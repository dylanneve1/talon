/**
 * Runtime detection for source runs.
 *
 * Talon source runs work on two runtimes: Node (which needs the tsx
 * CLI/loader to execute `.ts` entrypoints) and Bun (which executes
 * TypeScript natively). Every place that re-invokes a TS entrypoint in
 * a child process — the daemon spawn, the restart handoff, MCP server
 * commands — branches on this instead of hardcoding the tsx recipe, so
 * `bun src/cli.ts start` yields a bun daemon with bun children while
 * node+tsx runs stay byte-identical to before.
 *
 * Bun-COMPILED binaries are a third shape detected separately (argv[1]
 * points into the embedded virtual fs) — see the existing `$bunfs`
 * checks at the spawn sites and in `util/mcp-launcher.ts`.
 */

/** True when the current process is executing under the Bun runtime. */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}
