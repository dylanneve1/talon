/**
 * Terminal response stream — stops the spinner and prints a committed
 * assistant message. No partial-text preview (the terminal renderer doesn't
 * support in-place line rerenders for arbitrary-length blocks).
 */

import type { ResponseStream } from "../../core/types.js";
import type { createRenderer } from "./renderer.js";

type Renderer = ReturnType<typeof createRenderer>;

export function createTerminalStream(renderer: Renderer): ResponseStream {
  let pending = "";
  let done = false;

  return {
    update(text: string) {
      if (done) return;
      pending = text;
    },
    async commit(text?: string) {
      if (done) return;
      const source = text ?? pending;
      pending = "";
      const trimmed = source.trimEnd();
      if (!trimmed) return;
      renderer.stopSpinner();
      renderer.renderAssistantMessage(trimmed);
    },
    async discard() {
      if (done) return;
      done = true;
      pending = "";
      renderer.stopSpinner();
    },
    hasPending() {
      return !done && pending.trimEnd().length > 0;
    },
  };
}
