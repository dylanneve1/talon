#!/usr/bin/env node
/**
 * Talon CLI — interactive setup, management, and monitoring.
 *
 * Usage:
 *   talon              — interactive menu (runs setup on first launch)
 *   talon setup        — guided setup wizard
 *   talon status       — show bot health and stats
 *   talon config       — view/edit configuration
 *   talon logs         — tail the log file with formatting
 *   talon start        — start the bot directly
 *   talon chat         — terminal chat mode
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  watchFile,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { dirs, files as pathFiles } from "./util/paths.js";

const PKG_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const CONFIG_FILE = pathFiles.config;
const LOG_FILE = pathFiles.log;
const ERROR_LOG_FILE = pathFiles.errorLog;
const BASE_URL = "http://127.0.0.1:19876";
const HEALTH_URL = `${BASE_URL}/health`;

function printBanner(): void {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("\uD83E\uDD85 Talon"))}`);
  console.log(`  ${pc.dim("Agentic AI harness")}`);
  console.log();
}

type Config = {
  frontend: string | string[];
  botToken?: string;
  claudeBinary?: string;
  model: string;
  concurrency: number;
  pulse: boolean;
  pulseIntervalMs: number;
  adminUserId?: number;
  apiId?: number;
  apiHash?: string;
  maxMessageLength: number;
  plugins?: unknown[];
  // Teams
  teamsWebhookUrl?: string;
  teamsWebhookSecret?: string;
  teamsWebhookPort?: number;
  teamsBotDisplayName?: string;
};

const DEFAULTS: Config = {
  frontend: "telegram",
  model: "default",
  concurrency: 1,
  pulse: true,
  pulseIntervalMs: 300000,
  maxMessageLength: 4000,
};

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
    }
  } catch {
    /* corrupt */
  }
  return { ...DEFAULTS };
}

function saveConfig(config: Config): void {
  if (!existsSync(dirs.root)) mkdirSync(dirs.root, { recursive: true });
  const clean = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined),
  );
  writeFileAtomic.sync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n");
}

function maskToken(token: string | undefined): string {
  if (!token || token.length < 10) return pc.red("not set");
  return pc.green(token.slice(0, 8) + "..." + token.slice(-4));
}

function isConfigured(config: Config): boolean {
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return fes.every((fe) => {
    if (fe === "telegram") return !!config.botToken;
    if (fe === "terminal") return true;
    if (fe === "teams") return !!config.teamsWebhookUrl;
    return false;
  });
}

// ── Setup wizard ────────────────────────────────────────────────────────────

async function runSetup(): Promise<void> {
  printBanner();
  p.intro(pc.inverse(" Setup Wizard "));

  const config = loadConfig();
  const existingFrontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend || "telegram"];

  const frontendSelection = await p.multiselect({
    message: "Frontend platforms (space to toggle, enter to confirm)",
    initialValues: existingFrontends,
    options: [
      {
        value: "telegram",
        label: `Telegram  ${pc.dim("\u2014 bot via @BotFather")}`,
      },
      {
        value: "terminal",
        label: `Terminal  ${pc.dim("\u2014 local CLI chat")}`,
      },
      {
        value: "teams",
        label: `Teams     ${pc.dim("\u2014 Microsoft Teams via Power Automate")}`,
      },
    ],
    required: true,
  });
  if (p.isCancel(frontendSelection)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  const selectedFrontends = frontendSelection as string[];

  let botToken: string | undefined;
  let adminId: string | undefined;
  let apiId: number | undefined;
  let apiHash: string | undefined;

  if (selectedFrontends.includes("telegram")) {
    const token = await p.text({
      message: "Bot token",
      placeholder: "Paste your token from @BotFather",
      initialValue: config.botToken || undefined,
      validate: (v) => {
        if (!v) return "Token is required";
        if (!v.includes(":")) return "Invalid format";
      },
    });
    if (p.isCancel(token)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    botToken = token;

    adminId = (await p.text({
      message: "Your Telegram user ID",
      placeholder: "optional \u2014 message @userinfobot to find yours",
      initialValue: config.adminUserId ? String(config.adminUserId) : "",
    })) as string;
    if (p.isCancel(adminId)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const wantUserbot = await p.confirm({
      message: "Set up userbot for full history access?",
      initialValue: !!(config.apiId && config.apiHash),
    });
    if (p.isCancel(wantUserbot)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (wantUserbot) {
      p.note(
        "Get these from https://my.telegram.org \u2192 API development tools",
        "Telegram API credentials",
      );
      const id = await p.text({
        message: "API ID",
        placeholder: "12345678",
        initialValue: config.apiId ? String(config.apiId) : "",
        validate: (v) => {
          if (v && isNaN(parseInt(v, 10))) return "Must be a number";
        },
      });
      if (p.isCancel(id)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      const hash = await p.text({
        message: "API Hash",
        initialValue: config.apiHash || "",
      });
      if (p.isCancel(hash)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (id) apiId = parseInt(id, 10);
      if (hash) apiHash = hash as string;
    }
  }

  let teamsWebhookUrl: string | undefined;
  let teamsWebhookSecret: string | undefined;
  let teamsWebhookPort: number | undefined;
  let teamsBotDisplayName: string | undefined;

  if (selectedFrontends.includes("teams")) {
    p.note(
      "Set up two Power Automate workflows in Teams:\n" +
        "1. Send: 'Post to a channel when a webhook request is received' — copy the URL below\n" +
        "2. Receive: 'When a new channel message is added' → HTTP POST to your Talon endpoint",
      "Teams Setup",
    );

    const url = await p.text({
      message: "Power Automate webhook URL (for sending to Teams)",
      placeholder: "https://prod-XX.westus.logic.azure.com/workflows/...",
      initialValue: config.teamsWebhookUrl || undefined,
      validate: (v) => {
        if (!v) return "Webhook URL is required";
        try {
          new URL(v);
        } catch {
          return "Must be a valid URL";
        }
      },
    });
    if (p.isCancel(url)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    teamsWebhookUrl = url;

    const secret = (await p.text({
      message: "Webhook secret for inbound verification",
      placeholder: "optional — shared secret to verify incoming webhooks",
      initialValue: config.teamsWebhookSecret || "",
    })) as string;
    if (p.isCancel(secret)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (secret) teamsWebhookSecret = secret;

    const port = await p.text({
      message: "Webhook receiver port",
      placeholder: "19878",
      initialValue: config.teamsWebhookPort
        ? String(config.teamsWebhookPort)
        : "19878",
      validate: (v) => {
        if (!v) return "Port is required";
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1024 || n > 65535) return "Port must be 1024-65535";
      },
    });
    if (p.isCancel(port)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    teamsWebhookPort = parseInt(port as string, 10);

    const botName = (await p.text({
      message: "Bot display name in Teams (for echo loop prevention)",
      placeholder: "optional — e.g. 'Talon Bot'",
      initialValue: config.teamsBotDisplayName || "",
    })) as string;
    if (p.isCancel(botName)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (botName) teamsBotDisplayName = botName;
  }

  // Discover models from SDK; fall back to static list if SDK isn't available
  const {
    registerClaudeModels,
    registerClaudeModelsStatic,
    CLAUDE_MODELS_STATIC,
  } = await import("./backend/claude-sdk/models.js");
  try {
    const { dirs } = await import("./util/paths.js");
    await registerClaudeModels({
      model: config.model,
      cwd: dirs.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(config.claudeBinary
        ? { pathToClaudeCodeExecutable: config.claudeBinary }
        : {}),
    });
  } catch {
    // Setup wizard may run before Claude Code is installed — use static list
    registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
  }
  const { getModels } = await import("./core/models.js");
  const registeredModels = getModels();

  const model = await p.select({
    message: "Default model",
    initialValue: config.model,
    options: registeredModels.map((m) => ({
      value: m.id,
      label: `${m.displayName.padEnd(12)}${m.description ? pc.dim(`\u2014 ${m.description}`) : ""}`,
    })),
  });
  if (p.isCancel(model)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const pulse = !selectedFrontends.every((f) => f === "terminal")
    ? await p.confirm({
        message: "Enable pulse? (periodic group engagement)",
        initialValue: config.pulse,
      })
    : false;
  if (p.isCancel(pulse)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // ── Claude binary path ──
  const claudeBinaryInput = await p.text({
    message: "Claude Code binary path",
    placeholder: "leave empty for default (claude)",
    initialValue: config.claudeBinary || "",
  });
  if (p.isCancel(claudeBinaryInput)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  const claudeBinary = (claudeBinaryInput as string).trim() || undefined;

  const newConfig: Config = {
    frontend:
      selectedFrontends.length === 1 ? selectedFrontends[0] : selectedFrontends,
    botToken: selectedFrontends.includes("telegram") ? botToken : undefined,
    claudeBinary,
    model: model as string,
    concurrency: config.concurrency,
    pulse: pulse as boolean,
    pulseIntervalMs: config.pulseIntervalMs,
    adminUserId: adminId ? parseInt(adminId, 10) || undefined : undefined,
    apiId,
    apiHash,
    maxMessageLength: config.maxMessageLength,
    plugins: config.plugins,
    // Teams
    teamsWebhookUrl: selectedFrontends.includes("teams")
      ? teamsWebhookUrl
      : undefined,
    teamsWebhookSecret: selectedFrontends.includes("teams")
      ? teamsWebhookSecret
      : undefined,
    teamsWebhookPort: selectedFrontends.includes("teams")
      ? teamsWebhookPort
      : undefined,
    teamsBotDisplayName: selectedFrontends.includes("teams")
      ? teamsBotDisplayName
      : undefined,
  };

  const s = p.spinner();
  s.start("Saving configuration");
  saveConfig(newConfig);
  s.stop("Configuration saved");

  p.outro(`Run ${pc.cyan(pc.bold("talon start"))} to launch Talon`);

  if (selectedFrontends.includes("telegram") && apiId && apiHash) {
    console.log(
      `  ${pc.yellow("!")} Run ${pc.cyan("npx tsx src/login.ts")} to authenticate the userbot first.\n`,
    );
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

async function showStatus(): Promise<void> {
  printBanner();
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const h = (await resp.json()) as Record<string, unknown>;
      const ok = h.ok as boolean;
      console.log(
        `  ${ok ? pc.green("\u25CF") : pc.yellow("\u25CF")} ${pc.bold("Running")}  ${ok ? pc.green("healthy") : pc.yellow("degraded")}`,
      );
      console.log();
      console.log(
        `  ${pc.dim("Uptime")}       ${formatUptime(h.uptime as number)}`,
      );
      console.log(`  ${pc.dim("Memory")}       ${h.memory} MB`);
      console.log(`  ${pc.dim("Sessions")}     ${h.sessions}`);
      console.log(`  ${pc.dim("Messages")}     ${h.messages}`);
      console.log(`  ${pc.dim("Queue")}        ${h.queue} pending`);
      console.log(`  ${pc.dim("Errors")}       ${h.errors}`);
      console.log(`  ${pc.dim("Last active")}  ${h.lastActivity}\n`);
      return;
    }
  } catch {
    /* not running */
  }

  console.log(`  ${pc.red("\u25CF")} ${pc.bold("Stopped")}\n`);
  if (existsSync(CONFIG_FILE)) {
    const config = loadConfig();
    const fes = Array.isArray(config.frontend)
      ? config.frontend
      : [config.frontend];
    console.log(`  ${pc.dim("Frontend")} ${fes.join(", ")}`);
    if (fes.includes("telegram"))
      console.log(
        `  ${pc.dim("Token")}    ${config.botToken ? pc.green("configured") : pc.red("not set")}`,
      );
    if (fes.includes("teams"))
      console.log(
        `  ${pc.dim("Teams")}    ${config.teamsWebhookUrl ? pc.green("configured") : pc.red("not set")}`,
      );
    console.log(`  ${pc.dim("Model")}    ${config.model}`);
    console.log(`  ${pc.dim("Config")}   ${pc.dim(CONFIG_FILE)}\n`);
    console.log(
      `  Start with ${pc.cyan("talon start")} or ${pc.cyan("talon chat")}\n`,
    );
  } else {
    console.log(`  Run ${pc.cyan("talon setup")} to get started.\n`);
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ── Config viewer ───────────────────────────────────────────────────────────

async function viewConfig(): Promise<void> {
  printBanner();
  if (!existsSync(CONFIG_FILE)) {
    console.log(`  No config found. Running setup...\n`);
    await runSetup();
    return;
  }
  const config = loadConfig();
  p.intro(pc.inverse(" Configuration "));
  console.log();
  console.log(`  ${pc.dim("File")}             ${pc.dim(CONFIG_FILE)}`);
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  console.log(`  ${pc.dim("Frontend")}         ${fes.join(", ")}`);
  if (fes.includes("telegram")) {
    console.log(
      `  ${pc.dim("Bot token")}        ${maskToken(config.botToken)}`,
    );
    console.log(
      `  ${pc.dim("Admin")}            ${config.adminUserId || pc.dim("not set")}`,
    );
    console.log(
      `  ${pc.dim("Userbot")}          ${config.apiId ? pc.green("configured") : pc.dim("not set")}`,
    );
  }
  if (fes.includes("teams")) {
    console.log(
      `  ${pc.dim("Teams webhook")}    ${config.teamsWebhookUrl ? pc.green("configured") : pc.red("not set")}`,
    );
    console.log(
      `  ${pc.dim("Teams secret")}     ${config.teamsWebhookSecret ? pc.green("set") : pc.dim("not set")}`,
    );
    console.log(
      `  ${pc.dim("Teams port")}       ${config.teamsWebhookPort || 19878}`,
    );
    console.log(
      `  ${pc.dim("Teams bot name")}   ${config.teamsBotDisplayName || pc.dim("not set")}`,
    );
  }
  if (config.claudeBinary)
    console.log(
      `  ${pc.dim("Claude binary")}    ${pc.green(config.claudeBinary)}`,
    );
  console.log(`  ${pc.dim("Model")}            ${config.model}`);
  console.log(`  ${pc.dim("Concurrency")}      ${config.concurrency}`);
  console.log(
    `  ${pc.dim("Pulse")}            ${config.pulse ? pc.green("on") : pc.dim("off")} ${pc.dim(`(${Math.round(config.pulseIntervalMs / 60000)}m)`)}`,
  );
  if (config.plugins && config.plugins.length > 0)
    console.log(
      `  ${pc.dim("Plugins")}          ${config.plugins.length} loaded`,
    );
  console.log();
  const action = await p.select({
    message: "Action",
    options: [
      { value: "edit", label: "Edit", hint: "re-run setup wizard" },
      { value: "done", label: "Done" },
    ],
  });
  if (action === "edit") await runSetup();
}

// ── Log viewer ──────────────────────────────────────────────────────────────

const LEVEL_LABELS: Record<number, string> = {
  10: pc.dim("TRC"),
  20: pc.dim("DBG"),
  30: pc.blue("INF"),
  40: pc.yellow("WRN"),
  50: pc.red("ERR"),
  60: pc.bgRed(pc.white("FTL")),
};

function formatLogLine(line: string): string {
  try {
    const obj = JSON.parse(line);
    const level = LEVEL_LABELS[obj.level as number] ?? pc.dim("???");
    const time = pc.dim(
      new Date(obj.time as number).toTimeString().slice(0, 8),
    );
    const comp = pc.cyan(((obj.component as string) ?? "?").padEnd(10));
    return `  ${time} ${level} ${comp} ${obj.msg}${obj.err ? pc.red(` (${obj.err})`) : ""}`;
  } catch {
    return `  ${line}`;
  }
}

async function tailFile(
  filePath: string,
  label: string,
  initialLines = 30,
): Promise<void> {
  printBanner();
  if (!existsSync(filePath)) {
    console.log(
      `  No ${label} file yet.  Start the bot first: ${pc.cyan("talon start")}\n`,
    );
    return;
  }
  console.log(
    `  ${pc.dim(`Tailing ${label}`)} ${pc.dim(filePath)}\n  ${pc.dim("Press Ctrl+C to stop")}\n`,
  );
  // An empty/whitespace-only file must yield 0 lines, not [""]. Otherwise
  // lastSize starts at 1 and the first real appended line gets skipped.
  const splitLines = (content: string): string[] => {
    const trimmed = content.replace(/\n+$/, "");
    return trimmed === "" ? [] : trimmed.split("\n");
  };

  const lines = splitLines(readFileSync(filePath, "utf-8"));
  for (const line of lines.slice(-initialLines))
    console.log(formatLogLine(line));
  let lastSize = lines.length;
  watchFile(filePath, { interval: 500 }, () => {
    try {
      const nl = splitLines(readFileSync(filePath, "utf-8"));
      for (let i = lastSize; i < nl.length; i++)
        console.log(formatLogLine(nl[i]));
      lastSize = nl.length;
    } catch {
      /* ignore */
    }
  });
  await new Promise(() => {});
}

async function tailLogs(): Promise<void> {
  await tailFile(LOG_FILE, "log", 30);
}

async function tailErrors(): Promise<void> {
  await tailFile(ERROR_LOG_FILE, "errors.log", 50);
}

// ── Debug ───────────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function debugDumpMetrics(): Promise<void> {
  printBanner();
  try {
    const data = (await fetchJson(`${BASE_URL}/debug/metrics`)) as {
      counters: Record<string, number>;
      histograms: Record<
        string,
        { count: number; p50: number; p95: number; p99: number; avg: number }
      >;
    };
    console.log(`  ${pc.bold("Counters")}`);
    const counters = Object.entries(data.counters ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (counters.length === 0) {
      console.log(`    ${pc.dim("(none)")}`);
    } else {
      for (const [k, v] of counters) {
        console.log(`    ${pc.dim(k.padEnd(40))} ${pc.cyan(String(v))}`);
      }
    }
    console.log();
    console.log(
      `  ${pc.bold("Histograms")} ${pc.dim("(p50 / p95 / p99 / avg, ms)")}`,
    );
    const histograms = Object.entries(data.histograms ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (histograms.length === 0) {
      console.log(`    ${pc.dim("(none)")}`);
    } else {
      for (const [k, h] of histograms) {
        console.log(
          `    ${pc.dim(k.padEnd(40))} ${pc.cyan(`${h.p50}`.padStart(5))} / ${pc.cyan(`${h.p95}`.padStart(5))} / ${pc.cyan(`${h.p99}`.padStart(5))} / ${pc.cyan(`${h.avg}`.padStart(5))} ${pc.dim(`n=${h.count}`)}`,
        );
      }
    }
    console.log();
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not reach bot: ${err instanceof Error ? err.message : err}\n`,
    );
    console.log(`  Is Talon running?  Start with ${pc.cyan("talon start")}.\n`);
  }
}

async function debugDumpSpans(limit: number): Promise<void> {
  printBanner();
  try {
    const data = (await fetchJson(
      `${BASE_URL}/debug/spans?limit=${limit}`,
    )) as {
      spans: Array<{
        name: string;
        durationMs: number;
        status: string;
        attrs: Record<string, unknown>;
        err?: string;
        startMs: number;
        traceId: string;
      }>;
    };
    if (!data.spans?.length) {
      console.log(`  ${pc.dim("(no spans)")}\n`);
      return;
    }
    console.log(`  ${pc.bold(`Last ${data.spans.length} spans`)}\n`);
    for (const s of data.spans) {
      const ok = s.status === "ok" ? pc.green("✓") : pc.red("✗");
      const when = pc.dim(new Date(s.startMs).toISOString().slice(11, 19));
      const ms = pc.cyan(`${s.durationMs}ms`.padStart(8));
      console.log(`  ${when} ${ok} ${ms} ${pc.bold(s.name)}`);
      const keys = Object.keys(s.attrs).slice(0, 4);
      if (keys.length) {
        const summary = keys
          .map((k) => `${pc.dim(k)}=${String(s.attrs[k]).slice(0, 40)}`)
          .join(" ");
        console.log(`            ${summary}`);
      }
      if (s.err) console.log(`            ${pc.red(s.err)}`);
    }
    console.log();
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not reach bot: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

async function debugSetLogLevel(level: string): Promise<void> {
  printBanner();
  const valid = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
  if (!valid.includes(level)) {
    console.log(`  ${pc.red("✖")} Invalid level: ${level}`);
    console.log(`  Valid: ${valid.join(", ")}\n`);
    return;
  }
  try {
    const res = (await postJson(`${BASE_URL}/debug/log-level`, { level })) as {
      ok: boolean;
      level?: string;
      error?: string;
    };
    if (res.ok) {
      console.log(
        `  ${pc.green("●")} Log level set to ${pc.bold(res.level ?? level)}\n`,
      );
    } else {
      console.log(`  ${pc.red("✖")} ${res.error}\n`);
    }
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not reach bot: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

async function debugDumpState(): Promise<void> {
  printBanner();
  try {
    const data = await fetchJson(`${BASE_URL}/debug/state`);
    console.log(JSON.stringify(data, null, 2));
    console.log();
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not reach bot: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

async function runDebug(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "state":
      await debugDumpState();
      return;
    case "metrics":
      await debugDumpMetrics();
      return;
    case "spans": {
      const parsed = Number.parseInt(args[1] ?? "30", 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
      await debugDumpSpans(limit);
      return;
    }
    case "errors":
      await tailErrors();
      return;
    case "log-level":
      if (!args[1]) {
        printBanner();
        try {
          const cur = (await fetchJson(`${BASE_URL}/debug/log-level`)) as {
            level: string;
          };
          console.log(`  Current log level: ${pc.bold(cur.level)}\n`);
        } catch (err) {
          console.log(
            `  ${pc.red("✖")} Could not reach bot: ${err instanceof Error ? err.message : err}\n`,
          );
        }
        return;
      }
      await debugSetLogLevel(args[1]);
      return;
    default:
      printBanner();
      console.log("  Usage: talon debug <subcommand>\n");
      console.log("  Subcommands:");
      console.log(
        `    ${pc.cyan("state")}               Full runtime snapshot (JSON)`,
      );
      console.log(
        `    ${pc.cyan("metrics")}             Counters + histogram percentiles`,
      );
      console.log(
        `    ${pc.cyan("spans [N]")}           Last N spans (default 30)`,
      );
      console.log(`    ${pc.cyan("errors")}              Tail errors.log live`);
      console.log(
        `    ${pc.cyan("log-level [lvl]")}     Get/set runtime log level`,
      );
      console.log();
  }
}

// ── Doctor ──────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  printBanner();
  console.log(`  ${pc.bold("Environment check")}\n`);
  let issues = 0;
  const major = parseInt(process.versions.node.split(".")[0], 10);
  console.log(
    major >= 22
      ? `  ${pc.green("\u2713")} Node.js ${process.versions.node}`
      : `  ${pc.red("\u2717")} Node.js ${process.versions.node} ${pc.dim("(need >=22)")}`,
  );
  if (major < 22) issues++;
  if (existsSync(CONFIG_FILE)) {
    const config = loadConfig();
    const fes = Array.isArray(config.frontend)
      ? config.frontend
      : [config.frontend];
    console.log(
      isConfigured(config)
        ? `  ${pc.green("\u2713")} Frontend: ${fes.join(", ")} (configured)`
        : `  ${pc.red("\u2717")} Frontend not fully configured`,
    );
    if (!isConfigured(config)) issues++;
  } else {
    console.log(`  ${pc.red("\u2717")} No config file`);
    issues++;
  }
  console.log(
    existsSync(dirs.root)
      ? `  ${pc.green("\u2713")} Workspace: ${pc.dim(dirs.root)}`
      : `  ${pc.yellow("!")} Workspace missing`,
  );
  try {
    const { execSync } = await import("node:child_process");
    const doctorConfig = existsSync(CONFIG_FILE) ? loadConfig() : undefined;
    if (doctorConfig?.claudeBinary) {
      // Check if it's a PATH command or an absolute/relative file path
      const cmd = process.platform === "win32" ? "where" : "which";
      try {
        execSync(`${cmd} ${doctorConfig.claudeBinary}`, { stdio: "pipe" });
        console.log(
          `  ${pc.green("\u2713")} Claude Code binary: ${pc.dim(doctorConfig.claudeBinary)}`,
        );
      } catch {
        console.log(
          `  ${pc.red("\u2717")} Claude Code binary not found: ${pc.dim(doctorConfig.claudeBinary)}`,
        );
        issues++;
      }
    } else {
      execSync(process.platform === "win32" ? "where claude" : "which claude", {
        stdio: "pipe",
      });
      console.log(`  ${pc.green("\u2713")} Claude Code installed`);
    }
  } catch {
    console.log(`  ${pc.red("\u2717")} Claude Code not found`);
    issues++;
  }
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) console.log(`  ${pc.green("\u2713")} Bot is running`);
  } catch {
    console.log(`  ${pc.dim("-")} Bot is not running`);
  }
  console.log(
    issues === 0
      ? `\n  ${pc.green("All checks passed.")}\n`
      : `\n  ${pc.yellow(`${issues} issue(s) found.`)}\n`,
  );
}

// ── Terminal chat ───────────────────────────────────────────────────────────

async function startChat(): Promise<void> {
  process.env.TALON_QUIET = "1";

  const { bootstrap, initBackendAndDispatcher } =
    await import("./bootstrap.js");
  const { flushSessions } = await import("./storage/sessions.js");
  const { flushChatSettings } = await import("./storage/chat-settings.js");
  const { flushCronJobs } = await import("./storage/cron-store.js");
  const { flushHistory } = await import("./storage/history.js");
  const { flushMediaIndex } = await import("./storage/media-index.js");
  const { createTerminalFrontend } =
    await import("./frontend/terminal/index.js");
  const { Gateway } = await import("./core/gateway.js");

  const { config } = await bootstrap({ frontendNames: ["terminal"] });

  // Override frontend for the backend — talon chat always uses terminal,
  // regardless of what the config file says. This prevents the backend from
  // spawning telegram-tools or teams-tools MCP servers and ensures the
  // system prompt loads terminal.md instead of teams.md/telegram.md.
  (config as Record<string, unknown>).frontend = "terminal";
  const { rebuildSystemPrompt } = await import("./util/config.js");
  const { getPluginPromptAdditions } = await import("./core/plugin.js");
  rebuildSystemPrompt(config, getPluginPromptAdditions());

  const gateway = new Gateway();
  const frontend = createTerminalFrontend(config, gateway);
  await frontend.init();
  const { backend } = await initBackendAndDispatcher(config, frontend);
  gateway.backend = backend;

  process.on("SIGINT", () => {
    flushSessions();
    flushChatSettings();
    flushCronJobs();
    flushHistory();
    flushMediaIndex();
    frontend.stop();
    process.exit(0);
  });
  await frontend.start();
}

// ── Main menu ───────────────────────────────────────────────────────────────

async function mainMenu(): Promise<void> {
  printBanner();
  if (!existsSync(CONFIG_FILE) || !isConfigured(loadConfig())) {
    p.intro(pc.inverse(" Welcome to Talon "));
    p.note(
      "Talon is an agentic AI harness.\nSupports Telegram and Terminal.\nLet's get you set up.",
      "First time?",
    );
    await runSetup();
    return;
  }

  let running = false;
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    running = resp.ok;
  } catch {
    /* not running */
  }
  const config = loadConfig();
  const statusDot = running
    ? `${pc.green("\u25CF")} running`
    : `${pc.red("\u25CF")} stopped`;
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  const frontendLabel = fes
    .map((f) =>
      f === "telegram" ? "Telegram" : f === "teams" ? "Teams" : "Terminal",
    )
    .join(" + ");

  const action = await p.select({
    message: `Talon ${statusDot} ${pc.dim(`(${frontendLabel})`)}`,
    options: [
      ...(!running
        ? [
            {
              value: "start" as const,
              label: `Start ${frontendLabel}`,
              hint: "background daemon",
            },
          ]
        : []),
      ...(running
        ? [
            { value: "restart" as const, label: "Restart" },
            { value: "stop" as const, label: "Stop" },
          ]
        : []),
      { value: "chat", label: "Chat in terminal", hint: "talk to Talon here" },
      { value: "status", label: "Status", hint: "health and stats" },
      { value: "config", label: "Config", hint: "view or edit" },
      { value: "logs", label: "Logs", hint: "tail live" },
      { value: "setup", label: "Setup", hint: "re-run wizard" },
    ],
  });
  if (p.isCancel(action)) process.exit(0);
  switch (action) {
    case "start":
      await daemonStart();
      break;
    case "stop":
      daemonStop();
      break;
    case "restart":
      await daemonRestart();
      break;
    case "chat":
      process.chdir(PKG_ROOT);
      await startChat();
      break;
    case "status":
      await showStatus();
      break;
    case "config":
      await viewConfig();
      break;
    case "logs":
      await tailLogs();
      break;
    case "setup":
      await runSetup();
      break;
  }
}

// ── Daemon management ───────────────────────────────────────────────────────

const PID_FILE = pathFiles.pid;

function readPid(): number | null {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch {
    /* corrupt */
  }
  return null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function daemonStart(): Promise<void> {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(
      `  ${pc.yellow("!")} Talon is already running (PID ${existingPid})`,
    );
    console.log(
      `  Use ${pc.cyan("talon restart")} to restart, or ${pc.cyan("talon stop")} to stop.\n`,
    );
    return;
  }

  const { spawn } = await import("node:child_process");
  const entryScript = resolve(PKG_ROOT, "src", "index.ts");

  // Spawn detached process with stdio piped to /dev/null
  // Use node with tsx's ESM loader to avoid .cmd wrapper issues on Windows
  const tsxImport = resolve(
    PKG_ROOT,
    "node_modules",
    "tsx",
    "dist",
    "esm",
    "index.mjs",
  );
  const child = spawn(process.execPath, ["--import", tsxImport, entryScript], {
    cwd: PKG_ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  if (child.pid) {
    if (!existsSync(dirs.root)) mkdirSync(dirs.root, { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));
    console.log(`  ${pc.green("●")} Talon started (PID ${child.pid})`);
    console.log(`  ${pc.dim("Logs:")} talon logs`);
    console.log(`  ${pc.dim("Stop:")} talon stop\n`);
  } else {
    console.log(`  ${pc.red("✖")} Failed to start Talon\n`);
  }
}

function daemonStop(): boolean {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    console.log(`  ${pc.dim("●")} Talon is not running\n`);
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ok */
    }
    return false;
  }

  process.kill(pid, "SIGTERM");
  console.log(`  ${pc.red("●")} Talon stopped (PID ${pid})`);
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* ok */
  }
  return true;
}

async function daemonRestart(): Promise<void> {
  const was = daemonStop();
  if (was) {
    // Wait for graceful shutdown
    await new Promise((r) => setTimeout(r, 2000));
  }
  await daemonStart();
}

// ── Entry point ─────────────────────────────────────────────────────────────

const command = process.argv[2];
switch (command) {
  case "setup":
    runSetup();
    break;
  case "status":
    showStatus();
    break;
  case "config":
    viewConfig();
    break;
  case "logs":
    tailLogs();
    break;
  case "errors":
    tailErrors();
    break;
  case "debug":
    runDebug(process.argv.slice(3));
    break;
  case "start":
    printBanner();
    await daemonStart();
    break;
  case "stop":
    printBanner();
    daemonStop();
    break;
  case "restart":
    printBanner();
    await daemonRestart();
    break;
  case "run":
    process.chdir(PKG_ROOT);
    import("./index.js");
    break;
  case "chat":
    process.chdir(PKG_ROOT);
    startChat();
    break;
  case "doctor":
    runDoctor();
    break;
  case "--help":
  case "-h":
    printBanner();
    console.log("  Usage: talon [command]\n");
    console.log("  Commands:");
    console.log(`    ${pc.cyan("setup")}      Guided setup wizard`);
    console.log(`    ${pc.cyan("start")}      Start as background daemon`);
    console.log(`    ${pc.cyan("stop")}       Stop the daemon`);
    console.log(`    ${pc.cyan("restart")}    Restart the daemon`);
    console.log(`    ${pc.cyan("run")}        Run in foreground (attached)`);
    console.log(`    ${pc.cyan("chat")}       Terminal chat mode`);
    console.log(`    ${pc.cyan("status")}     Show bot health`);
    console.log(`    ${pc.cyan("config")}     View/edit configuration`);
    console.log(`    ${pc.cyan("logs")}       Tail log file`);
    console.log(
      `    ${pc.cyan("errors")}     Tail errors-only log (errors.log)`,
    );
    console.log(
      `    ${pc.cyan("debug")}      Runtime debug tools (state|metrics|spans|log-level|errors)`,
    );
    console.log(`    ${pc.cyan("doctor")}     Validate environment`);
    console.log();
    console.log(
      `  Run ${pc.cyan("talon")} with no args for interactive menu.\n`,
    );
    break;
  case undefined:
    mainMenu();
    break;
  default:
    console.error(
      `  Unknown command: ${command}\n  Run ${pc.cyan("talon --help")} for usage.\n`,
    );
    process.exit(1);
}
