/**
 * `talon doctor` checks for the OpenAI Agents backend: the SDK is bundled,
 * so this is about the API key and which endpoint it will talk to.
 */

import type {
  DoctorCheck,
  DoctorConfigSlice,
} from "../../core/doctor-types.js";

export async function openAIAgentsDoctorChecks(
  config: DoctorConfigSlice | undefined,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    { label: "OpenAI Agents SDK bundled", status: "ok" },
  ];
  const hasEnvKey = Boolean(process.env.OPENAI_API_KEY);
  const hasCfgKey = Boolean(config?.openaiApiKey);
  if (hasEnvKey || hasCfgKey) {
    const sources: string[] = [];
    if (hasEnvKey) sources.push("OPENAI_API_KEY env");
    if (hasCfgKey) sources.push("openaiApiKey in talon.json");
    checks.push({
      label: "OpenAI Agents auth",
      status: "ok",
      detail: sources.join(", "),
    });
  } else {
    checks.push({
      label: "OpenAI Agents auth missing",
      status: "warn",
      detail: "set OPENAI_API_KEY or openaiApiKey in talon.json",
      issue: true,
    });
  }
  const envBase = process.env.OPENAI_BASE_URL;
  const cfgBase = config?.openaiBaseUrl;
  if (envBase || cfgBase) {
    checks.push({
      label: "OpenAI-compatible endpoint",
      status: "ok",
      detail: envBase ? `env (${envBase})` : `config (${cfgBase})`,
    });
  } else {
    checks.push({
      label: "Endpoint: api.openai.com (default)",
      status: "info",
    });
  }
  return checks;
}
