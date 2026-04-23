#!/usr/bin/env node
/**
 * GitHub MCP functional smoke — CI-driven, Linux-only (Docker dependency).
 *
 * Subcommands:
 *   pull   — docker pull the Talon-pinned image, verify it's resolvable.
 *   smoke  — spawn the MCP server over stdio, run MCP initialize →
 *            tools/list, assert expected GitHub tools are present.
 *
 * Uses a throwaway GITHUB_PERSONAL_ACCESS_TOKEN for the smoke step — the
 * server only needs a syntactically valid token to boot; we don't make any
 * authenticated API calls.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function pinnedImage() {
  const src = readFileSync(
    resolve(REPO_ROOT, "src/plugins/github/install.ts"),
    "utf-8",
  );
  const match = /GITHUB_MCP_IMAGE\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse GITHUB_MCP_IMAGE");
  return match[1];
}

function log(...args) {
  console.log("[gh-smoke]", ...args);
}

async function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  if (stdout.trim()) log(stdout.trim().split("\n").slice(0, 8).join("\n"));
  if (stderr.trim()) log(`stderr: ${stderr.trim().split("\n").slice(0, 4).join("\n")}`);
  return { stdout, stderr };
}

async function doPull() {
  const image = pinnedImage();
  log(`pinned image: ${image}`);
  await run("docker", ["pull", image]);
  await run("docker", ["image", "inspect", image]);
  log("pull OK");
}

// Minimal MCP stdio client — same shape as mempalace-smoke.
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
  request(method, params, timeoutMs = 30_000) {
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
  const image = pinnedImage();
  log(`spawning ${image} via docker run`);

  const fakeToken = process.env.GITHUB_SMOKE_TOKEN ?? "ghp_smoke_dummy_token_for_init_only";
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      image,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: fakeToken },
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
    log(`tools (${names.length}): ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`);

    // Expect a core subset — github-mcp-server tool names are stable across versions.
    const expected = ["get_me", "search_repositories", "list_issues"];
    for (const name of expected) {
      if (!names.includes(name)) {
        throw new Error(
          `expected tool "${name}" not found in github-mcp tools/list`,
        );
      }
    }
    log("tools/list OK");
  } finally {
    await client.close().catch(() => {});
  }

  log(`smoke OK on ${process.platform}`);
}

async function main() {
  const cmd = process.argv[2] ?? "smoke";
  try {
    if (cmd === "pull") await doPull();
    else if (cmd === "smoke") await doSmoke();
    else {
      console.error(`unknown subcommand "${cmd}" — use pull | smoke`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`[gh-smoke] FAILED: ${err.stack || err.message || err}`);
    process.exit(1);
  }
}

main();
