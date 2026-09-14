/**
 * Tool-result summarisation — the bounded, readable string the app shows in
 * its expanded tool view (and the turn-meta sidecar persists).
 */

/** Best-effort JSON stringify that never throws (circular refs → String()). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Reduce a tool's raw result to a readable, bounded string for the app's
 * expanded tool view. MCP results are typically
 * `{ content: [{ type: "text", text }] }`, so pull the text parts out; fall
 * back to pretty JSON for anything else. Truncated so a huge file read or
 * search dump can't bloat the wire payload or the history sidecar.
 */
export function summarizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .map((c) =>
          c &&
          typeof c === "object" &&
          typeof (c as { text?: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
        )
        .filter((s) => s.length > 0);
      text = parts.length > 0 ? parts.join("\n") : safeJson(result);
    } else {
      text = safeJson(result);
    }
  }
  text = text.trim();
  if (!text) return undefined;
  const MAX = 4000;
  return text.length > MAX ? `${text.slice(0, MAX)}\n… (truncated)` : text;
}
