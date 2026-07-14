import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { catalog, MESSAGE_MAX, NAME_MAX } from "../src/gifts/catalog";

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

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

    await ctx.db.insert("gifts", {
      giftType: args.giftType,
      senderName,
      recipientName,
      message,
      variants: args.variants,
      lang: args.lang,
      slug,
      statusKey,
    });

    return { slug, statusKey };
  },
});

export const getGift = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!gift) return null;
    // Public fields only — never statusKey.
    return {
      giftType: gift.giftType,
      senderName: gift.senderName,
      recipientName: gift.recipientName,
      message: gift.message,
      variants: gift.variants,
      lang: gift.lang ?? "en",
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
    };
  },
});
