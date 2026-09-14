/**
 * Teams poll loop — Graph API chat polling is the whole receive side (no
 * Bot Framework, no inbound endpoint). Each tick fetches the newest
 * messages, cuts at the last one seen, and hands the rest — oldest first —
 * to the slash-command router or a model turn.
 */

import { log, logError } from "../../util/log.js";
import { handleSlashCommand } from "./commands.js";
import type { ChatMessage } from "./graph.js";
import type { TeamsRuntime } from "./runtime.js";
import { runTurn } from "./turn.js";

/**
 * Messages arrive newest first; everything before `lastSeenId` is new. IDs
 * are opaque strings, so this is a cut at the seen id, not a comparison.
 */
export function selectNewMessages(
  messages: ChatMessage[],
  lastSeenId: string | null,
): ChatMessage[] {
  const fresh: ChatMessage[] = [];
  for (const msg of messages) {
    if (lastSeenId && msg.id === lastSeenId) break;
    fresh.push(msg);
  }
  return fresh;
}

// Skip bot/workflow messages by display name (echo loop prevention).
// We do NOT filter by user ID — the authenticated user also sends
// real messages that Talon should respond to.
function isBotEcho(runtime: TeamsRuntime, msg: ChatMessage): boolean {
  return (
    !!runtime.botDisplayName &&
    msg.senderName.toLowerCase() === runtime.botDisplayName.toLowerCase()
  );
}

async function handleMessage(
  runtime: TeamsRuntime,
  msg: ChatMessage,
): Promise<void> {
  const talonChatId = `teams_chat_${msg.chatId}`;
  if (await handleSlashCommand(runtime, msg, talonChatId)) return;

  log(
    "teams",
    `[${msg.senderName}]: ${msg.text.slice(0, 80)}${msg.text.length > 80 ? "..." : ""}`,
  );
  runTurn(runtime, msg, talonChatId);
}

async function poll(runtime: TeamsRuntime, chatId: string): Promise<void> {
  if (runtime.polling) return;
  runtime.polling = true;

  try {
    if (!runtime.graphClient) return;
    const messages = await runtime.graphClient.getChatMessages(chatId, 20);
    const newMessages = selectNewMessages(messages, runtime.lastSeenMessageId);

    if (newMessages.length > 0) {
      runtime.lastSeenMessageId = newMessages[0].id;
    }

    // Process in chronological order (oldest first)
    for (const msg of newMessages.reverse()) {
      if (!msg.text.trim()) continue;
      if (msg.edited) continue;
      if (isBotEcho(runtime, msg)) continue;
      await handleMessage(runtime, msg);
    }
  } catch (err) {
    logError(
      "teams",
      `Poll error: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    runtime.polling = false;
  }
}

/** Initial poll, then the interval; the timer lives on the runtime so stop can clear it. */
export async function startPolling(
  runtime: TeamsRuntime,
  chatId: string,
): Promise<void> {
  await poll(runtime, chatId);
  runtime.pollTimer = setInterval(
    () => void poll(runtime, chatId),
    runtime.pollIntervalMs,
  );
}

export function stopPolling(runtime: TeamsRuntime): void {
  if (runtime.pollTimer) {
    clearInterval(runtime.pollTimer);
    runtime.pollTimer = null;
  }
}
