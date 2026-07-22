/**
 * Node provisioning grants — single-use legs, expiry, and the generated
 * installer scripts (POSIX sh for linux/darwin, PowerShell for windows).
 */

import { describe, it, expect } from "vitest";
import {
  installOneLiner,
  NodeProvisionStore,
} from "../core/mesh/node-provision.js";

const BASE = {
  goos: "linux" as const,
  goarch: "arm64",
  binaryPath: "/tmp/talon-node-linux-arm64",
  sha256: "ab".repeat(32),
  size: 6_000_000,
  version: "3.4.0",
  bridgeUrl: "https://100.64.0.7:19880",
  bearerToken: "bearer-secret",
  fingerprint: "cd".repeat(32),
};

describe("NodeProvisionStore", () => {
  it("serves each leg exactly once", () => {
    const store = new NodeProvisionStore();
    const grant = store.create(BASE);
    expect(store.openScript(grant.token)?.filename).toBe(
      "install-talon-node.sh",
    );
    expect(store.openScript(grant.token)).toBeNull();
    expect(store.openBinary(grant.token)).toEqual({
      path: BASE.binaryPath,
      size: BASE.size,
    });
    expect(store.openBinary(grant.token)).toBeNull();
  });

  it("rejects unknown tokens and expires unclaimed grants", () => {
    const store = new NodeProvisionStore(-1); // everything already expired
    const grant = store.create(BASE);
    expect(store.openScript("nope")).toBeNull();
    expect(store.openScript(grant.token)).toBeNull();
  });

  it("sanitizes device names against quote breakouts", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, name: 'evil"; rm -rf / #box 1' });
    expect(grant.name).toBe("evil rm -rf  box 1");
  });
});

describe("installer scripts", () => {
  it("sh installer wires bridge, digest, token, and fingerprint through", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, name: "build-box" });
    const { script, filename } = store.openScript(grant.token)!;
    expect(filename).toBe("install-talon-node.sh");
    expect(script).toContain(`BRIDGE="${BASE.bridgeUrl}"`);
    expect(script).toContain(`SHA="${BASE.sha256}"`);
    expect(script).toContain(`/node/binary?provision=${grant.token}`);
    expect(script).toContain(`--token "${BASE.bearerToken}"`);
    expect(script).toContain(`--fingerprint "${BASE.fingerprint}"`);
    expect(script).toContain(`--name "build-box"`);
    // The digest check must gate the install, not decorate it.
    expect(script).toContain("refusing to install");
  });

  it("windows grants produce a PowerShell installer and one-liner", () => {
    const store = new NodeProvisionStore();
    const grant = store.create({ ...BASE, goos: "windows", goarch: "amd64" });
    const { script, filename } = store.openScript(grant.token)!;
    expect(filename).toBe("install-talon-node.ps1");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain(BASE.sha256);
    expect(installOneLiner(grant)).toContain("powershell");
  });

  it("unix one-liner pipes the install route into sh", () => {
    const store = new NodeProvisionStore();
    const grant = store.create(BASE);
    expect(installOneLiner(grant)).toBe(
      `curl -fsSk "${BASE.bridgeUrl}/node/install?provision=${grant.token}" | sh`,
    );
  });

  it("omits fingerprint and name flags when absent", () => {
    const store = new NodeProvisionStore();
    const { fingerprint: _drop, ...rest } = BASE;
    const grant = store.create(rest);
    const { script } = store.openScript(grant.token)!;
    expect(script).not.toContain("--fingerprint");
    expect(script).not.toContain("--name");
  });
});
