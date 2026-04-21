/**
 * Launcher tests.
 *
 * Unit-level: wrapMcpServer + ensureLauncher path resolution.
 * Integration: spawn the real launcher.mjs, drive it with a dummy child,
 * close its stdin, verify it terminates the child and exits cleanly.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKED_IN_LAUNCHER = resolve(REPO_ROOT, "src/util/mcp-launcher.mjs");

describe("mcp-launcher", () => {
  it("wrapMcpServer rewrites command/args to go through node launcher", async () => {
    const { wrapMcpServer } = await freshLauncher();
    const wrapped = wrapMcpServer({
      command: "/usr/bin/python",
      args: ["-m", "mempalace.mcp_server"],
      env: { FOO: "bar" },
    });

    expect(wrapped.command).toBe("node");
    expect(wrapped.args[0]).toMatch(/mcp-launcher\.mjs$/);
    expect(wrapped.args.slice(1)).toEqual([
      "/usr/bin/python",
      "-m",
      "mempalace.mcp_server",
    ]);
    expect(wrapped.env).toEqual({ FOO: "bar" });
  });

  it("ensureLauncher returns the checked-in launcher script", async () => {
    const { ensureLauncher } = await freshLauncher();
    const path = ensureLauncher();

    expect(path).toBe(CHECKED_IN_LAUNCHER);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("Supervises an MCP stdio child");
    expect(content).toContain("spawn(cmd, args");
    expect(content).toContain('process.stdin.on("end"');
  });

  // ── Integration: real launcher + real child ────────────────────────────

  it("terminates the supervised child when parent stdin closes", async () => {
    const { ensureLauncher } = await freshLauncher();
    const launcherPath = ensureLauncher();

    // Dummy child: a Node one-liner that keeps stdin open forever and prints
    // a ready marker so the parent can detect it has spawned. It will only
    // exit when its stdin closes (which happens when the launcher dies).
    const childScript = `
      process.stdout.write("READY\\n");
      process.stdin.on("data", (d) => process.stdout.write(d));
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
    `;

    const launcher = spawn("node", [launcherPath, "node", "-e", childScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for READY to confirm stdio proxy is up
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timeout waiting for READY")),
        5000,
      );
      launcher.stdout!.on("data", (chunk) => {
        if (chunk.toString().includes("READY")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      launcher.on("exit", () => {
        clearTimeout(timeout);
        reject(new Error("launcher exited before READY"));
      });
    });

    // Close our write-end → launcher sees stdin EOF → it SIGTERMs the child
    // → launcher exits.
    launcher.stdin!.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      launcher.on("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);
  }, 10_000);

  it("proxies stdin→stdout verbatim while the child is alive", async () => {
    const { ensureLauncher } = await freshLauncher();
    const launcherPath = ensureLauncher();

    // Echo-style child.
    const childScript = `
      process.stdin.on("data", (d) => process.stdout.write(d));
      process.stdin.resume();
    `;
    const launcher = spawn("node", [launcherPath, "node", "-e", childScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const output: Buffer[] = [];
    launcher.stdout!.on("data", (c) => output.push(c));
    launcher.stdin!.write("hello\n");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("echo timeout")), 5000);
      const check = setInterval(() => {
        if (Buffer.concat(output).toString().includes("hello")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    launcher.stdin!.end();
    await new Promise((r) => launcher.on("exit", r));
    expect(Buffer.concat(output).toString()).toContain("hello");
  }, 10_000);
});

/**
 * Import the launcher module fresh so mocks and module state never leak
 * between tests.
 */
async function freshLauncher() {
  const { vi } = await import("vitest");
  vi.resetModules();
  return import("../util/mcp-launcher.js");
}
