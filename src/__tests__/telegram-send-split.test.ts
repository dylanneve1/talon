/**
 * sendText auto-split — over-4096 sends become sequential messages
 * instead of a thrown "Message too long" that burned a model round-trip.
 */

import { describe, it, expect, vi } from "vitest";
import type { Bot } from "grammy";
import { sendText } from "../frontend/telegram/actions/index.js";
import { TELEGRAM_MAX_TEXT } from "../frontend/telegram/actions/types.js";

type SentCall = {
  chatId: number;
  text: string;
  opts?: {
    parse_mode?: string;
    reply_parameters?: { message_id: number };
  };
};

function fakeBot(sent: SentCall[]): Bot {
  let nextId = 100;
  return {
    api: {
      sendMessage: vi.fn(
        async (chatId: number, text: string, opts?: SentCall["opts"]) => {
          sent.push({ chatId, text, opts });
          return { message_id: nextId++ };
        },
      ),
    },
  } as unknown as Bot;
}

describe("sendText auto-split", () => {
  it("sends short text as a single message with reply threading", async () => {
    const sent: SentCall[] = [];
    const id = await sendText(fakeBot(sent), 42, "hello **there**", 7);
    expect(id).toBe(100);
    expect(sent).toHaveLength(1);
    expect(sent[0].opts?.reply_parameters).toEqual({ message_id: 7 });
  });

  it("splits an over-limit message into sequential chunks", async () => {
    const sent: SentCall[] = [];
    const paragraph = `${"lorem ipsum dolor sit amet ".repeat(20)}\n\n`;
    const text = paragraph.repeat(20); // ~11k chars
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_TEXT);

    const id = await sendText(fakeBot(sent), 42, text, 7);

    expect(sent.length).toBeGreaterThan(1);
    // Every rendered chunk fits the hard cap.
    for (const call of sent) {
      expect(call.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    }
    // Reply threading only on the first chunk; id returned is the anchor's.
    expect(sent[0].opts?.reply_parameters).toEqual({ message_id: 7 });
    for (const call of sent.slice(1)) {
      expect(call.opts?.reply_parameters).toBeUndefined();
    }
    expect(id).toBe(100);
    // Nothing lost: the chunks re-assemble to the original content.
    const joined = sent.map((c) => c.text).join("\n");
    expect(joined.replace(/\s+/g, " ").trim()).toContain(
      "lorem ipsum dolor sit amet",
    );
  });

  it("never strands an open code fence at a chunk boundary", async () => {
    const sent: SentCall[] = [];
    const code = `\`\`\`\n${"const x = 1;\n".repeat(400)}\`\`\`\n`;
    const text = `intro\n\n${code}${"tail paragraph. ".repeat(300)}`;
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_TEXT);

    await sendText(fakeBot(sent), 42, text);

    expect(sent.length).toBeGreaterThan(1);
    for (const call of sent) {
      // HTML conversion of a balanced-fence chunk yields balanced <pre> tags.
      const opens = (call.text.match(/<pre>/g) ?? []).length;
      const closes = (call.text.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});
