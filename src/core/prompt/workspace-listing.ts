/**
 * Workspace file listing for the system prompt's dynamic tail.
 *
 * Renders a compact tree of `~/.talon/workspace/` so the model knows
 * what artifacts exist. Volatile by nature (file sizes change as logs
 * grow), so it always belongs to the DYNAMIC prompt part — never the
 * cacheable static prefix.
 *
 * Any directory with more than `COLLAPSE_THRESHOLD` rendered entries
 * collapses to a single `name/ (N files)` summary line, so per-file
 * sizes inside such a directory are never needed. The tree is built
 * lazily: `statSync` is deferred to render time and only ever called
 * for files that actually appear in the output. The eager
 * implementation stat'd every file during the walk — on a workspace
 * with tens of thousands of files (logs, build artifacts, media) that
 * meant one blocking syscall per file on every session start, just to
 * print a handful of summary lines.
 */

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const COLLAPSE_THRESHOLD = 8;

// A node contributes `count` rendered lines to its parent (used to
// decide the collapse) and renders those lines lazily via `render()`.
type Node = { count: number; render: () => string[] };

function buildNode(dir: string, prefix: string): Node {
  const children: Node[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (
        e.name.startsWith(".") ||
        e.name === "node_modules" ||
        e.name === "talon.log"
      )
        continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        const sub = buildNode(full, `${prefix}${e.name}/`);
        if (sub.count === 0) continue; // empty dir → omitted
        if (sub.count <= COLLAPSE_THRESHOLD) {
          children.push(sub); // expand inline
        } else {
          // Collapse to one summary line — never render (or stat) the
          // files inside.
          const line = `${prefix}${e.name}/ (${sub.count} files)`;
          children.push({ count: 1, render: () => [line] });
        }
      } else {
        children.push({
          count: 1,
          render: () => {
            let sz = 0;
            try {
              sz = statSync(full).size;
            } catch {
              /* file vanished between readdir and stat — show 0B */
            }
            return [
              `${prefix}${e.name} (${sz < 1024 ? sz + "B" : (sz / 1024).toFixed(0) + "KB"})`,
            ];
          },
        });
      }
    }
  } catch {
    /* unreadable dir → treat as empty */
  }
  const count = children.reduce((n, c) => n + c.count, 0);
  return { count, render: () => children.flatMap((c) => c.render()) };
}

/**
 * Render the `## Current Workspace Contents` section, or an empty
 * string when the workspace is missing or empty.
 */
export function renderWorkspaceListing(workspaceDir: string): string {
  try {
    const files = buildNode(workspaceDir, "").render();
    if (files.length === 0) return "";
    return (
      "## Current Workspace Contents\n\n" +
      files.map((f) => `  ${f}`).join("\n")
    );
  } catch {
    /* no workspace yet */
    return "";
  }
}
