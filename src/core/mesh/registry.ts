/**
 * MeshRegistry — persistent storage for companion devices, last-known
 * locations, and a bounded per-device location/battery history.
 *
 * Pure state: validate, upsert, persist (0600 JSON sidecars under the Talon
 * root). No transport and no waiting logic — that policy lives in
 * MeshService, so the registry stays trivially testable.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import {
  sanitizeCapabilities,
  toDeviceInfo,
  toDeviceLocation,
  type DeviceInfo,
  type DeviceLocation,
  type DevicePlatform,
} from "./types.js";

const PRESENCE_TIMEOUT_MS = 90_000;
const DEVICE_FILE = resolve(dirs.root, "mesh-devices.json");
const LOCATION_FILE = resolve(dirs.root, "mesh-locations.json");
const HISTORY_FILE = resolve(dirs.root, "mesh-history.json");
/** Newest fixes kept per device (~a day of 5-minute periodic reports). */
const MAX_HISTORY_PER_DEVICE = 500;
const PLATFORMS = new Set<DevicePlatform>([
  "android",
  "macos",
  "windows",
  "linux",
  "ios",
]);

export class MeshRegistry {
  private devices = new Map<string, DeviceInfo>();
  private locations = new Map<string, DeviceLocation>();
  private history = new Map<string, DeviceLocation[]>();

  constructor(
    private readonly files = {
      devices: DEVICE_FILE,
      locations: LOCATION_FILE,
      history: HISTORY_FILE,
    },
  ) {}

  async load(): Promise<void> {
    this.devices = new Map(
      (await readArray<DeviceInfo>(this.files.devices))
        .map((d) => sanitizeDevice(d, d.lastSeen, false))
        .filter((d): d is DeviceInfo => d !== null)
        .map((d) => [d.id, d]),
    );
    this.locations = new Map(
      (await readArray<DeviceLocation>(this.files.locations))
        .map(sanitizeLocation)
        .filter((l): l is DeviceLocation => l !== null)
        .map((l) => [l.deviceId, l]),
    );
    this.history = new Map();
    for (const fix of (await readArray<DeviceLocation>(this.files.history))
      .map(sanitizeLocation)
      .filter((l): l is DeviceLocation => l !== null)) {
      this.appendHistory(fix);
    }
  }

  async register(
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<DeviceInfo> {
    const next = sanitizeDevice(body, now, true);
    if (!next) throw new Error("Invalid device registration");
    const prev = this.devices.get(next.id);
    const device = toDeviceInfo(
      {
        ...prev,
        ...next,
        online: true,
        lastSeen: now,
      },
      now,
    );
    this.devices.set(device.id, device);
    await this.persistDevices();
    return device;
  }

  async storeLocation(
    body: Record<string, unknown>,
    now = Date.now(),
  ): Promise<DeviceLocation> {
    const loc = sanitizeLocation(body);
    if (!loc) throw new Error("Invalid device location");
    this.locations.set(loc.deviceId, loc);
    const device = this.devices.get(loc.deviceId);
    if (device) {
      this.devices.set(
        loc.deviceId,
        toDeviceInfo(
          {
            ...device,
            online: true,
            lastSeen: now,
            ...(typeof loc.batteryPct === "number"
              ? { battery: loc.batteryPct }
              : {}),
          },
          now,
        ),
      );
      await this.persistDevices();
    }
    this.appendHistory(loc);
    await this.persistLocations();
    await this.persistHistory();
    return loc;
  }

  /** Fixes for one device since `sinceTs`, oldest first. */
  getHistory(deviceId: string, sinceTs = 0): DeviceLocation[] {
    return (this.history.get(deviceId) ?? [])
      .filter((l) => l.ts >= sinceTs)
      .map(toDeviceLocation);
  }

  /** Append one fix to the device's rolling history (dedup on timestamp,
   *  chronological order, bounded to MAX_HISTORY_PER_DEVICE). */
  private appendHistory(fix: DeviceLocation): void {
    const list = this.history.get(fix.deviceId) ?? [];
    if (list.some((l) => l.ts === fix.ts)) return;
    list.push(toDeviceLocation(fix));
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > MAX_HISTORY_PER_DEVICE) {
      list.splice(0, list.length - MAX_HISTORY_PER_DEVICE);
    }
    this.history.set(fix.deviceId, list);
  }

  list(now = Date.now()): {
    devices: DeviceInfo[];
    locations: DeviceLocation[];
  } {
    return {
      devices: [...this.devices.values()]
        .map((d) => toDeviceInfo(d, now, PRESENCE_TIMEOUT_MS))
        .sort((a, b) => b.lastSeen - a.lastSeen),
      locations: [...this.locations.values()]
        .map(toDeviceLocation)
        .sort((a, b) => b.ts - a.ts),
    };
  }

  getLocation(deviceId: string): DeviceLocation | undefined {
    const loc = this.locations.get(deviceId);
    return loc ? toDeviceLocation(loc) : undefined;
  }

  private async persistDevices(): Promise<void> {
    await writePrivateJson(this.files.devices, [...this.devices.values()]);
  }

  private async persistLocations(): Promise<void> {
    await writePrivateJson(this.files.locations, [...this.locations.values()]);
  }

  private async persistHistory(): Promise<void> {
    await writePrivateJson(
      this.files.history,
      [...this.history.values()].flat(),
    );
  }
}

async function readArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sanitizeDevice(
  body: Record<string, unknown>,
  now: number,
  requireCore: boolean,
): DeviceInfo | null {
  const id = stringField(body.id);
  const name = stringField(body.name);
  const appVersion = stringField(body.appVersion);
  const platform = stringField(body.platform) as DevicePlatform | undefined;
  if ((requireCore || id !== undefined) && !id) return null;
  if ((requireCore || name !== undefined) && !name) return null;
  if ((requireCore || appVersion !== undefined) && !appVersion) return null;
  if (
    (requireCore || platform !== undefined) &&
    (!platform || !PLATFORMS.has(platform))
  ) {
    return null;
  }
  return {
    id: id ?? "",
    name: name ?? "",
    platform: platform ?? "linux",
    appVersion: appVersion ?? "",
    online: body.online === true,
    lastSeen: numberField(body.lastSeen) ?? now,
    ...(numberField(body.battery) !== undefined
      ? { battery: numberField(body.battery) }
      : {}),
    ...(typeof body.charging === "boolean" ? { charging: body.charging } : {}),
    ...(sanitizeCapabilities(body.capabilities)
      ? { capabilities: sanitizeCapabilities(body.capabilities) }
      : {}),
  };
}

function sanitizeLocation(
  body: Record<string, unknown>,
): DeviceLocation | null {
  const deviceId = stringField(body.deviceId);
  const lat = numberField(body.lat);
  const lon = numberField(body.lon);
  const ts = numberField(body.ts);
  if (!deviceId || !Number.isFinite(lat) || !Number.isFinite(lon) || !ts) {
    return null;
  }
  if (lat! < -90 || lat! > 90 || lon! < -180 || lon! > 180) return null;
  return toDeviceLocation({
    deviceId,
    lat: lat!,
    lon: lon!,
    ...(numberField(body.accuracyM) !== undefined
      ? { accuracyM: numberField(body.accuracyM) }
      : {}),
    ...(numberField(body.altitudeM) !== undefined
      ? { altitudeM: numberField(body.altitudeM) }
      : {}),
    ...(numberField(body.speedMps) !== undefined
      ? { speedMps: numberField(body.speedMps) }
      : {}),
    ...(numberField(body.headingDeg) !== undefined
      ? { headingDeg: numberField(body.headingDeg) }
      : {}),
    ts,
    ...(stringField(body.provider)
      ? { provider: stringField(body.provider) }
      : {}),
    ...(numberField(body.batteryPct) !== undefined
      ? { batteryPct: numberField(body.batteryPct) }
      : {}),
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
