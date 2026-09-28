# New Gifts — Batch 5 Plan (Occasions the gallery can't answer yet)

Six gift concepts, extending the [PRD catalog](PRD.md) and Batches [2](new-gifts.md), [3](new-gifts-3.md), [4](new-gifts-4.md). Same contract: `preview / sealed / opening / revealed`, procedural-only 3D, EN + AR, pointer-only gesture, 60fps on a mid phone.

**Curation point of view** (what Batch 5 adds that 1–4 don't have):

1. **Intents with no answer.** Filter the gallery by "get well" or "graduation" today and there is nothing to filter by. "Thank you" has three gifts, all solemn crafts. Batch 5 is picked from the gaps in the occasion filter, not from a mood board.
2. **Worthless objects.** A till receipt, a sticking plaster, a paper plane. Every earlier gift is an heirloom (locket, astrolabe, rose under glass) or a spectacle (fireworks, stadium). These three cost nothing, which is why they can carry a message that heirlooms can't.
3. **Smell and taste.** The catalog already does sight (aurora, fireworks) and sound (oud, music box). Bakhoor and ma'amoul are what Eid morning *smells* and *tastes* like. Neither one is a lamp or a lantern, which is how the catalog has shown the region so far.

## Summary

| id | Signature gesture | Sealed → unwrap | Reveal | Variants |
|---|---|---|---|---|
| `receipt` | Tap the feed button | Thermal printer on a counter, READY blinking | An itemised bill for everything they've done for you, TOTAL: PRICELESS, the message printed under it | paper: white / pink / canary · printer: charcoal / cream / mint |
| `bakhoor` | Drop the oud chip on the coal | Carved mabkhara on a brass tray, one live coal | Smoke rises, curls, and gathers into the message in the air | burner: wood / silver / ceramic · scent: oud / rose / musk |
| `plaster` | Peel it off | A droopy felt heart with a plaster across its seam | The seam underneath is mended in gold, the heart perks up, a get-well tag flips open | plaster: classic / stars / clear · heart: red / pink / blue |
| `mortarboard` | Flick the cap up | A cap on a ribboned diploma, stage lights | The whole class throws with you; the tassel turns; the diploma unrolls with the message | cap: black / navy / maroon · tassel: gold / silver / crimson |
| `paper-plane` | Flick to throw | A folded plane on a windowsill, rooftops beyond | It loops over the rooftops, comes back, lands and unfolds into the letter | paper: notebook / airmail / kraft · sky: morning / sunset / night |
| `maamoul` | Knock the mold on the board | Carved wooden mold, dough, a sieve of sugar | The cookie drops out patterned; sugar sifts down and settles into the message | mold: date / pistachio / walnut · board: walnut / olive / marble |

---

### `receipt` — Receipt of Thanks / فاتورة الجميل

> "Itemised. Unpayable." / «مفصّلة… ولا تُسدَّد»

- **Why special:** gratitude told as a debt joke. Like Batch 4's roast tier it is funny before the sender types a word, because the line items are ours, not theirs, and a sincere message still lands under TOTAL: PRICELESS.
- **Sealed:** a small thermal printer on a café counter, green READY LED blinking, a torn stub hanging from the slot.
- **Opening:** tap the printer. Each tap feeds a burst and the paper chatters out one line at a time: *Listening to my rants ×∞*, *2 a.m. rides ×37*, *Pretending my cooking is good ×1*… then TOTAL: PRICELESS, AMOUNT PAID: 0.00, BALANCE: FOREVER, then the message, then CASHIER: sender · CUSTOMER: recipient, a barcode, THANK YOU — COME AGAIN. Idle fallback feeds it by itself.
- **Revealed:** the printer tears it off with a snap; the strip curls over the counter edge; the camera tilts to read it.
- **Feasibility:** low. One tall canvas texture drawn by hand (monospace rows, dotted rules, barcode), a plane whose visible length grows out of the slot, `clack` per line.

### `bakhoor` — Mabkhara / المبخرة

> "Your words, in the smoke that welcomes guests" / «كلماتك في الدخان الذي يستقبل الضيوف»

- **Why special:** bakhoor is how the region says welcome, Friday, Eid, wedding. Smoke is the one particle medium nobody has written in yet (the `magic-lamp` genie is a cloud, not a script).
- **Sealed:** a carved square-footed mabkhara on a brass tray over a majlis carpet, one coal glowing faintly, a chip of oud on the tray.
- **Opening:** drag the chip onto the coal. It hisses, the coal flares, and a twisting column rises, curls, then gathers into the message in the air above the burner.
- **Revealed:** the words hold in soft smoke, fed by a thin plume, edges breathing. Ember pulses.
- **Feasibility:** medium. A pooled `Points` cloud with curl-ish rise, then a spring onto `sampleTextPoints` targets. Censer is lathe + boxes.

### `plaster` — Get-Well Plaster / لزقة الشفاء

> "Peel slowly. It's healed." / «انزعها بهدوء… لقد طاب»

- **Why special:** "get well" has no gift at all. Everyone has peeled a plaster with gritted teeth, so the gesture needs no hint. It doubles as the softest apology in the catalog: *I hurt you, here's a plaster.*
- **Sealed:** a plush felt heart, a little droopy, breathing slowly, a plaster across its seam; a cup of tea beside it.
- **Opening:** drag the plaster tab. It peels back along the drag, curling, with a sticky rip. Underneath, the seam has been mended in neat gold stitches; the heart inflates and bounces upright.
- **Revealed:** the heart beats gently; a paper tag tied to it flips open with the message; the peeled plaster lies beside it with the recipient's name in marker on the pad.
- **Feasibility:** medium. Plaster is a subdivided plane with a page-curl bend driven by peel progress; heart is a bevelled `ExtrudeGeometry` with a noise felt texture.

### `mortarboard` — Cap Toss / رمية التخرّج

> "Throw it high. You earned the sky." / «ارمِها عاليًا… السماء لك»

- **Why special:** graduation (results day, university) is the region's loudest congrats moment and the gallery can't find it. The toss is a gesture everyone already knows; the gift gives you the whole class to throw with.
- **Sealed:** a cap resting on a rolled diploma tied with ribbon, on a stage under spotlights, a few confetti on the boards.
- **Opening:** flick the cap up. It spins away and forty more fly up with it from all sides in slow motion; the camera tilts up into them. They fall; one lands back on the diploma and its tassel swings across. The ribbon slips, the scroll unrolls toward the camera.
- **Revealed:** the diploma open, recipient's name as the graduate, message beneath, a seal at the foot; slow confetti.
- **Feasibility:** medium. Caps are one `InstancedMesh` on scripted arcs; the scroll is a plane wrapped around a shrinking cylinder.

### `paper-plane` — Paper Plane / طيّارة ورق

> "Thrown from far away, landed right here" / «رُميت من بعيد… وهبطت هنا تمامًا»

- **Why special:** for distance: family abroad, a friend who moved. The letter *is* the plane, so it can only be read once it stops being a plane.
- **Sealed:** a folded plane on a windowsill, the sender's name on the wing, rooftops and sky beyond; a breeze lifts its nose now and then.
- **Opening:** flick to throw. It glides out over the roofs, banks wide, loops back, and lands in front of the camera, then unfolds fold by fold into a flat creased sheet.
- **Revealed:** the unfolded letter, creases still visible, message handwritten across it.
- **Feasibility:** medium-high. One grid mesh folded by rotating vertices about fold lines (so the same UVs show the message once flat). Fallback: morph between a folded and a flat pose.

### `maamoul` — Ma'amoul Mold / قالب المعمول

> "Knock it out, the pattern is yours" / «اطرقه… والنقش لك»

- **Why special:** Eid morning in the Levant is ma'amoul, and the carved wooden mold is the one kitchen object everyone's grandmother owns. The knock-out, whacking the mold on the board, has a sound people remember. The mold's shape traditionally tells you the filling, so the variant carries that meaning too.
- **Sealed:** a carved wooden mold on a floured board, a ball of dough, a sieve of powdered sugar, morning light.
- **Opening:** tap the mold: each knock jumps it with a thunk and a puff of flour; on the third, the cookie drops out with the pattern crisp on its dome. The sieve passes overhead and sugar falls.
- **Revealed:** the sugar has settled on the dark board as the message and the recipient's name; the cookie sits beside it.
- **Feasibility:** medium. Mold and cookie are lathe profiles sharing one carved canvas bump map; sugar is a falling `Points` cloud landing on `sampleTextPoints` targets.

---

## Occasion tags — two new keys

Code-only (occasions are not stored on the gift row), same as Batch 4:

- `graduation` / «تخرّج»
- `get-well` / «سلامتك»

Tags: `receipt` thanks+funny · `bakhoor` celebration+thanks · `plaster` get-well+apology · `mortarboard` graduation+congrats · `paper-plane` thinking-of-you+love · `maamoul` celebration+thanks.

## Parking lot

Batch 4's parking lot carries forward. New:

- **Fortune cookie**: crack it, the slip never ends. Funny, but not ours; ma'amoul took the "baked good" slot.
- **Kite / طيّارة ورق على خيط**: shares a name and a sky with `paper-plane`. Revisit if a kite's string can carry the text.
- **Knafeh cheese-pull**: the stretch *is* the text. Great joke; string-physics risk.
