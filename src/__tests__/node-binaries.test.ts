/**
 * Node-binary resolver — target matrix, name normalization, and the tiered
 * resolution flow (cache verify, digest-checked release download). The
 * source-build tier is exercised only for its "disabled" path — a real
 * `go build` needs a toolchain the CI matrix already covers in apps/node.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_TARGETS,
  nodeAssetName,
  normalizeGoarch,
  normalizeGoos,
  platformToGoos,
  resolveNodeBinary,
} from "../core/mesh/node-binaries.js";

const VERSION = "9.9.9";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function tempCache(): Promise<string> {
  return mkdtemp(join(tmpdir(), "talon-node-bin-"));
}

/** A fetch stub serving a release's sums manifest + one binary. */
function releaseFetch(
  binary: Buffer,
  asset: string,
  opts: { sums?: string } = {},
): typeof fetch {
  const sums = opts.sums ?? `${sha256(binary)}  ${asset}\n`;
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/talon-node-SHA256SUMS")) return new Response(sums);
    if (url.endsWith(`/${asset}`)) return new Response(new Uint8Array(binary));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("target naming + normalization", () => {
  it("names assets exactly like the build tool (windows gets .exe)", () => {
    expect(nodeAssetName("linux", "arm64")).toBe("talon-node-linux-arm64");
    expect(nodeAssetName("windows", "amd64")).toBe(
      "talon-node-windows-amd64.exe",
    );
  });

  it("normalizes user spellings onto Go names", () => {
    expect(normalizeGoos("macOS")).toBe("darwin");
    expect(normalizeGoos("Linux")).toBe("linux");
    expect(normalizeGoos("android")).toBeUndefined();
    expect(normalizeGoarch("x86_64")).toBe("amd64");
    expect(normalizeGoarch("aarch64")).toBe("arm64");
    expect(normalizeGoarch("armv7l")).toBe("arm");
    expect(normalizeGoarch("riscv64")).toBeUndefined();
  });

  it("maps mesh platforms onto GOOS, excluding mobile", () => {
    expect(platformToGoos("macos")).toBe("darwin");
    expect(platformToGoos("linux")).toBe("linux");
    expect(platformToGoos("windows")).toBe("windows");
    expect(platformToGoos("android")).toBeUndefined();
    expect(platformToGoos("ios")).toBeUndefined();
  });

  it("rejects targets outside the matrix without touching any tier", async () => {
    await expect(
      resolveNodeBinary("linux", "riscv64", { repoRoot: null }),
    ).rejects.toThrow(/No talon-node target/);
    expect(NODE_TARGETS.length).toBe(6);
  });
});

describe("release download tier", () => {
  it("downloads, digest-verifies, caches (0755), and serves from cache after", async () => {
    const cacheRoot = await tempCache();
    const binary = Buffer.from("#!fake-elf talon-node payload");
    const asset = nodeAssetName("linux", "arm64");
    let fetches = 0;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: unknown,
    ) => {
      fetches++;
      return releaseFetch(binary, asset)(
        String(input) as string,
        init as never,
      );
    }) as typeof fetch;

    const first = await resolveNodeBinary("linux", "arm64", {
      cacheRoot,
      repoRoot: null,
      fetchImpl,
      version: VERSION,
    });
    expect(first.source).toBe("release");
    expect(first.version).toBe(VERSION);
    expect(first.sha256).toBe(sha256(binary));
    expect(first.path).toBe(join(cacheRoot, VERSION, asset));
    expect(await readFile(first.path)).toEqual(binary);

    const again = await resolveNodeBinary("linux", "arm64", {
      cacheRoot,
      repoRoot: null,
      fetchImpl: (() => {
        throw new Error("network must not be touched on a cache hit");
      }) as unknown as typeof fetch,
      version: VERSION,
    });
    expect(again.source).toBe("cache");
    expect(again.sha256).toBe(first.sha256);
    expect(fetches).toBe(2); // sums + binary, once
  });

  it("refuses a download whose digest does not match the manifest", async () => {
    const cacheRoot = await tempCache();
    const binary = Buffer.from("payload");
    const asset = nodeAssetName("linux", "amd64");
    await expect(
      resolveNodeBinary("linux", "amd64", {
        cacheRoot,
        repoRoot: null,
        fetchImpl: releaseFetch(binary, asset, {
          sums: `${sha256("something else")}  ${asset}\n`,
        }),
        version: VERSION,
      }),
    ).rejects.toThrow(/digest mismatch/);
  });

  it("fails clearly when the release has no entry for the asset", async () => {
    const cacheRoot = await tempCache();
    await expect(
      resolveNodeBinary("darwin", "arm64", {
        cacheRoot,
        repoRoot: null,
        fetchImpl: releaseFetch(Buffer.from("x"), "talon-node-linux-amd64"),
        version: VERSION,
      }),
    ).rejects.toThrow(/no entry/);
  });

  it("re-downloads over a corrupted cache entry instead of serving it", async () => {
    const cacheRoot = await tempCache();
    const asset = nodeAssetName("linux", "amd64");
    const good = Buffer.from("good build");
    const dir = join(cacheRoot, VERSION);
    await mkdir(dir, { recursive: true });
    // Recorded digest says "good build", but the bytes on disk are damaged.
    await writeFile(join(dir, asset), "damaged");
    await writeFile(join(dir, `${asset}.sha256`), `${sha256(good)}\n`);

    const resolved = await resolveNodeBinary("linux", "amd64", {
      cacheRoot,
      repoRoot: null,
      fetchImpl: releaseFetch(good, asset),
      version: VERSION,
    });
    expect(resolved.source).toBe("release");
    expect(await readFile(resolved.path)).toEqual(good);
  });

  it("prunes cached matrices from other Talon versions after a download", async () => {
    const cacheRoot = await tempCache();
    const staleDir = join(cacheRoot, "1.0.0");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "talon-node-linux-amd64"), "stale");
    const devDir = join(cacheRoot, "dev");
    await mkdir(devDir, { recursive: true });
    await writeFile(join(devDir, "talon-node-linux-amd64"), "dev build");

    const binary = Buffer.from("fresh");
    const asset = nodeAssetName("linux", "amd64");
    await resolveNodeBinary("linux", "amd64", {
      cacheRoot,
      repoRoot: null,
      fetchImpl: releaseFetch(binary, asset),
      version: VERSION,
    });
    await expect(readFile(join(staleDir, asset))).rejects.toThrow();
    // Dev builds are working-tree artifacts, not version-keyed — kept.
    expect(String(await readFile(join(devDir, asset)))).toBe("dev build");
  });
});
