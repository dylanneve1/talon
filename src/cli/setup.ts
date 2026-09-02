/**
 * Guided setup wizard — collects frontend/backend config interactively and
 * writes talon.json.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { printBanner, loadConfig, saveConfig, type Config } from "./config.js";

/** "353871234567, +44 7700 900000" → ["353871234567", "447700900000"]. */
function parseNumberList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.replace(/[\s+()-]/g, ""))
    .filter((entry) => entry.length > 0);
}

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
        value: "whatsapp",
        label: `WhatsApp  ${pc.dim("— a real account via Baileys multi-device")}`,
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
      {
        value: "native",
        label: `Native    ${pc.dim("— HTTP+SSE bridge for the companion app")}`,
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

  let whatsapp: Config["whatsapp"] | undefined;

  if (selectedFrontends.includes("whatsapp")) {
    p.note(
      "Talon drives a real WhatsApp account over Baileys multi-device —\n" +
        "the same mechanism as WhatsApp Web. On first start you'll pair it\n" +
        "under WhatsApp → Linked devices.",
      "WhatsApp Setup",
    );

    const pairing = (await p.text({
      message: "The bot account's own number (E.164 digits, no +)",
      placeholder: "leave blank to pair by QR code instead",
      initialValue: config.whatsapp?.pairingNumber || "",
      validate: (v) => {
        if (v && !/^\d{7,15}$/.test(v.replace(/[\s+()-]/g, "")))
          return "Digits only, country code included — e.g. 353871234567";
      },
    })) as string;
    if (p.isCancel(pairing)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const allowed = (await p.text({
      message: "Numbers allowed to DM the bot (comma-separated)",
      placeholder: "353871234567, 447700900000 — blank disables DMs",
      initialValue: (config.whatsapp?.allowedJids ?? []).join(", "),
    })) as string;
    if (p.isCancel(allowed)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const groupPolicy = await p.select({
      message: "Which groups should the bot serve?",
      initialValue: config.whatsapp?.groupPolicy ?? "listed",
      options: [
        {
          value: "listed",
          label: `Listed only     ${pc.dim("— groups you name in allowedGroups")}`,
        },
        {
          value: "with-allowed-user",
          label: `Groups I'm in   ${pc.dim("— any group containing an allowed number")}`,
        },
        {
          value: "all",
          label: `All             ${pc.dim("— every group the account belongs to")}`,
        },
      ],
    });
    if (p.isCancel(groupPolicy)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    whatsapp = {
      // Preserve allowedGroups / respondMode / sendReadReceipts — the
      // wizard doesn't prompt for them but must not drop them.
      ...config.whatsapp,
      allowedJids: parseNumberList(allowed),
      groupPolicy: groupPolicy as "listed" | "with-allowed-user" | "all",
      ...(pairing.replace(/[\s+()-]/g, "")
        ? { pairingNumber: pairing.replace(/[\s+()-]/g, "") }
        : {}),
    };
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

  const newConfig = buildSetupConfig(config, {
    selectedFrontends,
    backend,
    botToken,
    claudeBinary,
    codexApiKey,
    openaiApiKey,
    openaiBaseUrl,
    openaiApiMode,
    model: model as string,
    pulse: pulse as boolean,
    adminId,
    apiId,
    apiHash,
    teamsWebhookUrl,
    teamsWebhookSecret,
    teamsWebhookPort,
    teamsBotDisplayName,
    discordBotToken,
    discordApplicationId,
    whatsapp,
  });

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

/** Everything the wizard's prompts collected, in one bag. */
export type SetupAnswers = {
  selectedFrontends: string[];
  backend: Config["backend"];
  botToken?: string;
  claudeBinary?: string;
  codexApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiApiMode?: Config["openaiApiMode"];
  model: string;
  pulse: boolean;
  adminId?: string;
  apiId?: number;
  apiHash?: string;
  teamsWebhookUrl?: string;
  teamsWebhookSecret?: string;
  teamsWebhookPort?: number;
  teamsBotDisplayName?: string;
  discordBotToken?: string;
  discordApplicationId?: string;
  whatsapp?: Config["whatsapp"];
};

/**
 * Fold the wizard's answers onto the existing config.
 *
 * Extracted from `runSetup` so the merge is testable without driving the
 * prompts — the behaviour that matters here is what it *doesn't* touch.
 * The wizard models roughly half of ~/.talon/config.json; it used to
 * rebuild the file from its own named fields alone, which silently
 * deleted every other key (whatsapp, native, soul, memory, github,
 * heartbeat/dream, allowlists, plugin blocks…). Spreading `existing`
 * first keeps them. Fields below still override, and an explicit
 * `undefined` still deletes, because `saveConfig` strips undefined.
 */
export function buildSetupConfig(
  existing: Config,
  answers: SetupAnswers,
): Config {
  const on = (id: string) => answers.selectedFrontends.includes(id);
  /** Did the chosen backend's credential prompt actually run? */
  const ownsCredential = (backend: Config["backend"]) =>
    answers.backend === backend;
  return {
    ...existing,
    frontend:
      answers.selectedFrontends.length === 1
        ? answers.selectedFrontends[0]
        : answers.selectedFrontends,
    backend: answers.backend,
    botToken: on("telegram") ? answers.botToken : undefined,
    // Backend credentials: the wizard prompts for exactly one backend's
    // (an if/else-if chain on the chosen backend), so taking the answer
    // unconditionally deleted every other backend's — picking `claude`
    // wiped a stored openaiApiKey/openaiBaseUrl even though the account
    // stays reachable via enabledBackends and per-chat overrides. Each
    // credential is now overwritten only by the prompt that owns it, and
    // left alone otherwise. Blanking a shown prompt still clears it.
    claudeBinary: ownsCredential("claude")
      ? answers.claudeBinary
      : existing.claudeBinary,
    codexApiKey: ownsCredential("codex")
      ? answers.codexApiKey
      : existing.codexApiKey,
    openaiApiKey: ownsCredential("openai-agents")
      ? answers.openaiApiKey
      : existing.openaiApiKey,
    openaiBaseUrl: ownsCredential("openai-agents")
      ? answers.openaiBaseUrl
      : existing.openaiBaseUrl,
    openaiApiMode: ownsCredential("openai-agents")
      ? answers.openaiApiMode
      : existing.openaiApiMode,
    model: answers.model,
    concurrency: existing.concurrency,
    pulse: answers.pulse,
    pulseIntervalMs: existing.pulseIntervalMs,
    adminUserId: answers.adminId
      ? parseInt(answers.adminId, 10) || undefined
      : undefined,
    apiId: answers.apiId,
    apiHash: answers.apiHash,
    maxMessageLength: existing.maxMessageLength,
    plugins: existing.plugins,
    // Teams
    teamsWebhookUrl: on("teams") ? answers.teamsWebhookUrl : undefined,
    teamsWebhookSecret: on("teams") ? answers.teamsWebhookSecret : undefined,
    teamsWebhookPort: on("teams") ? answers.teamsWebhookPort : undefined,
    teamsBotDisplayName: on("teams") ? answers.teamsBotDisplayName : undefined,
    // Discord — bot token + applicationId. Allowlists / admin IDs /
    // mention vs channel-wide reply behaviour are left as defaults in
    // the wizard; advanced users hand-edit talon.json.
    discord:
      on("discord") && answers.discordBotToken && answers.discordApplicationId
        ? {
            ...existing.discord,
            botToken: answers.discordBotToken,
            applicationId: answers.discordApplicationId,
          }
        : existing.discord,
    // Never dropped. Deselecting WhatsApp shouldn't throw away its
    // pairing setup, and dropping it while `frontend` still lists
    // whatsapp produces a config util/config.ts refuses to load at all
    // ("WhatsApp frontend requires a whatsapp config block") — a daemon
    // that won't start. The `??` keeps that impossible even if the
    // branch that collects the answer is ever skipped.
    whatsapp: answers.whatsapp ?? existing.whatsapp,
  };
}
