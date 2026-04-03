/**
 * Tests for src/util/cleanup-registry.ts
 */
import { describe, it, expect } from "vitest";
import { registerCleanup } from "../util/cleanup-registry.js";

describe("cleanup-registry", () => {
  it("registered handler is called when the exit event fires", () => {
    let called = false;
    registerCleanup(() => {
      called = true;
    });
    process.emit("exit", 0);
    expect(called).toBe(true);
  });

  it("multiple handlers are all called on exit", () => {
    const results: number[] = [];
    registerCleanup(() => results.push(1));
    registerCleanup(() => results.push(2));
    registerCleanup(() => results.push(3));
    process.emit("exit", 0);
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(3);
  });

  it("handler that throws does not prevent subsequent handlers from running", () => {
    let afterCalled = false;
    registerCleanup(() => {
      throw new Error("boom");
    });
    registerCleanup(() => {
      afterCalled = true;
    });
    expect(() => process.emit("exit", 0)).not.toThrow();
    expect(afterCalled).toBe(true);
  });

  it("registering the same function object twice calls it twice", () => {
    let count = 0;
    const fn = () => count++;
    registerCleanup(fn);
    registerCleanup(fn);
    process.emit("exit", 0);
    expect(count).toBe(2);
  });

  it("does not add a new process exit listener on each registerCleanup call", () => {
    const before = process.listenerCount("exit");
    registerCleanup(() => {});
    registerCleanup(() => {});
    registerCleanup(() => {});
    const after = process.listenerCount("exit");
    // Listener count must not grow — one listener handles all handlers
    expect(after).toBe(before);
  });
});
