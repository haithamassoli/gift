# Gift — 3D Gifts You Send as a Link

A web app for sending beautiful animated 3D gifts. Sender picks a gift from a gallery, personalizes it (names, message, gift-specific variants), and gets a shareable link. Recipient opens the link and taps to "unwrap": a themed Three.js animation plays and reveals the message. No accounts, free, mobile-first. Convex stores gift instances; the gift catalog is a code registry.

## Stack

- Vite + React + TypeScript
- three.js via `@react-three/fiber` + `@react-three/drei`
- Convex (database + functions)
- All 3D is procedural (geometry, materials, shaders, particles) — no external model/texture assets

## User flows

**Sender:** browse gallery → pick gift → set variants + sender name, recipient name, message (live 3D preview updates) → Create → gets public share link `/g/:slug` + private status page `/sent/:statusKey` showing live "Opened ✓" (Convex reactivity).

**Recipient:** opens `/g/:slug` → sealed scene ("A gift for {recipientName} — from {senderName}") → tap to unwrap → gift-specific opening animation → main animation + message reveal. Replayable; first unwrap sets `openedAt`. Message also rendered as selectable HTML text below the canvas.

## Routes

| Route | Purpose |
|---|---|
| `/` | Gallery: card per gift with live 3D preview (render only when scrolled into view) |
| `/create/:giftType` | Personalization form + live preview |
| `/sent/:statusKey` | Share link + copy button + live opened status |
| `/g/:slug` | Recipient unwrap experience |

## Gift catalog (code registry)

Each gift = one code-split module implementing:

```ts
interface GiftDef {
  id: string;
  name: string;
  tagline: string;
  variants: { key: string; label: string; options: { value: string; label: string }[] }[];
  Scene: FC<{
    variants: Record<string, string>;
    phase: "preview" | "sealed" | "opening" | "revealed";
    senderName: string; recipientName: string; message: string;
    onOpenComplete?: () => void;
  }>;
}
```

Every gift has its own themed seal/unwrap — no generic gift box.

| id | Sealed → unwrap | Main animation | Variants |
|---|---|---|---|
| `eternal-rose` | Glass dome lifts | Rose blooms petal by petal, drifting light motes | petal color: red / white / midnight-gold |
| `birthday-cake` | Candles ignite one by one | Tap flames to blow out → confetti burst | frosting: chocolate / strawberry / vanilla; candles: 1–24 |
| `balloon-bunch` | Balloons inflate | Bunch lifts a tag carrying the message into the sky | palette: warm / pastel / gold; count: 7 / 12 / 20 |
| `snow-globe` | Globe fades in on pedestal | Drag to shake — particles swirl around miniature scene; message on base plaque | scene: cabin / pine forest / heart; particles: snow / stardust |
| `fireworks` | First rocket launches on tap | Bursts spell the message over water; extra taps launch more | palette: festival / rose-gold / neon |
| `message-bottle` | Waves carry bottle ashore | Cork pops, parchment unrolls with message | time: sunset / night / dawn |
| `constellation` | First star ignites | Stars connect into a shape; message shimmers below | shape: heart / star / infinity |
| `butterfly-jar` | Jar lid unscrews | Glowing butterflies escape and swirl into the message | glow: aqua / violet / amber |
| `music-box` | Lid opens | Figurine rotates, sparkles pulse to a soft chime loop (WebAudio, starts on tap) | figurine: ballerina / heart / moon |
| `lantern-sky` | Lanterns ignite | Lanterns rise carrying the message letters | color: amber / crimson / jade |
| `golden-locket` | Heart locket unclasps | Opens to engraved names + message | metal: gold / silver / rose-gold |
| `aurora` | Sky darkens over snowfield | Aurora ribbons form; message glows within the lights | palette: emerald / magenta / ice |

## Data model (Convex)

```ts
gifts: defineTable({
  giftType: v.string(),                        // registry key
  senderName: v.string(),                      // ≤ 40 chars
  recipientName: v.string(),                   // ≤ 40 chars
  message: v.string(),                         // ≤ 280 chars
  variants: v.record(v.string(), v.string()),  // keys/values validated against registry
  slug: v.string(),                            // public id for /g/:slug
  statusKey: v.string(),                       // private id for /sent/:statusKey
  openedAt: v.optional(v.number()),
})
  .index("by_slug", ["slug"])
  .index("by_statusKey", ["statusKey"])
```

Functions:

- `createGift` (mutation): server-side validation — giftType exists in registry, variant keys/values legal, length caps; generates random `slug` + `statusKey`; returns both.
- `getGift` (query, by slug): returns public fields only — never `statusKey`.
- `markOpened` (mutation, by slug): sets `openedAt` if unset.
- `getStatus` (query, by statusKey): returns `openedAt` + share slug (reactive).

## Non-functional

- Mobile-first: touch primary, responsive canvas, DPR capped at 2, target 60fps on mid-range phones.
- One `<Canvas>` per page; gift scenes lazy-loaded (dynamic import per registry entry).
- `prefers-reduced-motion`: skip to `revealed` phase with static scene.
- Audio only after user gesture (autoplay policy).
- Static OG tags site-wide: "Someone made you a gift 🎁" (no per-gift SSR).
- Server-side validation in Convex is the trust boundary; client validation is UX only.

## Out of scope (v1)

Accounts, payments, email delivery, editing after send, link expiry, content moderation, analytics, i18n, custom asset uploads, per-gift OG images, push notifications.
