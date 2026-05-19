/**
 * Minimal OpenAI-compatible HTTP server for offline live-backend
 * tests against the `openai-agents` backend.
 *
 * Implements just enough of the surface the SDK actually calls when
 * talking to a chat-completions provider:
 *
 *   - `GET /v1/models` — returns a synthetic catalog. The backend's
 *     `fetchEndpointModels()` reads this on init.
 *   - `POST /v1/chat/completions` (with `stream: true`) — returns a
 *     scripted Server-Sent-Events response containing assistant text
 *     and/or tool calls. The SDK parses these chunks into
 *     `RunItemStreamEvent`s the same way it does for real providers.
 *
 * The script is a list of one ScriptedResponse per *expected request*
 * from the SDK. A turn that requires the model to call a tool and
 * then respond emits two HTTP requests — one whose response asks for
 * the tool, and a second (with the tool's output appended to the
 * messages) whose response is the final assistant text. Tests
 * arrange the script accordingly.
 *
 * No auth check, no rate limits, no streaming gymnastics — the goal
 * is deterministic SSE bytes the SDK can parse, not provider
 * fidelity.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface DummyModel {
  id: string;
  name?: string;
  context_length?: number;
  /** OpenRouter-style: `"0"` flags free-tier. */
  pricing?: { prompt: string; completion?: string };
}

export interface ToolCallSpec {
  name: string;
  /** Arguments — serialised to a JSON string by the server (matches OpenAI's API). */
  arguments: Record<string, unknown>;
  /** Optional callId; auto-generated when omitted. */
  id?: string;
}

/**
 * One response in the per-request script. `text` and `toolCalls` may
 * both be present (an assistant chunk that also requests tools); when
 * `toolCalls` is set, `finishReason` defaults to `"tool_calls"`.
 */
export interface ScriptedResponse {
  text?: string;
  toolCalls?: ToolCallSpec[];
  finishReason?: "stop" | "tool_calls";
  /** Optional model id to echo in the response (defaults to the request's). */
  model?: string;
}

export interface RecordedRequest {
  path: string;
  method: string;
  body: unknown;
}

export interface DummyOpenAIServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Set the response sequence for upcoming chat-completions requests. Consumed in order. */
  setScript(responses: ScriptedResponse[]): void;
  /** Empty the pending script (does NOT touch the recorded-request log). */
  clearScript(): void;
  /** Inspect requests recorded since last `clearRequests()`. */
  getRequests(): RecordedRequest[];
  clearRequests(): void;
}

export interface DummyServerOptions {
  models?: DummyModel[];
}

const DEFAULT_MODELS: DummyModel[] = [
  {
    id: "test/gpt-stub",
    name: "GPT Stub",
    context_length: 8192,
    pricing: { prompt: "0" },
  },
];

export async function startDummyOpenAIServer(
  options: DummyServerOptions = {},
): Promise<DummyOpenAIServer> {
  const models = options.models ?? DEFAULT_MODELS;
  let script: ScriptedResponse[] = [];
  const requests: RecordedRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed: unknown = undefined;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
      }
      requests.push({ path: url, method: req.method ?? "GET", body: parsed });

      if (url.endsWith("/models") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: models }));
        return;
      }

      if (url.endsWith("/chat/completions") && req.method === "POST") {
        const reqBody = parsed as { model?: string } | undefined;
        const next = script.shift();
        if (!next) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "dummy server: no scripted response available for this request",
                code: "no_script",
              },
            }),
          );
          return;
        }
        writeChatCompletionSSE(
          res,
          next,
          reqBody?.model ?? models[0]?.id ?? "test/gpt-stub",
        );
        return;
      }

      // Unknown path — return 404 so the SDK surfaces a useful error.
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unknown path: ${url}` } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/v1`;

  return {
    url,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setScript: (responses) => {
      script = [...responses];
    },
    clearScript: () => {
      script = [];
    },
    getRequests: () => requests.slice(),
    clearRequests: () => {
      requests.length = 0;
    },
  };
}

/**
 * Stream a single chat-completions response over Server-Sent Events.
 * The format matches OpenAI's chat-completions streaming protocol so
 * the official `openai` client (used by `@openai/agents` under the
 * hood) parses it without modification.
 */
function writeChatCompletionSSE(
  res: import("node:http").ServerResponse,
  scripted: ScriptedResponse,
  modelId: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const model = scripted.model ?? modelId;
  const finish =
    scripted.finishReason ??
    (scripted.toolCalls && scripted.toolCalls.length > 0
      ? "tool_calls"
      : "stop");

  const writeChunk = (delta: Record<string, unknown>): void => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  };

  // Opening role chunk — mirrors what real providers emit first.
  writeChunk({ role: "assistant", content: "" });

  // Text content streamed as one chunk for determinism. Real providers
  // chunk word-by-word; the SDK doesn't care.
  if (scripted.text) {
    writeChunk({ content: scripted.text });
  }

  // Tool calls. Each call gets a single chunk carrying name + the
  // fully-serialised arguments (real providers stream arguments
  // character-by-character; emitting the whole blob once is a valid
  // shape the parser handles).
  if (scripted.toolCalls && scripted.toolCalls.length > 0) {
    const toolCalls = scripted.toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id ?? `call_${randomBytes(8).toString("hex")}`,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
    writeChunk({ tool_calls: toolCalls });
  }

  // Final chunk with finish_reason — terminates the SSE stream from
  // the SDK's perspective.
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: scripted.text ? scripted.text.length : 0,
        total_tokens: 10 + (scripted.text ? scripted.text.length : 0),
      },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}
