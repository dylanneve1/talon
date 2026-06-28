import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Backend,
  BackgroundRunner,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import {
  clearBackends,
  registerBackend,
  type BackendFactory,
} from "../core/agent-runtime/backend-registry.js";
import {
  cleanupBackendPool,
  initBackendPool,
  resetBackendPoolForTest,
} from "../core/engine/backend-controller.js";
import type { OneShotAgentParams, UnifiedModelInfo } from "../core/types.js";
import type { CronJob } from "../storage/cron-store.js";
import type { TalonConfig } from "../util/config.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const { executeJob, initCron } = await import("../core/background/cron.js");
const { logWarn } = await import("../util/log.js");

const STUB_CONFIG = { backend: "claude" } as unknown as TalonConfig;
const STUB_CTX = {
  getBridgePort: () => 0,
  frontendName: "terminal" as const,
};

function fakeBackground(
  run: (p: OneShotAgentParams) => Promise<void>,
): BackgroundRunner {
  return { runOneShotAgent: run };
}

function exactModel(id: string): UnifiedModelInfo {
  return {
    id,
    displayName: id,
    provider: "test",
    providerName: "Test",
    selectable: true,
  };
}

function backendWithModel(
  run: (p: OneShotAgentParams) => Promise<void>,
  validModel: string | null,
): Backend {
  return composeBackend({
    id: "codex",
    label: "codex",
    background: fakeBackground(run),
    models: {
      async resolveModelInfo(query: string) {
        if (query === validModel) {
          const model = exactModel(query);
          return { kind: "exact" as const, model, storedValue: query };
        }
        return { kind: "missing" as const };
      },
      getDefaultModelId: () => validModel,
      getRawModelInfo: async (id: string) =>
        id === validModel ? exactModel(id) : undefined,
    },
  });
}

function backendFactory(
  id: string,
  backend: Backend,
  cleanup?: () => void,
): BackendFactory {
  return {
    id,
    label: id,
    async init() {
      return { backend, cleanup };
    },
  };
}

async function initPoolWithBeta(backend: Backend): Promise<void> {
  registerBackend(
    backendFactory("claude", composeBackend({ id: "claude", label: "claude" })),
  );
  registerBackend(backendFactory("codex", backend));
  await initBackendPool(STUB_CONFIG, STUB_CTX);
}

function queryJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    chatId: "42",
    schedule: "0 9 * * *",
    type: "query",
    content: "check status",
    name: "Status check",
    enabled: true,
    createdAt: Date.now(),
    runCount: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
  vi.clearAllMocks();
});

afterEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
});

describe("cron query runtime", () => {
  it("falls back to resolveChatModel when no provider/model override is stored", async () => {
    const run = vi.fn(async (_params: OneShotAgentParams) => {});
    await initPoolWithBeta(backendWithModel(run, "model-ok"));
    const sendMessage = vi.fn(async () => {});
    const resolveChatModel = vi.fn(async () => ({
      model: "model-ok",
      backendId: "codex",
    }));
    initCron({ sendMessage, resolveChatModel });

    const result = await executeJob(queryJob());

    expect(result).toEqual({ status: "ran" });
    expect(resolveChatModel).toHaveBeenCalledWith("42");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].model).toBe("model-ok");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("throws clearly when the no-override path resolves no model", async () => {
    const sendMessage = vi.fn(async () => {});
    initCron({
      sendMessage,
      resolveChatModel: vi.fn(async () => ({
        model: null,
        backendId: "codex",
      })),
    });

    await expect(executeJob(queryJob())).rejects.toThrow(
      /no model resolved for backend "codex"/,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skips and notifies the chat when the stored provider/model is stale", async () => {
    const run = vi.fn(async (_params: OneShotAgentParams) => {});
    await initPoolWithBeta(backendWithModel(run, "model-ok"));
    const sendMessage = vi.fn(async () => {});
    initCron({
      sendMessage,
      resolveChatModel: vi.fn(async () => ({
        model: "model-ok",
        backendId: "codex",
      })),
    });

    const result = await executeJob(
      queryJob({ provider: "codex", model: "stale-model" }),
    );

    expect(result).toEqual({
      status: "skipped",
      reason: `model "stale-model" is not selectable on provider "codex".`,
    });
    expect(run).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining(
        `Cron job "Status check" skipped: model "stale-model" is not selectable on provider "codex".`,
      ),
    );
  });
});
