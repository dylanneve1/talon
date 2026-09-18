/**
 * Terminal input — the key dispatch table and the paste gate.
 *
 * Pins what the `createInput` keypress closure carried implicitly: each
 * control code reaches its handler, a stray control byte is dropped, a
 * printable byte is typed, escape sequences consume their tail, and a paste
 * chunk never reaches the key dispatcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  KEY_HANDLERS,
  handleKeyChunk,
} from "../frontend/terminal/input/keys.js";
import { consumePasteChunk } from "../frontend/terminal/input/paste.js";
import {
  createInputState,
  fullText,
  type InputState,
} from "../frontend/terminal/input/state.js";

let state: InputState;
let stdoutWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state = createInputState("  ❯ ");
  stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
});

afterEach(() => {
  stdoutWrite.mockRestore();
});

describe("KEY_HANDLERS", () => {
  it("is a null-prototype table with exactly the eight control codes", () => {
    expect(Object.getPrototypeOf(KEY_HANDLERS)).toBeNull();
    expect(
      Object.keys(KEY_HANDLERS)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([0x03, 0x08, 0x09, 0x0a, 0x0d, 0x15, 0x1b, 0x7f]);
  });

  it("CR and LF share Enter; DEL and BS share Backspace", () => {
    expect(KEY_HANDLERS[0x0d]).toBe(KEY_HANDLERS[0x0a]);
    expect(KEY_HANDLERS[0x7f]).toBe(KEY_HANDLERS[0x08]);
  });

  it("does not route Object.prototype names", () => {
    expect((KEY_HANDLERS as Record<string, unknown>)["constructor"]).toBe(
      undefined,
    );
  });
});

describe("handleKeyChunk", () => {
  it("types printable bytes and drops unlisted control bytes", () => {
    handleKeyChunk(state, "a\x01b\x02c");
    expect(state.parts).toEqual([{ type: "text", content: "abc" }]);
  });

  it("Tab inserts two spaces", () => {
    handleKeyChunk(state, "x\ty");
    expect(fullText(state)).toBe("x  y");
  });

  it("Backspace removes the last char, then a whole paste block", () => {
    handleKeyChunk(state, "ab");
    handleKeyChunk(state, "\x7f");
    expect(fullText(state)).toBe("a");
    state.parts.push({ type: "paste", content: "1\n2\n3" });
    handleKeyChunk(state, "\x08");
    expect(state.parts).toEqual([{ type: "text", content: "a" }]);
  });

  it("Ctrl+U clears the line", () => {
    handleKeyChunk(state, "hello\x15");
    expect(state.parts).toEqual([{ type: "text", content: "" }]);
  });

  it("Enter submits to onLine and clears; empty Enter just redraws", () => {
    const onLine = vi.fn();
    state.lineCallback = onLine;
    handleKeyChunk(state, "\r");
    expect(onLine).not.toHaveBeenCalled();
    handleKeyChunk(state, "hi\n");
    expect(onLine).toHaveBeenCalledWith("hi");
    expect(fullText(state)).toBe("");
  });

  it("Enter resolves a pending waitForInput instead of onLine", () => {
    const onLine = vi.fn();
    const resolve = vi.fn();
    state.lineCallback = onLine;
    state.pendingResolve = resolve;
    handleKeyChunk(state, "3\r");
    expect(resolve).toHaveBeenCalledWith("3");
    expect(state.pendingResolve).toBeNull();
    expect(onLine).not.toHaveBeenCalled();
  });

  it("CSI and ESC-O arrows walk history and consume their tail", () => {
    state.lineCallback = () => {};
    handleKeyChunk(state, "first\r");
    handleKeyChunk(state, "second\r");
    handleKeyChunk(state, "\x1b[A");
    expect(fullText(state)).toBe("second");
    handleKeyChunk(state, "\x1bOA");
    expect(fullText(state)).toBe("first");
    handleKeyChunk(state, "\x1b[Bz");
    expect(fullText(state)).toBe("secondz");
  });

  it("bare Escape cancels a pending waitForInput with an empty answer", () => {
    const resolve = vi.fn();
    state.pendingResolve = resolve;
    handleKeyChunk(state, "12\x1b");
    expect(resolve).toHaveBeenCalledWith("");
    expect(state.pendingResolve).toBeNull();
    expect(fullText(state)).toBe("");
  });

  it("Ctrl+C turns bracketed paste off and exits", () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    handleKeyChunk(state, "\x03");
    expect(stdoutWrite).toHaveBeenCalledWith("\n\x1b[?2004l");
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
});

describe("consumePasteChunk", () => {
  it("passes ordinary chunks through", () => {
    expect(consumePasteChunk(state, "abc")).toBe(false);
    expect(state.inPaste).toBe(false);
  });

  it("inlines a short paste and collapses a long one", () => {
    expect(consumePasteChunk(state, "\x1b[200~a\nb\x1b[201~")).toBe(true);
    expect(state.parts).toEqual([{ type: "text", content: "a b" }]);
    expect(consumePasteChunk(state, "\x1b[200~1\n2\n3\x1b[201~")).toBe(true);
    expect(state.parts.at(-1)).toEqual({ type: "paste", content: "1\n2\n3" });
  });

  it("accumulates a paste split across chunks", () => {
    expect(consumePasteChunk(state, "\x1b[200~one\n")).toBe(true);
    expect(state.inPaste).toBe(true);
    expect(consumePasteChunk(state, "two\n")).toBe(true);
    expect(consumePasteChunk(state, "three\x1b[201~")).toBe(true);
    expect(state.inPaste).toBe(false);
    expect(state.pasteAccum).toBe("");
    expect(state.parts.at(-1)).toEqual({
      type: "paste",
      content: "one\ntwo\nthree",
    });
  });
});
