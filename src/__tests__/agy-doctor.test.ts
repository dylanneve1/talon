/**
 * Antigravity doctor + auth-detection tests.
 *
 * The binary, its version, the cached OAuth credentials and the model
 * catalog are the four things an operator can get wrong; each has to
 * produce a check that names the fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const binaryOnPathMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});
vi.mock("../util/binary-on-path.js", () => ({
  binaryOnPath: binaryOnPathMock,
}));

const { agyDoctorChecks } = await import("../backend/agy/doctor.js");
const { detectAgyAuth, isAgyAuthFailure, agyAuthError } =
  await import("../backend/agy/auth.js");

let dir: string;
let tokenPath: string;

const MODELS_TSV = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";

function writeToken(body: unknown): void {
  writeFileSync(tokenPath, JSON.stringify(body));
  process.env.TALON_AGY_TOKEN_FILE = tokenPath;
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

const byLabel = (checks: Awaited<ReturnType<typeof agyDoctorChecks>>) =>
  Object.fromEntries(checks.map((c) => [c.label, c]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agy-doctor-"));
  tokenPath = join(dir, "antigravity-oauth-token");
  process.env.TALON_AGY_TOKEN_FILE = join(dir, "absent");
  binaryOnPathMock.mockReturnValue(true);
  execFileSyncMock.mockImplementation((_bin: string, args: string[]) =>
    args[0] === "--version" ? "1.2.7\n" : MODELS_TSV,
  );
});

afterEach(() => {
  delete process.env.TALON_AGY_TOKEN_FILE;
  delete process.env.AGY_BINARY;
  rmSync(dir, { recursive: true, force: true });
});

describe("agy auth detection", () => {
  it("reads the 1.2.x nested token shape", () => {
    writeToken({
      auth_method: "consumer",
      token: {
        access_token: "ya29.x",
        refresh_token: "1//y",
        expiry: future(),
      },
    });
    const auth = detectAgyAuth();
    expect(auth).toMatchObject({
      present: true,
      method: "consumer",
      expired: false,
      refreshable: true,
    });
  });

  it("also reads the flat legacy shape", () => {
    writeToken({ auth_method: "consumer", expiry: past(), refresh_token: "r" });
    expect(detectAgyAuth()).toMatchObject({
      present: true,
      expired: true,
      refreshable: true,
    });
  });

  it("reports a missing file rather than throwing", () => {
    process.env.TALON_AGY_TOKEN_FILE = join(dir, "nope");
    expect(detectAgyAuth()).toMatchObject({
      present: false,
      problem: "no cached credentials",
    });
  });

  it("reports a corrupt file rather than throwing", () => {
    writeFileSync(tokenPath, "not json");
    process.env.TALON_AGY_TOKEN_FILE = tokenPath;
    expect(detectAgyAuth().problem).toMatch(/not valid JSON/);
  });

  it("recognises the CLI's unauthenticated stderr", () => {
    expect(isAgyAuthFailure("error: authentication required")).toBe(true);
    expect(isAgyAuthFailure("Error: not authenticated")).toBe(true);
    expect(isAgyAuthFailure("dial tcp: connection refused")).toBe(false);
  });

  it("names the interactive login as the fix, and says there is no API key", () => {
    const err = agyAuthError(new Error("raw"));
    expect(err.message).toMatch(/interactively/);
    expect(err.message).toMatch(/no API key/i);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
});

describe("agy doctor", () => {
  it("fails fast when the binary is missing", async () => {
    binaryOnPathMock.mockReturnValue(false);
    const checks = await agyDoctorChecks(undefined);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "fail" });
    expect(checks[0].detail).toMatch(/agyBinary|AGY_BINARY/);
  });

  it("reports binary, version, auth and models when all is well", async () => {
    writeToken({
      auth_method: "consumer",
      token: { expiry: future(), refresh_token: "r" },
    });
    const checks = byLabel(await agyDoctorChecks(undefined));
    expect(checks["Antigravity CLI installed"].status).toBe("ok");
    expect(checks["Antigravity CLI version"]).toMatchObject({
      status: "ok",
      detail: "1.2.7",
    });
    expect(checks["Antigravity auth"].status).toBe("ok");
    expect(checks["Antigravity models"]).toMatchObject({ status: "ok" });
    expect(checks["Antigravity models"].detail).toContain("1 available");
  });

  it("fails a version below the stream-json floor", async () => {
    execFileSyncMock.mockImplementation((_b: string, args: string[]) =>
      args[0] === "--version" ? "1.1.9\n" : MODELS_TSV,
    );
    const checks = byLabel(await agyDoctorChecks(undefined));
    expect(checks["Antigravity CLI too old (1.1.9)"]).toMatchObject({
      status: "fail",
    });
  });

  it("accepts a newer version", async () => {
    execFileSyncMock.mockImplementation((_b: string, args: string[]) =>
      args[0] === "--version" ? "2.0.0\n" : MODELS_TSV,
    );
    const checks = byLabel(await agyDoctorChecks(undefined));
    expect(checks["Antigravity CLI version"].status).toBe("ok");
  });

  it("warns when no credentials are cached", async () => {
    const checks = byLabel(await agyDoctorChecks(undefined));
    const auth = checks["Antigravity auth missing"];
    expect(auth).toMatchObject({ status: "warn", issue: true });
    expect(auth.detail).toMatch(/interactively/);
  });

  it("warns on an expired token with no refresh token", async () => {
    writeToken({ auth_method: "consumer", token: { expiry: past() } });
    const checks = byLabel(await agyDoctorChecks(undefined));
    expect(checks["Antigravity auth expired"]).toMatchObject({
      status: "warn",
      issue: true,
    });
  });

  it("stays green on an expired-but-refreshable token", async () => {
    writeToken({
      auth_method: "consumer",
      token: { expiry: past(), refresh_token: "r" },
    });
    const checks = byLabel(await agyDoctorChecks(undefined));
    expect(checks["Antigravity auth"].status).toBe("ok");
    expect(checks["Antigravity auth"].detail).toContain("refreshable");
  });

  it("warns when `agy models` answers with nothing", async () => {
    execFileSyncMock.mockImplementation((_b: string, args: string[]) =>
      args[0] === "--version" ? "1.2.7\n" : "Fetching available models...\n",
    );
    const checks = byLabel(await agyDoctorChecks(undefined));
    expect(checks["Antigravity models empty"]).toMatchObject({
      status: "warn",
      issue: true,
    });
  });

  it("skips the catalog probe for an inactive backend", async () => {
    await agyDoctorChecks(undefined, false);
    const probed = execFileSyncMock.mock.calls.map(
      (c) => (c[1] as string[])[0],
    );
    expect(probed).not.toContain("models");
  });

  it("honours the configured binary and the env override", async () => {
    await agyDoctorChecks({ agyBinary: "/opt/agy" } as never);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("/opt/agy");
    execFileSyncMock.mockClear();
    process.env.AGY_BINARY = "/env/agy";
    await agyDoctorChecks({ agyBinary: "/opt/agy" } as never);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("/env/agy");
  });
});
