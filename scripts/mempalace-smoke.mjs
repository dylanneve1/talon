#!/usr/bin/env node
/**
 * MemPalace functional smoke test — driven from CI across Linux/macOS/Windows.
 *
 * Subcommands:
 *   install  — create venv, pip install the Talon-pinned mempalace release,
 *              verify `import mempalace` and `import mempalace.mcp_server`.
 *   smoke    — spawn the MCP server (stdio), run MCP `initialize` →
 *              `tools/list` → `tools/call mempalace_status`, assert
 *              responses are well-formed and include expected tools.
 *
 * Exits non-zero on any failure. Prints structured progress so CI logs are
 * skimmable.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const IS_WINDOWS = process.platform === "win32";
const VENV_DIR = join(REPO_ROOT, ".smoke-mempalace-venv");
const VENV_PY = IS_WINDOWS
  ? join(VENV_DIR, "Scripts", "python.exe")
  : join(VENV_DIR, "bin", "python");

/** Read the pinned version from install.ts so source stays single-truth. */
function pinnedVersion() {
  const src = readFileSync(
    join(REPO_ROOT, "src/plugins/mempalace/install.ts"),
    "utf-8",
  );
  const match = /MEMPALACE_INSTALL_TARGET\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse MEMPALACE_INSTALL_TARGET");
  return match[1];
}

function minVersion() {
  const src = readFileSync(
    join(REPO_ROOT, "src/plugins/mempalace/install.ts"),
    "utf-8",
  );
  const match = /MEMPALACE_MIN_VERSION\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse MEMPALACE_MIN_VERSION");
  return match[1];
}

function log(...args) {
  console.log("[smoke]", ...args);
}

async function run(cmd, args, opts = {}) {
  const label = `${cmd} ${args.join(" ")}`;
  log(`$ ${label}`);
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  if (stdout.trim()) log(stdout.trim());
  if (stderr.trim()) log(`stderr: ${stderr.trim()}`);
  return { stdout, stderr };
}

// ── install ──────────────────────────────────────────────────────────────

async function doInstall() {
  const target = pinnedVersion();
  log(`pinned mempalace version: ${target}`);

  const pythonBootstrap = process.env.PYTHON ?? (IS_WINDOWS ? "python" : "python3");
  log(`bootstrap python: ${pythonBootstrap}`);

  if (!existsSync(VENV_PY)) {
    await run(pythonBootstrap, ["-m", "venv", VENV_DIR]);
  } else {
    log(`reusing existing venv at ${VENV_DIR}`);
  }

  // Upgrade pip first — fresh venvs often ship stale pip that chokes on
  // newer wheels. Ignore failures, not critical.
  try {
    await run(VENV_PY, ["-m", "pip", "install", "--upgrade", "pip"]);
  } catch (err) {
    log(`pip upgrade skipped: ${err.message}`);
  }

  await run(VENV_PY, [
    "-m",
    "pip",
    "install",
    "--upgrade",
    `mempalace==${target}`,
  ]);

  // Use a two-step check: first verify mempalace importable (version via
  // sys.stdout), then verify mempalace.mcp_server importable separately. The
  // mcp_server import is noisy (banner on stderr) which can confuse callers
  // that capture both streams.
  const { stdout } = await run(VENV_PY, [
    "-c",
    "import mempalace, sys; sys.stdout.write(getattr(mempalace, '__version__', ''))",
  ]);
  const installed = stdout.trim();
  log(`installed mempalace: ${installed}`);
  if (installed !== target) {
    throw new Error(
      `installed version "${installed}" != pinned target ${target}`,
    );
  }

  await run(VENV_PY, ["-c", "import mempalace.mcp_server"]);
  log("install OK");
}

// ── smoke ────────────────────────────────────────────────────────────────

/** Minimal MCP client — just enough to hit initialize → tools/list → call. */
class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[mcp-stderr] ${chunk}`);
    });
    this.child.on("exit", (code, signal) => {
      const err = new Error(`MCP server exited code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`non-JSON line from server: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    const payload = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      this.child.on("exit", () => resolve());
    });
  }
}

async function doSmoke() {
  if (!existsSync(VENV_PY)) {
    throw new Error(
      `expected python at ${VENV_PY} — run 'node scripts/mempalace-smoke.mjs install' first`,
    );
  }

  const palace = mkdtempSync(join(tmpdir(), "talon-smoke-palace-"));
  log(`temp palace: ${palace}`);

  const child = spawn(
    VENV_PY,
    ["-m", "mempalace.mcp_server", "--palace", palace],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MEMPALACE_PALACE_PATH: palace },
    },
  );

  const client = new StdioMcpClient(child);

  try {
    log("initialize…");
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "talon-smoke", version: "0.0.0" },
    });
    if (!init?.protocolVersion) {
      throw new Error(
        `initialize returned no protocolVersion: ${JSON.stringify(init)}`,
      );
    }
    log(`server protocol: ${init.protocolVersion}`);
    client.notify("notifications/initialized", {});

    log("tools/list…");
    const tools = await client.request("tools/list", {});
    if (!Array.isArray(tools?.tools) || tools.tools.length === 0) {
      throw new Error(
        `tools/list returned no tools: ${JSON.stringify(tools)}`,
      );
    }
    const toolNames = tools.tools.map((t) => t.name).sort();
    log(`tools (${toolNames.length}): ${toolNames.slice(0, 10).join(", ")}${toolNames.length > 10 ? ", …" : ""}`);
    const expected = ["mempalace_status", "mempalace_search"];
    for (const name of expected) {
      if (!toolNames.includes(name)) {
        throw new Error(`expected tool "${name}" not found in tools/list`);
      }
    }

    log("tools/call mempalace_status…");
    const statusCall = await client.request("tools/call", {
      name: "mempalace_status",
      arguments: {},
    });
    if (!statusCall?.content || !Array.isArray(statusCall.content)) {
      throw new Error(
        `mempalace_status returned unexpected shape: ${JSON.stringify(statusCall).slice(0, 300)}`,
      );
    }
    log("mempalace_status OK");
  } finally {
    await client.close().catch(() => {});
  }

  log(`smoke OK on ${process.platform} (python floor >= ${minVersion()})`);
}

// ── entrypoint ───────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] ?? "smoke";
  try {
    if (cmd === "install") await doInstall();
    else if (cmd === "smoke") await doSmoke();
    else {
      console.error(`unknown subcommand "${cmd}" — use install | smoke`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`[smoke] FAILED: ${err.stack || err.message || err}`);
    process.exit(1);
  }
}

main();
