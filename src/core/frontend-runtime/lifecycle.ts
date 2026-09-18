/**
 * Frontend lifecycle sequencing for the composition roots (`app.ts`,
 * `cli/chat.ts`).
 *
 * One rule, no per-frontend special cases: `start()` resolves when the
 * frontend is listening (`capabilities.ts`), so bringing the daemon up
 * is "start them all, wait for readiness" — and whatever the caller
 * sequences afterwards (boot metrics, the resource sampler, the "Ready
 * in …" line) runs at the true end of the boot.
 */

import { log } from "../../util/log.js";
import type { Frontend } from "./capabilities.js";
import { getFrontendDescriptor } from "./registry.js";

/**
 * Start every configured frontend in parallel and resolve once they are
 * all listening. Rejects as soon as one fails to come up.
 */
export async function startFrontends(
  frontends: readonly Frontend[],
): Promise<void> {
  const sharesStdin = frontends.some(
    (frontend) => getFrontendDescriptor(frontend.name)?.sharesStdin === true,
  );
  if (sharesStdin && frontends.length > 1) {
    log(
      "bot",
      "Terminal frontend shares stdin with the other frontends; keystrokes here reach the terminal prompt only.",
    );
  }
  await Promise.all(frontends.map((frontend) => frontend.start()));
}
