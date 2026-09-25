/**
 * MCP hub — in-flight tool calls on hub children.
 *
 * A plugin tool call can legitimately run for minutes (a crawl, a mine,
 * a slow page). These tests pin that the hub itself never kills such a
 * call from under the model: the idle reaper skips busy children.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  acquireChild,
  closeAllChildren,
  getActiveChildKeys,
  startChildReaper,
  stopChildReaper,
} from "../core/mcp-hub/children.js";

/**
 * Minimal stdio MCP server. Tools:
 *   - `hang`: never answers
 *   - `slow`: answers after `ms` milliseconds
 * Exits when stdin closes so hub-side closes are instant.
 */
const FAKE_SERVER = {
  command: process.execPath,
  args: [
    "--no-warnings",
    "-e",
    `
    process.stdin.setEncoding("utf-8");
    process.stdin.on("end", () => process.exit(0));
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
    const text = (id, t) => send({ id, result: { content: [{ type: "text", text: t }] } });
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ id: msg.id, result: {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "0" },
          } });
        } else if (msg.method === "tools/list") {
          send({ id: msg.id, result: { tools: [] } });
        } else if (msg.method === "tools/call") {
          const { name, arguments: args } = msg.params;
          if (name === "slow") setTimeout(() => text(msg.id, "done"), args.ms);
        }
      }
    });
  `,
  ],
  env: {},
};

afterEach(async () => {
  vi.useRealTimers();
  stopChildReaper();
  delete process.env.TALON_MCP_HUB_IDLE_MS;
  await closeAllChildren();
});

describe("hub child idle reaper", () => {
  it("never reaps a child with a call in flight", async () => {
    process.env.TALON_MCP_HUB_IDLE_MS = "1";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    startChildReaper();

    const key = "reap-busy chat";
    const child = await acquireChild(key, () => FAKE_SERVER);
    const call = child.callTool("slow", { ms: 500 });
    // Idle by the clock (TTL 1ms), but busy.
    await new Promise((r) => setTimeout(r, 20));
    vi.advanceTimersByTime(60_000);

    expect(getActiveChildKeys()).toContain(key);
    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    // Idle for real now: the next sweep reaps it.
    await new Promise((r) => setTimeout(r, 20));
    vi.advanceTimersByTime(60_000);
    expect(getActiveChildKeys()).not.toContain(key);
  }, 20_000);
});
