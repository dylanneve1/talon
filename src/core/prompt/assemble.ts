/**
 * System-prompt assembly — the single place where Talon's system
 * instructions are composed.
 *
 * ## Section pipeline
 *
 * The prompt is an ordered list of markdown sections joined by
 * `\n\n---\n\n`. Static sections (stable for a session's lifetime)
 * and dynamic sections (volatile between rebuilds) are kept apart so
 * providers can prompt-cache the static prefix — see
 * `SystemPromptParts`.
 *
 *   STATIC                                  source
 *   1. Identity                             ~/.talon/prompts/identity.md
 *                                           + ~/.talon/workspace/identity.md
 *   2. Core behaviour                       ~/.talon/prompts/custom.md,
 *                                           else base.md, else fallback
 *   3. Frontend capabilities                ~/.talon/prompts/<frontend>.md
 *   4. Persistent memory (ranked, capped)   prompts/system/persistent-memory.md
 *                                           wrapping ~/.talon/workspace/memory/memory.md
 *                                           via memory-view.ts
 *   4.5 Live state (capped)                 prompts/system/live-state.md
 *                                           wrapping ~/.talon/workspace/memory/state.md
 *                                           (heartbeat-owned, rewritten whole)
 *   5. Memory recall + capability docs      prompts/system/{memory-recall,workspace,...}.md
 *   6. Plugin additions                     plugin.systemPrompt() contributions
 *   (7. Delivery contract — appended by the backend as its suffix,
 *       AFTER plugins, so it is the last thing the model reads.
 *       See backend/shared/delivery-contract.ts.)
 *
 *   DYNAMIC
 *   1. Daily-memory pointer                 prompts/system/daily-memory.md
 *                                           (names today's file — changes at midnight)
 *   2. Skill index                          workspace/skills/<name>/SKILL.md
 *   3. Workspace file listing               workspace-listing.ts
 *                                           (file sizes change as logs grow)
 *
 * ## Ownership
 *
 * Files under `~/.talon/prompts/` are seeded once and user-editable —
 * edits win over package updates. Files under the package's
 * `prompts/system/` are read directly from the package and are NOT
 * seeded: they document runtime behaviour versioned with the code
 * (tool names, flow enforcement, trigger limits), where a stale
 * seeded copy would describe a contract the code no longer
 * implements. See prompts/README.md.
 *
 * ## Deliberate omissions
 *
 * No "Current Date & Time" section: every user message already
 * carries a `[YYYY-MM-DD HH:MM:SS]` tag (see shared/prompt-format),
 * the daily-memory pointer names today's file, and the `check_time`
 * tool covers timezone queries. A minute-precision timestamp here was
 * the single biggest cache-buster — it guaranteed every rebuild
 * produced a unique prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs, files as pathFiles } from "../../util/paths.js";
import { todayAndYesterday } from "../../util/time.js";
import { log } from "../../util/log.js";
import { loadSystemTemplate } from "./templates.js";
import { renderMemoryView } from "./memory-view.js";
import { renderWorkspaceListing } from "./workspace-listing.js";
import { renderSkillsPrompt } from "../../storage/skill-store.js";
import { renderStickerLibraryPrompt } from "../../storage/sticker-store.js";
import { getSoul } from "../soul/service.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * System prompt split for prompt-cache friendliness.
 *
 * `staticText` holds everything stable for the lifetime of a session
 * (identity, behaviour, frontend docs, memory snapshot, capability
 * docs, plugin additions). `dynamicText` holds volatile context
 * (workspace file listing, daily-memory pointer) that changes between
 * rebuilds.
 *
 * The Claude SDK backend sends these as separate blocks divided by
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, so the static prefix is eligible
 * for cross-session prompt caching while volatile content lives after
 * the cache boundary. Other backends join them into a single string —
 * keeping volatile content last still maximises their providers'
 * automatic prefix caching.
 */
export type SystemPromptParts = {
  staticText: string;
  dynamicText: string;
};

/** Join the two prompt parts into the single-string form. */
export function joinSystemPromptParts(parts: SystemPromptParts): string {
  if (!parts.dynamicText) return parts.staticText;
  if (!parts.staticText) return parts.dynamicText;
  return `${parts.staticText}\n\n---\n\n${parts.dynamicText}`;
}

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Cap on the injected `state.md` block. Deliberately much tighter than the
 * memory cap: this is a status snapshot the heartbeat rewrites every run, so
 * anything past a couple of thousand chars means the heartbeat is
 * accumulating history in a file that is supposed to be replaced — the
 * failure the memory/state split exists to prevent. Truncating loudly is the
 * signal that it is happening.
 */
export const STATE_INJECT_MAX_CHARS = 2_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function readOptionalFile(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch {
    /* ignore */
  }
  return "";
}

let lastLoggedPromptKey = "";

// ── Assembly ────────────────────────────────────────────────────────────────

/** Inputs for `assembleSystemPrompt`. */
export type AssemblePromptInputs = {
  /** Primary frontend whose prompt file to load (default: telegram). */
  frontend?: string;
  /** Plugin system-prompt contributions (static; change on plugin reload). */
  pluginPromptAdditions?: string[];
};

/**
 * Assemble the system prompt. See the module docstring for the
 * section pipeline, ownership rules, and the static/dynamic split.
 */
export function assembleSystemPrompt(
  inputs: AssemblePromptInputs,
): SystemPromptParts {
  const promptDir = dirs.prompts;
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];
  const loaded: string[] = [];

  // 1. Identity — static personality from prompts/identity.md plus the
  //    bot's own evolving identity file in the workspace.
  const identityPrompt = readOptionalFile(resolve(promptDir, "identity.md"));
  const identityUser = readOptionalFile(pathFiles.identity);
  if (identityPrompt || identityUser) {
    const identityParts = [identityPrompt, identityUser].filter(Boolean);
    staticParts.push(`## Identity\n\n${identityParts.join("\n\n")}`);
    loaded.push("identity");
  }

  // 1.5. Soul — the compiled identity surface, when the soul is enabled.
  //      Off by default (TALON_SOUL_ENABLED); inert deployments add nothing.
  //      Selection-based and verbatim, so it never injects invented self-text.
  const soulSection = getSoul().renderPromptSection();
  if (soulSection) {
    staticParts.push(soulSection);
    loaded.push("soul");
  }

  // 2. Core behaviour — custom.md replaces base.md wholesale when present.
  const custom = readOptionalFile(resolve(promptDir, "custom.md"));
  const basePrompt = readOptionalFile(resolve(promptDir, "base.md"));
  if (custom) {
    staticParts.push(custom);
    loaded.push("custom");
  } else if (basePrompt) {
    staticParts.push(basePrompt);
    loaded.push("base");
  } else staticParts.push("You are a sharp and helpful AI assistant.");

  // 3. Frontend capabilities (telegram.md / discord.md / teams.md / …).
  const frontendFile = `${inputs.frontend ?? "telegram"}.md`;
  const frontendPrompt = readOptionalFile(resolve(promptDir, frontendFile));
  if (frontendPrompt) {
    staticParts.push(frontendPrompt);
    loaded.push(frontendFile.replace(".md", ""));
  }

  // 4. Persistent memory — size-capped so a memory file that has grown
  //    for months can't bloat every session from turn 0. Over the cap the
  //    view ranks sections rather than head-slicing, so durable knowledge
  //    isn't evicted by whatever happens to sit at the top of the file
  //    (see prompt/memory-view.ts).
  const memory = readOptionalFile(pathFiles.memory);
  if (memory) {
    const { text, truncated, omitted } = renderMemoryView(memory);
    staticParts.push(
      loadSystemTemplate("persistent-memory", {
        content: text,
        truncated: truncated ? "yes" : undefined,
        omitted: omitted || undefined,
      }),
    );
    loaded.push(truncated ? "memory(ranked)" : "memory");
  }

  // 4.5. Live state — the heartbeat's rewritten-whole status snapshot, kept
  //      OUT of memory.md so "as of Run #N" sections can't accrete in the
  //      durable store and push real knowledge past the cap. Capped hard:
  //      this is the most volatile content in the static prompt, and a
  //      status file that grows is the exact failure this split exists to
  //      prevent.
  const state = readOptionalFile(pathFiles.state);
  if (state) {
    const truncated = state.length > STATE_INJECT_MAX_CHARS;
    staticParts.push(
      loadSystemTemplate("live-state", {
        content: truncated
          ? state.slice(0, STATE_INJECT_MAX_CHARS).trimEnd()
          : state,
        truncated: truncated ? "yes" : undefined,
      }),
    );
    loaded.push(truncated ? "state(capped)" : "state");
  }

  // 5. Package-owned behavioural and capability docs. The memory policy
  //    is deliberately package-owned so custom identity/base prompts cannot
  //    remove recall-before-asking or adaptive persistence behaviour.
  //    Provider-specific additions follow in step 6 and become canonical
  //    when their tools are available; otherwise the policy falls back to
  //    memory.md + daily notes.
  staticParts.push(
    loadSystemTemplate("memory-recall"),
    loadSystemTemplate("workspace"),
    loadSystemTemplate("cron"),
    loadSystemTemplate("triggers"),
    loadSystemTemplate("goals"),
    loadSystemTemplate("skills"),
  );

  // 6. Plugin contributions. Static: they only change on plugin
  //    reload, which triggers a full rebuild.
  if (inputs.pluginPromptAdditions) {
    for (const addition of inputs.pluginPromptAdditions) {
      staticParts.push(addition);
    }
  }

  // Dynamic 1: daily-memory pointer (names today's file — read on
  // demand, not injected; changes at midnight).
  const { today } = todayAndYesterday();
  dynamicParts.push(
    loadSystemTemplate("daily-memory", {
      daily_dir: dirs.dailyMemory,
      today,
    }),
  );

  // Dynamic 2: skill index. Names/descriptions are enough for
  // discovery; full markdown bodies stay on disk until loaded.
  const skills = renderSkillsPrompt();
  if (skills) dynamicParts.push(skills);

  // Dynamic 2.5: sticker library index (Telegram only — the one
  // frontend with a sticker send surface). Strict check on purpose:
  // config always resolves a concrete frontend, so an absent value
  // means a caller outside the normal chat path (no sticker tools) —
  // don't inject the index there. Dynamic because packs are
  // auto-saved mid-session as users send stickers.
  if (inputs.frontend === "telegram") {
    const stickerLibrary = renderStickerLibraryPrompt();
    if (stickerLibrary) dynamicParts.push(stickerLibrary);
  }

  // Dynamic 3: workspace file listing (sizes change as logs grow).
  const workspaceFiles = renderWorkspaceListing(dirs.workspace);
  if (workspaceFiles) dynamicParts.push(workspaceFiles);

  const loadedKey = loaded.join(" + ");
  if (loadedKey && loadedKey !== lastLoggedPromptKey) {
    log("config", `System prompt: ${loadedKey}`);
    lastLoggedPromptKey = loadedKey;
  }

  return {
    staticText: staticParts.join("\n\n---\n\n"),
    dynamicText: dynamicParts.join("\n\n---\n\n"),
  };
}
