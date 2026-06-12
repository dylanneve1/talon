/**
 * Doctor — structured environment and native-plane diagnostics.
 *
 * One collection pass shared by every surface that reports health:
 * `talon doctor` renders the report with terminal colors (src/cli.ts),
 * the Telegram /doctor command renders it as HTML (frontend/telegram).
 * Keeping the checks here means a new check shows up everywhere at
 * once instead of drifting per-frontend.
 *
 * Checks are pure data (label / status / detail) — no console output,
 * no process.exit. Renderers decide presentation.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { NATIVE_MODULES } from "../native/registry.js";
import { dirs } from "../util/paths.js";

export type DoctorStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  label: string;
  status: DoctorStatus;
  detail?: string;
  /**
   * Counts toward the issue total even when status is "warn" — used
   * for soft failures like missing backend auth where the bot still
   * starts but a backend won't work.
   */
  issue?: boolean;
}

/** One embedded native module: provenance plus a live self-test result. */
export interface NativeModuleCheck {
  name: string;
  /** Source language ("Rust", "Zig", "C", "C++", "Gleam"). */
  language: string;
  /** Compile target ("wasm32-unknown-unknown", "wasm32-freestanding", "JavaScript"). */
  target: string;
  /** Embedded artifact size, when the module ships as wasm bytes. */
  sizeBytes?: number;
  ok: boolean;
  /** Failure detail when !ok. */
  note?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  native: NativeModuleCheck[];
  /** Failed checks + warn-with-issue checks + failed native modules. */
  issues: number;
}

/**
 * The slice of config doctor reads. Both the CLI's local Config and
 * TalonConfig satisfy this structurally.
 */
export interface DoctorConfigSlice {
  frontend: string | string[];
  backend?: string;
  botToken?: string;
  teamsWebhookUrl?: string;
  discord?: { botToken?: string };
  claudeBinary?: string;
  codexApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}

function errorNote(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Instantiate each embedded module and verify a known answer from it.
 * Catches a corrupted install — truncated artifact, engine without
 * wasm support — at check time instead of mid-message in a frontend.
 * The module list, provenance, and self-tests live in the native
 * registry (src/native/registry.ts) — a new native module shows up
 * here by registering there.
 */
export async function checkNativeModules(): Promise<NativeModuleCheck[]> {
  const results: NativeModuleCheck[] = [];
  for (const spec of NATIVE_MODULES) {
    const check: NativeModuleCheck = {
      name: spec.name,
      language: spec.language,
      target: spec.target,
      ok: false,
    };
    try {
      check.sizeBytes = await spec.sizeBytes?.();
      await spec.selfTest();
      check.ok = true;
    } catch (err) {
      check.note = errorNote(err);
    }
    results.push(check);
  }
  return results;
}

/** Whether every configured frontend has its required credentials. */
function frontendConfigured(config: DoctorConfigSlice): boolean {
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return fes.every((fe) => {
    if (fe === "telegram") return Boolean(config.botToken);
    if (fe === "terminal") return true;
    if (fe === "teams") return Boolean(config.teamsWebhookUrl);
    if (fe === "discord") return Boolean(config.discord?.botToken);
    return false;
  });
}

function binaryOnPath(name: string): boolean {
  try {
    const lookupCmd = process.platform === "win32" ? "where" : "which";
    execFileSync(lookupCmd, [name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Binary / auth checks for the active backend only. */
async function checkBackend(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const backend = config?.backend ?? "claude";

  if (backend === "claude") {
    if (config?.claudeBinary) {
      checks.push(
        binaryOnPath(config.claudeBinary)
          ? {
              label: "Claude Code binary",
              status: "ok",
              detail: config.claudeBinary,
            }
          : {
              label: "Claude Code binary not found",
              status: "fail",
              detail: config.claudeBinary,
            },
      );
    } else {
      checks.push(
        binaryOnPath("claude")
          ? { label: "Claude Code installed", status: "ok" }
          : { label: "Claude Code not found", status: "fail" },
      );
    }
  } else if (backend === "codex") {
    if (!binaryOnPath("codex")) {
      checks.push({
        label: "Codex CLI not found",
        status: "fail",
        detail: "npm i -g @openai/codex",
      });
      return checks;
    }
    checks.push({ label: "Codex CLI installed", status: "ok" });
    const { detectCodexAuth } = await import("../backend/codex/auth.js");
    const auth = detectCodexAuth({
      codexApiKey: config?.codexApiKey,
      openaiApiKey: config?.openaiApiKey,
      openaiBaseUrl: config?.openaiBaseUrl,
    });
    for (const diagnostic of auth.diagnostics) {
      checks.push({ label: diagnostic, status: "warn" });
    }
    if (auth.mode !== "none") {
      checks.push({
        label: "Codex auth",
        status: "ok",
        detail: auth.baseUrl ? `${auth.source} (${auth.baseUrl})` : auth.source,
      });
    } else {
      checks.push({
        label: "Codex auth missing",
        status: "warn",
        detail:
          "set CODEX_API_KEY, TALON_CODEX_KEY, codexApiKey, or run `codex login`",
        issue: true,
      });
    }
  } else if (backend === "kilo" || backend === "opencode") {
    // Bundled as npm deps — no external binary to check.
    checks.push({
      label: `${backend === "kilo" ? "Kilo" : "OpenCode"} SDK bundled`,
      status: "ok",
    });
  } else if (backend === "openai-agents") {
    checks.push({ label: "OpenAI Agents SDK bundled", status: "ok" });
    const hasEnvKey = Boolean(process.env.OPENAI_API_KEY);
    const hasCfgKey = Boolean(config?.openaiApiKey);
    if (hasEnvKey || hasCfgKey) {
      const sources: string[] = [];
      if (hasEnvKey) sources.push("OPENAI_API_KEY env");
      if (hasCfgKey) sources.push("openaiApiKey in talon.json");
      checks.push({
        label: "OpenAI Agents auth",
        status: "ok",
        detail: sources.join(", "),
      });
    } else {
      checks.push({
        label: "OpenAI Agents auth missing",
        status: "warn",
        detail: "set OPENAI_API_KEY or openaiApiKey in talon.json",
        issue: true,
      });
    }
    const envBase = process.env.OPENAI_BASE_URL;
    const cfgBase = config?.openaiBaseUrl;
    if (envBase || cfgBase) {
      checks.push({
        label: "OpenAI-compatible endpoint",
        status: "ok",
        detail: envBase ? `env (${envBase})` : `config (${cfgBase})`,
      });
    } else {
      checks.push({
        label: "Endpoint: api.openai.com (default)",
        status: "info",
      });
    }
  }

  return checks;
}

/**
 * Run every check and return the structured report. `config` is
 * undefined when no config file exists yet (first run).
 */
export async function collectDoctorReport(opts: {
  config?: DoctorConfigSlice;
  hasConfigFile: boolean;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    label: `Node.js ${process.versions.node}`,
    status: nodeMajor >= 24 ? "ok" : "fail",
    detail: nodeMajor >= 24 ? undefined : "need >=24",
  });

  if (opts.hasConfigFile && opts.config) {
    const fes = Array.isArray(opts.config.frontend)
      ? opts.config.frontend
      : [opts.config.frontend];
    checks.push(
      frontendConfigured(opts.config)
        ? {
            label: `Frontend: ${fes.join(", ")}`,
            status: "ok",
            detail: "configured",
          }
        : { label: "Frontend not fully configured", status: "fail" },
    );
  } else {
    checks.push({ label: "No config file", status: "fail" });
  }

  checks.push(
    existsSync(dirs.root)
      ? { label: "Workspace", status: "ok", detail: dirs.root }
      : { label: "Workspace missing", status: "warn" },
  );

  // The warden is optional by design (built per-arch, absent on plain
  // npm installs), so a missing binary is informational — triggers run
  // on the in-process TS path. When present, report the live version.
  {
    const { wardenBinaryPath, wardenVersion } =
      await import("../native/warden.js");
    const wardenBin = wardenBinaryPath();
    if (wardenBin) {
      const version = wardenVersion();
      checks.push(
        version
          ? { label: `Trigger supervision: ${version}`, status: "ok" }
          : {
              label: "Trigger supervision: warden binary unresponsive",
              status: "warn",
              detail: wardenBin,
              issue: true,
            },
      );
    } else {
      checks.push({
        label: "Trigger supervision: TS fallback (no warden binary)",
        status: "info",
        detail: "npm run build:warden",
      });
    }
  }

  const native = await checkNativeModules();
  checks.push(...(await checkBackend(opts.config)));

  const issues =
    checks.filter((c) => c.status === "fail" || c.issue).length +
    native.filter((m) => !m.ok).length;

  return { checks, native, issues };
}
