/**
 * Plugin lifecycle error taxonomy.
 *
 * Every failure mode during plugin self-heal collapses to one of these shapes.
 * The runner uses `kind` to decide log level and whether the issue is
 * actionable by the user. `hint` is the user-facing one-liner — keep it
 * imperative: "run X", "check Y", "free Z MB of disk".
 *
 * Classification is heuristic — we pattern-match subprocess stderr to guess
 * the category. When in doubt, we fall back to `unknown` so we never mislabel.
 */

export type PluginErrorKind =
  | "executable-not-found"
  | "permission"
  | "network"
  | "disk-space"
  | "upstream-unavailable"
  | "version-mismatch"
  | "timeout"
  | "unknown";

export type PluginError = Readonly<{
  kind: PluginErrorKind;
  /** Short summary, safe to put in a log line or Telegram reply. */
  message: string;
  /** Actionable next step for the user (imperative voice, one line). */
  hint: string;
  /** Optional extra context (stderr tail, required bytes, etc). */
  details?: string;
}>;

/** Build an error from a plain string — fallback when no signal is available. */
export function unknownError(message: string, hint: string): PluginError {
  return { kind: "unknown", message, hint };
}

/** Classify a subprocess failure based on exit code + stdout/stderr content. */
export function classifySubprocessError(input: {
  program: string;
  args: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}): PluginError {
  const { program, exitCode, signal, stderr, stdout, spawnError } = input;
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  const tail = (stderr || stdout).trim().split("\n").slice(-3).join("\n");

  // spawn errors have structured codes
  const spawnCode = spawnError?.code;
  if (spawnCode === "ENOENT") {
    return {
      kind: "executable-not-found",
      message: `${program} not found on PATH`,
      hint: `install ${program} and make sure it's on PATH`,
      details: spawnError?.message,
    };
  }
  if (spawnCode === "EACCES" || spawnCode === "EPERM") {
    return {
      kind: "permission",
      message: `cannot execute ${program} (${spawnCode})`,
      hint: `check file permissions on ${program}`,
      details: spawnError?.message,
    };
  }

  if (signal) {
    return {
      kind: "timeout",
      message: `${program} killed by ${signal}`,
      hint: `retry with a larger timeout or check for a stuck ${program} process`,
      details: tail,
    };
  }

  // Pattern match known failure modes — ordered by specificity.
  if (
    combined.includes("no space left on device") ||
    combined.includes("enospc") ||
    combined.includes("disk quota exceeded")
  ) {
    return {
      kind: "disk-space",
      message: "disk full",
      hint: "free disk space and retry",
      details: tail,
    };
  }
  if (
    combined.includes("could not resolve host") ||
    combined.includes("name resolution") ||
    combined.includes("temporary failure in name resolution") ||
    combined.includes("network is unreachable") ||
    combined.includes("connection refused") ||
    combined.includes("connection reset") ||
    combined.includes("connection timed out") ||
    combined.includes("getaddrinfo eai_again") ||
    combined.includes("timeout while waiting for") ||
    combined.includes("failed to resolve") ||
    combined.includes("proxy error")
  ) {
    return {
      kind: "network",
      message: "network unreachable",
      hint: "check internet connectivity and retry",
      details: tail,
    };
  }
  if (
    combined.includes("no matching distribution") ||
    combined.includes("could not find a version") ||
    combined.includes("error: no matching manifest") ||
    combined.includes("manifest unknown") ||
    combined.includes("not found: manifest") ||
    combined.includes("404 not found")
  ) {
    return {
      kind: "upstream-unavailable",
      message: "upstream package/image not published",
      hint: "verify the pinned version exists on the upstream registry",
      details: tail,
    };
  }
  if (
    combined.includes("permission denied") ||
    combined.includes("eacces") ||
    combined.includes("eperm") ||
    combined.includes("operation not permitted")
  ) {
    return {
      kind: "permission",
      message: "permission denied",
      hint: "check file/directory permissions for the install path",
      details: tail,
    };
  }

  // Fall-through — preserve whatever the subprocess said.
  const exitLabel = exitCode !== null ? `exit ${exitCode}` : "no exit code";
  return {
    kind: "unknown",
    message: `${program} failed (${exitLabel})`,
    hint: "check the detailed error log; retry once, then investigate manually",
    details: tail,
  };
}

/** Render a PluginError for a single log line (structured + compact). */
export function formatError(err: PluginError): string {
  const head = `[${err.kind}] ${err.message} — ${err.hint}`;
  return err.details
    ? `${head}\n    ${err.details.split("\n").join("\n    ")}`
    : head;
}
