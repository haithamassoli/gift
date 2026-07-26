# New Gifts — Batch 4 Plan (Couples)

Ten gift concepts for **two people**, extending the [PRD catalog](PRD.md), [Batch 2](new-gifts.md) and [Batch 3](new-gifts-3.md). Same contract: `preview / sealed / opening / revealed`, procedural-only 3D, EN + AR, 60fps on a mid phone. Five creative-and-unique, five funny.

**Curation point of view** (what Batch 4 adds that 1–3 don't have):

1. **Two names, not from-and-to.** Every earlier gift treats `senderName` as a signature at the bottom. Batch 4 treats the pair as the subject: both names on the coin, both prints in the clay, both on the jumbotron. No schema change — the same two fields, read as a couple instead of an envelope.
2. **The object is incomplete alone.** The half-coin says nothing by itself, one shadow is not a scene, one bird can't build a nest. The reveal isn't "the words appear", it's "the two halves meet and *then* the words appear". That's a genuinely new reveal shape for the catalog, which has so far only ever assembled words out of particles, grids, and strokes.
3. **The joke is in the mechanic, never in the message.** The sender writes the message and we cannot assume they're funny. So the humour has to survive a completely sincere message: the rock still does nothing, the reels still run out of excuses, the dinner is still cremated. Five gifts that are funny *before* the sender types a word.

## Summary

| id | Signature gesture | Sealed → unwrap | Reveal | Variants |
|---|---|---|---|---|
| `henna` | Trace the paste, wait, rub it off | Henna night — bowl, cone, a bare hand on silk | Dried paste flakes away under the thumb; the stain underneath is the message, both names in the palm | pattern: khaleeji / moroccan / floral; stain: henna / umber / black-cherry |
| `two-halves` | Drag your half to meet theirs | One sawn half of an old coin, spotlit on velvet | The halves close, the seam heals gold, and the split inscription finally reads | metal: gold / silver / copper; engraving: kufic / diwani / laurel |
| `shadow-play` | Drag a puppet across the screen | Lit linen screen, one jointed silhouette waiting | Two shadows meet, overlap, and the overlap resolves into the message | lamp: oil / candle / gas; screen: linen / silk / paper |
| `fingerprint` | Press and hold a thumb | Slab of wet clay, one print already in it | Your ridges settle beside theirs; where the two prints touch, the shared lines spell the message | medium: clay / ink / plaster; ridges: gold / ember / indigo |
| `nest` | Swipe to send the pair out | Bare branch at first light, two birds, no nest | Twig by twig the nest is built — the twigs ARE the strokes of the words | bird: bulbul / swallow / sparrow; light: dawn / golden / dusk |
| `pet-rock` | Pet it (rub) | A rock. In a box. With eyes. | It blinks, wobbles, purrs, and finally rolls over — message on its belly, adoption papers in both names | rock: granite / sandstone / geode; eyes: googly / sleepy / heart |
| `scoreboard` | Tap the clicker | Split-flap board: "WHO'S RIGHT — YOU 47 / ME 3" | Flaps clatter; their score climbs, the sender's never moves; the board gives up and flips the message | finish: cream / navy / chrome |
| `excuse-machine` | Pull the lever | Slot machine, three reels of excuses | Reels never line up; on the third pull the machine gives up and drops the truth | cabinet: chrome / cherry / brass; reels: fruit / hearts / question marks |
| `burnt-dinner` | Lift the cloche | Silver dome on a set table, one thin wisp of smoke | Smoke pours out, dinner is cremated, message written in the char — takeout menu underneath | dish: roast / cake / pasta; kitchen: cozy / marble / candlelit |
| `big-screen` | Drag to pan the camera | Packed stadium at night, big screen showing ads | The camera sweeps past you twice, finds you on the third, and 60,000 people see both names | stadium: floodlit / sunset / indoor; frame: hearts / confetti / fireworks |

---

## Pair tier — one object, two people

### `henna` — Henna Night / ليلة الحنّة

> "Trace the paste, then wait — the stain remembers" / «انقش الحنّاء ثم انتظر، فالأثر يتذكّر»

- **Why special:** the henna night is *the* couples ritual across the region, and it has a built-in three-act structure the catalog has never used: apply, wait, remove. The message isn't drawn — it's what's left behind after something is taken away. Batch 4's flagship, and the only gift in the catalog where waiting is part of the gesture.
- **Sealed:** a low table on patterned silk — a bowl of green paste, a rolled cone, a bare hand resting palm-up, warm lamps, faint drum in the distance.
- **Opening:** drag the cone along a faint ghost pattern; paste lays down in raised beads behind the finger. When the pattern closes, it darkens and cracks as it dries (a held beat — the only enforced pause in the catalog). Then rub with the thumb: dried flakes fall away.
- **Revealed:** under the flakes, the stain — deep and slightly bled into the skin, the way real henna sits. The palm motif resolves into the message, both names hidden in the fingertip patterns. A last flake drops.
- **Variants:** `pattern` النقش: khaleeji خليجي / moroccan مغربي / floral زهري · `stain` الأثر: henna حنّائي / umber بنّي داكن / black-cherry كرزي
- **Feasibility:** low-medium, all in `mask.ts` — apply paints the mask (`paintWritePath` ghost path), rub *erases* a second mask, and the stain is the layer beneath. Two inverse uses of one existing util, exactly like `scratch-card` / `foggy-mirror`. The drying crack is a noise threshold on the same mask. Reduced motion: pre-stained, one flake falling.

### `two-halves` — Two Halves / نصفان

> "Half a coin says nothing alone" / «نصف القطعة لا يقول شيئًا وحده»

- **Why special:** the purest statement of the batch thesis, and the cheapest gift in it. The message is *physically* unreadable in the sealed state — the sender's half is off-screen — so the reveal isn't decoration, it's the only way to read the thing. Old habit, too: split coins as tokens of return go back to antiquity.
- **Sealed:** a single sawn half-coin on dark velvet, tarnished, one hard spotlight, torn edge toward camera. Half-glyphs run off the cut.
- **Opening:** drag your half toward the centre. The other half slides in from off-frame to meet it — magnetically, faster as they close. They kiss with a clean chime.
- **Revealed:** the seam heals in a running line of gold (kintsugi-adjacent, deliberately), the coin rises and turns once, and the inscription — split down the middle until now — reads whole. Both names on the rim, no date, no year.
- **Variants:** `metal` المعدن: gold ذهب / silver فضة / copper نحاس · `engraving` النقش: kufic كوفي / diwani ديواني / laurel غار
- **Feasibility:** **lowest risk in the batch** — two lathe half-discs, one `makeTextTexture` split across both UV sets, a gold emissive line along the seam. Ship it first if the gallery needs a couples entry fast. Arabic is easier here than Latin: the cut falls between connected letter groups.

### `shadow-play` — Shadow Play / خيال الظلّ

> "Two shadows, one story" / «ظلّان، وحكاية واحدة»

- **Why special:** خيال الظل is centuries-old Arab/Ottoman theatre — jointed leather puppets behind a lit sheet — and it is the only art form built entirely out of *two figures meeting*. The reveal writes with absence: the words are where the light isn't.
- **Sealed:** a taut linen screen lit from behind, one jointed silhouette waiting at the edge, dust drifting through the beam, the lamp guttering.
- **Opening:** drag your puppet across the screen. The second one walks in to meet it — jointed limbs swinging on scripted hinges, the shadows growing soft or hard as they move toward and away from the lamp.
- **Revealed:** the two silhouettes overlap; the overlap doesn't darken — it *resolves*, the combined outline reading as the message in shadow. Both names appear in the two puppets' rod-shadows below. The lamp steadies.
- **Variants:** `lamp` المصباح: oil زيتي / candle شمعة / gas غازي · `screen` الستارة: linen كتّان / silk حرير / paper ورق
- **Feasibility:** medium — do **not** use shadow maps on alpha-tested cutouts, they fringe badly. Render the puppets to a render target and project it, exactly the light-cookie approach `fanous` uses; the screen is one quad. Puppets are flat cut-outs with three hinges. Reduced motion: puppets pre-met, message already in the overlap.

### `fingerprint` — Two Prints / بصمتان

> "Press once — the lines already match" / «اضغط مرّة، فالخطوط متطابقة من البداية»

- **Why special:** the most modern object in a catalog full of heritage ones, and the most intimate — a fingerprint is the one mark that is only ever yours. Two of them touching, with the shared ridges carrying the words, is a better wedding-ring metaphor than a wedding ring.
- **Sealed:** a slab of wet grey clay under a work lamp, one thumbprint already pressed into the left side, ridges catching the light.
- **Opening:** press and hold anywhere on the right — the clay yields under the touch with a soft squash, ridges rolling out from the contact point and deepening as you hold. Release: a clean print.
- **Revealed:** the two prints' outer ridges reach toward each other, meet, and merge into one continuous whorl; the shared lines light up and read as the message following the ridge curves. Both names impressed small beneath.
- **Variants:** `medium` الوسيط: clay طين / ink حبر / plaster جبس · `ridges` الخطوط: gold ذهبي / ember جمري / indigo نيلي
- **Feasibility:** **highest visual risk in the batch — spike it first.** Ridges are concentric offset curves around a core point (cheap); making them *morph into letterforms* without looking like a smear is the hard 10%. Approach: `orderWritePath` gives the letter strokes, the ridge field is warped toward them by distance. Fallback if the morph looks bad: ridges stay put and the message engraves itself between the two prints.

### `nest` — The Nest / العُشّ

> "Twig by twig, a home" / «غصنًا بعد غصن، يصير بيتًا»

- **Why special:** the quiet one. Two birds doing repetitive work is a truer picture of a long relationship than fireworks, and the twigs literally *are* the letters — the words are built out of the labour, not revealed at the end of it. Bulbuls carry real weight in Arabic poetry; «عُشّ الزوجية» is a live phrase.
- **Sealed:** a bare branch against a pale first-light sky, two small birds side by side, nothing built yet.
- **Opening:** swipe to send them out. Each swipe is one round trip — they leave, return with a twig, and set it. The pile grows, first messy, then obviously deliberate. Wingbeats and small calls, tiny scale.
- **Revealed:** the last twigs go in and the camera lifts: the nest isn't a bowl, it's the message, woven in branch. Both names on two pale eggs at the centre. The pair settle in.
- **Variants:** `bird` الطائر: bulbul بلبل / swallow سنونو / sparrow دوري · `light` الضوء: dawn فجر / golden أصيل / dusk غسق
- **Feasibility:** low — `orderWritePath` gives the stroke order, and each twig is a short instanced cylinder placed along the path with jitter in angle and length (the jitter is the whole aesthetic). Birds are two-triangle-wing low-poly with a two-frame flap; they never land in close-up. Reduced motion: nest complete, one bird arriving.

## Roast tier — the joke is the mechanic

### `pet-rock` — Pet Rock / الصخرة الأليفة

> "It does nothing. It's yours forever." / «لا تفعل شيئًا، وهي لك للأبد»

- **Why special:** the anti-gift, in a gallery of spectacles. Sending someone a rock is a joke *about sending gifts*, which makes it the funniest thing the product can ship about itself — and then it earns the sentiment anyway, because the rock is loyal, low-maintenance, and yours forever. Best laughs-per-line-of-code in the catalog by a wide margin.
- **Sealed:** a cardboard box with breathing holes. Inside, on straw: a rock. It has eyes. It is looking at you.
- **Opening:** pet it — rub back and forth. It blinks (asynchronously, one eye slightly late), wobbles toward the finger, and starts to purr; the purr goes up a semitone the longer you keep going. Stop petting and it wobbles once, pointedly.
- **Revealed:** it rolls over, delighted. On its belly, in marker: the message. Beside the box, a Certificate of Adoption in both names, notarised by nobody, plus care instructions (three lines, all blank).
- **Variants:** `rock` الصخرة: granite جرانيت / sandstone حجر رملي / geode جيود · `eyes` العيون: googly متحرّكة / sleepy نعسانة / heart قلبية
- **Feasibility:** **trivial** — a noise-displaced sphere, two eye spheres with a lid quad each, the `magic-lamp` rub gesture verbatim, a purr from a filtered sawtooth in `audio.ts`. One day, most of it spent on the blink timing, which is where the entire joke lives.

### `scoreboard` — Scoreboard / لوحة النتائج

> "Final score: you were right. Again." / «النتيجة النهائية: الحقّ معك… مرّة أخرى»

- **Why special:** every couple keeps this score. Rendering it as an airport split-flap board makes the pettiness monumental, and the self-deprecation points at the *sender* — the safe direction for a gift to be funny in. The split-flap is also the most satisfying letter-by-letter reveal mechanism ever built, and nothing in the catalog uses it yet.
- **Sealed:** a wall-mounted split-flap board in a dim hallway. `WHO'S RIGHT` across the top. `{recipient} 47 — {sender} 3`. A clicker hangs on a string beneath it.
- **Opening:** tap the clicker. Clatter. Their number goes up. Tap again: up again. The sender's number does not move, ever, no matter how many times you tap. After a few rounds the board starts skipping ahead by tens, then gives up.
- **Revealed:** every flap in the board runs at once — that glorious cascade — and settles into the message. Bottom row, small: `{sender} 3 · FINAL`.
- **Variants:** `finish` الطلاء: cream كريمي / navy كحلي / chrome كروم
- **Feasibility:** low, and it pays for itself — the split-flap module is the batch's one new reusable piece (a grid of two rotating quads per character, front/back texture from `makeTextTexture`, `clack` per flap with rate jitter). Arabic runs right-to-left by reversing the column order only; each cell holds a shaped glyph so nothing breaks.

### `excuse-machine` — The Excuse Machine / آلة الأعذار

> "Pull the lever until it runs out of excuses" / «اسحب الذراع حتى تنفد الأعذار»

- **Why special:** the apology gift with no dignity in it, which is exactly what makes an apology land. The rigged randomiser is the oldest joke in slot machines and it works because the recipient figures out the rig one pull before the machine admits it.
- **Sealed:** a chrome slot machine in an empty room, three reels of excuses idling, one bulb flickering.
- **Opening:** pull the lever. Reels spin — `I WAS` / `STUCK IN` / `TRAFFIC`, then `I WAS` / `ACTUALLY` / `ASLEEP`, then combinations that make no sense at all. Never a jackpot. On the third pull the machine buzzes, the reels drop out of alignment entirely, and it stops trying.
- **Revealed:** the reels fall away and the payout tray lights up: the real message on a printed slip, both names on it, one sad coin rolling out after it and falling over.
- **Variants:** `cabinet` الآلة: chrome كروم / cherry كرزي / brass نحاسي · `reels` البكرات: fruit فواكه / hearts قلوب / question marks علامات استفهام
- **Feasibility:** low — three textured cylinders (`makeTextTexture` strips) with the `astrolabe` snap on stop, one hinged lever. Shares the flap/clack audio with `scoreboard`. **Overlap to respect:** `claw-machine` already owns the neon-arcade-cabinet look — keep this one dim, chrome, and lonely, not bubblegum.

### `burnt-dinner` — Dinner Is Served / العشاء جاهز

> "I cooked. I'm sorry. Let's order in." / «طبختُ لك… أعتذر، لنطلب من الخارج»

- **Why special:** cooking for someone and ruining it is a universal domestic scene that needs no translation and no pun — the joke survives Arabic intact, which `roast`-style wordplay would not. And it converts cleanly into a real IOU: the reveal is a promise of an actual dinner.
- **Sealed:** a table set properly — cloth, two candles, folded napkins, one silver cloche. A single thin wisp of smoke escaping the rim.
- **Opening:** lift the cloche. Smoke pours out, a lot of it, far more than the dish can account for. A smoke alarm chirps somewhere off-screen, twice.
- **Revealed:** the smoke clears over a fully cremated dinner. Written in the char, legible, apologetic: the message. Underneath the plate, a takeout menu with a phone number circled and both names on the reservation line. One candle has gone out.
- **Variants:** `dish` الطبق: roast مشوي / cake كعكة / pasta معكرونة · `kitchen` المطبخ: cozy دافئ / marble رخامي / candlelit على ضوء الشموع
- **Feasibility:** low — `magic-lamp`'s curl-noise smoke reused verbatim, a lathe cloche, a charred surface from `makeTextTexture` as a burn mask over a dark PBR material. The smoke alarm chirp is two `tone` calls and it is worth more than any of the geometry.

### `big-screen` — Big Screen / الشاشة الكبيرة

> "Sixty thousand people, and the camera found you" / «ستون ألفًا، والكاميرا وجدتكما أنتما»

- **Why special:** the warm end of the funny tier, and the loudest gift in the catalog — the only one with an audience in it. Football stadiums are the region's shared cathedral, and the humour is the near-miss: the camera keeps almost finding you, and the crowd's disappointment is audible. Deliberately *not* a kiss cam — the moment is the names in lights, which travels everywhere the product ships.
- **Sealed:** a packed night stadium from the upper stands, floodlights blazing, the big screen running an advert for something dull.
- **Opening:** drag to pan the roving camera across the crowd. It slides past your row — close — and settles on someone else, who waves. Crowd groans. Pan again: past you again, other direction. Third time it locks on, zooms, and the whole stand turns to look.
- **Revealed:** the big screen fills with both names inside an animated frame, message beneath, as 60,000 people roar. Confetti from the tier above. The camera holds a beat too long, the way it always does.
- **Variants:** `stadium` الملعب: floodlit أضواء ليلية / sunset غروب / indoor صالة مغلقة · `frame` الإطار: hearts قلوب / confetti قصاصات / fireworks ألعاب نارية
- **Feasibility:** medium — the crowd is one `InstancedMesh` of ~8k capsule blobs in 4 colour bands with per-instance sway, most of them dark and out of focus; distance does the rest. Screen is an emissive quad with `makeTextTexture`. Crowd roar is a filtered noise swell (one new helper in `audio.ts`). Build it last. Stretch, if the grid util is free: a card stunt in the far stand using `rasterTextGrid`.

---

## Shared tech (build once, use twice+)

| Piece | Used by | Note |
|---|---|---|
| **Split-flap module** (grid of flipping quads, `clack` per flap) | `scoreboard`, `excuse-machine` reels (cylindrical cousin) | The batch's one new reusable piece. RTL = reverse the column order, nothing else |
| Paint mask (`mask.ts`) | `henna` apply **and** `henna` rub-off | Two inverse uses in one gift; util already shipped for `scratch-card` / `foggy-mirror` |
| Stroke-path text (`orderWritePath`) | `henna` ghost pattern, `nest` twig placement, `fingerprint` ridge warp | Reuse verbatim |
| Text texture (`makeTextTexture`) | `two-halves` engraving, `scoreboard` flaps, `excuse-machine` reels, `burnt-dinner` char, `big-screen` screen | Heaviest-reused util in the batch — five of ten gifts |
| Light-cookie projection (`fanous`) | `shadow-play` screen | Avoids alpha-tested shadow maps, which fringe |
| Curl-noise smoke (`magic-lamp`) | `burnt-dinner` | Reuse verbatim |
| Rub gesture (`magic-lamp`) | `pet-rock` | Reuse verbatim |
| Rotation snap (`astrolabe`) | `excuse-machine` reel stop | Reuse |
| Audio (`audio.ts`) | purr (`pet-rock`), flaps (`scoreboard`, `excuse-machine`), alarm chirp (`burnt-dinner`), crowd roar (`big-screen`) | One new helper: filtered noise swell for the roar |

**Not** a shared util: three gifts do "two things converge into one" (`two-halves`, `shadow-play`, `fingerprint`). That's three lines of `lerp` each — leave it duplicated, don't abstract a convergence hook for it.

Still no physics engine — flakes, twigs, confetti and the sad coin are all scripted. Every gesture is pointer-only (no gyro, no mic), so previews and desktop keep working. Reduced-motion per contract: jump to static `revealed` (stain set, coin whole, shadows met, nest built, rock rolled over, board flipped, dinner already ruined).

## Occasion tags — two new keys

A couples batch exposes two real gaps in the browse-by-intent filter. `occasionsById` is a plain code map in `catalog.ts` and occasions are not stored on the gift row, so this is **code-only — no migration**.

- `anniversary` / «ذكرى سنوية» — the single most common couples intent, currently homeless between `love` and `celebration`.
- `funny` / «على الضحك» — five of these gifts have no honest tag today; humour is an intent, not a subgenre of love.

~4 lines in the `Occasion` union and the `occasions` array, plus ten entries in `occasionsById`. Proposed tags: `henna` anniversary+celebration · `two-halves` love+anniversary · `shadow-play` love · `fingerprint` love+anniversary · `nest` love+congrats · `pet-rock` funny+thinking-of-you · `scoreboard` funny+anniversary · `excuse-machine` funny+apology · `burnt-dinner` funny+apology · `big-screen` funny+love. Skip both keys and everything collapses into `love`/`apology` — workable, but the funny tier becomes unfindable.

## Build order (riskiest first, like Batches 2–3)

1. **Spike: fingerprint ridge morph** — ridge field warping into letterforms without smearing. Unblocks `fingerprint`; fallback is engrave-between-the-prints.
2. **Split-flap module** + `scoreboard` — ships the new util on the cheapest scene.
3. `pet-rock` — one day; the gallery should get a laugh in it early.
4. `two-halves` — lowest risk in the batch, and the clearest statement of the thesis.
5. `henna` — flagship; all mask work, plus the drying beat that needs tuning by hand.
6. `excuse-machine` — split-flap's cylindrical cousin + snap.
7. `burnt-dinner` — smoke reuse; mostly a lighting and audio pass.
8. `shadow-play` — cookie projection; puppet hinges.
9. `nest` — writePath twigs; the calm one, good after two loud ones.
10. `big-screen` — crowd instancing; last, benefits from everything above.
11. `fingerprint` — needs spike 1 green.

Per gift, definition of done matches Batches 2–3: all four phases, both viewports, both languages, reduced-motion path, registry + catalog + gallery entry.

## Parking lot (keep for Batch 5)

Batch 3's parking lot carries forward unchanged (moon sighting, pearl dive, sadu loom, lighthouse, attar bottle, pop-up book, wishing well, chocolate box, plus the Batch 2 carry-overs).

New, couples-specific:

- **Love locks** — clip a padlock onto a bridge railing, toss the key. Parked on purpose: the natural reveal (pull back, the railing of locks spells the message) is `domino-run`'s trick a second time. Needs a different third act before it's worth building.
- **Worry beads / المسبحة** — flick beads one at a time, each one a day counted, the tassel unfurls the message. The best unclaimed pointer gesture left. Parked pending a native read on whether framing a مسبحة as a romantic keepsake lands warmly or irreverently; fallback framing is a plain bead strand.
- **Time capsule** — dig through sand (inverse paint mask, same util as `henna`) to unearth a tin buried by both of you. Held back so `henna` gets the mask util to itself this batch.
- **Chore wheel** — spin it, it lands on the sender every time. Same rigged-randomiser joke as `excuse-machine`; one per batch.
- **Terms & conditions** — scroll the relationship EULA, tap "I Agree", the message is clause 47(b). Funny, but it's a 2D gag with no 3D in it.
- **Two coffees** — a dallah pouring two finjans, steam intertwining. Shelved while `cup-reading` owns the coffee table.
- **Matching tattoos** — the needle traces, the ink settles, the two designs are halves of one. Overlaps `henna` hard; revisit only if `henna` proves the apply-wait-reveal structure works.
