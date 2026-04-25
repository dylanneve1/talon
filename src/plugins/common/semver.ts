/**
 * Minimal semver utilities shared by plugin self-heal logic.
 *
 * Deliberately small: we only need parse + compare for the "is the installed
 * version at or above the floor?" decision. Pulling in a full semver library
 * just for that would balloon the MCP-adjacent surface for no good reason.
 *
 * Pre-release suffixes (e.g. "3.3.2-rc.1") are truncated to their major.minor.patch
 * prefix. This is fine for our pinning strategy — we only compare against released
 * versions we've actually tested.
 */

export type SemVer = Readonly<{
  major: number;
  minor: number;
  patch: number;
}>;

/** Parse `"X.Y.Z"` (with optional `-prerelease`) into a SemVer, or null if malformed. */
export function parseSemVer(raw: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Compare `a` vs `b`. Returns `-1` if `a < b`, `0` if equal, `1` if `a > b`. */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** True when `version >= minimum` under semver ordering. Unparseable → false. */
export function isAtLeast(version: string, minimum: string): boolean {
  const v = parseSemVer(version);
  const min = parseSemVer(minimum);
  if (!v || !min) return false;
  return compareSemVer(v, min) >= 0;
}

/** True when `a` and `b` parse to the same major.minor.patch. Unparseable → false. */
export function isExactMatch(a: string, b: string): boolean {
  const parsedA = parseSemVer(a);
  const parsedB = parseSemVer(b);
  if (!parsedA || !parsedB) return false;
  return compareSemVer(parsedA, parsedB) === 0;
}
