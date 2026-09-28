import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeTextTexture, sampleTextPoints, type TextPoints, type TextTexture } from "../text3d";
import { radialBlob } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import { pick } from "../catalog";
import type { Lang } from "../../i18n";

/* ===========================================================================
   MA'AMOUL — Eid morning on a kitchen board. A carved wooden mold, a ball of
   dough, a sieve of powdered sugar. The dough goes into the carving, the mold
   turns over, and three knocks on the board drop the cookie out with the
   pattern crisp on its dome. Then the sieve passes over and the sugar settles
   into the recipient's name and the message.

   Everything visible is a closed form of (phase, opening clock, three event
   times): `revealed` is written straight from its phase, which is also the
   frame reduced motion lands on.
   =========================================================================== */

const TAU = Math.PI * 2;
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
/** Heading whose local +x points along (dx, dz) on the board. */
const yawOf = (dx: number, dz: number) => Math.atan2(-dz, dx);
function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * k;
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* ---------- the mold: its shape is the filling ---------- */
// Grandmothers read the filling off the shape before anyone bites: a round flat
// cushion is dates, an oval is pistachio, a tall dome is walnut. So the variant is
// the cup's profile, and the cookie is that same profile turned inside out.
// The dome is a superellipse, r^n + h^m = 1: `n` squares the shoulder, `m` flattens
// the crown. `sx` stretches the whole head along the paddle for the oval.
type PatternKind = "rosette" | "leaf" | "flutes";
interface Shape {
  rc: number; // cup radius (before the oval stretch)
  depth: number; // cup depth = the cookie's dome height
  n: number;
  m: number;
  sx: number;
  taper: number; // how much narrower the back of the head is than its face
  pattern: PatternKind;
}
const SHAPES: Record<string, Shape> = {
  date: { rc: 0.27, depth: 0.1, n: 2.4, m: 2.6, sx: 1, taper: 0.95, pattern: "rosette" },
  pistachio: { rc: 0.19, depth: 0.115, n: 2, m: 2, sx: 1.6, taper: 0.94, pattern: "leaf" },
  walnut: { rc: 0.215, depth: 0.25, n: 1.35, m: 1.15, sx: 1, taper: 0.8, pattern: "flutes" },
};
const HANDLE_L = 0.62;
const HANDLE_T = 0.075;
const HANDLE_BEV = 0.012;

/* ---------- the board ---------- */
// Walnut and marble are the dark boards white sugar was made for; olive is the
// family board, lighter, with its wild wavy figure, kept mid-toned so the sugar
// still reads on it.
interface BoardDef {
  kind: "walnut" | "olive" | "marble";
  rough: number;
  env: number;
}
const BOARDS: Record<string, BoardDef> = {
  walnut: { kind: "walnut", rough: 0.66, env: 0.12 },
  olive: { kind: "olive", rough: 0.58, env: 0.14 },
  marble: { kind: "marble", rough: 0.2, env: 0.6 },
};

/* ---------- layout ---------- */
// Two stagings of one board. A phone in portrait gets a tall board with the words
// wrapped narrow down its middle and the cookie beneath them; anything wide lays
// the words out long with the cookie to one side. Everything is in board space:
// +x right, +z toward the viewer, the board's top at y = 0.
interface Frame {
  x: number;
  z: number;
  w: number;
  d: number;
  el: number; // camera elevation, radians
}
interface Layout {
  key: "wide" | "tall";
  board: { x: number; z: number; w: number; d: number };
  msg: { x: number; z: number; w: number; d: number; maxFont: number };
  cookie: [number, number]; // where the mold is knocked, and so where the cookie stays
  moldYaw: number;
  rest: [number, number]; // where the mold is set down afterwards, carving up
  restYaw: number;
  ball: [number, number];
  sieve: [number, number];
  sieveYaw: number;
  plate: [number, number];
  pool: { x: number; z: number; w: number; d: number; yaw: number };
  motes: { x0: number; x1: number; z0: number; z1: number };
  cams: { preview: Frame; sealed: Frame; knock: Frame; reveal: Frame };
}
const WIDE: Layout = {
  key: "wide",
  board: { x: 0.1, z: 0, w: 4.9, d: 3.1 },
  msg: { x: 0.3, z: 0.0, w: 2.5, d: 1.5, maxFont: 0.19 },
  cookie: [-1.5, 0.3],
  moldYaw: yawOf(-0.62, 0.78),
  rest: [1.95, 0.72],
  restYaw: yawOf(0.52, 0.85),
  ball: [-0.8, 0.86],
  sieve: [1.8, -0.95],
  sieveYaw: yawOf(0.8, -0.6),
  plate: [-1.55, -0.95],
  pool: { x: -1.0, z: -0.55, w: 2.8, d: 2.0, yaw: 0.4 },
  motes: { x0: -2.3, x1: 0.5, z0: -1.5, z1: 0.7 },
  cams: {
    preview: { x: -1.0, z: -0.12, w: 2.9, d: 2.8, el: 0.86 },
    sealed: { x: 0.1, z: 0.0, w: 4.9, d: 3.1, el: 0.92 },
    knock: { x: -1.3, z: 0.3, w: 2.7, d: 2.1, el: 0.98 },
    reveal: { x: 0.25, z: 0.05, w: 4.4, d: 2.35, el: 1.18 },
  },
};
const TALL: Layout = {
  key: "tall",
  board: { x: 0, z: 0.05, w: 2.75, d: 4.8 },
  msg: { x: 0, z: -0.25, w: 1.75, d: 2.15, maxFont: 0.17 },
  cookie: [-0.48, 1.5],
  moldYaw: yawOf(-0.45, 0.89),
  rest: [0.5, 1.45],
  restYaw: yawOf(0.5, 0.87),
  ball: [0.34, 1.0],
  sieve: [0.62, -1.85],
  sieveYaw: yawOf(0.7, -0.7),
  plate: [-0.6, -1.85],
  pool: { x: -0.5, z: -1.55, w: 2.0, d: 2.6, yaw: 0.35 },
  motes: { x0: -1.3, x1: 0.9, z0: -2.2, z1: 0.6 },
  cams: {
    preview: { x: -0.15, z: 1.0, w: 2.3, d: 2.6, el: 0.9 },
    sealed: { x: 0, z: 0.05, w: 2.7, d: 4.7, el: 0.96 },
    knock: { x: -0.3, z: 1.25, w: 2.1, d: 2.2, el: 1.0 },
    reveal: { x: 0, z: 0.22, w: 2.0, d: 3.7, el: 1.18 },
  },
};
const TALL_BELOW = 1.1; // width/height under this stages the tall board

/* ---------- camera ---------- */
const FOV = 36;
const TAN_H = Math.tan((FOV * Math.PI) / 360);

/* ---------- opening timeline (seconds on the opening clock) ---------- */
// No-input path: dough in and turned over by READY (1.9), the invisible hand starts
// knocking at IDLE0 (6.5) and the cookie is out by ~8.4; the sieve crosses and the
// last grain lands ~5.5s later. A recipient who knocks straight away is done by ~9s.
const BALL_T0 = 0.35; // the ball hops into the carving…
const BALL_DUR = 0.55;
const PRESS_DUR = 0.22; // …and is pressed flush
const PLUG_AT = BALL_T0 + BALL_DUR + PRESS_DUR;
const FLIP_T0 = PLUG_AT + 0.12; // then the mold turns over onto its face
const FLIP_DUR = 0.62;
const READY = FLIP_T0 + FLIP_DUR;
const K_LIFT = 0.15; // one knock: up…
const IMPACT = 0.23; // …down onto the board…
const KNOCK_DUR = 0.5; // …and the little jump it takes off the wood
const IDLE0 = 6.5; // seconds without a tap before a hand that is not there knocks for them
const GHOST_GAP = 0.3;
const OUT_HOLD = 0.32; // a beat after the third knock before the mold comes away
const LIFT_DUR = 1.05; // …carried to the side and set down carving-up
const SIEVE_IN = 0.95;
const SIEVE_OUT = 0.9;
const SWEEP_LEAD = OUT_HOLD + LIFT_DUR + 0.15 + SIEVE_IN;
const FALL_MAX = 0.92;
const END_HOLD = 0.75;
const SIEVE_Y = 0.6; // the sieve's height over the board while it sifts
const SIEVE_R = 0.3;
const TAP_EVERY = 0.38; // the unseen hand taps the rim this often

/* ---------- procedural textures: small helpers ---------- */
function canvas2d(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d")! };
}
function srgb(t: THREE.CanvasTexture, aniso = 4) {
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}
/** A wavy stroke across the canvas along x — grain, veins, growth rings. */
function wavy(
  g: CanvasRenderingContext2D,
  W: number,
  y0: number,
  amp: number,
  freq: number,
  ph: number,
  step = 16,
) {
  g.beginPath();
  for (let x = -step; x <= W + step; x += step) {
    const y = y0 + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 2.7 + ph * 1.7) * amp * 0.3;
    if (x === -step) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/** Separable box blur on a square height field. Two passes read as a soft gaussian. */
function boxBlur(src: Float32Array, S: number, r: number): Float32Array {
  const tmp = new Float32Array(S * S);
  const out = new Float32Array(S * S);
  const w = 2 * r + 1;
  for (let y = 0; y < S; y++) {
    const row = y * S;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(S - 1, Math.max(0, k))];
    for (let x = 0; x < S; x++) {
      tmp[row + x] = acc / w;
      acc += src[row + Math.min(S - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < S; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(S - 1, Math.max(0, k)) * S + x];
    for (let y = 0; y < S; y++) {
      out[y * S + x] = acc / w;
      acc += tmp[Math.min(S - 1, y + r + 1) * S + x] - tmp[Math.max(0, y - r) * S + x];
    }
  }
  return out;
}

/* ---------- the carving ---------- */
// One canvas per mold, drawn once as a height field (white = where the knife went
// deepest into the wood = where the cookie stands proudest). The same field is the
// normal map on both sides of the knock: the cup wears it inverted, the cookie
// upright, so the dome is exactly the carving turned inside out. The cup's rim maps
// to the canvas edge through a planar top-down UV; the last tenth is left plain
// for the cookie's shoulder.
const PAT = 512;
function drawCarving(g: CanvasRenderingContext2D, kind: PatternKind) {
  const S = PAT;
  const c = S / 2;
  const R = S / 2;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  const dot = (x: number, y: number, r: number) => {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  };
  // A pointed almond from r0 to r1 along `ang`, `w` wide at its belly.
  const almond = (ang: number, r0: number, r1: number, w: number) => {
    g.save();
    g.translate(c, c);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(r0, 0);
    g.quadraticCurveTo((r0 + r1) / 2, -w, r1, 0);
    g.quadraticCurveTo((r0 + r1) / 2, w, r0, 0);
    g.fill();
    g.restore();
  };
  const spoke = (ang: number, r0: number, r1: number, lw: number) => {
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(c + Math.cos(ang) * r0, c + Math.sin(ang) * r0);
    g.lineTo(c + Math.cos(ang) * r1, c + Math.sin(ang) * r1);
    g.stroke();
  };

  if (kind === "rosette") {
    // the date mold: an eight-petal rosette, a bead ring, a knot at the heart
    dot(c, c, R * 0.08);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      almond(a, R * 0.19, R * 0.64, R * 0.14);
      almond(a + Math.PI / 8, R * 0.4, R * 0.62, R * 0.05);
      const b = a + Math.PI / 8;
      dot(c + Math.cos(b) * R * 0.16, c + Math.sin(b) * R * 0.16, R * 0.03);
    }
    g.lineWidth = R * 0.03;
    g.beginPath();
    g.arc(c, c, R * 0.72, 0, TAU);
    g.stroke();
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * TAU;
      dot(c + Math.cos(a) * R * 0.81, c + Math.sin(a) * R * 0.81, R * 0.032);
    }
    // a vein down each petal, cut back out of it
    g.strokeStyle = "#000";
    for (let i = 0; i < 8; i++) spoke((i / 8) * TAU, R * 0.27, R * 0.57, R * 0.022);
  } else if (kind === "leaf") {
    // the pistachio mold: a leaf. Drawn round; the oval stretches it along the paddle.
    g.lineWidth = R * 0.055;
    g.beginPath();
    g.moveTo(c - R * 0.74, c);
    g.lineTo(c + R * 0.74, c);
    g.stroke();
    g.lineWidth = R * 0.04;
    for (let i = -5; i <= 5; i++) {
      const x = c + i * R * 0.125;
      const span = R * 0.52 * Math.sqrt(Math.max(0, 1 - Math.pow((i * 0.125) / 0.78, 2)));
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(x + R * 0.02, c);
        g.lineTo(x - span * 0.5, c + s * span);
        g.stroke();
      }
    }
    g.lineWidth = R * 0.028;
    g.beginPath();
    g.arc(c, c, R * 0.7, 0, TAU);
    g.stroke();
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      dot(c + Math.cos(a) * R * 0.81, c + Math.sin(a) * R * 0.81, R * 0.034);
    }
  } else {
    // the walnut mold: ribs running up a tall dome to a knot at the top
    dot(c, c, R * 0.085);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      almond(a, R * 0.1, R * 0.86, R * 0.045);
      const b = a + Math.PI / 16;
      dot(c + Math.cos(b) * R * 0.66, c + Math.sin(b) * R * 0.66, R * 0.024);
    }
  }
}

interface Carving {
  h: Float32Array; // crisp-edged height, 0..1
  ao: Float32Array; // wide blur of it: where a groove sits in the shadow of a ridge
}
function buildCarving(kind: PatternKind): Carving {
  const { g } = canvas2d(PAT, PAT);
  drawCarving(g, kind);
  const data = g.getImageData(0, 0, PAT, PAT).data;
  const raw = new Float32Array(PAT * PAT);
  for (let i = 0; i < raw.length; i++) raw[i] = data[i * 4] / 255;
  // Two light passes round the knife edges without losing the crispness; a wide
  // one is the cavity term the colour maps darken the grooves with.
  const h = boxBlur(boxBlur(raw, PAT, 2), PAT, 2);
  const ao = boxBlur(boxBlur(h, PAT, 7), PAT, 7);
  return { h, ao };
}

/** Tangent-space normals from the height field: n = (-dh/du, -dh/dv, 1). */
function normalMapFrom(cv: Carving, k: number): THREE.CanvasTexture {
  const S = PAT;
  const { c, g } = canvas2d(S, S);
  const img = g.createImageData(S, S);
  const d = img.data;
  const h = cv.h;
  for (let y = 0; y < S; y++) {
    const yu = Math.max(0, y - 1) * S;
    const yd = Math.min(S - 1, y + 1) * S;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const du = (h[y * S + Math.min(S - 1, x + 1)] - h[y * S + Math.max(0, x - 1)]) * k;
      // canvas rows run down, v runs up (the texture is flipped on upload)
      const dv = (h[yu + x] - h[yd + x]) * k;
      const inv = 1 / Math.sqrt(du * du + dv * dv + 1);
      d[i * 4] = (-du * inv * 0.5 + 0.5) * 255;
      d[i * 4 + 1] = (-dv * inv * 0.5 + 0.5) * 255;
      d[i * 4 + 2] = (inv * 0.5 + 0.5) * 255;
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** A colour map written per pixel from the carving (+ a noise per pixel). */
function colorMapFrom(
  cv: Carving,
  seed: number,
  shade: (h: number, cav: number, n: number, x: number, y: number) => [number, number, number],
): THREE.CanvasTexture {
  const S = PAT;
  const { c, g } = canvas2d(S, S);
  const img = g.createImageData(S, S);
  const d = img.data;
  const rand = mulberry32(seed);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      // the cavity: how much lower this pixel is than its neighbourhood
      const cav = Math.max(0, cv.ao[i] - cv.h[i]);
      const [r, gg, b] = shade(cv.h[i], cav, rand(), x, y);
      d[i * 4] = r;
      d[i * 4 + 1] = gg;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return srgb(new THREE.CanvasTexture(c));
}

/* ---------- lathe geometry with top-down UVs ---------- */
// LatheGeometry's own UVs run around and along the profile, which would wrap a
// flat carving round the cup like a label. Everything carved gets a planar
// projection from above instead; `plain` profile points (the cookie's flat base)
// are pinned to the canvas corner, where the carving is not.
function lathe(
  profile: [number, number][],
  seg: number,
  uvScale: number,
  plain: number,
): THREE.LatheGeometry {
  const geo = new THREE.LatheGeometry(profile.map(([r, y]) => V2(r, y)), seg);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const P = profile.length;
  for (let i = 0; i < pos.count; i++) {
    if (i % P < plain) uv.setXY(i, 0.02, 0.02);
    else uv.setXY(i, pos.getX(i) * uvScale + 0.5, 0.5 - pos.getZ(i) * uvScale);
  }
  return geo;
}

/** The superellipse dome from the rim (s=1, h=0) to the crown (s=0, h=1). */
function domePoints(sh: Shape, R: number, D: number, y0: number, sign: number, N = 26): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * (Math.PI / 2);
    const s = Math.pow(Math.cos(th), 2 / sh.n);
    const h = Math.pow(Math.sin(th), 2 / sh.m);
    pts.push([R * s, y0 + sign * D * h]);
  }
  return pts;
}

interface ShapeAssets {
  shape: Shape;
  rh: number; // head radius
  headH: number; // head thickness, front face to back
  shellGeo: THREE.BufferGeometry;
  cupGeo: THREE.BufferGeometry;
  handleGeo: THREE.BufferGeometry;
  cookieGeo: THREE.BufferGeometry;
  cupMat: THREE.MeshStandardMaterial;
  rawMat: THREE.MeshStandardMaterial;
  bakedMat: THREE.MeshStandardMaterial;
}

/* ---------- the mold's wood: pale beech, handled for forty years ---------- */
function buildMoldWood(): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = "#c29868";
  g.fillRect(0, 0, W, H);
  const rand = mulberry32(5150);
  for (let i = 0; i < 200; i++) {
    const dark = rand() < 0.6;
    g.strokeStyle = dark ? `rgba(128,86,48,${0.08 + rand() * 0.2})` : `rgba(232,200,150,${0.08 + rand() * 0.16})`;
    g.lineWidth = 0.6 + rand() * 2.4;
    wavy(g, W, rand() * H, 1 + rand() * 4, 0.006 + rand() * 0.01, rand() * TAU);
  }
  for (let i = 0; i < 5; i++) {
    g.strokeStyle = `rgba(110,72,40,${0.12 + rand() * 0.12})`;
    g.lineWidth = 6 + rand() * 12;
    wavy(g, W, rand() * H, 3 + rand() * 5, 0.004 + rand() * 0.004, rand() * TAU);
  }
  const t = srgb(new THREE.CanvasTexture(c));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.3, 1.3);
  return t;
}
const moldWoodTex = buildMoldWood();
const moldWoodMat = new THREE.MeshStandardMaterial({ map: moldWoodTex, roughness: 0.7, metalness: 0 });

/* A wood grain value for the cup's colour map, in the carving's pixel space. */
const grainAt = (x: number, y: number, n: number) =>
  0.5 + 0.5 * Math.sin(y * 0.07 + Math.sin(x * 0.011) * 2.6 + n * 0.5);

function buildShapeAssets(sh: Shape, seed: number): ShapeAssets {
  const cv = buildCarving(sh.pattern);
  const normal = normalMapFrom(cv, 7);
  const uvScale = 1 / (2 * sh.rc);
  const rh = sh.rc + 0.085;
  const headH = sh.depth + 0.075;

  /* the cup: the carved hollow, rim to the deepest point */
  const cupGeo = lathe(domePoints(sh, sh.rc, sh.depth, 0, -1), 64, uvScale, 0);

  /* the head around it: back, a groove turned into the side, the rim face */
  const back = rh * sh.taper;
  // The back gets two turned rings: it is what shows while the mold is face-down
  // being knocked, and a plain disc there reads as a spoon.
  const ring = (r: number, w: number): [number, number][] => [
    [r - w, -headH],
    [r - w * 0.6, -headH + 0.007],
    [r + w * 0.6, -headH + 0.007],
    [r + w, -headH],
  ];
  const shell: [number, number][] = [
    [0, -headH],
    ...ring(back * 0.3, 0.012),
    ...ring(back * 0.7, 0.014),
    [back - 0.03, -headH],
    [back - 0.006, -headH + 0.012],
    [lerp(back, rh, 0.25), -headH + 0.04],
    [rh, -headH * 0.55],
    [rh - 0.012, -headH * 0.55 + 0.01],
    [rh, -headH * 0.55 + 0.02],
    [rh, -0.03],
    [rh - 0.006, -0.008],
    [rh - 0.026, 0],
    [sh.rc, 0],
  ];
  const shellGeo = new THREE.LatheGeometry(shell.map(([r, y]) => V2(r, y)), 64);
  {
    // grain runs along the paddle; project it from above so the back reads as one plank
    const pos = shellGeo.attributes.position;
    const uv = shellGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * 1.2 + 0.3, pos.getZ(i) * 1.2 + 0.5);
  }

  /* the cookie: the same dome, standing up, on a flat base with a soft foot */
  const R = sh.rc * 0.985;
  const D = sh.depth * 0.985;
  const foot = 0.008;
  const cookieProfile: [number, number][] = [
    [0, 0],
    [R * 0.96, 0],
    [R, foot],
    // the duplicate starts the dome: a hard crease between base and wall
    ...domePoints(sh, R, D - foot, foot, 1),
  ];
  const cookieGeo = lathe(cookieProfile, 64, uvScale, 3);

  if (sh.sx !== 1) {
    cupGeo.scale(sh.sx, 1, 1);
    shellGeo.scale(sh.sx, 1, 1);
    cookieGeo.scale(sh.sx, 1, 1);
  }

  /* the handle: a flat paddle cut from the same plank, with a hole to hang it by */
  const x0 = rh * sh.sx - 0.05;
  const L = HANDLE_L;
  const hs = new THREE.Shape();
  hs.moveTo(x0, -0.066);
  hs.bezierCurveTo(x0 + 0.16, -0.05, x0 + 0.26, -0.07, x0 + L - 0.1, -0.086);
  hs.bezierCurveTo(x0 + L - 0.02, -0.092, x0 + L + 0.014, -0.05, x0 + L + 0.014, 0);
  hs.bezierCurveTo(x0 + L + 0.014, 0.05, x0 + L - 0.02, 0.092, x0 + L - 0.1, 0.086);
  hs.bezierCurveTo(x0 + 0.26, 0.07, x0 + 0.16, 0.05, x0, 0.066);
  hs.lineTo(x0, -0.066);
  const hole = new THREE.Path();
  hole.absarc(x0 + L - 0.075, 0, 0.022, 0, TAU, true);
  hs.holes.push(hole);
  const handleGeo = new THREE.ExtrudeGeometry(hs, {
    depth: HANDLE_T - 2 * HANDLE_BEV,
    bevelEnabled: true,
    bevelThickness: HANDLE_BEV,
    bevelSize: HANDLE_BEV * 0.8,
    bevelSegments: 2,
    curveSegments: 18,
  });
  // Flat to the back of the head, so face-up the whole paddle lies on the board;
  // 4mm proud of the back so the two coplanar faces never fight.
  handleGeo.rotateX(Math.PI / 2);
  handleGeo.translate(0, -headH + HANDLE_T - HANDLE_BEV + 0.004, 0);

  /* colour maps from the same carving */
  const rawMap = colorMapFrom(cv, seed + 1, (h, cav, n) => {
    // raw semolina dough: pale gold, flecked with grain, a touch darker in the grooves
    const fleck = n < 0.035 ? 0.84 : n > 0.975 ? 1.06 : 1;
    const k = fleck * (1 - cav * 0.9) * (0.97 + h * 0.05) * (0.97 + n * 0.05);
    return [236 * k, 206 * k, 150 * k];
  });
  const bakedMap = colorMapFrom(cv, seed + 2, (h, cav, n) => {
    // baked and sugared: the raised carving browns, the sugar sits in a white bloom
    // over it and gathers least in the shadowed grooves
    const br = [214 - h * 40, 158 - h * 42, 88 - h * 30];
    const s = clamp01(0.74 + (n - 0.5) * 0.3 - cav * 1.2);
    return [lerp(br[0], 250, s), lerp(br[1], 246, s), lerp(br[2], 238, s)];
  });
  const cupMap = colorMapFrom(cv, seed + 3, (h, cav, n, x, y) => {
    // the carved cup: the same wood, darker where the knife went deep, and a
    // lifetime of flour packed into the cuts
    const gr = grainAt(x, y, n);
    const base = [lerp(170, 200, gr), lerp(122, 150, gr), lerp(76, 100, gr)];
    const dark = 1 - h * 0.38;
    const flour = clamp01(h * 0.45 + cav * 1.6) * (0.55 + n * 0.45);
    return [lerp(base[0] * dark, 244, flour), lerp(base[1] * dark, 238, flour), lerp(base[2] * dark, 226, flour)];
  });

  const cupMat = new THREE.MeshStandardMaterial({
    map: cupMap,
    normalMap: normal,
    normalScale: new THREE.Vector2(-1.3, -1.3), // the carving, cut *into* the wood
    roughness: 0.8,
    metalness: 0,
  });
  const rawMat = new THREE.MeshStandardMaterial({
    map: rawMap,
    normalMap: normal,
    normalScale: new THREE.Vector2(1.5, 1.5),
    roughness: 0.82,
    metalness: 0,
  });
  const bakedMat = new THREE.MeshStandardMaterial({
    map: bakedMap,
    normalMap: normal,
    normalScale: new THREE.Vector2(1.2, 1.2),
    roughness: 0.92,
    metalness: 0,
  });

  return { shape: sh, rh, headH, shellGeo, cupGeo, handleGeo, cookieGeo, cupMat, rawMat, bakedMat };
}
// All three are built up front: the plate at the back always carries one of each,
// which is what an Eid plate is.
const ASSETS: Record<string, ShapeAssets> = {
  date: buildShapeAssets(SHAPES.date, 101),
  pistachio: buildShapeAssets(SHAPES.pistachio, 202),
  walnut: buildShapeAssets(SHAPES.walnut, 303),
};

/* ---------- the board textures (one per board, built when first asked for) ---------- */
const BOARD_TILE = 5; // world units one texture spans — wider than either board
function buildBoardTex(kind: BoardDef["kind"]): THREE.CanvasTexture {
  const S = 1024;
  const { c, g } = canvas2d(S, S);
  g.lineCap = "round";
  if (kind === "marble") {
    const rand = mulberry32(2909);
    g.fillStyle = "#141d19";
    g.fillRect(0, 0, S, S);
    // a clouded body: deep greens drifting through near-black
    for (let i = 0; i < 180; i++) {
      radialBlob(g, rand() * S, rand() * S, 60 + rand() * 220, rand() > 0.45 ? "rgba(36,58,48,0.32)" : "rgba(4,8,7,0.4)");
    }
    // Veins run one way through a slab. Each is a long smooth curve on a shared
    // diagonal — a soft halo under a fine bright core — with finer veins
    // branching off it, and all of them dimmer than the sugar will be.
    const vein = (x0: number, y0: number, len: number, a0: number, core: number, bright: number) => {
      const f1 = 2 + rand() * 3;
      const f2 = 6 + rand() * 7;
      const f3 = 16 + rand() * 12;
      const p1 = rand() * TAU;
      const p2 = rand() * TAU;
      const p3 = rand() * TAU;
      const amp = (40 + rand() * 80) * (len / S);
      const pts: [number, number][] = [];
      const wid: number[] = [];
      const ca = Math.cos(a0);
      const sa = Math.sin(a0);
      const K = 90;
      for (let k = 0; k <= K; k++) {
        const u = k / K;
        const off = Math.sin(u * f1 + p1) * amp + Math.sin(u * f2 + p2) * amp * 0.25 + Math.sin(u * f3 + p3) * amp * 0.07;
        pts.push([x0 + ca * u * len - sa * off, y0 + sa * u * len + ca * off]);
        // veins swell and pinch along their length, and taper out at the ends
        wid.push(Math.sin(Math.PI * u) ** 0.4 * (0.45 + 0.9 * (0.5 + 0.5 * Math.sin(u * f2 * 1.7 + p3))));
      }
      const stroke = (lw: number, col: string) => {
        g.strokeStyle = col;
        for (let k = 1; k <= K; k++) {
          g.lineWidth = Math.max(0.3, lw * wid[k]);
          g.beginPath();
          g.moveTo(pts[k - 1][0], pts[k - 1][1]);
          g.lineTo(pts[k][0], pts[k][1]);
          g.stroke();
        }
      };
      stroke(core * 9, `rgba(110,140,126,${0.045 * bright})`);
      stroke(core * 3, `rgba(150,178,164,${0.09 * bright})`);
      stroke(core, `rgba(214,228,220,${0.32 * bright})`);
      return pts;
    };
    for (let i = 0; i < 7; i++) {
      const a0 = -0.55 + (rand() - 0.5) * 0.35;
      const pts = vein(-100 + rand() * 300, rand() * S * 1.2, S * (1.1 + rand() * 0.4), a0, 0.8 + rand() * 1.1, 0.6 + rand() * 0.6);
      for (let b = 0; b < 3; b++) {
        const [x, y] = pts[Math.floor(rand() * pts.length)];
        vein(x, y, S * (0.15 + rand() * 0.3), a0 + (rand() - 0.5) * 1.4, 0.5 + rand() * 0.5, 0.45);
      }
    }
  } else if (kind === "olive") {
    const rand = mulberry32(1703);
    g.fillStyle = "#664a2f";
    g.fillRect(0, 0, S, S);
    // olive's figure: honey-coloured bands broken by dark streaks that flow and
    // bunch along the grain — broad and soft, never a scribble
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(160,124,80,${0.18 + rand() * 0.2})`;
      g.lineWidth = 18 + rand() * 60;
      wavy(g, S, rand() * S, 10 + rand() * 30, 0.002 + rand() * 0.004, rand() * TAU, 20);
    }
    for (let i = 0; i < 22; i++) {
      g.strokeStyle = `rgba(40,26,14,${0.22 + rand() * 0.3})`;
      g.lineWidth = 3 + rand() * 12;
      wavy(g, S, rand() * S, 12 + rand() * 34, 0.003 + rand() * 0.005, rand() * TAU, 16);
    }
    for (let i = 0; i < 240; i++) {
      g.strokeStyle = rand() < 0.55 ? `rgba(48,32,18,${0.06 + rand() * 0.12})` : `rgba(176,140,94,${0.05 + rand() * 0.1})`;
      g.lineWidth = 0.6 + rand() * 1.6;
      wavy(g, S, rand() * S, 4 + rand() * 18, 0.003 + rand() * 0.006, rand() * TAU, 16);
    }
  } else {
    const rand = mulberry32(811);
    g.fillStyle = "#3a2517";
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 34; i++) {
      g.strokeStyle = rand() < 0.5 ? "rgba(22,12,6,0.22)" : "rgba(96,62,38,0.16)";
      g.lineWidth = 10 + rand() * 50;
      wavy(g, S, rand() * S, 3 + rand() * 10, 0.002 + rand() * 0.004, rand() * TAU, 24);
    }
    for (let i = 0; i < 420; i++) {
      g.strokeStyle = rand() < 0.6 ? `rgba(20,11,6,${0.08 + rand() * 0.2})` : `rgba(104,70,44,${0.06 + rand() * 0.14})`;
      g.lineWidth = 0.6 + rand() * 2.2;
      wavy(g, S, rand() * S, 1 + rand() * 6, 0.003 + rand() * 0.008, rand() * TAU);
    }
  }
  // Knife marks: a board that has been used, not one out of the box.
  const rand = mulberry32(4471);
  for (let i = 0; i < 110; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const a = rand() * TAU;
    const l = 14 + rand() * 50;
    g.strokeStyle = `rgba(230,210,190,${0.03 + rand() * 0.05})`;
    g.lineWidth = 0.6 + rand() * 0.8;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  const t = srgb(new THREE.CanvasTexture(c), 8);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // ExtrudeGeometry's cap UVs are the shape's own coordinates in world units
  t.repeat.set(1 / BOARD_TILE, 1 / BOARD_TILE);
  t.offset.set(0.5, 0.5);
  return t;
}
const boardTexCache: Partial<Record<BoardDef["kind"], THREE.CanvasTexture>> = {};
function boardTex(kind: BoardDef["kind"]): THREE.CanvasTexture {
  return (boardTexCache[kind] ??= buildBoardTex(kind));
}

/* ---------- the board's body: a thick plank with rounded corners and eased edges ---------- */
const BOARD_T = 0.13;
function buildBoardGeo(w: number, d: number): THREE.ExtrudeGeometry {
  const r = 0.2;
  const hw = w / 2;
  const hd = d / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + r);
  s.lineTo(hw, hd - r);
  s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-hw + r, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, -hd + r);
  s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  const bev = 0.022;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: BOARD_T - 2 * bev,
    bevelEnabled: true,
    bevelThickness: bev,
    bevelSize: bev,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -(BOARD_T - bev), 0); // top face at y = 0
  return geo;
}
const BOARD_GEO = {
  wide: buildBoardGeo(WIDE.board.w, WIDE.board.d),
  tall: buildBoardGeo(TALL.board.w, TALL.board.d),
};

/* ---------- flour on the board, where the work was done ---------- */
function buildFlourTex(L: Layout): THREE.CanvasTexture {
  const { w, d, x: bx, z: bz } = L.board;
  const CW = 1024;
  const CH = Math.round((CW * d) / w);
  const { c, g } = canvas2d(CW, CH);
  const X = (x: number) => ((x - (bx - w / 2)) / w) * CW;
  const Y = (z: number) => ((z - (bz - d / 2)) / d) * CH;
  const U = CW / w; // px per world unit
  const rand = mulberry32(L.key === "wide" ? 606 : 707);
  const flour = (a: number) => `rgba(255,250,240,${a})`;
  // where the dough was worked: a broad dusting around the mold and the ball
  const [cx, cz] = L.cookie;
  const [bxx, bzz] = L.ball;
  radialBlob(g, X(cx), Y(cz), U * 0.9, flour(0.2));
  radialBlob(g, X((cx + bxx) / 2), Y((cz + bzz) / 2), U * 0.8, flour(0.14));
  radialBlob(g, X(bxx), Y(bzz), U * 0.45, flour(0.18));
  // the sieve has been standing here: the sugar it shed where it was set down
  const [sx, sz] = L.sieve;
  radialBlob(g, X(sx), Y(sz), U * 0.6, flour(0.16));
  for (let i = 0; i < 260; i++) {
    const a = rand() * TAU;
    const d = (SIEVE_R + (rand() - 0.3) * 0.2) * U;
    g.fillStyle = flour(0.1 + rand() * 0.3);
    g.beginPath();
    g.arc(X(sx) + Math.cos(a) * d, Y(sz) + Math.sin(a) * d, 0.6 + rand() * 1.3, 0, TAU);
    g.fill();
  }
  // specks everywhere, thickest by the dough, sparest over the middle
  for (let i = 0; i < 2400; i++) {
    const near = rand() < 0.55;
    const x = near ? cx + (rand() - 0.5) * 1.8 : bx + (rand() - 0.5) * w;
    const z = near ? cz + (rand() - 0.5) * 1.5 : bz + (rand() - 0.5) * d;
    const inMsg = Math.abs(x - L.msg.x) < L.msg.w / 2 && Math.abs(z - L.msg.z) < L.msg.d / 2;
    if (inMsg && rand() < 0.8) continue;
    g.fillStyle = flour(0.08 + rand() * (near ? 0.35 : 0.2));
    g.beginPath();
    g.arc(X(x), Y(z), 0.6 + rand() * 1.6, 0, TAU);
    g.fill();
  }
  return srgb(new THREE.CanvasTexture(c));
}
const flourTexCache: { wide?: THREE.CanvasTexture; tall?: THREE.CanvasTexture } = {};
function flourTex(L: Layout): THREE.CanvasTexture {
  return (flourTexCache[L.key] ??= buildFlourTex(L));
}

/* ---------- the rest of the kitchen ---------- */
/** A warm room for the tin and the glaze to reflect: bright window, dim walls. */
function buildEnv(): THREE.Texture {
  const W = 128;
  const H = 64;
  const { c, g } = canvas2d(W, H);
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#b39479");
  sky.addColorStop(0.5, "#5a4133");
  sky.addColorStop(1, "#1a110c");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  radialBlob(g, 42, 22, 18, "#fff3dc"); // the window
  radialBlob(g, 100, 30, 16, "#6b5040");
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ENV = buildEnv();

/** A linen cloth under the board, loosely woven. */
function buildLinen(): THREE.CanvasTexture {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = "#4a392d";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(333);
  for (let y = 0; y < S; y += 2) {
    g.fillStyle = rand() < 0.5 ? `rgba(0,0,0,${rand() * 0.12})` : `rgba(255,236,210,${rand() * 0.06})`;
    g.fillRect(0, y, S, 1);
  }
  for (let x = 0; x < S; x += 2) {
    g.fillStyle = rand() < 0.5 ? `rgba(0,0,0,${rand() * 0.1})` : `rgba(255,236,210,${rand() * 0.05})`;
    g.fillRect(x, 0, 1, S);
  }
  const t = srgb(new THREE.CanvasTexture(c));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  return t;
}
const linenTex = buildLinen();

/** The room falls away into the page's own dark past the edges of the cloth. */
function buildVignette(): THREE.CanvasTexture {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, "rgba(16,11,20,0)");
  gr.addColorStop(0.36, "rgba(16,11,20,0)");
  gr.addColorStop(0.62, "rgba(16,11,20,0.9)");
  gr.addColorStop(1, "rgba(16,11,20,1)");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return srgb(new THREE.CanvasTexture(c));
}
const vignetteTex = buildVignette();

/** The morning coming in through an arched window, laid across the board. */
function buildWindowPool(): THREE.CanvasTexture {
  const W = 256;
  const H = 256;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  // Two arched lights with a mullion between, each split by a transom. Drawn
  // off-canvas and thrown back in as a blurred shadow: the one soft-edge trick
  // every browser's 2D canvas has.
  g.shadowColor = "#fff";
  g.shadowBlur = 7;
  g.shadowOffsetX = W;
  g.fillStyle = "#fff";
  const hw = W * 0.125;
  for (const cx of [W * 0.33, W * 0.67]) {
    const x = cx - W;
    g.beginPath();
    g.moveTo(x - hw, H * 0.5);
    g.lineTo(x - hw, H * 0.3);
    g.arc(x, H * 0.3, hw, Math.PI, 0);
    g.lineTo(x + hw, H * 0.5);
    g.closePath();
    g.fill();
    g.fillRect(x - hw, H * 0.54, hw * 2, H * 0.36);
  }
  return new THREE.CanvasTexture(c);
}
const windowTex = buildWindowPool();

/** Soft contact shadows — the room has no shadow maps, and does not need them. */
function buildBlob(): THREE.CanvasTexture {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, "rgba(0,0,0,0.7)");
  gr.addColorStop(0.5, "rgba(0,0,0,0.38)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
const blobTex = buildBlob();

/** A soft ring: the "knock here" ripple, and the flour the knocks leave. */
function buildRing(inner: number, peak: number, a: number): THREE.CanvasTexture {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, "rgba(255,250,240,0)");
  gr.addColorStop(inner, "rgba(255,250,240,0)");
  gr.addColorStop(peak, `rgba(255,250,240,${a})`);
  gr.addColorStop(1, "rgba(255,250,240,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
const rippleTex = buildRing(0.66, 0.84, 1);
const knockRingTex = (() => {
  const t = buildRing(0.42, 0.58, 0.32);
  // …mostly flung grains, thinning outward, and a few streaks where it sprayed
  const g = (t.image as HTMLCanvasElement).getContext("2d")!;
  const rand = mulberry32(919);
  for (let i = 0; i < 1100; i++) {
    const a = rand() * TAU;
    const r = 128 * (0.5 + Math.pow(rand(), 2.2) * 0.5);
    g.fillStyle = `rgba(255,250,240,${(0.12 + rand() * 0.5) * (1.25 - r / 128)})`;
    g.beginPath();
    g.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 0.5 + rand() * 1.2, 0, TAU);
    g.fill();
  }
  g.lineCap = "round";
  for (let i = 0; i < 14; i++) {
    const a = rand() * TAU;
    const r0 = 128 * (0.56 + rand() * 0.06);
    const r1 = r0 + 128 * (0.12 + rand() * 0.2);
    g.strokeStyle = `rgba(255,250,240,${0.12 + rand() * 0.14})`;
    g.lineWidth = 2 + rand() * 3;
    g.beginPath();
    g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
    g.lineTo(128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1);
    g.stroke();
  }
  return t;
})();

/** The sieve's fine mesh. */
function buildMesh(): THREE.CanvasTexture {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  g.clearRect(0, 0, S, S);
  g.strokeStyle = "rgba(150,146,138,0.85)";
  g.lineWidth = 1;
  for (let i = 0; i < S; i += 4) {
    g.beginPath();
    g.moveTo(i + 0.5, 0);
    g.lineTo(i + 0.5, S);
    g.moveTo(0, i + 0.5);
    g.lineTo(S, i + 0.5);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  return t;
}
const meshTex = buildMesh();

/** A glazed plate with a cobalt rim band, the kind every aunt's cupboard has. */
function buildPlateTex(): THREE.CanvasTexture {
  const S = 512;
  const { c, g } = canvas2d(S, S);
  const C = S / 2;
  g.fillStyle = "#efe6d4";
  g.fillRect(0, 0, S, S);
  const ring = (r: number, lw: number, col: string) => {
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.beginPath();
    g.arc(C, C, r, 0, TAU);
    g.stroke();
  };
  ring(C * 0.93, C * 0.1, "#1f4f8f");
  ring(C * 0.86, 2, "#1f4f8f");
  ring(C * 0.7, 3, "#2a5c9a");
  g.fillStyle = "#2a5c9a";
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    g.save();
    g.translate(C + Math.cos(a) * C * 0.78, C + Math.sin(a) * C * 0.78);
    g.rotate(a);
    g.beginPath();
    g.ellipse(0, 0, C * 0.05, C * 0.018, 0, 0, TAU);
    g.fill();
    g.restore();
  }
  return srgb(new THREE.CanvasTexture(c));
}
const PLATE_R = 0.5;
const plateGeo = lathe(
  [
    [0, 0.012],
    [0.28, 0.012],
    [0.3, 0],
    [0.33, 0],
    [0.35, 0.012],
    [0.47, 0.05],
    [0.5, 0.058],
    [0.505, 0.066],
    [0.49, 0.071],
    [0.46, 0.063],
    [0.36, 0.028],
    [0.3, 0.024],
    [0, 0.024],
  ],
  56,
  1 / (2 * PLATE_R),
  0,
);
const plateMat = new THREE.MeshStandardMaterial({
  map: buildPlateTex(),
  roughness: 0.22,
  metalness: 0.02,
  envMap: ENV,
  envMapIntensity: 0.5,
});
// One of each, the way a plate goes out to guests: [shape, angle, yaw].
const PLATE_COOKIES: [string, number, number][] = [
  ["date", 0.55, 0.3],
  ["pistachio", 2.2, 2.2 + Math.PI / 2],
  ["walnut", 3.75, 0],
  ["date", 5.2, 1.1],
];
const PLATE_COOKIE_K = 0.56;

/* the sieve */
const tinMat = new THREE.MeshStandardMaterial({
  color: "#cfc9bd",
  roughness: 0.34,
  metalness: 0.85,
  envMap: ENV,
  envMapIntensity: 1,
  side: THREE.DoubleSide,
});
const sieveRimGeo = new THREE.CylinderGeometry(SIEVE_R, SIEVE_R * 0.93, 0.11, 44, 1, true);
const sieveLipGeo = new THREE.TorusGeometry(SIEVE_R, 0.012, 8, 48);
const sieveMeshGeo = new THREE.CircleGeometry(SIEVE_R * 0.93, 40);
const sieveMeshMat = new THREE.MeshStandardMaterial({
  map: meshTex,
  transparent: true,
  roughness: 0.4,
  metalness: 0.6,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const sieveHandleGeo = new THREE.CylinderGeometry(0.011, 0.011, 0.42, 8);
const sieveHookGeo = new THREE.TorusGeometry(0.032, 0.008, 6, 18);
const unitSphere = new THREE.SphereGeometry(1, 28, 16);
const sugarMoundMat = new THREE.MeshStandardMaterial({ color: "#f8f5ef", roughness: 1, metalness: 0 });

/* the dough ball: the same speckled semolina, before it has a shape */
const doughTex = (() => {
  const S = 128;
  const { c, g } = canvas2d(S, S);
  g.fillStyle = "#ebcd94";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(8080);
  for (let i = 0; i < 700; i++) {
    g.fillStyle = rand() < 0.7 ? `rgba(180,140,80,${0.2 + rand() * 0.3})` : `rgba(255,244,220,${0.3 + rand() * 0.3})`;
    g.fillRect(rand() * S, rand() * S, 1 + rand(), 1 + rand());
  }
  return srgb(new THREE.CanvasTexture(c));
})();
const doughMat = new THREE.MeshStandardMaterial({ map: doughTex, roughness: 0.84, metalness: 0 });
const BALL_R = 0.15;
const ballGeo = (() => {
  // a hand-rolled ball: not quite round
  const geo = new THREE.SphereGeometry(BALL_R, 36, 24);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + Math.sin(v.x * 31 + 1.2) * Math.cos(v.z * 27) * 0.03 + Math.sin(v.y * 40) * 0.015;
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
})();

const flatPlane = new THREE.PlaneGeometry(1, 1);
/** Per-frame opacity writes go through the mesh, never the memo that made the material. */
const basicOf = (m: THREE.Mesh | null) => (m ? (m.material as THREE.MeshBasicMaterial) : null);

/* ---------- shaders ---------- */
// The sugar is one Points cloud animated entirely on the GPU: every grain carries
// where it leaves the sieve, where it lands, and when — so the CPU touches two
// uniforms a frame however long the message is, and uT = ∞ is the settled board.
const SUGAR_VERT = /* glsl */ `
uniform float uT;
uniform float uTime;
uniform float uScale;
uniform float uSize;
attribute vec3 aFrom;
attribute vec4 aT; // release, fall, seed, size
attribute float aA;
varying float vA;
varying float vB;
void main() {
  float k = clamp((uT - aT.x) / aT.y, 0.0, 1.0);
  float live = step(aT.x, uT);
  float lat = 1.0 - (1.0 - k) * (1.0 - k);
  vec3 p = mix(aFrom, position, vec3(lat, k * k, lat));
  // powder drifts as it falls, and is still by the time it lands
  float sway = sin(k * 3.14159) * (0.025 + 0.05 * fract(aT.z * 7.31));
  p.x += sway * sin(aT.z * 43.0 + k * 5.0);
  p.z += sway * cos(aT.z * 29.0 + k * 4.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float landed = step(1.0, k);
  // a few settled grains catch the window now and then
  float tw = landed * pow(max(0.0, sin(uTime * (0.6 + fract(aT.z * 3.7) * 1.4) + aT.z * 61.0)), 70.0);
  gl_PointSize = live * uSize * aT.w * (1.0 + 0.6 * (1.0 - landed) + tw * 1.3) * uScale / -mv.z;
  vA = live * aA * mix(0.75, 1.0, landed);
  vB = 1.0 + tw;
}
`;
const SUGAR_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
varying float vB;
void main() {
  float a = smoothstep(0.5, 0.12, length(gl_PointCoord - 0.5)) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(min(uColor * vB, vec3(1.0)), a);
}
`;
function makeSugarMaterial(size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: -1 },
      uTime: { value: 0 },
      uScale: { value: 600 },
      uSize: { value: size },
      uColor: { value: new THREE.Color(0.95, 0.93, 0.9) },
    },
    vertexShader: SUGAR_VERT,
    fragmentShader: SUGAR_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

// The settled lettering under the grains: the same raster the grains were sampled
// from, uncovered behind the sieve in reading order (uFront runs along the pass's
// axis), with a per-texel grain so it reads as powder and not print.
const WIPE_VERT = /* glsl */ `
uniform vec2 uOff; // the plane's centre on the board (x, z)
uniform vec2 uAxis; // the pass's direction on the board
varying vec2 vUv;
varying float vR;
void main() {
  vUv = uv;
  // the plane lies flat: its local y runs toward -z on the board
  vR = dot(vec2(uOff.x + position.x, uOff.y - position.y), uAxis);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const WIPE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uFront;
uniform float uSoft;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec2 uGrain;
varying vec2 vUv;
varying float vR;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  // sample a hair off true at every grain cell, so the edges come out ragged the
  // way sifted sugar settles against a line, not clean like ink
  vec2 cell = floor(vUv * uGrain * 0.5);
  vec2 j = (vec2(hash(cell), hash(cell + 7.13)) - 0.5) * 2.4 / uGrain;
  float a = texture2D(uMap, vUv + j).a;
  float w = smoothstep(uFront + uSoft, uFront - uSoft, vR);
  float n = hash(floor(vUv * uGrain));
  a *= w * uOpacity * (0.45 + 0.55 * n);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

// Flour: puffs off the knocks, and motes in the window light. CPU-driven (a few
// hundred points), per-point size and alpha.
const DUST_VERT = /* glsl */ `
uniform float uScale;
attribute float aSize;
attribute float aAlpha;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha < 0.003 ? 0.0 : aSize * uScale / -mv.z;
  vA = aAlpha;
}
`;
const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;
function makeDustMaterial(color: string, additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 600 }, uColor: { value: new THREE.Color(color) } },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/* ---------- the sugar, laid out ---------- */
const MSG_FS = 72;
const NAME_FS = 120;
const LINE_H = 1.22;
const SUGAR_FONT = "Georgia, 'Times New Roman', serif";
const MSG_GRAINS = 2300;
const NAME_GRAINS = 560;

// The pass follows the reading: across the lines (left to right, or right to left
// for Arabic) when the block is wide, and down them, line by line, when it is tall
// — a phone's narrow column is read downward, so that is how it gets written.
interface Sweep {
  ax: number; // unit direction of the pass on the board
  az: number;
  r0: number; // its span along that direction
  r1: number;
  c: number; // centre of the weave across it…
  a: number; // …and how far to either side the wrist carries it
  dur: number;
}
const readAlong = (sw: Sweep, x: number, z: number) => x * sw.ax + z * sw.az;
/** Where the sieve is `tau` seconds into its pass. Shared by the grain builder and the frame loop. */
function sieveAt(sw: Sweep, tau: number, out: { x: number; z: number }) {
  const u = clamp01(tau / sw.dur);
  const along = sw.r0 + (sw.r1 - sw.r0) * u;
  const across = sw.c + sw.a * Math.sin(u * TAU * 2);
  // the cross direction is the pass turned a quarter: (−az, ax) up to sign, and
  // for the two passes used here that is simply the other board axis
  out.x = along * sw.ax + across * Math.abs(sw.az);
  out.z = along * sw.az + across * Math.abs(sw.ax);
}

interface SugarPlane {
  tex: THREE.CanvasTexture;
  mat: THREE.ShaderMaterial;
  w: number;
  h: number;
  x: number;
  z: number;
}
interface Sugar {
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  planes: SugarPlane[];
  sweep: Sweep;
}

/** Count the lines `text` wraps to at `maxW` — the same greedy word wrap text3d uses. */
function measureWrap(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  let lines = 0;
  let widest = 0;
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(cand).width > maxW) {
        widest = Math.max(widest, ctx.measureText(line).width);
        lines++;
        line = word;
      } else line = cand;
    }
    widest = Math.max(widest, ctx.measureText(line).width);
    lines++;
  }
  return { lines, widest };
}
const WRAP_EMS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 23, 26, 30];

function buildSugar(nameText: string, msgText: string, lang: Lang, L: Layout): Sugar {
  const seed = hashStr(`${nameText}|${msgText}|${lang}`);
  const rand = mulberry32(seed);
  const font = (fontSize: number, maxWidthPx: number) => ({
    fontSize,
    fontFamily: SUGAR_FONT,
    fontWeight: "700",
    maxWidthPx,
    lineHeight: LINE_H,
    lang,
  });
  // Thmanyah sits smaller on its em than Georgia, so Arabic gets a little more;
  // and a few words alone on a board can afford to be written large.
  const short = 1 + 0.6 * clamp01((60 - msgText.length) / 45);
  const maxFont = L.msg.maxFont * (lang === "ar" ? 1.2 : 1) * short;
  const pad = (fs: number) => Math.ceil(fs * 0.25);
  const gapPx = -MSG_FS * 0.12;

  /* Choose the wrap. The letters should be as big as the board allows, so try a
     range of line lengths and keep the one that fits the space at the largest
     size — a long message on a wide board goes long and low, on a phone it goes
     down the middle. Among ties (short messages, capped by maxFont) keep the
     block whose shape best matches the space. A long name never drives this: it
     is shrunk to the message's width, down to a floor, before it would wrap. */
  const mctx = document.createElement("canvas").getContext("2d")!;
  if (lang === "ar") mctx.direction = "rtl";
  const family = lang === "ar" ? "'Thmanyah Sans', system-ui, sans-serif" : SUGAR_FONT;
  mctx.font = `700 ${NAME_FS}px ${family}`;
  const nameW = nameText ? mctx.measureText(nameText).width : 0;
  const nameWord = nameText ? Math.max(...nameText.split(/\s+/).map((wd) => mctx.measureText(wd).width)) : 0;
  // The name's size for a message block `w` px wide: whole on one line if it
  // fits, else no smaller than a touch over the message — unless even its
  // longest word would not fit, which is the one thing allowed to shrink it more.
  const nameFsFor = (w: number) => {
    const room = w - 2 * pad(NAME_FS);
    const floor = Math.min(MSG_FS * 1.1, (NAME_FS * room) / Math.max(1, nameWord));
    return Math.max(floor, Math.min(NAME_FS, (NAME_FS * room) / Math.max(1, nameW)));
  };
  mctx.font = `700 ${MSG_FS}px ${family}`;
  let best = { em: 12, score: -Infinity, w: 0 };
  for (const em of WRAP_EMS) {
    if (L.key === "wide" && em < 9) continue; // a wide board is not a column
    const m = measureWrap(mctx, msgText, MSG_FS * em);
    const w = Math.ceil(m.widest) + 2 * pad(MSG_FS);
    const h = m.lines * MSG_FS * LINE_H + 2 * pad(MSG_FS);
    const nfs = nameText ? nameFsFor(w) : 0;
    const nh = nameText ? Math.ceil((nfs * nameW) / NAME_FS / Math.max(1, w)) * nfs * LINE_H + 2 * pad(nfs) + gapPx : 0;
    const bw = Math.max(w, nameText ? Math.min((nfs * nameW) / NAME_FS, w) + 2 * pad(nfs) : 0);
    const sc = Math.min(L.msg.w / bw, L.msg.d / (h + nh), maxFont / MSG_FS);
    const err = Math.abs(Math.log((h + nh) / bw / (L.msg.d / L.msg.w)));
    const score = sc * (1 - 0.06 * err);
    if (score > best.score) best = { em, score, w };
  }
  const wrap = MSG_FS * best.em;
  const nameFs = nameText ? nameFsFor(best.w) : NAME_FS;

  // Each block is sampled for grain targets and rasterized for the settled
  // lettering with identical font, wrap and padding, so the two line up.
  const blocks: { pts: TextPoints; tex: TextTexture; fs: number }[] = [];
  const addBlock = (text: string, fs: number, maxW: number, n: number) => {
    blocks.push({
      pts: sampleTextPoints(text, { ...font(fs, maxW), maxPoints: n, seed: seed ^ fs }),
      tex: makeTextTexture(text, { ...font(fs, maxW), color: "#ffffff", glow: fs * 0.12, padding: pad(fs) }),
      fs,
    });
  };
  if (nameText) addBlock(nameText, nameFs, Math.max(best.w - 2 * pad(nameFs), nameFs * 3), NAME_GRAINS);
  addBlock(msgText, MSG_FS, wrap, MSG_GRAINS);

  const px = blocks.map((b) => {
    const img = b.tex.texture.image as HTMLCanvasElement;
    return { w: img.width, h: img.height };
  });
  const gap = blocks.length > 1 ? gapPx : 0;
  const blockW = Math.max(...px.map((p) => p.w));
  const blockH = px.reduce((a, p) => a + p.h, 0) + gap * (blocks.length - 1);
  // Long messages shrink to the board; short ones stop at a sane letter size.
  const s = Math.min(L.msg.w / blockW, L.msg.d / blockH, maxFont / MSG_FS);
  const fontWorld = MSG_FS * s;

  const M = blocks.reduce((a, b) => a + b.pts.count, 0);
  const tgt = new Float32Array(M * 2);
  const planes: SugarPlane[] = [];
  let zTop = L.msg.z - (blockH * s) / 2;
  let m = 0;
  const dir = lang === "ar" ? -1 : 1;
  const tallBlock = blockH > blockW * 1.1;
  const axis = tallBlock ? { x: 0, z: 1 } : { x: dir, z: 0 };
  blocks.forEach((b, bi) => {
    const w = px[bi].w * s;
    const h = px[bi].h * s;
    const cz = zTop + h / 2;
    const wp = (b.fs * LINE_H) / b.pts.lineSpacing; // the points' own canvas width
    for (let k = 0; k < b.pts.count; k++) {
      tgt[m * 2] = L.msg.x + b.pts.points[k * 2] * wp * s;
      tgt[m * 2 + 1] = cz - b.pts.points[k * 2 + 1] * wp * s;
      m++;
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: b.tex.texture },
        uFront: { value: -1e3 },
        uAxis: { value: new THREE.Vector2(axis.x, axis.z) },
        uSoft: { value: 0.16 },
        uOpacity: { value: 0.86 },
        uColor: { value: new THREE.Color(0.96, 0.94, 0.91) },
        uOff: { value: new THREE.Vector2(L.msg.x, cz) },
        uGrain: { value: new THREE.Vector2(px[bi].w / 2, px[bi].h / 2) },
      },
      vertexShader: WIPE_VERT,
      fragmentShader: WIPE_FRAG,
      transparent: true,
      depthWrite: false,
    });
    planes.push({ tex: b.tex.texture, mat, w, h, x: L.msg.x, z: cz });
    zTop += h + gap * s;
  });

  /* the pass: over the words in reading order, weaving across their lines */
  const sweep: Sweep = { ax: axis.x, az: axis.z, r0: 0, r1: 0, c: 0, a: 0, dur: 0 };
  let rMin = Infinity;
  let rMax = -Infinity;
  for (let k = 0; k < M; k++) {
    const r = readAlong(sweep, tgt[k * 2], tgt[k * 2 + 1]);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  if (!Number.isFinite(rMin)) {
    const r = readAlong(sweep, L.msg.x, L.msg.z);
    rMin = r - 0.5;
    rMax = r + 0.5;
  }
  sweep.r0 = rMin - 0.3;
  sweep.r1 = rMax + 0.3;
  sweep.dur = Math.min(3.9, Math.max(2.6, 2.2 + (rMax - rMin) * 0.45));
  sweep.c = tallBlock ? L.msg.x : L.msg.z;
  sweep.a = Math.min(0.32, (((tallBlock ? blockW : blockH) * s) / 2) * 0.55);

  /* grains: every letter pixel, a halo of dust around the letters, and the
     overspray a real sieve leaves along its whole path */
  const nNear = Math.round(Math.min(520, Math.max(160, M * 0.2)));
  const nSpray = Math.round(Math.min(380, Math.max(140, M * 0.14)));
  const N = M + nNear + nSpray;
  const pos = new Float32Array(N * 3);
  const from = new Float32Array(N * 3);
  const tim = new Float32Array(N * 4);
  const alpha = new Float32Array(N);
  const at = { x: 0, z: 0 };
  const span = sweep.r1 - sweep.r0;
  const disc = (r: number) => {
    const a = rand() * TAU;
    const d = Math.sqrt(rand()) * r;
    return [Math.cos(a) * d, Math.sin(a) * d];
  };
  const put = (i: number, x: number, z: number, rel: number, spread: number, size: number, a: number) => {
    pos[i * 3] = x;
    pos[i * 3 + 1] = 0.005 + rand() * 0.003;
    pos[i * 3 + 2] = z;
    sieveAt(sweep, rel, at);
    const [ox, oz] = disc(spread);
    from[i * 3] = at.x + ox;
    from[i * 3 + 1] = SIEVE_Y - 0.03 - rand() * 0.04;
    from[i * 3 + 2] = at.z + oz;
    tim[i * 4] = rel;
    tim[i * 4 + 1] = 0.5 + rand() * (FALL_MAX - 0.52);
    tim[i * 4 + 2] = rand();
    tim[i * 4 + 3] = size;
    alpha[i] = a;
  };
  const relOf = (x: number, z: number) => clamp01((readAlong(sweep, x, z) - sweep.r0) / span) * sweep.dur;
  for (let k = 0; k < M; k++) {
    const x = tgt[k * 2];
    const z = tgt[k * 2 + 1];
    put(k, x, z, Math.max(0, relOf(x, z) + (rand() - 0.5) * 0.14), SIEVE_R * 0.8, 0.75 + rand() * 0.6, 0.78 + rand() * 0.22);
  }
  for (let j = 0; j < nNear; j++) {
    const k = Math.floor(rand() * Math.max(1, M));
    const r = fontWorld * (0.15 + Math.pow(rand(), 1.8) * 0.6);
    const a = rand() * TAU;
    const x = (M ? tgt[k * 2] : L.msg.x) + Math.cos(a) * r;
    const z = (M ? tgt[k * 2 + 1] : L.msg.z) + Math.sin(a) * r;
    put(M + j, x, z, Math.max(0, relOf(x, z) + rand() * 0.12), SIEVE_R * 0.8, 0.45 + rand() * 0.35, 0.28 + rand() * 0.3);
  }
  for (let j = 0; j < nSpray; j++) {
    const rel = rand() * sweep.dur;
    sieveAt(sweep, rel, at);
    const [ox, oz] = disc(SIEVE_R * 1.3);
    put(M + nNear + j, at.x + ox, at.z + oz, rel, SIEVE_R * 0.5, 0.45 + rand() * 0.35, 0.14 + rand() * 0.22);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aFrom", new THREE.BufferAttribute(from, 3));
  geo.setAttribute("aT", new THREE.BufferAttribute(tim, 4));
  geo.setAttribute("aA", new THREE.BufferAttribute(alpha, 1));
  const mat = makeSugarMaterial(Math.min(0.026, Math.max(0.009, fontWorld * 0.15)));
  return { geo, mat, planes, sweep };
}

/* ---------- flour dust: motes in the light, puffs off the knocks ---------- */
const MOTE_N = 46;
const PUFF_N = 120; // small grains flung out
const CLOUD_N = 24; // the soft cloud that hangs a moment after
const PUFF_ALL = PUFF_N + CLOUD_N;
const MOTES = (() => {
  const rand = mulberry32(1234);
  const n = MOTE_N;
  const a = { u: new Float32Array(n), w: new Float32Array(n), y: new Float32Array(n), sp: new Float32Array(n), ph: new Float32Array(n), sz: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    a.u[i] = rand();
    a.w[i] = rand();
    a.y[i] = rand();
    a.sp[i] = 0.02 + rand() * 0.04;
    a.ph[i] = rand() * TAU;
    a.sz[i] = 0.028 + rand() * 0.03;
  }
  return a;
})();

function freshPuffs() {
  return {
    t0: new Float32Array(PUFF_ALL).fill(-99),
    life: new Float32Array(PUFF_ALL).fill(1),
    ox: new Float32Array(PUFF_ALL),
    oy: new Float32Array(PUFF_ALL),
    oz: new Float32Array(PUFF_ALL),
    vx: new Float32Array(PUFF_ALL),
    vy: new Float32Array(PUFF_ALL),
    vz: new Float32Array(PUFF_ALL),
    sz: new Float32Array(PUFF_ALL),
    a: new Float32Array(PUFF_ALL),
    cur: 0,
    ccur: 0,
  };
}
type Puffs = ReturnType<typeof freshPuffs>;
/** Flour squeezed out from under a rim of radius `r` as it hits the board. */
function spawnPuff(p: Puffs, e: number, x: number, z: number, r: number, k: number, grains: number, clouds: number) {
  for (let n = 0; n < grains; n++) {
    const i = p.cur;
    p.cur = (i + 1) % PUFF_N;
    const a = Math.random() * TAU;
    const sp = (0.35 + Math.random() * 0.9) * k;
    p.t0[i] = e;
    p.life[i] = 0.7 + Math.random() * 0.7;
    p.ox[i] = x + Math.cos(a) * r;
    p.oy[i] = 0.02;
    p.oz[i] = z + Math.sin(a) * r;
    p.vx[i] = Math.cos(a) * sp;
    p.vy[i] = (0.25 + Math.random() * 0.7) * k;
    p.vz[i] = Math.sin(a) * sp;
    p.sz[i] = 0.022 + Math.random() * 0.026;
    p.a[i] = 0.55 + Math.random() * 0.4;
  }
  for (let n = 0; n < clouds; n++) {
    const i = PUFF_N + p.ccur;
    p.ccur = (p.ccur + 1) % CLOUD_N;
    const a = Math.random() * TAU;
    p.t0[i] = e;
    p.life[i] = 1.1 + Math.random() * 0.6;
    p.ox[i] = x + Math.cos(a) * r * 0.9;
    p.oy[i] = 0.05;
    p.oz[i] = z + Math.sin(a) * r * 0.9;
    p.vx[i] = Math.cos(a) * 0.22 * k;
    p.vy[i] = 0.12 + Math.random() * 0.1;
    p.vz[i] = Math.sin(a) * 0.22 * k;
    p.sz[i] = (0.28 + Math.random() * 0.22) * (0.7 + 0.3 * k);
    p.a[i] = 0.2 + Math.random() * 0.12;
  }
}

/* ---------- the run: everything the opening accumulates ---------- */
function freshRun() {
  return {
    queued: 0, // taps waiting for the mold to be free
    started: 0,
    landed: 0,
    knockAt: -1,
    impacted: true,
    outAt: -1, // clock time of the third knock
    alone: 0, // seconds since the last real touch
    touched: false,
    down: false,
    ghostNext: 0,
    flipLanded: false,
    restLanded: false,
    released: false,
    hiss: false,
    tap: -1,
    chimed: false,
    joltAt: -99,
    joltK: 0,
    shake: 0,
    sieveKick: 0,
  };
}

export default function MaamoulScene({ variants, phase, recipientName, message, lang, onOpenComplete }: SceneProps) {
  const shapeKey = SHAPES[variants.mold] ? variants.mold : "date";
  const A = ASSETS[shapeKey];
  const boardDef = BOARDS[variants.board] ?? BOARDS.walnut;
  const tall = useThree((s) => s.size.width < s.size.height * TALL_BELOW);
  const L = tall ? TALL : WIDE;
  const isPreview = phase === "preview";

  /* useMemo owns every per-instance GPU resource here; each is disposed below.
     Module-scope textures and geometry are shared across instances and live on. */
  const boardMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: boardTex(boardDef.kind),
        roughness: boardDef.rough,
        metalness: 0,
        envMap: ENV,
        envMapIntensity: boardDef.env,
      }),
    [boardDef],
  );
  useEffect(() => () => boardMat.dispose(), [boardMat]);

  const flourMap = flourTex(L);

  // The gallery card never gets as far as sugar, so it never pays for it.
  const msgText = message.trim() || pick(lang, "Sweet wishes", "أطيب الأمنيات");
  const nameText = recipientName.trim();
  const sugar = useMemo(
    () => (isPreview ? null : buildSugar(nameText, msgText, lang, L)),
    [isPreview, nameText, msgText, lang, L],
  );
  useEffect(
    () => () => {
      if (!sugar) return;
      sugar.geo.dispose();
      sugar.mat.dispose();
      for (const p of sugar.planes) {
        p.tex.dispose();
        p.mat.dispose();
      }
    },
    [sugar],
  );

  const dust = useMemo(() => {
    const mk = (n: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(n), 1));
      return g;
    };
    return {
      moteGeo: mk(MOTE_N),
      puffGeo: mk(PUFF_ALL),
      moteMat: makeDustMaterial("#ffe4b8", true),
      puffMat: makeDustMaterial("#fbf6ec", false),
    };
  }, []);
  useEffect(
    () => () => {
      dust.moteGeo.dispose();
      dust.puffGeo.dispose();
      dust.moteMat.dispose();
      dust.puffMat.dispose();
    },
    [dust],
  );

  // Per-instance so that fading one card's shadow never fades another's.
  const fx = useMemo(
    () => ({
      moldShadow: new THREE.MeshBasicMaterial({ map: blobTex, color: "#000", transparent: true, depthWrite: false }),
      sieveShadow: new THREE.MeshBasicMaterial({ map: blobTex, color: "#000", transparent: true, depthWrite: false }),
      ballShadow: new THREE.MeshBasicMaterial({ map: blobTex, color: "#000", transparent: true, depthWrite: false }),
      cookieShadow: new THREE.MeshBasicMaterial({ map: blobTex, color: "#000", transparent: true, opacity: 0, depthWrite: false }),
      ripple: [0, 1].map(
        () =>
          new THREE.MeshBasicMaterial({
            map: rippleTex,
            color: "#ffe9c4",
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
      ),
      knockRing: new THREE.MeshBasicMaterial({ map: knockRingTex, transparent: true, opacity: 0, depthWrite: false }),
    }),
    [],
  );
  useEffect(
    () => () => {
      fx.moldShadow.dispose();
      fx.sieveShadow.dispose();
      fx.ballShadow.dispose();
      fx.cookieShadow.dispose();
      fx.ripple.forEach((m) => m.dispose());
      fx.knockRing.dispose();
    },
    [fx],
  );

  /* ---------- state ---------- */
  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const runRef = useRef(freshRun());
  const puffRef = useRef(freshPuffs());
  const camStRef = useRef({ x: 0, z: 0, dist: 5, el: 0.9, live: false });
  const atRef = useRef({ x: 0, z: 0 });
  // Replay re-enters "opening": the knocks start from nothing again. The clock is
  // zeroed here too, in the same layout pass — useOpeningClock's own reset lands a
  // frame later, and one frame of the old clock against a fresh run would fire the
  // turn-over's thud before the dough is even in.
  useLayoutEffect(() => {
    if (phase === "opening") {
      runRef.current = freshRun();
      tRef.current = 0;
      doneRef.current = false;
    }
  }, [phase, tRef, doneRef]);

  /* ---------- refs ---------- */
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moldRef = useRef<THREE.Group>(null);
  const pitchRef = useRef<THREE.Group>(null);
  const flipRef = useRef<THREE.Group>(null);
  const plugRef = useRef<THREE.Mesh>(null);
  const cookieRef = useRef<THREE.Mesh>(null);
  const ballRef = useRef<THREE.Mesh>(null);
  const sieveRef = useRef<THREE.Group>(null);
  const moundRef = useRef<THREE.Mesh>(null);
  const plateRef = useRef<THREE.Group>(null);
  const sugarRef = useRef<THREE.Points>(null);
  const planeRefs = useRef<(THREE.Mesh | null)[]>([]);
  const moteRef = useRef<THREE.Points>(null);
  const puffPtsRef = useRef<THREE.Points>(null);
  const moldShadowRef = useRef<THREE.Group>(null);
  const moldShadowHeadRef = useRef<THREE.Mesh>(null);
  const sieveShadowRef = useRef<THREE.Mesh>(null);
  const ballShadowRef = useRef<THREE.Mesh>(null);
  const cookieShadowRef = useRef<THREE.Mesh>(null);
  const rippleRefs = useRef<(THREE.Mesh | null)[]>([]);
  const knockRingRef = useRef<THREE.Mesh>(null);

  /* ---------- the knock ---------- */
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    const r = runRef.current;
    if (r.landed >= 3) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety for a tap */
    }
    // A real hand always wins: the invisible one steps back the moment one lands.
    r.alone = 0;
    r.touched = true;
    r.down = true;
    if (r.started + r.queued < 3) r.queued += 1;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const r = runRef.current;
    if (!r.down) return;
    ev.stopPropagation();
    r.alone = 0;
  };
  const onUp = (ev: ThreeEvent<PointerEvent>) => {
    runRef.current.down = false;
    try {
      (ev.target as Element).releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    const opening = phase === "opening";
    if (opening) tRef.current += dt;
    const t = tRef.current;
    const r = runRef.current;
    const sh = A.shape;
    const H = A.headH;
    const [cx, cz] = L.cookie;
    const pxScale = state.size.height * state.viewport.dpr * 0.5;

    /* ---- the gesture: queue → knock → impact ---- */
    const busy = r.knockAt >= 0 && t - r.knockAt < KNOCK_DUR;
    if (opening && r.landed < 3) {
      r.alone += dt; // a real touch (down or drag) zeroes it
      // Nobody is knocking. After IDLE0 a hand that is not there picks the mold up
      // and does it — and keeps going until the cookie is out, unless a real one
      // arrives, which resets `alone` and sends it away.
      if (r.alone > IDLE0 && t >= READY && !busy && r.queued === 0 && r.started < 3 && t >= r.ghostNext) {
        r.queued = 1;
        r.ghostNext = t + KNOCK_DUR + GHOST_GAP;
      }
      if (t >= READY && !busy && r.queued > 0 && r.started < 3) {
        r.queued -= 1;
        r.started += 1;
        r.knockAt = t;
        r.impacted = false;
      }
    }
    if (opening && !r.impacted && t - r.knockAt >= IMPACT) {
      r.impacted = true;
      r.landed += 1;
      const last = r.landed >= 3;
      // Wood on wood: a dry crack on top of a low body thump. The third is the one
      // that means it.
      clack({ freq: last ? 300 : 360, decay: last ? 0.16 : 0.12, gain: last ? 0.5 : 0.4 });
      tone(last ? 78 : 92, { seconds: 0.22, gain: last ? 0.36 : 0.28 });
      spawnPuff(puffRef.current, e, cx, cz, A.rh * Math.max(1, sh.sx * 0.85), last ? 1.25 : 0.9, last ? 44 : 30, last ? 10 : 6);
      r.shake = last ? 1 : 0.65;
      r.joltAt = e;
      r.joltK = last ? 1 : 0.7;
      if (last) r.outAt = t;
    }

    /* ---- the story's clock points ---- */
    const outAt = phase === "revealed" ? -1e3 : opening ? r.outAt : -1;
    const hasOut = phase === "revealed" || (opening && r.outAt >= 0);
    const liftV = hasOut ? clamp01((t - outAt - OUT_HOLD) / LIFT_DUR) : 0;
    const released = hasOut && t - outAt >= OUT_HOLD;
    const sweepStart = hasOut ? outAt + SWEEP_LEAD : Infinity;
    const sw = sugar?.sweep;
    const tau = phase === "revealed" ? 1e4 : t - sweepStart; // seconds into the sieve's pass

    /* ---- the mold ---- */
    let mx = cx;
    let mz = cz;
    let my = H; // face-up: the back on the board, the front face H above it
    let yaw = L.moldYaw;
    let flip = 0;
    let pitch = 0;
    if (phase === "revealed") {
      [mx, mz] = L.rest;
      yaw = L.restYaw;
    } else if (opening) {
      if (!released) {
        // turned over onto its face, the dough inside…
        const fu = clamp01((t - FLIP_T0) / FLIP_DUR);
        const fe = easeInOut(fu);
        flip = Math.PI * fe;
        my = lerp(H, 0, fe) + Math.sin(Math.PI * fu) * (0.3 + H * 0.5);
        // …and knocked: up, down hard, and the little jump it takes off the board
        if (r.knockAt >= 0) {
          const k = t - r.knockAt;
          const big = r.started >= 3 ? 1.15 : 1;
          if (k < K_LIFT) {
            const u = easeOutCubic(k / K_LIFT);
            my += 0.26 * big * u;
            pitch = 0.16 * big * u;
          } else if (k < IMPACT) {
            const u = (k - K_LIFT) / (IMPACT - K_LIFT);
            my += 0.26 * big * (1 - u * u);
            pitch = 0.16 * big * (1 - u * u);
          } else if (k < KNOCK_DUR) {
            const u = (k - IMPACT) / (KNOCK_DUR - IMPACT);
            my += 0.045 * big * Math.sin(Math.PI * Math.min(1, u * 1.6)) * (1 - u);
            pitch = -0.03 * Math.sin(Math.PI * u) * (1 - u);
          }
        }
        // Waiting to be knocked: every so often it lifts a hair and settles, like a
        // mold in a hand that is about to do it.
        if (t >= READY && !busy && r.started < 3 && !r.touched) {
          const w = (t - READY) % 1.6;
          if (w < 0.28) {
            const s = Math.sin((Math.PI * w) / 0.28);
            my += 0.035 * s;
            pitch += 0.05 * s;
          }
        }
      } else {
        // carried off to the side and set down carving-up, to be seen
        const ve = easeInOut(liftV);
        mx = lerp(cx, L.rest[0], ve);
        mz = lerp(cz, L.rest[1], ve);
        my = lerp(0, H, ve) + Math.sin(Math.PI * liftV) * 0.55;
        flip = Math.PI + Math.PI * ve;
        yaw = lerpAngle(L.moldYaw, L.restYaw, ve);
        pitch = Math.sin(Math.PI * liftV) * 0.18;
      }
      if (!r.flipLanded && t >= READY) {
        r.flipLanded = true;
        clack({ freq: 520, decay: 0.08, gain: 0.2 });
        spawnPuff(puffRef.current, e, cx, cz, A.rh * sh.sx, 0.5, 14, 3);
      }
      if (released && !r.released) {
        r.released = true;
        // the cookie lets go of the carving
        spawnPuff(puffRef.current, e, cx, cz, A.rh * 0.8, 0.45, 12, 3);
      }
      if (liftV >= 1 && !r.restLanded) {
        r.restLanded = true;
        clack({ freq: 640, decay: 0.07, gain: 0.18 });
      }
    }
    const baseY = flip > Math.PI * 0.5 && flip < Math.PI * 1.5 ? 0 : H;
    if (moldRef.current) {
      moldRef.current.position.set(mx, my, mz);
      moldRef.current.rotation.y = yaw;
    }
    if (pitchRef.current) pitchRef.current.rotation.z = pitch;
    if (flipRef.current) flipRef.current.rotation.x = flip;
    const moldLift = Math.max(0, my - baseY);
    if (moldShadowRef.current) {
      const s = moldShadowRef.current;
      s.position.set(mx + 0.05 + moldLift * 0.25, 0.003, mz + 0.05 + moldLift * 0.25);
      s.rotation.y = yaw;
      s.scale.setScalar(1 + moldLift * 0.5);
    }
    const msm = basicOf(moldShadowHeadRef.current);
    if (msm) msm.opacity = 0.62 * (1 - clamp01(moldLift / 0.9) * 0.65);

    /* ---- the dough: a ball, then pressed into the carving ---- */
    const bu = opening ? clamp01((t - BALL_T0) / BALL_DUR) : 0;
    const pu = opening ? clamp01((t - BALL_T0 - BALL_DUR) / PRESS_DUR) : 0;
    const plugIn = opening && t >= PLUG_AT && !released;
    const ballVis = phase === "preview" || phase === "sealed" || (opening && t < PLUG_AT);
    if (ballRef.current) {
      const b = ballRef.current;
      b.visible = ballVis;
      const [bx, bz] = L.ball;
      const be = easeInOut(bu);
      const sy = lerp(0.88, 0.28, smooth(pu));
      b.position.set(lerp(bx, cx, be), lerp(BALL_R * 0.88, H + BALL_R * sy * 0.55, be) + Math.sin(Math.PI * bu) * 0.42, lerp(bz, cz, be));
      b.rotation.y = lerp(0, L.moldYaw, be);
      b.scale.set(lerp(1, (sh.rc * sh.sx) / BALL_R, smooth(pu)), sy, lerp(1, sh.rc / BALL_R, smooth(pu)));
    }
    if (ballShadowRef.current) {
      const [bx, bz] = L.ball;
      const be = easeInOut(bu);
      ballShadowRef.current.visible = ballVis;
      ballShadowRef.current.position.set(lerp(bx, cx, be) + 0.03, 0.003, lerp(bz, cz, be) + 0.03);
      const m = basicOf(ballShadowRef.current);
      if (m) m.opacity = 0.6 * (1 - Math.sin(Math.PI * bu) * 0.6);
    }
    if (plugRef.current) plugRef.current.visible = plugIn;

    /* ---- the cookie, out on the board ---- */
    const cookieOut = released;
    if (cookieRef.current) {
      const c = cookieRef.current;
      c.visible = cookieOut;
      c.position.set(cx, 0, cz);
      c.rotation.y = L.moldYaw;
      // it lets go of the carving with a small settle, not a bounce
      const v = phase === "revealed" ? 9 : t - outAt - OUT_HOLD;
      const sq = cookieOut ? Math.exp(-v * 7) * Math.sin(v * 22) * 0.05 : 0;
      c.scale.set(0.985 * (1 + sq * 0.5), 0.985 * (1 - sq), 0.985 * (1 + sq * 0.5));
    }
    if (cookieShadowRef.current) {
      cookieShadowRef.current.visible = cookieOut;
      const m = basicOf(cookieShadowRef.current);
      if (m) m.opacity = cookieOut ? 0.55 : 0;
    }

    /* ---- flour the knocks leave round the mold ---- */
    const krm = basicOf(knockRingRef.current);
    if (knockRingRef.current && krm) {
      const want = phase === "revealed" ? 1 : opening ? Math.min(3, r.landed) / 3 : 0;
      krm.opacity = lerp(krm.opacity, want * 0.6, Math.min(1, dt * 5));
      knockRingRef.current.visible = krm.opacity > 0.005;
    }

    /* ---- the affordance: a ripple on the board under the mold, saying knock ---- */
    {
      let k = 0;
      if (phase === "sealed") k = 0.35;
      else if (opening && t >= READY && r.landed < 3) {
        // full until the first touch, then quieter; gone once the invisible hand
        // takes over, because an invitation that outlives the thing it invites is noise
        const ghost = clamp01((r.alone - IDLE0 + 0.3) / 0.6);
        k = (r.touched ? 0.45 : 1) * (1 - ghost) * clamp01((t - READY) / 0.4);
      }
      const base = A.rh * Math.max(1, sh.sx * 0.8) * 2.3;
      for (let i = 0; i < 2; i++) {
        const m = rippleRefs.current[i];
        const mm = basicOf(m);
        if (!m || !mm) continue;
        const ph = (e / 1.5 + i * 0.5) % 1;
        m.position.set(mx, 0.006, mz);
        m.scale.setScalar(base * (1 + ph * 0.9));
        mm.opacity = lerp(mm.opacity, k * Math.pow(1 - ph, 1.6) * 0.7, Math.min(1, dt * 8));
        m.visible = mm.opacity > 0.004;
      }
    }

    /* ---- props rattle when the mold hits the board ---- */
    const ja = e - r.joltAt;
    const jolt = opening && ja < 0.5 ? Math.exp(-ja * 10) * Math.abs(Math.sin(ja * 38)) * 0.014 * r.joltK : 0;
    if (plateRef.current) plateRef.current.position.set(L.plate[0], jolt * 0.6, L.plate[1]);

    /* ---- the sieve: lifted, carried over the board, tapped as it goes ---- */
    let sx = L.sieve[0];
    let sz = L.sieve[1];
    let sy = jolt;
    let tilt = 0;
    let mound = 1;
    const at = atRef.current;
    if (sw && hasOut) {
      if (tau >= -SIEVE_IN && tau < 0) {
        const u = easeInOut((tau + SIEVE_IN) / SIEVE_IN);
        sieveAt(sw, 0, at);
        sx = lerp(L.sieve[0], at.x, u);
        sz = lerp(L.sieve[1], at.z, u);
        sy = lerp(0, SIEVE_Y, smooth(Math.min(1, u * 1.5)));
        tilt = Math.sin(Math.PI * u) * 0.12;
      } else if (tau >= 0 && tau <= sw.dur) {
        sieveAt(sw, tau, at);
        // the shake of a wrist, plus the knock of a finger on the rim
        r.sieveKick = Math.max(0, r.sieveKick - dt * 6);
        sx = at.x + Math.sin(tau * 41) * 0.012;
        sz = at.z + Math.cos(tau * 37) * 0.01;
        sy = SIEVE_Y + Math.sin(tau * 29) * 0.008 - r.sieveKick * 0.03;
        tilt = 0.08 + r.sieveKick * 0.08;
        mound = lerp(1, 0.42, tau / sw.dur);
        if (opening) {
          const tap = Math.floor(tau / TAP_EVERY);
          if (tap !== r.tap) {
            r.tap = tap;
            r.sieveKick = 1;
            clack({ freq: 2500, decay: 0.03, gain: 0.07 });
          }
          if (!r.hiss) {
            r.hiss = true;
            // powder through a mesh: a soft, high hiss for the length of the pass
            swell({ source: "noise", filter: "highpass", cutoff: 5200, q: 0.4, attack: 0.4, hold: Math.max(0.2, sw.dur - 0.8), release: 0.7, gain: 0.05 });
          }
        }
      } else if (tau > sw.dur) {
        const u = easeInOut(clamp01((tau - sw.dur) / SIEVE_OUT));
        sieveAt(sw, sw.dur, at);
        sx = lerp(at.x, L.sieve[0], u);
        sz = lerp(at.z, L.sieve[1], u);
        sy = lerp(SIEVE_Y, 0, smooth(Math.max(0, u * 1.4 - 0.4)));
        tilt = Math.sin(Math.PI * u) * 0.1;
        mound = 0.42;
      }
    }
    if (sieveRef.current) {
      sieveRef.current.position.set(sx, sy, sz);
      sieveRef.current.rotation.set(tilt, L.sieveYaw, 0);
    }
    if (moundRef.current) moundRef.current.scale.set(SIEVE_R * 0.8, 0.075 * mound, SIEVE_R * 0.8);
    if (sieveShadowRef.current) {
      sieveShadowRef.current.position.set(sx + 0.05 + sy * 0.2, 0.003, sz + 0.05 + sy * 0.2);
      sieveShadowRef.current.scale.setScalar(SIEVE_R * 2.6 * (1 + sy * 0.4));
      const m = basicOf(sieveShadowRef.current);
      if (m) m.opacity = 0.55 * (1 - clamp01(sy / SIEVE_Y) * 0.7);
    }

    /* ---- the sugar ---- */
    if (sugar && sw) {
      const pts = sugarRef.current;
      if (pts) {
        const u = (pts.material as THREE.ShaderMaterial).uniforms;
        u.uT.value = hasOut ? tau : -1;
        u.uTime.value = e;
        u.uScale.value = pxScale;
        pts.visible = hasOut && tau > 0;
      }
      // the settled letters show behind the sieve as the grains land on them
      const land = (tau - 0.72) / sw.dur;
      const front = !hasOut ? -1e3 : phase === "revealed" ? 1e3 : sw.r0 + (sw.r1 - sw.r0) * land;
      for (let i = 0; i < sugar.planes.length; i++) {
        const m = planeRefs.current[i];
        if (!m) continue;
        (m.material as THREE.ShaderMaterial).uniforms.uFront.value = front;
        m.visible = hasOut && tau > 0.3;
      }
      if (opening && tau > sw.dur + 0.5 && !r.chimed) {
        r.chimed = true;
        tone(784, { seconds: 1.3, gain: 0.1, shimmer: true });
        tone(1175, { seconds: 1.1, gain: 0.07, when: 0.14, shimmer: true });
      }
      if (opening && tau > sw.dur + FALL_MAX + END_HOLD && !doneRef.current) {
        doneRef.current = true;
        onOpenComplete?.();
      }
    }

    /* ---- flour: motes in the window light, and the puffs ---- */
    const motes = moteRef.current;
    if (motes) {
      (motes.material as THREE.ShaderMaterial).uniforms.uScale.value = pxScale;
      const g = motes.geometry;
      const pa = g.attributes.position as THREE.BufferAttribute;
      const sa = g.attributes.aSize as THREE.BufferAttribute;
      const aa = g.attributes.aAlpha as THREE.BufferAttribute;
      const R = L.motes;
      const moteK = phase === "revealed" ? 0.7 : 1;
      for (let i = 0; i < MOTE_N; i++) {
        const v = (MOTES.y[i] + e * MOTES.sp[i]) % 1;
        pa.setXYZ(
          i,
          lerp(R.x0, R.x1, MOTES.u[i]) + Math.sin(e * 0.21 + MOTES.ph[i]) * 0.18 + v * 0.5,
          0.15 + v * 1.5,
          lerp(R.z0, R.z1, MOTES.w[i]) + Math.cos(e * 0.17 + MOTES.ph[i] * 1.3) * 0.14 + v * 0.35,
        );
        sa.setX(i, MOTES.sz[i]);
        aa.setX(i, Math.sin(v * Math.PI) * Math.max(0, 0.4 + 0.4 * Math.sin(e * 1.3 + MOTES.ph[i] * 5)) * moteK);
      }
      pa.needsUpdate = true;
      sa.needsUpdate = true;
      aa.needsUpdate = true;
    }
    const puffs = puffPtsRef.current;
    if (puffs) {
      (puffs.material as THREE.ShaderMaterial).uniforms.uScale.value = pxScale;
      const p = puffRef.current;
      const g = puffs.geometry;
      const pa = g.attributes.position as THREE.BufferAttribute;
      const sa = g.attributes.aSize as THREE.BufferAttribute;
      const aa = g.attributes.aAlpha as THREE.BufferAttribute;
      let any = false;
      for (let i = 0; i < PUFF_ALL; i++) {
        const a = e - p.t0[i];
        if (a < 0 || a > p.life[i]) {
          aa.setX(i, 0);
          continue;
        }
        any = true;
        const cloud = i >= PUFF_N;
        // flour is all drag: it leaves fast and stops in the air
        const drag = cloud ? 1.4 : 3.2;
        const f = (1 - Math.exp(-a * drag)) / drag;
        const fall = cloud ? -0.02 * a : 0.35 * a * a;
        pa.setXYZ(i, p.ox[i] + p.vx[i] * f, Math.max(0.006, p.oy[i] + p.vy[i] * f - fall), p.oz[i] + p.vz[i] * f);
        const k = 1 - a / p.life[i];
        sa.setX(i, p.sz[i] * (cloud ? 0.6 + a * 0.9 : 1));
        aa.setX(i, p.a[i] * (cloud ? k * Math.min(1, a * 8) : k * k));
      }
      pa.needsUpdate = true;
      sa.needsUpdate = true;
      aa.needsUpdate = true;
      puffs.visible = any;
    }

    /* ---- light: the sun breathes a little, as sun through a curtain does ---- */
    if (sunRef.current) sunRef.current.intensity = 2.1 * (1 + Math.sin(e * 0.37) * 0.03 + Math.sin(e * 1.13) * 0.012);

    /* ---- camera: framed per beat, from whichever axis is tighter ---- */
    const cam = camRef.current;
    if (cam) {
      const f = phase === "preview"
        ? L.cams.preview
        : phase === "sealed"
          ? L.cams.sealed
          : phase === "revealed" || (hasOut && t - outAt > 1.0)
            ? L.cams.reveal
            : L.cams.knock;
      const aspect = state.size.width / Math.max(1, state.size.height);
      const near = (f.d / 2) * Math.cos(f.el);
      const byW = f.w / 2 / (TAN_H * aspect) + near * 0.5;
      const byD = ((f.d / 2) * Math.sin(f.el)) / TAN_H + near;
      const dist = Math.max(byW, byD) * 1.04;
      const cs = camStRef.current;
      const k = cs.live ? 1 - Math.exp(-dt * 2.6) : 1;
      cs.live = true;
      cs.x = lerp(cs.x, f.x, k);
      cs.z = lerp(cs.z, f.z, k);
      cs.dist = lerp(cs.dist, dist, k);
      cs.el = lerp(cs.el, f.el, k);
      r.shake = Math.max(0, r.shake - dt * 3.5);
      const shk = opening ? r.shake * r.shake * Math.sin(e * 70) * 0.012 * cs.dist * 0.3 : 0;
      const drift = Math.sin(e * 0.13) * 0.015 * cs.dist;
      cam.position.set(cs.x + drift, cs.dist * Math.sin(cs.el) + shk, cs.z + cs.dist * Math.cos(cs.el));
      cam.lookAt(cs.x + drift * 0.6, 0, cs.z);
    }
  });

  const { w: bw, d: bd, x: bx, z: bz } = L.board;
  const rh = A.rh;
  const sx = A.shape.sx;

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault fov={FOV} near={0.1} far={80} position={[0, 4, 3]} />

      {/* Morning through a window at the back left: a warm key low enough to rake the
          carving, a cool bounce from the room, and a warm floor under it all. */}
      <ambientLight intensity={0.3} color="#ffe8d0" />
      <hemisphereLight args={["#ffe6c4", "#2a1a12", 0.5]} />
      <directionalLight ref={sunRef} position={[-3.4, 3.6, -2.6]} intensity={2.1} color="#ffdcae" />
      <directionalLight position={[2.8, 2.4, 3.2]} intensity={0.32} color="#b9c8ff" />

      {/* the cloth under the board, falling off into the dark */}
      <mesh rotation-x={-Math.PI / 2} position={[bx, -BOARD_T, bz]} geometry={flatPlane} scale={[22, 22, 1]}>
        <meshStandardMaterial map={linenTex} roughness={0.95} metalness={0} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[bx, -BOARD_T + 0.002, bz]} geometry={flatPlane} scale={[16, 16, 1]}>
        <meshBasicMaterial map={vignetteTex} transparent depthWrite={false} />
      </mesh>

      {/* the board */}
      <mesh geometry={BOARD_GEO[L.key]} material={boardMat} position={[bx, 0, bz]} />
      <mesh rotation-x={-Math.PI / 2} position={[bx, 0.002, bz]} geometry={flatPlane} scale={[bw, bd, 1]} renderOrder={1}>
        <meshBasicMaterial map={flourMap} transparent depthWrite={false} />
      </mesh>
      {/* the window, laid across the board by the low sun */}
      <mesh
        rotation={[-Math.PI / 2, 0, L.pool.yaw]}
        position={[L.pool.x, 0.0025, L.pool.z]}
        geometry={flatPlane}
        scale={[L.pool.w, L.pool.d, 1]}
        renderOrder={1}
      >
        <meshBasicMaterial map={windowTex} color="#ffcf94" transparent opacity={0.16} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* contact shadows */}
      <group ref={moldShadowRef}>
        <mesh ref={moldShadowHeadRef} rotation-x={-Math.PI / 2} geometry={flatPlane} scale={[rh * sx * 2.5, rh * 2.5, 1]} material={fx.moldShadow} renderOrder={2} />
        <mesh
          rotation-x={-Math.PI / 2}
          position={[rh * sx + HANDLE_L * 0.45, 0, 0]}
          geometry={flatPlane}
          scale={[HANDLE_L * 1.3, 0.34, 1]}
          material={fx.moldShadow}
          renderOrder={2}
        />
      </group>
      <mesh ref={sieveShadowRef} rotation-x={-Math.PI / 2} geometry={flatPlane} material={fx.sieveShadow} renderOrder={2} />
      <mesh ref={ballShadowRef} rotation-x={-Math.PI / 2} geometry={flatPlane} scale={[BALL_R * 3, BALL_R * 3, 1]} material={fx.ballShadow} renderOrder={2} />
      <mesh
        ref={cookieShadowRef}
        rotation={[-Math.PI / 2, 0, L.moldYaw]}
        position={[L.cookie[0] + 0.03, 0.003, L.cookie[1] + 0.03]}
        geometry={flatPlane}
        scale={[A.shape.rc * sx * 2.6, A.shape.rc * 2.6, 1]}
        material={fx.cookieShadow}
        renderOrder={2}
        visible={false}
      />
      <mesh rotation-x={-Math.PI / 2} position={[L.plate[0] + 0.05, 0.003, L.plate[1] + 0.05]} geometry={flatPlane} scale={[PLATE_R * 2.7, PLATE_R * 2.7, 1]} renderOrder={2}>
        <meshBasicMaterial map={blobTex} color="#000" transparent opacity={0.5} depthWrite={false} />
      </mesh>

      {/* flour the knocks drive out from under the rim */}
      <mesh
        ref={knockRingRef}
        rotation={[-Math.PI / 2, 0, L.moldYaw]}
        position={[L.cookie[0], 0.004, L.cookie[1]]}
        geometry={flatPlane}
        scale={[rh * Math.max(1, sx * 0.85) * 3.4, rh * 3.4, 1]}
        material={fx.knockRing}
        renderOrder={3}
        visible={false}
      />

      {/* the plate at the back: one of each, dusted */}
      <group ref={plateRef} position={[L.plate[0], 0, L.plate[1]]}>
        <mesh geometry={plateGeo} material={plateMat} />
        {PLATE_COOKIES.map(([key, ang, yw], i) => (
          <mesh
            key={i}
            geometry={ASSETS[key].cookieGeo}
            material={ASSETS[key].bakedMat}
            position={[Math.cos(ang) * 0.2, 0.024, Math.sin(ang) * 0.2]}
            rotation-y={yw}
            scale={PLATE_COOKIE_K}
          />
        ))}
      </group>

      {/* the sieve of powdered sugar */}
      <group ref={sieveRef} position={[L.sieve[0], 0, L.sieve[1]]}>
        <mesh geometry={sieveRimGeo} material={tinMat} position={[0, 0.055, 0]} />
        <mesh geometry={sieveLipGeo} material={tinMat} position={[0, 0.11, 0]} rotation-x={Math.PI / 2} />
        <mesh geometry={sieveMeshGeo} material={sieveMeshMat} position={[0, 0.012, 0]} rotation-x={-Math.PI / 2} />
        <mesh ref={moundRef} geometry={unitSphere} material={sugarMoundMat} position={[0, 0.014, 0]} scale={[SIEVE_R * 0.8, 0.075, SIEVE_R * 0.8]} />
        <mesh geometry={sieveHandleGeo} material={tinMat} position={[SIEVE_R + 0.2, 0.095, 0]} rotation-z={Math.PI / 2 - 0.12} />
        <mesh geometry={sieveHookGeo} material={tinMat} position={[SIEVE_R + 0.43, 0.12, 0]} rotation-x={Math.PI / 2} />
        <mesh geometry={sieveHookGeo} material={tinMat} position={[-SIEVE_R - 0.02, 0.1, 0]} rotation-x={Math.PI / 2} scale={0.7} />
      </group>

      {/* the ball of dough, with the date paste already folded in */}
      <mesh ref={ballRef} geometry={ballGeo} material={doughMat} position={[L.ball[0], BALL_R * 0.88, L.ball[1]]} scale={[1, 0.88, 1]} />

      {/* the mold: position/heading → the knock's pitch → turning over */}
      <group ref={moldRef} position={[L.cookie[0], A.headH, L.cookie[1]]} rotation-y={L.moldYaw}>
        <group ref={pitchRef}>
          <group ref={flipRef}>
            <mesh geometry={A.shellGeo} material={moldWoodMat} />
            <mesh geometry={A.cupGeo} material={A.cupMat} />
            <mesh geometry={A.handleGeo} material={moldWoodMat} />
            {/* the dough pressed into the carving, flat face up */}
            <mesh ref={plugRef} geometry={A.cookieGeo} material={A.rawMat} rotation-x={Math.PI} scale={0.985} visible={false} />
          </group>
        </group>
      </group>

      {/* the cookie, knocked out, the pattern on its dome */}
      <mesh ref={cookieRef} geometry={A.cookieGeo} material={A.rawMat} position={[L.cookie[0], 0, L.cookie[1]]} visible={false} />

      {/* the name and the message, in sugar */}
      {sugar && (
        <>
          {sugar.planes.map((p, i) => (
            <mesh
              key={i}
              ref={(m) => {
                planeRefs.current[i] = m;
              }}
              rotation-x={-Math.PI / 2}
              position={[p.x, 0.0035, p.z]}
              geometry={flatPlane}
              scale={[p.w, p.h, 1]}
              material={p.mat}
              renderOrder={4}
              visible={false}
            />
          ))}
          <points ref={sugarRef} geometry={sugar.geo} material={sugar.mat} frustumCulled={false} renderOrder={5} visible={false} />
        </>
      )}

      {/* flour in the air */}
      <points ref={puffPtsRef} geometry={dust.puffGeo} material={dust.puffMat} frustumCulled={false} renderOrder={6} visible={false} />
      <points ref={moteRef} geometry={dust.moteGeo} material={dust.moteMat} frustumCulled={false} renderOrder={7} />

      {/* knock here */}
      {fx.ripple.map((m, i) => (
        <mesh
          key={i}
          ref={(el) => {
            rippleRefs.current[i] = el;
          }}
          rotation-x={-Math.PI / 2}
          geometry={flatPlane}
          material={m}
          renderOrder={3}
          visible={false}
        />
      ))}

      {/* Any tap on the board knocks: the ripple says where, but a thumb that lands
          beside the mold should not be told it missed. Only mounted while wanted. */}
      {phase === "opening" && (
        <mesh
          rotation-x={-Math.PI / 2}
          position={[bx, 0.35, bz]}
          geometry={flatPlane}
          scale={[bw + 4, bd + 4, 1]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
