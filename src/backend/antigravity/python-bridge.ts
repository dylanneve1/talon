/**
 * Python bridge subprocess manager.
 *
 * Spawns `python3 agent_bridge.py --config-fd 3` and owns its lifecycle.
 * Communicates with the bridge over:
 *
 *   - fd 3: one-shot JSON config payload (written + closed at spawn).
 *   - stdin: line-delimited JSON commands (chat / abort / shutdown).
 *   - stdout: line-delimited JSON events (ready / text / tool_call /
 *     tool_result / done / error / log).
 *   - stderr: forwarded to Talon's log stream (warn level).
 *
 * Design notes:
 *
 *   - **One bridge per chat.** Antigravity's `Agent` context manager
 *     holds open the `localharness` binary + a stateful MCP server
 *     map; reusing it across chats with different MCP configs would
 *     give the wrong tool surface to whoever switched in second.
 *   - **Long-lived.** Bridges stay alive across turns. The cost of
 *     spawning the binary (~1s on the VPS) only hits the first turn.
 *   - **No reaper at this layer.** State.resetState() and the registry
 *     `cleanup` hook tear bridges down — orphan reaping is the host
 *     process's responsibility.
 *
 * Failure modes:
 *
 *   - `ready` never arrives → caller's `start()` Promise rejects.
 *   - Bridge stdout closes mid-turn → in-flight `chat()` rejects with
 *     a clear `bridge died` error; subsequent calls reject the same way.
 *   - Bridge emits an `error` event for an in-flight chat → that
 *     specific `chat()` Promise rejects; bridge stays alive.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { log, logWarn, logError } from "../../util/log.js";
import {
  ANTIGRAVITY_BRIDGE_PROTOCOL_VERSION,
  ANTIGRAVITY_BRIDGE_SCRIPT,
  ANTIGRAVITY_DEFAULT_VENV_PATH,
  ANTIGRAVITY_TURN_TIMEOUT_MS,
} from "./constants.js";

/** Config shipped to the Python bridge on spawn (over fd 3). */
export interface BridgeConfig {
  gemini_api_key?: string;
  model?: string;
  system_instructions?: string;
  workspaces?: string[];
  mcp_servers?: Array<{
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
  capabilities?: boolean;
  save_dir?: string;
  app_data_dir?: string;
}

/** Spawn-time options separate from the JSON config payload. */
export interface BridgeSpawnOptions {
  /** Path to the `python3` binary (typically inside a venv). */
  pythonPath?: string;
  /** Override the agent_bridge.py path (test isolation). */
  bridgeScriptPath?: string;
  /** Per-turn timeout override. */
  turnTimeoutMs?: number;
}

interface BridgeEvent {
  type: string;
  id?: string | null;
  [key: string]: unknown;
}

interface PendingTurn {
  resolve: (result: BridgeTurnResult) => void;
  reject: (err: Error) => void;
  textParts: string[];
  thoughtParts: string[];
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    tool_id?: string;
  }>;
  toolResults: Array<{
    name: string;
    tool_id?: string;
    result: unknown;
    error?: string | null;
  }>;
  usage: BridgeUsage | null;
  timeoutHandle: NodeJS.Timeout | null;
  onText?: (delta: string) => void;
  onThought?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export interface BridgeUsage {
  prompt_token_count: number | null;
  cached_content_token_count: number | null;
  candidates_token_count: number | null;
  thoughts_token_count: number | null;
  total_token_count: number | null;
}

export interface BridgeTurnResult {
  text: string;
  thoughts: string;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    tool_id?: string;
  }>;
  toolResults: Array<{
    name: string;
    tool_id?: string;
    result: unknown;
    error?: string | null;
  }>;
  usage: BridgeUsage | null;
}

export interface ChatOptions {
  /** Stable per-turn id; the bridge echoes it on every event. */
  id: string;
  prompt: string;
  /** Stream-text callback (called per Text chunk). */
  onText?: (delta: string) => void;
  /** Stream-thought callback (called per Thought chunk). */
  onThought?: (delta: string) => void;
  /** Tool-use callback (called per ToolCall chunk before the result). */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Override the default turn timeout for this call. */
  timeoutMs?: number;
}

type ChildProc = ChildProcessByStdio<Writable, Readable, Readable>;

const HERE = (() => {
  // import.meta.url shape `file:///path/to/dist/backend/antigravity/python-bridge.js`
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

function resolveBridgeScriptPath(override?: string): string {
  if (override) return override;
  // Locations to try, in order:
  //   1) Compiled location (dist/backend/antigravity/python/agent_bridge.py)
  //   2) Source location (src/backend/antigravity/python/agent_bridge.py)
  // The build step is expected to copy `python/` next to the .js
  // outputs; until that's wired we fall back to the src tree.
  const distSibling = resolve(HERE, ANTIGRAVITY_BRIDGE_SCRIPT);
  if (existsSync(distSibling)) return distSibling;
  const srcSibling = resolve(
    HERE,
    "../../../src/backend/antigravity",
    ANTIGRAVITY_BRIDGE_SCRIPT,
  );
  if (existsSync(srcSibling)) return srcSibling;
  return distSibling; // best-effort; spawn will fail loudly if missing
}

function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function resolvePythonPath(override?: string): string {
  const candidates: string[] = [];
  if (override) candidates.push(override);

  // Common locations operators install the venv at.
  const home = homedir();
  candidates.push(
    resolve(home, ".talon-antigravity/venv/bin/python3"),
    resolve(expandHome(ANTIGRAVITY_DEFAULT_VENV_PATH) ?? "", "bin/python3"),
  );

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  // Last resort: system python3. Bridge will fail with ImportError on
  // missing `google-antigravity` and emit a clean error event.
  return "python3";
}

export class AntigravityBridge {
  private proc: ChildProc | null = null;
  private ready = false;
  private dead = false;
  private deathReason: string | null = null;
  private pending = new Map<string, PendingTurn>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  private readonly chatId: string;
  private readonly turnTimeoutMs: number;
  /**
   * The Gemini model the bridge was spawned with. `ensureBridge`
   * consults this when a /model swap arrives — `LocalAgentConfig.model`
   * is baked at agent-context start, so a different model means we
   * have to respawn rather than reuse.
   */
  activeModel: string | null = null;

  constructor(chatId: string, _opts: BridgeSpawnOptions = {}) {
    this.chatId = chatId;
    this.turnTimeoutMs = _opts.turnTimeoutMs ?? ANTIGRAVITY_TURN_TIMEOUT_MS;
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
  }

  /** Whether the bridge has reached the `ready` state. */
  isReady(): boolean {
    return this.ready && !this.dead;
  }

  /** Spawn the bridge and resolve when `ready` arrives. */
  async start(
    config: BridgeConfig,
    opts: BridgeSpawnOptions = {},
  ): Promise<void> {
    if (this.proc) {
      throw new Error("Bridge already started");
    }

    const pythonPath = resolvePythonPath(opts.pythonPath);
    const scriptPath = resolveBridgeScriptPath(opts.bridgeScriptPath);

    // Spawn with default 3 stdio pipes (stdin/stdout/stderr) + a 4th
    // pipe at fd 3 for the one-shot config payload. Node's
    // `child_process.spawn` accepts an array of stdio descriptors —
    // `pipe` allocates a connected pipe at each index.
    const proc = spawn(pythonPath, [scriptPath, "--config-fd", "3"], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        // The bridge passes its own env to MCP subprocesses; PATH
        // / HOME need to flow through unchanged. PYTHONUNBUFFERED
        // ensures we see JSON events without the default 4KB stdout
        // buffer.
      },
    }) as unknown as ChildProcessByStdio<Writable, Readable, Readable> & {
      stdio: [Writable, Readable, Readable, Writable];
    };

    this.proc = proc as ChildProc;
    this.activeModel = config.model ?? null;
    const configPayload = JSON.stringify(config);
    const configFd = proc.stdio[3] as Writable | undefined;
    if (!configFd) {
      proc.kill();
      throw new Error("Bridge spawn failed: fd 3 not available");
    }
    configFd.write(configPayload);
    configFd.end();

    // Stdout — JSON events, line-delimited.
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      this.onLine(line);
    });

    // Stderr — forward to Talon's log stream. We don't fail the bridge
    // on stderr noise (Python warnings, MCP server logs, etc).
    const stderrRl = createInterface({
      input: proc.stderr!,
      crlfDelay: Infinity,
    });
    stderrRl.on("line", (line) => {
      if (line.trim()) {
        logWarn("agent", `[${this.chatId}] stderr: ${line}`);
      }
    });

    proc.on("exit", (code, signal) => {
      this.dead = true;
      const reason = `bridge exited (code=${code}, signal=${signal})`;
      this.deathReason = reason;
      this.failAllPending(new Error(reason));
      if (!this.ready && this.readyReject) {
        this.readyReject(new Error(`bridge died before ready: ${reason}`));
      }
      log("agent", `[${this.chatId}] ${reason}`);
    });

    proc.on("error", (err) => {
      this.dead = true;
      const msg = `bridge spawn error: ${err.message}`;
      this.deathReason = msg;
      this.failAllPending(err);
      if (!this.ready && this.readyReject) {
        this.readyReject(err);
      }
      logError("agent", `[${this.chatId}] ${msg}`, err);
    });

    // Belt-and-suspenders: time out the ready handshake.
    const readyTimeout = setTimeout(() => {
      if (!this.ready && this.readyReject) {
        const msg = `bridge ready handshake timed out (60s) — is google-antigravity installed and GEMINI_API_KEY valid? venv=${pythonPath}`;
        this.readyReject(new Error(msg));
      }
    }, 60_000);

    try {
      await this.readyPromise;
    } finally {
      clearTimeout(readyTimeout);
    }
  }

  private onLine(line: string): void {
    let evt: BridgeEvent;
    try {
      evt = JSON.parse(line);
    } catch {
      logWarn(
        "agent",
        `[${this.chatId}] non-JSON stdout line: ${line.slice(0, 200)}`,
      );
      return;
    }

    switch (evt.type) {
      case "ready": {
        const ver = evt.protocol_version as number | undefined;
        if (ver !== ANTIGRAVITY_BRIDGE_PROTOCOL_VERSION) {
          const err = new Error(
            `bridge protocol version mismatch: got ${ver}, expected ${ANTIGRAVITY_BRIDGE_PROTOCOL_VERSION}`,
          );
          if (this.readyReject) this.readyReject(err);
          this.dead = true;
          this.proc?.kill();
          return;
        }
        this.ready = true;
        log(
          "agent",
          `[${this.chatId}] ready (conversation_id=${evt.conversation_id ?? "?"})`,
        );
        if (this.readyResolve) this.readyResolve();
        return;
      }
      case "log": {
        const level = String(evt.level ?? "info");
        const message = `[${this.chatId}] py: ${evt.message ?? ""}`;
        if (level === "warn" || level === "warning") {
          logWarn("agent", message);
        } else if (level === "error") {
          logError("agent", message);
        } else {
          log("agent", message);
        }
        return;
      }
      case "text":
      case "thought":
      case "tool_call":
      case "tool_result":
      case "done":
      case "error":
      case "aborted": {
        const id = evt.id as string | null | undefined;
        if (!id) {
          if (evt.type === "error") {
            logError(
              "agent",
              `[${this.chatId}] global error: ${evt.error ?? "(unknown)"}`,
            );
            // A global error before any chat → reject ready if pending.
            if (!this.ready && this.readyReject) {
              this.readyReject(
                new Error(`bridge error before ready: ${evt.error}`),
              );
            }
          }
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) return;
        this.handleTurnEvent(pending, evt);
        return;
      }
      default:
        logWarn("agent", `[${this.chatId}] unknown event type: ${evt.type}`);
    }
  }

  private handleTurnEvent(pending: PendingTurn, evt: BridgeEvent): void {
    switch (evt.type) {
      case "text": {
        const delta = String(evt.text ?? "");
        pending.textParts.push(delta);
        pending.onText?.(delta);
        return;
      }
      case "thought": {
        const delta = String(evt.text ?? "");
        pending.thoughtParts.push(delta);
        pending.onThought?.(delta);
        return;
      }
      case "tool_call": {
        const name = String(evt.name ?? "");
        const args = (evt.args as Record<string, unknown>) ?? {};
        const tool_id = (evt.tool_id as string | undefined) ?? undefined;
        pending.toolCalls.push({ name, args, tool_id });
        pending.onToolCall?.(name, args);
        return;
      }
      case "tool_result": {
        const name = String(evt.name ?? "");
        const tool_id = (evt.tool_id as string | undefined) ?? undefined;
        const result = evt.result as unknown;
        const error = (evt.error as string | null | undefined) ?? null;
        pending.toolResults.push({ name, tool_id, result, error });
        return;
      }
      case "done": {
        pending.usage = (evt.usage as BridgeUsage | null) ?? null;
        this.completePending(pending, {
          text: pending.textParts.join(""),
          thoughts: pending.thoughtParts.join(""),
          toolCalls: pending.toolCalls,
          toolResults: pending.toolResults,
          usage: pending.usage,
        });
        return;
      }
      case "error": {
        const msg = String(evt.error ?? "unknown bridge error");
        this.rejectPending(pending, new Error(msg));
        return;
      }
      case "aborted": {
        this.rejectPending(pending, new Error("turn aborted"));
        return;
      }
    }
  }

  private completePending(
    pending: PendingTurn,
    result: BridgeTurnResult,
  ): void {
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    // Find and remove from map.
    for (const [k, v] of this.pending.entries()) {
      if (v === pending) {
        this.pending.delete(k);
        break;
      }
    }
    pending.resolve(result);
  }

  private rejectPending(pending: PendingTurn, err: Error): void {
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    for (const [k, v] of this.pending.entries()) {
      if (v === pending) {
        this.pending.delete(k);
        break;
      }
    }
    pending.reject(err);
  }

  private failAllPending(err: Error): void {
    const all = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of all) {
      if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
      p.reject(err);
    }
  }

  /** Send a chat command and resolve with the full turn result. */
  async chat(opts: ChatOptions): Promise<BridgeTurnResult> {
    if (this.dead) {
      throw new Error(
        `bridge is dead: ${this.deathReason ?? "(no reason recorded)"}`,
      );
    }
    if (!this.ready) {
      throw new Error("bridge not ready — call start() first");
    }
    if (!this.proc) {
      throw new Error("bridge has no process");
    }

    return new Promise<BridgeTurnResult>((resolveChat, rejectChat) => {
      const pending: PendingTurn = {
        resolve: resolveChat,
        reject: rejectChat,
        textParts: [],
        thoughtParts: [],
        toolCalls: [],
        toolResults: [],
        usage: null,
        timeoutHandle: null,
        onText: opts.onText,
        onThought: opts.onThought,
        onToolCall: opts.onToolCall,
      };

      const timeoutMs = opts.timeoutMs ?? this.turnTimeoutMs;
      pending.timeoutHandle = setTimeout(() => {
        // Best-effort abort, then reject.
        this.sendCommand({ type: "abort", target: opts.id });
        this.rejectPending(
          pending,
          new Error(`chat timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pending.set(opts.id, pending);
      this.sendCommand({
        type: "chat",
        id: opts.id,
        prompt: opts.prompt,
      });
    });
  }

  /** Send an abort signal for the given turn id. */
  abort(turnId: string): void {
    if (this.dead || !this.proc) return;
    this.sendCommand({ type: "abort", target: turnId });
  }

  /** Send shutdown and wait briefly for clean exit, then SIGKILL. */
  async shutdown(): Promise<void> {
    if (!this.proc || this.dead) return;
    this.sendCommand({ type: "shutdown" });
    try {
      await new Promise<void>((resolveShutdown) => {
        const grace = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolveShutdown();
        }, 5_000);
        this.proc!.once("exit", () => {
          clearTimeout(grace);
          resolveShutdown();
        });
      });
    } catch {
      // already dead
    }
  }

  private sendCommand(cmd: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      logWarn("agent", `[${this.chatId}] sendCommand: stdin not writable`);
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      logWarn(
        "agent",
        `[${this.chatId}] sendCommand write failed: ${err.message}`,
      );
    }
  }
}
