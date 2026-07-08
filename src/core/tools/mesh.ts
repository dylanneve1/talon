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
    name: "open_device_url",
    description:
      "Open an http(s) URL on a Talon companion device (in its default browser). Useful for handing a page, doc, or map to another device.",
    schema: {
      url: z.string().describe("The http:// or https:// URL to open."),
      device: deviceParam,
    },
    execute: (params, bridge) => bridge("open_device_url", params),
    tag: "mesh",
  },
  {
    name: "set_device_clipboard",
    description:
      "Place text on a Talon companion device's clipboard — hand a snippet, code, or link to another device for pasting.",
    schema: {
      text: z.string().describe("The text to put on the device's clipboard."),
      device: deviceParam,
    },
    execute: (params, bridge) => bridge("set_device_clipboard", params),
    tag: "mesh",
  },
  {
    name: "get_device_clipboard",
    description:
      "Read the current clipboard text from a Talon companion device (may be empty if the platform restricts background clipboard access).",
    schema: { device: deviceParam },
    execute: (params, bridge) => bridge("get_device_clipboard", params),
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
