import { describe, it, expect, vi } from "vitest";
import {
  GITHUB_MCP_IMAGE,
  ensureGithubMcpAvailable,
} from "../plugins/github/install.js";

describe("GITHUB_MCP_IMAGE", () => {
  it("is a pinned ghcr.io reference (never :latest)", () => {
    expect(GITHUB_MCP_IMAGE).toMatch(
      /^ghcr\.io\/github\/github-mcp-server:v\d+\.\d+\.\d+/,
    );
    expect(GITHUB_MCP_IMAGE).not.toContain(":latest");
  });
});

describe("ensureGithubMcpAvailable", () => {
  function queueExec(responses: Array<{ stdout?: string } | Error>) {
    return vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected exec call (no response queued)");
      if (next instanceof Error) throw next;
      return { stdout: next.stdout ?? "", stderr: "" };
    });
  }

  it("reports ok when docker works and image is present", async () => {
    const exec = queueExec([
      { stdout: "Containers: 0" }, // docker info
      { stdout: "[{...}]" }, // docker image inspect
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: false,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.image).toBe(GITHUB_MCP_IMAGE);
    expect(status.error).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("errors when docker daemon is unreachable", async () => {
    const exec = queueExec([
      Object.assign(new Error("Cannot connect to the Docker daemon"), {
        stderr: "daemon unreachable",
      }),
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("Docker is not installed");
  });

  it("errors without pulling when autoPull=false and image is missing", async () => {
    const exec = queueExec([
      { stdout: "Containers: 0" },
      Object.assign(new Error("No such image"), {}),
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: false,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("not present locally");
    expect(status.error).toContain("github.autoPull=true");
  });

  it("pulls when autoPull=true and image is missing, then reports ok", async () => {
    const exec = queueExec([
      { stdout: "Containers: 0" }, // docker info
      Object.assign(new Error("No such image"), {}), // first inspect fails
      { stdout: "pulled" }, // docker pull
      { stdout: "[{...}]" }, // second inspect succeeds
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.steps.some((s) => s.startsWith("pulling"))).toBe(true);
    expect(status.steps.some((s) => s.startsWith("image pulled"))).toBe(true);
  });

  it("surfaces pull failure with useful error text", async () => {
    const exec = queueExec([
      { stdout: "Containers: 0" },
      Object.assign(new Error("no image"), {}),
      Object.assign(new Error("pull failed"), {
        stderr: "manifest unknown: manifest unknown",
      }),
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("docker pull");
    expect(status.error).toContain("manifest unknown");
  });

  it("errors when pull succeeds but image is still not detectable", async () => {
    const exec = queueExec([
      { stdout: "Containers: 0" },
      Object.assign(new Error("no image"), {}),
      { stdout: "pulled" },
      Object.assign(new Error("still not there"), {}),
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("claimed success");
  });

  it("respects image override", async () => {
    const exec = queueExec([
      { stdout: "Containers: 0" },
      { stdout: "[{...}]" },
    ]);
    const status = await ensureGithubMcpAvailable({
      autoPull: false,
      image: "ghcr.io/github/github-mcp-server:v0.9.0-rc1",
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.image).toBe("ghcr.io/github/github-mcp-server:v0.9.0-rc1");
  });
});
