import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../util/concurrency.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapConcurrent", () => {
  it("preserves result order while running up to `limit` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapConcurrent([5, 1, 4, 2, 3], 2, async (ms) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return ms * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("drains the batch before rethrowing the first failure", async () => {
    const finished: number[] = [];
    await expect(
      mapConcurrent([1, 2, 3], 3, async (n) => {
        await sleep(n);
        finished.push(n);
        if (n === 1) throw new Error("first");
        return n;
      }),
    ).rejects.toThrow("first");
    expect(finished.sort()).toEqual([1, 2, 3]);
  });

  it("handles an empty input and a limit above the item count", async () => {
    expect(await mapConcurrent([], 8, async () => 1)).toEqual([]);
    expect(await mapConcurrent([1], 8, async (n) => n + 1)).toEqual([2]);
  });
});
