/**
 * Native tools — Talon's own shell/filesystem tools, replacing the SDK's
 * built-in Bash/Read/Write/Edit/Glob/Grep when `config.nativeTools` is on.
 *
 * Their defining feature: every one checks the current chat's active
 * `teleport` target. With no teleport for that chat, they run on the daemon
 * host (local spawn / local fs / local ripgrep). With a teleport engaged, they
 * run ON the companion device via the mesh exec/fs channel — so
 * `bash`/`read`/`write`/… transparently operate on the phone for that chat.
 *
 *   teleport(device)  → native tools target that device
 *   teleport_back()   → native tools run locally again
 *
 * The teleported path reuses the exec/fs command surface on MeshService; the
 * local path is a thin, well-scoped reimplementation of the built-ins.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  glob as fsGlob,
  mkdir,
  readFile,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getMeshService } from "../../mesh/index.js";
import {
  clearTeleport,
  getTeleport,
  setTeleport,
  setTeleportCwd,
} from "../../mesh/teleport.js";
import {
  clampExecOutput,
  createOutputCapture,
} from "../../../util/exec-output.js";
import type { SharedActionHandlers } from "./types.js";

type Result = { ok: boolean; text: string };

/**
 * ripgrep binary, resolved from PATH (env-overridable for tests). NOT a
 * hardcoded absolute path: /usr/bin/rg only exists on some Linux installs,
 * and a missing binary must fall back loudly (or to the pure-JS walker),
 * never masquerade as "no matches".
 */
function rgBin(): string {
  return process.env.TALON_NATIVE_RG ?? "rg";
}
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;
/** Grace between SIGTERM and SIGKILL on timeout, so pipelines can flush. */
const KILL_GRACE_MS = 2_000;
/** How long a background launch waits to catch fast failures. */
const BACKGROUND_SETTLE_MS = 1_200;
/** Where background job output lands (one log file per job). */
const BACKGROUND_LOG_DIR = join(tmpdir(), "talon-bash");
/** Appended to a timed-out bash result so the model self-corrects. */
const TIMEOUT_HINT =
  "(Streaming/never-ending commands — adb logcat, tail -f, dev servers, watchers — " +
  "will always hit this wall. Re-run with background:true to launch it detached with " +
  "output captured to a log file, or bound the command itself: `adb logcat -d`, " +
  "`timeout 30 …`, `head -n 200`.)";
/** Same self-correction hint, phrased for a teleported (on-device) run. */
const TELEPORT_TIMEOUT_HINT =
  "(Streaming/never-ending commands can't ride a teleported foreground call — " +
  "background it in-shell instead: `cmd > /tmp/out.log 2>&1 &`, then poll the log " +
  "with read, or bound the command itself: `logcat -d`, `timeout 30 …`, `head -n 200`.)";
const MAX_READ_LINES = 2_000;
/** Caps for the pure-JS glob/search fallbacks (rg unavailable). */
const MAX_JS_RESULTS = 2_000;
const MAX_JS_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
/** Markers used to recover the post-command working dir from a teleport shell. */
const CWD_OPEN = "__TALON_CWD__";
const CWD_CLOSE = "__TALON_CWD_END__";

export const nativeHandlers: SharedActionHandlers = {
  teleport: (body, chatId) => teleport(chatId, body.device),
  teleport_back: (_body, chatId) => teleportBack(chatId),
  native_bash: (body, chatId) =>
    bash(chatId, body.command, body.cwd, body.timeout_sec, body.background),
  native_read: (body, chatId) =>
    read(chatId, body.path, body.offset, body.limit),
  native_write: (body, chatId) => write(chatId, body.path, body.content),
  native_edit: (body, chatId) =>
    edit(chatId, body.path, body.old_string, body.new_string, body.replace_all),
  native_glob: (body, chatId) => glob(chatId, body.pattern, body.path),
  native_search: (body, chatId) =>
    search(chatId, body.pattern, body.path, body.glob, body.case_insensitive),
};

// ── Teleport control ────────────────────────────────────────────────────────

async function teleport(chatId: number, query: unknown): Promise<Result> {
  const svc = getMeshService();
  await svc.list();
  const resolved = svc.resolveDevice(query);
  if ("error" in resolved) return { ok: false, text: resolved.error };
  const target = resolved.target;
  if (!target.online) {
    return {
      ok: false,
      text: `${target.name} appears offline — cannot teleport onto a device that isn't connected.`,
    };
  }
  if (target.capabilities && !target.capabilities.includes("exec")) {
    return {
      ok: false,
      text: `${target.name} does not advertise the "exec" capability, so teleport can't run commands on it.`,
    };
  }
  await setTeleport(chatId, target.id, target.name);
  return {
    ok: true,
    text: [
      `🛰️ Teleported onto ${target.name}. Native bash/read/write/edit/glob/search now run ON that device.`,
      `Working dir starts at the device default; \`cd\` in bash persists across calls.`,
      `Call teleport_back to return to the daemon host.`,
    ].join(" "),
  };
}

async function teleportBack(chatId: number): Promise<Result> {
  const prior = await clearTeleport(chatId);
  return {
    ok: true,
    text: prior
      ? `↩️ Teleported back from ${prior.deviceName}. Native tools run on the daemon host again.`
      : "Not teleported — native tools already run on the daemon host.",
  };
}

// ── bash ────────────────────────────────────────────────────────────────────

async function bash(
  chatId: number,
  command: unknown,
  cwd: unknown,
  timeoutSec: unknown,
  background?: unknown,
): Promise<Result> {
  const cmd = typeof command === "string" ? command : "";
  if (!cmd.trim()) return { ok: false, text: "No command given." };
  const timeoutMs = clampTimeout(timeoutSec);
  const active = await getTeleport(chatId);
  if (background === true) {
    if (active) {
      return {
        ok: false,
        text:
          "background:true runs on the daemon host only. On a teleported device, " +
          "background it in-shell instead: `cmd > /tmp/out.log 2>&1 &`, then poll " +
          "the log with read.",
      };
    }
    return bashBackground(cmd, typeof cwd === "string" ? cwd : undefined);
  }
  if (active) return bashTeleported(chatId, active.deviceId, cmd, timeoutMs);
  return bashLocal(cmd, typeof cwd === "string" ? cwd : undefined, timeoutMs);
}

/**
 * Launch a command detached from the request cycle: its own process group,
 * stdout+stderr appended to a per-job log file, tool returns immediately.
 * This is the sanctioned path for streaming/long-running commands (adb
 * logcat, dev servers, watchers) that would otherwise burn the whole
 * foreground timeout and come back "killed".
 *
 * A short settle window catches fast failures (typo'd binary, instant
 * non-zero exit) so those still surface as a normal error instead of a
 * "started" message pointing at a log with one line in it.
 */
async function bashBackground(
  cmd: string,
  cwd: string | undefined,
): Promise<Result> {
  // The background contract is POSIX-shaped end to end: detached process
  // group, `kill -- -pid` to stop, survives daemon restarts. Windows has
  // none of those (and the CI legs showed the detached writer's output not
  // reaching the log) — refuse loudly with the native alternative instead
  // of pretending.
  if (process.platform === "win32") {
    return {
      ok: false,
      text:
        "background:true needs POSIX process groups and isn't supported on a Windows " +
        "daemon host. Run it foreground with a bound command (`timeout 30 …`, `head -n 200`) " +
        "or start it yourself: `powershell Start-Process -WindowStyle Hidden` with output redirected to a file.",
    };
  }
  try {
    await mkdir(BACKGROUND_LOG_DIR, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      text: `Cannot create log dir ${BACKGROUND_LOG_DIR}: ${(err as Error).message}`,
    };
  }
  const slug =
    cmd
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "job";
  const logPath = join(BACKGROUND_LOG_DIR, `${Date.now()}-${slug}.log`);
  let fd: number;
  try {
    fd = openSync(logPath, "a");
  } catch (err) {
    return {
      ok: false,
      text: `Cannot open log file ${logPath}: ${(err as Error).message}`,
    };
  }
  // Always detached: the win32 guard above returned already, so this only
  // runs on POSIX where the job gets its own process group.
  const child = spawn("bash", ["-c", cmd], {
    ...(cwd ? { cwd } : {}),
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (r: Result) => {
      if (settled) return;
      settled = true;
      try {
        closeSync(fd);
      } catch {
        // parent's dup only; the child keeps its own copy either way
      }
      resolvePromise(r);
    };
    child.on("error", (err) =>
      done({ ok: false, text: `Failed to start: ${err.message}` }),
    );
    // Fast failure inside the settle window → report it like a normal run.
    child.on("close", (code) => {
      void (async () => {
        let logged = "";
        try {
          logged = await readFile(logPath, "utf8");
        } catch {
          // log unreadable — report the exit alone
        }
        done({
          ok: (code ?? 0) === 0,
          text:
            `Background command exited almost immediately (exit ${code ?? 0}).\n` +
            renderExec("local", `exit ${code ?? 0}`, logged, "") +
            `\nFull log: ${logPath}`,
        });
      })();
    });
    setTimeout(() => {
      if (settled) return;
      child.unref();
      done({
        ok: true,
        text: [
          `🚀 Started in background [local] — pid ${child.pid}.`,
          `Output (stdout+stderr) → ${logPath}`,
          `Follow it with read/bash (e.g. \`tail -n 50 ${logPath}\`).`,
          `Stop it with \`kill -- -${child.pid}\` (whole process group).`,
          `Unsupervised: it keeps running until it exits or is killed — it even survives a Talon restart.`,
        ].join("\n"),
      });
    }, BACKGROUND_SETTLE_MS);
  });
}

function bashLocal(
  cmd: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<Result> {
  return new Promise((resolvePromise) => {
    // detached → own process group on POSIX, so a timeout can kill the whole
    // tree (bash's children included), not just the shell itself.
    const detached = process.platform !== "win32";
    const child = spawn("bash", ["-c", cmd], {
      ...(cwd ? { cwd } : {}),
      env: process.env,
      detached,
    });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    let killed = false;
    // Timeout escalation: SIGTERM the whole process group first (lets
    // pipelines flush + children clean up), SIGKILL any survivors after a
    // short grace. Straight-to-SIGKILL used to eat buffered output.
    const killTree = (signal: NodeJS.Signals) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // group already gone — fall through to the direct kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        // already dead
      }
    };
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (r: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise(r);
    };
    const timedOutResult = () => {
      const body = renderExec(
        "local",
        `⏱️ timed out after ${timeoutMs / 1000}s — killed; partial output kept below`,
        stdout.value(),
        stderr.value(),
      );
      return { ok: false, text: `${body}\n${TIMEOUT_HINT}` };
    };
    const timer = setTimeout(() => {
      killed = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      // `close` waits for the stdio pipes to drain — a surviving grandchild
      // that inherited stdout (Windows has no process groups; a detached
      // POSIX grandchild can escape the group kill) would otherwise hold
      // this promise open long past the timeout. Force-resolve with the
      // partial output once the escalation window has passed.
      forceTimer = setTimeout(
        () => finish(timedOutResult()),
        KILL_GRACE_MS + 1_000,
      );
    }, timeoutMs);
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    child.on("error", (err) => {
      finish({ ok: false, text: `Failed to run: ${err.message}` });
    });
    child.on("close", (code) => {
      if (killed) {
        finish(timedOutResult());
        return;
      }
      finish({
        ok: (code ?? 0) === 0,
        text: renderExec(
          "local",
          `exit ${code ?? 0}`,
          stdout.value(),
          stderr.value(),
        ),
      });
    });
  });
}

async function bashTeleported(
  chatId: number,
  deviceId: string,
  cmd: string,
  timeoutMs: number,
): Promise<Result> {
  const active = await getTeleport(chatId);
  const cwd = active?.cwd;
  // Wrap so the resulting working dir is reported back and persists across
  // calls (a `cd` in `cmd` carries forward), while the real exit code is
  // preserved. printf can't fail in a way that masks the command's status.
  const wrapped =
    `${cwd ? `cd ${shellQuote(cwd)} 2>/dev/null; ` : ""}` +
    `{ ${cmd}\n}; __talon_rc=$?; ` +
    `printf '${CWD_OPEN}%s${CWD_CLOSE}' "$(pwd 2>/dev/null)"; exit $__talon_rc`;
  const dispatched = await getMeshService().dispatchCommand(
    deviceId,
    "exec",
    { cmd: wrapped, timeoutMs },
    timeoutMs + 5_000,
  );
  if ("error" in dispatched) return { ok: false, text: dispatched.error };
  const { target, result } = dispatched;
  const data = result.data ?? {};
  let stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const via =
    typeof data.via === "string" && data.via ? ` via ${data.via}` : "";
  const exitCode =
    typeof data.exitCode === "number" ? data.exitCode : undefined;
  // Recover + strip the trailing cwd marker.
  const open = stdout.lastIndexOf(CWD_OPEN);
  if (open !== -1) {
    const close = stdout.indexOf(CWD_CLOSE, open);
    if (close !== -1) {
      const newCwd = stdout.slice(open + CWD_OPEN.length, close).trim();
      stdout = stdout.slice(0, open);
      if (newCwd) await setTeleportCwd(chatId, newCwd);
    }
  }
  if (!result.ok && exitCode === undefined) {
    return {
      ok: false,
      text: result.message ?? `${target.name} could not run the command.`,
    };
  }
  // The device marks a command it had to kill at its own exec budget with
  // this stderr marker (see the companion's device_exec) — surface the same
  // self-correction hint the local timeout path gets.
  const timedOutOnDevice = stderr.includes("[killed: timeout]");
  const body = renderExec(
    `${target.name}${via}`,
    `exit ${exitCode ?? "?"}`,
    stdout,
    stderr,
  );
  return {
    ok: exitCode === 0,
    text: timedOutOnDevice ? `${body}\n${TELEPORT_TIMEOUT_HINT}` : body,
  };
}

// ── read / write / edit ─────────────────────────────────────────────────────

async function read(
  chatId: number,
  path: unknown,
  offset: unknown,
  limit: unknown,
): Promise<Result> {
  const p = str(path);
  if (!p) return { ok: false, text: "A file path is required." };
  const start = num(offset) ?? 0;
  const max = Math.min(num(limit) ?? MAX_READ_LINES, MAX_READ_LINES);
  const active = await getTeleport(chatId);
  let content: string;
  let where: string;
  if (active) {
    const res = await getMeshService().readFileBytes(active.deviceId, p);
    if ("error" in res) return { ok: false, text: res.error };
    content = res.data.toString("utf8");
    where = active.deviceName;
  } else {
    try {
      content = await readFile(p, "utf8");
    } catch (err) {
      return { ok: false, text: `Cannot read ${p}: ${(err as Error).message}` };
    }
    where = "local";
  }
  const lines = content.split("\n");
  const slice = lines.slice(start, start + max);
  const numbered = slice
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");
  const more =
    lines.length > start + max
      ? `\n… (${lines.length - start - max} more lines; raise limit/offset)`
      : "";
  return {
    ok: true,
    text: `${p} [${where}] — ${lines.length} lines\n${numbered}${more}`,
  };
}

async function write(
  chatId: number,
  path: unknown,
  content: unknown,
): Promise<Result> {
  const p = str(path);
  if (!p) return { ok: false, text: "A file path is required." };
  const body = typeof content === "string" ? content : "";
  const active = await getTeleport(chatId);
  if (active) {
    return getMeshService().writeFileToDevice(active.deviceId, p, body);
  }
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  } catch (err) {
    return { ok: false, text: `Cannot write ${p}: ${(err as Error).message}` };
  }
  return { ok: true, text: `Wrote ${body.length} bytes to ${p} [local].` };
}

async function edit(
  chatId: number,
  path: unknown,
  oldString: unknown,
  newString: unknown,
  replaceAll: unknown,
): Promise<Result> {
  const p = str(path);
  if (!p) return { ok: false, text: "A file path is required." };
  const from = typeof oldString === "string" ? oldString : "";
  const to = typeof newString === "string" ? newString : "";
  if (from === to)
    return { ok: false, text: "old_string and new_string are identical." };
  const active = await getTeleport(chatId);
  const svc = getMeshService();

  let content: string;
  if (active) {
    const res = await svc.readFileBytes(active.deviceId, p);
    if ("error" in res) return { ok: false, text: res.error };
    content = res.data.toString("utf8");
  } else {
    try {
      content = await readFile(p, "utf8");
    } catch (err) {
      return { ok: false, text: `Cannot read ${p}: ${(err as Error).message}` };
    }
  }

  const count = from ? content.split(from).length - 1 : 0;
  if (count === 0) {
    return {
      ok: false,
      text: `old_string not found in ${p}.${nearMissHint(content, from)}`,
    };
  }
  if (count > 1 && replaceAll !== true) {
    return {
      ok: false,
      text: `old_string appears ${count}× in ${p}; pass replace_all or make it unique.`,
    };
  }
  const updated =
    replaceAll === true
      ? content.split(from).join(to)
      : content.replace(from, to);

  if (active) {
    const res = await svc.writeFileToDevice(active.deviceId, p, updated);
    return res.ok
      ? {
          ok: true,
          text: `Edited ${p} [${active.deviceName}] (${count} replacement${count === 1 ? "" : "s"}).`,
        }
      : res;
  }
  try {
    await writeFile(p, updated);
  } catch (err) {
    return { ok: false, text: `Cannot write ${p}: ${(err as Error).message}` };
  }
  return {
    ok: true,
    text: `Edited ${p} [local] (${count} replacement${count === 1 ? "" : "s"}).`,
  };
}

// ── glob / search ───────────────────────────────────────────────────────────

async function glob(
  chatId: number,
  pattern: unknown,
  path: unknown,
): Promise<Result> {
  const pat = str(pattern);
  if (!pat) return { ok: false, text: "A glob pattern is required." };
  const root = str(path) ?? ".";
  const active = await getTeleport(chatId);
  if (active) {
    // Prefer rg on the device; fall back to find (basename patterns via
    // -name, path patterns via -path). `command -v` gates the choice so a
    // no-match rg exit (1) isn't misread as "rg missing, run find too".
    const findExpr = pat.includes("/")
      ? `-path ${shellQuote(`*${pat}`)}`
      : `-name ${shellQuote(pat)}`;
    const cmd =
      `if command -v rg >/dev/null 2>&1; ` +
      `then rg --files -g ${shellQuote(pat)} ${shellQuote(root)}; ` +
      `else find ${shellQuote(root)} ${findExpr} 2>/dev/null; fi`;
    return bashTeleported(chatId, active.deviceId, cmd, 30_000);
  }
  const res = await runLocal(rgBin(), ["--files", "-g", pat, root]);
  let files: string[];
  if (res.code === 127) {
    // rg not installed — pure-JS fallback rather than lying "no matches".
    files = await globJs(pat, root);
  } else if (res.code > 1 && !res.stdout.trim()) {
    // exit 2 with output = partial results (e.g. permission-denied subdirs);
    // exit 2 with none = a real error worth surfacing.
    return {
      ok: false,
      text: `glob failed: ${res.stderr.trim() || `ripgrep exit ${res.code}`}`,
    };
  } else {
    files = res.stdout.trim().split("\n").filter(Boolean);
  }
  return {
    ok: true,
    text: files.length
      ? `${files.length} match(es):\n${files.slice(0, 200).join("\n")}${files.length > 200 ? `\n… (${files.length - 200} more)` : ""}`
      : `No files match ${pat} under ${root}.`,
  };
}

async function search(
  chatId: number,
  pattern: unknown,
  path: unknown,
  globPat: unknown,
  caseInsensitive: unknown,
): Promise<Result> {
  const pat = str(pattern);
  if (!pat) return { ok: false, text: "A search pattern is required." };
  const root = str(path) ?? ".";
  const g = str(globPat);
  const ci = caseInsensitive === true;
  // `-e` keeps a pattern that starts with "-" from being parsed as a flag
  // (same idiom for rg and grep).
  const flags = [
    "-n",
    "--color=never",
    ...(ci ? ["-i"] : []),
    ...(g ? ["-g", g] : []),
  ];
  const active = await getTeleport(chatId);
  if (active) {
    // Prefer rg on the device, fall back to grep (Android toybox has grep
    // but rarely rg). --include is grep's closest analogue of -g.
    const grepFlags = [
      "-rn",
      ...(ci ? ["-i"] : []),
      ...(g ? [`--include=${g}`] : []),
    ];
    const cmd =
      `if command -v rg >/dev/null 2>&1; ` +
      `then rg ${flags.map(shellQuote).join(" ")} -e ${shellQuote(pat)} ${shellQuote(root)}; ` +
      `else grep ${grepFlags.map(shellQuote).join(" ")} -e ${shellQuote(pat)} ${shellQuote(root)} 2>/dev/null; fi`;
    return bashTeleported(chatId, active.deviceId, cmd, 30_000);
  }
  const res = await runLocal(rgBin(), [...flags, "-e", pat, root]);
  let lines: string[];
  if (res.code === 127) {
    // rg not installed — pure-JS fallback rather than lying "no matches".
    try {
      lines = await searchJs(pat, root, g, ci);
    } catch (err) {
      return { ok: false, text: `search failed: ${(err as Error).message}` };
    }
  } else if (res.code > 1 && !res.stdout.trim()) {
    // exit 2 with output = partial results; exit 2 with none = real error.
    return {
      ok: false,
      text: `search failed: ${res.stderr.trim() || `ripgrep exit ${res.code}`}`,
    };
  } else {
    const out = res.stdout.trim();
    lines = out ? out.split("\n") : [];
  }
  return {
    ok: true,
    text: lines.length
      ? `${lines.length} match line(s):\n${lines.slice(0, 200).join("\n")}${lines.length > 200 ? `\n… (${lines.length - 200} more)` : ""}`
      : `No matches for ${pat} under ${root}.`,
  };
}

// ── pure-JS glob/search fallbacks (no ripgrep on the host) ──────────────────

/**
 * Glob without ripgrep, via node:fs `glob`. Mirrors rg's -g semantics for
 * bare names (a pattern without "/" matches at any depth) and skips
 * node_modules/.git, which rg would exclude via gitignore.
 */
async function globJs(pat: string, root: string): Promise<string[]> {
  const pattern = pat.includes("/") ? pat : `**/${pat}`;
  const out: string[] = [];
  try {
    for await (const entry of fsGlob(pattern, {
      cwd: root,
      exclude: (e: unknown) => {
        const name =
          typeof e === "string" ? e : ((e as { name?: string }).name ?? "");
        return (
          SKIP_DIRS_RE.test(name) || name === "node_modules" || name === ".git"
        );
      },
    })) {
      out.push(join(root, String(entry)));
      if (out.length >= MAX_JS_RESULTS) break;
    }
  } catch {
    // unreadable root etc. — empty result, caller reports "no matches"
  }
  return out;
}

/** Content search without ripgrep: walk text files and regex-match lines. */
async function searchJs(
  pat: string,
  root: string,
  globPat: string | undefined,
  caseInsensitive: boolean,
): Promise<string[]> {
  const re = new RegExp(pat, caseInsensitive ? "i" : "");
  let files: string[];
  try {
    const st = await fsStat(root);
    files = st.isFile() ? [root] : await globJs(globPat ?? "**/*", root);
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      const st = await fsStat(f);
      if (!st.isFile() || st.size > MAX_JS_FILE_BYTES) continue;
      content = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue; // binary
    const fileLines = content.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (re.test(fileLines[i])) lines.push(`${f}:${i + 1}:${fileLines[i]}`);
      if (lines.length >= MAX_JS_RESULTS) return lines;
    }
  }
  return lines;
}

/**
 * When an edit's old_string doesn't match verbatim, the cause is almost
 * always invisible: indentation, tabs vs spaces, or a trailing space. Point
 * at the closest-looking line so the model re-reads that region instead of
 * blindly retrying the same string.
 */
function nearMissHint(content: string, from: string): string {
  const probe =
    from
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length >= 8) ?? from.trim();
  if (!probe) return "";
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.trim().includes(probe));
  if (idx === -1) return "";
  return (
    `\nLine ${idx + 1} looks close — whitespace/indentation must match the file byte-for-byte. ` +
    `Re-read that region before retrying:\n${String(idx + 1).padStart(6)}\t${lines[idx]}`
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function runLocal(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env: process.env });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    child.on("error", () =>
      resolvePromise({
        code: 127,
        stdout: stdout.value(),
        stderr: stderr.value(),
      }),
    );
    child.on("close", (code) =>
      resolvePromise({
        code: code ?? 0,
        stdout: stdout.value(),
        stderr: stderr.value(),
      }),
    );
  });
}

function renderExec(
  where: string,
  status: string,
  stdout: string,
  stderr: string,
): string {
  const parts = [`[${where}] ${status}`];
  if (stdout.trim())
    parts.push(
      `--- stdout ---\n${clampExecOutput(stdout.replace(/\s+$/, ""))}`,
    );
  if (stderr.trim())
    parts.push(
      `--- stderr ---\n${clampExecOutput(stderr.replace(/\s+$/, ""))}`,
    );
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

function clampTimeout(value: unknown): number {
  const sec = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(
    MAX_EXEC_TIMEOUT_MS,
    Math.max(1_000, Math.round(sec * 1_000)),
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
