/**
 * Regression test — ID-shaped tool params accept both numeric and
 * stringified-numeric values.
 *
 * Background: some MCP transport / model paths deliver `message_id`,
 * `user_id`, `reply_to`, `offset_id` as JSON strings ("2081") rather
 * than numbers (2081). Plain `z.number()` rejects those with
 * `expected number, received string`, which manifested as
 * `react`/`pin_message`/`get_member_info`/`download_media` failing
 * out of nowhere even when the model formatted the call correctly
 * for a number-typed JSON Schema field.
 *
 * Fix: ID fields use `z.coerce.number().int()`. Numbers pass through;
 * numeric strings coerce; non-numeric strings and non-integers fail.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "../core/tools/index.js";

const ID_FIELD_NAMES = new Set([
  "message_id",
  "user_id",
  "reply_to",
  "offset_id",
]);

function getIdSchema(toolName: string, field: string): z.ZodTypeAny {
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not found`);
  const schema = (tool.schema as Record<string, z.ZodTypeAny>)[field];
  if (!schema) throw new Error(`field ${field} not found on ${toolName}`);
  return schema;
}

describe("ID-shaped tool params accept stringified numbers", () => {
  // Spot-check a representative set across all four files.
  const cases: Array<[string, string]> = [
    ["react", "message_id"],
    ["edit_message", "message_id"],
    ["delete_message", "message_id"],
    ["forward_message", "message_id"],
    ["pin_message", "message_id"],
    ["unpin_message", "message_id"],
    ["stop_poll", "message_id"],
    ["send", "reply_to"],
    ["get_member_info", "user_id"],
    ["create_sticker_set", "user_id"],
    ["add_sticker_to_set", "user_id"],
    ["read_chat_history", "offset_id"],
    ["get_message_by_id", "message_id"],
    ["download_media", "message_id"],
  ];

  for (const [tool, field] of cases) {
    it(`${tool}.${field} accepts a number`, () => {
      const s = getIdSchema(tool, field);
      const out = s.parse(2081);
      expect(out).toBe(2081);
    });

    it(`${tool}.${field} accepts a numeric string and coerces it`, () => {
      const s = getIdSchema(tool, field);
      const out = s.parse("2081");
      expect(out).toBe(2081);
    });

    it(`${tool}.${field} rejects a non-numeric string`, () => {
      const s = getIdSchema(tool, field);
      expect(() => s.parse("abc")).toThrow();
    });

    it(`${tool}.${field} rejects a non-integer`, () => {
      const s = getIdSchema(tool, field);
      expect(() => s.parse(1.5)).toThrow();
    });
  }
});

describe("Audit: every ID-shaped field in tool schemas is coerced", () => {
  it("no ID field uses raw z.number() (must use z.coerce.number().int())", () => {
    const violations: Array<{ tool: string; field: string }> = [];
    for (const tool of ALL_TOOLS) {
      const schema = tool.schema as Record<string, unknown>;
      for (const field of Object.keys(schema)) {
        if (!ID_FIELD_NAMES.has(field)) continue;
        const zSchema = schema[field] as z.ZodTypeAny;
        // A coerced number rejects "abc" but accepts "123" → that's our marker.
        // A plain z.number() rejects both. Distinguish by parsing "123".
        const result = zSchema.safeParse("123");
        if (!result.success) {
          violations.push({ tool: tool.name, field });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
