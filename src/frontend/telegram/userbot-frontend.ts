/**
 * Re-export from userbot/frontend.ts for backwards compatibility.
 * All functionality has been moved to ./userbot/frontend.ts
 */
export {
  createUserbotFrontend,
  recordOurMessage,
  isOurMessage,
  clearRateLimits,
  clearOurMessageTracking,
  isUserTyping,
  isRateLimited,
  shouldHandleInGroup,
  getSenderName,
  getSenderUsername,
  getSenderId,
  getCachedOnlineStatus,
} from "./userbot/frontend.js";
