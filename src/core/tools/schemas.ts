/**
 * Shared zod schema fragments for tool input definitions.
 */

import { z } from "zod";

/**
 * Telegram-style positive integer ID (message_id, user_id, reply_to,
 * offset_id, etc.).
 *
 * Accepts:
 *   - actual numbers that are positive integers (`2081`)
 *   - digit-only strings (`"2081"`) which are transformed into numbers
 *
 * Rejects:
 *   - non-numeric strings (`"abc"`, `"2081abc"`, `""`, `"   "`)
 *   - booleans, `null`, `undefined` (would otherwise coerce to 0/1)
 *   - non-integer numbers (`1.5`)
 *   - zero and negatives
 *
 * Use this instead of `z.number()` or `z.coerce.number()` for any ID
 * field on tool input schemas. The plain coercion path was too lax —
 * `z.coerce.number().int()` happily turns `null`/`""` into `0` and
 * `true` into `1`, both of which the Telegram bot API would then
 * dispatch to. The strict union avoids that.
 */
export const idSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d+$/, "must be a positive integer")
    .transform((s) => Number(s))
    .pipe(z.number().int().positive()),
]);

/**
 * Telegram-style chat ID. Unlike message/user IDs, chat IDs can be
 * NEGATIVE: supergroups and channels use `-100xxxxxxxxxx`, basic
 * groups use `-xxxxxxxxxx`, and private chats / DMs use the
 * positive user ID. Zero is never a valid chat ID and is the
 * sentinel the gateway already treats as falsy/unrouted.
 *
 * Accepts:
 *   - actual non-zero integer numbers (`352042062`, `-1001426819337`)
 *   - integer strings with optional leading minus (`"-1001426819337"`)
 *
 * Rejects:
 *   - zero (`0`, `"0"`, `"-0"`)
 *   - non-integer numbers (`1.5`)
 *   - non-numeric strings, booleans, null, undefined
 *
 * Use this for `chat_id` fields on tool input schemas. The bare
 * `idSchema` is for message/user/reply IDs (always positive) and
 * would reject the negative IDs Telegram uses for groups/channels —
 * which was the bug PR #150 shipped with: heartbeat outbound `send`
 * to a supergroup got `expected number, received string` (the model
 * sees a `number` JSON schema, but zod rejects negatives before the
 * gateway sees the request). Gateway-side handling for negative
 * chat_ids was already tested and correct — only the tool-input
 * schema layer needed the fix.
 */
const nonZeroInt = z
  .number()
  .int()
  .refine((n) => n !== 0, "chat_id cannot be zero");

export const chatIdSchema = z.union([
  nonZeroInt,
  z
    .string()
    .regex(/^-?\d+$/, "must be an integer (negative for supergroups)")
    .transform((s) => Number(s))
    .pipe(nonZeroInt),
]);
