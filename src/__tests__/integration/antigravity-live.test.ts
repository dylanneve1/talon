/**
 * Live integration test for the Antigravity backend.
 *
 * Drives a REAL `google-antigravity` SDK install (via the Python
 * bridge) and exercises the full TS-side surface. Two failure modes
 * we explicitly want to catch:
 *
 *  1. The bridge handshake — spawn the venv, send config on fd 3,
 *     receive `ready` within the timeout. This shakes out venv path
 *     issues, missing-Python issues, and protocol version drift.
 *  2. Model dispatch — send a real chat command with a real
 *     `GEMINI_API_KEY` and assert we receive text + usage back. If
 *     Antigravity's response format ever shifts, the chunk
 *     translation in agent_bridge.py breaks here.
 *
 * Skipping:
 *   Skipped by default unless `GEMINI_API_KEY` is set (and
 *   `google-antigravity` is installed at the expected venv path).
 *   The dedicated CI job sets `ANTIGRAVITY_LIVE_REQUIRED=1` so the
 *   skip fails loudly there if the env was meant to be provisioned.
 *
 * Cost:
 *   One `gemini-3.5-flash` chat turn (~10-50 tokens out). Negligible.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { AntigravityBridge } from "../../backend/antigravity/python-bridge.js";

const DEFAULT_VENV_PYTHON = resolve(
  homedir(),
  ".talon-antigravity",
  "venv",
  "bin",
  "python3",
);

const HAS_PYTHON_VENV = existsSync(
  process.env.ANTIGRAVITY_PYTHON ?? DEFAULT_VENV_PYTHON,
);
const HAS_API_KEY = Boolean(process.env.GEMINI_API_KEY);

const ANTIGRAVITY_REQUIRED = process.env.ANTIGRAVITY_LIVE_REQUIRED === "1";
const liveDescribe =
  (HAS_PYTHON_VENV && HAS_API_KEY) || ANTIGRAVITY_REQUIRED
    ? describe
    : describe.skip;

const WORKSPACE_PATH = resolve(homedir(), "talon-antigravity-workspace");

let bridge: AntigravityBridge | null = null;

beforeAll(() => {
  if (!existsSync(WORKSPACE_PATH)) {
    mkdirSync(WORKSPACE_PATH, { recursive: true });
  }
});

afterAll(async () => {
  if (bridge) {
    await bridge.shutdown().catch(() => {});
    bridge = null;
  }
});

liveDescribe("antigravity live — bridge handshake + model dispatch", () => {
  it("starts the bridge against the real google-antigravity install", async () => {
    bridge = new AntigravityBridge("antigravity-live-test", {
      turnTimeoutMs: 90_000,
    });

    await bridge.start(
      {
        gemini_api_key: process.env.GEMINI_API_KEY,
        model: "gemini-3.5-flash",
        workspaces: [WORKSPACE_PATH],
        mcp_servers: [],
      },
      {
        pythonPath: process.env.ANTIGRAVITY_PYTHON ?? DEFAULT_VENV_PYTHON,
      },
    );

    expect(bridge.isReady()).toBe(true);
  }, 120_000);

  it("round-trips a chat turn and returns text + usage", async () => {
    if (!bridge || !bridge.isReady()) {
      throw new Error("bridge not ready — the handshake test must run first");
    }

    const textParts: string[] = [];
    const result = await bridge.chat({
      id: "live-turn-1",
      prompt: "Reply with exactly the four characters 'pong' and nothing else.",
      onText: (delta) => textParts.push(delta),
      timeoutMs: 60_000,
    });

    // Sanity: we got SOME text back.
    expect(result.text.length).toBeGreaterThan(0);
    expect(textParts.join("")).toBe(result.text);

    // Token usage should be populated; values can fluctuate so we just
    // check positive integers.
    expect(result.usage).not.toBeNull();
    expect((result.usage?.prompt_token_count ?? 0) > 0).toBe(true);
    expect((result.usage?.total_token_count ?? 0) > 0).toBe(true);

    // We asked for "pong" — Gemini may sandwich it with extra words
    // depending on the day; just check the response contains "pong".
    expect(result.text.toLowerCase()).toContain("pong");
  }, 120_000);
});
