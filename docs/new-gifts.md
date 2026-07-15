# New Gifts — Batch 2 Plan

Ten new gift concepts extending the [PRD catalog](PRD.md). Same contract: `preview / sealed / opening / revealed`, procedural-only 3D, EN + AR, 60fps on a mid phone.

**Curation point of view** (why these and not teddy bears and ring boxes):

1. **Gesture-first.** The most loved gifts in the current catalog are the ones the recipient *does* (shake the globe, blow the candles, shoot the doll). Every gift here has one signature pointer gesture a phone does well: rub, flip, scratch, align, strike, hold.
2. **From the audience's world.** The app ships Arabic-first care (names, taglines, font pipeline). Batch 2 spends that: the cup reading, the magic lamp, the astrolabe — gifts no generic gift app would think to build.
3. **The message is the material.** The product is a message; the best reveals make the words themselves the spectacle — smoke calligraphy, coffee grounds, fog writing, tape ribbon script.

## Summary

| id | Signature gesture | Sealed → unwrap | Reveal | Variants |
|---|---|---|---|---|
| `magic-lamp` | Rub (back-and-forth drag) | Lamp on a cushion in a dark bazaar, dust motes | Smoke pours out, swirls into the message as smoke calligraphy | metal: brass / aged silver / obsidian; smoke: turquoise / rose / gold dust |
| `cup-reading` | Flip the cup (drag down) | Steaming coffee cup on a saucer | Flip, rest, lift — grounds swirl into omens, then spell the message as the fortune | pattern: gilded / cobalt / blossom |
| `foggy-mirror` | Hold to breathe fog | Cold glass, dim scene behind | Fog blooms under the touch; an unseen fingertip writes the message, drips run | setting: rain window / candlelight / night train |
| `astrolabe` | Rotate rings to align | Brass instrument, engraved, softly lit | Rings snap into alignment one by one; engraving lights up with the message | metal: brass / silver / night steel; sky: dawn / dusk / night |
| `scratch-card` | Scratch (drag paints away foil) | Gold-foil card slides onto a table | Foil flakes fly under the finger; message underneath; confetti at full reveal | foil: gold / silver / rose; motif: hearts / stars / clovers |
| `claw-machine` | Aim (drag), release to drop | Neon cabinet hums to life | Claw drops, always wins the plush; plush carries the message tag | plush: bear / bunny / star; cabinet: bubblegum / midnight / mint |
| `pinata` | Repeated taps to crack | Piñata sways from a rope | Cracks spread per hit, then bursts — candy rain + the note flutters down | shape: star / heart / little burro; palette: fiesta / pastel / sunset |
| `mixtape` | Press play | Cassette clicks into a deck | Spools turn; the tape ribbon spins out and loops into cursive script spelling the message; lo-fi hiss | shell: smoke / cherry / seafoam; label: handwritten / typed |
| `koi-pond` | Tap to scatter food | Still dark pond, lilies, moon | Koi glide in; their glowing wakes trace the message on the water | koi: white-gold / crimson / black pearl; time: dusk / night / dawn |
| `matchbox` | Strike the match (swipe) | Closed matchbox in darkness | Box slides open, match strikes, flame lights a miniature paper world; message glows on its back wall | world: city rooftops / desert night / harbor |

---

## Wonder tier — culturally grounded signatures

### `magic-lamp` — Magic Lamp / المصباح السحري

> "Rub the brass, and the smoke writes your words" / «افرك النحاس، فيكتب الدخان كلماتك»

- **Why special:** the rub gesture is universally understood before it's explained, and the lamp is native to the audience's own storytelling heritage — 1001 Nights, not borrowed kitsch.
- **Sealed:** lamp on an embroidered cushion, dark market stall, hanging dust motes, one warm shaft of light.
- **Opening:** drag back and forth across the lamp — each pass buffs a glow hotter (progress = rub distance). At full heat the spout exhales.
- **Revealed:** curl-noise smoke pours upward and condenses into the message (particle→text targets, same trick as fireworks/butterflies). Names engrave on the lamp body.
- **Variants:** `metal` المعدن: brass نحاس / aged silver فضة عتيقة / obsidian سبج · `smoke` الدخان: turquoise فيروزي / rose وردي / gold dust غبار ذهبي
- **Feasibility:** low risk — lathe geometry for the lamp, existing particle-text pipeline, curl-noise drift. Arabic smoke calligraphy already covered by `text3d` + `useArabicFontReady`.

### `cup-reading` — The Cup Reading / قراءة الفنجان

> "Flip the cup; the grounds spell their fortune" / «اقلب الفنجان، فيكتب البُنّ بختهم»

- **Why special:** tasseography (قراءة الفنجان) is a beloved ritual across the region — an aunt reading your future in the grounds. Nobody else will ship this. It reframes the message as *fate*.
- **Sealed:** a finished cup of Arabic coffee steaming on its saucer, majlis lighting.
- **Opening:** drag down to flip the cup onto the saucer (the real ritual), a beat of stillness, tap to lift.
- **Revealed:** dark grounds crawl the porcelain interior, form fleeting omen shapes (bird, road, heart), then settle into the message. Caption: "Your fortune:" / «بختك:».
- **Variants:** `pattern` النقش: gilded مذهّب / cobalt كوبالت / blossom مزهر
- **Feasibility:** medium — grounds are particles constrained to the cup's inner surface (spherical UV), then released to text targets. The flip is a scripted transform.

### `foggy-mirror` — Foggy Mirror / مرآة الضباب

> "Breathe on the glass; a finger writes back" / «انفخ على الزجاج، فيكتب لك إصبع خفي»

- **Why special:** everyone has written on a steamed mirror as a kid. Holding your thumb on the screen to "breathe" is intimate in a way no explosion can be.
- **Sealed:** a pane of cold glass; behind it a soft out-of-focus scene (rain, candles, passing lights).
- **Opening:** press and hold — fog blooms radially from the touch point with a soft breath sound.
- **Revealed:** an invisible fingertip strokes the message into the fog (stroke-order path reveal), squeaky glass sound, a few condensation drips run from the letters.
- **Variants:** `setting` المشهد: rain window نافذة مطر / candlelight ضوء الشموع / night train قطار ليلي
- **Feasibility:** medium — one full-screen fog shader driven by a pointer-painted render-target mask (shared with `scratch-card`, build once). Reduced-motion: fog already written, static.

### `astrolabe` — Astrolabe / الأسطرلاب

> "Turn the rings until the stars agree" / «أدِر الحلقات حتى تتفق النجوم»

- **Why special:** an Islamic golden-age instrument as a love object — "the stars aligned" made literal and tactile. A micro-puzzle: the recipient *earns* the reveal.
- **Sealed:** the instrument hangs against a pre-dawn sky, rings ticking slowly, engraved arabesques catching light.
- **Opening:** drag rotates the free ring; near alignment it snaps magnetically with a brass click (3 rings, ~20s total, generous snap tolerance — a moment, not a chore).
- **Revealed:** aligned rings project a star chart; the engraving fills with light spelling both names, message inscribed along the outer rim like instrument markings.
- **Variants:** `metal` المعدن: brass نحاس / silver فضة / night steel فولاذ ليلي · `sky` السماء: dawn فجر / dusk غسق / night ليل
- **Feasibility:** low risk — torus geometry, rotation snap logic, curved text along a ring (extend `text3d`).

## Play tier — the arcade row (pairs with `shooting-gallery`)

### `scratch-card` — Scratch Card / بطاقة الحظ

> "Scratch the gold — every card wins" / «اكشط الذهب، كل البطاقات رابحة»

- **Opening:** finger-drag scrapes foil off in real strokes (pointer-painted mask, shared with `foggy-mirror`); metallic flakes spray from the fingertip.
- **Revealed:** message printed beneath; at ~85% scratched, auto-clear + confetti + "WINNER" stamp with both names.
- **Variants:** `foil` القشرة: gold ذهبي / silver فضي / rose وردي · `motif` الزخرفة: hearts قلوب / stars نجوم / clovers نفل
- **Feasibility:** low-medium — the mask shader is the whole gift; flakes are instanced sprites. The most tactile gesture in the catalog.

### `claw-machine` — Claw Machine / لعبة المخلب

> "Rigged, for once, in their favor" / «مضبوطة، لمرة واحدة، لصالحهم»

- **Opening:** drag aims the gantry (claw shadow tracks over the plush pile), release drops it. It grips true every time — the one claw machine in the world that can't lose.
- **Revealed:** the plush rides up, drops into the chute, arrives hugging a folded tag that unfolds into the message.
- **Variants:** `plush` الدمية: bear دب / bunny أرنب / star نجمة · `cabinet` الكشك: bubblegum وردي فقاعي / midnight منتصف الليل / mint نعناعي
- **Feasibility:** low risk — kinematic rig (no physics engine), capsule-blob plushies, emissive cabinet neon.

### `pinata` — Piñata / بينياتا

> "Tap until it rains sweets and secrets" / «انقرها حتى تمطر حلوى وأسرارًا»

- **Opening:** each tap swings it, papier-mâché cracks spread visibly (5–7 hits, haptic-feeling screen shake on each).
- **Revealed:** burst — instanced candy rain, streamers, and one paper note spiraling down front-and-center with the message.
- **Variants:** `shape` الشكل: star نجمة / heart قلب / little burro مهر صغير · `palette` الألوان: fiesta مهرجان / pastel باستيل / sunset غروب
- **Feasibility:** low risk — precomputed shell fragments, scripted burst; fringe = shader-displaced strips. Cathartic in a way nothing else in the catalog is.

## Poetry tier — quiet ones

### `mixtape` — Mixtape / شريط الذكريات

> "Press play — the ribbon writes the rest" / «اضغط التشغيل، فيكتب الشريط الباقي»

- **Opening:** tap the chunky play button (it *thunks*), spools turn, lo-fi hiss + warble start (WebAudio, post-gesture like music-box).
- **Revealed:** the tape ribbon spins out of the cassette and loops through the air into flowing script that spells the message, glinting as it tightens. Arabic mode is the flex: Arabic is natively cursive — the ribbon *is* the handwriting.
- **Variants:** `shell` الهيكل: smoke دخاني / cherry كرزي / seafoam زبد البحر · `label` الملصق: handwritten بخط اليد / typed مطبوع
- **Feasibility:** **highest risk in the batch** — ribbon script = TubeGeometry swept along font-derived stroke paths. Needs a spike; see build order.

### `koi-pond` — Koi Pond / بركة الكوي

> "Feed the koi; they write it on the water" / «أطعم الأسماك، فتكتبها على الماء»

- **Opening:** tap scatters food pellets; ripples ring out; koi glide in from the dark edges.
- **Revealed:** their wakes bioluminesce, tracing the message across the surface before fading to a steady glow; lilies drift past the words.
- **Variants:** `koi` الكوي: white-gold أبيض ذهبي / crimson قرمزي / black pearl لؤلؤ أسود · `time` الوقت: dusk غسق / night ليل / dawn فجر
- **Feasibility:** medium — koi swim splines sampled from text stroke paths (reuse ribbon-spike output); wake = fading render-target trail. The calm one — the catalog lacks a truly serene gift.

### `matchbox` — Matchbox World / عالم في علبة كبريت

> "One match, and a tiny world wakes" / «عود واحد، فيستيقظ عالم صغير»

- **Opening:** swipe slides the drawer open; a second swipe strikes the match — spark, flare, warm bloom (the whole scene goes from near-black to candlelit).
- **Revealed:** inside the drawer, a miniature paper diorama wakes up — flat-shaded quads like a papercraft stage, tiny windows lighting one by one; the message glows ember-orange on the back wall.
- **Variants:** `world` العالم: city rooftops سطوح المدينة / desert night ليل الصحراء / harbor المرفأ
- **Feasibility:** low risk — the gift is 90% lighting drama; paper worlds are cheap flat quads. Strike swipe = velocity-gated drag.

---

## Shared tech (build once, use twice+)

| Piece | Used by | Note |
|---|---|---|
| Pointer-painted mask (render-target the finger draws into) | `scratch-card` foil, `foggy-mirror` fog | One shader util; the two gifts are inverse uses of it |
| Stroke-path text (font glyph → ordered stroke paths) | `mixtape` ribbon, `foggy-mirror` writing, `koi-pond` swim paths | The batch's one real spike; Arabic connected script is the hard case |
| Particle→text targets | `magic-lamp` smoke, `cup-reading` grounds | Already solved (fireworks, butterfly-jar) — reuse |
| Rotation-snap interaction | `astrolabe` | Trivial, but keep generic (drag-to-angle + magnetic snap) |

No physics engine — piñata, claw, and candy rain are all scripted/kinematic. Every gesture is pointer-only (no gyro, no mic), so previews and desktop keep working. Reduced-motion per contract: jump to static `revealed` (fog pre-written, rings pre-aligned, foil pre-scratched).

## Build order (riskiest first, like M3)

1. **Spike: stroke-path text** — glyph→stroke extraction incl. Arabic. Unblocks mixtape / mirror / koi; if it fails, mirror falls back to fade-in fog text and mixtape drops out.
2. `foggy-mirror` — proves the pointer-mask util + stroke writing on the cheapest scene.
3. `scratch-card` — reuses the mask util same week.
4. `magic-lamp` — flagship, all-reused tech; ship it early for the gallery.
5. `cup-reading` — surface-constrained particles.
6. `astrolabe` — snap interaction + curved rim text.
7. `pinata`, `claw-machine` — the arcade row, low risk.
8. `matchbox` — lighting showcase.
9. `koi-pond` — spline swim + trail, benefits from everything above.
10. `mixtape` — last; it needs the spike's best output (ribbon along strokes).

Per gift, definition of done matches M3: all four phases, both viewports, both languages, reduced-motion path, registry + catalog + gallery entry.

## Parking lot (not specced, keep for Batch 3)

- **Typewriter** — keys ghost-type the message letter by letter, clack audio; the most message-forward concept there is. → promoted to [Batch 3](new-gifts-3.md).
- **Fanous** — Ramadan lantern; pierced-metal light projects the words on a wall. Seasonal (Ramadan/Eid) drop. → promoted to [Batch 3](new-gifts-3.md).
- **Polaroid** — flash, then shake-to-develop the handwritten note.
- **Kaleidoscope** — rotate until mirrored shards snap into the words.
- **Radio dial** — tune through static to find "their station" broadcasting the message.
- **Bioluminescent bay** — touch the water, the tide glows where it writes.
- **Fortune cookie** — pinch to snap, the slip slides out.
- **Paper plane** — swipe to launch; it flies a long arc, lands, unfolds back into the letter.
