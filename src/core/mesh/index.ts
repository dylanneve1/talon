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
  type LocateDispatcher,
  type MeshServiceOptions,
  type MeshToolResult,
} from "./service.js";
export {
  toDeviceInfo,
  toDeviceLocation,
  type DeviceInfo,
  type DeviceLocation,
  type DevicePlatform,
} from "./types.js";
