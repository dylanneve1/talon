/**
 * Poll actions: send, stop, vote, retract, get results.
 */

import { Api } from "telegram";
import { getClient } from "../client.js";
import { extractMessageId } from "../helpers.js";
import { withRetry } from "../../../../core/gateway.js";
import type { Gateway } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerPollActions(
  registry: ActionRegistry,
  gateway: Gateway,
  recordOurMessage: (chatId: string, msgId: number) => void,
) {
  registry.set("send_poll", async (body, chatId, peer, chatIdStr) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const question = String(body.question ?? "");
    const rawOptions = body.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2)
      return { ok: false, error: "send_poll requires at least 2 options (array)" };
    const pollAnswers = (rawOptions as unknown[]).map((opt, i) =>
      new Api.PollAnswer({
        text: new Api.TextWithEntities({ text: String(opt), entities: [] }),
        option: Buffer.from([i]),
      }),
    );
    const isQuiz = body.is_quiz === true;
    const isAnonymous = body.is_anonymous !== false;
    const allowsMultiple = body.allows_multiple_answers === true;
    const correctOption = typeof body.correct_option_id === "number" ? body.correct_option_id : undefined;
    const poll = new Api.Poll({
      id: BigInt(0) as unknown as import("big-integer").BigInteger,
      question: new Api.TextWithEntities({ text: question, entities: [] }),
      answers: pollAnswers,
      quiz: isQuiz || undefined,
      publicVoters: isAnonymous ? undefined : true,
      multipleChoice: allowsMultiple || undefined,
      closePeriod: typeof body.open_period === "number" ? body.open_period : undefined,
    });
    const solutionText = isQuiz && correctOption !== undefined && body.explanation ? String(body.explanation) : undefined;
    const media = new Api.InputMediaPoll({
      poll,
      correctAnswers: isQuiz && correctOption !== undefined ? [Buffer.from([correctOption])] : undefined,
      solution: solutionText,
      solutionEntities: solutionText ? [] : undefined,
    });
    gateway.incrementMessages(chatId);
    const sendResult = await withRetry(() =>
      client!.invoke(new Api.messages.SendMedia({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: peer as any, media, message: "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        randomId: BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000)) as any,
      })),
    );
    const pollMsgId = extractMessageId(sendResult);
    if (pollMsgId) recordOurMessage(chatIdStr, pollMsgId);
    return { ok: true, message_id: pollMsgId };
  });

  registry.set("stop_poll", async () => {
    return { ok: false, error: "stop_poll is not supported in userbot mode." };
  });

  registry.set("vote_poll", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    const optionIndex = Number(body.option_index ?? 0);
    let optionBytes: Buffer | null = null;
    let votedFor = String(optionIndex);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pollResultsData = await withRetry(() => client!.invoke(new Api.messages.GetPollResults({ peer: peer as any, msgId }))) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const answerVoters = pollResultsData?.results?.results as any[] | undefined;
      if (answerVoters && answerVoters[optionIndex]) {
        optionBytes = Buffer.from(answerVoters[optionIndex].option);
      }
    } catch { /* fall through */ }
    if (!optionBytes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgs = await client.getMessages(peer as any, { ids: [msgId] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pollMedia = (msgs[0] as any)?.media;
      if (pollMedia?.className === "MessageMediaPoll") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const answers = pollMedia.poll?.answers as any[] ?? [];
        if (optionIndex < 0 || optionIndex >= answers.length)
          return { ok: false, error: `Invalid option_index. Poll has ${answers.length} options (0-${answers.length - 1})` };
        const answer = answers[optionIndex];
        optionBytes = Buffer.from(answer.option);
        votedFor = typeof answer.text === "string" ? answer.text : (answer.text?.text ?? String(optionIndex));
      } else if (pollMedia?.className === "MessageMediaUnsupported") {
        optionBytes = Buffer.from([optionIndex]);
      }
    }
    if (!optionBytes) return { ok: false, error: "Could not find poll or its options at that message ID" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.messages.SendVote({ peer: peer as any, msgId, options: [optionBytes!] })));
    return { ok: true, voted_for: votedFor, option_index: optionIndex };
  });

  registry.set("retract_vote", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    const votePeer = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.messages.SendVote({ peer: votePeer as any, msgId, options: [] })));
    return { ok: true, retracted: true };
  });

  registry.set("get_poll_results", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetPollResults({ peer: p as any, msgId }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pollUpdate = (result?.updates ?? []).find((u: any) => u.className === "UpdateMessagePoll") as any;
    if (!pollUpdate) return { ok: false, error: "Poll results not available for this message. Ensure it is a poll message." };
    const poll = pollUpdate.poll;
    const results = pollUpdate.results;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answers = (poll?.answers ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answerVoters = (results?.results ?? []) as any[];
    const totalVoters = Number(results?.totalVoters ?? 0);
    const breakdown = answers.map((answer, i) => {
      const voter = answerVoters[i];
      const count = Number(voter?.voters ?? 0);
      const pct = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0;
      const chosen = voter?.chosen ?? false;
      const text = typeof answer.text === "string" ? answer.text : (answer.text?.text ?? `Option ${i}`);
      return { index: i, text, votes: count, percentage: pct, you_voted: chosen };
    });
    return {
      ok: true, message_id: msgId,
      question: typeof poll?.question === "string" ? poll.question : (poll?.question?.text ?? ""),
      total_voters: totalVoters, closed: poll?.closed ?? false, options: breakdown,
    };
  });
}
