#!/usr/bin/env node
/**
 * Codex backend heartbeat smoke test.
 *
 * Standalone verification that the Codex backend's `runOneShotAgent`
 * (the path heartbeat + dream go through) successfully executes a
 * turn against the real `codex` CLI on the host's current credential.
 *
 * Runs:
 *   1. `initCodexAgent` against a minimal in-memory config.
 *   2. `runOneShotAgent` with a tiny prompt + the OAuth-aware default
 *      model.
 *   3. Reports the captured log lines.
 *
 * Doesn't touch ~/.talon/, doesn't talk to Telegram, doesn't run for
 * the full heartbeat duration. Pure backend exercise.
 *
 * Usage:
 *   node scripts/codex-heartbeat-smoke.mjs
 *   MODEL=gpt-5.5 node scripts/codex-heartbeat-smoke.mjs
 *   MODEL=gpt-5-codex node scripts/codex-heartbeat-smoke.mjs   # exercises swap path
 *
 * Exit code 0 on a successful turn (agent_message present); 1 on any
 * uncaught error from the runner.
 */

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const model = process.env.MODEL ?? "gpt-5.5";
const prompt =
  process.env.PROMPT ??
  "Reply with just one word: 'pong'. Don't use any tools.";

console.log(`[smoke] model=${model}`);
console.log(`[smoke] prompt=${JSON.stringify(prompt)}`);

const tmpWorkspace = mkdtempSync(join(tmpdir(), "talon-codex-smoke-"));

// Dynamic imports so we can override env BEFORE init reads it.
const { initCodexAgent } = await import("../src/backend/codex/init.ts");
const { runOneShotAgent } = await import("../src/backend/codex/one-shot.ts");

const config = {
  model,
  workspace: tmpWorkspace,
  systemPrompt: "You are a heartbeat smoke test. Answer briefly.",
  frontend: "terminal",
};

initCodexAgent(config, () => 19876, "terminal");

const lines = [];
const appendLog = async (text) => {
  lines.push(text);
  process.stdout.write(text);
};

const abortController = new AbortController();

try {
  const t0 = Date.now();
  await runOneShotAgent({
    prompt,
    systemPrompt: "You are a heartbeat smoke test. Answer briefly.",
    workspace: tmpWorkspace,
    model,
    contextLabel: "heartbeat",
    abortController,
    appendLog,
  });
  const elapsed = Date.now() - t0;

  const log = lines.join("");
  const hasAssistant = log.includes("Assistant\n");
  const hasError = log.includes("Error\n") || log.includes("FAILED\n");
  const hasSwap = log.includes("Model swap");

  console.log("");
  console.log(`[smoke] elapsed=${elapsed}ms`);
  console.log(`[smoke] hasAssistant=${hasAssistant}`);
  console.log(`[smoke] hasError=${hasError}`);
  console.log(`[smoke] hasSwap=${hasSwap}`);
  console.log(`[smoke] result=${hasAssistant && !hasError ? "PASS" : "FAIL"}`);
  process.exit(hasAssistant && !hasError ? 0 : 1);
} catch (err) {
  console.error("");
  console.error(`[smoke] uncaught error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
