/**
 * The "started, not stopped" seam for frontends that own a
 * run-until-stopped loop (Telegram's long-poll, WhatsApp's reconnect
 * loop).
 *
 * Those loops resolve when the frontend STOPS, which is the opposite of
 * what `start()` promises (`capabilities.ts`). This splits one loop into
 * the two signals the lifecycle actually needs: `ready`, which settles
 * the moment the loop reports it is listening, and `stopped`, the loop
 * itself — kept by the frontend and awaited in `stop()`.
 */

/** A split run loop: readiness for `start()`, the loop itself for `stop()`. */
export type RunHandle = {
  /** Resolves when the loop signalled readiness; rejects if it failed first. */
  ready: Promise<void>;
  /** Resolves when the loop has ended. Never rejects — see `onError`. */
  stopped: Promise<void>;
};

/**
 * Run `loop`, handing it the callback that marks the frontend listening.
 *
 * A loop that ends — or throws — before it ever signalled readiness
 * settles `ready` anyway: a boot must fail or proceed, never hang on a
 * surface that already gave up. `onError` receives a failure the loop
 * hits after readiness, which nothing else would ever observe.
 */
export function runUntilStopped(
  loop: (signalReady: () => void) => Promise<void>,
  onError: (err: unknown) => void,
): RunHandle {
  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readyState: "pending" | "resolved" | "rejected" = "pending";
  const markReady = (): void => {
    if (readyState !== "pending") return;
    readyState = "resolved";
    resolveReady();
  };
  const running = loop(markReady);
  // Settle `ready` on the loop's own outcome too: a loop that ends (or
  // fails) before signalling readiness must not leave the boot hanging.
  running.then(markReady, (err: unknown) => {
    if (readyState !== "pending") return;
    readyState = "rejected";
    rejectReady(err);
  });
  const stopped = running.catch((err: unknown) => {
    // A failure before readiness is already the caller's — `start()`
    // rejects with it. Only report what nobody else would see.
    if (readyState !== "rejected") onError(err);
  });
  return { ready, stopped };
}
