#!/usr/bin/env node
/**
 * Playwright MCP functional smoke — CI-driven, multi-OS.
 *
 * Subcommands:
 *   install  — ensure @playwright/mcp is resolved (via npm ci), run
 *              `npx playwright install <browser>` for the target browser.
 *   smoke    — spawn @playwright/mcp over stdio, run MCP initialize →
 *              tools/list → tools/call browser_navigate (about:blank) →
 *              tools/call browser_close. Assert responses are well-formed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const MCP_BIN = resolve(REPO_ROOT, "node_modules/@playwright/mcp/cli.js");

function pinnedVersion() {
  const src = readFileSync(
    resolve(REPO_ROOT, "src/plugins/playwright/install.ts"),
    "utf-8",
  );
  const match = /PLAYWRIGHT_MCP_VERSION\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse PLAYWRIGHT_MCP_VERSION");
  return match[1];
}

function log(...args) {
  console.log("[pw-smoke]", ...args);
}

async function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  if (stdout.trim()) log(stdout.trim().split("\n").slice(0, 6).join("\n"));
  if (stderr.trim()) log(`stderr: ${stderr.trim().split("\n").slice(0, 4).join("\n")}`);
  return { stdout, stderr };
}

async function doInstall() {
  const target = pinnedVersion();
  log(`pinned @playwright/mcp version: ${target}`);

  if (!existsSync(MCP_BIN)) {
    throw new Error(
      `${MCP_BIN} not present — run 'npm ci' in the Talon repo first`,
    );
  }
  const pkgJson = resolve(dirname(MCP_BIN), "package.json");
  const installedVersion = JSON.parse(readFileSync(pkgJson, "utf-8")).version;
  log(`installed @playwright/mcp: ${installedVersion}`);
  if (installedVersion !== target) {
    throw new Error(
      `installed version ${installedVersion} != pinned target ${target}`,
    );
  }

  const browser = process.env.PW_SMOKE_BROWSER ?? "chromium";
  await run("npx", ["playwright", "install", browser]);
  log(`browser installed: ${browser}`);
}

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (c) => this.onData(c));
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (c) => process.stderr.write(`[mcp-stderr] ${c}`));
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
  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolveFn, rejectFn) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectFn(new Error(`request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolveFn(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectFn(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
  notify(method, params) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }
  async close() {
    this.child.stdin.end();
    await new Promise((res) => this.child.on("exit", () => res()));
  }
}

async function doSmoke() {
  if (!existsSync(MCP_BIN)) {
    throw new Error(`${MCP_BIN} missing — run install step first`);
  }

  const browser = process.env.PW_SMOKE_BROWSER ?? "chromium";
  const args = [MCP_BIN, "--no-sandbox", "--headless"];
  if (browser !== "chromium") args.push("--browser", browser);

  log(`spawning @playwright/mcp with ${browser}`);
  const child = spawn("node", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new StdioMcpClient(child);

  try {
    log("initialize…");
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "talon-smoke", version: "0.0.0" },
    });
    if (!init?.protocolVersion) {
      throw new Error(`bad initialize response: ${JSON.stringify(init)}`);
    }
    log(`server protocol: ${init.protocolVersion}`);
    client.notify("notifications/initialized", {});

    log("tools/list…");
    const tools = await client.request("tools/list", {});
    if (!Array.isArray(tools?.tools) || tools.tools.length === 0) {
      throw new Error(`bad tools/list response: ${JSON.stringify(tools)}`);
    }
    const names = tools.tools.map((t) => t.name);
    log(`tools (${names.length}): ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}`);
    for (const required of ["browser_navigate", "browser_close"]) {
      if (!names.includes(required)) {
        throw new Error(
          `expected tool "${required}" not found in tools/list`,
        );
      }
    }

    log("browser_navigate about:blank …");
    await client.request(
      "tools/call",
      { name: "browser_navigate", arguments: { url: "about:blank" } },
      90_000,
    );
    log("browser_navigate OK");

    log("browser_close …");
    await client.request(
      "tools/call",
      { name: "browser_close", arguments: {} },
      30_000,
    );
    log("browser_close OK");
  } finally {
    await client.close().catch(() => {});
  }

  log(`smoke OK on ${process.platform} (${browser})`);
}

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
    console.error(`[pw-smoke] FAILED: ${err.stack || err.message || err}`);
    process.exit(1);
  }
}

main();
