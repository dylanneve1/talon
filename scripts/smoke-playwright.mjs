#!/usr/bin/env node
/**
 * Playwright MCP functional smoke — matrix Linux/macOS/Windows × chromium.
 *
 * Verifies that the Talon-pinned `@playwright/mcp` version is installed
 * at the expected version, downloads the target browser, then exercises
 * the MCP server via initialize → tools/list → browser_navigate →
 * browser_close. The navigate target is about:blank so no external
 * network is needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { StdioMcpClient } from "./lib/mcp-stdio-client.mjs";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MCP_BIN = join(REPO_ROOT, "node_modules/@playwright/mcp/cli.js");

// On Windows npm ships `npx.cmd` rather than `npx`; Node's spawn won't
// resolve `.cmd` extensions without `shell: true`.
const NPX_BIN = process.platform === "win32" ? "npx.cmd" : "npx";

function pinnedVersion() {
  const src = readFileSync(
    join(REPO_ROOT, "src/plugins/playwright/heal.ts"),
    "utf-8",
  );
  const match = /PLAYWRIGHT_MCP_VERSION\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse PLAYWRIGHT_MCP_VERSION");
  return match[1];
}

function log(...args) {
  console.log("[playwright-smoke]", ...args);
}

async function run(cmd, args) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (stdout.trim()) log(stdout.trim().split("\n").slice(0, 6).join("\n"));
  if (stderr.trim())
    log(`stderr: ${stderr.trim().split("\n").slice(0, 4).join("\n")}`);
  return { stdout, stderr };
}

async function install() {
  const target = pinnedVersion();
  log(`pinned @playwright/mcp: ${target}`);
  if (!existsSync(MCP_BIN)) {
    throw new Error(`${MCP_BIN} missing — run 'npm ci' in the Talon checkout first`);
  }
  const pkgJsonPath = resolve(dirname(MCP_BIN), "package.json");
  const installedVersion = JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version;
  log(`installed @playwright/mcp: ${installedVersion}`);
  if (installedVersion !== target) {
    throw new Error(
      `installed ${installedVersion} != pinned ${target} — 'npm ci' should have aligned these`,
    );
  }
  const browser = process.env.PW_SMOKE_BROWSER ?? "chromium";
  await run(NPX_BIN, ["playwright", "install", browser]);
  log(`browser installed: ${browser}`);
}

async function smoke() {
  if (!existsSync(MCP_BIN)) {
    throw new Error(`${MCP_BIN} missing — run install step first`);
  }
  const browser = process.env.PW_SMOKE_BROWSER ?? "chromium";
  const args = [MCP_BIN, "--no-sandbox", "--headless"];
  if (browser !== "chromium") args.push("--browser", browser);
  log(`spawning @playwright/mcp with ${browser}`);
  const child = spawn("node", args, { stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioMcpClient(child, { name: "playwright" });
  try {
    log("initialize…");
    const protocol = await client.handshake();
    log(`MCP protocol: ${protocol}`);
    log("tools/list…");
    const tools = await client.listTools();
    log(`tools (${tools.length}): ${tools.slice(0, 8).join(", ")}…`);
    for (const required of ["browser_navigate", "browser_close"]) {
      if (!tools.includes(required)) {
        throw new Error(`expected tool "${required}" missing from tools/list`);
      }
    }
    log("browser_navigate about:blank…");
    await client.callTool(
      "browser_navigate",
      { url: "about:blank" },
      90_000,
    );
    log("browser_navigate OK");
    log("browser_close…");
    await client.callTool("browser_close", {}, 30_000);
    log("browser_close OK");
  } finally {
    await client.close().catch(() => {});
  }
  log(`smoke OK on ${process.platform} (${browser})`);
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
      `[playwright-smoke] FAILED: ${err.stack || err.message || err}`,
    );
    process.exit(1);
  }
}

main();
