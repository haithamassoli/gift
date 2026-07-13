# Tasks

Execution plan for [PRD.md](PRD.md). Milestones are sequential; each ends demonstrable. Work top to bottom.

## M1 — Walking skeleton (one gift end-to-end)

**Done:** on a phone-size viewport, create a rose gift, open its link, unwrap it, watch the sender status flip to "Opened ✓" live.

- [ ] Read `convex/_generated/ai/guidelines.md`, then install deps: `three`, `@react-three/fiber`, `@react-three/drei`, `react-router`
- [ ] Convex schema: `gifts` table with `by_slug` + `by_statusKey` indexes per PRD
- [ ] `createGift` mutation: validate giftType against registry, variant keys/values, length caps (names ≤40, message ≤280); generate random `slug` + `statusKey`
- [ ] `getGift` query (public fields only, never `statusKey`), `markOpened` mutation (first open only), `getStatus` query (reactive `openedAt` + slug)
- [ ] Gift registry: `GiftDef` interface per PRD, registry map, lazy-loaded `Scene` modules
- [ ] `eternal-rose` gift: all four phases (preview / sealed / opening / revealed), dome-lift unwrap, petal-by-petal bloom, light motes, 3 petal-color variants
- [ ] Minimal pages for all four routes: `/`, `/create/:giftType`, `/sent/:statusKey`, `/g/:slug`
- [ ] Wire flow: create → redirect to sent page → open share link → tap-to-unwrap → `markOpened` → status updates live

## M2 — Sender & recipient UX

**Done:** with one gift, the site feels like a finished product.

- [ ] Gallery: card per registry entry (name, tagline), 3D preview rendered only when scrolled into view
- [ ] Create page: variant pickers generated from registry, name/message inputs with visible char caps, live preview reflects every change
- [ ] Sent page: copy-link button, live "Opened ✓" state, "make another" link
- [ ] Recipient page: sealed intro ("A gift for {recipient} — from {sender}"), clear tap target, replay after reveal, message rendered as selectable HTML below the canvas
- [ ] Loading states everywhere; friendly not-found page for bad slug/statusKey

## M3 — Gift catalog

**Done:** all 12 gifts live, each implementing the same phase/variant contract. Spec for each = PRD catalog table (sealed/unwrap, main animation, variants). Riskiest first.

- [ ] `fireworks` — bursts must legibly spell the message (hardest: text from particles); tap launches extras
- [ ] `snow-globe` — drag-to-shake gesture drives particle swirl
- [ ] `birthday-cake` — per-flame tap targets to blow out candles; confetti burst; candle count 1–24
- [ ] `constellation` — stars connect into heart / star / infinity; shimmer text
- [ ] `butterfly-jar` — lid unscrews; glowing swarm forms the message
- [ ] `lantern-sky` — lanterns rise carrying message letters
- [ ] `balloon-bunch` — inflate, lift message tag; palette + count variants
- [ ] `message-bottle` — shore waves, cork pop, parchment unroll
- [ ] `music-box` — lid opens, figurine spins; WebAudio chime loop (starts on tap)
- [ ] `golden-locket` — unclasp, open to engraved names; metal variants
- [ ] `aurora` — shader ribbons over snowfield; message glows within
- [ ] Registry/gallery updated as each lands; every gift verified in all four phases + both viewports

## M4 — Hardening

**Done:** smooth on a mid-range phone, accessible, no dead weight.

- [ ] `prefers-reduced-motion`: shared wrapper skips straight to static `revealed` phase
- [ ] Perf pass: DPR capped at 2, 60fps target on mid phone, rendering paused when tab hidden or canvas offscreen
- [ ] Audio only after user gesture (music-box, fireworks); no autoplay errors in console
- [ ] Code-splitting verified: opening one gift loads only that gift's module (check network tab)
- [ ] Static OG tags: "Someone made you a gift 🎁"
- [ ] Sweep all 12 gifts on small-phone portrait + desktop: text legible, tap targets reachable, no clipping

## M5 — Ship

**Done:** production link works end-to-end.

- [ ] Typecheck, lint, production build all clean
- [ ] Deploy Convex prod + static hosting; env vars set
- [ ] Prod smoke test: create + unwrap one gift of each of the 12 types
