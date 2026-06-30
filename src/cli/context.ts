/**
 * Shared CLI context — package root and well-known file paths.
 *
 * PKG_ROOT is resolved from this file's own location (src/cli/) two levels up
 * to the package root, so it's independent of the process cwd — matching the
 * original `src/cli.ts` derivation (which sat one level up, in src/).
 */

import { dirname, resolve } from "node:path";
import { files as pathFiles } from "../util/paths.js";

// Bun-compiled binaries embed the source tree — import.meta.dirname points
// into the virtual FS (prefix ~BUN / $bunfs) which has no real disk path.
// Fall back to the directory containing the executable instead.
const isBunEmbedded =
  (import.meta.dirname ?? "").includes("~BUN") ||
  (import.meta.dirname ?? "").includes("$bunfs");

export const PKG_ROOT = isBunEmbedded
  ? dirname(process.execPath)
  : resolve(import.meta.dirname ?? process.cwd(), "..", "..");
export const CONFIG_FILE = pathFiles.config;
export const LOG_FILE = pathFiles.log;
