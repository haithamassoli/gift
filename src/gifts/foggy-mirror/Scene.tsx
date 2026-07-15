import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makePaintMask, type PaintMask } from "../mask";
import { orderWritePath, type WritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";

/* ---------- settings: the world behind the glass, way out of focus ---------- */
type Motion = "rain" | "candle" | "train";
const SETTINGS: Record<
  string,
  {
    fog: string; // condensation
    rim: string; // water shoved aside by the fingertip, catching the light
    back: string; // the room
    haze: string; // its soft central glow
    far: string[]; // small bokeh tints
    near: string[]; // big soft bokeh tints
    motion: Motion;
    seed: number;
  }
> = {
  "rain-window": {
    fog: "#d7e3ee", rim: "#f4faff", back: "#0b1119", haze: "#1e3450",
    far: ["#9fc6f0", "#c8dcf5", "#e8b979", "#8fb4e0"],
    near: ["#5b86bd", "#d9a05c", "#7fa6d4"],
    motion: "rain", seed: 4211,
  },
  candlelight: {
    fog: "#eee0cd", rim: "#fff7e8", back: "#150d07", haze: "#4a2a10",
    far: ["#ffbc63", "#ff9a3c", "#ffd9a0", "#e07a35"],
    near: ["#ff9c3a", "#ffc978", "#c8611f"],
    motion: "candle", seed: 918,
  },
  "night-train": {
    fog: "#d4e2e5", rim: "#eafdff", back: "#070c10", haze: "#123038",
    far: ["#7fe6e0", "#ffd28a", "#a9f0ff", "#5fbfc9"],
    near: ["#2f9aa8", "#e8b25e", "#59cfd8"],
    motion: "train", seed: 3307,
  },
};

/* ---------- the pane ---------- */
const MASK_SIZE = 512;
const TEXEL = 1 / MASK_SIZE;
const GLASS_PAD = 1.02; // a hair past the viewport, so no sliver of bare canvas shows at the edge
const W_FRAC = 0.86; // of the visible width
const H_FRAC = 0.74; // of the visible height

// THE RULE ON THIS PANE: a constant in mask-uv is not a constant on the glass.
// The mask is mapped over the viewport with `span = max(vw, vh)`, and the canvas runs
// from a 0.46 phone to a 2.53 desktop — so span grows 2.5x and anything authored in uv
// grows with it. Authored in uv, the drips came out 2.5x fatter and 2.5x longer on a
// desktop than on a phone while the writing stayed world-capped: full-height bars
// struck through a narrow column of script. So every size on this glass is a WORLD
// length, divided by the live span where it is used. (The breath below is the one
// deliberate exception — see BLOOM_R0.)
const V_OFF_W = 0.1529; // people write at eye level, and it leaves the drips room to run

// The written block is shaped from the pane's own aspect rather than a constant. The
// pane IS the viewport, so it is a 2.17-tall column on a phone and a 0.39-wide letterbox
// on a desktop; a fixed 1.45 block put 8 lines of script down 19% of a desktop's width
// and left the rest of the glass bare. 0.67 lands a phone back on the 1.45 this tableau
// was authored at, and lets a wide canvas have the width it is offering.
const CHAR_W = 0.42; // measured advance / fontSize for Snell Roundhand at weight 400
const BLOCK_K = 0.67; // block height/width, as a fraction of the pane's own
// …and the line length is capped by what the mask can physically hold, not by a number.
// makePaintMask is square while the pane is the viewport, so in portrait barely half the
// mask's width is ever on screen — few, large characters is the only way the writing
// survives there. A landscape canvas covers the whole mask and affords twice as many.
// 11 mask px per character is what the portrait tableau was drawn at.
const MASK_PX_PER_CHAR = 11;
const WRITE_STEP = 3; // orderWritePath's floor, and the grid the dab below has to close

/* ---------- the breath ---------- */
// The exception to the world-units rule above, and deliberately so: the pane is the
// screen, a breath lands under a thumb on the screen, and COV_TARGET is measured
// against the visible glass. So the bloom stays in uv and scales with the pane.
const BLOOM_R0 = 0.055; // a breath has a core the moment it lands
const BLOOM_R1 = 0.3;
const BLOOM_GROW = 2.2; // seconds of breathing to reach the full bloom radius
const SPREAD_R = 2.2; // big enough that the far corner still sits inside the brush
const FOG_FILL_DABS = 4;
const FOG_MAX = 0.82; // condensation veils the room, it does not paint it out
// Fraction of the *visible* glass. The bloom's radius caps, so coverage caps too — at
// about 0.33 dead centre, and half that against an edge. Anything near the ceiling is a
// gesture that cannot be finished, so this sits well under it and T_MERCY_MAX covers the rest.
const COV_TARGET = 0.22;
const COV_POLL = 0.14; // coverage() allocates a whole ImageData — never sample it per frame

/* ---------- opening timeline (seconds) ---------- */
// A gift may never outlast 12s with nobody touching it, and the bound is on
// onOpenComplete, not on the grant — so the whole show is the budget:
//   T_MERCY_MAX + T_SPREAD + total(worst) = 6.0 + 0.7 + 4.58 = 11.28,
// and the coverage gate gets there on its own around 5.5s. The rest of the 12 is
// deliberate slack: `dt` is clamped to 0.05, so on a phone that drops frames this clock
// runs *behind* the wall clock the bound is actually measured on. The show was shortened
// to buy the grant its seconds back; the grant was not extended.
const T_MERCY0 = 3.0; // the glass starts breathing for them
const MERCY_RAMP = 2.2; // ...easing in, so it reads as company and not as a timer
// The hard floor, and it is the no-input path's. Breathing for them is generosity, not a
// guarantee: the bloom's radius caps, so a thumb held against the very edge of the pane
// can plateau under COV_TARGET and wait there forever. Past this the breath spreads
// regardless. A gift cannot lock — but whoever is actually breathing on the glass is not
// on a timer either, so once a thumb has landed only that plateau needs catching.
const T_MERCY_MAX = 6.0;
const T_MERCY_MAX_HELD = 13;
const T_SPREAD = 0.7; // the breath lets go of the thumb and hazes the whole pane
const WRITE_MIN = 2.0;
const WRITE_MAX = 3.8;
const WRITE_RATE = 2100; // path points per second
const T_SETTLE = 0.7;
const DRIP_N = 5;
const DRIP_SPAN = 0.6; // only the first stretch of the writing sheds — that water has had the longest to gather
const DRIP_STEP = 0.04; // the trail is stamped on a fixed grid, so a cold reveal lays down the same stamps a live run does
const DRIP_FALL = 1.7;
// A runnel's width is surface tension's business — not the text's, and not the window's.
// So it is a world constant (see V_OFF_W), a touch fatter than the fine hairlines the
// writing leaves, and it is divided by the live span at every point of use.
const DRIP_R_W = 0.0143;
const DRIP_SWAY_W = 0.0245;
const DRIP_STEPS = Math.ceil(DRIP_FALL / DRIP_STEP);

/* ---------- condensation grain ---------- */
// Tileable value-noise fbm. Condensation is never even, and a bare alpha ramp
// reads as spray paint. Each lattice wraps on its own period so the pane can
// repeat the texture without a seam.
function makeGrainTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(S, S);
  const rand = mulberry32(60613);
  const octave = (period: number) => {
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    return (x: number, y: number) => {
      const fx = x * period;
      const fy = y * period;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const r0 = (y0 % period) * period;
      const r1 = ((y0 + 1) % period) * period;
      const c0 = x0 % period;
      const c1 = (x0 + 1) % period;
      return lerp(
        lerp(grid[r0 + c0], grid[r0 + c1], tx),
        lerp(grid[r1 + c0], grid[r1 + c1], tx),
        ty,
      );
    };
  };
  const octs: [(x: number, y: number) => number, number][] = [
    [octave(4), 0.54],
    [octave(9), 0.29],
    [octave(21), 0.17],
  ];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let n = 0;
      for (const [f, amp] of octs) n += f(x / S, y / S) * amp;
      const v = Math.round(clamp01(n) * 255);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
const grainTex = makeGrainTexture();
const glowTex = makeRadialSprite();

/** Everything behind or on the glass is a light source, never a lit surface — so it all glows the same way. */
const ADDITIVE = {
  map: glowTex,
  transparent: true,
  depthWrite: false,
  toneMapped: false,
  blending: THREE.AdditiveBlending,
} as const;

/* ---------- fog on the glass ---------- */
// The mask's soft brush falloff lives in its *alpha*: canvas compositing stores
// premultiplied, so a 30%-alpha dab reads back as white at 30% and three's stock
// alphaMap — which samples green — would see 1.0 and cut the breath out with a
// hard edge. So the mask is sampled here by hand. Patching MeshBasicMaterial
// rather than hand-rolling a raw ShaderMaterial keeps three's colour management,
// so the fog grey is the grey that was authored.
const FOG_GLSL = /* glsl */ `
  vec2 fmUv = (vUv - 0.5) * uMaskScale + 0.5;
  float fmM = texture2D(uMask, fmUv).a;

  // Water shoved aside by a fingertip piles along the stroke and catches the light.
  // The letters' edges are sharp and the breath's edge is not, so this finds the writing.
  float fmL = texture2D(uMask, fmUv - vec2(uTexel, 0.0)).a;
  float fmR = texture2D(uMask, fmUv + vec2(uTexel, 0.0)).a;
  float fmD = texture2D(uMask, fmUv - vec2(0.0, uTexel)).a;
  float fmU = texture2D(uMask, fmUv + vec2(0.0, uTexel)).a;
  // Thresholded, not scaled: a letter's edge falls away inside a texel or two and a
  // breath's takes twenty, so only the writing clears this. Scaling instead of
  // thresholding rings the whole bloom in white and it reads as a moon.
  float fmRim = smoothstep(0.3, 0.7, length(vec2(fmR - fmL, fmU - fmD)));

  float fmGrain = texture2D(uGrain, vUv * uGrainScale + uGrainDrift).r;
  // the pane is coldest where the frame holds it, so the breath sticks at the edges
  vec2 fmC = (vUv - 0.5) * 2.0;
  float fmCold = 0.84 + 0.30 * min(dot(fmC, fmC), 1.6);

  // Chew the mask's edge up with the grain before it becomes coverage. The dabs
  // saturate, so the mask alone hands back a disc with a compass edge; letting the
  // droplets decide where the breath gives out turns that rim into a cloud. The core
  // (fmM = 1) clamps back to solid, so only the falloff band is eaten.
  float fmEdge = clamp(fmM * (0.55 + 0.9 * fmGrain) * 1.35, 0.0, 1.0);
  float fmA = fmEdge * uDensity * fmCold * (0.58 + 0.54 * fmGrain);
  diffuseColor.rgb += uRim * fmRim * uDensity * 0.9;
  diffuseColor.a *= clamp(fmA + fmRim * uDensity * 0.3, 0.0, 1.0);
`;

interface FogUniforms {
  uMask: { value: THREE.Texture };
  uGrain: { value: THREE.Texture };
  uMaskScale: { value: THREE.Vector2 };
  uGrainScale: { value: THREE.Vector2 };
  uGrainDrift: { value: THREE.Vector2 };
  uRim: { value: THREE.Color };
  uDensity: { value: number };
  uTexel: { value: number };
}

function makeFogMat(fog: string, rim: string, mask: THREE.Texture) {
  const uniforms: FogUniforms = {
    uMask: { value: mask },
    uGrain: { value: grainTex },
    uMaskScale: { value: new THREE.Vector2(1, 1) },
    uGrainScale: { value: new THREE.Vector2(3.4, 3.4) },
    uGrainDrift: { value: new THREE.Vector2(0, 0) },
    uRim: { value: new THREE.Color(rim) },
    uDensity: { value: 0 },
    uTexel: { value: 1.6 * TEXEL },
  };
  const mat = new THREE.MeshBasicMaterial({
    color: fog,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  mat.defines = { USE_UV: "" }; // makes three declare + fill vUv for us
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uMask;
uniform sampler2D uGrain;
uniform vec2 uMaskScale;
uniform vec2 uGrainScale;
uniform vec2 uGrainDrift;
uniform vec3 uRim;
uniform float uDensity;
uniform float uTexel;`,
      )
      .replace("#include <alphamap_fragment>", FOG_GLSL);
  };
  return { mat, uniforms };
}

/* ---------- bokeh ---------- */
// There is no EffectComposer in this stack, so nothing back here is ever really
// blurred: the near layer is simply bigger, softer and dimmer, which is what
// defocus looks like anyway. Out-of-focus rain doesn't streak either — it beads.
interface Bokeh {
  n: number;
  spread: number;
  pos: Float32Array;
  col: Float32Array;
  base: Float32Array;
  phase: Float32Array;
  speed: Float32Array;
}
function buildBokeh(n: number, seed: number, tints: string[], spread: number, z0: number, z1: number): Bokeh {
  const rand = mulberry32(seed);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const base = new Float32Array(n * 3);
  const phase = new Float32Array(n);
  const speed = new Float32Array(n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rand() * 2 - 1) * spread;
    pos[i * 3 + 1] = (rand() * 2 - 1) * spread * 0.9;
    pos[i * 3 + 2] = lerp(z0, z1, rand());
    c.set(tints[Math.floor(rand() * tints.length)]);
    const b = 0.45 + rand() * 0.55;
    base[i * 3] = c.r * b;
    base[i * 3 + 1] = c.g * b;
    base[i * 3 + 2] = c.b * b;
    phase[i] = rand() * Math.PI * 2;
    speed[i] = 0.6 + rand() * 0.9;
  }
  col.set(base);
  return { n, spread, pos, col, base, phase, speed };
}

function driftBokeh(
  b: Bokeh,
  motion: Motion,
  dt: number,
  e: number,
  posA: THREE.BufferAttribute,
  colA: THREE.BufferAttribute,
) {
  const lim = b.spread * 1.05;
  // a train overtakes another every so often and the whole field rushes
  const surge = motion === "train" ? 1 + 2.4 * Math.pow(Math.max(0, Math.sin(e * 0.21)), 8) : 1;
  for (let i = 0; i < b.n; i++) {
    let x = posA.getX(i);
    let y = posA.getY(i);
    if (motion === "rain") {
      y -= b.speed[i] * 0.3 * dt;
      x += Math.sin(e * 0.5 + b.phase[i]) * 0.05 * dt;
      if (y < -lim * 0.9) y = lim * 0.9;
    } else if (motion === "candle") {
      y += Math.sin(e * 0.4 + b.phase[i]) * 0.06 * dt;
      x += Math.cos(e * 0.33 + b.phase[i] * 1.7) * 0.05 * dt;
    } else {
      x -= b.speed[i] * 1.15 * surge * dt;
      y += Math.sin(e * 2.1 + b.phase[i]) * 0.03 * dt;
      if (x < -lim) x += lim * 2;
    }
    posA.setXY(i, x, y);
    const f =
      motion === "candle"
        ? 0.72 +
          0.28 * Math.sin(e * (5.5 + b.speed[i] * 3.5) + b.phase[i]) +
          0.07 * Math.sin(e * 21 + b.phase[i] * 2)
        : motion === "rain"
          ? 0.78 + 0.22 * Math.sin(e * 1.25 + b.phase[i])
          : 0.85 + 0.15 * Math.sin(e * 3.4 + b.phase[i]);
    colA.setXYZ(i, b.base[i * 3] * f, b.base[i * 3 + 1] * f, b.base[i * 3 + 2] * f);
  }
  posA.needsUpdate = true;
  colA.needsUpdate = true;
}

/* ---------- the breath ---------- */
// makePaintMask's brush lands at full alpha and paint() takes no strength, so dabbing
// a fixed radius at 60Hz saturates its entire footprint within a few frames and the
// breath comes out as a crisp disc with a cut edge. Jittering each dab's radius and
// centre spreads the saturation over a band instead of a circle, so the edge builds up
// gradually — and a breath is a turbulent thing anyway, not a compass circle.
const breathRand = mulberry32(5150);

/* ---------- the breath, fully spread ---------- */
/** The pane every path converges on before the writing starts. */
function fogFull(mask: PaintMask, u: number, v: number) {
  // Each soft dab leaves (1-a) of the clear glass behind it, so a handful saturate
  // the whole pane without the brush ever acquiring a hard edge.
  for (let i = 0; i < FOG_FILL_DABS; i++) mask.paint(u, v, SPREAD_R, "draw");
}

/* ---------- the unseen fingertip ---------- */
/** Erasing the fog along the ordered path *is* the finger — there is nothing else to draw. */
function writeTo(
  mask: PaintMask,
  w: WritePath,
  lineStart: Set<number>,
  from: number,
  to: number,
  r: number,
  wFrac: number,
  gap2: number,
  vOff: number,
) {
  for (let i = Math.max(0, from + 1); i <= to; i++) {
    const u = 0.5 + w.path[i * 2] * wFrac;
    const v = 0.5 + w.path[i * 2 + 1] * wFrac + vOff;
    // the hand lifts between lines instead of dragging back across the whole block
    if (i === 0 || lineStart.has(i)) {
      mask.paint(u, v, r, "erase");
      continue;
    }
    const pu = 0.5 + w.path[(i - 1) * 2] * wFrac;
    const pv = 0.5 + w.path[(i - 1) * 2 + 1] * wFrac + vOff;
    // lineStarts is not the only place the path leaps. It is a sweep *through* the ink,
    // column by column, so it also jumps the gap between two letters and — worse — across
    // a counter, whenever one column holds ink both above and below the hole in an "o".
    // Dragging the pen through those fills every letter in solid. Lift it on any leap.
    const du = u - pu;
    const dv = v - pv;
    if (du * du + dv * dv > gap2) mask.paint(u, v, r, "erase");
    else mask.stroke(pu, pv, u, v, r, "erase");
  }
}

/* ---------- condensation drips ---------- */
interface Drip {
  x: number;
  y: number; // in write space: the low point of a stroke, where water gathers
  born: number; // write progress at which its letter exists
  hang: number; // the beat it spends swelling before it lets go
  sway: number;
  wob: number;
  vt: number; // terminal crawl, in WORLD units per second
}

function pickDrips(w: WritePath): Drip[] {
  const rand = mulberry32(8213);
  const out: Drip[] = [];
  const reach = Math.floor(w.count * DRIP_SPAN);
  for (let k = 0; k < DRIP_N; k++) {
    const a = Math.floor(((k + 0.12) / DRIP_N) * reach);
    const b = Math.floor(((k + 0.88) / DRIP_N) * reach);
    let best = -1;
    let low = Infinity;
    for (let i = a; i < b; i++) {
      if (w.path[i * 2 + 1] < low) {
        low = w.path[i * 2 + 1];
        best = i;
      }
    }
    if (best < 0) continue;
    out.push({
      x: w.path[best * 2],
      y: low,
      born: best / w.count,
      hang: 0.25 + rand() * 0.35,
      sway: (rand() - 0.5) * 0.9,
      wob: rand() * Math.PI * 2,
      // a bead this size runs a few centimetres and stalls; it does not sluice the pane
      vt: 0.306 + rand() * 0.214,
    });
  }
  return out;
}

const DRIP_EASE = 0.34; // water on cold glass reaches its terminal crawl almost at once
const dripP0 = { u: 0, v: 0 };
const dripP1 = { u: 0, v: 0 };
/** World in, uv out: every length here is divided by the live span, never baked. */
function dripAt(out: { u: number; v: number }, d: Drip, tau: number, wFrac: number, span: number) {
  const fall = d.vt * (tau - DRIP_EASE * (1 - Math.exp(-tau / DRIP_EASE)));
  out.u = 0.5 + d.x * wFrac + ((d.sway * DRIP_SWAY_W) / span) * Math.sin(tau * 2.2 + d.wob);
  out.v = 0.5 + d.y * wFrac + (V_OFF_W - fall) / span;
}

/** Stamped on DRIP_STEP's fixed grid, so a cold reveal draws the very same trail a live run does. */
function dripTrail(mask: PaintMask, d: Drip, from: number, to: number, wFrac: number, span: number) {
  const r = DRIP_R_W / span;
  for (let s = from + 1; s <= to; s++) {
    dripAt(dripP0, d, (s - 1) * DRIP_STEP, wFrac, span);
    dripAt(dripP1, d, s * DRIP_STEP, wFrac, span);
    // past the bottom of the pane the stamps just clip away, so there is nothing to guard
    mask.stroke(dripP0.u, dripP0.v, dripP1.u, dripP1.v, r, "erase");
  }
}

export default function FoggyMirrorScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const setting = SETTINGS[variants.setting] ?? SETTINGS["rain-window"];

  // The pane's aspect decides how the writing wraps, so the raster needs it — but
  // re-wrapping means re-rasterizing, so it may only happen when the canvas changes
  // shape, never per frame. Quantized to eighths: a resize of a pixel must not
  // re-rasterize, and a reveal (which really does change the shape) must.
  const paneA = useThree((s) => {
    const a = s.viewport.height / s.viewport.width;
    return Number.isFinite(a) && a > 0 ? Math.min(2.2, Math.max(0.36, Math.round(a * 8) / 8)) : 1;
  });

  // `message` is "" on the gallery card, and on /create it is the sender's real message
  // arriving one keystroke at a time with no debounce. Preview writes the short copy
  // either way: writing in fog is this gift's whole signature and it has to be on the
  // card, but a 280-char paragraph breathed onto a 400px panel is mush at any size — and
  // rasterizing one per keystroke cost 6ms a character to draw something unreadable.
  // The name still answers as it is typed. Nobody writes a paragraph on a mirror.
  const written = message.trim();
  const source = phase === "preview" || !written ? forRecipient(lang, recipientName) : written;

  /* useMemo is load-bearing: it owns the mask canvas, its texture and the materials. */
  const mask = useMemo(() => makePaintMask({ size: MASK_SIZE, filled: false }), []);
  useEffect(() => () => mask.dispose(), [mask]);

  const fog = useMemo(() => makeFogMat(setting.fog, setting.rim, mask.texture), [setting, mask]);
  useEffect(() => () => fog.mat.dispose(), [fog]);

  const bokeh = useMemo(
    () => ({
      far: buildBokeh(30, setting.seed, setting.far, 4.4, -2.2, -5.0),
      near: buildBokeh(11, setting.seed + 77, setting.near, 4.0, -1.2, -2.4),
    }),
    [setting],
  );

  const write = useMemo(() => {
    // A blank line rasterizes no ink, and then lineStarts is short by one against the
    // lines the raster actually laid out — which is what gridFrac below reconstructs the
    // raster from. Measured: "alpha\n\nbravo" gives 2 lineStarts for 3 lines, and the dab
    // comes out half again too fat. A blank line is very plausible in a 280-char message,
    // and nothing is lost by closing the gap up: a finger does not leave one.
    const text = source.replace(/\s*\n\s*\n+/g, "\n");
    if (!text) return null;
    // A finger writes in script, and Arabic is natively cursive — so `lang: "ar"`
    // routes to Thmanyah and the writing is handwriting for free.
    const size = 92;
    const lh = 1.45;
    const blockA = paneA * BLOCK_K;
    // what the mask can hold across the pane's width, in characters (see MASK_PX_PER_CHAR):
    // in portrait only 1/paneA of the mask's width is ever on screen, in landscape all of it
    const capChars = (W_FRAC * Math.min(1, 1 / paneA) * MASK_SIZE) / MASK_PX_PER_CHAR;
    const chars = Math.max(
      5,
      Math.min(Math.floor(capChars), Math.round(Math.sqrt((text.length * lh) / (blockA * CHAR_W)))),
    );
    const w = orderWritePath(text, {
      step: WRITE_STEP,
      fontSize: size,
      // Regular, not bold: the heavy faces are wider *and* thicker, and at the ~40px a
      // character gets on the mask they close up. The hairlines plus the dab's dilation
      // below come out finger-thick on their own.
      fontWeight: "400",
      fontFamily: "'Snell Roundhand', 'Segoe Script', 'Bradley Hand', cursive",
      maxWidthPx: chars * CHAR_W * size,
      lineHeight: lh,
      lang,
    });
    if (!w.count) return null;
    const drips = pickDrips(w);
    const dur = Math.min(WRITE_MAX, Math.max(WRITE_MIN, w.count / WRITE_RATE));
    const last = drips.reduce((m, d) => Math.max(m, d.born * dur + d.hang), 0);
    return {
      w,
      drips,
      dur,
      lineStart: new Set(w.lineStarts),
      // orderWritePath returns a dense sweep *through* the ink, not a centreline, so the
      // brush is not a pen: any radius dilates the glyph outward, and past a pixel or two
      // the counters fill in and the words close into blobs. So the dab is sized only to
      // close the sampling grid. WritePath doesn't report the raster it came from, but
      // aspect plus the line count reconstructs it: rasterW = rasterH / aspect. The blank
      // lines are collapsed above, so lineStarts.length is that line count.
      gridFrac:
        WRITE_STEP /
        ((w.lineStarts.length * size * lh + Math.ceil(size * 0.25) * 2) / Math.max(0.01, w.aspect)),
      total: Math.max(dur + T_SETTLE, last + DRIP_FALL),
    };
  }, [source, lang, paneA]);

  const worldRef = useRef<THREE.Group>(null);
  const glassRef = useRef<THREE.Mesh>(null);
  const bokehRef = useRef<THREE.Group>(null);
  const farRef = useRef<THREE.Points>(null);
  const nearRef = useRef<THREE.Points>(null);
  const inviteRef = useRef<THREE.Mesh>(null);
  const headRef = useRef<THREE.Mesh>(null);
  const beadRef = useRef<THREE.Points>(null);
  const beadPos = useMemo(() => new Float32Array(DRIP_N * 3), []);

  // Per-frame uniform writes go through a ref: the memo above owns the material and its
  // disposal, but the lint only accepts mutation through a *Ref (same shape as moonflower).
  // Layout effect, not passive: this has to land before the first useFrame reads it.
  const uniformsRef = useRef<FogUniforms | null>(null);
  useLayoutEffect(() => {
    uniformsRef.current = fog.uniforms;
  }, [fog]);

  const spanRef = useRef(1);
  const breathRef = useRef(0);
  const spreadAtRef = useRef(-1);
  const filledRef = useRef(false);
  const writeAtRef = useRef(-1);
  const covRef = useRef(0);
  const pollRef = useRef(0);
  const dirtyRef = useRef(true);
  const paintedRef = useRef(-1);
  const dripRef = useRef(new Int32Array(DRIP_N));
  const holdRef = useRef({ down: false, touched: false, u: 0.5, v: 0.5, pu: 0.5, pv: 0.5, su: 0.5, sv: 0.5 });

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  /* The mask is the one thing here that accumulates, so it is rebuilt from `phase`
     alone: a replay must re-fog and re-write from scratch, and reduced motion lands
     on `revealed` having never run `opening`. The rebuild itself waits for the first
     frame, where the viewport (and so the writing's size) is finally known. */
  useLayoutEffect(() => {
    dirtyRef.current = true;
  }, [phase, mask, write]);

  const grab = (e: { point: THREE.Vector3 }) => {
    const h = holdRef.current;
    h.u = 0.5 + e.point.x / spanRef.current;
    h.v = 0.5 + e.point.y / spanRef.current;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const h = holdRef.current;
    const uni = uniformsRef.current;
    if (!uni) return; // the fog uniforms are half this scene's state; there is nothing to pose without them

    /* The pane is the viewport, so the mask's uv is the screen and a dab always
       lands under the thumb. The mask itself stays square and maps onto the pane
       "cover" — stretched to a portrait phone, every fingertip would be an ellipse. */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const span = Math.max(vw, vh);
    spanRef.current = span;
    // The pad has to reach the shader too: uMaskScale maps the *pane* back onto the
    // square mask, so telling it `vw` while the pane is `vw * GLASS_PAD` wide would
    // slide the fog off the finger by the difference.
    const pw = vw * GLASS_PAD;
    const ph = vh * GLASS_PAD;
    if (glassRef.current) glassRef.current.scale.set(pw, ph, 1);
    if (bokehRef.current) {
      const k = Math.max(1, vw / 3.2);
      bokehRef.current.scale.set(k, k, 1);
    }
    uni.uMaskScale.value.set(pw / span, ph / span);
    uni.uGrainScale.value.set((pw / span) * 3.4, (ph / span) * 3.4);
    uni.uGrainDrift.value.set(e * 0.004, e * -0.002);

    /* The writing, fitted. Both bounds are real — the block is wrapped to the pane's own
       shape upstream (see BLOCK_K), so neither one strands the other's axis any more. */
    const wWorld = write ? Math.min(vw * W_FRAC, (vh * H_FRAC) / Math.max(0.2, write.w.aspect)) : 0;
    const wFrac = wWorld / span;
    const vOff = V_OFF_W / span;
    // just wide enough to close the path's own sampling grid, never wider (see gridFrac)
    const gridUv = write ? write.gridFrac * wFrac : 0;
    const dab = write ? Math.min(2.2, Math.max(1, gridUv * MASK_SIZE * 0.8)) * TEXEL : 0;
    // anything more than a couple of grid steps is the path leaping, not the finger moving
    const gap2 = (gridUv * 2.5) ** 2;

    // preview and revealed are static tableaux whose writing size is baked into the
    // mask, so they have to be re-laid-out if the viewport moves under them — a phone
    // rotating while the gift is open. Never mid-opening: that mask is a performance.
    if (!opening && Math.abs(span - paintedRef.current) > span * 0.01) dirtyRef.current = true;

    if (dirtyRef.current) {
      dirtyRef.current = false;
      paintedRef.current = span;
      mask.reset();
      breathRef.current = 0;
      spreadAtRef.current = -1;
      filledRef.current = false;
      writeAtRef.current = -1;
      covRef.current = 0;
      pollRef.current = 0;
      h.down = false;
      h.touched = false;
      dripRef.current.fill(0);
      const cold = phase === "preview" || phase === "revealed";
      if (cold) {
        fogFull(mask, 0.5, 0.5);
        breathRef.current = BLOOM_GROW;
      }
      // The finished tableau, drawn cold — reduced motion never runs the opening, and the
      // gallery card never runs anything at all. Preview draws it too: writing in fog is
      // the gift, and without it the card was a featureless grey tile.
      if (cold && write) {
        writeTo(mask, write.w, write.lineStart, -1, write.w.count - 1, dab, wFrac, gap2, vOff);
        writeAtRef.current = write.w.count - 1;
        for (let i = 0; i < write.drips.length; i++) {
          dripTrail(mask, write.drips[i], 0, DRIP_STEPS, wFrac, span);
          dripRef.current[i] = DRIP_STEPS;
        }
      }
      uni.uDensity.value = cold ? FOG_MAX : 0;
    }

    /* ---------- the breath ---------- */
    if (opening && spreadAtRef.current < 0) {
      // their breath — or, if they never touch the glass, the room's
      const mercy = smooth(clamp01((t - T_MERCY0) / MERCY_RAMP));
      const rate = h.down ? 1 : mercy;
      if (rate > 0.002) {
        breathRef.current += dt * rate;
        // linear, not eased: coverage goes as the radius squared, and an eased radius makes
        // the gate land almost the moment the thumb touches down
        const grow = lerp(BLOOM_R0, BLOOM_R1, clamp01(breathRef.current / BLOOM_GROW));
        // see breathRand: the jitter is what keeps the edge from cutting
        const r = grow * (0.55 + 0.45 * breathRand());
        const j = grow * 0.06;
        const u = (h.touched ? h.u : 0.5) + (breathRand() - 0.5) * j;
        const v = (h.touched ? h.v : 0.5) + (breathRand() - 0.5) * j;
        // pointermove is sparse on a drag, so a thumb that wanders paints a smear
        if (h.down && (u !== h.pu || v !== h.pv)) mask.stroke(h.pu, h.pv, u, v, r, "draw");
        else mask.paint(u, v, r, "draw");
        h.pu = u;
        h.pv = v;
      }
      pollRef.current -= dt;
      if (pollRef.current <= 0) {
        pollRef.current = COV_POLL;
        // coverage() spans the whole square mask, but only its short-axis fraction is
        // ever on screen — renormalize or the threshold drifts with the aspect ratio
        covRef.current = mask.coverage() / (Math.min(vw, vh) / span);
      }
      if (covRef.current >= COV_TARGET || t > (h.touched ? T_MERCY_MAX_HELD : T_MERCY_MAX)) {
        spreadAtRef.current = t;
        h.su = h.touched ? h.u : 0.5;
        h.sv = h.touched ? h.v : 0.5;
      }
    }

    const spreadAt = spreadAtRef.current;
    const tWrite = opening && spreadAt >= 0 ? spreadAt + T_SPREAD : Infinity;
    if (opening && spreadAt >= 0 && t < tWrite) {
      // the breath lets go of the thumb and hazes the whole pane
      const k = clamp01((t - spreadAt) / T_SPREAD);
      mask.paint(h.su, h.sv, lerp(BLOOM_R1, SPREAD_R, easeOutCubic(k)), "draw");
    }
    if (opening && t >= tWrite && !filledRef.current) {
      filledRef.current = true;
      fogFull(mask, h.su, h.sv); // converge on exactly the pane a cold reveal paints
    }

    /* ---------- the writing ---------- */
    if (write && opening && t >= tWrite) {
      const target = Math.floor(clamp01((t - tWrite) / write.dur) * (write.w.count - 1));
      if (target > writeAtRef.current) {
        writeTo(mask, write.w, write.lineStart, writeAtRef.current, target, dab, wFrac, gap2, vOff);
        writeAtRef.current = target;
      }
    }
    if (headRef.current) {
      const i = writeAtRef.current;
      const on = !!write && opening && i >= 0 && i < write.w.count - 1;
      headRef.current.visible = on;
      if (on && write) {
        headRef.current.position.set(
          write.w.path[i * 2] * wWorld,
          write.w.path[i * 2 + 1] * wWorld + V_OFF_W,
          0.02,
        );
      }
    }

    /* ---------- the drips ---------- */
    // The trail each drip cuts is the mask's business and must not depend on the bead
    // sprites existing, so it is advanced first and on its own.
    if (write && opening) {
      for (let i = 0; i < write.drips.length; i++) {
        const d = write.drips[i];
        const tau = t - (tWrite + d.born * write.dur + d.hang);
        const step = tau <= 0 ? 0 : Math.min(DRIP_STEPS, Math.floor(tau / DRIP_STEP));
        if (step > dripRef.current[i]) {
          dripTrail(mask, d, dripRef.current[i], step, wFrac, span);
          dripRef.current[i] = step;
        }
      }
    }
    if (beadRef.current) {
      const posA = beadRef.current.geometry.attributes.position as THREE.BufferAttribute;
      let any = false;
      for (let i = 0; i < DRIP_N; i++) {
        const d = write && opening ? write.drips[i] : undefined;
        const tau = d && write ? t - (tWrite + d.born * write.dur + d.hang) : Infinity;
        // it beads up at the foot of its letter for a beat before it lets go
        if (!d || tau < -d.hang || tau > DRIP_FALL) {
          posA.setXYZ(i, 0, -999, 0);
          continue;
        }
        dripAt(dripP0, d, Math.max(0, tau), wFrac, span);
        posA.setXYZ(i, (dripP0.u - 0.5) * span, (dripP0.v - 0.5) * span, 0.02);
        any = true;
      }
      posA.needsUpdate = true;
      beadRef.current.visible = any;
    }

    /* ---------- fog density ---------- */
    // The first breath has to fade in from here: one dab of the mask's brush already
    // lands at full alpha, so the mask alone cannot ramp.
    const target =
      phase === "preview"
        ? // The gallery card, and it is a small tile against a very dim room. Thinner than
          // a real breath on purpose, and thinner again than it first looked right at:
          // fog this pale is what lets the bokeh and the script through, and a misted
          // window you can nearly see into is an invitation where a grey rectangle is a
          // loading state. It breathes, slowly, as though someone were just out of frame.
          0.32 + 0.07 * Math.sin(e * 0.45)
        : phase === "sealed"
          ? 0
          : phase === "revealed"
            ? FOG_MAX
            : FOG_MAX * smooth(clamp01(breathRef.current / 0.45));
    uni.uDensity.value += (target - uni.uDensity.value) * Math.min(1, dt * 4);

    /* ---------- the cold spot inviting a thumb ---------- */
    if (inviteRef.current) {
      const m = inviteRef.current.material as THREE.MeshBasicMaterial;
      const want =
        phase === "sealed"
          ? 0.13 + 0.07 * Math.sin(e * 1.5)
          : opening && breathRef.current < 0.05
            ? 0.2 + 0.1 * Math.sin(e * 2.3)
            : 0;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 3);
      inviteRef.current.visible = m.opacity > 0.004;
    }

    /* ---------- the world behind, drifting ---------- */
    if (farRef.current && nearRef.current) {
      const g = farRef.current.geometry.attributes;
      driftBokeh(bokeh.far, setting.motion, dt, e, g.position as THREE.BufferAttribute, g.color as THREE.BufferAttribute);
      const n = nearRef.current.geometry.attributes;
      driftBokeh(bokeh.near, setting.motion, dt, e, n.position as THREE.BufferAttribute, n.color as THREE.BufferAttribute);
    }
    // only the world leans; the glass is the frame you are looking through
    if (worldRef.current) {
      const k = Math.min(1, dt * 2.5);
      worldRef.current.rotation.x = lerp(worldRef.current.rotation.x, state.pointer.y * 0.05, k);
      worldRef.current.rotation.y = lerp(worldRef.current.rotation.y, state.pointer.x * 0.05, k);
    }

    if (opening && write && t > tWrite + write.total && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    } else if (opening && !write && t > tWrite + T_SETTLE && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      {/* No lights anywhere in here: every material on this pane is basic or points,
          because a mirror shows you light sources, not lit surfaces. */}
      <PerspectiveCamera makeDefault position={[0, 0, 4.2]} fov={40} />

      {/* the room, hopelessly out of focus */}
      <group ref={worldRef}>
        <mesh position={[0, 0, -9]}>
          <planeGeometry args={[44, 44]} />
          <meshBasicMaterial color={setting.back} toneMapped={false} />
        </mesh>
        {/* Sized so its falloff lands inside the frame: much wider and only the sprite's
            flat centre is ever on screen, which washes the whole pane one colour. */}
        <mesh position={[0, 0, -8.6]}>
          <planeGeometry args={[13, 13]} />
          <meshBasicMaterial color={setting.haze} opacity={0.8} {...ADDITIVE} />
        </mesh>

        {/* two scales of bokeh: the near layer is bigger, dimmer and softer, which is
            all defocus really looks like once nothing is ever actually in focus */}
        <group ref={bokehRef}>
          <points ref={farRef}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[bokeh.far.pos, 3]} />
              <bufferAttribute attach="attributes-color" args={[bokeh.far.col, 3]} />
            </bufferGeometry>
            <pointsMaterial size={0.5} sizeAttenuation vertexColors opacity={0.62} {...ADDITIVE} />
          </points>
          <points ref={nearRef}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[bokeh.near.pos, 3]} />
              <bufferAttribute attach="attributes-color" args={[bokeh.near.col, 3]} />
            </bufferGeometry>
            <pointsMaterial size={1.5} sizeAttenuation vertexColors opacity={0.3} {...ADDITIVE} />
          </points>
        </group>
      </group>

      {/* the pane. It is its own hit target — the fog is painted where you touch it. */}
      <mesh
        ref={glassRef}
        renderOrder={2}
        material={fog.mat}
        onPointerDown={(ev) => {
          ev.stopPropagation();
          if (phase !== "opening" || spreadAtRef.current >= 0) return;
          grab(ev);
          const h = holdRef.current;
          h.down = true;
          h.touched = true;
          h.pu = h.u;
          h.pv = h.v;
        }}
        onPointerMove={(ev) => {
          if (!holdRef.current.down) return;
          ev.stopPropagation();
          grab(ev);
        }}
        onPointerUp={(ev) => {
          ev.stopPropagation();
          holdRef.current.down = false;
        }}
        onPointerLeave={() => {
          holdRef.current.down = false;
        }}
      >
        <planeGeometry args={[1, 1]} />
      </mesh>

      {/* a cold spot on the glass, waiting for a thumb */}
      <mesh ref={inviteRef} position={[0, 0, 0.03]} renderOrder={3}>
        <planeGeometry args={[0.95, 0.95]} />
        <meshBasicMaterial color={setting.rim} opacity={0} {...ADDITIVE} />
      </mesh>

      {/* the light catching the wet streak the finger has this second left behind */}
      <mesh ref={headRef} renderOrder={4} visible={false}>
        <planeGeometry args={[0.17, 0.17]} />
        <meshBasicMaterial color={setting.rim} opacity={0.5} {...ADDITIVE} />
      </mesh>

      {/* the drip heads; the clear trail they cut is in the mask, not here */}
      <points ref={beadRef} renderOrder={4}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[beadPos, 3]} />
        </bufferGeometry>
        <pointsMaterial color={setting.rim} size={0.09} sizeAttenuation opacity={0.55} {...ADDITIVE} />
      </points>
    </>
  );
}
