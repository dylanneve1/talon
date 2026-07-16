/**
 * VFS tools — the unified `talon://` namespace.
 *
 * One browsable tree over everything the daemon owns: real stores (the
 * workspace, skills, scripts, logs) and live synthetic state (`proc/` for
 * the task table and event bus, `plugins/` for the registry) answer the
 * same three tools. The synthetic mounts are the point — this is the only
 * way to read live daemon state as plain files.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const NAMESPACE = `Namespace roots: home/ (workspace), skills/, scripts/, logs/, proc/ (live task table under proc/tasks/<id> and the event ring at proc/events), plugins/ (registry view). List "" to see the root and where each mount lives on disk. Absolute OS paths inside a mounted directory are accepted and translated.`;

export const vfsTools: ToolDefinition[] = [
  {
    name: "vfs_list",
    description: `List a directory in the talon:// namespace — the unified view over Talon's own state. ${NAMESPACE} Entries show kind (d/-), writability, size, and name.`,
    schema: {
      path: z
        .string()
        .describe(
          'Namespace path, e.g. "" (root), "proc/tasks", "skills/review-pr". Forward slashes on every platform; "talon://" prefix optional.',
        ),
    },
    execute: (params, bridge) => bridge("vfs_list", params),
    tag: "vfs",
  },

  {
    name: "vfs_read",
    description: `Read a file from the talon:// namespace (UTF-8 text, 256KB cap). ${NAMESPACE} Reading proc/tasks/<id> returns that task as JSON; proc/events returns the event ring as JSON Lines.`,
    schema: {
      path: z
        .string()
        .describe(
          'Namespace file path, e.g. "proc/events" or "logs/2026-07-16.md"',
        ),
    },
    execute: (params, bridge) => bridge("vfs_read", params),
    tag: "vfs",
  },

  {
    name: "vfs_write",
    description: `Write a UTF-8 file into a writable part of the talon:// namespace (home/, skills/, scripts/). Parent directories are created; synthetic mounts (proc/, plugins/) and logs/ are read-only views.`,
    schema: {
      path: z
        .string()
        .describe(
          'Namespace file path under a writable mount, e.g. "home/notes/ideas.md"',
        ),
      content: z
        .string()
        .describe("Full file content (replaces any existing content)"),
    },
    execute: (params, bridge) => bridge("vfs_write", params),
    tag: "vfs",
  },
];
