import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { makeRadialSprite } from "../sprites";
import { clack, resumeAudio, tone } from "../audio";
import { pick } from "../catalog";
import { forRecipient } from "../../i18n";

/* ============================================================================
 * TYPEWRITER — the most message-forward machine.
 *
 * The joke that carries it: the recipient hammers ANY key and the platen answers
 * with the *correct* next letter of the sender's message. It cannot misspell what
 * was meant. So the interaction is not "type the message" — there is no keyboard
 * to get right — it is "tap, and watch the truth come out." Every tap commits the
 * next glyph the sender authored; if the recipient stops, the machine finishes the
 * page on its own (the mercy pattern — a gift may never lock waiting for input).
 *
 * The page is the whole point, so the sheet is the tallest, brightest thing in the
 * frame. Letters are inked onto it by redrawing a single CanvasTexture with N
 * glyphs revealed — cheap (only on a keystroke, never per frame), and it draws the
 * finished page COLD in one pass, which is exactly what `revealed` and reduced
 * motion need. Everything else — the swinging typebar, the sliding carriage cursor,
 * the margin bell, the platen feeding the sheet up a line — is pose driven off the
 * revealed glyph count and the phase, never off a replayed timeline.
 * ========================================================================== */

/* ---------- machine body palette, keyed by variants.machine ---------- */
interface MachineSkin {
  body: string; // the shell
  trough: string; // the darker channel the keys sit in
  keycap: string; // round glass key tops
  chrome: string; // carriage rails, platen knobs, the return lever
  seam: string; // painted edge lines / the ribbon-cover lid
}
const MACHINES: Record<string, MachineSkin> = {
  // Pastel mint — the friendly Olivetti-lettera register the brief asks for.
  mint: { body: "#a6d8c4", trough: "#7cbaa4", keycap: "#f4ede0", chrome: "#d9dee1", seam: "#7bb39d" },
  // Warm coral, a touch pinker so it reads as "pastel" not "red" against the ink.
  coral: { body: "#f0a89c", trough: "#d98479", keycap: "#f6efe2", chrome: "#dcd7d0", seam: "#d47f73" },
  // Charcoal is the serious desk machine: dark shell, pale keys so they still catch the lamp.
  charcoal: { body: "#44484f", trough: "#2d3035", keycap: "#dfe0e4", chrome: "#c7ccd2", seam: "#2a2d32" },
};

/* ---------- ink, keyed by variants.ink ---------- */
// The body of the letter is always the black half of the ribbon; "red-black" is a
// two-tone ribbon, and on a real machine you shift to the red band to set a name or
// a salutation apart. So red-black inks the two people — the recipient at the top,
// the sender at the sign-off — in red, and the message body in black. A plain black
// ribbon inks everything the one colour.
const INK_BLACK = "#2a2621";
const INK_RED = "#b23328";
const PAPER = "#f6f0e4"; // warm bond paper
const PAPER_SHADE = "#e7dccb"; // the platen shadow across the sheet's foot

/* ---------- layout of the message on the sheet ---------- */
// Typewriters are monospace, so the sheet is authored on a fixed character grid:
// one advance per column, which is what lets the carriage cursor and the typebar
// land on the glyph the canvas actually drew. CPL is chosen so a wrapped line reads
// on a phone-width sheet without the type shrinking to nothing.
const CPL = 22; // characters per line before wrap
const FONT_PX = 46; // canvas px per glyph — big enough to stay crisp when the sheet fills the frame
const LINE_K = 1.44; // line height as a multiple of FONT_PX; typed pages breathe
const MARGIN_K = 0.95; // sheet margin as a multiple of FONT_PX

/* ---------- world dimensions (before the viewport fit-scale) ---------- */
const PAPER_W = 1.62; // the sheet is the hero — wide and tall
const STRIKE_Y = 0.66; // world Y where the typebar strikes: the platen line. The live line always feeds to here.
const PAPER_Z = -0.34; // the sheet sits behind the platen and leans back
const PAPER_TILT = -0.16; // radians: leaned away from camera while typing, like a real platen
const PAPER_TILT_REVEAL = 0.06; // …and tips toward the reader once it is done
const CURSOR_Z = -0.26; // the carriage cursor / typebar strike, just in front of the sheet
const FIT_W = 3.3; // design width the fit-scale targets…
const FIT_H = 3.9; // …and design height, tall so the whole scroll of paper shows in portrait
const ROOT_Y = -0.24; // drop the machine so keyboard and sheet both sit in frame

/* ---------- opening cadence (seconds, on the opening clock) ---------- */
const GRACE = 1.4; // let them tap first; the machine waits this long before it helps
const MERCY_GAP = 0.55; // …and after their last tap, waits this long before taking over again
const MERCY_INTERVAL = 0.085; // auto-type cadence once mercy is driving
const MERCY_TICKS = 95; // total auto-strikes budgeted for the page — bounds the no-input runtime
const FINISH_HOLD = 1.3; // ribbon-shiver + the sheet lifting, after the last glyph, before we call it done

/* ---------- shared textures (module singletons, like foggy-mirror's glowTex) ---------- */
const GLOW = makeRadialSprite(64, [
  [0, "rgba(255,244,214,0.95)"],
  [0.45, "rgba(255,225,160,0.5)"],
  [1, "rgba(255,214,120,0)"],
]);

/* ---------- the sheet document ---------- */
interface DocLine {
  text: string;
  emphasis: boolean; // inked red on a red-black ribbon (the two names)
}
interface Step {
  line: number;
  col: number;
  ret: boolean; // a carriage return (bell + sweep + line feed), no glyph
  space: boolean;
}

/** Wrap a paragraph string to a fixed character grid, hard-breaking any over-long word. */
function wrapText(text: string, cpl: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      let word = raw;
      // a URL or a very long token would otherwise blow past the sheet's edge
      while (word.length > cpl) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cpl));
        word = word.slice(cpl);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > cpl) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Build the whole letter — salutation, body, sign-off — plus the canvas it inks
 * onto and the metrics the carriage rides on. Everything a resource: the texture is
 * disposed on rebuild, and the canvas draw is a pure function of the revealed count.
 */
function buildDoc(
  message: string,
  sender: string,
  recipient: string,
  lang: "en" | "ar",
  redInk: boolean,
  isPreview: boolean,
) {
  const rtl = lang === "ar";
  const salutation = forRecipient(lang, recipient); // "For Layla" / "إلى ليلى" — the recipient, in red
  const signName = sender.trim();
  const signoff = signName ? pick(lang, `— ${signName}`, `— ${signName}`) : "";

  const lines: DocLine[] = [];
  if (isPreview) {
    // The gallery card: the machine is sealed and the sheet carries only the teaser
    // line. A whole letter breathed onto a 4:3 thumbnail is unreadable mush; the
    // salutation alone says "someone is typing to you" and reads at any size.
    lines.push({ text: salutation, emphasis: true });
  } else {
    lines.push({ text: salutation, emphasis: true });
    lines.push({ text: "", emphasis: false });
    for (const l of wrapText(message, CPL)) lines.push({ text: l, emphasis: false });
    if (signoff) {
      lines.push({ text: "", emphasis: false });
      lines.push({ text: signoff, emphasis: true });
    }
  }

  // Flatten to the ordered strike sequence. A char step inks a glyph; a return step
  // between two lines is the bell + carriage sweep + line feed, and inks nothing —
  // which also gives a blank line its own beat.
  const steps: Step[] = [];
  lines.forEach((ln, li) => {
    for (let c = 0; c < ln.text.length; c++) {
      steps.push({ line: li, col: c, ret: false, space: ln.text[c] === " " });
    }
    if (li < lines.length - 1) steps.push({ line: li, col: ln.text.length, ret: true, space: false });
  });

  // --- canvas + monospace metrics ---
  const family = rtl ? "'Thmanyah Sans', 'Courier New', monospace" : "'Courier New', 'Courier', monospace";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `500 ${FONT_PX}px ${family}`;
  const advPx = Math.max(1, ctx.measureText("M").width); // monospace advance
  const lineHpx = FONT_PX * LINE_K;
  const marginPx = FONT_PX * MARGIN_K;
  const CW = Math.ceil(CPL * advPx + marginPx * 2);
  const CH = Math.ceil(Math.max(1, lines.length) * lineHpx + marginPx * 2);
  canvas.width = CW;
  canvas.height = CH;

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  /** Ink the first `n` steps onto the sheet and report the live carriage position.
      Pure in `n` (mutates only its own texture); called only when the count moves. */
  function reveal(n: number): { curLine: number; curCol: number } {
    const reveals = new Array(lines.length).fill(0);
    let curLine = 0;
    let curCol = 0;
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      if (s.ret) {
        curLine = s.line + 1;
        curCol = 0;
      } else {
        reveals[s.line] = s.col + 1;
        curLine = s.line;
        curCol = s.col + 1;
      }
    }
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, CW, CH);
    // the platen casts a soft shade across the foot of the sheet
    const grad = ctx.createLinearGradient(0, CH - marginPx * 1.6, 0, CH);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, PAPER_SHADE);
    ctx.fillStyle = grad;
    ctx.fillRect(0, CH - marginPx * 1.6, CW, marginPx * 1.6);

    ctx.font = `500 ${FONT_PX}px ${family}`;
    if (rtl) ctx.direction = "rtl";
    ctx.textBaseline = "middle";
    ctx.textAlign = rtl ? "right" : "left";
    const x = rtl ? CW - marginPx : marginPx;
    lines.forEach((ln, li) => {
      const shown = ln.text.slice(0, reveals[li]); // logical prefix — correct in both scripts
      if (!shown) return;
      ctx.fillStyle = redInk && ln.emphasis ? INK_RED : INK_BLACK;
      ctx.fillText(shown, x, marginPx + (li + 0.5) * lineHpx);
    });
    texture.needsUpdate = true;
    return { curLine, curCol };
  }

  return {
    texture,
    reveal,
    steps,
    stepCount: steps.length,
    rtl,
    aspect: CH / CW,
    // fractions of the sheet, for mapping the carriage into world space
    charFrac: advPx / CW,
    marginFrac: marginPx / CW,
    topFrac: (marginPx + 0.5 * lineHpx) / CH, // sheet-top to the first line's centre
    lineFrac: lineHpx / CH,
    dispose() {
      texture.dispose();
    },
  };
}

/* ---------- keyboard layout (three staggered rows of round keys) ---------- */
interface Key {
  x: number;
  y: number;
  z: number;
}
function buildKeys(): Key[] {
  const keys: Key[] = [];
  const counts = [10, 9, 8]; // row 0 nearest the player, row 2 up by the platen
  const sx = 0.185;
  for (let r = 0; r < counts.length; r++) {
    const n = counts[r];
    const z = 0.5 - r * 0.155; // rows climb toward the platen
    const y = 0.15 + r * 0.135;
    const stagger = (r % 2) * sx * 0.5; // the classic offset between rows
    for (let i = 0; i < n; i++) {
      keys.push({ x: -((n - 1) / 2) * sx + i * sx + stagger, y, z });
    }
  }
  return keys;
}

export default function TypewriterScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const skin = MACHINES[variants.machine] ?? MACHINES.mint;
  const redInk = variants.ink === "red-black";
  const isPreview = phase === "preview";

  /* useMemo is load-bearing: it owns the sheet canvas + its texture. Rebuilds only
     when the letter's content or the ink actually changes (not on every phase flip,
     since sealed/opening/revealed all share the same page). */
  const doc = useMemo(
    () => buildDoc(message.trim(), senderName, recipientName, lang, redInk, isPreview),
    [message, senderName, recipientName, lang, redInk, isPreview],
  );
  useEffect(() => () => doc.dispose(), [doc]);

  const keys = useMemo(() => buildKeys(), []);
  const keyRng = useMemo(() => mulberry32(1907), []); // deterministic mercy key picks
  const strikeRng = useMemo(() => mulberry32(4242), []); // deterministic clack detune

  /* refs mutated per frame */
  const rootRef = useRef<THREE.Group>(null);
  const paperRef = useRef<THREE.Group>(null);
  const cursorRef = useRef<THREE.Group>(null);
  const typebarRef = useRef<THREE.Group>(null);
  const ribbonRef = useRef<THREE.Mesh>(null);
  const keysGroupRef = useRef<THREE.Group>(null);
  const spaceRef = useRef<THREE.Mesh>(null);
  const bellRef = useRef<THREE.Sprite>(null);
  const inviteRef = useRef<THREE.Sprite>(null);
  const lampRef = useRef<THREE.PointLight>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const typedRef = useRef(0);
  // The last count inked onto the sheet, and the carriage position that count implies.
  // Kept on the component (not on the memoized doc) so the frame loop never mutates doc.
  const drawnRef = useRef(-1);
  const curLineRef = useRef(0);
  const curColRef = useRef(0);

  // All the scalar animation state, in one ref object so the lint accepts the writes.
  const animRef = useRef({
    press: 0, // key-depress amount 0..1
    pressIdx: -1, // which key is down (-1 = spacebar)
    strike: 0, // typebar swing 0..1
    bell: 0, // margin-bell glow 0..1
    shiver: 0, // ribbon vibration 0..1
    cursorX: 0, // eased carriage cursor world X
    lastCommitAt: -99,
    lastManualT: -99,
    mercyAcc: 0,
    finishT: -1,
  });

  /* On every phase change, seat the typed count and force a cold redraw. preview and
     revealed draw the whole page in one pass here; opening starts blank. This is the
     reduced-motion target too: mounting straight to revealed inks the finished sheet
     without ever running the opening. */
  useEffect(() => {
    const a = animRef.current;
    a.press = a.strike = a.bell = a.shiver = a.mercyAcc = 0;
    a.pressIdx = -1;
    a.lastCommitAt = -99;
    a.lastManualT = -99;
    a.finishT = -1;
    if (phase === "sealed" || phase === "opening") typedRef.current = 0;
    else typedRef.current = doc.stepCount; // preview + revealed: fully typed
    drawnRef.current = -1; // force the frame loop to ink it
    // Seat the typebar down in its rest fan and hide it, from `phase`. It only lifts
    // mid-strike — an "opening"-only beat that useFrame drives — and every resting
    // phase wants it out of the sheet. That lowering lived solely in useFrame, so it
    // waited on a frame actually running; but the shared canvas parks the loop in
    // exactly these states (offscreen → "never", reduced motion → a fixed settle
    // burst, then stop), which can strand a bar caught raised from the last strike in
    // front of the page. Seating it here means preview/sealed/revealed never depend on
    // a frame arriving to clear it — the sheet is unobstructed from the phase alone.
    if (typebarRef.current) {
      typebarRef.current.rotation.x = -1.15; // rest fan: down in the basket, behind the platen
      typebarRef.current.visible = false;
    }
  }, [phase, doc]);

  /* Commit the next `count` steps: ink them, swing the bar, ring the bell on a
     return, and answer with sound. Called with count=1 from a tap and count=burst
     from mercy. `manual` picks the depressed key from the pointer; mercy picks one
     at deterministic random — the joke is that ANY key yields the right letter. */
  const commit = (count: number, manual: boolean, pointerLocalX: number) => {
    const from = typedRef.current;
    const to = Math.min(doc.stepCount, from + count);
    if (to === from) return;
    typedRef.current = to;

    let hitReturn = false;
    let hadChar = false;
    let lastSpace = false;
    for (let i = from; i < to; i++) {
      const s = doc.steps[i];
      if (s.ret) hitReturn = true;
      else {
        hadChar = true;
        lastSpace = s.space;
      }
    }

    const a = animRef.current;
    if (hadChar) {
      // space thunks low and dull; a letter is a bright dry clack, lightly detuned
      if (lastSpace) clack({ freq: 470, decay: 0.09, gain: 0.3 });
      else clack({ freq: 1480 + strikeRng() * 520, decay: 0.055, gain: 0.34 });
      a.strike = 1;
    }
    if (hitReturn) {
      tone(1650, { gain: 0.24, seconds: 0.5, shimmer: true }); // the margin bell
      a.bell = 1;
      a.shiver = Math.max(a.shiver, 0.6);
    }
    // depress a key: the spacebar on a space, else the key under the finger (or, for
    // the machine's own hand, a random one — the joke is that any key is the right one)
    if (hadChar && lastSpace) {
      a.pressIdx = -1; // the spacebar (see the spaceRef branch in the frame loop)
    } else if (manual) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < keys.length; i++) {
        const d = Math.abs(keys[i].x - pointerLocalX);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      a.pressIdx = best;
    } else {
      a.pressIdx = Math.floor(keyRng() * keys.length);
    }
    a.press = 1;
    a.lastCommitAt = tRef.current;
    if (manual) a.lastManualT = tRef.current;
  };

  // pointer -> a single strike. The keyboard is one big invisible slab so a tap
  // ANYWHERE on the keys counts; the nearest keycap depresses for feedback.
  const onKeyDown = (ev: { point: THREE.Vector3; stopPropagation: () => void }) => {
    ev.stopPropagation();
    if (phase !== "opening" || typedRef.current >= doc.stepCount) return;
    resumeAudio(); // audio may only start inside a gesture — this is the gesture
    const s = rootRef.current?.scale.x || 1;
    commit(1, true, ev.point.x / s); // world -> root-local x for the nearest-key search
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const el = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const a = animRef.current;
    const opening = phase === "opening";

    /* ---------- fit the machine into the viewport ---------- */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const fit = Math.min(vw / FIT_W, vh / FIT_H, 1.15);
    if (rootRef.current) {
      rootRef.current.scale.setScalar(fit);
      rootRef.current.position.y = ROOT_Y * fit;
      // the whole desk breathes a little; never during the actual typing
      const sway = isPreview ? 0.05 : phase === "sealed" ? 0.03 : phase === "revealed" ? 0.04 : 0;
      rootRef.current.rotation.y = Math.sin(el * 0.4) * sway;
    }

    /* ---------- mercy: the machine finishes the page for them ----------
       Fires once they have stopped (or if they never start): after GRACE, if their
       last tap is older than MERCY_GAP, auto-type at MERCY_INTERVAL. The burst is
       sized so the whole page — however long — lands inside the runtime budget, so a
       280-char letter finishes "in a hurry" rather than dragging past the clock. */
    if (opening && typedRef.current < doc.stepCount) {
      const idle = t > GRACE && t - a.lastManualT > MERCY_GAP;
      if (idle) {
        a.mercyAcc += dt;
        if (a.mercyAcc >= MERCY_INTERVAL) {
          a.mercyAcc = 0;
          const remaining = doc.stepCount - typedRef.current;
          const ticksLeft = Math.max(1, MERCY_TICKS - Math.floor(t / MERCY_INTERVAL));
          const burst = Math.max(1, Math.ceil(remaining / ticksLeft));
          commit(burst, false, 0);
        }
      }
    }

    /* ---------- ink the sheet whenever the typed count moved ---------- */
    if (drawnRef.current !== typedRef.current) {
      const cur = doc.reveal(typedRef.current);
      curLineRef.current = cur.curLine;
      curColRef.current = cur.curCol;
      drawnRef.current = typedRef.current;
    }

    /* ---------- decay the strike animations ---------- */
    a.press = Math.max(0, a.press - dt * 7);
    a.strike = Math.max(0, a.strike - dt * 6);
    a.bell = Math.max(0, a.bell - dt * 2.4);
    a.shiver = Math.max(0, a.shiver - dt * 2.2);

    /* ---------- keys: reset all to rest, depress the active one ---------- */
    if (keysGroupRef.current) {
      const kids = keysGroupRef.current.children;
      for (let i = 0; i < kids.length; i++) {
        kids[i].position.y = keys[i].y - (i === a.pressIdx ? a.press * 0.05 : 0);
      }
    }
    if (spaceRef.current) {
      // spacebar rides down when the pressed step is a space (pressIdx -1 flags it)
      spaceRef.current.position.y = 0.1 - (a.pressIdx === -1 ? a.press * 0.03 : 0);
    }

    /* ---------- the carriage cursor + typebar, aimed at the live column ----------
       curCol -> a fraction across the sheet, then to world X. In Arabic the carriage
       fills from the right, so the fraction is mirrored and the sweep runs the other
       way — a real Arabic-typewriter detail. */
    const curLine = curLineRef.current;
    const curCol = curColRef.current;
    const frac = doc.rtl
      ? 1 - doc.marginFrac - curCol * doc.charFrac
      : doc.marginFrac + curCol * doc.charFrac;
    const targetX = (frac - 0.5) * PAPER_W;
    // eased, so a return reads as a quick sweep back across the platen rather than a jump
    a.cursorX = lerp(a.cursorX, targetX, Math.min(1, dt * 12));
    if (cursorRef.current) {
      cursorRef.current.position.x = a.cursorX;
      cursorRef.current.visible = opening || phase === "sealed";
      // a soft idle bob while sealed, inviting the first tap
      const bob = phase === "sealed" ? Math.sin(el * 3) * 0.006 : 0;
      cursorRef.current.position.y = STRIKE_Y + 0.02 + bob;
    }
    if (typebarRef.current) {
      typebarRef.current.position.x = a.cursorX;
      // the bar swings up from its rest fan to the strike and falls back
      typebarRef.current.rotation.x = lerp(-1.15, -0.05, easeOutCubic(a.strike));
      typebarRef.current.visible = opening && a.strike > 0.02;
    }
    if (ribbonRef.current) {
      // the inked ribbon jumps up to meet the type on each strike, and shivers at the end
      ribbonRef.current.position.x = a.cursorX;
      ribbonRef.current.position.y = STRIKE_Y - 0.02 + a.strike * 0.04 + a.shiver * Math.sin(el * 60) * 0.006;
    }

    /* ---------- completion: the page is typed, hold for the flourish, then finish ---------- */
    if (opening && typedRef.current >= doc.stepCount && a.finishT < 0) {
      a.finishT = t;
      a.shiver = 1; // the whole ribbon shivers as the last key lands
    }
    if (opening && a.finishT >= 0 && t > a.finishT + FINISH_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    /* ---------- the sheet: feed the live line to the platen, then lift + tilt on reveal ----------
       Line L must sit at STRIKE_Y while it is being typed, so the platen appears to
       roll the paper up a line at each return. revealK tips the finished sheet toward
       the reader and lifts it clear of the platen — the "scroll up to camera" beat,
       which `revealed` holds statically. */
    const revealK =
      phase === "revealed"
        ? 1
        : opening && a.finishT >= 0
          ? smooth(clamp01((t - a.finishT) / FINISH_HOLD))
          : 0;
    if (paperRef.current) {
      const Hp = PAPER_W * doc.aspect;
      const topLocalY = (0.5 - doc.topFrac) * Hp; // sheet-local Y of the first line's centre
      const lineWorld = doc.lineFrac * Hp;
      const feedY = STRIKE_Y - topLocalY + curLine * lineWorld;
      const target = feedY + revealK * 0.42;
      paperRef.current.position.y = lerp(paperRef.current.position.y, target, Math.min(1, dt * 6));
      paperRef.current.position.z = lerp(paperRef.current.position.z, PAPER_Z + revealK * 0.22, Math.min(1, dt * 6));
      paperRef.current.rotation.x = lerp(PAPER_TILT, PAPER_TILT_REVEAL, revealK);
    }

    /* ---------- the margin bell glow ---------- */
    if (bellRef.current) {
      const m = bellRef.current.material as THREE.SpriteMaterial;
      m.opacity = 0.15 + a.bell * 0.85;
      bellRef.current.scale.setScalar(0.16 + a.bell * 0.08);
    }

    /* ---------- the sealed affordance: a warm pulse over the keys ---------- */
    if (inviteRef.current) {
      const m = inviteRef.current.material as THREE.SpriteMaterial;
      const want = phase === "sealed" ? 0.28 + 0.16 * Math.sin(el * 2.2) : 0;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 3);
      inviteRef.current.visible = m.opacity > 0.01;
    }

    /* ---------- lamp: warm and steady on the sheet, a touch brighter once revealed ---------- */
    if (lampRef.current) {
      const base = phase === "sealed" ? 5.2 : phase === "revealed" || revealK > 0 ? 8.2 : 6.6;
      lampRef.current.intensity = lerp(lampRef.current.intensity, base, Math.min(1, dt * 3));
    }
  });

  const Hp = PAPER_W * doc.aspect;

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 1.05, 4.45]} fov={34} onUpdate={(c) => c.lookAt(0, 0.78, 0)} />

      {/* Desk lighting: a cool ambient wash plus the anglepoise pool aimed at the sheet. */}
      <ambientLight intensity={0.55} color="#c7d2df" />
      <directionalLight position={[-2.4, 3.2, 2.2]} intensity={0.5} color="#eaf0f7" />
      <pointLight ref={lampRef} position={[1.15, 2.15, 0.35]} intensity={6.6} color="#ffdca4" distance={7} decay={1.6} />

      {/* the desk + a soft backdrop (never scene.background) */}
      <mesh position={[0, ROOT_Y - 0.55, 0.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[16, 10]} />
        <meshStandardMaterial color="#20242c" roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0, 1.4, -3.2]}>
        <planeGeometry args={[18, 12]} />
        <meshStandardMaterial color="#161a21" roughness={1} metalness={0} />
      </mesh>

      <group ref={rootRef}>
        {/* ---------------- the machine body ---------------- */}
        {/* base slab, a touch wider, for a beveled foot */}
        <mesh position={[0, 0.06, 0.12]}>
          <boxGeometry args={[2.16, 0.12, 1.44]} />
          <meshStandardMaterial color={skin.trough} roughness={0.5} metalness={0.15} />
        </mesh>
        {/* main shell */}
        <mesh position={[0, 0.24, 0.1]}>
          <boxGeometry args={[2.0, 0.34, 1.3]} />
          <meshStandardMaterial color={skin.body} roughness={0.42} metalness={0.12} />
        </mesh>
        {/* the sloped key bed cut into the shell (a darker trough) */}
        <mesh position={[0, 0.2, 0.4]} rotation={[-0.5, 0, 0]}>
          <boxGeometry args={[1.84, 0.06, 0.86]} />
          <meshStandardMaterial color={skin.trough} roughness={0.55} metalness={0.1} />
        </mesh>
        {/* the ribbon-cover hump at the back, under the platen */}
        <mesh position={[0, 0.44, -0.28]}>
          <boxGeometry args={[1.7, 0.26, 0.5]} />
          <meshStandardMaterial color={skin.seam} roughness={0.4} metalness={0.18} />
        </mesh>
        {/* painted maker's stripe across the front */}
        <mesh position={[0, 0.24, 0.756]}>
          <boxGeometry args={[1.4, 0.05, 0.02]} />
          <meshStandardMaterial color={skin.chrome} roughness={0.3} metalness={0.7} />
        </mesh>

        {/* ---------------- the platen (roller) + knobs ---------------- */}
        <group position={[0, STRIKE_Y + 0.02, -0.33]}>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.15, 0.15, 1.92, 28]} />
            <meshStandardMaterial color="#2b2622" roughness={0.6} metalness={0.2} />
          </mesh>
          {/* chrome end knobs the typist would turn to feed paper */}
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 1.02, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.13, 0.13, 0.08, 20]} />
              <meshStandardMaterial color={skin.chrome} roughness={0.25} metalness={0.85} />
            </mesh>
          ))}
          {/* the carriage-return lever, off the left knob */}
          <mesh position={[-1.16, 0.12, 0]} rotation={[0, 0, 0.5]}>
            <boxGeometry args={[0.05, 0.3, 0.05]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.25} metalness={0.85} />
          </mesh>
        </group>

        {/* ---------------- the sheet (the hero) ---------------- */}
        <group ref={paperRef} position={[0, STRIKE_Y, PAPER_Z]} rotation={[PAPER_TILT, 0, 0]}>
          <mesh>
            <planeGeometry args={[PAPER_W, Hp]} />
            <meshStandardMaterial map={doc.texture} roughness={0.9} metalness={0} side={THREE.DoubleSide} />
          </mesh>
        </group>

        {/* ---------------- the inked ribbon, rising to meet each strike ---------------- */}
        <mesh ref={ribbonRef} position={[0, STRIKE_Y - 0.02, CURSOR_Z + 0.01]}>
          <planeGeometry args={[0.16, 0.05]} />
          <meshStandardMaterial color={redInk ? "#8f2a22" : "#1c1a17"} roughness={0.7} metalness={0.1} />
        </mesh>

        {/* ---------------- the carriage cursor (the sliding type guide) ---------------- */}
        <group ref={cursorRef} position={[0, STRIKE_Y + 0.02, CURSOR_Z + 0.03]}>
          <mesh>
            <boxGeometry args={[0.04, 0.12, 0.02]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.2} metalness={0.9} emissive="#ffe9be" emissiveIntensity={0.25} />
          </mesh>
        </group>

        {/* ---------------- one reused typebar that swings up and strikes ---------------- */}
        <group ref={typebarRef} position={[0, STRIKE_Y - 0.16, CURSOR_Z - 0.02]} rotation={[-1.15, 0, 0]} visible={false}>
          <mesh position={[0, 0.16, 0]}>
            <boxGeometry args={[0.02, 0.34, 0.02]} />
            <meshStandardMaterial color="#3a3530" roughness={0.5} metalness={0.5} />
          </mesh>
          {/* the type slug at the tip */}
          <mesh position={[0, 0.33, 0]}>
            <boxGeometry args={[0.06, 0.05, 0.03]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.3} metalness={0.8} />
          </mesh>
        </group>

        {/* ---------------- the keys ---------------- */}
        <group ref={keysGroupRef}>
          {keys.map((k, i) => (
            <group key={i} position={[k.x, k.y, k.z]} rotation={[-0.5, 0, 0]}>
              {/* the stem */}
              <mesh position={[0, -0.03, 0]}>
                <cylinderGeometry args={[0.04, 0.05, 0.08, 12]} />
                <meshStandardMaterial color={skin.trough} roughness={0.6} metalness={0.15} />
              </mesh>
              {/* the round glass cap */}
              <mesh position={[0, 0.02, 0]}>
                <cylinderGeometry args={[0.072, 0.066, 0.03, 20]} />
                <meshStandardMaterial color={skin.keycap} roughness={0.28} metalness={0.15} />
              </mesh>
              {/* chrome ring */}
              <mesh position={[0, 0.036, 0]}>
                <torusGeometry args={[0.07, 0.008, 8, 20]} />
                <meshStandardMaterial color={skin.chrome} roughness={0.25} metalness={0.85} />
              </mesh>
            </group>
          ))}
        </group>

        {/* the spacebar, front and centre */}
        <mesh ref={spaceRef} position={[0, 0.1, 0.66]} rotation={[-0.5, 0, 0]}>
          <boxGeometry args={[0.9, 0.04, 0.1]} />
          <meshStandardMaterial color={skin.keycap} roughness={0.3} metalness={0.15} />
        </mesh>

        {/* the whole key bed is one hit target: tap ANYWHERE and it types the next
            letter. Transparent rather than visible={false} — R3F skips pointer events
            on invisible meshes, so an opacity-0 plane is the reliable invisible target. */}
        <mesh position={[0, 0.34, 0.42]} rotation={[-0.5, 0, 0]} onPointerDown={onKeyDown}>
          <planeGeometry args={[1.95, 1.0]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>

        {/* the warm invitation pulse over the keys while sealed */}
        <sprite ref={inviteRef} position={[0, 0.34, 0.42]} scale={[1.1, 0.7, 1]}>
          <spriteMaterial map={GLOW} transparent depthWrite={false} toneMapped={false} opacity={0} blending={THREE.AdditiveBlending} />
        </sprite>

        {/* the margin bell's glint, at the platen's left end (right end in Arabic) */}
        <sprite ref={bellRef} position={[doc.rtl ? 0.95 : -0.95, STRIKE_Y + 0.24, -0.2]} scale={[0.16, 0.16, 1]}>
          <spriteMaterial map={GLOW} transparent depthWrite={false} toneMapped={false} opacity={0.15} blending={THREE.AdditiveBlending} />
        </sprite>

        {/* ---------------- the anglepoise lamp ---------------- */}
        {/* Stands off to the right and leans up, framing the sheet from the upper-right.
            It used to sit at z=0.35 and reach to center — arm and mint shade draped
            straight across the typed message, occluding it in every phase. Now the whole
            chain stays right of the page's text column and above it, at the sheet's own
            depth, so nothing crosses the words. */}
        <group position={[1.7, 0, -0.05]}>
          {/* weighted base */}
          <mesh position={[0, 0.05, 0]}>
            <cylinderGeometry args={[0.22, 0.26, 0.08, 24]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.3} metalness={0.8} />
          </mesh>
          {/* lower arm, rising with a slight lean toward the page */}
          <mesh position={[-0.12, 1.05, 0]} rotation={[0, 0, 0.2]}>
            <cylinderGeometry args={[0.025, 0.025, 2.1, 12]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.3} metalness={0.85} />
          </mesh>
          {/* elbow */}
          <mesh position={[-0.42, 2.05, 0]}>
            <sphereGeometry args={[0.06, 16, 16]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.3} metalness={0.85} />
          </mesh>
          {/* upper arm, angling the shade in over the top-right corner */}
          <mesh position={[-0.58, 2.2, 0]} rotation={[0, 0, -1.2]}>
            <cylinderGeometry args={[0.025, 0.025, 0.6, 12]} />
            <meshStandardMaterial color={skin.chrome} roughness={0.3} metalness={0.85} />
          </mesh>
          {/* the shade, angled down at the paper from the upper right */}
          <group position={[-0.78, 2.32, 0.02]} rotation={[0, 0, -2.3]}>
            <mesh>
              <coneGeometry args={[0.24, 0.3, 24, 1, true]} />
              <meshStandardMaterial color={skin.body} roughness={0.4} metalness={0.2} side={THREE.DoubleSide} />
            </mesh>
            {/* the glowing bulb inside */}
            <mesh position={[0, -0.06, 0]}>
              <sphereGeometry args={[0.07, 16, 16]} />
              <meshStandardMaterial color="#fff1cf" emissive="#ffdd9a" emissiveIntensity={2.2} toneMapped={false} />
            </mesh>
          </group>
        </group>
      </group>
    </>
  );
}
