/**
 * Model audit — verify that the models named in config actually exist
 * on the backends that will serve them.
 *
 * Why this exists: bootstrap validates PER-CHAT model overrides and
 * clears stale ones, but the GLOBAL `config.model` (and
 * `heartbeatModel` / `dreamModel`) were never checked. When a pinned
 * model disappears from a provider's catalog (deprecation, policy
 * withdrawal), backends quietly serve their default instead — the
 * config keeps naming a dead model and nothing ever says so. This has
 * happened in production: a config pinned to a model that was later
 * withdrawn ran the backend default for weeks, discovered only by
 * inspecting per-turn accounting.
 *
 * The audit runs once at boot (after the backend pool binds roles) and
 * reports findings for the caller to log loudly. It never throws and
 * never blocks boot — a backend without a `models` catalog capability
 * simply isn't auditable.
 */

import type { Backend } from "../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../util/config.js";

export type ModelAuditRole = "chat" | "heartbeat" | "dream";

export type ModelAuditFinding = {
  role: ModelAuditRole;
  backendId: string;
  configured: string;
  kind: "missing" | "ambiguous";
  /** Human-readable, log-ready description with the fix. */
  message: string;
};

/** Config keys audited per role — named in messages so the fix is obvious. */
const CONFIG_KEY: Record<ModelAuditRole, string> = {
  chat: "model",
  heartbeat: "heartbeatModel",
  dream: "dreamModel",
};

/**
 * Audit each role's configured model against its backend's catalog.
 *
 * `getBackend` should return the backend bound to a role (or throw /
 * return undefined when the role isn't bound — both are treated as
 * not-auditable, never as findings). Models set to "default" (or
 * unset) are skipped: no pin, nothing to drift.
 */
export async function auditConfiguredModels(
  config: TalonConfig,
  getBackend: (role: ModelAuditRole) => Backend | undefined,
): Promise<ModelAuditFinding[]> {
  const targets: Array<{
    role: ModelAuditRole;
    model: string | undefined;
    backendId: string;
  }> = [
    { role: "chat", model: config.model, backendId: config.backend },
    {
      role: "heartbeat",
      model: config.heartbeatModel,
      backendId: config.heartbeatBackend ?? config.backend,
    },
    {
      role: "dream",
      model: config.dreamModel,
      backendId: config.dreamBackend ?? config.backend,
    },
  ];

  const findings: ModelAuditFinding[] = [];
  for (const { role, model, backendId } of targets) {
    if (!model || model === "default") continue;

    let backend: Backend | undefined;
    try {
      backend = getBackend(role);
    } catch {
      continue; // role not bound — nothing serving it, nothing to audit
    }
    const catalog = backend?.models;
    if (!catalog?.resolveModelInfo) continue; // no catalog — not auditable

    let resolution: Awaited<ReturnType<typeof catalog.resolveModelInfo>>;
    try {
      resolution = await catalog.resolveModelInfo(model);
    } catch {
      continue; // catalog unavailable (network, spawn) — don't guess
    }

    if (resolution.kind === "missing") {
      findings.push({
        role,
        backendId,
        configured: model,
        kind: "missing",
        message:
          `${role}: configured model "${model}" is NOT selectable on ` +
          `backend "${backendId}" — turns will silently run the backend ` +
          `default. Update "${CONFIG_KEY[role]}" in config.json.`,
      });
    } else if (resolution.kind === "ambiguous") {
      const names = resolution.matches
        .slice(0, 5)
        .map((m) => m.displayName)
        .join(", ");
      findings.push({
        role,
        backendId,
        configured: model,
        kind: "ambiguous",
        message:
          `${role}: configured model "${model}" is ambiguous on backend ` +
          `"${backendId}" (matches: ${names}) — pin an exact id in ` +
          `"${CONFIG_KEY[role]}" in config.json.`,
      });
    }
  }
  return findings;
}
