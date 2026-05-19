/**
 * Filesystem-path normalisation for model-supplied input.
 *
 * Models routinely emit `~/.talon/workspace/...` because that's the
 * canonical path Talon documents in prompts. Node's `fs` module
 * does NOT expand `~/` — `statSync('~/foo')` fails with ENOENT.
 * Tilde expansion is a shell concern, not a libc/Node one.
 *
 * Anywhere a path crosses from agent-land (tool args, MCP payloads,
 * gateway action bodies) into a `fs.*` or send-media API call, route
 * it through `expandFsPath` first so the leading `~/` is replaced
 * with the actual home directory.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a model-supplied path to an absolute on-disk path.
 *
 *   - `~`                 → `$HOME`
 *   - `~/<rel>`           → `$HOME/<rel>`
 *   - already absolute    → returned unchanged
 *   - relative            → resolved against `process.cwd()`
 *   - empty string        → returned unchanged (caller decides what to do)
 */
export function expandFsPath(input: string): string {
  if (!input) return input;
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  if (isAbsolute(input)) return input;
  return resolve(process.cwd(), input);
}
