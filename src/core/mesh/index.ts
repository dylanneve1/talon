/**
 * Device mesh — core module barrel.
 *
 * Registry (persistence) + service (policy, locate fan-out, tool surface) +
 * canonical device/location types. Transports and gateway actions import
 * from here.
 */

export { MeshRegistry } from "./devices/registry.js";
export {
  MeshService,
  getMeshService,
  setMeshService,
} from "./devices/service.js";
