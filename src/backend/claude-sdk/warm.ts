/**
 * Session warm-up — cold-start optimization.
 *
 * Spawns a throwaway SDK subprocess in streaming input mode, calls
 * getContextUsage() to populate contextWindow and baseline contextTokens,
 * then tears it down. Fire-and-forget — does not block the caller.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getSession } from "../../storage/sessions.js";
import { rebuildSystemPrompt } from "../../util/config.js";
import { getPluginPromptAdditions } from "../../core/plugin.js";
import { log, logWarn } from "../../util/log.js";
import { getConfig } from "./state.js";
import { buildSdkOptions } from "./options.js";

export async function warmSession(chatId: string): Promise<void> {
  // Guard against being called before initAgent()
  try {
    getConfig();
  } catch {
    return;
  }

  const abort = new AbortController();
  try {
    rebuildSystemPrompt(getConfig(), getPluginPromptAdditions());
    const { options } = buildSdkOptions(chatId);

    // Streaming input mode: pass an async iterable that never yields a user message
    const neverYield = async function* (): AsyncGenerator<never> {
      await new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    };

    const q = query({
      prompt: neverYield(),
      options: { ...options, abortController: abort },
    });

    // Drain the stream in the background so the SDK's internal message loop
    // doesn't stall — control responses are processed in readMessages() which
    // needs the inputStream consumer to not back-pressure.
    const drainPromise = (async () => {
      try {
        for await (const _ of q) {
          // discard SDK messages; we only care about the control response
        }
      } catch {
        // expected: abort causes the stream to end with an error
      }
    })();

    // Race getContextUsage against a timeout so /reset doesn't hang
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("warm-up timed out")), 15_000),
    );
    const ctx = await Promise.race([q.getContextUsage(), timeout]);
    const session = getSession(chatId);
    if (ctx.maxTokens > 0) session.usage.contextWindow = ctx.maxTokens;
    if (ctx.totalTokens > 0) session.usage.contextTokens = ctx.totalTokens;
    log(
      "agent",
      `[${chatId}] warm-up: context ${ctx.totalTokens}/${ctx.maxTokens} (${ctx.percentage.toFixed(1)}%) model=${ctx.model}`,
    );

    abort.abort();
    await drainPromise;
  } catch (err) {
    abort.abort();
    // Non-fatal — /status will just show 0 until first real message
    logWarn(
      "agent",
      `[${chatId}] warm-up failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
