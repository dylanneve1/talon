/** Bounded turn execution for OpenCode/Kilo's long-lived HTTP servers. */

import { logWarn } from "../../util/log.js";

const DEFAULT_REMOTE_TURN_TIMEOUT_MS = 10 * 60_000;

export function remoteTurnTimeoutMs(): number {
  const configured = Number(process.env.TALON_REMOTE_TURN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REMOTE_TURN_TIMEOUT_MS;
}

export class RemoteTurnTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} turn timed out after ${Math.round(timeoutMs / 1000)}s`);
    // Core error classification treats TimeoutError as a retryable transport
    // failure, so the normal fallback-model path remains available.
    this.name = "TimeoutError";
  }
}

export interface RemoteTurnAbortClient {
  session: {
    abort(args: { sessionID: string }): Promise<unknown>;
  };
}

/**
 * Race a prompt+SSE turn against a hard deadline. On expiry, abort upstream
 * generation before rejecting so the provider stops spending tokens and the
 * session can be safely reset by the shared retry path.
 */
export async function awaitRemoteTurn<T>(
  turn: Promise<T>,
  inputs: {
    client: RemoteTurnAbortClient;
    sessionId: string;
    chatId: string;
    label: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const timeoutMs = inputs.timeoutMs ?? remoteTurnTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      turn,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          logWarn(
            "agent",
            `[${inputs.chatId}] ${inputs.label} turn exceeded ${Math.round(timeoutMs / 1000)}s; aborting`,
          );
          inputs.client.session
            .abort({ sessionID: inputs.sessionId })
            .catch((err) =>
              logWarn(
                "agent",
                `[${inputs.chatId}] ${inputs.label} timeout abort failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          reject(new RemoteTurnTimeoutError(inputs.label, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
