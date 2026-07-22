/**
 * NodeProvisionStore — one-time grants that turn a fresh host into a mesh
 * node with a single command.
 *
 * The daemon mints a grant bound to one resolved binary (path + digest) and
 * one target platform; the bridge serves two UNAUTHENTICATED but
 * token-gated routes against it:
 *
 *   GET /node/install?provision=<token>   → installer script (once)
 *   GET /node/binary?provision=<token>    → the binary itself (once)
 *
 * The routes must work pre-auth — the whole point is a host that holds no
 * bridge credential yet — so the grant token IS the authorization, exactly
 * like streamed-transfer tokens (transfers.ts): random 192-bit, single-use
 * per leg, expiring unused. The script carries the bridge bearer token and
 * pinned TLS fingerprint into the node's config, verifies the downloaded
 * binary against the grant's digest (integrity is the script's own sha256
 * check, not TLS), installs it, and registers the boot service via
 * `talon-node install`.
 */

import { randomBytes } from "node:crypto";

/** Unclaimed grants die after this long. */
const GRANT_TTL_MS = 30 * 60 * 1000;

export type NodeProvisionGrant = {
  token: string;
  goos: "linux" | "darwin" | "windows";
  goarch: string;
  /** Device name baked into the installer (optional — defaults to hostname). */
  name?: string;
  /** The resolved binary this grant serves. */
  binaryPath: string;
  sha256: string;
  size: number;
  version: string;
  /** Bridge base URL as reachable from the target host. */
  bridgeUrl: string;
  /** Bridge bearer token the node will authenticate with. */
  bearerToken: string;
  /** Bridge TLS certificate fingerprint to pre-pin (absent over plain HTTP). */
  fingerprint?: string;
  createdAt: number;
  scriptUsed: boolean;
  binaryUsed: boolean;
};

export class NodeProvisionStore {
  private readonly grants = new Map<string, NodeProvisionGrant>();

  constructor(private readonly ttlMs = GRANT_TTL_MS) {}

  create(
    grant: Omit<
      NodeProvisionGrant,
      "token" | "createdAt" | "scriptUsed" | "binaryUsed"
    >,
  ): NodeProvisionGrant {
    this.sweep();
    const full: NodeProvisionGrant = {
      ...grant,
      // Device names are injected into generated shell/PowerShell text —
      // keep them to characters that can't break out of a quoted string.
      ...(grant.name
        ? { name: grant.name.replace(/[^\w .-]+/g, "").slice(0, 64) }
        : {}),
      token: randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      scriptUsed: false,
      binaryUsed: false,
    };
    this.grants.set(full.token, full);
    return full;
  }

  /** Serve the installer script for a live grant — once. */
  openScript(token: string): { script: string; filename: string } | null {
    const grant = this.claim(token, "scriptUsed");
    if (!grant) return null;
    return grant.goos === "windows"
      ? {
          script: powershellInstaller(grant),
          filename: "install-talon-node.ps1",
        }
      : { script: shellInstaller(grant), filename: "install-talon-node.sh" };
  }

  /** Resolve the binary leg of a live grant — once. */
  openBinary(token: string): { path: string; size: number } | null {
    const grant = this.claim(token, "binaryUsed");
    if (!grant) return null;
    return { path: grant.binaryPath, size: grant.size };
  }

  /** Expire-check + single-use latch for one leg of a grant. */
  private claim(
    token: string,
    leg: "scriptUsed" | "binaryUsed",
  ): NodeProvisionGrant | null {
    this.sweep();
    const grant = this.grants.get(token);
    if (!grant || grant[leg]) return null;
    grant[leg] = true;
    if (grant.scriptUsed && grant.binaryUsed) this.grants.delete(token);
    return grant;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, grant] of this.grants) {
      if (grant.createdAt < cutoff) this.grants.delete(token);
    }
  }
}

/** The command a human (or the model over SSH) runs on the target host. */
export function installOneLiner(grant: NodeProvisionGrant): string {
  const url = `${grant.bridgeUrl}/node/install?provision=${grant.token}`;
  if (grant.goos === "windows") {
    // -k has no iwr flag; trust-all callback covers the self-signed bridge
    // cert for the two fetches — the binary itself is digest-verified. The
    // one-liner is meant for cmd.exe / PowerShell, where $true survives the
    // outer double quotes verbatim.
    return (
      `powershell -ExecutionPolicy Bypass -Command "` +
      `[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; ` +
      `iwr -UseBasicParsing '${url}' | Select-Object -ExpandProperty Content | iex"`
    );
  }
  return `curl -fsSk "${url}" | sh`;
}

/**
 * POSIX installer: fetch the binary over the same grant, verify its digest,
 * install it next to the node's config, and register the boot service. -k on
 * the fetches is deliberate — the bridge cert is self-signed; integrity
 * comes from the embedded sha256 and the fingerprint is pre-pinned into the
 * node's config for every connection after install.
 */
function shellInstaller(grant: NodeProvisionGrant): string {
  const nameFlag = grant.name ? ` --name "${grant.name}"` : "";
  const fpFlag = grant.fingerprint
    ? ` --fingerprint "${grant.fingerprint}"`
    : "";
  return `#!/bin/sh
# talon-node installer — generated by Talon ${grant.version} for ${grant.goos}/${grant.goarch}
set -eu
BRIDGE="${grant.bridgeUrl}"
SHA="${grant.sha256}"
if [ "$(id -u)" = "0" ]; then DEST_DIR="\${TALON_NODE_DIR:-/usr/local/bin}"; else DEST_DIR="\${TALON_NODE_DIR:-$HOME/.talon-node/bin}"; fi
mkdir -p "$DEST_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
echo "Downloading talon-node ${grant.version} (${grant.goos}/${grant.goarch})..."
curl -fsSk "$BRIDGE/node/binary?provision=${grant.token}" -o "$TMP"
if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"; else GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"; fi
if [ "$GOT" != "$SHA" ]; then echo "talon-node download failed its checksum — refusing to install" >&2; exit 1; fi
BIN="$DEST_DIR/talon-node"
mv "$TMP" "$BIN"
chmod 0755 "$BIN"
trap - EXIT
echo "Installed $BIN"
"$BIN" install --bridge "$BRIDGE" --token "${grant.bearerToken}"${fpFlag}${nameFlag}
echo "Done — this host is now on the mesh. Check with: $BIN status"
`;
}

/** PowerShell installer (Windows PowerShell 5+ compatible). */
function powershellInstaller(grant: NodeProvisionGrant): string {
  const nameArg = grant.name ? `, "--name", "${grant.name}"` : "";
  const fpArg = grant.fingerprint
    ? `, "--fingerprint", "${grant.fingerprint}"`
    : "";
  return `# talon-node installer — generated by Talon ${grant.version} for ${grant.goos}/${grant.goarch}
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
$bridge = "${grant.bridgeUrl}"
$dest = Join-Path $env:LOCALAPPDATA "talon-node"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$bin = Join-Path $dest "talon-node.exe"
Write-Host "Downloading talon-node ${grant.version} (${grant.goos}/${grant.goarch})..."
Invoke-WebRequest -UseBasicParsing "$bridge/node/binary?provision=${grant.token}" -OutFile $bin
$got = (Get-FileHash $bin -Algorithm SHA256).Hash.ToLower()
if ($got -ne "${grant.sha256}") { Remove-Item $bin; throw "talon-node download failed its checksum - refusing to install" }
Write-Host "Installed $bin"
& $bin install --bridge $bridge --token "${grant.bearerToken}"${fpArg}${nameArg}
Write-Host "Done - this host is now on the mesh. Check with: $bin status"
`;
}
