/**
 * Slash commands on WhatsApp — `/model`, `/effort`, `/settings`,
 * `/reset`, `/status`, `/help`.
 *
 * WhatsApp has no inline buttons, so everything Telegram does with a
 * picker is done here with typed arguments: `/model` prints a numbered
 * catalog, `/model 3` (or `/model <id>`, `/model <backend>`) picks from
 * it. The state changes come from frontend/shared/model-commands.ts;
 * this module only parses, authorises, and renders.
 *
 * Replies are written in Markdown — `sendText` translates them into
 * WhatsApp's dialect and splits long listings into bubbles.
 */

import { log } from "../../util/log.js";
import { recordMessageProcessed } from "../../util/watchdog.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { isPulseEnabled } from "../../core/background/pulse.js";
import {
  DEFAULT_PULSE_INTERVAL_MS,
  formatBytes,
  formatDuration,
  formatModelLabel,
  formatTokenCount,
  formatUsd,
} from "../shared/format.js";
import {
  collectSessionStatus,
  performSessionReset,
  type SessionStatusData,
} from "../shared/session-status.js";
import { formatCacheTempLine } from "../shared/status-context.js";
import {
  describeChatEffort,
  describeChatModels,
  matchBackendArg,
  resetChatBackend,
  resetChatModel,
  resolveChatBackendPair,
  selectChatModel,
  setChatEffortLevel,
  switchChatBackend,
  type ModelCommandDeps,
  type ModelOverview,
} from "../shared/model-commands.js";
import { sendText } from "./actions/send.js";
import { identityAllowed, type Identity } from "./identity.js";
import type { WhatsAppChatInfo } from "./registry.js";
import type { WhatsAppRuntime } from "./runtime.js";

const COMMAND_NAMES = [
  "model",
  "effort",
  "settings",
  "reset",
  "status",
  "help",
] as const;

type WhatsAppCommandName = (typeof COMMAND_NAMES)[number];

export type WhatsAppCommand = { name: WhatsAppCommandName; arg: string };

/** The inbound message fields the command layer needs. */
export type CommandInbound = {
  chat: WhatsAppChatInfo;
  text: string;
  senderName: string;
  identity: Identity;
  isGroup: boolean;
};

/** How many catalog entries `/model` prints before pointing at `/model <id>`. */
const MAX_LISTED_MODELS = 40;

/**
 * Parse a slash command out of message text. Group messages in mention
 * mode arrive as "@<number> /model", so leading @mentions are skipped.
 * Returns null for anything that is not one of ours, including bare
 * text that merely starts with a slash (a path, a fraction).
 */
export function parseWhatsAppCommand(text: string): WhatsAppCommand | null {
  const body = text.replace(/^(?:@\S+\s*)+/, "").trim();
  const match = /^\/([a-zA-Z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!(COMMAND_NAMES as readonly string[]).includes(name)) return null;
  return { name: name as WhatsAppCommandName, arg: (match[2] ?? "").trim() };
}

/** Commands that change chat state, as opposed to showing it. */
function isMutating(cmd: WhatsAppCommand): boolean {
  if (cmd.name === "reset") return true;
  return (cmd.name === "model" || cmd.name === "effort") && cmd.arg !== "";
}

/**
 * May this sender change the chat's settings? A DM sender already passed
 * the allowlist. In a group, the same allowlist is the admin rule — the
 * people in `allowedJids` are the operator's, everyone else may read
 * settings but not change them. With no allowlist at all there is no
 * admin to distinguish, the way Telegram opens up with no adminUserId.
 */
export function canChangeSettings(
  runtime: WhatsAppRuntime,
  inbound: Pick<CommandInbound, "isGroup" | "identity">,
): boolean {
  if (!inbound.isGroup || runtime.allowedDms.size === 0) return true;
  return identityAllowed(inbound.identity, runtime.allowedDms);
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderModelOverview(view: ModelOverview): string {
  const lines: string[] = [];
  lines.push(
    view.activeModel
      ? `**Model:** \`${view.activeModel}\`${
          view.activeDisplay && view.activeDisplay !== view.activeModel
            ? ` (${view.activeDisplay})`
            : ""
        }${view.hasModelOverride ? " — chat override" : ""}`
      : "**Model:** none selected — messages will be refused until you pick one",
  );
  lines.push(
    `**Backend:** ${view.backendLabel} (\`${view.backendId}\`)${view.hasBackendOverride ? " — chat override" : ""}`,
  );
  if (view.backends.length > 1) {
    lines.push(
      `Backends: ${view.backends.map((b) => `\`${b.id}\``).join(", ")} — \`/model <backend>\` switches (session restarts).`,
    );
  }
  if (view.choices.length === 0) {
    lines.push(
      "",
      "This backend has no browsable catalog; `/model <id>` sets one directly.",
    );
  } else {
    lines.push("", `**Models** (${view.choices.length}):`);
    for (const c of view.choices.slice(0, MAX_LISTED_MODELS)) {
      const marker = c.id === view.activeModel ? " ✓" : "";
      const free = c.free ? " · free" : "";
      lines.push(`${c.index}. ${c.displayName} — \`${c.id}\`${free}${marker}`);
    }
    if (view.choices.length > MAX_LISTED_MODELS) {
      lines.push(
        `… ${view.choices.length - MAX_LISTED_MODELS} more — \`/model <id>\` picks any of them.`,
      );
    }
  }
  lines.push(
    "",
    "`/model <number>` or `/model <id>` picks; `/model default` clears the chat's pick" +
      (view.hasBackendOverride
        ? "; `/model backend default` reverts the backend."
        : "."),
  );
  return lines.join("\n");
}

function renderSettings(
  view: ModelOverview,
  effort: { current: string; levels: string[] },
  pulseOn: boolean,
  pulseIntervalMs: number | undefined,
  freeOnly: boolean,
): string {
  const lines = [
    "**Settings**",
    `Model: \`${view.activeModel ?? "none selected"}\`${view.hasModelOverride ? " (chat override)" : ""}`,
    `Backend: ${view.backendLabel} (\`${view.backendId}\`)${view.hasBackendOverride ? " (chat override)" : ""}`,
    `Effort: ${effort.current}${effort.levels.length ? ` — levels: ${effort.levels.join(", ")}` : ""}`,
    `Pulse: ${pulseOn ? "on" : "off"} (every ${formatDuration(pulseIntervalMs ?? DEFAULT_PULSE_INTERVAL_MS)})`,
  ];
  if (freeOnly) lines.push("Free-only models: on");
  lines.push(
    "",
    "Change with `/model`, `/effort`; `/reset` starts a fresh session.",
  );
  return lines.join("\n");
}

function renderStatus(s: SessionStatusData): string {
  const used = s.context.known ? formatTokenCount(s.context.used) : "unknown";
  const max = s.context.max > 0 ? formatTokenCount(s.context.max) : "unknown";
  const pct = s.context.known ? `${s.context.pct}%` : "unknown";
  const lines = [
    `**Talon** · \`${formatModelLabel(s.activeModel)}\`${s.backendLabel ? ` · ${s.backendLabel}` : ""} · effort: ${s.effortName}${s.turnInProgress ? " · ⏳ turn running" : ""}`,
    "",
    `**Context** ${used} / ${max} (${pct})${s.context.warn ? " ⚠️ consider /reset" : ""}`,
    `\`${s.context.bar}\``,
    "",
    "**Session stats**",
    `Response: last ${s.lastResponseMs ? formatDuration(s.lastResponseMs) : "—"} · avg ${s.avgResponseMs ? formatDuration(s.avgResponseMs) : "—"} · best ${s.fastestMs ? formatDuration(s.fastestMs) : "—"}`,
    `Turns: ${s.turns}${s.turnsModelLabel ? ` (${formatModelLabel(s.turnsModelLabel)})` : ""}`,
    `Tokens: in ${formatTokenCount(s.inputTokens)} · out ${formatTokenCount(s.outputTokens)}${s.costUsd > 0 ? ` · cost ${formatUsd(s.costUsd)}` : ""}`,
  ];
  if (s.cache) {
    lines.push(
      `Cache: ${s.cache.hitPct}% hit · read ${formatTokenCount(s.cache.read)}${s.cache.showsWrite ? ` · write ${formatTokenCount(s.cache.write)}` : ""}`,
    );
  }
  if (s.cacheTemp) lines.push(formatCacheTempLine(s.cacheTemp));
  if (s.plan) {
    lines.push(
      "",
      `**Plan**${s.plan.plan ? ` ${s.plan.plan}` : ""}${s.plan.ageLabel ? ` (${s.plan.ageLabel})` : ""}`,
      ...s.plan.windows.map(
        (w) =>
          `\`${w.label.padEnd(6)}${w.bar} ${String(w.percent).padStart(3)}%\`${w.resetLabel ? ` reset ${w.resetLabel}` : ""}`,
      ),
    );
  }
  lines.push(
    "",
    `**Pulse** ${s.pulseOn ? "on" : "off"}`,
    `**Workspace** ${formatBytes(s.diskBytes)}`,
    `**Session** ${s.sessionName ? `"${s.sessionName}" ` : ""}${s.sessionId ? `\`${s.sessionId.slice(0, 8)}…\`` : "(new)"} · ${s.sessionAge} old`,
    `**Uptime** ${s.uptime} · ${s.activeSessionCount} active session${s.activeSessionCount === 1 ? "" : "s"}`,
    `**Runtime** ${s.runtime} · ${formatBytes(s.rssBytes)} RSS`,
  );
  return lines.join("\n");
}

const HELP_TEXT = [
  "**Commands**",
  "/model — list backends and models; `/model <n|id>` picks, `/model <backend>` switches",
  "/effort — show or set thinking effort: `/effort high`, `/effort adaptive`",
  "/settings — this chat's model, backend, effort and pulse",
  "/status — session info, context usage and stats",
  "/reset — start a fresh session (chat log kept)",
  "/help — this message",
].join("\n");

// ── Handlers ────────────────────────────────────────────────────────────────

async function runModelCommand(
  chatId: string,
  arg: string,
  deps: ModelCommandDeps,
): Promise<string> {
  if (!arg) return renderModelOverview(await describeChatModels(chatId, deps));
  const lower = arg.toLowerCase();
  // `/reset` keeps history on WhatsApp because the local store is the only
  // chat record; a backend switch keeps it for the same reason.
  if (lower === "backend default" || lower === "backend reset") {
    return (await resetChatBackend(chatId, deps, { keepHistory: true })).text;
  }
  if (lower === "reset" || lower === "default") {
    return (await resetChatModel(chatId, deps)).text;
  }
  const backend = matchBackendArg(arg, deps.config);
  if (backend) {
    return (
      await switchChatBackend(chatId, backend, deps, { keepHistory: true })
    ).text;
  }
  return (await selectChatModel(chatId, arg, deps)).text;
}

async function runEffortCommand(
  chatId: string,
  arg: string,
  deps: ModelCommandDeps,
): Promise<string> {
  if (arg) return (await setChatEffortLevel(chatId, arg, deps)).text;
  const effort = await describeChatEffort(chatId, deps);
  if (effort.levels.length === 0) {
    return `No reasoning levels available for ${effort.activeModel ?? "the active model"} on backend ${effort.backendId}.`;
  }
  return `**Effort:** ${effort.current}\nLevels: ${effort.levels.join(", ")}, or adaptive — \`/effort <level>\` sets one.`;
}

async function runSettingsCommand(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<string> {
  const [view, effort] = await Promise.all([
    describeChatModels(chatId, deps),
    describeChatEffort(chatId, deps),
  ]);
  const sets = getChatSettings(chatId);
  return renderSettings(
    view,
    effort,
    isPulseEnabled(chatId),
    sets.pulseIntervalMs,
    sets.freeOnly === true,
  );
}

async function runStatusCommand(
  chatId: string,
  deps: ModelCommandDeps,
): Promise<string> {
  const { backend, backendId } = resolveChatBackendPair(chatId, deps);
  return renderStatus(
    await collectSessionStatus(chatId, deps.config, backend, backendId),
  );
}

async function runResetCommand(
  chatId: string,
  senderName: string,
  deps: ModelCommandDeps,
): Promise<string> {
  // The local history store is WhatsApp's only chat record — a reset
  // clears the model's session, not the conversation log.
  await performSessionReset(
    chatId,
    resolveChatBackendPair(chatId, deps).backend,
    {
      keepHistory: true,
    },
  );
  log("whatsapp", `Session reset by ${senderName}`);
  return "Session cleared.";
}

/** The reply text for one parsed command. */
export async function executeWhatsAppCommand(
  runtime: WhatsAppRuntime,
  cmd: WhatsAppCommand,
  inbound: CommandInbound,
): Promise<string> {
  const chatId = inbound.chat.chatId;
  const deps: ModelCommandDeps = {
    config: runtime.config,
    gateway: runtime.gateway,
  };
  if (isMutating(cmd) && !canChangeSettings(runtime, inbound)) {
    return "Only allowlisted users can change settings in a group.";
  }
  switch (cmd.name) {
    case "model":
      return runModelCommand(chatId, cmd.arg, deps);
    case "effort":
      return runEffortCommand(chatId, cmd.arg, deps);
    case "settings":
      return runSettingsCommand(chatId, deps);
    case "status":
      return runStatusCommand(chatId, deps);
    case "reset":
      return runResetCommand(chatId, inbound.senderName, deps);
    case "help":
      return HELP_TEXT;
  }
}

/**
 * Handle a slash command if the message is one. True when it was — the
 * caller then skips the agent turn. Delivery failures are swallowed:
 * the state change already happened and is visible on the next
 * `/settings`; a dead socket is the connection loop's problem.
 */
export async function handleWhatsAppCommand(
  runtime: WhatsAppRuntime,
  inbound: CommandInbound,
): Promise<boolean> {
  const cmd = parseWhatsAppCommand(inbound.text);
  if (!cmd) return false;
  const reply = await executeWhatsAppCommand(runtime, cmd, inbound);
  const sock = runtime.sock;
  if (sock) {
    await sendText(
      { sock, gateway: runtime.gateway },
      inbound.chat,
      reply,
    ).catch(() => {});
  }
  recordMessageProcessed();
  return true;
}
