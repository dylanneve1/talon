/**
 * Backend registry — decouples bootstrap from concrete backend imports.
 *
 * Each concrete backend (`claude-sdk`, `kilo`, `opencode`) exposes a
 * `factory.ts` module that registers itself by calling `registerBackend`.
 * Bootstrap looks up the requested backend by id, calls `init`, and
 * receives a fully-wired `Backend` plus an optional cleanup hook.
 *
 * Why a registry instead of `if/else` in bootstrap:
 *
 *   1. **Modularity.** Adding a fourth backend means writing one new
 *      `factory.ts` and importing it — no churn to `bootstrap.ts`.
 *   2. **Testability.** Tests can register a stub backend
 *      (`registerBackend({ id: "test-stub", ... })`) and route through
 *      the same code path the real backends use.
 *   3. **Plugin doors.** Future external backend plugins can call
 *      `registerBackend` from a path-style plugin module, the same way
 *      MCP plugins do today.
 *
 * The registry is module-scoped — every Talon process has its own map.
 * `clearBackends()` is exposed for test isolation.
 *
 * Layering: this lives in `core/` (not `backend/`) on purpose. It is
 * generic infrastructure — a typed `id → factory` map that depends only
 * on the core `Backend` contract and `TalonConfig`, never on a concrete
 * backend. Keeping it here lets `core/engine/backend-controller` resolve
 * backends without `core` importing `backend/` (the dependency arrow runs
 * backend → core: each backend's `factory.ts` imports `registerBackend`
 * from here to self-register). Do not move it back under `backend/`.
 */

import type { Backend } from "./capabilities.js";
import type { TalonConfig } from "../../util/config.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Frontend identifiers that can be passed to a backend's init step. */
export type FrontendName =
  | "telegram"
  | "terminal"
  | "teams"
  | "discord"
  | "native";

/** Per-init context — runtime dependencies the backend may need at startup. */
export interface BackendInitContext {
  /**
   * Returns the gateway HTTP port — late-bound so backends pick up the
   * actual listening port (the gateway picks 0 → ephemeral in tests).
   */
  getBridgePort: () => number;
  /**
   * Primary frontend driving this Talon process. Backends use this to
   * label MCP servers, scope tool environments, and pick the right
   * default suffix wording.
   */
  frontendName: FrontendName;
}

/** Result returned by a backend factory's `init` step. */
export interface BackendInstance {
  /** The fully-wired `Backend` the dispatcher will route to. */
  backend: Backend;
  /**
   * Optional teardown hook invoked when Talon shuts down or hot-swaps
   * backends (future use). Idempotent: backends should tolerate multiple
   * calls.
   */
  cleanup?: () => Promise<void> | void;
}

/** A registered backend implementation. */
export interface BackendFactory {
  /** Stable identifier — matches `config.backend` in `talon.json`. */
  id: string;
  /** Display label used in `/status` and agent logs (e.g. "Kilo"). */
  label: string;
  /** Initialise the backend; called exactly once per Talon process. */
  init(config: TalonConfig, ctx: BackendInitContext): Promise<BackendInstance>;
}

// ── State ───────────────────────────────────────────────────────────────────

const backends = new Map<string, BackendFactory>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register a backend implementation.
 *
 * Throws on duplicate id — we'd rather fail at startup than silently
 * pick the wrong implementation.
 */
export function registerBackend(factory: BackendFactory): void {
  if (backends.has(factory.id)) {
    throw new Error(
      `Backend "${factory.id}" already registered — duplicate registration`,
    );
  }
  backends.set(factory.id, factory);
}

/** Look up a backend by id. Returns `undefined` if not registered. */
export function getBackend(id: string): BackendFactory | undefined {
  return backends.get(id);
}

/**
 * List all registered backends, sorted by id for deterministic output.
 *
 * Useful for `/status`, error messages ("known backends: a, b, c"), and
 * config validation. Returns a fresh array each call — caller can mutate
 * without affecting the registry.
 */
export function listBackends(): BackendFactory[] {
  return [...backends.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Clear the registry. Test-only utility — production code should never
 * call this.
 */
export function clearBackends(): void {
  backends.clear();
}

/** Whether a backend with this id is currently registered. */
export function hasBackend(id: string): boolean {
  return backends.has(id);
}
