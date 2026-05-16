#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const backend = process.argv[2];
const npm = "npm";

const backends = {
  kilo: {
    sdkPackage: "@kilocode/sdk",
    cliPackage: "@kilocode/cli",
    binary: "kilo",
    envExecutable: "KILO_CODE_EXECUTABLE",
    version(sdk) {
      return sdk.version;
    },
  },
  opencode: {
    sdkPackage: "@opencode-ai/sdk",
    cliPackage: "opencode-ai",
    binary: "opencode",
    envExecutable: "OPENCODE_EXECUTABLE",
    version(sdk) {
      return sdk.version;
    },
  },
  claude: {
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    cliPackage: "@anthropic-ai/claude-code",
    binary: "claude",
    envExecutable: "CLAUDE_CODE_EXECUTABLE",
    version(sdk) {
      return sdk.claudeCodeVersion ?? "latest";
    },
    executableCandidates(root, prefix) {
      return [
        join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        join(root, "@anthropic-ai", "claude-code", "bin", "claude"),
        join(
          prefix,
          process.platform === "win32" ? "claude.cmd" : "bin/claude",
        ),
      ];
    },
  },
  // Codex spawns the `codex` CLI per `runStreamed` call rather than
  // running a long-lived server. The SDK pins its CLI to an exact
  // version via its own `@openai/codex` dependency — we install that
  // pinned version so live discovery catches SDK ↔ CLI drift.
  codex: {
    sdkPackage: "@openai/codex-sdk",
    cliPackage: "@openai/codex",
    binary: "codex",
    envExecutable: "CODEX_CODE_EXECUTABLE",
    version(sdk) {
      return sdk.dependencies?.["@openai/codex"] ?? "latest";
    },
    executableCandidates(root, prefix) {
      return [
        join(root, "@openai", "codex", "bin", "codex.exe"),
        join(root, "@openai", "codex", "bin", "codex"),
        join(prefix, process.platform === "win32" ? "codex.cmd" : "bin/codex"),
      ];
    },
  },
};

if (!backend || !Object.hasOwn(backends, backend)) {
  console.error(
    `Usage: node .github/scripts/install-backend-cli.mjs <${Object.keys(backends).join("|")}>`,
  );
  process.exit(2);
}

function readPackageJson(packageName) {
  const path = join(
    process.cwd(),
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

function quoteCmd(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function cmdCallArgs(command, args) {
  return [
    "/d",
    "/c",
    ["call", quoteCmd(command), ...args.map(quoteCmd)].join(" "),
  ];
}

function runCmd(command, args, options = {}) {
  return execFileSync("cmd.exe", cmdCallArgs(command, args), {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function resolveWindowsNpm() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return {
      kind: "node",
      command: process.env.npm_node_execpath || process.execPath,
      argsPrefix: [process.env.npm_execpath],
    };
  }

  const npmCmd = execFileSync("where.exe", ["npm.cmd"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!npmCmd) throw new Error("Could not resolve npm.cmd on PATH");
  return {
    kind: "cmd",
    command: npmCmd,
    argsPrefix: [],
  };
}

function runNpm(args, options = {}) {
  if (process.platform === "win32") {
    const resolved = resolveWindowsNpm();
    if (resolved.kind === "cmd") {
      return runCmd(resolved.command, args, options);
    }
    return execFileSync(
      resolved.command,
      [...resolved.argsPrefix, ...args],
      options,
    );
  }
  return execFileSync(npm, args, options);
}

function npmOutput(args) {
  return runNpm(args, { encoding: "utf8" }).trim();
}

function genericExecutableCandidates(binary, prefix) {
  return process.platform === "win32"
    ? [
        join(prefix, `${binary}.cmd`),
        join(prefix, `${binary}.exe`),
        join(prefix, binary),
      ]
    : [join(prefix, "bin", binary)];
}

function globalBinDir(prefix) {
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function commandFor(binary) {
  if (process.platform !== "win32") return binary;

  try {
    const matches = execFileSync("where.exe", [binary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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

function needsShell(command) {
  return (
    process.platform === "win32" &&
    (command.toLowerCase().endsWith(".cmd") ||
      command.toLowerCase().endsWith(".bat"))
  );
}

function runVersion(command) {
  if (needsShell(command)) {
    runCmd(command, ["--version"], {
      stdio: "inherit",
    });
  } else {
    execFileSync(command, ["--version"], { stdio: "inherit" });
  }
}

const config = backends[backend];
const sdk = readPackageJson(config.sdkPackage);
const version = config.version(sdk);
const spec =
  version === "latest" ? config.cliPackage : `${config.cliPackage}@${version}`;

console.log(`${config.sdkPackage} ${sdk.version}`);
console.log(`Installing ${spec}`);
runNpm(["install", "--global", spec], { stdio: "inherit" });

console.log(`Verifying global npm install for ${config.cliPackage}`);
runNpm(["list", "--global", "--depth=0", config.cliPackage], {
  stdio: "inherit",
});

const root = npmOutput(["root", "--global"]);
const prefix = npmOutput(["prefix", "--global"]);
const binDir = globalBinDir(prefix);
console.log(`Global npm root: ${root}`);
console.log(`Global npm prefix: ${prefix}`);
console.log(`Global npm bin: ${binDir}`);
if (process.env.GITHUB_PATH) {
  appendFileSync(process.env.GITHUB_PATH, `${binDir}\n`);
}

const installedCandidates = [
  ...(config.executableCandidates?.(root, prefix) ?? []),
  ...genericExecutableCandidates(config.binary, prefix),
];
const installedCommand =
  installedCandidates.find(existsSync) ?? commandFor(config.binary);

console.log(`Verifying ${config.binary} --version`);
runVersion(installedCommand);

if (config.envExecutable) {
  const executable = installedCandidates.find(existsSync);
  if (!executable) {
    console.error(
      `Could not resolve ${config.envExecutable} after installing ${spec}`,
    );
    process.exit(1);
  }

  console.log(`${config.envExecutable}=${executable}`);
  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `${config.envExecutable}=${executable}\n`,
    );
  }
}
