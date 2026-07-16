/**
 * VFS gateway actions — what the model sees through vfs_list / vfs_read /
 * vfs_write. Uses the real default namespace (built lazily on the first
 * handler call, after beforeAll has pointed paths at a temp workspace).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

let workspaceDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    dirs: new Proxy(real.dirs, {
      get(target, prop: string) {
        if (prop === "workspace") return workspaceDir;
        if (prop === "skills") return join(workspaceDir, "skills");
        if (prop === "scripts") return join(workspaceDir, "scripts");
        if (prop === "logs") return join(workspaceDir, "logs");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { vfsHandlers } from "../core/engine/gateway-actions/vfs.js";

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-vfs-actions-"));
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function call(
  action: "vfs_list" | "vfs_read" | "vfs_write",
  body: Record<string, unknown>,
) {
  return vfsHandlers[action]!(body, 0);
}

describe("vfs gateway actions", () => {
  it("lists the namespace root with all default mounts", async () => {
    const result = await call("vfs_list", { path: "" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("(6 entries)");
    for (const mount of ["home/", "skills/", "proc/", "plugins/"]) {
      expect(result.text).toContain(mount);
    }
  });

  it("round-trips a write through the home mount", async () => {
    const written = await call("vfs_write", {
      path: "home/notes/idea.md",
      content: "remember this",
    });
    expect(written.ok).toBe(true);
    expect(written.text).toContain("talon://home/notes/idea.md");

    const read = await call("vfs_read", { path: "home/notes/idea.md" });
    expect(read).toMatchObject({ ok: true, text: "remember this" });

    const listed = await call("vfs_list", { path: "home/notes" });
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain("idea.md");
  });

  it("surfaces errno-style failures as tool errors", async () => {
    const missing = await call("vfs_read", { path: "home/nope.md" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("not-found");

    const readonly = await call("vfs_write", {
      path: "proc/tasks/1",
      content: "x",
    });
    expect(readonly.ok).toBe(false);
    expect(readonly.error).toContain("not-writable");

    const traversal = await call("vfs_list", { path: "home/../secrets" });
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toContain("invalid-path");
  });

  it("accepts the OS spelling of a mounted path", async () => {
    const written = await call("vfs_write", {
      path: join(workspaceDir, "os-spelled.md"),
      content: "hello",
    });
    expect(written.ok).toBe(true);

    const read = await call("vfs_read", { path: "home/os-spelled.md" });
    expect(read).toMatchObject({ ok: true, text: "hello" });
  });

  it("shows disk mappings for file mounts at the root", async () => {
    const result = await call("vfs_list", { path: "" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`home/  → ${workspaceDir}`);
  });

  it("exposes live proc structure through the same tools", async () => {
    const listed = await call("vfs_list", { path: "proc" });
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain("tasks/");
    expect(listed.text).toContain("events");
  });
});
