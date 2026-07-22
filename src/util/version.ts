/**
 * The daemon's own release version, as a runtime value.
 *
 * A JSON import (not an fs read) so every packaging shape agrees: tsx and
 * Node resolve the file, and `bun build --compile` inlines it into the
 * standalone binary, where no package.json exists on disk. This is the
 * version the node-binary resolver keys caches and release-asset URLs on,
 * so it must exactly match the published tag (publish.yml verifies that).
 */

import pkg from "../../package.json" with { type: "json" };

/** Talon's semver (e.g. "3.3.0") — the release identity of this build. */
export function talonVersion(): string {
  return pkg.version;
}
