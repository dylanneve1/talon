/**
 * MCP-functional tier, batch 4 — sticker tool dispatch.
 *
 * Exercises the full sticker tool surface (read browsing, write management,
 * and combined delivery via send_sticker) through the SDK→MCP→bridge→gateway
 * →recording-handler chain.
 *
 * Sticker tools covered:
 *   Read/browse: get_sticker_pack, download_sticker, save_sticker_pack
 *   Write/manage: create_sticker_set, add_sticker_to_set, delete_sticker_from_set
 *                 set_sticker_set_title, delete_sticker_set
 *   Delivery:     send_sticker (messaging tool, not stickers.ts — but used together)
 *
 * None of the sticker management tools have been exercised in the
 * MCP-functional tier before this batch. Their bridge action names match their
 * MCP tool names (unlike list_chat_members → list_known_users in tier 3), so
 * no name-mismatch notes needed here.
 *
 * The recording handler (recording-handler.ts) was extended in this batch to
 * explicitly handle all sticker management actions rather than falling through
 * to the `default` case. Both cases return { ok: true }; the change is for
 * clarity and future-proofing (tests that assert on action presence now get
 * deterministic responses).
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

// ── Suite: sticker read / browse tools ────────────────────────────────────
//
// These are the read-path sticker tools — browsing and downloading.
// Recording handler returns {ok: true, items: []} for get/save_sticker_pack
// and {ok: true} for download_sticker (returns a file path in production,
// but the recording handler is only for routing assertions).

describe.skipIf(!stubReady)("Sticker read tool dispatch", () => {
  const recording = makeRecordingHandler({ seed: 8000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("get_sticker_pack → dispatches with set_name preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "show me the AnimatedEmojis pack",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_gspack",
                  name: "mcp__telegram-tools__get_sticker_pack",
                  input: { set_name: "AnimatedEmojis" },
                },
                {
                  type: "tool_use",
                  id: "tu_end_gspack",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Here are the stickers." },
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

    const packs = recording.byAction("get_sticker_pack");
    expect(packs.length).toBe(1);
    expect(packs[0].body.set_name).toBe("AnimatedEmojis");
    expect(recording.byAction("send_message").length).toBeGreaterThanOrEqual(1);
    cleanupTurn(turn);
  }, 45_000);

  it("download_sticker → dispatches with file_id preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "download sticker abc123",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_dlstick",
                  name: "mcp__telegram-tools__download_sticker",
                  input: { file_id: "CAADAgADmgADBjMpS_f0jE1MzNJMFgQ" },
                },
                {
                  type: "tool_use",
                  id: "tu_end_dlstick",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Sticker downloaded." },
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

    const downloads = recording.byAction("download_sticker");
    expect(downloads.length).toBe(1);
    expect(downloads[0].body.file_id).toBe("CAADAgADmgADBjMpS_f0jE1MzNJMFgQ");
    cleanupTurn(turn);
  }, 45_000);

  it("save_sticker_pack → dispatches with set_name preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "save the AnimatedEmojis pack for later",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_savepack",
                  name: "mcp__telegram-tools__save_sticker_pack",
                  input: { set_name: "AnimatedEmojis" },
                },
                {
                  type: "tool_use",
                  id: "tu_end_savepack",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Pack saved." },
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

    const saves = recording.byAction("save_sticker_pack");
    expect(saves.length).toBe(1);
    expect(saves[0].body.set_name).toBe("AnimatedEmojis");
    cleanupTurn(turn);
  }, 45_000);
});

// ── Suite: sticker write / management tools ────────────────────────────────
//
// Write-path sticker tools: create, add, delete stickers and packs.
// These have never been exercised in the MCP-functional tier.
// All bridge action names match their MCP tool names exactly.

describe.skipIf(!stubReady)("Sticker write tool dispatch", () => {
  const recording = makeRecordingHandler({ seed: 9000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("create_sticker_set → dispatches with all required params preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "create a new sticker pack",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_createset",
                  name: "mcp__telegram-tools__create_sticker_set",
                  input: {
                    user_id: 123456,
                    name: "cool_pack",
                    title: "Cool Stickers",
                    file_path: "/workspace/sticker.png",
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_end_createset",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Sticker pack created." },
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

    const creates = recording.byAction("create_sticker_set");
    expect(creates.length).toBe(1);
    expect(creates[0].body.user_id).toBe(123456);
    expect(creates[0].body.name).toBe("cool_pack");
    expect(creates[0].body.title).toBe("Cool Stickers");
    expect(creates[0].body.file_path).toBe("/workspace/sticker.png");
    cleanupTurn(turn);
  }, 45_000);

  it("add_sticker_to_set → dispatches with user_id, name, file_path preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "add a sticker to the pack",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_addstick",
                  name: "mcp__telegram-tools__add_sticker_to_set",
                  input: {
                    user_id: 123456,
                    name: "cool_pack_by_talon",
                    file_path: "/workspace/new_sticker.png",
                    emoji_list: ["😎"],
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_end_addstick",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Sticker added." },
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

    const adds = recording.byAction("add_sticker_to_set");
    expect(adds.length).toBe(1);
    expect(adds[0].body.user_id).toBe(123456);
    expect(adds[0].body.name).toBe("cool_pack_by_talon");
    expect(adds[0].body.file_path).toBe("/workspace/new_sticker.png");
    cleanupTurn(turn);
  }, 45_000);

  it("delete_sticker_from_set → dispatches with sticker_file_id preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "delete sticker CAADAgADmgADBjMpS from the pack",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_delstick",
                  name: "mcp__telegram-tools__delete_sticker_from_set",
                  input: { sticker_file_id: "CAADAgADmgADBjMpS_f0jE1MzNJMFgQ" },
                },
                {
                  type: "tool_use",
                  id: "tu_end_delstick",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Sticker deleted." },
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

    const deletes = recording.byAction("delete_sticker_from_set");
    expect(deletes.length).toBe(1);
    expect(deletes[0].body.sticker_file_id).toBe(
      "CAADAgADmgADBjMpS_f0jE1MzNJMFgQ",
    );
    cleanupTurn(turn);
  }, 45_000);

  it("set_sticker_set_title → dispatches with name and title preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "rename the sticker pack",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_renamepack",
                  name: "mcp__telegram-tools__set_sticker_set_title",
                  input: {
                    name: "cool_pack_by_talon",
                    title: "Very Cool Stickers",
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_end_renamepack",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Pack renamed." },
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

    const renames = recording.byAction("set_sticker_set_title");
    expect(renames.length).toBe(1);
    expect(renames[0].body.name).toBe("cool_pack_by_talon");
    expect(renames[0].body.title).toBe("Very Cool Stickers");
    cleanupTurn(turn);
  }, 45_000);

  it("delete_sticker_set → dispatches with name preserved", async () => {
    const turn = await runTalonTurn({
      prompt: "delete the entire sticker pack",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_deleteset",
                  name: "mcp__telegram-tools__delete_sticker_set",
                  input: { name: "cool_pack_by_talon" },
                },
                {
                  type: "tool_use",
                  id: "tu_end_deleteset",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Pack deleted." },
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

    const delSets = recording.byAction("delete_sticker_set");
    expect(delSets.length).toBe(1);
    expect(delSets[0].body.name).toBe("cool_pack_by_talon");
    cleanupTurn(turn);
  }, 45_000);
});

// ── Suite: sticker delivery + combined workflows ───────────────────────────
//
// send_sticker is a messaging tool (not in stickers.ts) that delivers a
// sticker to the chat. Combined workflows like get_sticker_pack + send_sticker
// are how the model actually uses these tools together in production.

describe.skipIf(!stubReady)("Sticker delivery and combined workflows", () => {
  const recording = makeRecordingHandler({ seed: 10000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("send(type=sticker) → dispatches send_sticker bridge action with file_id", async () => {
    // The MCP tool is `send` with `type: "sticker"` — not a separate
    // `send_sticker` tool. The bridge action dispatched is `send_sticker`.
    // This test verifies the routing from MCP `send` → bridge `send_sticker`.
    const turn = await runTalonTurn({
      prompt: "send me a sticker",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_sendstick",
                  name: "mcp__telegram-tools__send",
                  input: {
                    type: "sticker",
                    file_id: "CAADAgADmgADBjMpS_f0jE1MzNJMFgQ",
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_end_sendstick",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "" },
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

    const stickers = recording.byAction("send_sticker");
    expect(stickers.length).toBe(1);
    expect(stickers[0].body.file_id).toBe("CAADAgADmgADBjMpS_f0jE1MzNJMFgQ");
    // send_sticker returns { ok: true, message_id: number } like other send* tools
    cleanupTurn(turn);
  }, 45_000);

  it("get_sticker_pack + send(type=sticker) in same turn — browse then deliver, order preserved", async () => {
    // Common production flow: model browses the pack to find a file_id, then
    // immediately delivers via send(type="sticker") in the same assistant turn.
    // Bridge receives get_sticker_pack first, then send_sticker.
    const turn = await runTalonTurn({
      prompt: "send me a sticker from AnimatedEmojis",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_browse",
                  name: "mcp__telegram-tools__get_sticker_pack",
                  input: { set_name: "AnimatedEmojis" },
                },
                {
                  type: "tool_use",
                  id: "tu_deliver",
                  name: "mcp__telegram-tools__send",
                  input: {
                    type: "sticker",
                    file_id: "CAADAgADmgADBjMpS_f0jE1MzNJMFgQ",
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_end_combo",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "" },
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

    expect(recording.byAction("get_sticker_pack").length).toBe(1);
    expect(recording.byAction("send_sticker").length).toBe(1);

    // Browse dispatched before deliver
    const browseSeq = recording.byAction("get_sticker_pack")[0].seq;
    const deliverSeq = recording.byAction("send_sticker")[0].seq;
    expect(browseSeq).toBeLessThan(deliverSeq);

    cleanupTurn(turn);
  }, 45_000);

  it("create_sticker_set + add_sticker_to_set in same turn — lifecycle batch captured in order", async () => {
    // Model creates a pack then immediately adds a sticker — this is a
    // two-step mutation that must execute in the right order.
    const turn = await runTalonTurn({
      prompt: "create a new pack and add a sticker to it",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_create_batch",
                  name: "mcp__telegram-tools__create_sticker_set",
                  input: {
                    user_id: 42,
                    name: "batch_pack",
                    title: "Batch Pack",
                    file_path: "/workspace/first.png",
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_add_batch",
                  name: "mcp__telegram-tools__add_sticker_to_set",
                  input: {
                    user_id: 42,
                    name: "batch_pack_by_talon",
                    file_path: "/workspace/second.png",
                  },
                },
                {
                  type: "tool_use",
                  id: "tu_end_batch",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Pack created and sticker added." },
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

    expect(recording.byAction("create_sticker_set").length).toBe(1);
    expect(recording.byAction("add_sticker_to_set").length).toBe(1);

    // create before add
    const createSeq = recording.byAction("create_sticker_set")[0].seq;
    const addSeq = recording.byAction("add_sticker_to_set")[0].seq;
    expect(createSeq).toBeLessThan(addSeq);

    expect(recording.byAction("send_message").length).toBeGreaterThanOrEqual(1);
    cleanupTurn(turn);
  }, 45_000);
});
