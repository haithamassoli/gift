import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, sampleTextPoints } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- palettes ---------- */
// The metal has to change the *material*, not a tint: brass is warm and rough,
// aged silver is cool and tarnished, obsidian is volcanic glass — a dielectric
// with a hard specular, so it barely counts as metal at all.
interface Metal {
  body: string;
  trim: string;
  rough: number;
  metalness: number;
  env: number;
  heat: string; // the colour the lamp takes as it is buffed
  hot: string; // and where that colour goes at full heat
  rim: string;
  engrave: string;
  peak: number;
}
const METALS: Record<string, Metal> = {
  brass: {
    body: "#c08a2e", trim: "#7a5418", rough: 0.42, metalness: 0.98, env: 1.15,
    heat: "#ff7a18", hot: "#ffe6b4", rim: "#3f6f8a", engrave: "#ffc861", peak: 1.15,
  },
  "aged-silver": {
    body: "#9aa3a8", trim: "#454e55", rough: 0.72, metalness: 0.9, env: 0.85,
    heat: "#9fd8ff", hot: "#eaf6ff", rim: "#6a7fb0", engrave: "#dcefff", peak: 1.0,
  },
  obsidian: {
    body: "#15111c", trim: "#08060e", rough: 0.12, metalness: 0.2, env: 1.6,
    // peak is emissive gain, and a near-black body wants the *least* of it, not the
    // most: emissive is added light, so brass buries a warm one under its own lit
    // colour while here it simply becomes the colour. At 1.7 — the highest of the
    // three — the glass measured rgb(107,83,110) at rest against rgb(72,63,47) of
    // bare material: lavender plastic. Kept subordinate, the ember reads as heat
    // trapped in the glass and the hard specular stays the thing you see.
    heat: "#a24cff", hot: "#f2d8ff", rim: "#7b4fd0", engrave: "#c79bff", peak: 0.14,
  },
};

interface Smoke {
  core: string;
  edge: string;
  light: string;
}
const SMOKES: Record<string, Smoke> = {
  turquoise: { core: "#d6fff8", edge: "#1d7f92", light: "#3fe0d0" },
  rose: { core: "#ffe2ec", edge: "#9c3a5e", light: "#ff6f9c" },
  "gold-dust": { core: "#fff5cf", edge: "#9d6a14", light: "#ffc23d" },
};

/* ---------- stage layout (tilt space) ---------- */
const FOV = 40;
const CAM_Z = 4.7;
const LAMP_X = 0.34;
const LAMP_Y = -1.22;
const BELLY_R = 0.662;
const BELLY_Y = 0.28;
const CUSH_X = 0.3;
const CUSH_Y = -1.4;
const SPOUT = new THREE.Vector3(LAMP_X - 1.33, LAMP_Y + 0.58, 0);
const SPOUT_DIR = new THREE.Vector3(-0.35, 0.94, 0);
const TEXT_CY = 0.76;
const TEXT_W = 2.5;
const TEXT_H = 1.46;
const ACTION_W = 2.8; // spout mouth → cushion edge, and the words above them
const HIT_X = 0.08;
const HIT_Y = -0.84;

/* ---------- the back of the stall ---------- */
// Sized, not eyeballed. The canvas is not the window and it jumps to aspect 2.53 the
// instant the reveal mounts the message under it; the old 14u wall was 0.58u short of
// covering that and left bare page down both sides, hidden only by the luck of the
// wall's near-black matching the page's.
const WALL_Z = -3.2;
const WALL_H = 2 * (CAM_Z - WALL_Z) * Math.tan((FOV * Math.PI) / 360); // 5.75 at the wall's depth
const WALL_W = WALL_H * 2.6; // 14.95 — past the 2.53 of the widest canvas, with the lean to spare

/* ---------- opening timeline (seconds) ---------- */
const T_MERCY0 = 2.6; // the lamp starts warming on its own…
const T_MERCY1 = 5.8; // …and exhales here even if no one ever touched it
// A gift may never outlast 12s with nobody touching it, and the bound is on the whole
// show, not on the grant — so the grant plus TAU_HOLD is the budget: 5.8 + 4.8 = 10.6.
// The rest of the 12 is deliberate slack: `dt` is clamped to 0.05, so on a phone that
// drops frames this clock runs *behind* the wall clock the bound is actually measured on.
const TAU_HOLD = 4.8; // reveal clock pins here: the last glyph forms at τ 4.55 and settles
const WISP_LIFE = 4.6;
const RUB_TARGET = 5.6; // ~4-5 full passes across the belly
const HEAT_REST = 0.45; // what the metal settles back to once the smoke is out
const PREV_LEAD = 2.0;
const PREV_PERIOD = 13.0;

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();
const smokeTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.85)"],
  [0.45, "rgba(255,255,255,0.32)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- the stall, as something for the metal to reflect ---------- */
// A metal with nothing around it renders black: direct lights only give it
// specular dots. three PMREMs any equirect handed to `envMap`, so 20 lines of
// canvas is the difference between brass and dark grey plastic.
function buildEnvTexture(): THREE.Texture {
  const W = 256, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#4a3520"); // canvas awning, warmed through
  sky.addColorStop(0.44, "#181113");
  sky.addColorStop(0.66, "#0a0709");
  sky.addColorStop(1, "#050407"); // packed dirt
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(60, 22, 54, "#fff2d2"); // the gap the shaft falls through
  blob(196, 62, 42, "#41546e"); // cold daylight at the stall's mouth
  for (let i = 0; i < 5; i++) blob(30 + i * 52, 46 + (i % 2) * 10, 9, "#ffbe63"); // lanterns
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const envTex = buildEnvTexture();

/* ---------- wear ---------- */
// One map, two channels. Tarnish is an oxide — it has to make the surface
// rougher *and* less metallic at once, which a single grey channel cannot say,
// so green scales roughness and blue scales metalness in opposite directions.
function buildWearTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(8123);
  for (let i = 0; i < 80; i++) {
    const x = rand() * S, y = rand() * S, r = 5 + rand() * 20, a = 0.1 + rand() * 0.35;
    // redraw the blobs that touch an edge on the far side, so the tile is seamless
    for (const dx of x < r ? [0, S] : x > S - r ? [0, -S] : [0])
      for (const dy of y < r ? [0, S] : y > S - r ? [0, -S] : [0]) {
        const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        gr.addColorStop(0, `rgba(255,255,255,${a})`);
        gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr;
        g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
  }
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const w = d[i] / 255;
    d[i] = 255;
    d[i + 1] = Math.round(255 * (0.45 + 0.55 * w));
    d[i + 2] = Math.round(255 * (1 - 0.5 * w));
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}
const wearTex = buildWearTexture();

/* ---------- the one warm shaft ---------- */
// |dot(N,V)| baked into a texture: the cone's wall goes transparent exactly
// where it turns edge-on, which is what makes a hard cylinder read as volume.
// The camera never orbits, so the silhouette sits at fixed u and this is free.
function buildShaftTexture(): THREE.CanvasTexture {
  const W = 96, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = 1 - y / (H - 1); // flipY: canvas row 0 is v = 1, the source end
    const fall = smooth(clamp01(v / 0.3)) * (0.45 + 0.55 * v);
    for (let x = 0; x < W; x++) {
      const face = Math.pow(Math.abs(Math.cos((x / W) * Math.PI * 2)), 2.4);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * face * fall);
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
const shaftTex = buildShaftTexture();

/* ---------- the cushion it sits on ---------- */
function buildCushionTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4a1020"; // madder ground
  g.fillRect(0, 0, S, S);
  g.strokeStyle = "#b8912f"; // gold thread
  g.lineWidth = 1.5;
  // the eight-point star: two squares, one turned 45° — the workhorse of the craft
  for (let gy = 0; gy < 2; gy++)
    for (let gx = 0; gx < 2; gx++) {
      const cx = (gx + 0.5) * (S / 2), cy = (gy + 0.5) * (S / 2);
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        for (let i = 0; i <= 4; i++) {
          const a = (k * Math.PI) / 4 + (i * Math.PI) / 2;
          const px = cx + Math.cos(a) * S * 0.17, py = cy + Math.sin(a) * S * 0.17;
          if (i) g.lineTo(px, py);
          else g.moveTo(px, py);
        }
        g.stroke();
      }
    }
  g.strokeStyle = "rgba(184,145,47,0.4)"; // the lattice tying the stars together
  g.beginPath();
  for (let i = 0; i <= 4; i++) {
    g.moveTo(0, (i * S) / 4);
    g.lineTo(S, (i * S) / 4);
    g.moveTo((i * S) / 4, 0);
    g.lineTo((i * S) / 4, S);
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const cushionTex = buildCushionTexture();

function buildWallTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#08060a";
  g.fillRect(0, 0, 64, 64);
  const gr = g.createRadialGradient(20, 14, 2, 20, 14, 54);
  gr.addColorStop(0, "#3b2a1c");
  gr.addColorStop(0.5, "#170f10");
  gr.addColorStop(1, "#06050a");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const wallTex = buildWallTexture();

/* ---------- the lamp ---------- */
// Wide, low and oval — the 1001 Nights silhouette. The belly carries a
// near-cylindrical band so the engraving has something flush to sit in.
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
const BODY_PROFILE = [
  V2(0.0, 0.0), V2(0.24, 0.0), V2(0.3, 0.012), V2(0.285, 0.034), // turned foot ring
  V2(0.4, 0.056), V2(0.52, 0.092), V2(0.6, 0.136), V2(0.64, 0.18),
  V2(0.658, 0.222), V2(0.662, 0.252), V2(0.662, 0.312), V2(0.656, 0.348), // the engraving band
  V2(0.64, 0.382), V2(0.596, 0.432), V2(0.52, 0.482), V2(0.43, 0.522),
  V2(0.348, 0.55), V2(0.302, 0.564), V2(0.318, 0.578), // collar lip, to catch the key
  V2(0.292, 0.592), V2(0.268, 0.602), V2(0.256, 0.628), // lid seam
  V2(0.212, 0.664), V2(0.142, 0.698), V2(0.072, 0.72), V2(0.03, 0.729), V2(0.0, 0.732),
];
const bodyGeo = new THREE.LatheGeometry(BODY_PROFILE, 56);

// A real spout narrows to its mouth and flares at the lip; TubeGeometry only
// sweeps a constant radius, so push every ring in or out from its spine point.
function buildSpoutGeo(): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.46, 0.2, 0),
    new THREE.Vector3(-0.94, 0.19, 0),
    new THREE.Vector3(-1.24, 0.34, 0),
    new THREE.Vector3(-1.33, 0.58, 0),
  ]);
  const SEG = 40, RAD = 14;
  // radius 1 so every vertex sits exactly one unit off the spine, ready to scale
  const g = new THREE.TubeGeometry(curve, SEG, 1, RAD, false);
  const p = g.attributes.position;
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG;
    const r = 0.155 * Math.pow(1 - u, 0.8) + 0.048 + 0.03 * smooth(clamp01((u - 0.9) / 0.1));
    curve.getPointAt(u, c); // TubeGeometry rings are arc-length placed; match it
    for (let j = 0; j <= RAD; j++) {
      const k = i * (RAD + 1) + j;
      v.fromBufferAttribute(p, k).sub(c).multiplyScalar(r).add(c);
      p.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}
const spoutGeo = buildSpoutGeo();

const handleGeo = new THREE.TorusGeometry(0.24, 0.045, 10, 32, 4.6);
const finialGeo = new THREE.SphereGeometry(0.042, 12, 10);
const collarGeo = new THREE.TorusGeometry(0.052, 0.012, 6, 20);

// A box pushed into a pillow: the seam pinches the rim shut, the stuffing bulges
// the middle.
function buildCushionGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 16, 5, 12);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const u = v.x * 2, w = v.z * 2, h = v.y * 2;
    const puff = Math.pow(Math.max(0, Math.cos(u * 1.5708) * Math.cos(w * 1.5708)), 0.5);
    const bow = 1 + 0.09 * (1 - h * h);
    p.setXYZ(i, v.x * bow, v.y * (0.22 + 0.78 * puff), v.z * bow);
  }
  g.computeVertexNormals();
  return g;
}
const cushionGeo = buildCushionGeo();

const tasselHeadGeo = new THREE.SphereGeometry(0.038, 10, 8);
// a cone is already apex-up: tied at the top, flaring where it hangs
const tasselSkirtGeo = new THREE.ConeGeometry(0.045, 0.12, 10);
const tasselMat = new THREE.MeshStandardMaterial({
  color: "#b8912f", roughness: 0.6, metalness: 0.35, envMap: envTex,
});

/* ---------- dust hanging in the shaft ---------- */
const MOTE_N = 80;
const SHAFT_H = 4.6, SHAFT_RT = 0.14, SHAFT_RB = 0.95;
function buildMotes() {
  const rand = mulberry32(5150);
  const u = new Float32Array(MOTE_N);
  const th = new Float32Array(MOTE_N);
  const v0 = new Float32Array(MOTE_N);
  const sp = new Float32Array(MOTE_N);
  const ph = new Float32Array(MOTE_N);
  for (let i = 0; i < MOTE_N; i++) {
    u[i] = Math.sqrt(rand()); // uniform over the disc
    th[i] = rand() * Math.PI * 2;
    v0[i] = rand();
    sp[i] = 0.012 + rand() * 0.022; // dust hangs more than it falls
    ph[i] = rand() * Math.PI * 2;
  }
  return { u, th, v0, sp, ph, pos: new Float32Array(MOTE_N * 3), col: new Float32Array(MOTE_N * 3) };
}
const MOTES = buildMotes();

/* ---------- sparks shed off the buffed metal ---------- */
const SPARK_N = 44;
const SPARK_LIFE = 0.75;

/* ---------- the smoke ---------- */
// The whole sim lives in the vertex shader. Two clocks in, ~800 particles out,
// nothing per-frame on the CPU — and because every position is a closed form of
// the reveal clock, a replay is identical to the first run for free.
const WISP_N = 200;
// Dense enough that the glyphs hold together once condensed — sparse points at a
// readable size just merge into a smudge. They shrink hard on forming, so the
// extra ones cost almost no fill.
const TEXT_MAX = 820;

const SMOKE_VERT = `
#define WISP_LIFE ${WISP_LIFE.toFixed(2)}
attribute vec4 aRnd;
attribute vec3 aTiming;   // birth delay, form start, form duration
attribute vec2 aKind;     // x: 1 = becomes a glyph, 0 = free wisp | y: puff size in world units
uniform float uTau;       // reveal clock; < 0 before the lamp exhales
uniform float uWisp;      // always-advancing clock the wisps recycle on
uniform float uTime;
uniform float uTextA;
uniform float uWispA;
uniform float uFade;      // how far a wisp gets before it dies: a curl at rest, a column once lit
uniform float uScale;
uniform float uLean;
uniform vec3 uSpout;
uniform vec3 uDir;
varying float vA;
varying float vD;

// Curl of a trig vector potential. Divergence-free by construction, which is
// why it folds and churns instead of just thinning out like plain noise.
vec3 curl(vec3 p) {
  vec3 s = sin(p), c = cos(p);
  return vec3(
    -s.x * s.y - c.z * c.x,
    -s.y * s.z - c.x * c.y,
    -s.z * s.x - c.y * c.z
  );
}

void main() {
  float isText = aKind.x;
  // wisps loop forever so the spout never stops breathing; glyph particles ride
  // the one-shot reveal clock and stay parked until it starts.
  float age = mix(mod(uWisp - aTiming.x, WISP_LIFE), uTau - aTiming.x, isText);
  if (age < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    gl_PointSize = 0.0;
    return;
  }

  // the jet out of the spout, killed by drag within a few tenths
  vec3 p = uSpout + uDir * ((0.42 + aRnd.x * 0.38) * 0.34 * (1.0 - exp(-age / 0.34)));
  // buoyancy against drag: hot gas climbs, cools, and stalls into a layer —
  // which is exactly the height the words want to hang at
  p.y += 1.25 * (1.0 - exp(-age / 1.25));
  // the exhale leaves the spout spinning
  float th = aRnd.y * 6.2832 + age * (1.5 + aRnd.z);
  float rad = 0.05 + age * (0.09 + aRnd.w * 0.13);
  p.x += cos(th) * rad;
  p.z += sin(th) * rad * 0.55;
  // and the column leans across toward the words as it climbs
  p.x += uLean * smoothstep(0.0, 2.4, age);

  vec3 q = p * 1.25 + vec3(aRnd.x * 12.0, -uTime * 0.14, aRnd.y * 9.0);
  p += curl(q) * (0.07 + age * 0.13);
  p += curl(q * 2.7 + 3.1) * (0.02 + age * 0.05);

  // condense: the pour path is still climbing when the glyph calls, so the
  // particle arcs into place instead of sliding
  float f = smoothstep(0.0, 1.0, clamp((uTau - aTiming.y) / aTiming.z, 0.0, 1.0)) * isText;
  vec3 tgt = position + curl(position * 2.4 + vec3(uTime * 0.2, uTime * 0.15, aRnd.z * 7.0)) * 0.03;
  p = mix(p, tgt, f);

  float fadeIn = smoothstep(0.0, 0.3, age);
  float wispOut = 1.0 - smoothstep(uFade * 0.42, uFade, age);
  vA = fadeIn * mix(wispOut * uWispA, uTextA * (0.3 + 0.42 * f), isText);
  vD = 0.25 * fadeIn + 0.75 * f; // denser once gathered, so the words are the brightest smoke

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // puffs expand as they rise and tighten as they condense, so the letters read
  gl_PointSize = min(
    aKind.y * mix(1.0 + min(age, 1.8) * 0.28, 0.52, f) * uScale / max(-mv.z, 0.1),
    72.0
  );
}
`;

const SMOKE_FRAG = `
uniform sampler2D uTex;
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uGain;
varying float vA;
varying float vD;
void main() {
  float m = texture2D(uTex, gl_PointCoord).a;
  gl_FragColor = vec4(mix(uEdge, uCore, vD) * uGain, m * vA);
}
`;

function buildSmoke(textSource: string, lang: Lang) {
  const tp = sampleTextPoints(textSource, {
    maxPoints: TEXT_MAX, fontSize: 84, fontWeight: "800", maxWidthPx: 760, seed: 17, lang,
  });
  // 0 if the raster came back blank; the whole system then falls back to wisps
  const nText = tp.count;
  const n = nText + WISP_N;
  const rand = mulberry32(20260714);
  const pos = new Float32Array(n * 3);
  const rnd = new Float32Array(n * 4);
  const tim = new Float32Array(n * 3);
  const knd = new Float32Array(n * 2);

  // a long message wraps tall, so trade width for height rather than overflow
  let w = TEXT_W;
  if (tp.aspect * w > TEXT_H) w = TEXT_H / tp.aspect;

  for (let i = 0; i < n; i++) {
    rnd[i * 4] = rand();
    rnd[i * 4 + 1] = rand();
    rnd[i * 4 + 2] = rand();
    rnd[i * 4 + 3] = rand();
    if (i < nText) {
      pos[i * 3] = tp.points[i * 2] * w;
      pos[i * 3 + 1] = TEXT_CY + tp.points[i * 2 + 1] * w;
      pos[i * 3 + 2] = (rand() - 0.5) * 0.07;
      const delay = rand() * 1.1;
      tim[i * 3] = delay;
      tim[i * 3 + 1] = delay + 1.25 + rand() * 0.8; // pours ≥1.25s before a glyph calls it
      tim[i * 3 + 2] = 0.9 + rand() * 0.5; // …so the last one lands at τ 4.55, inside TAU_HOLD
      knd[i * 2] = 1;
      knd[i * 2 + 1] = 0.085 + rand() * 0.05;
    } else {
      tim[i * 3] = rand() * WISP_LIFE; // evenly phased, so the plume is continuous
      tim[i * 3 + 1] = 0;
      tim[i * 3 + 2] = 1;
      knd[i * 2] = 0;
      knd[i * 2 + 1] = 0.14 + rand() * 0.11; // fatter, softer puffs than the glyph points
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  geo.setAttribute("aTiming", new THREE.BufferAttribute(tim, 3));
  geo.setAttribute("aKind", new THREE.BufferAttribute(knd, 2));
  return geo;
}

const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();

export default function MagicLampScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const metal = METALS[variants.metal] ?? METALS.brass;
  const smokePal = SMOKES[variants.smoke] ?? SMOKES.turquoise;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" in preview: rasterizing that spells nothing and the gallery
  // card gets an empty plume, so fall back to the shared "For you" copy.
  const textSource = message.trim() || forRecipient(lang, recipientName);
  const smokeGeo = useMemo(() => buildSmoke(textSource, lang), [textSource, lang]);
  useEffect(() => () => smokeGeo.dispose(), [smokeGeo]);

  const smokeMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTau: { value: -1 }, uWisp: { value: 0 }, uTime: { value: 0 },
          uTextA: { value: 0 }, uWispA: { value: 0 }, uFade: { value: 1.35 },
          uScale: { value: 600 }, uLean: { value: -SPOUT.x },
          uSpout: { value: SPOUT.clone() }, uDir: { value: SPOUT_DIR.clone() },
          // additive: ~800 overlapping puffs sum fast, so the gain stays under 1
          uTex: { value: smokeTex }, uGain: { value: 0.62 },
          uCore: { value: new THREE.Color(smokePal.core) },
          uEdge: { value: new THREE.Color(smokePal.edge) },
        },
        vertexShader: SMOKE_VERT,
        fragmentShader: SMOKE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [smokePal],
  );
  useEffect(() => () => smokeMat.dispose(), [smokeMat]);

  const mats = useMemo(() => {
    const mk = (color: string, rough: number) =>
      new THREE.MeshStandardMaterial({
        color, roughness: rough, metalness: metal.metalness,
        roughnessMap: wearTex, metalnessMap: wearTex, // green scales one, blue the other
        envMap: envTex, envMapIntensity: metal.env,
        emissive: new THREE.Color(metal.heat), emissiveIntensity: 0,
      });
    return {
      body: mk(metal.body, metal.rough),
      trim: mk(metal.trim, Math.min(1, metal.rough * 1.3)),
      heatC: new THREE.Color(metal.heat),
      hotC: new THREE.Color(metal.hot),
    };
  }, [metal]);
  useEffect(() => () => { mats.body.dispose(); mats.trim.dispose(); }, [mats]);

  // Names engraved round the belly. The band widens to fit rather than squashing
  // the letters, so long names simply wrap further round the lamp.
  const engrave = useMemo(() => {
    const names = [recipientName.trim(), senderName.trim()].filter(Boolean).join("  ·  ");
    if (!names) return null;
    const { texture, aspect } = makeTextTexture(names, {
      fontSize: 64, fontWeight: "600", color: "#ffffff", maxWidthPx: 2400, padding: 26, lang,
    });
    const R = BELLY_R + 0.006;
    let theta = 0.185 / (aspect * R);
    let h = 0.185;
    if (theta > 2.3) theta = 2.3;
    else if (theta < 0.8) theta = 0.8;
    else return { texture, theta, h, R };
    h = theta * aspect * R;
    return { texture, theta, h, R };
  }, [recipientName, senderName, lang]);
  useEffect(() => () => engrave?.texture.dispose(), [engrave]);

  // Buffers feed <bufferAttribute> and are only ever written through the points
  // ref in useFrame; the spark sim itself is mutable state, so it lives in a ref.
  const sparkBuf = useMemo(
    () => ({
      pos: new Float32Array(SPARK_N * 3),
      col: new Float32Array(SPARK_N * 3),
    }),
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

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const lampRef = useRef<THREE.Group>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  // Materials are reached through the objects that carry them, never through the
  // memo binding: the memo owns construction and disposal, the frame owns state.
  const bodyMeshRef = useRef<THREE.Mesh>(null);
  const trimMeshRef = useRef<THREE.Mesh>(null);
  const smokePtsRef = useRef<THREE.Points>(null);
  const bellyRef = useRef<THREE.Sprite>(null);
  const bellyMatRef = useRef<THREE.SpriteMaterial>(null);
  const flareRef = useRef<THREE.Sprite>(null);
  const flareMatRef = useRef<THREE.SpriteMaterial>(null);
  const hintRef = useRef<THREE.Sprite>(null);
  const hintMatRef = useRef<THREE.SpriteMaterial>(null);
  const engMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const heatLightRef = useRef<THREE.PointLight>(null);
  const smokeLightRef = useRef<THREE.PointLight>(null);
  const motesRef = useRef<THREE.Points>(null);
  const moteMatRef = useRef<THREE.PointsMaterial>(null);
  const sparkRef = useRef<THREE.Points>(null);

  const ignRef = useRef(-1);
  const rub = useRef({
    on: false,
    seeded: false,
    acc: 0,
    buff: 0,
    dir: 0,
    run: 0,
    idle: 0,
    alone: 0, // how long the lamp has been left to itself — the mercy's own clock
    emit: 0,
    px: 0,
    py: 0,
    hx: LAMP_X,
    hy: LAMP_Y + BELLY_Y,
  });

  // Replay re-enters "opening": the clock resets, so the rub has to as well or
  // the second run would ignite instantly.
  useLayoutEffect(() => {
    const r = rub.current;
    r.on = r.seeded = false;
    r.acc = r.buff = r.dir = r.run = r.idle = r.alone = r.emit = 0;
    ignRef.current = -1;
    sparks.current.t0.fill(-99);
  }, [phase]);

  /* ---------- the rub ---------- */
  const stop = () => {
    rub.current.on = false;
    rub.current.seeded = false;
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    // Capture so the release always lands here even if the finger wanders off
    // the lamp; without it the rub would latch on forever.
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — the pointer-out fallback below covers its absence */
    }
    const r = rub.current;
    r.on = true;
    r.seeded = false;
    r.dir = 0;
    r.run = 0;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const hit = hitRef.current;
    const r = rub.current;
    if (!hit || !r.on || phase !== "opening" || ignRef.current >= 0) return;
    hit.worldToLocal(tmpV.copy(ev.point));
    const x = tmpV.x + HIT_X;
    const y = tmpV.y + HIT_Y;
    if (r.seeded) {
      const dx = x - r.px;
      const dy = y - r.py;
      // A rub is lateral — buffing across the belly, not flailing up and down.
      const d = Math.hypot(dx, dy * 0.45);
      // A captured pointer freezes at its last hit and jumps on re-entry.
      if (d < 0.5) {
        r.acc += d;
        r.run += Math.abs(dx);
        const s = Math.sign(dx);
        if (s !== 0 && r.dir !== 0 && s !== r.dir && r.run > 0.22) {
          r.buff = 1; // a pass completed — the metal flares
          r.emit = 4;
          r.run = 0;
        }
        if (s !== 0 && Math.abs(dx) > 0.004) r.dir = s;
        r.hx = x;
        r.hy = y;
        r.idle = 0;
      }
    } else {
      r.seeded = true;
      r.hx = x;
      r.hy = y;
    }
    r.px = x;
    r.py = y;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const r = rub.current;

    /* fit the action span into narrow (portrait) viewports */
    const fit = Math.max(0.68, Math.min(1, state.viewport.width / ACTION_W));
    fitRef.current?.scale.setScalar(fit);

    /* whole stall leans toward the pointer */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(
        tiltRef.current.rotation.x,
        state.pointer.y * 0.06,
        k,
      );
      tiltRef.current.rotation.y = lerp(
        tiltRef.current.rotation.y,
        state.pointer.x * 0.08,
        k,
      );
    }

    /* ---- heat: what the rub buys, what patience buys ---- */
    r.idle += dt;
    // The mercy is the no-input path's and only its, so it runs on its own clock: one
    // that stops while a hand is actually working the belly, and starts again the
    // moment that hand goes still. A palm resting on the lamp is not a rub — if it
    // counted, a lamp nobody moved would never light at all.
    if (phase === "opening" && !(r.on && r.idle < 0.5)) r.alone += dt;
    r.buff = Math.max(0, r.buff - dt * 3.2);
    // brass cools when you stop — gently, so it reads as metal and not a penalty
    if (r.idle > 0.35 && ignRef.current < 0)
      r.acc = Math.max(0, r.acc - dt * 0.42);
    if (r.emit > 0) {
      const sk = sparks.current;
      for (let k = 0; k < r.emit; k++) {
        const i = sk.cursor;
        sk.cursor = (i + 1) % SPARK_N;
        const a = Math.random() * Math.PI * 2;
        sk.t0[i] = e;
        sk.ox[i] = r.hx + Math.cos(a) * 0.05;
        sk.oy[i] = r.hy + Math.sin(a) * 0.05;
        sk.vx[i] = Math.cos(a) * 0.35 + (Math.random() - 0.5) * 0.3;
        sk.vy[i] = 0.35 + Math.random() * 0.55;
      }
      r.emit = 0;
    }

    let heat: number;
    let tau: number; // reveal clock: < 0 until the lamp exhales
    let textA: number;
    let hint = 0;
    // Once it has given the smoke up the metal cools back to an ember: held at
    // full heat the brass just blows out to white and stops being brass. Lands
    // exactly on REST at TAU_HOLD, so the flip to "revealed" is seamless.
    const cooled = (x: number) => lerp(1, HEAT_REST, smooth(clamp01((x - 0.4) / 2.4)));
    if (phase === "opening") {
      // eased in from 3.0s of being left alone, full at 6.9s: the lamp warming to the
      // idea itself, not a timer going off. Whoever rubs never sees it.
      const mercy = smooth(clamp01((r.alone - T_MERCY0) / (T_MERCY1 - T_MERCY0)));
      const raw = Math.max(clamp01(r.acc / RUB_TARGET), mercy);
      if (raw >= 1 && ignRef.current < 0) ignRef.current = t;
      tau = ignRef.current >= 0 ? Math.min(t - ignRef.current, TAU_HOLD) : -1;
      heat = ignRef.current >= 0 ? cooled(tau) : raw;
      textA = 1;
      if (ignRef.current < 0)
        hint = clamp01((t - 0.9) / 0.7) * (1 - clamp01(r.acc / 0.5));
    } else if (phase === "revealed") {
      // A complete tableau from `phase` alone — reduced motion lands here cold.
      heat = HEAT_REST;
      tau = TAU_HOLD;
      textA = 1;
    } else if (phase === "preview") {
      // the whole gift on a loop: charge, exhale, write, fade, charge
      const cyc = e % PREV_PERIOD;
      tau = cyc - PREV_LEAD;
      const out = smooth(clamp01((tau - 9) / 2));
      heat = tau < 0 ? clamp01(cyc / PREV_LEAD) : cooled(tau) * (1 - out);
      textA = clamp01(tau * 3) * (1 - smooth(clamp01((tau - 9) / 1.5)));
    } else {
      heat = 0.06 + 0.05 * Math.sin(e * 1.3); // sealed: something breathes in there
      tau = -1;
      textA = 0;
    }

    const lit = tau >= 0;
    const shud = lit ? Math.exp(-tau * 5.5) : 0; // the exhale's recoil
    const hop = lit && tau < 0.34 ? Math.sin((tau / 0.34) * Math.PI) * 0.05 : 0;
    const flash = lit ? Math.exp(-tau * 4) : 0;
    const exh = lit ? smooth(clamp01(tau / 0.55)) : 0;
    const glow = clamp01(heat * 0.8 + r.buff * 0.32) + flash * 0.9;

    /* ---- the lamp ---- */
    const lamp = lampRef.current;
    if (lamp) {
      lamp.rotation.z =
        0.012 * Math.sin(e * 0.7) +
        heat * 0.01 * Math.sin(e * 32) +
        shud * 0.06 * Math.sin(tau * 62);
      lamp.position.set(LAMP_X, LAMP_Y + 0.006 * Math.sin(e * 1.1) + hop, 0);
    }
    tmpC.copy(mats.heatC).lerp(mats.hotC, clamp01(glow * 0.75));
    // Heat floods a near-black body the moment it is anywhere — obsidian goes violet
    // where brass hides the same value under its own colour — so it is kneed, and hold
    // the lamp cold until it is genuinely being heated. One knee, once: guarding only
    // the emissive was no guard at all, because the belly sprite and the violet lamp
    // 0.3u behind it rode the raw glow and obsidian came out lavender plastic anyway.
    // Every channel of the look rides this now.
    const hot = Math.pow(clamp01((glow - 0.12) / 0.88), 1.5);
    // …and under the knee, the ember that never quite goes out. Capped where the metal
    // still reads as itself, so this can never become the unguarded channel again.
    const ember = 0.055 * smooth(clamp01(glow / 0.12));
    const emis = hot * metal.peak;
    const bodyMat = bodyMeshRef.current?.material as THREE.MeshStandardMaterial | undefined;
    const trimMat = trimMeshRef.current?.material as THREE.MeshStandardMaterial | undefined;
    if (bodyMat) {
      bodyMat.emissive.copy(tmpC);
      bodyMat.emissiveIntensity = emis;
    }
    if (trimMat) {
      trimMat.emissive.copy(tmpC);
      trimMat.emissiveIntensity = emis * 0.8;
    }

    if (bellyRef.current) bellyRef.current.scale.setScalar(0.35 + hot * 0.85);
    if (bellyMatRef.current) bellyMatRef.current.opacity = hot * 0.5 + ember;
    if (heatLightRef.current) heatLightRef.current.intensity = (hot + ember) * 5;
    if (engMatRef.current) {
      engMatRef.current.opacity = lit
        ? smooth(clamp01((tau - 0.8) / 1.4)) * 0.95
        : glow * 0.12;
    }

    // the spout's own flare, in the smoke's colour — the two variants both light
    // the stall, so neither is only a swatch
    const flare = lit
      ? (0.2 + Math.sin(clamp01(tau / 0.55) * Math.PI) * 0.9) * textA
      : 0;
    if (flareRef.current) flareRef.current.scale.setScalar(0.2 + flare * 0.75);
    if (flareMatRef.current) flareMatRef.current.opacity = flare * 0.85;
    if (smokeLightRef.current) smokeLightRef.current.intensity = flare * 1.1;

    // a light sweeping the belly, until they take the hint
    if (hintRef.current) hintRef.current.position.x = Math.sin(t * 2.1) * 0.42;
    if (hintMatRef.current) hintMatRef.current.opacity = hint * 0.4;

    /* ---- smoke ---- */
    let wispA = lerp(0.1 + heat * 0.16, 0.5, exh);
    if (phase === "preview") wispA *= Math.max(textA, 1 - exh);
    const sm = smokePtsRef.current?.material as
      THREE.ShaderMaterial | undefined;
    if (sm) {
      const u = sm.uniforms;
      u.uTau.value = tau;
      u.uWisp.value = e;
      u.uTime.value = e;
      u.uTextA.value = textA;
      u.uWispA.value = wispA;
      // the plume grows out of the spout on the exhale rather than popping in
      u.uFade.value = lerp(1.35, WISP_LIFE, exh);
      // gl_PointSize is in device pixels and ignores the model matrix, so fold the
      // portrait fit back in or the puffs bloat on a phone
      u.uScale.value =
        ((state.size.height * state.viewport.dpr) /
          (2 * Math.tan((FOV * Math.PI) / 360))) *
        fit;
    }

    /* ---- dust, drifting down the shaft ---- */
    const mp = motesRef.current;
    if (mp) {
      const pa = mp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = mp.geometry.attributes.color as THREE.BufferAttribute;
      const moteA = phase === "sealed" ? 0.5 : phase === "preview" ? 0.6 : 0.72;
      for (let i = 0; i < MOTE_N; i++) {
        const v = (MOTES.v0[i] + e * MOTES.sp[i]) % 1;
        // the cone widens as they fall, so the dust spreads with it
        const rr = MOTES.u[i] * lerp(SHAFT_RT, SHAFT_RB, v);
        const th = MOTES.th[i] + Math.sin(e * 0.24 + MOTES.ph[i]) * 0.5;
        pa.setXYZ(i, Math.cos(th) * rr, (0.5 - v) * SHAFT_H, Math.sin(th) * rr);
        // dust only exists where the light is
        const k =
          (1 - MOTES.u[i] * MOTES.u[i]) *
          (0.45 + 0.55 * Math.sin(e * 2.1 + MOTES.ph[i] * 3));
        const b = Math.max(0, k) * moteA;
        ca.setXYZ(i, b, b * 0.86, b * 0.62);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }
    if (moteMatRef.current) moteMatRef.current.opacity = 1;

    /* ---- sparks ---- */
    const sp = sparkRef.current;
    if (sp) {
      const sk = sparks.current;
      const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < SPARK_N; i++) {
        const a = e - sk.t0[i];
        if (a < 0 || a > SPARK_LIFE) {
          ca.setXYZ(i, 0, 0, 0);
          continue;
        }
        pa.setXYZ(i, sk.ox[i] + sk.vx[i] * a, sk.oy[i] + sk.vy[i] * a - 1.5 * a * a, 0.72);
        const k = 1 - a / SPARK_LIFE;
        ca.setXYZ(i, mats.heatC.r * k, mats.heatC.g * k, mats.heatC.b * k);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    if (phase === "opening" && lit && tau >= TAU_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      {/* aimed at the midpoint of cushion and words, not the origin, so neither crops */}
      <PerspectiveCamera makeDefault position={[0, 0.3, CAM_Z]} fov={FOV} onUpdate={(c) => c.lookAt(0, -0.09, 0)} />
      <ambientLight intensity={0.22} color="#ffe0bc" />
      {/* the key rides in along the shaft; the rim is the stall's cold bounce */}
      <directionalLight position={[-2.4, 4.2, 2.2]} intensity={1.6} color="#ffd9a0" />
      <directionalLight position={[3.2, 1.4, -2.6]} intensity={0.75} color={metal.rim} />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the back of the stall — see WALL_W: sized off the frustum, not by eye */}
          <mesh position={[0, 0.2, WALL_Z]}>
            <planeGeometry args={[WALL_W, WALL_H * 1.22]} />
            <meshBasicMaterial map={wallTex} />
          </mesh>

          {/* the shaft, and the dust hanging in it */}
          <group position={[-0.455, 0.355, -0.15]} rotation={[0, 0, 0.474]}>
            <mesh>
              <cylinderGeometry args={[SHAFT_RT, SHAFT_RB, SHAFT_H, 30, 1, true]} />
              <meshBasicMaterial
                map={shaftTex} color="#ffca7d" transparent opacity={0.5}
                depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending}
              />
            </mesh>
            <points ref={motesRef} frustumCulled={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[MOTES.pos, 3]} />
                <bufferAttribute attach="attributes-color" args={[MOTES.col, 3]} />
              </bufferGeometry>
              <pointsMaterial
                ref={moteMatRef} map={glowTex} vertexColors size={0.035} sizeAttenuation
                transparent depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </points>
          </group>

          {/* embroidered cushion — its crown sits above the lamp's foot, so the
              lamp settles into it rather than perching on a board */}
          <mesh position={[CUSH_X, CUSH_Y, 0]} scale={[1.78, 0.56, 1.3]} geometry={cushionGeo}>
            <meshStandardMaterial map={cushionTex} roughness={0.72} metalness={0.06} />
          </mesh>
          {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
            <group key={i} position={[CUSH_X + sx * 0.95, CUSH_Y - 0.05, sz * 0.69]}>
              <mesh geometry={tasselHeadGeo} material={tasselMat} />
              <mesh position={[0, -0.075, 0]} geometry={tasselSkirtGeo} material={tasselMat} />
            </group>
          ))}
          {/* no shadow maps here: a soft dark plane, then the pool of light over it.
              Coplanar and both depth-write-free, so the order has to be explicit. */}
          <mesh position={[0.52, -1.175, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
            <planeGeometry args={[1.5, 1.0]} />
            <meshBasicMaterial map={glowTex} color="#000000" transparent opacity={0.55} depthWrite={false} />
          </mesh>
          <mesh position={[0.18, -1.17, 0.12]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
            <planeGeometry args={[1.9, 1.5]} />
            <meshBasicMaterial
              map={glowTex} color="#ffd9a0" transparent opacity={0.3}
              depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* the lamp */}
          <group ref={lampRef} position={[LAMP_X, LAMP_Y, 0]}>
            <mesh ref={bodyMeshRef} geometry={bodyGeo} material={mats.body} />
            <mesh geometry={spoutGeo} material={mats.body} />
            {/* the arc runs past a half-turn so both ends bury in the belly */}
            <mesh position={[0.62, 0.27, 0]} rotation={[0, 0, -2.3]} geometry={handleGeo} material={mats.body} />
            <mesh ref={trimMeshRef} position={[0, 0.752, 0]} geometry={finialGeo} material={mats.trim} />
            <mesh position={[0, 0.726, 0]} rotation={[Math.PI / 2, 0, 0]} geometry={collarGeo} material={mats.trim} />
            <mesh position={[0, 0.022, 0]} material={mats.trim}>
              <cylinderGeometry args={[0.305, 0.305, 0.03, 32]} />
            </mesh>

            {/* the band widens to fit the names rather than squashing them */}
            {engrave && (
              <mesh position={[0, BELLY_Y, 0]}>
                <cylinderGeometry
                  args={[engrave.R, engrave.R, engrave.h, 48, 1, true, -engrave.theta / 2, engrave.theta]}
                />
                <meshBasicMaterial
                  ref={engMatRef} map={engrave.texture} color={metal.engrave} transparent
                  opacity={0} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
                />
              </mesh>
            )}

            {/* the heat, faked the house way: emissive metal + an additive sprite over it */}
            <sprite ref={bellyRef} position={[0, BELLY_Y, BELLY_R * 0.55]} scale={0.35}>
              <spriteMaterial
                ref={bellyMatRef} map={glowTex} color={metal.heat} transparent
                opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </sprite>
            <pointLight
              ref={heatLightRef} position={[0, BELLY_Y, 0.3]} intensity={0}
              color={metal.heat} distance={4} decay={1.5}
            />
            {/* a light buffing the belly on its own, until they take the hint */}
            <sprite ref={hintRef} position={[0, BELLY_Y + 0.02, BELLY_R * 0.92]} scale={0.5}>
              <spriteMaterial
                ref={hintMatRef} map={glowTex} color="#fff0d0" transparent
                opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </sprite>
            <sprite ref={flareRef} position={[-1.33, 0.6, 0]} scale={0.2}>
              <spriteMaterial
                ref={flareMatRef} map={glowTex} color={smokePal.light} transparent
                opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </sprite>
          </group>
          <pointLight
            ref={smokeLightRef} position={[SPOUT.x, SPOUT.y + 0.25, 0.4]} intensity={0}
            color={smokePal.light} distance={5} decay={1.4}
          />

          {/* sparks buffed off the metal */}
          <points ref={sparkRef} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[sparkBuf.pos, 3]} />
              <bufferAttribute attach="attributes-color" args={[sparkBuf.col, 3]} />
            </bufferGeometry>
            <pointsMaterial
              map={glowTex} vertexColors size={0.05} sizeAttenuation
              transparent depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </points>

          {/* the smoke, and the words it becomes */}
          <points ref={smokePtsRef} geometry={smokeGeo} material={smokeMat} frustumCulled={false} />

          {/* three r185 raycasts straight through `visible={false}` — an invisible
              hit target has to be a transparent one or the rub is silently eaten.
              Sits in front of the belly, and only exists while it is wanted. */}
          {phase === "opening" && (
            <mesh
              ref={hitRef}
              position={[HIT_X, HIT_Y, 0.8]}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={stop}
              onPointerCancel={stop}
              onPointerOut={stop}
            >
              <planeGeometry args={[2.4, 1.15]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          )}
        </group>
      </group>
    </>
  );
}
