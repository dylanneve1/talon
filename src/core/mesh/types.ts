/**
 * Device-mesh domain types + normalizers.
 *
 * The canonical shapes for companion devices and their reported locations.
 * They live in core (not a frontend) because the mesh is daemon-wide state:
 * devices register through the native bridge transport, but the model reads
 * them from ANY frontend via the shared `list_devices` /
 * `get_device_location` gateway actions. The bridge protocol re-exports
 * these types so the wire contract is unchanged.
 */

export type DevicePlatform =
  | "android"
  | "macos"
  | "windows"
  | "linux"
  | "ios";

export type DeviceInfo = {
  id: string;
  name: string;
  platform: DevicePlatform;
  appVersion: string;
  online: boolean;
  /** Epoch milliseconds. */
  lastSeen: number;
  /** Battery percent, 0-100. */
  battery?: number;
  charging?: boolean;
};

export type DeviceLocation = {
  deviceId: string;
  lat: number;
  lon: number;
  accuracyM?: number;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  /** Epoch milliseconds. */
  ts: number;
  provider?: string;
  batteryPct?: number;
};

export function toDeviceInfo(
  value: DeviceInfo,
  now = Date.now(),
  offlineAfterMs = 90_000,
): DeviceInfo {
  const battery =
    typeof value.battery === "number"
      ? Math.max(0, Math.min(100, Math.round(value.battery)))
      : undefined;
  return {
    id: value.id,
    name: value.name,
    platform: value.platform,
    appVersion: value.appVersion,
    online: now - value.lastSeen <= offlineAfterMs && value.online,
    lastSeen: value.lastSeen,
    ...(battery !== undefined ? { battery } : {}),
    ...(typeof value.charging === "boolean" ? { charging: value.charging } : {}),
  };
}

export function toDeviceLocation(value: DeviceLocation): DeviceLocation {
  return {
    deviceId: value.deviceId,
    lat: value.lat,
    lon: value.lon,
    ...(typeof value.accuracyM === "number"
      ? { accuracyM: value.accuracyM }
      : {}),
    ...(typeof value.altitudeM === "number" ? { altitudeM: value.altitudeM } : {}),
    ...(typeof value.speedMps === "number" ? { speedMps: value.speedMps } : {}),
    ...(typeof value.headingDeg === "number"
      ? { headingDeg: value.headingDeg }
      : {}),
    ts: value.ts,
    ...(value.provider ? { provider: value.provider } : {}),
    ...(typeof value.batteryPct === "number"
      ? { batteryPct: Math.max(0, Math.min(100, Math.round(value.batteryPct))) }
      : {}),
  };
}
