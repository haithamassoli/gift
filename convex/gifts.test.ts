/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Some tests fake timers so scheduled jobs are discarded instead of left on
// real pending timeouts; always restore.
afterEach(() => {
  vi.useRealTimers();
});

// Minimal valid createGift args: eternal-rose has a single "petal" variant.
const baseGift = {
  giftType: "eternal-rose",
  senderName: "Amal",
  recipientName: "Sami",
  message: "Happy birthday!",
  variants: { petal: "red" },
  lang: "en",
} as const;

test("sendReply is gated on open, write-once, and non-empty", async () => {
  const t = convexTest(schema, modules);
  const { slug } = await t.mutation(api.gifts.createGift, baseGift);

  await expect(
    t.mutation(api.gifts.sendReply, { slug, reply: "Thank you" }),
  ).rejects.toThrow("Gift has not been opened");

  await t.mutation(api.gifts.markOpened, { slug });

  await expect(
    t.mutation(api.gifts.sendReply, { slug, reply: "   " }),
  ).rejects.toThrow("Reply must be");

  await t.mutation(api.gifts.sendReply, { slug, reply: "Thank you" });
  const gift = await t.query(api.gifts.getGift, { slug });
  expect(gift?.reply).toBe("Thank you");

  await expect(
    t.mutation(api.gifts.sendReply, { slug, reply: "Again" }),
  ).rejects.toThrow("Reply already sent");
});

test("createGift requires a future unlock for recipientEmail", async () => {
  // Fake timers: the passing case schedules unseal an hour out; discard it at
  // afterEach rather than running it (it would fan out into the email action).
  vi.useFakeTimers();
  const t = convexTest(schema, modules);

  await expect(
    t.mutation(api.gifts.createGift, {
      ...baseGift,
      recipientEmail: "sami@example.com",
    }),
  ).rejects.toThrow("Recipient email requires a scheduled unlock");

  await expect(
    t.mutation(api.gifts.createGift, {
      ...baseGift,
      recipientEmail: "sami@example.com",
      openAfter: Date.now() - 1000,
    }),
  ).rejects.toThrow("Recipient email requires a scheduled unlock");

  const created = await t.mutation(api.gifts.createGift, {
    ...baseGift,
    recipientEmail: "sami@example.com",
    openAfter: Date.now() + 60 * 60 * 1000,
  });
  expect(created.slug).toBeTruthy();
  expect(created.statusKey).toBeTruthy();
});

test("burn scrubs content but keeps the receipt, and is a no-op twice", async () => {
  const t = convexTest(schema, modules);
  const { slug, statusKey } = await t.mutation(api.gifts.createGift, baseGift);
  await t.mutation(api.gifts.markOpened, { slug });

  const id = await t.run(async (ctx) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!gift) throw new Error("gift row missing");
    return gift._id;
  });

  await t.mutation(internal.gifts.burn, { id });

  const burned = await t.run(async (ctx) => ctx.db.get(id));
  expect(burned?.message).toBe("");
  expect(burned?.burnedAt).toBeGreaterThan(0);

  const status = await t.query(api.gifts.getStatus, { statusKey });
  expect(status?.openedAt).toEqual(expect.any(Number));

  // Second burn must be a no-op: plant a sentinel and confirm it survives.
  await t.run(async (ctx) => {
    await ctx.db.patch(id, { message: "sentinel" });
  });
  await t.mutation(internal.gifts.burn, { id });
  const afterSecond = await t.run(async (ctx) => ctx.db.get(id));
  expect(afterSecond?.message).toBe("sentinel");
  expect(afterSecond?.burnedAt).toBe(burned?.burnedAt);
});

test("visitor counter creates the row then increments it", async () => {
  const t = convexTest(schema, modules);

  expect(await t.query(api.gifts.getVisitors, {})).toBe(0);
  await t.mutation(api.gifts.bumpVisitors, {});
  await t.mutation(api.gifts.bumpVisitors, {});
  expect(await t.query(api.gifts.getVisitors, {})).toBe(2);
});

test("createGift validates the photo blob", async () => {
  const t = convexTest(schema, modules);

  const storeBlob = (type: string) =>
    t.run(async (ctx) => {
      const id = await ctx.storage.store(
        new Blob([new Uint8Array(1024)], { type }),
      );
      // convex-test doesn't copy Blob.type onto the _storage row, so write
      // contentType the way the real backend stores it before createGift
      // reads it back via ctx.db.system.get.
      const patchMeta = ctx.db.patch as unknown as (
        id: string,
        value: Record<string, string>,
      ) => Promise<void>;
      await patchMeta(id, { contentType: type });
      return id;
    });

  const textId = await storeBlob("text/plain");
  await expect(
    t.mutation(api.gifts.createGift, { ...baseGift, photoId: textId }),
  ).rejects.toThrow("Invalid photo");

  const pngId = await storeBlob("image/png");
  const { slug } = await t.mutation(api.gifts.createGift, {
    ...baseGift,
    photoId: pngId,
  });
  const gift = await t.query(api.gifts.getGift, { slug });
  expect(gift?.photoUrl).toBeTruthy();
});
