/**
 * Soul Kernel — runtime gate.
 *
 * The soul is OFF by default. It is an experimental identity substrate; no
 * deployment should grow one unless it explicitly opts in. Our own Talon flips
 * `enabled` on (so the kernel accumulates from day one, ready for when the
 * harness wiring lands); every other deployment stays inert.
 *
 * Resolution order: explicit settings argument → env (`TALON_SOUL_ENABLED`) →
 * default false. When the harness config system grows a `soul` block, it should
 * feed it through `resolveSoulSettings`, keeping this the single gate.
 */

export interface SoulSettings {
  /** Master switch. Default false everywhere except our Talon. */
  readonly enabled: boolean;
  /** Path to the persisted kernel; defaults under the workspace when wired. */
  readonly path?: string;
}

export const DEFAULT_SOUL_SETTINGS: SoulSettings = { enabled: false };

function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Resolve effective settings. An explicit `enabled` always wins; otherwise the
 * env flag; otherwise disabled. Keeping this pure makes it trivially testable and
 * keeps the "default off" guarantee in one place.
 */
export function resolveSoulSettings(
  override?: Partial<SoulSettings>,
): SoulSettings {
  const enabled = override?.enabled ?? envFlag("TALON_SOUL_ENABLED") ?? false;
  return {
    enabled,
    ...(override?.path ? { path: override.path } : {}),
  };
}

/** True when the soul should run in this deployment. */
export function soulEnabled(override?: Partial<SoulSettings>): boolean {
  return resolveSoulSettings(override).enabled;
}
