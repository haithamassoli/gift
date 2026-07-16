# Feature Plan — 7 additions (no new gifts)

Scope: the seven features agreed on 2026-07-16, ordered here by **implementation order**
(dependencies + risk), not by value. All schema changes are additive `v.optional(...)`
fields — no migration needed, old rows keep working.

| # | Feature | Size | Depends on |
|---|---------|------|-----------|
| F5 | Sender preview that doesn't trip the open receipt | S | — |
| F1 | Photo upload attachment | M | — |
| F3 | "Send it for me" — email recipient at unlock | M | — |
| F2 | Thank-you reply from recipient | M | F5 |
| F7 | Burn after reading (fade 24 h after opening) | M | F1 |
| F4 | Sent-gifts history on the homepage | S | — |
| F6 | QR code on the sent page | S | — |

## Ground rules (apply to every feature)

- Read `convex/_generated/ai/guidelines.md` before touching `convex/` (CLAUDE.md rule).
- Every user-facing string goes into **both** `en` and `ar` in `src/i18n.tsx`. Flag new
  Arabic copy for review; don't ship machine-guess Arabic silently.
- PII discipline: `notifyEmail` and the new `recipientEmail` are **never** returned by
  `getGift`/`getStatus`.
- Dev gotcha: the Convex watcher misses edits under `src/` — after changing
  `src/gifts/catalog.ts`, `touch convex/gifts.ts`.
- Test on the dev deployment (`.env.local`) first; prod is `enchanted-cardinal-983`.
- Verification: `npm run lint` + the manual checklist at the end of each feature.

---

## F5 — Sender preview without burning the receipt

**Problem:** `/sent`'s "See it as they will" link opens the real `/g/[slug]`; if the
sender taps Unwrap, `markOpened` fires → receipt shows Opened and the notify email goes
out. Must land before F2 (a sender previewing must not be able to "reply to themselves").

**Changes**

- `src/app/sent/[statusKey]/page.tsx`: preview link → `` `${shareUrl}?preview=1` ``.
- `src/app/g/[slug]/page.tsx`: read the flag once at mount, same pattern as `canShare`
  in the sent page (avoids the `useSearchParams` Suspense requirement — the link is
  `target="_blank"`, always a full load):

  ```ts
  const [isPreview] = useState(
    () => typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("preview"),
  );
  ```

  - In `unwrap()`: skip `markOpened` when `isPreview`.
  - Show a small fixed "Preview" badge so the sender knows the receipt is safe.
  - (After F2) hide the reply box when `isPreview`.
- i18n: `gift.previewBadge`.

**Accepted limitation:** a recipient who hand-adds `?preview=1` opens without a receipt.
The receipt is already best-effort (client-triggered) — fine.

**Verify:** open preview link → unwrap → `/sent` still says "Not opened yet", no email.
Open the clean link → receipt flips reactively.

---

## F1 — Photo upload attachment

**Why first among the big ones:** normal people don't have image URLs. The voice-note
pipeline is 95 % of the work — clone it.

**Backend**

- `src/gifts/catalog.ts`: `export const PHOTO_MAX_BYTES = 5_000_000;`
- `convex/schema.ts`: `photoId: v.optional(v.id("_storage"))`.
- `convex/gifts.ts`:
  - Rename `generateVoiceUploadUrl` → `generateUploadUrl` (it's already generic; only
    the create page calls it).
  - `createGift`: accept `photoId: v.optional(v.id("_storage"))`; validate via
    `ctx.db.system.get` — `contentType?.startsWith("image/")` and
    `size <= PHOTO_MAX_BYTES` (mirror the voice check).
  - `getGift`: return `photoUrl` — `null` while sealed or absent, else
    `ctx.storage.getUrl(photoId)` (mirror `voiceUrl`).

**Frontend**

- `src/app/create/[giftType]/page.tsx` (extras section):
  - Native `<input type="file" accept="image/*">` — mobile browsers offer camera free.
    Hold the `File` in state; thumbnail via `URL.createObjectURL` (revoke on change).
  - On submit: if a photo is set, upload exactly like the voice blob (same
    `generateUploadUrl` → POST → `storageId` dance), pass `photoId`.
  - Client-side guard: reject files > `PHOTO_MAX_BYTES` with an inline error before
    uploading. Skipped: client-side downscaling — add if 5 MB uploads feel slow.
  - Relabel the existing URL field to "Add a link" (`create.attachment` copy change);
    the photo input gets its own label. Both may coexist on one gift.
- `src/app/g/[slug]/page.tsx` → `RevealedMessage`: new `photoUrl` prop, render an
  `<img>` (same styling as the `IMAGE_RE` payload image), above the payload block.
  Keep the `IMAGE_RE` fallback — old gifts with image URLs still render.

**i18n:** `create.photoLabel`, `create.photoTooBig`, `create.photoRemove`.

**Verify:** create with photo (phone camera + desktop file) → unwrap shows it; sealed
gift returns `photoUrl: null` in the network response until unlock; >5 MB rejected
client- and server-side.

---

## F3 — "Send it for me" (email the recipient at unlock)

**Scope decision:** scheduled gifts only. An unscheduled gift is shared by hand — the
gap is the sender forgetting at unlock time. Server enforces this.

**Backend**

- `convex/schema.ts`: `recipientEmail: v.optional(v.string())` — PII comment like
  `notifyEmail`'s.
- `convex/gifts.ts` `createGift`:
  - Accept `recipientEmail: v.optional(v.string())`, validate with the existing
    `EMAIL_RE`.
  - Reject (throw) if `recipientEmail` is set but the resolved `openAfter` is absent —
    crisp semantics at the trust boundary, and the UI never produces that combination.
- `convex/gifts.ts` `unseal`: after the patch, if the gift has `recipientEmail`,
  `ctx.scheduler.runAfter(0, internal.email.sendGiftLink, { email, recipientName,
  senderName, slug, lang })`.
- `convex/email.ts`:
  - Hoist the `esc` / `wrap` / `button` helpers to module scope (shared by both actions).
  - New `sendGiftLink` internalAction: link `https://gift.assoli.site/g/${slug}`,
    subject ≈ "Someone made you a gift 🎁" (en/ar), body: sender name + button. Same
    Resend call + error-log-and-continue pattern.

**Frontend**

- Create page, inside the `scheduled` block only: email input + hint
  "We'll email them the link when it unlocks (optional)". Clear it when scheduling is
  toggled off (so the server never sees email-without-schedule).

**i18n:** `create.recipientEmailLabel`, `create.recipientEmailHint`.

**Verify:** schedule a gift 2 min out with a real inbox → email arrives at unlock with
a working link. Unscheduled + email via devtools-forged mutation → server throws.

---

## F2 — Thank-you reply

**Backend**

- `convex/schema.ts`: `reply: v.optional(v.string())`, `repliedAt: v.optional(v.number())`.
- `convex/gifts.ts` new `sendReply` mutation `{ slug, reply }`:
  - Gift must exist, `openedAt` must be set, `reply` not already set (write-once),
    trimmed length 1..`MESSAGE_MAX`. Throw otherwise.
- `getGift`: also return `reply` (so a returning recipient sees "You replied" instead
  of an empty box). Same trust model as `message` — anyone with the slug link.
- `getStatus`: also return `reply` and `repliedAt`.
- Optional (recommended, small): if the gift has `notifyEmail`, `markOpened`-style
  schedule a `sendReplied` email from `sendReply` — otherwise senders who never revisit
  `/sent` never see the reply. Reuses the F3 helpers; one more template.

**Frontend**

- `/g/[slug]` `RevealedMessage`: after the message block —
  - `gift.reply` set → render it read-only ("You sent thanks: …").
  - else (and not `isPreview` from F5) → textarea (`maxLength = MESSAGE_MAX`) + send
    button → `sendReply` → swap to the read-only state (Convex reactivity re-renders
    via `getGift` anyway).
- `/sent/[statusKey]`: when `status.reply` is set, show it as a quoted block under the
  Opened line — reactive for free.

**i18n:** `gift.replyLabel`, `gift.replyPlaceholder`, `gift.replySend`, `gift.replySent`,
`sent.replyHeading`.

**Verify:** unwrap → reply → appears live on an already-open `/sent` tab; second reply
attempt (forged mutation) throws; reply box absent in `?preview=1` and before opening.

---

## F7 — Burn after reading

**Design:** fixed 24 h fade after opening; the row survives so the sender's receipt
stays intact — content is scrubbed, not the document.
`// ponytail: fixed 24h, make it a duration field if anyone asks`.

**Backend**

- `convex/schema.ts`: `burnAfterOpen: v.optional(v.boolean())`,
  `burnedAt: v.optional(v.number())`.
- `convex/gifts.ts`:
  - `createGift`: accept `burnAfterOpen: v.optional(v.boolean())`, store when true.
  - `markOpened`: inside the first-open branch, if `gift.burnAfterOpen`, schedule
    `internal.gifts.burn` via `ctx.scheduler.runAfter(24 * 60 * 60 * 1000, …, { id })`.
  - New `burn` internalMutation: delete storage blobs (`ctx.storage.delete` for
    `voiceId` and `photoId` when present), then patch
    `{ message: "", payload: undefined, voiceId: undefined, photoId: undefined,
    burnedAt: Date.now() }` (patching `undefined` unsets the field).
  - `getGift`: return `burned: gift.burnedAt != null` and `burnsAfterOpen:
    gift.burnAfterOpen ?? false` (lets the sealed overlay warn the recipient).
- Do **not** delete the row: `getStatus` receipt (openedAt, reply) survives the burn.

**Frontend**

- Create page extras: checkbox "Make it fade 24 hours after opening".
- `/g/[slug]`: if `gift.burned` → `<NotFound heading={t.gift.burnedHeading}
  copy={t.gift.burnedCopy} />` (NotFound already takes these props). While sealed/unopened
  and `burnsAfterOpen`, show a one-line hint under the unwrap button.

**i18n:** `create.burnLabel`, `gift.burnedHeading`, `gift.burnedCopy`, `gift.burnHint`.

**Verify:** (dev) temporarily shorten the delay to 1 min → open a gift with voice+photo →
after burn: page shows faded state, storage blobs gone (Convex dashboard), `/sent` still
shows Opened + reply. One `convex-test` for the gates worth writing here — see Testing.

---

## F4 — Sent-gifts history (device-local, no auth)

**Backend** — one bounded batch query in `convex/gifts.ts`:

```ts
export const getStatuses = query({
  args: { statusKeys: v.array(v.string()) },  // cap: throw if > 50
  handler: // per key: by_statusKey lookup → { statusKey, openedAt: … ?? null }
});
```

Returns only `openedAt` per key — nothing else leaves the server that `getStatus`
wouldn't already give a key-holder.

**Frontend**

- `src/app/create/[giftType]/page.tsx`: on successful create, prepend
  `{ statusKey, recipientName, giftType, createdAt: Date.now() }` to
  `localStorage["gift.sent.v1"]`, capped at 50 entries. Wrap in try/catch (private
  browsing quota).
- `src/app/page.tsx`: load the list in a `useEffect` into state (avoids hydration
  mismatch — the page is SSR'd). When non-empty, render a "Gifts you've sent" section
  under the grid: gift name (via `registry`), recipient, relative date, Opened ✓ from
  one `useQuery(api.gifts.getStatuses, …)`, each row linking to `/sent/[statusKey]`.
  Include a small "Clear history" button (statusKeys are secrets; shared devices).

Skipped: accounts/sync — localStorage covers the need until someone asks for
cross-device.

**i18n:** `home.sentHeading`, `home.sentOpened`, `home.sentNotOpened`, `home.sentClear`.

**Verify:** create two gifts → both listed with correct names; open one → ✓ appears
reactively; clear works; incognito (no storage) renders the homepage unchanged.

---

## F6 — QR code on the sent page

**Dependency:** `qrcode.react` (zero-dep, maintained, SVG output). Justified under the
ladder: no installed dep or platform feature renders QR, and hand-rolling an encoder is
~500 lines. External QR-image APIs are ruled out — they'd leak the private link to a
third party.

**Frontend** — `src/app/sent/[statusKey]/page.tsx`, under the URL box:

```tsx
<div className="mx-auto w-fit rounded-2xl bg-white p-3">
  <QRCodeSVG value={shareUrl} size={144} />
</div>
```

White backing plate is required — scanners need a light background + quiet zone on this
dark theme. Caption: "Print it, tuck it in the box." Skipped: dedicated print button —
browser print already works.

**i18n:** `sent.qrHint`.

**Verify:** scan from a phone camera on both a laptop screen and a printout → lands on
`/g/[slug]`.

---

## Testing

Manual checklists above are the bulk. One automated check earns its keep: a single
`convex/gifts.test.ts` (convex-test + vitest + `@edge-runtime/vm`, per guidelines)
covering the new server gates — reply requires opened + write-once, recipientEmail
requires openAfter, burn scrubs fields but preserves the receipt, photo validation
rejects non-images. Skip UI tests.

## Rollout

1. Ship F5 alone (guards the receipt everything else leans on).
2. F1 → F3 → F2 → F7 as one sequence of small PRs — each is independently shippable;
   deploy Convex (dev) with each since schema fields are additive.
3. F4 and F6 any time, in parallel — they touch no schema (F4's query is read-only).
4. `npx convex deploy` to prod (`enchanted-cardinal-983`) after each feature verifies
   on dev, not as one big-bang release.
