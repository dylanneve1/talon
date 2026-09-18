/**
 * Telegram `model:*` callback router — the parsed-kind table.
 *
 * Pins the routing contract the if/else chain used to carry implicitly:
 * each parsed kind reaches its own handler with the chat id and deps, the
 * router answers the query (toast or plain ack) and redraws the view the
 * handler named, a handler that already answered gets nothing more, and a
 * kind nobody claims — unparseable data, an Object.prototype name — is
 * acked and dropped.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const handlers = vi.hoisted(() => ({
  done: vi.fn(async () => undefined),
  noop: vi.fn(async () => undefined),
  select: vi.fn(async () => ({ toast: "Model: x", view: { kind: "menu" } })),
  reset: vi.fn(async () => ({ toast: "reset", view: { kind: "menu" } })),
  toggleFree: vi.fn(async () => ({
    toast: "Free only: on",
    view: { kind: "menu" },
  })),
  menu: vi.fn(async () => ({ view: { kind: "menu" } })),
  browse: vi.fn(async () => ({ view: { kind: "browse" } })),
  navBackToProviders: vi.fn(async () => ({
    view: { kind: "browse", page: 1 },
  })),
  navProvider: vi.fn(async () => ({ view: { kind: "browse", page: 1 } })),
  navPage: vi.fn(async () => ({ view: { kind: "browse", page: 2 } })),
  navFilter: vi.fn(async () => ({ view: { kind: "browse", page: 1 } })),
  backends: vi.fn(async () => ({ view: { kind: "backends" } })),
  backendSelect: vi.fn(async () => ({
    toast: "Backend: b",
    view: { kind: "menu" },
  })),
  backendDefault: vi.fn(async () => ({
    toast: "Backend reset",
    view: { kind: "menu" },
  })),
}));
vi.mock("../frontend/telegram/callbacks/model/control.js", () => ({
  handleDone: handlers.done,
  handleNoop: handlers.noop,
}));
vi.mock("../frontend/telegram/callbacks/model/select.js", () => ({
  handleSelect: handlers.select,
  handleReset: handlers.reset,
  handleToggleFree: handlers.toggleFree,
}));
vi.mock("../frontend/telegram/callbacks/model/nav.js", () => ({
  showMenu: handlers.menu,
  showBrowse: handlers.browse,
  navBackToProviders: handlers.navBackToProviders,
  navProvider: handlers.navProvider,
  navPage: handlers.navPage,
  navFilter: handlers.navFilter,
  showBackends: handlers.backends,
}));
vi.mock("../frontend/telegram/callbacks/model/backend.js", () => ({
  handleBackendSelect: handlers.backendSelect,
  handleBackendDefault: handlers.backendDefault,
}));
const renderModelView = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../frontend/telegram/callbacks/model/views.js", () => ({
  renderModelView,
}));
const parseModelCallback = vi.hoisted(() => vi.fn());
vi.mock("../frontend/telegram/model-callbacks.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../frontend/telegram/model-callbacks.js")
    >();
  parseModelCallback.mockImplementation(actual.parseModelCallback);
  return { ...actual, parseModelCallback };
});

import {
  MODEL_CALLBACK_HANDLERS,
  handleModelCallback,
} from "../frontend/telegram/callbacks/model.js";
import type { CallbackDeps } from "../frontend/telegram/callbacks/query.js";
import type { Context } from "grammy";

const deps = { config: {}, gateway: undefined } as unknown as CallbackDeps;
const cid = "123";

type Fake = Context & { answerCallbackQuery: ReturnType<typeof vi.fn> };

function fakeCtx(): Fake {
  return {
    answerCallbackQuery: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  } as unknown as Fake;
}

const allHandlers = Object.values(handlers);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MODEL_CALLBACK_HANDLERS", () => {
  it("has a null prototype and exactly the parser's kinds", () => {
    expect(Object.getPrototypeOf(MODEL_CALLBACK_HANDLERS)).toBeNull();
    expect(Object.keys(MODEL_CALLBACK_HANDLERS).sort()).toEqual([
      "backend-default",
      "backend-select",
      "backends",
      "browse",
      "done",
      "menu",
      "nav-back-to-providers",
      "nav-filter",
      "nav-page",
      "nav-provider",
      "noop",
      "reset",
      "select",
      "toggle-free",
      "unknown",
    ]);
  });
});

describe("handleModelCallback", () => {
  it.each([
    ["model:done", "done", handlers.done],
    ["model:noop", "noop", handlers.noop],
    ["model:some/model-id", "select", handlers.select],
    ["model:reset", "reset", handlers.reset],
    ["model:toggle-free", "toggle-free", handlers.toggleFree],
    ["model:menu", "menu", handlers.menu],
    ["model:browse", "browse", handlers.browse],
    [
      "model:nav:providers",
      "nav-back-to-providers",
      handlers.navBackToProviders,
    ],
    ["model:nav:provider:openai", "nav-provider", handlers.navProvider],
    ["model:nav:page:2:all", "nav-page", handlers.navPage],
    ["model:nav:filter:free", "nav-filter", handlers.navFilter],
    ["model:backends", "backends", handlers.backends],
    ["model:backend:codex", "backend-select", handlers.backendSelect],
    ["model:backend-default", "backend-default", handlers.backendDefault],
  ])("routes %s to the %s handler", async (data, kind, handler) => {
    const ctx = fakeCtx();
    await handleModelCallback(ctx, data, cid, deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ kind }),
      cid,
      deps,
    );
    for (const other of allHandlers) {
      if (other !== handler) expect(other).not.toHaveBeenCalled();
    }
  });

  it("answers with the handler's toast and redraws its view", async () => {
    const ctx = fakeCtx();
    await handleModelCallback(ctx, "model:reset", cid, deps);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "reset" });
    expect(renderModelView).toHaveBeenCalledWith(
      ctx,
      { kind: "menu" },
      cid,
      deps,
    );
  });

  it("acks plainly when the handler has no toast", async () => {
    const ctx = fakeCtx();
    await handleModelCallback(ctx, "model:nav:page:2:all", cid, deps);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
    expect(renderModelView).toHaveBeenCalledWith(
      ctx,
      { kind: "browse", page: 2 },
      cid,
      deps,
    );
  });

  it("does nothing more when the handler already answered", async () => {
    const ctx = fakeCtx();
    await handleModelCallback(ctx, "model:done", cid, deps);
    expect(handlers.done).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    expect(renderModelView).not.toHaveBeenCalled();
  });

  it("routes unparseable data to the noop ack", async () => {
    const ctx = fakeCtx();
    await handleModelCallback(ctx, "model:", cid, deps);
    expect(handlers.noop).toHaveBeenCalledWith(
      ctx,
      { kind: "unknown" },
      cid,
      deps,
    );
    expect(renderModelView).not.toHaveBeenCalled();
  });

  it("acks a kind with no handler the same way, without touching Object.prototype", async () => {
    for (const kind of ["constructor", "toString", "__proto__"]) {
      parseModelCallback.mockReturnValueOnce({ kind });
      const ctx = fakeCtx();
      await handleModelCallback(ctx, "model:whatever", cid, deps);
      for (const h of allHandlers) expect(h).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
      expect(renderModelView).not.toHaveBeenCalled();
    }
  });
});
