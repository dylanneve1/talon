/**
 * View navigation — `model:menu`, `model:browse`, `model:nav:*`,
 * `model:backends`. No state changes; each just names the view to redraw.
 */

import type { ModelCallback } from "../../model-callbacks.js";
import type { ModelOutcome } from "./types.js";

export async function showMenu(): Promise<ModelOutcome> {
  return { view: { kind: "menu" } };
}

export async function showBrowse(): Promise<ModelOutcome> {
  return { view: { kind: "browse" } };
}

export async function navBackToProviders(): Promise<ModelOutcome> {
  return { view: { kind: "browse", backToGroups: true, page: 1 } };
}

export async function navProvider(
  _ctx: unknown,
  action: Extract<ModelCallback, { kind: "nav-provider" }>,
): Promise<ModelOutcome> {
  return { view: { kind: "browse", provider: action.provider, page: 1 } };
}

export async function navPage(
  _ctx: unknown,
  action: Extract<ModelCallback, { kind: "nav-page" }>,
): Promise<ModelOutcome> {
  return {
    view: {
      kind: "browse",
      page: action.page,
      filter: action.filter,
      provider: action.provider,
    },
  };
}

// Legacy support — current UX promotes free-toggle on the main
// menu, but a `model:nav:filter:*` payload from an old message
// still routes to the browse view with that filter applied.
export async function navFilter(
  _ctx: unknown,
  action: Extract<ModelCallback, { kind: "nav-filter" }>,
): Promise<ModelOutcome> {
  return { view: { kind: "browse", filter: action.filter, page: 1 } };
}

export async function showBackends(): Promise<ModelOutcome> {
  return { view: { kind: "backends" } };
}
