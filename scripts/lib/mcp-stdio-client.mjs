/**
 * Minimal MCP stdio client shared by the plugin smoke scripts.
 *
 * Implements just enough JSON-RPC to exercise the three things we need for
 * smoke testing any MCP server:
 *   - initialize + notifications/initialized handshake
 *   - tools/list to assert the expected toolset is present
 *   - tools/call for a representative side-effect-free invocation
 *
 * Not for production use. Real Talon talks to MCP via the Claude Agent SDK.
 */

export class StdioMcpClient {
  constructor(child, { name = "mcp", onStderrLine } = {}) {
    this.name = name;
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      if (onStderrLine) {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) onStderrLine(line);
        }
      } else {
        process.stderr.write(`[${name}-stderr] ${chunk}`);
      }
    });
    child.on("exit", (code, signal) => {
      const err = new Error(`${name} exited code=${code} signal=${signal}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  #onData(chunk) {
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
        // Some servers (github-mcp) print non-JSON banner lines — ignore.
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
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
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
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  async handshake(timeoutMs = 30_000) {
    const init = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "talon-smoke", version: "0.0.0" },
      },
      timeoutMs,
    );
    if (!init?.protocolVersion) {
      throw new Error(`bad initialize response: ${JSON.stringify(init)}`);
    }
    this.notify("notifications/initialized", {});
    return init.protocolVersion;
  }

  async listTools(timeoutMs = 15_000) {
    const result = await this.request("tools/list", {}, timeoutMs);
    if (!Array.isArray(result?.tools)) {
      throw new Error(`bad tools/list response: ${JSON.stringify(result)}`);
    }
    return result.tools.map((t) => t.name);
  }

  async callTool(name, args = {}, timeoutMs = 60_000) {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    return result;
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.on("exit", () => resolve());
    });
  }
}

/** Pull a pinned constant from a TypeScript source file without tsc. */
export function readPinnedConstant(sourcePath, constName) {
  const { readFileSync } = require("node:fs");
  const src = readFileSync(sourcePath, "utf-8");
  const re = new RegExp(`${constName}\\s*=\\s*"([^"]+)"`);
  const match = re.exec(src);
  if (!match) {
    throw new Error(`failed to parse ${constName} from ${sourcePath}`);
  }
  return match[1];
}
