/**
 * Cross-provider job one-shot runner.
 *
 * When a trigger or cron `query` job carries a model override whose provider
 * differs from the chat's backend, the wake-up can't ride the chat session — a
 * session id is backend-specific. So instead of resuming, we run the job as an
 * isolated one-shot agent on the target backend, exactly like heartbeat/dream:
 * its own backend instance, its own context window, no chat history.
 *
 * The isolated agent still gets the full frontend tool surface (it runs under
 * the "heartbeat" context label, which every backend wires for outbound
 * messaging), so it can act in the chat by calling the messaging tools with an
 * explicit `chat_id`. The Opus-authored `instructions` become its system prompt.
 */

import { resolve } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { dirs } from "../../util/paths.js";
import { log, logError } from "../../util/log.js";
import { acquireBackendInstance } from "../engine/backend-controller.js";
import type { OneShotAgentParams } from "../types.js";

const JOB_LOGS_DIR = resolve(dirs.logs, "jobs");

/** Default hard timeout for an isolated job run (10 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export interface JobOneShotParams {
  /** Chat the job belongs to (used for delivery via the messaging tools). */
  readonly chatId: string;
  /** Target backend/provider id (already validated as available). */
  readonly backendId: string;
  /** Model id to run on (already validated against the target backend). */
  readonly model: string;
  /** Opus-authored brief that becomes the agent's system prompt. */
  readonly instructions?: string;
  /** The wake/cron payload — already carries its `[System: ...]` header. */
  readonly payload: string;
  /** Short label for the log file (the trigger/cron name). */
  readonly label: string;
  /** Job kind, for the log + system prompt copy. */
  readonly kind: "trigger" | "cron";
  /** Optional override of the hard timeout. */
  readonly timeoutMs?: number;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "job";
}

function buildJobSystemPrompt(
  chatId: string,
  kind: "trigger" | "cron",
  instructions?: string,
): string {
  const base =
    `You are Talon running an isolated ${kind} job for chat ${chatId}. ` +
    `You have NO conversation history — only the task below and your tools. ` +
    `Investigate and act using your tools. If you need to message the user, ` +
    `call the messaging tool with chat_id="${chatId}". Be concise and ` +
    `action-oriented; if there is nothing to report, do nothing.`;
  return instructions ? `${base}\n\n${instructions}` : base;
}

/**
 * Run a trigger/cron wake-up as an isolated one-shot on a different backend.
 * Acquires the target backend on demand, runs the agent under a hard timeout,
 * and always releases the backend instance afterwards.
 */
export async function runJobOneShot(params: JobOneShotParams): Promise<void> {
  const { backend, release } = await acquireBackendInstance(params.backendId);
  try {
    const background = backend.background;
    if (!background) {
      throw new Error(
        `Backend "${params.backendId}" has no background capability — ` +
          `cannot run an isolated job on it`,
      );
    }

    await mkdir(JOB_LOGS_DIR, { recursive: true }).catch(() => {});
    const logFile = resolve(
      JOB_LOGS_DIR,
      `${params.kind}-${slug(params.label)}-${Date.now()}.md`,
    );
    const appendLog = async (text: string) => {
      await appendFile(logFile, text).catch(() => {});
    };
    await appendLog(
      `# ${params.kind} job "${params.label}" — ${new Date().toISOString()}\n` +
        `**Backend:** ${params.backendId} **Model:** ${params.model}\n\n`,
    );

    const abortController = new AbortController();
    const timeoutMs = params.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try {
        abortController.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref();

    const oneShot: OneShotAgentParams = {
      prompt: params.payload,
      systemPrompt: buildJobSystemPrompt(
        params.chatId,
        params.kind,
        params.instructions,
      ),
      // "heartbeat" is the one context label every backend wires for the full
      // outbound frontend tool surface, so the isolated agent can deliver to the
      // chat. (Minor: shares the heartbeat orphan-eviction namespace.)
      contextLabel: "heartbeat",
      workspace: dirs.workspace,
      model: params.model,
      abortController,
      appendLog,
    };

    try {
      await background.runOneShotAgent(oneShot);
      log(
        params.kind === "cron" ? "cron" : "triggers",
        `isolated job "${params.label}" ran on ${params.backendId}/${params.model}`,
      );
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logError(
      params.kind === "cron" ? "cron" : "triggers",
      `isolated job "${params.label}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    await release();
  }
}
