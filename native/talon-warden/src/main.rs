//! talon-warden — supervision harness for trigger child processes.
//!
//! Talon's trigger supervisor (src/core/background/triggers.ts) runs
//! bot-authored scripts as children. Supervising them from inside the
//! Node event loop has three structural gaps the warden closes:
//!
//!   1. `child.kill()` signals the direct child only. A bash script
//!      that spawned `sleep 9999 &` leaks the grandchild past every
//!      cancel/timeout/shutdown path. The warden puts the child in its
//!      OWN process group and signals the whole group.
//!   2. Timeout enforcement rides the Node event loop — a wedged or
//!      SIGSTOPped Talon stops enforcing deadlines. The warden enforces
//!      TERM → grace → KILL out of process.
//!   3. A SIGKILLed Talon reaps nothing; orphan triggers run until the
//!      next boot's best-effort PID probe. The warden watches for
//!      parent death (pdeathsig on Linux, ppid-change polling
//!      everywhere, EPIPE on the event pipe as backstop) and tears the
//!      tree down itself.
//!
//! The warden owns plumbing only. Policy — TALON_FIRE parsing, status
//! transitions, wake prompts, the persistent-trigger contract — stays
//! in TypeScript, fed by an NDJSON event stream on the warden's stdout:
//!
//!   {"event":"start","pid":123,"pidStarttime":456}
//!   {"event":"line","stream":"stdout","text":"…","truncated":false}
//!   {"event":"exit","code":0,"signal":null,"timedOut":false,
//!    "reason":"exited","durationMs":42}
//!   {"event":"error","message":"spawn failed: …"}
//!
//! Exactly one terminal event (`exit` or `error`) is emitted. `reason`
//! is why supervision ended: "exited" (child's own exit), "timeout",
//! "signal" (SIGTERM/SIGINT/SIGHUP forwarded from the parent), or
//! "parent-exit" (Talon died). `signal` is the signal that terminated
//! the CHILD, by name. Lines are byte-capped (never split mid-UTF-8);
//! overflow is dropped and flagged `truncated`.
//!
//! Invocation (see also `parse_args` tests):
//!
//!   talon-warden --timeout-ms=300000 [--grace-ms=5000]
//!                [--max-line-bytes=8192] -- <cmd> [args…]
//!
//! `--timeout-ms=0` disables the deadline (persistent triggers).
//! Warden exit codes: 0 supervised to completion (whatever the child
//! did), 2 usage error, 3 spawn failure, 1 internal/pipe failure.

#[cfg(not(unix))]
compile_error!("talon-warden is Unix-only; Windows uses the TS supervision path");

use std::env;
use std::io::{self, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_GRACE_MS: u64 = 5_000;
const DEFAULT_MAX_LINE_BYTES: usize = 8_192;
/// Main-loop tick: bounds parent-liveness staleness and signal latency.
const TICK_MS: u64 = 100;
/// After the child exits, how long to wait for pipe EOF before giving
/// up on stragglers that escaped the process group but hold the pipe.
const DRAIN_MS: u64 = 250;

// ── Configuration ────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
struct Config {
    timeout_ms: u64, // 0 = no deadline
    grace_ms: u64,
    max_line_bytes: usize,
    command: Vec<String>,
}

enum ParsedArgs {
    Run(Config),
    Version,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut timeout_ms: Option<u64> = None;
    let mut grace_ms = DEFAULT_GRACE_MS;
    let mut max_line_bytes = DEFAULT_MAX_LINE_BYTES;
    let mut command = Vec::new();

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--version" {
            return Ok(ParsedArgs::Version);
        } else if arg == "--" {
            command.extend(iter.cloned());
            break;
        } else if let Some(v) = arg.strip_prefix("--timeout-ms=") {
            timeout_ms = Some(parse_u64(v, "--timeout-ms")?);
        } else if let Some(v) = arg.strip_prefix("--grace-ms=") {
            grace_ms = parse_u64(v, "--grace-ms")?;
        } else if let Some(v) = arg.strip_prefix("--max-line-bytes=") {
            let n = parse_u64(v, "--max-line-bytes")?;
            if n == 0 {
                return Err("--max-line-bytes must be > 0".into());
            }
            max_line_bytes = n as usize;
        } else {
            return Err(format!("unknown argument: {arg}"));
        }
    }

    let timeout_ms = timeout_ms.ok_or("missing required --timeout-ms=<n>")?;
    if command.is_empty() {
        return Err("missing command after --".into());
    }
    Ok(ParsedArgs::Run(Config {
        timeout_ms,
        grace_ms,
        max_line_bytes,
        command,
    }))
}

fn parse_u64(value: &str, flag: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{flag} expects a non-negative integer, got {value:?}"))
}

// ── JSON emission ────────────────────────────────────────────────────────────
// Hand-rolled: the protocol is four flat shapes, all values are numbers,
// booleans, or strings we escape here. Input strings are valid UTF-8
// (lossy-converted at the pipe boundary), so escaping `"` `\` and
// control characters is sufficient for RFC 8259 output.

fn json_escape_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    json_escape_into(&mut out, s);
    out.push('"');
    out
}

/// Write one NDJSON event line and flush. The parent reads these as
/// they happen (mid-run TALON_FIRE lines must not sit in a buffer). A
/// write failure means the parent is gone — tear the tree down and die.
fn emit(line: &str, child_pgid: Option<i32>) {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    let failed = writeln!(lock, "{line}").is_err() || lock.flush().is_err();
    if failed {
        if let Some(pgid) = child_pgid {
            kill_group(pgid, libc::SIGKILL);
        }
        std::process::exit(1);
    }
}

// ── Process-group signalling ─────────────────────────────────────────────────

/// Signal the child's whole process group. ESRCH (already gone) is fine.
fn kill_group(pgid: i32, sig: i32) {
    unsafe {
        libc::kill(-pgid, sig);
    }
}

/// Best-known names for the signals a trigger child realistically dies
/// by; anything exotic still round-trips as "SIG<n>".
fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGTERM => "SIGTERM".into(),
        _ => format!("SIG{sig}"),
    }
}

// ── Parent-forwarded signals ─────────────────────────────────────────────────

static SIGNAL_RECEIVED: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_signal(sig: libc::c_int) {
    SIGNAL_RECEIVED.store(sig, Ordering::SeqCst);
}

fn install_signal_handlers() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as *const () as usize;
        // SA_RESTART so reader-thread read(2)s resume instead of
        // surfacing EINTR everywhere; the main loop polls the atomic.
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaction(sig, &action, std::ptr::null_mut());
        }
        // A dead parent closes our stdout pipe; we want the failed
        // write (handled in emit), not a silent SIGPIPE death mid-kill.
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

// ── /proc starttime ──────────────────────────────────────────────────────────

/// Field 22 of /proc/<pid>/stat (start time in jiffies since boot) —
/// the same PID-reuse defence triggers.ts keeps for orphan probing.
/// None off-Linux or on any parse failure.
fn pid_starttime(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_starttime(&stat)
}

/// The comm field (2nd) is wrapped in parens and may itself contain
/// ')' — the safe parse is from the LAST ')'. After that split, index
/// 19 is field 22 (state is field 3 → starttime 22, 19 further along).
fn parse_starttime(stat: &str) -> Option<u64> {
    let tail = &stat[stat.rfind(')')? + 2..];
    tail.split(' ').nth(19)?.parse().ok()
}

// ── Pipe readers ─────────────────────────────────────────────────────────────

enum Msg {
    Line {
        stream: &'static str,
        text: String,
        truncated: bool,
    },
    ReaderDone,
    Exited(ExitStatus),
}

/// If a byte cap landed inside a multi-byte sequence, drop the partial
/// trailing bytes so lossy conversion can't manufacture a U+FFFD that
/// was never in the child's output.
fn trim_partial_utf8(buf: &mut Vec<u8>) {
    let len = buf.len();
    // Walk back over up to 3 trailing continuation bytes to the byte
    // that should be the sequence's lead.
    let mut i = len;
    while i > 0 && len - i < 4 && buf[i - 1] & 0xc0 == 0x80 {
        i -= 1;
    }
    if i == 0 {
        return; // all continuation bytes (malformed) — leave for lossy
    }
    let lead = buf[i - 1];
    let needed = match lead {
        b if b & 0x80 == 0x00 => return, // ASCII tail: nothing dangling
        b if b & 0xe0 == 0xc0 => 2,
        b if b & 0xf0 == 0xe0 => 3,
        b if b & 0xf8 == 0xf0 => 4,
        _ => return, // malformed lead: leave for lossy conversion
    };
    if needed > len - (i - 1) {
        buf.truncate(i - 1);
    }
}

/// Pump one pipe, splitting on '\n', capping each line at `max` bytes
/// (overflow dropped, flagged), and forwarding lines to the supervisor.
fn pump_lines<R: Read>(mut pipe: R, stream: &'static str, max: usize, tx: mpsc::Sender<Msg>) {
    let mut chunk = [0u8; 8192];
    let mut line: Vec<u8> = Vec::new();
    let mut overflowed = false;

    let flush = |line: &mut Vec<u8>, overflowed: bool| {
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if overflowed {
            trim_partial_utf8(line);
        }
        let text = String::from_utf8_lossy(line).into_owned();
        line.clear();
        // Send failure = supervisor gone; the reader just winds down.
        tx.send(Msg::Line {
            stream,
            text,
            truncated: overflowed,
        })
        .is_ok()
    };

    'outer: loop {
        let n = match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &byte in &chunk[..n] {
            if byte == b'\n' {
                if !flush(&mut line, overflowed) {
                    break 'outer;
                }
                overflowed = false;
            } else if !overflowed {
                line.push(byte);
                if line.len() >= max {
                    overflowed = true;
                }
            }
        }
    }
    if !line.is_empty() || overflowed {
        flush(&mut line, overflowed);
    }
    let _ = tx.send(Msg::ReaderDone);
}

// ── Supervision ──────────────────────────────────────────────────────────────

#[derive(PartialEq, Clone, Copy)]
enum Phase {
    Running,
    /// TERM sent to the group; KILL follows at `kill_at`.
    Terminating { kill_at: Instant },
    /// KILL already sent; nothing left to escalate to.
    Killed,
}

fn run(config: Config) -> i32 {
    install_signal_handlers();
    let initial_ppid = unsafe { libc::getppid() };

    // If the parent dies, have the kernel TERM us promptly (Linux). The
    // ppid poll below is the portable path; EPIPE on emit the backstop.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
    }

    let mut cmd = Command::new(&config.command[0]);
    cmd.args(&config.command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Own process group, child as leader: group kills reach every
        // descendant that didn't deliberately setsid away.
        .process_group(0);

    // If the WARDEN is SIGKILLed, its children still get a TERM (Linux).
    #[cfg(target_os = "linux")]
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            emit(
                &format!(
                    "{{\"event\":\"error\",\"message\":{}}}",
                    json_string(&format!("spawn failed: {err}"))
                ),
                None,
            );
            return 3;
        }
    };

    let started_at = Instant::now();
    let pid = child.id() as i32;
    let pgid = pid; // process_group(0) → child leads its own group
    let starttime = pid_starttime(pid as u32)
        .map(|t| t.to_string())
        .unwrap_or_else(|| "null".into());
    emit(
        &format!("{{\"event\":\"start\",\"pid\":{pid},\"pidStarttime\":{starttime}}}"),
        Some(pgid),
    );

    let (tx, rx) = mpsc::channel::<Msg>();
    let stdout_pipe = child.stdout.take().expect("stdout was piped");
    let stderr_pipe = child.stderr.take().expect("stderr was piped");
    let max = config.max_line_bytes;
    let tx_out = tx.clone();
    let tx_err = tx.clone();
    thread::spawn(move || pump_lines(stdout_pipe, "stdout", max, tx_out));
    thread::spawn(move || pump_lines(stderr_pipe, "stderr", max, tx_err));
    thread::spawn(move || {
        // wait() reaps the direct child; group stragglers are killed by
        // the supervisor and reaped by init after reparenting.
        let status = child.wait();
        if let Ok(status) = status {
            let _ = tx.send(Msg::Exited(status));
        }
    });
    // Only the two pipe pumps send ReaderDone; the count gates the
    // post-exit drain on both pipes reaching EOF.
    const READER_PARTIES: u32 = 2;

    let deadline = (config.timeout_ms > 0)
        .then(|| started_at + Duration::from_millis(config.timeout_ms));
    let grace = Duration::from_millis(config.grace_ms);

    let mut phase = Phase::Running;
    let mut reason = "exited";
    let mut timed_out = false;
    let mut exit_status: Option<ExitStatus> = None;
    let mut readers_done: u32 = 0;
    let mut drain_until: Option<Instant> = None;

    loop {
        let now = Instant::now();
        let mut wake = now + Duration::from_millis(TICK_MS);
        if let (Phase::Running, Some(d)) = (phase, deadline) {
            wake = wake.min(d);
        }
        if let Phase::Terminating { kill_at } = phase {
            wake = wake.min(kill_at);
        }
        if let Some(d) = drain_until {
            wake = wake.min(d);
        }

        match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Msg::Line {
                stream,
                text,
                truncated,
            }) => {
                emit(
                    &format!(
                        "{{\"event\":\"line\",\"stream\":\"{stream}\",\"text\":{},\"truncated\":{truncated}}}",
                        json_string(&text)
                    ),
                    Some(pgid),
                );
            }
            Ok(Msg::ReaderDone) => readers_done += 1,
            Ok(Msg::Exited(status)) => {
                exit_status = Some(status);
                // The trigger is over: a completed run must not leave
                // background descendants behind. Sweep the group.
                kill_group(pgid, libc::SIGKILL);
                drain_until = Some(Instant::now() + Duration::from_millis(DRAIN_MS));
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // Done once the child is reaped and both pipes hit EOF — or the
        // drain window closes on a pipe held open outside the group.
        if exit_status.is_some()
            && (readers_done >= READER_PARTIES
                || drain_until.is_some_and(|d| Instant::now() >= d))
        {
            break;
        }
        if exit_status.is_some() {
            continue; // already sweeping; no further escalation logic
        }

        let now = Instant::now();
        if phase == Phase::Running {
            let signal = SIGNAL_RECEIVED.load(Ordering::SeqCst);
            let parent_died = unsafe { libc::getppid() } != initial_ppid;
            if parent_died {
                reason = "parent-exit";
            } else if signal != 0 {
                reason = "signal";
            } else if deadline.is_some_and(|d| now >= d) {
                reason = "timeout";
                timed_out = true;
            }
            if reason != "exited" {
                kill_group(pgid, libc::SIGTERM);
                phase = Phase::Terminating {
                    kill_at: now + grace,
                };
            }
        }
        if let Phase::Terminating { kill_at } = phase {
            if now >= kill_at {
                kill_group(pgid, libc::SIGKILL);
                phase = Phase::Killed;
            }
        }
    }

    let duration_ms = started_at.elapsed().as_millis();
    let (code, signal) = match exit_status {
        Some(status) => (
            status.code().map_or("null".into(), |c| c.to_string()),
            status
                .signal()
                .map_or("null".into(), |s| json_string(&signal_name(s))),
        ),
        // Channel died without an exit status — should not happen, but
        // never leave the tree running on an internal failure.
        None => {
            kill_group(pgid, libc::SIGKILL);
            ("null".into(), "null".into())
        }
    };
    emit(
        &format!(
            "{{\"event\":\"exit\",\"code\":{code},\"signal\":{signal},\"timedOut\":{timed_out},\"reason\":\"{reason}\",\"durationMs\":{duration_ms}}}"
        ),
        Some(pgid),
    );
    0
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(ParsedArgs::Version) => {
            println!("talon-warden {}", env!("CARGO_PKG_VERSION"));
        }
        Ok(ParsedArgs::Run(config)) => {
            std::process::exit(run(config));
        }
        Err(message) => {
            eprintln!("talon-warden: {message}");
            eprintln!(
                "usage: talon-warden --timeout-ms=<n> [--grace-ms=<n>] \
                 [--max-line-bytes=<n>] -- <cmd> [args...]"
            );
            std::process::exit(2);
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────
// Pure-function coverage. Process behaviour (group kills, timeout
// escalation, parent-death teardown, protocol framing) is exercised
// end-to-end against the real binary in
// src/__tests__/talon-warden.test.ts, beside talon-driver's suite.

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_full_invocation() {
        let parsed = parse_args(&args(&[
            "--timeout-ms=1000",
            "--grace-ms=200",
            "--max-line-bytes=64",
            "--",
            "bash",
            "-c",
            "echo hi",
        ]))
        .unwrap();
        let ParsedArgs::Run(config) = parsed else {
            panic!("expected Run");
        };
        assert_eq!(
            config,
            Config {
                timeout_ms: 1000,
                grace_ms: 200,
                max_line_bytes: 64,
                command: args(&["bash", "-c", "echo hi"]),
            }
        );
    }

    #[test]
    fn defaults_grace_and_line_cap() {
        let ParsedArgs::Run(config) =
            parse_args(&args(&["--timeout-ms=0", "--", "true"])).unwrap()
        else {
            panic!("expected Run");
        };
        assert_eq!(config.grace_ms, DEFAULT_GRACE_MS);
        assert_eq!(config.max_line_bytes, DEFAULT_MAX_LINE_BYTES);
        assert_eq!(config.timeout_ms, 0);
    }

    #[test]
    fn rejects_missing_timeout_command_and_junk() {
        assert!(parse_args(&args(&["--", "true"])).is_err());
        assert!(parse_args(&args(&["--timeout-ms=5"])).is_err());
        assert!(parse_args(&args(&["--timeout-ms=5", "--"])).is_err());
        assert!(parse_args(&args(&["--timeout-ms=x", "--", "true"])).is_err());
        assert!(parse_args(&args(&["--bogus", "--", "true"])).is_err());
        assert!(parse_args(&args(&["--max-line-bytes=0", "--", "true"])).is_err());
    }

    #[test]
    fn version_flag_short_circuits() {
        assert!(matches!(
            parse_args(&args(&["--version"])),
            Ok(ParsedArgs::Version)
        ));
    }

    #[test]
    fn json_escapes_quotes_backslashes_and_controls() {
        assert_eq!(json_string("plain"), r#""plain""#);
        assert_eq!(json_string("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(json_string("tab\there"), r#""tab\there""#);
        assert_eq!(json_string("\u{1}"), "\"\\u0001\"");
        assert_eq!(json_string("naïve 🦀"), "\"naïve 🦀\"");
    }

    #[test]
    fn parses_proc_stat_starttime() {
        // comm containing ')' and spaces — the pathological case.
        let stat = "1234 (we (ird) name) S 1 1234 1234 0 -1 4194304 \
                    100 0 0 0 1 1 0 0 20 0 1 0 987654 1000000 100 \
                    18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0";
        assert_eq!(parse_starttime(stat), Some(987654));
        assert_eq!(parse_starttime("garbage"), None);
    }

    #[test]
    fn trims_partial_utf8_at_cap() {
        // "é" = c3 a9; cap split after the lead byte.
        let mut buf = vec![b'a', 0xc3];
        trim_partial_utf8(&mut buf);
        assert_eq!(buf, vec![b'a']);

        // 4-byte emoji cut after 2 bytes.
        let mut buf = vec![b'a', 0xf0, 0x9f];
        trim_partial_utf8(&mut buf);
        assert_eq!(buf, vec![b'a']);

        // Complete sequence is untouched.
        let mut buf = "aé".as_bytes().to_vec();
        trim_partial_utf8(&mut buf);
        assert_eq!(buf, "aé".as_bytes());

        // Pure ASCII untouched.
        let mut buf = b"abc".to_vec();
        trim_partial_utf8(&mut buf);
        assert_eq!(buf, b"abc");
    }

    #[test]
    fn pump_lines_frames_caps_and_flags() {
        let (tx, rx) = mpsc::channel();
        let input: &[u8] = b"short\r\nthis line is far too long\npost\nno-newline-tail";
        pump_lines(input, "stdout", 9, tx);

        let mut lines = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            if let Msg::Line {
                text, truncated, ..
            } = msg
            {
                lines.push((text, truncated));
            }
        }
        assert_eq!(
            lines,
            vec![
                ("short".into(), false),
                ("this line".into(), true),
                ("post".into(), false),
                ("no-newlin".into(), true),
            ]
        );
    }

    #[test]
    fn signal_names_cover_common_and_fallback() {
        assert_eq!(signal_name(libc::SIGTERM), "SIGTERM");
        assert_eq!(signal_name(libc::SIGKILL), "SIGKILL");
        assert_eq!(signal_name(64), "SIG64");
    }
}
