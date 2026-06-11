/**
 * Background agents — everything that runs without a user message.
 *
 *   - `heartbeat` — periodic autonomous agent pass ("anything need
 *     doing?"), prompted by prompts/heartbeat.md.
 *   - `dream`    — memory-consolidation agent (daily notes → memory,
 *     mempalace mining), prompted by prompts/dream.md.
 *   - `pulse`    — lightweight liveness/typing-indicator ticker.
 *   - `cron`     — persistent user-scheduled jobs (message / query).
 *   - `triggers` — user-authored watcher scripts that fire wake-ups.
 *
 * All of these drive the backend through the same `BackgroundRunner`
 * surface (core/agent-runtime/capabilities.ts) — they never talk to a
 * concrete backend directly.
 */

export * from "./heartbeat.js";
export * from "./dream.js";
export * from "./pulse.js";
export * from "./cron.js";
export * from "./triggers.js";
