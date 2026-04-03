/**
 * Profile actions: get/edit profile, username, photos, contacts, block, emoji status, etc.
 */

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { CustomFile } from "telegram/client/uploads.js";
import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerProfileActions(registry: ActionRegistry) {
  registry.set("get_my_profile", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = await client.getMe() as any;
    return {
      ok: true, id: Number(me.id), first_name: me.firstName ?? null,
      last_name: me.lastName ?? null, username: me.username ?? null,
      phone: me.phone ?? null, bio: me.about ?? null,
      verified: me.verified ?? false, premium: me.premium ?? false, bot: me.bot ?? false,
    };
  });

  registry.set("edit_profile", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const updateParams: Record<string, string> = {};
    if (typeof body.first_name === "string") updateParams.firstName = body.first_name;
    if (typeof body.last_name === "string") updateParams.lastName = body.last_name;
    if (typeof body.about === "string") updateParams.about = body.about;
    if (Object.keys(updateParams).length === 0)
      return { ok: false, error: "Provide at least one of: first_name, last_name, about" };
    await withRetry(() => client!.invoke(new Api.account.UpdateProfile(updateParams)));
    return { ok: true };
  });

  registry.set("set_username", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const username = String(body.username ?? "");
    await withRetry(() => client!.invoke(new Api.account.UpdateUsername({ username })));
    return { ok: true };
  });

  registry.set("set_profile_photo", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const filePath = String(body.file_path ?? "");
    if (!filePath) return { ok: false, error: "file_path is required" };
    const fileSize = statSync(filePath).size;
    const uploaded = await withRetry(() =>
      client!.uploadFile({ file: new CustomFile(basename(filePath), fileSize, filePath), workers: 1 }),
    );
    await withRetry(() => client!.invoke(new Api.photos.UploadProfilePhoto({ file: uploaded })));
    return { ok: true };
  });

  registry.set("delete_profile_photos", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const photosResult = await client.invoke(new Api.photos.GetUserPhotos({
      userId: new Api.InputUserSelf(), offset: 0,
      maxId: BigInt(0) as unknown as import("big-integer").BigInteger, limit: 100,
    })) as any;
    const photos: unknown[] = photosResult.photos ?? [];
    if (photos.length === 0) return { ok: true, deleted: 0 };
    await withRetry(() =>
      client!.invoke(new Api.photos.DeletePhotos({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        id: (photos as any[]).map((p: any) =>
          new Api.InputPhoto({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference }),
        ),
      })),
    );
    return { ok: true, deleted: photos.length };
  });

  registry.set("get_contacts", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.contacts.GetContacts({
      hash: BigInt(0) as unknown as import("big-integer").BigInteger,
    })) as any;
    const users = (result.users ?? []) as Array<{ id: unknown; firstName?: string; lastName?: string; username?: string; phone?: string }>;
    if (users.length === 0) return { ok: true, text: "No contacts.", count: 0 };
    const formatted = users.map((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
      const username = u.username ? ` @${u.username}` : "";
      const phone = u.phone ? ` +${u.phone}` : "";
      return `[id:${Number(u.id)}]${username} ${name}${phone}`;
    });
    return { ok: true, text: formatted.join("\n"), count: users.length };
  });

  registry.set("add_contact", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const phone = String(body.phone_number ?? "");
    const firstName = String(body.first_name ?? "");
    const lastName = String(body.last_name ?? "");
    if (!phone || !firstName) return { ok: false, error: "phone_number and first_name are required" };
    await withRetry(() =>
      client!.invoke(new Api.contacts.ImportContacts({
        contacts: [new Api.InputPhoneContact({
          clientId: BigInt(Date.now()) as unknown as import("big-integer").BigInteger,
          phone, firstName, lastName,
        })],
      })),
    );
    return { ok: true };
  });

  registry.set("delete_contact", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.contacts.DeleteContacts({ id: [userId as any] })));
    return { ok: true };
  });

  registry.set("block_user", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.contacts.Block({ id: userId as any })));
    return { ok: true };
  });

  registry.set("unblock_user", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.contacts.Unblock({ id: userId as any })));
    return { ok: true };
  });

  registry.set("get_blocked_users", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const limit = Math.min(100, Number(body.limit ?? 20));
    const offset = Number(body.offset ?? 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.contacts.GetBlocked({ offset, limit })) as any;
    const users = (result.users ?? []) as Array<{ id: unknown; firstName?: string; lastName?: string; username?: string }>;
    const totalCount = Number(result.count ?? users.length);
    if (users.length === 0) return { ok: true, text: "No blocked users.", count: 0, total: 0 };
    const formatted = users.map((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
      const username = u.username ? ` @${u.username}` : "";
      return `[id:${Number(u.id)}]${username} ${name}`;
    });
    return { ok: true, text: formatted.join("\n"), count: users.length, total: totalCount, offset, has_more: offset + users.length < totalCount };
  });

  registry.set("get_mutual_contacts", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.contacts.GetContacts({
      hash: BigInt(0) as unknown as import("big-integer").BigInteger,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const users = (result.users ?? []) as any[];
    if (users.length === 0) return { ok: true, text: "No mutual contacts.", count: 0 };
    const formatted = users
      .filter((u) => u.mutualContact === true || u.contact === true)
      .map((u) => {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
        const username = u.username ? ` @${u.username}` : "";
        const phone = u.phone ? ` +${u.phone}` : "";
        return `[id:${Number(u.id)}]${username} ${name}${phone}`;
      });
    return { ok: true, text: formatted.join("\n") || "No mutual contacts.", count: formatted.length };
  });

  registry.set("import_contacts", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const rawContacts = body.contacts;
    if (!Array.isArray(rawContacts) || rawContacts.length === 0)
      return { ok: false, error: "contacts must be a non-empty array of {phone, first_name, last_name?}" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contacts = (rawContacts as any[]).map((c, i) => {
      const phone = String(c.phone ?? "");
      const firstName = String(c.first_name ?? "");
      const lastName = String(c.last_name ?? "");
      if (!phone || !firstName) throw new Error(`Contact[${i}]: phone and first_name are required`);
      return new Api.InputPhoneContact({
        clientId: BigInt(Date.now() + i) as unknown as import("big-integer").BigInteger,
        phone, firstName, lastName,
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.contacts.ImportContacts({ contacts }))) as any;
    const imported = Number(result?.imported?.length ?? 0);
    const notImported = Number(result?.retryContacts?.length ?? 0);
    return { ok: true, imported, not_imported: notImported };
  });

  registry.set("export_contacts", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contactsResult = await withRetry(() => client!.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as any }))) as any;
    const users = contactsResult.users ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vcards = users.map((u: any) => {
      const fn = [u.firstName ?? "", u.lastName ?? ""].filter(Boolean).join(" ");
      let vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${fn}\n`;
      vcard += `N:${u.lastName ?? ""};${u.firstName ?? ""};;;\n`;
      if (u.phone) vcard += `TEL;TYPE=CELL:+${u.phone}\n`;
      if (u.username) vcard += `NOTE:@${u.username} (Telegram ID: ${u.id})\n`;
      vcard += `END:VCARD`;
      return vcard;
    });
    const vcfContent = vcards.join("\n\n");
    const outDir = resolve("workspace");
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `contacts_${Date.now()}.vcf`);
    writeFileSync(outPath, vcfContent, "utf-8");
    return { ok: true, count: users.length, file: outPath };
  });

  registry.set("get_profile_photos", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const userId = body.user_id ? Number(body.user_id) : null;
    const limit = Math.min(50, Number(body.limit ?? 10));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetUser = userId ? (userId as any) : new Api.InputUserSelf();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.photos.GetUserPhotos({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: targetUser as any, offset: 0,
      maxId: BigInt(0) as unknown as import("big-integer").BigInteger, limit,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const photos = (result.photos ?? []) as any[];
    const formatted = photos.map((p_) => ({
      id: String(p_.id), date: p_.date ? new Date(p_.date * 1000).toISOString() : null,
    }));
    return { ok: true, count: formatted.length, photos: formatted };
  });

  registry.set("set_emoji_status", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const docIdRaw = body.document_id;
    if (!docIdRaw) {
      await withRetry(() => client!.invoke(new Api.account.UpdateEmojiStatus({ emojiStatus: new Api.EmojiStatusEmpty() })));
      return { ok: true, cleared: true };
    }
    const documentId = BigInt(String(docIdRaw)) as unknown as import("big-integer").BigInteger;
    const until = typeof body.until === "number" ? body.until : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emojiStatus = new Api.EmojiStatus({ documentId, ...(until ? { until } : {}) } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.account.UpdateEmojiStatus({ emojiStatus: emojiStatus as any })));
    return { ok: true, document_id: String(docIdRaw), until: until ?? null };
  });

  registry.set("get_emoji_status", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = await client.getMe() as any;
    const status = me?.emojiStatus;
    if (!status || status.className === "EmojiStatusEmpty") return { ok: true, emoji_status: null };
    return {
      ok: true,
      emoji_status: {
        document_id: status.documentId ? String(status.documentId) : null,
        until: status.until ?? null, className: status.className,
      },
    };
  });

  registry.set("get_online_status", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = body.user_id;
    if (!userId) return { ok: false, error: "user_id is required" };
    const resolvedUser = await client.getEntity(Number(userId)).catch(() => null);
    if (!resolvedUser) return { ok: false, error: `Could not resolve user ${userId}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.users.GetFullUser({ id: resolvedUser as any }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = result.users?.[0] as any;
    const status = user?.status;
    if (!status) return { ok: true, user_id: userId, status: "unknown" };
    const cn = status.className;
    if (cn === "UserStatusOnline") return { ok: true, status: "online", expires: new Date(status.expires * 1000).toISOString() };
    if (cn === "UserStatusOffline") return { ok: true, status: "offline", wasOnline: new Date(status.wasOnline * 1000).toISOString() };
    if (cn === "UserStatusRecently") return { ok: true, status: "recently_online" };
    if (cn === "UserStatusLastWeek") return { ok: true, status: "last_week" };
    if (cn === "UserStatusLastMonth") return { ok: true, status: "last_month" };
    return { ok: true, status: cn };
  });

  registry.set("get_premium_info", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const premUserId = body.user_id ? Number(body.user_id) : undefined;
    if (premUserId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entity = await client.getEntity(premUserId as any) as any;
      return { ok: true, user_id: Number(entity.id), premium: entity.premium ?? false, username: entity.username ?? null, first_name: entity.firstName ?? null };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = await client.getMe() as any;
    return { ok: true, user_id: Number(me.id), premium: me.premium ?? false, username: me.username ?? null, first_name: me.firstName ?? null, is_self: true };
  });

  registry.set("get_bot_info", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const botId = body.user_id ?? body.bot_id ?? body.username;
    if (!botId) return { ok: false, error: "user_id or username is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const botEntity = await client.getEntity(typeof botId === "string" ? botId : Number(botId) as any) as any;
    if (!botEntity.bot) return { ok: false, error: "The specified user is not a bot" };
    const fullUser = await client.invoke(new Api.users.GetFullUser({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: new Api.InputUser({ userId: BigInt(botEntity.id) as any, accessHash: BigInt(botEntity.accessHash ?? 0) as any }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const botInfo = fullUser.fullUser?.botInfo;
    return {
      ok: true, bot_id: Number(botEntity.id), username: botEntity.username ?? null,
      first_name: botEntity.firstName ?? null, description: botInfo?.description ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      commands: (botInfo?.commands ?? []).map((c: any) => ({ command: c.command, description: c.description })),
      can_join_groups: botEntity.botChatHistory ?? false, inline_placeholder: botInfo?.inlinePlaceholder ?? null,
    };
  });

  registry.set("get_full_user", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const target = String(body.target ?? body.user_id ?? "").trim();
    if (!target) return { ok: false, error: "target is required (@username, phone, or user ID)" };
    const targetPeer: number | string = /^-?\d+$/.test(target) ? Number(target) : target;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = await client.getEntity(targetPeer as any) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const full = await withRetry(() => client!.invoke(new Api.users.GetFullUser({ id: entity as any }))) as any;
    const u = full.users?.[0] ?? entity;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
    const username = u.username ? `@${u.username}` : "none";
    const bio = full.fullUser?.about ?? "(no bio)";
    const phone = u.phone ? `+${u.phone}` : "hidden";
    const commonChatsCount = full.fullUser?.commonChatsCount ?? 0;
    const premium = u.premium ? " [Premium]" : "";
    const verified = u.verified ? " [Verified]" : "";
    const bot = u.bot ? " [Bot]" : "";
    return {
      ok: true,
      text: `${name}${premium}${verified}${bot}\nUsername: ${username}\nID: ${Number(u.id)}\nPhone: ${phone}\nBio: ${bio}\nCommon chats: ${commonChatsCount}`,
    };
  });

  registry.set("get_connection_status", async () => {
    const client = getClient();
    const connected = !!client;
    if (!client) return { ok: true, connected: false, authorized: false };
    try {
      const authorized = await client.isUserAuthorized();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = (client as any).session;
      const dcId = session?.dcId ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const me = authorized ? (await client.getMe().catch(() => null)) as any : null;
      return {
        ok: true, connected, authorized, dc_id: dcId,
        self: me ? { id: Number(me.id), username: me.username ?? null, first_name: me.firstName ?? null, phone: me.phone ?? null } : null,
      };
    } catch {
      return { ok: true, connected, authorized: false };
    }
  });
}
