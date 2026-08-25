/**
 * Real-environment provisioning suite — the teeth behind the
 * native-provision workflow (.github/workflows/native-provision.yml).
 *
 * Everything here hits the network and real interpreters, so the whole
 * file is gated behind env flags and skipped in the normal unit run:
 *
 *   TALON_PROVISION_REAL=1            mempalace venv scenarios (all OSes)
 *   TALON_PROVISION_TARGET=latest     canary: provision PyPI latest instead of the pin
 *   TALON_PROVISION_REAL_PLAYWRIGHT=1 real browser download scenario
 *   TALON_PROVISION_REAL_DOCKER=1     real image pull scenario (needs docker)
 *   TALON_PROVISION_GITHUB_TAG        canary override for the image tag
 *
 * Scenarios mirror the provisioner's real-life duties: fresh install →
 * live MCP handshake, self-heal from a gutted site-packages, and a
 * genuine 3.3.6 → pin upgrade with the palace migration wired through.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findBasePython,
  runStep,
  venvPython,
  type ProvisionOutcome,
} from "../../core/plugin/provision.js";
import {
  provisionMempalace,
  MEMPALACE_PINNED_VERSION,
} from "../../plugins/mempalace/provision.js";
import { provisionPlaywright } from "../../plugins/playwright/provision.js";
import {
  provisionGithubMcp,
  githubMcpImageRef,
} from "../../plugins/github/provision.js";

const REAL = process.env.TALON_PROVISION_REAL === "1";
const REAL_PLAYWRIGHT = process.env.TALON_PROVISION_REAL_PLAYWRIGHT === "1";
const REAL_DOCKER = process.env.TALON_PROVISION_REAL_DOCKER === "1";

const INSTALL_TIMEOUT = 20 * 60_000;

const detail = (o: ProvisionOutcome): string =>
  `status=${o.status} error=${o.error ?? "-"} warnings=[${o.warnings.join("; ")}] actions=[${o.actions.join("; ")}]`;

async function resolveTarget(): Promise<string> {
  if (process.env.TALON_PROVISION_TARGET !== "latest") {
    return process.env.TALON_PROVISION_TARGET ?? MEMPALACE_PINNED_VERSION;
  }
  const res = await fetch("https://pypi.org/pypi/mempalace/json");
  const data = (await res.json()) as { info: { version: string } };
  return data.info.version;
}

/**
 * Spawn the mempalace MCP server over stdio and complete a JSON-RPC
 * initialize handshake — the same contract the Claude SDK relies on.
 */
async function mcpInitialize(
  python: string,
  palace: string,
): Promise<{ serverName?: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      python,
      ["-m", "mempalace.mcp_server", "--palace", palace],
      { env: { ...process.env, MEMPALACE_PALACE_PATH: palace } },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("MCP initialize timed out"));
    }, 120_000);

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: { serverInfo?: { name?: string } };
          };
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolvePromise({ serverName: msg.result.serverInfo?.name });
            return;
          }
        } catch {
          /* partial line — keep buffering */
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`MCP server exited early (code ${code})`));
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "talon-provision-ci", version: "0" },
        },
      }) + "\n",
    );
  });
}

describe.skipIf(!REAL)("mempalace real provisioning", () => {
  it(
    "fresh install → pinned version → live MCP handshake → self-heal",
    { timeout: 2 * INSTALL_TIMEOUT },
    async () => {
      const target = await resolveTarget();
      const home = mkdtempSync(join(tmpdir(), "talon-prov-fresh-"));
      const venvDir = join(home, "mempalace-venv");
      const python = venvPython(venvDir, process.platform);
      const palace = join(home, "palace");
      const statePath = join(home, "state.json");
      const opts = {
        pythonPath: python,
        palacePath: palace,
        version: target,
      };
      const deps = { defaultManagedPython: python, statePath };

      // Fresh: no venv at all → created, installed, verified.
      const fresh = await provisionMempalace(opts, deps);
      expect(fresh.status, detail(fresh)).toBe("ready");
      expect(fresh.version).toBe(target);
      expect(fresh.actions.join(" ")).toContain("created venv");

      // The runtime actually serves MCP.
      const handshake = await mcpInitialize(python, palace);
      expect(handshake.serverName).toBeTruthy();

      // Idempotent second pass: nothing to do.
      const again = await provisionMempalace(opts, deps);
      expect(again.status, detail(again)).toBe("ready");
      expect(again.actions).toHaveLength(0);

      // Self-heal: gut site-packages and expect a working reinstall.
      const purelib = await runStep(
        python,
        ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        { timeoutMs: 30_000 },
      );
      expect(purelib.ok).toBe(true);
      rmSync(join(purelib.stdout.trim(), "mempalace"), {
        recursive: true,
        force: true,
      });
      const healed = await provisionMempalace(opts, deps);
      expect(healed.status, detail(healed)).toBe("ready");
      expect(healed.version).toBe(target);
      expect(healed.actions.join(" ")).toContain(
        `installed mempalace ${target}`,
      );

      rmSync(home, { recursive: true, force: true });
    },
  );

  it(
    "3.3.6 → pin upgrade migrates the palace exactly once",
    { timeout: 2 * INSTALL_TIMEOUT },
    async () => {
      const target = await resolveTarget();
      const home = mkdtempSync(join(tmpdir(), "talon-prov-upgrade-"));
      const venvDir = join(home, "mempalace-venv");
      const python = venvPython(venvDir, process.platform);
      const palace = join(home, "palace");
      const statePath = join(home, "state.json");

      // Seed a genuine old install the way a pre-provisioner deployment had it.
      const base = await findBasePython(runStep, process.platform, {
        major: 3,
        minor: 10,
      });
      expect(base).toBeDefined();
      const venv = await runStep(
        base!.command,
        [...base!.args, "-m", "venv", venvDir],
        { timeoutMs: 120_000 },
      );
      expect(venv.ok).toBe(true);
      const old = await runStep(
        python,
        ["-m", "pip", "install", "mempalace==3.3.6"],
        { timeoutMs: INSTALL_TIMEOUT },
      );
      expect(old.ok).toBe(true);

      // A palace with a store present arms the one-time wing migration.
      mkdirSync(palace, { recursive: true });
      writeFileSync(join(palace, "chroma.sqlite3"), "");

      const outcome = await provisionMempalace(
        { pythonPath: python, palacePath: palace, version: target },
        { defaultManagedPython: python, statePath },
      );
      // A healthy-but-behind install reconciles in the background.
      expect(outcome.status, detail(outcome)).toBe("ready");
      expect(outcome.version).toBe("3.3.6");
      expect(outcome.background).toBeDefined();
      const settled = await outcome.background!();
      expect(settled.status, detail(settled)).toBe("ready");
      expect(settled.version).toBe(target);
      expect(settled.actions.join(" ")).toContain(
        `upgraded mempalace 3.3.6 → ${target}`,
      );
      expect(settled.actions.join(" ")).toContain("wing-name migration");

      rmSync(home, { recursive: true, force: true });
    },
  );
});

describe.skipIf(!REAL_PLAYWRIGHT)("playwright real provisioning", () => {
  it(
    "downloads the chromium build into an isolated cache",
    { timeout: INSTALL_TIMEOUT },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "talon-prov-pw-"));
      const browsers = join(home, "browsers");
      const outcome = await provisionPlaywright(
        { browser: "chromium" },
        {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
          statePath: join(home, "state.json"),
        },
      );
      expect(outcome.status, detail(outcome)).toBe("ready");
      expect(outcome.actions.join(" ")).toContain("chromium");

      // Second pass sees the build and does nothing.
      const again = await provisionPlaywright(
        { browser: "chromium" },
        {
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
          statePath: join(home, "state.json"),
        },
      );
      expect(again.status, detail(again)).toBe("ready");
      expect(again.actions).toHaveLength(0);

      rmSync(home, { recursive: true, force: true });
    },
  );
});

describe.skipIf(!REAL_DOCKER)("github mcp real provisioning", () => {
  it(
    "pulls the pinned image and the binary answers",
    { timeout: INSTALL_TIMEOUT },
    async () => {
      const home = mkdtempSync(join(tmpdir(), "talon-prov-gh-"));
      const imageTag = process.env.TALON_PROVISION_GITHUB_TAG;
      const outcome = await provisionGithubMcp(
        { imageTag },
        { statePath: join(home, "state.json") },
      );
      // Either already present (ready) or pulled by the background task.
      const settled = outcome.background ? await outcome.background() : outcome;
      expect(settled.status, detail(settled)).toBe("ready");

      const help = await runStep(
        "docker",
        ["run", "--rm", githubMcpImageRef(imageTag), "--help"],
        { timeoutMs: 120_000 },
      );
      expect(help.ok).toBe(true);

      rmSync(home, { recursive: true, force: true });
    },
  );
});
