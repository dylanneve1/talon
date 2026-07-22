/**
 * Cron CRUD — create / list / edit / delete scheduled jobs for a chat.
 */

import {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  updateCronJob,
  deleteCronJob,
  validateCronExpression,
  generateCronId,
  describeSchedule,
  nextRunAt,
  type CronJobType,
  type CatchupPolicy,
} from "../../../storage/cron-store.js";
import { runJobNow } from "../../background/cron.js";
import { log } from "../../../util/log.js";
import type { Backend } from "../../agent-runtime/capabilities.js";
import {
  getBackendForChat,
  getBackendIdForChat,
  acquireBackendInstance,
  isModelValidForBackend,
} from "../backend-controller/index.js";
import { validateJobModelOverride } from "./shared.js";
import type { SharedActionHandlers } from "./types.js";

// ── Scheduler field parsing (shared by create/edit cron) ────────────────────

/** The scheduler ticks once a minute, so sub-minute intervals are meaningless. */
const MIN_INTERVAL_SECONDS = 60;
const CATCHUP_POLICIES = new Set<CatchupPolicy>(["skip", "once", "all"]);

/** True for a body field that was actually supplied (not absent/blank). */
function provided(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Parse an instant given as an ISO-8601 string or epoch-ms number into epoch
 * ms. Returns undefined when the field is absent or unparseable — callers
 * distinguish the two via `provided()`.
 */
function parseInstant(v: unknown): number | undefined {
  if (!provided(v)) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : undefined;
}

/**
 * Validate a cron `query` job's model + optional provider override. Cron runs
 * isolated, so unlike triggers it may target a different provider — the backend
 * just has to exist, support isolated (background) runs, and have the model as a
 * selectable id. Same backend (no provider) validates against the chat backend.
 * Returns an error string, or null when valid.
 */
async function validateCronModelOverride(
  chatId: number,
  model?: string,
  provider?: string,
): Promise<string | null> {
  const chatBackendId = getBackendIdForChat(String(chatId));
  if (!provider || provider === chatBackendId) {
    const capabilityErr = validateCronBackgroundCapability(
      chatBackendId,
      getBackendForChat(String(chatId)),
    );
    if (capabilityErr) return capabilityErr;
    if (!model) return null;
    return validateJobModelOverride(chatId, model);
  }

  let acquired: Awaited<ReturnType<typeof acquireBackendInstance>> | null =
    null;
  try {
    acquired = await acquireBackendInstance(provider);
  } catch {
    return `Unknown or unavailable provider "${provider}".`;
  }

  try {
    const capabilityErr = validateCronBackgroundCapability(
      provider,
      acquired.backend,
    );
    if (capabilityErr) return capabilityErr;
    if (!model) {
      return `A 'provider' override also requires a 'model'.`;
    }
    if (!(await isModelValidForBackend(acquired.backend, model))) {
      return `Model "${model}" is not a selectable model on provider "${provider}".`;
    }
    return null;
  } catch (err) {
    return `Could not validate provider override: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await acquired.release();
  }
}

function validateCronBackgroundCapability(
  provider: string,
  backend: Backend,
): string | null {
  if (backend.background) return null;
  return `Provider "${provider}" can't run isolated jobs (no background capability).`;
}

export const cronHandlers: SharedActionHandlers = {
  create_cron_job: async (body, chatId) => {
    const name = String(body.name ?? "Unnamed job");
    const jobType = (body.type as CronJobType) ?? "message";
    const content = String(body.content ?? "");
    const timezone = body.timezone ? String(body.timezone) : undefined;
    const model = body.model ? String(body.model) : undefined;
    const provider = body.provider ? String(body.provider) : undefined;
    const instructions = body.instructions
      ? String(body.instructions)
      : undefined;

    if (!content) return { ok: false, error: "Missing content" };
    if (content.length > 10_000)
      return { ok: false, error: "Content too long (max 10,000 chars)" };

    // Cadence: exactly one of `schedule` (cron expression) or
    // `every_seconds` (fixed interval).
    const schedule = provided(body.schedule)
      ? String(body.schedule)
      : undefined;
    const hasEvery = provided(body.every_seconds);
    if (!schedule && !hasEvery)
      return {
        ok: false,
        error:
          "Provide either 'schedule' (a cron expression) or 'every_seconds' (a fixed interval).",
      };
    if (schedule && hasEvery)
      return {
        ok: false,
        error: "Provide only one of 'schedule' or 'every_seconds', not both.",
      };

    let everyMs: number | undefined;
    if (hasEvery) {
      const everySeconds = Number(body.every_seconds);
      if (!Number.isFinite(everySeconds) || everySeconds < MIN_INTERVAL_SECONDS)
        return {
          ok: false,
          error: `'every_seconds' must be a number >= ${MIN_INTERVAL_SECONDS} (the scheduler ticks once a minute).`,
        };
      everyMs = Math.round(everySeconds * 1000);
    }

    if (schedule) {
      const validation = validateCronExpression(schedule, timezone);
      if (!validation.valid)
        return {
          ok: false,
          error: `Invalid cron expression: ${validation.error}`,
        };
    }

    // Lifecycle bounds.
    const startAt = parseInstant(body.start_at);
    if (provided(body.start_at) && startAt === undefined)
      return {
        ok: false,
        error:
          "Could not parse 'start_at' (use an ISO-8601 timestamp or epoch ms).",
      };
    const endAt = parseInstant(body.end_at);
    if (provided(body.end_at) && endAt === undefined)
      return {
        ok: false,
        error:
          "Could not parse 'end_at' (use an ISO-8601 timestamp or epoch ms).",
      };
    if (startAt !== undefined && endAt !== undefined && endAt <= startAt)
      return { ok: false, error: "'end_at' must be after 'start_at'." };
    if (endAt !== undefined && endAt <= Date.now())
      return {
        ok: false,
        error: "'end_at' is in the past — the job would never run.",
      };

    // Run cap. `once: true` is sugar for max_runs = 1 (one-shot).
    let maxRuns: number | undefined;
    if (body.once === true) maxRuns = 1;
    else if (provided(body.max_runs)) {
      const m = Number(body.max_runs);
      if (!Number.isInteger(m) || m < 1)
        return { ok: false, error: "'max_runs' must be a positive integer." };
      maxRuns = m;
    }

    // Missed-run catch-up policy. New jobs default to "once": a run that
    // came due while Talon was down (or while the scheduler was wedged)
    // replays a single time at startup instead of being lost silently — a
    // live audit found one-shot reminders that missed their date under the
    // old "skip" default and quietly rolled over a full year. Explicit
    // "skip" remains available for jobs where a late run is worthless.
    let catchup: CatchupPolicy = "once";
    if (provided(body.catchup)) {
      catchup = String(body.catchup) as CatchupPolicy;
      if (!CATCHUP_POLICIES.has(catchup))
        return {
          ok: false,
          error: "'catchup' must be one of: skip, once, all.",
        };
    }

    // The overrides only make sense for "query" jobs (a "message" job just
    // sends text — no model runs).
    if ((model || provider || instructions) && jobType !== "query")
      return {
        ok: false,
        error: "Model/provider/instructions only apply to 'query' jobs.",
      };
    if (provider && !model)
      return {
        ok: false,
        error: "A 'provider' override also requires a 'model'.",
      };

    // Validate the target backend/model up front so a bad id or unsupported
    // backend is rejected here instead of silently failing at fire time.
    if (jobType === "query") {
      const modelErr = await validateCronModelOverride(chatId, model, provider);
      if (modelErr) return { ok: false, error: modelErr };
    }

    const id = generateCronId();
    addCronJob({
      id,
      chatId: String(chatId),
      type: jobType,
      content,
      name,
      enabled: true,
      createdAt: Date.now(),
      runCount: 0,
      timezone,
      ...(schedule ? { schedule } : {}),
      ...(everyMs !== undefined ? { everyMs } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
      ...(maxRuns !== undefined ? { maxRuns } : {}),
      catchup,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(instructions ? { instructions } : {}),
    });
    log(
      "gateway",
      `create_cron_job: "${name}" [${schedule ?? `every ${everyMs}ms`}]`,
    );

    const created = getCronJob(id);
    const nextMs = created ? nextRunAt(created) : null;
    const bounds = [
      maxRuns !== undefined ? `max runs: ${maxRuns}` : null,
      startAt !== undefined
        ? `starts: ${new Date(startAt).toISOString()}`
        : null,
      endAt !== undefined ? `ends: ${new Date(endAt).toISOString()}` : null,
      catchup ? `catch-up: ${catchup}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ok: true,
      text:
        `Created cron job "${name}" (id: ${id})\n` +
        `Schedule: ${created ? describeSchedule(created) : (schedule ?? "interval")}\n` +
        `Type: ${jobType}\n` +
        `Next run: ${nextMs ? new Date(nextMs).toISOString() : "unknown"}` +
        (bounds ? `\n${bounds}` : ""),
    };
  },

  list_cron_jobs: (body, chatId) => {
    const jobs = getCronJobsForChat(String(chatId));
    if (jobs.length === 0)
      return { ok: true, text: "No cron jobs in this chat." };
    const fmt = (ms: number) =>
      new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    const lines = jobs.map((j) => {
      const status = j.enabled ? "enabled" : "disabled";
      const lastRun = j.lastRunAt ? fmt(j.lastRunAt) : "never";
      const nextMs = j.enabled ? nextRunAt(j) : null;
      const nextRun = nextMs ? fmt(nextMs) : "—";
      const outcome = j.lastStatus
        ? ` [${j.lastStatus}${
            j.lastStatus === "error" && j.lastError
              ? `: ${j.lastError.slice(0, 60)}`
              : ""
          }]`
        : "";
      const bounds: string[] = [];
      if (j.maxRuns !== undefined)
        bounds.push(`cap ${j.runCount}/${j.maxRuns}`);
      if (j.startAt !== undefined) bounds.push(`from ${fmt(j.startAt)}`);
      if (j.endAt !== undefined) bounds.push(`until ${fmt(j.endAt)}`);
      if (j.catchup && j.catchup !== "skip")
        bounds.push(`catch-up: ${j.catchup}`);
      if (j.model) bounds.push(`model: ${j.model}`);
      return [
        `- ${j.name} (${status})`,
        `  ID: ${j.id}`,
        `  Schedule: ${describeSchedule(j)}${j.timezone ? ` (${j.timezone})` : ""}`,
        `  Type: ${j.type}`,
        `  Content: ${j.content.slice(0, 100)}${j.content.length > 100 ? "..." : ""}`,
        `  Runs: ${j.runCount}${outcome} | Last: ${lastRun} | Next: ${nextRun}`,
        bounds.length ? `  Bounds: ${bounds.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });
    return {
      ok: true,
      text: `Cron jobs (${jobs.length}):\n\n${lines.join("\n\n")}`,
    };
  },

  edit_cron_job: async (body, chatId) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== String(chatId))
      return { ok: false, error: "Job belongs to a different chat" };

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = String(body.name);
    if (body.content !== undefined) updates.content = String(body.content);
    if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
    if (body.type !== undefined) updates.type = String(body.type);
    if (body.timezone !== undefined)
      updates.timezone = body.timezone ? String(body.timezone) : undefined;

    // Cadence — schedule and every_seconds are mutually exclusive; setting
    // one switches mode and clears the other.
    const editSchedule = body.schedule !== undefined;
    const editEvery = provided(body.every_seconds);
    if (editSchedule && provided(body.schedule) && editEvery)
      return {
        ok: false,
        error: "Provide only one of 'schedule' or 'every_seconds', not both.",
      };
    if (editSchedule && provided(body.schedule)) {
      const tz = (updates.timezone as string | undefined) ?? job.timezone;
      const v = validateCronExpression(String(body.schedule), tz);
      if (!v.valid)
        return { ok: false, error: `Invalid cron expression: ${v.error}` };
      updates.schedule = String(body.schedule);
      updates.everyMs = undefined;
    }
    if (editEvery) {
      const everySeconds = Number(body.every_seconds);
      if (!Number.isFinite(everySeconds) || everySeconds < MIN_INTERVAL_SECONDS)
        return {
          ok: false,
          error: `'every_seconds' must be a number >= ${MIN_INTERVAL_SECONDS}.`,
        };
      updates.everyMs = Math.round(everySeconds * 1000);
      updates.schedule = undefined;
    }

    // Lifecycle bounds (pass null/"" to clear).
    if (body.start_at !== undefined) {
      if (!provided(body.start_at)) updates.startAt = undefined;
      else {
        const s = parseInstant(body.start_at);
        if (s === undefined)
          return { ok: false, error: "Could not parse 'start_at'." };
        updates.startAt = s;
      }
    }
    if (body.end_at !== undefined) {
      if (!provided(body.end_at)) updates.endAt = undefined;
      else {
        const e = parseInstant(body.end_at);
        if (e === undefined)
          return { ok: false, error: "Could not parse 'end_at'." };
        if (e <= Date.now())
          return {
            ok: false,
            error: "'end_at' is in the past — the job would never run.",
          };
        updates.endAt = e;
      }
    }
    if (body.once === true) updates.maxRuns = 1;
    else if (body.max_runs !== undefined) {
      if (!provided(body.max_runs)) updates.maxRuns = undefined;
      else {
        const m = Number(body.max_runs);
        if (!Number.isInteger(m) || m < 1)
          return {
            ok: false,
            error: "'max_runs' must be a positive integer.",
          };
        updates.maxRuns = m;
      }
    }
    if (body.catchup !== undefined) {
      const c = String(body.catchup) as CatchupPolicy;
      if (!CATCHUP_POLICIES.has(c))
        return {
          ok: false,
          error: "'catchup' must be one of: skip, once, all.",
        };
      updates.catchup = c;
    }
    if (body.model !== undefined) {
      updates.model = provided(body.model) ? String(body.model) : undefined;
    }
    if (body.provider !== undefined) {
      updates.provider = provided(body.provider)
        ? String(body.provider)
        : undefined;
    }
    if (body.instructions !== undefined) {
      updates.instructions = provided(body.instructions)
        ? String(body.instructions)
        : undefined;
    }

    // Query execution overrides only apply to 'query' jobs — mirror create.
    // Validate the effective post-edit target so provider+model edits are
    // checked together using cron's cross-provider rules.
    const effType = (updates.type as CronJobType | undefined) ?? job.type;
    const effModel =
      "model" in updates ? (updates.model as string | undefined) : job.model;
    const effProvider =
      "provider" in updates
        ? (updates.provider as string | undefined)
        : job.provider;
    const effInstructions =
      "instructions" in updates
        ? (updates.instructions as string | undefined)
        : job.instructions;
    if (effType !== "query" && (effModel || effProvider || effInstructions))
      return {
        ok: false,
        error: "Model/provider/instructions only apply to 'query' jobs.",
      };
    if (effProvider && !effModel)
      return {
        ok: false,
        error: "A 'provider' override also requires a 'model'.",
      };
    if (
      effType === "query" &&
      ("model" in updates || "provider" in updates || "type" in updates)
    ) {
      const modelErr = await validateCronModelOverride(
        chatId,
        effModel,
        effProvider,
      );
      if (modelErr) return { ok: false, error: modelErr };
    }

    // Reject a start/end window that can never fire, accounting for the merge.
    const effStart =
      "startAt" in updates
        ? (updates.startAt as number | undefined)
        : job.startAt;
    const effEnd =
      "endAt" in updates ? (updates.endAt as number | undefined) : job.endAt;
    if (effStart !== undefined && effEnd !== undefined && effEnd <= effStart)
      return { ok: false, error: "'end_at' must be after 'start_at'." };

    // If a lowered run cap already met/exceeds runCount, retire the job now so
    // it can't sneak one more run before enforceRunCap catches it post-run.
    const effMaxRuns =
      "maxRuns" in updates
        ? (updates.maxRuns as number | undefined)
        : job.maxRuns;
    if (
      effMaxRuns !== undefined &&
      job.runCount >= effMaxRuns &&
      updates.enabled !== true
    )
      updates.enabled = false;

    const updated = updateCronJob(jobId, updates);
    return {
      ok: true,
      text: `Updated job "${updated?.name ?? jobId}". Fields changed: ${Object.keys(updates).join(", ")}`,
    };
  },

  run_cron_job: async (body, chatId) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== String(chatId))
      return { ok: false, error: "Job belongs to a different chat" };
    const result = await runJobNow(jobId);
    if (!result.ok) return { ok: false, error: result.error ?? "Run failed" };
    log("gateway", `run_cron_job: "${job.name}" [${jobId}]`);
    return { ok: true, text: `Ran job "${job.name}" (${jobId}) now.` };
  },

  delete_cron_job: (body, chatId) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== String(chatId))
      return { ok: false, error: "Job belongs to a different chat" };
    deleteCronJob(jobId);
    return { ok: true, text: `Deleted cron job "${job.name}" (${jobId})` };
  },
};
