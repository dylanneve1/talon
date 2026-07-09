/**
 * Native tools — Talon's own shell/filesystem tools, replacing the SDK's
 * built-in Bash/Read/Write/Edit/Glob/Grep when `config.nativeTools` is on.
 *
 * Their defining feature: every one checks the active `teleport` target. With
 * no teleport, they run on the daemon host (local spawn / local fs / local
 * ripgrep). With a teleport engaged, they run ON the companion device via the
 * mesh exec/fs channel — so `bash`/`read`/`write`/… transparently operate on
 * the phone. Talon acts as if it were running on whichever node is active.
 *
 *   teleport(device)  → native tools target that device
 *   teleport_back()   → native tools run locally again
 *
 * The teleported path reuses the exec/fs command surface on MeshService; the
 * local path is a thin, well-scoped reimplementation of the built-ins.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getMeshService } from "../../mesh/index.js";
import {
  clearTeleport,
  getTeleport,
  setTeleport,
  setTeleportCwd,
} from "../../mesh/teleport.js";
import type { SharedActionHandlers } from "./types.js";

type Result = { ok: boolean; text: string };

const RG = "/usr/bin/rg";
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 300_000;
const MAX_READ_LINES = 2_000;
/** Markers used to recover the post-command working dir from a teleport shell. */
const CWD_OPEN = "__TALON_CWD__";
const CWD_CLOSE = "__TALON_CWD_END__";

export const nativeHandlers: SharedActionHandlers = {
  teleport: (body) => teleport(body.device),
  teleport_back: () => teleportBack(),
  native_bash: (body) => bash(body.command, body.cwd, body.timeout_sec),
  native_read: (body) => read(body.path, body.offset, body.limit),
  native_write: (body) => write(body.path, body.content),
  native_edit: (body) =>
    edit(body.path, body.old_string, body.new_string, body.replace_all),
  native_glob: (body) => glob(body.pattern, body.path),
  native_search: (body) =>
    search(body.pattern, body.path, body.glob, body.case_insensitive),
};

// ── Teleport control ────────────────────────────────────────────────────────

async function teleport(query: unknown): Promise<Result> {
  const svc = getMeshService();
  await svc.list();
  const target = svc.chooseDevice(query);
  if (!target) {
    return {
      ok: false,
      text:
        typeof query === "string" && query.trim()
          ? `No mesh device matches "${query}". Use list_devices to see them.`
          : "No mesh device to teleport to. Register a companion first.",
    };
  }
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
  await setTeleport(target.id, target.name);
  return {
    ok: true,
    text: [
      `🛰️ Teleported onto ${target.name}. Native bash/read/write/edit/glob/search now run ON that device.`,
      `Working dir starts at the device default; \`cd\` in bash persists across calls.`,
      `Call teleport_back to return to the daemon host.`,
    ].join(" "),
  };
}

async function teleportBack(): Promise<Result> {
  const prior = await clearTeleport();
  return {
    ok: true,
    text: prior
      ? `↩️ Teleported back from ${prior.deviceName}. Native tools run on the daemon host again.`
      : "Not teleported — native tools already run on the daemon host.",
  };
}

// ── bash ────────────────────────────────────────────────────────────────────

async function bash(
  command: unknown,
  cwd: unknown,
  timeoutSec: unknown,
): Promise<Result> {
  const cmd = typeof command === "string" ? command : "";
  if (!cmd.trim()) return { ok: false, text: "No command given." };
  const timeoutMs = clampTimeout(timeoutSec);
  const active = await getTeleport();
  if (active) return bashTeleported(active.deviceId, cmd, timeoutMs);
  return bashLocal(cmd, typeof cwd === "string" ? cwd : undefined, timeoutMs);
}

function bashLocal(
  cmd: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<Result> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-c", cmd], {
      ...(cwd ? { cwd } : {}),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, text: `Failed to run: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exit = killed ? `killed (timeout ${timeoutMs / 1000}s)` : `exit ${code ?? 0}`;
      resolvePromise({
        ok: !killed && (code ?? 0) === 0,
        text: renderExec("local", exit, stdout, stderr),
      });
    });
  });
}

async function bashTeleported(
  deviceId: string,
  cmd: string,
  timeoutMs: number,
): Promise<Result> {
  const active = await getTeleport();
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
  const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
  // Recover + strip the trailing cwd marker.
  const open = stdout.lastIndexOf(CWD_OPEN);
  if (open !== -1) {
    const close = stdout.indexOf(CWD_CLOSE, open);
    if (close !== -1) {
      const newCwd = stdout.slice(open + CWD_OPEN.length, close).trim();
      stdout = stdout.slice(0, open);
      if (newCwd) await setTeleportCwd(newCwd);
    }
  }
  if (!result.ok && exitCode === undefined) {
    return { ok: false, text: result.message ?? `${target.name} could not run the command.` };
  }
  return {
    ok: exitCode === 0,
    text: renderExec(target.name, `exit ${exitCode ?? "?"}`, stdout, stderr),
  };
}

// ── read / write / edit ─────────────────────────────────────────────────────

async function read(
  path: unknown,
  offset: unknown,
  limit: unknown,
): Promise<Result> {
  const p = str(path);
  if (!p) return { ok: false, text: "A file path is required." };
  const start = num(offset) ?? 0;
  const max = Math.min(num(limit) ?? MAX_READ_LINES, MAX_READ_LINES);
  const active = await getTeleport();
  let content: string;
  let where: string;
  if (active) {
    const res = await getMeshService().readFileFromDevice(active.deviceId, p);
    if (!res.ok) return res;
    // readFileFromDevice returns a "<path> on <name> (size):\n\n<content>"
    // envelope; split off the body.
    const sep = res.text.indexOf("\n\n");
    content = sep === -1 ? res.text : res.text.slice(sep + 2);
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

async function write(path: unknown, content: unknown): Promise<Result> {
  const p = str(path);
  if (!p) return { ok: false, text: "A file path is required." };
  const body = typeof content === "string" ? content : "";
  const active = await getTeleport();
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
  path: unknown,
  oldString: unknown,
  newString: unknown,
  replaceAll: unknown,
): Promise<Result> {
  const p = str(path);
  if (!p) return { ok: false, text: "A file path is required." };
  const from = typeof oldString === "string" ? oldString : "";
  const to = typeof newString === "string" ? newString : "";
  if (from === to) return { ok: false, text: "old_string and new_string are identical." };
  const active = await getTeleport();
  const svc = getMeshService();

  let content: string;
  if (active) {
    const res = await svc.readFileFromDevice(active.deviceId, p);
    if (!res.ok) return res;
    const sep = res.text.indexOf("\n\n");
    content = sep === -1 ? "" : res.text.slice(sep + 2);
  } else {
    try {
      content = await readFile(p, "utf8");
    } catch (err) {
      return { ok: false, text: `Cannot read ${p}: ${(err as Error).message}` };
    }
  }

  const count = from ? content.split(from).length - 1 : 0;
  if (count === 0) return { ok: false, text: `old_string not found in ${p}.` };
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
      ? { ok: true, text: `Edited ${p} [${active.deviceName}] (${count} replacement${count === 1 ? "" : "s"}).` }
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

async function glob(pattern: unknown, path: unknown): Promise<Result> {
  const pat = str(pattern);
  if (!pat) return { ok: false, text: "A glob pattern is required." };
  const root = str(path) ?? ".";
  const active = await getTeleport();
  if (active) {
    // Best-effort on-device glob via find/rg.
    const cmd = `${RG} --files -g ${shellQuote(pat)} ${shellQuote(root)} 2>/dev/null || find ${shellQuote(root)} -name ${shellQuote(pat)} 2>/dev/null`;
    return bashTeleported(active.deviceId, cmd, 30_000);
  }
  const res = await runLocal(RG, ["--files", "-g", pat, root]);
  if (res.code !== 0 && !res.stdout.trim()) {
    return { ok: true, text: `No files match ${pat} under ${root}.` };
  }
  const files = res.stdout.trim().split("\n").filter(Boolean);
  return {
    ok: true,
    text: files.length
      ? `${files.length} match(es):\n${files.slice(0, 200).join("\n")}${files.length > 200 ? `\n… (${files.length - 200} more)` : ""}`
      : `No files match ${pat} under ${root}.`,
  };
}

async function search(
  pattern: unknown,
  path: unknown,
  globPat: unknown,
  caseInsensitive: unknown,
): Promise<Result> {
  const pat = str(pattern);
  if (!pat) return { ok: false, text: "A search pattern is required." };
  const root = str(path) ?? ".";
  const g = str(globPat);
  const flags = [
    "-n",
    "--color=never",
    ...(caseInsensitive === true ? ["-i"] : []),
    ...(g ? ["-g", g] : []),
  ];
  const active = await getTeleport();
  if (active) {
    const cmd = `${RG} ${flags.map(shellQuote).join(" ")} ${shellQuote(pat)} ${shellQuote(root)}`;
    return bashTeleported(active.deviceId, cmd, 30_000);
  }
  const res = await runLocal(RG, [...flags, pat, root]);
  if (res.code === 1 && !res.stdout.trim()) {
    return { ok: true, text: `No matches for ${pat} under ${root}.` };
  }
  const out = res.stdout.trim();
  const lines = out ? out.split("\n") : [];
  return {
    ok: true,
    text: lines.length
      ? `${lines.length} match line(s):\n${lines.slice(0, 200).join("\n")}${lines.length > 200 ? `\n… (${lines.length - 200} more)` : ""}`
      : `No matches for ${pat} under ${root}.`,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function runLocal(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolvePromise({ code: 127, stdout, stderr }));
    child.on("close", (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
  });
}

function renderExec(
  where: string,
  status: string,
  stdout: string,
  stderr: string,
): string {
  const parts = [`[${where}] ${status}`];
  if (stdout.trim()) parts.push(`--- stdout ---\n${stdout.replace(/\s+$/, "")}`);
  if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.replace(/\s+$/, "")}`);
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

function clampTimeout(value: unknown): number {
  const sec = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(1_000, Math.round(sec * 1_000)));
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
