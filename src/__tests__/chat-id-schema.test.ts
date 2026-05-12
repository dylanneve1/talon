/**
 * Regression tests — `chatIdSchema` accepts the negative chat IDs
 * Telegram uses for supergroups/channels, AND the positive ones it
 * uses for private chats / DMs, AND digit-strings of either sign.
 *
 * Background: PR #150 shipped heartbeat outbound `send` / `react`
 * with `chat_id: idSchema`, but `idSchema` is `.positive()` — meant
 * for message/user/reply IDs which are always positive. Supergroup
 * chat IDs (`-1001426819337` shape) failed validation at the MCP
 * tool-schema layer with `expected number, received string` style
 * errors before the request ever reached the gateway — even though
 * the gateway-http tests already proved negative chat_ids route
 * correctly end-to-end. This test pins the new `chatIdSchema` to
 * accept both signs while still rejecting zero and non-integers.
 *
 * The exact -1001426819337 case below is the one Dylan asked the
 * heartbeat to test in chat at 2026-05-12 18:13Z. The
 * old schema rejected it; this test ensures the new schema doesn't.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../core/tools/index.js";
import { chatIdSchema, idSchema } from "../core/tools/schemas.js";

function getToolField(toolName: string, field: string): z.ZodTypeAny {
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not found`);
  const schema = (tool.schema as Record<string, z.ZodTypeAny>)[field];
  if (!schema) throw new Error(`field ${field} not found on ${toolName}`);
  return schema;
}

describe("chatIdSchema (standalone)", () => {
  describe("accepts", () => {
    it("a positive integer (user DM)", () => {
      expect(chatIdSchema.parse(352042062)).toBe(352042062);
    });

    it("a negative integer (Telegram supergroup)", () => {
      expect(chatIdSchema.parse(-1001426819337)).toBe(-1001426819337);
    });

    it("a negative integer (Telegram basic group)", () => {
      expect(chatIdSchema.parse(-123456789)).toBe(-123456789);
    });

    it("a positive integer string", () => {
      expect(chatIdSchema.parse("352042062")).toBe(352042062);
    });

    it("a negative integer string", () => {
      expect(chatIdSchema.parse("-1001426819337")).toBe(-1001426819337);
    });
  });

  describe("rejects", () => {
    it("zero", () => {
      expect(() => chatIdSchema.parse(0)).toThrow();
    });

    it("zero as string", () => {
      expect(() => chatIdSchema.parse("0")).toThrow();
    });

    it("negative zero as string", () => {
      // "-0" parses via Number() to -0, which === 0 in JS, so the
      // refine catches it. Lock that in.
      expect(() => chatIdSchema.parse("-0")).toThrow();
    });

    it("a non-integer number", () => {
      expect(() => chatIdSchema.parse(1.5)).toThrow();
    });

    it("a non-numeric string", () => {
      expect(() => chatIdSchema.parse("not-a-number")).toThrow();
    });

    it("an empty string", () => {
      expect(() => chatIdSchema.parse("")).toThrow();
    });

    it("a boolean", () => {
      expect(() => chatIdSchema.parse(true)).toThrow();
    });

    it("null", () => {
      expect(() => chatIdSchema.parse(null)).toThrow();
    });

    it("a string with leading/trailing whitespace", () => {
      expect(() => chatIdSchema.parse(" 123 ")).toThrow();
    });
  });

  describe("does not conflict with idSchema", () => {
    it("idSchema still rejects negatives (chatIdSchema is the negative-aware variant)", () => {
      expect(() => idSchema.parse(-1001426819337)).toThrow();
      expect(() => idSchema.parse("-1001426819337")).toThrow();
    });

    it("idSchema still accepts the same positives chatIdSchema accepts", () => {
      expect(idSchema.parse(2081)).toBe(2081);
      expect(chatIdSchema.parse(2081)).toBe(2081);
    });
  });
});

describe("chat_id tool params (wired into send/react)", () => {
  // The exact two tool fields PR #150 wired to idSchema by mistake.
  // After the fix they must accept both Dylan's DM (positive) AND
  // the Pandario group (negative).
  const cases: Array<[string, number]> = [
    ["send", 352042062], // Dylan DM
    ["send", -1001426819337], // Pandario group
    ["react", 352042062],
    ["react", -1001426819337],
  ];

  for (const [tool, chatId] of cases) {
    it(`${tool}.chat_id accepts ${chatId}`, () => {
      const s = getToolField(tool, "chat_id");
      expect(s.parse(chatId)).toBe(chatId);
    });
  }

  it("send.chat_id accepts stringified negative supergroup ID", () => {
    const s = getToolField("send", "chat_id");
    expect(s.parse("-1001426819337")).toBe(-1001426819337);
  });

  it("react.chat_id rejects zero", () => {
    const s = getToolField("react", "chat_id");
    expect(() => s.parse(0)).toThrow();
  });
});
