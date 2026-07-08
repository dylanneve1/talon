/**
 * MeshService — the daemon-wide device-mesh facade.
 *
 * One instance serves every consumer in the process:
 *
 *   - Transports (the native bridge server) feed it registrations and
 *     location reports, and plug in a LocateDispatcher so on-demand locate
 *     requests reach connected companion apps. The service never imports a
 *     transport — dependencies point inward.
 *   - The model reads it through the shared `list_devices` /
 *     `get_device_location` gateway actions, so mesh access works
 *     identically from Telegram, Discord, Teams, terminal, and native
 *     chats — the mesh is daemon state, not a native-frontend feature.
 *
 * With no dispatcher registered (daemon running without the native bridge),
 * locate degrades gracefully: the last persisted location is answered
 * immediately instead of waiting out the fresh-fix window.
 */

import { MeshRegistry } from "./registry.js";
import type { DeviceInfo, DeviceLocation } from "./types.js";

/**
 * Pushes an on-demand locate request toward connected companion devices.
 * `deviceId` targets one device; undefined asks every device for a fix.
 */
export type LocateDispatcher = (deviceId?: string) => void;

export type MeshToolResult = { ok: boolean; text: string };

export type MeshServiceOptions = {
  /** How long a locate waits for a fresh fix before last-known fallback. */
  freshFixTimeoutMs?: number;
  /** Upper bound between staleness re-checks while waiting. */
  pollIntervalMs?: number;
};

const DEFAULT_FRESH_FIX_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MOBILE_PLATFORMS = new Set(["android", "ios"]);

export class MeshService {
  private readonly waiters = new Set<() => void>();
  private readonly dispatchers = new Set<LocateDispatcher>();
  private readonly freshFixTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly registry = new MeshRegistry(),
    options: MeshServiceOptions = {},
  ) {
    this.freshFixTimeoutMs =
      options.freshFixTimeoutMs ?? DEFAULT_FRESH_FIX_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Hydrate persisted devices/locations. Idempotent — safe to await from
   *  every entry point; the first caller does the read, the rest share it. */
  load(): Promise<void> {
    this.loading ??= this.registry.load();
    return this.loading;
  }

  /**
   * Plug a transport in as a locate dispatcher. Returns an unsubscribe so
   * the transport detaches cleanly on shutdown (no stale broadcasts into a
   * stopped server).
   */
  registerLocateDispatcher(dispatch: LocateDispatcher): () => void {
    this.dispatchers.add(dispatch);
    return () => this.dispatchers.delete(dispatch);
  }

  /** Fan a locate request out to every transport. True when at least one
   *  transport is attached (i.e. waiting for a fresh fix can pay off). */
  requestLocate(deviceId?: string): boolean {
    for (const dispatch of this.dispatchers) {
      try {
        dispatch(deviceId);
      } catch {
        // One broken transport must not stop the others from locating.
      }
    }
    return this.dispatchers.size > 0;
  }

  async register(body: Record<string, unknown>): Promise<DeviceInfo> {
    await this.load();
    return this.registry.register(body);
  }

  /** Store a reported fix and wake anyone waiting on a fresh location. */
  async storeLocation(body: Record<string, unknown>): Promise<DeviceLocation> {
    await this.load();
    const loc = await this.registry.storeLocation(body);
    for (const notify of [...this.waiters]) notify();
    return loc;
  }

  async list(): Promise<{ devices: DeviceInfo[]; locations: DeviceLocation[] }> {
    await this.load();
    return this.registry.list();
  }

  async getLocation(deviceId: string): Promise<DeviceLocation | undefined> {
    await this.load();
    return this.registry.getLocation(deviceId);
  }

  // ── Model-facing tool surface ──────────────────────────────────────────────

  /** `list_devices`: every mesh device with presence, battery, and its
   *  last-known position — the model's full view of the mesh. */
  async describeDevices(): Promise<MeshToolResult> {
    const { devices } = await this.list();
    if (devices.length === 0) {
      return { ok: true, text: "No mesh devices have registered yet." };
    }
    return {
      ok: true,
      text: devices.map((d) => this.deviceLine(d)).join("\n"),
    };
  }

  /**
   * `get_device_location`: resolve the target (id, name fragment, or the
   * most recent mobile device), push a locate to connected transports, wait
   * briefly for a fresh fix, then fall back to the last persisted location.
   */
  async locateDevice(query?: unknown): Promise<MeshToolResult> {
    await this.load();
    const target = this.chooseDevice(query);
    if (!target) {
      const known = this.registry.list().devices;
      return {
        ok: false,
        text:
          typeof query === "string" && query.trim() && known.length > 0
            ? `No mesh device matches "${query.trim()}". Known devices:\n${known.map((d) => this.deviceLine(d)).join("\n")}`
            : "No mesh devices are registered.",
      };
    }
    const requestedAt = Date.now();
    // Only wait out the fresh-fix window when a transport can actually
    // deliver the locate — otherwise answer from persistence immediately.
    const dispatched = this.requestLocate(target.id);
    const fresh = dispatched
      ? await this.waitForFreshLocation(target.id, requestedAt)
      : undefined;
    const loc = fresh ?? this.registry.getLocation(target.id);
    if (!loc) {
      return {
        ok: false,
        text: dispatched
          ? `No location is known for ${target.name}. A locate request was sent, but no fix arrived within ${Math.round(this.freshFixTimeoutMs / 1000)}s.`
          : `No location is known for ${target.name}, and no companion transport is connected to request one.`,
      };
    }
    return { ok: true, text: this.locationSummary(target, loc) };
  }

  /** Resolve a device by exact id, name fragment, or default (most recently
   *  seen mobile device, falling back to the most recent device overall). */
  chooseDevice(query?: unknown): DeviceInfo | undefined {
    const devices = this.registry.list().devices;
    if (typeof query === "string" && query.trim()) {
      const q = query.trim().toLowerCase();
      return devices.find(
        (d) => d.id.toLowerCase() === q || d.name.toLowerCase().includes(q),
      );
    }
    return devices.find((d) => MOBILE_PLATFORMS.has(d.platform)) ?? devices[0];
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  private deviceLine(device: DeviceInfo): string {
    const parts = [
      `${device.name} [id: ${device.id}] (${device.platform})`,
      device.online ? "online" : "offline",
      `last seen ${age(Date.now() - device.lastSeen)}`,
    ];
    if (typeof device.battery === "number") {
      parts.push(`${device.battery}%${device.charging ? " charging" : ""}`);
    }
    const loc = this.registry.getLocation(device.id);
    if (loc) {
      parts.push(
        `at ${loc.lat.toFixed(6)},${loc.lon.toFixed(6)} (fix ${age(Date.now() - loc.ts)})`,
      );
    }
    return `- ${parts.join(" · ")}`;
  }

  private locationSummary(device: DeviceInfo, loc: DeviceLocation): string {
    const ageText = age(Date.now() - loc.ts);
    const accuracy =
      typeof loc.accuracyM === "number"
        ? ` Accuracy ${Math.round(loc.accuracyM)}m.`
        : "";
    return [
      `${device.name} is at ${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}.`,
      `${accuracy} Fix age ${ageText}.`,
      `Reverse-geocode pair: ${loc.lat},${loc.lon}`,
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async waitForFreshLocation(
    deviceId: string,
    requestedAt: number,
  ): Promise<DeviceLocation | undefined> {
    const existing = this.registry.getLocation(deviceId);
    if (existing && existing.ts >= requestedAt) return existing;
    const deadline = Date.now() + this.freshFixTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.min(remaining, this.pollIntervalMs),
        );
        this.waiters.add(done);
      });
      const loc = this.registry.getLocation(deviceId);
      if (loc && loc.ts >= requestedAt) return loc;
    }
    return undefined;
  }
}

function age(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  return `${hrs}h ago`;
}

// ── Process-wide instance ─────────────────────────────────────────────────────

let instance: MeshService | null = null;

/** The daemon's shared mesh service (lazily created). */
export function getMeshService(): MeshService {
  instance ??= new MeshService();
  return instance;
}

/** Swap the shared instance — composition/test seam. Pass null to reset. */
export function setMeshService(service: MeshService | null): void {
  instance = service;
}
