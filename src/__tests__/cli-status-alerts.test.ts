/**
 * `talon status` / `talon doctor` render the daemon's active alerts from
 * its /health body — and tolerate a daemon too old to send any.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("picocolors", () => {
  const id = (s: string) => s;
  return {
    default: { yellow: id, red: id, bold: id, dim: id, green: id, cyan: id },
  };
});

const { formatAlertLines } = await import("../cli/status.js");

describe("formatAlertLines", () => {
  it("renders one line per alert", () => {
    expect(
      formatAlertLines({
        alerts: [
          { key: "disk.low", severity: "critical", message: "800 MiB free" },
          { key: "errors.spike", severity: "warn", message: "20 errors" },
        ],
      }),
    ).toEqual(["  ● disk.low  800 MiB free", "  ● errors.spike  20 errors"]);
  });

  it("is empty for a daemon without alerts, or garbage", () => {
    expect(formatAlertLines({})).toEqual([]);
    expect(formatAlertLines({ alerts: "nope" })).toEqual([]);
    expect(formatAlertLines({ alerts: [null, { key: 1 }] })).toEqual([]);
  });
});
