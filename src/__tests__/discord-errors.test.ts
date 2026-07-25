/**
 * Discord API error mapping.
 *
 * The curated messages in errors.ts exist so the agent learns WHICH
 * permission was missing, or that a message was deleted before its edit
 * could run. They key on the numeric Discord code.
 */

import { describe, it, expect } from "vitest";
import { mapDiscordError } from "../frontend/discord/errors.js";
import { classify } from "../core/errors.js";

const apiError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

describe("mapDiscordError", () => {
  it("maps a raw DiscordAPIError", () => {
    const out = mapDiscordError(apiError(50013, "Missing Permissions"), "send");
    expect(out?.error).toContain("Missing permissions");
  });

  // Every primary send path runs inside withRetry, which rethrows
  // classify(err) — a TalonError carrying only the message, with the
  // DiscordAPIError demoted to `cause`. Before the cause walk, the whole
  // mapping table was dead on send_message, reply_to,
  // send_message_with_buttons, the media sends, and forward/copy.
  it("still maps after withRetry has wrapped it in a TalonError", () => {
    const wrapped = classify(apiError(50013, "Missing Permissions"));
    const out = mapDiscordError(wrapped, "send_message");
    expect(out?.error).toContain("Missing permissions");
    expect(out?.error).toContain("send_message");
  });

  it("walks more than one level of cause nesting", () => {
    const nested = new Error("outer", {
      cause: classify(apiError(10008, "Unknown Message")),
    });
    expect(mapDiscordError(nested, "edit_message")?.error).toContain(
      "deleted before",
    );
  });

  it("returns null for a non-Discord error so the caller falls back", () => {
    expect(mapDiscordError(new Error("boom"), "send")).toBeNull();
    expect(mapDiscordError(classify(new Error("boom")), "send")).toBeNull();
  });

  it("does not recurse forever on a self-referential cause", () => {
    const loop: Error & { cause?: unknown } = new Error("loop");
    loop.cause = loop;
    expect(mapDiscordError(loop, "send")).toBeNull();
  });
});
