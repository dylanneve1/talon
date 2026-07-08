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
  get_device_status: (body) => getMeshService().getDeviceStatus(body.device),
};
