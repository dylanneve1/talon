/**
 * `native_glob` / `native_search` — find files by pattern, find text inside
 * them.
 *
 * ripgrep is the fast path on both hosts; when it isn't installed the local
 * runs fall back to a pure-JS walker rather than lying "no matches", and a
 * teleported run falls back to the device's find/grep.
 */

import { glob as fsGlob, readFile, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { getTeleport } from "../../../mesh/devices/teleport.js";
import { bashTeleported } from "./exec-remote.js";
import { resolvePathParam, str } from "./params.js";
import type { Result } from "./results.js";
import { runLocal, shellQuote } from "./shell.js";
import type { SharedActionHandlers } from "../types.js";

/**
 * ripgrep binary, resolved from PATH (env-overridable for tests). NOT a
 * hardcoded absolute path: /usr/bin/rg only exists on some Linux installs,
 * and a missing binary must fall back loudly (or to the pure-JS walker),
 * never masquerade as "no matches".
 */
function rgBin(): string {
  return process.env.TALON_NATIVE_RG ?? "rg";
}
/** Caps for the pure-JS glob/search fallbacks (rg unavailable). */
const MAX_JS_RESULTS = 2_000;
const MAX_JS_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

export const searchHandlers: SharedActionHandlers = {
  native_glob: (body, chatId) => glob(chatId, body.pattern, body.path),
  native_search: (body, chatId) =>
    search(chatId, body.pattern, body.path, body.glob, body.case_insensitive),
};

async function glob(
  chatId: number,
  pattern: unknown,
  path: unknown,
): Promise<Result> {
  const pat = str(pattern);
  if (!pat) return { ok: false, text: "A glob pattern is required." };
  const active = await getTeleport(chatId);
  const root = resolvePathParam(str(path) ?? ".", active?.deviceName);
  if (active) {
    // Prefer rg on the device; fall back to find (basename patterns via
    // -name, path patterns via -path). `command -v` gates the choice so a
    // no-match rg exit (1) isn't misread as "rg missing, run find too".
    const findExpr = pat.includes("/")
      ? `-type f -path ${shellQuote(`*${pat}`)}`
      : `-type f -name ${shellQuote(pat)}`;
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
  // rg's parallel directory walk (and the JS fallback's) emit in
  // nondeterministic order — sort so identical calls render identically.
  files.sort();
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
  const active = await getTeleport(chatId);
  const root = resolvePathParam(str(path) ?? ".", active?.deviceName);
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
