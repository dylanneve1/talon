/**
 * Codex stub adapter — points the codex backend at the fake `codex` binary
 * (`stub-codex/fake-codex.mjs`), which speaks codex's per-turn stdio JSONL
 * `ThreadEvent` protocol.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chmodSync, writeFileSync, readFileSync } from "node:fs";

import type { TalonConfig } from "../../../../util/config.js";
import type { StubBackendAdapter, TurnContext } from "../types.js";
import type {
  CodexStubTurn,
  CodexStubScript,
} from "../../stub-codex/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_BINARY = resolve(__dirname, "../../stub-codex/fake-codex.mjs");

/** One codex dispatcher turn: the items to emit, plus the MCP-dispatch flag. */
export type CodexTurn = CodexStubTurn & { dispatchMcp?: boolean };

export function codexAdapter(): StubBackendAdapter<CodexTurn> {
  return {
    id: "codex" as TalonConfig["backend"],
    model: "gpt-5-codex",

    prepare() {
      // Force api-key auth with a throwaway key so the backend registers +
      // spawns the binary (the stub ignores the key), and point codex at the
      // stub. The bogus base URL makes model discovery fail fast (ECONNREFUSED)
      // → curated catalog, instead of hitting real OpenAI.
      process.env.TALON_CODEX_KEY = "stub-codex-key";
      process.env.TALON_CODEX_BINARY = STUB_BINARY;
      try {
        chmodSync(STUB_BINARY, 0o755);
      } catch {
        /* best effort */
      }
    },

    configOverrides() {
      return {
        codexBinary: STUB_BINARY,
        openaiBaseUrl: "http://127.0.0.1:1",
      } as Partial<TalonConfig>;
    },

    applyTurn(turn, ctx) {
      const script: CodexStubScript = {
        dispatchMcp: turn.dispatchMcp,
        turns: [{ emit: turn.emit, usage: turn.usage, fail: turn.fail }],
      };
      const scriptPath = resolve(ctx.tmpDir, "script.json");
      writeFileSync(scriptPath, JSON.stringify(script));
      process.env.STUB_CODEX_SCRIPT = scriptPath;
      process.env.STUB_CODEX_STATE = resolve(ctx.tmpDir, "state.counter");
      process.env.STUB_CODEX_LOG = resolve(ctx.tmpDir, "protocol.log");
      process.env.STUB_CODEX_TIMEOUT_MS = turn.dispatchMcp ? "30000" : "10000";
    },

    afterTurn() {
      delete process.env.STUB_CODEX_SCRIPT;
      delete process.env.STUB_CODEX_STATE;
      delete process.env.STUB_CODEX_LOG;
      delete process.env.STUB_CODEX_TIMEOUT_MS;
    },

    collectExtras(ctx: TurnContext) {
      try {
        const log = readFileSync(resolve(ctx.tmpDir, "protocol.log"), "utf8");
        return { protocolLog: log.split("\n").filter(Boolean) };
      } catch {
        return { protocolLog: [] };
      }
    },
  };
}
