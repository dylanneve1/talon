/**
 * In-process fake of an OpenAI-compatible API, for the **openai-agents**
 * backend. The `@openai/agents` SDK talks to whatever `baseURL` we inject via
 * `TALON_AGENTS_URL`; with a custom base URL Talon defaults the SDK to
 * `chat_completions` mode (standard OpenAI streaming), which is what this
 * server speaks.
 *
 * Unlike opencode (where the server executes MCP tools), the `@openai/agents`
 * SDK connects MCP servers as stdio subprocesses ITSELF and runs tool calls
 * in-process — so this server only emits the model's streamed output
 * (`/chat/completions` SSE) and the model catalog (`/models`); the SDK handles
 * the tool round-trip and re-requests with the result. A per-turn counter
 * walks a multi-request agentic loop.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface OpenAITextStep {
  type: "text";
  text: string;
}

/** A tool call the SDK should execute. */
export interface OpenAIToolStep {
  type: "tool";
  /**
   * Tool name **suffix** to match against the function names the SDK actually
   * advertises in the request's `tools` array (the SDK generates MCP function
   * names like `telegram-tools-end_turn` when `includeServerInToolNames` is on).
   * e.g. pass `"end_turn"` and the fake resolves the real registered name.
   */
  name: string;
  arguments?: Record<string, unknown>;
}

export type OpenAIStep = OpenAITextStep | OpenAIToolStep;

/**
 * One scripted turn = a list of model "responses", one per `/chat/completions`
 * request in the agentic loop. Response 0 fires on the first request, response
 * 1 after the SDK runs the tool and re-requests, etc.
 */
export interface OpenAITurn {
  responses: OpenAIStep[][];
}

export interface FakeOpenAIServer {
  port: number;
  setTurn: (turn: OpenAITurn) => void;
  stop: () => Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

export async function startFakeOpenAIServer(
  model = "stub-model",
): Promise<FakeOpenAIServer> {
  let currentTurn: OpenAITurn = { responses: [[{ type: "text", text: "" }]] };
  let requestIndex = 0;

  const dbg = (msg: string) => {
    if (process.env.STUB_OPENAI_DEBUG)
      process.stderr.write(`[fake-openai] ${msg}\n`);
  };

  const streamChunk = (
    res: ServerResponse,
    choice: Record<string, unknown>,
  ) => {
    const chunk = {
      id: "chatcmpl-" + randomUUID().slice(0, 8),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [choice],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  /** Resolve a scripted tool-name suffix to the real function name the SDK
   *  advertised in this request's `tools` array. */
  const resolveToolName = (
    suffix: string,
    requestBody: string,
  ): string | undefined => {
    try {
      const body = JSON.parse(requestBody) as {
        tools?: Array<{ function?: { name?: string } }>;
      };
      const names = (body.tools ?? [])
        .map((t) => t.function?.name)
        .filter((n): n is string => typeof n === "string");
      return (
        names.find((n) => n === suffix) ??
        names.find((n) => n.endsWith(suffix)) ??
        names.find((n) => n.replace(/[^a-z0-9]/gi, "").endsWith(suffix))
      );
    } catch {
      return undefined;
    }
  };

  const handleChatCompletions = (res: ServerResponse, requestBody: string) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const steps = currentTurn.responses[requestIndex] ??
      currentTurn.responses[currentTurn.responses.length - 1] ?? [
        { type: "text", text: "" },
      ];
    requestIndex++;
    dbg(`/chat/completions step ${requestIndex - 1}: ${JSON.stringify(steps)}`);

    const toolSteps = steps.filter(
      (s): s is OpenAIToolStep => s.type === "tool",
    );
    const textSteps = steps.filter(
      (s): s is OpenAITextStep => s.type === "text",
    );

    if (toolSteps.length > 0) {
      // Emit tool_call deltas, then finish with `tool_calls`.
      toolSteps.forEach((tool, i) => {
        const fnName = resolveToolName(tool.name, requestBody) ?? tool.name;
        dbg(`tool step → resolved "${tool.name}" to function "${fnName}"`);
        streamChunk(res, {
          index: 0,
          delta: {
            ...(i === 0 ? { role: "assistant", content: null } : {}),
            tool_calls: [
              {
                index: i,
                id: "call_" + randomUUID().slice(0, 8),
                type: "function",
                function: {
                  name: fnName,
                  arguments: JSON.stringify(tool.arguments ?? {}),
                },
              },
            ],
          },
          finish_reason: null,
        });
      });
      streamChunk(res, { index: 0, delta: {}, finish_reason: "tool_calls" });
    } else {
      const text = textSteps.map((s) => s.text).join("");
      streamChunk(res, {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      });
      streamChunk(res, { index: 0, delta: {}, finish_reason: "stop" });
    }

    res.write("data: [DONE]\n\n");
    res.end();
  };

  const server: Server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    dbg(`${req.method} ${url}`);

    if (url.endsWith("/models") && req.method === "GET") {
      return json(res, 200, {
        object: "list",
        data: [{ id: model, object: "model", owned_by: "stub" }],
      });
    }
    if (url.endsWith("/chat/completions") && req.method === "POST") {
      // Buffer the body (carries the `tools` catalog), then stream the response.
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handleChatCompletions(res, body));
      return;
    }
    return json(res, 200, {});
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    port,
    setTurn: (turn) => {
      currentTurn = turn;
      requestIndex = 0;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
