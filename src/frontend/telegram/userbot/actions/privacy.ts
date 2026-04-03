/**
 * Privacy actions: get/set privacy, drafts, check privacy, sessions, 2FA status.
 */

import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerPrivacyActions(registry: ActionRegistry) {
  registry.set("get_privacy", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const keyName = String(body.key ?? "status_timestamp");
    const keyMap: Record<string, unknown> = {
      status_timestamp: new Api.InputPrivacyKeyStatusTimestamp(),
      chat_invite: new Api.InputPrivacyKeyChatInvite(),
      phone_number: new Api.InputPrivacyKeyPhoneNumber(),
      phone_call: new Api.InputPrivacyKeyPhoneCall(),
      phone_p2p: new Api.InputPrivacyKeyPhoneP2P(),
      forwards: new Api.InputPrivacyKeyForwards(),
      profile_photo: new Api.InputPrivacyKeyProfilePhoto(),
      about: new Api.InputPrivacyKeyAbout(),
    };
    const privKey = keyMap[keyName] ?? new Api.InputPrivacyKeyStatusTimestamp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.account.GetPrivacy({ key: privKey as any }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = (result.rules ?? []).map((r: any) => r.className).join(", ");
    return { ok: true, key: keyName, rules };
  });

  registry.set("set_privacy", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const keyName = String(body.key ?? "status_timestamp");
    const ruleName = String(body.rule ?? "allow_all");
    const keyMap: Record<string, unknown> = {
      status_timestamp: new Api.InputPrivacyKeyStatusTimestamp(),
      chat_invite: new Api.InputPrivacyKeyChatInvite(),
      phone_number: new Api.InputPrivacyKeyPhoneNumber(),
      phone_call: new Api.InputPrivacyKeyPhoneCall(),
      profile_photo: new Api.InputPrivacyKeyProfilePhoto(),
      forwards: new Api.InputPrivacyKeyForwards(),
      about: new Api.InputPrivacyKeyAbout(),
    };
    const ruleMap: Record<string, unknown> = {
      allow_all: new Api.InputPrivacyValueAllowAll(),
      allow_contacts: new Api.InputPrivacyValueAllowContacts(),
      allow_close_friends: new Api.InputPrivacyValueAllowCloseFriends(),
      disallow_all: new Api.InputPrivacyValueDisallowAll(),
      disallow_contacts: new Api.InputPrivacyValueDisallowContacts(),
    };
    const privKey = keyMap[keyName] ?? new Api.InputPrivacyKeyStatusTimestamp();
    const privRule = ruleMap[ruleName] ?? new Api.InputPrivacyValueAllowAll();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.account.SetPrivacy({ key: privKey as any, rules: [privRule as any] })));
    return { ok: true, key: keyName, rule: ruleName };
  });

  registry.set("get_draft", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const targetPeer = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetAllDrafts())) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = (result?.updates ?? []).find((u: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p2 = u.peer as any;
      if (!p2) return false;
      if (p2.className === "PeerUser") return Number(p2.userId) === targetPeer;
      if (p2.className === "PeerChat") return -Number(p2.chatId) === targetPeer;
      if (p2.className === "PeerChannel") return String(`-100${BigInt(p2.channelId).toString()}`) === String(targetPeer);
      return false;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draft = update?.draft as any;
    if (!draft || draft.className === "DraftMessageEmpty") return { ok: true, draft: null };
    return { ok: true, draft: { text: draft.message, date: new Date((draft.date ?? 0) * 1000).toISOString() } };
  });

  registry.set("set_draft", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const text = String(body.text ?? "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.messages.SaveDraft({ peer: p as any, message: text })));
    return { ok: true };
  });

  registry.set("check_privacy_for_user", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const keys = ["phone_number", "last_seen", "profile_photo", "forwards", "about"] as const;
    const privacyKeyMap: Record<string, unknown> = {
      phone_number: new Api.InputPrivacyKeyPhoneNumber(),
      last_seen: new Api.InputPrivacyKeyStatusTimestamp(),
      profile_photo: new Api.InputPrivacyKeyProfilePhoto(),
      forwards: new Api.InputPrivacyKeyForwards(),
      about: new Api.InputPrivacyKeyAbout(),
    };
    const results: Record<string, string> = {};
    for (const key of keys) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await client.invoke(new Api.account.GetPrivacy({ key: privacyKeyMap[key] as any })) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rules = (res.rules ?? []) as any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ruleNames = rules.map((r: any) => r.className?.replace("PrivacyValue", "") ?? "?");
        results[key] = ruleNames.join(", ");
      } catch {
        results[key] = "unknown";
      }
    }
    return { ok: true, user_id: userId, privacy_rules: results };
  });

  registry.set("get_active_sessions", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authResult = await withRetry(() => client!.invoke(new Api.account.GetAuthorizations())) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = (authResult.authorizations ?? []).map((a: any) => ({
      hash: String(a.hash), device: a.deviceModel ?? "", platform: a.platform ?? "",
      system_version: a.systemVersion ?? "", app_name: a.appName ?? "",
      app_version: a.appVersion ?? "", date_created: a.dateCreated,
      date_active: a.dateActive, ip: a.ip ?? "", country: a.country ?? "",
      region: a.region ?? "", is_current: a.current ?? false,
    }));
    return { ok: true, sessions };
  });

  registry.set("terminate_session", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const hash = body.hash;
    if (!hash) return { ok: false, error: "hash is required (from get_active_sessions)" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.account.ResetAuthorization({ hash: BigInt(String(hash)) as any })));
    return { ok: true, terminated: true };
  });

  registry.set("get_two_factor_status", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pwResult = await withRetry(() => client!.invoke(new Api.account.GetPassword())) as any;
    return {
      ok: true, has_password: pwResult.hasPassword ?? false,
      hint: pwResult.hint ?? null,
      email_unconfirmed_pattern: pwResult.emailUnconfirmedPattern ?? null,
      has_recovery: pwResult.hasRecovery ?? false,
      has_secure_values: pwResult.hasSecureValues ?? false,
    };
  });
}
