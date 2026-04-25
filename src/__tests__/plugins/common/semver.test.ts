import { describe, it, expect } from "vitest";
import {
  compareSemVer,
  isAtLeast,
  isExactMatch,
  parseSemVer,
} from "../../../plugins/common/semver.js";

describe("parseSemVer", () => {
  it("parses basic X.Y.Z", () => {
    expect(parseSemVer("3.3.2")).toEqual({ major: 3, minor: 3, patch: 2 });
  });

  it("ignores pre-release suffix after the triplet", () => {
    expect(parseSemVer("3.3.2-rc.1")).toEqual({ major: 3, minor: 3, patch: 2 });
    expect(parseSemVer("1.0.0-alpha")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSemVer("  3.3.2\n")).toEqual({ major: 3, minor: 3, patch: 2 });
  });

  it("returns null for malformed inputs that the plugin lifecycle must reject", () => {
    // These are the real shapes we'd encounter if upstream broke their
    // version convention — empty strings, two-component versions, non-semver
    // date stamps, etc.
    expect(parseSemVer("")).toBeNull();
    expect(parseSemVer("3.3")).toBeNull();
    expect(parseSemVer("v3.3.2")).toBeNull(); // no 'v' prefix
    expect(parseSemVer("latest")).toBeNull();
    expect(parseSemVer("not a version")).toBeNull();
  });
});

describe("compareSemVer", () => {
  it("orders by major/minor/patch in that priority", () => {
    const base = { major: 3, minor: 3, patch: 2 } as const;
    expect(compareSemVer(base, { major: 3, minor: 3, patch: 2 })).toBe(0);
    expect(compareSemVer(base, { major: 3, minor: 3, patch: 1 })).toBe(1);
    expect(compareSemVer(base, { major: 3, minor: 4, patch: 0 })).toBe(-1);
    expect(compareSemVer(base, { major: 4, minor: 0, patch: 0 })).toBe(-1);
    // patch diff loses to minor diff
    expect(
      compareSemVer(
        { major: 3, minor: 3, patch: 99 },
        { major: 3, minor: 4, patch: 0 },
      ),
    ).toBe(-1);
  });
});

describe("isAtLeast — the floor check used at startup", () => {
  it("accepts versions at or above the floor", () => {
    expect(isAtLeast("3.3.2", "3.3.2")).toBe(true);
    expect(isAtLeast("3.3.3", "3.3.2")).toBe(true);
    expect(isAtLeast("3.4.0", "3.3.2")).toBe(true);
    expect(isAtLeast("4.0.0", "3.3.2")).toBe(true);
  });

  it("rejects versions below the floor", () => {
    expect(isAtLeast("3.3.1", "3.3.2")).toBe(false);
    expect(isAtLeast("3.2.99", "3.3.2")).toBe(false);
    expect(isAtLeast("2.0.0", "3.3.2")).toBe(false);
  });

  it("returns false on unparseable input — floor check fails closed", () => {
    expect(isAtLeast("not-a-version", "3.3.2")).toBe(false);
    expect(isAtLeast("3.3.2", "not-a-version")).toBe(false);
  });
});

describe("isExactMatch — the pin-alignment check", () => {
  it("treats pre-release suffixes as equivalent (we only parse the triplet)", () => {
    expect(isExactMatch("3.3.2", "3.3.2-rc.1")).toBe(true);
    expect(isExactMatch("3.3.2", "3.3.2")).toBe(true);
  });

  it("distinguishes different patches", () => {
    expect(isExactMatch("3.3.2", "3.3.3")).toBe(false);
    expect(isExactMatch("3.3.2", "3.4.2")).toBe(false);
  });

  it("returns false on unparseable input", () => {
    expect(isExactMatch("", "3.3.2")).toBe(false);
    expect(isExactMatch("3.3.2", "latest")).toBe(false);
  });
});
