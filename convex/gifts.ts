import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  catalog,
  MESSAGE_MAX,
  NAME_MAX,
  PAYLOAD_MAX,
  VOICE_MAX_BYTES,
  isSafePayloadUrl,
} from "../src/gifts/catalog";

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SLUG_CHARS[b % SLUG_CHARS.length];
  return out;
}

export const createGift = mutation({
  args: {
    giftType: v.string(),
    senderName: v.string(),
    recipientName: v.string(),
    message: v.string(),
    variants: v.record(v.string(), v.string()),
    lang: v.union(v.literal("en"), v.literal("ar")),
    openAfter: v.optional(v.number()),
    payload: v.optional(v.string()),
    notifyEmail: v.optional(v.string()),
    voiceId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const def = catalog[args.giftType];
    if (!def) throw new Error(`Unknown gift type: ${args.giftType}`);

    const senderName = args.senderName.trim();
    const recipientName = args.recipientName.trim();
    const message = args.message.trim();
    if (!senderName || senderName.length > NAME_MAX)
      throw new Error(`Sender name must be 1-${NAME_MAX} characters`);
    if (!recipientName || recipientName.length > NAME_MAX)
      throw new Error(`Recipient name must be 1-${NAME_MAX} characters`);
    if (message.length > MESSAGE_MAX)
      throw new Error(`Message must be at most ${MESSAGE_MAX} characters`);

    const payload = args.payload?.trim();
    if (payload) {
      if (payload.length > PAYLOAD_MAX)
        throw new Error(`Link must be at most ${PAYLOAD_MAX} characters`);
      if (!isSafePayloadUrl(payload))
        throw new Error("Link must be a valid http(s) URL");
    }

    const notifyEmail = args.notifyEmail?.trim();
    if (notifyEmail) {
      if (notifyEmail.length > 254 || !EMAIL_RE.test(notifyEmail))
        throw new Error("Enter a valid email address");
    }

    if (args.voiceId) {
      const meta = await ctx.db.system.get(args.voiceId);
      if (
        !meta ||
        !meta.contentType?.startsWith("audio/") ||
        meta.size > VOICE_MAX_BYTES
      )
        throw new Error("Invalid voice recording");
    }

    const variantKeys = Object.keys(args.variants);
    if (variantKeys.length !== def.variants.length)
      throw new Error("Variants do not match this gift");
    for (const variant of def.variants) {
      const value = args.variants[variant.key];
      if (!variant.options.some((o) => o.value === value))
        throw new Error(`Invalid value for variant "${variant.key}"`);
    }

    let slug = randomId(10);
    while (
      await ctx.db
        .query("gifts")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique()
    ) {
      slug = randomId(10);
    }
    const statusKey = randomId(16);

    // Only honor a genuinely-future unlock; a past/now value just means "open now".
    const openAfter =
      args.openAfter !== undefined && args.openAfter > Date.now()
        ? args.openAfter
        : undefined;

    const id = await ctx.db.insert("gifts", {
      giftType: args.giftType,
      senderName,
      recipientName,
      message,
      variants: args.variants,
      lang: args.lang,
      slug,
      statusKey,
      ...(openAfter !== undefined ? { openAfter } : {}),
      ...(payload ? { payload } : {}),
      ...(notifyEmail ? { notifyEmail } : {}),
      ...(args.voiceId ? { voiceId: args.voiceId } : {}),
    });

    if (openAfter !== undefined) {
      await ctx.scheduler.runAt(openAfter, internal.gifts.unseal, { id });
    }

    return { slug, statusKey };
  },
});

export const unseal = internalMutation({
  args: { id: v.id("gifts") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { unsealedAt: Date.now() });
    return null;
  },
});

// ponytail: unauthenticated upload URL, same trust level as createGift;
// rate-limit if abused.
export const generateVoiceUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const getGift = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!gift) return null;
    const sealed = gift.openAfter != null && gift.openAfter > Date.now();
    // Public fields only — never statusKey or notifyEmail. While sealed, the
    // message, payload, and voice are withheld server-side.
    return {
      giftType: gift.giftType,
      senderName: gift.senderName,
      recipientName: gift.recipientName,
      message: sealed ? null : gift.message,
      variants: gift.variants,
      lang: gift.lang ?? "en",
      openAfter: gift.openAfter ?? null,
      payload: sealed ? null : (gift.payload ?? null),
      voiceUrl:
        sealed || !gift.voiceId
          ? null
          : await ctx.storage.getUrl(gift.voiceId),
    };
  },
});

export const markOpened = mutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!gift) throw new Error("Gift not found");
    if (gift.openedAt === undefined) {
      await ctx.db.patch(gift._id, { openedAt: Date.now() });
      if (gift.notifyEmail) {
        await ctx.scheduler.runAfter(0, internal.email.sendOpened, {
          email: gift.notifyEmail,
          recipientName: gift.recipientName,
          statusKey: gift.statusKey,
          lang: gift.lang ?? "en",
        });
      }
    }
    return null;
  },
});

export const getStatus = query({
  args: { statusKey: v.string() },
  handler: async (ctx, args) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_statusKey", (q) => q.eq("statusKey", args.statusKey))
      .unique();
    if (!gift) return null;
    return {
      slug: gift.slug,
      openedAt: gift.openedAt ?? null,
      openAfter: gift.openAfter ?? null,
    };
  },
});
