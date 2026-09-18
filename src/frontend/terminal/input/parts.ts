/**
 * Input parts — the ordered list of typed text segments and collapsed paste
 * blocks that makes up the current line.
 */

export type InputPart =
  { type: "text"; content: string } | { type: "paste"; content: string };
type TextPart = Extract<InputPart, { type: "text" }>;
export type PastePart = Extract<InputPart, { type: "paste" }>;

export function cloneParts(parts: readonly InputPart[]): InputPart[] {
  return parts.map((part) => ({ ...part }));
}

export function partsText(parts: readonly InputPart[]): string {
  return parts
    .map((part) => part.content)
    .join("\n")
    .trim();
}

export function lastPart(parts: InputPart[]): InputPart {
  return parts[parts.length - 1]!;
}

/** Ensure the last part is a text part (for typing into). */
export function ensureTrailingText(parts: InputPart[]): TextPart {
  const last = lastPart(parts);
  if (last.type === "text") return last;
  const t: TextPart = { type: "text", content: "" };
  parts.push(t);
  return t;
}
