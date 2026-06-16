//! talon-warden — supervision harness for trigger child processes.
//!
//! Talon's trigger supervisor (src/core/background/triggers.ts) runs
//! bot-authored scripts as children. Supervising them from inside the
//! Node event loop has three structural gaps the warden closes:
//!
//!   1. `child.kill()` signals the direct child only. A bash script
//!      that spawned `sleep 9999 &` leaks the grandchild past every
//!      cancel/timeout/shutdown path. The warden puts the child in its
//!      OWN process group (POSIX) or a kill-on-close Job Object
//!      (Windows) and tears the whole tree down at once.
//!   2. Timeout enforcement rides the Node event loop — a wedged or
//!      SIGSTOPped Talon stops enforcing deadlines. The warden enforces
//!      TERM → grace → KILL out of process.
//!   3. A SIGKILLed Talon reaps nothing; orphan triggers run until the
//!      next boot's best-effort PID probe. The warden watches for
//!      parent death (pdeathsig on Linux, ppid-change polling on Unix,
//!      a waited parent handle on Windows, EPIPE on the event pipe as
//!      backstop everywhere) and tears the tree down itself.
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
//! "signal" (SIGTERM/SIGINT/SIGHUP on Unix, a console control event on
//! Windows — forwarded from the parent), or "parent-exit" (Talon died).
//! `signal` is the signal that terminated the CHILD, by name; on
//! Windows children do not die by signal, so it is always null and the
//! exit code carries the cause. Lines are byte-capped (never split
//! mid-UTF-8); overflow is dropped and flagged `truncated`.
//!
//! Invocation (see also `parse_args` tests):
//!
//!   talon-warden --timeout-ms=300000 [--grace-ms=5000]
//!                [--max-line-bytes=8192] -- <cmd> [args…]
//!
//! `--timeout-ms=0` disables the deadline (persistent triggers).
//! Warden exit codes: 0 supervised to completion (whatever the child
//! did), 2 usage error, 3 spawn failure, 1 internal/pipe failure.
//!
//! Platform plane: everything above the `plat` module is portable. The
//! process-group/job, signal/console-control forwarding, parent-death
//! detection, and per-OS pid-starttime probe live behind `plat`, with a
//! Unix (libc) and a Windows (Win32 Job Objects) implementation.

use std::env;
use std::io::{self, Read, Write};
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
/// up on stragglers that escaped the tree but hold the pipe.
const DRAIN_MS: u64 = 250;

/// Set by the platform signal/console-control handler; the main loop
/// polls it. Non-zero means a parent-forwarded termination request
/// arrived (the exact value is the signal number on Unix, a sentinel on
/// Windows — the protocol only reports `reason:"signal"`).
static SIGNAL_RECEIVED: AtomicI32 = AtomicI32::new(0);

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

// ── Platform plane ─────────────────────────────────────────────────────────
// The only OS surface std doesn't cover: tree teardown, parent-death
// detection, parent-forwarded termination, and the pid-starttime probe.
// Both implementations expose the same API; everything else is portable.

#[cfg(unix)]
mod plat {
    use super::SIGNAL_RECEIVED;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Command, ExitStatus};
    use std::sync::atomic::Ordering;

    /// A handle to the supervised process tree. On Unix the child leads
    /// its own process group, so the pgid (== child pid) addresses the
    /// whole group via `kill(-pgid, …)`.
    pub struct Tree {
        pgid: i32,
    }

    /// Baseline for parent-liveness: the ppid captured at startup. A
    /// change means the original parent (Talon) is gone and we've been
    /// reparented.
    pub struct ParentWatch {
        initial_ppid: i32,
    }

    extern "C" fn on_signal(sig: libc::c_int) {
        SIGNAL_RECEIVED.store(sig, Ordering::SeqCst);
    }

    /// TERM/INT/HUP set the atomic (the main loop polls it); SIGPIPE is
    /// ignored so a dead-parent pipe surfaces as a failed write in
    /// `emit`, not a silent death mid-kill.
    pub fn install_signal_handlers() {
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
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        }
    }

    /// Capture the parent baseline and, on Linux, ask the kernel to TERM
    /// us promptly if the parent dies (the ppid poll is the portable
    /// path; EPIPE on emit is the backstop).
    pub fn watch_parent() -> ParentWatch {
        let initial_ppid = unsafe { libc::getppid() };
        #[cfg(target_os = "linux")]
        unsafe {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
        }
        ParentWatch { initial_ppid }
    }

    pub fn parent_died(watch: &ParentWatch) -> bool {
        unsafe { libc::getppid() != watch.initial_ppid }
    }

    /// Put the child in its own process group so group kills reach every
    /// descendant that didn't deliberately `setsid` away. On Linux also
    /// arm the child's pdeathsig so a SIGKILLed warden still TERMs it.
    pub fn configure_spawn(cmd: &mut Command) {
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
    }

    /// `process_group(0)` made the child its own group leader, so the
    /// pgid is the child pid.
    pub fn build_tree(child_pid: u32) -> Tree {
        Tree {
            pgid: child_pid as i32,
        }
    }

    /// Graceful: TERM the whole group. ESRCH (already gone) is fine.
    pub fn tree_term(tree: &Tree) {
        unsafe {
            libc::kill(-tree.pgid, libc::SIGTERM);
        }
    }

    /// Forceful: KILL the whole group.
    pub fn tree_kill(tree: &Tree) {
        unsafe {
            libc::kill(-tree.pgid, libc::SIGKILL);
        }
    }

    /// Field 22 of /proc/<pid>/stat (start time in jiffies since boot) —
    /// the same PID-reuse defence triggers.ts keeps for orphan probing.
    /// None off-Linux or on any parse failure.
    pub fn pid_starttime(pid: u32) -> Option<u64> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        super::parse_starttime(&stat)
    }

    /// The signal that terminated the child, by name, if it died by one.
    pub fn signal_of(status: &ExitStatus) -> Option<String> {
        status.signal().map(signal_name)
    }

    /// Best-known names for the signals a trigger child realistically
    /// dies by; anything exotic still round-trips as "SIG<n>".
    pub fn signal_name(sig: i32) -> String {
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
}

#[cfg(windows)]
mod plat {
    use super::SIGNAL_RECEIVED;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, ExitStatus};
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, TRUE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{
        GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_BREAK_EVENT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP,
        PROCESS_SYNCHRONIZE,
    };

    /// A handle to the supervised process tree. On Windows the child and
    /// every descendant live in a Job Object created with
    /// KILL_ON_JOB_CLOSE: terminating the job (or just dropping the last
    /// handle to it — which happens when the warden dies) tears the
    /// whole tree down atomically. `pid` is the child, used as the
    /// console process-group id for the graceful CTRL_BREAK.
    pub struct Tree {
        job: HANDLE,
        pid: u32,
    }
    // The job handle is only ever read by tree_term/tree_kill on the
    // main thread; Tree is not shared across threads.
    unsafe impl Send for Tree {}

    /// A waited handle to the parent process. Windows has no getppid, so
    /// we resolve the parent pid once via a process snapshot and open a
    /// SYNCHRONIZE handle; a satisfied wait means it exited. Null when
    /// the parent could not be resolved (then EPIPE on emit is the only
    /// backstop, exactly as on Unix when ppid polling is unavailable).
    pub struct ParentWatch {
        handle: HANDLE,
    }
    unsafe impl Send for ParentWatch {}

    unsafe extern "system" fn ctrl_handler(_ctrl_type: u32) -> i32 {
        // Any console control event (C, BREAK, CLOSE, LOGOFF, SHUTDOWN)
        // is treated as a parent-forwarded termination request. Report
        // it handled; the main loop sees the atomic and tears down.
        SIGNAL_RECEIVED.store(1, Ordering::SeqCst);
        TRUE
    }

    pub fn install_signal_handlers() {
        unsafe {
            SetConsoleCtrlHandler(Some(ctrl_handler), TRUE);
        }
    }

    /// Resolve the parent pid through a process snapshot and open a
    /// SYNCHRONIZE handle we can wait on for liveness.
    pub fn watch_parent() -> ParentWatch {
        let handle = unsafe {
            let me = GetCurrentProcessId();
            let parent_pid = parent_pid_of(me);
            match parent_pid {
                Some(ppid) => OpenProcess(PROCESS_SYNCHRONIZE, FALSE, ppid),
                None => std::ptr::null_mut(),
            }
        };
        ParentWatch { handle }
    }

    /// Walk the process snapshot to find our own entry's parent pid.
    unsafe fn parent_pid_of(pid: u32) -> Option<u32> {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry) != FALSE {
            loop {
                if entry.th32ProcessID == pid {
                    found = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == FALSE {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }

    pub fn parent_died(watch: &ParentWatch) -> bool {
        if watch.handle.is_null() {
            return false; // unresolved parent → rely on the EPIPE backstop
        }
        // 0ms wait: WAIT_OBJECT_0 means the handle is signaled (the
        // process exited); WAIT_TIMEOUT means it's still alive.
        unsafe { WaitForSingleObject(watch.handle, 0) == WAIT_OBJECT_0 }
    }

    /// New process group so a graceful CTRL_BREAK can target the child's
    /// group specifically. Job assignment (the real tree-teardown
    /// guarantee) happens in `build_tree` immediately after spawn.
    pub fn configure_spawn(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    /// Create a kill-on-close Job Object and assign the freshly spawned
    /// child to it, so the child and every descendant tear down together
    /// — and tear down automatically if the warden itself dies (the
    /// equivalent of Linux's pdeathsig, but for the whole tree). The
    /// child handle must outlive this call; the caller holds the `Child`.
    pub fn build_tree_from_child(child: &Child) -> Tree {
        let pid = child.id();
        let job = unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                // Nested jobs (Win8+) make this succeed even if the child
                // already belongs to a job. A tiny race exists between
                // spawn and assignment; trigger scripts do not fork a
                // tree that fast, and KILL_ON_JOB_CLOSE still covers
                // anything assigned.
                AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            }
            job
        };
        Tree { job, pid }
    }

    /// Graceful: deliver CTRL_BREAK to the child's process group.
    /// Best-effort — it needs a console and the new-process-group flag;
    /// when it can't be delivered the timeout/grace escalates to
    /// tree_kill regardless.
    pub fn tree_term(tree: &Tree) {
        unsafe {
            GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, tree.pid);
        }
    }

    /// Forceful: terminate the entire job, killing the child and every
    /// descendant at once.
    pub fn tree_kill(tree: &Tree) {
        unsafe {
            if !tree.job.is_null() {
                TerminateJobObject(tree.job, 1);
            }
        }
    }

    /// No cheap, stable per-pid start time on Windows that maps to the
    /// Linux jiffies field triggers.ts probes; report null (matching the
    /// documented "null off-Linux" contract). The Job Object, not a
    /// starttime PID-reuse check, is the orphan-teardown guarantee here.
    pub fn pid_starttime(_pid: u32) -> Option<u64> {
        None
    }

    /// Windows children do not terminate by POSIX signal; the cause is
    /// carried entirely by the exit code.
    pub fn signal_of(_status: &ExitStatus) -> Option<String> {
        None
    }
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
fn emit(line: &str, tree: Option<&plat::Tree>) {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    let failed = writeln!(lock, "{line}").is_err() || lock.flush().is_err();
    if failed {
        if let Some(tree) = tree {
            plat::tree_kill(tree);
        }
        std::process::exit(1);
    }
}

// ── /proc starttime parsing (Linux; pure, so kept portable + tested) ───────────

/// The comm field (2nd) is wrapped in parens and may itself contain
/// ')' — the safe parse is from the LAST ')'. After that split, index
/// 19 is field 22 (state is field 3 → starttime 22, 19 further along).
// Used by plat::pid_starttime on Unix and by the parser test everywhere;
// the non-test Windows build has no caller, hence the cfg.
#[cfg(any(unix, test))]
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
    /// TERM sent to the tree; KILL follows at `kill_at`.
    Terminating { kill_at: Instant },
    /// KILL already sent; nothing left to escalate to.
    Killed,
}

fn run(config: Config) -> i32 {
    plat::install_signal_handlers();
    let parent_watch = plat::watch_parent();

    let mut cmd = Command::new(&config.command[0]);
    cmd.args(&config.command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group (Unix) / new console group (Windows); the tree
    // teardown guarantee (pgid kills / kill-on-close Job Object) is wired
    // by configure_spawn + build_tree_from_child.
    plat::configure_spawn(&mut cmd);

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
    let pid = child.id();
    let tree = build_tree(&child);
    let starttime = plat::pid_starttime(pid)
        .map(|t| t.to_string())
        .unwrap_or_else(|| "null".into());
    emit(
        &format!("{{\"event\":\"start\",\"pid\":{pid},\"pidStarttime\":{starttime}}}"),
        Some(&tree),
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
        // wait() reaps the direct child; tree stragglers are killed by
        // the supervisor (group kill / TerminateJobObject) and, on Unix,
        // reaped by init after reparenting.
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
                    Some(&tree),
                );
            }
            Ok(Msg::ReaderDone) => readers_done += 1,
            Ok(Msg::Exited(status)) => {
                exit_status = Some(status);
                // The trigger is over: a completed run must not leave
                // background descendants behind. Sweep the tree.
                plat::tree_kill(&tree);
                drain_until = Some(Instant::now() + Duration::from_millis(DRAIN_MS));
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // Done once the child is reaped and both pipes hit EOF — or the
        // drain window closes on a pipe held open outside the tree.
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
            let parent_died = plat::parent_died(&parent_watch);
            if parent_died {
                reason = "parent-exit";
            } else if signal != 0 {
                reason = "signal";
            } else if deadline.is_some_and(|d| now >= d) {
                reason = "timeout";
                timed_out = true;
            }
            if reason != "exited" {
                plat::tree_term(&tree);
                phase = Phase::Terminating {
                    kill_at: now + grace,
                };
            }
        }
        if let Phase::Terminating { kill_at } = phase {
            if now >= kill_at {
                plat::tree_kill(&tree);
                phase = Phase::Killed;
            }
        }
    }

    let duration_ms = started_at.elapsed().as_millis();
    let (code, signal) = match exit_status {
        Some(status) => (
            status.code().map_or("null".into(), |c| c.to_string()),
            plat::signal_of(&status).map_or("null".into(), |s| json_string(&s)),
        ),
        // Channel died without an exit status — should not happen, but
        // never leave the tree running on an internal failure.
        None => {
            plat::tree_kill(&tree);
            ("null".into(), "null".into())
        }
    };
    emit(
        &format!(
            "{{\"event\":\"exit\",\"code\":{code},\"signal\":{signal},\"timedOut\":{timed_out},\"reason\":\"{reason}\",\"durationMs\":{duration_ms}}}"
        ),
        Some(&tree),
    );
    0
}

/// Build the tree handle from the spawned child. Unix needs only the
/// pid (it leads its own group); Windows needs the live `Child` to
/// assign its handle to a Job Object.
#[cfg(unix)]
fn build_tree(child: &std::process::Child) -> plat::Tree {
    plat::build_tree(child.id())
}

#[cfg(windows)]
fn build_tree(child: &std::process::Child) -> plat::Tree {
    plat::build_tree_from_child(child)
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
// Pure-function coverage. Process behaviour (group/job kills, timeout
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

    #[cfg(unix)]
    #[test]
    fn signal_names_cover_common_and_fallback() {
        assert_eq!(plat::signal_name(libc::SIGTERM), "SIGTERM");
        assert_eq!(plat::signal_name(libc::SIGKILL), "SIGKILL");
        assert_eq!(plat::signal_name(64), "SIG64");
    }
}
