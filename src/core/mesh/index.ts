/**
 * Device mesh — core module barrel.
 *
 * Registry (persistence) + service (policy, locate fan-out, tool surface) +
 * canonical device/location types. Transports and gateway actions import
 * from here.
 */

export { MeshRegistry } from "./registry.js";
export {
  MeshService,
  getMeshService,
  setMeshService,
  type MeshTransport,
  type MeshServiceOptions,
  type MeshToolResult,
} from "./service.js";
export {
  sanitizeCapabilities,
  toDeviceInfo,
  toDeviceLocation,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceInfo,
  type DeviceLocation,
  type DevicePlatform,
} from "./types.js";
