import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";

/* ---------- palettes ---------- */
// `fringe` is read as bands down the form, so the order is the design: adjacent
// entries have to fight each other or the whole body greys out into one hue.
interface Pal {
  fringe: string[];
  body: string; // the papier-mâché under the fringe
  candy: string[];
  rope: string;
  key: string;
  fill: string;
  paper: string; // the note
  ink: string;
}
const PALETTES: Record<string, Pal> = {
  fiesta: {
    fringe: ["#ff2d78", "#ffc21e", "#12c4c4", "#8de021", "#8a3ffc"],
    body: "#c4406f",
    candy: ["#ff3b6b", "#ffd23f", "#25d0d0", "#7ee041", "#a855f7", "#ff8c1a"],
    rope: "#b99461", key: "#fff2d6", fill: "#5b4bd8",
    paper: "#fff6e4", ink: "#3a2233",
  },
  pastel: {
    fringe: ["#ffb3c7", "#bfe9d0", "#ffe6a3", "#c9c2f5", "#a8dcf0"],
    body: "#e5a8bb",
    candy: ["#ffc2d4", "#c8f0da", "#fff0b8", "#d6cffa", "#b7e6f7", "#ffd9b8"],
    rope: "#cbb18a", key: "#fffaf0", fill: "#8fa8d8",
    paper: "#fffaf2", ink: "#4a3a48",
  },
  sunset: {
    fringe: ["#ff5a3c", "#ff9d2e", "#ffd166", "#e83a8c", "#6b2d8f"],
    body: "#b8433a",
    candy: ["#ff6b4a", "#ffab2e", "#ffdf6e", "#ff3d84", "#9b4fd0", "#ffe9b0"],
    rope: "#a8794c", key: "#ffe4bd", fill: "#7a3aa8",
    paper: "#fff4e0", ink: "#4a2418",
  },
};

/* ---------- stage layout ---------- */
const FOV = 40;
const CAM_Z = 5.0;
const CAM_Y = 0.15;
const PIVOT_Y = 2.15; // where the rope is tied: the pendulum's pivot, not its top
const ROPE_L = 2.05;
// The rope is drawn past its own pivot, because the pivot is not always off screen.
// `fitS` floors at 0.58 on a 390-wide phone, which drags the pivot from 2.15 down to
// 1.25 while the frame's top edge sits at 1.84 — a rope hanging from nothing, in the
// two phases the recipient spends the longest in. It stays one straight rigid
// cylinder, so a swing still reads as a swing; all that moves is where the rope
// crosses the frame's edge, by ~26px, against nothing to measure it by.
const ROPE_ABOVE = 2.0; // ⇒ the top reaches 4.15, clearing 1.84 / 0.58 = 3.17
const BODY_Y = PIVOT_Y - ROPE_L;
const BODY_R = 0.78; // silhouette half-extent
const HIT_R = 1.02; // generous: it is a moving target and a thumb is not a stick
const ACTION_W = 3.0;
const NOTE_Y = -0.38;
const NOTE_Z = 0.5; // in front of the rope's scraps, but not so close it needs a wide frustum
const NOTE_W = 2.3;
const NOTE_H_MAX = 1.5;

/* ---------- timeline (seconds) ---------- */
const HITS_NEEDED = 6; // the 6th lands the burst; 1-5 crack it
const CRACK_GROW = 0.26; // a crack tears open this fast, then it is there forever
const TAU_HOLD = 3.3; // the burst's whole show; the note lands exactly here
const T_MERCY0 = 2.2; // …after this long untouched, the piñata starts giving way
// Accelerando, not a metronome: the rope creaks, the shell tires, and it goes.
// onOpenComplete is bounded at 12s from `opening`, and the bound is on the whole
// show — 2.2 + 4.95 of straining + 3.6 of burst = 10.75, with 1.25s of slack for
// a phone whose dt clamps at 0.05 and so runs this clock behind the wall.
const MERCY_GAPS = [1.3, 1.1, 0.95, 0.85, 0.75];
const SHAKE_DUR = 0.12; // a hit. 120ms reads as impact; 400ms reads as an earthquake
const BURST_SHAKE = 0.3;
// Half of real. Honest gravity empties a piñata in under a second — the drama is
// not in the physics being right, it is in being able to watch it, and the doc
// picked scripted over simulated precisely so this could be aimed.
const G = 4.6;

// Preview shows the gift whole, at rest, alive — never the burst. The burst is
// what the `opening` gesture buys, and a card that has already spent it is a card
// showing litter: a rope, a fallen note and a floor of confetti. So preview is
// `sealed` with the draft leaned on, because a 410px gallery tile has to sell
// "alive" from across the page.
const PREV_SWAY = 2.6;

const glowTex = makeRadialSprite();

/* ---------- silhouettes ---------- */
// One body builder serves all three shapes, so a shape is only ever a closed 2D
// outline. Everything else — the puff, the bands, the fringe rows, the cracks,
// the shards — is derived from it and therefore free.
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);

function starOutline(): THREE.Vector2[] {
  const p: THREE.Vector2[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2; // the classic star is drawn tip-up
    const r = i % 2 === 0 ? 1 : 0.42;
    p.push(V2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return p;
}

function heartOutline(): THREE.Vector2[] {
  const p: THREE.Vector2[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    p.push(
      V2(
        16 * Math.pow(Math.sin(t), 3),
        13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      ),
    );
  }
  p.reverse(); // the parametric heart runs clockwise; the builder wants ccw
  return p;
}

// Side-on, nose to the left. Traced ccw from the muzzle over the ears, down the
// tail, and back along the belly — the legs are the tabs a real burro piñata has.
const BURRO: [number, number][] = [
  [-0.94, 0.40], [-0.88, 0.60], [-0.74, 0.73], [-0.68, 0.80], [-0.78, 1.04],
  [-0.58, 0.86], [-0.50, 1.06], [-0.40, 0.82], [-0.26, 0.68], [-0.08, 0.58],
  [0.30, 0.56], [0.62, 0.48], [0.74, 0.42], [0.90, 0.32], [0.96, 0.02],
  [0.78, 0.18], [0.68, 0.10], [0.64, -0.44], [0.66, -0.76], [0.46, -0.76],
  [0.44, -0.36], [0.10, -0.32], [-0.20, -0.34], [-0.22, -0.76], [-0.42, -0.76],
  [-0.40, -0.30], [-0.54, -0.10], [-0.72, 0.12], [-0.90, 0.26],
];
const burroOutline = () => BURRO.map(([x, y]) => V2(x, y));

/** Even-arc-length resample of a closed polyline. */
function resample(src: THREE.Vector2[], n: number): THREE.Vector2[] {
  const m = src.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < m; i++) {
    const d = src[i].distanceTo(src[(i + 1) % m]);
    seg.push(d);
    total += d;
  }
  const out: THREE.Vector2[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const want = (k / n) * total;
    while (acc + seg[i] < want && i < m - 1) acc += seg[i++];
    const f = seg[i] > 1e-6 ? (want - acc) / seg[i] : 0;
    out.push(src[i].clone().lerp(src[(i + 1) % m], f));
  }
  return out;
}

/** Chaikin corner cut — papier-mâché has no sharp corners, only tight ones. */
function chaikin(src: THREE.Vector2[], iters: number): THREE.Vector2[] {
  let p = src;
  for (let k = 0; k < iters; k++) {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      out.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
    }
    p = out;
  }
  return p;
}

const RING_U = 72;
const RING_V = 22;
const NB = 8; // colour bands down the form; the fringe rows sit in them

interface ShapeDef {
  outline: THREE.Vector2[]; // resampled to RING_U, centered, half-extent BODY_R
  cx: number;
  cy: number; // the centroid the puff shrinks toward
  depth: number;
  puff: number;
}

function makeShape(raw: THREE.Vector2[], depth: number, puff: number): ShapeDef {
  const outline = resample(chaikin(resample(raw, 192), 2), RING_U);
  // normalize to a common half-extent so every shape films the same
  const box = new THREE.Box2().setFromPoints(outline);
  const c = box.getCenter(new THREE.Vector2());
  const size = box.getSize(new THREE.Vector2());
  const k = BODY_R / (Math.max(size.x, size.y) / 2);
  for (const p of outline) p.sub(c).multiplyScalar(k);
  // area centroid, not the box centre: the puff has to shrink toward the mass or
  // a burro's head collapses while its rump keeps its full depth
  let ax = 0, ay = 0, aa = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    const cr = p.x * q.y - q.x * p.y;
    aa += cr;
    ax += (p.x + q.x) * cr;
    ay += (p.y + q.y) * cr;
  }
  aa *= 0.5;
  return { outline, cx: ax / (6 * aa), cy: ay / (6 * aa), depth, puff };
}

const SHAPES: Record<string, () => ShapeDef> = {
  star: () => makeShape(starOutline(), 0.5, 0.6),
  heart: () => makeShape(heartOutline(), 0.56, 0.55),
  burro: () => makeShape(burroOutline(), 0.46, 0.72),
};

/**
 * The body: the silhouette swept front-to-back, each ring shrunk toward the
 * centroid by cos(α)^puff. A star's points become cones, a heart becomes a real
 * heart, a burro's legs become tapered tabs — which is what those piñatas are.
 * v=0 is the back pole, v=0.5 the silhouette itself, v=1 the front pole.
 */
function surfaceAt(s: ShapeDef, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (v - 0.5) * Math.PI;
  const k = Math.pow(Math.max(0, Math.cos(a)), s.puff);
  const fu = ((u % 1) + 1) % 1;
  const g = fu * RING_U;
  const i0 = Math.floor(g) % RING_U;
  const f = g - Math.floor(g);
  const p = s.outline[i0];
  const q = s.outline[(i0 + 1) % RING_U];
  const x = p.x + (q.x - p.x) * f;
  const y = p.y + (q.y - p.y) * f;
  return out.set(s.cx + (x - s.cx) * k, s.cy + (y - s.cy) * k, s.depth * Math.sin(a));
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
/** Outward normal by finite difference. Never called at a pole, where dPdu dies. */
function normalAt(s: ShapeDef, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const h = 0.004;
  surfaceAt(s, u + h, v, _a).sub(surfaceAt(s, u - h, v, _b));
  surfaceAt(s, u, Math.min(0.999, v + h), _b).sub(surfaceAt(s, u, Math.max(0.001, v - h), _c));
  return out.crossVectors(_a, _b).normalize();
}

const bandColor = (pal: Pal, v: number) =>
  pal.fringe[Math.min(NB - 1, Math.floor(v * NB)) % pal.fringe.length];

/* ---------- papier-mâché ---------- */
// Paper, not plastic: torn newsprint edges under a coat of paste. Cheap, and it
// is the whole difference between a shell and a beach ball.
function buildPaperTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(4471);
  for (let i = 0; i < 70; i++) {
    const x = rand() * S, y = rand() * S, w = 18 + rand() * 44, h = 14 + rand() * 34;
    g.save();
    g.translate(x, y);
    g.rotate(rand() * Math.PI);
    g.fillStyle = `rgba(0,0,0,${0.03 + rand() * 0.06})`;
    g.beginPath();
    // a torn strip: straight-ish long edges, ragged short ones
    g.moveTo(-w / 2, -h / 2);
    for (let k = 0; k <= 6; k++) g.lineTo(-w / 2 + (k * w) / 6, -h / 2 + (rand() - 0.5) * 5);
    g.lineTo(w / 2, h / 2);
    for (let k = 6; k >= 0; k--) g.lineTo(-w / 2 + (k * w) / 6, h / 2 + (rand() - 0.5) * 5);
    g.closePath();
    g.fill();
    g.restore();
  }
  for (let i = 0; i < 2200; i++) {
    // pulp fleck
    g.fillStyle = `rgba(${rand() > 0.5 ? 255 : 90},${rand() > 0.5 ? 250 : 90},200,0.12)`;
    g.fillRect(rand() * S, rand() * S, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const paperTex = buildPaperTexture();
// The same pulp, but the note is a hand's width of it rather than a whole shell —
// at the shell's tiling the torn strips come out the size of continents.
const notePaperTex = paperTex.clone();
notePaperTex.repeat.set(9, 5);
notePaperTex.needsUpdate = true;

function buildRopeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b08a55";
  g.fillRect(0, 0, 32, 32);
  g.lineWidth = 4;
  for (let i = -32; i < 64; i += 9) {
    g.strokeStyle = i % 18 === 0 ? "rgba(0,0,0,0.32)" : "rgba(255,240,210,0.3)";
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 20, 32);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 30); // the twist reads as strands, not as a stripe: ~8 per world unit
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ropeTex = buildRopeTexture();

/* ---------- cracks ---------- */
// Walked once, in (u,v), so every shape gets the same web mapped onto its own
// form. `hit` is which blow opens it and `s0..s1` where in that blow's reveal a
// branch joins its parent — so the whole web is a pure function of the hit count
// and a replay tears it open identically.
const CRACKS_PER_HIT = 3;
const CRACK_HITS = HITS_NEEDED - 1;
interface CrackLine {
  uv: number[]; // u,v pairs
  hit: number;
  s0: number;
  s1: number;
  w: number;
}
function buildCrackLines(): CrackLine[] {
  const rand = mulberry32(90210);
  const out: CrackLine[] = [];
  const walk = (u0: number, v0: number, dir0: number, steps: number) => {
    const uv = [u0, v0];
    let u = u0, v = v0, dir = dir0;
    for (let k = 0; k < steps; k++) {
      dir += (rand() - 0.5) * 1.15; // paper tears drunk, not straight
      const st = 0.028 + rand() * 0.03;
      u += Math.cos(dir) * st;
      // …and crawls outward off the face as it goes, so the web radiates from the
      // blow instead of pooling under the fringe rows that would hide it
      v += Math.sin(dir) * st * 0.6 - 0.012;
      // reflect off the silhouette and the front pole rather than sliding along them
      if (v > 0.98) { v = 1.96 - v; dir = -dir; }
      if (v < 0.5) { v = 1.0 - v; dir = -dir; }
      uv.push(u, v);
    }
    return uv;
  };
  for (let h = 0; h < CRACK_HITS; h++) {
    for (let c = 0; c < CRACKS_PER_HIT; c++) {
      // later blows land their cracks further round the form: the damage spreads
      const u0 = (h * 0.37 + c / CRACKS_PER_HIT + rand() * 0.14) % 1;
      // Start on the bare front cap. The fringe rows own v ≈ 0.3-0.88 and hang over
      // anything drawn under them, so a crack seeded there is a crack nobody sees.
      const v0 = 0.8 + rand() * 0.16;
      const uv = walk(u0, v0, rand() * Math.PI * 2, 9 + Math.floor(rand() * 5));
      out.push({ uv, hit: h, s0: 0, s1: 1, w: 0.03 + rand() * 0.018 });
      // a fork off the parent's middle, opening as the parent finishes
      const f = 4 + Math.floor(rand() * 3);
      out.push({
        uv: walk(uv[f * 2], uv[f * 2 + 1], rand() * Math.PI * 2, 4 + Math.floor(rand() * 4)),
        hit: h,
        s0: 0.45 + rand() * 0.2,
        s1: 1,
        w: 0.018 + rand() * 0.012,
      });
    }
  }
  return out;
}
const CRACK_LINES = buildCrackLines();

const CRACK_VERT = `
attribute float aReveal;
attribute float aSide;
uniform float uReveal;
varying float vA;
varying float vSide;
void main() {
  vA = clamp((uReveal - aReveal) * 7.0, 0.0, 1.0);
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const CRACK_FRAG = `
uniform vec3 uColor;
uniform vec3 uLip;
varying float vA;
varying float vSide;
void main() {
  if (vA < 0.004) discard;
  // dark in the gap, with the torn paper curling pale on one lip — the thing that
  // makes a painted line read as a hole
  gl_FragColor = vec4(mix(uColor, uLip, smoothstep(0.3, 1.0, vSide)), vA);
}
`;

/* ---------- fringe & streamers ---------- */
const FRINGE_ROWS = [0.3, 0.38, 0.46, 0.54, 0.62, 0.7, 0.79, 0.88];
const FRINGE_PER_ROW = 34;
const FRINGE_N = FRINGE_ROWS.length * FRINGE_PER_ROW;
const HANG_N = 6;
const FLY_N = 12;

/** A strip glued along its top edge: local -y is how far down the cut it is. */
function stripGeo(segs: number, n: number, seed: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, segs);
  g.translate(0, -0.5, 0);
  const rand = mulberry32(seed);
  const wv = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    wv[i * 3] = rand() * Math.PI * 2; // phase — a fringe in lockstep reads as a curtain
    wv[i * 3 + 1] = 0.012 + rand() * 0.016; // amplitude, world units
    wv[i * 3 + 2] = 2.4 + rand() * 2.2; // frequency
  }
  g.setAttribute("aWv", new THREE.InstancedBufferAttribute(wv, 3));
  return g;
}
const fringeGeo = stripGeo(5, FRINGE_N, 1301);
const hangGeo = stripGeo(12, HANG_N, 55);
const flyGeo = stripGeo(10, FLY_N, 909);

// Amplitude has to be world-scale here: the strip is scaled (w, len, 1), so only
// its local z survives to world unscaled. The rest of the wave would vanish.
const FRINGE_PATCH = `
  #include <begin_vertex>
  float hang = -position.y;
  float bend = pow(hang, 1.6);
  float d = distance(instanceMatrix[3].xyz, uHit);
  // a ring of agitation running out from the strike, not a global shiver
  float rip = uRip * (1.0 - smoothstep(0.0, 0.9, abs(d - uRipT * 3.4)));
  float amp = aWv.y * (1.0 + rip * 6.0) * uAmp;
  float ph = uTime * aWv.z * (1.0 + rip * 2.0) + aWv.x;
  transformed.z += (sin(ph) + 0.4 * sin(ph * 2.3 + 1.1)) * amp * bend;
`;

/* ---------- shell fragments ---------- */
// Patches of the very surface that just broke, so at τ=0 they sit exactly where
// the shell was. The whole flight is a closed form of τ in the vertex shader:
// nothing per-frame on the CPU, and replay is bit-exact for free.
const FU = 7;
const FV = 4;
const FRAG_N = FU * FV;
const SHARD_PATCH_VERT = `
  vec3 _lp = transformed - aCen;
  _lp = _lp * cos(_ang) + cross(aAxis, _lp) * sin(_ang) + aAxis * dot(aAxis, _lp) * (1.0 - cos(_ang));
  float _ft = max(0.0, uTau - aDelay);
  transformed = aCen + _lp + aVel * _ft - vec3(0.0, ${G.toFixed(1)} * 0.5 * _ft * _ft, 0.0);
`;

/* ---------- candy ---------- */
// A lathed wrapped sweet: twist, flare, belly, flare, twist. One geometry, one
// draw call, and at 0.09u across the twists are exactly what says "sweet".
const CANDY_PROFILE = [
  V2(0.0, -0.5), V2(0.055, -0.46), V2(0.045, -0.33), V2(0.13, -0.25),
  V2(0.26, -0.13), V2(0.3, 0.0), V2(0.26, 0.13), V2(0.13, 0.25),
  V2(0.045, 0.33), V2(0.055, 0.46), V2(0.0, 0.5),
];
const candyGeo = new THREE.LatheGeometry(CANDY_PROFILE, 8);
const CANDY_N = 210;

interface Kit {
  body: THREE.BufferGeometry;
  cracks: THREE.BufferGeometry;
  shards: THREE.BufferGeometry;
  base: Float32Array; // fringe instance matrices at rest
  col: Float32Array;
  burst: Float32Array;
  topY: number; // where the rope ties on
}

function buildKit(shapeKey: string, palKey: string): Kit {
  const s = (SHAPES[shapeKey] ?? SHAPES.star)();
  const pal = PALETTES[palKey] ?? PALETTES.fiesta;
  const rand = mulberry32(31337);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const col = new THREE.Color();

  /* body */
  const NU = RING_U + 1;
  const NV = RING_V + 1;
  const bp = new Float32Array(NU * NV * 3);
  const bu = new Float32Array(NU * NV * 2);
  const bc = new Float32Array(NU * NV * 3);
  for (let j = 0; j < NV; j++) {
    const v = j / RING_V;
    col.set(bandColor(pal, v)).multiplyScalar(0.6); // paste under the paper, not the paper
    for (let i = 0; i < NU; i++) {
      const k = j * NU + i;
      surfaceAt(s, i / RING_U, v, p);
      bp[k * 3] = p.x; bp[k * 3 + 1] = p.y; bp[k * 3 + 2] = p.z;
      bu[k * 2] = i / RING_U; bu[k * 2 + 1] = v;
      bc[k * 3] = col.r; bc[k * 3 + 1] = col.g; bc[k * 3 + 2] = col.b;
    }
  }
  const bi: number[] = [];
  for (let j = 0; j < RING_V; j++)
    for (let i = 0; i < RING_U; i++) {
      const a = j * NU + i;
      bi.push(a, a + 1, a + NU, a + 1, a + NU + 1, a + NU);
    }
  const body = new THREE.BufferGeometry();
  body.setAttribute("position", new THREE.BufferAttribute(bp, 3));
  body.setAttribute("uv", new THREE.BufferAttribute(bu, 2));
  body.setAttribute("color", new THREE.BufferAttribute(bc, 3));
  body.setIndex(bi);
  body.computeVertexNormals();
  body.computeBoundingSphere();
  const topY = body.boundingSphere!.center.y + body.boundingSphere!.radius * 0.72;

  /* cracks — ribbons laid along the surface they are splitting */
  const cv: number[] = [];
  const cr: number[] = [];
  const cs: number[] = [];
  const q = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const lo = new THREE.Vector3();
  const hi = new THREE.Vector3();
  const prevL = new THREE.Vector3();
  const prevR = new THREE.Vector3();
  for (const cl of CRACK_LINES) {
    const m = cl.uv.length / 2;
    let pr = 0;
    for (let i = 0; i < m; i++) {
      const t = i / (m - 1);
      surfaceAt(s, cl.uv[i * 2], cl.uv[i * 2 + 1], p);
      normalAt(s, cl.uv[i * 2], cl.uv[i * 2 + 1], n);
      const j = Math.min(m - 1, i + 1);
      const jp = Math.max(0, i - 1);
      surfaceAt(s, cl.uv[j * 2], cl.uv[j * 2 + 1], q);
      surfaceAt(s, cl.uv[jp * 2], cl.uv[jp * 2 + 1], _a);
      perp.crossVectors(n, q.sub(_a)).normalize();
      p.addScaledVector(n, 0.006); // the tear rides just proud of the shell
      // widest at the blow, closing to nothing at the tip
      const w = cl.w * (1 - t * t) + 0.0015;
      lo.copy(p).addScaledVector(perp, w);
      hi.copy(p).addScaledVector(perp, -w);
      const rv = cl.hit + lerp(cl.s0, cl.s1, t);
      if (i > 0) {
        cv.push(prevL.x, prevL.y, prevL.z, prevR.x, prevR.y, prevR.z, lo.x, lo.y, lo.z);
        cv.push(prevR.x, prevR.y, prevR.z, hi.x, hi.y, hi.z, lo.x, lo.y, lo.z);
        cr.push(pr, pr, rv, pr, rv, rv);
        cs.push(1, -1, 1, -1, -1, 1);
      }
      prevL.copy(lo);
      prevR.copy(hi);
      pr = rv;
    }
  }
  const cracks = new THREE.BufferGeometry();
  cracks.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cv), 3));
  cracks.setAttribute("aReveal", new THREE.BufferAttribute(new Float32Array(cr), 1));
  cracks.setAttribute("aSide", new THREE.BufferAttribute(new Float32Array(cs), 1));

  /* shards — the (u,v) grid tiled into patches, each a real piece of the shell */
  const PU = 3;
  const PV = 3;
  const per = (PU + 1) * (PV + 1);
  const sp = new Float32Array(FRAG_N * per * 3);
  const sc = new Float32Array(FRAG_N * per * 3);
  const scen = new Float32Array(FRAG_N * per * 3);
  const svel = new Float32Array(FRAG_N * per * 3);
  const sax = new Float32Array(FRAG_N * per * 3);
  const srate = new Float32Array(FRAG_N * per);
  const sdel = new Float32Array(FRAG_N * per);
  const si: number[] = [];
  const cen = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const ax = new THREE.Vector3();
  for (let f = 0; f < FRAG_N; f++) {
    const fi = f % FU;
    const fj = Math.floor(f / FU);
    // jittered boundaries: the tiles overlap and gap, which is what a tear is.
    // Only ever seen from τ=0 on, with a flash and a shake over it.
    const u0 = (fi + (rand() - 0.5) * 0.22) / FU;
    const u1 = (fi + 1 + (rand() - 0.5) * 0.22) / FU;
    const v0 = 0.02 + ((fj + (rand() - 0.5) * 0.22) / FV) * 0.96;
    const v1 = 0.02 + ((fj + 1 + (rand() - 0.5) * 0.22) / FV) * 0.96;
    const um = (u0 + u1) / 2;
    const vm = THREE.MathUtils.clamp((v0 + v1) / 2, 0.04, 0.96);
    surfaceAt(s, um, vm, cen);
    normalAt(s, um, vm, n);
    // out along its own normal, lifted, and biased at the camera so the shell
    // comes at you rather than politely sideways
    vel.copy(n).multiplyScalar(1.5 + rand() * 2.0);
    vel.y += 0.55 + rand() * 1.1;
    vel.z += 0.45 + rand() * 0.5;
    ax.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    const rate = (rand() * 2 - 1) * 15;
    const del = rand() * 0.045;
    col.set(bandColor(pal, vm)).multiplyScalar(0.6);
    const b = f * per;
    for (let j = 0; j <= PV; j++)
      for (let i = 0; i <= PU; i++) {
        const k = b + j * (PU + 1) + i;
        surfaceAt(s, lerp(u0, u1, i / PU), THREE.MathUtils.clamp(lerp(v0, v1, j / PV), 0.02, 0.98), p);
        sp[k * 3] = p.x; sp[k * 3 + 1] = p.y; sp[k * 3 + 2] = p.z;
        sc[k * 3] = col.r; sc[k * 3 + 1] = col.g; sc[k * 3 + 2] = col.b;
        scen[k * 3] = cen.x; scen[k * 3 + 1] = cen.y; scen[k * 3 + 2] = cen.z;
        svel[k * 3] = vel.x; svel[k * 3 + 1] = vel.y; svel[k * 3 + 2] = vel.z;
        sax[k * 3] = ax.x; sax[k * 3 + 1] = ax.y; sax[k * 3 + 2] = ax.z;
        srate[k] = rate;
        sdel[k] = del;
      }
    for (let j = 0; j < PV; j++)
      for (let i = 0; i < PU; i++) {
        const a = b + j * (PU + 1) + i;
        si.push(a, a + 1, a + PU + 1, a + 1, a + PU + 2, a + PU + 1);
      }
  }
  const shards = new THREE.BufferGeometry();
  shards.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  shards.setAttribute("color", new THREE.BufferAttribute(sc, 3));
  shards.setAttribute("aCen", new THREE.BufferAttribute(scen, 3));
  shards.setAttribute("aVel", new THREE.BufferAttribute(svel, 3));
  shards.setAttribute("aAxis", new THREE.BufferAttribute(sax, 3));
  shards.setAttribute("aRate", new THREE.BufferAttribute(srate, 1));
  shards.setAttribute("aDelay", new THREE.BufferAttribute(sdel, 1));
  shards.setIndex(si);
  shards.computeVertexNormals();

  /* fringe — rows follow the form's own cross-sections, the way you would
     actually glue them, so a star gets rings down each point for free */
  const base = new Float32Array(FRINGE_N * 16);
  const fcol = new Float32Array(FRINGE_N * 3);
  const burst = new Float32Array(FRINGE_N * 3);
  const m4 = new THREE.Matrix4();
  const X = new THREE.Vector3();
  const Y = new THREE.Vector3();
  const Z = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  for (let r = 0; r < FRINGE_ROWS.length; r++) {
    const v = FRINGE_ROWS[r];
    col.set(pal.fringe[r % pal.fringe.length]);
    for (let i = 0; i < FRINGE_PER_ROW; i++) {
      const k = r * FRINGE_PER_ROW + i;
      const u = (i + 0.5) / FRINGE_PER_ROW + (r % 2) * (0.5 / FRINGE_PER_ROW); // brick the rows
      surfaceAt(s, u, v, p);
      normalAt(s, u, v, n);
      // hangs between straight down and straight off the surface: paste at the top,
      // gravity at the bottom
      Y.copy(down).lerp(n, 0.42).normalize().negate();
      X.crossVectors(Y, n);
      if (X.lengthSq() < 1e-6) X.set(1, 0, 0); // strips at the poles have no "across"
      X.normalize();
      Z.crossVectors(X, Y).normalize();
      const w = 0.052 + rand() * 0.03;
      const len = 0.15 + rand() * 0.07;
      m4.makeBasis(X.multiplyScalar(w), Y.multiplyScalar(len), Z);
      m4.setPosition(p);
      m4.toArray(base, k * 16);
      fcol[k * 3] = col.r; fcol[k * 3 + 1] = col.g; fcol[k * 3 + 2] = col.b;
      burst[k * 3] = n.x * (1.6 + rand() * 1.5);
      burst[k * 3 + 1] = n.y * (1.6 + rand() * 1.5) + 0.5 + rand();
      burst[k * 3 + 2] = n.z * (1.6 + rand() * 1.5) + 0.35;
    }
  }
  return { body, cracks, shards, base, col: fcol, burst, topY };
}

/* ---------- swing ---------- */
// The rope carries two motions and they are not the same motion. `th`/`ph` are a
// pendulum's impulse response — they start at zero, they decay to zero, and only a
// blow ever feeds them, which is exactly what makes a cold `revealed` and a replay
// correct for free. The idle sway underneath is closed form, so it is already at
// full amplitude on frame one and loops forever.
const W2_SWING = 9.8 / ROPE_L;
const C_SWING = 0.55;
const TH_CAP = 0.72; // ⇒ ~0.33 rad of swing: the whole arc stays in a portrait frame
const PH_CAP = 0.6;
const PS_CAP = 3.4;
const HIT_JIG = [0.14, -0.09, 0.2, -0.16, 0.06, -0.12]; // deterministic, so a replay lands the same blows
const AUTO_X = [0.44, -0.56, 0.3, -0.38, 0.52, -0.22];

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const dummy = new THREE.Object3D();
const dcol = new THREE.Color();
const clampAbs = (x: number, c: number) => Math.min(c, Math.max(-c, x));

export default function PinataScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const pal = PALETTES[variants.palette] ?? PALETTES.fiesta;
  const shapeKey = SHAPES[variants.shape] ? variants.shape : "star";
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  const kit = useMemo(() => buildKit(shapeKey, variants.palette), [shapeKey, variants.palette]);
  useEffect(
    () => () => {
      kit.body.dispose();
      kit.cracks.dispose();
      kit.shards.dispose();
    },
    [kit],
  );

  // One uniforms bag, handed to every patched material at compile time and written
  // in useFrame. It is a ref, not a memo, because the frame owns its values and
  // only the frame ever writes them.
  const uniRef = useRef({
    uTau: { value: -1 },
    uTime: { value: 0 },
    uRip: { value: 0 },
    uRipT: { value: 0 },
    uAmp: { value: 1 },
    uHit: { value: new THREE.Vector3() },
  });

  const mats = useMemo(() => {
    const paper = () =>
      new THREE.MeshStandardMaterial({
        map: paperTex,
        vertexColors: true,
        roughness: 0.94,
        metalness: 0,
      });
    const body = paper();

    const shard = paper();
    shard.side = THREE.DoubleSide;
    shard.transparent = true;
    shard.onBeforeCompile = (sh) => {
      sh.uniforms.uTau = uniRef.current.uTau;
      sh.vertexShader = sh.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           attribute vec3 aCen; attribute vec3 aVel; attribute vec3 aAxis;
           attribute float aRate; attribute float aDelay;
           uniform float uTau; varying float vFade;`,
        )
        // the normal has to take the tumble too, or lit shards strobe as they spin
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
           float _ang = aRate * max(0.0, uTau - aDelay);
           objectNormal = objectNormal * cos(_ang) + cross(aAxis, objectNormal) * sin(_ang)
             + aAxis * dot(aAxis, objectNormal) * (1.0 - cos(_ang));`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           ${SHARD_PATCH_VERT}
           vFade = 1.0 - smoothstep(1.9, 2.6, uTau);`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vFade;")
        .replace(
          "#include <dithering_fragment>",
          "#include <dithering_fragment>\ngl_FragColor.a *= vFade;",
        );
    };

    const fringe = new THREE.MeshStandardMaterial({
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: true,
    });
    fringe.onBeforeCompile = (sh) => {
      const u = uniRef.current;
      sh.uniforms.uTime = u.uTime;
      sh.uniforms.uRip = u.uRip;
      sh.uniforms.uRipT = u.uRipT;
      sh.uniforms.uHit = u.uHit;
      sh.uniforms.uAmp = u.uAmp;
      sh.vertexShader = sh.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           attribute vec3 aWv;
           uniform float uTime; uniform float uRip; uniform float uRipT;
           uniform vec3 uHit; uniform float uAmp;`,
        )
        .replace("#include <begin_vertex>", FRINGE_PATCH);
    };

    const crack = new THREE.ShaderMaterial({
      uniforms: {
        uReveal: { value: -1 },
        uColor: { value: new THREE.Color("#170d12") },
        uLip: { value: new THREE.Color(pal.paper) },
      },
      vertexShader: CRACK_VERT,
      fragmentShader: CRACK_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const candy = new THREE.MeshStandardMaterial({
      roughness: 0.28,
      metalness: 0.05,
      transparent: true,
    });
    return { body, shard, fringe, crack, candy };
  }, [pal]);
  useEffect(
    () => () => {
      for (const m of Object.values(mats)) m.dispose();
    },
    [mats],
  );

  /* the note. `message` is "" on a gallery card and live per-keystroke in /create,
     so it must never be required and never be assumed absent. */
  const note = useMemo(() => {
    const src = message.trim() || forRecipient(lang, recipientName);
    const { texture, aspect } = makeTextTexture(src, {
      fontSize: 58,
      fontWeight: "500",
      color: pal.ink,
      maxWidthPx: 880,
      padding: 54,
      lang,
    });
    // a long message trades width for height rather than overflowing the frame
    let w = NOTE_W;
    if (aspect * w > NOTE_H_MAX) w = NOTE_H_MAX / aspect;
    return { texture, w, h: w * aspect };
  }, [message, lang, recipientName, pal]);
  useEffect(() => () => note.texture.dispose(), [note]);

  /* candy: every value here is fixed at build, so the whole rain is a closed form
     of τ and a replay is identical to the first burst */
  const candy = useMemo(() => {
    const rand = mulberry32(777001);
    const c = {
      vel: new Float32Array(CANDY_N * 3),
      ax: new Float32Array(CANDY_N * 3),
      rate: new Float32Array(CANDY_N),
      sc: new Float32Array(CANDY_N),
      del: new Float32Array(CANDY_N),
    };
    const v = new THREE.Vector3();
    for (let i = 0; i < CANDY_N; i++) {
      do {
        v.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      } while (v.lengthSq() > 1 || v.lengthSq() < 1e-4);
      v.normalize();
      v.y += 0.5;
      v.z += 0.45; // biased at the camera: sweets should come at you, not sideways
      v.normalize();
      // two thirds go out hard; the rest hang over the middle and rain down
      const fast = i % 3 !== 0;
      v.multiplyScalar(fast ? 1.5 + rand() * 3.2 : 0.4 + rand() * 1.1);
      c.vel[i * 3] = v.x; c.vel[i * 3 + 1] = v.y; c.vel[i * 3 + 2] = v.z;
      v.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      c.ax[i * 3] = v.x; c.ax[i * 3 + 1] = v.y; c.ax[i * 3 + 2] = v.z;
      c.rate[i] = (rand() * 2 - 1) * 13;
      c.sc[i] = 0.075 + rand() * 0.05;
      c.del[i] = rand() * (fast ? 0.12 : 0.6); // the rain keeps coming after the blast
    }
    return c;
  }, []);

  const fly = useMemo(() => {
    const rand = mulberry32(6060);
    const f = {
      vel: new Float32Array(FLY_N * 3),
      ax: new Float32Array(FLY_N * 3),
      rate: new Float32Array(FLY_N),
      len: new Float32Array(FLY_N),
    };
    const v = new THREE.Vector3();
    for (let i = 0; i < FLY_N; i++) {
      const a = (i / FLY_N) * Math.PI * 2 + rand() * 0.5;
      v.set(Math.cos(a), Math.sin(a) * 0.6 + 0.7, Math.sin(a * 1.7) * 0.4 + 0.5).normalize();
      v.multiplyScalar(1.5 + rand() * 1.9);
      f.vel[i * 3] = v.x; f.vel[i * 3 + 1] = v.y; f.vel[i * 3 + 2] = v.z;
      v.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      f.ax[i * 3] = v.x; f.ax[i * 3 + 1] = v.y; f.ax[i * 3 + 2] = v.z;
      f.rate[i] = (rand() * 2 - 1) * 6;
      f.len[i] = 0.7 + rand() * 0.75;
    }
    return f;
  }, []);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const ropeRef = useRef<THREE.Group>(null);
  const swingRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const shellRef = useRef<THREE.Mesh>(null);
  const crackRef = useRef<THREE.Mesh>(null);
  const shardRef = useRef<THREE.Mesh>(null);
  const fringeRef = useRef<THREE.InstancedMesh>(null);
  const hangRef = useRef<THREE.InstancedMesh>(null);
  const flyRef = useRef<THREE.InstancedMesh>(null);
  const candyRef = useRef<THREE.InstancedMesh>(null);
  const burstRef = useRef<THREE.Group>(null);
  const noteRef = useRef<THREE.Group>(null);
  const paperMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const inkMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const flashRef = useRef<THREE.Sprite>(null);
  const flashMatRef = useRef<THREE.SpriteMaterial>(null);
  const flashLightRef = useRef<THREE.PointLight>(null);
  const hintRef = useRef<THREE.Sprite>(null);
  const hintMatRef = useRef<THREE.SpriteMaterial>(null);

  const swing = useRef({ th: 0, thv: 0, ph: 0, phv: 0, ps: 0, psv: 0, pit: 0, pitv: 0 });
  const hit = useRef({ n: 0, last: -9, nextAuto: T_MERCY0, burstT: -1, ripT: 9 });
  const shake = useRef({ t: 9, a: 0, d: SHAKE_DUR });
  const fringeDirty = useRef(true);

  // Replay re-enters "opening": the clock resets, so every accumulator must too or
  // the second run arrives pre-cracked and bursts on the first touch.
  useLayoutEffect(() => {
    const s = swing.current;
    s.th = s.thv = s.ph = s.phv = s.ps = s.psv = s.pit = s.pitv = 0;
    hit.current.n = 0;
    hit.current.last = -9;
    hit.current.nextAuto = T_MERCY0;
    hit.current.burstT = -1;
    shake.current.a = 0;
    fringeDirty.current = true;
  }, [phase, kit]);

  useLayoutEffect(() => {
    fringeDirty.current = true;
    const fm = fringeRef.current;
    if (fm) {
      for (let i = 0; i < FRINGE_N; i++) {
        fm.setColorAt(i, dcol.fromArray(kit.col, i * 3));
      }
      if (fm.instanceColor) fm.instanceColor.needsUpdate = true;
    }
    // instanceColor is what carries the palette here: three defines USE_COLOR in the
    // *fragment* prefix for any instanced-coloured mesh, so setColorAt reaches
    // diffuseColor without the geometry needing a colour attribute at all.
    const sm = flyRef.current;
    if (sm) {
      for (let i = 0; i < FLY_N; i++) sm.setColorAt(i, dcol.set(pal.fringe[i % pal.fringe.length]));
      if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
    }
    const cm = candyRef.current;
    if (cm) {
      // sweets are the one thing in here nobody mistakes for paper, so they get the
      // palette's own confectionery, not the fringe's
      for (let i = 0; i < CANDY_N; i++) cm.setColorAt(i, dcol.set(pal.candy[i % pal.candy.length]));
      if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
    }
    // the scraps the burst leaves knotted to the rope — the aftermath's only live thing
    const hm = hangRef.current;
    if (hm) {
      const rand = mulberry32(4242);
      for (let i = 0; i < HANG_N; i++) {
        const a = (i / HANG_N) * Math.PI * 2;
        // spread off the knot rather than bunched on it, so they clear the note
        dummy.position.set(Math.cos(a) * 0.14, 0.02, Math.sin(a) * 0.1);
        dummy.rotation.set(0, a, (rand() - 0.5) * 0.6);
        dummy.scale.set(0.05 + rand() * 0.03, 0.26 + rand() * 0.22, 1);
        dummy.updateMatrix();
        hm.setMatrixAt(i, dummy.matrix);
        hm.setColorAt(i, dcol.set(pal.fringe[i % pal.fringe.length]));
      }
      hm.instanceMatrix.needsUpdate = true;
      if (hm.instanceColor) hm.instanceColor.needsUpdate = true;
    }
  }, [kit, pal]);

  /* ---------- the blow ---------- */
  const land = (hx: number, hy: number, hz: number, now: number, power: number) => {
    const st = hit.current;
    const s = swing.current;
    const i = st.n;
    st.n += 1;
    st.last = now;
    st.nextAuto = now + T_MERCY0;
    const hxn = clampAbs(hx / BODY_R, 1);
    const hyn = clampAbs(hy / BODY_R, 1);
    // A tap is a poke straight into the screen at the point they touched. The
    // linear part knocks it away; the moment arm about the rope is what spins it,
    // so a hit on the nose only swings and a hit on the ear whips it round.
    s.thv = clampAbs(s.thv + (0.85 * hxn + HIT_JIG[i % HIT_JIG.length]) * power, TH_CAP);
    s.phv = clampAbs(s.phv + (0.95 + 0.3 * (1 - Math.abs(hxn))) * power, PH_CAP);
    s.psv = clampAbs(s.psv + 3.6 * hxn * power, PS_CAP);
    s.pitv = clampAbs(s.pitv - 1.3 * hyn * power, 1.6);
    uniRef.current.uHit.value.set(hx, hy, hz);
    st.ripT = 0;
    shake.current.t = 0;
    shake.current.a = power;
    shake.current.d = SHAKE_DUR;
    if (st.n >= HITS_NEEDED) {
      st.burstT = now;
      shake.current.a = 1.5;
      shake.current.d = BURST_SHAKE;
      s.phv -= 1.5; // the rope loses its load and snaps back
    }
  };

  const onTap = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || hit.current.n >= HITS_NEEDED) return;
    bodyRef.current?.worldToLocal(tmpV.copy(ev.point));
    land(tmpV.x, tmpV.y, tmpV.z, tRef.current, 1);
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const st = hit.current;
    const s = swing.current;

    /* ---- who is driving: taps, the mercy, or nothing at all ---- */
    let hits: number;
    let since: number;
    let tau: number; // burst clock; < 0 until the shell goes
    if (phase === "opening") {
      // The mercy is the no-input path's alone, and it reads as the shell tiring
      // rather than a timer: the gaps between the blows it lands close on their own.
      if (st.n < HITS_NEEDED && t >= st.nextAuto) {
        const g = MERCY_GAPS[Math.min(st.n, MERCY_GAPS.length - 1)];
        land(AUTO_X[st.n % AUTO_X.length] * BODY_R, -0.1, 0.5, t, 0.62);
        st.nextAuto = t + g;
      }
      hits = st.n;
      since = t - st.last;
      tau = st.burstT >= 0 ? Math.min(t - st.burstT, TAU_HOLD) : -1;
    } else if (phase === "revealed") {
      // a complete tableau from `phase` alone — reduced motion lands here cold
      hits = HITS_NEEDED;
      since = 9;
      tau = TAU_HOLD;
    } else {
      // sealed and preview are the same picture: the gift whole, unbroken, swinging.
      hits = 0;
      since = 9;
      tau = -1;
    }
    const burst = tau >= 0;
    const shell = !burst;

    /* ---- fit the action into the viewport, every frame: the canvas is not the
       window and its aspect jumps the instant the reveal mounts the message ---- */
    const fitS = Math.max(0.58, Math.min(1, state.viewport.width / ACTION_W));
    fitRef.current?.scale.setScalar(fitS);
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.05, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.07, k);
    }

    /* ---- the rope ---- */
    // impulse response only: fed by blows, decaying to nothing
    s.thv += (-W2_SWING * Math.sin(s.th) - C_SWING * s.thv) * dt;
    s.th += s.thv * dt;
    s.phv += (-W2_SWING * Math.sin(s.ph) - C_SWING * s.phv) * dt;
    s.ph += s.phv * dt;
    s.psv += (-1.9 * s.ps - 0.42 * s.psv) * dt; // torsion: it winds up and unwinds slowly
    s.ps += s.psv * dt;
    s.pitv += (-6.2 * s.pit - 1.7 * s.pitv) * dt;
    s.pit += s.pitv * dt;
    // …and over the top, the draft in the room, which never dies and never needs to
    // spin up. Backed off while it is being hit, so the blows are what you read, and
    // leaned on in preview, which has nothing but this to say the gift is alive.
    const draft = phase === "opening" ? 0.3 : phase === "preview" ? PREV_SWAY : 1;
    const dth = (0.05 * Math.sin(e * 0.83) + 0.022 * Math.sin(e * 1.31 + 1.7)) * draft;
    const dph = 0.028 * Math.sin(e * 0.61 + 0.4) * draft;
    // The turn is what says the form is solid and not a decal, but past ~20° a star
    // stops reading as a star and the silhouette is the whole variant — so the draft
    // leans on the swing and only ever breathes on the torsion.
    const dps =
      (0.16 * Math.sin(e * 0.37) + 0.07 * Math.sin(e * 0.23 + 2.1)) * Math.min(draft, 1.4);
    if (ropeRef.current) ropeRef.current.rotation.set(s.ph + dph, 0, s.th + dth);
    // frozen at the burst: the debris keeps the pose the shell died in, and the
    // rope above it carries on swinging without it
    if (swingRef.current && !burst) swingRef.current.rotation.set(s.ph + dph, 0, s.th + dth);
    if (bodyRef.current && !burst) {
      bodyRef.current.rotation.set(s.pit, s.ps + dps, 0);
      // the burst origin tracks the belly until there is no belly; after that it
      // holds where the shell was, which is what everything else flies from
      if (burstRef.current?.parent) {
        bodyRef.current.getWorldPosition(tmpV);
        burstRef.current.parent.worldToLocal(tmpV);
        burstRef.current.position.copy(tmpV);
      }
    }

    /* ---- cracks: a pure function of the hit count, so they persist and replay ---- */
    // Materials are reached through the objects that carry them, never through the
    // memo binding: the memo owns construction and disposal, the frame owns state.
    const crackMat = crackRef.current?.material as THREE.ShaderMaterial | undefined;
    if (crackMat) crackMat.uniforms.uReveal.value = hits - 1 + clamp01(since / CRACK_GROW);
    if (shellRef.current) shellRef.current.visible = shell;
    if (crackRef.current) crackRef.current.visible = shell && hits > 0;

    /* ---- fringe ---- */
    st.ripT += dt;
    const u = uniRef.current;
    u.uTime.value = e;
    u.uRipT.value = st.ripT;
    u.uRip.value = Math.exp(-st.ripT * 5.5) * (hits > 0 ? 1 : 0);
    u.uAmp.value = phase === "sealed" ? 0.7 : 1;
    u.uTau.value = tau;
    const fm = fringeRef.current;
    if (fm) {
      fm.visible = tau < 2.6;
      if (burst || fringeDirty.current) {
        const f = Math.max(0, tau);
        for (let i = 0; i < FRINGE_N; i++) {
          tmpM.fromArray(kit.base, i * 16);
          if (f > 0) {
            tmpM.elements[12] += kit.burst[i * 3] * f;
            tmpM.elements[13] += kit.burst[i * 3 + 1] * f - 0.5 * G * f * f;
            tmpM.elements[14] += kit.burst[i * 3 + 2] * f;
          }
          fm.setMatrixAt(i, tmpM);
        }
        fm.instanceMatrix.needsUpdate = true;
        fringeDirty.current = burst; // one last write at f=0 restores the rest pose
      }
    }

    /* ---- the shell coming apart ---- */
    if (shardRef.current) shardRef.current.visible = burst && tau < 2.6;
    if (hangRef.current) hangRef.current.visible = burst;

    /* ---- candy ---- */
    const cm = candyRef.current;
    if (cm) {
      cm.visible = burst && tau < 2.9;
      if (cm.visible) {
        for (let i = 0; i < CANDY_N; i++) {
          const ft = tau - candy.del[i];
          if (ft <= 0) {
            dummy.scale.setScalar(0);
          } else {
            dummy.position.set(
              candy.vel[i * 3] * ft,
              candy.vel[i * 3 + 1] * ft - 0.5 * G * ft * ft,
              candy.vel[i * 3 + 2] * ft,
            );
            tmpV.fromArray(candy.ax, i * 3);
            dummy.quaternion.setFromAxisAngle(tmpV, candy.rate[i] * ft);
            dummy.scale.setScalar(candy.sc[i] * Math.min(1, ft / 0.05));
          }
          dummy.updateMatrix();
          cm.setMatrixAt(i, dummy.matrix);
        }
        cm.instanceMatrix.needsUpdate = true;
      }
      (cm.material as THREE.MeshStandardMaterial).opacity = 1 - smooth(clamp01((tau - 2.0) / 0.9));
    }

    /* ---- streamers ---- */
    const sm = flyRef.current;
    if (sm) {
      sm.visible = burst && tau < 3.3;
      if (sm.visible) {
        // they share the fringe's material with the rope's scraps, which have to
        // outlive them, so a streamer bows out on its own scale, not on opacity
        const fade = 1 - smooth(clamp01((tau - 2.6) / 0.7));
        for (let i = 0; i < FLY_N; i++) {
          dummy.position.set(
            fly.vel[i * 3] * tau,
            fly.vel[i * 3 + 1] * tau - 0.5 * G * 0.55 * tau * tau, // paper, so it hangs
            fly.vel[i * 3 + 2] * tau,
          );
          tmpV.fromArray(fly.ax, i * 3);
          dummy.quaternion.setFromAxisAngle(tmpV, fly.rate[i] * tau);
          dummy.scale.set(0.06 * fade, fly.len[i] * Math.min(1, tau / 0.12) * fade, 1);
          dummy.updateMatrix();
          sm.setMatrixAt(i, dummy.matrix);
        }
        sm.instanceMatrix.needsUpdate = true;
      }
    }

    /* ---- the note ---- */
    const nk = burst ? smooth(clamp01((tau - 0.15) / (TAU_HOLD - 0.15))) : 0;
    const ng = noteRef.current;
    if (ng) {
      ng.visible = nk > 0.001;
      if (ng.visible && burstRef.current) {
        const b = burstRef.current.position;
        const tx = -b.x;
        const ty = NOTE_Y - b.y;
        const tz = NOTE_Z - b.z;
        const sw = (1 - nk) * (1 - nk); // the spiral tightens as it falls
        const ec = easeOutCubic(nk);
        ng.position.set(
          lerp(0, tx, ec) + Math.cos(nk * 11) * 0.45 * sw,
          // it is thrown up with everything else and only then flutters down
          lerp(0, ty, nk) + Math.sin(nk * Math.PI) * 0.55 + Math.sin(e * 0.8) * 0.012 * nk,
          lerp(0, tz, ec) + Math.sin(nk * 11) * 0.3 * sw,
        );
        // every term lands exactly on the revealed pose at nk = 1, so the flip to
        // "revealed" has nothing to pop
        ng.rotation.set(
          0.85 * Math.pow(1 - nk, 2),
          22 * Math.pow(1 - nk, 2.5) + Math.sin(e * 0.5 + 1) * 0.03 * nk,
          0.7 * Math.pow(1 - nk, 2) * Math.sin(nk * 13) + Math.sin(e * 0.7) * 0.014 * nk,
        );
        // The note is the one thing that has to stay whole, and it does not live at
        // z=0 — `viewport` measures the frustum there, and the note sits nearer the
        // camera where it is narrower. Measure at its own depth, every frame: this
        // canvas runs from aspect 0.46 to 2.53 and jumps between them at the reveal.
        const nz = NOTE_Z * fitS;
        const k = (CAM_Z - nz) / CAM_Z;
        const fitW = (state.viewport.width * k * 0.9) / (note.w * 1.12 * fitS);
        const fitH = (state.viewport.height * k * 0.86) / ((note.h + 0.22) * fitS);
        // It leaves the shell as a folded scrap and opens on the way down. Held big
        // and half-opaque it was a grey slab hanging in the middle of the confetti;
        // small and solid, it reads as the one real thing in the air.
        ng.scale.setScalar(
          lerp(0.16, 1, easeOutBack(clamp01(nk * 1.5))) * Math.min(1, fitW, fitH),
        );
      }
    }
    // opaque almost at once: a translucent note is a smudge, never a note
    const na = clamp01(nk * 8);
    if (paperMatRef.current) paperMatRef.current.opacity = na;
    if (inkMatRef.current) inkMatRef.current.opacity = na;

    /* ---- the flash, faked the house way: additive sprite + a point light ---- */
    const fl = burst ? Math.exp(-tau * 9) : 0;
    if (flashRef.current) flashRef.current.scale.setScalar(0.6 + easeOutCubic(clamp01(tau / 0.3)) * 3.4);
    if (flashMatRef.current) flashMatRef.current.opacity = fl * 0.9;
    if (flashLightRef.current) flashLightRef.current.intensity = fl * 9;

    /* ---- a nudge, until they take the hint ---- */
    const hintA = phase === "opening" && hits === 0 ? clamp01((t - 0.7) / 0.6) : 0;
    if (hintRef.current) hintRef.current.scale.setScalar(0.5 + 0.35 * Math.sin(e * 3.4));
    if (hintMatRef.current) hintMatRef.current.opacity = hintA * (0.28 + 0.16 * Math.sin(e * 3.4));

    /* ---- the hit, in the camera ---- */
    // Short and sharp: at 120ms this is a knock you feel; stretch it and it becomes
    // an earthquake the piñata is standing in.
    const sk = shake.current;
    sk.t += dt;
    const cam = camRef.current;
    if (cam) {
      const env = sk.a * Math.pow(Math.max(0, 1 - sk.t / sk.d), 2);
      cam.position.set(
        Math.sin(sk.t * 232) * 0.08 * env,
        CAM_Y + Math.sin(sk.t * 187 + 1.1) * 0.062 * env,
        CAM_Z + Math.sin(sk.t * 151 + 2.3) * 0.05 * env,
      );
      cam.rotation.z = Math.sin(sk.t * 205) * 0.017 * env;
    }

    if (phase === "opening" && burst && tau >= TAU_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const ropeLen = ROPE_L - kit.topY * 0.55;

  return (
    <>
      <PerspectiveCamera
        ref={camRef}
        makeDefault
        position={[0, CAM_Y, CAM_Z]}
        fov={FOV}
        onUpdate={(c) => c.lookAt(0, 0.02, 0)}
      />
      <ambientLight intensity={0.55} color="#fff0dd" />
      <directionalLight position={[-2.2, 3.4, 3.2]} intensity={1.7} color={pal.key} />
      <directionalLight position={[3.0, -0.6, -2.4]} intensity={0.75} color={pal.fill} />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the rope, which outlives the piñata */}
          <group ref={ropeRef} position={[0, PIVOT_Y, 0]}>
            {/* knot at -ropeLen, top at +ROPE_ABOVE — well past the pivot it turns on */}
            <mesh position={[0, (ROPE_ABOVE - ropeLen) / 2, 0]}>
              <cylinderGeometry args={[0.021, 0.021, ropeLen + ROPE_ABOVE, 8, 1, true]} />
              <meshStandardMaterial map={ropeTex} roughness={0.95} side={THREE.DoubleSide} />
            </mesh>
            <mesh position={[0, -ropeLen, 0]}>
              <sphereGeometry args={[0.045, 10, 8]} />
              <meshStandardMaterial color={pal.rope} roughness={0.9} />
            </mesh>
            {/* the scraps left knotted to it */}
            <instancedMesh
              ref={hangRef}
              args={[hangGeo, mats.fringe, HANG_N]}
              position={[0, -ropeLen, 0]}
              visible={false}
              frustumCulled={false}
            />
          </group>

          {/* the piñata, and everything it turns into */}
          <group ref={swingRef} position={[0, PIVOT_Y, 0]}>
            <group ref={bodyRef} position={[0, -ROPE_L, 0]}>
              <mesh ref={shellRef} geometry={kit.body} material={mats.body} />
              <mesh ref={crackRef} geometry={kit.cracks} material={mats.crack} visible={false} />
              <mesh
                ref={shardRef}
                geometry={kit.shards}
                material={mats.shard}
                visible={false}
                frustumCulled={false}
              />
              <instancedMesh
                ref={fringeRef}
                args={[fringeGeo, mats.fringe, FRINGE_N]}
                frustumCulled={false}
              />
              <sprite ref={hintRef} position={[0, 0, BODY_R * 0.9]} scale={0.5}>
                <spriteMaterial
                  map={glowTex}
                  color="#ffffff"
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
              {/* three r185 raycasts straight through `visible={false}`, so an
                  invisible target has to be a transparent one. It swings with the
                  piñata — hitting a moving thing is the entire game. */}
              {phase === "opening" && (
                <mesh onPointerDown={onTap}>
                  <sphereGeometry args={[HIT_R, 16, 12]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
              )}
            </group>
          </group>

          {/* the burst: parked where the shell was, in world axes */}
          <group ref={burstRef} position={[0, BODY_Y, 0]}>
            <instancedMesh
              ref={candyRef}
              args={[candyGeo, mats.candy, CANDY_N]}
              visible={false}
              frustumCulled={false}
            />
            <instancedMesh
              ref={flyRef}
              args={[flyGeo, mats.fringe, FLY_N]}
              visible={false}
              frustumCulled={false}
            />
            <sprite ref={flashRef} scale={0.6}>
              <spriteMaterial
                ref={flashMatRef}
                map={glowTex}
                color="#fff6dc"
                transparent
                opacity={0}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </sprite>
            <pointLight ref={flashLightRef} intensity={0} color="#fff2d0" distance={7} decay={1.6} />

            {/* the one thing that is not confetti */}
            <group ref={noteRef} visible={false}>
              <mesh>
                <planeGeometry args={[note.w * 1.12, note.h + 0.22]} />
                <meshStandardMaterial
                  ref={paperMatRef}
                  color={pal.paper}
                  map={notePaperTex}
                  roughness={0.96}
                  side={THREE.DoubleSide}
                  transparent
                  opacity={0}
                />
              </mesh>
              <mesh position={[0, 0, 0.005]}>
                <planeGeometry args={[note.w, note.h]} />
                <meshBasicMaterial
                  ref={inkMatRef}
                  map={note.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                />
              </mesh>
            </group>
          </group>
        </group>
      </group>
    </>
  );
}


