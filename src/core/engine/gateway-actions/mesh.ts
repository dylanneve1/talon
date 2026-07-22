/**
 * Device mesh — read tools (list_devices, get_device_location,
 * get_device_history) and command tools (ring, live status).
 *
 * Shared actions, so the model has full mesh access from every frontend
 * (Telegram, Discord, Teams, terminal, native) — not just chats running
 * through the native bridge. The mesh itself is daemon-wide state
 * (core/mesh); the native bridge is merely the transport companions
 * register through and commands travel over.
 */

import { getMeshService } from "../../mesh/index.js";
import type { SharedActionHandlers } from "./types.js";

export const meshHandlers: SharedActionHandlers = {
  list_devices: () => getMeshService().describeDevices(),
  get_device_location: (body) => getMeshService().locateDevice(body.device),
  get_device_history: (body) =>
    getMeshService().deviceHistory(body.device, body.hours),
  ring_device: (body) => getMeshService().ringDevice(body.device, body.message),
  // Registry hygiene: drop a stale/superseded device entry. Requires an
  // explicit target — a destructive action must never default-pick a device.
  remove_device: (body) => getMeshService().removeDevice(body.device),
  get_device_status: (body) => getMeshService().getDeviceStatus(body.device),
  // Exec + filesystem surface — the substrate teleport routes through.
  device_exec: (body) =>
    getMeshService().execOnDevice(
      body.device,
      body.cmd,
      body.cwd,
      body.timeout_sec,
    ),
  device_list_dir: (body) =>
    getMeshService().listDirOnDevice(body.device, body.path),
  device_stat: (body) => getMeshService().statOnDevice(body.device, body.path),
  device_read_file: (body) =>
    getMeshService().readFileFromDevice(body.device, body.path),
  device_write_file: (body) =>
    getMeshService().writeFileToDevice(body.device, body.path, body.content),
  device_pull_file: (body) =>
    getMeshService().pullFileFromDevice(
      body.device,
      body.remote_path,
      body.local_path,
    ),
  device_push_file: (body) =>
    getMeshService().pushFileToDevice(
      body.device,
      body.local_path,
      body.remote_path,
    ),
  // Remote self-update: push a new APK and silently (re)install it, keeping
  // the mesh connection across the app restart.
  update_device: (body) =>
    getMeshService().updateDeviceApp(
      body.device,
      body.apk_path,
      body.remote_path,
    ),
  // Remote self-update for a headless talon-node: push a new binary and have
  // the node verify, swap, and restart into it. binary_path is optional —
  // omitted, the daemon resolves the right build for the node's
  // platform/arch itself (source build or verified release download).
  update_node: (body) =>
    getMeshService().updateNodeBinary(
      body.device,
      body.binary_path,
      body.remote_path,
    ),
  // Node provisioning: materialize a talon-node binary for any arch, and
  // mint single-use bridge-served install links for fresh hosts.
  get_node_binary: (body) => getMeshService().getNodeBinary(body.os, body.arch),
  make_node_install_link: (body) =>
    getMeshService().makeNodeInstallLink(
      body.os,
      body.arch,
      body.name,
      body.bridge_url,
    ),
};
