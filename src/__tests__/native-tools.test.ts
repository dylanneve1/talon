/**
 * Native tools — Talon's own bash/read/write/edit/glob/search plus teleport.
 *
 *   - composeTools gating: the native set is opt-in (includeNativeTools)
 *   - local execution: shell + filesystem run on the daemon host
 *   - teleport routing: with a target engaged, bash runs on the device via
 *     the mesh exec channel, marker-based cwd tracking persists across calls
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MeshRegistry,
  MeshService,
  setMeshService,
} from "../core/mesh/index.js";
import { resetTeleportCache } from "../core/mesh/teleport.js";
import { nativeHandlers } from "../core/engine/gateway-actions/native.js";
import { composeTools } from "../core/tools/index.js";

let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "talon-native-"));
  process.env.TALON_TELEPORT_STATE_FILE = join(workdir, "teleport.json");
});

afterEach(async () => {
  await nativeHandlers.teleport_back({ action: "teleport_back" }, 1);
  resetTeleportCache();
  setMeshService(null);
});

function freshMesh(): MeshService {
  return new MeshService(
    new MeshRegistry({
      devices: join(workdir, `d-${Math.random()}.json`),
      locations: join(workdir, `l-${Math.random()}.json`),
      history: join(workdir, `h-${Math.random()}.json`),
    }),
  );
}

describe("native tool composition gating", () => {
  it("excludes the native set by default and includes it on request", () => {
    const off = composeTools({ frontend: "telegram" }).map((t) => t.name);
    for (const n of [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "search",
      "teleport",
    ]) {
      expect(off).not.toContain(n);
    }

    const on = composeTools({
      frontend: "telegram",
      includeNativeTools: true,
    }).map((t) => t.name);
    for (const n of [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "search",
      "teleport",
      "teleport_back",
    ]) {
      expect(on).toContain(n);
    }
  });
});

describe("native tools — local execution", () => {
  it("runs a shell command on the daemon host", async () => {
    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo hello-native" },
      1,
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("hello-native");
    expect(res.text).toContain("exit 0");
  });

  it("reports a non-zero exit", async () => {
    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "exit 3" },
      1,
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain("exit 3");
  });

  it("writes, reads (numbered), and edits a file locally", async () => {
    const f = join(workdir, "roundtrip.txt");
    const w = await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "alpha\nbeta\ngamma\n" },
      1,
    );
    expect(w.ok).toBe(true);

    const r = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain("alpha");
    expect(r.text).toMatch(/\s+1\talpha/); // line numbers

    const e = await nativeHandlers.native_edit(
      {
        action: "native_edit",
        path: f,
        old_string: "beta",
        new_string: "BETA!",
      },
      1,
    );
    expect(e.ok).toBe(true);

    const r2 = await nativeHandlers.native_read(
      { action: "native_read", path: f },
      1,
    );
    expect(r2.text).toContain("BETA!");
    expect(r2.text).not.toContain("beta");
  });

  it("refuses an ambiguous edit unless replace_all is set", async () => {
    const f = join(workdir, "dupe.txt");
    await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "x x x" },
      1,
    );
    const ambiguous = await nativeHandlers.native_edit(
      { action: "native_edit", path: f, old_string: "x", new_string: "y" },
      1,
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.text).toContain("appears 3×");

    const all = await nativeHandlers.native_edit(
      {
        action: "native_edit",
        path: f,
        old_string: "x",
        new_string: "y",
        replace_all: true,
      },
      1,
    );
    expect(all.ok).toBe(true);
    expect(all.text).toContain("3 replacements");
  });

  it("searches file contents and globs files with ripgrep", async () => {
    const f = join(workdir, "needle.txt");
    await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "find-this-token here\n" },
      1,
    );
    const s = await nativeHandlers.native_search(
      { action: "native_search", pattern: "find-this-token", path: workdir },
      1,
    );
    expect(s.ok).toBe(true);
    expect(s.text).toContain("find-this-token");

    const g = await nativeHandlers.native_glob(
      { action: "native_glob", pattern: "needle.txt", path: workdir },
      1,
    );
    expect(g.ok).toBe(true);
    expect(g.text).toContain("needle.txt");
  });

  it("search and glob still find real matches when rg is missing (JS fallback)", async () => {
    const f = join(workdir, "fallback-needle.txt");
    await nativeHandlers.native_write(
      { action: "native_write", path: f, content: "fallback-token here\n" },
      1,
    );
    process.env.TALON_NATIVE_RG = join(workdir, "no-such-rg-binary");
    try {
      const s = await nativeHandlers.native_search(
        { action: "native_search", pattern: "fallback-token", path: workdir },
        1,
      );
      expect(s.ok).toBe(true);
      // Must be a REAL match line (path:line:content), not a vacuous
      // "No matches for fallback-token" echo of the pattern.
      expect(s.text).toContain("match line");
      expect(s.text).toContain(`${f}:1:`);

      const g = await nativeHandlers.native_glob(
        {
          action: "native_glob",
          pattern: "fallback-needle.txt",
          path: workdir,
        },
        1,
      );
      expect(g.ok).toBe(true);
      expect(g.text).toContain("match(es)");
      expect(g.text).toContain(f);
    } finally {
      delete process.env.TALON_NATIVE_RG;
    }
  });
});

describe("native tools — teleport routing", () => {
  it("teleports onto a device, routes bash through the mesh, and tracks cwd", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    const sentCmds: string[] = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          sentCmds.push(String(cmd.params.cmd));
          // Emulate the device shell: our wrapper appends a pwd marker; return
          // some output plus the marker so cwd tracking can parse it.
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              stdout:
                "Downloads\nPictures\n__TALON_CWD__/sdcard/Download__TALON_CWD_END__",
              stderr: "",
              exitCode: 0,
              via: "shizuku",
            },
          });
        }),
    });

    const tp = await nativeHandlers.teleport(
      { action: "teleport", device: "phone" },
      1,
    );
    expect(tp.ok).toBe(true);
    expect(tp.text).toContain("Pixel 9");

    const res = await nativeHandlers.native_bash(
      { action: "native_bash", command: "ls" },
      1,
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain("[Pixel 9 via shizuku] exit 0");
    expect(res.text).toContain("Downloads");
    // The cwd marker must be stripped from what the model sees.
    expect(res.text).not.toContain("__TALON_CWD__");

    // Second command should carry the tracked cwd forward.
    resetTeleportCache();
    await nativeHandlers.native_bash(
      { action: "native_bash", command: "ls again" },
      1,
    );
    expect(sentCmds[1]).toContain("cd '/sdcard/Download'");
  });

  it("scopes teleport routing to the current chat", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["exec"],
    });
    const sentCmds: string[] = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() => {
          sentCmds.push(String(cmd.params.cmd));
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            data: {
              stdout: "remote\n__TALON_CWD__/sdcard__TALON_CWD_END__",
              stderr: "",
              exitCode: 0,
            },
          });
        }),
    });

    const tp = await nativeHandlers.teleport(
      { action: "teleport", device: "phone" },
      1,
    );
    expect(tp.ok).toBe(true);

    const local = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo local-chat" },
      2,
    );
    expect(local.ok).toBe(true);
    expect(local.text).toContain("[local] exit 0");
    expect(local.text).toContain("local-chat");
    expect(sentCmds).toHaveLength(0);

    const remote = await nativeHandlers.native_bash(
      { action: "native_bash", command: "echo remote-chat" },
      1,
    );
    expect(remote.ok).toBe(true);
    expect(remote.text).toContain("[Pixel 9] exit 0");
    expect(sentCmds).toHaveLength(1);
  });

  it("refuses to teleport onto a device that lacks exec", async () => {
    const service = freshMesh();
    setMeshService(service);
    await service.register({
      id: "watch",
      name: "Pixel Watch",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["ring"],
    });
    const tp = await nativeHandlers.teleport(
      { action: "teleport", device: "watch" },
      1,
    );
    expect(tp.ok).toBe(false);
    expect(tp.text).toContain('does not advertise the "exec"');
  });
});
