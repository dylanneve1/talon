/**
 * Contract test against the shared protocol fixture in
 * apps/companion/test/fixtures/protocol_v1.json. The companion app asserts
 * the same file from Dart (test/protocol_fixture_test.dart), so a wire-shape
 * drift on either side fails one of the two suites instead of shipping a
 * silent misrender. Assignments to the protocol types make renames a
 * compile-time failure here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeStatus,
  type ClientChat,
  type ClientMessage,
  type LogEntry,
  type SearchResult,
} from "../frontend/native/protocol.js";

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "../../apps/companion/test/fixtures/protocol_v1.json"),
    "utf-8",
  ),
) as {
  protocol: number;
  message: ClientMessage;
  chat: ClientChat;
  status: BridgeStatus;
  searchResult: SearchResult;
  logEntry: LogEntry;
};

describe("bridge protocol fixture (shared with the companion app)", () => {
  it("carries the daemon's protocol version", () => {
    expect(fixture.protocol).toBe(BRIDGE_PROTOCOL_VERSION);
  });

  it("message shape matches ClientMessage", () => {
    const m: ClientMessage = fixture.message;
    expect(m.id).toBe("1024");
    expect(m.role).toBe("assistant");
    expect(m.ts).toBe(1767225600000);
    expect(m.buttons?.[0][0].url).toBe("https://example.com");
    expect(m.imagePath).toBe("/media?id=m42");
    expect(m.durationMs).toBe(4200);
    expect(m.tokensIn).toBe(1200);
    expect(m.tokensOut).toBe(340);
    expect(m.tools).toHaveLength(2);
    expect(m.tools?.[0].name).toBe("mcp__search__web");
    expect(m.tools?.[1].error).toBe("exit 1");
  });

  it("chat shape matches ClientChat", () => {
    const c: ClientChat = fixture.chat;
    expect(c.id).toBe("d_abc123");
    expect(c.model).toBe("claude-sonnet-5");
    expect(c.backend).toBe("claude");
    expect(c.effort).toBe("high");
    expect(c.pulse).toBe(true);
  });

  it("status shape matches BridgeStatus", () => {
    const s: BridgeStatus = fixture.status;
    expect(s.app).toBe("talon-bridge");
    expect(s.protocol).toBe(1);
    expect(s.activeChats).toBe(3);
  });

  it("search result shape matches SearchResult", () => {
    const r: SearchResult = fixture.searchResult;
    expect(r.chatTitle).toBe("Protocol design");
    expect(r.message.role).toBe("user");
  });

  it("log entry shape matches LogEntry", () => {
    const e: LogEntry = fixture.logEntry;
    expect(e.ts).toBe(1767225600000);
    expect(e.level).toBe("error");
    expect(e.component).toBe("agent");
    expect(e.msg).toContain("SDK error");
    expect(e.err).toContain("weekly limit");
    expect(e.stack).toContain("runChatTurn");
  });
});
