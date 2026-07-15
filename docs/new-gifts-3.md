# New Gifts — Batch 3 Plan

Ten new gift concepts extending the [PRD catalog](PRD.md) and [Batch 2](new-gifts.md). Same contract: `preview / sealed / opening / revealed`, procedural-only 3D, EN + AR, 60fps on a mid phone.

**Curation point of view** (what Batch 3 adds that 1–2 don't have):

1. **The recipient is the maker.** Batch 1–2 gifts are *performed* — one gesture triggers a spectacle. Batch 3 gifts are *crafted*: dip, stitch, trace, type, stamp, pluck. The recipient finishes the gift with their own hand, so the reveal feels earned twice — once by the sender's words, once by the receiver's work.
2. **Heritage as mechanic, not backdrop.** Calligraphy, tatreez, falconry, the fanous — living practices (three of them UNESCO-listed) used as the *interaction*, not as set dressing behind a generic explosion.
3. **Words with a body.** Batch 2 wrote messages in ephemera — smoke, fog, water. Batch 3 gives the words a physical body: ink and gold leaf, silk thread, neon glass, typebars, dominoes, wax, sand. Every reveal leaves an artifact that looks like it could be picked up and kept.

## Summary

| id | Signature gesture | Sealed → unwrap | Reveal | Variants |
|---|---|---|---|---|
| `qalam` | Dip, then trace the stroke | Calligrapher's desk, inkwell, blank page | Your rough strokes snap into perfect script; gold illumination blooms around the finished piece | ink: midnight / oxblood / lapis; paper: cream / aged / indigo |
| `tatreez` | Swipe to stitch rows | Hoop of dark cloth, threaded needle glinting | Cross-stitch motifs bloom row by row; message resolves in stitched pixel letters | thread: crimson / gold / olive; cloth: indigo / black / linen |
| `fanous` | Open the door, hold to light the wick | Dark alcove, unlit brass lantern | Pierced light sweeps the walls and aligns into the message — words made of lamplight | glass: amber / emerald / ruby; pattern: stars / arabesque / crescents |
| `falcon` | Swipe to cast, hold the glove to recall | Hooded falcon on a leather glove, desert dusk | She returns from the dunes carrying the message scroll on her jess | falcon: shaheen / saker / white gyr; hour: dusk / dawn / moonlit |
| `typewriter` | Hammer any keys | Pastel machine, fresh sheet rolled in | Every keypress types the *correct* next letter — it cannot misspell them; sheet scrolls up inked | machine: mint / coral / charcoal; ink: black / red-black |
| `domino-run` | Flick the first tile | Thousands of tiles coiled on a dim table | The cascade runs; overhead pull-back shows the fallen tiles ARE the message | tiles: ivory / jet / rosewood; table: green felt / walnut / slate |
| `neon-sign` | Trace the dark glass tube | Rooftop workbench, dead sign, city bokeh | Gas flickers on segment by segment until the night says it in cursive neon | gas: rose / cyan / amber; night: rain / clear / fog |
| `oud` | Pluck / strum the strings | Oud on a cushion in lamplight | Each true note releases a letter of light; the phrase plays itself back as the words assemble | wood: honey / walnut / ebony; maqam: hijaz / nahawand / rast |
| `wax-seal` | Hold wax to flame, press to stamp | Folded letter, candle, brass stamp | Their monogram crisp in cooling wax; the letter unfolds itself into the message | wax: crimson / gold / midnight; stamp: initials / heart / star |
| `hourglass` | Drag to flip | Brass hourglass, all sand up top, late light | Falling sand lands *deliberately*, piling into the message letter by letter | sand: gold / rose / silver; frame: brass / ebony / steel |

---

## Wonder tier — heritage in the hands

### `qalam` — Calligrapher's Qalam / قلم الخطّاط

> "Dip the reed; the master's hand knows the rest" / «اغمس القلم، فيدُ الخطّاط تعرف الباقي»

- **Why special:** the whole app is about sending words — this gift makes *writing itself* the spectacle. Arabic calligraphy is the ceiling of "message as material"; in EN mode the same rig writes elegant copperplate (stroke paths are script-agnostic). The batch flagship.
- **Sealed:** a calligrapher's desk at night — inkwell, reed pen on its rest, blank cream page with faint guide lines, one low lamp.
- **Opening:** tap the inkwell to dip (nib darkens, wet sheen), then drag along a ghost path — your rough stroke snaps into a perfect stroke as an unseen hand steadies it. Ink runs dry after a few strokes; re-dip. The dip-write-dip rhythm *is* the ritual.
- **Revealed:** remaining strokes complete themselves in flowing ink with wet specular; then the tazhib blooms — gold-leaf arabesque frames unfurling around the finished piece, both names in the roundel beneath.
- **Variants:** `ink` الحبر: midnight ليلي / oxblood عنّابي / lapis لازوردي · `paper` الورق: cream كريمي / aged معتّق / indigo نيلي
- **Feasibility:** medium — guided-trace is the batch's shared interaction util; strokes are ribbon geometry along the Batch-2 stroke-path output; wet-ink sheen = animated specular mask; gold = emissive flakes along spline frames.

### `tatreez` — Tatreez Hoop / طارة التطريز

> "Stitch by stitch, the words find home" / «غرزة غرزة، تعود الكلمات إلى البيت»

- **Why special:** tatreez motifs are a literal embroidered language — village, family, memory in thread (UNESCO-listed). And cross-stitch is a pixel font, which makes Arabic *and* Latin legible with one cheap trick. The craft gift with the strongest emotional register.
- **Sealed:** a wooden hoop holding deep indigo cloth, threaded needle glinting, spools beside it, warm side light.
- **Opening:** swipe across the hoop — each pass stitches a row of silk X's with a soft thread-pull sound; border motifs (cypress, amulets, moons) bloom outward first.
- **Revealed:** the last rows stitch themselves in a hurry; the center resolves into the message in cross-stitch letters, names monogrammed in the corner; the cloth relaxes on the hoop.
- **Variants:** `thread` الخيط: crimson قرمزي / gold ذهبي / olive زيتوني · `cloth` القماش: indigo نيلي / black أسود / linen كتّاني
- **Feasibility:** low risk — the whole gift is one instancing trick: message rasterized to a grid, instanced X-sprites per lit cell; cloth is a quad with a slight normal ripple.

### `fanous` — Fanous / الفانوس

> "Light the wick; the walls learn your words" / «أشعل الفتيل، فتحفظ الجدران كلماتك»

- **Why special:** THE Ramadan object, and the purest form of the batch thesis — the message becomes *light itself*, projected through pierced brass onto stone. Promoted from the Batch 2 parking lot; schedule as a seasonal drop before Ramadan (≈ Feb 2027) but it reads year-round.
- **Sealed:** a dark stone alcove; an ornate brass fanous with colored glass panes, unlit, swaying just barely.
- **Opening:** drag the little glass door open, then press-and-hold to light the wick (hold-meter like `foggy-mirror`); the flame catches, the door clicks shut.
- **Revealed:** warm light floods out; pierced-metal lace sweeps the walls as the lantern slowly turns, then the perforations align and the moving light resolves into the message written across the stone; names in a cartouche on the front pane.
- **Variants:** `glass` الزجاج: amber كهرماني / emerald زمردي / ruby ياقوتي · `pattern` النقش: stars نجوم / arabesque أرابيسك / crescents أهلّة
- **Feasibility:** low risk — the projection is a spotlight cookie: render the message to a canvas texture and let the light do the work; lantern is lathe geometry + pierced alpha map; the slow rotation is free drama.

### `falcon` — The Falconer / الصقّار

> "Cast her to the wind; she returns with your words" / «أطلقه للريح، فيعود بكلماتك»

- **Why special:** falconry is UNESCO-listed Gulf heritage and the catalog's first true flight — every other gift stays on the table. The message arrives the way messages once actually did: carried back to the glove.
- **Sealed:** a tooled leather glove in the foreground, hooded falcon perched on it, desert dusk, heat shimmer on the dunes.
- **Opening:** swipe up-and-out to cast — she rows out over the dunes (camera chases), banks through a canyon of low light; press-and-hold the glove to call her home.
- **Revealed:** she flares, lands with a wing-thump, and offers the scroll on her jess — it unrolls into the message; names tooled into the glove leather.
- **Variants:** `falcon` الصقر: shaheen شاهين / saker حُر / white gyr جير أبيض · `hour` الوقت: dusk غسق / dawn فجر / moonlit مقمر
- **Feasibility:** **highest visual risk in the batch** — needs one convincing bird: low-poly falcon, two flap cycles + a glide pose, spline flight with banking. The landing is the hard 10%; spike it early. Fallback: she flies to camera and the scroll takes over.

## Play tier — machines with charm

### `typewriter` — Typewriter / الآلة الكاتبة

> "Whatever you press, it types the truth" / «مهما ضغطت، تكتب الحقيقة»

- **Why special:** the most message-forward machine there is, promoted from the Batch 2 parking lot with one joke that makes it: the recipient hammers *any* keys and the machine cannot misspell what the sender meant. Arabic mode runs the carriage the other way — a real 1950s Arabic-typewriter detail nobody else would ship.
- **Sealed:** a hulking pastel typewriter under an anglepoise lamp, fresh sheet rolled in.
- **Opening:** tap keys anywhere — each tap swings a typebar, clack, and the *correct* next letter strikes the page; the space bar thunks; the margin bell dings; the carriage sweeps back per line.
- **Revealed:** the last line types itself in a hurry, the ribbon shivers, and the sheet scrolls up and tilts to camera — message inked, names typed in the corner like a sign-off.
- **Variants:** `machine` الآلة: mint نعناعي / coral مرجاني / charcoal فحمي · `ink` الحبر: black أسود / red-black أحمر وأسود
- **Feasibility:** low-medium — one pivoting typebar mesh reused per hit; letters are glyph decals appearing on the sheet; the joy is audio (clack / ding / carriage zip, post-gesture WebAudio per the `music-box` pattern).

### `domino-run` — Domino Run / صف الدومينو

> "One touch, and every piece falls into place" / «لمسة واحدة، فيقع كل حجر في مكانه»

- **Why special:** "everything falls into place" made literal — the fallen tiles *are* the letters, a kinetic mosaic the recipient sets off with one flick. Dominoes are café-culture furniture across the region; this is the largest-scale reveal in the catalog and it costs no physics.
- **Sealed:** a dim tabletop, thousands of upright tiles coiled in a serpentine path, the first tile spotlit.
- **Opening:** flick the first tile. The wave runs — clack-clack-clack — camera tracking the front as it branches and turns.
- **Revealed:** pull back overhead: the fallen tiles form the message in pixel letters, pips glowing faintly; the final tile taps a tiny bell; a flourish branch spells the names.
- **Variants:** `tiles` الأحجار: ivory عاجي / jet فاحم / rosewood خشب الورد · `table` الطاولة: green felt جوخ أخضر / walnut جوز / slate إردواز
- **Feasibility:** low risk despite the spectacle — no physics engine: rasterize the rendered message to a grid (shares the `tatreez` util, so Arabic shaping is free), lay a serpentine run through the lit cells, and key each instance's topple to its distance along the run. InstancedMesh + one clack sample with rate jitter.

### `neon-sign` — Neon Workshop / ورشة النيون

> "Trace the glass until the night says it out loud" / «تتبّع الزجاج حتى يقولها الليل»

- **Why special:** hand-bent neon is sign-maker craft, and Arabic neon signage is its own beloved urban vernacular — Cairo, Beirut, Dubai shopfronts. The recipient wires the message up themselves, one tube at a time. "They light up your name," literally.
- **Sealed:** a rooftop workbench at night — a dead glass-tube sign lying flat, city bokeh beyond, one work lamp.
- **Opening:** drag along the tube path — gas flickers behind the finger, sputters, then holds; each segment hums on with a buzz-tick; one loose wire throws a spark (charm, not danger).
- **Revealed:** the last segment snaps on and the whole sign blazes in cursive neon — the message — flicker settling into a steady hum as the sign hoists up against the skyline; a small maker's plate reads "bent by {sender} for {recipient}".
- **Variants:** `gas` الغاز: rose وردي / cyan سماوي / amber كهرماني · `night` الليل: rain مطر / clear صحو / fog ضباب
- **Feasibility:** low-medium — tubes are TubeGeometry along the Batch-2 stroke-path output verbatim (Arabic's connected script is *native* neon); glow is emissive + existing bloom; guided-trace shared with `qalam`.

## Poetry tier — quiet rituals

### `oud` — The Oud / العود

> "Pluck the strings; the melody remembers" / «داعب الأوتار، فاللحن يتذكّر»

- **Why special:** the region's heart-instrument, *played* rather than wound — `music-box` is passive, this one answers your fingers. The maqam variant is the quiet flex: the palette option changes the actual scale the strings speak.
- **Sealed:** an oud resting on a cushion in lamplight, mother-of-pearl rosette glinting, strings shivering with faint sympathetic shimmer.
- **Opening:** pluck a string (tap) or strum across (drag) — each true note releases a floating glyph of light from the rosette, one letter of the message in order; strings visibly vibrate.
- **Revealed:** after the last pluck the phrase plays itself back as a short taqsim flourish while the released letters drift up and settle into the full message hanging in the lamplight; names inlaid in mother-of-pearl below the strings.
- **Variants:** `wood` الخشب: honey عسلي / walnut جوز / ebony أبنوس · `maqam` المقام: hijaz حجاز / nahawand نهاوند / rast راست
- **Feasibility:** **highest audio risk in the batch** — the gift lives or dies on pluck feel. Karplus-Strong string synthesis is ~20 lines of WebAudio and sounds shockingly oud-like with a lowpass body filter; the maqam variant is just a scale table. Spike latency + polyphony first; fallback is a small sampled note set.

### `wax-seal` — Wax & Seal / الشمع والختم

> "Some words deserve to be sealed" / «بعض الكلمات تستحق أن تُختَم»

- **Why special:** the recipient stamps it *themselves* — approval made tactile, with both names cast as a monogram in brass. `message-bottle` owns "letter in a vessel"; here the seal is the object, and the squish is the game-feel.
- **Sealed:** a folded ivory letter on dark wood, a stick of sealing wax, a lit candle, a brass stamp standing upright.
- **Opening:** press-and-hold the wax over the flame — it slumps and drips into a pooling blob — then press the stamp down: squish, a satisfying ooze ring.
- **Revealed:** lift — a crisp monogram of both initials in the cooling wax, one wisp of steam; then the letter unfolds itself into the message, ribbon dangling from the seal.
- **Variants:** `wax` الشمع: crimson قرمزي / gold ذهبي / midnight ليلي · `stamp` الختم: initials أحرف / heart قلب / star نجمة
- **Feasibility:** low risk — the wax blob is a morphing lathe with a soft fresnel; the monogram is normal-mapped SDF text pressed into it; everything else is scripted. Hold-meter reused from `foggy-mirror`.

### `hourglass` — Hourglass / الساعة الرملية

> "Turn it over; every grain knows where to land" / «اقلبها، فكل حبّة رمل تعرف مكانها»

- **Why special:** the anti-fireworks — patience as spectacle. Sand falls the way sand falls, but lands *deliberately*, piling into letterforms: time itself spelling the message. Desert sand made intimate; the calmest maker-gift in the batch.
- **Sealed:** a brass-framed hourglass on a windowsill, all sand in the top bulb, dust motes in late light.
- **Opening:** drag to flip — it swings heavy and settles with a clunk; the first grains begin to fall.
- **Revealed:** the falling thread fans out and lands in drifts that build the message letter by letter (gentle time-lapse acceleration); the last grains drop, names etched in the frame, low sun making the pile glow through the glass.
- **Variants:** `sand` الرمل: gold ذهبي / rose وردي / silver فضي · `frame` الإطار: brass نحاس / ebony أبنوس / steel فولاذ
- **Feasibility:** low-medium — the particle→text pipeline exists (`fireworks`, `magic-lamp`); the extension is pile-up ordering (targets sorted bottom-up per letter so drifts grow like real sand). The flip is a scripted transform like `cup-reading`.

---

## Shared tech (build once, use twice+)

| Piece | Used by | Note |
|---|---|---|
| Guided-trace interaction (finger follows a tolerant ghost path) | `qalam` strokes, `neon-sign` tubes | The batch's one new interaction util; forgiving tolerance — a moment, not a test |
| Stroke-path text (Batch 2 spike) | `qalam`, `neon-sign` | Reuse verbatim; Arabic connected script is the native case for both |
| Grid-rasterized message (rendered text → lit cells) | `tatreez` stitches, `domino-run` tiles | Rasterize the *rendered* canvas so Arabic shaping comes free; one util, two aesthetics |
| Particle→text with pile-up ordering | `hourglass` | Extend the existing pipeline with bottom-up target sort |
| Light-cookie projection (message → spotlight map) | `fanous` | Canvas-to-texture on a spotlight; the wall does the rendering |
| Post-gesture WebAudio (`music-box` / `mixtape` pattern) | `typewriter`, `oud`, `domino-run` | Karplus-Strong pluck synth is the only new audio tech |
| Press-hold meter (`foggy-mirror` pattern) | `fanous` wick, `falcon` recall, `wax-seal` melt | Reuse |

Still no physics engine — the domino cascade, falcon flight, and wax drip are scripted/kinematic. Every gesture is pointer-only (no gyro, no mic), so previews and desktop keep working. Reduced-motion per contract: jump to static `revealed` (calligraphy finished, sign lit, tiles fallen, sand piled).

## Build order (riskiest first, like Batch 2)

1. **Spike: Karplus-Strong pluck** — latency + polyphony on a mid phone. Unblocks `oud`; if it fails, fall back to sampled notes or park it.
2. **Spike: falcon flight** — spline + banking + landing on a placeholder bird. Fallback: fly-to-camera, scroll takes over.
3. `neon-sign` — proves guided-trace on the cheapest scene (tubes already exist from the Batch 2 spike).
4. `qalam` — flagship; guided-trace + stroke ribbons + gold bloom.
5. `tatreez` — grid util debut; pure instancing.
6. `domino-run` — grid util second user + scripted cascade.
7. `typewriter` — mechanics + the audio charm pass.
8. `wax-seal` — self-contained; blob + stamp.
9. `hourglass` — particle pile-up extension.
10. `fanous` — light cookie; **land before Ramadan (≈ Feb 2027)**.
11. `falcon` — cinematic; needs spike 2 green.
12. `oud` — last; needs spike 1 green.

Per gift, definition of done matches Batch 2: all four phases, both viewports, both languages, reduced-motion path, registry + catalog + gallery entry.

## Parking lot (not specced, keep for Batch 4)

Carried from Batch 2: kaleidoscope, radio dial, bioluminescent bay, fortune cookie, paper plane, polaroid.

New:

- **Moon sighting** — pan a telescope across the night sky hunting the hilal; finding it triggers the greeting + message. Seasonal sibling to `fanous` (Eid drop).
- **Pearl dive** — hold to descend past the dhow's hull, pry the oyster, the nacre swirl spells the message around the pearl. Gulf pearl-diving heritage.
- **Sadu loom** — drag the shuttle; Bedouin bands weave in with the message as square-kufic geometry. Kept back so textiles don't double up with `tatreez` in one batch.
- **Lighthouse** — rotate the lamp; the beam sweeps dark water and the words surface wherever the light passes.
- **Attar bottle** — press the atomizer; each spritz puffs part of the message in gold-shimmer mist. Distinct from `magic-lamp` smoke: mist, glitter, brief.
- **Pop-up book** — drag the heavy page; a paper city erects itself and a banner unfurls the message. Papercraft cousin of `matchbox`.
- **Wishing well** — flick a coin; ripples, then the wish rises as caustic light on the stones.
- **Chocolate box** — tap to "eat" chocolates one by one; letters printed in the tray underneath.
