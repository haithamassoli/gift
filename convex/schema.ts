import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  gifts: defineTable({
    giftType: v.string(),
    senderName: v.string(),
    recipientName: v.string(),
    message: v.string(),
    variants: v.record(v.string(), v.string()),
    // Language the sender created the gift in — optional for back-compat with
    // rows written before i18n (read as "en").
    lang: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    slug: v.string(),
    statusKey: v.string(),
    openedAt: v.optional(v.number()),
    // Epoch ms before which the gift stays sealed. Absent = openable immediately.
    // The gate is now enforced server-side in getGift: while sealed, message and
    // payload are withheld from the query response (openAfter itself stays public
    // to drive the recipient countdown).
    openAfter: v.optional(v.number()),
    // Optional http(s) URL (photo / link / voucher) revealed after the gift
    // opens. ponytail: presentational gate like openAfter — getGift returns it,
    // so it sits in the network response before the reveal; withhold server-side
    // if that matters. Single URL only; add a type discriminator if raw-text
    // voucher codes are ever needed.
    payload: v.optional(v.string()),
    // PII — getGift/getStatus must NEVER return it.
    notifyEmail: v.optional(v.string()),
    // Written by the unseal poke purely to invalidate getGift subscriptions at unlock.
    unsealedAt: v.optional(v.number()),
    voiceId: v.optional(v.id("_storage")),
  })
    .index("by_slug", ["slug"])
    .index("by_statusKey", ["statusKey"]),
});
