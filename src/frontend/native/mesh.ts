import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import {
  toDeviceInfo,
  toDeviceLocation,
  type DeviceInfo,
  type DeviceLocation,
  type DevicePlatform,
} from "./protocol.js";

const PRESENCE_TIMEOUT_MS = 90_000;
const DEVICE_FILE = resolve(dirs.root, "mesh-devices.json");
const LOCATION_FILE = resolve(dirs.root, "mesh-locations.json");
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

  constructor(
    private readonly files = {
      devices: DEVICE_FILE,
      locations: LOCATION_FILE,
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
  }

  async register(body: Record<string, unknown>, now = Date.now()): Promise<DeviceInfo> {
    const next = sanitizeDevice(body, now, true);
    if (!next) throw new Error("Invalid device registration");
    const prev = this.devices.get(next.id);
    const device = toDeviceInfo({
      ...prev,
      ...next,
      online: true,
      lastSeen: now,
    }, now);
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
      this.devices.set(loc.deviceId, toDeviceInfo({
        ...device,
        online: true,
        lastSeen: now,
        ...(typeof loc.batteryPct === "number" ? { battery: loc.batteryPct } : {}),
      }, now));
      await this.persistDevices();
    }
    await this.persistLocations();
    return loc;
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
  if ((requireCore || platform !== undefined) && (!platform || !PLATFORMS.has(platform))) {
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
  };
}

function sanitizeLocation(body: Record<string, unknown>): DeviceLocation | null {
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
    ...(stringField(body.provider) ? { provider: stringField(body.provider) } : {}),
    ...(numberField(body.batteryPct) !== undefined
      ? { batteryPct: numberField(body.batteryPct) }
      : {}),
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
