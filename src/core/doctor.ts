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
import { stat } from "node:fs/promises";
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
  model?: string;
  heartbeatModel?: string;
  heartbeatBackend?: string;
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

/**
 * The configured frontends that are missing their required credentials.
 * `terminal` (stdio) and `native` (the client bridge) carry none, so they
 * are always configured; a name doctor doesn't recognize stays a failure
 * (fail-closed) so a typo'd frontend is surfaced instead of blessed —
 * but it is *named* in the report either way, never a bare "not fully
 * configured" that leaves the operator guessing which entry is at fault.
 */
function unconfiguredFrontends(config: DoctorConfigSlice): string[] {
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return fes.filter((fe) => {
    if (fe === "telegram") return !config.botToken;
    if (fe === "teams") return !config.teamsWebhookUrl;
    if (fe === "discord") return !config.discord?.botToken;
    return fe !== "terminal" && fe !== "native";
  });
}

/** How long a namespace probe may take before the mount counts as wedged. */
const NS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Probe one path without trusting it to answer: a healthy dir stats in
 * microseconds, a stale FUSE mount from a dead daemon answers ENOTCONN,
 * and a live-but-stuck daemon's mount HANGS the syscall — so the probe
 * races a timeout and a hang counts as wedged rather than wedging
 * doctor itself.
 */
async function probeNsPath(
  path: string,
): Promise<"ok" | "missing" | "hang" | string> {
  const result = await Promise.race([
    stat(path).then(
      () => "ok" as const,
      (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        return code === "ENOENT" ? ("missing" as const) : (code ?? "error");
      },
    ),
    new Promise<"hang">((resolve) => {
      setTimeout(() => resolve("hang"), NS_PROBE_TIMEOUT_MS).unref();
    }),
  ]);
  return result;
}

/**
 * The namespace mountpoint (~/.talon/ns) from the outside. Doctor runs
 * in its own process, so it can't read the daemon's in-memory FUSE
 * status — but every failure mode shows up in the filesystem itself:
 * missing means no daemon has booted yet, ENOTCONN or a hanging syscall
 * means a FUSE mount wedged by a dead or stuck daemon (every consumer
 * of the namespace is broken until it's detached), and a healthy root
 * either has live views (proc/ answers) or is the plain symlink farm.
 */
async function checkNamespaceDir(): Promise<DoctorCheck> {
  const root = await probeNsPath(dirs.ns);
  if (root === "missing") {
    return {
      label: "Namespace dir not built yet",
      status: "info",
      detail: `${dirs.ns} appears at first daemon boot`,
    };
  }
  if (root !== "ok") {
    return {
      label:
        root === "hang"
          ? "Namespace dir wedged (syscalls hang)"
          : `Namespace dir wedged (${root})`,
      status: "fail",
      detail: `stale FUSE mount at ${dirs.ns} — detach with: fusermount3 -uz ${dirs.ns} (or: umount -l ${dirs.ns})`,
    };
  }
  // Root answers. proc/ is served over the FUSE bridge, so it gets its
  // own hang-guarded probe: present = live views, absent = symlink farm.
  const proc = await probeNsPath(`${dirs.ns}/proc`);
  if (proc === "ok") {
    return {
      label: `Namespace dir: ${dirs.ns}`,
      status: "ok",
      detail: "live views mounted (proc/ answering)",
    };
  }
  if (proc === "missing") {
    return {
      label: `Namespace dir: ${dirs.ns}`,
      status: "ok",
      detail: "symlink farm (no live views — daemon off or FUSE not mounted)",
    };
  }
  return {
    label: `Namespace live views unhealthy (proc/ ${proc === "hang" ? "hangs" : proc})`,
    status: "warn",
    detail: `file mounts still work; detach the mount with: fusermount3 -uz ${dirs.ns}`,
    issue: true,
  };
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

/**
 * Validate models pinned in config against the Claude backend's static
 * catalog. A model that has been withdrawn from the catalog (it
 * happens: deprecations, policy pulls) makes every turn silently run
 * the backend default while the config keeps naming the dead id —
 * this check is where that finally becomes visible. Claude-only: this
 * catalog is a static import; other backends need a live server and
 * are audited at boot instead (core/engine/model-audit.ts).
 */
async function checkClaudeConfiguredModels(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const targets: Array<{ key: string; model?: string; backendId?: string }> = [
    { key: "model", model: config?.model, backendId: config?.backend },
    {
      key: "heartbeatModel",
      model: config?.heartbeatModel,
      backendId: config?.heartbeatBackend ?? config?.backend,
    },
  ];
  try {
    const { resolveModel } =
      await import("../backend/claude-sdk/model-provider.js");
    // Doctor runs standalone — live SDK model discovery hasn't happened,
    // so the registry may be empty. Seed the static catalog (the same
    // list the setup wizard offers) so alias pins like "opus" resolve.
    // The static list is a snapshot: a model can exist upstream and not
    // here, which is why findings are warn-level, never fail.
    const { getModels } = await import("./models/catalog.js");
    if (getModels("anthropic").length === 0) {
      const [{ registerClaudeModelsStatic }, { CLAUDE_MODELS_STATIC }] =
        await Promise.all([
          import("../backend/claude-sdk/models/discovery.js"),
          import("../backend/claude-sdk/models/static.js"),
        ]);
      registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
    }
    for (const { key, model, backendId } of targets) {
      if (!model || model === "default") continue;
      if ((backendId ?? "claude") !== "claude") continue;
      const res = await resolveModel(model);
      if (res.kind === "exact") {
        checks.push({
          label: `Model (${key}): ${model} → ${res.model.displayName}`,
          status: "ok",
        });
      } else if (res.kind === "ambiguous") {
        checks.push({
          label: `Model (${key}): "${model}" is ambiguous`,
          status: "warn",
          detail: res.matches.map((m) => m.displayName).join(", "),
          issue: true,
        });
      } else {
        checks.push({
          label: `Model (${key}): "${model}" not selectable on claude`,
          status: "warn",
          detail: "turns silently run the backend default — update config.json",
          issue: true,
        });
      }
    }
  } catch {
    /* catalog unavailable — skip, never break doctor */
  }
  return checks;
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
    checks.push(...(await checkClaudeConfiguredModels(config)));
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
    const missing = unconfiguredFrontends(opts.config);
    checks.push(
      missing.length === 0
        ? {
            label: `Frontend: ${fes.join(", ")}`,
            status: "ok",
            detail: "configured",
          }
        : {
            label: `Frontend not fully configured: ${missing.join(", ")}`,
            status: "fail",
            detail: "missing credentials in talon.json (or unknown frontend)",
          },
    );
  } else {
    checks.push({ label: "No config file", status: "fail" });
  }

  checks.push(
    existsSync(dirs.root)
      ? { label: "Workspace", status: "ok", detail: dirs.root }
      : { label: "Workspace missing", status: "warn" },
  );

  checks.push(await checkNamespaceDir());

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

  // Same optional contract for the hashing addon: absent means the
  // embedded wasm module is doing the hashing (correct, just slower
  // and on the event loop), so it's informational, not an issue. The
  // addon was digest-verified at load time by nativeBlake3().
  {
    const { nativeBlake3 } = await import("../native/blake3.js");
    const addon = nativeBlake3();
    checks.push(
      addon
        ? {
            label: `Media hashing: blake3 native addon v${addon.version()}`,
            status: "ok",
          }
        : {
            label: "Media hashing: embedded wasm (no native addon)",
            status: "info",
            detail: "npm run build:napi",
          },
    );
  }

  // Same optional contract for the namespace FUSE addon: absent means
  // ~/.talon/ns is the symlink farm only (file mounts fine, no live
  // proc//plugins views), so it's informational, not an issue.
  {
    const { nativeFuseFs } = await import("../native/fusefs.js");
    const addon = nativeFuseFs();
    checks.push(
      addon
        ? {
            label: `Namespace FUSE: talon-fusefs addon v${addon.version()}`,
            status: "ok",
          }
        : {
            label: "Namespace FUSE: symlink farm only (no addon)",
            status: "info",
            detail: "npm run build:fusefs",
          },
    );
  }

  // Package-owned prompt templates must be loadable. On a standalone
  // `bun build --compile` binary these are embedded file assets (no
  // source tree on disk); a failure here means the embed manifest is
  // stale or the package is incomplete — caught at check time, not
  // mid-message when a backend assembles its system prompt.
  {
    const { loadSystemTemplate } = await import("./prompt/index.js");
    try {
      const sample = loadSystemTemplate("workspace");
      checks.push(
        sample.trim().length > 0
          ? {
              label: "Prompt templates loaded",
              status: "ok",
            }
          : {
              label: "Prompt templates empty",
              status: "fail",
              issue: true,
            },
      );
    } catch (err) {
      checks.push({
        label: "Prompt templates unavailable",
        status: "fail",
        detail: errorNote(err),
        issue: true,
      });
    }
  }

  // Seeded prompt provenance — surfaces the upgrade-aware seeding
  // state (.seeded.json): files still tracking the package refresh on
  // upgrade; user-edited files are never touched again. Knowing which
  // is which is the difference between "why didn't my prompt update?"
  // and a one-line answer.
  {
    const { promptSeedReport } = await import("../util/workspace.js");
    try {
      const { tracking, edited } = promptSeedReport();
      if (tracking.length + edited.length > 0) {
        checks.push({
          label: `Prompts: ${tracking.length} tracking package upgrades, ${edited.length} user-edited`,
          status: "ok",
          detail:
            edited.length > 0 ? `edited: ${edited.join(", ")}` : undefined,
        });
      }
    } catch {
      /* diagnostics only — never block the report */
    }
  }

  const native = await checkNativeModules();
  checks.push(...(await checkBackend(opts.config)));

  const issues =
    checks.filter((c) => c.status === "fail" || c.issue).length +
    native.filter((m) => !m.ok).length;

  return { checks, native, issues };
}
