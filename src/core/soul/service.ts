/**
 * Soul Kernel — runtime service (the harness integration seam).
 *
 * A single gated entry point the rest of Talon talks to, so the kernel's
 * internals stay decoupled from the frontend/runtime. The service is OFF unless
 * the deployment opts in (`TALON_SOUL_ENABLED`); when off, every method is an
 * inert no-op and nothing about Talon's behavior changes.
 *
 * Construction is synchronous and race-free: the kernel loads from disk (or
 * genesis) with `readFileSync`, and the static projection used in the system
 * prompt is synchronous too. Only the maintenance `dream` (which embeds) is
 * async, so it runs off the hot path on a schedule.
 *
 * Responsibilities:
 *   - render the projected identity surface for the system prompt,
 *   - accept behavioral signals (reactions today; more taps to follow),
 *   - evaluate reflexes for the turn-end guard,
 *   - run the periodic `dream` and persist.
 */

import { existsSync } from "node:fs";
import { files } from "../../util/paths.js";
import { log, logError } from "../../util/log.js";
import { SoulKernel } from "./kernel.js";
import { TalonEmbedder } from "./talon-embedder.js";
import { resolveSoulSettings, type SoulSettings } from "./settings.js";
import {
  evaluateReflexes,
  isBlocked,
  type ReflexContext,
  type ReflexVerdict,
} from "./reflex.js";
import { explainDelta } from "./delta.js";
import type { Embedder } from "./embedder.js";
import type { Hash, ReflexPayload } from "./types.js";

export class SoulService {
  readonly enabled: boolean;
  private readonly embedder: Embedder = new TalonEmbedder();
  private lastActive: Hash[] = [];

  private constructor(
    private readonly kernel: SoulKernel | null,
    private readonly path: string,
  ) {
    this.enabled = kernel !== null;
  }

  /**
   * Build the service from settings. Disabled deployments get an inert instance;
   * enabled ones load the persisted kernel (or genesis a fresh one). A corrupt
   * store degrades to genesis rather than crashing the bot.
   */
  static create(override?: Partial<SoulSettings>): SoulService {
    const settings = resolveSoulSettings(override);
    const path = settings.path ?? files.soul;
    if (!settings.enabled) return new SoulService(null, path);

    let kernel: SoulKernel;
    try {
      kernel = existsSync(path) ? SoulKernel.load(path) : SoulKernel.genesis();
      log("soul", `loaded kernel (${existsSync(path) ? "disk" : "genesis"})`);
    } catch (err) {
      logError("soul", `kernel load failed, starting fresh: ${String(err)}`);
      kernel = SoulKernel.genesis();
    }
    return new SoulService(kernel, path);
  }

  // ── Prompt surface ───────────────────────────────────────────────────────────

  /**
   * The projected identity surface to inject into the system prompt, or "" when
   * disabled. Records the surfaced values as "active" so a later reaction can be
   * credited to exactly what was on stage.
   */
  renderPromptSection(): string {
    if (!this.kernel) return "";
    const projection = this.kernel.project();
    this.lastActive = [...projection.includedValues];
    return projection.text;
  }

  // ── Signal taps ──────────────────────────────────────────────────────────────

  /** A reaction to Talon's message → reinforce/penalize the values on stage. */
  recordReaction(emoji: string, at = Date.now()): void {
    if (!this.kernel) return;
    this.kernel.ingest({
      kind: "reaction",
      at,
      emoji,
      activeNodes: this.lastActive,
    });
    this.persist();
  }

  /** An explicit instruction about how to be → stored as verbatim evidence. */
  recordDirective(text: string, actor?: string, at = Date.now()): void {
    if (!this.kernel) return;
    this.kernel.ingest({
      kind: "directive",
      at,
      text,
      ...(actor ? { actor } : {}),
    });
    this.persist();
  }

  /** A correction → verbatim evidence + Spine event + penalize active values. */
  recordCorrection(text: string, actor?: string, at = Date.now()): void {
    if (!this.kernel) return;
    this.kernel.ingest({
      kind: "correction",
      at,
      text,
      activeNodes: this.lastActive,
      ...(actor ? { actor } : {}),
    });
    this.persist();
  }

  // ── Reflex guard ─────────────────────────────────────────────────────────────

  /** Evaluate the kernel's reflexes for a decision point. Empty when disabled. */
  reflexCheck(ctx: ReflexContext): ReflexVerdict[] {
    if (!this.kernel) return [];
    const reflexes = this.kernel
      .graph()
      .nodesOfKind("reflex")
      .map((n) => n.payload as ReflexPayload);
    return evaluateReflexes(reflexes, ctx);
  }

  /** Convenience: does any reflex block this decision point? */
  isBlocked(ctx: ReflexContext): boolean {
    return isBlocked(this.reflexCheck(ctx));
  }

  // ── Maintenance ──────────────────────────────────────────────────────────────

  /** The periodic organic pass: crystallize → consolidate → reflect, then persist. */
  async dream(): Promise<void> {
    if (!this.kernel) return;
    try {
      const summary = await this.kernel.dream(this.embedder);
      this.kernel.commit("dream");
      this.persist();
      log(
        "soul",
        `dream: +${summary.crystallized} values, ${summary.consolidated.created.length} merged, ${summary.themes} themes`,
      );
    } catch (err) {
      logError("soul", `dream failed: ${String(err)}`);
    }
  }

  // ── Introspection (/soul) ────────────────────────────────────────────────────

  /** Human-readable current identity + last delta, for the `/soul` command. */
  introspect(): string {
    if (!this.kernel) return "Soul is disabled.";
    const head = this.kernel.head();
    const projection = this.kernel.project();
    const lines = [
      projection.text,
      "",
      `_version ${this.kernel.history().length}, ${this.kernel.graph().size} nodes_`,
    ];
    if (head) lines.push(`_last change: ${head.summary}_`);
    const delta = explainDelta(this.kernel.delta());
    if (delta !== "no structural change")
      lines.push("", "Recent changes:", delta);
    return lines.join("\n");
  }

  private persist(): void {
    if (!this.kernel) return;
    try {
      this.kernel.save(this.path);
    } catch (err) {
      logError("soul", `persist failed: ${String(err)}`);
    }
  }
}

// ── Module singleton ─────────────────────────────────────────────────────────

let instance: SoulService | null = null;

/** The process-wide soul service (lazily created from env settings). */
export function getSoul(): SoulService {
  return (instance ??= SoulService.create());
}

/** Replace the singleton (tests / explicit settings). */
export function setSoul(service: SoulService): void {
  instance = service;
}

/** Drop the singleton so the next getSoul() rebuilds it. */
export function resetSoul(): void {
  instance = null;
}
