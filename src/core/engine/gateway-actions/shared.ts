/**
 * Helpers shared across shared-action domains: due-date parsing and per-job
 * model-override validation.
 */

import { resolveExplicitModelRef } from "../../models/active-model.js";
import {
  getBackendForChat,
  getBackendIdForChat,
} from "../backend-controller/index.js";

/**
 * Parse a goal due date. Accepts ISO 8601 strings (date-only or full
 * timestamp). Returns unix ms, or undefined when unparseable.
 */
export function parseDueDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Validate a per-job model override so create_cron_job / trigger_create can
 * reject a bad override up front — the agent retries or tells the user —
 * instead of storing one that fails at fire time.
 *
 * The override is restricted to the chat's own backend so the wake-up can
 * resume the existing session (a session id is backend-specific). The model
 * must therefore be selectable on the chat's backend; returns an error string
 * when it isn't, or `null` when it's valid.
 */
export async function validateJobModelOverride(
  chatId: number,
  model: string,
): Promise<string | null> {
  try {
    const chatIdStr = String(chatId);
    const ref = await resolveExplicitModelRef(
      model,
      getBackendForChat(chatIdStr),
      getBackendIdForChat(chatIdStr),
    );
    if (!ref) {
      return (
        `Model "${model}" is not a selectable model on this chat's backend. ` +
        `Leave model unset to use the chat's model, or pick a valid model id ` +
        `on the same backend (cross-backend models aren't allowed — they'd ` +
        `break session continuity).`
      );
    }
    return null;
  } catch (err) {
    return `Could not validate model override: ${err instanceof Error ? err.message : String(err)}`;
  }
}
