/**
 * Terminal renderer — output formatting, spinner (via ora), and status line.
 *
 * No alternate screen buffers. No scroll regions. No cursor repositioning.
 * Just clean output that works reliably on every terminal including PowerShell.
 *
 * Spinner is handled by `ora` — battle-tested, cross-platform, flicker-free.
 * Status line renders as a single dim line above the prompt.
 */

import type { Interface as ReadlineInterface } from "node:readline";
import pc from "picocolors";
import ora, { type Ora } from "ora";

// ── Types ────────────────────────────────────────────────────────────────────

export type StatusBarInfo = {
  model: string;
  sessionName?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitPct: number;
  costUsd: number;
};

export type Renderer = {
  readonly cols: number;

  // Output primitives
  writeln(text?: string): void;
  writeSystem(text: string): void;
  writeError(text: string): void;

  // Messages
  renderAssistantMessage(text: string): void;
  renderToolCall(toolName: string, input: Record<string, unknown>): void;
  renderStats(
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
    cacheRead: number,
    tools: number,
  ): void;

  // Spinner (via ora)
  startSpinner(label?: string, rl?: ReadlineInterface | null): void;
  updateSpinnerLabel(label: string): void;
  stopSpinner(rl?: ReadlineInterface | null): void;

  // Status line
  initStatusBar(): void;
  updateStatusBar(info: StatusBarInfo): void;
  destroyStatusBar(): void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const HIDDEN_TOOLS = new Set(["TodoRead", "TodoWrite"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Word-wrap text to fit terminal width, preserving existing newlines. */
export function wrap(text: string, indent: number, maxWidth: number): string {
  const width = maxWidth - indent;
  if (width <= 20) return text;
  const pad = " ".repeat(indent);
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return pad + line;
      const words = line.split(" ");
      const wrapped: string[] = [];
      let current = "";
      for (const word of words) {
        if (current.length + word.length + 1 > width && current) {
          wrapped.push(pad + current);
          current = word;
        } else {
          current = current ? current + " " + word : word;
        }
      }
      if (current) wrapped.push(pad + current);
      return wrapped.join("\n");
    })
    .join("\n");
}

/** Format a timestamp as relative time (e.g. "2h ago", "3d ago"). */
export function formatTimeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Format token count compactly (e.g. 12345 → "12.3k"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Extract display detail from a tool call's input parameters. */
export function extractToolDetail(
  input: Record<string, unknown>,
  maxDetail: number,
): string {
  if (input.command) {
    const src = String(input.description || input.command);
    return src.length > maxDetail ? src.slice(0, maxDetail - 3) + "..." : src;
  }
  if (input.file_path) return String(input.file_path);
  if (input.pattern && input.path) return `${input.pattern} in ${input.path}`;
  if (input.pattern) return String(input.pattern);
  if (input.action) return String(input.action);
  if (input.query) return String(input.query).slice(0, maxDetail);
  if (input.url) return String(input.url).slice(0, maxDetail);
  if (input.type) return String(input.type);
  if (input.name) return String(input.name);
  if (input.model) return String(input.model);
  if (input.package_url) return String(input.package_url);
  if (input.build_number) return `#${input.build_number}`;
  if (input.packages) return (input.packages as string[]).join(", ");

  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === "_chatId") continue;
    if (typeof v === "string" && v.length > 0) {
      parts.push(`${k}=${v.length > 30 ? v.slice(0, 30) + "..." : v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join(", ").slice(0, maxDetail);
}

/** Clean MCP tool names: "mcp__server__tool_name" → "tool_name" */
export function cleanToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1] || name;
  }
  return name;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRenderer(cols?: number): Renderer {
  const COLS = cols ?? Math.min(process.stdout.columns || 100, 120);

  // Spinner (ora instance, created lazily)
  let spinner: Ora | null = null;

  // Status line state
  let statusBarActive = false;
  let statusBarContent = "";

  // ── Output primitives ──

  function writeln(text = ""): void {
    process.stdout.write(`\x1b[2K\r${text}\n`);
  }

  function writeSystem(text: string): void {
    writeln(`  ${pc.dim(text)}`);
  }

  function writeError(text: string): void {
    writeln();
    writeln(`  ${pc.red("✖")} ${pc.red(text)}`);
  }

  // ── Message rendering ──

  function renderAssistantMessage(text: string): void {
    writeln();
    writeln(`  ${pc.cyan("▍")} ${pc.bold(pc.cyan("Talon"))}`);
    const wrapped = wrap(text, 2, COLS);
    for (const line of wrapped.split("\n")) {
      writeln(`  ${pc.cyan("▍")}${line}`);
    }
  }

  let hasToolOutput = false;

  function resetToolOutput(): void {
    hasToolOutput = false;
  }

  function renderToolCall(
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const clean = cleanToolName(toolName);
    if (HIDDEN_TOOLS.has(clean)) return;

    if (!hasToolOutput) {
      hasToolOutput = true;
      writeln();
    }

    const displayName = clean.replace(/_/g, " ");
    const maxDetail = COLS - displayName.length - 16;
    const detail = extractToolDetail(input, maxDetail);
    const detailStr = detail ? `  ${pc.dim(detail)}` : "";
    writeln(`    ${pc.dim("→")} ${pc.yellow(displayName)}${detailStr}`);
  }

  function renderStats(
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
    cacheRead: number,
    tools: number,
  ): void {
    const dur = (durationMs / 1000).toFixed(1);
    const cacheHit =
      inputTokens + cacheRead > 0
        ? Math.round((cacheRead / (inputTokens + cacheRead)) * 100)
        : 0;
    const parts = [
      `${dur}s`,
      `${inputTokens + outputTokens} tok`,
      `${cacheHit}% cache`,
    ];
    if (tools > 0) parts.push(`${tools} tool${tools > 1 ? "s" : ""}`);
    writeln();
    writeln(`  ${pc.dim(parts.join("  ·  "))}`);
    resetToolOutput();
  }

  // ── Spinner (via ora) ──

  function startSpinner(
    label = "thinking",
    rl?: ReadlineInterface | null,
  ): void {
    stopSpinner(rl);
    if (rl) rl.pause();
    spinner = ora({
      text: label,
      indent: 4,
      spinner: "dots",
    }).start();
  }

  function updateSpinnerLabel(label: string): void {
    if (spinner) spinner.text = label;
  }

  function stopSpinner(rl?: ReadlineInterface | null): void {
    if (spinner) {
      spinner.stop();
      // ora leaves the cursor on the spinner line — clear it
      process.stdout.write("\x1b[2K\r");
      spinner = null;
    }
    if (rl) rl.resume();
  }

  // ── Status line (single dim line above prompt) ──

  function initStatusBar(): void {
    statusBarActive = true;
  }

  function updateStatusBar(info: StatusBarInfo): void {
    if (!statusBarActive) return;
    const totalTok = formatTokens(info.inputTokens + info.outputTokens);
    const parts = [info.model];
    if (info.sessionName) parts.push(`"${info.sessionName}"`);
    parts.push(
      `${info.turns} turn${info.turns !== 1 ? "s" : ""}`,
      `${totalTok} tok`,
      `${info.cacheHitPct}% cache`,
    );
    if (info.costUsd > 0) parts.push(`$${info.costUsd.toFixed(2)}`);
    statusBarContent = parts.join("  ·  ");
    drawStatusLine();
  }

  function drawStatusLine(): void {
    if (!statusBarActive || !statusBarContent) return;
    writeln(`  ${pc.dim(statusBarContent)}`);
  }

  function destroyStatusBar(): void {
    statusBarActive = false;
  }

  return {
    cols: COLS,
    writeln,
    writeSystem,
    writeError,
    renderAssistantMessage,
    renderToolCall,
    renderStats,
    startSpinner,
    updateSpinnerLabel,
    stopSpinner,
    initStatusBar,
    updateStatusBar,
    destroyStatusBar,
  };
}
