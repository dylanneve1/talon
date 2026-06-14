/**
 * Backend-agnostic contracts for the multi-backend functional harness.
 *
 * A `StubBackendAdapter` teaches the shared harness how to stub ONE backend's
 * transport. The harness owns everything backend-independent (the real
 * composition-root boot, the gateway + recording handler, the frontend seam,
 * driving `dispatcher.execute`); the adapter owns only the transport-specific
 * bits (start a fake server / point at a stub binary, apply the scripted turn,
 * collect extra diagnostics). Adding a backend = adding an adapter; no harness
 * changes.
 */
import type { TalonConfig } from "../../../util/config.js";

/** Result of one driven turn — common fields plus adapter-supplied extras. */
export interface StubTurnResult {
  /** Assistant text delivered to the frontend (concatenated `onTextBlock`s). */
  text: string;
  /** Tool calls observed via `onToolUse`, in order. */
  toolUses: ToolUseRecord[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Adapter-specific diagnostics (protocol log, MCP registrations, …). */
  extras: Record<string, unknown>;
}

export interface ToolUseRecord {
  name: string;
  input: Record<string, unknown>;
}

/** Per-turn context the harness hands the adapter when applying a script. */
export interface TurnContext {
  chatId: string;
  /** Fresh temp dir for this turn — adapters may drop script/state/log files. */
  tmpDir: string;
}

/**
 * One backend's stub transport. `Turn` is the backend-specific script shape for
 * a single dispatcher turn (the harness is generic over it).
 */
export interface StubBackendAdapter<Turn> {
  /** Backend id, e.g. `"codex"`. Drives `config.backend`. */
  readonly id: TalonConfig["backend"];
  /** Model id the dispatcher resolves and runs. */
  readonly model: string;

  /**
   * One-time setup that must run BEFORE the composition root boots (the backend
   * factory modules read their port/auth env at import time, and that import
   * happens inside `initBackendAndDispatcher`). Start fake servers, assign
   * dynamic ports into env, set stub auth here.
   */
  prepare?(): Promise<void> | void;

  /** Extra `TalonConfig` fields this backend needs (binary path, base URL, …). */
  configOverrides?(): Partial<TalonConfig>;

  /** Make the next `dispatcher.execute` run this scripted turn. */
  applyTurn(turn: Turn, ctx: TurnContext): void | Promise<void>;

  /** Per-turn cleanup (unset env, etc.). Always runs, even on failure. */
  afterTurn?(ctx: TurnContext): void;

  /** Adapter-specific diagnostics merged into `StubTurnResult.extras`. */
  collectExtras?(ctx: TurnContext): Record<string, unknown>;

  /** Final teardown (stop fake servers). */
  teardown?(): Promise<void> | void;
}
