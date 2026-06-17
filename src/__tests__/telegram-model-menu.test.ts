/**
 * Tests for the `/model` UX layer (Telegram frontend):
 *
 *   - `parseModelCallback` — pure parser over the inline-button
 *     callback-data grammar. Pinned because Telegram's 64-byte
 *     callback_data limit + frontend dispatch correctness depend on
 *     it staying in lockstep with the renderers.
 *   - `buildModelMenuState` — pure async assembler that turns the
 *     backend's `getSettingsPresentation` snapshot + chat-settings
 *     into a `ModelMenuState` ready for rendering.
 *   - `renderModelMenuKeyboard` / `renderModelMenuText` — the main
 *     menu surface.
 *   - `renderModelBrowseKeyboard` — the browse view (groups or
 *     paginated models, with `← Back to menu` always present).
 */
import { describe, it, expect } from "vitest";
import { parseModelCallback } from "../frontend/telegram/model-callbacks.js";
import {
  buildModelMenuState,
  renderModelMenuKeyboard,
  renderModelMenuText,
  renderModelBrowseKeyboard,
  type ModelMenuState,
} from "../frontend/telegram/helpers/index.js";

// ── parseModelCallback ─────────────────────────────────────────────────────

describe("telegram /model — parseModelCallback", () => {
  it("rejects non-model: callbacks as unknown", () => {
    expect(parseModelCallback("settings:done").kind).toBe("unknown");
    expect(parseModelCallback("pulse:on").kind).toBe("unknown");
    expect(parseModelCallback("").kind).toBe("unknown");
  });

  it("parses one-word actions", () => {
    expect(parseModelCallback("model:done").kind).toBe("done");
    expect(parseModelCallback("model:noop").kind).toBe("noop");
    expect(parseModelCallback("model:menu").kind).toBe("menu");
    expect(parseModelCallback("model:browse").kind).toBe("browse");
    expect(parseModelCallback("model:toggle-free").kind).toBe("toggle-free");
    expect(parseModelCallback("model:reset").kind).toBe("reset");
  });

  it("parses provider drill with multi-segment provider ids", () => {
    const out = parseModelCallback("model:nav:provider:aion-labs");
    expect(out).toEqual({ kind: "nav-provider", provider: "aion-labs" });
  });

  it("parses back-to-providers", () => {
    expect(parseModelCallback("model:nav:providers").kind).toBe(
      "nav-back-to-providers",
    );
  });

  it("parses nav:page with required filter and optional provider", () => {
    expect(parseModelCallback("model:nav:page:3:all")).toEqual({
      kind: "nav-page",
      page: 3,
      filter: "all",
    });
    expect(parseModelCallback("model:nav:page:2:free:openai")).toEqual({
      kind: "nav-page",
      page: 2,
      filter: "free",
      provider: "openai",
    });
  });

  it("treats malformed nav payloads as unknown", () => {
    expect(parseModelCallback("model:nav:page:NaN:all").kind).toBe("unknown");
    expect(parseModelCallback("model:nav:page:1:bogus").kind).toBe("unknown");
    expect(parseModelCallback("model:nav:page:0:all").kind).toBe("unknown");
    expect(parseModelCallback("model:nav:provider:").kind).toBe("unknown");
    expect(parseModelCallback("model:nav:filter:bogus").kind).toBe("unknown");
    expect(parseModelCallback("model:nav:unknown-sub").kind).toBe("unknown");
  });

  it("parses a plain model id as a selection", () => {
    expect(parseModelCallback("model:openrouter/owl-alpha")).toEqual({
      kind: "select",
      modelId: "openrouter/owl-alpha",
    });
  });

  it("refuses to interpret stale picker-control payloads as model ids", () => {
    // Earlier bot versions emitted ambiguous control payloads. The
    // parser must never let `nav:...` end up as a selectable model id
    // because that would persist into chat-settings on click.
    expect(parseModelCallback("model:nav:filter:free").kind).not.toBe("select");
    expect(parseModelCallback("model:nav:filter:free").kind).toBe("nav-filter");
  });
});

// ── buildModelMenuState ────────────────────────────────────────────────────

describe("telegram /model — buildModelMenuState", () => {
  function stubBackend(
    opts: {
      freeCount?: number;
      totalCount?: number;
      statusLines?: string[];
      display?: string;
    } = {},
  ) {
    return {
      fetchSnapshot: async () => ({
        freeCount: opts.freeCount ?? 0,
        totalCount: opts.totalCount ?? 0,
        modelDetails: opts.statusLines ?? [],
      }),
      fetchActiveDisplay: async () => opts.display,
      activeBackend: { id: "claude", label: "Claude SDK" },
      hasBackendOverride: false,
      showBackendButton: false,
    };
  }

  it("falls back to the raw model id when no display name is available", async () => {
    const state = await buildModelMenuState({
      chatId: "c1",
      activeModel: "openrouter/owl-alpha",
      defaultModel: "openrouter/owl-alpha",
      freeOnly: false,
      ...stubBackend(),
    });
    expect(state.activeDisplay).toBe("openrouter/owl-alpha");
  });

  it("marks hasOverride when the active model differs from the default", async () => {
    const same = await buildModelMenuState({
      chatId: "c",
      activeModel: "m",
      defaultModel: "m",
      freeOnly: false,
      ...stubBackend(),
    });
    expect(same.hasOverride).toBe(false);

    const diff = await buildModelMenuState({
      chatId: "c",
      activeModel: "m",
      defaultModel: "other",
      freeOnly: false,
      ...stubBackend(),
    });
    expect(diff.hasOverride).toBe(true);
  });

  it("shows the free toggle only when the backend reports free models", async () => {
    const without = await buildModelMenuState({
      chatId: "c",
      activeModel: "m",
      defaultModel: "m",
      freeOnly: false,
      ...stubBackend({ freeCount: 0, totalCount: 50 }),
    });
    expect(without.showFreeToggle).toBe(false);

    const withFree = await buildModelMenuState({
      chatId: "c",
      activeModel: "m",
      defaultModel: "m",
      freeOnly: false,
      ...stubBackend({ freeCount: 4, totalCount: 50 }),
    });
    expect(withFree.showFreeToggle).toBe(true);
  });

  it("recovers from snapshot-fetch failures with a safe empty state", async () => {
    const state = await buildModelMenuState({
      chatId: "c",
      activeModel: "m",
      defaultModel: "m",
      freeOnly: false,
      fetchSnapshot: async () => {
        throw new Error("backend offline");
      },
      fetchActiveDisplay: async () => "Active",
      activeBackend: { id: "claude", label: "Claude SDK" },
      hasBackendOverride: false,
      showBackendButton: false,
    });
    expect(state.statusLines).toEqual([]);
    expect(state.showFreeToggle).toBe(false);
    expect(state.activeDisplay).toBe("Active");
  });
});

// ── renderModelMenuKeyboard ────────────────────────────────────────────────

function baseState(overrides: Partial<ModelMenuState> = {}): ModelMenuState {
  return {
    activeModel: "openrouter/owl-alpha",
    activeDisplay: "Owl Alpha",
    noModelSelected: false,
    statusLines: ["356 models discovered via OpenAI Agents endpoint"],
    hasOverride: false,
    showFreeToggle: true,
    freeOnly: false,
    activeBackend: { id: "openai-agents", label: "OpenAI Agents" },
    hasBackendOverride: false,
    showBackendButton: false,
    ...overrides,
  };
}

function callbacks(
  rows: ReadonlyArray<ReadonlyArray<{ callback_data: string }>>,
): string[] {
  return rows.flat().map((b) => b.callback_data);
}

describe("telegram /model — renderModelMenuKeyboard", () => {
  it("always includes Browse", () => {
    const rows = renderModelMenuKeyboard(baseState());
    expect(callbacks(rows)).toContain("model:browse");
  });

  it("does NOT include a Done button — closing the picker requires deleting the message externally", () => {
    const rows = renderModelMenuKeyboard(baseState({ hasOverride: true }));
    expect(callbacks(rows)).not.toContain("model:done");
  });

  it("includes the free toggle when showFreeToggle is true", () => {
    const off = renderModelMenuKeyboard(baseState({ freeOnly: false }));
    const on = renderModelMenuKeyboard(baseState({ freeOnly: true }));
    expect(callbacks(off)).toContain("model:toggle-free");
    expect(callbacks(on)).toContain("model:toggle-free");
    expect(
      off.flat().find((b) => b.callback_data === "model:toggle-free")!.text,
    ).toMatch(/OFF/i);
    expect(
      on.flat().find((b) => b.callback_data === "model:toggle-free")!.text,
    ).toMatch(/ON/i);
  });

  it("omits the free toggle when the backend has no free models", () => {
    const rows = renderModelMenuKeyboard(baseState({ showFreeToggle: false }));
    expect(callbacks(rows)).not.toContain("model:toggle-free");
  });

  it("includes Reset only when there's a per-chat override", () => {
    const without = renderModelMenuKeyboard(baseState({ hasOverride: false }));
    const withOverride = renderModelMenuKeyboard(
      baseState({ hasOverride: true }),
    );
    expect(callbacks(without)).not.toContain("model:reset");
    expect(callbacks(withOverride)).toContain("model:reset");
  });
});

describe("telegram /model — renderModelMenuText", () => {
  it("contains the active display name and renders status lines plainly", () => {
    const text = renderModelMenuText(
      baseState({
        activeDisplay: "Owl Alpha",
        statusLines: ["356 models discovered"],
      }),
    );
    expect(text).toContain("Owl Alpha");
    expect(text).toContain("356 models discovered");
  });

  it("adds a filter hint when freeOnly is on", () => {
    const off = renderModelMenuText(baseState({ freeOnly: false }));
    const on = renderModelMenuText(baseState({ freeOnly: true }));
    expect(off.toLowerCase()).not.toContain("filtering to free");
    expect(on.toLowerCase()).toContain("free-tier");
  });

  it("does not advertise free filtering when the backend lacks free models", () => {
    const text = renderModelMenuText(
      baseState({ freeOnly: true, showFreeToggle: false }),
    );
    expect(text.toLowerCase()).not.toContain("free-tier");
  });
});

// ── renderModelBrowseKeyboard ──────────────────────────────────────────────

describe("telegram /model — renderModelBrowseKeyboard", () => {
  it("always ends with a Back-to-menu row", () => {
    const rows = renderModelBrowseKeyboard(
      [{ text: "a", callback_data: "model:a" }],
      {
        page: 1,
        totalPages: 1,
        filter: "all",
        freeCount: 0,
        totalCount: 1,
      },
      "models",
      undefined,
      "model:menu",
    );
    const last = rows[rows.length - 1];
    expect(last).toEqual([
      { text: "← Back to menu", callback_data: "model:menu" },
    ]);
  });

  it("renders no Prev/Next row when there's a single page", () => {
    const rows = renderModelBrowseKeyboard(
      [{ text: "a", callback_data: "model:a" }],
      {
        page: 1,
        totalPages: 1,
        filter: "all",
        freeCount: 0,
        totalCount: 1,
      },
      "models",
      undefined,
      "model:menu",
    );
    expect(callbacks(rows).some((cb) => cb.startsWith("model:nav:page:"))).toBe(
      false,
    );
  });

  it("renders Prev/Next page buttons when totalPages > 1", () => {
    const rows = renderModelBrowseKeyboard(
      [{ text: "a", callback_data: "model:a" }],
      {
        page: 2,
        totalPages: 5,
        filter: "all",
        freeCount: 0,
        totalCount: 40,
      },
      "models",
      undefined,
      "model:menu",
    );
    const cbs = callbacks(rows);
    // Prev → page 1, Next → page 3
    expect(cbs).toContain("model:nav:page:1:all");
    expect(cbs).toContain("model:nav:page:3:all");
  });

  it("encodes the active provider into pagination data when drilled in", () => {
    const rows = renderModelBrowseKeyboard(
      [{ text: "a", callback_data: "model:a" }],
      {
        page: 1,
        totalPages: 3,
        filter: "all",
        freeCount: 0,
        totalCount: 24,
      },
      "models",
      "anthropic",
      "model:menu",
    );
    const cbs = callbacks(rows);
    expect(cbs).toContain("model:nav:providers"); // back-to-groups button
    expect(cbs).toContain("model:nav:page:2:all:anthropic");
  });

  it("does NOT render an inline filter chip row — the toggle lives on the main menu", () => {
    const rows = renderModelBrowseKeyboard(
      [{ text: "a", callback_data: "model:a" }],
      {
        page: 1,
        totalPages: 1,
        filter: "all",
        freeCount: 8,
        totalCount: 40,
      },
      "models",
      undefined,
      "model:menu",
    );
    expect(
      callbacks(rows).some((cb) => cb.startsWith("model:nav:filter:")),
    ).toBe(false);
  });

  it("respects Telegram's 64-byte callback_data limit on every button", () => {
    const rows = renderModelBrowseKeyboard(
      [
        {
          text: "x",
          // Worst-case selection id we'd see from OpenRouter (≈48 chars
          // including the `model:` prefix); still under 64 bytes.
          callback_data: "model:openrouter/nousresearch/hermes-3-llama-3.1-405",
        },
      ],
      {
        page: 3,
        totalPages: 99,
        filter: "free",
        freeCount: 100,
        totalCount: 400,
      },
      "models",
      "nousresearch",
      "model:menu",
    );
    for (const b of rows.flat()) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(
        64,
      );
    }
  });
});
