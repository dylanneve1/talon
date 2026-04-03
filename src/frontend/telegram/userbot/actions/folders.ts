/**
 * Chat folder actions: get, create, delete, add chat to folder.
 */

import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerFolderActions(registry: ActionRegistry) {
  registry.set("get_chat_folders", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetDialogFilters())) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters = (result.filters ?? result ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const folders = filters.map((f: any) => ({
      id: f.id, title: f.title?.text ?? f.title ?? "(unnamed)",
      emoticon: f.emoticon ?? null,
      includePeers: (f.includePeers ?? []).length,
      excludePeers: (f.excludePeers ?? []).length,
      pinnedPeers: (f.pinnedPeers ?? []).length,
      flags: {
        contacts: !!f.contacts, nonContacts: !!f.nonContacts,
        groups: !!f.groups, broadcasts: !!f.broadcasts, bots: !!f.bots,
        excludeMuted: !!f.excludeMuted, excludeRead: !!f.excludeRead,
        excludeArchived: !!f.excludeArchived,
      },
    }));
    return { ok: true, count: folders.length, folders };
  });

  registry.set("create_chat_folder", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const title = String(body.title ?? "");
    if (!title) return { ok: false, error: "title is required" };
    const emoticon = body.emoticon ? String(body.emoticon) : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await withRetry(() => client!.invoke(new Api.messages.GetDialogFilters())) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters = (existing.filters ?? existing ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maxId = Math.max(2, ...filters.map((f: any) => f.id ?? 0));
    const newId = maxId + 1;
    const filter = new Api.DialogFilter({
      id: newId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      title: new Api.TextWithEntities({ text: title, entities: [] }) as any,
      emoticon, pinnedPeers: [], includePeers: [], excludePeers: [],
      contacts: body.contacts === true, nonContacts: body.non_contacts === true,
      groups: body.groups === true, broadcasts: body.broadcasts === true,
      bots: body.bots === true, excludeMuted: body.exclude_muted === true,
      excludeRead: body.exclude_read === true,
      excludeArchived: body.exclude_archived !== false,
    });
    await withRetry(() => client!.invoke(new Api.messages.UpdateDialogFilter({ id: newId, filter })));
    return { ok: true, id: newId, title };
  });

  registry.set("delete_chat_folder", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const folderId = Number(body.id ?? body.folder_id ?? 0);
    if (!folderId) return { ok: false, error: "id (folder ID) is required" };
    await withRetry(() => client!.invoke(new Api.messages.UpdateDialogFilter({ id: folderId })));
    return { ok: true };
  });

  registry.set("add_chat_to_folder", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const folderId = Number(body.folder_id ?? 0);
    if (!folderId) return { ok: false, error: "folder_id is required" };
    const targetChat = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await withRetry(() => client!.invoke(new Api.messages.GetDialogFilters())) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filters = (existing.filters ?? existing ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter = filters.find((f: any) => f.id === folderId);
    if (!filter) return { ok: false, error: `Folder ${folderId} not found` };
    const entity = await client.getEntity(targetChat).catch(() => null);
    if (!entity) return { ok: false, error: `Could not resolve chat ${targetChat}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputPeer = (await client.getInputEntity(entity as any)) as any;
    if (!filter.includePeers) filter.includePeers = [];
    filter.includePeers.push(inputPeer);
    await withRetry(() => client!.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter })));
    return { ok: true, folder_id: folderId, chat_id: targetChat };
  });
}
