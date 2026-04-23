#!/usr/bin/env node
/**
 * MemPalace functional smoke driver. CI target for Linux/macOS/Windows ×
 * Python 3.11/3.12. Mirrors exactly what the self-heal does in production,
 * but calibrated to fail fast and log loudly.
 *
 * Steps:
 *   1. Read pinned MEMPALACE_INSTALL_TARGET from src/plugins/mempalace/heal.ts
 *      so source is single-truth.
 *   2. Create a fresh venv in .smoke-mempalace-venv/ (CI uses matrix Python).
 *   3. pip install the pinned version. Stream subprocess output live.
 *   4. Verify `import mempalace; __version__` matches exactly.
 *   5. Verify `import mempalace.mcp_server` succeeds.
 *   6. Spawn the MCP server, initialize, tools/list, assert expected tool
 *      names, call mempalace_status.
 *
 * Exits non-zero on any deviation.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "./lib/mcp-stdio-client.mjs";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const IS_WINDOWS = process.platform === "win32";
const VENV_DIR = join(REPO_ROOT, ".smoke-mempalace-venv");
const VENV_PY = IS_WINDOWS
  ? join(VENV_DIR, "Scripts", "python.exe")
  : join(VENV_DIR, "bin", "python");

function pinnedVersion() {
  const src = readFileSync(
    join(REPO_ROOT, "src/plugins/mempalace/heal.ts"),
    "utf-8",
  );
  const match = /MEMPALACE_TARGET\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse MEMPALACE_TARGET");
  return match[1];
}

function log(...args) {
  console.log("[mempalace-smoke]", ...args);
}

async function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  if (stdout.trim()) log(stdout.trim().split("\n").slice(0, 8).join("\n"));
  if (stderr.trim())
    log(`stderr: ${stderr.trim().split("\n").slice(0, 4).join("\n")}`);
  return { stdout, stderr };
}

async function install() {
  const target = pinnedVersion();
  log(`pinned mempalace: ${target}`);
  const bootstrap =
    process.env.PYTHON ?? (IS_WINDOWS ? "python" : "python3");
  if (!existsSync(VENV_PY)) {
    await run(bootstrap, ["-m", "venv", VENV_DIR]);
  } else {
    log(`reusing venv at ${VENV_DIR}`);
  }
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
  const { stdout } = await run(VENV_PY, [
    "-c",
    "import mempalace, sys; sys.stdout.write(getattr(mempalace, '__version__', ''))",
  ]);
  const installed = stdout.trim();
  if (installed !== target) {
    throw new Error(`installed mempalace ${installed} != pinned ${target}`);
  }
  await run(VENV_PY, ["-c", "import mempalace.mcp_server"]);
  log(`install OK — mempalace ${installed} ready`);
}

async function smoke() {
  if (!existsSync(VENV_PY)) {
    throw new Error(
      `expected venv python at ${VENV_PY} — run the install step first`,
    );
  }
  const palace = mkdtempSync(join(tmpdir(), "talon-mempalace-smoke-"));
  log(`temp palace: ${palace}`);
  const child = spawn(
    VENV_PY,
    ["-m", "mempalace.mcp_server", "--palace", palace],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MEMPALACE_PALACE_PATH: palace },
    },
  );
  const client = new StdioMcpClient(child, { name: "mempalace" });
  try {
    log("initialize…");
    const protocol = await client.handshake();
    log(`MCP protocol: ${protocol}`);

    log("tools/list…");
    const tools = await client.listTools();
    log(`tools (${tools.length}): ${tools.slice(0, 8).join(", ")}…`);
    for (const required of ["mempalace_status", "mempalace_search"]) {
      if (!tools.includes(required)) {
        throw new Error(
          `expected tool "${required}" missing from mempalace tools/list`,
        );
      }
    }

    log("tools/call mempalace_status…");
    const status = await client.callTool("mempalace_status", {});
    if (!Array.isArray(status?.content)) {
      throw new Error(
        `mempalace_status returned unexpected shape: ${JSON.stringify(status).slice(0, 300)}`,
      );
    }
    log("mempalace_status OK");
  } finally {
    await client.close().catch(() => {});
  }
  log(`smoke OK on ${process.platform}`);
}

async function main() {
  const cmd = process.argv[2] ?? "smoke";
  try {
    if (cmd === "install") await install();
    else if (cmd === "smoke") await smoke();
    else {
      console.error(`unknown subcommand "${cmd}" — use install | smoke`);
      process.exit(2);
    }
  } catch (err) {
    console.error(
      `[mempalace-smoke] FAILED: ${err.stack || err.message || err}`,
    );
    process.exit(1);
  }
}

main();
