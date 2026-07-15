import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { orderWritePath, makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth, easeOutCubic } from "../math";
import { forRecipient, type Lang } from "../../i18n";
import { pick } from "../catalog";

/* ============================================================================
   NEON WORKSHOP — the recipient wires the message up themselves, one tube at a
   time. A dead glass sign lies on a rooftop workbench; drag along its length and
   the gas catches behind the finger, sputters, holds, and the whole sign blazes
   up against the skyline.

   The sign is `orderWritePath(message)` — a dense sweep THROUGH the ink of the
   glyphs, in writing order. That ordering is the whole trick: it turns the 2D
   shape of the message into a 1D parameter, so "how far along have you traced"
   is a single number (0..1) and lighting the traced portion is one uniform.

   DEVIATION FROM THE BRIEF, and a deliberate one: the glass is rendered as a
   dense rod of soft round sprites, not a THREE.TubeGeometry. orderWritePath's
   own docs warn it is a fill-sweep and NOT a centreline "to hang a spline off":
   a CatmullRom through it snakes up and down every stroke and a TubeGeometry
   built on that frenet-sawtooths into a crinkled ribbon. Overlapping soft discs
   along the same path merge into a continuous glowing rod that fills the letters
   exactly the way bent neon does — and the brief's own second option, "radial
   sprite billboards along the tube", is precisely this. Glow is faked the house
   way (additive sprites + a hot white core), since there is no bloom in the stack.
   ============================================================================ */

/* ---------- the gas ---------- */
// A neon colour is really two colours: the discharge tint the tube reads as, and
// the hot white core where the gas is densest. `glass` is a dark tint of the gas,
// because a dead neon tube still shows the colour of the phosphor it is coated in.
interface Gas {
  neon: string;
  core: string;
  glass: string; // the unlit tube — a dark ghost of the gas
  lamp: string; // the work lamp's warm answer, so the two variants don't tint alike
}
const GASES: Record<string, Gas> = {
  rose: { neon: "#ff2f86", core: "#ffd9ea", glass: "#3a1526", lamp: "#ffb066" },
  cyan: { neon: "#1ee4ff", core: "#d8ffff", glass: "#0f2c34", lamp: "#ffcf8a" },
  amber: { neon: "#ff9d1e", core: "#ffe8c0", glass: "#3a2609", lamp: "#ffd18a" },
};

/* ---------- the night behind the sign ---------- */
// Cheap additive weather. Rooftop bokeh is the city out of focus; the mood layer
// on top (streaks / stars / fog banks) is the only thing that changes, and each
// is one draw call.
interface Night {
  top: string; // sky gradient
  bot: string;
  glow: string; // the city's light dome on the horizon
  bokeh: string[]; // out-of-focus window/sign lights
  rain: number;
  stars: number;
  fog: number;
  reflect: number; // how wet the rooftop is — how strongly the sign mirrors below
  seed: number;
}
const NIGHTS: Record<string, Night> = {
  rain: {
    top: "#070b16", bot: "#0d1524", glow: "#14243c",
    bokeh: ["#3a6ea5", "#5a8fd0", "#b9d4f0", "#c98a3a"],
    rain: 1, stars: 0, fog: 0, reflect: 1.0, seed: 7412,
  },
  clear: {
    top: "#05060f", bot: "#0a0e1e", glow: "#1a1c34",
    bokeh: ["#ffcf8a", "#ff9a5a", "#8fb4e0", "#ffe3b0"],
    rain: 0, stars: 1, fog: 0, reflect: 0.5, seed: 2231,
  },
  fog: {
    top: "#0a0c12", bot: "#141821", glow: "#20242e",
    bokeh: ["#8895a5", "#c0c8d2", "#a88b6a", "#6f7e90"],
    rain: 0, stars: 0.28, fog: 1, reflect: 0.18, seed: 5093,
  },
};

/* ---------- stage ---------- */
const FOV = 40;
const CAM_Z = 4.3;
const SIGN_CY = 0.18; // a touch high — the maker's plate hangs below the words
const HOIST_DY = 0.22; // world units the finished sign rises when it hoists. Applied on the
// UNSCALED outer group, not the fit-scaled inner one — otherwise a wide sign (W≈2.7) turned
// this into a ~1.4-unit launch that carried the whole message off the top of the viewport.
const TILT_SEALED = -0.34; // the dead sign lies tipped back on the bench…
// …and straightens to face you as it hoists. Kept modest so the words still read
// in the small preview tile, where the sign never straightens at all.

/* ---------- opening timeline (seconds) ---------- */
// A gift may never outlast 12s untouched, and the bound is on onOpenComplete. The
// no-input path is: mercy fills the sign by T_MERCY0 + MERCY_RAMP = 7.0, then the
// finale runs FINALE_HOLD = 1.7 → done ~8.7s, comfortably inside 12 even with
// `dt` clamped to 0.05 running this clock behind a frame-dropping phone's wall clock.
const T_MERCY0 = 3.0; // the power creeps on for them if they never touch it…
const MERCY_RAMP = 4.0; // …easing in over these seconds, so it reads as the sign warming, not a timer
const FILL_RATE = 0.95; // how fast the lit head chases the finger (or the mercy cap)
const FINALE_HOLD = 1.7; // blaze flash → settle → hoist, then the show is over
const HINT_ORDER_RATE = 0.13; // the "trace me" bead's sweep speed along the dead tube
const SPARK_LIFE = 0.7;
const SPARK_N = 22;
const SEALED_SPARK = 4.6; // the loose wire ticks over every so often while it waits

/* ---------- text shaping ---------- */
// A script face: neon is bent in continuous cursive, and the connected strokes
// keep the sprite rod reading as one tube. Arabic is natively cursive, so it is
// the native case here — orderWritePath routes "ar" to Thmanyah + rtl for free.
const SCRIPT = "'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive";

/* ---------- shared sprites (module singletons, app-lifetime) ---------- */
const glowTex = makeRadialSprite();
// A firmer-cored sprite for the glass rod: the discs have to overlap into a solid
// tube, so the falloff holds near-opaque well past the centre before it lets go.
const rodTex = makeRadialSprite(48, [
  [0, "rgba(255,255,255,1)"],
  [0.55, "rgba(255,255,255,0.9)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- the neon shader ---------- */
// One pass drives the entire performance from three clocks-worth of uniforms and
// two per-vertex attributes (aOrder along the path, aSeg = which stroke it belongs
// to). Nothing per-vertex is touched on the CPU, so a replay is bit-identical to
// the first run and reduced motion lands on the finished sign in a single frame.
const NEON_VERT = `
attribute float aOrder;
attribute float aSeg;
uniform float uHead;     // lit fraction of the sign, 0..1
uniform float uIdle;     // preview: a few strokes buzz as the power teases on
uniform float uHint;     // sealed: a bead sweeps the dead tube, "trace me"
uniform float uHintPos;
uniform float uBlaze;    // finale over-drive
uniform float uTime;
uniform float uSize;     // world diameter of a puff
uniform float uScale;    // world->pixel for gl_PointSize
varying float vB;
float hash(float x){ return fract(sin(x * 127.1) * 43758.5453123); }
void main() {
  float reached = step(aOrder, uHead);
  float behind = uHead - aOrder;
  // 0 right at the head (where it sputters), 1 a moment behind (where it holds)
  float settle = smoothstep(0.0, 0.09, behind);
  // as the head passes, each stroke catches in a random stutter that settles into
  // a steady hum — the flicker IS noise on the emissive, quantised per stroke so a
  // whole letter buzzes together instead of dissolving into sparkle
  float blink = mix(hash(aSeg * 4.7 + floor(uTime * 20.0)), 1.0, settle);
  float hum = 0.86 + 0.14 * sin(uTime * 5.5 + aSeg * 24.0);
  float b = reached * max(blink * hum, 0.14);          // once lit, the gas never goes fully dark
  b += uIdle * (0.3 + 0.7 * hash(aSeg * 9.1 + floor(uTime * 6.0)));
  float d = aOrder - uHintPos;
  b += uHint * exp(-d * d * 1400.0);                    // a ~0.05-wide travelling bead
  b += uBlaze * reached;
  vB = clamp(b, 0.0, 2.2);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(uSize * uScale / max(-mv.z, 0.1), 96.0);
}
`;
const NEON_FRAG = `
uniform sampler2D uTex;
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uGain;
varying float vB;
void main() {
  float m = texture2D(uTex, gl_PointCoord).a;
  // A saturated gas tube with a thin hot centreline, NOT a white slab. Pinning the
  // white high (0.55..0.95, was 0.15..0.95) keeps the disc the gas colour almost all
  // the way in, so stacked discs stay rose/cyan/amber instead of piling additively up
  // to clipped white; only the innermost core pixels tip toward uCore.
  vec3 col = mix(uColor, uCore, smoothstep(0.55, 0.95, m));
  gl_FragColor = vec4(col * uGain, m * vB);
}
`;

interface NeonUniforms {
  [k: string]: THREE.IUniform;
  uHead: { value: number };
  uIdle: { value: number };
  uHint: { value: number };
  uHintPos: { value: number };
  uBlaze: { value: number };
  uTime: { value: number };
  uSize: { value: number };
  uScale: { value: number };
  uColor: { value: THREE.Color };
  uCore: { value: THREE.Color };
  uGain: { value: number };
  uTex: { value: THREE.Texture };
}

function makeNeonMat(gas: Gas, gain: number, tex: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHead: { value: 0 }, uIdle: { value: 0 }, uHint: { value: 0 }, uHintPos: { value: 0 },
      uBlaze: { value: 0 }, uTime: { value: 0 }, uSize: { value: 0.05 }, uScale: { value: 600 },
      uColor: { value: new THREE.Color(gas.neon) },
      uCore: { value: new THREE.Color(gas.core) },
      uGain: { value: gain },
      uTex: { value: tex },
    } as NeonUniforms,
    vertexShader: NEON_VERT,
    fragmentShader: NEON_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/* ---------- the dead glass ---------- */
// Normal-blended, dark, always visible: the physical tube lying on the bench. A
// glass highlight rides its crown (m near 1) so the work lamp catches it and the
// shape reads even with every scrap of gas switched off, in the preview tile.
const GLASS_VERT = `
uniform float uSize;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(uSize * uScale / max(-mv.z, 0.1), 96.0);
}
`;
const GLASS_FRAG = `
uniform sampler2D uTex;
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  float m = texture2D(uTex, gl_PointCoord).a;
  float hi = smoothstep(0.72, 1.0, m) * 0.55; // the lamp down the tube's spine
  gl_FragColor = vec4(uColor + hi, m * uAlpha);
}
`;
function makeGlassMat(gas: Gas): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 0.028 }, uScale: { value: 600 },
      uColor: { value: new THREE.Color(gas.glass) },
      uAlpha: { value: 0.9 },
      uTex: { value: rodTex },
    },
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

/* ---------- per-layer puff diameters, as a fraction of the unit sign width ---------- */
// Tuned so the discs overlap into a rod at ~step-4 spacing, and — the load-bearing
// part — so the LETTERS READ: the glow is a snug aura, not a wide bloom, or the
// halos of neighbouring strokes (and stacked wrapped lines) fuse into one lit smear.
// The glass is a firm tube, the core a tight hot filament inside it, the glow just a
// hair proud of the glass so it haloes the tube without swallowing the whitespace.
const SIZE_GLASS = 0.028;
const SIZE_CORE = 0.013;   // was 0.016 — a thinner filament, so the hot centreline can't fatten into a slab
const SIZE_GLOW = 0.038;   // was 0.058 — a snug halo; the old one bloomed until adjacent strokes fused
const SIZE_REFLECT = 0.048; // was 0.066 — the mirror trimmed to match, so the wet floor doesn't fog over

/* ---------- the message, ordered into a single traceable path ---------- */
interface Sign {
  geo: THREE.BufferGeometry;
  pathX: Float32Array; // unit coords, kept apart from the position buffer for the nearest-point search
  pathY: Float32Array;
  aspect: number;
  count: number;
  sparkAt: number; // the order fraction where the loose wire sits
  sparkX: number;
  sparkY: number;
}
function buildSign(text: string, lang: Lang): Sign | null {
  // A long message wraps into more, smaller lines; a coarser step there keeps the
  // point budget bounded without thinning any one stroke (which would shred the rod).
  const step = text.length > 140 ? 5 : 4;
  const w = orderWritePath(text, {
    step,
    fontSize: 84,
    fontWeight: "700",
    fontFamily: SCRIPT,
    maxWidthPx: 1100,
    lineHeight: 1.16,
    lang,
  });
  const N = w.count;
  if (!N) return null;

  const pos = new Float32Array(N * 3);
  const order = new Float32Array(N);
  const seg = new Float32Array(N);
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const lineSet = new Set(w.lineStarts);
  const rand = mulberry32(9371);
  const jit = mulberry32(2255);
  let segVal = rand();
  for (let i = 0; i < N; i++) {
    const x = w.path[i * 2];
    const y = w.path[i * 2 + 1];
    px[i] = x;
    py[i] = y;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = (jit() - 0.5) * 0.012; // a little depth so the rod has body
    order[i] = N > 1 ? i / (N - 1) : 0;
    // a new stroke begins at a line break or wherever the sweep leaps a gap between
    // letters — so each letter flickers to life as its own unit
    if (i > 0) {
      const dx = x - w.path[(i - 1) * 2];
      const dy = y - w.path[(i - 1) * 2 + 1];
      if (lineSet.has(i) || dx * dx + dy * dy > 0.02 * 0.02) segVal = rand();
    }
    seg[i] = segVal;
  }

  const si = Math.floor(N * 0.42); // the loose wire, a little under halfway along
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aOrder", new THREE.BufferAttribute(order, 1));
  geo.setAttribute("aSeg", new THREE.BufferAttribute(seg, 1));
  return {
    geo,
    pathX: px,
    pathY: py,
    aspect: w.aspect > 0 ? w.aspect : 1,
    count: N,
    sparkAt: order[si],
    sparkX: px[si],
    sparkY: py[si],
  };
}

/* ---------- the night sky ---------- */
function buildSkyTexture(night: Night): THREE.CanvasTexture {
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, night.top);
  grad.addColorStop(1, night.bot);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // the city's light dome, low and warm, hugging the horizon
  const dome = g.createRadialGradient(W * 0.5, H * 1.05, 4, W * 0.5, H * 1.05, H * 0.9);
  dome.addColorStop(0, night.glow);
  dome.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = dome;
  g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- out-of-focus city bokeh ---------- */
interface Bokeh {
  n: number;
  pos: Float32Array;
  col: Float32Array;
  base: Float32Array;
  phase: Float32Array;
  speed: Float32Array;
}
function buildBokeh(n: number, seed: number, tints: string[], spreadX: number, z: number): Bokeh {
  const rand = mulberry32(seed);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const base = new Float32Array(n * 3);
  const phase = new Float32Array(n);
  const speed = new Float32Array(n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rand() * 2 - 1) * spreadX;
    // biased low: city lights gather toward the horizon, thinning upward
    pos[i * 3 + 1] = -2.4 + Math.pow(rand(), 1.6) * 5.2;
    pos[i * 3 + 2] = z + rand() * 1.2;
    c.set(tints[Math.floor(rand() * tints.length)]);
    const b = 0.4 + rand() * 0.55;
    base[i * 3] = c.r * b;
    base[i * 3 + 1] = c.g * b;
    base[i * 3 + 2] = c.b * b;
    phase[i] = rand() * Math.PI * 2;
    speed[i] = 0.5 + rand() * 0.9;
  }
  col.set(base);
  return { n, pos, col, base, phase, speed };
}
function driftBokeh(b: Bokeh, dt: number, e: number, rainAmt: number, posA: THREE.BufferAttribute, colA: THREE.BufferAttribute) {
  for (let i = 0; i < b.n; i++) {
    let y = posA.getY(i);
    // in rain the whole field creeps down (streaking past); otherwise it just breathes
    y += (Math.sin(e * 0.25 + b.phase[i]) * 0.04 - rainAmt * 0.12 * b.speed[i]) * dt;
    if (y < -2.6) y += 5.2;
    posA.setY(i, y);
    const f = 0.7 + 0.3 * Math.sin(e * (1.2 + b.speed[i]) + b.phase[i]); // twinkle
    colA.setXYZ(i, b.base[i * 3] * f, b.base[i * 3 + 1] * f, b.base[i * 3 + 2] * f);
  }
  posA.needsUpdate = true;
  colA.needsUpdate = true;
}

/* ---------- stars (clear night; a faint dusting in fog) ---------- */
const STAR_VERT = `
attribute float aPhase;
uniform float uTime;
uniform float uAmt;
varying float vA;
void main() {
  vA = uAmt * (0.45 + 0.55 * sin(uTime * (1.5 + aPhase) + aPhase * 6.28));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 2.2;
}
`;
const STAR_FRAG = `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.0, length(d));
  gl_FragColor = vec4(uColor, m * vA);
}
`;
function buildStars(seed: number): { geo: THREE.BufferGeometry; n: number } {
  const n = 90;
  const rand = mulberry32(seed);
  const pos = new Float32Array(n * 3);
  const ph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rand() * 2 - 1) * 9;
    pos[i * 3 + 1] = 1.5 + rand() * 5; // upper sky only
    pos[i * 3 + 2] = -5 - rand() * 2;
    ph[i] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(ph, 1));
  return { geo, n };
}

/* ---------- rain (real streaks: rigid diagonal segments, wrapped in the shader) ---------- */
const RAIN_VERT = `
attribute float aOff;
uniform float uTime;
uniform float uSpeed;
uniform float uRange;
void main() {
  vec3 p = position;
  float fall = mod(uTime * uSpeed + aOff, uRange);
  p.y -= fall;         // both endpoints of a streak share aOff, so it falls rigid
  p.x -= fall * 0.26;  // …and slants with the wind
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
const RAIN_FRAG = `
uniform vec3 uColor;
uniform float uAmt;
void main() { gl_FragColor = vec4(uColor, 0.32 * uAmt); }
`;
function buildRain(seed: number): { geo: THREE.BufferGeometry; range: number } {
  const drops = 130;
  const range = 9; // taller than the frame, so streaks wrap off-screen
  const rand = mulberry32(seed);
  const pos = new Float32Array(drops * 2 * 3);
  const off = new Float32Array(drops * 2);
  for (let i = 0; i < drops; i++) {
    const x = (rand() * 2 - 1) * 7;
    const y = rand() * range;
    const len = 0.28 + rand() * 0.3;
    const o = rand() * range;
    // top endpoint then bottom endpoint of the streak
    pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = -2 - rand() * 2;
    pos[i * 6 + 3] = x - len * 0.26; pos[i * 6 + 4] = y - len; pos[i * 6 + 5] = pos[i * 6 + 2];
    off[i * 2] = o;
    off[i * 2 + 1] = o;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aOff", new THREE.BufferAttribute(off, 1));
  return { geo, range };
}

export default function NeonSignScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const gas = GASES[variants.gas] ?? GASES.rose;
  const night = NIGHTS[variants.night] ?? NIGHTS.rain;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" on the gallery card, and the card must read at thumbnail size,
  // so preview always shows the short "For you" copy — never a 280-char paragraph
  // bent into neon and shrunk to mush.
  const written = message.trim();
  const source = phase === "preview" || !written ? forRecipient(lang, recipientName) : written;

  /* useMemo is load-bearing: it owns every GPU resource here and each is disposed below. */
  const sign = useMemo(() => buildSign(source, lang), [source, lang]);
  useEffect(() => () => sign?.geo.dispose(), [sign]);

  const mats = useMemo(
    () => ({
      glass: makeGlassMat(gas),
      glow: makeNeonMat(gas, 0.3, glowTex),  // was 0.5 — a soft aura, dialled down so neighbouring lines don't bleed together
      core: makeNeonMat(gas, 0.62, glowTex), // was 0.95 — enough to read hot, low enough not to blow the spine to white
      reflect: makeNeonMat(gas, 0.3, glowTex),
      backglow: new THREE.MeshBasicMaterial({
        map: glowTex, color: gas.neon, transparent: true, opacity: 0,
        depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
      }),
    }),
    [gas],
  );
  useEffect(
    () => () => {
      mats.glass.dispose();
      mats.glow.dispose();
      mats.core.dispose();
      mats.reflect.dispose();
      mats.backglow.dispose();
    },
    [mats],
  );

  const sky = useMemo(() => buildSkyTexture(night), [night]);
  useEffect(() => () => sky.dispose(), [sky]);

  const bokeh = useMemo(
    () => ({
      far: buildBokeh(34, night.seed, night.bokeh, 8, -5),
      near: buildBokeh(12, night.seed + 51, night.bokeh, 6, -3),
    }),
    [night],
  );
  // bokeh's buffers are plain typed arrays and its <bufferGeometry> is JSX-owned, so
  // react-three-fiber tears it down with the component — nothing to dispose by hand.

  const stars = useMemo(() => buildStars(night.seed + 900), [night]);
  useEffect(() => () => stars.geo.dispose(), [stars]);
  const rain = useMemo(() => buildRain(night.seed + 300), [night]);
  useEffect(() => () => rain.geo.dispose(), [rain]);

  const starMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAmt: { value: 0 }, uColor: { value: new THREE.Color("#dfe9ff") } },
        vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useEffect(() => () => starMat.dispose(), [starMat]);
  const rainMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uSpeed: { value: 7 }, uRange: { value: rain.range },
          uAmt: { value: night.rain }, uColor: { value: new THREE.Color("#bcd6f0") },
        },
        vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    [rain, night],
  );
  useEffect(() => () => rainMat.dispose(), [rainMat]);

  // The maker's plate — both names, cold-drawn onto a little brass tag under the
  // sign. Hidden until the sign hoists, so preview's placeholder names never show.
  const plate = useMemo(() => {
    const s = senderName.trim();
    const r = recipientName.trim();
    if (!s && !r) return null;
    const label = pick(
      lang,
      `bent by ${s || "—"} for ${r || "you"}`,
      `صاغها ${s || "—"} لـ ${r || "لك"}`,
    );
    const { texture, aspect } = makeTextTexture(label, {
      fontSize: 46, fontWeight: "600", color: "#ffe9c8", glow: 8, glowColor: gas.neon,
      maxWidthPx: 900, padding: 24, lang,
    });
    return { texture, aspect };
  }, [senderName, recipientName, lang, gas]);
  useEffect(() => () => plate?.texture.dispose(), [plate]);

  // Sparks off the loose wire — a mutable sim in a ref, the buffers it feeds in a memo.
  const sparkBuf = useMemo(
    () => ({ pos: new Float32Array(SPARK_N * 3), col: new Float32Array(SPARK_N * 3) }),
    [],
  );
  const sparks = useRef({
    t0: new Float32Array(SPARK_N).fill(-99),
    ox: new Float32Array(SPARK_N),
    oy: new Float32Array(SPARK_N),
    vx: new Float32Array(SPARK_N),
    vy: new Float32Array(SPARK_N),
    cursor: 0,
  });

  /* ---------- refs ---------- */
  const leanRef = useRef<THREE.Group>(null);
  const signOuterRef = useRef<THREE.Group>(null); // scaled by the fitted world width
  const signInnerRef = useRef<THREE.Group>(null); // hoist + tilt
  const reflectGroupRef = useRef<THREE.Group>(null);
  const glassRef = useRef<THREE.Points>(null);
  const glowRef = useRef<THREE.Points>(null);
  const coreRef = useRef<THREE.Points>(null);
  const reflectRef = useRef<THREE.Points>(null);
  const backglowRef = useRef<THREE.Mesh>(null);
  const plateGroupRef = useRef<THREE.Group>(null);
  const plateMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const plateTagRef = useRef<THREE.MeshBasicMaterial>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  const bokehFarRef = useRef<THREE.Points>(null);
  const bokehNearRef = useRef<THREE.Points>(null);
  const starRef = useRef<THREE.Points>(null);
  const rainRef = useRef<THREE.LineSegments>(null);
  const fogRef = useRef<THREE.Group>(null);
  const lampRef = useRef<THREE.Sprite>(null);
  const lampMatRef = useRef<THREE.SpriteMaterial>(null);
  const sparkRef = useRef<THREE.Points>(null);

  // Trace state. `reach` is the furthest order the finger has swept to, monotonic;
  // `head` chases it (and the mercy cap) at a bounded rate, so the light lags the
  // fingertip and fills in smoothly rather than snapping.
  const traceRef = useRef({ down: false, reach: 0 });
  const headRef = useRef(0);
  const finaleAtRef = useRef(-1);
  const hoistRef = useRef(0);
  const sparkedRef = useRef(false);
  const lastSealedSparkRef = useRef(0);

  // Replay re-enters "opening": reset everything the sign accumulates, or the
  // second run would start already lit.
  useLayoutEffect(() => {
    traceRef.current.down = false;
    traceRef.current.reach = 0;
    headRef.current = phase === "revealed" ? 1 : 0;
    finaleAtRef.current = -1;
    hoistRef.current = phase === "revealed" ? 1 : 0;
    sparkedRef.current = phase === "revealed";
    sparks.current.t0.fill(-99);
  }, [phase]);

  const emitSparks = (e: number, count: number) => {
    if (!sign) return;
    const sk = sparks.current;
    for (let k = 0; k < count; k++) {
      const i = sk.cursor;
      sk.cursor = (i + 1) % SPARK_N;
      const a = -0.2 + Math.random() * (Math.PI + 0.4); // fan upward and out
      sk.t0[i] = e;
      sk.ox[i] = sign.sparkX + (Math.random() - 0.5) * 0.02;
      sk.oy[i] = sign.sparkY + (Math.random() - 0.5) * 0.02;
      sk.vx[i] = Math.cos(a) * (0.18 + Math.random() * 0.22);
      sk.vy[i] = Math.sin(a) * (0.22 + Math.random() * 0.28);
    }
  };

  /* ---------- pointer: the finger tracing the tube ---------- */
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const nearestOrder = (ev: ThreeEvent<PointerEvent>): { order: number; near: boolean } => {
    const hit = hitRef.current;
    if (!hit || !sign) return { order: 0, near: false };
    // worldToLocal on the hit mesh (a child of the un-fitted inner group) hands back
    // the finger in the sign's own unit space, tilt and hoist already undone.
    hit.worldToLocal(tmp.copy(ev.point));
    let best = Infinity;
    let bestOrder = 0;
    for (let i = 0; i < sign.count; i++) {
      const dx = tmp.x - sign.pathX[i];
      const dy = tmp.y - sign.pathY[i];
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bestOrder = i / (sign.count - 1);
      }
    }
    return { order: bestOrder, near: best < 0.06 * 0.06 };
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety; onPointerUp/Out cover its absence */
    }
    traceRef.current.down = true;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    if (!traceRef.current.down || phase !== "opening") return;
    ev.stopPropagation();
    const { order, near } = nearestOrder(ev);
    const tr = traceRef.current;
    // Only advance if the finger is near the tube AND not skipping too far ahead:
    // you cannot tap the end to light the sign, you have to sweep along it.
    if (near && order <= tr.reach + 0.16) tr.reach = Math.max(tr.reach, order);
  };
  const stop = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    traceRef.current.down = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    /* ---- fit the sign into the viewport ---- */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const aspect = sign?.aspect ?? 1;
    // both bounds real: wide signs cap on width, tall (wrapped) ones on height
    const W = sign ? Math.min(vw * 0.82, (vh * 0.6) / aspect) : 1;
    signOuterRef.current?.scale.setScalar(W);
    // world->pixel for every gl_PointSize (device px, so fold in dpr)
    const uScale = (state.size.height * state.viewport.dpr) / (2 * Math.tan((FOV * Math.PI) / 360));

    /* ---- the whole rooftop leans a little toward the pointer ---- */
    if (leanRef.current) {
      const k = Math.min(1, dt * 2.5);
      leanRef.current.rotation.x = lerp(leanRef.current.rotation.x, state.pointer.y * 0.04, k);
      leanRef.current.rotation.y = lerp(leanRef.current.rotation.y, state.pointer.x * 0.06, k);
    }

    /* ---- drive the lit head from the trace, the mercy, or the phase ---- */
    let head = headRef.current;
    let idle = 0;
    let hint = 0;
    let hintPos = 0;
    let blaze = 0;
    let hoistTarget = 0;
    let lampWant: number; // every phase branch below sets it (the else covers "opening")

    if (phase === "preview") {
      // the sealed sign, gently alive: a couple of strokes buzz as if the power is
      // teasing on, and a bead drifts the dead tube — inviting, but no reveal
      head = 0;
      idle = 0.16;
      hint = 0.45;
      hintPos = (e * 0.08) % 1;
      lampWant = 1;
      hoistTarget = 0;
    } else if (phase === "sealed") {
      head = 0;
      hint = 0.6;
      hintPos = (e * HINT_ORDER_RATE) % 1; // "trace me" sweeps end to end
      lampWant = 1;
      hoistTarget = 0;
      // the loose wire ticks over now and then while it waits
      if (sign && e - lastSealedSparkRef.current > SEALED_SPARK) {
        lastSealedSparkRef.current = e;
        emitSparks(e, 5);
      }
    } else if (phase === "revealed") {
      // the finished tableau from `phase` alone — reduced motion lands here cold
      head = 1;
      hoistTarget = 1;
      lampWant = 0.15;
    } else {
      // opening
      const tr = traceRef.current;
      const mercy = smooth(clamp01((t - T_MERCY0) / MERCY_RAMP));
      const cap = Math.max(tr.reach, mercy);
      // the head chases the cap at a bounded rate, so the light trails the fingertip
      head = Math.min(cap, head + FILL_RATE * dt);
      headRef.current = head;
      // the hint bead fades the instant they start wiring
      hint = clamp01(1 - head * 10) * 0.55;
      hintPos = (e * HINT_ORDER_RATE) % 1;
      lampWant = lerp(1, 0.2, clamp01(head)); // the work lamp yields to the gas
      // the loose wire throws its one spark as the head passes it
      if (sign && !sparkedRef.current && head >= sign.sparkAt) {
        sparkedRef.current = true;
        emitSparks(e, 12);
      }
      // the last stroke snaps on → the sign over-drives, then settles and hoists
      if (head >= 0.999) {
        if (finaleAtRef.current < 0) finaleAtRef.current = t;
        const ft = t - finaleAtRef.current;
        blaze = Math.max(0, 0.9 * Math.exp(-ft * 3.2)) + 0.06 * Math.exp(-ft * 0.6);
        hoistTarget = 1;
        lampWant = 0.15;
      }
    }
    if (phase !== "opening") headRef.current = head;

    /* ---- hoist: only "opening" animates it; every other phase snaps (cold draw) ---- */
    if (phase === "opening") {
      hoistRef.current = lerp(hoistRef.current, hoistTarget, Math.min(1, dt * 2.4));
    } else {
      hoistRef.current = hoistTarget;
    }
    const hoist = easeOutCubic(clamp01(hoistRef.current));
    if (signInnerRef.current) {
      // Hoist rise lives on the OUTER group below (world units). It used to sit here,
      // on the fit-scaled inner group, where a wide sign multiplied it by W≈2.7 and
      // launched the whole message off the top of the frame — leaving only its reflection.
      signInnerRef.current.position.set(0, 0, 0);
      signInnerRef.current.rotation.x = TILT_SEALED * (1 - hoist);
      const s = 1 + hoist * 0.03;
      signInnerRef.current.scale.set(s, s, s);
    }
    if (signOuterRef.current) signOuterRef.current.position.y = SIGN_CY + hoist * HOIST_DY;

    /* ---- push the neon uniforms ---- */
    const pushNeon = (m: THREE.ShaderMaterial | undefined, size: number, useHint: boolean, useIdle: boolean, useBlaze: boolean) => {
      if (!m) return;
      const u = m.uniforms as NeonUniforms;
      u.uHead.value = head;
      u.uIdle.value = useIdle ? idle : 0;
      u.uHint.value = useHint ? hint : 0;
      u.uHintPos.value = hintPos;
      u.uBlaze.value = useBlaze ? blaze : 0;
      u.uTime.value = e;
      u.uSize.value = size * W;
      u.uScale.value = uScale;
    };
    pushNeon(glowRef.current?.material as THREE.ShaderMaterial, SIZE_GLOW, true, true, true);
    pushNeon(coreRef.current?.material as THREE.ShaderMaterial, SIZE_CORE, false, true, true);
    // the wet reflection lights with the sign but carries no hint bead of its own
    pushNeon(reflectRef.current?.material as THREE.ShaderMaterial, SIZE_REFLECT, false, false, true);

    if (glassRef.current) {
      const gu = (glassRef.current.material as THREE.ShaderMaterial).uniforms;
      gu.uSize.value = SIZE_GLASS * W;
      gu.uScale.value = uScale;
    }
    if (reflectGroupRef.current) {
      // mirror across the sign's own bottom edge; wet nights show it, fog barely does
      reflectGroupRef.current.position.y = -aspect;
      reflectGroupRef.current.visible = night.reflect > 0.01 && head > 0.001;
    }
    if (reflectRef.current) {
      (reflectRef.current.material as THREE.ShaderMaterial).uniforms.uGain.value = 0.3 * night.reflect;
    }

    /* ---- the ambient wash a lit sign throws behind itself ---- */
    if (backglowRef.current) {
      const m = backglowRef.current.material as THREE.MeshBasicMaterial;
      m.opacity = head * 0.22 + blaze * 0.28;
      backglowRef.current.scale.set(W * 1.5, W * 1.5 * aspect + W * 0.4, 1);
    }

    /* ---- the maker's plate, fading in as the sign hoists ---- */
    if (plateGroupRef.current) plateGroupRef.current.visible = plate != null && hoist > 0.01;
    const plateA = plate ? hoist * hoist : 0;
    if (plateMatRef.current) plateMatRef.current.opacity = plateA * 0.72;
    if (plateTagRef.current) plateTagRef.current.opacity = plateA;

    /* ---- sparks off the loose wire ---- */
    const sp = sparkRef.current;
    if (sp) {
      const sk = sparks.current;
      const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      const cc = new THREE.Color(gas.core);
      for (let i = 0; i < SPARK_N; i++) {
        const a = e - sk.t0[i];
        if (a < 0 || a > SPARK_LIFE) {
          ca.setXYZ(i, 0, 0, 0);
          pa.setXYZ(i, 0, -999, 0);
          continue;
        }
        pa.setXYZ(i, sk.ox[i] + sk.vx[i] * a, sk.oy[i] + sk.vy[i] * a - 0.55 * a * a, 0.06);
        const k = 1 - a / SPARK_LIFE;
        ca.setXYZ(i, cc.r * k, cc.g * k, cc.b * k);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- the work lamp, raking the bench ---- */
    if (lampMatRef.current) lampMatRef.current.opacity = lerp(lampMatRef.current.opacity, lampWant * 0.85, Math.min(1, dt * 3));

    /* ---- the night ---- */
    if (bokehFarRef.current && bokehNearRef.current) {
      const f = bokehFarRef.current.geometry.attributes;
      driftBokeh(bokeh.far, dt, e, night.rain, f.position as THREE.BufferAttribute, f.color as THREE.BufferAttribute);
      const n = bokehNearRef.current.geometry.attributes;
      driftBokeh(bokeh.near, dt, e, night.rain, n.position as THREE.BufferAttribute, n.color as THREE.BufferAttribute);
    }
    if (starRef.current) {
      const u = (starRef.current.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = e;
      u.uAmt.value = night.stars;
    }
    if (rainRef.current) {
      (rainRef.current.material as THREE.ShaderMaterial).uniforms.uTime.value = e;
    }
    if (fogRef.current) {
      // slow fog banks drifting across; only present on a foggy night
      fogRef.current.visible = night.fog > 0.01;
      fogRef.current.children.forEach((child, i) => {
        child.position.x = ((e * 0.12 + i * 3.1) % 12) - 6;
      });
    }

    /* ---- completion, exactly once ---- */
    if (phase === "opening" && finaleAtRef.current >= 0 && t > finaleAtRef.current + FINALE_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const aspect = sign?.aspect ?? 1;

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0, CAM_Z]} fov={FOV} />

      <group ref={leanRef}>
        {/* the night sky, and the city out of focus below it */}
        <mesh position={[0, 0.6, -6]}>
          <planeGeometry args={[26, 16]} />
          <meshBasicMaterial map={sky} depthWrite={false} toneMapped={false} />
        </mesh>

        {night.fog > 0.01 && (
          <group ref={fogRef}>
            {[0, 1, 2, 3].map((i) => (
              <mesh key={i} position={[i * 3 - 4.5, -0.4 + (i % 2) * 0.7, -4.4]}>
                <planeGeometry args={[6, 3.4]} />
                <meshBasicMaterial
                  map={glowTex} color="#aeb8c6" transparent opacity={0.14 * night.fog}
                  depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
                />
              </mesh>
            ))}
          </group>
        )}

        <points ref={starRef} geometry={stars.geo} material={starMat} frustumCulled={false} />

        <points ref={bokehFarRef} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[bokeh.far.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[bokeh.far.col, 3]} />
          </bufferGeometry>
          <pointsMaterial
            map={glowTex} size={0.34} sizeAttenuation vertexColors transparent opacity={0.6}
            depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
          />
        </points>
        <points ref={bokehNearRef} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[bokeh.near.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[bokeh.near.col, 3]} />
          </bufferGeometry>
          <pointsMaterial
            map={glowTex} size={0.9} sizeAttenuation vertexColors transparent opacity={0.28}
            depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
          />
        </points>

        <lineSegments ref={rainRef} geometry={rain.geo} material={rainMat} frustumCulled={false} />

        {/* the rooftop workbench — a dark slab the dead tube rests on */}
        <mesh position={[0, -1.7, -0.4]} rotation={[-Math.PI / 2.4, 0, 0]}>
          <planeGeometry args={[9, 3]} />
          <meshBasicMaterial color="#0a0d14" transparent opacity={0.85} depthWrite={false} />
        </mesh>
        {/* the one work lamp, warm, off to the side */}
        <sprite ref={lampRef} position={[-1.9, -0.7, 0.4]} scale={2.6}>
          <spriteMaterial
            ref={lampMatRef} map={glowTex} color={gas.lamp} transparent opacity={0}
            depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
          />
        </sprite>

        {/* the sign: outer group carries the fitted world scale, inner does hoist+tilt */}
        <group ref={signOuterRef} position={[0, SIGN_CY, 0]}>
          <group ref={signInnerRef} rotation={[TILT_SEALED, 0, 0]}>
            {/* the ambient wash behind the tubes */}
            <mesh ref={backglowRef} position={[0, 0, -0.06]} scale={[1, 1, 1]}>
              <planeGeometry args={[1, 1]} />
              <primitive object={mats.backglow} attach="material" />
            </mesh>

            {sign && (
              <>
                {/* the dead glass — always visible, the physical tube */}
                <points ref={glassRef} geometry={sign.geo} material={mats.glass} renderOrder={1} frustumCulled={false} />
                {/* the gas: a snug soft glow, then a tight hot filament down its spine */}
                <points ref={glowRef} geometry={sign.geo} material={mats.glow} renderOrder={2} frustumCulled={false} />
                <points ref={coreRef} geometry={sign.geo} material={mats.core} renderOrder={3} frustumCulled={false} />

                {/* the wet reflection on the rooftop, mirrored across the sign's foot */}
                <group ref={reflectGroupRef} scale={[1, -1, 1]}>
                  <points ref={reflectRef} geometry={sign.geo} material={mats.reflect} renderOrder={0} frustumCulled={false} />
                </group>

                {/* sparks off the loose wire */}
                <points ref={sparkRef} renderOrder={4} frustumCulled={false}>
                  <bufferGeometry>
                    <bufferAttribute attach="attributes-position" args={[sparkBuf.pos, 3]} />
                    <bufferAttribute attach="attributes-color" args={[sparkBuf.col, 3]} />
                  </bufferGeometry>
                  <pointsMaterial
                    map={glowTex} size={0.05} sizeAttenuation vertexColors transparent
                    depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
                  />
                </points>
              </>
            )}

            {/* the maker's plate, hung below the words */}
            {plate && (
              <group ref={plateGroupRef} position={[0, -aspect / 2 - 0.16, 0.02]} visible={false}>
                <mesh>
                  <planeGeometry args={[0.5, 0.5 * plate.aspect + 0.06]} />
                  <meshBasicMaterial ref={plateMatRef} color="#1a140c" transparent opacity={0} depthWrite={false} />
                </mesh>
                <mesh position={[0, 0, 0.001]}>
                  <planeGeometry args={[0.46, 0.46 * plate.aspect]} />
                  <meshBasicMaterial
                    ref={plateTagRef} map={plate.texture} transparent opacity={0}
                    depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
                  />
                </mesh>
              </group>
            )}

            {/* the trace target — only live while it is wanted (see magic-lamp) */}
            {phase === "opening" && sign && (
              <mesh
                ref={hitRef}
                position={[0, 0, 0.2]}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={stop}
                onPointerCancel={stop}
                onPointerOut={stop}
              >
                <planeGeometry args={[1.25, aspect * 1.25 + 0.3]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            )}
          </group>
        </group>
      </group>
    </>
  );
}
