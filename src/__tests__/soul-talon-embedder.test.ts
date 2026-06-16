/**
 * Tests for Talon's own embedder and the runtime gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { TalonEmbedder } from "../core/soul/talon-embedder.js";
import { cosineDistance } from "../core/soul/embedder.js";
import {
  resolveSoulSettings,
  soulEnabled,
  DEFAULT_SOUL_SETTINGS,
} from "../core/soul/settings.js";

describe("TalonEmbedder", () => {
  it("is deterministic and unit-normalized", async () => {
    const e = new TalonEmbedder();
    const [a] = await e.embed(["push back on bad ideas"]);
    const [b] = await e.embed(["push back on bad ideas"]);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
  });

  it("separates paraphrase from unrelated better than chance", async () => {
    const e = new TalonEmbedder();
    const [base, near, far] = await e.embed([
      "keep replies concise and avoid walls of text",
      "stay concise, no walls of text in replies",
      "book a flight from dublin to nice next june",
    ]);
    expect(cosineDistance(base!, near!)).toBeLessThan(
      cosineDistance(base!, far!),
    );
  });

  it("is robust to a typo (shared character n-grams)", async () => {
    const e = new TalonEmbedder();
    const [a, b] = await e.embed([
      "verify before stating",
      "verfiy before stating",
    ]);
    expect(cosineDistance(a!, b!)).toBeLessThan(0.4);
  });
});

describe("soul gate", () => {
  const saved = process.env.TALON_SOUL_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.TALON_SOUL_ENABLED;
    else process.env.TALON_SOUL_ENABLED = saved;
  });

  it("is disabled by default", () => {
    delete process.env.TALON_SOUL_ENABLED;
    expect(DEFAULT_SOUL_SETTINGS.enabled).toBe(false);
    expect(soulEnabled()).toBe(false);
  });

  it("an explicit override wins over the env", () => {
    process.env.TALON_SOUL_ENABLED = "false";
    expect(soulEnabled({ enabled: true })).toBe(true);
  });

  it("reads the env flag when no override is given", () => {
    process.env.TALON_SOUL_ENABLED = "on";
    expect(resolveSoulSettings().enabled).toBe(true);
  });
});
