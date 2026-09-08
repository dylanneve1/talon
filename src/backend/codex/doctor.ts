/**
 * `talon doctor` checks for the Codex backend: the CLI binary and how it
 * will authenticate.
 */

import type {
  DoctorCheck,
  DoctorConfigSlice,
} from "../../core/doctor-types.js";
import { binaryOnPath } from "../../util/binary-on-path.js";
import { detectCodexAuth } from "./auth.js";

export async function codexDoctorChecks(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  if (!binaryOnPath("codex")) {
    checks.push({
      label: "Codex CLI not found",
      status: "fail",
      detail: "npm i -g @openai/codex",
    });
    return checks;
  }
  checks.push({ label: "Codex CLI installed", status: "ok" });
  const auth = detectCodexAuth({
    codexApiKey: config?.codexApiKey,
    openaiApiKey: config?.openaiApiKey,
    openaiBaseUrl: config?.openaiBaseUrl,
  });
  for (const diagnostic of auth.diagnostics) {
    checks.push({ label: diagnostic, status: "warn" });
  }
  if (auth.mode !== "none") {
    checks.push({
      label: "Codex auth",
      status: "ok",
      detail: auth.baseUrl ? `${auth.source} (${auth.baseUrl})` : auth.source,
    });
  } else {
    checks.push({
      label: "Codex auth missing",
      status: "warn",
      detail:
        "set CODEX_API_KEY, TALON_CODEX_KEY, codexApiKey, or run `codex login`",
      issue: true,
    });
  }
  return checks;
}
