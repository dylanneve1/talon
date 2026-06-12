import { describe, expect, it } from "vitest";

import {
  checkNativeModules,
  collectDoctorReport,
  type DoctorReport,
} from "../core/doctor.js";
import { renderDoctorMessage } from "../frontend/telegram/helpers.js";

describe("checkNativeModules", () => {
  it("verifies all three embedded modules with provenance", async () => {
    const native = await checkNativeModules();
    expect(native.map((m) => m.name)).toEqual([
      "blake3",
      "textops",
      "scheduler-core",
    ]);
    for (const mod of native) {
      expect(mod.ok, `${mod.name}: ${mod.note}`).toBe(true);
    }
    const byName = Object.fromEntries(native.map((m) => [m.name, m]));
    expect(byName.blake3.language).toBe("Rust");
    expect(byName.blake3.sizeBytes).toBeGreaterThan(0);
    expect(byName.textops.language).toBe("Zig");
    expect(byName.textops.sizeBytes).toBeGreaterThan(0);
    expect(byName["scheduler-core"].language).toBe("Gleam");
    // Gleam compiles to plain JS — there is no embedded wasm artifact.
    expect(byName["scheduler-core"].sizeBytes).toBeUndefined();
  });
});

describe("collectDoctorReport", () => {
  it("fails the config check when no config file exists", async () => {
    const report = await collectDoctorReport({ hasConfigFile: false });
    const labels = report.checks.map((c) => c.label);
    expect(labels).toContain("No config file");
    expect(report.issues).toBeGreaterThanOrEqual(1);
  });

  it("reports a configured bundled backend with zero backend issues", async () => {
    const report = await collectDoctorReport({
      hasConfigFile: true,
      config: { frontend: "terminal", backend: "kilo" },
    });
    const labels = report.checks.map((c) => c.label);
    expect(labels).toContain("Frontend: terminal");
    expect(labels).toContain("Kilo SDK bundled");
    expect(report.native).toHaveLength(3);
    // Node version and workspace presence vary by machine — assert
    // that nothing *else* (frontend, backend, native) raises an issue.
    const envCheck = (label: string) =>
      label.startsWith("Node.js ") || label.startsWith("Workspace");
    const nonEnvIssues = report.checks.filter(
      (c) => (c.status === "fail" || c.issue) && !envCheck(c.label),
    );
    expect(nonEnvIssues).toEqual([]);
    expect(report.native.every((m) => m.ok)).toBe(true);
  });

  it("flags an unconfigured telegram frontend", async () => {
    const report = await collectDoctorReport({
      hasConfigFile: true,
      config: { frontend: "telegram", backend: "opencode" },
    });
    const labels = report.checks.map((c) => c.label);
    expect(labels).toContain("Frontend not fully configured");
    expect(report.issues).toBeGreaterThanOrEqual(1);
  });

  it("counts warn checks marked as issues (missing openai-agents auth)", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const report = await collectDoctorReport({
        hasConfigFile: true,
        config: { frontend: "terminal", backend: "openai-agents" },
      });
      const auth = report.checks.find(
        (c) => c.label === "OpenAI Agents auth missing",
      );
      expect(auth?.status).toBe("warn");
      expect(auth?.issue).toBe(true);
      expect(report.issues).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("renderDoctorMessage", () => {
  const healthyReport: DoctorReport = {
    checks: [
      { label: "Node.js 24.0.0", status: "ok" },
      { label: "Frontend: telegram", status: "ok", detail: "configured" },
    ],
    native: [
      {
        name: "blake3",
        language: "Rust",
        target: "wasm32-unknown-unknown",
        sizeBytes: 60_000,
        ok: true,
      },
      {
        name: "scheduler-core",
        language: "Gleam",
        target: "JavaScript",
        ok: true,
      },
    ],
    issues: 0,
  };

  it("renders sections, modules, process info, and the all-clear", () => {
    const html = renderDoctorMessage(healthyReport);
    expect(html).toContain("<b>🩺 Talon Doctor</b>");
    expect(html).toContain("<b>Environment</b>");
    expect(html).toContain("<b>Native modules</b>");
    expect(html).toContain("<code>blake3</code>");
    expect(html).toContain("Rust → wasm32-unknown-unknown · 58.6 KB");
    // No size segment for modules without an embedded artifact.
    expect(html).toContain("Gleam → JavaScript\n");
    expect(html).toContain("Uptime ");
    expect(html).toContain(`PID ${process.pid}`);
    expect(html).toContain("✅ All checks passed.");
  });

  it("renders failures with counts and escapes HTML in details", () => {
    const html = renderDoctorMessage({
      checks: [
        {
          label: "Claude Code <binary> not found",
          status: "fail",
          detail: "/usr/local/bin/<claude>",
        },
      ],
      native: [
        {
          name: "textops",
          language: "Zig",
          target: "wasm32-freestanding",
          ok: false,
          note: "magic <header> mismatch",
        },
      ],
      issues: 2,
    });
    expect(html).toContain("❌ Claude Code &lt;binary&gt; not found");
    expect(html).toContain("(/usr/local/bin/&lt;claude&gt;)");
    expect(html).toContain("(magic &lt;header&gt; mismatch)");
    expect(html).toContain("⚠️ 2 issue(s) found.");
    expect(html).not.toContain("<claude>");
  });
});
