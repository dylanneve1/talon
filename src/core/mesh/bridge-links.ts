/**
 * Bridge links — the MeshService collaborator that hands a device what it
 * needs to reach this daemon: node provisioning (a single-use installer
 * link that fetches a digest-verified talon-node binary from the bridge),
 * companion pairing (a single-use link carrying the bridge URL, token and
 * certificate fingerprint), and the reachability answer behind both.
 *
 * It owns the grant stores and the bridge's self-reported identity; it
 * never touches devices or commands.
 */

import { networkInterfaces } from "node:os";
import {
  CompanionPairStore,
  pairLink,
  pairPage,
  type CompanionPairPayload,
} from "./companion-pairing.js";
import { formatBytes, type MeshToolResult } from "./common.js";
import {
  NODE_TARGETS,
  normalizeGoarch,
  normalizeGoos,
  type NodeBinaryResolver,
} from "./node-binaries.js";
import { installOneLiner, NodeProvisionStore } from "./node-provision.js";

/**
 * What the native bridge tells the mesh about itself once it's listening —
 * everything a generated node installer needs to point a fresh host here.
 * Registered by the native frontend after server start; null when the
 * bridge isn't running (provisioning tools then fail with a clear reason).
 */
export type MeshBridgeInfo = {
  scheme: "http" | "https";
  /** The bind host from config — may be a wildcard (0.0.0.0/::). */
  host: string;
  port: number;
  /** Bearer token clients authenticate with (absent on open loopback). */
  token?: string;
  /** TLS certificate SHA-256 (absent over plain HTTP). */
  fingerprint?: string;
};

export class BridgeLinks {
  /** One-time grants for bridge-served node installers. */
  private readonly provision = new NodeProvisionStore();
  /** One-time grants that hand a phone this bridge's connection details. */
  private readonly companionPairs = new CompanionPairStore();
  private bridgeInfo: MeshBridgeInfo | null = null;

  constructor(private readonly resolveNode: NodeBinaryResolver) {}

  /** The native bridge reports its reachable identity here (null on stop). */
  setBridgeInfo(info: MeshBridgeInfo | null): void {
    this.bridgeInfo = info;
  }

  // ── Node provisioning ──────────────────────────────────────────────────────

  /**
   * `get_node_binary`: materialize a talon-node binary for any supported
   * platform/arch on the daemon host — source build in a dev checkout, else
   * the digest-verified release download (cached under ~/.talon/node-bin).
   */
  async getNodeBinary(os: unknown, arch: unknown): Promise<MeshToolResult> {
    const goos = normalizeGoos(os);
    const goarch = normalizeGoarch(arch);
    if (!goos || !goarch) {
      return { ok: false, text: unknownTargetText(os, arch) };
    }
    try {
      const bin = await this.resolveNode(goos, goarch);
      return {
        ok: true,
        text: `talon-node ${bin.version} for ${goos}/${goarch}: ${bin.path} (${formatBytes(bin.size)}, sha256 ${bin.sha256}, via ${bin.source})`,
      };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  }

  /**
   * `make_node_install_link`: mint a single-use provisioning URL on the
   * bridge and return the one command that turns a fresh host into a mesh
   * node — it fetches the installer script, which downloads the (digest-
   * verified) binary from the same bridge, installs it, pre-pins the bridge
   * certificate, and registers the boot service.
   */
  async makeNodeInstallLink(
    os: unknown,
    arch: unknown,
    name?: unknown,
    bridgeUrl?: unknown,
  ): Promise<MeshToolResult> {
    const goos = normalizeGoos(os);
    const goarch = normalizeGoarch(arch);
    if (!goos || !goarch) {
      return { ok: false, text: unknownTargetText(os, arch) };
    }
    const info = this.bridgeInfo;
    if (!info) {
      return {
        ok: false,
        text: "The native bridge isn't running, so there is nothing for a new node to connect to. Enable the native frontend first.",
      };
    }
    if (!info.token) {
      return {
        ok: false,
        text: "The bridge has no bearer token (loopback-only bind), and nodes authenticate with one. Set native.host to a reachable address (a token is auto-minted) and restart.",
      };
    }
    const base = this.bridgeBaseUrl(info, bridgeUrl);
    if (typeof base !== "string") return { ok: false, text: base.error };
    let bin;
    try {
      bin = await this.resolveNode(goos, goarch);
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
    const grant = this.provision.create({
      goos,
      goarch,
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      binaryPath: bin.path,
      sha256: bin.sha256,
      size: bin.size,
      version: bin.version,
      bridgeUrl: base,
      bearerToken: info.token,
      ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
    });
    return {
      ok: true,
      text: [
        `Run this on the new ${goos}/${goarch} host:`,
        "",
        `  ${installOneLiner(grant)}`,
        "",
        `It installs talon-node ${bin.version} (sha256-verified against ${grant.sha256.slice(0, 12)}…), pins the bridge certificate, and registers a boot service — the host appears on the mesh within a minute.`,
        `Single-use link, expires in 30 minutes. The host must be able to reach ${base}.`,
      ].join("\n"),
    };
  }

  /**
   * Mint a single-use link that connects a phone to this bridge without
   * anyone typing an address or a token — the companion half of
   * {@link makeNodeInstallLink}.
   *
   * Returns the link plus the values it carries, so a caller (a `/mesh`
   * reply, say) can print both: the link is the one-tap path, the values are
   * what someone falls back to when the app isn't installed yet.
   */
  makeCompanionPairLink(
    label?: unknown,
    bridgeUrl?: unknown,
  ):
    | {
        ok: true;
        link: string;
        url: string;
        token: string;
        fingerprint?: string;
      }
    | { ok: false; text: string } {
    const info = this.bridgeInfo;
    if (!info) {
      return {
        ok: false,
        text: "The native bridge isn't running, so there is nothing for a phone to connect to. Enable the native frontend first.",
      };
    }
    if (!info.token) {
      return {
        ok: false,
        text: "The bridge has no bearer token (loopback-only bind), and companions authenticate with one. Set native.host to a reachable address (a token is auto-minted) and restart.",
      };
    }
    const base = this.bridgeBaseUrl(info, bridgeUrl);
    if (typeof base !== "string") return { ok: false, text: base.error };
    const grant = this.companionPairs.create({
      bridgeUrl: base,
      bearerToken: info.token,
      ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
      ...(typeof label === "string" && label.trim()
        ? { label: label.trim() }
        : {}),
    });
    return {
      ok: true,
      link: pairLink(grant),
      url: base,
      token: info.token,
      ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
    };
  }

  /**
   * GET /pair — serve a pairing grant (single-use), as the landing page or
   * as the JSON the companion reads.
   */
  openCompanionPair(
    token: string,
    format: "html" | "json",
  ): { contentType: string; body: string } | null {
    const payload = this.companionPairs.claim(token);
    if (!payload) return null;
    return format === "json"
      ? {
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify(payload satisfies CompanionPairPayload),
        }
      : {
          contentType: "text/html; charset=utf-8",
          body: pairPage(payload),
        };
  }

  /**
   * How this bridge is reachable, for an operator asking "what do I point a
   * device at?".
   *
   * The bearer token comes back with it. Deciding who may see a credential is
   * the caller's job, not this seam's — the Telegram `/mesh` shows it to the
   * configured admin and withholds it from everyone else — and an operator who
   * asked their own daemon for its own connection details should get an
   * answer, not a lecture.
   */
  bridgeReachability():
    | {
        ok: true;
        url: string;
        authRequired: boolean;
        token?: string;
        fingerprint?: string;
      }
    | { ok: false; text: string } {
    const info = this.bridgeInfo;
    if (!info) return { ok: false, text: "The native bridge isn't running." };
    const base = this.bridgeBaseUrl(info);
    if (typeof base !== "string") return { ok: false, text: base.error };
    return {
      ok: true,
      url: base,
      authRequired: Boolean(info.token),
      ...(info.token ? { token: info.token } : {}),
      ...(info.fingerprint ? { fingerprint: info.fingerprint } : {}),
    };
  }

  /** GET /node/install — serve a grant's installer script (single-use). */
  openNodeInstall(token: string): { script: string; filename: string } | null {
    return this.provision.openScript(token);
  }

  /** GET /node/binary — serve a grant's binary (single-use). */
  openNodeBinary(token: string): { path: string; size: number } | null {
    return this.provision.openBinary(token);
  }

  /**
   * The bridge base URL a NEW host should dial: an explicit override wins;
   * otherwise derive from the bridge's bind. A wildcard bind maps to this
   * host's first external IPv4; a loopback bind is unreachable from other
   * machines, so it's an error rather than a link that can't work.
   */
  private bridgeBaseUrl(
    info: MeshBridgeInfo,
    explicit?: unknown,
  ): string | { error: string } {
    if (typeof explicit === "string" && explicit.trim()) {
      const url = explicit.trim().replace(/\/+$/, "");
      if (!/^https?:\/\/\S+$/.test(url)) {
        return { error: `bridge_url must be an http(s) URL, got "${url}".` };
      }
      return url;
    }
    let host = info.host;
    if (host === "0.0.0.0" || host === "::") {
      const external = firstExternalIPv4();
      if (!external) {
        return {
          error:
            "Could not determine this host's external address — pass bridge_url explicitly (the URL the new node should dial).",
        };
      }
      host = external;
    } else if (isLoopbackAddress(host)) {
      return {
        error: `The bridge is bound to loopback (${host}), which other machines can't reach. Set native.host to a reachable address, or pass bridge_url if a tunnel exposes it.`,
      };
    }
    return `${info.scheme}://${host}:${info.port}`;
  }
}

/** Error text for an os/arch pair outside the talon-node build matrix. */
function unknownTargetText(os: unknown, arch: unknown): string {
  return `No talon-node target for os="${String(os)}", arch="${String(arch)}". Supported: ${NODE_TARGETS.map(
    (t) => `${t.goos}/${t.goarch}`,
  ).join(", ")} (macos ≡ darwin, x86_64 ≡ amd64, aarch64 ≡ arm64).`;
}

/** First non-internal IPv4 on this host — the wildcard-bind fallback. */
function firstExternalIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.family === "IPv4") return iface.address;
    }
  }
  return undefined;
}

function isLoopbackAddress(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}
