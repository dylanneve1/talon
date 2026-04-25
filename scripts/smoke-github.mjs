#!/usr/bin/env node
/**
 * GitHub MCP functional smoke — Linux-only due to Docker dependency.
 *
 * Reads GITHUB_MCP_IMAGE from src/plugins/github/heal.ts, pulls that exact
 * tag, spawns the MCP server, and asserts the expected toolset is served
 * over stdio. Uses a syntactically-valid but non-authenticated token —
 * we're only testing MCP protocol + tool registration, not GitHub API
 * access.
 */

import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { StdioMcpClient } from "./lib/mcp-stdio-client.mjs";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function pinnedImage() {
  const src = readFileSync(
    join(REPO_ROOT, "src/plugins/github/heal.ts"),
    "utf-8",
  );
  const match = /GITHUB_MCP_IMAGE\s*=\s*"([^"]+)"/.exec(src);
  if (!match) throw new Error("failed to parse GITHUB_MCP_IMAGE");
  return match[1];
}

function log(...args) {
  console.log("[github-smoke]", ...args);
}

async function run(cmd, args) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const { stdout, stderr } = await execFileP(cmd, args, {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (stdout.trim()) log(stdout.trim().split("\n").slice(0, 8).join("\n"));
  if (stderr.trim())
    log(`stderr: ${stderr.trim().split("\n").slice(0, 4).join("\n")}`);
  return { stdout, stderr };
}

async function pull() {
  const image = pinnedImage();
  log(`pinned image: ${image}`);
  await run("docker", ["pull", image]);
  await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  log("pull OK");
}

async function smoke() {
  const image = pinnedImage();
  log(`spawning ${image}`);
  const token =
    process.env.GITHUB_SMOKE_TOKEN ?? "ghp_smoke_dummy_token_for_init";
  const child = spawn(
    "docker",
    ["run", "--rm", "-i", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", image],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token },
    },
  );
  const client = new StdioMcpClient(child, { name: "github" });
  try {
    log("initialize…");
    const protocol = await client.handshake();
    log(`MCP protocol: ${protocol}`);
    log("tools/list…");
    const tools = await client.listTools();
    log(`tools (${tools.length}): ${tools.slice(0, 8).join(", ")}…`);
    for (const required of [
      "get_me",
      "search_repositories",
      "list_issues",
    ]) {
      if (!tools.includes(required)) {
        throw new Error(
          `expected tool "${required}" missing from github tools/list`,
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
    if (cmd === "pull") await pull();
    else if (cmd === "smoke") await smoke();
    else {
      console.error(`unknown subcommand "${cmd}" — use pull | smoke`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`[github-smoke] FAILED: ${err.stack || err.message || err}`);
    process.exit(1);
  }
}

main();
