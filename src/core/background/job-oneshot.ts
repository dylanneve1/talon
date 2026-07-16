/**
 * Decoupled-job one-shot orchestrator.
 *
 * When a trigger or cron `query` job carries a model override whose provider
 * differs from the chat's backend, the wake-up can't ride the chat session — a
 * session id is backend-specific. So it runs as an isolated one-shot on the
 * target backend (heartbeat/dream pattern): own backend, own context window, no
 * chat history. The agent still gets the outbound frontend tools (via the job
 * context label) so it can deliver to the chat with an explicit `chat_id`.
 *
 * This module is deliberately thin: it owns acquisition + log wiring, and
 * delegates the prompt shape to {@link ./job-prompt} and the timeout/abort
 * discipline to {@link ./isolated-agent}.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import {
  acquireBackendInstance,
  isModelValidForBackend,
} from "../engine/backend-controller/index.js";
import { taskTable } from "../tasks/index.js";
import type { OneShotAgentParams } from "../types.js";
import { runIsolatedAgent } from "./isolated-agent.js";
import {
  buildJobSystemPrompt,
  jobLogPath,
  JOB_CONTEXT_LABEL,
  JOB_LOGS_DIR,
  type JobKind,
} from "./job-prompt.js";

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
  readonly kind: JobKind;
  /** Optional override of the hard timeout. */
  readonly timeoutMs?: number;
}

export type JobOneShotResult =
  { status: "ran" } | { status: "skipped"; reason: string };

/** Open a per-run log file and return an appender bound to it. */
async function openJobLog(
  kind: JobKind,
  label: string,
  backendId: string,
  model: string,
): Promise<(text: string) => Promise<void>> {
  await mkdir(JOB_LOGS_DIR, { recursive: true }).catch(() => {});
  const file = jobLogPath(kind, label);
  const appendLog = async (text: string) => {
    await appendFile(file, text).catch(() => {});
  };
  await appendLog(
    `# ${kind} job "${label}" — ${new Date().toISOString()}\n` +
      `**Backend:** ${backendId} **Model:** ${model}\n\n`,
  );
  return appendLog;
}

function skipJob(params: JobOneShotParams, reason: string): JobOneShotResult {
  logWarn(
    params.kind === "cron" ? "cron" : "triggers",
    `isolated job "${params.label}" skipped: ${reason}`,
  );
  return { status: "skipped", reason };
}

/**
 * Run a trigger/cron wake-up as an isolated one-shot on a different backend.
 * Acquires the target backend on demand and always releases it afterwards.
 */
export async function runJobOneShot(
  params: JobOneShotParams,
): Promise<JobOneShotResult> {
  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>>;
  try {
    acquired = await acquireBackendInstance(params.backendId);
  } catch (err) {
    return skipJob(
      params,
      `provider "${params.backendId}" is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { backend, release } = acquired;
  try {
    const background = backend.background;
    if (!background) {
      return skipJob(
        params,
        `provider "${params.backendId}" can't run isolated jobs (no background capability).`,
      );
    }

    let modelValid = false;
    try {
      modelValid = await isModelValidForBackend(backend, params.model);
    } catch (err) {
      return skipJob(
        params,
        `could not validate model "${params.model}" on provider "${params.backendId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!modelValid) {
      return skipJob(
        params,
        `model "${params.model}" is not selectable on provider "${params.backendId}".`,
      );
    }

    const appendLog = await openJobLog(
      params.kind,
      params.label,
      params.backendId,
      params.model,
    );

    const abortController = new AbortController();
    const task = taskTable.begin({
      kind: params.kind,
      label: params.label,
      chatId: params.chatId,
      abort: () => abortController.abort(),
    });
    task.bind({ model: params.model, backendId: params.backendId });

    const oneShot: OneShotAgentParams = {
      prompt: params.payload,
      systemPrompt: buildJobSystemPrompt(
        params.chatId,
        params.kind,
        params.instructions,
      ),
      contextLabel: JOB_CONTEXT_LABEL,
      workspace: dirs.workspace,
      model: params.model,
      abortController,
      appendLog,
    };

    try {
      await runIsolatedAgent({
        background,
        params: oneShot,
        timeoutMs: params.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        // No evictLabel: the job context label is shared with heartbeat, so a
        // sweep here could kill a concurrent heartbeat's subprocess. Bounded
        // abort-grace is enough.
      });
      task.succeed();
    } catch (err) {
      task.fail(err);
      throw err;
    }
    log(
      params.kind === "cron" ? "cron" : "triggers",
      `isolated job "${params.label}" ran on ${params.backendId}/${params.model}`,
    );
    return { status: "ran" };
  } finally {
    await release();
  }
}
