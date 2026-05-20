/**
 * Antigravity one-shot agent runner — used by heartbeat & dream.
 *
 * Spawns a fresh per-context bridge (via ensureBridge with the
 * sentinel chat id like "heartbeat" / "dream"), runs one chat turn,
 * shuts the bridge down at the end.
 *
 * Heartbeats / dream runs aren't meant to share a long-lived agent
 * with chat — each one is its own conversation. So one-shot uses
 * its own per-run bridge spawn that gets torn down on completion.
 */

import { randomUUID } from "node:crypto";
import type { OneShotAgentParams } from "../../core/types.js";
import { logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../shared/index.js";
import { ANTIGRAVITY_SYSTEM_PROMPT_SUFFIX } from "./constants.js";
import { ensureBridge } from "./init.js";
import { getState } from "./state.js";

export async function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<void> {
  const {
    prompt,
    systemPrompt,
    model: _model,
    contextLabel,
    abortController,
    appendLog,
  } = params;

  const finalSystemPrompt = appendBackendSuffix(
    systemPrompt,
    ANTIGRAVITY_SYSTEM_PROMPT_SUFFIX,
  );

  // Antigravity doesn't expose system_instructions on a per-call
  // basis from the SDK we use — Talon's `LocalAgentConfig` set it
  // once at agent build. For one-shot we prepend it to the prompt,
  // mirroring Codex's approach.
  const inputText = `${finalSystemPrompt}\n\n---\n\n${prompt}`;

  let bridge;
  try {
    bridge = await ensureBridge(contextLabel);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ts = new Date().toISOString().slice(11, 19);
    await appendLog(`\n### [${ts}] Bridge start failed\n${msg}\n`);
    return;
  }

  const turnId = `oneshot-${randomUUID()}`;
  const ts = new Date().toISOString().slice(11, 19);
  await appendLog(`\n### [${ts}] One-shot turn started (${contextLabel})\n`);

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    bridge?.abort(turnId);
  };
  abortController.signal.addEventListener("abort", onAbort);

  try {
    const result = await bridge.chat({
      id: turnId,
      prompt: inputText,
      onText: (delta) => {
        // Append text deltas inline so the run log streams as the
        // model thinks. Heartbeat's appendLog is the public surface
        // for these events.
        if (delta) void appendLog(delta);
      },
      onThought: (delta) => {
        if (delta) void appendLog(`\n_thought:_ ${delta}`);
      },
      onToolCall: (name, args) => {
        const summary = `\n\n[tool ${name}] ${JSON.stringify(args).slice(0, 200)}\n`;
        void appendLog(summary);
      },
    });

    const ts2 = new Date().toISOString().slice(11, 19);
    if (aborted) {
      await appendLog(`\n### [${ts2}] Aborted\nRun aborted by timeout.\n`);
      return;
    }
    if (result.usage) {
      const u = result.usage;
      await appendLog(
        `\n### [${ts2}] Turn complete (tokens: prompt=${u.prompt_token_count ?? "?"}, total=${u.total_token_count ?? "?"})\n`,
      );
    } else {
      await appendLog(`\n### [${ts2}] Turn complete\n`);
    }
  } catch (e) {
    if (aborted || /abort/i.test(e instanceof Error ? e.message : String(e))) {
      const ts2 = new Date().toISOString().slice(11, 19);
      await appendLog(`\n### [${ts2}] Aborted\nRun aborted by timeout.\n`);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    const ts2 = new Date().toISOString().slice(11, 19);
    await appendLog(`\n### [${ts2}] Turn failed\n${msg}\n`);
    logWarn("agent", `Antigravity one-shot turn failed: ${msg}`);
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
    // For one-shot we don't want a long-lived bridge — tear down so
    // the next heartbeat starts with a fresh agent.
    const state = getState();
    const stillCached = state.bridges.get(contextLabel);
    if (stillCached === bridge) {
      state.bridges.delete(contextLabel);
    }
    void bridge.shutdown();
  }
}
