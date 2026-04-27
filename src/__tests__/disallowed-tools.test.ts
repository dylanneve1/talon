import { describe, expect, it } from "vitest";

import {
  DISALLOWED_TOOLS_BACKGROUND,
  DISALLOWED_TOOLS_CORE,
} from "../core/constants.js";
import { DISALLOWED_TOOLS_CHAT } from "../backend/claude-sdk/constants.js";

describe("disallowed tool lists", () => {
  describe("DISALLOWED_TOOLS_CORE", () => {
    it("blocks interactive/planning tools that are nonsensical in headless contexts", () => {
      const expected = [
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
      for (const tool of expected) {
        expect(DISALLOWED_TOOLS_CORE).toContain(tool);
      }
    });

    it("blocks ScheduleWakeup — /loop-skill-only tool that wedges the dispatcher when called outside /loop mode", () => {
      // Confirmed root cause of a 35-minute hang on 2026-04-27.
      // ScheduleWakeup registers a wakeup the runtime never fires, so the
      // chat lock is held indefinitely until manual restart.
      expect(DISALLOWED_TOOLS_CORE).toContain("ScheduleWakeup");
    });
  });

  describe("DISALLOWED_TOOLS_BACKGROUND", () => {
    it("inherits everything from CORE", () => {
      for (const tool of DISALLOWED_TOOLS_CORE) {
        expect(DISALLOWED_TOOLS_BACKGROUND).toContain(tool);
      }
    });

    it("additionally blocks Agent (no nested agents in dream/heartbeat)", () => {
      expect(DISALLOWED_TOOLS_BACKGROUND).toContain("Agent");
    });
  });

  describe("DISALLOWED_TOOLS_CHAT", () => {
    it("inherits everything from CORE", () => {
      for (const tool of DISALLOWED_TOOLS_CORE) {
        expect(DISALLOWED_TOOLS_CHAT).toContain(tool);
      }
    });

    it("additionally blocks Claude's built-in web tools (replaced by Brave MCP)", () => {
      expect(DISALLOWED_TOOLS_CHAT).toContain("WebSearch");
      expect(DISALLOWED_TOOLS_CHAT).toContain("WebFetch");
    });
  });
});
