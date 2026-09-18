/**
 * Types for the `model:*` callback handlers.
 *
 * A handler mutates at most one piece of chat-settings (or pool) state and
 * hands the router what to do next: a toast to answer the query with (or a
 * plain ack) and the view to redraw. It returns `undefined` when it already
 * answered the query itself — an error toast, or the "done" close — and
 * there is nothing to redraw.
 */

import type { Context } from "grammy";
import type { ModelCallback } from "../../model-callbacks.js";
import type { CallbackDeps } from "../shared.js";

export type ModelView =
  | { kind: "menu" }
  | { kind: "backends" }
  | {
      kind: "browse";
      page?: number;
      filter?: "all" | "free";
      provider?: string;
      backToGroups?: boolean;
    };

export type ModelOutcome = { toast?: string; view: ModelView };

export type ModelCallbackHandler<A extends ModelCallback = ModelCallback> = (
  ctx: Context,
  action: A,
  cid: string,
  deps: CallbackDeps,
) => Promise<ModelOutcome | undefined>;

export type ModelCallbackHandlers = {
  [K in ModelCallback["kind"]]: ModelCallbackHandler<
    Extract<ModelCallback, { kind: K }>
  >;
};
