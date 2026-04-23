import { describe, it, expect, vi } from "vitest";
import {
  createProgressLogger,
  formatElapsed,
  type LogLevel,
} from "../../../plugins/common/progress.js";
import type { LogComponent } from "../../../util/log.js";

function capture() {
  const events: Array<{
    level: LogLevel;
    component: LogComponent;
    message: string;
  }> = [];
  const sink = vi.fn(
    (level: LogLevel, component: LogComponent, message: string) => {
      events.push({ level, component, message });
    },
  );
  return { events, sink };
}

describe("ProgressLogger", () => {
  it("numbers steps 1..N and emits start + end sink events with elapsed", () => {
    const { events, sink } = capture();
    let t = 0;
    const logger = createProgressLogger({
      component: "plugin",
      sink,
      now: () => t,
    });

    const a = logger.step("step a");
    t = 120;
    a.ok();
    const b = logger.step("step b");
    t = 350;
    b.ok("details");

    // Four events: start a, end a, start b, end b.
    expect(events).toHaveLength(4);
    expect(events[0].message).toMatch(/▸ \[1\] step a/);
    expect(events[1].message).toMatch(/✓ \[1\] step a \(120ms\)/);
    expect(events[2].message).toMatch(/▸ \[2\] step b/);
    expect(events[3].message).toMatch(/✓ \[2\] step b \(230ms\) — details/);
  });

  it("routes fail to level=error so production logs pick the right bucket", () => {
    const { events, sink } = capture();
    const logger = createProgressLogger({
      component: "plugin",
      sink,
      now: () => 0,
    });
    logger.step("boom").fail("kaboom");
    const finish = events.at(-1)!;
    expect(finish.level).toBe("error");
    expect(finish.message).toContain("✗ [1] boom");
    expect(finish.message).toContain("kaboom");
  });

  it("skipped steps use level=info and don't count toward totalElapsedMs", () => {
    const { events, sink } = capture();
    let t = 0;
    const logger = createProgressLogger({
      component: "plugin",
      sink,
      now: () => t,
    });
    const a = logger.step("done a");
    t = 50;
    a.ok();
    const b = logger.step("skip b");
    t = 5050; // 5s of "skip work"
    b.skip("already present");
    expect(logger.totalElapsedMs()).toBe(50);
    const skippedEvent = events.at(-1)!;
    expect(skippedEvent.level).toBe("info");
    expect(skippedEvent.message).toContain("– [2] skip b");
  });

  it("stream() emits an indented info line suitable for subprocess output", () => {
    const { events, sink } = capture();
    const logger = createProgressLogger({
      component: "plugin",
      sink,
      now: () => 0,
    });
    const step = logger.step("install");
    step.stream("Collecting mempalace==3.3.2");
    // pip output has its own leading whitespace for sub-steps — preserve
    // it so hierarchy stays visible under our fixed 4-space prefix.
    step.stream("  Downloading mempalace-3.3.2-py3-none-any.whl (550 kB)");
    step.stream(""); // blank line: dropped
    step.ok();

    const streamEvents = events.filter((e) => e.message.startsWith("    "));
    expect(streamEvents).toHaveLength(2);
    expect(streamEvents[0].message).toBe("    Collecting mempalace==3.3.2");
    expect(streamEvents[1].message).toBe(
      "      Downloading mempalace-3.3.2-py3-none-any.whl (550 kB)",
    );
  });

  it("records() returns a snapshot of structured step data for tests / summaries", () => {
    const { sink } = capture();
    let t = 0;
    const logger = createProgressLogger({
      component: "plugin",
      sink,
      now: () => t,
    });
    const a = logger.step("a");
    t = 100;
    a.ok("x");
    const b = logger.step("b");
    t = 250;
    b.fail("bad");
    const c = logger.step("c");
    t = 260;
    c.skip("not needed");

    const records = logger.records();
    expect(records).toEqual([
      { index: 1, label: "a", status: "ok", elapsedMs: 100, detail: "x" },
      { index: 2, label: "b", status: "fail", elapsedMs: 150, detail: "bad" },
      {
        index: 3,
        label: "c",
        status: "skipped",
        elapsedMs: 10,
        detail: "not needed",
      },
    ]);
  });
});

describe("formatElapsed", () => {
  it("uses ms below 1 second", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(999)).toBe("999ms");
  });
  it("uses 1 decimal for 1-10s", () => {
    expect(formatElapsed(1000)).toBe("1.0s");
    expect(formatElapsed(2340)).toBe("2.3s");
    expect(formatElapsed(9999)).toBe("10.0s");
  });
  it("uses integer seconds for 10s–10min", () => {
    expect(formatElapsed(10_000)).toBe("10s");
    expect(formatElapsed(125_000)).toBe("125s");
  });
  it("uses minutes for 10min+", () => {
    expect(formatElapsed(600_000)).toBe("10m00s");
    expect(formatElapsed(625_500)).toBe("10m26s");
  });
});
