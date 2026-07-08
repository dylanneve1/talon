import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const meshTools: ToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List Talon companion mesh devices with platform, online presence, last-seen age, and battery state.",
    schema: {},
    execute: (_params, bridge) => bridge("list_devices", {}),
    frontends: ["native"],
    tag: "mesh",
  },
  {
    name: "get_device_location",
    description:
      "Get a Talon companion device's current or last-known location. Sends an on-demand locate request first, waits briefly for a fresh GPS fix, then falls back to last-known. With no device, uses the most recently seen mobile device.",
    schema: {
      device: z
        .string()
        .optional()
        .describe("Device id or part of the device name. Defaults to a mobile mesh device."),
    },
    execute: (params, bridge) => bridge("get_device_location", params),
    frontends: ["native"],
    tag: "mesh",
  },
];
