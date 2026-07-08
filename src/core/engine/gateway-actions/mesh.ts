/**
 * Device mesh — `list_devices` and `get_device_location`.
 *
 * Shared actions, so the model has full mesh access from every frontend
 * (Telegram, Discord, Teams, terminal, native) — not just chats running
 * through the native bridge. The mesh itself is daemon-wide state
 * (core/mesh); the native bridge is merely the transport companions
 * register through.
 */

import { getMeshService } from "../../mesh/index.js";
import type { SharedActionHandlers } from "./types.js";

export const meshHandlers: SharedActionHandlers = {
  list_devices: () => getMeshService().describeDevices(),
  get_device_location: (body) => getMeshService().locateDevice(body.device),
};
