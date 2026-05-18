/**
 * Built-in filesystem + shell tools for the OpenAI Agents backend.
 *
 * The Claude SDK backend ships these as part of Claude Code (`Read`,
 * `Write`, `Edit`, `Bash`, `Glob`, `Grep`). The `@openai/agents` SDK
 * doesn't — it's model-agnostic and assumes the host wires whatever
 * capabilities the agent needs. To keep Talon's system prompt and
 * behavior consistent across backends, this module mirrors that
 * Claude-Code surface as plain `tool()` definitions.
 *
 * Tool names + parameter shapes match Claude Code exactly so the
 * shared prompt vocabulary ("read X", "write to ~/.talon/...") works
 * uniformly. Outputs mirror Claude Code's text format where useful
 * (e.g. `cat -n`-style line numbers for `Read`).
 *
 * Safety posture: same as the Claude SDK backend — full host access.
 * Talon already trusts the active model; sandboxing is a future
 * concern handled at the runtime layer, not here.
 */
import { tool } from "@openai/agents";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, glob } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

// ── Path resolution ─────────────────────────────────────────────────────────
//
// Tool inputs may be absolute, ~/-prefixed, or relative. Normalize to
// absolute paths so behavior doesn't depend on Talon's cwd.

function expandPath(input: string): string {
  if (input.startsWith("~/")) return resolvePath(homedir(), input.slice(2));
  if (input === "~") return homedir();
  if (isAbsolute(input)) return input;
  return resolvePath(process.cwd(), input);
}

// ── Read ────────────────────────────────────────────────────────────────────

const readTool = tool({
  name: "Read",
  description:
    "Read a text file from disk. Returns the file contents with " +
    "`cat -n`-style line numbering. `offset` (1-indexed) skips the " +
    "first N-1 lines; `limit` caps the number of lines returned.",
  parameters: z.object({
    file_path: z
      .string()
      .describe("Absolute path (or ~/...) to the file to read."),
    offset: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe("1-indexed line number to start reading from."),
    limit: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe("Maximum number of lines to read."),
  }),
  async execute({ file_path, offset, limit }) {
    const abs = expandPath(file_path);
    const text = await readFile(abs, "utf8");
    const allLines = text.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit != null ? start + limit : allLines.length;
    const slice = allLines.slice(start, end);
    return slice
      .map((line, i) => `${String(start + i + 1).padStart(6, " ")}\t${line}`)
      .join("\n");
  },
});

// ── Write ───────────────────────────────────────────────────────────────────

const writeTool = tool({
  name: "Write",
  description:
    "Write a string to a file, creating it (and any missing parent " +
    "directories) if necessary. Overwrites existing content. Use " +
    "Edit for partial in-place changes.",
  parameters: z.object({
    file_path: z
      .string()
      .describe("Absolute path (or ~/...) to the file to write."),
    content: z.string().describe("Full file contents to write."),
  }),
  async execute({ file_path, content }) {
    const abs = expandPath(file_path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return `wrote ${content.length} bytes to ${abs}`;
  },
});

// ── Edit ────────────────────────────────────────────────────────────────────

const editTool = tool({
  name: "Edit",
  description:
    "Replace text in a file. `old_string` must appear verbatim in " +
    "the file. By default `old_string` must be unique; set " +
    "`replace_all` to replace every occurrence. Use this for surgical " +
    "changes instead of rewriting the whole file with Write.",
  parameters: z.object({
    file_path: z
      .string()
      .describe("Absolute path (or ~/...) to the file to modify."),
    old_string: z.string().describe("Exact text to replace."),
    new_string: z
      .string()
      .describe("Replacement text. Must differ from old_string."),
    replace_all: z
      .boolean()
      .nullable()
      .describe(
        "When true, replace every occurrence of old_string. " +
          "When false or null, the match must be unique.",
      ),
  }),
  async execute({ file_path, old_string, new_string, replace_all }) {
    if (old_string === new_string) {
      throw new Error("old_string and new_string must differ");
    }
    const abs = expandPath(file_path);
    const original = await readFile(abs, "utf8");
    if (replace_all) {
      const next = original.split(old_string).join(new_string);
      if (next === original) {
        throw new Error(`old_string not found in ${abs}`);
      }
      await writeFile(abs, next, "utf8");
      const count = original.split(old_string).length - 1;
      return `replaced ${count} occurrence${count === 1 ? "" : "s"} in ${abs}`;
    }
    const first = original.indexOf(old_string);
    if (first === -1) throw new Error(`old_string not found in ${abs}`);
    const second = original.indexOf(old_string, first + old_string.length);
    if (second !== -1) {
      throw new Error(
        `old_string is not unique in ${abs} — pass replace_all=true ` +
          `or add more surrounding context to disambiguate`,
      );
    }
    await writeFile(
      abs,
      original.slice(0, first) +
        new_string +
        original.slice(first + old_string.length),
      "utf8",
    );
    return `replaced 1 occurrence in ${abs}`;
  },
});

// ── Bash ────────────────────────────────────────────────────────────────────

const BASH_DEFAULT_TIMEOUT_MS = 30_000;
const BASH_MAX_TIMEOUT_MS = 600_000;

function runShell(
  command: string,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}> {
  return new Promise((resolveResult) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let timedOut = false;
    child.on("error", (err) => {
      // spawn failed (e.g. bash not in PATH on Windows). Resolve instead
      // of letting Node emit an uncaught error — the tool returns the
      // diagnostic so callers can surface it rather than crashing.
      clearTimeout(killer);
      resolveResult({ stdout, stderr: err.message, code: -1, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolveResult({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

const bashTool = tool({
  name: "Bash",
  description:
    "Run a shell command via `bash -lc`. Returns combined stdout " +
    "and stderr along with the exit code. Default timeout 30s, max " +
    "10min. Use for inspecting files, running scripts, package " +
    "managers, git, etc. Do not start long-running servers — there " +
    "is no background mode here.",
  parameters: z.object({
    command: z.string().describe("Shell command to execute."),
    description: z
      .string()
      .nullable()
      .describe(
        "Short (5-10 word) explanation of what this command does. " +
          "Recorded in logs.",
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(BASH_MAX_TIMEOUT_MS)
      .nullable()
      .describe(
        `Optional timeout in milliseconds (max ${BASH_MAX_TIMEOUT_MS}).`,
      ),
  }),
  async execute({ command, timeout_ms }) {
    const timeout = timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS;
    const result = await runShell(command, timeout);
    const parts: string[] = [];
    if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
    if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
    parts.push(
      `--- exit ${result.code}${result.timedOut ? " (timed out)" : ""} ---`,
    );
    return parts.join("\n");
  },
});

// ── Glob ────────────────────────────────────────────────────────────────────

const globTool = tool({
  name: "Glob",
  description:
    "List files matching a glob pattern (e.g. `**/*.ts`, " +
    "`src/**/*.md`). Returns absolute paths, one per line, sorted " +
    "alphabetically. Searches under `path` if provided, otherwise " +
    "under the current working directory.",
  parameters: z.object({
    pattern: z.string().describe("Glob pattern to match (e.g. `src/**/*.ts`)."),
    path: z
      .string()
      .nullable()
      .describe(
        "Directory to search under. Defaults to the current " +
          "working directory.",
      ),
  }),
  async execute({ pattern, path }) {
    const cwd = path ? expandPath(path) : process.cwd();
    const matches: string[] = [];
    for await (const entry of glob(pattern, { cwd })) {
      matches.push(resolvePath(cwd, entry));
    }
    matches.sort();
    return matches.length > 0 ? matches.join("\n") : "(no matches)";
  },
});

// ── Grep ────────────────────────────────────────────────────────────────────

const grepTool = tool({
  name: "Grep",
  description:
    "Search for a regular expression in files using the system " +
    "`grep` (or `rg` when available). Returns matching lines with " +
    "file paths, line numbers, and content.",
  parameters: z.object({
    pattern: z.string().describe("Regular expression to search for."),
    path: z
      .string()
      .nullable()
      .describe(
        "File or directory to search. Defaults to the current " +
          "working directory.",
      ),
    include: z
      .string()
      .nullable()
      .describe("Glob limiting which files to search (e.g. `*.ts`)."),
  }),
  async execute({ pattern, path, include }) {
    const target = path ? expandPath(path) : process.cwd();
    // Prefer ripgrep if installed; fall back to GNU/BSD grep.
    const rgCheck = await runShell("command -v rg", 2000);
    const useRg = rgCheck.code === 0 && rgCheck.stdout.trim().length > 0;

    let command: string;
    if (useRg) {
      const includeFlag = include ? ` --glob ${JSON.stringify(include)}` : "";
      command = `rg -n --no-heading${includeFlag} ${JSON.stringify(pattern)} ${JSON.stringify(target)}`;
    } else {
      const includeFlag = include
        ? ` --include=${JSON.stringify(include)}`
        : "";
      command = `grep -RIn${includeFlag} -E ${JSON.stringify(pattern)} ${JSON.stringify(target)}`;
    }
    const result = await runShell(command, 30_000);
    // Both rg and grep return non-zero exit when there are no matches; that
    // isn't an error from the model's perspective, surface it as "no matches".
    if (result.code !== 0 && !result.stdout && !result.stderr) {
      return "(no matches)";
    }
    if (result.stdout) return result.stdout.trimEnd();
    return result.stderr.trimEnd() || "(no matches)";
  },
});

// ── Public surface ──────────────────────────────────────────────────────────

/**
 * The full Claude-Code-equivalent filesystem + shell toolset for
 * OpenAI Agents. Pass this into `new Agent({ tools: [...] })`.
 */
export const OPENAI_AGENTS_BUILTIN_TOOLS = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
] as const;
