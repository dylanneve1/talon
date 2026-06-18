/**
 * Regression + audit tests — ID-shaped tool params use one of the two
 * supported schemas from `core/tools/schemas.ts`:
 *
 *   - `idSchema` — strict Telegram-style ID. Accepts a positive integer
 *     OR a digit-only string that is COERCED to a positive integer.
 *     Used by telegram-only tools (stop_poll, sticker tools).
 *
 *   - `snowflakeOrIdSchema` — Discord-compatible. Accepts a positive
 *     integer OR a digit-only string that PASSES THROUGH unchanged.
 *     Used by every tool exposed to the discord frontend. Snowflakes
 *     (17–19 digits, exceed 2^53) MUST stay as strings — `Number()`
 *     rounds and silently drops trailing digits, after which Discord's
 *     REST API rejects the request as "Unknown Message".
 *
 * Both schemas reject the empty/null/boolean/non-digit/non-integer/
 * negative/zero inputs that a bare `z.coerce.number().int()` was too
 * lax about.
 *
 * Background: some MCP transport / model paths deliver `message_id`,
 * `user_id`, `reply_to`, `offset_id` as JSON strings ("2081") rather
 * than numbers (2081). Plain `z.number()` rejects those with
 * `expected number, received string`, which manifested as
 * `react`/`pin_message`/`get_member_info`/`download_media` failing
 * out of nowhere even when the model formatted the call correctly
 * for a number-typed JSON Schema field.
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

const SNOWFLAKE = "1497549923779084388"; // 19-digit Discord snowflake > 2^53

function getIdSchema(toolName: string, field: string): z.ZodTypeAny {
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not found`);
  const schema = (tool.schema as Record<string, z.ZodTypeAny>)[field];
  if (!schema) throw new Error(`field ${field} not found on ${toolName}`);
  return schema;
}

/**
 * A snowflake-or-numeric schema preserves the input string verbatim
 * (no Number() coercion). Detect by parsing a snowflake-sized digit
 * string and checking the result type/value. Strict idSchema would
 * either reject (precision overflow in safe-int check) or coerce to
 * a rounded number.
 */
function acceptsSnowflakeAsString(schema: z.ZodTypeAny): boolean {
  const r = schema.safeParse(SNOWFLAKE);
  return r.success && r.data === SNOWFLAKE;
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
      // snowflakeOrIdSchema coerces the number to a string; strict idSchema
      // keeps it numeric. Both outcomes are valid — the bridge normalizes.
      expect(out === 2081 || out === "2081").toBe(true);
    });

    it(`${tool}.${field} accepts a numeric string`, () => {
      const s = getIdSchema(tool, field);
      // snowflakeOrIdSchema passes the string through; strict idSchema
      // coerces to number. Both outcomes are valid — the bridge layer
      // normalizes at the boundary.
      const out = s.parse("2081");
      expect(out === 2081 || out === "2081").toBe(true);
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

describe("Audit: every ID-shaped field uses idSchema or snowflakeOrIdSchema", () => {
  /**
   * Asserts the full accept/reject contract for both supported ID
   * schemas. Guards against a future replacement that passes loose
   * checks (e.g. bare `z.string()` accepts "123" but doesn't reject
   * empty/non-numeric inputs).
   */
  for (const tool of ALL_TOOLS) {
    const schema = tool.schema as Record<string, unknown>;
    for (const field of Object.keys(schema)) {
      if (!ID_FIELD_NAMES.has(field)) continue;
      const zSchema = schema[field] as z.ZodTypeAny;
      const isSnowflake = acceptsSnowflakeAsString(zSchema);

      it(`${tool.name}.${field}: accepts a positive integer number`, () => {
        const r = zSchema.safeParse(2081);
        expect(r.success).toBe(true);
        // snowflakeOrIdSchema coerces the number to a string; idSchema keeps it
        // numeric. Both are valid — the bridge normalizes at the boundary.
        if (r.success) expect(r.data === 2081 || r.data === "2081").toBe(true);
      });

      it(`${tool.name}.${field}: accepts a digit string`, () => {
        const r = zSchema.safeParse("2081");
        expect(r.success).toBe(true);
        if (r.success) {
          if (isSnowflake) {
            // Pass-through schema keeps the string verbatim.
            expect(r.data).toBe("2081");
          } else {
            // Strict idSchema coerces to number.
            expect(typeof r.data).toBe("number");
            expect(Number.isInteger(r.data as number)).toBe(true);
            expect(r.data).toBe(2081);
          }
        }
      });

      if (isSnowflake) {
        it(`${tool.name}.${field}: preserves Discord snowflakes without precision loss`, () => {
          const r = zSchema.safeParse(SNOWFLAKE);
          expect(r.success).toBe(true);
          if (r.success) {
            // The string must survive intact — `Number(SNOWFLAKE)`
            // rounds the last digit off (2^53 ceiling) and Discord
            // would reject the result as Unknown Message.
            expect(r.data).toBe(SNOWFLAKE);
            expect(typeof r.data).toBe("string");
          }
        });
      }

      // Reject the inputs that bare `z.coerce.number().int()` was too
      // permissive about — empty/whitespace/null/booleans coerce to
      // 0/0/0/1 and would pass `.int()`. Both strict union schemas
      // reject all of these.
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
