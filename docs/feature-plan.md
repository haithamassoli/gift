# Feature plan: share, server-side seal, OG previews, voice notes, open-email

Five features from the 2026-07 feature review, in build order (each independently shippable):

| # | Feature | Size | Depends on |
|---|---------|------|-----------|
| 1 | `navigator.share` on Sent page | XS | — |
| 2 | Server-side gate for scheduled gifts | S | — |
| 3 | "Email me when opened" | S + account setup | — |
| 4 | Per-gift OG link previews | M | prod Convex URL |
| 5 | Voice-note attachment | L | #2 (seal gating) |

Shared notes:

- Every new UI string gets an `en` + `ar` entry in `src/i18n.tsx`. Arabic drafts below are placeholders — review before ship.
- Memory note applies: after editing `src/gifts/catalog.ts`, touch `convex/gifts.ts` so the Convex watcher picks it up.
- All schema additions are `v.optional(...)` — safe against existing rows, no migration needed except where called out in #2.

---

## 1. `navigator.share` on the Sent page (XS)

**Why:** mobile PWA whose links travel by WhatsApp; clipboard-only is friction.

**Changes — `src/pages/Sent.tsx` only:**

- Feature-detect once: `const canShare = "share" in navigator;`
- When supported, render a **Share** button as the primary action (current rose style); Copy drops to secondary (current outline style). When unsupported (desktop Firefox etc.), UI is unchanged.

```ts
const share = () =>
  navigator.share({ url: shareUrl, text: t.sent.shareText }).catch(() => {});
// catch: AbortError when the user dismisses the sheet — not an error.
```

**i18n:** `sent.share` ("Share" / "مشاركة"), `sent.shareText` ("I made you a gift 🎁" / "صنعت لك هدية 🎁").

**Verify:** open a Sent page on a phone (or Chrome device emulation doesn't expose share — use a real device / Safari), tap Share, see the OS sheet; dismiss it, no error toast.

---

## 2. Server-side gate for scheduled gifts (S)

**Why:** pays down the debt noted in `convex/schema.ts` — `getGift` currently returns `message`/`payload` in the network response while the gift is still sealed. Withhold them server-side until `openAfter` passes.

**Design:** gate on time in the query; use a scheduled "poke" write to make the reactive subscription refresh at the unlock moment (Convex queries don't re-run just because wall-clock time passes — only when a document they read changes).

**Changes:**

`convex/schema.ts`
- Add `unsealedAt: v.optional(v.number())` — its only job is to be a write that invalidates `getGift` subscriptions at unlock time.
- Update the `openAfter` ponytail comment: the gate is now server-side.

`convex/gifts.ts`
- `createGift`: after `ctx.db.insert`, if `openAfter` is set:
  ```ts
  await ctx.scheduler.runAt(openAfter, internal.gifts.unseal, { id });
  ```
- New `unseal` internalMutation: `ctx.db.patch(args.id, { unsealedAt: Date.now() })`.
- `getGift`:
  ```ts
  const sealed = gift.openAfter != null && gift.openAfter > Date.now();
  return {
    ...,
    message: sealed ? null : gift.message,   // null = sealed; "" stays a valid empty message
    payload: sealed ? null : (gift.payload ?? null),
    openAfter: gift.openAfter ?? null,       // still public — drives the countdown
  };
  ```
  Names, variants, lang stay public — the sealed scene shows them today.

`src/pages/GiftView.tsx`
- `message` is now `string | null`. Replace the client-clock lock with server truth:
  ```ts
  const locked = gift.openAfter != null && gift.message === null;
  ```
- Delete `mountNow` / `unlockedNow` / `unlock` / LockedSeal's `onUnlock` — the unseal poke pushes fresh data and `locked` flips by itself. LockedSeal keeps its 1 s ticker purely for the countdown text (clamped at 0 by `formatCountdown`).
- Pass `gift.message ?? ""` where scenes/RevealedMessage take a string (unreachable while sealed, but types).

**Migration:** rows created before this change with a still-future `openAfter` have no scheduled poke. A recipient who loads after unlock is fine (fresh query, fresh `Date.now()`); only a tab held open across the unlock moment would stall. One-shot fix: temporary `internalMutation` that scans for `openAfter > now` rows and schedules `unseal` for each; run once with `npx convex run`, then delete it. If prod has zero such rows (likely), skip.

**Edge cases:**
- Scheduler fires at-or-after `openAfter`, so the re-run always sees `sealed === false`. A few seconds of "in 0 seconds" countdown while the poke lands is acceptable.
- Client clock skew no longer matters — the lock is driven by data, not the device clock.

**Verify:** create a gift scheduled +2 min. DevTools → WS frames on the recipient page: `message` must be `null` while sealed. Keep the tab open across the unlock: countdown ends, unwrap button appears without a reload, message present.

---

## 3. Optional "email me when it's opened" (S + setup)

**Why:** senders currently only learn of the open if they revisit the Sent page.

**Prerequisite (manual):** Resend account, verify `assoli.site`, then `npx convex env set RESEND_API_KEY ...` (dev and prod). Plain `fetch` to Resend's API — no SDK, no component. Upgrade path if volume/retries ever matter: `@convex-dev/resend`.

**Changes:**

`convex/schema.ts`
- `notifyEmail: v.optional(v.string())` — PII. `getGift` and `getStatus` already whitelist their return fields; **never** add this one.

`convex/gifts.ts`
- `createGift`: optional `notifyEmail` arg. Validate: trim, ≤ 254 chars, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Store only if non-empty.
- `markOpened`: inside the existing first-open branch (`openedAt === undefined`), after the patch:
  ```ts
  if (gift.notifyEmail)
    await ctx.scheduler.runAfter(0, internal.email.sendOpened, {
      email: gift.notifyEmail, recipientName: gift.recipientName,
      statusKey: gift.statusKey, lang: gift.lang ?? "en",
    });
  ```
  Scheduling inside the mutation is transactional with the patch, and the `openedAt` guard already makes it once-only.

`convex/email.ts` (new)
- `sendOpened` internalAction: `fetch("https://api.resend.com/emails", ...)` with `Authorization: Bearer` from the env (declare `RESEND_API_KEY` in `convex/convex.config.ts` via `defineApp({ env: ... })` and read with `env` from `./_generated/server`, per Convex guidelines). Plain-text body by `lang`: "{recipientName} opened your gift 🎁" + link to `https://gift.assoli.site/sent/{statusKey}`. From: `Gift <gift@assoli.site>`. Log and swallow non-2xx — a lost email must never look like a failed open.
- No `"use node"` — `fetch` works in the default runtime.

`src/pages/Create.tsx`
- `<input type="email">` below the schedule block, with a one-line hint. Optional, not part of `canSubmit`. Pass trimmed value or `undefined`.

**i18n:** `create.notifyLabel` ("Email me when it's opened (optional)" / "أرسل لي بريدًا عند فتحها (اختياري)"), `create.notifyHint` ("One email, nothing else." / "بريد واحد فقط، لا شيء آخر.").

**Skipped (ponytail):** unsubscribe link and email deletion — it's a single transactional email to the address's owner; revisit if anyone complains. Rate limiting — `markOpened`'s once-only guard is the limiter.

**Verify:** create with your email, open the gift, receive exactly one email; open again / replay — no second email. Confirm a WS frame of `getGift` never contains `notifyEmail`.

---

## 4. Per-gift OG link previews (M)

**Why:** every shared link previews as the generic "Someone made you a gift 🎁". "Haitham made Sara a gift" is the whole pitch, visible before the tap.

**Design:** crawlers can't run the SPA, so serve them static HTML from a Convex HTTP endpoint. A `vercel.json` rewrite sends known crawler user-agents for `/g/:slug` to `https://<prod-deployment>.convex.site/g/:slug`; humans keep hitting the SPA. Vercel proxies, so the crawler sees the `gift.assoli.site` URL — share links don't change.

**Changes:**

`convex/http.ts` (new)
- `httpRouter` + one route: `{ pathPrefix: "/g/", method: "GET" }`.
- Handler: slug = last path segment → `ctx.runQuery(api.gifts.getGift, { slug })`. Unknown slug → same HTML with the current generic tags.
- Response `text/html; charset=utf-8`, `Cache-Control: public, max-age=300`, containing:
  - `<title>` + `og:title`: localized by `gift.lang` — en `"{sender} made {recipient} a gift 🎁"`, ar `"هدية من {sender} إلى {recipient} 🎁"`.
  - `og:description`: keep the generic "Tap to unwrap it." — the message is the surprise (and may be sealed).
  - `og:image`: the existing `https://gift.assoli.site/og-image.png`. `og:url`: `https://gift.assoli.site/g/{slug}`. `twitter:card: summary_large_image`.
  - `<meta http-equiv="refresh" content="0;url=https://gift.assoli.site/g/{slug}">` + a plain link — belt-and-braces for any human UA the regex catches.
- **HTML-escape `senderName`/`recipientName`** (`& < > " '`) — user input interpolated into HTML; this is the one non-negotiable security line in this feature.

`vercel.json`
- Crawler rule **before** the SPA catch-all (rewrites match in order):
  ```json
  {
    "rewrites": [
      {
        "source": "/g/:slug",
        "has": [{
          "type": "header", "key": "user-agent",
          "value": ".*(facebookexternalhit|Facebot|WhatsApp|Twitterbot|TelegramBot|Slackbot|Discordbot|LinkedInBot|Applebot|Pinterestbot|redditbot|SkypeUriPreview|Googlebot|bingbot).*"
        }],
        "destination": "https://<PROD-DEPLOYMENT>.convex.site/g/:slug"
      },
      { "source": "/(.*)", "destination": "/index.html" }
    ]
  }
  ```
  `<PROD-DEPLOYMENT>` = prod deployment name from the Convex dashboard (`.convex.site`, not `.convex.cloud`). Crawler UA tokens have stable casing — no case-insensitive flag needed.

**Skipped (ponytail):** per-gift OG images (rendering scene thumbnails server-side) — big; the static image plus a personalized title gets ~all the win. Add a per-gift-type static image later if wanted (one line in the handler, images in `public/`).

**Edge cases:** sealed gifts still show names (same as the sealed page itself). WhatsApp caches previews per-URL aggressively — test with fresh slugs, not by re-sharing one.

**Verify:**
- `curl -A "WhatsApp/2.0" https://gift.assoli.site/g/<slug>` → HTML with personalized `og:title`, names escaped (`curl` one with `<b>x</b>` as sender name).
- `curl https://gift.assoli.site/g/<slug>` (normal UA) → SPA `index.html`.
- Paste a fresh link into WhatsApp and one of opengraph.xyz / Facebook Sharing Debugger.

---

## 5. Voice-note attachment (L)

**Why:** a 30-second voice message is more personal than any visual polish; `payload` today is URL-only.

**Design:** MediaRecorder (native, zero deps) → blob → Convex file storage → signed URL in `getGift` → native `<audio controls>` in the reveal. Coexists with `payload`; both optional.

**Constants — `src/gifts/catalog.ts`** (shared client/server; touch `convex/gifts.ts` after editing):
- `VOICE_MAX_BYTES = 2_000_000`, `VOICE_MAX_SECONDS = 60`.

**Backend — `convex/schema.ts` + `convex/gifts.ts`:**
- Schema: `voiceId: v.optional(v.id("_storage"))`.
- New mutation `generateVoiceUploadUrl` (no args): `return ctx.storage.generateUploadUrl();`
  `// ponytail: unauthenticated upload URL, same trust level as createGift itself; rate-limit if abused.`
- `createGift`: optional `voiceId: v.id("_storage")` arg. Validate via `ctx.db.system.get(args.voiceId)`: exists, `contentType?.startsWith("audio/")`, `size <= VOICE_MAX_BYTES`; else throw.
- `getGift`: `voiceUrl: sealed || !gift.voiceId ? null : await ctx.storage.getUrl(gift.voiceId)` — reuses #2's `sealed`, so voice notes are sealed server-side from day one.

**Recorder — `src/components/VoiceRecorder.tsx` (new), used by `Create.tsx`:**
- Render nothing unless `navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"`.
- Mime pick, in order: `audio/mp4` (Safari + modern Chrome; AAC plays everywhere) else `audio/webm;codecs=opus` (Firefox/older Chrome).
  `// ponytail: webm recordings don't play on iOS < 17.4 recipients; transcode server-side if that support matrix ever matters.`
- States: idle → recording (60 s auto-stop timer, elapsed display) → recorded (`<audio controls>` preview from `URL.createObjectURL`, delete button). Stop mic tracks on stop. `getUserMedia` rejection → inline `t.create.micDenied`, back to idle.
- Exposes the blob to Create via `onChange(blob | null)` — one prop, no context.
- Upload happens in `handleCreate`, not on record-stop (re-records don't orphan files):
  ```ts
  let voiceId;
  if (voiceBlob) {
    const url = await generateVoiceUploadUrl();
    const res = await fetch(url, { method: "POST",
      headers: { "Content-Type": voiceBlob.type }, body: voiceBlob });
    ({ storageId: voiceId } = await res.json());
  }
  ```

**Reveal — `src/pages/GiftView.tsx`:** in `RevealedMessage`, above the payload block:
```tsx
{voiceUrl && <audio controls src={voiceUrl} className="mt-6 w-full" />}
```
Native controls; no custom player.

**i18n:** `create.voiceLabel` ("Add a voice note (optional)" / "أضف رسالة صوتية (اختياري)"), `create.record` ("Record" / "تسجيل"), `create.stop` ("Stop" / "إيقاف"), `create.rerecord` ("Delete & re-record" / "حذف وإعادة التسجيل"), `create.micDenied` ("Microphone access was blocked." / "تم حظر الوصول إلى الميكروفون.").

**Skipped (ponytail):** waveform UI, pause/resume, orphaned-upload cleanup (abandoned drafts leak ≤2 MB files; add a monthly cron deleting `_storage` files unreferenced by any gift if it ever adds up), duration check server-side (size cap is the real guard).

**Verify:** record → preview → re-record → send on Chrome desktop, Android Chrome, iOS Safari. Cross-play: record on each, open on the others. Confirm a sealed scheduled gift has `voiceUrl: null` in the WS frame until unlock. Try a 3 MB non-audio POST to the upload URL followed by createGift → rejected.

---

## Rollout

1. #2 first — it changes `getGift`'s shape (`message: string | null`); #4 and #5 build on the `sealed` flag.
2. #1 and #3 any time, independent.
3. #4 needs the prod deployment name in `vercel.json`; test on a preview deploy with curl before merging.
4. #5 last — biggest surface (mic UX × 3 browsers).
