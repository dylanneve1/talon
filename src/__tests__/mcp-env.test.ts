/**
 * MCP env contract — buildTalonMcpEnv (backend side) and parseEnvList
 * (server side) are the two halves of the env-var protocol between
 * backends and the spawned mcp-server subprocess.
 */

import { describe, it, expect } from "vitest";
import {
  buildTalonMcpEnv,
  parseEnvList,
  ENV_DISABLED_TOOLS,
  ENV_DISABLED_TOOL_TAGS,
} from "../core/tools/mcp-env.js";
import { composeTools } from "../core/tools/index.js";

describe("buildTalonMcpEnv", () => {
  it("builds the base trio without exclusions", () => {
    const env = buildTalonMcpEnv({
      bridgeUrl: "http://127.0.0.1:1",
      chatId: "42",
      frontend: "telegram",
    });
    expect(env).toEqual({
      TALON_BRIDGE_URL: "http://127.0.0.1:1",
      TALON_CHAT_ID: "42",
      TALON_FRONTEND: "telegram",
    });
  });

  it("carries config exclusions as comma-separated vars", () => {
    const env = buildTalonMcpEnv({
      bridgeUrl: "u",
      chatId: "c",
      frontend: "telegram",
      config: {
        disabledTools: ["send_dice"],
        disabledToolTags: ["stickers", "web"],
      },
    });
    expect(env[ENV_DISABLED_TOOLS]).toBe("send_dice");
    expect(env[ENV_DISABLED_TOOL_TAGS]).toBe("stickers,web");
  });

  it("omits exclusion vars when lists are empty or config absent", () => {
    const env = buildTalonMcpEnv({
      bridgeUrl: "u",
      chatId: "c",
      frontend: "telegram",
      config: { disabledTools: [], disabledToolTags: [] },
    });
    expect(env[ENV_DISABLED_TOOLS]).toBeUndefined();
    expect(env[ENV_DISABLED_TOOL_TAGS]).toBeUndefined();
  });
});

describe("parseEnvList", () => {
  it("splits, trims, and drops blanks", () => {
    expect(parseEnvList("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(parseEnvList(undefined)).toEqual([]);
    expect(parseEnvList("")).toEqual([]);
  });
});

describe("composeTools with exclusions (the server-side effect)", () => {
  it("excluding the stickers tag removes the sticker tools", () => {
    const all = composeTools({ frontend: "telegram" });
    const trimmed = composeTools({
      frontend: "telegram",
      excludeTags: ["stickers"],
    });
    expect(trimmed.length).toBeLessThan(all.length);
    expect(trimmed.some((t) => t.tag === "stickers")).toBe(false);
    // end_turn survives — it's tagged messaging, not stickers.
    expect(trimmed.some((t) => t.name === "end_turn")).toBe(true);
  });
});
