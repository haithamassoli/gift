import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  catalog,
  MESSAGE_MAX,
  NAME_MAX,
  PAYLOAD_MAX,
  PHOTO_MAX_BYTES,
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
    recipientEmail: v.optional(v.string()),
    voiceId: v.optional(v.id("_storage")),
    photoId: v.optional(v.id("_storage")),
    burnAfterOpen: v.optional(v.boolean()),
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

    const recipientEmail = args.recipientEmail?.trim();
    if (recipientEmail) {
      if (recipientEmail.length > 254 || !EMAIL_RE.test(recipientEmail))
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

    if (args.photoId) {
      const meta = await ctx.db.system.get(args.photoId);
      if (
        !meta ||
        !meta.contentType?.startsWith("image/") ||
        meta.size > PHOTO_MAX_BYTES
      )
        throw new Error("Invalid photo");
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

    // Trust boundary: the UI only offers "email them at unlock" on scheduled
    // gifts, so this combination can only come from a forged call.
    if (recipientEmail && openAfter === undefined)
      throw new Error("Recipient email requires a scheduled unlock");

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
      ...(recipientEmail ? { recipientEmail } : {}),
      ...(args.voiceId ? { voiceId: args.voiceId } : {}),
      ...(args.photoId ? { photoId: args.photoId } : {}),
      ...(args.burnAfterOpen ? { burnAfterOpen: true } : {}),
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
    const gift = await ctx.db.get(args.id);
    if (gift?.recipientEmail) {
      await ctx.scheduler.runAfter(0, internal.email.sendGiftLink, {
        email: gift.recipientEmail,
        recipientName: gift.recipientName,
        senderName: gift.senderName,
        slug: gift.slug,
        lang: gift.lang ?? "en",
      });
    }
    return null;
  },
});

// ponytail: unauthenticated upload URL, same trust level as createGift;
// rate-limit if abused.
export const generateUploadUrl = mutation({
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
    // Public fields only — never statusKey, notifyEmail, or recipientEmail.
    // While sealed, the message, payload, voice, and photo are withheld
    // server-side.
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
      photoUrl:
        sealed || !gift.photoId
          ? null
          : await ctx.storage.getUrl(gift.photoId),
      reply: gift.reply ?? null,
      burned: gift.burnedAt != null,
      burnsAfterOpen: gift.burnAfterOpen ?? false,
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
      if (gift.burnAfterOpen) {
        // ponytail: fixed 24h fade; make it a duration field if anyone asks.
        await ctx.scheduler.runAfter(
          24 * 60 * 60 * 1000,
          internal.gifts.burn,
          { id: gift._id },
        );
      }
    }
    return null;
  },
});

// Burn after reading: scrub the content but keep the row, so the sender's
// receipt (openedAt, reply) survives the fade.
export const burn = internalMutation({
  args: { id: v.id("gifts") },
  handler: async (ctx, args) => {
    const gift = await ctx.db.get(args.id);
    if (!gift || gift.burnedAt !== undefined) return null;
    if (gift.voiceId) await ctx.storage.delete(gift.voiceId);
    if (gift.photoId) await ctx.storage.delete(gift.photoId);
    // Patching undefined unsets the field.
    await ctx.db.patch(args.id, {
      message: "",
      payload: undefined,
      voiceId: undefined,
      photoId: undefined,
      burnedAt: Date.now(),
    });
    return null;
  },
});

export const sendReply = mutation({
  args: { slug: v.string(), reply: v.string() },
  handler: async (ctx, args) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!gift) throw new Error("Gift not found");
    if (gift.openedAt === undefined)
      throw new Error("Gift has not been opened");
    if (gift.reply !== undefined) throw new Error("Reply already sent");
    const reply = args.reply.trim();
    if (!reply || reply.length > MESSAGE_MAX)
      throw new Error(`Reply must be 1-${MESSAGE_MAX} characters`);
    await ctx.db.patch(gift._id, { reply, repliedAt: Date.now() });
    if (gift.notifyEmail) {
      await ctx.scheduler.runAfter(0, internal.email.sendReplied, {
        email: gift.notifyEmail,
        recipientName: gift.recipientName,
        reply,
        statusKey: gift.statusKey,
        lang: gift.lang ?? "en",
      });
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
      reply: gift.reply ?? null,
      repliedAt: gift.repliedAt ?? null,
    };
  },
});

// Batch receipt lookup for the homepage history. Returns ONLY openedAt per
// key — nothing a key-holder couldn't already get from getStatus.
export const getStatuses = query({
  args: { statusKeys: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.statusKeys.length > 50) throw new Error("Too many keys");
    const statuses = [];
    for (const statusKey of args.statusKeys) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_statusKey", (q) => q.eq("statusKey", statusKey))
        .unique();
      statuses.push({ statusKey, openedAt: gift?.openedAt ?? null });
    }
    return statuses;
  },
});
