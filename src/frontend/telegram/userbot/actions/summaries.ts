/**
 * Summary actions: get/manage chat summaries, pending items, and summarization state.
 */

import {
  getSummary,
  updateSummary,
  getAllSummaries,
  needsSummarization,
} from "../../../../storage/summaries.js";
import type { ActionRegistry } from "./index.js";

export function registerSummaryActions(registry: ActionRegistry) {
  registry.set("get_chat_summary_stored", async (body, _chatId, _peer, chatIdStr) => {
    const targetChat = String(body.chat_id ?? chatIdStr);
    const summary = getSummary(targetChat);
    if (!summary) {
      return { ok: true, text: `No stored summary for chat ${targetChat}.`, summary: null };
    }
    return {
      ok: true,
      summary,
      text: [
        `Summary for ${summary.title ?? targetChat} (last updated: ${summary.lastSummarized}):`,
        summary.summary,
        "",
        summary.keyTopics.length > 0 ? `Topics: ${summary.keyTopics.join(", ")}` : "",
        summary.keyDecisions.length > 0 ? `Decisions: ${summary.keyDecisions.join("; ")}` : "",
        summary.pendingItems.length > 0 ? `Pending: ${summary.pendingItems.join("; ")}` : "",
        summary.participants.length > 0 ? `Participants: ${summary.participants.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
    };
  });

  registry.set("update_chat_summary", async (body, _chatId, _peer, chatIdStr) => {
    const targetChat = String(body.chat_id ?? chatIdStr);
    const summaryText = String(body.summary ?? "");
    if (!summaryText) return { ok: false, error: "summary text is required" };

    const updated = updateSummary(targetChat, {
      summary: summaryText,
      title: body.title ? String(body.title) : undefined,
      keyTopics: Array.isArray(body.key_topics) ? (body.key_topics as string[]) : undefined,
      keyDecisions: Array.isArray(body.key_decisions) ? (body.key_decisions as string[]) : undefined,
      pendingItems: Array.isArray(body.pending_items) ? (body.pending_items as string[]) : undefined,
      participants: Array.isArray(body.participants) ? (body.participants as string[]) : undefined,
      lastMessageCount: typeof body.message_count === "number" ? body.message_count as number : undefined,
    });

    return { ok: true, text: `Summary updated for chat ${targetChat}.`, summary: updated };
  });

  registry.set("list_chat_summaries", async (body) => {
    const limit = Number(body.limit ?? 20);
    const allSummaries = getAllSummaries();
    const entries = Object.values(allSummaries)
      .sort((a, b) => b.lastSummarized.localeCompare(a.lastSummarized))
      .slice(0, limit);

    if (entries.length === 0) {
      return { ok: true, text: "No chat summaries stored yet.", summaries: [] };
    }

    const formatted = entries.map((s) => {
      const title = s.title ? ` (${s.title})` : "";
      const pending = s.pendingItems.length > 0 ? ` [${s.pendingItems.length} pending]` : "";
      return `${s.chatId}${title}: ${s.summary.slice(0, 100)}...${pending} — last: ${s.lastSummarized}`;
    });

    return {
      ok: true,
      text: formatted.join("\n"),
      count: entries.length,
      total: Object.keys(allSummaries).length,
    };
  });

  registry.set("get_pending_items", async () => {
    const allSummaries = getAllSummaries();
    const allPending: Array<{ chatId: string; title?: string; item: string }> = [];

    for (const summary of Object.values(allSummaries)) {
      for (const item of summary.pendingItems) {
        allPending.push({
          chatId: summary.chatId,
          title: summary.title,
          item,
        });
      }
    }

    if (allPending.length === 0) {
      return { ok: true, text: "No pending items across any chats.", items: [] };
    }

    const formatted = allPending.map((p) => {
      const label = p.title ?? p.chatId;
      return `[${label}] ${p.item}`;
    });

    return {
      ok: true,
      text: formatted.join("\n"),
      count: allPending.length,
      items: allPending,
    };
  });

  registry.set("needs_summarization", async (body, _chatId, _peer, chatIdStr) => {
    const targetChat = String(body.chat_id ?? chatIdStr);
    const msgCount = Number(body.message_count ?? 0);
    const needs = needsSummarization(targetChat, msgCount);
    return { ok: true, needs_summarization: needs, chat_id: targetChat, message_count: msgCount };
  });
}
