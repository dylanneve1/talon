/**
 * Delivery — moving text between a sub-agent and its parent, both ways.
 *
 * Downward (`deliverToAgent`) is a mailbox push the agent drains at its own
 * milestones. Upward — a report or an interim note — has two parents, two
 * channels, one shape:
 *
 *   - **A chat** is woken with a synthetic turn (`source: "agent"`), exactly
 *     as a trigger fires one. The turn resumes the chat's own session, so
 *     the model reads the report with full conversational context and
 *     decides for itself whether the user hears about it.
 *   - **An agent** gets the text pushed into its mailbox, which it drains
 *     with `check_inbox`. A parent that has already settled has nowhere to
 *     put it: the message is logged and dropped, because reviving a
 *     finished run to hear late news is worse than losing the news.
 *
 * No batching: several settlements arriving while a chat is busy become
 * several queued turns, and the weaver serialises per chat. That is the
 * behaviour triggers already have, and the model handles it fine.
 */

import type { execute as dispatcherExecute } from "../engine/dispatcher.js";
import { log, logWarn, logError } from "../../util/log.js";
import { bus } from "../bus/index.js";
import { agentRegistry } from "./registry.js";
import { buildMessagePrompt, buildSettlementPrompt } from "./prompt.js";
import type { AgentMessage, AgentParent, AgentRecord } from "./types.js";

/** Injected at startup so this module knows nothing about the dispatcher. */
export type AgentDeliveryDeps = {
  /** Wakes a chat with a synthetic turn. */
  execute: typeof dispatcherExecute;
};

/** Reassignable holder so a re-init (or a test) can swap the deps. */
const deliveryDeps: { deps: AgentDeliveryDeps | null } = { deps: null };

/** Wire the delivery path. Called once from the composition root. */
export function initAgentDelivery(deps: AgentDeliveryDeps): void {
  deliveryDeps.deps = deps;
}

/** Sender/recipient key of a parent, for the `agent.message` event. */
function parentKey(parent: AgentParent): string {
  return parent.kind === "chat" ? parent.chatId : parent.agentId;
}

/** Wake a chat with a synthetic agent turn. */
async function wakeChat(
  chatId: string,
  numericChatId: number,
  prompt: string,
): Promise<void> {
  const deps = deliveryDeps.deps;
  if (!deps) {
    logWarn(
      "agents",
      `delivery not initialised — dropped a report for ${chatId}`,
    );
    return;
  }
  try {
    await deps.execute({
      chatId,
      numericChatId,
      prompt,
      senderName: "Agent",
      isGroup: false,
      source: "agent",
    });
  } catch (err) {
    logError("agents", `wake dispatch failed for chat ${chatId}`, err);
  }
}

/** Push into a live agent's mailbox, or say why it could not be delivered. */
function pushToAgent(
  parentAgentId: string,
  message: AgentMessage,
  what: string,
): void {
  if (!agentRegistry.isLive(parentAgentId)) {
    logWarn(
      "agents",
      `dropped ${what} from ${message.from}: parent ${parentAgentId} has already settled`,
    );
    return;
  }
  if (!agentRegistry.push(parentAgentId, message)) {
    logWarn(
      "agents",
      `dropped ${what} from ${message.from}: parent ${parentAgentId}'s inbox is full`,
    );
  }
}

/**
 * Send an instruction down to a live agent. Returns false when the agent is
 * gone or its mailbox is full — the caller turns that into a tool error, so
 * a parent always learns that its instruction did not land.
 */
export function deliverToAgent(
  from: string,
  agentId: string,
  text: string,
): boolean {
  if (!agentRegistry.isLive(agentId)) return false;
  if (!agentRegistry.push(agentId, { from, text, at: Date.now() }))
    return false;
  bus.publish({
    type: "agent.message",
    from,
    to: agentId,
    kind: "message",
  });
  return true;
}

/** Deliver a settled agent's report to its parent. */
export async function deliverSettlement(record: AgentRecord): Promise<void> {
  const prompt = buildSettlementPrompt(record);
  bus.publish({
    type: "agent.message",
    from: record.id,
    to: parentKey(record.parent),
    kind: "result",
  });
  if (record.parent.kind === "chat") {
    log(
      "agents",
      `${record.id} "${record.label}" ${record.state} — waking chat ${record.parent.chatId}`,
    );
    await wakeChat(record.parent.chatId, record.parent.numericChatId, prompt);
    return;
  }
  pushToAgent(
    record.parent.agentId,
    { from: record.id, text: prompt, at: Date.now() },
    "a report",
  );
}

/** Deliver an interim `message_parent` note. */
export async function deliverMessage(
  record: AgentRecord,
  text: string,
): Promise<void> {
  bus.publish({
    type: "agent.message",
    from: record.id,
    to: parentKey(record.parent),
    kind: "message",
  });
  if (record.parent.kind === "chat") {
    await wakeChat(
      record.parent.chatId,
      record.parent.numericChatId,
      buildMessagePrompt(record, text),
    );
    return;
  }
  pushToAgent(
    record.parent.agentId,
    { from: record.id, text: buildMessagePrompt(record, text), at: Date.now() },
    "a message",
  );
}
