import fs from "node:fs";
import { z } from "zod";
import { google, youtube_v3 } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthClient } from "./auth.js";
import * as quota from "./quota.js";

function yt() {
  return google.youtube({ version: "v3", auth: getAuthClient() });
}
function analytics() {
  return google.youtubeAnalytics({ version: "v2", auth: getAuthClient() });
}

/** Runs a YouTube call with a quota check, and turns errors into readable messages. */
async function run<T>(units: number, fn: () => Promise<T>) {
  try {
    if (units > 0) quota.check(units);
    const result = await fn();
    if (units > 0) quota.spend(units);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    const msg = e?.response?.data?.error?.message || e?.message || String(e);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  }
}

function slimVideo(v: youtube_v3.Schema$Video) {
  return {
    id: v.id,
    url: `https://youtu.be/${v.id}`,
    title: v.snippet?.title,
    publishedAt: v.snippet?.publishedAt,
    privacy: v.status?.privacyStatus,
    publishAt: v.status?.publishAt,
    uploadStatus: v.status?.uploadStatus,
    views: v.statistics?.viewCount,
    likes: v.statistics?.likeCount,
    comments: v.statistics?.commentCount,
    duration: v.contentDetails?.duration,
  };
}

const privacy = z.enum(["private", "unlisted", "public"]);

export function registerTools(server: McpServer) {
  // ---------- Channel ----------
  server.registerTool(
    "quota_status",
    { description: "How much of today's free YouTube API quota (10,000 units) is used and left. Uploads cost ~1,600." },
    async () => run(0, async () => quota.remaining())
  );

  server.registerTool(
    "my_channel",
    { description: "Get the logged-in channel's name, handle, description, stats and keywords." },
    async () =>
      run(quota.COST.read, async () => {
        const r = await yt().channels.list({ part: ["snippet", "statistics", "brandingSettings"], mine: true });
        const c = r.data.items?.[0];
        if (!c) throw new Error("No channel found on this Google account.");
        return {
          id: c.id,
          title: c.snippet?.title,
          handle: c.snippet?.customUrl,
          description: c.snippet?.description,
          keywords: c.brandingSettings?.channel?.keywords,
          subscribers: c.statistics?.subscriberCount,
          views: c.statistics?.viewCount,
          videos: c.statistics?.videoCount,
        };
      })
  );

  server.registerTool(
    "update_channel",
    {
      description: "Change the channel description and/or keywords. Only fields you pass are changed.",
      inputSchema: {
        description: z.string().optional(),
        keywords: z.string().optional().describe('Space-separated; wrap multi-word ones in quotes, e.g. minecraft "ai tools"'),
      },
    },
    async ({ description, keywords }) =>
      run(quota.COST.read + quota.COST.write, async () => {
        const api = yt();
        const r = await api.channels.list({ part: ["brandingSettings"], mine: true });
        const c = r.data.items?.[0];
        if (!c) throw new Error("No channel found.");
        const channel = { ...(c.brandingSettings?.channel || {}) };
        if (description !== undefined) channel.description = description;
        if (keywords !== undefined) channel.keywords = keywords;
        await api.channels.update({ part: ["brandingSettings"], requestBody: { id: c.id, brandingSettings: { channel } } });
        return { updated: true, description: channel.description, keywords: channel.keywords };
      })
  );

  server.registerTool(
    "set_banner",
    {
      description: "Upload a new channel banner image (JPG/PNG, 2048x1152 recommended, max 6MB).",
      inputSchema: { image_path: z.string() },
    },
    async ({ image_path }) =>
      run(quota.COST.read + quota.COST.write * 2, async () => {
        const api = yt();
        const up = await api.channelBanners.insert({ media: { body: fs.createReadStream(image_path) } });
        const r = await api.channels.list({ part: ["brandingSettings"], mine: true });
        const c = r.data.items?.[0];
        if (!c) throw new Error("No channel found.");
        await api.channels.update({
          part: ["brandingSettings"],
          requestBody: {
            id: c.id,
            brandingSettings: { channel: c.brandingSettings?.channel, image: { bannerExternalUrl: up.data.url } },
          },
        });
        return { updated: true };
      })
  );

  // ---------- Videos ----------
  server.registerTool(
    "list_videos",
    {
      description: "List the channel's uploaded videos (newest first) with privacy, views, likes and comments.",
      inputSchema: { max: z.number().int().min(1).max(50).default(25) },
    },
    async ({ max }) =>
      run(3, async () => {
        const api = yt();
        const ch = await api.channels.list({ part: ["contentDetails"], mine: true });
        const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) return [];
        const items = await api.playlistItems.list({ part: ["contentDetails"], playlistId: uploads, maxResults: max });
        const ids = (items.data.items || []).map((i) => i.contentDetails?.videoId!).filter(Boolean);
        if (!ids.length) return [];
        const vids = await api.videos.list({ part: ["snippet", "status", "statistics", "contentDetails"], id: ids });
        return (vids.data.items || []).map(slimVideo);
      })
  );

  server.registerTool(
    "get_video",
    {
      description: "Get full details of one video: title, description, tags, privacy, stats.",
      inputSchema: { video_id: z.string() },
    },
    async ({ video_id }) =>
      run(quota.COST.read, async () => {
        const r = await yt().videos.list({ part: ["snippet", "status", "statistics", "contentDetails"], id: [video_id] });
        const v = r.data.items?.[0];
        if (!v) throw new Error("Video not found.");
        return { ...slimVideo(v), description: v.snippet?.description, tags: v.snippet?.tags, categoryId: v.snippet?.categoryId };
      })
  );

  server.registerTool(
    "upload_video",
    {
      description:
        "Upload a video file from this computer. Costs ~1,600 quota units (about 6 a day). NOTE: until the Google project passes YouTube's audit, API uploads are locked to private.",
      inputSchema: {
        file_path: z.string(),
        title: z.string().max(100),
        description: z.string().default(""),
        tags: z.array(z.string()).default([]),
        privacy: privacy.default("private"),
        publish_at: z.string().optional().describe("ISO time to auto-publish, e.g. 2026-10-20T17:00:00Z (needs privacy=private)"),
        category_id: z.string().default("22").describe("22 People & Blogs, 20 Gaming, 28 Science & Tech, 27 Education, 24 Entertainment"),
        made_for_kids: z.boolean().default(false),
        thumbnail_path: z.string().optional(),
      },
    },
    async (a) =>
      run(quota.COST.upload + (a.thumbnail_path ? quota.COST.thumbnail : 0), async () => {
        if (!fs.existsSync(a.file_path)) throw new Error(`File not found: ${a.file_path}`);
        const api = yt();
        const res = await api.videos.insert({
          part: ["snippet", "status"],
          notifySubscribers: true,
          requestBody: {
            snippet: { title: a.title, description: a.description, tags: a.tags, categoryId: a.category_id },
            status: {
              privacyStatus: a.publish_at ? "private" : a.privacy,
              publishAt: a.publish_at,
              selfDeclaredMadeForKids: a.made_for_kids,
            },
          },
          media: { body: fs.createReadStream(a.file_path) },
        });
        const id = res.data.id!;
        let thumbnail = "none";
        if (a.thumbnail_path) {
          try {
            await api.thumbnails.set({ videoId: id, media: { body: fs.createReadStream(a.thumbnail_path) } });
            thumbnail = "set";
          } catch (e: any) {
            thumbnail = "failed: " + (e?.response?.data?.error?.message || e.message) + " (custom thumbnails need a phone-verified channel)";
          }
        }
        return { id, url: `https://youtu.be/${id}`, studio: `https://studio.youtube.com/video/${id}/edit`, privacy: res.data.status?.privacyStatus, thumbnail };
      })
  );

  server.registerTool(
    "update_video",
    {
      description: "Edit a video's title, description, tags, category, privacy, or scheduled publish time. Only fields you pass change.",
      inputSchema: {
        video_id: z.string(),
        title: z.string().max(100).optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        category_id: z.string().optional(),
        privacy: privacy.optional(),
        publish_at: z.string().optional(),
      },
    },
    async (a) =>
      run(quota.COST.read + quota.COST.write, async () => {
        const api = yt();
        const r = await api.videos.list({ part: ["snippet", "status"], id: [a.video_id] });
        const v = r.data.items?.[0];
        if (!v) throw new Error("Video not found.");
        const snippet = {
          title: a.title ?? v.snippet?.title,
          description: a.description ?? v.snippet?.description,
          tags: a.tags ?? v.snippet?.tags,
          categoryId: a.category_id ?? v.snippet?.categoryId,
          defaultLanguage: v.snippet?.defaultLanguage,
        };
        const status: youtube_v3.Schema$VideoStatus = {
          privacyStatus: a.privacy ?? v.status?.privacyStatus,
          embeddable: v.status?.embeddable,
          license: v.status?.license,
          publicStatsViewable: v.status?.publicStatsViewable,
          selfDeclaredMadeForKids: v.status?.selfDeclaredMadeForKids,
        };
        if (a.publish_at) {
          status.publishAt = a.publish_at;
          status.privacyStatus = "private";
        }
        const u = await api.videos.update({ part: ["snippet", "status"], requestBody: { id: a.video_id, snippet, status } });
        return slimVideo(u.data);
      })
  );

  server.registerTool(
    "set_thumbnail",
    {
      description: "Set a custom thumbnail (JPG/PNG, 1280x720, under 2MB). Channel must be phone-verified.",
      inputSchema: { video_id: z.string(), image_path: z.string() },
    },
    async ({ video_id, image_path }) =>
      run(quota.COST.thumbnail, async () => {
        await yt().thumbnails.set({ videoId: video_id, media: { body: fs.createReadStream(image_path) } });
        return { updated: true, video_id };
      })
  );

  server.registerTool(
    "delete_video",
    {
      description: "PERMANENTLY delete a video. Always confirm with the user first.",
      inputSchema: { video_id: z.string(), confirm: z.literal(true) },
    },
    async ({ video_id }) =>
      run(quota.COST.write, async () => {
        await yt().videos.delete({ id: video_id });
        return { deleted: video_id };
      })
  );

  // ---------- Playlists ----------
  server.registerTool(
    "list_playlists",
    { description: "List the channel's playlists." },
    async () =>
      run(quota.COST.read, async () => {
        const r = await yt().playlists.list({ part: ["snippet", "status", "contentDetails"], mine: true, maxResults: 50 });
        return (r.data.items || []).map((p) => ({
          id: p.id,
          title: p.snippet?.title,
          privacy: p.status?.privacyStatus,
          videos: p.contentDetails?.itemCount,
        }));
      })
  );

  server.registerTool(
    "create_playlist",
    {
      description: "Create a playlist.",
      inputSchema: { title: z.string(), description: z.string().default(""), privacy: privacy.default("public") },
    },
    async (a) =>
      run(quota.COST.write, async () => {
        const r = await yt().playlists.insert({
          part: ["snippet", "status"],
          requestBody: { snippet: { title: a.title, description: a.description }, status: { privacyStatus: a.privacy } },
        });
        return { id: r.data.id, title: r.data.snippet?.title };
      })
  );

  server.registerTool(
    "add_to_playlist",
    { description: "Add a video to a playlist.", inputSchema: { playlist_id: z.string(), video_id: z.string() } },
    async ({ playlist_id, video_id }) =>
      run(quota.COST.write, async () => {
        const r = await yt().playlistItems.insert({
          part: ["snippet"],
          requestBody: { snippet: { playlistId: playlist_id, resourceId: { kind: "youtube#video", videoId: video_id } } },
        });
        return { added: true, item_id: r.data.id };
      })
  );

  server.registerTool(
    "remove_from_playlist",
    { description: "Remove a video from a playlist.", inputSchema: { playlist_id: z.string(), video_id: z.string() } },
    async ({ playlist_id, video_id }) =>
      run(quota.COST.read + quota.COST.write, async () => {
        const api = yt();
        const r = await api.playlistItems.list({ part: ["id"], playlistId: playlist_id, videoId: video_id });
        const item = r.data.items?.[0];
        if (!item) throw new Error("That video isn't in that playlist.");
        await api.playlistItems.delete({ id: item.id! });
        return { removed: true };
      })
  );

  // ---------- Comments ----------
  server.registerTool(
    "list_comments",
    {
      description: "Read comments on one video, or across the whole channel if no video_id is given. Includes replies.",
      inputSchema: {
        video_id: z.string().optional(),
        max: z.number().int().min(1).max(100).default(30),
        status: z.enum(["published", "heldForReview", "likelySpam"]).default("published"),
      },
    },
    async ({ video_id, max, status }) =>
      run(quota.COST.read * 2, async () => {
        const api = yt();
        let channelId: string | undefined;
        if (!video_id) {
          const ch = await api.channels.list({ part: ["id"], mine: true });
          channelId = ch.data.items?.[0]?.id ?? undefined;
        }
        const r = await api.commentThreads.list({
          part: ["snippet", "replies"],
          videoId: video_id,
          allThreadsRelatedToChannelId: channelId,
          maxResults: max,
          moderationStatus: status,
          order: "time",
        });
        return (r.data.items || []).map((t) => {
          const top = t.snippet?.topLevelComment?.snippet;
          return {
            comment_id: t.snippet?.topLevelComment?.id,
            video_id: t.snippet?.videoId,
            author: top?.authorDisplayName,
            text: top?.textOriginal,
            likes: top?.likeCount,
            at: top?.publishedAt,
            replies: (t.replies?.comments || []).map((c) => ({
              comment_id: c.id,
              author: c.snippet?.authorDisplayName,
              text: c.snippet?.textOriginal,
            })),
          };
        });
      })
  );

  server.registerTool(
    "reply_comment",
    { description: "Reply to a comment as the channel.", inputSchema: { comment_id: z.string(), text: z.string() } },
    async ({ comment_id, text }) =>
      run(quota.COST.write, async () => {
        const r = await yt().comments.insert({ part: ["snippet"], requestBody: { snippet: { parentId: comment_id, textOriginal: text } } });
        return { replied: true, reply_id: r.data.id };
      })
  );

  server.registerTool(
    "moderate_comment",
    {
      description: "Approve a held comment, hide it (reject), or mark it for review. Optionally ban the author from the channel.",
      inputSchema: {
        comment_id: z.string(),
        action: z.enum(["published", "rejected", "heldForReview"]),
        ban_author: z.boolean().default(false),
      },
    },
    async ({ comment_id, action, ban_author }) =>
      run(quota.COST.write, async () => {
        await yt().comments.setModerationStatus({ id: [comment_id], moderationStatus: action, banAuthor: ban_author });
        return { comment_id, status: action, banned: ban_author };
      })
  );

  server.registerTool(
    "delete_comment",
    { description: "Delete a comment the channel wrote.", inputSchema: { comment_id: z.string() } },
    async ({ comment_id }) =>
      run(quota.COST.write, async () => {
        await yt().comments.delete({ id: comment_id });
        return { deleted: comment_id };
      })
  );

  // ---------- Analytics ----------
  server.registerTool(
    "analytics",
    {
      description:
        "Query YouTube Analytics for the channel (or one video). Common metrics: views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, likes, comments, shares. Common dimensions: day, video, insightTrafficSourceType, country, deviceType, ageGroup, gender.",
      inputSchema: {
        start_date: z.string().describe("YYYY-MM-DD"),
        end_date: z.string().describe("YYYY-MM-DD"),
        metrics: z.string().default("views,estimatedMinutesWatched,averageViewDuration,subscribersGained,likes"),
        dimensions: z.string().optional(),
        video_id: z.string().optional(),
        sort: z.string().optional().describe("e.g. -views"),
        max_results: z.number().int().optional(),
      },
    },
    async (a) =>
      run(0, async () => {
        const r = await analytics().reports.query({
          ids: "channel==MINE",
          startDate: a.start_date,
          endDate: a.end_date,
          metrics: a.metrics,
          dimensions: a.dimensions,
          filters: a.video_id ? `video==${a.video_id}` : undefined,
          sort: a.sort,
          maxResults: a.max_results,
        });
        const cols = (r.data.columnHeaders || []).map((c) => c.name!);
        return (r.data.rows || []).map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v])));
      })
  );
}
