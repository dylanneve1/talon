/**
 * `talon doctor` checks for the Antigravity backend: the binary, its
 * version, the cached OAuth credentials, and whether the model
 * catalog answers.
 */

import { execFileSync } from "node:child_process";
import type {
  DoctorCheck,
  DoctorConfigSlice,
} from "../../core/doctor/types.js";
import { binaryOnPath } from "../../util/binary-on-path.js";
import { AGY_MIN_VERSION } from "./constants.js";
import { detectAgyAuth } from "./auth.js";
import { parseAgyModels } from "./models.js";

/** Resolve the binary the same way the runtime does: env, config, PATH. */
function resolveBinary(config: DoctorConfigSlice | undefined): string {
  const configured = (config as { agyBinary?: string } | undefined)?.agyBinary;
  return process.env.AGY_BINARY || configured || "agy";
}

/** `1.2.7` → [1, 2, 7]; missing parts are 0. */
function parseVersion(text: string): number[] {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return [];
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(found: number[], required: number[]): boolean {
  for (let i = 0; i < required.length; i++) {
    const a = found[i] ?? 0;
    const b = required[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function run(binary: string, args: string[]): string {
  return execFileSync(binary, args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
}

function versionCheck(binary: string): DoctorCheck {
  let output: string;
  try {
    output = run(binary, ["--version"]).trim();
  } catch (err) {
    return {
      label: "Antigravity CLI version unreadable",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
      issue: true,
    };
  }
  const found = parseVersion(output);
  const required = parseVersion(AGY_MIN_VERSION);
  if (found.length === 0) {
    return {
      label: "Antigravity CLI version unrecognised",
      status: "warn",
      detail: output,
      issue: true,
    };
  }
  if (!versionAtLeast(found, required)) {
    return {
      label: `Antigravity CLI too old (${output})`,
      status: "fail",
      detail: `headless stream-json needs >= ${AGY_MIN_VERSION}`,
    };
  }
  return { label: "Antigravity CLI version", status: "ok", detail: output };
}

function authCheck(): DoctorCheck {
  const auth = detectAgyAuth();
  if (!auth.present) {
    return {
      label: "Antigravity auth missing",
      status: "warn",
      detail: `${auth.problem ?? "no token file"} — run \`agy\` once interactively to sign in`,
      issue: true,
    };
  }
  if (auth.expired && !auth.refreshable) {
    return {
      label: "Antigravity auth expired",
      status: "warn",
      detail: `token expired ${auth.expiry?.toISOString() ?? ""} with no refresh token — run \`agy\` again`,
      issue: true,
    };
  }
  const detail = [
    auth.method ? `${auth.method} OAuth` : "OAuth",
    auth.expired ? "access token stale (refreshable)" : undefined,
    auth.expiry ? `expiry ${auth.expiry.toISOString()}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return { label: "Antigravity auth", status: "ok", detail };
}

function modelsCheck(binary: string): DoctorCheck {
  try {
    const models = parseAgyModels(run(binary, ["models"]));
    if (models.length === 0) {
      return {
        label: "Antigravity models empty",
        status: "warn",
        detail: "`agy models` returned no rows",
        issue: true,
      };
    }
    return {
      label: "Antigravity models",
      status: "ok",
      detail: `${models.length} available (${models[0].id}…)`,
    };
  } catch (err) {
    return {
      label: "Antigravity models unavailable",
      status: "warn",
      detail: err instanceof Error ? err.message : String(err),
      issue: true,
    };
  }
}

export async function agyDoctorChecks(
  config: DoctorConfigSlice | undefined,
  isActive = true,
): Promise<DoctorCheck[]> {
  const binary = resolveBinary(config);
  const found =
    binary.includes("/") || binary.includes("\\") ? true : binaryOnPath(binary);
  if (!found) {
    return [
      {
        label: "Antigravity CLI not found",
        status: "fail",
        detail:
          "install the Antigravity CLI and put `agy` on PATH, or set `agyBinary` / AGY_BINARY",
      },
    ];
  }

  const checks: DoctorCheck[] = [
    { label: "Antigravity CLI installed", status: "ok", detail: binary },
    versionCheck(binary),
    authCheck(),
  ];
  // The catalog probe costs a process spawn and a network round-trip,
  // so it only runs for the backend actually serving chats.
  if (isActive) checks.push(modelsCheck(binary));
  return checks;
}
