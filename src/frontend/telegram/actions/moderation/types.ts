import type { ActionResult } from "../../../../core/types.js";
import type { TelegramActionContext } from "../types.js";

/** One `moderate` call, pre-parsed: the op name, the raw body, and the
 * `user_id` the router already validated for ops that need one. */
type ModerationRequest = {
  op: string;
  body: Record<string, unknown>;
  chatId: number;
  ctx: TelegramActionContext;
  userId: number | undefined;
};

export type ModerationOp = (req: ModerationRequest) => Promise<ActionResult>;

export type ModerationOps = Record<string, ModerationOp>;
