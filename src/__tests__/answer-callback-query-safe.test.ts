/**
 * Unit tests for `answerCallbackQuerySafe` — the wrapper that swallows
 * Telegram's "query is too old / query ID is invalid" GrammyError when
 * a callback handler's pre-answer work blows past the ~15s callback
 * validity window. Other failures still surface as warnings; success
 * paths return silently.
 *
 * Regression motivation: an unhandled GrammyError was crashing into the
 * top-level bot.catch when /model selection had to resolve an upstream
 * model list against a slow backend — the answerCallbackQuery() call at
 * callbacks.ts:524 fired after Telegram had already invalidated the
 * query, throwing an unhandled error. See talon.log entry from
 * 2026-05-24 (pid 743933, callbacks.ts:524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "grammy";
import { answerCallbackQuerySafe } from "../frontend/telegram/callbacks/index.js";
import * as logModule from "../util/log.js";

function makeCtx(answerImpl: (other?: unknown) => Promise<void>): {
  ctx: Context;
  calls: Array<unknown>;
} {
  const calls: Array<unknown> = [];
  const answerCallbackQuery = vi.fn(async (other?: unknown) => {
    calls.push(other);
    return answerImpl(other);
  });
  const ctx = { answerCallbackQuery } as unknown as Context;
  return { ctx, calls };
}

describe("answerCallbackQuerySafe", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logModule, "logWarn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("forwards the no-arg form to ctx.answerCallbackQuery()", async () => {
    const { ctx, calls } = makeCtx(async () => {});
    await answerCallbackQuerySafe(ctx);
    expect(calls).toEqual([undefined]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("forwards the toast-text form unchanged", async () => {
    const { ctx, calls } = makeCtx(async () => {});
    await answerCallbackQuerySafe(ctx, { text: "Backend: codex" });
    expect(calls).toEqual([{ text: "Backend: codex" }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("swallows 'query is too old' GrammyError without throwing", async () => {
    const err = new Error(
      "Call to 'answerCallbackQuery' failed! (400: Bad Request: query is too old and response timeout expired or query ID is invalid)",
    );
    const { ctx } = makeCtx(async () => {
      throw err;
    });
    await expect(answerCallbackQuerySafe(ctx)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatch(/callback expired/i);
  });

  it("swallows 'query ID is invalid' GrammyError without throwing", async () => {
    const err = new Error("query ID is invalid");
    const { ctx } = makeCtx(async () => {
      throw err;
    });
    await expect(
      answerCallbackQuerySafe(ctx, { text: "x" }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatch(/callback expired/i);
  });

  it("swallows 'response timeout expired' GrammyError without throwing", async () => {
    const err = new Error("response timeout expired");
    const { ctx } = makeCtx(async () => {
      throw err;
    });
    await expect(answerCallbackQuerySafe(ctx)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatch(/callback expired/i);
  });

  it("logs other failures as a generic warning instead of crashing", async () => {
    const err = new Error("Network unreachable");
    const { ctx } = makeCtx(async () => {
      throw err;
    });
    await expect(answerCallbackQuerySafe(ctx)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/answerCallbackQuery failed/i);
    expect(msg).not.toMatch(/callback expired/i);
  });

  it("handles non-Error throwables by stringifying them", async () => {
    const { ctx } = makeCtx(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string thrown";
    });
    await expect(answerCallbackQuerySafe(ctx)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[1] as string;
    expect(msg).toContain("string thrown");
  });
});
