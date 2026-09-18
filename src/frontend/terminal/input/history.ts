import { cloneParts, partsText, type InputPart } from "./parts.js";

const MAX_HISTORY_ITEMS = 100;

/**
 * In-process prompt history. Keeping this out of the persistent stores avoids
 * creating a second plaintext transcript while still giving terminal users
 * the expected Up/Down workflow.
 */
export class PromptHistory {
  private readonly entries: InputPart[][] = [];
  private cursor = 0;
  private draft: InputPart[] | null = null;

  constructor(private readonly maxItems = MAX_HISTORY_ITEMS) {}

  add(parts: readonly InputPart[]): void {
    const text = partsText(parts);
    if (!text) return;

    const latest = this.entries.at(-1);
    if (!latest || partsText(latest) !== text) {
      this.entries.push(cloneParts(parts));
      if (this.entries.length > this.maxItems) this.entries.shift();
    }
    this.resetNavigation();
  }

  move(
    direction: "previous" | "next",
    current: readonly InputPart[],
  ): InputPart[] | undefined {
    if (this.entries.length === 0) return undefined;

    if (direction === "previous") {
      if (this.cursor === this.entries.length) {
        this.draft = cloneParts(current);
      }
      if (this.cursor > 0) this.cursor--;
      return cloneParts(this.entries[this.cursor]!);
    }

    if (this.cursor === this.entries.length) return undefined;
    if (this.cursor < this.entries.length - 1) {
      this.cursor++;
      return cloneParts(this.entries[this.cursor]!);
    }

    this.cursor = this.entries.length;
    return cloneParts(this.draft ?? [{ type: "text", content: "" }]);
  }

  /** Preserve an edited recalled prompt as the current draft. */
  detach(parts: readonly InputPart[]): void {
    if (this.cursor === this.entries.length) return;
    this.cursor = this.entries.length;
    this.draft = cloneParts(parts);
  }

  resetNavigation(): void {
    this.cursor = this.entries.length;
    this.draft = null;
  }
}
