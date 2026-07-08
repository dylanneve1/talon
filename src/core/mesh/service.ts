/**
 * MeshService — the daemon-wide device-mesh facade.
 *
 * One instance serves every consumer in the process:
 *
 *   - Transports (the native bridge server) feed it registrations, location
 *     reports, and command results, and plug in a MeshTransport so locate
 *     requests and device commands reach connected companion apps. The
 *     service never imports a transport — dependencies point inward.
 *   - The model reads and drives it through the shared mesh gateway actions
 *     (list_devices, get_device_location, get_device_history, ring_device,
 *     get_device_status), so full mesh access works identically from
 *     Telegram, Discord, Teams, terminal, and native chats — the mesh is
 *     daemon state, not a native-frontend feature.
 *
 * Two request/response flows ride the same SSE-out / HTTP-POST-back loop:
 *
 *   locate   → `locate` event   → device POSTs /location            (legacy,
 *              kept verbatim so pre-command app builds keep working)
 *   command  → `device_command` → device POSTs /devices/command-result with
 *              the command's correlation id; sendCommand resolves the
 *              pending promise or times out.
 *
 * With no transport registered (daemon running without the native bridge),
 * everything degrades gracefully: locate answers from the last persisted
 * fix immediately, and commands fail fast with a clear explanation.
 */

import { randomUUID } from "node:crypto";
import { MeshRegistry } from "./registry.js";
import type {
  DeviceCommand,
  DeviceCommandResult,
  DeviceInfo,
  DeviceLocation,
} from "./types.js";

/** How a transport pushes mesh traffic to connected companion devices. */
export type MeshTransport = {
  /** Ask one device (or all, when undefined) for a fresh location fix. */
  locate(deviceId?: string): void;
  /** Deliver an on-demand command to its target device. */
  command(command: DeviceCommand): void;
};

export type MeshToolResult = { ok: boolean; text: string };

export type MeshServiceOptions = {
  /** How long a locate waits for a fresh fix before last-known fallback. */
  freshFixTimeoutMs?: number;
  /** Upper bound between staleness re-checks while waiting. */
  pollIntervalMs?: number;
  /** How long a device command waits for its result before timing out. */
  commandTimeoutMs?: number;
};

const DEFAULT_FRESH_FIX_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const MOBILE_PLATFORMS = new Set(["android", "ios"]);
const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_LINES = 24;

export class MeshService {
  private readonly waiters = new Set<() => void>();
  private readonly transports = new Set<MeshTransport>();
  private readonly pendingCommands = new Map<
    string,
    (result: DeviceCommandResult) => void
  >();
  private readonly freshFixTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly registry = new MeshRegistry(),
    options: MeshServiceOptions = {},
  ) {
    this.freshFixTimeoutMs =
      options.freshFixTimeoutMs ?? DEFAULT_FRESH_FIX_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /** Hydrate persisted devices/locations. Idempotent — safe to await from
   *  every entry point; the first caller does the read, the rest share it. */
  load(): Promise<void> {
    this.loading ??= this.registry.load();
    return this.loading;
  }

  /**
   * Plug a transport in. Returns an unsubscribe so the transport detaches
   * cleanly on shutdown (no stale broadcasts into a stopped server).
   */
  registerTransport(transport: MeshTransport): () => void {
    this.transports.add(transport);
    return () => this.transports.delete(transport);
  }

  /** Fan a locate request out to every transport. True when at least one
   *  transport is attached (i.e. waiting for a fresh fix can pay off). */
  requestLocate(deviceId?: string): boolean {
    for (const transport of this.transports) {
      try {
        transport.locate(deviceId);
      } catch {
        // One broken transport must not stop the others.
      }
    }
    return this.transports.size > 0;
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

  async list(): Promise<{
    devices: DeviceInfo[];
    locations: DeviceLocation[];
  }> {
    await this.load();
    return this.registry.list();
  }

  async getLocation(deviceId: string): Promise<DeviceLocation | undefined> {
    await this.load();
    return this.registry.getLocation(deviceId);
  }

  // ── Command channel ────────────────────────────────────────────────────────

  /**
   * A device answered a command (bridge route POST /devices/command-result).
   * Resolves the pending sendCommand; false when nothing was waiting (late
   * or unknown correlation id — harmless, just ignored).
   */
  completeCommand(body: Record<string, unknown>): boolean {
    const commandId = typeof body.commandId === "string" ? body.commandId : "";
    const resolve = this.pendingCommands.get(commandId);
    if (!resolve) return false;
    this.pendingCommands.delete(commandId);
    resolve({
      commandId,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
      ok: body.ok === true,
      ...(typeof body.message === "string" && body.message.trim()
        ? { message: body.message.trim().slice(0, 2_000) }
        : {}),
      ...(body.data &&
      typeof body.data === "object" &&
      !Array.isArray(body.data)
        ? { data: body.data as Record<string, unknown> }
        : {}),
    });
    return true;
  }

  /**
   * Push one command to a device and await its result (or time out). The
   * low-level primitive under every command tool; exposed for tests and
   * future tools.
   */
  sendCommand(
    device: DeviceInfo,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<DeviceCommandResult> {
    const command: DeviceCommand = {
      id: randomUUID(),
      deviceId: device.id,
      name,
      params,
    };
    return new Promise<DeviceCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(command.id);
        resolve({
          commandId: command.id,
          deviceId: device.id,
          ok: false,
          message: `${device.name} did not answer within ${Math.round(this.commandTimeoutMs / 1000)}s (device ${device.online ? "was online" : "appears offline"}).`,
        });
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.pendingCommands.set(command.id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      for (const transport of this.transports) {
        try {
          transport.command(command);
        } catch {
          // One broken transport must not stop the others.
        }
      }
    });
  }

  // ── Model-facing tool surface ──────────────────────────────────────────────

  /** `list_devices`: every mesh device with presence, battery, last-known
   *  position, and capabilities — the model's full view of the mesh. */
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
    if (!target) return this.noSuchDevice(query);
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

  /** `ring_device`: make the device sound/vibrate so it can be found. */
  ringDevice(query?: unknown, message?: unknown): Promise<MeshToolResult> {
    return this.commandTool(query, "ring", {
      ...(typeof message === "string" && message.trim()
        ? { message: message.trim().slice(0, 200) }
        : {}),
    });
  }

  /**
   * `get_device_history`: the device's movement + battery over a window,
   * computed from the fixes the daemon has been receiving all along —
   * timeline, distance traveled, and battery trend.
   */
  async deviceHistory(
    query?: unknown,
    hours?: unknown,
  ): Promise<MeshToolResult> {
    await this.load();
    const target = this.chooseDevice(query);
    if (!target) return this.noSuchDevice(query);
    const windowHours = clampHours(hours);
    const sinceTs = Date.now() - windowHours * 3_600_000;
    const fixes = this.registry.getHistory(target.id, sinceTs);
    if (fixes.length === 0) {
      return {
        ok: true,
        text: `No location reports from ${target.name} in the last ${windowHours}h. Enable periodic reporting in the companion app for a movement history.`,
      };
    }
    return { ok: true, text: this.historySummary(target, fixes, windowHours) };
  }

  /** `get_device_status`: live telemetry straight from the device. */
  getDeviceStatus(query?: unknown): Promise<MeshToolResult> {
    return this.commandTool(query, "status", {});
  }

  /**
   * Shared command-tool flow: resolve the target, check its advertised
   * capabilities, require a transport, send, and render the device's answer.
   */
  private async commandTool(
    query: unknown,
    name: string,
    params: Record<string, unknown>,
  ): Promise<MeshToolResult> {
    await this.load();
    const target = this.chooseDevice(query);
    if (!target) return this.noSuchDevice(query);
    // Devices advertise what they can do; an explicit list that lacks the
    // command is a clean "can't" — absent list means an older app build, so
    // attempt it and let the timeout speak.
    if (target.capabilities && !target.capabilities.includes(name)) {
      return {
        ok: false,
        text: `${target.name} does not support "${name}" (supports: ${target.capabilities.join(", ")}).`,
      };
    }
    if (this.transports.size === 0) {
      return {
        ok: false,
        text: `No companion transport is connected, so "${name}" cannot reach ${target.name}.`,
      };
    }
    const result = await this.sendCommand(target, name, params);
    return {
      ok: result.ok,
      text: this.commandSummary(target, name, result),
    };
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

  private noSuchDevice(query: unknown): MeshToolResult {
    const known = this.registry.list().devices;
    return {
      ok: false,
      text:
        typeof query === "string" && query.trim() && known.length > 0
          ? `No mesh device matches "${query.trim()}". Known devices:\n${known.map((d) => this.deviceLine(d)).join("\n")}`
          : "No mesh devices are registered.",
    };
  }

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
    if (device.capabilities?.length) {
      parts.push(`can: ${device.capabilities.join(", ")}`);
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

  private commandSummary(
    device: DeviceInfo,
    name: string,
    result: DeviceCommandResult,
  ): string {
    if (!result.ok) {
      return result.message ?? `${device.name} rejected "${name}".`;
    }
    const detail = result.message ? ` ${result.message}` : "";
    switch (name) {
      case "ring":
        return `${device.name} is ringing.${detail}`;
      case "status": {
        const fields = Object.entries(result.data ?? {})
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${String(v)}`);
        return fields.length
          ? `${device.name} status — ${fields.join(" · ")}`
          : `${device.name} answered but reported no status fields.${detail}`;
      }
      default:
        return (
          result.message ??
          (result.data
            ? `${device.name} answered: ${JSON.stringify(result.data)}`
            : `${device.name} completed "${name}".`)
        );
    }
  }

  /** Render a window of fixes: headline (count, span, distance, battery
   *  trend) plus a bounded, evenly-sampled timeline oldest-first. */
  private historySummary(
    device: DeviceInfo,
    fixes: DeviceLocation[],
    windowHours: number,
  ): string {
    let distanceM = 0;
    for (let i = 1; i < fixes.length; i++) {
      distanceM += haversineM(fixes[i - 1], fixes[i]);
    }
    const batteries = fixes
      .map((f) => f.batteryPct)
      .filter((b): b is number => typeof b === "number");
    const headline = [
      `${device.name}: ${fixes.length} fix${fixes.length === 1 ? "" : "es"} in the last ${windowHours}h`,
      `moved ~${formatDistance(distanceM)}`,
      ...(batteries.length >= 2
        ? [`battery ${batteries[0]}% → ${batteries[batteries.length - 1]}%`]
        : []),
    ].join(" · ");
    const lines = sampleEvenly(fixes, MAX_HISTORY_LINES).map((f) => {
      const parts = [
        `${formatWhen(f.ts)} — ${f.lat.toFixed(5)},${f.lon.toFixed(5)}`,
      ];
      if (typeof f.accuracyM === "number")
        parts.push(`±${Math.round(f.accuracyM)}m`);
      if (typeof f.batteryPct === "number") parts.push(`${f.batteryPct}%`);
      return `- ${parts.join(" · ")}`;
    });
    const omitted = fixes.length - Math.min(fixes.length, MAX_HISTORY_LINES);
    return [
      headline,
      ...lines,
      ...(omitted > 0
        ? [`(${omitted} more fixes omitted; timeline sampled evenly)`]
        : []),
    ].join("\n");
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

/** Clamp the requested history window to 1..168 hours (default 24). */
function clampHours(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_HOURS;
  return Math.min(168, Math.max(1, Math.round(n)));
}

/** Great-circle distance between two fixes in meters. */
function haversineM(a: DeviceLocation, b: DeviceLocation): number {
  const R = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(meters: number): string {
  if (meters < 1_000) return `${Math.round(meters)}m`;
  return `${(meters / 1_000).toFixed(1)}km`;
}

/** Local wall-clock stamp for history lines (date + HH:MM). */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Up to `max` items spread evenly across the list, endpoints included. */
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  }
  return out;
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
