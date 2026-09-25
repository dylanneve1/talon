/**
 * `talon logs` keeps tailing across a log rotation: a daemon start moves
 * talon.log aside and starts a fresh, shorter file under the same name.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tail = vi.hoisted(() => ({
  file: "",
  listener: null as ((curr: Stats, prev: Stats) => void) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watchFile: ((_path: string, _opts: unknown, listener: never) => {
      tail.listener = listener;
    }) as unknown as typeof actual.watchFile,
  };
});

vi.mock("../cli/context.js", () => ({
  get LOG_FILE() {
    return tail.file;
  },
}));

vi.mock("../cli/config.js", () => ({ printBanner: () => {} }));

const { tailLogs } = await import("../cli/logs.js");

function line(msg: string): string {
  return JSON.stringify({ level: 30, time: 0, component: "bot", msg });
}

const stats = (ino: number, size: number) => ({ ino, size }) as Stats;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("talon logs", () => {
  it("prints the new file's lines after the log is rotated", async () => {
    tail.file = join(mkdtempSync(join(tmpdir(), "talon-logs-")), "talon.log");
    const old = Array.from({ length: 40 }, (_, i) => line(`old ${i}`));
    writeFileSync(tail.file, old.join("\n") + "\n");
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((text?: unknown) => {
      printed.push(String(text));
    });

    void tailLogs();
    await vi.waitFor(() => expect(tail.listener).not.toBeNull());
    printed.length = 0;

    // Rotation: a new inode, and far fewer lines than before.
    writeFileSync(tail.file, [line("fresh 1"), line("fresh 2")].join("\n"));
    tail.listener!(stats(2, 100), stats(1, 5000));

    expect(printed.join("\n")).toContain("fresh 1");
    expect(printed.join("\n")).toContain("fresh 2");
  });
});
