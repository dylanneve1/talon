/**
 * Guided setup wizard — collects frontend/backend config interactively and
 * writes talon.json.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { printBanner, loadConfig, saveConfig, type Config } from "./config.js";

export async function runSetup(): Promise<void> {
  printBanner();
  p.intro(pc.inverse(" Setup Wizard "));

  const config = loadConfig();
  const existingFrontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend || "telegram"];

  const frontendSelection = await p.multiselect({
    message: "Frontend platforms (space to toggle, enter to confirm)",
    initialValues: existingFrontends,
    options: [
      {
        value: "telegram",
        label: `Telegram  ${pc.dim("— bot via @BotFather")}`,
      },
      {
        value: "discord",
        label: `Discord   ${pc.dim("— bot via Developer Portal (discord.js v14)")}`,
      },
      {
        value: "teams",
        label: `Teams     ${pc.dim("— Microsoft Teams via Power Automate")}`,
      },
      {
        value: "terminal",
        label: `Terminal  ${pc.dim("— local CLI chat")}`,
      },
    ],
    required: true,
  });
  if (p.isCancel(frontendSelection)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  const selectedFrontends = frontendSelection as string[];

  let botToken: string | undefined;
  let adminId: string | undefined;
  let apiId: number | undefined;
  let apiHash: string | undefined;

  if (selectedFrontends.includes("telegram")) {
    const token = await p.text({
      message: "Bot token",
      placeholder: "Paste your token from @BotFather",
      initialValue: config.botToken || undefined,
      validate: (v) => {
        if (!v) return "Token is required";
        if (!v.includes(":")) return "Invalid format";
      },
    });
    if (p.isCancel(token)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    botToken = token;

    adminId = (await p.text({
      message: "Your Telegram user ID",
      placeholder: "optional — message @userinfobot to find yours",
      initialValue: config.adminUserId ? String(config.adminUserId) : "",
    })) as string;
    if (p.isCancel(adminId)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const wantUserbot = await p.confirm({
      message: "Set up userbot for full history access?",
      initialValue: !!(config.apiId && config.apiHash),
    });
    if (p.isCancel(wantUserbot)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (wantUserbot) {
      p.note(
        "Get these from https://my.telegram.org → API development tools",
        "Telegram API credentials",
      );
      const id = await p.text({
        message: "API ID",
        placeholder: "12345678",
        initialValue: config.apiId ? String(config.apiId) : "",
        validate: (v) => {
          if (v && isNaN(parseInt(v, 10))) return "Must be a number";
        },
      });
      if (p.isCancel(id)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      const hash = await p.text({
        message: "API Hash",
        initialValue: config.apiHash || "",
      });
      if (p.isCancel(hash)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (id) apiId = parseInt(id, 10);
      if (hash) apiHash = hash as string;
    }
  }

  let teamsWebhookUrl: string | undefined;
  let teamsWebhookSecret: string | undefined;
  let teamsWebhookPort: number | undefined;
  let teamsBotDisplayName: string | undefined;

  if (selectedFrontends.includes("teams")) {
    p.note(
      "Set up two Power Automate workflows in Teams:\n" +
        "1. Send: 'Post to a channel when a webhook request is received' — copy the URL below\n" +
        "2. Receive: 'When a new channel message is added' → HTTP POST to your Talon endpoint",
      "Teams Setup",
    );

    const url = await p.text({
      message: "Power Automate webhook URL (for sending to Teams)",
      placeholder: "https://prod-XX.westus.logic.azure.com/workflows/...",
      initialValue: config.teamsWebhookUrl || undefined,
      validate: (v) => {
        if (!v) return "Webhook URL is required";
        try {
          new URL(v);
        } catch {
          return "Must be a valid URL";
        }
      },
    });
    if (p.isCancel(url)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    teamsWebhookUrl = url;

    const secret = (await p.text({
      message: "Webhook secret for inbound verification",
      placeholder: "optional — shared secret to verify incoming webhooks",
      initialValue: config.teamsWebhookSecret || "",
    })) as string;
    if (p.isCancel(secret)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (secret) teamsWebhookSecret = secret;

    const port = await p.text({
      message: "Webhook receiver port",
      placeholder: "19878",
      initialValue: config.teamsWebhookPort
        ? String(config.teamsWebhookPort)
        : "19878",
      validate: (v) => {
        if (!v) return "Port is required";
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1024 || n > 65535) return "Port must be 1024-65535";
      },
    });
    if (p.isCancel(port)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    teamsWebhookPort = parseInt(port as string, 10);

    const botName = (await p.text({
      message: "Bot display name in Teams (for echo loop prevention)",
      placeholder: "optional — e.g. 'Talon Bot'",
      initialValue: config.teamsBotDisplayName || "",
    })) as string;
    if (p.isCancel(botName)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (botName) teamsBotDisplayName = botName;
  }

  let discordBotToken: string | undefined;
  let discordApplicationId: string | undefined;

  if (selectedFrontends.includes("discord")) {
    p.note(
      "Get bot token + application ID from\n" +
        "https://discord.com/developers/applications → your app → Bot",
      "Discord Setup",
    );

    const token = await p.text({
      message: "Discord bot token",
      placeholder: "MTxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      initialValue: config.discord?.botToken || undefined,
      validate: (v) => {
        if (!v) return "Bot token is required";
      },
    });
    if (p.isCancel(token)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    discordBotToken = token as string;

    const appId = await p.text({
      message: "Discord application ID",
      placeholder: "1234567890123456789",
      initialValue: config.discord?.applicationId || undefined,
      validate: (v) => {
        if (!v) return "Application ID is required";
      },
    });
    if (p.isCancel(appId)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    discordApplicationId = appId as string;
  }

  // Discover models from SDK; fall back to static list if SDK isn't available
  const {
    registerClaudeModels,
    registerClaudeModelsStatic,
    CLAUDE_MODELS_STATIC,
  } = await import("../backend/claude-sdk/models/index.js");
  try {
    const { dirs } = await import("../util/paths.js");
    await registerClaudeModels({
      model: config.model,
      cwd: dirs.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(config.claudeBinary
        ? { pathToClaudeCodeExecutable: config.claudeBinary }
        : {}),
    });
  } catch {
    // Setup wizard may run before Claude Code is installed — use static list
    registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
  }
  const { getModels } = await import("../core/models/catalog.js");
  const registeredModels = getModels();

  const model = await p.select({
    message: "Default model",
    initialValue: config.model,
    options: registeredModels.map((m) => ({
      value: m.id,
      label: `${m.displayName.padEnd(12)}${m.description ? pc.dim(`— ${m.description}`) : ""}`,
    })),
  });
  if (p.isCancel(model)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const pulse = !selectedFrontends.every((f) => f === "terminal")
    ? await p.confirm({
        message: "Enable pulse? (periodic group engagement)",
        initialValue: config.pulse,
      })
    : false;
  if (p.isCancel(pulse)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // ── Backend selection ──
  const backendSelection = await p.select({
    message: "AI backend",
    initialValue: config.backend ?? "claude",
    options: [
      {
        value: "claude",
        label: `Claude    ${pc.dim("— Anthropic Claude Agent SDK")}`,
      },
      {
        value: "kilo",
        label: `Kilo      ${pc.dim("— @kilocode/sdk (multi-provider routing)")}`,
      },
      {
        value: "opencode",
        label: `OpenCode  ${pc.dim("— @opencode-ai/sdk")}`,
      },
      {
        value: "codex",
        label: `Codex     ${pc.dim("— OpenAI Codex CLI (@openai/codex)")}`,
      },
      {
        value: "openai-agents",
        label: `OpenAI Agents ${pc.dim("— @openai/agents (OpenAI or any OpenAI-compatible endpoint)")}`,
      },
    ],
  });
  if (p.isCancel(backendSelection)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  const backend = backendSelection as Config["backend"];

  // ── Backend-specific config ──
  let claudeBinary: string | undefined;
  let codexApiKey: string | undefined;
  let openaiApiKey: string | undefined;
  let openaiBaseUrl: string | undefined;
  let openaiApiMode: "responses" | "chat_completions" | undefined;

  if (backend === "claude") {
    const claudeBinaryInput = await p.text({
      message: "Claude Code binary path",
      placeholder: "leave empty for default (claude)",
      initialValue: config.claudeBinary || "",
    });
    if (p.isCancel(claudeBinaryInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    claudeBinary = (claudeBinaryInput as string).trim() || undefined;
  } else if (backend === "codex") {
    const keyInput = await p.text({
      message: "Codex OpenAI API key",
      placeholder:
        "leave empty to use CODEX_API_KEY / TALON_CODEX_KEY env or `codex login` auth",
      initialValue: config.codexApiKey || "",
    });
    if (p.isCancel(keyInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    codexApiKey = (keyInput as string).trim() || undefined;
  } else if (backend === "openai-agents") {
    const keyInput = await p.text({
      message:
        "API key (OpenAI, OpenRouter, Azure, or whatever your endpoint requires)",
      placeholder: "leave empty to use OPENAI_API_KEY env",
      initialValue: config.openaiApiKey || "",
    });
    if (p.isCancel(keyInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    openaiApiKey = (keyInput as string).trim() || undefined;

    const baseUrlInput = await p.text({
      message:
        "Base URL " +
        pc.dim(
          "(leave empty for OpenAI direct; e.g. https://openrouter.ai/api/v1)",
        ),
      placeholder: "https://openrouter.ai/api/v1",
      initialValue: config.openaiBaseUrl || "",
    });
    if (p.isCancel(baseUrlInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    openaiBaseUrl = (baseUrlInput as string).trim() || undefined;

    if (openaiBaseUrl) {
      const modeSelection = await p.select({
        message: "OpenAI API surface",
        options: [
          {
            value: "chat_completions",
            label: `Chat Completions ${pc.dim("— most third parties (OpenRouter, Ollama, LiteLLM, most Azure)")}`,
          },
          {
            value: "responses",
            label: `Responses ${pc.dim("— OpenAI native, requires proxy support")}`,
          },
        ],
        initialValue: config.openaiApiMode ?? "chat_completions",
      });
      if (p.isCancel(modeSelection)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      openaiApiMode = modeSelection as "responses" | "chat_completions";
    }
  }

  // kilo / opencode need no extra prompts — bundled SDK + per-provider
  // creds configured separately (kilo via `kilo login`, opencode via
  // its own auth flow).

  const newConfig: Config = {
    frontend:
      selectedFrontends.length === 1 ? selectedFrontends[0] : selectedFrontends,
    backend,
    botToken: selectedFrontends.includes("telegram") ? botToken : undefined,
    claudeBinary,
    codexApiKey,
    openaiApiKey,
    openaiBaseUrl,
    openaiApiMode,
    model: model as string,
    concurrency: config.concurrency,
    pulse: pulse as boolean,
    pulseIntervalMs: config.pulseIntervalMs,
    adminUserId: adminId ? parseInt(adminId, 10) || undefined : undefined,
    apiId,
    apiHash,
    maxMessageLength: config.maxMessageLength,
    plugins: config.plugins,
    // Teams
    teamsWebhookUrl: selectedFrontends.includes("teams")
      ? teamsWebhookUrl
      : undefined,
    teamsWebhookSecret: selectedFrontends.includes("teams")
      ? teamsWebhookSecret
      : undefined,
    teamsWebhookPort: selectedFrontends.includes("teams")
      ? teamsWebhookPort
      : undefined,
    teamsBotDisplayName: selectedFrontends.includes("teams")
      ? teamsBotDisplayName
      : undefined,
    // Discord — bot token + applicationId. Allowlists / admin IDs /
    // mention vs channel-wide reply behaviour are left as defaults in
    // the wizard; advanced users hand-edit talon.json.
    discord:
      selectedFrontends.includes("discord") &&
      discordBotToken &&
      discordApplicationId
        ? {
            ...config.discord,
            botToken: discordBotToken,
            applicationId: discordApplicationId,
          }
        : config.discord,
  };

  const s = p.spinner();
  s.start("Saving configuration");
  saveConfig(newConfig);
  s.stop("Configuration saved");

  p.outro(`Run ${pc.cyan(pc.bold("talon start"))} to launch Talon`);

  if (selectedFrontends.includes("telegram") && apiId && apiHash) {
    console.log(
      `  ${pc.yellow("!")} Run ${pc.cyan("npx tsx src/login.ts")} to authenticate the userbot first.\n`,
    );
  }
}
