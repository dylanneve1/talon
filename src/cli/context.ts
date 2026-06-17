/**
 * Shared CLI context — package root and well-known file paths.
 *
 * PKG_ROOT is resolved from this file's own location (src/cli/) two levels up
 * to the package root, so it's independent of the process cwd — matching the
 * original `src/cli.ts` derivation (which sat one level up, in src/).
 */

import { resolve } from "node:path";
import { files as pathFiles } from "../util/paths.js";

export const PKG_ROOT = resolve(
  import.meta.dirname ?? process.cwd(),
  "..",
  "..",
);
export const CONFIG_FILE = pathFiles.config;
export const LOG_FILE = pathFiles.log;
