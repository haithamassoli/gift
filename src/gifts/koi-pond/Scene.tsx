import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makePaintMask, type PaintMask } from "../mask";
import { orderWritePath, type WritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";

/* ---------- the fish ---------- */
// A koi is a white fish wearing its markings, so `spot` is painted onto whole
// body segments rather than blended in: that is how the real animal is patterned
// and how it reads from directly above.
const PALETTES: Record<
  string,
  { body: string; spot: string; fin: string; metal: number; rough: number }
> = {
  "white-gold": { body: "#f6f1e4", spot: "#dfa236", fin: "#fdf8ec", metal: 0.14, rough: 0.48 },
  crimson: { body: "#f8f3ea", spot: "#c31f38", fin: "#ffece6", metal: 0.08, rough: 0.52 },
  // Near-black fish in near-black water would simply not be there, so this one is
  // lacquer rather than pigment: it is polished enough to hand the moon back.
  "black-pearl": { body: "#242733", spot: "#949cb2", fin: "#98a2b8", metal: 0.62, rough: 0.3 },
};

/* ---------- the hour ---------- */
// `time` is the entire look and not a filter over one: the sky lying on the water,
// how much moon is left in it, and — the part that matters — how much room the eye
// has for the bioluminescence. A wake glows exactly as hard at dawn. You just
// cannot see it against the light. So `bio` is one scalar and every channel of the
// glow hangs off it: both wake planes, and the light they throw back on the fish.
const TIMES: Record<
  string,
  {
    bed: string;
    deep: string;
    shallow: string;
    clear: number; // water's alpha mid-pond — what is left of a koi once you look through it
    moon: string;
    moonI: number;
    amb: string;
    ambI: number;
    key: string;
    keyI: number;
    bio: number;
    cool: string;
    hot: string;
    glint: string;
  }
> = {
  dusk: {
    bed: "#0d0a14", deep: "#16233a", shallow: "#3d5c80", clear: 0.5,
    moon: "#ffb066", moonI: 0.9,
    amb: "#4a5a80", ambI: 0.52, key: "#ffb98a", keyI: 0.85,
    bio: 0.62, cool: "#3fd0c8", hot: "#b8ffe9", glint: "#ffd2a0",
  },
  night: {
    bed: "#04070d", deep: "#070f1c", shallow: "#173350", clear: 0.56,
    moon: "#e6eeff", moonI: 1.25,
    amb: "#2a3f66", ambI: 0.38, key: "#b9cdf5", keyI: 1,
    bio: 1, cool: "#35e0d2", hot: "#ccfff4", glint: "#cfe2ff",
  },
  dawn: {
    bed: "#0e1018", deep: "#1b2a3c", shallow: "#5d7898", clear: 0.46,
    moon: "#dfe4ee", moonI: 0.5,
    amb: "#7d90ad", ambI: 0.68, key: "#ffd9b8", keyI: 0.95,
    bio: 0.55, cool: "#6fe0c4", hot: "#ddfff0", glint: "#ffe6cf",
  },
};

/* ---------- the pond ---------- */
// THE RULE THIS SCENE BUYS ITSELF OUT OF: a constant in mask-uv is only a constant
// on screen while the mask's *world* mapping is fixed. So the pond is an object,
// not the viewport — a POND_W square of world, scaled bodily to whatever canvas it
// lands in. uv 0..1 is that square, at 0.46 aspect and at 2.53 alike, and every
// radius below is therefore both a uv length and a world one. What changes with the
// canvas is only how much dark bank surrounds the water, which is the picture anyway.
const POND_W = 6.4; // the mask square: koi, lilies and the writing all live inside it
const POND_R = 3.05; // the waterline, inscribed in it
const POND_FIT = 6.3; // fitted to the canvas's short side, every phase, every frame

const INK_SIZE = 512; // has to hold letterforms
const WAKE_SIZE = 256; // a wake is a blurred thing, and this one re-uploads every frame
const INK_TEXEL = 1 / INK_SIZE;

const W_FRAC = 0.78; // the writing, across the pond square…
const H_FRAC = 0.6;
// …but the pond is a disc and a block of writing is a rectangle, and a circle's usable
// half-width shrinks the further you get from its centre line — which is exactly where
// the first and last lines live. Fitted to the square alone they hang out over the bank,
// and the gift's one promise is that the koi write ON THE WATER. So the block is fitted
// to the disc as well: the ink's own reach, times the block's world width, lands here.
// 0.62 is not a taste — it is where the glow's bank reaches unity (GLOW_GLSL reads it
// back off this line), so every glyph is lit alike, and it is inside the water's own
// 0.70, so every glyph is on water that still reads as water.
const INK_R = POND_R * 0.62;
const BLOCK_A = 0.52; // target height/width of the written block — a pond is wider than it is tall
const CHAR_W = 0.5; // measured advance / fontSize, system sans at weight 400
const MASK_PX_PER_CHAR = 11; // what the tableau was drawn at; the cap on line length
const WRITE_STEP = 3; // orderWritePath's floor, and the grid the ink dab has to close
const FONT_PX = 92;
const LINE_H = 1.4;

const KOI_N = 5;
const SEG_N = 7;
const KOI_Z = -0.17; // under the surface, seen through it
// Segment half-length, and well past SEG_GAP/2 on purpose: the spheres have to overlap by
// more than the beat can pull them apart sideways, or the body comes out as a string of
// beads the moment the tail swings.
const BODY_L = 0.15;
const CRUISE = 0.86; // pond units per second — a koi is never in a hurry
const TURN_MAX = 2.3; // rad/s: the turn radius is the fish's, and it is not a bird
const HIST_N = 44; // samples of the head's own past track — see HIST_STEP
const R_DARK = 0.455 * POND_W; // sealed: out in the bank, where the water is opaque
const R_IDLE = 0.29 * POND_W;

const WAKE_R = 0.011; // uv == world/POND_W (see above)
const WAKE_TAU = 1.5; // seconds for a wake to fall to 1/e — still water lets go slowly
const EAT_R = 0.3;

const PELLET_N = 32;
const PELLET_PER_TAP = 7;
const PELLET_SCATTER = 0.26;
const PELLET_LIFE = 7;

const RIPPLE_N = 15;
const RIPPLE_AMB = 3; // the first three are the pond's own, and are a pure function of e
const RIPPLE_LIFE = 2.4;
const RIPPLE_V = 0.5; // a koi taking a pellet is not a stone going in

const LILY_N = 5; // opaque things over a message you are meant to read: five is the most it takes
const FLOWER_N = 2;
const PETAL_N = 11;

/* ---------- opening timeline (seconds) ---------- */
// The bound is on onOpenComplete and it is 12s, so the whole show is the budget and
// not the grant. Nobody touches it: food at 2.6 → tWrite 5.2 → +2.8 write → +0.8
// settle = 8.8s, with three seconds of slack for a slow first frame. Somebody taps
// at the last possible moment: 6.4 + 2.8 + 0.8 = 10.0s. Neither one is a timer going
// off — the koi are already drifting in and the writing simply begins.
const T_MERCY_FOOD = 2.6; // untouched, a hand off-frame scatters a little food anyway
const T_GATHER = 2; // what a koi needs to cross from the bank
const T_WRITE_MIN = 5.2;
const T_WRITE_MAX = 6.4;
const WRITE_RATE = 2600; // path points per second, across all five fish at once
const WRITE_MIN = 1.6;
const WRITE_MAX = 2.8;
const T_SETTLE = 0.8; // the bloom falls back to the steady glow it will keep
const BLOOM_TAU = 0.55;

/* ---------- textures ---------- */
const glowTex = makeRadialSprite();
/** A ring, not a disc: the whole of a ripple is its rim. */
const ringTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0)"],
  [0.56, "rgba(255,255,255,0)"],
  [0.79, "rgba(255,255,255,1)"],
  [0.92, "rgba(255,255,255,0.22)"],
  [1, "rgba(255,255,255,0)"],
]);

/** Two octaves of value noise, tiling. The surface is never still and never repeats visibly. */
function makeWaterTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(S, S);
  const octave = (period: number, seed: number) => {
    const rand = mulberry32(seed);
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
      return lerp(lerp(grid[r0 + c0], grid[r0 + c1], tx), lerp(grid[r1 + c0], grid[r1 + c1], tx), ty);
    };
  };
  const a = octave(6, 3311);
  const b = octave(13, 991);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = Math.round(clamp01(a(x / S, y / S) * 0.66 + b(x / S, y / S) * 0.34) * 255);
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
const waterTex = makeWaterTexture();

/* ---------- the water ---------- */
// The bank is the one thing this shader really owes the gift: the water gives out
// into night at POND_R, and that darkness is what the koi glide in *from*. It is a
// real edge with the fish behind it, not a vignette laid over one — which is also
// why the plane is translucent in the middle and opaque at the rim for free.
const WATER_GLSL = /* glsl */ `
  vec2 wp = (vUv - 0.5) * uHalf * 2.0;
  float wr = length(wp) * uInvR;
  float n1 = texture2D(uNoise, wp * 0.09 + uDrift).r;
  float n2 = texture2D(uNoise, wp * 0.21 - uDrift * 1.6).r;
  float surf = n1 * 0.6 + n2 * 0.4;
  float bank = smoothstep(1.0, 0.70, wr);
  // still water is not flat, it breathes — one long swell across the whole pond
  float swell = 0.5 + 0.5 * sin(wp.x * 1.7 + wp.y * 1.1 + uTime * 0.35);
  diffuseColor.rgb = mix(uDeep, uShallow, surf * bank * (0.7 + 0.3 * swell));
  diffuseColor.a = mix(1.0, uClear, bank);
`;

interface WaterUniforms {
  uNoise: { value: THREE.Texture };
  uHalf: { value: THREE.Vector2 };
  uDrift: { value: THREE.Vector2 };
  uDeep: { value: THREE.Color };
  uShallow: { value: THREE.Color };
  uClear: { value: number };
  uInvR: { value: number };
  uTime: { value: number };
}

function makeWaterMat(deep: string, shallow: string, clear: number) {
  const uniforms: WaterUniforms = {
    uNoise: { value: waterTex },
    uHalf: { value: new THREE.Vector2(POND_W / 2, POND_W / 2) },
    uDrift: { value: new THREE.Vector2(0, 0) },
    uDeep: { value: new THREE.Color(deep) },
    uShallow: { value: new THREE.Color(shallow) },
    uClear: { value: clear },
    uInvR: { value: 1 / POND_R },
    uTime: { value: 0 },
  };
  const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  mat.defines = { USE_UV: "" }; // makes three declare + fill vUv for us
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uNoise;
uniform vec2 uHalf;
uniform vec2 uDrift;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uClear;
uniform float uInvR;
uniform float uTime;`,
      )
      .replace("#include <alphamap_fragment>", WATER_GLSL);
  };
  return { mat, uniforms };
}

/* ---------- the glow the wakes leave ---------- */
// three 0.185's stock alphaMap samples GREEN, and the brush's falloff lives in
// ALPHA — hand it the mask and every soft wake comes back a hard-edged disc with
// the falloff thrown away. So the mask is sampled by hand. Patching
// MeshBasicMaterial instead of hand-rolling a ShaderMaterial keeps three's colour
// management, so the teal that was authored is the teal that renders.
//
// The four extra taps are the point of the thing: bioluminescence is a bloom around
// a filament, not a stroke. The core is water the fish disturbed; the halo is what
// the water then does with the light. It also lets the ink dab stay hairline-thin —
// the only width that does not close up an "o" — and still read as a wake.
const GLOW_GLSL = /* glsl */ `
  float core = texture2D(uMask, vUv).a;
  float halo = 0.25 * (
      texture2D(uMask, vUv + vec2(uT, 0.0)).a
    + texture2D(uMask, vUv - vec2(uT, 0.0)).a
    + texture2D(uMask, vUv + vec2(0.0, uT)).a
    + texture2D(uMask, vUv - vec2(0.0, uT)).a);
  // The water's own bank, drawn in tighter. A wake out on the dark rim is one you cannot
  // see the fish for, and five koi circling out there while the gift is sealed came back
  // as five glowing arcs around a pond that is meant to be still and empty. Pulled in to
  // 0.92 it is out before they are, and it still lets them trail a wake the whole way in
  // with no gate. The inner edge is INK_R and not a number of its own: the writing is
  // fitted inside exactly that radius, so this is unity across every glyph of it — which
  // is the only reason a ramp sitting on top of the message is safe to have at all.
  float gBank = smoothstep(0.92, ${(INK_R / POND_R).toFixed(4)}, length((vUv - 0.5) * ${POND_W.toFixed(4)}) * ${(1 / POND_R).toFixed(6)});
  diffuseColor.rgb = mix(uCool, uHot, clamp(core * 1.5, 0.0, 1.0));
  diffuseColor.a = clamp(core + halo * uHalo, 0.0, 1.0) * uI * gBank;
`;

interface GlowUniforms {
  uMask: { value: THREE.Texture };
  uCool: { value: THREE.Color };
  uHot: { value: THREE.Color };
  uI: { value: number };
  uT: { value: number };
  uHalo: { value: number };
}

function makeGlowMat(mask: THREE.Texture, cool: string, hot: string, texel: number, halo: number) {
  const uniforms: GlowUniforms = {
    uMask: { value: mask },
    uCool: { value: new THREE.Color(cool) },
    uHot: { value: new THREE.Color(hot) },
    uI: { value: 0 },
    uT: { value: texel },
    uHalo: { value: halo },
  };
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  mat.defines = { USE_UV: "" };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uMask;
uniform vec3 uCool;
uniform vec3 uHot;
uniform float uI;
uniform float uT;
uniform float uHalo;`,
      )
      .replace("#include <alphamap_fragment>", GLOW_GLSL);
  };
  return { mat, uniforms };
}

/* ---------- the school ---------- */
const SEG_GAP = 0.132; // arclength between segment centres
const SEG_W = [0.062, 0.096, 0.105, 0.094, 0.072, 0.045, 0.024]; // half-width, across the fish
const SEG_H = [0.078, 0.125, 0.14, 0.124, 0.096, 0.06, 0.03]; // half-height: a koi is tall and narrow,
// which is exactly why so little of one is showing from up here
const SEG_WAVE = [0.02, 0.05, 0.12, 0.24, 0.42, 0.68, 1]; // the head barely moves; the tail does the work
const WAVE_K = 0.75; // rad of lag per segment — most of a wavelength down the body, as a carp swims
const TURN_LEAD = 0.05; // the tail swings *out* of a turn: it is what pushes the head round
const BANK = 0.18; // and the fish rolls into it — 25 degrees at full helm, not a barrel roll

interface Koi {
  spot: boolean[];
  scale: number;
  beat: number;
  phase: number;
  a0: number; // where it idles when there is nothing to do
  w0: number;
  rj: number;
}

const SCHOOL: Koi[] = (() => {
  const rand = mulberry32(60421);
  return Array.from({ length: KOI_N }, (_, i) => {
    // never the nose, never the whole fish: a koi is a white carp wearing two or
    // three blotches, and where they fall is the only thing that tells them apart
    const spot = new Array<boolean>(SEG_N).fill(false);
    const s0 = 1 + Math.floor(rand() * 2);
    spot[s0] = true;
    if (rand() < 0.55) spot[s0 + 1] = true;
    if (rand() < 0.75) spot[4 + Math.floor(rand() * 2)] = true;
    return {
      spot,
      scale: 0.82 + rand() * 0.34,
      beat: 3.1 + rand() * 1.5,
      phase: rand() * Math.PI * 2,
      a0: (i / KOI_N) * Math.PI * 2 + rand() * 0.5,
      w0: (rand() < 0.5 ? -1 : 1) * (0.13 + rand() * 0.07),
      rj: 0.84 + rand() * 0.28,
    };
  });
})();

interface KoiState {
  x: number;
  y: number;
  h: number; // heading
  turn: number; // rad/s, smoothed — it is what banks the body
  spd: number;
  beat: number;
  /** The head's own past track, sampled on a fixed *arclength* grid — so a fish that
   *  slows to a hover still has a whole body behind it, and a fast one is not stretched. */
  hist: Float32Array;
  head: number;
  acc: number;
  wu: number;
  wv: number;
  wake: boolean;
}
const HIST_STEP = 0.023; // HIST_N of these outruns the longest body, at any speed
const IDLE_PRIME_DT = 0.1;

function makeKoiState(): KoiState {
  return {
    x: 0, y: 0, h: 0, turn: 0, spd: CRUISE, beat: 0,
    hist: new Float32Array(HIST_N * 2), head: 0, acc: 0,
    wu: 0.5, wv: 0.5, wake: false,
  };
}

const tmpV = new THREE.Vector2();
/** Where a koi mills about when nothing is being asked of it. Pure in the clock, so a
 *  cold `revealed` can prime a whole body's worth of past track it never actually swam. */
function idlePos(k: Koi, e: number, r: number, out: THREE.Vector2) {
  const a = k.a0 + e * k.w0;
  const rr = r * (k.rj + 0.11 * Math.sin(e * 0.29 + k.phase));
  out.set(Math.cos(a) * rr, Math.sin(a) * rr);
}

function primeIdle(st: KoiState, k: Koi, e: number, r: number) {
  for (let n = 0; n < HIST_N; n++) {
    idlePos(k, e - n * IDLE_PRIME_DT, r, tmpV);
    const i = (HIST_N - n) % HIST_N; // index 0 is the newest; the ring walks backwards from it
    st.hist[i * 2] = tmpV.x;
    st.hist[i * 2 + 1] = tmpV.y;
  }
  st.head = 0;
  st.acc = 0;
  st.x = st.hist[0];
  st.y = st.hist[1];
  st.h = Math.atan2(st.y - st.hist[(HIST_N - 1) * 2 + 1], st.x - st.hist[(HIST_N - 1) * 2]);
  st.turn = 0;
  st.spd = CRUISE * 0.34;
  st.beat = k.phase;
  st.wake = false;
}

/** Straight in from the dark: an entering koi has no history to speak of, and a line
 *  behind it is the truth rather than a stand-in. */
function primeLine(st: KoiState, x: number, y: number, h: number) {
  for (let n = 0; n < HIST_N; n++) {
    const i = (HIST_N - n) % HIST_N;
    st.hist[i * 2] = x - Math.cos(h) * n * HIST_STEP;
    st.hist[i * 2 + 1] = y - Math.sin(h) * n * HIST_STEP;
  }
  st.head = 0;
  st.acc = 0;
  st.x = x;
  st.y = y;
  st.h = h;
  st.turn = 0;
  st.spd = CRUISE;
  st.beat = 0;
  st.wake = false;
}

function pushHist(st: KoiState) {
  const i = st.head;
  if ((st.x - st.hist[i * 2]) ** 2 + (st.y - st.hist[i * 2 + 1]) ** 2 < HIST_STEP * HIST_STEP) return;
  st.head = (st.head + 1) % HIST_N;
  st.hist[st.head * 2] = st.x;
  st.hist[st.head * 2 + 1] = st.y;
}

/** Walk the head's track backwards by true distance. The body is inextensible; the
 *  sampling that produced the track was not necessarily even. */
function sampleBack(st: KoiState, dist: number, out: THREE.Vector2) {
  let d = dist;
  let ax = st.hist[st.head * 2];
  let ay = st.hist[st.head * 2 + 1];
  for (let n = 1; n < HIST_N; n++) {
    const j = (st.head - n + HIST_N) % HIST_N;
    const bx = st.hist[j * 2];
    const by = st.hist[j * 2 + 1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= d) {
      const k = seg > 1e-6 ? d / seg : 0;
      out.set(lerp(ax, bx, k), lerp(ay, by, k));
      return;
    }
    d -= seg;
    ax = bx;
    ay = by;
  }
  out.set(ax, ay); // ran off the end of what this fish remembers
}

/** Steer toward a point and arrive at it rather than through it — a koi closing on
 *  a pellet coasts the last hand's-breadth, it does not ram it. */
function swimTo(st: KoiState, gx: number, gy: number, dt: number, urge: number) {
  const dx = gx - st.x;
  const dy = gy - st.y;
  const dist = Math.hypot(dx, dy);
  let d = Math.atan2(dy, dx) - st.h;
  d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest way round
  const want = clamp01(Math.abs(d) / 0.5) * Math.sign(d) * TURN_MAX;
  st.turn += (want - st.turn) * Math.min(1, dt * 7);
  st.h += st.turn * dt;
  const cruise = CRUISE * urge;
  const target = cruise * (0.34 + 0.66 * clamp01(dist / 0.9));
  st.spd += (target - st.spd) * Math.min(1, dt * 2.4);
  st.x += Math.cos(st.h) * st.spd * dt;
  st.y += Math.sin(st.h) * st.spd * dt;
  pushHist(st);
}

/* ---------- the lilies ---------- */
// They do not wrap and they are never respawned: each pad idles round a long slow
// ellipse of its own, so the drift is a pure function of the clock and no pad ever
// pops back in at the far side of a pond somebody is looking straight down into.
interface Lily {
  cx: number; cy: number; rx: number; ry: number;
  w: number; p: number; rot: number; spin: number; r: number; tint: number;
}
const LILIES: Lily[] = (() => {
  const rand = mulberry32(2214);
  return Array.from({ length: LILY_N }, (_, i) => {
    const a = (i / LILY_N) * Math.PI * 2 + rand() * 0.7;
    // Weighted outward. Pads are opaque and the message is not, so a pad sitting on a
    // word simply deletes it — at 0.34 of the radius seven of them ate half the message.
    // From here their drift still carries them across the writing, which is the brief;
    // they just do not camp on it.
    const rr = (0.6 + rand() * 0.36) * POND_R;
    return {
      cx: Math.cos(a) * rr,
      cy: Math.sin(a) * rr,
      rx: 0.4 + rand() * 0.55,
      ry: 0.34 + rand() * 0.5,
      w: (rand() < 0.5 ? -1 : 1) * (0.045 + rand() * 0.05),
      p: rand() * Math.PI * 2,
      rot: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 0.07,
      r: 0.26 + rand() * 0.17,
      tint: rand(),
    };
  });
})();

/* ---------- the flowers ---------- */
// Petals are laid out once, in the flower's own space, and only ever ride whatever
// pad they are sitting on — so two flowers cost one instanced draw between them.
const PETALS: { m: THREE.Matrix4; c: number }[] = (() => {
  const out: { m: THREE.Matrix4; c: number }[] = [];
  const o = new THREE.Object3D();
  const put = (a: number, r: number, len: number, w: number, th: number, tilt: number, c: number) => {
    o.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.02 + Math.sin(tilt) * len * 0.5);
    o.rotation.set(0, 0, a); // local +x runs outward along the petal
    o.rotateY(-tilt); // …and its tip lifts
    o.scale.set(len, w, th);
    o.updateMatrix();
    out.push({ m: o.matrix.clone(), c });
  };
  for (let i = 0; i < 6; i++) put((i / 6) * Math.PI * 2, 0.13, 0.16, 0.055, 0.028, 0.26, 0);
  for (let i = 0; i < 4; i++) put((i / 4) * Math.PI * 2 + 0.7, 0.075, 0.1, 0.042, 0.026, 0.7, 1);
  o.position.set(0, 0, 0.055);
  o.rotation.set(0, 0, 0);
  o.scale.set(0.05, 0.05, 0.045);
  o.updateMatrix();
  out.push({ m: o.matrix.clone(), c: 2 });
  return out;
})();
const PETAL_C = ["#f6d9e4", "#e9a8c4", "#e8c766"].map((c) => new THREE.Color(c));

/* ---------- the sky, lying on the water ---------- */
const GLINT_N = 70;
const GLINTS = (() => {
  const rand = mulberry32(8123);
  const pos = new Float32Array(GLINT_N * 3);
  const ph = new Float32Array(GLINT_N);
  const sp = new Float32Array(GLINT_N);
  for (let i = 0; i < GLINT_N; i++) {
    const r = Math.sqrt(rand()) * POND_R * 0.96;
    const a = rand() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    pos[i * 3 + 2] = 0.016;
    ph[i] = rand() * Math.PI * 2;
    sp[i] = 0.5 + rand() * 1.7;
  }
  return { pos, ph, sp, live: new Float32Array(pos), col: new Float32Array(GLINT_N * 3) };
})();

/* ---------- the writing ---------- */
/** Ink laid along the ordered path *is* the message; the koi riding it are the reason. */
function inkTo(
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
    if (i === 0 || lineStart.has(i)) {
      mask.paint(u, v, r, "draw");
      continue;
    }
    const pu = 0.5 + w.path[(i - 1) * 2] * wFrac;
    const pv = 0.5 + w.path[(i - 1) * 2 + 1] * wFrac + vOff;
    // lineStarts is not the only place the path leaps: it is a dense sweep *through*
    // the ink, column by column, so it also jumps between letters and across the hole
    // in an "o" whenever one column holds ink both above and below it. Drag the wake
    // through those and every letter fills in solid. Lift on any leap.
    const du = u - pu;
    const dv = v - pv;
    if (du * du + dv * dv > gap2) mask.paint(u, v, r, "draw");
    else mask.stroke(pu, pv, u, v, r, "draw");
  }
}

/** How far a boxcar reaches down the path to find the line a fish could actually swim. */
const SMOOTH_N = 48;

/* ---------- odds and ends ---------- */
const MOON_X = -1.75; // off to one side, and clear of where the writing lands
const MOON_Y = 1.55;
const RIPPLE_PERIOD = 3.2;
const URGE_FOOD = 1.35;
const URGE_WRITE = 1.9;

/** Deterministic, and cheap enough to call per ripple: a replay of the same taps
 *  scatters the same food. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function lilyAt(l: Lily, e: number, out: THREE.Vector2) {
  out.set(l.cx + l.rx * Math.cos(e * l.w + l.p), l.cy + l.ry * Math.sin(e * l.w + l.p * 1.4));
}

/* per-frame scratch; a pond allocates nothing */
const mQ = new THREE.Quaternion();
const mT = new THREE.Vector3();
const mN = new THREE.Vector3();
const mU = new THREE.Vector3();
const mS = new THREE.Vector3();
const mM = new THREE.Matrix4();
const mC = new THREE.Color();
const mO = new THREE.Object3D();
const goal = new THREE.Vector2();
const bP = Array.from({ length: SEG_N + 1 }, () => new THREE.Vector2());
const bQ = Array.from({ length: SEG_N + 1 }, () => new THREE.Vector2());

export default function KoiPondScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const koiPal = PALETTES[variants.koi] ?? PALETTES["white-gold"];
  const time = TIMES[variants.time] ?? TIMES.night;

  // `message` is "" on the gallery card and, on /create, the sender's real message
  // arriving one keystroke at a time with no debounce. Either way the pond writes
  // something: a gift whose whole signature is writing on water cannot sit in the
  // gallery as a dark tile, and a live preview that ignores what is being typed is
  // not a preview of anything.
  const source = message.trim() || forRecipient(lang, recipientName);

  /* useMemo is load-bearing here: it owns two mask canvases, their textures and four
     materials. Nothing below rebuilds on the viewport — the pond is a fixed square of
     world and the writing is wrapped to the pond, not to the canvas, so a resize (or a
     reveal) moves the camera's idea of the pond and never the raster's. */
  const ink = useMemo(() => makePaintMask({ size: INK_SIZE, filled: false }), []);
  const wake = useMemo(() => makePaintMask({ size: WAKE_SIZE, filled: false }), []);
  useEffect(
    () => () => {
      ink.dispose();
      wake.dispose();
    },
    [ink, wake],
  );

  const water = useMemo(() => makeWaterMat(time.deep, time.shallow, time.clear), [time]);
  useEffect(() => () => water.mat.dispose(), [water]);

  // The ink is a filament with a bloom on it; the wake is mostly bloom.
  const inkMat = useMemo(
    () => makeGlowMat(ink.texture, time.cool, time.hot, INK_TEXEL * 3.2, 0.9),
    [ink, time],
  );
  useEffect(() => () => inkMat.mat.dispose(), [inkMat]);
  const wakeMat = useMemo(
    () => makeGlowMat(wake.texture, time.cool, time.hot, (1 / WAKE_SIZE) * 2.2, 0.9),
    [wake, time],
  );
  useEffect(() => () => wakeMat.mat.dispose(), [wakeMat]);

  const write = useMemo(() => {
    // A blank line rasterizes no ink, and lineStarts then runs a line short against the
    // raster that gridFrac below reconstructs — measured, "alpha\n\nbravo" gives 2
    // lineStarts for 3 lines. A blank line is very plausible in a 280-char message, and
    // water does not hold one anyway.
    const text = source.replace(/\s*\n\s*\n+/g, "\n");
    if (!text) return null;
    // Wrapped to the block the pond wants rather than to a number, and capped by what
    // the mask can physically hold across W_FRAC of itself.
    const cap = Math.floor((W_FRAC * INK_SIZE) / MASK_PX_PER_CHAR);
    const chars = Math.max(
      8,
      Math.min(cap, Math.round(Math.sqrt((text.length * LINE_H) / (BLOCK_A * CHAR_W)))),
    );
    const w = orderWritePath(text, {
      step: WRITE_STEP,
      fontSize: FONT_PX,
      // Regular, not the 700 default: heavy faces are wider *and* thicker, and at the
      // ~40 mask px a character gets they close up before a wake ever touches them.
      fontWeight: "400",
      maxWidthPx: chars * CHAR_W * FONT_PX,
      lineHeight: LINE_H,
      lang,
    });
    if (!w.count) return null;

    // Five fish, five stretches of writing, all at once. A pond is not a typewriter,
    // and writing in parallel is most of what buys the show back inside the mercy budget.
    const bounds = [0];
    const near = w.count / (KOI_N * 4);
    for (let j = 1; j < KOI_N; j++) {
      const want = Math.round((j / KOI_N) * w.count);
      let best = want;
      for (const ls of w.lineStarts) if (Math.abs(ls - want) < Math.abs(best - want)) best = ls;
      // a koi handed whole lines writes them cleanly; one that is not simply meets its
      // neighbour mid-word, which is not a thing anybody can see happen
      const b = Math.abs(best - want) < near ? best : want;
      bounds.push(Math.min(w.count, Math.max(bounds[j - 1], b)));
    }
    bounds.push(w.count);

    // The path is a dense sweep *through* the ink — column by column, up and back down
    // every stem. A fingertip can do that. A fish the size of a word cannot, and made to
    // follow it literally the calm gift thrashes. So the koi rides the path's own
    // centreline: the same curve, boxcar-averaged over about a character, which is what a
    // koi tracing a line of writing would really swim. The ink is still laid by the raw
    // path, so the message is exact — the fish is what drags the light, not what draws it.
    // …and how far out the ink actually gets from the block's own centre, for the disc
    // fit. Measured off the glyphs rather than reasoned off `aspect`: the raster is
    // padded, its corners are usually empty, and a message whose first line wraps short
    // is not one that has to pay for a corner it never wrote in. Free — the sweep below
    // walks every point anyway.
    let reach2 = 0;
    const sm = new Float32Array(w.count * 2);
    const px = new Float64Array(w.count + 1);
    const py = new Float64Array(w.count + 1);
    for (let i = 0; i < w.count; i++) {
      const x = w.path[i * 2];
      const y = w.path[i * 2 + 1];
      px[i + 1] = px[i] + x;
      py[i + 1] = py[i] + y;
      const r2 = x * x + y * y;
      if (r2 > reach2) reach2 = r2;
    }
    for (let i = 0; i < w.count; i++) {
      const a = Math.max(0, i - SMOOTH_N);
      const b = Math.min(w.count, i + SMOOTH_N + 1);
      sm[i * 2] = (px[b] - px[a]) / (b - a);
      sm[i * 2 + 1] = (py[b] - py[a]) / (b - a);
    }

    return {
      w,
      sm,
      slices: Array.from(
        { length: KOI_N },
        (_, j) => [bounds[j], bounds[j + 1]] as [number, number],
      ),
      lineStart: new Set(w.lineStarts),
      reach: Math.sqrt(reach2),
      dur: Math.min(WRITE_MAX, Math.max(WRITE_MIN, w.count / WRITE_RATE)),
      // WritePath drops the raster it came from, but aspect and the line count rebuild
      // it: rasterW = rasterH / aspect. Blank lines are collapsed above, so
      // lineStarts.length *is* that line count.
      gridFrac:
        WRITE_STEP /
        ((w.lineStarts.length * FONT_PX * LINE_H + Math.ceil(FONT_PX * 0.25) * 2) /
          Math.max(0.01, w.aspect)),
    };
  }, [source, lang]);

  // A ref and not a memo: this is the only state in the pond that a frame writes to,
  // and the lint recognizes what may be mutated by its name (same shape as foggy-mirror's
  // dripRef). Everything in it resets on the dirty rebuild below.
  const koiRef = useRef(SCHOOL.map(() => makeKoiState()));
  // Per mount, not module scope: the gallery renders a wall of these at once, and a
  // shared buffer would have them all drawing each other's pond.
  const pelletBuf = useMemo(
    () => ({ pos: new Float32Array(PELLET_N * 3), col: new Float32Array(PELLET_N * 3) }),
    [],
  );
  const glintBuf = useMemo(
    () => ({ pos: new Float32Array(GLINTS.pos), col: new Float32Array(GLINT_N * 3) }),
    [],
  );

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const bedRef = useRef<THREE.Mesh>(null);
  const waterRef = useRef<THREE.Mesh>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  const moonRef = useRef<THREE.Group>(null);
  const moonCoreRef = useRef<THREE.Mesh>(null);
  const moonHaloRef = useRef<THREE.Mesh>(null);
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const finRef = useRef<THREE.InstancedMesh>(null);
  const padRef = useRef<THREE.InstancedMesh>(null);
  const petalRef = useRef<THREE.InstancedMesh>(null);
  const rippleRef = useRef<THREE.InstancedMesh>(null);
  const pelletRef = useRef<THREE.Points>(null);
  const glintRef = useRef<THREE.Points>(null);
  const glowLightRef = useRef<THREE.PointLight>(null);

  // Per-frame uniform writes go through refs: the memos own the materials and their
  // disposal, but the lint only accepts mutation through a *Ref (same shape as foggy-mirror).
  const waterUniRef = useRef<WaterUniforms | null>(null);
  const inkUniRef = useRef<GlowUniforms | null>(null);
  const wakeUniRef = useRef<GlowUniforms | null>(null);
  useLayoutEffect(() => {
    waterUniRef.current = water.uniforms;
    inkUniRef.current = inkMat.uniforms;
    wakeUniRef.current = wakeMat.uniforms;
  }, [water, inkMat, wakeMat]);

  const dirtyRef = useRef(true);
  const foodRef = useRef(new Float32Array(PELLET_N * 3)); // x, y, born (born < 0 = empty)
  const foodNRef = useRef(0);
  const ringRef = useRef(new Float32Array(RIPPLE_N * 3)); // x, y, born
  const ringNRef = useRef(RIPPLE_AMB);
  const firstFoodRef = useRef(-1);
  const tWriteRef = useRef(T_WRITE_MIN);
  const penRef = useRef(new Int32Array(KOI_N));
  const bloomRef = useRef(0);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  /* The two masks are the only things in the pond that accumulate, so they are rebuilt
     from `phase` alone: a replay has to re-write from an empty pond, and reduced motion
     lands on `revealed` having never run an opening at all. */
  useLayoutEffect(() => {
    dirtyRef.current = true;
  }, [phase, ink, wake, write]);

  const nowRef = useRef(0);
  // Color.set parses a string, and there are ~60 instance colours a frame here.
  const cols = useMemo(
    () => ({
      body: new THREE.Color(koiPal.body),
      spot: new THREE.Color(koiPal.spot),
      fin: new THREE.Color(koiPal.fin),
      ring: new THREE.Color(time.glint),
      glint: new THREE.Color(time.glint),
      pellet: new THREE.Color("#d8b477"),
      // Authored bright, and they still land dark: Color.set converts sRGB to linear, so a
      // hex picked to *look* like a night lily pad is already near-black before a light
      // touches it, and against dusk's paler water it reads as a hole punched in the pond.
      // These are daylight leaf greens on purpose — the pipeline takes them down.
      padA: new THREE.Color("#3a6e4a"),
      padB: new THREE.Color("#5f9a63"),
    }),
    [koiPal, time],
  );

  /** A handful of food does not land all at once, so neither does this. */
  const scatter = (x: number, y: number, t0: number, spread: number) => {
    const f = foodRef.current;
    for (let i = 0; i < PELLET_PER_TAP; i++) {
      const n = foodNRef.current % PELLET_N;
      foodNRef.current = n + 1;
      const a = hash(n * 7 + i * 3) * Math.PI * 2;
      const r = Math.sqrt(hash(n * 13 + i * 5 + 1)) * spread;
      f[n * 3] = x + Math.cos(a) * r;
      f[n * 3 + 1] = y + Math.sin(a) * r;
      f[n * 3 + 2] = t0 + i * 0.09;
    }
  };

  /** born is on the wall clock, not the opening's: the pond rings whatever phase it is in. */
  const ring = (x: number, y: number, born: number) => {
    const n = RIPPLE_AMB + (ringNRef.current % (RIPPLE_N - RIPPLE_AMB));
    ringNRef.current = ringNRef.current + 1;
    const r = ringRef.current;
    r[n * 3] = x;
    r[n * 3 + 1] = y;
    r[n * 3 + 2] = born;
  };

  const onTap = (ev: ThreeEvent<PointerEvent>) => {
    if (phase !== "opening") return;
    ev.stopPropagation();
    const hit = hitRef.current;
    if (!ev.uv || !hit) return;
    let x = (ev.uv.x - 0.5) * hit.scale.x;
    let y = (ev.uv.y - 0.5) * hit.scale.y;
    // food on the bank is not food — pull a wide tap back onto the water
    const d = Math.hypot(x, y);
    const lim = POND_R * 0.84;
    if (d > lim) {
      x *= lim / d;
      y *= lim / d;
    }
    if (firstFoodRef.current < 0) firstFoodRef.current = tRef.current;
    scatter(x, y, tRef.current, PELLET_SCATTER);
    ring(x, y, nowRef.current);
    ring(x, y, nowRef.current + 0.26); // one ring reads as a target; two read as water
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    nowRef.current = e;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const wu = waterUniRef.current;
    const iu = inkUniRef.current;
    const ku = wakeUniRef.current;
    if (!wu || !iu || !ku) return; // half this pond's state is uniforms; there is nothing to pose without them

    /* The pond is an object and not the canvas: fit its square to the canvas's short
       side and let the night have whatever is left over. That holds from 0.46 to 2.53
       with no special case — and it is the whole reason every uv radius above is also
       a world one. */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const s = Math.min(vw, vh) / POND_FIT;
    if (fitRef.current) fitRef.current.scale.setScalar(s);
    // …and everything that has to reach the frame's edge is sized back out in pond
    // units every frame, because the canvas changes shape the instant it reveals.
    const cw = (vw / s) * 1.06;
    const ch = (vh / s) * 1.06;
    if (bedRef.current) bedRef.current.scale.set(cw, ch, 1);
    if (hitRef.current) hitRef.current.scale.set(cw, ch, 1);
    if (waterRef.current) waterRef.current.scale.set(cw, ch, 1);
    wu.uHalf.value.set(cw / 2, ch / 2);
    wu.uDrift.value.set(e * 0.004, e * 0.0026);
    wu.uTime.value = e;

    /* The writing is wrapped and fitted to the pond, so this is the same number on
       every viewport and in every phase — which is exactly why the mask never has to
       be re-rasterized when the canvas moves under it. Three caps, and the water wins
       whichever is meanest: the square across, the square down, and — the one that
       actually holds the promise — the disc, which is the only one of the three that
       knows the outer lines have less room than the middle ones. The koi ride `wWorld`
       too, so the school shrinks onto the message and stays on it. */
    const wWorld = write
      ? Math.min(
          POND_W * W_FRAC,
          (POND_W * H_FRAC) / Math.max(0.2, write.w.aspect),
          INK_R / Math.max(0.05, write.reach),
        )
      : 0;
    const wFrac = wWorld / POND_W;
    const gridUv = write ? write.gridFrac * wFrac : 0;
    // Just wide enough to close the path's own sampling grid, never wider: the path is a
    // sweep *through* the ink, so any radius dilates the glyph, and a couple of texels
    // past this the counters fill and the words go to blobs. The shader's halo is what
    // turns the hairline back into a wake.
    const dab = write ? Math.min(2.4, Math.max(1.05, gridUv * INK_SIZE * 0.8)) * INK_TEXEL : 0;
    const gap2 = (gridUv * 2.5) ** 2;

    if (dirtyRef.current) {
      dirtyRef.current = false;
      ink.reset();
      wake.reset();
      for (let i = 0; i < PELLET_N; i++) foodRef.current[i * 3 + 2] = -1;
      for (let i = RIPPLE_AMB; i < RIPPLE_N; i++) ringRef.current[i * 3 + 2] = -1;
      foodNRef.current = 0;
      ringNRef.current = RIPPLE_AMB;
      firstFoodRef.current = -1;
      tWriteRef.current = T_WRITE_MIN;
      bloomRef.current = 0;
      const cold = phase === "preview" || phase === "revealed";

      if (write) {
        for (let j = 0; j < KOI_N; j++) penRef.current[j] = write.slices[j][0] - 1;
        // The finished tableau, laid cold. Reduced motion never runs an opening and the
        // gallery card never runs anything at all — both land here, on frame one.
        if (cold) {
          inkTo(ink, write.w, write.lineStart, -1, write.w.count - 1, dab, wFrac, gap2, 0);
          for (let j = 0; j < KOI_N; j++) penRef.current[j] = write.slices[j][1] - 1;
        }
      }
      // A lerp needs a second to cross and the tableau has forty frames, so the cold
      // phases are set, not eased, and the easing below only ever handles live changes.
      iu.uI.value = cold ? time.bio * 0.9 : 0;
      ku.uI.value = time.bio * (phase === "sealed" ? 0.3 : 0.7);

      for (let j = 0; j < KOI_N; j++) {
        if (opening) {
          // Out in the bank, nosed at the water, with a line of track already behind it:
          // they have been circling out there in the dark the whole time it sat sealed.
          const a = SCHOOL[j].a0;
          primeLine(koiRef.current[j], Math.cos(a) * R_DARK, Math.sin(a) * R_DARK, a + Math.PI + 0.5);
        } else {
          primeIdle(koiRef.current[j], SCHOOL[j], e, phase === "sealed" ? R_DARK : R_IDLE);
        }
      }
    }

    /* ---------- the food ---------- */
    // Nobody has touched it. Rather than a timer going off, food arrives the way it does
    // when someone is standing at the bank and not saying anything about it: same food,
    // same rings, same fish. The only tell is that it lands wide, as a scattered handful
    // does, and the koi answer it exactly as they answer a tap.
    if (opening && firstFoodRef.current < 0 && t >= T_MERCY_FOOD) {
      firstFoodRef.current = T_MERCY_FOOD;
      scatter(0, 0.2, T_MERCY_FOOD, PELLET_SCATTER * 2.4);
      ring(0, 0.2, e + 0.1);
    }

    /* ---------- when the writing begins ---------- */
    // Fixed enough to be a show, loose enough to be an answer: about a gather after the
    // food lands. The window it may begin in is what holds onOpenComplete inside 12s
    // however late somebody finally taps — 6.4 + 2.8 + 0.8 = 10.0s, worst case.
    if (opening && firstFoodRef.current >= 0) {
      tWriteRef.current = Math.min(
        T_WRITE_MAX,
        Math.max(T_WRITE_MIN, firstFoodRef.current + T_GATHER),
      );
    }
    const tWrite = tWriteRef.current;
    const writing = opening && t >= tWrite;
    const prog = write ? clamp01((t - tWrite) / write.dur) : 0;

    /* ---------- the ink ---------- */
    if (write && writing) {
      for (let j = 0; j < KOI_N; j++) {
        const [a, b] = write.slices[j];
        if (b <= a) continue;
        const target = a + Math.floor(prog * (b - a)) - 1;
        if (target > penRef.current[j]) {
          inkTo(ink, write.w, write.lineStart, penRef.current[j], target, dab, wFrac, gap2, 0);
          penRef.current[j] = target;
        }
      }
    }

    /* ---------- the wake lets go ---------- */
    // Exponential and in seconds, so still water is exactly as slow about it at 30fps
    // as at 120. This is the one thing mask.ts could not already do.
    wake.fade(1 - Math.exp(-dt / WAKE_TAU));

    /* ---------- the school ---------- */
    const gather =
      opening && firstFoodRef.current >= 0 ? clamp01((t - firstFoodRef.current) / 0.8) : 0;
    const f = foodRef.current;
    for (let j = 0; j < KOI_N; j++) {
      const k = SCHOOL[j];
      const st = koiRef.current[j];
      const slice = write ? write.slices[j] : null;
      let urge = 1;
      let best = -1;
      let bd = 9;
      if (writing && write && slice && slice[1] > slice[0]) {
        // Riding its own stretch of the message. The carrot runs faster than any koi
        // swims — the light is what traces the words, the fish is only what drags it —
        // so it settles a length or so back, which is where a wake comes from anyway.
        const i = Math.min(slice[1] - 1, slice[0] + Math.floor(prog * (slice[1] - slice[0])));
        goal.set(write.sm[i * 2] * wWorld, write.sm[i * 2 + 1] * wWorld);
        urge = URGE_WRITE;
      } else {
        if (opening) {
          for (let i = 0; i < PELLET_N; i++) {
            const born = f[i * 3 + 2];
            if (born < 0 || t < born || t > born + PELLET_LIFE) continue;
            const d = (f[i * 3] - st.x) ** 2 + (f[i * 3 + 1] - st.y) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
        if (best >= 0) {
          goal.set(f[best * 3], f[best * 3 + 1]);
          urge = URGE_FOOD;
        } else {
          // no food and nothing asked: mill about, and further out the less there is to do
          idlePos(k, e, opening ? lerp(R_DARK, R_IDLE, gather) : phase === "sealed" ? R_DARK : R_IDLE, goal);
        }
      }
      swimTo(st, goal.x, goal.y, dt, urge);
      if (best >= 0 && bd < EAT_R * EAT_R) {
        f[best * 3 + 2] = -1; // and it takes it
        ring(st.x, st.y, e);
      }

      // The moonlight does not reach the bank, so neither does the eye. This is the dark
      // the koi glide in *from*, and the water's own translucency could not carry it
      // alone: a near-white fish out on the rim still reads at 14% against near-black
      // water, and five of them circling a sealed pond is a spoiler. Same falloff, on the
      // fish rather than on what is over it.
      const lit = smooth(clamp01((0.9 - Math.hypot(st.x, st.y) / POND_R) / 0.35));

      /* the body: sampled back down the head's own track, then given the beat */
      st.beat += dt * k.beat * (0.45 + 0.55 * clamp01(st.spd / CRUISE));
      const amp = 0.07 * k.scale * (0.25 + 0.75 * clamp01(st.spd / CRUISE));
      for (let i = 0; i <= SEG_N; i++) sampleBack(st, i * SEG_GAP * k.scale, bP[i]);
      for (let i = 0; i <= SEG_N; i++) {
        const a = bP[Math.max(0, i - 1)];
        const b = bP[Math.min(SEG_N, i + 1)];
        const tx = a.x - b.x;
        const ty = a.y - b.y;
        const l = Math.hypot(tx, ty) || 1;
        // The wave lags down the body — and it is biased *out* of the turn, because a
        // fish turns by shoving water the other way with its tail. The tail leads; the
        // head is what gets pushed round.
        const wv = i < SEG_N ? SEG_WAVE[i] : 1.18; // the fin overshoots the last vertebra
        const lat = wv * (amp * Math.sin(st.beat - i * WAVE_K) - st.turn * TURN_LEAD);
        bQ[i].set(bP[i].x - (ty / l) * lat, bP[i].y + (tx / l) * lat);
      }

      for (let i = 0; i < SEG_N; i++) {
        const p = bQ[i];
        const q = bQ[i + 1];
        const l = Math.hypot(p.x - q.x, p.y - q.y) || 1;
        mT.set((p.x - q.x) / l, (p.y - q.y) / l, 0);
        mN.set(-mT.y, mT.x, 0);
        mU.set(0, 0, 1);
        mQ.setFromAxisAngle(mT, -st.turn * BANK); // and it rolls into the turn, it does not slide round flat
        mN.applyQuaternion(mQ);
        mU.applyQuaternion(mQ);
        mM.makeBasis(mT, mN, mU);
        mM.scale(mS.set(BODY_L * k.scale, SEG_W[i] * k.scale, SEG_H[i] * k.scale));
        mM.setPosition(p.x, p.y, KOI_Z);
        bodyRef.current?.setMatrixAt(j * SEG_N + i, mM);
        bodyRef.current?.setColorAt(j * SEG_N + i, mC.copy(k.spot[i] ? cols.spot : cols.body).multiplyScalar(lit));
      }

      // The caudal fin is a vertical thing and from straight up you would be looking at
      // its edge. So it is laid flat and made translucent instead — which is how a koi
      // reads through water anyway: a body, and a smear of fin trailing it.
      const fp = bQ[SEG_N];
      const fx = bQ[SEG_N - 1].x - fp.x;
      const fy = bQ[SEG_N - 1].y - fp.y;
      const fl = Math.hypot(fx, fy) || 1;
      mT.set(fx / fl, fy / fl, 0);
      mN.set(-mT.y, mT.x, 0);
      mU.set(0, 0, 1);
      mM.makeBasis(mT, mN, mU);
      mM.scale(mS.set(0.34 * k.scale, 0.3 * k.scale, 1));
      // Hung off the last vertebra rather than off the tip: a fan starting where the body
      // stops floats along behind the fish like a separate object. It has to grow out of it.
      mM.setPosition(bQ[SEG_N - 1].x, bQ[SEG_N - 1].y, KOI_Z + 0.006);
      finRef.current?.setMatrixAt(j, mM);
      finRef.current?.setColorAt(j, mC.copy(cols.fin).multiplyScalar(lit));

      /* the wake comes off the tail — the only part of a koi doing anything to the water */
      const uu = 0.5 + fp.x / POND_W;
      const vv = 0.5 + fp.y / POND_W;
      if (st.wake) wake.stroke(st.wu, st.wv, uu, vv, WAKE_R, "draw");
      st.wu = uu;
      st.wv = vv;
      st.wake = true;
    }
    if (bodyRef.current) {
      bodyRef.current.instanceMatrix.needsUpdate = true;
      if (bodyRef.current.instanceColor) bodyRef.current.instanceColor.needsUpdate = true;
    }
    if (finRef.current) {
      finRef.current.instanceMatrix.needsUpdate = true;
      if (finRef.current.instanceColor) finRef.current.instanceColor.needsUpdate = true;
    }

    /* ---------- rings ---------- */
    if (rippleRef.current) {
      const rr = ringRef.current;
      // The pond's own three: something falls in every RIPPLE_PERIOD and it is nobody's
      // business what. A pure function of the clock — no state, and they never stop.
      for (let i = 0; i < RIPPLE_AMB; i++) {
        const n = Math.floor(e / RIPPLE_PERIOD - i / RIPPLE_AMB);
        const a = hash(n * 3 + i * 17) * Math.PI * 2;
        const r = Math.sqrt(hash(n * 7 + i * 31 + 5)) * POND_R * 0.85;
        rr[i * 3] = Math.cos(a) * r;
        rr[i * 3 + 1] = Math.sin(a) * r;
        rr[i * 3 + 2] = (n + i / RIPPLE_AMB) * RIPPLE_PERIOD;
      }
      let any = false;
      for (let i = 0; i < RIPPLE_N; i++) {
        const born = rr[i * 3 + 2];
        const tau = e - born;
        if (born < 0 || tau < 0 || tau > RIPPLE_LIFE) {
          mC.setScalar(0);
        } else {
          const k = tau / RIPPLE_LIFE;
          mO.position.set(rr[i * 3], rr[i * 3 + 1], 0.026);
          mO.rotation.set(0, 0, 0);
          // it slows as it goes: the ring is longer every moment and the same water is
          // being asked to be all of it
          mO.scale.setScalar(0.16 + RIPPLE_V * tau * (1 - 0.34 * k));
          mO.updateMatrix();
          rippleRef.current.setMatrixAt(i, mO.matrix);
          mC.copy(cols.ring).multiplyScalar((1 - k) ** 2 * (1 - Math.exp(-tau * 8)) * 0.24);
          any = true;
        }
        rippleRef.current.setColorAt(i, mC);
      }
      rippleRef.current.instanceMatrix.needsUpdate = true;
      if (rippleRef.current.instanceColor) rippleRef.current.instanceColor.needsUpdate = true;
      rippleRef.current.visible = any;
    }

    /* ---------- the pellets ---------- */
    if (pelletRef.current) {
      // gl_PointSize is device pixels and ignores the model matrix, so the pond's fit has
      // to be multiplied back in by hand or the food bloats to boulders on a phone.
      (pelletRef.current.material as THREE.PointsMaterial).size = 0.17 * s;
      const pa = pelletRef.current.geometry.attributes.position as THREE.BufferAttribute;
      const pc = pelletRef.current.geometry.attributes.color as THREE.BufferAttribute;
      let any = false;
      for (let i = 0; i < PELLET_N; i++) {
        const born = f[i * 3 + 2];
        const tau = t - born;
        if (born < 0 || tau < 0 || tau > PELLET_LIFE) {
          pa.setZ(i, -99);
          pc.setXYZ(i, 0, 0, 0);
          continue;
        }
        // it lands, it wanders on the surface, and what the fish do not find goes soft
        pa.setXYZ(
          i,
          f[i * 3] + 0.05 * Math.sin(e * 0.5 + i),
          f[i * 3 + 1] + 0.05 * Math.cos(e * 0.42 + i * 2),
          0.032,
        );
        mC.copy(cols.pellet).multiplyScalar(
          clamp01(tau / 0.18) * clamp01((PELLET_LIFE - tau) / 1.4),
        );
        pc.setXYZ(i, mC.r, mC.g, mC.b);
        any = true;
      }
      pa.needsUpdate = true;
      pc.needsUpdate = true;
      pelletRef.current.visible = any && opening;
    }

    /* ---------- the lilies ---------- */
    if (padRef.current) {
      for (let i = 0; i < LILY_N; i++) {
        const l = LILIES[i];
        lilyAt(l, e, tmpV);
        mO.position.set(tmpV.x, tmpV.y, 0.055 + 0.008 * Math.sin(e * 0.7 + l.p));
        // a pad is not a coaster: it sits on a surface that is moving under it
        mO.rotation.set(
          0.09 * Math.sin(e * 0.5 + l.p),
          0.09 * Math.cos(e * 0.42 + l.p),
          l.rot + e * l.spin,
        );
        mO.scale.setScalar(l.r);
        mO.updateMatrix();
        padRef.current.setMatrixAt(i, mO.matrix);
        padRef.current.setColorAt(i, mC.copy(cols.padA).lerp(cols.padB, l.tint));
      }
      padRef.current.instanceMatrix.needsUpdate = true;
      if (padRef.current.instanceColor) padRef.current.instanceColor.needsUpdate = true;
    }
    if (petalRef.current) {
      for (let i = 0; i < FLOWER_N; i++) {
        const l = LILIES[i * 3]; // each flower rides a pad, and goes wherever it goes
        lilyAt(l, e, tmpV);
        mO.position.set(tmpV.x + 0.06, tmpV.y - 0.04, 0.076);
        mO.rotation.set(0, 0, l.rot + e * l.spin);
        mO.scale.setScalar(l.r * 1.05);
        mO.updateMatrix();
        for (let p = 0; p < PETAL_N; p++) {
          mM.multiplyMatrices(mO.matrix, PETALS[p].m);
          petalRef.current.setMatrixAt(i * PETAL_N + p, mM);
          petalRef.current.setColorAt(i * PETAL_N + p, PETAL_C[PETALS[p].c]);
        }
      }
      petalRef.current.instanceMatrix.needsUpdate = true;
      if (petalRef.current.instanceColor) petalRef.current.instanceColor.needsUpdate = true;
    }

    /* ---------- the sky, lying on the water ---------- */
    if (glintRef.current) {
      (glintRef.current.material as THREE.PointsMaterial).size = 0.1 * s; // see the pellets
      const ga = glintRef.current.geometry.attributes.position as THREE.BufferAttribute;
      const gc = glintRef.current.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < GLINT_N; i++) {
        // the surface carries them about — a reflection that holds still is a mirror
        ga.setXY(
          i,
          GLINTS.pos[i * 3] + 0.05 * Math.sin(e * 0.23 + GLINTS.ph[i]),
          GLINTS.pos[i * 3 + 1] + 0.05 * Math.cos(e * 0.19 + GLINTS.ph[i] * 1.7),
        );
        // sharp, not sinusoidal: a glint is the one instant a facet is aimed at you
        mC.copy(cols.glint).multiplyScalar(
          Math.pow(Math.max(0, Math.sin(e * GLINTS.sp[i] + GLINTS.ph[i])), 6) * time.moonI * 0.8,
        );
        gc.setXYZ(i, mC.r, mC.g, mC.b);
      }
      ga.needsUpdate = true;
      gc.needsUpdate = true;
    }

    /* ---------- the moon, lying on the water ---------- */
    // It belongs to the sky and not to the pond, so the water tears it up rather than
    // the other way round: smeared along the swell, and never quite holding still.
    if (moonRef.current && moonCoreRef.current && moonHaloRef.current) {
      const wob = 0.5 * Math.sin(e * 0.6) + 0.5 * Math.sin(e * 0.23);
      moonRef.current.position.set(MOON_X + wob * 0.06, MOON_Y + 0.05 * Math.sin(e * 0.41), 0.014);
      moonCoreRef.current.scale.set(0.66 + wob * 0.06, 1.2 + 0.3 * Math.sin(e * 0.37), 1);
      moonHaloRef.current.scale.setScalar(2.7 + wob * 0.2);
    }

    /* ---------- how much of any of it reads ---------- */
    // One scalar. `time` decides how much room the eye has for bioluminescence — a wake
    // glows exactly as hard at dawn, you simply cannot see it against the light — and
    // every channel hangs off it: both glow planes and the light they throw back on the
    // fish. Guarding one of the three is not guarding the look.
    const flareWant = writing ? clamp01(1 - (t - tWrite) / ((write ? write.dur : WRITE_MIN) + T_SETTLE)) : 0;
    bloomRef.current += (flareWant - bloomRef.current) * Math.min(1, dt / BLOOM_TAU);
    // "…tracing the message across the water before fading to a steady glow": the mask
    // holds the message at full the whole time, so what settles is the light in it.
    const inkWant = phase === "sealed" || (opening && !writing) ? 0 : time.bio * 0.9;
    iu.uI.value += (inkWant * (1 + 0.9 * bloomRef.current) - iu.uI.value) * Math.min(1, dt * 3);
    // Under the wake, not over it: a koi is dimmed by the water it is under and its wake
    // is not, so at parity the trail outshone the fish that made it and the pond read as
    // smoke. The fish is the thing; the wake is what the fish did.
    const wakeWant = time.bio * (phase === "sealed" ? 0.22 : 0.42);
    ku.uI.value += (wakeWant - ku.uI.value) * Math.min(1, dt * 2);
    // Weak, and high: this is an accent, not the look. The additive planes are the glow —
    // the light is only what the water hands back to the fish and the pads. Close and hot,
    // it lit every lily neon teal the moment the message came up.
    if (glowLightRef.current) glowLightRef.current.intensity = iu.uI.value * 0.55;

    /* only the pond leans: from straight up there is nothing else to lean */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 2.5);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, -state.pointer.y * 0.07, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.07, k);
    }

    if (opening && t > tWrite + (write ? write.dur : WRITE_MIN) + T_SETTLE && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 5.4, 0]}
        fov={40}
        onUpdate={(c) => {
          // Straight down, and screen-up pinned to -z. Which collapses the mask's uv, the
          // write path's xy and the pond's own xy into one single space: no basis in this
          // file ever has to be reconciled with another, and viewport.width/height are
          // exactly the pond's x/z span at the water.
          c.up.set(0, 0, -1);
          c.lookAt(0, 0, 0);
        }}
      />
      <ambientLight intensity={time.ambI} color={time.amb} />
      {/* the moon is over there, so its light comes from over there */}
      <directionalLight position={[-3, 4, 2.6]} intensity={time.keyI} color={time.key} />
      {/* the house bloom: the writing is additive planes, and this is the light they
          throw back down onto the fish. Same scalar, or it is not the same look. */}
      <pointLight ref={glowLightRef} position={[0, 1.6, 0]} intensity={0} color={time.cool} distance={6} />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* The pond's own plane: local xy is the water, +z is up out of it. Everything
              below is 2D and in pond units, including the two masks. */}
          <group rotation={[-Math.PI / 2, 0, 0]}>
            {/* the bed — something has to be under translucent water, or the page is */}
            <mesh ref={bedRef} position={[0, 0, -0.5]}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial color={time.bed} />
            </mesh>

            {/* the school, under the surface and seen through it */}
            <instancedMesh ref={bodyRef} args={[undefined, undefined, KOI_N * SEG_N]}>
              <sphereGeometry args={[1, 10, 7]} />
              <meshStandardMaterial roughness={koiPal.rough} metalness={koiPal.metal} />
            </instancedMesh>
            <instancedMesh ref={finRef} args={[undefined, undefined, KOI_N]} renderOrder={-2}>
              <circleGeometry args={[1, 10, Math.PI * 0.62, Math.PI * 0.76]} />
              <meshBasicMaterial transparent opacity={0.3} depthWrite={false} side={THREE.DoubleSide} />
            </instancedMesh>

            {/* the water: translucent over the fish, opaque out on the bank, and the bank
                is what they glide in from. Sized to the canvas every frame — never by eye. */}
            <mesh ref={waterRef} renderOrder={-1}>
              <planeGeometry args={[1, 1]} />
              <primitive object={water.mat} attach="material" />
            </mesh>

            {/* the sky, lying on it */}
            <points ref={glintRef}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[glintBuf.pos, 3]} />
                <bufferAttribute attach="attributes-color" args={[glintBuf.col, 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={glowTex}
                size={0.1}
                sizeAttenuation
                vertexColors
                transparent
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </points>
            <group ref={moonRef} position={[MOON_X, MOON_Y, 0.014]}>
              <mesh ref={moonHaloRef}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                  map={glowTex}
                  color={time.moon}
                  transparent
                  opacity={0.1 * time.moonI}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
              <mesh ref={moonCoreRef} position={[0, 0, 0.001]}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                  map={glowTex}
                  color={time.moon}
                  transparent
                  opacity={0.55 * time.moonI}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            </group>

            {/* the message, and the wakes still writing it. Both are the pond square, so
                their uv is the pond's xy and a fixed radius stays a fixed radius. */}
            <mesh position={[0, 0, 0.018]}>
              <planeGeometry args={[POND_W, POND_W]} />
              <primitive object={inkMat.mat} attach="material" />
            </mesh>
            <mesh position={[0, 0, 0.022]}>
              <planeGeometry args={[POND_W, POND_W]} />
              <primitive object={wakeMat.mat} attach="material" />
            </mesh>

            <instancedMesh ref={rippleRef} args={[undefined, undefined, RIPPLE_N]}>
              <planeGeometry args={[2, 2]} />
              <meshBasicMaterial
                map={ringTex}
                transparent
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </instancedMesh>

            <points ref={pelletRef} visible={false} renderOrder={1}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[pelletBuf.pos, 3]} />
                <bufferAttribute attach="attributes-color" args={[pelletBuf.col, 3]} />
              </bufferGeometry>
              <pointsMaterial map={glowTex} size={0.17} sizeAttenuation vertexColors transparent depthWrite={false} />
            </points>

            {/* the lilies ride over everything, words included */}
            <instancedMesh ref={padRef} args={[undefined, undefined, LILY_N]}>
              <circleGeometry args={[1, 22, 0.22, Math.PI * 2 - 0.44]} />
              <meshStandardMaterial roughness={0.72} metalness={0.04} />
            </instancedMesh>
            <instancedMesh ref={petalRef} args={[undefined, undefined, FLOWER_N * PETAL_N]}>
              <sphereGeometry args={[1, 8, 6]} />
              <meshStandardMaterial roughness={0.66} />
            </instancedMesh>

            {/* Raycasting ignores visible={false}, so this is transparent at zero instead. */}
            <mesh ref={hitRef} position={[0, 0, 0.1]} onPointerDown={onTap}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          </group>
        </group>
      </group>
    </>
  );
}
