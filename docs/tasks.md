# Tasks

Execution plan for [PRD.md](PRD.md). Milestones are sequential; each ends demonstrable. Work top to bottom.

## M1 — Walking skeleton (one gift end-to-end)

**Done:** on a phone-size viewport, create a rose gift, open its link, unwrap it, watch the sender status flip to "Opened ✓" live.

- [x] Read `convex/_generated/ai/guidelines.md`, then install deps: `three`, `@react-three/fiber`, `@react-three/drei`, `react-router`
- [x] Convex schema: `gifts` table with `by_slug` + `by_statusKey` indexes per PRD
- [x] `createGift` mutation: validate giftType against registry, variant keys/values, length caps (names ≤40, message ≤280); generate random `slug` + `statusKey`
- [x] `getGift` query (public fields only, never `statusKey`), `markOpened` mutation (first open only), `getStatus` query (reactive `openedAt` + slug)
- [x] Gift registry: `GiftDef` interface per PRD, registry map, lazy-loaded `Scene` modules
- [x] `eternal-rose` gift: all four phases (preview / sealed / opening / revealed), dome-lift unwrap, petal-by-petal bloom, light motes, 3 petal-color variants
- [x] Minimal pages for all four routes: `/`, `/create/:giftType`, `/sent/:statusKey`, `/g/:slug`
- [x] Wire flow: create → redirect to sent page → open share link → tap-to-unwrap → `markOpened` → status updates live

## M2 — Sender & recipient UX

**Done:** with one gift, the site feels like a finished product.

- [x] Gallery: card per registry entry (name, tagline), 3D preview rendered only when scrolled into view
- [x] Create page: variant pickers generated from registry, name/message inputs with visible char caps, live preview reflects every change
- [x] Sent page: copy-link button, live "Opened ✓" state, "make another" link
- [x] Recipient page: sealed intro ("A gift for {recipient} — from {sender}"), clear tap target, replay after reveal, message rendered as selectable HTML below the canvas
- [x] Loading states everywhere; friendly not-found page for bad slug/statusKey

## M3 — Gift catalog

**Done:** all 12 gifts live, each implementing the same phase/variant contract. Spec for each = PRD catalog table (sealed/unwrap, main animation, variants). Riskiest first.

- [x] `fireworks` — bursts must legibly spell the message (hardest: text from particles); tap launches extras
- [x] `snow-globe` — drag-to-shake gesture drives particle swirl
- [x] `birthday-cake` — per-flame tap targets to blow out candles; confetti burst; candle count 1–24
- [x] `constellation` — stars connect into heart / star / infinity; shimmer text
- [x] `butterfly-jar` — lid unscrews; glowing swarm forms the message
- [x] `lantern-sky` — lanterns rise carrying message letters
- [x] `balloon-bunch` — inflate, lift message tag; palette + count variants
- [x] `message-bottle` — shore waves, cork pop, parchment unroll
- [x] `music-box` — lid opens, figurine spins; WebAudio chime loop (starts on tap)
- [x] `golden-locket` — unclasp, open to engraved names; metal variants
- [x] `aurora` — shader ribbons over snowfield; message glows within
- [x] Registry/gallery updated as each lands; every gift verified in all four phases + both viewports

## M4 — Hardening

**Done:** smooth on a mid-range phone, accessible, no dead weight.

- [x] `prefers-reduced-motion`: shared wrapper skips straight to static `revealed` phase
- [x] Perf pass: DPR capped at 2, 60fps target on mid phone, rendering paused when tab hidden or canvas offscreen
- [x] Audio only after user gesture (music-box, fireworks); no autoplay errors in console
- [x] Code-splitting verified: opening one gift loads only that gift's module (check network tab)
- [x] Static OG tags: "Someone made you a gift 🎁"
- [x] Sweep all 12 gifts on small-phone portrait + desktop: text legible, tap targets reachable, no clipping

## M5 — Ship

**Done:** production link works end-to-end.

- [x] Typecheck, lint, production build all clean
- [ ] Deploy Convex prod + static hosting; env vars set — Convex prod deployed (enchanted-cardinal-983) and the build is wired to it; static hosting pending: no hosting CLI is authenticated on this machine
- [x] Prod smoke test: create + unwrap one gift of each of the 12 types
