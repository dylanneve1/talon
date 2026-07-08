import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Device-mesh tools. Deliberately NOT frontend-restricted: the mesh is
 * daemon-wide state served by shared gateway actions, so the model can see
 * and locate companion devices from any chat surface.
 */
export const meshTools: ToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List all Talon companion mesh devices with id, platform, online presence, last-seen age, battery state, and last-known location.",
    schema: {},
    execute: (_params, bridge) => bridge("list_devices", {}),
    tag: "mesh",
  },
  {
    name: "get_device_location",
    description:
      "Get any Talon companion device's current or last-known location. Sends an on-demand locate request first, waits briefly for a fresh GPS fix, then falls back to last-known. With no device, uses the most recently seen mobile device.",
    schema: {
      device: z
        .string()
        .optional()
        .describe(
          "Device id or part of the device name (see list_devices). Defaults to the most recently seen mobile mesh device.",
        ),
    },
    execute: (params, bridge) => bridge("get_device_location", params),
    tag: "mesh",
  },
];
