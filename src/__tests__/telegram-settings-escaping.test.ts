/**
 * `/model <query>` error-reply escaping.
 *
 * Regression: the reply built from `backend.models.formatModelError()`
 * was sent with `parse_mode: "HTML"` without escaping, while the
 * fallback on the very next line escaped. Every backend implements
 * formatModelError as plain text that interpolates the raw query, so
 * any `<` in a failed lookup reached Telegram as a tag and the whole
 * send failed with:
 *
 *   400: Bad Request: can't parse entities: Unsupported start tag "name"
 *
 * That is reachable by copying the hint OpenCode and Kilo print in the
 * model menu — "Hint: use /model <name> to switch." — so the documented
 * recovery path was itself the trigger, and the command looked inert.
 *
 * Same bug class as the model menu's status lines; this covers the
 * other sink.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot } from "grammy";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: vi.fn(() => ({ effort: undefined })),
  setChatModelForBackend: vi.fn(),
  setChatBackend: vi.fn(),
  setChatEffort: vi.fn(),
  setChatPulseInterval: vi.fn(),
}));
vi.mock("../core/background/pulse.js", () => ({
  registerChat: vi.fn(),
  disablePulse: vi.fn(),
  enablePulse: vi.fn(),
  isPulseEnabled: vi.fn(() => false),
}));
vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendIdForChat: vi.fn(() => "opencode"),
}));
vi.mock("../core/models/active-model.js", () => ({
  resolveActiveModelForChat: vi.fn(async () => ({ model: "glm-5" })),
}));

const resolveModelInfo = vi.hoisted(() => vi.fn());
const formatModelError = vi.hoisted(() => vi.fn());

vi.mock("../frontend/telegram/model-menu.js", () => ({
  resolveBackendForChat: vi.fn(() => ({
    models: { resolveModelInfo, formatModelError },
  })),
  buildModelMenuViewForChat: vi.fn(async () => null),
}));

import { registerSettingsCommands } from "../frontend/telegram/commands/settings.js";

/** Collect the handlers `registerSettingsCommands` installs. */
function captureCommands(): Map<string, (ctx: unknown) => Promise<void>> {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const bot = {
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers.set(name, handler);
    },
  } as unknown as Bot;
  registerSettingsCommands(bot, {
    config: {},
    gateway: {},
  } as never);
  return handlers;
}

/** Minimal grammy ctx double that records the outgoing reply. */
function makeCtx(arg: string) {
  const replies: Array<{ text: string; opts?: { parse_mode?: string } }> = [];
  return {
    ctx: {
      chat: { id: -100123 },
      match: arg,
      reply: async (text: string, opts?: { parse_mode?: string }) => {
        replies.push({ text, opts });
      },
    },
    replies,
  };
}

beforeEach(() => {
  resolveModelInfo.mockReset();
  formatModelError.mockReset();
});

describe("/model error replies are HTML-safe", () => {
  it("escapes a backend model error containing angle brackets", async () => {
    resolveModelInfo.mockResolvedValue({ kind: "missing" });
    // Verbatim shape of the OpenCode/Kilo hint a user would copy.
    formatModelError.mockReturnValue(
      'No OpenCode model matched "<name>". Hint: use /model <name> to switch.',
    );

    const handlers = captureCommands();
    const { ctx, replies } = makeCtx("<name>");
    await handlers.get("model")!(ctx);

    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(reply!.opts?.parse_mode).toBe("HTML");
    // No raw tag may survive into an HTML-parsed send.
    expect(reply!.text).not.toContain("<name>");
    expect(reply!.text).toContain("&lt;name&gt;");
  });

  it("escapes the built-in fallback when the backend supplies no formatter", async () => {
    resolveModelInfo.mockResolvedValue({ kind: "missing" });
    formatModelError.mockReturnValue(undefined);

    const handlers = captureCommands();
    const { ctx, replies } = makeCtx("<name>");
    await handlers.get("model")!(ctx);

    expect(replies[0]!.text).not.toContain("<name>");
    expect(replies[0]!.text).toContain("&lt;name&gt;");
  });

  it("leaves an ordinary query readable", async () => {
    resolveModelInfo.mockResolvedValue({ kind: "missing" });
    formatModelError.mockReturnValue('No model matched "gpt-9".');

    const handlers = captureCommands();
    const { ctx, replies } = makeCtx("gpt-9");
    await handlers.get("model")!(ctx);

    // Quotes round-trip as `&quot;`, which Telegram renders back as `"`.
    // The model id itself must survive untouched.
    expect(replies[0]!.text).toContain("gpt-9");
    expect(replies[0]!.text).toBe("No model matched &quot;gpt-9&quot;.");
  });
});
