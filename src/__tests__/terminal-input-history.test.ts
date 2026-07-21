import { describe, expect, it } from "vitest";
import { PromptHistory, type InputPart } from "../frontend/terminal/input.js";

const text = (content: string): InputPart[] => [{ type: "text", content }];

describe("PromptHistory", () => {
  it("walks backward and forward, then restores the unfinished draft", () => {
    const history = new PromptHistory();
    history.add(text("first"));
    history.add(text("second"));

    expect(history.move("previous", text("draft"))).toEqual(text("second"));
    expect(history.move("previous", text("second"))).toEqual(text("first"));
    expect(history.move("next", text("first"))).toEqual(text("second"));
    expect(history.move("next", text("second"))).toEqual(text("draft"));
  });

  it("keeps collapsed paste content intact and returns defensive copies", () => {
    const history = new PromptHistory();
    const prompt: InputPart[] = [
      { type: "text", content: "Review" },
      { type: "paste", content: "line one\nline two\nline three" },
    ];
    history.add(prompt);

    const recalled = history.move("previous", text(""))!;
    expect(recalled).toEqual(prompt);
    recalled[1]!.content = "changed";

    expect(history.move("previous", recalled)).toEqual(prompt);
  });

  it("deduplicates adjacent entries and enforces its size limit", () => {
    const history = new PromptHistory(2);
    history.add(text("one"));
    history.add(text("one"));
    history.add(text("two"));
    history.add(text("three"));

    expect(history.move("previous", text(""))).toEqual(text("three"));
    expect(history.move("previous", text("three"))).toEqual(text("two"));
    expect(history.move("previous", text("two"))).toEqual(text("two"));
  });

  it("preserves edits to a recalled prompt as the draft", () => {
    const history = new PromptHistory();
    history.add(text("saved"));

    const edited = text("saved with edit");
    history.move("previous", text("original draft"));
    history.detach(edited);

    expect(history.move("previous", edited)).toEqual(text("saved"));
    expect(history.move("next", text("saved"))).toEqual(edited);
  });
});
