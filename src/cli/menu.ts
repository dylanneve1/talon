/**
 * Interactive main menu — shown when `talon` runs with no subcommand. Runs
 * setup on first launch, otherwise offers start/stop/chat/status/config/etc.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { findRunningInstance } from "../core/daemon/discovery.js";
import { printBanner, loadConfig, isConfigured } from "./config.js";
import { CONFIG_FILE, PKG_ROOT } from "./context.js";
import { runSetup } from "./setup.js";
import { showStatus } from "./status.js";
import { viewConfig } from "./config-view.js";
import { tailLogs } from "./logs.js";
import { startChat } from "./chat.js";
import { daemonStart, daemonStop, daemonRestart } from "./daemon.js";

export async function mainMenu(): Promise<void> {
  printBanner();
  if (!existsSync(CONFIG_FILE) || !isConfigured(loadConfig())) {
    p.intro(pc.inverse(" Welcome to Talon "));
    p.note(
      "Talon is an agentic AI harness.\nRuns on Telegram, Discord, Teams, Terminal,\nand the native client bridge.\nLet's get you set up.",
      "First time?",
    );
    await runSetup();
    return;
  }

  const running = (await findRunningInstance()) !== null;
  const config = loadConfig();
  const statusDot = running
    ? `${pc.green("●")} running`
    : `${pc.red("●")} stopped`;
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
            : f === "native"
              ? "Native"
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
