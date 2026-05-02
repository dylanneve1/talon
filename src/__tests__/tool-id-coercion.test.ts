/**
 * Regression + audit tests — ID-shaped tool params use the strict
 * shared `idSchema` from `core/tools/schemas.ts`.
 *
 * Background: some MCP transport / model paths deliver `message_id`,
 * `user_id`, `reply_to`, `offset_id` as JSON strings ("2081") rather
 * than numbers (2081). Plain `z.number()` rejects those with
 * `expected number, received string`, which manifested as
 * `react`/`pin_message`/`get_member_info`/`download_media` failing
 * out of nowhere even when the model formatted the call correctly
 * for a number-typed JSON Schema field.
 *
 * Initial fix used `z.coerce.number().int()`, but per Copilot review
 * that was too lax — `""`/`null` coerce to 0 and `true` to 1, which
 * then pass `.int()` and reach the bot API. The current `idSchema` is
 * a union: `z.number().int().positive()` OR a digit-only string that
 * gets transformed to a positive integer. Everything else is rejected.
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

describe("Audit: every ID-shaped field in tool schemas is the strict idSchema", () => {
  /**
   * For each ID field on every tool, this test asserts the full
   * accept/reject contract of `idSchema` — not just "accepts a
   * string." That guards against a future replacement that passes
   * the loose check (`safeParse("123")` succeeds) but doesn't
   * actually return a positive integer (e.g. `z.string()` would
   * accept "123" and return the string "123").
   */
  for (const tool of ALL_TOOLS) {
    const schema = tool.schema as Record<string, unknown>;
    for (const field of Object.keys(schema)) {
      if (!ID_FIELD_NAMES.has(field)) continue;
      const zSchema = schema[field] as z.ZodTypeAny;

      it(`${tool.name}.${field}: accepts a positive integer number`, () => {
        const r = zSchema.safeParse(2081);
        expect(r.success).toBe(true);
        if (r.success) expect(r.data).toBe(2081);
      });

      it(`${tool.name}.${field}: accepts a digit string and returns a number`, () => {
        const r = zSchema.safeParse("2081");
        expect(r.success).toBe(true);
        if (r.success) {
          expect(typeof r.data).toBe("number");
          expect(Number.isInteger(r.data as number)).toBe(true);
          expect(r.data).toBe(2081);
        }
      });

      // Reject the inputs that bare `z.coerce.number().int()` was too
      // permissive about — empty/whitespace/null/booleans coerce to
      // 0/0/0/1 and would pass `.int()`. The strict union rejects all.
      const rejectCases: Array<[unknown, string]> = [
        ["", "empty string"],
        ["   ", "whitespace string"],
        ["abc", "non-numeric string"],
        ["2081abc", "mixed string"],
        [null, "null"],
        [true, "true"],
        [false, "false"],
        [0, "zero"],
        [-1, "negative integer"],
        [1.5, "non-integer"],
      ];
      for (const [bad, label] of rejectCases) {
        it(`${tool.name}.${field}: rejects ${label}`, () => {
          const r = zSchema.safeParse(bad);
          expect(r.success).toBe(false);
        });
      }
    }
  }
});
