import { describe, it, expect } from "vitest";
import {
  buildModelPickerView,
  buildBackendPickerView,
  decodeModelNav,
  MODEL_NAV_PREFIX,
  MODEL_PAGE_SIZE,
} from "../frontend/discord/model-picker.js";
import type { ModelPickerResult } from "../core/types.js";

function pres(over: Partial<ModelPickerResult> = {}): ModelPickerResult {
  return {
    modelButtons: [
      { text: "✓ Opus 5", callback_data: "model:opus" },
      { text: "Sonnet 5", callback_data: "model:sonnet" },
    ],
    modelDetails: [],
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: 2,
    ...over,
  };
}

/** Buttons of the first row that carries any, flattened to label + state. */
function buttons(
  components: ReturnType<typeof buildModelPickerView>["components"],
): { label: string; id: string; disabled: boolean }[] {
  const out: { label: string; id: string; disabled: boolean }[] = [];
  for (const row of components) {
    for (const c of row.components as unknown as Record<string, unknown>[]) {
      if (c.type === 2) {
        out.push({
          label: String(c.label ?? ""),
          id: String(c.custom_id ?? ""),
          disabled: Boolean(c.disabled),
        });
      }
    }
  }
  return out;
}

function selectOptions(
  components: ReturnType<typeof buildModelPickerView>["components"],
): { label: string; value: string }[] {
  for (const row of components) {
    for (const c of row.components as unknown as Record<string, unknown>[]) {
      if (c.type === 3) {
        return (c.options as { label: string; value: string }[]) ?? [];
      }
    }
  }
  return [];
}

describe("decodeModelNav", () => {
  it("ignores custom_ids from other namespaces", () => {
    expect(decodeModelNav("settings:model")).toBeNull();
    expect(decodeModelNav("model:select")).toBeNull();
  });

  it("decodes a page target with its filter", () => {
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:page:3:free`)).toEqual({
      page: 3,
      filter: "free",
    });
  });

  it("carries the provider through paging", () => {
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:page:2:all:openai`)).toEqual({
      page: 2,
      filter: "all",
      provider: "openai",
    });
  });

  it("resets to page 1 when the filter flips", () => {
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:filter:free`)).toEqual({
      page: 1,
      filter: "free",
    });
  });

  it("falls back to page 1 on a malformed page number", () => {
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:page:zero:all`)?.page).toBe(1);
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:page:-4:all`)?.page).toBe(1);
  });

  it("decodes the provider list and a provider drill", () => {
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:providers`)).toEqual({
      page: 1,
      filter: "all",
    });
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:provider:anthropic`)).toEqual({
      page: 1,
      filter: "all",
      provider: "anthropic",
    });
  });

  it("rejects an unknown action", () => {
    expect(decodeModelNav(`${MODEL_NAV_PREFIX}:teleport`)).toBeNull();
  });
});

describe("buildModelPickerView", () => {
  it("omits the arrows on a single-page catalog", () => {
    const view = buildModelPickerView(pres(), "Opus 5", "claude");
    const labels = buttons(view.components).map((b) => b.label);
    expect(labels).not.toContain("◀");
    expect(labels).not.toContain("▶");
    // The backend button is always offered.
    expect(labels.some((l) => l.includes("Backend"))).toBe(true);
  });

  it("disables the arrow at each edge", () => {
    const first = buttons(
      buildModelPickerView(pres({ page: 1, totalPages: 7 }), "Opus 5", "claude")
        .components,
    );
    expect(first.find((b) => b.label === "◀")?.disabled).toBe(true);
    expect(first.find((b) => b.label === "▶")?.disabled).toBe(false);

    const last = buttons(
      buildModelPickerView(pres({ page: 7, totalPages: 7 }), "Opus 5", "claude")
        .components,
    );
    expect(last.find((b) => b.label === "◀")?.disabled).toBe(false);
    expect(last.find((b) => b.label === "▶")?.disabled).toBe(true);
  });

  it("shows the page counter as an inert button", () => {
    const b = buttons(
      buildModelPickerView(pres({ page: 3, totalPages: 7 }), "Opus 5", "claude")
        .components,
    );
    const counter = b.find((x) => x.label === "3/7");
    expect(counter?.disabled).toBe(true);
  });

  it("points each arrow at the neighbouring page, keeping the filter", () => {
    const b = buttons(
      buildModelPickerView(
        pres({ page: 4, totalPages: 9, filter: "free" }),
        "Opus 5",
        "claude",
      ).components,
    );
    expect(b.find((x) => x.label === "◀")?.id).toBe(
      `${MODEL_NAV_PREFIX}:page:3:free`,
    );
    expect(b.find((x) => x.label === "▶")?.id).toBe(
      `${MODEL_NAV_PREFIX}:page:5:free`,
    );
  });

  it("offers the free filter only when free models exist, and toggles back", () => {
    const none = buttons(
      buildModelPickerView(pres({ freeCount: 0 }), "Opus 5", "claude")
        .components,
    );
    expect(none.some((b) => b.label.includes("Free"))).toBe(false);

    // Everything free means the filter would keep everything — no button.
    const allFree = buttons(
      buildModelPickerView(
        pres({ freeCount: 7, totalCount: 7 }),
        "Opus 5",
        "claude",
      ).components,
    );
    expect(allFree.some((b) => b.label.includes("Free"))).toBe(false);

    const some = buttons(
      buildModelPickerView(
        pres({ freeCount: 12, totalCount: 300 }),
        "Opus 5",
        "claude",
      ).components,
    );
    expect(some.find((b) => b.label.startsWith("Free only"))?.id).toBe(
      `${MODEL_NAV_PREFIX}:filter:free`,
    );

    const on = buttons(
      buildModelPickerView(
        pres({ freeCount: 12, totalCount: 300, filter: "free" }),
        "Opus 5",
        "claude",
      ).components,
    );
    expect(on.find((b) => b.label === "All models")?.id).toBe(
      `${MODEL_NAV_PREFIX}:filter:all`,
    );
  });

  it("offers a way back only while drilled into a provider", () => {
    const flat = buttons(
      buildModelPickerView(pres(), "Opus 5", "claude").components,
    );
    expect(flat.some((b) => b.label === "← Providers")).toBe(false);

    const drilled = buttons(
      buildModelPickerView(pres({ provider: "openai" }), "Opus 5", "claude")
        .components,
    );
    expect(drilled.find((b) => b.label === "← Providers")?.id).toBe(
      `${MODEL_NAV_PREFIX}:providers`,
    );
  });

  it("never exceeds Discord's option cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      text: `Model ${i}`,
      callback_data: `model:m${i}`,
    }));
    const view = buildModelPickerView(
      pres({ modelButtons: many, totalPages: 2 }),
      "Opus 5",
      "claude",
    );
    expect(selectOptions(view.components)).toHaveLength(MODEL_PAGE_SIZE);
  });

  it("strips the selected-marker from labels and keeps the raw value", () => {
    const opts = selectOptions(
      buildModelPickerView(pres(), "Opus 5", "claude").components,
    );
    expect(opts[0]).toMatchObject({ label: "Opus 5", value: "opus" });
  });

  it("marks provider chips so the handler can tell them from models", () => {
    const view = buildModelPickerView(
      pres({
        view: "groups",
        modelButtons: [
          { text: "OpenRouter (278)", callback_data: "model:nav:provider:or" },
          { text: "Zen (7)", callback_data: "model:nav:provider:zen" },
        ],
      }),
      "Opus 5",
      "kilo",
    );
    // Both views share one select; without the prefix the handler would try
    // to resolve a provider id as a model and report it unavailable.
    expect(selectOptions(view.components).map((o) => o.value)).toEqual([
      "provider:or",
      "provider:zen",
    ]);
  });

  it("names the current backend on its button", () => {
    const b = buttons(
      buildModelPickerView(pres(), "Opus 5", "opencode").components,
    );
    expect(b.some((x) => x.label === "⚙ Backend: opencode")).toBe(true);
  });
});

describe("buildBackendPickerView", () => {
  it("marks the current backend and offers a way back", () => {
    const view = buildBackendPickerView(
      [
        { id: "claude", label: "Anthropic" },
        { id: "opencode", label: "OpenCode" },
      ],
      "claude",
    );
    const opts = selectOptions(view.components);
    expect(opts.map((o) => o.value)).toEqual(["claude", "opencode"]);
    expect(opts[0]).toMatchObject({ label: "Anthropic" });
    expect(buttons(view.components).some((b) => b.label === "← Models")).toBe(
      true,
    );
    expect(view.content).toContain("claude");
  });
});
