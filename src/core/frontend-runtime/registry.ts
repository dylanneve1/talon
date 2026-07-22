/**
 * Frontend registry — the frontend counterpart of
 * `core/agent-runtime/backend-registry.ts`.
 *
 * One typed `id → descriptor` map that owns two things the codebase
 * used to hardcode in parallel chains (bootstrap dispatch routing,
 * gateway action routing, backend MCP tool scoping, the composition
 * root's creation switch):
 *
 *   1. **Identity + chat-id ownership.** "Whose chat id is this?" is
 *      answered once, here, from the registered descriptors' matchers in
 *      `routePriority` order — instead of five copies of the same
 *      if/else chain drifting apart.
 *   2. **Creation.** The composition root looks a frontend up by id and
 *      calls its attached create — adding a frontend means one new
 *      `factory.ts`, no switch churn.
 *
 * Registration is split to respect layering (core never imports
 * frontend/): built-in *descriptors* register from core
 * (`builtins.ts`), and each frontend's `factory.ts` attaches the heavy
 * create via `attachFrontendCreate` (`create.ts`). External plugin
 * frontends register descriptor + create in one call with
 * `registerFrontend`.
 *
 * This module is deliberately self-contained (no imports from
 * `capabilities.ts` or the engine): the create function is stored
 * opaquely here and typed at the `create.ts` seam, so routing-only
 * consumers (gateway, backend MCP scoping) never pull the engine types
 * into an import cycle.
 *
 * The registry is module-scoped; `resetFrontendRegistry()` restores the
 * built-in descriptors for test isolation.
 */

import { TalonError } from "../errors.js";

/**
 * Static identity + routing traits for one frontend. Registered before
 * config is even loaded, so it must stay dependency-light: no SDK
 * imports, no I/O — predicates and flags only.
 */
export type FrontendDescriptor = {
  /** Stable identifier — matches `config.frontend` entries. */
  id: string;
  /** Display label for logs and status output (e.g. "Telegram"). */
  label: string;
  /**
   * Whether this frontend owns a chat id, by its id-shape convention
   * (native `d_*`, teams `teams_chat_*`, discord `discord_*`, telegram
   * numeric, terminal `t_*`). Shapes should be disjoint; where two
   * matchers could overlap, `routePriority` breaks the tie.
   */
  ownsChatId: (chatId: string) => boolean;
  /**
   * Tie-break order for chat-id resolution — lower checks first. Broad
   * matchers (telegram accepts any numeric id) belong at the high end
   * so specific shapes always win.
   */
  routePriority: number;
  /**
   * Has an outbound messaging surface — i.e. gets a per-frontend MCP
   * tool server (`<id>-tools`) so the model can address the surface
   * explicitly. False for the terminal: the agent runs to stdout and
   * has nothing to deliver out-of-band.
   */
  messaging: boolean;
  /**
   * Reads stdin interactively, so `start()` blocks for the process
   * lifetime. The composition root starts such frontends without
   * awaiting them when they run alongside others.
   */
  sharesStdin?: boolean;
};

/**
 * The create function as stored here: opaque. `create.ts` narrows it
 * back to the typed `FrontendCreate` — keeping engine types out of
 * this module so routing-only importers stay cycle-free.
 */
type OpaqueCreate = (...args: never[]) => unknown;

type Entry = FrontendDescriptor & { create?: OpaqueCreate };

const frontends = new Map<string, Entry>();

/**
 * Register a frontend descriptor (optionally with a create function
 * already attached, as plugin frontends do via `registerFrontend` in
 * `create.ts`). Throws on duplicate id — fail at startup rather than
 * silently shadowing an implementation.
 */
export function registerFrontendDescriptor(
  descriptor: FrontendDescriptor,
  create?: OpaqueCreate,
): void {
  if (frontends.has(descriptor.id)) {
    throw new TalonError(
      `Frontend "${descriptor.id}" already registered — duplicate registration`,
      { reason: "bad_request" },
    );
  }
  frontends.set(descriptor.id, { ...descriptor, create });
}

/** @internal typed seam in create.ts — use `attachFrontendCreate`. */
export function attachOpaqueCreate(id: string, create: OpaqueCreate): void {
  const entry = frontends.get(id);
  if (!entry) {
    throw new TalonError(
      `Cannot attach factory: frontend "${id}" is not registered ` +
        `(known: ${knownIds()})`,
      { reason: "bad_request" },
    );
  }
  if (entry.create) {
    throw new TalonError(`Frontend "${id}" already has a factory attached`, {
      reason: "bad_request",
    });
  }
  entry.create = create;
}

/** @internal typed seam in create.ts — use `createFrontendById`. */
export function getOpaqueCreate(id: string): OpaqueCreate | undefined {
  return frontends.get(id)?.create;
}

/** Look up a frontend descriptor by id. */
export function getFrontendDescriptor(
  id: string,
): FrontendDescriptor | undefined {
  return frontends.get(id);
}

/** Whether a frontend with this id is registered. */
export function hasFrontend(id: string): boolean {
  return frontends.has(id);
}

/** All registered descriptors, sorted by id for deterministic output. */
export function listFrontends(): FrontendDescriptor[] {
  return [...frontends.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** @internal error-message helper shared with create.ts. */
export function knownIds(): string {
  return [...frontends.keys()].sort().join(", ") || "none";
}

/**
 * The frontend that owns a chat id by shape convention, or null for
 * cross-surface contexts (the heartbeat sentinel, isolated one-shots).
 * Matchers run in `routePriority` order so specific shapes beat broad
 * ones (telegram's numeric matcher accepts almost anything).
 *
 * By default only messaging frontends are considered — the historical
 * `frontendForChatId` contract used for MCP tool scoping, where
 * terminal sessions deliberately resolve to null. Pass
 * `includeNonMessaging: true` for full routing (gateway actions,
 * dispatch), where terminal ids resolve to the terminal.
 */
export function resolveOwnerFrontendId(
  chatId: string,
  opts: { includeNonMessaging?: boolean } = {},
): string | null {
  for (const entry of byPriority()) {
    if (!opts.includeNonMessaging && !entry.messaging) continue;
    if (entry.ownsChatId(chatId)) return entry.id;
  }
  return null;
}

/**
 * Pick the frontend that should serve a chat from a set of live
 * candidates (the configured frontends of this process). Semantics
 * preserved from the old bootstrap chain: a single candidate always
 * wins; otherwise the chat id's owner wins when it is a candidate;
 * otherwise fall back to the first messaging candidate (a stdin
 * frontend must not swallow cross-surface work), else the first.
 */
export function resolveFrontendIdAmong(
  chatId: string | undefined,
  candidates: readonly string[],
): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (chatId) {
    for (const entry of byPriority()) {
      if (!candidates.includes(entry.id)) continue;
      if (entry.ownsChatId(chatId)) return entry.id;
    }
  }
  const messaging = candidates.find(
    (id) => frontends.get(id)?.messaging !== false,
  );
  return messaging ?? candidates[0];
}

/**
 * Restore the registry to just the built-in descriptors. Test-only
 * utility — production code should never call this.
 */
export function resetFrontendRegistry(): void {
  frontends.clear();
  registerBuiltinFrontendsInternal();
}

// ── Internal ────────────────────────────────────────────────────────────────

function byPriority(): Entry[] {
  return [...frontends.values()].sort(
    (a, b) => a.routePriority - b.routePriority,
  );
}

// Injected by builtins.ts at module-load time (avoids an import cycle:
// builtins imports registerFrontendDescriptor from here).
let registerBuiltinFrontendsInternal: () => void = () => {};

/** @internal wiring for builtins.ts — not part of the public API. */
export function setBuiltinRegistrar(fn: () => void): void {
  registerBuiltinFrontendsInternal = fn;
}
