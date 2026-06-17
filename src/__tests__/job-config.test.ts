/**
 * Tests for the decoupled-jobs feature gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  decoupledJobsEnabled,
  setDecoupledJobsEnabled,
} from "../core/background/job-config.js";

afterEach(() => setDecoupledJobsEnabled(false));

describe("decoupled-jobs gate", () => {
  it("defaults to disabled", () => {
    expect(decoupledJobsEnabled()).toBe(false);
  });

  it("flips with the setter", () => {
    setDecoupledJobsEnabled(true);
    expect(decoupledJobsEnabled()).toBe(true);
    setDecoupledJobsEnabled(false);
    expect(decoupledJobsEnabled()).toBe(false);
  });
});
