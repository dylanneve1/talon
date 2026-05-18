/**
 * Pure parser + types for `/model` inline-button callback data.
 *
 * Centralising this here keeps the dispatch in `callbacks.ts` thin
 * and gives tests a side-effect-free entry point — no Telegram
 * context, no chat-settings storage, no backend calls. The
 * grammar:
 *
 *   model:done                         — close (delete message)
 *   model:noop                         — ack-and-drop (page indicator)
 *   model:menu                         — re-render main menu
 *   model:browse                       — drill into browse view
 *   model:toggle-free                  — flip persisted freeOnly
 *   model:reset                        — clear per-chat model override
 *   model:nav:provider:<provider>      — drill into one provider
 *   model:nav:providers                — back to provider list
 *   model:nav:filter:<all|free>        — change filter (legacy; toggle owns it now)
 *   model:nav:page:<N>:<filter>:<P?>   — navigate to a page
 *   model:<id>                         — select that model
 *
 * Telegram Bot API limit: 1–64 bytes per callback_data
 * (https://core.telegram.org/bots/api#inlinekeyboardbutton). The
 * grammar above keeps the prefix short so 40+-char model ids still
 * fit.
 */

export type ModelCallback =
  | { kind: "done" }
  | { kind: "noop" }
  | { kind: "menu" }
  | { kind: "browse" }
  | { kind: "toggle-free" }
  | { kind: "reset" }
  | { kind: "nav-provider"; provider: string }
  | { kind: "nav-back-to-providers" }
  | { kind: "nav-filter"; filter: "all" | "free" }
  | {
      kind: "nav-page";
      page: number;
      filter: "all" | "free";
      provider?: string;
    }
  | { kind: "select"; modelId: string }
  | { kind: "unknown" };

const FILTERS = new Set(["all", "free"]);

export function parseModelCallback(data: string): ModelCallback {
  if (!data.startsWith("model:")) return { kind: "unknown" };
  const rest = data.slice("model:".length);

  if (rest === "done") return { kind: "done" };
  if (rest === "noop") return { kind: "noop" };
  if (rest === "menu") return { kind: "menu" };
  if (rest === "browse") return { kind: "browse" };
  if (rest === "toggle-free") return { kind: "toggle-free" };
  if (rest === "reset") return { kind: "reset" };

  if (rest.startsWith("nav:")) {
    const parts = rest.split(":");
    // parts[0] === "nav", parts[1] === <sub>, parts[2...] === args
    const sub = parts[1];
    if (sub === "providers") return { kind: "nav-back-to-providers" };
    if (sub === "provider") {
      const provider = parts.slice(2).join(":");
      if (!provider) return { kind: "unknown" };
      return { kind: "nav-provider", provider };
    }
    if (sub === "filter") {
      const f = parts[2];
      if (f && FILTERS.has(f))
        return { kind: "nav-filter", filter: f as "all" | "free" };
      return { kind: "unknown" };
    }
    if (sub === "page") {
      const n = Number(parts[2]);
      if (!Number.isFinite(n) || n < 1) return { kind: "unknown" };
      const f = parts[3];
      if (!f || !FILTERS.has(f)) return { kind: "unknown" };
      const provider = parts[4];
      return {
        kind: "nav-page",
        page: Math.floor(n),
        filter: f as "all" | "free",
        ...(provider ? { provider } : {}),
      };
    }
    return { kind: "unknown" };
  }

  // Anything else under `model:` is a model id selection. Reject ids
  // that look like control payloads from older bot versions so they
  // can't be persisted as a real model.
  if (rest.startsWith("nav") || rest === "" || rest.includes(":nav:")) {
    return { kind: "unknown" };
  }
  return { kind: "select", modelId: rest };
}
