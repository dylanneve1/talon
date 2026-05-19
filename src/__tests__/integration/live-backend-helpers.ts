import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

function resolveWindowsCommand(binary: string): string {
  if (process.platform !== "win32") return binary;

  try {
    const matches = execFileSync("where.exe", [binary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      matches.find((match) => match.toLowerCase().endsWith(".exe")) ??
      matches.find((match) => !match.toLowerCase().endsWith(".ps1")) ??
      binary
    );
  } catch {
    return binary;
  }
}

export function cliCommand(binary: string, envVar?: string): string {
  const override = envVar ? process.env[envVar] : undefined;
  if (override) return override;
  return resolveWindowsCommand(binary);
}

function needsShell(command: string): boolean {
  return (
    process.platform === "win32" &&
    (command.toLowerCase().endsWith(".cmd") ||
      command.toLowerCase().endsWith(".bat"))
  );
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function cmdCallArgs(command: string, args: string[]): string[] {
  return [
    "/d",
    "/c",
    ["call", quoteCmd(command), ...args.map(quoteCmd)].join(" "),
  ];
}

function runCmd(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2] = {},
): Buffer | string {
  const cmdOptions = {
    ...options,
    windowsVerbatimArguments: true,
  } as Parameters<typeof execFileSync>[2];
  return execFileSync("cmd.exe", cmdCallArgs(command, args), cmdOptions);
}

export function cliAvailable(binary: string, envVar?: string): boolean {
  const command = cliCommand(binary, envVar);
  try {
    if (needsShell(command)) {
      runCmd(command, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
    } else {
      execFileSync(command, ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function cliVersion(binary: string, envVar?: string): string {
  const command = cliCommand(binary, envVar);
  if (needsShell(command)) {
    return runCmd(command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    })
      .toString()
      .trim();
  }
  return execFileSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
}

export function spawnCli(
  binary: string,
  args: string[],
  envVar?: string,
): ChildProcess {
  const command = cliCommand(binary, envVar);
  if (needsShell(command)) {
    return spawn("cmd.exe", cmdCallArgs(command, args), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: true,
    });
  }

  return spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function waitForHealthy(
  url: string,
  deadlineMs: number,
): Promise<void> {
  const stopAt = Date.now() + deadlineMs;
  let lastError: unknown;

  while (Date.now() < stopAt) {
    try {
      const resp = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return;
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }

  throw new Error(
    `server at ${url} never reported healthy within ${deadlineMs}ms (last: ${lastError})`,
  );
}

export async function stopProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.killed) return;

  if (process.platform === "win32" && proc.pid) {
    try {
      execFileSync("taskkill.exe", ["/pid", String(proc.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 5000,
      });
    } catch {
      proc.kill();
    }
    return;
  }

  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
      resolve();
    }, 2000);
    proc.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
