/**
 * Built-in frontend descriptors.
 *
 * Identity only — no frontend implementation is imported here (core
 * never imports frontend/). The heavy `create` half of each built-in is
 * attached by `src/frontend/<id>/factory.ts` when the composition root
 * imports `src/frontend/factories.ts`.
 *
 * Chat-id shapes are the long-standing conventions from
 * `util/chat-id.ts`. Priorities encode the historical resolution order
 * (terminal, native, teams, discord, telegram) — load-bearing in two
 * places: telegram's numeric matcher is a near-catch-all so it must run
 * last, and the terminal claims the legacy chat id "1" that telegram's
 * matcher would also accept.
 */

import {
  registerFrontendDescriptor as registerFrontend,
  setBuiltinRegistrar,
} from "./registry.js";
import {
  isDiscordChatId,
  isNativeChatId,
  isTeamsChatId,
  isTelegramChatId,
  isTerminalChatId,
} from "../../util/chat-id.js";

function registerBuiltinFrontends(): void {
  registerFrontend({
    id: "terminal",
    label: "Terminal",
    ownsChatId: isTerminalChatId,
    routePriority: 10,
    messaging: false,
    sharesStdin: true,
  });
  registerFrontend({
    id: "native",
    label: "Native",
    ownsChatId: isNativeChatId,
    routePriority: 20,
    messaging: true,
  });
  registerFrontend({
    id: "teams",
    label: "Teams",
    ownsChatId: isTeamsChatId,
    routePriority: 30,
    messaging: true,
  });
  registerFrontend({
    id: "discord",
    label: "Discord",
    ownsChatId: isDiscordChatId,
    routePriority: 40,
    messaging: true,
  });
  registerFrontend({
    id: "telegram",
    label: "Telegram",
    ownsChatId: isTelegramChatId,
    routePriority: 90,
    messaging: true,
  });
}

setBuiltinRegistrar(registerBuiltinFrontends);
registerBuiltinFrontends();
