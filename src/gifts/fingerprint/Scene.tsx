import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite, radialBlob } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
// `dust` is what the medium sheds when it is struck, and `sheen` is what the work
// lamp finds on it — wet clay is glossy and warm, plaster is chalk and takes the
// lamp cold, ink is a mirror. Neither is a tint on the same look.
const MEDIA: Record<
  string,
  { slab: string; rough: number; ridge: string; deep: string; metal: number; dust: string; sheen: string }
> = {
  clay: { slab: "#8d8175", rough: 0.86, ridge: "#5d5347", deep: "#3a332a", metal: 0.02, dust: "#c8bba8", sheen: "#ffe9c4" },
  ink: { slab: "#efe9dd", rough: 0.72, ridge: "#1d1b22", deep: "#0d0c10", metal: 0, dust: "#6f6a74", sheen: "#ffffff" },
  plaster: { slab: "#e6e1d6", rough: 0.9, ridge: "#a79e8d", deep: "#6f685c", metal: 0, dust: "#f0e8da", sheen: "#fff4dd" },
};
const RIDGE_GLOW: Record<string, string> = {
  gold: "#ffcc63",
  ember: "#ff7a3c",
  indigo: "#7f9cff",
};

const TAU = Math.PI * 2;
const TEX = 1024; // the ridges are hairlines; 512 turns them to mush
const SLAB_W = 2.3;
const SLAB_H = 1.28;
const SLAB_TILT = -0.22;
const ACTION_W = 2.6;
const ACTION_H = 1.9;

/* Print centres in uv. Theirs is already in the clay; yours goes on the right. */
const P1 = { x: 0.29, y: 0.54 };
const P2 = { x: 0.71, y: 0.54 };
const PRINT_R = 0.155; // full print radius in uv
const RIDGE_GAP = 0.0125; // uv spacing between ridges — a real thumb is about this
/** uv → the slab's own plane, which is where every mark and every prop lives. */
const sx = (u: number) => (u - 0.5) * SLAB_W;
const sy = (v: number) => (v - 0.5) * SLAB_H;

/**
 * One print: concentric offset loops round a core, each one wobbled by a couple of
 * low harmonics so it reads as a whorl and not as a target. `grow` 0..1 rolls the
 * ridges out from the contact point, which is exactly what pressing a thumb into
 * clay looks like from above.
 *
 * `smx/smy` is the drag the thumb was carrying, in canvas px. It is applied
 * proportionally to the ring index rather than to the print as a whole: the outer
 * loops rolled out last and have had the whole of the slide pushed into them, the
 * core has had almost none. That lag is what a smear actually is.
 *
 * `from` skips the inner rings, which is how the emissive canvas gets only the
 * outermost few — the shared lines light up, the private ones never do.
 */
function drawPrint(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  grow: number,
  seed: number,
  lw: number,
  smx: number,
  smy: number,
  from: number,
) {
  if (grow <= 0.001) return;
  const rand = mulberry32(seed);
  const ph1 = rand() * TAU;
  const ph2 = rand() * TAU;
  const squash = 0.86 + rand() * 0.12;
  g.lineWidth = lw;
  const rings = ringCount(r);
  for (let i = Math.max(1, from); i <= rings; i++) {
    const rad = i * RIDGE_GAP * TEX;
    if (rad > r * grow) break;
    const lag = i / rings;
    const ox = cx + smx * lag;
    const oy = cy + smy * lag;
    // Each loop opens at a different angle, so the whorl has a delta the way a
    // real one does instead of closing into rings.
    const open = 0.5 + 0.35 * Math.sin(i * 0.7 + ph1);
    g.beginPath();
    for (let k = 0; k <= 52; k++) {
      const a = open + (k / 52) * (TAU - 0.9);
      const wob =
        1 +
        0.11 * Math.sin(a * 2 + ph1 + i * 0.22) +
        0.06 * Math.sin(a * 3 - ph2 - i * 0.13);
      const x = ox + Math.cos(a) * rad * wob;
      const y = oy + Math.sin(a) * rad * wob * squash;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  if (from <= 1) {
    // the core itself
    g.beginPath();
    g.arc(cx, cy, RIDGE_GAP * TEX * 0.5, 0, TAU);
    g.stroke();
  }
}
const ringCount = (r: number) => Math.floor(r / (RIDGE_GAP * TEX)) + 1;

/**
 * The bowl the thumb leaves and the wall of clay it displaces doing it. The bump
 * map reads mid grey as flat, so the bowl is painted *under* the ridges as a dark
 * pool and the rim over them as a bright collar — press longer and the pool goes
 * deeper while the collar climbs, which is the whole of "a longer press cuts
 * deeper" said in two gradients.
 */
function drawYield(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  depth: number,
  rimUp: boolean,
) {
  if (r <= 1) return;
  if (rimUp) {
    g.lineWidth = 7 + depth * 9;
    g.strokeStyle = `rgba(255,255,255,${0.24 + depth * 0.5})`;
    g.beginPath();
    g.arc(cx, cy, r * 1.045, 0, TAU);
    g.stroke();
  } else {
    radialBlob(g, cx, cy, r * 1.12, `rgba(24,24,24,${0.3 + depth * 0.34})`);
  }
}

const TENDRIL_N = 8;
/**
 * The outer ridges reaching across the gap. Deliberately not a bridge of straight
 * lines: each strand leaves its own rim at its own angle, bows on the way over and
 * lands somewhere along the midline, and they stagger rather than arriving
 * together — clay tears organically or the join reads as wiring.
 */
function drawTendrils(g: CanvasRenderingContext2D, merge: number, rim: number, lw: number) {
  if (merge <= 0.02) return;
  const rand = mulberry32(3311);
  g.lineWidth = lw;
  const midX = 0.5 * TEX;
  for (let s = 0; s < 2; s++) {
    const p = s === 0 ? P1 : P2;
    const face = s === 0 ? 0 : Math.PI;
    const cx = p.x * TEX;
    const cy = (1 - p.y) * TEX;
    for (let k = 0; k < TENDRIL_N; k++) {
      const spread = k / (TENDRIL_N - 1) - 0.5;
      const wob = rand() - 0.5;
      const late = rand() * 0.34;
      // staggered starts, so the two fields interleave instead of shaking hands
      const grow = smooth(clamp01((merge - late) / (1 - late)));
      if (grow <= 0.01) continue;
      // They leave from right round the rim, not only off the facing edge — the
      // ones that start high or low have to arc, and the arc is what makes the
      // reach read as growth over a gap that is only a thumb's width wide.
      const a = face + spread * 1.7 + wob * 0.22;
      const x0 = cx + Math.cos(a) * rim;
      const y0 = cy + Math.sin(a) * rim * 0.9;
      const x1 = midX;
      const y1 = cy + spread * 0.26 * TEX + wob * 0.05 * TEX;
      // the bow: perpendicular to the run, so a strand curves the way a root does
      const bx = (x0 + x1) / 2 - (y1 - y0) * 0.24 * (wob > 0 ? 1 : -1);
      const by = (y0 + y1) / 2 + (x1 - x0) * 0.24 * (wob > 0 ? 1 : -1);
      g.beginPath();
      const steps = 15;
      for (let i = 0; i <= steps; i++) {
        const u = (i / steps) * grow;
        const iv = 1 - u;
        const x = iv * iv * x0 + 2 * iv * u * bx + u * u * x1;
        const y = iv * iv * y0 + 2 * iv * u * by + u * u * y1;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
  }
  // and once both sides are there, the seam itself — one continuous whorl
  if (merge > 0.86) {
    const a = smooth(clamp01((merge - 0.86) / 0.14));
    g.lineWidth = lw * 1.5;
    g.beginPath();
    for (let i = 0; i <= 26; i++) {
      const u = i / 26;
      const y = (1 - P1.y) * TEX + (u - 0.5) * 0.4 * TEX * a;
      g.lineTo(midX + Math.sin(u * 7.3) * 0.012 * TEX, y);
    }
    g.stroke();
  }
}

/**
 * The words, stamped into the clay between the two prints.
 *
 * This is the fallback the plan named, and the spike is why. Warping the ridge
 * field into letterforms *and* stroking `orderWritePath` as a ridge-like polyline
 * both fail the same way: that path is a dense column sweep through the ink, not a
 * centreline, so drawing it as a line gives a zigzag scribble — the exact smear the
 * plan warned about, and it is illegible at the size a phone shows the slab at.
 * A crisp raster blitted into both canvases keeps the words readable, and the ridge
 * fields reaching toward each other on either side still carry the idea.
 */
function drawWords(
  g: CanvasRenderingContext2D,
  raster: HTMLCanvasElement,
  span: number,
  scale: number,
) {
  const w = span * scale;
  const h = (w * raster.height) / raster.width;
  g.drawImage(raster, TEX / 2 - w / 2, TEX * 0.54 - h / 2, w, h);
}

/** Grain in the medium, so the slab is not a flat grey rectangle. */
function buildGrain(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#d8d8d8";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(5041);
  for (let i = 0; i < 9000; i++) {
    const v = 196 + rand() * 56;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rand() * s, rand() * s, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1.2);
  // Near-white, not mid-grey: `map` multiplies the albedo, and a 50% grain map
  // simply halves the slab before a single light touches it.
  return tex;
}
const GRAIN = buildGrain();
const HINT_SPRITE = makeRadialSprite(64);

/**
 * A wave in a soft surface, as a texture: a trough with the crest thrown up just
 * outside it. Drawn over the slab with plain alpha, the dark half reads as the
 * shadow side and the light half as the lit side, which is the only way a flat
 * quad can pass for clay moving.
 */
function buildRippleTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const tr = Math.exp(-((r - 0.62) ** 2) / 0.006);
      const cr = Math.exp(-((r - 0.8) ** 2) / 0.005);
      const i = (y * S + x) * 4;
      const v = cr / (cr + tr + 1e-5);
      d[i] = d[i + 1] = d[i + 2] = Math.round(255 * v);
      d[i + 3] = r < 1 ? Math.round(255 * Math.min(1, tr * 0.8 + cr * 0.85)) : 0;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
const RIPPLE_TEX = buildRippleTexture();

/* ---------- ripples, dust and the pulse along the join ---------- */
const RIPPLE_N = 4;
const RIPPLE_IDX = [0, 1, 2, 3];
const RIPPLE_LIFE = 0.95;
const PULSE_IDX = [-1, 1];
const PULSE_LIFE = 0.85;

const PUFF_N = 44;
const PUFF_LIFE = 1.0;

// Grit hanging over the slab in the lamp's beam. Every position is a closed form
// of the elapsed clock, so the layout is the same for every gift and can live at
// module scope; only the buffers are per-scene, because the colour is the medium's.
const MOTE_N = 46;
function buildMotes() {
  const rand = mulberry32(7714);
  const x = new Float32Array(MOTE_N);
  const y = new Float32Array(MOTE_N);
  const r = new Float32Array(MOTE_N);
  const sp = new Float32Array(MOTE_N);
  const ph = new Float32Array(MOTE_N);
  for (let i = 0; i < MOTE_N; i++) {
    x[i] = (rand() - 0.5) * SLAB_W * 1.15;
    y[i] = (rand() - 0.5) * SLAB_H * 1.5;
    r[i] = 0.03 + rand() * 0.11;
    sp[i] = 0.16 + rand() * 0.34;
    ph[i] = rand() * TAU;
  }
  return { x, y, r, sp, ph };
}
const MOTES = buildMotes();

/** Quantize for the repaint step key — hoisted so the frame allocates nothing. */
const q = (x: number, n: number) => Math.round(clamp01(x) * n);

/* ---------- opening ---------- */
const HOLD_DUR = 1.35; // press to a full print…
const DEEP_DUR = 1.1; // …and keep holding: it goes on cutting deeper
// A gift may never lock waiting for a gesture — and this one is also the gallery
// card's whole loop, which has no hands at all. Left alone this long, a phantom
// thumb lands and does it for you: the same press, the same beats, the same
// release. Untouched, onOpenComplete is at
// MERCY_WAIT + HOLD_DUR + DEEP_DUR + POST_END ≈ 8.3s, inside the 12s house bound.
const MERCY_WAIT = 2.4;
const MERGE_START = 0.3;
const MERGE_END = 1.6; // the two fields reach and join
const JOIN_AT = 1.42; // the strands touch, and the light runs both ways
const STAMP_AT = 1.95; // the message comes down
const STAMP_SET = 0.34; // …and settles out of its own impact
const NAMES_AT = 2.55;
const POST_END = 3.45;
const CAM_LOOK_Y = -0.02;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

const _v = new THREE.Vector3();

export default function FingerprintScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const med = MEDIA[variants.medium] ?? MEDIA.clay;
  const glow = RIDGE_GLOW[variants.ridges] ?? RIDGE_GLOW.gold;

  const write = useMemo(() => {
    const text = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    // White on transparent: both canvases want it as pure coverage — the relief
    // reads it as height and the emissive as where to light up.
    const t = makeTextTexture(text, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "700",
      fontSize: 84,
      color: "#ffffff",
      maxWidthPx: 84 * 8,
      lineHeight: 1.3,
      padding: 18,
      lang,
    });
    // The words live between the prints: the middle third, fitted on both axes.
    const span = Math.min(TEX * 0.46, (TEX * 0.32) / Math.max(0.2, t.aspect));
    return { raster: t.texture.image as HTMLCanvasElement, tex: t.texture, span };
  }, [message, recipientName, lang]);
  useEffect(() => () => write.tex.dispose(), [write]);

  /**
   * Two canvases, one geometry: `relief` is the bump map the light reads (both
   * prints plus the words as ridges), `lines` is the emissive that only ever holds
   * the shared lines. Both are redrawn on a step counter, not per frame — pressing
   * a thumb is a few dozen states, not sixty a second.
   */
  // Held in a ref, not a memo: the canvases are drawn into long after render, and
  // a memoized value may not be written to once render is over. The two textures
  // reach the material through `paint` below rather than through JSX, for the same
  // reason — nothing here may be read during render.
  const artRef = useRef<{
    relief: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
    lines: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
    reliefTex: THREE.CanvasTexture;
    linesTex: THREE.CanvasTexture;
    lit: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      artRef.current?.reliefTex.dispose();
      artRef.current?.linesTex.dispose();
      artRef.current = null;
    },
    [],
  );

  /** Redraw both canvases for a given state. Deliberately a plain function and not
   *  a useMemo: anything a hook captures becomes read-only afterwards, and this has
   *  to write to the canvases and to the slab's material. */
  const paint = (
    mine: number,
    deep: number,
    merge: number,
    stamp: number,
    smrx: number,
    smry: number,
  ) => {
    if (!artRef.current) {
      const mk = () => {
        const c = document.createElement("canvas");
        c.width = c.height = TEX;
        return { c, g: c.getContext("2d")! };
      };
      const relief = mk();
      const lines = mk();
      const reliefTex = new THREE.CanvasTexture(relief.c);
      const linesTex = new THREE.CanvasTexture(lines.c);
      reliefTex.anisotropy = linesTex.anisotropy = 4;
      artRef.current = { relief, lines, reliefTex, linesTex, lit: false };
    }
    const art = artRef.current;
    const slab = slabMatRef.current;
    if (slab && slab.bumpMap !== art.reliefTex) {
      slab.bumpMap = art.reliefTex;
      slab.emissiveMap = art.linesTex;
      slab.needsUpdate = true;
    }
    const { g: rg } = art.relief;
    const { g: lg } = art.lines;
    // Nothing lights until the fields meet, and re-uploading a blank 1024² (mipmaps
    // and all) twenty times a second through the whole press is the one cost here a
    // mid phone would actually feel. Touch the emissive only while it holds something.
    const lit = merge > 0.4 || stamp > 0;
    if (lit || art.lit) lg.clearRect(0, 0, TEX, TEX);
    // The bump map is read as height: mid grey is the flat slab, white is a ridge.
    // An opaque fill is its own clear, so the relief never pays for one.
    rg.fillStyle = "#6a6a6a";
    rg.fillRect(0, 0, TEX, TEX);
    rg.lineCap = lg.lineCap = "round";
    rg.lineJoin = lg.lineJoin = "round";

    // Theirs is already in the clay, and it reaches first — it has had longer.
    // The print itself is done rolling out by now; the reaching is the tendrils'
    // job, so the field only creeps — grown any further the two rims simply
    // overlap and there is no gap left for a strand to cross.
    const rr = PRINT_R * TEX * (1 + merge * 0.08);
    const x1 = P1.x * TEX;
    const y1 = (1 - P1.y) * TEX;
    const x2 = P2.x * TEX;
    const y2 = (1 - P2.y) * TEX;

    drawYield(rg, x1, y1, rr, 0.62, false);
    drawYield(rg, x2 + smrx, y2 + smry, rr * mine, deep, false);

    rg.strokeStyle = "#f2f2f2";
    drawPrint(rg, x1, y1, rr, 1, 8821, 4.6, 0, 0, 1);
    // deeper press, fatter ridges: the clay has had more of itself pushed aside
    drawPrint(rg, x2, y2, rr, mine, 4409, 4.6 + deep * 1.7, smrx, smry, 1);

    drawYield(rg, x1, y1, rr, 0.62, true);
    drawYield(rg, x2 + smrx, y2 + smry, rr * mine, deep, true);

    if (merge > 0) {
      rg.strokeStyle = "#ededed";
      drawTendrils(rg, merge, rr * 1.02, 3.6);
    }

    // Only the shared lines light: the emissive canvas holds the strands that
    // crossed, the outermost loop of each print they grew out of, and the words.
    if (merge > 0.4) {
      const a = smooth(clamp01((merge - 0.4) / 0.6));
      lg.globalAlpha = a;
      lg.strokeStyle = "#ffffff";
      drawTendrils(lg, merge, rr * 1.02, 3.0);
      drawPrint(lg, x1, y1, rr, 1, 8821, 3.0, 0, 0, ringCount(rr) - 1);
      drawPrint(lg, x2, y2, rr, mine, 4409, 3.0, smrx, smry, ringCount(rr) - 1);
      lg.globalAlpha = 1;
    }

    if (stamp > 0) {
      // A stamp arrives at full ink and then settles out of its own overshoot; a
      // fade would be a photograph developing, which is a different object.
      const wa = clamp01(stamp * 5);
      const ws = lerp(1.13, 1, easeOutBack(clamp01(stamp)));
      rg.globalAlpha = wa;
      drawWords(rg, write.raster, write.span, ws);
      rg.globalAlpha = 1;
      lg.globalAlpha = wa;
      drawWords(lg, write.raster, write.span, ws);
      lg.globalAlpha = 1;
    }
    art.reliefTex.needsUpdate = true;
    if (lit || art.lit) art.linesTex.needsUpdate = true;
    art.lit = lit;
  };

  const names = useMemo(() => {
    const t = makeTextTexture(`${senderName || "—"}   ·   ${recipientName || "—"}`, {
      fontFamily: "Georgia, serif",
      fontWeight: "600",
      fontSize: 42,
      color: med.ridge,
      maxWidthPx: 42 * 14,
      padding: 12,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 0.9, 0.12) };
  }, [senderName, recipientName, lang, med]);
  useEffect(() => () => names.t.texture.dispose(), [names]);

  const dustC = useMemo(() => new THREE.Color(med.dust), [med]);

  // Buffers feed <bufferAttribute> and are only ever written through the points
  // ref in useFrame; the puff sim itself is mutable state, so it lives in a ref.
  const puffBuf = useMemo(
    () => ({ pos: new Float32Array(PUFF_N * 3), col: new Float32Array(PUFF_N * 3) }),
    [],
  );
  const moteBuf = useMemo(
    () => ({ pos: new Float32Array(MOTE_N * 3), col: new Float32Array(MOTE_N * 3) }),
    [],
  );

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  const fresh = () => ({
    hold: 0,
    down: false,
    lifted: false,
    liftAt: 0,
    step: -1,
    paintAt: -9,
    touched: false,
    hover: false,
    seeded: false,
    /* `real` is a *hand's* press, as opposed to the mercy's phantom one, and
       `alone` is how long nothing at all has touched the slab. */
    real: false,
    alone: 0,
    dx: 0,
    dy: 0,
    px: 0,
    py: 0,
    sx: 0,
    sy: 0,
    vel: 0,
    tx: sx(P2.x),
    ty: sy(P2.y),
    now: 0,
    joltAt: -9,
    crumb: 0,
    sJoin: false,
    sStamp: false,
    sNames: false,
  });
  /* `hold` is the press in seconds; `lifted` latches the release that finishes it. */
  const g = useRef(fresh());
  const rip = useRef({
    t0: new Float32Array(RIPPLE_N).fill(-9),
    x: new Float32Array(RIPPLE_N),
    y: new Float32Array(RIPPLE_N),
    amp: new Float32Array(RIPPLE_N),
    cur: 0,
  });
  const puff = useRef({
    t0: new Float32Array(PUFF_N).fill(-9),
    ox: new Float32Array(PUFF_N),
    oy: new Float32Array(PUFF_N),
    vx: new Float32Array(PUFF_N),
    vy: new Float32Array(PUFF_N),
    sz: new Float32Array(PUFF_N),
    cur: 0,
  });
  // Replay re-enters "opening": the clock resets, so everything the gesture
  // accumulated has to as well or the second run would open on the first's smear.
  useEffect(() => {
    if (phase !== "opening") return;
    g.current = fresh();
    rip.current.t0.fill(-9);
    puff.current.t0.fill(-9);
  }, [phase]);
  // The create page retypes the message under a preview whose every other value is
  // pinned at 1, so the step key on its own would never ask for the one repaint that
  // carries the new words onto the slab.
  useEffect(() => {
    g.current.step = -1;
  }, [write]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const jarRef = useRef<THREE.Group>(null);
  const slabMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const pressRef = useRef<THREE.Mesh>(null);
  const pressMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const thumbRef = useRef<THREE.Group>(null);
  const namesRef = useRef<THREE.Mesh>(null);
  const namesMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintRef = useRef<THREE.Mesh>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const sheenRef = useRef<THREE.Mesh>(null);
  const sheenMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lampRef = useRef<THREE.PointLight>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  const motesRef = useRef<THREE.Points>(null);
  const puffRef = useRef<THREE.Points>(null);
  // Several meshes of a kind, one loop over them: a bag of individual refs is what
  // the immutability rule objects to, an array collected by callback ref is not.
  const ripRefs = useRef<(THREE.Mesh | null)[]>([]);
  const ripMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const pulseRefs = useRef<(THREE.Mesh | null)[]>([]);
  const pulseMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);

  const emitRipple = (x: number, y: number, amp: number, now: number) => {
    const r = rip.current;
    const i = r.cur;
    r.cur = (i + 1) % RIPPLE_N;
    r.t0[i] = now;
    r.x[i] = x;
    r.y[i] = y;
    r.amp[i] = amp;
  };
  const emitPuff = (
    n: number,
    x: number,
    y: number,
    spread: number,
    speed: number,
    now: number,
  ) => {
    const p = puff.current;
    for (let k = 0; k < n; k++) {
      const i = p.cur;
      p.cur = (i + 1) % PUFF_N;
      const a = Math.random() * TAU;
      p.t0[i] = now;
      p.ox[i] = x + Math.cos(a) * spread;
      p.oy[i] = y + Math.sin(a) * spread * 0.5;
      p.vx[i] = Math.cos(a) * speed * (0.5 + Math.random());
      p.vy[i] = Math.abs(Math.sin(a)) * speed * 0.5 + speed * (0.4 + Math.random() * 0.6);
      p.sz[i] = 0.5 + Math.random() * 0.9;
    }
  };

  /* ---------- the press ---------- */
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.lifted) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    const c = g.current;
    const hit = hitRef.current;
    if (hit) {
      hit.worldToLocal(_v.copy(ev.point));
      c.dx = _v.x;
      c.dy = _v.y;
      c.px = _v.x;
      c.py = _v.y;
      c.seeded = true;
    }
    c.down = true;
    c.real = true;
    c.alone = 0;
    c.touched = true;
    // wet clay under a thumb is a dull wet knock, not a tap
    clack({ freq: 240, decay: 0.14, gain: 0.2 });
    emitRipple(sx(P2.x), sy(P2.y), 1, c.now);
    emitPuff(5, sx(P2.x), sy(P2.y), 0.1, 0.22, c.now);
  };
  /**
   * The mercy: the same press, with nobody behind it. It goes through `down`
   * rather than around it, so the thumb still comes down, the clay still yields,
   * and the frame loop still lifts it at the end of the deep hold — one timeline,
   * driven from the other end. `hold` only ever accumulates, so this is a floor
   * under the gesture and can never pull a real press backwards; it does not
   * `resumeAudio`, and it does not seed a drag, so a wandering pointer over a
   * phantom press cannot smear a print nobody put there.
   */
  const phantomPress = (now: number) => {
    const c = g.current;
    c.down = true;
    c.touched = true;
    clack({ freq: 240, decay: 0.14, gain: 0.2 });
    emitRipple(sx(P2.x), sy(P2.y), 1, now);
    emitPuff(5, sx(P2.x), sy(P2.y), 0.1, 0.22, now);
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    const hit = hitRef.current;
    c.alone = 0;
    if (!hit || !c.real || c.lifted || phase !== "opening") return;
    ev.stopPropagation();
    hit.worldToLocal(_v.copy(ev.point));
    if (!c.seeded) {
      c.seeded = true;
      c.dx = _v.x;
      c.dy = _v.y;
    }
    const d = Math.hypot(_v.x - c.px, _v.y - c.py);
    // A captured pointer freezes at its last hit and jumps on re-entry.
    if (d < 0.6) {
      c.vel = Math.min(3, c.vel + d * 9);
      c.crumb += d * 26;
      if (d > 0.02) emitRipple(c.tx, c.ty, Math.min(0.6, d * 5), c.now);
    }
    c.px = _v.x;
    c.py = _v.y;
    // Clamped: a slide across wet clay smears the print, it does not relocate it.
    c.sx = Math.max(-0.055, Math.min(0.055, (_v.x - c.dx) / SLAB_W));
    c.sy = Math.max(-0.05, Math.min(0.05, (_v.y - c.dy) / SLAB_H));
  };
  const release = () => {
    const c = g.current;
    if (!c.down) return;
    c.down = false;
    c.real = false;
    c.seeded = false;
    // A print you lifted too early is still a print — a real thumb never gets a
    // second go at the same clay, and refusing the gesture would be worse.
    if (c.hold > 0.25 && !c.lifted) {
      c.lifted = true;
      c.liftAt = tRef.current;
      tone(330, { type: "sine", seconds: 0.5, gain: 0.16 });
      // the clay comes back up after the thumb: one big ripple off the rim
      emitRipple(c.tx, c.ty, 1.15, c.now);
      emitPuff(7, c.tx, c.ty, 0.14, 0.3, c.now);
    }
  };
  /* Only a hand can end a hand's press: a pointer that merely wanders off, or
     comes up having never come down, must not cut the phantom one short. */
  const lift = () => {
    if (g.current.real) release();
  };
  const leave = () => {
    g.current.hover = false;
    lift();
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const c = g.current;
    const opening = phase === "opening";
    const preview = phase === "preview";
    const revealed = phase === "revealed";
    c.now = e;

    if (fitRef.current) {
      const fit = Math.max(
        0.62,
        Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H),
      );
      // the slab breathes even when nothing is happening to it
      fitRef.current.scale.setScalar(fit * (1 + 0.005 * Math.sin(e * 0.72)));
    }

    /* ---- nobody has touched it: a phantom thumb lands and does the gesture ---- */
    // Reset by the phase effect and by any real pointer, so a hand that is only
    // about to reach for the clay is never overridden.
    if (opening && !c.down && !c.lifted) {
      c.alone += dt;
      if (c.alone >= MERCY_WAIT) phantomPress(e);
    }

    /* ---- the press ---- */
    if (opening && c.down && !c.lifted) {
      c.hold += dt;
      if (c.hold >= HOLD_DUR + DEEP_DUR) release();
    }
    c.vel = Math.max(0, c.vel - dt * 3.2);

    const post = revealed ? POST_END : c.lifted ? t - c.liftAt : -1;
    const mine = phase === "sealed" ? 0 : opening ? clamp01(c.hold / HOLD_DUR) : 1;
    // depth keeps accumulating past a full print, and freezes the moment the
    // thumb leaves: the clay does not un-remember how long it was held
    const deep = opening
      ? clamp01((c.hold - HOLD_DUR * 0.35) / DEEP_DUR)
      : phase === "sealed"
        ? 0
        : 0.62;
    const merge = revealed || preview
      ? 1
      : post < 0
        ? 0
        : smooth(clamp01((post - MERGE_START) / (MERGE_END - MERGE_START)));
    const stamp = revealed || preview ? 1 : post < 0 ? 0 : clamp01((post - STAMP_AT) / STAMP_SET);
    const namesA = revealed || preview ? 1 : post < 0 ? 0 : clamp01((post - NAMES_AT) / 0.5);
    // The clay comes back up the instant the thumb leaves, overshoots, and rings
    // down. Negative first: the very first thing a rebound does is get shallower.
    const reb = post >= 0 && post < 1.4 ? -Math.exp(-post * 6) * Math.sin(post * 21) : 0;

    /* ---- the beats, each fired once ---- */
    if (opening && post >= 0) {
      if (!c.sJoin && post >= JOIN_AT) {
        c.sJoin = true;
        tone(494, { type: "sine", seconds: 0.8, gain: 0.12, shimmer: true });
      }
      if (!c.sStamp && post >= STAMP_AT) {
        c.sStamp = true;
        clack({ freq: 150, decay: 0.22, gain: 0.32 });
        tone(126, { type: "sine", seconds: 0.42, gain: 0.11 });
        c.joltAt = t;
        emitRipple(0, sy(0.46), 1.3, e);
        emitPuff(26, 0, sy(0.46), 0.34, 0.5, e);
      }
      if (!c.sNames && post >= NAMES_AT) {
        c.sNames = true;
        clack({ freq: 430, decay: 0.07, gain: 0.11 });
        emitPuff(8, 0, -SLAB_H * 0.36, 0.3, 0.2, e);
      }
    }
    // grit thrown off the rim while the thumb is dragging through the clay
    if (opening && c.crumb > 1) {
      c.crumb = 0;
      emitPuff(2, c.tx, c.ty, 0.09, 0.18 + c.vel * 0.08, e);
    }

    /* ---- redraw only when the state has actually moved a step ---- */
    const smrx = revealed || preview ? 0 : c.sx * TEX;
    const smry = revealed || preview ? 0 : -c.sy * TEX;
    const step =
      ((((q(mine, 26) * 24 + q(merge, 23)) * 22 + q(stamp, 21)) * 13 + q(deep, 12)) * 9 +
        q((c.sx + 0.06) / 0.12, 8)) *
        9 +
      q((c.sy + 0.06) / 0.12, 8);
    // A 1024² repaint is a couple of milliseconds; a fast drag would ask for one
    // every frame. Throttled, the last state still lands within 50ms of settling.
    if (step !== c.step && e - c.paintAt > 0.05) {
      c.step = step;
      c.paintAt = e;
      paint(mine, deep, merge, stamp, smrx, smry);
    }

    /* ---- the slab, and what the jolt does to it ---- */
    const ja = t - c.joltAt;
    const jolt = opening && ja >= 0 && ja < 0.9 ? Math.exp(-ja * 8) * Math.sin(ja * 34) : 0;
    if (tiltRef.current) {
      // it leans toward the pointer before it is touched, and keeps a little of
      // that lean afterwards — an object that watches you is an invitation
      const k = Math.min(1, dt * 2.6);
      const lean = revealed ? 0.35 : 1;
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.05 * lean, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.07 * lean, k);
    }
    if (jarRef.current) {
      jarRef.current.rotation.x = jolt * 0.035;
      jarRef.current.rotation.z = jolt * 0.014;
      jarRef.current.position.y = jolt * -0.02;
    }

    // What the eye is shown, rather than what the canvas was painted at: the
    // rebound rides on it, and so does the extra clay a fast plough throws up.
    const depthVis = deep * (1 + reb * 0.35) + c.vel * 0.05;
    if (slabMatRef.current) {
      const m = slabMatRef.current;
      // the relief deepens as the fields merge, and rings once on the stamp
      m.bumpScale = lerp(0.42, 0.64, merge) + depthVis * 0.1 + jolt * 0.06;
      const emisA = Math.max(smooth(clamp01((merge - 0.4) / 0.6)) * 0.66, stamp);
      m.emissiveIntensity = emisA * (0.72 + 0.28 * Math.sin(e * 1.5 - merge * 2));
    }

    /* ---- the pool of shade under your thumb ---- */
    if (pressRef.current && pressMatRef.current) {
      const px = sx(P2.x) + c.sx * SLAB_W;
      const py = sy(P2.y) + c.sy * SLAB_H;
      // the thumb, and the shade under it, lag the finger: clay resists
      c.tx = lerp(c.tx, px, Math.min(1, dt * 11));
      c.ty = lerp(c.ty, py, Math.min(1, dt * 11));
      pressRef.current.position.set(c.tx, c.ty, 0.013);
      pressRef.current.visible = mine > 0.02;
      pressRef.current.scale.setScalar(lerp(0.45, 1.06, mine) * (1 + reb * 0.06));
      pressMatRef.current.opacity = (0.05 + 0.17 * depthVis) * (1 - 0.35 * merge);
    }

    /* ---- your thumb coming down, and lifting away ---- */
    if (thumbRef.current) {
      const th = thumbRef.current;
      const down = opening && c.down && !c.lifted;
      const lift = opening && c.lifted ? clamp01(post / 0.4) : 1;
      th.visible = down || (opening && c.lifted && post < 0.4);
      if (th.visible) {
        th.position.x = c.tx;
        th.position.y = c.ty + 0.18;
        th.position.z = down
          ? lerp(0.5, 0.15 - depthVis * 0.03, easeOutCubic(mine))
          : lerp(0.15, 0.62, easeOutCubic(lift));
        // it tips into whatever direction it is being dragged — resistance, seen
        th.rotation.z = (sx(P2.x) + c.sx * SLAB_W - c.tx) * 2.2;
        th.rotation.x = (sy(P2.y) + c.sy * SLAB_H - c.ty) * -2.2;
      }
    }

    /* ---- ripples travelling out of the contact ---- */
    for (let i = 0; i < RIPPLE_N; i++) {
      const m = ripRefs.current[i];
      const mm = ripMats.current[i];
      if (!m || !mm) continue;
      const a = e - rip.current.t0[i];
      if (a < 0 || a > RIPPLE_LIFE) {
        m.visible = false;
        continue;
      }
      const u = a / RIPPLE_LIFE;
      m.visible = true;
      m.position.x = rip.current.x[i];
      m.position.y = rip.current.y[i];
      const s = lerp(0.18, 1.55, easeOutCubic(u)) * (0.7 + rip.current.amp[i] * 0.4);
      m.scale.set(s, s * 0.94, 1);
      mm.opacity = clamp01(rip.current.amp[i]) * 0.32 * (1 - u) * (1 - u);
    }

    /* ---- the pulse of light running both ways along the join ---- */
    // It fires on the meeting in `opening`, loops slowly on the gallery card, and
    // breathes now and then once everything has settled — offset there, past the
    // burst reduced motion runs, or the frozen last frame catches it mid-flight.
    const pt = opening
      ? c.sJoin
        ? post - JOIN_AT
        : -1
      : preview
        ? e % 4.6
        : revealed
          ? (e + 3) % 6.2
          : -1;
    const pu = pt >= 0 && pt < PULSE_LIFE ? pt / PULSE_LIFE : -1;
    for (let i = 0; i < 2; i++) {
      const m = pulseRefs.current[i];
      const mm = pulseMats.current[i];
      if (!m || !mm) continue;
      if (pu < 0) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.x = PULSE_IDX[i] * easeOutCubic(pu) * (P2.x - 0.5) * SLAB_W;
      const amp = revealed ? 0.5 : 1;
      mm.opacity = Math.sin(pu * Math.PI) * 0.85 * amp;
      const s = lerp(0.5, 0.26, pu);
      m.scale.set(s, s, 1);
    }

    /* ---- the work lamp, and the specular it drags over the wet clay ---- */
    const sweepU = opening && post >= 0 ? clamp01((post - (STAMP_AT - 0.55)) / 1.7) : 0;
    const sweeping = sweepU > 0 && sweepU < 1;
    const lampX = sweeping
      ? lerp(Math.sin(e * 0.5) * 1.5, lerp(-2.1, 1.8, easeInOut(sweepU)), Math.sin(sweepU * Math.PI))
      : Math.sin(e * 0.5) * 1.5;
    if (lampRef.current) {
      // The work lamp swings a little, which is the only way flat ridges read as
      // deep, and it never quite holds still — a bulb on a stalk in a workshop.
      lampRef.current.position.x = lampX;
      lampRef.current.position.y = 1.1 + Math.cos(e * 0.4) * 0.3;
      lampRef.current.intensity =
        7 * (1 + 0.035 * Math.sin(e * 9.3) + 0.02 * Math.sin(e * 23.1)) + sweepU * (1 - sweepU) * 6;
    }
    if (sheenRef.current && sheenMatRef.current) {
      sheenRef.current.position.x = lampX * 0.34;
      sheenRef.current.rotation.z = lampX * 0.05;
      const wet = revealed ? 0.13 : preview ? 0.16 : 0.12;
      sheenMatRef.current.opacity =
        wet + 0.05 * Math.sin(e * 0.9) + (sweeping ? Math.sin(sweepU * Math.PI) * 0.24 : 0);
    }

    /* ---- both names, impressed small beneath ---- */
    if (namesMatRef.current) namesMatRef.current.opacity = namesA;
    if (namesRef.current) {
      // softer than the message: it settles from a smaller overshoot, not a bigger
      namesRef.current.scale.setScalar(namesA > 0 ? lerp(0.9, 1, easeOutBack(namesA)) : 0.9);
    }

    /* ---- the invitation, and what a hovering pointer does to it ---- */
    if (hintMatRef.current && hintRef.current) {
      const want =
        opening && !c.touched
          ? (0.26 + 0.2 * Math.sin(e * 2.7)) * (c.hover ? 1.45 : 1)
          : phase === "sealed"
            ? 0.07 + 0.05 * Math.sin(e * 0.9)
            : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
      const lead = opening && !c.touched ? 1 : 0;
      hintRef.current.position.x = sx(P2.x) + state.pointer.x * 0.06 * lead;
      hintRef.current.position.y = sy(P2.y) + state.pointer.y * 0.04 * lead;
      hintRef.current.scale.setScalar(1 + (0.16 + 0.1 * Math.sin(e * 2.7)) * lead);
    }

    /* ---- grit in the beam ---- */
    const mp = motesRef.current;
    if (mp) {
      const pa = mp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = mp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < MOTE_N; i++) {
        const a = MOTES.ph[i] + e * MOTES.sp[i] * 0.4;
        pa.setXYZ(
          i,
          MOTES.x[i] + Math.cos(a) * MOTES.r[i],
          MOTES.y[i] + Math.sin(a * 0.8) * MOTES.r[i] * 0.7,
          0.1 + Math.sin(a * 0.6) * 0.06,
        );
        const b = (0.2 + 0.22 * Math.sin(e * 1.4 + MOTES.ph[i])) * (0.5 + 0.5 * Math.cos(a));
        ca.setXYZ(i, dustC.r * b, dustC.g * b, dustC.b * b);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- the dust the stamp knocks loose ---- */
    const pp = puffRef.current;
    if (pp) {
      const pk = puff.current;
      const pa = pp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = pp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < PUFF_N; i++) {
        const a = e - pk.t0[i];
        if (a < 0 || a > PUFF_LIFE) {
          ca.setXYZ(i, 0, 0, 0);
          continue;
        }
        // out, up, and then down again: dust has almost no mass but it still falls
        pa.setXYZ(
          i,
          pk.ox[i] + pk.vx[i] * a,
          pk.oy[i] + pk.vy[i] * a - 0.5 * a * a,
          0.06 + a * 0.14,
        );
        const k = (1 - a / PUFF_LIFE) * pk.sz[i];
        ca.setXYZ(i, dustC.r * k, dustC.g * k, dustC.b * k);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- camera: it leans in while you press, and settles once it is done ---- */
    const cam = camRef.current;
    if (cam) {
      let cx = 0;
      let cy: number;
      let cz: number;
      if (opening) {
        // The push-in is bought by the press itself and then held through the
        // reveal — and it lands on the revealed framing, so the phase flip is one
        // continuous move and not a cut.
        cz = 2.35 - depthVis * 0.07 - mine * 0.04 - smooth(clamp01(post / 1.2)) * 0.05;
        cy = -0.12 + merge * 0.045 + jolt * 0.022;
        cx = c.sx * 0.5;
      } else if (revealed) {
        cz = 2.21 + 0.012 * Math.sin(e * 0.36);
        cy = -0.07 + 0.008 * Math.sin(e * 0.29);
      } else if (preview) {
        cz = 2.32 + 0.05 * Math.sin(e * 0.24);
        cy = -0.1 + 0.03 * Math.sin(e * 0.19);
        cx = 0.05 * Math.sin(e * 0.15);
      } else {
        cz = 2.36 + 0.02 * Math.sin(e * 0.31);
        cy = -0.12 + 0.014 * Math.sin(e * 0.23);
      }
      if (opening) {
        // smoothed only where it chases something live; the static tableaux are
        // framed cold so a reduced-motion burst lands on the right shot
        const k = Math.min(1, dt * 3.4);
        cam.position.x = lerp(cam.position.x, cx, k);
        cam.position.y = lerp(cam.position.y, cy, k);
        cam.position.z = lerp(cam.position.z, cz, k);
      } else {
        cam.position.set(cx, cy, cz);
      }
      cam.lookAt(0, CAM_LOOK_Y, 0);
    }

    if (opening && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  // No "set the static pose" effect: `step` starts at -1 and every phase computes
  // a real step, so the first frame after mount (or after a phase change) always
  // repaints — including the single settling burst reduced motion runs.

  return (
    <>
      <PerspectiveCamera makeDefault ref={camRef} position={[0, -0.12, 2.35]} fov={42} />
      <ambientLight intensity={0.6} />
      {/* a work lamp, low and raking — ridges are only ridges under a raking light */}
      <pointLight ref={lampRef} position={[0, 1.1, 1.5]} intensity={7} color="#fff2dc" distance={9} decay={1.1} />
      <directionalLight position={[-1.8, -0.6, 1.4]} intensity={0.3} color="#9fb4d6" />

      <mesh position={[0, 0, -1.4]}>
        <planeGeometry args={[14, 10]} />
        <meshBasicMaterial color="#14110f" depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        <group ref={tiltRef}>
          <group ref={jarRef}>
            {/* everything that lies *in* the clay shares the slab's own plane, so a
                mark at uv (u,v) is at (sx(u), sy(v)) and nothing floats off it */}
            <group rotation={[SLAB_TILT, 0, 0]}>
              {/* the slab. One plane, and every mark on it is a bump map — no
                  displacement, no second geometry, and it survives a mid-phone. */}
              <mesh>
                <planeGeometry args={[SLAB_W, SLAB_H]} />
                <meshStandardMaterial
                  ref={slabMatRef}
                  color={med.slab}
                  roughness={med.rough}
                  metalness={med.metal}
                  map={GRAIN}
                  bumpScale={0.55}
                  emissive={glow}
                  emissiveIntensity={0}
                />
              </mesh>

              {/* the shade pooled in theirs, which has been sitting there a while */}
              <mesh position={[sx(P1.x), sy(P1.y), 0.012]}>
                <circleGeometry args={[PRINT_R * SLAB_W * 1.2, 28]} />
                <meshBasicMaterial color="#000000" transparent opacity={0.13} depthWrite={false} />
              </mesh>
              {/* …and in yours, which deepens for exactly as long as you hold it */}
              <mesh ref={pressRef} position={[sx(P2.x), sy(P2.y), 0.013]} visible={false}>
                <circleGeometry args={[PRINT_R * SLAB_W * 1.2, 28]} />
                <meshBasicMaterial ref={pressMatRef} color="#000000" transparent opacity={0} depthWrite={false} />
              </mesh>

              {/* the clay yielding, travelling out and settling */}
              {RIPPLE_IDX.map((i) => (
                <mesh
                  key={i}
                  ref={(m) => {
                    ripRefs.current[i] = m;
                  }}
                  position={[0, 0, 0.016]}
                  visible={false}
                >
                  <planeGeometry args={[1, 1]} />
                  <meshBasicMaterial
                    ref={(m) => {
                      ripMats.current[i] = m;
                    }}
                    map={RIPPLE_TEX}
                    transparent
                    opacity={0}
                    depthWrite={false}
                    toneMapped={false}
                  />
                </mesh>
              ))}

              {/* both names, impressed small beneath */}
              <mesh ref={namesRef} position={[0, -SLAB_H * 0.36, 0.03]}>
                <planeGeometry args={names.size} />
                <meshBasicMaterial ref={namesMatRef} map={names.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
              </mesh>

              {/* the wet sheen the lamp drags across the ridges */}
              <mesh ref={sheenRef} position={[0, 0, 0.05]}>
                <planeGeometry args={[SLAB_W * 0.42, SLAB_H * 1.25]} />
                <meshBasicMaterial
                  ref={sheenMatRef}
                  map={HINT_SPRITE}
                  color={med.sheen}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                  toneMapped={false}
                />
              </mesh>

              {/* the light running both ways out of the join */}
              {PULSE_IDX.map((s, i) => (
                <mesh
                  key={s}
                  ref={(m) => {
                    pulseRefs.current[i] = m;
                  }}
                  position={[0, sy(P1.y), 0.055]}
                  visible={false}
                >
                  <planeGeometry args={[1, 1]} />
                  <meshBasicMaterial
                    ref={(m) => {
                      pulseMats.current[i] = m;
                    }}
                    map={HINT_SPRITE}
                    color={glow}
                    transparent
                    opacity={0}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                  />
                </mesh>
              ))}

              {/* press here — and it stops the instant a finger lands */}
              <mesh ref={hintRef} position={[sx(P2.x), sy(P2.y), 0.06]}>
                <planeGeometry args={[0.75, 0.75]} />
                <meshBasicMaterial
                  ref={hintMatRef}
                  map={HINT_SPRITE}
                  color={glow}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            </group>

            {/* the rim of the slab, so it is a slab and not a photograph of one */}
            <mesh position={[0, -SLAB_H / 2 - 0.03, -0.03]} rotation={[SLAB_TILT, 0, 0]}>
              <boxGeometry args={[SLAB_W, 0.07, 0.16]} />
              <meshStandardMaterial color={med.deep} roughness={0.9} />
            </mesh>

            {/* grit hanging in the beam, and the dust the stamp knocks loose */}
            <points ref={motesRef} frustumCulled={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[moteBuf.pos, 3]} />
                <bufferAttribute attach="attributes-color" args={[moteBuf.col, 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={HINT_SPRITE}
                vertexColors
                size={0.026}
                sizeAttenuation
                transparent
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </points>
            <points ref={puffRef} frustumCulled={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[puffBuf.pos, 3]} />
                <bufferAttribute attach="attributes-color" args={[puffBuf.col, 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={HINT_SPRITE}
                vertexColors
                size={0.055}
                sizeAttenuation
                transparent
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </points>

            {/* your thumb coming down — it is the only thing in the scene with a body */}
            <group ref={thumbRef} position={[sx(P2.x), sy(P2.y) + 0.18, 0.5]} visible={false}>
              <mesh rotation={[0.5, 0, 0]}>
                <capsuleGeometry args={[0.14, 0.5, 6, 16]} />
                <meshStandardMaterial color="#d19a72" roughness={0.68} />
              </mesh>
            </group>
          </group>
        </group>

        {/* r185 raycasts straight through `visible={false}`, so the hit target is a
            transparent mesh instead, and only exists while it is wanted */}
        {phase === "opening" && (
          <mesh
            ref={hitRef}
            position={[0, 0, 0.8]}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={lift}
            onPointerCancel={lift}
            onPointerOver={() => {
              g.current.hover = true;
            }}
            onPointerOut={leave}
          >
            <planeGeometry args={[9, 7]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        )}
      </group>
    </>
  );
}
