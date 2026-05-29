/**
 * Phase 6 prep tests — `JsonStore<T>` abstraction.
 *
 * Pins the invariants Phase 6.x storage migrations will depend on:
 *
 *   - load → defaultValue when file is absent
 *   - load promotes `.bak` to primary on corrupt primary
 *   - save backs up the existing primary to `.bak` before overwriting
 *   - save writes the envelope shape `{ schemaVersion, savedAt, data }`
 *   - save is idempotent when not dirty
 *   - migrate hook runs on version mismatch
 *   - validate hook rejects malformed data → falls back to default
 *
 * The test uses an in-memory `JsonStoreFs` so no real filesystem
 * I/O happens — every behaviour is exercised by inspecting the
 * fake's `files` map.
 */

import { describe, it, expect } from "vitest";
import {
  JsonStore,
  type JsonStoreFs,
  type JsonStoreOptions,
} from "../core/agent-runtime/store.js";

interface Settings {
  enabled: boolean;
  rate: number;
}

const defaults: Settings = { enabled: false, rate: 0 };

function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  let now = 1_000;
  const fs: JsonStoreFs = {
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    writeFileAtomic: async (path, data) => {
      files.set(path, data);
    },
    renameSync: (from, to) => {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, v);
      files.delete(from);
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
  };
  const advanceTime = (ms: number) => {
    now += ms;
  };
  const getNow = () => now;
  return { files, fs, advanceTime, getNow };
}

function makeStore<T = Settings>(
  fakeFs: ReturnType<typeof makeFakeFs>,
  overrides: Partial<JsonStoreOptions<T>> = {},
): JsonStore<T> {
  return new JsonStore<T>({
    path: "/fake/settings.json",
    defaultValue: defaults as unknown as T,
    fs: fakeFs.fs,
    now: fakeFs.getNow,
    schemaVersion: 1,
    ...overrides,
  });
}

// ── load ────────────────────────────────────────────────────────────────────

describe("JsonStore / load", () => {
  it("returns defaultValue when no file exists", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    const value = await store.load();
    expect(value).toEqual(defaults);
    expect(fakeFs.files.size).toBe(0);
  });

  it("reads the envelope shape from primary", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 1,
        savedAt: 999,
        data: { enabled: true, rate: 42 },
      }),
    });
    const store = makeStore(fakeFs);
    const value = await store.load();
    expect(value).toEqual({ enabled: true, rate: 42 });
  });

  it("accepts a bare data document for back-compat with envelope-less stores", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({ enabled: true, rate: 7 }),
    });
    const store = makeStore(fakeFs);
    expect(await store.load()).toEqual({ enabled: true, rate: 7 });
  });

  it("falls back to .bak when primary is corrupt JSON", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": "not-valid-json{",
      "/fake/settings.json.bak": JSON.stringify({
        schemaVersion: 1,
        savedAt: 1,
        data: { enabled: true, rate: 1 },
      }),
    });
    const store = makeStore(fakeFs);
    const value = await store.load();
    expect(value).toEqual({ enabled: true, rate: 1 });
    // .bak promoted back to primary
    expect(fakeFs.files.has("/fake/settings.json")).toBe(true);
    expect(fakeFs.files.has("/fake/settings.json.bak")).toBe(false);
  });

  it("falls back to defaultValue when both primary and .bak are corrupt", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": "garbage",
      "/fake/settings.json.bak": "more garbage",
    });
    const store = makeStore(fakeFs);
    expect(await store.load()).toEqual(defaults);
  });

  it("is idempotent — second load returns cached value without re-reading", async () => {
    let reads = 0;
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 1,
        savedAt: 1,
        data: { enabled: true, rate: 5 },
      }),
    });
    const wrappedFs: JsonStoreFs = {
      ...fakeFs.fs,
      readFileSync: (path) => {
        reads++;
        return fakeFs.fs.readFileSync(path, "utf8");
      },
    };
    const store = makeStore({ ...fakeFs, fs: wrappedFs } as ReturnType<
      typeof makeFakeFs
    >);
    await store.load();
    await store.load();
    expect(reads).toBe(1);
  });
});

// ── update / save ───────────────────────────────────────────────────────────

describe("JsonStore / update + save", () => {
  it("update marks dirty; get returns the new value", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    await store.load();
    expect(store.isDirty()).toBe(false);
    store.update((s) => {
      s.enabled = true;
      s.rate = 99;
    });
    expect(store.isDirty()).toBe(true);
    expect(store.get()).toEqual({ enabled: true, rate: 99 });
  });

  it("save writes the envelope and clears dirty", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    await store.load();
    store.update((s) => {
      s.enabled = true;
    });
    fakeFs.advanceTime(1234);
    await store.save();
    expect(store.isDirty()).toBe(false);
    const written = fakeFs.files.get("/fake/settings.json")!;
    const parsed = JSON.parse(written);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      data: { enabled: true, rate: 0 },
    });
    expect(parsed.savedAt).toBeGreaterThan(1_000);
  });

  it("save is a no-op when not dirty", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    await store.load();
    await store.save();
    expect(fakeFs.files.size).toBe(0);
  });

  it("set replaces the whole value and marks dirty", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    await store.load();
    store.set({ enabled: true, rate: 50 });
    expect(store.isDirty()).toBe(true);
    expect(store.get()).toEqual({ enabled: true, rate: 50 });
  });

  it("forceSave writes even when not dirty", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    await store.load();
    await store.forceSave();
    expect(fakeFs.files.size).toBe(1);
  });

  it("backs up the existing primary to .bak before overwriting", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 1,
        savedAt: 1,
        data: { enabled: false, rate: 1 },
      }),
    });
    const store = makeStore(fakeFs);
    await store.load();
    store.update((s) => {
      s.rate = 2;
    });
    await store.save();
    // Primary holds the new value …
    expect(JSON.parse(fakeFs.files.get("/fake/settings.json")!).data).toEqual({
      enabled: false,
      rate: 2,
    });
    // … and .bak holds the prior good copy, so a later corrupt primary
    // recovers via the load fallback ladder.
    expect(
      JSON.parse(fakeFs.files.get("/fake/settings.json.bak")!).data,
    ).toEqual({ enabled: false, rate: 1 });
  });

  it("writes no .bak on the first save (no primary to back up yet)", async () => {
    const fakeFs = makeFakeFs();
    const store = makeStore(fakeFs);
    await store.load();
    store.update((s) => {
      s.enabled = true;
    });
    await store.save();
    expect(fakeFs.files.has("/fake/settings.json")).toBe(true);
    expect(fakeFs.files.has("/fake/settings.json.bak")).toBe(false);
  });
});

// ── migrate / validate ─────────────────────────────────────────────────────

describe("JsonStore / migrate", () => {
  it("calls migrate when on-disk schemaVersion is older", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 0,
        savedAt: 0,
        data: { enable: true, ratePct: 50 }, // legacy field names
      }),
    });
    const store = makeStore<Settings>(fakeFs, {
      schemaVersion: 1,
      migrate: (raw, fromVersion) => {
        expect(fromVersion).toBe(0);
        const legacy = raw as { enable?: boolean; ratePct?: number };
        return {
          schemaVersion: 1,
          value: {
            enabled: legacy.enable === true,
            rate: (legacy.ratePct ?? 0) / 100,
          },
        };
      },
    });
    expect(await store.load()).toEqual({ enabled: true, rate: 0.5 });
  });

  it("does not call migrate when on-disk version matches current", async () => {
    let calls = 0;
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 2,
        savedAt: 0,
        data: { enabled: true, rate: 9 },
      }),
    });
    const store = makeStore<Settings>(fakeFs, {
      schemaVersion: 2,
      migrate: () => {
        calls++;
        return null;
      },
    });
    expect(await store.load()).toEqual({ enabled: true, rate: 9 });
    expect(calls).toBe(0);
  });

  it("falls back to defaultValue when migrate returns null", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 0,
        savedAt: 0,
        data: "anything",
      }),
    });
    const store = makeStore<Settings>(fakeFs, {
      schemaVersion: 1,
      migrate: () => null,
    });
    expect(await store.load()).toEqual(defaults);
  });
});

describe("JsonStore / validate", () => {
  it("falls back to defaultValue when validate throws", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 1,
        savedAt: 0,
        data: { enabled: "not-a-bool", rate: "not-a-number" },
      }),
    });
    const store = makeStore<Settings>(fakeFs, {
      validate: (raw) => {
        const r = raw as Partial<Settings>;
        if (typeof r.enabled !== "boolean" || typeof r.rate !== "number") {
          throw new Error("malformed");
        }
        return r as Settings;
      },
    });
    expect(await store.load()).toEqual(defaults);
  });

  it("accepts validated data through unchanged", async () => {
    const fakeFs = makeFakeFs({
      "/fake/settings.json": JSON.stringify({
        schemaVersion: 1,
        savedAt: 0,
        data: { enabled: true, rate: 0.25 },
      }),
    });
    const store = makeStore<Settings>(fakeFs, {
      validate: (raw) => raw as Settings,
    });
    expect(await store.load()).toEqual({ enabled: true, rate: 0.25 });
  });
});
