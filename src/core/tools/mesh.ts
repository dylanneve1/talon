import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Device-mesh tools. Deliberately NOT frontend-restricted: the mesh is
 * daemon-wide state served by shared gateway actions, so the model can see,
 * locate, and command companion devices from any chat surface.
 */

/** Shared device-target parameter: id or name fragment; default = mobile. */
const deviceParam = z
  .string()
  .optional()
  .describe(
    "Device id or part of the device name (see list_devices). Defaults to the most recently seen mobile mesh device.",
  );

export const meshTools: ToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List all Talon companion mesh devices with id, platform, online presence, last-seen age, battery state, last-known location, and supported commands.",
    schema: {},
    execute: (_params, bridge) => bridge("list_devices", {}),
    tag: "mesh",
  },
  {
    name: "get_device_location",
    description:
      "Get any Talon companion device's current or last-known location. Sends an on-demand locate request first, waits briefly for a fresh GPS fix, then falls back to last-known. With no device, uses the most recently seen mobile device.",
    schema: { device: deviceParam },
    execute: (params, bridge) => bridge("get_device_location", params),
    tag: "mesh",
  },
  {
    name: "get_device_history",
    description:
      "Movement and battery history for a Talon companion device: a timeline of its reported locations over a window (default 24h, max 168h), with distance traveled and battery trend. Answers questions like where a device was earlier or how fast its battery is draining.",
    schema: {
      device: deviceParam,
      hours: z
        .number()
        .optional()
        .describe("History window in hours (1-168, default 24)."),
    },
    execute: (params, bridge) => bridge("get_device_history", params),
    tag: "mesh",
  },
  {
    name: "ring_device",
    description:
      "Make a Talon companion device ring/vibrate so it can be found (find-my-phone). Optionally include a short message the device may display.",
    schema: {
      device: deviceParam,
      message: z
        .string()
        .optional()
        .describe("Optional short note to show on the device."),
    },
    execute: (params, bridge) => bridge("ring_device", params),
    tag: "mesh",
  },
  {
    name: "get_device_status",
    description:
      "Get live status straight from a Talon companion device: battery and charging state, platform/OS details, app version, and mesh sharing settings.",
    schema: { device: deviceParam },
    execute: (params, bridge) => bridge("get_device_status", params),
    tag: "mesh",
  },
];
