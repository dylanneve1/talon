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

  // ── Single-array shape used by Kilo + OpenCode SDK mcp.add({command:[…]})
  it("wrapMcpCommand prepends node + launcher to a single-array command", async () => {
    const { wrapMcpCommand } = await freshLauncher();
    const wrapped = wrapMcpCommand([
      "node",
      "--import",
      "tsx",
      "/path/to/mcp-server.ts",
    ]);

    expect(wrapped[0]).toBe("node");
    expect(wrapped[1]).toMatch(/mcp-launcher\.mjs$/);
    expect(wrapped.slice(2)).toEqual([
      "node",
      "--import",
      "tsx",
      "/path/to/mcp-server.ts",
    ]);
  });

  it("wrapMcpCommand throws on empty array (caller bug)", async () => {
    const { wrapMcpCommand } = await freshLauncher();
    expect(() => wrapMcpCommand([])).toThrow(/must not be empty/);
  });

  // ── Integration: real launcher + real child ────────────────────────────

  it("terminates the supervised child when parent stdin closes", async () => {
    const { ensureLauncher } = await freshLauncher();
    const launcherPath = ensureLauncher();

    // Dummy child: emits a valid JSON-RPC ready marker (so the stdout filter
    // passes it through to the parent), then keeps stdin open. Exits when its
    // stdin closes (which happens when the launcher dies).
    const childScript = `
      process.stdout.write(JSON.stringify({"jsonrpc":"2.0","method":"ready"}) + "\\n");
      process.stdin.on("data", (d) => process.stdout.write(d));
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
    `;

    const launcher = spawn("node", [launcherPath, "node", "-e", childScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for the JSON ready marker on stdout (the filter passes JSON through)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timeout waiting for JSON ready marker")),
        5000,
      );
      launcher.stdout!.on("data", (chunk) => {
        if (chunk.toString().includes('"method":"ready"')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      launcher.on("exit", () => {
        clearTimeout(timeout);
        reject(new Error("launcher exited before ready marker"));
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

  it("routes JSON stdout lines to stdout; non-JSON lines to stderr with tag", async () => {
    // PR #224 added a stdout filter: the launcher now only forwards lines that
    // parse as JSON (MCP JSON-RPC messages) to its own stdout. Non-JSON lines
    // (plugin banners, log noise) are rerouted to stderr with an
    // [mcp-launcher: stdout→stderr] prefix so they remain visible in logs
    // but don't confuse strict MCP clients (e.g. the Python `mcp` library).
    const { ensureLauncher } = await freshLauncher();
    const launcherPath = ensureLauncher();

    // Echo-style child: whatever arrives on stdin is echoed back to stdout.
    const childScript = `
      process.stdin.on("data", (d) => process.stdout.write(d));
      process.stdin.resume();
    `;
    const launcher = spawn("node", [launcherPath, "node", "-e", childScript], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    launcher.stdout!.on("data", (c) => stdoutBufs.push(c));
    launcher.stderr!.on("data", (c) => stderrBufs.push(c));

    // Send a valid JSON-RPC line — should pass through to stdout unchanged.
    const jsonLine =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    launcher.stdin!.write(jsonLine);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("JSON line did not appear on stdout")),
        5000,
      );
      const check = setInterval(() => {
        if (Buffer.concat(stdoutBufs).toString().includes('"method":"ping"')) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    // Send a plain text line — should be rerouted to stderr with the tag.
    launcher.stdin!.write("plain log line\n");

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("plain line did not appear on stderr")),
        5000,
      );
      const check = setInterval(() => {
        if (Buffer.concat(stderrBufs).toString().includes("plain log line")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    launcher.stdin!.end();
    await new Promise((r) => launcher.on("exit", r));

    const stdout = Buffer.concat(stdoutBufs).toString();
    const stderr = Buffer.concat(stderrBufs).toString();
    // JSON went to stdout
    expect(stdout).toContain('"method":"ping"');
    // Plain text was tagged and rerouted to stderr
    expect(stderr).toContain("[mcp-launcher: stdout→stderr]");
    expect(stderr).toContain("plain log line");
    // Plain text did NOT leak to stdout
    expect(stdout).not.toContain("plain log line");
  }, 10_000);

  it("ensureLauncher throws when launcher file does not exist on disk", async () => {
    // Cover the if (!existsSync(LAUNCHER_PATH)) throw branch (false arm of line 30).
    // Use vi.doMock to intercept node:fs before the fresh module import.
    const { vi: v } = await import("vitest");
    v.resetModules();
    v.doMock("node:fs", () => ({
      existsSync: () => false,
    }));
    try {
      const { ensureLauncher: freshEnsure } =
        await import("../util/mcp-launcher.js");
      expect(() => freshEnsure()).toThrow(/MCP launcher missing/);
    } finally {
      v.unmock("node:fs");
      v.resetModules();
    }
  });
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
