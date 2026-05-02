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
