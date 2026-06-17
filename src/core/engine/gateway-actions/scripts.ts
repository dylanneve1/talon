/**
 * Scripts — reusable agent-authored scripts (global, not chat-scoped).
 * save / list / run / delete.
 */

import {
  deleteScript,
  formatScript,
  getAllScripts,
  getScript,
  recordScriptUse,
  saveScript,
  validateScriptDescription,
  validateScriptLanguage,
  validateScriptName,
  validateScriptBody,
} from "../../../storage/script-store.js";
import {
  runScript,
  validateScriptTimeout,
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
} from "../../scripts/runner.js";
import { log } from "../../../util/log.js";
import type { SharedActionHandlers } from "./types.js";

export const scriptHandlers: SharedActionHandlers = {
  save_script: (body) => {
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    const language = body.language;
    const script = String(body.script ?? "");

    const nameErr = validateScriptName(name);
    if (nameErr) return { ok: false, error: nameErr };
    const descErr = validateScriptDescription(description);
    if (descErr) return { ok: false, error: descErr };
    if (!validateScriptLanguage(language))
      return {
        ok: false,
        error: "Unsupported language. Choose one of: bash, python, node",
      };
    const scriptErr = validateScriptBody(script);
    if (scriptErr) return { ok: false, error: scriptErr };

    const existed = Boolean(getScript(name));
    let saved;
    try {
      saved = saveScript({ name, description, language, script });
    } catch (err) {
      return {
        ok: false,
        error: `Failed to save script: ${err instanceof Error ? err.message : err}`,
      };
    }
    log("gateway", `save_script: "${name}" (${language})`);
    return {
      ok: true,
      text:
        `${existed ? "Updated" : "Saved"} script "${name}" (${language})\n` +
        `Script: ${saved.scriptPath}\n` +
        `Run it with run_script(name="${name}").`,
    };
  },

  list_scripts: () => {
    const scripts = getAllScripts();
    if (scripts.length === 0)
      return {
        ok: true,
        text: "No scripts saved yet. Use save_script to store a reusable procedure.",
      };
    return {
      ok: true,
      text: `Scripts (${scripts.length}):\n${scripts.map(formatScript).join("\n")}`,
    };
  },

  run_script: async (body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return { ok: false, error: "Missing name" };
    const script = getScript(name);
    if (!script)
      return {
        ok: false,
        error: `No script named "${name}". See list_scripts.`,
      };

    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    const timeoutSeconds =
      body.timeout_seconds != null
        ? Number(body.timeout_seconds)
        : DEFAULT_SCRIPT_TIMEOUT_SECONDS;
    const timeoutErr = validateScriptTimeout(timeoutSeconds);
    if (timeoutErr) return { ok: false, error: timeoutErr };

    const result = await runScript(script, args, timeoutSeconds);
    // Usage stats only count completed (non-timeout, spawned) runs.
    if (!result.timedOut && result.exitCode !== null) {
      recordScriptUse(name);
    }

    const status = result.timedOut
      ? `TIMED OUT after ${timeoutSeconds}s`
      : `exit ${result.exitCode ?? "n/a"}`;
    const parts = [
      `Script "${name}" finished (${status}, ${result.durationMs}ms)`,
    ];
    if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
    if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
    if (!result.stdout.trim() && !result.stderr.trim())
      parts.push("(no output)");
    return {
      ok: !result.timedOut && result.exitCode === 0,
      ...(result.timedOut || result.exitCode !== 0
        ? { error: parts.join("\n\n") }
        : { text: parts.join("\n\n") }),
    };
  },

  delete_script: (body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return { ok: false, error: "Missing name" };
    if (!deleteScript(name))
      return { ok: false, error: `No script named "${name}"` };
    return { ok: true, text: `Deleted script "${name}".` };
  },
};
