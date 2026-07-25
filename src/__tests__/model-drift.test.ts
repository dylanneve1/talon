/**
 * Model-drift detection — the boot-time config audit
 * (core/engine/model-audit), the turn-time drift check
 * (backend/claude-sdk/model-drift), and the doctor config-model check.
 *
 * The scenario all three guard: a model pinned in config is withdrawn
 * from the provider's catalog, and every turn silently runs the
 * backend default while the config keeps naming the dead id. This has
 * happened in production and was discovered only by reading per-turn
 * accounting lines.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const logWarnMock = vi.fn();
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  logDebug: vi.fn(),
}));

import { auditConfiguredModels } from "../core/engine/model-audit.js";
import {
  isSameModel,
  checkModelDrift,
  resetModelDriftWarnings,
} from "../backend/claude-sdk/model-drift.js";
import type { Backend } from "../core/agent-runtime/capabilities.js";
import type { TalonConfig } from "../util/config.js";

function fakeBackend(
  resolution:
    | { kind: "exact" }
    | { kind: "missing" }
    | { kind: "ambiguous" }
    | "throws"
    | "no-catalog",
): Backend {
  if (resolution === "no-catalog") return {} as Backend;
  return {
    models: {
      resolveModelInfo: vi.fn(async () => {
        if (resolution === "throws") throw new Error("catalog down");
        if (resolution.kind === "exact") {
          return {
            kind: "exact",
            model: { id: "m", displayName: "M" },
            storedValue: "m",
          };
        }
        if (resolution.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            matches: [
              { id: "a", displayName: "A" },
              { id: "b", displayName: "B" },
            ],
          };
        }
        return { kind: "missing" };
      }),
    },
  } as unknown as Backend;
}

/**
 * Backend whose catalog resolves any pin exactly, to a model advertising
 * `levels`. Used for the effort half of the audit: `undefined` levels stand
 * for a catalog that reports no reasoning metadata at all.
 */
function fakeBackendWithLevels(levels: string[] | undefined): Backend {
  return {
    models: {
      resolveModelInfo: vi.fn(async () => ({
        kind: "exact",
        model: {
          id: "m",
          displayName: "M",
          ...(levels ? { supportedReasoningLevels: levels } : {}),
        },
        storedValue: "m",
      })),
    },
  } as unknown as Backend;
}

function cfg(overrides: Partial<TalonConfig>): TalonConfig {
  return { backend: "claude", model: "default", ...overrides } as TalonConfig;
}

describe("auditConfiguredModels", () => {
  it("flags a pinned chat model missing from the backend catalog", async () => {
    const findings = await auditConfiguredModels(
      cfg({ model: "claude-fable-5" }),
      () => fakeBackend({ kind: "missing" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      role: "chat",
      configured: "claude-fable-5",
      kind: "missing",
    });
    expect(findings[0].message).toContain('"model" in config.json');
  });

  it("audits heartbeat/dream models against their own backends", async () => {
    const calls: string[] = [];
    const findings = await auditConfiguredModels(
      cfg({
        model: "default",
        heartbeatModel: "ghost-model",
        heartbeatBackend: "claude",
      }),
      (role) => {
        calls.push(role);
        return fakeBackend({ kind: "missing" });
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].role).toBe("heartbeat");
    expect(findings[0].message).toContain("heartbeatModel");
    // chat model is "default" → skipped, no backend lookup for it
    expect(calls).toEqual(["heartbeat"]);
  });

  it("reports ambiguous pins with the candidate names", async () => {
    const findings = await auditConfiguredModels(cfg({ model: "son" }), () =>
      fakeBackend({ kind: "ambiguous" }),
    );
    expect(findings[0]).toMatchObject({ kind: "ambiguous" });
    expect(findings[0].message).toContain("A, B");
  });

  it("is silent for resolvable pins, unset models, and defaults", async () => {
    expect(
      await auditConfiguredModels(cfg({ model: "opus" }), () =>
        fakeBackend({ kind: "exact" }),
      ),
    ).toEqual([]);
    expect(
      await auditConfiguredModels(cfg({ model: "default" }), () =>
        fakeBackend({ kind: "missing" }),
      ),
    ).toEqual([]);
  });

  it("flags a heartbeat effort the pinned model does not advertise", async () => {
    const findings = await auditConfiguredModels(
      cfg({ heartbeatModel: "m", heartbeatEffort: "xhigh" }),
      () => fakeBackendWithLevels(["low", "medium", "high"]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      role: "heartbeat",
      configured: "xhigh",
      kind: "unsupported-effort",
    });
    expect(findings[0].message).toContain('"heartbeatEffort" in config.json');
    expect(findings[0].message).toContain("low, medium, high");
  });

  it("flags a dream effort the pinned model does not advertise", async () => {
    const findings = await auditConfiguredModels(
      cfg({ dreamModel: "m", dreamEffort: "max" }),
      () => fakeBackendWithLevels(["minimal", "low", "medium", "high"]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      role: "dream",
      configured: "max",
      kind: "unsupported-effort",
    });
    expect(findings[0].message).toContain('"dreamEffort" in config.json');
  });

  it("is silent for a supported effort", async () => {
    expect(
      await auditConfiguredModels(
        cfg({ heartbeatModel: "m", heartbeatEffort: "high" }),
        () => fakeBackendWithLevels(["low", "medium", "high"]),
      ),
    ).toEqual([]);
  });

  it("is silent when the model reports no reasoning metadata", async () => {
    // Absence of metadata is not evidence the level is unsupported —
    // warning here would fire on every catalog that omits the field.
    expect(
      await auditConfiguredModels(
        cfg({ heartbeatModel: "m", heartbeatEffort: "xhigh" }),
        () => fakeBackendWithLevels(undefined),
      ),
    ).toEqual([]);
  });

  it("never throws when a backend is unauditable", async () => {
    expect(
      await auditConfiguredModels(cfg({ model: "x" }), () =>
        fakeBackend("no-catalog"),
      ),
    ).toEqual([]);
    expect(
      await auditConfiguredModels(cfg({ model: "x" }), () =>
        fakeBackend("throws"),
      ),
    ).toEqual([]);
    expect(
      await auditConfiguredModels(cfg({ model: "x" }), () => {
        throw new Error("role not bound");
      }),
    ).toEqual([]);
  });
});

describe("isSameModel (alias tolerance)", () => {
  it("treats aliases and expansions as the same model", () => {
    expect(isSameModel("opus", "claude-opus-4-8")).toBe(true);
    expect(isSameModel("claude-opus-4-8", "opus")).toBe(true);
    expect(isSameModel("sonnet[1m]", "sonnet")).toBe(true);
    expect(isSameModel("Sonnet", "sonnet")).toBe(true);
  });

  it("flags genuinely different models", () => {
    expect(isSameModel("claude-fable-5", "claude-opus-4-8")).toBe(false);
    expect(isSameModel("opus", "claude-haiku-4-5")).toBe(false);
  });
});

describe("checkModelDrift", () => {
  beforeEach(() => {
    resetModelDriftWarnings();
    logWarnMock.mockClear();
  });

  it("warns once per (requested → actual) pair", () => {
    checkModelDrift("claude-fable-5", ["claude-opus-4-8"]);
    checkModelDrift("claude-fable-5", ["claude-opus-4-8"]);
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(String(logWarnMock.mock.calls[0][1])).toContain("[MODEL DRIFT]");

    checkModelDrift("claude-fable-5", ["claude-haiku-4-5"]);
    expect(logWarnMock).toHaveBeenCalledTimes(2);
  });

  it("stays silent for default pins, alias matches, and empty usage", () => {
    checkModelDrift("default", ["claude-opus-4-8"]);
    checkModelDrift("opus", ["claude-opus-4-8"]);
    checkModelDrift("sonnet[1m]", ["sonnet"]);
    checkModelDrift("opus", []);
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});

describe("doctor configured-model check (claude static catalog)", () => {
  it("flags an unselectable pinned model as a warn-with-issue", async () => {
    const { collectDoctorReport } = await import("../core/doctor.js");
    const report = await collectDoctorReport({
      hasConfigFile: true,
      config: {
        frontend: "terminal",
        backend: "claude",
        model: "claude-fable-5-definitely-gone",
      },
    });
    const check = report.checks.find((c) =>
      c.label.includes("claude-fable-5-definitely-gone"),
    );
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.issue).toBe(true);
  });

  it("confirms a resolvable pin with its display name", async () => {
    const { collectDoctorReport } = await import("../core/doctor.js");
    const report = await collectDoctorReport({
      hasConfigFile: true,
      config: { frontend: "terminal", backend: "claude", model: "opus" },
    });
    const check = report.checks.find((c) =>
      c.label.startsWith("Model (model)"),
    );
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
  });
});
