/**
 * GitHub MCP self-heal.
 *
 * Docker image lifecycle. On every enabled run:
 *   1. Verify docker daemon is reachable (fast fail).
 *   2. Check whether the pinned image is present locally.
 *   3. Pull the pinned tag regardless. `docker pull` is cheap when the
 *      digest is already cached — layers aren't re-downloaded — and
 *      protects us from upstream force-pushes of the tag.
 *   4. Inspect the image to confirm it resolved.
 *
 * Unlike mempalace there's no "verify-only" mode: Docker images are
 * namespaced by registry/tag, so pulling the pinned tag doesn't step on
 * anything the user cares about. Worst case it warms the local cache.
 */

import {
  runProbe,
  runStreaming,
  type RunOptions,
} from "../common/subprocess.js";
import type { HealContext, HealFn, HealResult } from "../common/lifecycle.js";
import type { PluginError } from "../common/errors.js";

/**
 * Pinned github-mcp-server Docker image. Bump after testing against a new
 * upstream release. `latest` is explicitly avoided — pinning guards against
 * silent breaking changes in MCP protocol or tool schemas.
 *
 * @see https://github.com/github/github-mcp-server/releases
 */
export const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server:v1.0.2";

export interface GithubHealOpts {
  /** Image tag override. Testing only — production should bump the pin. */
  image?: string;
}

function runOpts(
  ctx: HealContext,
  tracker: RunOptions["tracker"],
  timeoutMs: number,
): RunOptions {
  return { timeoutMs, tracker, spawnImpl: ctx.spawnImpl };
}

function failed(
  identifier: string,
  error: PluginError,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "failed", identifier, error, elapsedMs, summary };
}

function healthy(
  identifier: string,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "healthy", identifier, elapsedMs, summary };
}

export function createGithubHeal(opts: GithubHealOpts = {}): HealFn {
  const image = opts.image ?? GITHUB_MCP_IMAGE;

  return async (ctx: HealContext): Promise<HealResult> => {
    const { logger } = ctx;
    const start = Date.now();
    const summary: string[] = [];

    // ── Step 1: docker daemon reachable? ──────────────────────────────
    const daemonStep = logger.step("docker daemon");
    const daemonResult = await runStreaming(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      runOpts(ctx, daemonStep, 15_000),
    );
    if (!daemonResult.ok) {
      daemonStep.fail(
        daemonResult.error?.message ?? "docker daemon not reachable",
      );
      return failed(
        image,
        daemonResult.error ?? {
          kind: "executable-not-found",
          message: "docker daemon not reachable",
          hint: "install Docker and start the daemon: https://docs.docker.com/engine/install/",
        },
        Date.now() - start,
        summary,
      );
    }
    const serverVersion = daemonResult.stdout.trim() || "unknown";
    daemonStep.ok(`Docker server ${serverVersion}`);
    summary.push(`docker ${serverVersion}`);

    // ── Step 2: is the pinned image already present? ──────────────────
    const inspectStep = logger.step("inspect pinned image");
    const inspectResult = await runProbe(
      "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeoutMs: 15_000, spawnImpl: ctx.spawnImpl },
    );
    const imagePresent = inspectResult !== null;
    inspectStep.ok(imagePresent ? "present" : "not present");

    // ── Step 3: pull the pinned tag (always, to refresh digest) ───────
    const pullStep = logger.step(
      imagePresent ? `refresh ${image}` : `pull ${image}`,
    );
    const pullResult = await runStreaming(
      "docker",
      ["pull", image],
      runOpts(ctx, pullStep, 5 * 60_000),
    );
    if (!pullResult.ok) {
      pullStep.fail(pullResult.error?.message ?? "docker pull failed");
      // Gracefully: if we already have the image, a pull failure is not
      // fatal — the MCP server will use the cached copy. Surface a
      // warning instead of refusing to spawn.
      if (imagePresent) {
        logger.warn(
          `pull failed but cached image is available; starting with stale digest — ${pullResult.error?.message ?? "unknown"}`,
        );
        summary.push(`image ${image} (cached, refresh failed)`);
        return {
          status: "degraded",
          identifier: image,
          error: pullResult.error,
          elapsedMs: Date.now() - start,
          summary,
        };
      }
      return failed(
        image,
        pullResult.error ?? {
          kind: "unknown",
          message: "docker pull failed and no cached image available",
          hint: `try manually: docker pull ${image}`,
        },
        Date.now() - start,
        summary,
      );
    }
    pullStep.ok();

    // ── Step 4: re-inspect to confirm ─────────────────────────────────
    const verifyStep = logger.step("verify image resolvable");
    const verifyResult = await runProbe(
      "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeoutMs: 15_000, spawnImpl: ctx.spawnImpl },
    );
    if (verifyResult === null) {
      verifyStep.fail("post-pull inspect failed");
      return failed(
        image,
        {
          kind: "unknown",
          message: `post-pull inspect of ${image} failed`,
          hint: "check docker daemon logs for registry auth or storage issues",
        },
        Date.now() - start,
        summary,
      );
    }
    const imageId = verifyResult.split(":")[1]?.slice(0, 12) ?? "unknown";
    verifyStep.ok(`id ${imageId}`);
    summary.push(`image ${image} (${imageId})`);

    return healthy(image, Date.now() - start, summary);
  };
}
