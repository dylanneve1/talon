/**
 * User-facing command menu — the single source for Telegram's command menu
 * (setMyCommands in index.ts) and the unknown-command suggester. Admin-only
 * commands (/admin) stay off the menu and out of suggestions deliberately.
 */

export const TELEGRAM_COMMANDS: ReadonlyArray<{
  command: string;
  description: string;
}> = [
  { command: "start", description: "Introduction" },
  {
    command: "settings",
    description: "View and change all chat settings",
  },
  { command: "status", description: "Session info, usage, and stats" },
  { command: "ping", description: "Health check with latency" },
  { command: "model", description: "Show or change model" },
  { command: "effort", description: "Set thinking effort level" },
  { command: "pulse", description: "Conversation engagement settings" },
  { command: "reset", description: "Clear session and start fresh" },
  { command: "restart", description: "Restart the bot (admin)" },
  { command: "metrics", description: "Aggregate performance metrics" },
  {
    command: "doctor",
    description: "Environment and native-module health",
  },
  { command: "dream", description: "Force memory consolidation" },
  { command: "plugins", description: "List loaded plugins" },
  { command: "help", description: "All commands and features" },
];
