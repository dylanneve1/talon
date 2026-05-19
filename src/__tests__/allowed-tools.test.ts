import { describe, expect, it } from "vitest";

import {
  ALLOWED_TOOLS_BACKGROUND,
  ALLOWED_TOOLS_CORE,
} from "../core/constants.js";
import { ALLOWED_TOOLS_CHAT } from "../backend/claude-sdk/constants.js";

/**
 * The Claude SDK exposes its built-in tools through the `tools` option as a
 * whitelist. These tests pin the contract so future SDK releases that
 * introduce new built-ins (e.g. Monitor, PushNotification, RemoteTrigger as
 * surfaced in the 2026-05 deferred-tool list) don't silently inherit into
 * Talon's tool surface.
 *
 * Symmetry: every tool *not* listed here is implicitly blocked. Any change
 * to the lists below should be a deliberate, reviewed decision — not the
 * accidental side-effect of an SDK upgrade.
 */
describe("allowed tool lists (SDK built-in whitelist)", () => {
  describe("ALLOWED_TOOLS_CORE", () => {
    it("exposes file I/O, shell, search, MCP resources, and the deferred-tool loader", () => {
      const expected = [
        "Read",
        "Write",
        "Edit",
        "NotebookEdit",
        "Bash",
        "Glob",
        "Grep",
        "ToolSearch",
        "ListMcpResourcesTool",
        "ReadMcpResourceTool",
      ];
      for (const tool of expected) {
        expect(ALLOWED_TOOLS_CORE).toContain(tool);
      }
    });

    it("does NOT include interactive/Plan-mode helpers (no human in the loop)", () => {
      const banned = [
        "EnterPlanMode",
        "ExitPlanMode",
        "EnterWorktree",
        "ExitWorktree",
        "TodoWrite",
        "TodoRead",
        "TaskCreate",
        "TaskUpdate",
        "TaskGet",
        "TaskList",
        "TaskOutput",
        "TaskStop",
        "AskUserQuestion",
      ];
      for (const tool of banned) {
        expect(ALLOWED_TOOLS_CORE).not.toContain(tool);
      }
    });

    it("does NOT include the SDK web tools (replaced by Brave Search MCP)", () => {
      expect(ALLOWED_TOOLS_CORE).not.toContain("WebSearch");
      expect(ALLOWED_TOOLS_CORE).not.toContain("WebFetch");
    });

    it("does NOT include ScheduleWakeup — wedged the dispatcher on 2026-04-27", () => {
      // Calling ScheduleWakeup outside /loop dynamic mode registers a wakeup
      // the runtime never fires, holding the chat lock indefinitely.
      // talon.log [e2589f7e] confirmed root cause of a 35-minute hang.
      expect(ALLOWED_TOOLS_CORE).not.toContain("ScheduleWakeup");
    });

    it("does NOT include Monitor / PushNotification / RemoteTrigger — Talon owns the trigger surface", () => {
      // Talon implements its own trigger system + gateway-driven push paths.
      // Exposing the SDK equivalents creates two parallel automation surfaces
      // with different lifecycle guarantees.
      expect(ALLOWED_TOOLS_CORE).not.toContain("Monitor");
      expect(ALLOWED_TOOLS_CORE).not.toContain("PushNotification");
      expect(ALLOWED_TOOLS_CORE).not.toContain("RemoteTrigger");
    });
  });

  describe("ALLOWED_TOOLS_BACKGROUND", () => {
    it("inherits everything from CORE", () => {
      for (const tool of ALLOWED_TOOLS_CORE) {
        expect(ALLOWED_TOOLS_BACKGROUND).toContain(tool);
      }
    });

    it("additionally exposes Skill (for /loop etc.) but not Agent (no nested sub-agents in dream/heartbeat)", () => {
      expect(ALLOWED_TOOLS_BACKGROUND).toContain("Skill");
      expect(ALLOWED_TOOLS_BACKGROUND).not.toContain("Agent");
    });
  });

  describe("ALLOWED_TOOLS_CHAT", () => {
    it("inherits everything from CORE", () => {
      for (const tool of ALLOWED_TOOLS_CORE) {
        expect(ALLOWED_TOOLS_CHAT).toContain(tool);
      }
    });

    it("additionally exposes Agent + Skill (chat-only sub-agent + skill flows)", () => {
      expect(ALLOWED_TOOLS_CHAT).toContain("Agent");
      expect(ALLOWED_TOOLS_CHAT).toContain("Skill");
    });

    it("still does NOT include the SDK web tools or Monitor/PushNotification/RemoteTrigger", () => {
      expect(ALLOWED_TOOLS_CHAT).not.toContain("WebSearch");
      expect(ALLOWED_TOOLS_CHAT).not.toContain("WebFetch");
      expect(ALLOWED_TOOLS_CHAT).not.toContain("Monitor");
      expect(ALLOWED_TOOLS_CHAT).not.toContain("PushNotification");
      expect(ALLOWED_TOOLS_CHAT).not.toContain("RemoteTrigger");
    });
  });
});
