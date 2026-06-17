/**
 * `talon status` — render the running instance's health, or a stopped summary
 * pulled from the config file.
 */

import pc from "picocolors";
import { existsSync } from "node:fs";
import { findRunningInstance } from "../core/daemon/discovery.js";
import { printBanner, loadConfig } from "./config.js";
import { CONFIG_FILE } from "./context.js";

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export async function showStatus(): Promise<void> {
  printBanner();
  const instance = await findRunningInstance();

  if (instance?.health) {
    const h = instance.health;
    const ok = h.ok as boolean;
    console.log(
      `  ${ok ? pc.green("●") : pc.yellow("●")} ${pc.bold("Running")}  ${ok ? pc.green("healthy") : pc.yellow("degraded")}`,
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
      `  ${pc.yellow("●")} ${pc.bold("Running")}  (PID ${instance.pid}) ${pc.dim("— health endpoint not reachable, possibly still starting")}`,
    );
    console.log(`  Check ${pc.cyan("talon logs")} for details.\n`);
    return;
  }

  console.log(`  ${pc.red("●")} ${pc.bold("Stopped")}\n`);
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
