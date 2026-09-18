/**
 * Input state — everything the keypress, paste and render modules share,
 * lifted out of the `createInput` closure.
 */

import { PromptHistory } from "./history.js";
import { partsText, type InputPart } from "./parts.js";

export type InputState = {
  readonly promptStr: string;
  lineCallback: ((text: string) => void) | null;
  pendingResolve: ((value: string) => void) | null;
  paused: boolean;
  /** Input is an ordered list of parts. */
  parts: InputPart[];
  readonly history: PromptHistory;
  /** Bracketed paste accumulation. */
  inPaste: boolean;
  pasteAccum: string;
  /** How many visual rows the last render occupied. */
  prevRows: number;
};

export function createInputState(promptStr: string): InputState {
  return {
    promptStr,
    lineCallback: null,
    pendingResolve: null,
    paused: false,
    parts: [{ type: "text", content: "" }],
    history: new PromptHistory(),
    inPaste: false,
    pasteAccum: "",
    prevRows: 1,
  };
}

export function fullText(state: InputState): string {
  return partsText(state.parts);
}

export function clearInput(state: InputState): void {
  state.parts = [{ type: "text", content: "" }];
  state.history.resetNavigation();
}

export function submitInput(state: InputState): void {
  const text = fullText(state);
  if (!state.pendingResolve) state.history.add(state.parts);
  clearInput(state);
  process.stdout.write("\n");

  if (state.pendingResolve) {
    const resolve = state.pendingResolve;
    state.pendingResolve = null;
    resolve(text);
    return;
  }
  if (state.lineCallback) state.lineCallback(text);
}
