/**
 * Story actions: post, delete, get stories, get story viewers.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { CustomFile } from "telegram/client/uploads.js";
import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerStoryActions(registry: ActionRegistry) {
  registry.set("post_story", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const filePath = String(body.file_path ?? "");
    if (!filePath) return { ok: false, error: "file_path is required" };
    const caption = body.caption ? String(body.caption) : undefined;
    const periodSeconds = typeof body.period_seconds === "number" ? body.period_seconds : 86400;
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const storyFileSize = statSync(filePath).size;
    const uploaded = await withRetry(() =>
      client!.uploadFile({ file: new CustomFile(basename(filePath), storyFileSize, filePath), workers: 4 }),
    );
    const isVideo = ["mp4", "mov", "avi", "mkv", "webm"].includes(ext);
    const media = isVideo
      ? new Api.InputMediaUploadedDocument({
          file: uploaded, mimeType: "video/mp4",
          attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0 })],
          nosoundVideo: false,
        })
      : new Api.InputMediaUploadedPhoto({ file: uploaded });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() =>
      client!.invoke(new Api.stories.SendStory({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: new Api.InputPeerSelf() as any, media,
        caption: caption ?? "", period: periodSeconds,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        randomId: BigInt(Date.now()) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        privacyRules: [new Api.InputPrivacyValueAllowAll() as any],
      })),
    ) as any;
    const storyId = result?.updates?.find?.((u: { className: string }) => u.className === "UpdateStory")?.story?.id ?? null;
    return { ok: true, story_id: storyId };
  });

  registry.set("delete_story", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const storyId = Number(body.story_id);
    if (!storyId) return { ok: false, error: "story_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.stories.DeleteStories({ peer: new Api.InputPeerSelf() as any, id: [storyId] })));
    return { ok: true };
  });

  registry.set("get_stories", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetPeer = body.user_id ? (Number(body.user_id) as any) : (new Api.InputPeerSelf() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.stories.GetPeerStories({ peer: targetPeer })) as any;
    const stories = (result.stories?.stories ?? []) as Array<{ id: number; date: number; caption?: string; media?: { className: string } }>;
    if (stories.length === 0) return { ok: true, text: "No stories.", count: 0 };
    const formatted = stories.map((s) => {
      const date = new Date(s.date * 1000).toISOString();
      return `[story:${s.id} ${date}] ${s.caption || "(no caption)"} [${s.media?.className ?? "media"}]`;
    });
    return { ok: true, text: formatted.join("\n"), count: stories.length };
  });

  registry.set("get_story_viewers", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const storyId = Number(body.story_id);
    if (!storyId) return { ok: false, error: "story_id is required" };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await withRetry(() => client!.invoke(new Api.stories.GetStoryViewsList({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: new Api.InputPeerSelf() as any, id: storyId,
        limit: Math.min(Number(body.limit ?? 50), 100), offset: "",
      }))) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viewers = (result.views ?? []).map((v: any) => ({
        userId: String(v.userId), date: new Date((v.date ?? 0) * 1000).toISOString(),
        reaction: v.reaction?.emoticon ?? null,
      }));
      return { ok: true, count: result.count ?? viewers.length, viewers };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
