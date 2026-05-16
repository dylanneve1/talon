/**
 * MCP-functional tier, batch 3 — member and chat management tool dispatch.
 *
 * Exercises the member info tools (list_chat_members, get_member_info,
 * online_count, get_pinned_messages) and chat management tools
 * (get_chat_admins, get_chat_member_count, set_chat_title, set_chat_description)
 * through the full SDK→MCP→bridge→gateway→recording-handler chain.
 *
 * Key lesson from batch 2 encoded here: bridge action names don't always match
 * MCP tool names. Always check the tool's execute() call for the actual bridge
 * action string. Specific mismatches in this batch:
 *   - list_chat_members tool → bridge("list_known_users", ...) [NOT list_chat_members]
 *
 * Each test uses the pattern: single assistantBlocks turn with the target tool
 * + end_turn in the same batch, so the SDK loop terminates cleanly in one
 * assistant message without a follow-up API call.
 *
 * Bugs this batch exercises:
 *   - If any tool is missing from mcp-server.ts's tool registry, the MCP
 *     dispatch fails with a schema error — the test catches the absence.
 *   - If a bridge action name changes (e.g. list_known_users → list_members),
 *     byAction assertions fail immediately, surfacing the drift before it
 *     reaches production.
 *   - set_chat_title / set_chat_description are write actions that go through
 *     the bridge but have never been exercised in the MCP-functional tier.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname as dirnamePath } from "node:path";
import { fileURLToPath as fileUrl } from "node:url";

import {
  runTalonTurn,
  cleanupTurn,
  teardownBootstrap,
} from "./talon-bootstrap.js";
import { successResult, assistantBlocks } from "./stub-claude/helpers.js";
import { makeRecordingHandler } from "./recording-handler.js";

const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubReady = existsSync(
  resolvePath(
    __testDir,
    process.platform === "win32"
      ? "stub-claude/fake-claude.exe"
      : "stub-claude/fake-claude.mjs",
  ),
);

// ── Suite: member and chat info tools ──────────────────────────────────────
//
// These are the read-path member/chat tools. Each routes to the recording
// handler which returns {ok: true, items: []}. The test verifies the
// dispatch went through the full chain (the recording handler was called
// with the right action name and params).
//
// Important: list_chat_members bridges to "list_known_users", not
// "list_chat_members". Tests assert on the bridge action name.

describe.skipIf(!stubReady)("Member and chat info tool dispatch", () => {
  const recording = makeRecordingHandler({ seed: 6000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("get_chat_admins → dispatches to bridge and returns ok:true", async () => {
    const turn = await runTalonTurn({
      prompt: "who are the admins",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_admins",
                  name: "mcp__telegram-tools__get_chat_admins",
                  input: {},
                },
                {
                  type: "tool_use",
                  id: "tu_end_admins",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Here are the admins." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(recording.byAction("get_chat_admins").length).toBe(1);
    expect(recording.byAction("send_message").length).toBeGreaterThanOrEqual(1);
    cleanupTurn(turn);
  }, 45_000);

  it("get_chat_member_count → dispatches to bridge and returns ok:true", async () => {
    const turn = await runTalonTurn({
      prompt: "how many members",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_count",
                  name: "mcp__telegram-tools__get_chat_member_count",
                  input: {},
                },
                {
                  type: "tool_use",
                  id: "tu_end_count",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Member count retrieved." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(recording.byAction("get_chat_member_count").length).toBe(1);
    cleanupTurn(turn);
  }, 45_000);

  it("list_chat_members → bridge action is 'list_known_users' (not 'list_chat_members')", async () => {
    // The list_chat_members tool calls bridge("list_known_users", { limit })
    // — the bridge action name is "list_known_users", not the MCP tool name.
    // This test verifies the routing AND documents the mismatch for future devs.
    const turn = await runTalonTurn({
      prompt: "list members",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_members",
                  name: "mcp__telegram-tools__list_chat_members",
                  input: { limit: 20 },
                },
                {
                  type: "tool_use",
                  id: "tu_end_members",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Listed members." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // Bridge action is "list_known_users" per src/core/tools/members.ts
    expect(recording.byAction("list_known_users").length).toBe(1);
    expect(recording.byAction("list_known_users")[0].body.limit).toBe(20);

    // Confirm the MCP tool name is NOT the bridge action name
    expect(recording.byAction("list_chat_members").length).toBe(0);

    cleanupTurn(turn);
  }, 45_000);

  it("get_member_info → dispatches with user_id param preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "get info for user 99",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_member_info",
                  name: "mcp__telegram-tools__get_member_info",
                  input: { user_id: 99 },
                },
                {
                  type: "tool_use",
                  id: "tu_end_member_info",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Got member info." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const memberInfos = recording.byAction("get_member_info");
    expect(memberInfos.length).toBe(1);
    expect(memberInfos[0].body.user_id).toBe(99);
    cleanupTurn(turn);
  }, 45_000);

  it("online_count → dispatches and returns ok:true with items", async () => {
    const turn = await runTalonTurn({
      prompt: "how many online",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_online",
                  name: "mcp__telegram-tools__online_count",
                  input: {},
                },
                {
                  type: "tool_use",
                  id: "tu_end_online",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Online count retrieved." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(recording.byAction("online_count").length).toBe(1);
    cleanupTurn(turn);
  }, 45_000);

  it("get_pinned_messages → dispatches and recording handler captures it", async () => {
    const turn = await runTalonTurn({
      prompt: "what's pinned",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_pinned",
                  name: "mcp__telegram-tools__get_pinned_messages",
                  input: {},
                },
                {
                  type: "tool_use",
                  id: "tu_end_pinned",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Pinned messages retrieved." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(recording.byAction("get_pinned_messages").length).toBe(1);
    cleanupTurn(turn);
  }, 45_000);
});

// ── Suite: chat mutation tools ─────────────────────────────────────────────
//
// set_chat_title and set_chat_description are write tools that go through
// the bridge and return {ok: true}. These have never been exercised in the
// MCP-functional tier. This suite closes that gap.

describe.skipIf(!stubReady)("Chat mutation tool dispatch", () => {
  const recording = makeRecordingHandler({ seed: 7000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("set_chat_title → bridge captures title param", async () => {
    const turn = await runTalonTurn({
      prompt: "rename the chat",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_title",
                  name: "mcp__telegram-tools__set_chat_title",
                  input: { title: "New Test Title" },
                },
                {
                  type: "tool_use",
                  id: "tu_end_title",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Chat renamed." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const renames = recording.byAction("set_chat_title");
    expect(renames.length).toBe(1);
    expect(renames[0].body.title).toBe("New Test Title");
    cleanupTurn(turn);
  }, 45_000);

  it("set_chat_description → bridge captures description param", async () => {
    const turn = await runTalonTurn({
      prompt: "update the description",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_desc",
                  name: "mcp__telegram-tools__set_chat_description",
                  input: { description: "This is a test chat." },
                },
                {
                  type: "tool_use",
                  id: "tu_end_desc",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Description updated." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const descs = recording.byAction("set_chat_description");
    expect(descs.length).toBe(1);
    expect(descs[0].body.description).toBe("This is a test chat.");
    cleanupTurn(turn);
  }, 45_000);

  it("multi-member-info turn — get_member_info + get_chat_admins in same batch, both captured in order", async () => {
    // Model calls two read tools in the same assistant message. Both should
    // dispatch through the bridge and appear in the recording handler.
    // Sequence assertion: member_info is dispatched before chat_admins.
    const turn = await runTalonTurn({
      prompt: "get both info and admins",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_info_first",
                  name: "mcp__telegram-tools__get_member_info",
                  input: { user_id: 42 },
                },
                {
                  type: "tool_use",
                  id: "tu_admins_second",
                  name: "mcp__telegram-tools__get_chat_admins",
                  input: {},
                },
                {
                  type: "tool_use",
                  id: "tu_end_multi",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Both retrieved." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(recording.byAction("get_member_info").length).toBe(1);
    expect(recording.byAction("get_chat_admins").length).toBe(1);
    expect(recording.byAction("send_message").length).toBeGreaterThanOrEqual(1);

    // get_member_info was dispatched before get_chat_admins
    const infoSeq = recording.byAction("get_member_info")[0].seq;
    const adminSeq = recording.byAction("get_chat_admins")[0].seq;
    expect(infoSeq).toBeLessThan(adminSeq);

    cleanupTurn(turn);
  }, 45_000);
});
