/**
 * Agent-side sub-agent actions — the three tools that only mean something
 * inside a sub-agent run.
 *
 * The calling agent is identified from the gateway chat key (`agent:<id>`),
 * which the backend derives from the run's `contextLabel` and the MCP hub
 * binds to the tool session. Nothing is taken from the model's parameters:
 * an agent cannot claim to be a different agent, because it never names one.
 *
 * Called from a chat (or any other context) these are refused rather than
 * silently no-oping — a model that thinks it reported when it did not is the
 * one failure mode worth being loud about.
 */

import {
  agentIdFromContextLabel,
  agentRegistry,
  deliverMessage,
  describeParent,
} from "../../../agents/index.js";
import { logError } from "../../../../util/log.js";
import type { ActionResult } from "../../../types.js";
import type { AgentRecord } from "../../../agents/index.js";
import type { SharedActionHandlers } from "../types.js";

function notAnAgent(tool: string): ActionResult {
  return {
    ok: false,
    error:
      `${tool} is only callable inside a sub-agent run. This context is a ` +
      `chat, which has no parent to report to.`,
  };
}

/** The live agent behind this chat key, or null when the caller isn't one. */
function callingAgent(chatKey: string): AgentRecord | null {
  const id = agentIdFromContextLabel(chatKey);
  if (!id || !agentRegistry.isLive(id)) return null;
  return agentRegistry.get(id);
}

export const agentReportHandlers: SharedActionHandlers = {
  report_result: (body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("report_result");
    const summary = String(body.summary ?? "").trim();
    if (!summary) return { ok: false, error: "Missing summary" };
    const details = body.details ? String(body.details).trim() : undefined;
    const stored = agentRegistry.report(record.id, {
      summary,
      ...(details ? { details } : {}),
    });
    if (!stored) {
      return {
        ok: false,
        error:
          "You have already reported a result. It is recorded and will be " +
          "delivered when your run ends — finish up instead of reporting again.",
      };
    }
    return {
      ok: true,
      text:
        `Result recorded. It is delivered to ${describeParent(record.parent)} ` +
        `when your run ends — you can stop now.`,
    };
  },

  message_parent: (body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("message_parent");
    const text = String(body.text ?? "").trim();
    if (!text) return { ok: false, error: "Missing text" };
    // Fire-and-forget: waking a chat runs a whole turn, and this tool call
    // must not block for the length of the parent's reply.
    void deliverMessage(record, text).catch((err: unknown) =>
      logError(
        "agents",
        `message_parent delivery failed for ${record.id}`,
        err,
      ),
    );
    return {
      ok: true,
      text: `Note sent to ${describeParent(record.parent)}. Carry on — this did not end your run.`,
    };
  },

  check_inbox: (_body, _chatId, _backend, chatKey) => {
    const record = callingAgent(chatKey);
    if (!record) return notAnAgent("check_inbox");
    const messages = agentRegistry.drain(record.id);
    if (messages.length === 0) {
      return { ok: true, text: "Inbox empty — no new instructions." };
    }
    const rendered = messages
      .map((message) => {
        const at = new Date(message.at).toISOString().slice(11, 19);
        return `[${at}] from ${message.from}:\n${message.text}`;
      })
      .join("\n\n");
    return {
      ok: true,
      text: `${messages.length} message(s):\n\n${rendered}`,
    };
  },
};
