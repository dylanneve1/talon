/**
 * Engine — the message-flow core.
 *
 *   - `dispatcher`         — per-chat serial, cross-chat parallel turn
 *     execution; the single entry point for "run this user message".
 *   - `gateway`            — loopback HTTP bridge the MCP tool
 *     subprocesses call back into.
 *   - `gateway-actions`    — the action handlers the bridge dispatches
 *     to (send/edit/react/cron/trigger/admin …).
 *   - `backend-controller` — backend lifecycle: init, hot-swap,
 *     cleanup, registry lookup.
 *
 * Everything here is frontend- and backend-agnostic: frontends feed
 * the dispatcher, backends are reached through the agent-runtime
 * capability slots.
 */

export * from "./dispatcher.js";
export * from "./gateway.js";
export * from "./backend-controller.js";
