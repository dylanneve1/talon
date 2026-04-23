/**
 * GitHub MCP onboarding + sanity checks.
 *
 * The GitHub MCP server ships as a Docker image. We:
 *   - Pin the image tag Talon supports (GITHUB_MCP_IMAGE)
 *   - Verify Docker is installed and the daemon is reachable
 *   - Verify the pinned image is present locally, optionally docker pull it
 *   - Surface actionable errors when any step fails
 *
 * Bump GITHUB_MCP_IMAGE when the plugin has been tested and verified against
 * a newer github-mcp-server release — not before.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Pinned github-mcp-server Docker image. Bump after testing against a new
 * upstream release. `latest` is explicitly avoided — pinning protects us
 * from silent breaking changes in the MCP protocol or tool schemas.
 *
 * @see https://github.com/github/github-mcp-server/releases
 */
export const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.0.2";

export type InstallStatus = {
  /** True when the image is available locally and Docker is reachable. */
  ok: boolean;
  /** Image reference used for the check. */
  image: string;
  /** Human-readable steps taken during this ensure() call. */
  steps: string[];
  /** Populated when ok=false — actionable error for the user. */
  error?: string;
};

export type EnsureOptions = {
  /**
   * If true, a missing image triggers `docker pull`. When false, the function
   * only diagnoses and returns an error.
   */
  autoPull: boolean;
  /** Image tag override. Defaults to {@link GITHUB_MCP_IMAGE}. */
  image?: string;
  /** Timeout for each subprocess call, ms. Default 120s (pulls can be slow). */
  timeoutMs?: number;
  /** Injected for tests — defaults to Node's promisified execFile. */
  execFileImpl?: typeof execFile;
};

/**
 * Ensure the pinned github-mcp-server image is pullable and available.
 *
 * When autoPull=true this is self-healing: missing image → docker pull.
 * When autoPull=false the function is purely diagnostic.
 */
export async function ensureGithubMcpAvailable(
  opts: EnsureOptions,
): Promise<InstallStatus> {
  const {
    autoPull,
    image = GITHUB_MCP_IMAGE,
    timeoutMs = 120_000,
    execFileImpl = execFile,
  } = opts;

  const steps: string[] = [];

  // 1. Docker available?
  try {
    await execFileImpl("docker", ["info"], { timeout: 15_000 });
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      image,
      steps,
      error: `Docker is not installed or the daemon is not running. The GitHub MCP server requires Docker. Details: ${msg.slice(0, 200)}`,
    };
  }
  steps.push("docker daemon reachable");

  // 2. Image present locally?
  const imagePresent = await isImagePresent(image, execFileImpl);
  if (imagePresent) {
    steps.push(`image present: ${image}`);
    return { ok: true, image, steps };
  }

  // 3. Missing image — optionally pull
  if (!autoPull) {
    return {
      ok: false,
      image,
      steps,
      error: `GitHub MCP image ${image} is not present locally. Run: docker pull ${image} — or set github.autoPull=true to pull automatically.`,
    };
  }
  steps.push(`pulling ${image}`);
  try {
    await execFileImpl("docker", ["pull", image], { timeout: timeoutMs });
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr ?? "";
    const stderrText =
      typeof stderr === "string"
        ? stderr
        : Buffer.isBuffer(stderr)
          ? stderr.toString("utf-8")
          : "";
    return {
      ok: false,
      image,
      steps,
      error: `docker pull ${image} failed: ${(err as Error).message}${stderrText ? ` — ${stderrText.trim().slice(0, 400)}` : ""}`,
    };
  }

  // 4. Re-verify
  if (!(await isImagePresent(image, execFileImpl))) {
    return {
      ok: false,
      image,
      steps,
      error: `docker pull claimed success but image ${image} is still not present locally.`,
    };
  }
  steps.push(`image pulled: ${image}`);
  return { ok: true, image, steps };
}

async function isImagePresent(
  image: string,
  execFileImpl: typeof execFile,
): Promise<boolean> {
  try {
    await execFileImpl("docker", ["image", "inspect", image], {
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}
