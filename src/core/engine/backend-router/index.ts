/**
 * Plan-aware backend router.
 *
 *   - `ledger`   — the local rolling token count that gives budget-only
 *                  backends a headroom signal.
 *   - `headroom` — one comparable "how much is left" per backend, from the
 *                  plan API where there is one and the ledger where there
 *                  is not.
 *   - `router`   — the decision: who runs this background job.
 */

export {
  flushBackendLedger,
  ledgerUsage,
  loadBackendLedger,
  recordBackendUsage,
  resetBackendLedgerForTest,
  tokensInWindow,
  LEDGER_RETENTION_MS,
  LEDGER_SHORT_WINDOW_MS,
} from "./ledger.js";
export {
  collectBackendHeadroom,
  formatHeadroom,
  getBackendHeadroom,
  hasBudget,
  headroomFromLedger,
  headroomFromPlan,
  limitingWindowOf,
  resetHeadroomCacheForTest,
  HEADROOM_CACHE_MS,
  type BackendHeadroom,
  type HeadroomSource,
  type LimitingWindow,
} from "./headroom.js";
export {
  chooseBackend,
  taskClassForEffort,
  DEFAULT_CEILING_PERCENT,
  type RouteDecision,
  type RouteHints,
  type RoutePurpose,
  type RouteRequest,
  type TaskClass,
} from "./router.js";
