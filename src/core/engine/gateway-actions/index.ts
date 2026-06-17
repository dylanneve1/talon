/**
 * Shared gateway actions — platform-agnostic handlers that work with any
 * frontend.
 *
 * Each domain module exports a `SharedActionHandlers` map keyed by action
 * name; they're merged into one registry here. `handleSharedAction` looks the
 * action up and returns null when it isn't recognized, so the gateway
 * delegates to the frontend.
 *
 *   - `history`   — in-memory history queries (read/search/users/media)
 *   - `fetch-url` — fetch a URL (text extraction or binary download)
 *   - `cron`      — scheduled-job CRUD
 *   - `triggers`  — long-running watcher-script CRUD
 *   - `goals`     — persistent multi-turn objectives
 *   - `scripts`   — reusable agent-authored scripts
 *   - `skills`    — markdown workflows
 *   - `plugins`   — plugin hot-reload
 *   - `models`    — model / backend discovery
 */

import type { ActionResult } from "../../types.js";
import type { Backend } from "../../agent-runtime/capabilities.js";
import type { SharedActionHandlers } from "./types.js";
import { historyHandlers } from "./history.js";
import { fetchUrlHandlers } from "./fetch-url.js";
import { cronHandlers } from "./cron.js";
import { triggerHandlers } from "./triggers.js";
import { goalHandlers } from "./goals.js";
import { scriptHandlers } from "./scripts.js";
import { skillHandlers } from "./skills.js";
import { pluginHandlers } from "./plugins.js";
import { modelHandlers } from "./models.js";

// Null-prototype so a request `action` of "toString" / "constructor" / etc.
// can't resolve an inherited Object.prototype method — `handlers[action]` only
// ever finds an own handler key (the original switch had no such hazard).
const handlers: SharedActionHandlers = Object.assign(Object.create(null), {
  ...historyHandlers,
  ...fetchUrlHandlers,
  ...cronHandlers,
  ...triggerHandlers,
  ...goalHandlers,
  ...scriptHandlers,
  ...skillHandlers,
  ...pluginHandlers,
  ...modelHandlers,
});

export async function handleSharedAction(
  body: Record<string, unknown>,
  chatId: number,
  backend?: Backend | null,
): Promise<ActionResult | null> {
  const action = body.action as string;
  const handler = handlers[action];
  if (!handler) return null; // not a shared action — delegate to frontend
  return handler(body, chatId, backend);
}

export type { SharedActionHandler, SharedActionHandlers } from "./types.js";
