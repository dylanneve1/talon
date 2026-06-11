/**
 * MCP supervisor tests.
 *
 * Unit-level: supervisorInvocation / wrapMcpServer / wrapMcpCommand
 * build the self-reinvocation command prefix.
 * Integration: spawn the REAL dispatch path (src/cli.ts _mcp-launch …)
 * with a dummy child, close its stdin, verify it terminates the child
 * and exits cleanly — exactly what happens when Talon dies.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MCP_LAUNCH_SUBCOMMAND,
  supervisorInvocation,
  wrapMcpServer,
  wrapMcpCommand,
} from "../util/mcp-launcher.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "src/cli.ts");
const TSX_IMPORT = pathToFileURL(
  resolve(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs"),
).href;

describe("mcp-launcher", () => {
  it("supervisorInvocation re-invokes the current process with the subcommand", () => {
    const inv = supervisorInvocation();
    expect(inv.command).toBe(process.execPath);
    expect(inv.args.at(-1)).toBe(MCP_LAUNCH_SUBCOMMAND);
    // execArgv (e.g. tsx loader flags) must ride along so the entry
    // resolves in the supervisor process too.
    expect(inv.args.slice(0, process.execArgv.length)).toEqual(
      process.execArgv,
    );
    // The entry script is passed absolute, so the supervisor spawn is
    // independent of the SDK's working directory.
    const entry = inv.args[process.execArgv.length];
    expect(entry).toBe(resolve(process.argv[1]));
  });

  it("supervisorInvocation omits embedded entries (bun --compile)", () => {
    const realArgv1 = process.argv[1];
    try {
      process.argv[1] = "/$bunfs/root/talon";
      expect(supervisorInvocation().args).toEqual([
        ...process.execArgv,
        MCP_LAUNCH_SUBCOMMAND,
      ]);
      process.argv[1] = "B:\\~BUN\\root\\talon.exe";
      expect(supervisorInvocation().args).toEqual([
        ...process.execArgv,
        MCP_LAUNCH_SUBCOMMAND,
      ]);
    } finally {
      process.argv[1] = realArgv1;
    }
  });

  it("supervisorInvocation honours the embedder override env", () => {
    const backup = process.env.TALON_MCP_SUPERVISOR_CMD;
    try {
      process.env.TALON_MCP_SUPERVISOR_CMD = JSON.stringify([
        "/usr/bin/node",
        "--import",
        "file:///tsx.mjs",
        "/app/src/cli.ts",
      ]);
      expect(supervisorInvocation()).toEqual({
        command: "/usr/bin/node",
        args: [
          "--import",
          "file:///tsx.mjs",
          "/app/src/cli.ts",
          MCP_LAUNCH_SUBCOMMAND,
        ],
      });

      process.env.TALON_MCP_SUPERVISOR_CMD = "not json";
      expect(() => supervisorInvocation()).toThrow(/JSON string array/);
      process.env.TALON_MCP_SUPERVISOR_CMD = "[]";
      expect(() => supervisorInvocation()).toThrow(/JSON string array/);
    } finally {
      if (backup === undefined) delete process.env.TALON_MCP_SUPERVISOR_CMD;
      else process.env.TALON_MCP_SUPERVISOR_CMD = backup;
    }
  });

  it("wrapMcpServer prefixes the supervisor invocation, preserving env", () => {
    const wrapped = wrapMcpServer({
      command: "/usr/bin/python",
      args: ["-m", "mempalace.mcp_server"],
      env: { FOO: "bar" },
    });

    const inv = supervisorInvocation();
    expect(wrapped.command).toBe(inv.command);
    expect(wrapped.args).toEqual([
      ...inv.args,
      "/usr/bin/python",
      "-m",
      "mempalace.mcp_server",
    ]);
    expect(wrapped.env).toEqual({ FOO: "bar" });
  });

  it("wrapMcpCommand prepends the supervisor invocation to a single-array command", () => {
    const original = ["node", "--import", "tsx", "/path/to/mcp-server.ts"];
    const inv = supervisorInvocation();
    expect(wrapMcpCommand(original)).toEqual([
      inv.command,
      ...inv.args,
      ...original,
    ]);
  });

  it("wrapMcpCommand throws on empty array (caller bug)", () => {
    expect(() => wrapMcpCommand([])).toThrow(/must not be empty/);
  });

  // ── Integration: real dispatch path + real child ─────────────────────────

  function spawnSupervisor(childScript: string) {
    // The production shape: an entrypoint re-invoked with _mcp-launch.
    return spawn(
      process.execPath,
      [
        "--import",
        TSX_IMPORT,
        CLI_ENTRY,
        MCP_LAUNCH_SUBCOMMAND,
        process.execPath,
        "-e",
        childScript,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  }

  it("terminates the supervised child when parent stdin closes", async () => {
    // Dummy child: emits a valid JSON-RPC ready marker (so the stdout filter
    // passes it through to the parent), then keeps stdin open. Exits when its
    // stdin closes (which happens when the supervisor dies).
    const childScript = `
      process.stdout.write(JSON.stringify({"jsonrpc":"2.0","method":"ready"}) + "\\n");
      process.stdin.on("data", (d) => process.stdout.write(d));
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
    `;

    const launcher = spawnSupervisor(childScript);

    // Wait for the JSON ready marker on stdout (the filter passes JSON through)
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timeout waiting for JSON ready marker")),
        15000,
      );
      launcher.stdout!.on("data", (chunk) => {
        if (chunk.toString().includes('"method":"ready"')) {
          clearTimeout(timeout);
          resolvePromise();
        }
      });
      launcher.on("exit", () => {
        clearTimeout(timeout);
        reject(new Error("supervisor exited before ready marker"));
      });
    });

    // Close our write-end → supervisor sees stdin EOF → it SIGTERMs the
    // child → supervisor exits.
    launcher.stdin!.end();

    const exitCode = await new Promise<number | null>((resolvePromise) => {
      launcher.on("exit", (code) => resolvePromise(code));
    });
    expect(exitCode).toBe(0);
  }, 30_000);

  it("routes JSON stdout lines to stdout; non-JSON lines to stderr with tag", async () => {
    // Echo-style child: whatever arrives on stdin is echoed back to stdout.
    const childScript = `
      process.stdin.on("data", (d) => process.stdout.write(d));
      process.stdin.resume();
    `;
    const launcher = spawnSupervisor(childScript);

    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    launcher.stdout!.on("data", (c) => stdoutBufs.push(c));
    launcher.stderr!.on("data", (c) => stderrBufs.push(c));

    // Send a valid JSON-RPC line — should pass through to stdout unchanged.
    const jsonLine =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    launcher.stdin!.write(jsonLine);

    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("JSON line did not appear on stdout")),
        15000,
      );
      const check = setInterval(() => {
        if (Buffer.concat(stdoutBufs).toString().includes('"method":"ping"')) {
          clearInterval(check);
          clearTimeout(timeout);
          resolvePromise();
        }
      }, 50);
    });

    // Send a plain text line — should be rerouted to stderr with the tag.
    launcher.stdin!.write("plain log line\n");

    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("plain line did not appear on stderr")),
        15000,
      );
      const check = setInterval(() => {
        if (Buffer.concat(stderrBufs).toString().includes("plain log line")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolvePromise();
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
  }, 30_000);
});
