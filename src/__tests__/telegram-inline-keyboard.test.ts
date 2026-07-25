/**
 * Inline-keyboard construction — Telegram's callback_data byte cap.
 *
 * `callback_data` is limited to 64 BYTES, not characters. Exceeding it
 * fails the entire sendMessage with BUTTON_DATA_INVALID, so the message
 * never arrives at all. Every button path in the Telegram frontend
 * (send_message_with_buttons, which backs both `end_turn(buttons=)` and
 * `send(buttons=)`, plus schedule_message and its deferred fire) routes
 * through `buildInlineKeyboard`.
 */

import { describe, it, expect } from "vitest";
import { buildInlineKeyboard } from "../frontend/telegram/actions/messaging.js";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Narrow the result union, failing loudly when the wrong branch came back. */
function keyboardOf(
  result: ReturnType<typeof buildInlineKeyboard>,
): Array<Array<Record<string, string>>> {
  if ("error" in result) {
    throw new Error(`expected a keyboard, got error: ${result.error}`);
  }
  return result.keyboard as Array<Array<Record<string, string>>>;
}

describe("buildInlineKeyboard", () => {
  it("passes short callback_data through untouched", () => {
    const kb = keyboardOf(
      buildInlineKeyboard([[{ text: "Option A", callback_data: "opt_a" }]]),
    );
    expect(kb[0][0]).toEqual({ text: "Option A", callback_data: "opt_a" });
  });

  it("falls back to the button text when callback_data is omitted", () => {
    const kb = keyboardOf(buildInlineKeyboard([[{ text: "Yes" }]]));
    expect(kb[0][0]).toEqual({ text: "Yes", callback_data: "Yes" });
  });

  it("keeps url buttons as-is (no callback_data involved)", () => {
    const kb = keyboardOf(
      buildInlineKeyboard([
        [
          {
            text: "Docs",
            url: "https://example.com/a/very/long/path/".repeat(5),
          },
        ],
      ]),
    );
    expect(kb[0][0].callback_data).toBeUndefined();
    expect(kb[0][0].url).toContain("https://example.com");
  });

  // The text fallback carries no contract with the model, so trimming it to
  // fit is safe — and far better than failing the send.
  it("truncates an over-long text fallback to 64 bytes", () => {
    const label =
      "Yes, I would like to proceed with option A and also enable notifications";
    expect(bytes(label)).toBeGreaterThan(64);

    const kb = keyboardOf(buildInlineKeyboard([[{ text: label }]]));
    expect(bytes(kb[0][0].callback_data!)).toBeLessThanOrEqual(64);
    // The visible label is untouched — only the hidden payload shrinks.
    expect(kb[0][0].text).toBe(label);
  });

  // Bytes, not characters: a 33-character Japanese label is 99 bytes, so
  // non-Latin keyboards hit this cap at roughly a third the length.
  it("truncates on a code-point boundary for multi-byte labels", () => {
    const label =
      "はい、本番環境へのデプロイを実行してください。よろしくお願いします";
    expect(bytes(label)).toBeGreaterThan(64);

    const kb = keyboardOf(buildInlineKeyboard([[{ text: label }]]));
    const data = kb[0][0].callback_data!;
    expect(bytes(data)).toBeLessThanOrEqual(64);
    // A split surrogate/continuation byte would round-trip as U+FFFD.
    expect(data).not.toContain("�");
    expect(label.startsWith(data)).toBe(true);
  });

  it("truncates emoji labels without splitting a code point", () => {
    const label = "🎉".repeat(40); // 4 bytes each
    const kb = keyboardOf(buildInlineKeyboard([[{ text: label }]]));
    const data = kb[0][0].callback_data!;
    expect(bytes(data)).toBeLessThanOrEqual(64);
    expect(data).not.toContain("�");
    expect([...data].every((c) => c === "🎉")).toBe(true);
  });

  // Explicit callback_data is what the model dispatches on. Silently
  // truncating it would hand the callback handler a different string than
  // the model is matching against, so this is reported instead.
  it("reports rather than truncates an over-long explicit callback_data", () => {
    const result = buildInlineKeyboard([
      [{ text: "Go", callback_data: "x".repeat(65) }],
    ]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("65 bytes");
      expect(result.error).toContain("64");
    }
  });

  it("accepts explicit callback_data of exactly 64 bytes", () => {
    const data = "x".repeat(64);
    const kb = keyboardOf(
      buildInlineKeyboard([[{ text: "Go", callback_data: data }]]),
    );
    expect(kb[0][0].callback_data).toBe(data);
  });

  it("counts explicit callback_data in bytes, not characters", () => {
    // 30 code points, 90 bytes — under a char limit, over the byte limit.
    const result = buildInlineKeyboard([
      [{ text: "Go", callback_data: "あ".repeat(30) }],
    ]);
    expect("error" in result).toBe(true);
  });

  it("reports the first bad button across multiple rows", () => {
    const result = buildInlineKeyboard([
      [{ text: "ok", callback_data: "fine" }],
      [
        { text: "Bad One", callback_data: "y".repeat(100) },
        { text: "also bad", callback_data: "z".repeat(100) },
      ],
    ]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("Bad One");
  });

  it("handles an empty keyboard and empty rows", () => {
    expect(keyboardOf(buildInlineKeyboard([]))).toEqual([]);
    expect(keyboardOf(buildInlineKeyboard([[]]))).toEqual([[]]);
  });
});
