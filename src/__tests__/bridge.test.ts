/**
 * Unit tests for the bridge — the HTTP caller MCP servers use to dispatch
 * actions to the gateway.
 *
 * Covers:
 *   - default chatId from createBridge() becomes `_chatId` in the body
 *   - explicit `chat_id` in params promotes to `_chatId` AND stays in body
 *   - explicit `chat_id` overrides the default
 *   - non-OK HTTP responses throw a structured error
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBridge } from "../core/tools/bridge.js";

describe("createBridge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("sends action + params + default _chatId from createBridge", async () => {
    const bridge = createBridge("http://test/", "123");
    await bridge("send_message", { text: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test//action");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({
      action: "send_message",
      text: "hello",
      _chatId: "123",
    });
    // No explicit chat_id — `chat_id` should NOT be in body.
    expect(body.chat_id).toBeUndefined();
  });

  it("explicit chat_id in params promotes to _chatId AND stays in body", async () => {
    // The bridge keeps `chat_id` in the body as the explicit-routing
    // signal the gateway uses to skip its active-context check. The
    // promoted `_chatId` carries the routing target.
    const bridge = createBridge("http://test/", ""); // empty default chat
    await bridge("send_message", {
      text: "hi from heartbeat",
      chat_id: 352042062,
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toMatchObject({
      action: "send_message",
      text: "hi from heartbeat",
      chat_id: 352042062, // stays in body — explicit-routing signal
      _chatId: "352042062", // promoted as the routing key
    });
  });

  it("explicit chat_id overrides createBridge's default chatId", async () => {
    const bridge = createBridge("http://test/", "111");
    await bridge("send_message", { text: "go to other chat", chat_id: 222 });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("222");
  });

  it("string chat_id (Teams-style ID) is preserved exactly", async () => {
    const bridge = createBridge("http://test/", "");
    await bridge("send_message", {
      text: "to teams",
      chat_id: "teams_chat_19:abc...",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body._chatId).toBe("teams_chat_19:abc...");
    expect(body.chat_id).toBe("teams_chat_19:abc...");
  });

  it("non-OK HTTP response throws structured error", async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }));

    const bridge = createBridge("http://test/", "123");
    await expect(bridge("send_message", { text: "hi" })).rejects.toThrow(
      /Bridge error \(500\): boom/,
    );
  });

  it("call with no params works (default chatId, no body extras)", async () => {
    const bridge = createBridge("http://test/", "456");
    await bridge("list_active_markets", {});

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body).toEqual({ action: "list_active_markets", _chatId: "456" });
  });
});
