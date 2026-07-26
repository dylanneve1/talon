/**
 * Outbound secret scanning for group-bound messages.
 *
 * Why this exists: the model has leaked live credentials into a GROUP chat
 * more than once (an API key, a Raspberry Pi password — twice in one day,
 * the second time inside the apology for the first). Markdown reminders in
 * memory.md have failed as a control roughly five times. A rule the model
 * must remember is not a control; a gate it cannot talk its way past is.
 *
 * Design (mirrors GitHub push protection):
 *  - Scan happens on the OUTBOUND path, before the bytes leave the process.
 *  - A hit ERRORS the tool call instead of silently redacting, so the model
 *    is forced to notice, rewrite, and resend. Silent redaction would teach
 *    it nothing and would mangle legitimate text.
 *  - The error names the RULE that matched, never the matched value — an
 *    error string is itself logged and sometimes echoed to chat, so putting
 *    the secret in it would re-create the leak we are preventing.
 *  - GROUPS ONLY. DMs are unaffected: Dylan reads his own credentials in
 *    his own DM all the time, and a guard that fires there would be turned
 *    off within a day.
 *
 * Two detection layers:
 *  1. Known values — the literal secrets on this box (workspace secrets/,
 *     ssh plugin credentials, config.json tokens). Highest confidence;
 *     these always block. This is the layer that would have caught every
 *     real incident.
 *  2. Generic patterns — private-key blocks and well-known token shapes.
 *     Deliberately conservative: only prefixes with a vendor-defined,
 *     unambiguous shape. No "high entropy string" heuristic, because in a
 *     chat that talks about hashes, commit SHAs and base64 all day, entropy
 *     alone is a false-positive machine and false positives are what get
 *     a guard disabled.
 */

/** A single match. `rule` is safe to show; the value never leaves here. */
export type SecretFinding = {
  /** Stable identifier for the rule that matched, e.g. "known-secret-value". */
  rule: string;
  /** Human-readable explanation, guaranteed to contain no secret material. */
  hint: string;
};

export type SecretScanOptions = {
  /** Literal secret values known to this deployment (layer 1). */
  knownSecrets?: readonly string[];
  /** Values that must never be treated as secrets (false-positive escape). */
  allowlist?: readonly string[];
};

/**
 * Shortest known-secret we will match on.
 *
 * A short "secret" (a 4-digit PIN, the string "admin") appears in ordinary
 * prose constantly; matching it would block normal conversation without
 * preventing a meaningful leak. Real credentials clear this comfortably.
 */
const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * Generic patterns. Each is a vendor-published, unambiguous credential
 * shape — not a guess. Keep this list conservative; every entry is a
 * potential false positive on someone's normal sentence.
 */
const PATTERN_RULES: ReadonlyArray<{
  rule: string;
  hint: string;
  re: RegExp;
}> = [
  {
    rule: "private-key-block",
    hint: "a PEM/OpenSSH private key block",
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  },
  {
    rule: "anthropic-api-key",
    hint: "an Anthropic API key (sk-ant-…)",
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}/,
  },
  {
    rule: "openai-api-key",
    hint: "an OpenAI API key (sk-…)",
    re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/,
  },
  {
    rule: "github-token",
    hint: "a GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_…)",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  {
    rule: "slack-token",
    hint: "a Slack token (xox…)",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    rule: "aws-access-key-id",
    hint: "an AWS access key ID (AKIA/ASIA…)",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    rule: "google-api-key",
    hint: "a Google API key (AIza…)",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    rule: "telegram-bot-token",
    hint: "a Telegram bot token (<digits>:AA…)",
    re: /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/,
  },
];

/**
 * Gateway actions that carry model-authored text to a chat.
 *
 * Listed explicitly rather than derived, so that a newly added action is
 * NOT silently covered — an unlisted action is a visible gap someone can
 * find, whereas a wrong auto-derivation is invisible. Media sends are
 * included because their captions are model-authored too.
 */
export const TEXT_BEARING_ACTIONS: ReadonlySet<string> = new Set([
  "send_message",
  "send_message_with_buttons",
  "schedule_message",
  "edit_message",
  "send_photo",
  "send_file",
  "send_video",
  "send_voice",
  "send_audio",
  "send_animation",
  "send_poll",
]);

/**
 * Is this chat a group?
 *
 * Telegram encodes it in the id: supergroups/channels are negative, user
 * DMs positive. That is an exact test, and Telegram is where every real
 * incident happened.
 *
 * Everything else returns false (scan skipped). That is a deliberate,
 * documented gap rather than a guess: on Discord a DM channel id and a
 * guild channel id are both positive snowflakes, so "is this a group"
 * cannot be answered from the id alone. Guessing wrong in the enforcing
 * direction would fire the guard on private chats, and a security control
 * that cries wolf gets switched off. When the frontends thread a real chat
 * kind through to the bridge, widen this — the rest of the machinery is
 * already frontend-agnostic.
 */
export function isGroupChat(chatId: string): boolean {
  const trimmed = chatId.trim();
  if (!/^-\d+$/.test(trimmed)) return false;
  return Number(trimmed) < 0;
}

/** Collect every string in an arbitrary params object, depth-first. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
  return out;
}

/** Scan one string. Returns every distinct rule that matched. */
export function scanText(
  text: string,
  options: SecretScanOptions = {},
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: SecretFinding) => {
    if (seen.has(finding.rule)) return;
    seen.add(finding.rule);
    findings.push(finding);
  };

  const allowlist = options.allowlist ?? [];
  for (const secret of options.knownSecrets ?? []) {
    if (typeof secret !== "string") continue;
    const value = secret.trim();
    if (value.length < MIN_KNOWN_SECRET_LENGTH) continue;
    if (allowlist.includes(value)) continue;
    if (text.includes(value)) {
      add({
        rule: "known-secret-value",
        hint: "a credential configured on this host (exact match)",
      });
    }
  }

  for (const { rule, hint, re } of PATTERN_RULES) {
    const match = re.exec(text);
    if (!match) continue;
    if (allowlist.includes(match[0])) continue;
    add({ rule, hint });
  }

  return findings;
}

/**
 * The gate itself: given an outbound bridge action and its params, return
 * the findings that should block it. Empty array = let it through.
 *
 * Pure and synchronous by design — the caller supplies the known-secret
 * list — so it is trivially testable and cannot itself perform I/O on the
 * send path.
 */
export function scanOutboundAction(
  action: string,
  params: unknown,
  chatId: string,
  options: SecretScanOptions = {},
): SecretFinding[] {
  if (!TEXT_BEARING_ACTIONS.has(action)) return [];
  if (!isGroupChat(chatId)) return [];

  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const text of collectStrings(params)) {
    for (const finding of scanText(text, options)) {
      if (seen.has(finding.rule)) continue;
      seen.add(finding.rule);
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * Build the error message shown to the model.
 *
 * Names the rules and tells it exactly what to do next. Contains no
 * matched values — see the module header for why that matters.
 */
export function secretScanErrorMessage(
  action: string,
  findings: readonly SecretFinding[],
): string {
  const rules = findings.map((f) => `${f.rule} (${f.hint})`).join("; ");
  return (
    `"${action}" was blocked by outbound secret scanning: ${rules}. ` +
    `This message is bound for a GROUP chat and appears to contain a live ` +
    `credential. Nothing was sent. Remove or redact the secret and call the ` +
    `tool again — do not paste the value, describe it instead (e.g. "the Pi ` +
    `password", not the password). If this is a false positive, say so in ` +
    `chat rather than trying to route around the check.`
  );
}
