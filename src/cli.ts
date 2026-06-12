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
import { existsSync, readFileSync, mkdirSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { dirs, files as pathFiles } from "./util/paths.js";
import { findRunningInstance } from "./core/daemon/discovery.js";
import {
  startDaemon,
  stopDaemon,
  restartDaemon,
  type StartOutcome,
  type StopOutcome,
} from "./core/daemon/control.js";
import { MCP_LAUNCH_SUBCOMMAND, runSupervisor } from "./util/mcp-launcher.js";
import { LUA_RUN_SUBCOMMAND, runLuaMain } from "./core/scripting/lua-runner.js";

// Hidden subcommand dispatch — must run before anything else. Talon
// supervises MCP stdio children (`_mcp-launch`) and runs WASM-sandboxed
// Lua trigger scripts (`_lua-run`) by re-invoking its own entrypoint
// (see util/mcp-launcher.ts). Neither call resolves; the helper process
// exits from its own handlers.
if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
  await runSupervisor(process.argv.slice(3));
} else if (process.argv[2] === LUA_RUN_SUBCOMMAND) {
  await runLuaMain(process.argv.slice(3));
}

const PKG_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const CONFIG_FILE = pathFiles.config;
const LOG_FILE = pathFiles.log;

function printBanner(): void {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("\uD83E\uDD85 Talon"))}`);
  console.log(`  ${pc.dim("Agentic AI harness")}`);
  console.log();
}

type Config = {
  frontend: string | string[];
  /** Active backend (`claude` / `kilo` / `opencode` / `codex` / `openai-agents`). */
  backend?: "claude" | "kilo" | "opencode" | "codex" | "openai-agents";
  botToken?: string;
  claudeBinary?: string;
  /** Codex-specific OpenAI API key. */
  codexApiKey?: string;
  /** OpenAI API key — used by OpenAI Agents and legacy Codex config. */
  openaiApiKey?: string;
  /** OpenAI-compatible base URL — OpenRouter, Azure, Ollama, LiteLLM, etc. */
  openaiBaseUrl?: string;
  /** OpenAI API surface — "responses" (default) or "chat_completions" (most third parties). */
  openaiApiMode?: "responses" | "chat_completions";
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
  // Discord
  discord?: {
    botToken: string;
    applicationId: string;
    allowedUsers?: string[];
    allowedGuilds?: string[];
    allowedChannels?: string[];
    adminUserIds?: string[];
    [key: string]: unknown;
  };
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
    if (fe === "discord") return !!config.discord?.botToken;
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
        value: "discord",
        label: `Discord   ${pc.dim("\u2014 bot via Developer Portal (discord.js v14)")}`,
      },
      {
        value: "teams",
        label: `Teams     ${pc.dim("\u2014 Microsoft Teams via Power Automate")}`,
      },
      {
        value: "terminal",
        label: `Terminal  ${pc.dim("\u2014 local CLI chat")}`,
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

  let discordBotToken: string | undefined;
  let discordApplicationId: string | undefined;

  if (selectedFrontends.includes("discord")) {
    p.note(
      "Get bot token + application ID from\n" +
        "https://discord.com/developers/applications → your app → Bot",
      "Discord Setup",
    );

    const token = await p.text({
      message: "Discord bot token",
      placeholder: "MTxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      initialValue: config.discord?.botToken || undefined,
      validate: (v) => {
        if (!v) return "Bot token is required";
      },
    });
    if (p.isCancel(token)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    discordBotToken = token as string;

    const appId = await p.text({
      message: "Discord application ID",
      placeholder: "1234567890123456789",
      initialValue: config.discord?.applicationId || undefined,
      validate: (v) => {
        if (!v) return "Application ID is required";
      },
    });
    if (p.isCancel(appId)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    discordApplicationId = appId as string;
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
  const { getModels } = await import("./core/models/catalog.js");
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

  // ── Backend selection ──
  const backendSelection = await p.select({
    message: "AI backend",
    initialValue: config.backend ?? "claude",
    options: [
      {
        value: "claude",
        label: `Claude    ${pc.dim("— Anthropic Claude Agent SDK")}`,
      },
      {
        value: "kilo",
        label: `Kilo      ${pc.dim("— @kilocode/sdk (multi-provider routing)")}`,
      },
      {
        value: "opencode",
        label: `OpenCode  ${pc.dim("— @opencode-ai/sdk")}`,
      },
      {
        value: "codex",
        label: `Codex     ${pc.dim("— OpenAI Codex CLI (@openai/codex)")}`,
      },
      {
        value: "openai-agents",
        label: `OpenAI Agents ${pc.dim("— @openai/agents (OpenAI or any OpenAI-compatible endpoint)")}`,
      },
    ],
  });
  if (p.isCancel(backendSelection)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  const backend = backendSelection as Config["backend"];

  // ── Backend-specific config ──
  let claudeBinary: string | undefined;
  let codexApiKey: string | undefined;
  let openaiApiKey: string | undefined;
  let openaiBaseUrl: string | undefined;
  let openaiApiMode: "responses" | "chat_completions" | undefined;

  if (backend === "claude") {
    const claudeBinaryInput = await p.text({
      message: "Claude Code binary path",
      placeholder: "leave empty for default (claude)",
      initialValue: config.claudeBinary || "",
    });
    if (p.isCancel(claudeBinaryInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    claudeBinary = (claudeBinaryInput as string).trim() || undefined;
  } else if (backend === "codex") {
    const keyInput = await p.text({
      message: "Codex OpenAI API key",
      placeholder:
        "leave empty to use CODEX_API_KEY / TALON_CODEX_KEY env or `codex login` auth",
      initialValue: config.codexApiKey || "",
    });
    if (p.isCancel(keyInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    codexApiKey = (keyInput as string).trim() || undefined;
  } else if (backend === "openai-agents") {
    const keyInput = await p.text({
      message:
        "API key (OpenAI, OpenRouter, Azure, or whatever your endpoint requires)",
      placeholder: "leave empty to use OPENAI_API_KEY env",
      initialValue: config.openaiApiKey || "",
    });
    if (p.isCancel(keyInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    openaiApiKey = (keyInput as string).trim() || undefined;

    const baseUrlInput = await p.text({
      message:
        "Base URL " +
        pc.dim(
          "(leave empty for OpenAI direct; e.g. https://openrouter.ai/api/v1)",
        ),
      placeholder: "https://openrouter.ai/api/v1",
      initialValue: config.openaiBaseUrl || "",
    });
    if (p.isCancel(baseUrlInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    openaiBaseUrl = (baseUrlInput as string).trim() || undefined;

    if (openaiBaseUrl) {
      const modeSelection = await p.select({
        message: "OpenAI API surface",
        options: [
          {
            value: "chat_completions",
            label: `Chat Completions ${pc.dim("— most third parties (OpenRouter, Ollama, LiteLLM, most Azure)")}`,
          },
          {
            value: "responses",
            label: `Responses ${pc.dim("— OpenAI native, requires proxy support")}`,
          },
        ],
        initialValue: config.openaiApiMode ?? "chat_completions",
      });
      if (p.isCancel(modeSelection)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      openaiApiMode = modeSelection as "responses" | "chat_completions";
    }
  }

  // kilo / opencode need no extra prompts — bundled SDK + per-provider
  // creds configured separately (kilo via `kilo login`, opencode via
  // its own auth flow).

  const newConfig: Config = {
    frontend:
      selectedFrontends.length === 1 ? selectedFrontends[0] : selectedFrontends,
    backend,
    botToken: selectedFrontends.includes("telegram") ? botToken : undefined,
    claudeBinary,
    codexApiKey,
    openaiApiKey,
    openaiBaseUrl,
    openaiApiMode,
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
    // Discord — bot token + applicationId. Allowlists / admin IDs /
    // mention vs channel-wide reply behaviour are left as defaults in
    // the wizard; advanced users hand-edit talon.json.
    discord:
      selectedFrontends.includes("discord") &&
      discordBotToken &&
      discordApplicationId
        ? {
            ...config.discord,
            botToken: discordBotToken,
            applicationId: discordApplicationId,
          }
        : config.discord,
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
  const instance = await findRunningInstance();

  if (instance?.health) {
    const h = instance.health;
    const ok = h.ok as boolean;
    console.log(
      `  ${ok ? pc.green("\u25CF") : pc.yellow("\u25CF")} ${pc.bold("Running")}  ${ok ? pc.green("healthy") : pc.yellow("degraded")}`,
    );
    console.log();
    console.log(`  ${pc.dim("PID")}          ${instance.pid}`);
    if (instance.port)
      console.log(`  ${pc.dim("Gateway")}      127.0.0.1:${instance.port}`);
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

  if (instance) {
    console.log(
      `  ${pc.yellow("\u25CF")} ${pc.bold("Running")}  (PID ${instance.pid}) ${pc.dim("\u2014 health endpoint not reachable, possibly still starting")}`,
    );
    console.log(`  Check ${pc.cyan("talon logs")} for details.\n`);
    return;
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
  const backendLabel: Record<NonNullable<Config["backend"]>, string> = {
    claude: "Anthropic Claude SDK",
    kilo: "Kilo (@kilocode/sdk)",
    opencode: "OpenCode (@opencode-ai/sdk)",
    codex: "OpenAI Codex CLI",
    "openai-agents": "OpenAI Agents (@openai/agents)",
  };
  console.log(
    `  ${pc.dim("Backend")}          ${pc.green(backendLabel[config.backend ?? "claude"])}`,
  );
  if (config.claudeBinary)
    console.log(
      `  ${pc.dim("Claude binary")}    ${pc.green(config.claudeBinary)}`,
    );
  if (config.codexApiKey)
    console.log(
      `  ${pc.dim("Codex API key")}    ${maskToken(config.codexApiKey)}`,
    );
  if (config.openaiApiKey)
    console.log(
      `  ${pc.dim("OpenAI API key")}   ${maskToken(config.openaiApiKey)}`,
    );
  if (config.openaiBaseUrl)
    console.log(`  ${pc.dim("OpenAI base URL")}  ${config.openaiBaseUrl}`);
  if (config.openaiApiMode)
    console.log(`  ${pc.dim("OpenAI API mode")}  ${config.openaiApiMode}`);
  if (config.discord?.botToken)
    console.log(
      `  ${pc.dim("Discord bot")}      ${maskToken(config.discord.botToken)} (app ${config.discord.applicationId.slice(0, 6)}…)`,
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

async function tailLogs(): Promise<void> {
  printBanner();
  if (!existsSync(LOG_FILE)) {
    console.log(
      `  No log file. Start the bot first: ${pc.cyan("talon start")}\n`,
    );
    return;
  }
  console.log(
    `  ${pc.dim("Tailing")} ${pc.dim(LOG_FILE)}\n  ${pc.dim("Press Ctrl+C to stop")}\n`,
  );
  const content = readFileSync(LOG_FILE, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines.slice(-30)) console.log(formatLogLine(line));
  let lastSize = lines.length;
  watchFile(LOG_FILE, { interval: 500 }, () => {
    try {
      const nl = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
      for (let i = lastSize; i < nl.length; i++)
        console.log(formatLogLine(nl[i]));
      lastSize = nl.length;
    } catch {
      /* ignore */
    }
  });
  await new Promise(() => {});
}

// ── Doctor ──────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  printBanner();
  console.log(`  ${pc.bold("Environment check")}\n`);
  let issues = 0;
  const major = parseInt(process.versions.node.split(".")[0], 10);
  console.log(
    major >= 24
      ? `  ${pc.green("\u2713")} Node.js ${process.versions.node}`
      : `  ${pc.red("\u2717")} Node.js ${process.versions.node} ${pc.dim("(need >=24)")}`,
  );
  if (major < 24) issues++;
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
  // Native plane: instantiate the embedded modules (Rust blake3, Zig
  // textops, Gleam scheduler-core) and verify a known answer from each.
  // Catches a corrupted install \u2014 truncated artifact, engine without
  // wasm support \u2014 here instead of mid-message in a frontend.
  try {
    const { blake3Hex } = await import("./native/blake3.js");
    const { splitMessage } = await import("./native/textops.js");
    const { backoffDelayMs } = await import("./native/scheduler-core.js");
    const emptyDigest = await blake3Hex("");
    const chunks = splitMessage("doctor check ".repeat(4), 16);
    const delayMs = backoffDelayMs(1, { baseMs: 1000, capMs: 2000, seed: 1 });
    const healthy =
      emptyDigest ===
        "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262" &&
      chunks.length > 1 &&
      chunks.every((c) => c.length <= 16) &&
      delayMs >= 750 &&
      delayMs <= 1250;
    if (healthy) {
      console.log(
        `  ${pc.green("\u2713")} Native modules: blake3 (Rust), textops (Zig), scheduler-core (Gleam)`,
      );
    } else {
      console.log(
        `  ${pc.red("\u2717")} Native modules loaded but returned unexpected results`,
      );
      issues++;
    }
  } catch (err) {
    console.log(
      `  ${pc.red("\u2717")} Native modules failed to load: ${pc.dim(err instanceof Error ? err.message : String(err))}`,
    );
    issues++;
  }
  // Backend-specific binary check (only required for the active backend).
  const doctorConfig = existsSync(CONFIG_FILE) ? loadConfig() : undefined;
  const activeBackend = doctorConfig?.backend ?? "claude";
  if (activeBackend === "claude") {
    try {
      const { execFileSync } = await import("node:child_process");
      if (doctorConfig?.claudeBinary) {
        const cmd = process.platform === "win32" ? "where" : "which";
        try {
          execFileSync(cmd, [doctorConfig.claudeBinary], { stdio: "pipe" });
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
        const lookupCmd = process.platform === "win32" ? "where" : "which";
        execFileSync(lookupCmd, ["claude"], { stdio: "pipe" });
        console.log(`  ${pc.green("\u2713")} Claude Code installed`);
      }
    } catch {
      console.log(`  ${pc.red("\u2717")} Claude Code not found`);
      issues++;
    }
  } else if (activeBackend === "codex") {
    try {
      const { execFileSync } = await import("node:child_process");
      const lookupCmd = process.platform === "win32" ? "where" : "which";
      execFileSync(lookupCmd, ["codex"], { stdio: "pipe" });
      console.log(`  ${pc.green("\u2713")} Codex CLI installed`);
      const { detectCodexAuth } = await import("./backend/codex/auth.js");
      const auth = detectCodexAuth({
        codexApiKey: doctorConfig?.codexApiKey,
        openaiApiKey: doctorConfig?.openaiApiKey,
        openaiBaseUrl: doctorConfig?.openaiBaseUrl,
      });
      for (const diagnostic of auth.diagnostics) {
        console.log(`  ${pc.yellow("!")} ${diagnostic}`);
      }
      if (auth.mode !== "none") {
        console.log(
          `  ${pc.green("\u2713")} Codex auth: ${pc.dim(
            auth.baseUrl ? `${auth.source} (${auth.baseUrl})` : auth.source,
          )}`,
        );
      } else {
        console.log(
          `  ${pc.yellow("!")} Codex auth missing (set CODEX_API_KEY, TALON_CODEX_KEY, codexApiKey, or run \`codex login\`)`,
        );
        issues++;
      }
    } catch {
      console.log(
        `  ${pc.red("\u2717")} Codex CLI not found (npm i -g @openai/codex)`,
      );
      issues++;
    }
  } else if (activeBackend === "kilo" || activeBackend === "opencode") {
    // Kilo / OpenCode are bundled as npm deps \u2014 no external binary to check.
    console.log(
      `  ${pc.green("\u2713")} ${activeBackend === "kilo" ? "Kilo" : "OpenCode"} SDK bundled`,
    );
  } else if (activeBackend === "openai-agents") {
    console.log(`  ${pc.green("\u2713")} OpenAI Agents SDK bundled`);
    const hasEnvKey = Boolean(process.env.OPENAI_API_KEY);
    const hasCfgKey = Boolean(doctorConfig?.openaiApiKey);
    const envBase = process.env.OPENAI_BASE_URL;
    const cfgBase = doctorConfig?.openaiBaseUrl;
    if (hasEnvKey || hasCfgKey) {
      const sources: string[] = [];
      if (hasEnvKey) sources.push("OPENAI_API_KEY env");
      if (hasCfgKey) sources.push("openaiApiKey in talon.json");
      console.log(
        `  ${pc.green("\u2713")} OpenAI Agents auth: ${pc.dim(sources.join(", "))}`,
      );
    } else {
      console.log(
        `  ${pc.yellow("!")} OpenAI Agents auth missing (set OPENAI_API_KEY or openaiApiKey in talon.json)`,
      );
      issues++;
    }
    if (envBase || cfgBase) {
      const baseSrc = envBase ? `env (${envBase})` : `config (${cfgBase})`;
      console.log(
        `  ${pc.green("\u2713")} OpenAI-compatible endpoint: ${pc.dim(baseSrc)}`,
      );
    } else {
      console.log(`  ${pc.dim("-")} Endpoint: api.openai.com (default)`);
    }
  }
  const instance = await findRunningInstance();
  if (instance) {
    console.log(`  ${pc.green("\u2713")} Bot is running (PID ${instance.pid})`);
  } else {
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
  const { flushTriggers } = await import("./storage/trigger-store.js");
  const { createTerminalFrontend } =
    await import("./frontend/terminal/index.js");
  const { Gateway } = await import("./core/engine/gateway.js");

  const { config } = await bootstrap({ frontendNames: ["terminal"] });

  // Override frontend for the backend — talon chat always uses terminal,
  // regardless of what the config file says. This prevents the backend from
  // spawning telegram-tools or teams-tools MCP servers and ensures the
  // system prompt loads terminal.md instead of teams.md/telegram.md.
  (config as Record<string, unknown>).frontend = "terminal";
  const { rebuildSystemPrompt } = await import("./util/config.js");
  const { getPluginPromptAdditions } = await import("./core/plugin.js");
  rebuildSystemPrompt(config, getPluginPromptAdditions());

  const gateway = new Gateway("chat");
  const frontend = createTerminalFrontend(config, gateway);
  await frontend.init();
  const { backend } = await initBackendAndDispatcher(config, frontend);
  gateway.backend = backend;

  // Mirror the index.ts wiring: keep the gateway's cached backend
  // reference in sync with chat-role rebinds.
  const { onBackendChange, roleHolder } =
    await import("./core/engine/backend-controller.js");
  const CHAT_ROLE_HOLDER = roleHolder("chat");
  onBackendChange((holder, newBackend) => {
    if (holder !== CHAT_ROLE_HOLDER) return;
    gateway.backend = newBackend;
  });

  process.on("SIGINT", () => {
    flushSessions();
    flushChatSettings();
    flushCronJobs();
    flushHistory();
    flushMediaIndex();
    flushTriggers();
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

  const running = (await findRunningInstance()) !== null;
  const config = loadConfig();
  const statusDot = running
    ? `${pc.green("\u25CF")} running`
    : `${pc.red("\u25CF")} stopped`;
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  const frontendLabel = fes
    .map((f) =>
      f === "telegram"
        ? "Telegram"
        : f === "teams"
          ? "Teams"
          : f === "discord"
            ? "Discord"
            : "Terminal",
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
//
// Lifecycle logic lives in core/daemon/ (pidfile, discovery, control);
// this section only renders the outcomes.

function renderStartOutcome(result: StartOutcome): void {
  if (result.ok) {
    const port = result.port ? `, gateway :${result.port}` : "";
    console.log(`  ${pc.green("●")} Talon started (PID ${result.pid}${port})`);
    console.log(`  ${pc.dim("Logs:")} talon logs`);
    console.log(`  ${pc.dim("Stop:")} talon stop\n`);
    return;
  }
  switch (result.reason) {
    case "already-running": {
      const inst = result.instance;
      const port = inst.port ? `, gateway :${inst.port}` : "";
      console.log(
        `  ${pc.yellow("!")} Talon is already running (PID ${inst.pid}${port})`,
      );
      if (inst.pidfileStale) {
        console.log(
          `  ${pc.dim("The PID file was stale — repaired from the live instance.")}`,
        );
      }
      console.log(
        `  Use ${pc.cyan("talon restart")} to restart, or ${pc.cyan("talon stop")} to stop.\n`,
      );
      return;
    }
    case "spawn-failed":
      console.log(
        `  ${pc.red("✖")} Failed to start Talon${result.detail ? pc.dim(` — ${result.detail}`) : ""}\n`,
      );
      return;
    case "exited-early":
      console.log(`  ${pc.red("✖")} Talon ${result.detail} during startup`);
      console.log(`  Check ${pc.cyan("talon logs")} for details.\n`);
      return;
    case "boot-timeout":
      console.log(
        `  ${pc.yellow("!")} Talon was spawned but has not reported healthy yet.`,
      );
      console.log(
        `  It may still be starting — check ${pc.cyan("talon status")} and ${pc.cyan("talon logs")}.\n`,
      );
      return;
  }
}

function renderStopOutcome(result: StopOutcome): void {
  if (result.stopped) {
    const how =
      result.method === "http"
        ? "graceful"
        : result.method === "sigterm"
          ? "SIGTERM"
          : "SIGKILL";
    console.log(`  ${pc.red("●")} Talon stopped (PID ${result.pid}, ${how})\n`);
    return;
  }
  if (result.reason === "not-running") {
    console.log(`  ${pc.dim("●")} Talon is not running\n`);
    return;
  }
  console.log(
    `  ${pc.red("✖")} Could not stop Talon (PID ${result.pid}) — the process did not exit\n`,
  );
}

async function daemonStart(): Promise<void> {
  renderStartOutcome(await startDaemon({ pkgRoot: PKG_ROOT }));
}

async function daemonStop(): Promise<void> {
  renderStopOutcome(await stopDaemon());
}

async function daemonRestart(): Promise<void> {
  const { stop, start } = await restartDaemon({ pkgRoot: PKG_ROOT });
  renderStopOutcome(stop);
  renderStartOutcome(start);
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
  case "start":
    printBanner();
    await daemonStart();
    break;
  case "stop":
    printBanner();
    await daemonStop();
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
  case "--version":
  case "-v": {
    // Read at invocation (not import) so `--version` stays dependency-free
    // and works before any config exists — the publish smoke test runs it
    // against the freshly installed package.
    const pkg = JSON.parse(
      readFileSync(resolve(PKG_ROOT, "package.json"), "utf-8"),
    ) as { version: string };
    console.log(pkg.version);
    break;
  }
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
    console.log(`    ${pc.cyan("doctor")}     Validate environment`);
    console.log(`    ${pc.cyan("--version")}  Print the package version`);
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
