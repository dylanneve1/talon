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
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, readFileSync, mkdirSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";

// Resolve paths relative to the package root, not cwd
const PKG_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const WORKSPACE = resolve(PKG_ROOT, "workspace");
const CONFIG_FILE = resolve(WORKSPACE, "talon.json");
const LOG_FILE = resolve(WORKSPACE, "talon.log");
const HEALTH_URL = "http://127.0.0.1:19876/health";

// ── Branding ────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("🦅 Talon"))}`);
  console.log(`  ${pc.dim("Claude-powered Telegram bot")}`);
  console.log();
}

// ── Config ──────────────────────────────────────────────────────────────────

type Config = {
  botToken: string;
  model: string;
  concurrency: number;
  pulse: boolean;
  pulseIntervalMs: number;
  adminUserId?: number;
  apiId?: number;
  apiHash?: string;
  maxMessageLength: number;
};

const DEFAULTS: Config = {
  botToken: "",
  model: "claude-sonnet-4-6",
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
  } catch { /* corrupt */ }
  return { ...DEFAULTS };
}

function saveConfig(config: Config): void {
  if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });
  // Don't write undefined fields — keep the JSON clean
  const clean = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined),
  );
  writeFileAtomic.sync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n");
}

function maskToken(token: string): string {
  if (!token || token.length < 10) return pc.red("not set");
  return pc.green(token.slice(0, 8) + "..." + token.slice(-4));
}

// ── Setup wizard ────────────────────────────────────────────────────────────

async function runSetup(): Promise<void> {
  printBanner();
  p.intro(pc.inverse(" Setup Wizard "));

  const config = loadConfig();

  const botToken = await p.text({
    message: "Bot token",
    placeholder: "Paste your token from @BotFather",
    initialValue: config.botToken || undefined,
    validate: (v) => {
      if (!v) return "Token is required";
      if (!v.includes(":")) return "Invalid format — should contain ':'";
    },
  });
  if (p.isCancel(botToken)) { p.cancel("Cancelled."); process.exit(0); }

  const model = await p.select({
    message: "Default model",
    initialValue: config.model,
    options: [
      { value: "claude-sonnet-4-6", label: `Sonnet 4.6  ${pc.dim("— fast, balanced")}` },
      { value: "claude-opus-4-6", label: `Opus 4.6    ${pc.dim("— smartest")}` },
      { value: "claude-haiku-4-5", label: `Haiku 4.5   ${pc.dim("— fastest, cheapest")}` },
    ],
  });
  if (p.isCancel(model)) { p.cancel("Cancelled."); process.exit(0); }

  const adminId = await p.text({
    message: "Your Telegram user ID",
    placeholder: "optional — message @userinfobot to find yours",
    initialValue: config.adminUserId ? String(config.adminUserId) : "",
  });
  if (p.isCancel(adminId)) { p.cancel("Cancelled."); process.exit(0); }

  const pulse = await p.confirm({
    message: "Enable pulse? (periodic group engagement)",
    initialValue: config.pulse,
  });
  if (p.isCancel(pulse)) { p.cancel("Cancelled."); process.exit(0); }

  const wantUserbot = await p.confirm({
    message: "Set up userbot for full history access?",
    initialValue: !!(config.apiId && config.apiHash),
  });
  if (p.isCancel(wantUserbot)) { p.cancel("Cancelled."); process.exit(0); }

  let apiId: number | undefined;
  let apiHash: string | undefined;

  if (wantUserbot) {
    p.note(
      "Get these from https://my.telegram.org → API development tools",
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
    if (p.isCancel(id)) { p.cancel("Cancelled."); process.exit(0); }

    const hash = await p.text({
      message: "API Hash",
      initialValue: config.apiHash || "",
    });
    if (p.isCancel(hash)) { p.cancel("Cancelled."); process.exit(0); }

    if (id) apiId = parseInt(id, 10);
    if (hash) apiHash = hash;
  }

  const newConfig: Config = {
    botToken,
    model: model as string,
    concurrency: config.concurrency,
    pulse: pulse as boolean,
    pulseIntervalMs: config.pulseIntervalMs,
    adminUserId: adminId ? parseInt(adminId, 10) || undefined : undefined,
    apiId,
    apiHash,
    maxMessageLength: config.maxMessageLength,
  };

  const s = p.spinner();
  s.start("Saving configuration");
  saveConfig(newConfig);
  s.stop("Configuration saved");

  p.outro(`Run ${pc.cyan(pc.bold("npm start"))} to launch Talon`);

  if (apiId && apiHash) {
    console.log(`  ${pc.yellow("!")} Run ${pc.cyan("npx tsx src/login.ts")} to authenticate the userbot first.`);
    console.log();
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

async function showStatus(): Promise<void> {
  printBanner();

  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const h = await resp.json() as Record<string, unknown>;
      const ok = h.ok as boolean;

      console.log(`  ${ok ? pc.green("●") : pc.yellow("●")} ${pc.bold("Running")}  ${ok ? pc.green("healthy") : pc.yellow("degraded")}`);
      console.log();
      console.log(`  ${pc.dim("Uptime")}       ${formatUptime(h.uptime as number)}`);
      console.log(`  ${pc.dim("Memory")}       ${h.memory} MB`);
      console.log(`  ${pc.dim("Sessions")}     ${h.sessions}`);
      console.log(`  ${pc.dim("Messages")}     ${h.messages}`);
      console.log(`  ${pc.dim("Queue")}        ${h.queue} pending`);
      console.log(`  ${pc.dim("Errors")}       ${h.errors}`);
      console.log(`  ${pc.dim("Last active")}  ${h.lastActivity}`);
      console.log();
      return;
    }
  } catch { /* not running */ }

  console.log(`  ${pc.red("●")} ${pc.bold("Stopped")}`);
  console.log();

  if (existsSync(CONFIG_FILE)) {
    const config = loadConfig();
    console.log(`  ${pc.dim("Token")}   ${config.botToken ? pc.green("configured") : pc.red("not set")}`);
    console.log(`  ${pc.dim("Model")}   ${config.model}`);
    console.log(`  ${pc.dim("Config")}  ${pc.dim(CONFIG_FILE)}`);
    console.log();
    console.log(`  Start with ${pc.cyan("npm start")}`);
  } else {
    console.log(`  Run ${pc.cyan("talon setup")} to get started.`);
  }
  console.log();
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
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
  console.log(`  ${pc.dim("Bot token")}        ${maskToken(config.botToken)}`);
  console.log(`  ${pc.dim("Model")}            ${config.model}`);
  console.log(`  ${pc.dim("Concurrency")}      ${config.concurrency}`);
  console.log(`  ${pc.dim("Pulse")}            ${config.pulse ? pc.green("on") : pc.dim("off")} ${pc.dim(`(${Math.round(config.pulseIntervalMs / 60000)}m)`)}`);
  console.log(`  ${pc.dim("Admin")}            ${config.adminUserId || pc.dim("not set")}`);
  console.log(`  ${pc.dim("Userbot")}          ${config.apiId ? pc.green("configured") : pc.dim("not set")}`);
  console.log(`  ${pc.dim("Max msg length")}   ${config.maxMessageLength}`);
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
    const time = pc.dim(new Date(obj.time as number).toTimeString().slice(0, 8));
    const comp = pc.cyan((obj.component as string ?? "?").padEnd(10));
    const err = obj.err ? pc.red(` (${obj.err})`) : "";
    return `  ${time} ${level} ${comp} ${obj.msg}${err}`;
  } catch {
    return `  ${line}`;
  }
}

async function tailLogs(): Promise<void> {
  printBanner();

  if (!existsSync(LOG_FILE)) {
    console.log(`  No log file. Start the bot first: ${pc.cyan("npm start")}\n`);
    return;
  }

  console.log(`  ${pc.dim("Tailing")} ${pc.dim(LOG_FILE)}`);
  console.log(`  ${pc.dim("Press Ctrl+C to stop")}\n`);

  const content = readFileSync(LOG_FILE, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines.slice(-30)) {
    console.log(formatLogLine(line));
  }

  // Follow new lines
  let lastSize = lines.length;
  watchFile(LOG_FILE, { interval: 500 }, () => {
    try {
      const newContent = readFileSync(LOG_FILE, "utf-8");
      const newLines = newContent.trim().split("\n");
      for (let i = lastSize; i < newLines.length; i++) {
        console.log(formatLogLine(newLines[i]));
      }
      lastSize = newLines.length;
    } catch { /* ignore */ }
  });

  await new Promise(() => {}); // block until Ctrl+C
}

// ── Doctor ──────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  printBanner();
  console.log(`  ${pc.bold("Environment check")}\n`);

  let issues = 0;

  // Node version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (major >= 22) {
    console.log(`  ${pc.green("\u2713")} Node.js ${nodeVersion}`);
  } else {
    console.log(`  ${pc.red("\u2717")} Node.js ${nodeVersion} ${pc.dim("(need >=22)")}`);
    issues++;
  }

  // Config file
  if (existsSync(CONFIG_FILE)) {
    const config = loadConfig();
    if (config.botToken) {
      console.log(`  ${pc.green("\u2713")} Bot token configured`);
    } else {
      console.log(`  ${pc.red("\u2717")} Bot token missing in ${pc.dim("talon.json")}`);
      issues++;
    }
    console.log(`  ${pc.green("\u2713")} Config: ${pc.dim(CONFIG_FILE)}`);
  } else {
    console.log(`  ${pc.red("\u2717")} No config file ${pc.dim("(run talon setup)")}`);
    issues++;
  }

  // Workspace
  if (existsSync(WORKSPACE)) {
    console.log(`  ${pc.green("\u2713")} Workspace: ${pc.dim(WORKSPACE)}`);
  } else {
    console.log(`  ${pc.yellow("!")} Workspace missing ${pc.dim("(will be created on start)")}`);
  }

  // Claude Code
  try {
    const { execSync } = await import("node:child_process");
    execSync("which claude", { stdio: "pipe" });
    console.log(`  ${pc.green("\u2713")} Claude Code installed`);
  } catch {
    console.log(`  ${pc.red("\u2717")} Claude Code not found ${pc.dim("(npm i -g @anthropic-ai/claude-code)")}`);
    issues++;
  }

  // Log file
  if (existsSync(LOG_FILE)) {
    const { statSync } = await import("node:fs");
    const size = statSync(LOG_FILE).size;
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    console.log(`  ${pc.green("\u2713")} Log file: ${sizeMB}MB`);
  } else {
    console.log(`  ${pc.dim("-")} No log file yet`);
  }

  // Bot health
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      console.log(`  ${pc.green("\u2713")} Bot is running`);
    }
  } catch {
    console.log(`  ${pc.dim("-")} Bot is not running`);
  }

  console.log();
  if (issues === 0) {
    console.log(`  ${pc.green("All checks passed.")}\n`);
  } else {
    console.log(`  ${pc.yellow(`${issues} issue(s) found.`)}\n`);
  }
}

// ── Terminal chat ───────────────────────────────────────────────────────────

async function startChat(): Promise<void> {
  // Suppress console logs — terminal frontend owns stdout
  process.env.TALON_QUIET = "1";

  const { loadConfig } = await import("./util/config.js");
  const { initWorkspace } = await import("./util/workspace.js");
  const { initAgent, handleMessage } = await import("./backend/claude-sdk/index.js");
  const { loadSessions, flushSessions } = await import("./storage/sessions.js");
  const { loadChatSettings, flushChatSettings } = await import("./storage/chat-settings.js");
  const { loadCronJobs, flushCronJobs } = await import("./storage/cron-store.js");
  const { loadHistory, flushHistory } = await import("./storage/history.js");
  const { initDispatcher } = await import("./core/dispatcher.js");
  const { initPulse, resetPulseTimer } = await import("./core/pulse.js");
  const { createTerminalFrontend } = await import("./frontend/terminal/index.js");

  const config = loadConfig();
  initWorkspace(config.workspace);
  loadSessions();
  loadChatSettings();
  loadCronJobs();
  loadHistory();

  const frontend = createTerminalFrontend(config);
  await frontend.init();

  initAgent(config, frontend.getBridgePort);

  initDispatcher({
    backend: { query: (params) => handleMessage(params) },
    context: frontend.context,
    sendTyping: frontend.sendTyping,
    onActivity: () => resetPulseTimer(),
    concurrency: config.concurrency,
  });

  initPulse();

  // Shutdown handler
  process.on("SIGINT", () => {
    flushSessions();
    flushChatSettings();
    flushCronJobs();
    flushHistory();
    frontend.stop();
    process.exit(0);
  });

  await frontend.start();
}

// ── Main menu ───────────────────────────────────────────────────────────────

async function mainMenu(): Promise<void> {
  printBanner();

  // First run — go straight to setup
  if (!existsSync(CONFIG_FILE) || !loadConfig().botToken) {
    p.intro(pc.inverse(" Welcome to Talon "));
    p.note(
      "Talon is a Claude-powered Telegram bot.\nLet's get you set up in about 60 seconds.",
      "First time?",
    );
    await runSetup();
    return;
  }

  // Check if bot is running
  let running = false;
  try {
    const resp = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    running = resp.ok;
  } catch { /* not running */ }

  const statusDot = running
    ? `${pc.green("●")} running`
    : `${pc.red("●")} stopped`;

  const action = await p.select({
    message: `Talon ${statusDot}`,
    options: [
      ...(!running ? [{ value: "start" as const, label: "Start Telegram bot" }] : []),
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
      console.log(`\n  Starting Talon...\n`);
      process.chdir(PKG_ROOT);
      await import("./index.js");
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

// ── Entry point ─────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "setup":   runSetup(); break;
  case "status":  showStatus(); break;
  case "config":  viewConfig(); break;
  case "logs":    tailLogs(); break;
  case "start":   process.chdir(PKG_ROOT); import("./index.js"); break;
  case "chat":    process.chdir(PKG_ROOT); startChat(); break;
  case "doctor":  runDoctor(); break;
  case "--help":
  case "-h":
    printBanner();
    console.log("  Usage: talon [command]\n");
    console.log("  Commands:");
    console.log(`    ${pc.cyan("setup")}    Guided setup wizard`);
    console.log(`    ${pc.cyan("start")}    Start the Telegram bot`);
    console.log(`    ${pc.cyan("chat")}     Chat with Talon in the terminal`);
    console.log(`    ${pc.cyan("status")}   Show bot health`);
    console.log(`    ${pc.cyan("config")}   View/edit configuration`);
    console.log(`    ${pc.cyan("logs")}     Tail log file`);
    console.log(`    ${pc.cyan("doctor")}   Validate environment`);
    console.log();
    console.log(`  Run ${pc.cyan("talon")} with no args for interactive menu.\n`);
    break;
  case undefined:
    mainMenu();
    break;
  default:
    console.error(`  Unknown command: ${command}\n`);
    console.error(`  Run ${pc.cyan("talon --help")} for usage.\n`);
    process.exit(1);
}
