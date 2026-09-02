import { execFileSync } from "node:child_process";

/** Whether `name` resolves on PATH (`which` / `where`), without running it. */
export function binaryOnPath(name: string): boolean {
  try {
    const lookupCmd = process.platform === "win32" ? "where" : "which";
    execFileSync(lookupCmd, [name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
