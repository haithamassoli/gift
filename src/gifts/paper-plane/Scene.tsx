import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import type { Lang } from "../../i18n";
import { makeRadialSprite } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell } from "../audio";

/* ---------- paper ---------- */
// The letter and the plane are one sheet, so the paper variant is both the
// stationery and the aircraft. Ruling, margin and the airmail border are printed
// on both faces, which is how you can tell, mid-flight, what it was torn from.
interface Paper {
  base: string;
  edge: string; // the tint a sheet ages to from the outside in
  fiber: string;
  fiberK: number;
  ink: string;
  rule: string | null;
  margin: string | null;
  airmail: boolean;
  crease: number; // how hard a fold shows on this stock
}
const PAPERS: Record<string, Paper> = {
  notebook: {
    base: "#fbfaf4", edge: "rgba(230,220,196,0.55)", fiber: "#7d7667", fiberK: 0.5, ink: "#1d2b5e",
    rule: "rgba(92,138,204,0.42)", margin: "rgba(218,70,70,0.6)", airmail: false, crease: 1,
  },
  airmail: {
    base: "#f7f6f1", edge: "rgba(222,216,198,0.5)", fiber: "#7d7667", fiberK: 0.45, ink: "#1b2552",
    rule: null, margin: null, airmail: true, crease: 1,
  },
  kraft: {
    base: "#c89f70", edge: "rgba(150,106,62,0.55)", fiber: "#4f3419", fiberK: 1.8, ink: "#2a180b",
    rule: null, margin: null, airmail: false, crease: 1.5,
  },
};

/* ---------- sky ---------- */
// One record per hour: the sky, the city cut against it, the light that falls on
// the sill and the lamp in the room behind you. Everything outside the window is
// painted from it, so the rooftops always sit in the same air as the sky.
interface Sky {
  top: string;
  mid: string;
  low: string;
  city: [string, string, string]; // silhouettes, far → near
  rim: string; // light caught on roof edges
  rimK: number;
  lit: number; // share of windows with a light on
  win: string;
  dark: string;
  disc: "sun" | "moon";
  discCol: string;
  discAt: [number, number];
  discR: number;
  halo: string;
  haloR: number;
  stars: number;
  cloud: string;
  cloudK: number;
  cloudFlat: number; // sunset clouds lie in long streaks
  amb: string;
  ambI: number;
  key: string;
  keyI: number;
  keyAt: [number, number, number];
  lamp: string;
  lampI: number;
  curtain: string;
  glow: number; // how much the unfolded letter lights itself to stay legible
}
const SKIES: Record<string, Sky> = {
  morning: {
    top: "#4f8fd2", mid: "#8fc0e8", low: "#e9e6da",
    city: ["#b3bfca", "#a0968b", "#756a60"], rim: "#fff3d6", rimK: 0.55,
    lit: 0.015, win: "#ffe2a4", dark: "rgba(52,64,80,0.5)",
    disc: "sun", discCol: "#fffaf0", discAt: [9, 3.6], discR: 2.4, halo: "#fff0c8", haloR: 16,
    stars: 0, cloud: "#ffffff", cloudK: 0.8, cloudFlat: 1,
    amb: "#dfe8f4", ambI: 1.05, key: "#fff0d6", keyI: 1.5, keyAt: [4, 6, -5],
    lamp: "#fff3e4", lampI: 0.8, curtain: "#fbf7ee", glow: 0.42,
  },
  sunset: {
    top: "#3a2e6a", mid: "#c06a8c", low: "#ffb27a",
    city: ["#9c6a86", "#653f63", "#3d2942"], rim: "#ffb36e", rimK: 0.8,
    lit: 0.14, win: "#ffcf86", dark: "rgba(30,18,36,0.45)",
    disc: "sun", discCol: "#ffd9a0", discAt: [-6.5, -2.2], discR: 4.2, halo: "#ff9a5a", haloR: 30,
    stars: 0, cloud: "#ffa08c", cloudK: 0.6, cloudFlat: 0.42,
    amb: "#b89cc2", ambI: 0.8, key: "#ffb27a", keyI: 1.5, keyAt: [-6, 2, -5],
    lamp: "#ffd9b4", lampI: 0.85, curtain: "#ffe8dc", glow: 0.4,
  },
  night: {
    top: "#050918", mid: "#121c44", low: "#2f3c6e",
    city: ["#232b52", "#161c3b", "#0c1027"], rim: "#8fa3e0", rimK: 0.22,
    lit: 0.34, win: "#ffc46a", dark: "rgba(4,6,14,0.45)",
    disc: "moon", discCol: "#f4efd8", discAt: [-8, 4.2], discR: 2.2, halo: "#9fb2ff", haloR: 12,
    stars: 230, cloud: "#44548a", cloudK: 0.32, cloudFlat: 0.7,
    amb: "#3a4478", ambI: 0.85, key: "#b9c8ff", keyI: 0.45, keyAt: [-4, 6, -5],
    lamp: "#ffc98c", lampI: 1.55, curtain: "#ffe6c4", glow: 0.45,
  },
};

/* ---------- the sheet ---------- */
// A portrait sheet, 1 × 1.4 (A4-ish), in its own frame: x across, y up the page
// (the nose), z out of the written face. Everything below is a function of this.
const A = 0.5; // half width
const B = 0.7; // half height
const T225 = Math.tan(Math.PI / 8);
const WING_NOSE = 0.025; // the wing crease's distance from the keel at the nose…
const WING_TAIL = 0.14; // …and at the tail: a fuselage that deepens toward the back

/* ---------- the fold chain ---------- */
// The classic dart, made the way a hand makes it: two top corners to the centre
// line, the new slanted edges to the centre again, in half along the centre, and
// each wing down. A fold is a line on the sheet *as it is at that stage*, and the
// side of it that moves. The flat-stage folds (corners, edges) are true 180°
// reflections, so a later fold cuts through the layers an earlier one stacked —
// which is why the regions are found by clipping in the folded frame, below.
type V2 = [number, number];
interface FoldSpec {
  from: V2;
  to: V2;
  ref: V2; // any point on the side that moves
  flat: boolean; // lies flat when done (reflects the region in the stage frame)
  up: 1 | -1; // which face the moving side swings toward: +z is the written face
  closed: number; // angle folded, as the plane
  open: number; // what the crease keeps once it has been flattened by hand
}
// The flat folds stop just short of 180° so stacked layers never share a plane
// (and never flicker); a real plane is puffy there too.
const FOLD_SPECS: FoldSpec[] = [
  { from: [0, B], to: [-A, B - A], ref: [-A, B], flat: true, up: 1, closed: Math.PI - 0.09, open: 0.05 },
  { from: [0, B], to: [A, B - A], ref: [A, B], flat: true, up: 1, closed: Math.PI - 0.09, open: 0.05 },
  { from: [0, B], to: [-A, B - A / T225], ref: [-A, 0], flat: true, up: 1, closed: Math.PI - 0.17, open: 0 },
  { from: [0, B], to: [A, B - A / T225], ref: [A, 0], flat: true, up: 1, closed: Math.PI - 0.17, open: 0 },
  // In half as a mountain: the flaps end up outside, under the wings, so the wing
  // tops are the clean back of the sheet — where the sender's name is written.
  { from: [0, -B], to: [0, B], ref: [-A, 0], flat: false, up: -1, closed: Math.PI / 2 - 0.1, open: 0.07 },
  { from: [0, -B], to: [0, B], ref: [A, 0], flat: false, up: -1, closed: Math.PI / 2 - 0.1, open: 0.07 },
  { from: [-WING_NOSE, B], to: [-WING_TAIL, -B], ref: [-A, -B], flat: false, up: 1, closed: 1.3, open: 0 },
  { from: [WING_NOSE, B], to: [WING_TAIL, -B], ref: [A, -B], flat: false, up: 1, closed: 1.3, open: 0 },
];
// Application order. Every axis lies in the flat z = 0 frame of the layer it
// hinges on, so each rotation is taken in its parent's frame: corners, then
// edges, then the wing about its crease *before* the half fold carries the whole
// half (wing and all) round the keel. That nesting is what lets the half fold open
// while the edges are still moving without anything tearing.
const CHAIN = [0, 1, 2, 3, 6, 7, 4, 5];

interface Iso {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}
const isoApply = (m: Iso, p: V2): V2 => [m.a * p[0] + m.b * p[1] + m.x, m.c * p[0] + m.d * p[1] + m.y];
/** `m`, then a reflection across the line through `c` along unit `d`. */
function reflectAfter(m: Iso, c: V2, d: V2): Iso {
  const r00 = 2 * d[0] * d[0] - 1;
  const r01 = 2 * d[0] * d[1];
  const r11 = 2 * d[1] * d[1] - 1;
  const tx = c[0] - (r00 * c[0] + r01 * c[1]);
  const ty = c[1] - (r01 * c[0] + r11 * c[1]);
  return {
    a: r00 * m.a + r01 * m.c,
    b: r00 * m.b + r01 * m.d,
    c: r01 * m.a + r11 * m.c,
    d: r01 * m.b + r11 * m.d,
    x: r00 * m.x + r01 * m.y + tx,
    y: r01 * m.x + r11 * m.y + ty,
  };
}

/** Split a convex polygon by the sign of `g` (one value per vertex). */
function clipPoly(poly: V2[], g: number[]): [V2[], V2[]] {
  const EPS = 1e-7;
  const pos: V2[] = [];
  const neg: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const p = poly[i];
    const q = poly[j];
    if (g[i] >= -EPS) pos.push(p);
    if (g[i] <= EPS) neg.push(p);
    if ((g[i] > EPS && g[j] < -EPS) || (g[i] < -EPS && g[j] > EPS)) {
      const t = g[i] / (g[i] - g[j]);
      const x: V2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      pos.push(x);
      neg.push(x);
    }
  }
  return [pos, neg];
}
function polyArea(p: V2[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    s += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return s / 2;
}

interface Fold3 {
  P: THREE.Vector3;
  D: THREE.Vector3;
  closed: number;
  open: number;
}

/**
 * Cut the sheet into the rigid facets the dart folds it into. Each fold is
 * applied to every current region *in the stage frame* (the region's own
 * reflection history maps it there), so the cut lands where the crease really is
 * on every layer it passes through. What comes back: facets with the bitmask of
 * folds that carry them, triangulated and lightly subdivided, with vertices ON
 * every crease — no face ever straddles a fold.
 */
function buildFoldModel() {
  const folds: Fold3[] = [];
  const lines = FOLD_SPECS.map((s) => {
    const dx = s.to[0] - s.from[0];
    const dy = s.to[1] - s.from[1];
    const len = Math.hypot(dx, dy);
    const d: V2 = [dx / len, dy / len];
    const side = Math.sign(d[0] * (s.ref[1] - s.from[1]) - d[1] * (s.ref[0] - s.from[0]));
    // Orient the 3D axis so a positive angle swings the moving side toward `up`.
    const D = new THREE.Vector3(d[0], d[1], 0);
    const m = new THREE.Vector3(-d[1] * side, d[0] * side, 0);
    if (new THREE.Vector3().crossVectors(D, m).z * s.up < 0) D.negate();
    folds.push({ P: new THREE.Vector3(s.from[0], s.from[1], 0), D, closed: s.closed, open: s.open });
    return { c: s.from, d, side, flat: s.flat };
  });

  let regions: { poly: V2[]; T: Iso; mask: number }[] = [
    { poly: [[-A, -B], [A, -B], [A, B], [-A, B]], T: { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }, mask: 0 },
  ];
  lines.forEach((f, k) => {
    const next: typeof regions = [];
    for (const r of regions) {
      const g = r.poly.map((p) => {
        const q = isoApply(r.T, p);
        return f.side * (f.d[0] * (q[1] - f.c[1]) - f.d[1] * (q[0] - f.c[0]));
      });
      const [mv, st] = clipPoly(r.poly, g);
      if (st.length >= 3 && polyArea(st) > 1e-7) next.push({ poly: st, T: r.T, mask: r.mask });
      if (mv.length >= 3 && polyArea(mv) > 1e-7) {
        next.push({ poly: mv, T: f.flat ? reflectAfter(r.T, f.c, f.d) : r.T, mask: r.mask | (1 << k) });
      }
    }
    regions = next;
  });

  // Crease segments, for drawing onto the paper: every facet edge that is not the
  // sheet's own border, de-duplicated (each crease is shared by two facets).
  const creases: [number, number, number, number][] = [];
  const seen = new Set<string>();
  const onBorder = (p: V2, q: V2) =>
    (Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(Math.abs(p[0]) - A) < 1e-6) ||
    (Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(Math.abs(p[1]) - B) < 1e-6);
  for (const r of regions) {
    for (let i = 0; i < r.poly.length; i++) {
      const p = r.poly[i];
      const q = r.poly[(i + 1) % r.poly.length];
      if (onBorder(p, q) || Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-5) continue;
      const k1 = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
      const k2 = `${q[0].toFixed(4)},${q[1].toFixed(4)}`;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      creases.push([p[0], p[1], q[0], q[1]]);
    }
  }

  // Fan-triangulate each (convex) facet and split every triangle into a small
  // barycentric grid: the facets are rigid, but a sheet this size under a
  // perspective camera wants more than two triangles per panel.
  const SUB = 3;
  const pos: number[] = [];
  const uv: number[] = [];
  const mask: number[] = [];
  const index: number[] = [];
  for (const r of regions) {
    const P = r.poly;
    for (let t = 1; t < P.length - 1; t++) {
      const v0 = P[0];
      const v1 = P[t];
      const v2 = P[t + 1];
      const rows: number[] = [];
      for (let i = 0; i <= SUB; i++) {
        rows.push(pos.length / 3);
        for (let j = 0; j <= SUB - i; j++) {
          const a = i / SUB;
          const b = j / SUB;
          const x = v0[0] + (v1[0] - v0[0]) * a + (v2[0] - v0[0]) * b;
          const y = v0[1] + (v1[1] - v0[1]) * a + (v2[1] - v0[1]) * b;
          pos.push(x, y, 0);
          uv.push((x + A) / (2 * A), (y + B) / (2 * B));
          mask.push(r.mask);
        }
      }
      for (let i = 0; i < SUB; i++) {
        for (let j = 0; j < SUB - i; j++) {
          const p00 = rows[i] + j;
          const p01 = rows[i] + j + 1;
          const p10 = rows[i + 1] + j;
          index.push(p00, p10, p01);
          if (j < SUB - i - 1) index.push(p10, rows[i + 1] + j + 1, p01);
        }
      }
    }
  }
  return {
    folds,
    creases,
    rest: new Float32Array(pos),
    uv: new Float32Array(uv),
    mask: new Uint8Array(mask),
    index: new Uint16Array(index),
  };
}
const MODEL = buildFoldModel();
const VERTS = MODEL.mask.length;

// Per-fold rotation matrices, rebuilt whenever the angles change. Module scratch:
// one sheet is folded at a time and nothing here survives the call.
const ROT = new Float32Array(8 * 9);
const ACTIVE = new Uint8Array(8);
/** Fold the flat sheet by `ang` (one angle per fold) into `pos` / `nor`. */
function foldSheet(ang: Float32Array, pos: Float32Array, nor: Float32Array) {
  for (let k = 0; k < 8; k++) {
    const th = ang[k];
    ACTIVE[k] = Math.abs(th) > 1e-6 ? 1 : 0;
    if (!ACTIVE[k]) continue;
    const { x, y, z } = MODEL.folds[k].D;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const t = 1 - c;
    const o = k * 9;
    ROT[o] = t * x * x + c;
    ROT[o + 1] = t * x * y - s * z;
    ROT[o + 2] = t * x * z + s * y;
    ROT[o + 3] = t * x * y + s * z;
    ROT[o + 4] = t * y * y + c;
    ROT[o + 5] = t * y * z - s * x;
    ROT[o + 6] = t * x * z - s * y;
    ROT[o + 7] = t * y * z + s * x;
    ROT[o + 8] = t * z * z + c;
  }
  const rest = MODEL.rest;
  for (let i = 0; i < VERTS; i++) {
    let x = rest[i * 3];
    let y = rest[i * 3 + 1];
    let z = 0;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    const m = MODEL.mask[i];
    for (let q = 0; q < 8; q++) {
      const k = CHAIN[q];
      if (!ACTIVE[k] || !(m & (1 << k))) continue;
      const P = MODEL.folds[k].P;
      const o = k * 9;
      const px = x - P.x;
      const py = y - P.y;
      const pz = z - P.z;
      x = ROT[o] * px + ROT[o + 1] * py + ROT[o + 2] * pz + P.x;
      y = ROT[o + 3] * px + ROT[o + 4] * py + ROT[o + 5] * pz + P.y;
      z = ROT[o + 6] * px + ROT[o + 7] * py + ROT[o + 8] * pz + P.z;
      const mx = nx;
      const my = ny;
      const mz = nz;
      nx = ROT[o] * mx + ROT[o + 1] * my + ROT[o + 2] * mz;
      ny = ROT[o + 3] * mx + ROT[o + 4] * my + ROT[o + 5] * mz;
      nz = ROT[o + 6] * mx + ROT[o + 7] * my + ROT[o + 8] * mz;
    }
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    nor[i * 3] = nx;
    nor[i * 3 + 1] = ny;
    nor[i * 3 + 2] = nz;
  }
}

function buildSheetGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(MODEL.rest.slice(), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage),
  );
  geo.setAttribute("uv", new THREE.BufferAttribute(MODEL.uv.slice(), 2));
  geo.setIndex(new THREE.BufferAttribute(MODEL.index.slice(), 1));
  // Two groups over the same triangles: the written face and the back are two
  // materials on ONE mesh, drawn front-side and back-side respectively.
  geo.addGroup(0, MODEL.index.length, 0);
  geo.addGroup(0, MODEL.index.length, 1);
  return geo;
}

/* ---------- stage (world units) ---------- */
const FOV = 40;
const TAN = Math.tan((FOV * Math.PI) / 360);
const CAM_Y0 = 0.42;
const CAM_Z0 = 2.7;
const LOOK = new THREE.Vector3(0, -0.1, 0);
const ACTION_W = 1.35; // the plane at rest, with air round it, must fit across a phone
const SILL_Y = -0.5;
const SILL_BACK = -0.6;
const SILL_FRONT = 1.12;
const WALL_Z = 0.96; // the room-side face of a thick old wall
const FRAME_Z = -0.47; // the painted frame sits at the outer end of the reveal
const FRAME_D = 0.2;
const JW = 0.15;
const PLANE_S = 0.6;
const LETTER_W = 2 * A * PLANE_S;
const LETTER_H = 2 * B * PLANE_S;

// sheet frame → plane body frame (nose −Z, up +Y): the nose is the top of the page
// and "up" for the plane is the back of the sheet. A half-turn about (0, 1, −1).
const Q_FOLD = new THREE.Quaternion(0, Math.SQRT1_2, -Math.SQRT1_2, 0);

/* ---------- module temporaries (never allocate in useFrame) ---------- */
const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _camBase = new THREE.Vector3();
const _look = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Orientation of a body whose nose points along unit `f`, rolled and pitched in its own frame. */
function bodyQuat(out: THREE.Quaternion, f: THREE.Vector3, roll: number, pitch: number) {
  _z.copy(f).negate();
  _x.crossVectors(UP, _z).normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  out.setFromRotationMatrix(_m);
  _q.setFromEuler(_e.set(pitch, 0, roll));
  return out.multiply(_q);
}

/** How far the folded plane's lowest point sits below its keel, at a given roll. */
function restLift(roll: number) {
  const ang = new Float32Array(8);
  for (let k = 0; k < 8; k++) ang[k] = MODEL.folds[k].closed;
  const pos = new Float32Array(VERTS * 3);
  foldSheet(ang, pos, new Float32Array(VERTS * 3));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, roll)).multiply(Q_FOLD);
  const v = new THREE.Vector3();
  let lo = Infinity;
  for (let i = 0; i < VERTS; i++) lo = Math.min(lo, v.fromArray(pos, i * 3).applyQuaternion(q).y);
  return -lo * PLANE_S + 0.004;
}

/* ---------- where it rests, and where it lands ---------- */
// At rest it points out of the window and to the left, tipped onto its near wing
// so the wing top — and the name on it — turns toward you.
const REST_ROLL = 0.2;
const REST_FWD = new THREE.Vector3(-0.9, 0, -0.42).normalize();
const REST_POS = new THREE.Vector3(0.12, SILL_Y + restLift(REST_ROLL), 0.2);
const LAND_Y = SILL_Y + restLift(0);
const LAND_TOUCH = new THREE.Vector3(0.06, LAND_Y, 0.52);
const SKID_LEN = 0.2;

/* ---------- the flight ---------- */
// Out over the sill and the drop, a long bank round the far roofs, and home from
// the right. Sampled by arc length so the speed reads evenly through the turn.
const FLIGHT = new THREE.CatmullRomCurve3(
  [
    REST_POS.clone(),
    REST_POS.clone().addScaledVector(REST_FWD, 0.45).setY(REST_POS.y + 0.12),
    new THREE.Vector3(-0.72, -0.08, -1.5),
    new THREE.Vector3(-1.95, 0.24, -3.3),
    new THREE.Vector3(-1.55, 0.58, -5.5),
    new THREE.Vector3(0.45, 0.74, -6.4),
    new THREE.Vector3(2.05, 0.55, -4.7),
    new THREE.Vector3(1.55, 0.2, -2.4),
    new THREE.Vector3(0.36, -0.14, -0.7),
    new THREE.Vector3(0.16, -0.36, 0.12),
    LAND_TOUCH.clone(),
  ],
  false,
  "centripetal",
  0.5,
);
FLIGHT.getLength(); // warm the arc-length table now, not on the first flying frame
const LAND_FWD = FLIGHT.getTangentAt(1).setY(0).normalize();

/* ---------- opening timeline (seconds) ---------- */
const IDLE_THROW = 6.8; // nobody has thrown it: the breeze takes it
const GUST_LEAD = 0.9; // the gust that lifts its nose just before it goes
const FLICK_PX = 22;
const FLY_DUR = 4.8;
const SKID_DUR = 0.45;
const UNFOLD_AT = 0.6; // after touchdown
// Each fold's [start, duration] after the unfold begins, in FOLD_SPECS order. The
// reverse of how it was made: wings up, the half opens like a book, the edge
// flaps, then the corners — each corner only once its edge flap is flat, since
// the edge fold was made *through* the folded corner.
const UNFOLD: [number, number][] = [
  [2.2, 0.5],
  [2.42, 0.5],
  [1.52, 0.58],
  [1.74, 0.58],
  [0.95, 0.75],
  [0.95, 0.75],
  [0, 0.5],
  [0.08, 0.5],
];
const UNFOLD_END = 2.92;
const SETTLE = 0.6;
const OPEN_END = FLY_DUR + UNFOLD_AT + UNFOLD_END + SETTLE;

/** Paper springs open: an ease-in-out with the smallest overshoot past flat. */
const openEase = (x: number) => easeInOut(x) + 0.07 * Math.sin(Math.PI * x) * x * x;

/* ---------- the invitation: dots arcing from the nose out through the window ---------- */
const HINT_N = 7;
const HINT_DOTS = (() => {
  // the line a throw would take: off the nose, up over the rail, out
  const nose = REST_POS.clone().addScaledVector(REST_FWD, B * PLANE_S * 1.05);
  nose.y += 0.05;
  const ctrl = new THREE.Vector3(nose.x - 0.2, -0.12, nose.z - 0.45);
  const end = new THREE.Vector3(nose.x - 0.42, -0.02, -0.95);
  const curve = new THREE.QuadraticBezierCurve3(nose, ctrl, end);
  return Array.from({ length: HINT_N }, (_, i) => curve.getPoint((i + 0.6) / HINT_N));
})();

/* ---------- city ---------- */
interface Layer {
  z: number;
  w: number;
  h: number;
  lo: number; // lowest roofline, world y
  hi: number; // highest
  px: number; // canvas width
  bw: [number, number]; // building widths
  seed: number;
  clutter: number; // tanks, dishes, antennas per roof
  winS: number; // window scale: smaller with distance
  mist: number;
  spires: number; // minarets
  domes: number;
}
const LAYERS: Layer[] = [
  { z: -24, w: 64, h: 9, lo: -4.0, hi: -1.5, px: 1024, bw: [0.9, 2.5], seed: 11, clutter: 0.35, winS: 0.75, mist: 0.6, spires: 2, domes: 2 },
  { z: -13, w: 36, h: 7, lo: -3.6, hi: -1.9, px: 2048, bw: [0.7, 1.8], seed: 23, clutter: 0.8, winS: 0.85, mist: 0.42, spires: 1, domes: 1 },
  { z: -6.5, w: 22, h: 5.5, lo: -2.6, hi: -1.85, px: 2048, bw: [0.6, 1.45], seed: 37, clutter: 1, winS: 1, mist: 0.28, spires: 0, domes: 0 },
];
const layerTop = (L: Layer) => L.hi + 1.7;

function srgb<T extends THREE.Texture>(tex: T): T {
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * One rooftop layer as a single canvas: flat roofs and parapets, black water
 * tanks, solar heaters, dishes, antennas and washing lines — the skyline of any
 * Levant or Gulf city seen from a fourth floor — with the odd dome and minaret,
 * and windows that light up with the hour. Silhouettes, one colour per layer,
 * so the depth is all in the air between them.
 */
function buildCity(sky: Sky, L: Layer, idx: number): THREE.CanvasTexture {
  const ppu = L.px / L.w;
  const W = L.px;
  const H = Math.round(L.h * ppu);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const rand = mulberry32(L.seed);
  const top = layerTop(L);
  const Y = (y: number) => (top - y) * ppu;
  const U = (u: number) => u * ppu;
  const base = new THREE.Color(sky.city[idx]);
  const shade = new THREE.Color();
  const col = sky.city[idx];

  const blds: { x: number; w: number; y: number }[] = [];
  for (let x = -U(0.4); x < W + U(0.4); ) {
    const w = U(L.bw[0] + rand() * (L.bw[1] - L.bw[0]));
    const r = rand();
    const k = r < 0.12 ? 0.82 + rand() * 0.18 : Math.pow(rand(), 1.4) * 0.8;
    blds.push({ x, w, y: L.lo + (L.hi - L.lo) * k });
    x += w - 1;
  }

  // walls, each a hair lighter or darker so neighbours separate
  for (const b of blds) {
    shade.copy(base).offsetHSL(0, 0, (rand() - 0.5) * 0.035);
    g.fillStyle = shade.getStyle();
    g.fillRect(b.x, Y(b.y), b.w + 1, H);
    // parapet lip
    g.fillRect(b.x - U(0.02), Y(b.y) - U(0.035), b.w + U(0.04), U(0.035));
  }

  // windows: a regular grid, a few blind columns, the lit ones glowing at night
  const sx = U(0.2 * L.winS);
  const sy = U(0.29 * L.winS);
  const ww = U(0.085 * L.winS);
  const wh = U(0.12 * L.winS);
  for (const b of blds) {
    const cols = Math.floor((b.w - U(0.12)) / sx);
    if (cols < 1) continue;
    const x0 = b.x + (b.w - cols * sx) / 2 + (sx - ww) / 2;
    const y0 = Y(b.y) + U(0.16);
    const rows = Math.floor(Math.min(H - y0, U(2.6)) / sy);
    for (let ci = 0; ci < cols; ci++) {
      if (rand() < 0.12) continue;
      for (let ri = 0; ri < rows; ri++) {
        const x = x0 + ci * sx;
        const y = y0 + ri * sy;
        if (rand() < sky.lit * (0.1 + 0.9 * Math.pow(L.winS, 6))) {
          const tv = rand() < 0.08;
          const pad = ww * 0.3;
          g.globalAlpha = 0.22;
          g.fillStyle = tv ? "#9fc4ff" : sky.win;
          g.fillRect(x - pad, y - pad, ww + pad * 2, wh + pad * 2);
          g.globalAlpha = 0.95;
          g.fillRect(x, y, ww, wh);
          g.globalAlpha = 1;
        } else {
          g.fillStyle = sky.dark;
          g.fillRect(x, y, ww, wh);
        }
      }
    }
  }

  g.fillStyle = col;
  g.strokeStyle = col;
  g.lineCap = "round";
  const thin = Math.max(1.2, U(0.013));
  /* ---- roof clutter ---- */
  const tank = (x: number, y: number) => {
    const w = U(0.2);
    const h = U(0.19);
    g.fillRect(x, y - U(0.07), U(0.025), U(0.07));
    g.fillRect(x + w - U(0.025), y - U(0.07), U(0.025), U(0.07));
    g.fillRect(x - U(0.01), y - U(0.08), w + U(0.02), U(0.02));
    g.beginPath();
    g.roundRect(x, y - U(0.08) - h, w, h, [U(0.06), U(0.06), U(0.01), U(0.01)]);
    g.fill();
  };
  const solar = (x: number, y: number) => {
    // a tilted collector with its tank along the top edge
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + U(0.34), y);
    g.lineTo(x + U(0.3), y - U(0.2));
    g.lineTo(x + U(0.1), y - U(0.24));
    g.closePath();
    g.fill();
    g.beginPath();
    g.roundRect(x + U(0.04), y - U(0.33), U(0.34), U(0.1), U(0.05));
    g.fill();
  };
  const dish = (x: number, y: number) => {
    g.lineWidth = thin;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - U(0.14));
    g.stroke();
    g.beginPath();
    g.ellipse(x + U(0.03), y - U(0.2), U(0.09), U(0.05), -0.9, 0, Math.PI);
    g.fill();
  };
  const antenna = (x: number, y: number) => {
    const h = U(0.45 + rand() * 0.35);
    g.lineWidth = thin;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - h);
    for (let i = 0; i < 3; i++) {
      const yy = y - h + U(0.05 + i * 0.08);
      const s = U(0.16 - i * 0.03);
      g.moveTo(x - s, yy);
      g.lineTo(x + s, yy);
    }
    g.stroke();
  };
  const laundry = (x: number, y: number, w: number) => {
    const h = U(0.24);
    g.lineWidth = thin;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - h);
    g.moveTo(x + w, y);
    g.lineTo(x + w, y - h);
    g.stroke();
    g.lineWidth = Math.max(1, thin * 0.6);
    g.beginPath();
    g.moveTo(x, y - h);
    g.quadraticCurveTo(x + w / 2, y - h + U(0.06), x + w, y - h);
    g.stroke();
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const cx = x + (w * (i + 0.7)) / (n + 0.4);
      g.fillRect(cx - U(0.03), y - h + U(0.03), U(0.06 + rand() * 0.04), U(0.08 + rand() * 0.06));
    }
  };
  for (const b of blds) {
    const n = Math.floor(rand() * 3.2 * L.clutter + 0.35);
    for (let k = 0; k < n; k++) {
      const kind = rand();
      const room = b.w - U(0.45);
      if (room <= 0) break;
      const x = b.x + U(0.12) + rand() * room;
      const y = Y(b.y) - U(0.035);
      if (kind < 0.34) tank(x, y);
      else if (kind < 0.5) solar(x, y);
      else if (kind < 0.66) dish(x, y);
      else if (kind < 0.86) antenna(x, y);
      else laundry(x, y, Math.min(room, U(0.5)));
    }
  }
  /* ---- domes and minarets: a few per layer, never next to each other ---- */
  const pick = (n: number, taken: Set<number>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      let j: number;
      let tries = 0;
      do {
        j = 2 + Math.floor(rand() * (blds.length - 4));
        tries++;
      } while ((taken.has(j) || taken.has(j - 1) || taken.has(j + 1)) && tries < 20);
      taken.add(j);
      out.push(j);
    }
    return out;
  };
  const taken = new Set<number>();
  const crescent = (x: number, y: number, r: number) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(x + r * 0.45, y - r * 0.2, r * 0.85, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "source-over";
  };
  for (const j of pick(L.domes, taken)) {
    const b = blds[j];
    const r = Math.min(b.w * 0.36, U(0.55));
    const cx = b.x + b.w / 2;
    const y = Y(b.y) - U(0.035);
    g.fillRect(cx - r * 0.95, y - r * 0.28, r * 1.9, r * 0.28); // the drum
    g.beginPath();
    g.ellipse(cx, y - r * 0.28, r, r * 1.05, 0, Math.PI, 0);
    g.fill();
    g.lineWidth = thin;
    g.beginPath();
    g.moveTo(cx, y - r * 1.33);
    g.lineTo(cx, y - r * 1.62);
    g.stroke();
    crescent(cx, y - r * 1.72, r * 0.12);
  }
  for (const j of pick(L.spires, taken)) {
    const b = blds[j];
    const cx = b.x + b.w / 2;
    const y = Y(b.y);
    const h = U(1.7 + rand() * 0.6);
    const w = U(0.17);
    g.fillRect(cx - w / 2, y - h, w, h);
    g.fillRect(cx - w * 0.95, y - h * 0.72, w * 1.9, U(0.05)); // the balcony
    g.fillRect(cx - w * 0.36, y - h - U(0.28), w * 0.72, U(0.28)); // upper shaft
    g.beginPath();
    g.moveTo(cx - w * 0.5, y - h - U(0.28));
    g.lineTo(cx, y - h - U(0.62));
    g.lineTo(cx + w * 0.5, y - h - U(0.28));
    g.closePath();
    g.fill();
    crescent(cx, y - h - U(0.7), U(0.045));
  }

  /* ---- light caught on the roof edges, strongest on the sun's side ---- */
  const sunLeft = sky.discAt[0] < 0;
  g.strokeStyle = sky.rim;
  for (const b of blds) {
    g.globalAlpha = sky.rimK * (0.35 + 0.5 * rand());
    g.lineWidth = Math.max(1, U(0.016));
    g.beginPath();
    g.moveTo(b.x - U(0.02), Y(b.y) - U(0.035));
    g.lineTo(b.x + b.w + U(0.02), Y(b.y) - U(0.035));
    g.stroke();
    g.globalAlpha *= 0.55;
    const ex = sunLeft ? b.x : b.x + b.w;
    g.beginPath();
    g.moveTo(ex, Y(b.y));
    g.lineTo(ex, Y(b.y) + U(0.8));
    g.stroke();
  }
  g.globalAlpha = 1;

  /* ---- mist settling between the rows of roofs ---- */
  g.globalCompositeOperation = "source-atop";
  const mist = g.createLinearGradient(0, Y(L.hi), 0, Y(L.lo - 1.4));
  mist.addColorStop(0, "rgba(0,0,0,0)");
  const low = new THREE.Color(sky.low);
  mist.addColorStop(1, `rgba(${Math.round(low.r * 255)},${Math.round(low.g * 255)},${Math.round(low.b * 255)},${L.mist})`);
  g.fillStyle = mist;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = "source-over";

  const tex = srgb(new THREE.CanvasTexture(c));
  tex.anisotropy = 4;
  return tex;
}

/* ---------- sky ---------- */
const SKY_Z = -42;
const SKY_TOP = 55;
const SKY_H = 100;
function buildSky(s: Sky): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 512;
  const g = c.getContext("2d")!;
  const at = (y: number) => clamp01((SKY_TOP - y) / SKY_H);
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, s.top);
  // Calibrated to the band the window shows: the far skyline sits near y = -3
  // on this plane and the header cuts it off near y = 7.
  grad.addColorStop(at(9), s.top);
  grad.addColorStop(at(2), s.mid);
  grad.addColorStop(at(-3), s.low);
  grad.addColorStop(1, s.low);
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 512);
  return srgb(new THREE.CanvasTexture(c));
}

/** The sun as a soft-edged disc, or a crescent moon with a little earthshine. */
function buildDisc(s: Sky): THREE.CanvasTexture {
  const n = 128;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  if (s.disc === "sun") {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, s.discCol);
    grad.addColorStop(0.72, s.discCol);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  } else {
    g.fillStyle = s.discCol;
    g.globalAlpha = 0.1;
    g.beginPath();
    g.arc(n / 2, n / 2, n * 0.4, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(n / 2, n / 2, n * 0.4, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(n / 2 + n * 0.17, n / 2 - n * 0.07, n * 0.36, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 0.1;
    g.beginPath();
    g.arc(n / 2, n / 2, n * 0.4, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
  return srgb(new THREE.CanvasTexture(c));
}

/** A soft cumulus: overlapping blobs with a flatter underside. */
function buildCloud(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  const rand = mulberry32(5150);
  for (let i = 0; i < 16; i++) {
    const x = 40 + rand() * 176;
    const y = 58 + rand() * 30 - Math.sin(((x - 40) / 176) * Math.PI) * 22;
    const r = 18 + rand() * 26;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return srgb(new THREE.CanvasTexture(c));
}
const CLOUDS = [
  { x: -18, y: 7.5, w: 13, h: 3.4, sp: 0.12 },
  { x: 4, y: 10, w: 9, h: 2.5, sp: 0.09 },
  { x: 21, y: 5.8, w: 15, h: 3.6, sp: 0.1 },
  { x: -3, y: 4.4, w: 17, h: 2.8, sp: 0.07 },
  { x: -34, y: 3.6, w: 12, h: 2.4, sp: 0.08 },
];

/* ---------- room: wood, paint, a sheer curtain ---------- */
function buildWood(): THREE.CanvasTexture {
  const w = 1024;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#83573a";
  g.fillRect(0, 0, w, h);
  const rand = mulberry32(808);
  for (let i = 0; i < 110; i++) {
    const y = rand() * h;
    const amp = 2 + rand() * 6;
    const f = 0.004 + rand() * 0.01;
    const ph = rand() * 6;
    g.strokeStyle = rand() > 0.5 ? "rgba(70,40,22,0.35)" : "rgba(168,118,78,0.28)";
    g.lineWidth = 0.8 + rand() * 2.2;
    g.beginPath();
    for (let x = 0; x <= w; x += 16) {
      const yy = y + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.1 + ph) * amp * 0.3;
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.stroke();
  }
  // a knot, and the pale wear where elbows and tea glasses have been
  g.strokeStyle = "rgba(60,34,18,0.4)";
  for (let r = 4; r < 22; r += 4) {
    g.beginPath();
    g.ellipse(700, 120, r * 2.2, r * 0.8, 0, 0, Math.PI * 2);
    g.stroke();
  }
  const wear = g.createRadialGradient(w * 0.45, h * 0.6, 10, w * 0.45, h * 0.6, 300);
  wear.addColorStop(0, "rgba(220,180,140,0.18)");
  wear.addColorStop(1, "rgba(220,180,140,0)");
  g.fillStyle = wear;
  g.fillRect(0, 0, w, h);
  const tex = srgb(new THREE.CanvasTexture(c));
  tex.anisotropy = 4;
  return tex;
}
/** Old paint on a wooden frame: a faded teal, chipped down to the wood in places. */
function buildPaint(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3f7f79";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(4411);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
    g.fillRect(rand() * s, rand() * s, 2 + rand() * 6, 1 + rand() * 2);
  }
  for (let i = 0; i < 14; i++) {
    g.fillStyle = "rgba(120,86,56,0.8)";
    g.beginPath();
    g.ellipse(rand() * s, rand() * s, 2 + rand() * 7, 1 + rand() * 3, rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  return srgb(new THREE.CanvasTexture(c));
}
/** Sheer voile: vertical folds baked in as light and shadow, mostly see-through. */
function buildVoile(): THREE.CanvasTexture {
  const w = 256;
  const h = 64;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  // Each fold is a soft highlight where the cloth turns to the light and a grey
  // valley behind it; the valleys are where the most cloth overlaps, so they are
  // also the least see-through.
  for (let x = 0; x < w; x++) {
    const u = (x / w) * Math.PI * 2;
    const fold = Math.sin(u * 5.5 + Math.sin(u * 1.3) * 1.2);
    const lit = Math.max(0, fold);
    const shade = Math.max(0, -fold);
    const v = Math.round(255 - shade * 70);
    g.fillStyle = `rgba(${v},${v - 4},${v - 8},${0.42 + 0.3 * lit * lit + 0.28 * shade})`;
    g.fillRect(x, 0, 1, h);
  }
  return srgb(new THREE.CanvasTexture(c));
}
const WOOD_TEX = buildWood();
const PAINT_TEX = buildPaint();
const VOILE_TEX = buildVoile();
const GLOW_TEX = makeRadialSprite(64);
const SHADOW_TEX = makeRadialSprite(64, [
  [0, "rgba(0,0,0,0.9)"],
  [0.45, "rgba(0,0,0,0.45)"],
  [1, "rgba(0,0,0,0)"],
]);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitPlane = new THREE.PlaneGeometry(1, 1);
const ringGeo = new THREE.RingGeometry(0.3, 0.325, 48);

// The window is sized off the lens, so it frames a phone and a wide laptop alike:
// the jambs always sit just inside the edges of the view, the header along the top.
type Piece = { mat: "frame" | "wall" | "under" | "sill"; place: (o: THREE.Object3D, xj: number, yh: number) => void };
const PIECES: Piece[] = [
  // the painted frame: two jambs, the header and a low bottom rail
  { mat: "frame", place: (o, xj, yh) => { o.position.set(-(xj + JW / 2), (SILL_Y + yh) / 2, FRAME_Z); o.scale.set(JW, yh - SILL_Y, FRAME_D); } },
  { mat: "frame", place: (o, xj, yh) => { o.position.set(xj + JW / 2, (SILL_Y + yh) / 2, FRAME_Z); o.scale.set(JW, yh - SILL_Y, FRAME_D); } },
  { mat: "frame", place: (o, xj, yh) => { o.position.set(0, yh + JW / 2, FRAME_Z); o.scale.set(2 * (xj + JW), JW, FRAME_D); } },
  { mat: "frame", place: (o, xj) => { o.position.set(0, SILL_Y + 0.025, FRAME_Z); o.scale.set(2 * xj, 0.05, FRAME_D); } },
  // the reveal: the thickness of the wall, left, right and overhead
  { mat: "wall", place: (o, xj, yh) => { o.position.set(-(xj + JW), (SILL_Y + yh + JW) / 2, (FRAME_Z + WALL_Z) / 2); o.rotation.set(0, Math.PI / 2, 0); o.scale.set(WALL_Z - FRAME_Z, yh + JW - SILL_Y, 1); } },
  { mat: "wall", place: (o, xj, yh) => { o.position.set(xj + JW, (SILL_Y + yh + JW) / 2, (FRAME_Z + WALL_Z) / 2); o.rotation.set(0, -Math.PI / 2, 0); o.scale.set(WALL_Z - FRAME_Z, yh + JW - SILL_Y, 1); } },
  { mat: "wall", place: (o, xj, yh) => { o.position.set(0, yh + JW, (FRAME_Z + WALL_Z) / 2); o.rotation.set(Math.PI / 2, 0, 0); o.scale.set(2 * (xj + JW), WALL_Z - FRAME_Z, 1); } },
  // the room-side face of the wall, round the opening
  { mat: "wall", place: (o, xj) => { o.position.set(-(xj + JW) - 10, 0, WALL_Z); o.scale.set(20, 40, 1); } },
  { mat: "wall", place: (o, xj) => { o.position.set(xj + JW + 10, 0, WALL_Z); o.scale.set(20, 40, 1); } },
  { mat: "wall", place: (o, xj, yh) => { o.position.set(0, yh + JW + 10, WALL_Z); o.scale.set(2 * (xj + JW), 20, 1); } },
  { mat: "under", place: (o, xj) => { o.position.set(0, SILL_Y - 0.13 - 10, WALL_Z); o.scale.set(2 * (xj + JW), 20, 1); } },
  // the sill, deep enough to leave a paper plane on
  { mat: "sill", place: (o, xj) => { o.position.set(0, SILL_Y - 0.065, (SILL_BACK + SILL_FRONT) / 2); o.scale.set(2 * (xj + JW + 0.3), 0.13, SILL_FRONT - SILL_BACK); } },
];

/* ---------- the letter ---------- */
const TEX_W = 1024;
const TEX_H = Math.round((TEX_W * B) / A);
const PPU = TEX_W / (2 * A); // canvas px per sheet unit
const HAND = "'Noteworthy', 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive";
const AR_FONT = "'Thmanyah Sans', system-ui, sans-serif";
const toCanvas = (x: number, y: number): V2 => [(x + A) * PPU, (B - y) * PPU];

interface Copy {
  salutation: string;
  body: string;
  signature: string;
}
function letterCopy(lang: Lang, recipient: string, message: string, sender: string): Copy {
  const to = recipient.trim();
  const from = sender.trim();
  const ar = lang === "ar";
  return {
    salutation: ar ? (to ? `إلى ${to}،` : "إليك،") : to ? `${to},` : "Hey you,",
    body: message.trim() || (ar ? "أفكّر فيك… من بعيد." : "Thinking of you, from far away."),
    signature: `— ${from || (ar ? "أنا" : "me")}`,
  };
}

/** Wrap on spaces; a word wider than the page (a URL, a run of letters) breaks by character. */
function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      let word = raw;
      while (word.length > 1 && g.measureText(word).width > maxW) {
        let n = word.length - 1;
        while (n > 1 && g.measureText(word.slice(0, n)).width > maxW) n--;
        if (line) out.push(line);
        line = "";
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      const cand = line ? `${line} ${word}` : word;
      if (line && g.measureText(cand).width > maxW) {
        out.push(line);
        line = word;
      } else {
        line = cand;
      }
    }
    out.push(line);
  }
  return out;
}

/** The stock itself: colour, fibre, and edges gone a shade warmer than the middle. */
function paintPaper(g: CanvasRenderingContext2D, p: Paper, seed: number) {
  const W = TEX_W;
  const H = TEX_H;
  g.fillStyle = p.base;
  g.fillRect(0, 0, W, H);
  const rand = mulberry32(seed);
  g.fillStyle = p.fiber;
  for (let i = 0; i < 2600; i++) {
    g.globalAlpha = (0.02 + rand() * 0.06) * p.fiberK;
    const r = 0.6 + rand() * 1.4;
    g.fillRect(rand() * W, rand() * H, r, r);
  }
  g.strokeStyle = p.fiber;
  g.lineWidth = 0.8;
  for (let i = 0; i < 240; i++) {
    g.globalAlpha = (0.025 + rand() * 0.05) * p.fiberK;
    const x = rand() * W;
    const y = rand() * H;
    const a = rand() * Math.PI * 2;
    const l = 6 + rand() * 20;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.6, y + Math.sin(a + 0.6) * l * 0.6, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  g.globalAlpha = 1;
  const edge = g.createRadialGradient(W / 2, H / 2, W * 0.32, W / 2, H / 2, H * 0.8);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(1, p.edge);
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);
}

/** Red and blue barber stripes round the edge: unmistakably par avion. */
function airmailBorder(g: CanvasRenderingContext2D) {
  const W = TEX_W;
  const H = TEX_H;
  const bw = 30;
  const step = 26;
  g.save();
  g.beginPath();
  g.rect(0, 0, W, H);
  g.rect(bw, bw, W - bw * 2, H - bw * 2);
  g.clip("evenodd");
  for (let i = 0; i < W + H; i += step * 4) {
    for (let j = 0; j < 4; j += 2) {
      g.fillStyle = j === 0 ? "#cf3440" : "#24469b";
      const x = i + j * step;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + step, 0);
      g.lineTo(x + step - H, H);
      g.lineTo(x - H, H);
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

/**
 * The creases, in both of their states: a hairline of shadow and a hairline of
 * light beside it. Drawn at the very end, over the ink, as a real fold would be.
 */
function drawCreases(g: CanvasRenderingContext2D, p: Paper) {
  g.lineCap = "round";
  for (const [x0, y0, x1, y1] of MODEL.creases) {
    const [ax, ay] = toCanvas(x0, y0);
    const [bx, by] = toCanvas(x1, y1);
    const len = Math.hypot(bx - ax, by - ay);
    const nx = (-(by - ay) / len) * 1.7;
    const ny = ((bx - ax) / len) * 1.7;
    g.strokeStyle = `rgba(70,56,40,${0.15 * p.crease})`;
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
    g.strokeStyle = `rgba(255,255,255,${0.36 / p.crease})`;
    g.lineWidth = 1.3;
    g.beginPath();
    g.moveTo(ax + nx, ay + ny);
    g.lineTo(bx + nx, by + ny);
    g.stroke();
  }
}

function ruleLines(g: CanvasRenderingContext2D, p: Paper, top: number, pitch: number) {
  if (!p.rule) return;
  g.strokeStyle = p.rule;
  g.lineWidth = 2;
  for (let y = top + pitch; y < TEX_H - 24; y += pitch) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(TEX_W, y);
    g.stroke();
  }
}
function marginLine(g: CanvasRenderingContext2D, p: Paper, x: number) {
  if (!p.margin) return;
  g.strokeStyle = p.margin;
  g.lineWidth = 2.6;
  g.beginPath();
  g.moveTo(x, 0);
  g.lineTo(x, TEX_H);
  g.stroke();
}

/** A doodled dart with a looping dashed trail — the one drawing on the page. */
function doodle(g: CanvasRenderingContext2D, x: number, y: number, s: number, flip: boolean, ink: string) {
  g.save();
  g.translate(x, y);
  g.scale(flip ? -s : s, s);
  g.strokeStyle = ink;
  g.lineWidth = 2.4 / s;
  g.lineJoin = "round";
  g.lineCap = "round";
  g.setLineDash([5 / s, 7 / s]);
  g.beginPath();
  g.moveTo(-8, 10);
  g.bezierCurveTo(-60, 26, -86, -14, -56, -22);
  g.bezierCurveTo(-30, -28, -34, 8, -70, 14);
  g.stroke();
  g.setLineDash([]);
  g.beginPath();
  g.moveTo(34, -12);
  g.lineTo(-6, -2);
  g.lineTo(4, 14);
  g.closePath();
  g.moveTo(34, -12);
  g.lineTo(2, 4);
  g.stroke();
  g.restore();
}

/**
 * The written face. Salutation, message and signature in a hand, laid on the
 * ruling; the hand shrinks until the whole message fits the page, and the ruling
 * is drawn at whatever pitch the hand settled on.
 */
function buildLetter(p: Paper, lang: Lang, copy: Copy): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = TEX_W;
  c.height = TEX_H;
  const g = c.getContext("2d")!;
  paintPaper(g, p, 7);
  const rtl = lang === "ar";
  const fam = rtl ? AR_FONT : HAND;
  const wt = rtl ? "500" : "400";
  const inset = p.airmail ? 44 : 0;
  const startPad = (p.margin ? 150 : 104) + inset;
  const endPad = 88 + inset;
  const left = rtl ? endPad : startPad;
  const right = TEX_W - (rtl ? startPad : endPad);
  const boxW = right - left;
  const top = 96 + inset;
  const bottom = TEX_H - 90 - inset;
  if (rtl) g.direction = "rtl";

  let fs = 72;
  let pitch = 100;
  let lines: string[] = [];
  for (; fs >= 24; fs -= 2) {
    g.font = `${wt} ${fs}px ${fam}`;
    lines = wrapText(g, copy.body, boxW);
    pitch = Math.round(fs * (rtl ? 1.6 : 1.46));
    if (top + (lines.length + 3) * pitch <= bottom) break;
  }
  ruleLines(g, p, top, pitch);
  marginLine(g, p, rtl ? TEX_W - startPad + 36 : startPad - 36);
  if (p.airmail) airmailBorder(g);

  // A short note does not huddle at the top of an empty page: it drops a few
  // rules toward the middle (whole rules, so it still sits on the ruling).
  const slack = Math.floor((bottom - top) / pitch) - (lines.length + 3);
  const drop = Math.max(0, Math.floor(slack * 0.45));
  const base = (k: number) => top + pitch * (k + 1 + drop) - pitch * 0.16;
  g.fillStyle = p.ink;
  g.shadowColor = p.ink;
  g.shadowBlur = 1.4;
  g.textBaseline = "alphabetic";
  const fit = (text: string, size: number, maxW: number) => {
    g.font = `${wt} ${size}px ${fam}`;
    const w = g.measureText(text).width;
    if (w > maxW) g.font = `${wt} ${Math.floor((size * maxW) / w)}px ${fam}`;
  };
  // salutation on the first rule, message under it, the name at the end side
  g.textAlign = rtl ? "right" : "left";
  fit(copy.salutation, Math.round(fs * 1.14), boxW);
  g.fillText(copy.salutation, rtl ? right : left, base(0));
  g.font = `${wt} ${fs}px ${fam}`;
  lines.forEach((l, i) => g.fillText(l, rtl ? right : left, base(i + 1)));
  const sigK = lines.length + 2;
  g.textAlign = rtl ? "left" : "right";
  fit(copy.signature, Math.round(fs * 1.06), boxW * 0.7);
  const sx = rtl ? left + 24 : right - 24;
  g.fillText(copy.signature, sx, base(sigK));
  g.shadowBlur = 0;
  doodle(g, rtl ? right - 80 : left + 90, base(sigK) - fs * 0.3, fs / 46, rtl, p.ink);

  drawCreases(g, p);
  const tex = srgb(new THREE.CanvasTexture(c));
  tex.anisotropy = 8;
  return tex;
}

/** Point a canvas at a spot on the sheet with text running along `eb`, tops toward `eu`. */
function sheetFrame(g: CanvasRenderingContext2D, x: number, y: number, eb: V2, eu: V2) {
  const [cx, cy] = toCanvas(x, y);
  g.setTransform(eb[0], -eb[1], -eu[0], eu[1], cx, cy);
}

/**
 * The back of the sheet — which, folded, is the top of both wings. The sender's
 * name goes on the near wing, written along it from nose to tail so it reads
 * left to right as the plane sits on the sill. (The text axes are chosen so it
 * reads unmirrored from *behind* the sheet, which is where the wing top is.)
 */
function buildBack(p: Paper, lang: Lang, sender: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = TEX_W;
  c.height = TEX_H;
  const g = c.getContext("2d")!;
  paintPaper(g, p, 19);
  ruleLines(g, p, 96, 96);
  // seen from behind, the margin is on the other edge
  marginLine(g, p, TEX_W - 114);
  const rtl = lang === "ar";
  const fam = rtl ? AR_FONT : HAND;
  const wt = rtl ? "600" : "400";
  if (p.airmail) {
    airmailBorder(g);
    // the blue label, on the far wing
    sheetFrame(g, -0.27, -0.4, [0, -1], [-1, 0]);
    g.fillStyle = "#24469b";
    g.beginPath();
    g.roundRect(-190, -50, 380, 100, 12);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(-180, -40, 360, 80, 8);
    g.stroke();
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `700 30px ${rtl ? AR_FONT : "system-ui, sans-serif"}`;
    if (rtl) g.direction = "rtl";
    g.fillText(rtl ? "بريد جوي" : "BY AIR MAIL", 0, -12);
    g.direction = "ltr";
    g.font = "600 22px system-ui, sans-serif";
    g.fillText("PAR AVION", 0, 22);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  const name = sender.trim() || (rtl ? "أنا" : "me");
  sheetFrame(g, 0.255, -0.38, [0, -1], [-1, 0]);
  if (rtl) g.direction = "rtl";
  g.textAlign = "center";
  g.textBaseline = "middle";
  let fs = 124;
  g.font = `${wt} ${fs}px ${fam}`;
  const maxW = 0.56 * PPU;
  const w = g.measureText(name).width;
  if (w > maxW) {
    fs = Math.max(34, Math.floor((fs * maxW) / w));
    g.font = `${wt} ${fs}px ${fam}`;
  }
  g.fillStyle = p.ink;
  g.shadowColor = p.ink;
  g.shadowBlur = 1.4;
  g.fillText(name, 0, 0);
  // a quick swash under it
  const tw = Math.min(maxW, g.measureText(name).width);
  g.shadowBlur = 0;
  g.strokeStyle = p.ink;
  g.lineWidth = 4;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(-tw * 0.45, fs * 0.52);
  g.quadraticCurveTo(0, fs * 0.72, tw * 0.5, fs * 0.46);
  g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.direction = "ltr";
  drawCreases(g, p);
  const tex = srgb(new THREE.CanvasTexture(c));
  tex.anisotropy = 8;
  return tex;
}

/* ---------- per-run state ---------- */
function freshRun() {
  return {
    down: false,
    sx: 0,
    sy: 0,
    alone: 0, // seconds since the last real pointer on the plane
    windup: false,
    thrownAt: -1,
    whoosh: false,
    landed: false,
    clacks: 0, // bitmask: which folds have already made their sound
    yaw: 0,
    yawOk: false,
    bank: 0,
    pitch: 0, // the breeze under the nose: a spring, pinned at the sill
    pitchV: 0,
    gust: 0,
    gustCyc: -1,
    look: LOOK.clone(),
    lookOk: false,
  };
}

export default function PaperPlaneScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const paper = PAPERS[variants.paper] ?? PAPERS.notebook;
  const sky = SKIES[variants.sky] ?? SKIES.morning;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  /* ---------- the sheet: one mesh, folded in the frame loop ---------- */
  const sheetGeo = useMemo(() => buildSheetGeometry(), []);
  useEffect(() => () => sheetGeo.dispose(), [sheetGeo]);

  const copy = useMemo(() => letterCopy(lang, recipientName, message, senderName), [lang, recipientName, message, senderName]);
  const front = useMemo(() => buildLetter(paper, lang, copy), [paper, lang, copy]);
  useEffect(() => () => front.dispose(), [front]);
  const back = useMemo(() => buildBack(paper, lang, senderName), [paper, lang, senderName]);
  useEffect(() => () => back.dispose(), [back]);

  // The written face also lights itself a little once open (emissiveMap = the
  // letter), so the ink stays legible whatever the hour does to the room.
  const sheetMats = useMemo(
    () => [
      new THREE.MeshStandardMaterial({
        map: front,
        emissiveMap: front,
        emissive: new THREE.Color("#ffffff"),
        emissiveIntensity: 0,
        roughness: 0.93,
        side: THREE.FrontSide,
      }),
      new THREE.MeshStandardMaterial({ map: back, roughness: 0.93, side: THREE.BackSide }),
    ],
    [front, back],
  );
  useEffect(() => () => sheetMats.forEach((m) => m.dispose()), [sheetMats]);

  /* ---------- outside ---------- */
  const outside = useMemo(
    () => ({
      sky: buildSky(sky),
      disc: buildDisc(sky),
      cloud: buildCloud(),
      city: LAYERS.map((L, i) => buildCity(sky, L, i)),
    }),
    [sky],
  );
  useEffect(
    () => () => {
      outside.sky.dispose();
      outside.disc.dispose();
      outside.cloud.dispose();
      outside.city.forEach((t) => t.dispose());
    },
    [outside],
  );

  // Stars: positions fixed, colours written through the points ref to twinkle.
  const stars = useMemo(() => {
    const n = sky.stars;
    const rand = mulberry32(2718);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const lum = new Float32Array(n);
    const ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rand() * 2 - 1) * 45;
      pos[i * 3 + 1] = -1.5 + Math.pow(rand(), 0.8) * 16;
      pos[i * 3 + 2] = SKY_Z + 1;
      lum[i] = 0.35 + Math.pow(rand(), 2) * 0.65;
      ph[i] = rand() * 100;
    }
    return { n, pos, col, lum, ph };
  }, [sky.stars]);

  const curtainGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 3.8, 8, 20);
    (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    return { geo, rest: (geo.attributes.position.array as Float32Array).slice() };
  }, []);
  useEffect(() => () => curtainGeo.geo.dispose(), [curtainGeo]);

  /* ---------- refs ---------- */
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const sheetRef = useRef<THREE.Mesh>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const curtainRef = useRef<THREE.Mesh>(null);
  const pieceRefs = useRef<(THREE.Mesh | null)[]>([]);
  const cloudRefs = useRef<(THREE.Sprite | null)[]>([]);
  const starsRef = useRef<THREE.Points>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const dotRefs = useRef<(THREE.Sprite | null)[]>([]);
  const lampRef = useRef<THREE.PointLight>(null);
  const discRef = useRef<THREE.Sprite>(null);
  const haloRef = useRef<THREE.Sprite>(null);
  const angRef = useRef(new Float32Array(8));
  const lastAngRef = useRef(new Float32Array(8).fill(NaN));
  const layoutRef = useRef<{ aspect: number; xj: number; yh: number; sky: Sky | null }>({ aspect: -1, xj: 1, yh: 1, sky: null });

  const runRef = useRef(freshRun());
  useEffect(() => {
    if (phase === "opening") runRef.current = freshRun();
  }, [phase]);

  /* ---------- the throw ---------- */
  // Down on the plane, then a flick in any direction past a few pixels throws it
  // on the spot; a plain tap throws it on release. Nobody hunts for the motion.
  const throwNow = () => {
    const r = runRef.current;
    r.thrownAt = tRef.current;
    r.down = false;
    swell({ source: "noise", cutoff: 1100, q: 0.7, attack: 0.08, hold: 0.25, release: 1.1, gain: 0.2 });
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const r = runRef.current;
    if (phase !== "opening" || r.thrownAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    r.down = true;
    r.sx = ev.nativeEvent.clientX;
    r.sy = ev.nativeEvent.clientY;
    r.alone = 0;
    r.windup = false;
    r.pitchV += 0.7; // it lifts to meet your hand
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const r = runRef.current;
    if (phase !== "opening" || r.thrownAt >= 0) return;
    // a pointer over the plane is somebody about to throw it: the breeze waits
    r.alone = 0;
    r.windup = false;
    if (!r.down) return;
    ev.stopPropagation();
    const dx = ev.nativeEvent.clientX - r.sx;
    const dy = ev.nativeEvent.clientY - r.sy;
    if (dx * dx + dy * dy > FLICK_PX * FLICK_PX) throwNow();
  };
  const onUp = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const r = runRef.current;
    if (phase === "opening" && r.down && r.thrownAt < 0) throwNow();
    r.down = false;
  };
  const onCancel = () => {
    runRef.current.down = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    const opening = phase === "opening";
    if (opening) tRef.current += dt;
    const t = tRef.current;
    const r = runRef.current;
    const aspect = state.size.width / Math.max(1, state.size.height);

    /* ---------- framing: pull the lens back until the sill fits a phone ---------- */
    const camZ = Math.max(CAM_Z0, ACTION_W / 2 / (TAN * aspect) + 0.3);
    const camY = CAM_Y0 + (camZ - CAM_Z0) * 0.1;
    _camBase.set(0, camY, camZ);

    const lay = layoutRef.current;
    if (Math.abs(lay.aspect - aspect) > 1e-4 || lay.sky !== sky) {
      lay.aspect = aspect;
      lay.sky = sky;
      const dFrame = camZ - FRAME_Z;
      const pitch0 = Math.atan2(camY - LOOK.y, camZ - LOOK.z);
      lay.xj = Math.min(2.3, Math.max(0.6, dFrame * TAN * aspect * 0.86 - JW));
      lay.yh = Math.min(2.8, camY + dFrame * Math.tan((FOV * Math.PI) / 360 - pitch0) - 0.16);
      PIECES.forEach((pc, i) => {
        const o = pieceRefs.current[i];
        if (o) pc.place(o, lay.xj, lay.yh);
      });
      // a narrow window would hide a low sun behind its jamb: bring it in
      const dx = sky.discAt[0] * Math.min(1, Math.max(0.45, aspect / 2.2));
      discRef.current?.position.setX(dx);
      haloRef.current?.position.setX(dx);
    }

    /* ---------- where the plane is, and how folded ---------- */
    const ang = angRef.current;
    for (let k = 0; k < 8; k++) ang[k] = MODEL.folds[k].closed;
    const sheet = sheetRef.current;
    let lift = 0; // height above the sill, for the shadow
    let overSill = true;
    let letterK = 0; // 0 = a plane, 1 = a letter held up to you
    let hint = 0;
    let follow = 0;

    // the letter's place: square to the lens, as large as the view allows
    const dLetter = Math.max(LETTER_H / (0.86 * 2 * TAN), LETTER_W / (0.9 * 2 * TAN * aspect));
    _look.copy(LOOK).sub(_camBase).normalize();
    _lp.copy(_camBase).addScaledVector(_look, dLetter);
    _m.lookAt(_camBase, _lp, UP);
    _qb.setFromRotationMatrix(_m);

    const ft = r.thrownAt >= 0 ? t - r.thrownAt : -1;

    if (phase === "revealed") {
      /* ---- the letter, open, creases and all ---- */
      for (let k = 0; k < 8; k++) ang[k] = MODEL.folds[k].open;
      letterK = 1;
      if (sheet) {
        sheet.position.copy(_lp);
        sheet.quaternion.copy(_qb);
        sheet.quaternion.multiply(_q.setFromEuler(_e.set(Math.sin(e * 0.5) * 0.02 - 0.03, Math.sin(e * 0.37) * 0.03, 0)));
      }
      lift = 1;
    } else if (opening && ft >= 0 && ft < FLY_DUR) {
      /* ---- in flight ---- */
      const x = clamp01(ft / FLY_DUR);
      const u = x + 0.45 * x * (1 - x);
      FLIGHT.getPointAt(u, _p);
      if (u < 0.995) {
        FLIGHT.getPointAt(Math.min(1, u + 0.005), _a);
        _f.copy(_a).sub(_p);
      } else {
        FLIGHT.getPointAt(u - 0.005, _a);
        _f.copy(_p).sub(_a);
      }
      // narrow screens pull the far loop in, eased so rest and landing never move
      const w = smooth(clamp01(u / 0.12)) * smooth(clamp01((1 - u) / 0.12));
      const sx = lerp(1, Math.min(1, Math.max(0.42, aspect / 1.5)), w);
      _p.x *= sx;
      _f.x *= sx;
      _p.y += Math.sin(u * Math.PI * 6) * 0.05 * w; // it rides the air in long soft swells
      _f.normalize();
      // the approach levels out onto the sill
      _f.lerp(LAND_FWD, smooth(clamp01((x - 0.9) / 0.1))).normalize();

      const yaw = Math.atan2(_f.x, _f.z);
      if (!r.yawOk) {
        r.yaw = yaw;
        r.yawOk = true;
      }
      let dy = yaw - r.yaw;
      if (dy > Math.PI) dy -= Math.PI * 2;
      if (dy < -Math.PI) dy += Math.PI * 2;
      r.yaw = yaw;
      const bankT = Math.max(-0.85, Math.min(0.85, (dy / Math.max(dt, 1e-3)) * 0.45));
      r.bank += (bankT - r.bank) * Math.min(1, dt * 3.5);
      const flare = Math.sin(Math.PI * clamp01((x - 0.84) / 0.16)) * 0.24;
      const bob = Math.sin(ft * 3.1) * 0.05 * w;
      // leaving the hand it keeps the lean it had on the sill for a moment
      const leave = 1 - smooth(clamp01(ft / 0.35));
      const roll = r.bank * (1 - smooth(clamp01((x - 0.92) / 0.08))) + Math.sin(ft * 2.3) * 0.06 * w + REST_ROLL * leave;
      bodyQuat(_qa, _f, roll, flare + bob);
      if (sheet) {
        sheet.position.copy(_p);
        sheet.quaternion.copy(_qa).multiply(Q_FOLD);
      }
      // the wings flex a little in the air
      ang[6] += Math.sin(e * 13) * 0.035;
      ang[7] += Math.sin(e * 13 + 1.3) * 0.035;
      lift = _p.y - LAND_Y;
      overSill = _p.z > SILL_BACK && Math.abs(_p.x) < lay.xj;
      follow = 1;

      if (!r.whoosh && x > 0.74) {
        // it comes past close on the way home
        r.whoosh = true;
        swell({ source: "noise", cutoff: 900, q: 0.8, attack: 0.3, hold: 0.2, release: 0.9, gain: 0.14 });
      }
    } else if (opening && ft >= FLY_DUR) {
      /* ---- touchdown, a short skid, then it opens itself ---- */
      const lt = ft - FLY_DUR;
      if (!r.landed) {
        r.landed = true;
        clack({ freq: 700, decay: 0.09, gain: 0.18 });
        swell({ source: "noise", filter: "bandpass", cutoff: 2600, q: 1.2, attack: 0.02, hold: 0.12, release: 0.28, gain: 0.05 });
      }
      const s = clamp01(lt / SKID_DUR);
      _p.copy(LAND_TOUCH).addScaledVector(LAND_FWD, SKID_LEN * easeOutCubic(s));
      const wob = Math.exp(-s * 5) * Math.sin(s * 22) * 0.07 * (1 - s);
      bodyQuat(_qa, LAND_FWD, wob, 0).multiply(Q_FOLD);

      const tau = lt - UNFOLD_AT;
      if (tau > 0) {
        for (let k = 0; k < 8; k++) {
          const [st, du] = UNFOLD[k];
          const f = tau < st ? 1 : 1 - openEase(clamp01((tau - st) / du));
          const fk = MODEL.folds[k];
          ang[k] = fk.open + (fk.closed - fk.open) * f;
          // each hinge gives as it goes: a small dry paper crack
          if (tau >= st && !(r.clacks & (1 << k))) {
            r.clacks |= 1 << k;
            if (k !== 4) {
              clack({ freq: 2100 + k * 140, decay: 0.045, gain: 0.12 });
              clack({ freq: 3400 + k * 90, decay: 0.03, gain: 0.06, when: 0.035 });
            }
          }
        }
        // It lifts off the sill as the wings come up and rears to face you
        // *before* the centre crease opens, so the book opens toward you rather
        // than flat against the sill; then it drifts up to where you can read it.
        const turn = easeInOut(clamp01((tau - 0.12) / 0.95));
        letterK = smooth(clamp01((tau - 0.2) / 2.2));
        const hover = smooth(clamp01(tau / 0.6)) * 0.3 * (1 - letterK);
        _p.lerp(_lp, letterK);
        _p.y += hover;
        _qa.slerp(_qb, turn);
        _qa.multiply(_q.setFromEuler(_e.set((Math.sin(e * 0.5) * 0.02 - 0.03) * letterK, Math.sin(e * 0.37) * 0.03 * letterK, 0)));
        lift = hover + letterK;
      }
      if (sheet) {
        sheet.position.copy(_p);
        sheet.quaternion.copy(_qa);
      }
    } else {
      /* ---- at rest on the sill: the breeze lifts its nose now and then ---- */
      const period = phase === "preview" ? 3.4 : phase === "sealed" ? 5.2 : 1.8;
      const cyc = Math.floor(e / period);
      if (r.gustCyc < 0) r.gustCyc = cyc;
      else if (cyc !== r.gustCyc) {
        r.gustCyc = cyc;
        r.pitchV += phase === "preview" ? 1.25 : phase === "sealed" ? 0.9 : 1.1;
        r.gust = Math.max(r.gust, phase === "opening" ? 0.5 : 0.8);
      }
      if (opening) {
        // Nobody threw it. `alone` counts seconds without a pointer; near the end
        // a bigger gust lifts it off its tail, and then the breeze takes it.
        if (!r.down) r.alone += dt;
        if (!r.windup && r.alone > IDLE_THROW - GUST_LEAD) {
          r.windup = true;
          r.pitchV += 2.2;
          r.gust = 1.6;
        }
        if (r.alone > IDLE_THROW) {
          r.thrownAt = t;
          swell({ source: "noise", cutoff: 1100, q: 0.7, attack: 0.1, hold: 0.25, release: 1.1, gain: 0.18 });
        }
        hint = smooth(clamp01((t - 0.5) / 0.8)) * (r.down ? 0.4 : 1) * (r.windup ? 0 : 1);
      }
      if (sheet) {
        // the tail stays on the sill; the nose lifts about it
        bodyQuat(_qa, REST_FWD, REST_ROLL, 0);
        _a.set(0, 0, B * PLANE_S).applyQuaternion(_qa).add(REST_POS);
        bodyQuat(_qa, REST_FWD, REST_ROLL, r.pitch);
        _b.set(0, 0, -B * PLANE_S).applyQuaternion(_qa);
        sheet.position.copy(_a).add(_b);
        sheet.quaternion.copy(_qa).multiply(Q_FOLD);
      }
      ang[6] += r.pitch * 0.3 + Math.sin(e * 9) * 0.03 * r.gust;
      ang[7] += r.pitch * 0.3 + Math.sin(e * 9 + 1.1) * 0.03 * r.gust;
      lift = 0;
    }

    // the spring under the nose runs in every phase; the sill pins it at zero
    r.pitchV += (-r.pitch * 58 - r.pitchV * 5.2) * dt;
    r.pitch += r.pitchV * dt;
    if (r.pitch < 0) {
      r.pitch = 0;
      if (r.pitchV < 0) r.pitchV *= -0.22;
    }
    r.gust = Math.max(0, r.gust - dt * 0.7);

    /* ---------- fold the sheet (only when an angle actually moved) ---------- */
    const last = lastAngRef.current;
    let moved = false;
    for (let k = 0; k < 8; k++) {
      if (!(Math.abs(ang[k] - last[k]) < 1e-5)) {
        moved = true;
        break;
      }
    }
    if (moved && sheet) {
      const pa = sheet.geometry.attributes.position as THREE.BufferAttribute;
      const na = sheet.geometry.attributes.normal as THREE.BufferAttribute;
      foldSheet(ang, pa.array as Float32Array, na.array as Float32Array);
      pa.needsUpdate = true;
      na.needsUpdate = true;
      last.set(ang);
    }
    if (sheet) {
      const mats = sheet.material as THREE.MeshStandardMaterial[];
      mats[0].emissiveIntensity = sky.glow * letterK;
    }

    /* ---------- its shadow on the sill ---------- */
    if (shadowRef.current && shadowMatRef.current && sheet) {
      const sh = shadowRef.current;
      const h = Math.max(0, lift);
      sh.position.set(sheet.position.x, SILL_Y + 0.003, sheet.position.z);
      _a.set(0, 1, 0).applyQuaternion(sheet.quaternion); // sheet +y is the nose
      sh.rotation.set(-Math.PI / 2, 0, Math.atan2(-_a.z, _a.x));
      sh.scale.set(0.95 * (1 + h * 1.4), 0.36 * (1 + h * 1.4), 1);
      shadowMatRef.current.opacity = overSill ? 0.5 * (1 - clamp01(h / 0.55)) * (1 - letterK) : 0;
    }

    /* ---------- the invitation ---------- */
    if (ringRef.current && ringMatRef.current) {
      const ph = (e / 1.6) % 1;
      ringRef.current.visible = hint > 0.01;
      ringRef.current.scale.set(1.5 * (0.75 + ph * 0.6), 0.75 + ph * 0.6, 1);
      ringMatRef.current.opacity = hint * (1 - ph) * (1 - ph) * 0.5;
    }
    for (let i = 0; i < HINT_N; i++) {
      const d = dotRefs.current[i];
      if (!d) continue;
      d.visible = hint > 0.01;
      const ph = (e * 1.1 - i * 0.12) % 1;
      (d.material as THREE.SpriteMaterial).opacity = hint * Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 2) * 0.95;
    }

    /* ---------- the curtain breathes; a gust bellies it into the room ---------- */
    const cur = curtainRef.current;
    if (cur) {
      // hung at the left edge of the view, whatever the view is
      const halfW = (camZ - SILL_FRONT - 0.08) * TAN * aspect;
      const edge = lerp(0.6, 0.82, clamp01((aspect - 0.5) / 1.2));
      cur.position.set(Math.max(-lay.xj + 0.2, -halfW * edge) - 0.5, lay.yh + 0.45 - 1.9, SILL_FRONT + 0.08);
      const pa = cur.geometry.attributes.position as THREE.BufferAttribute;
      const arr = pa.array as Float32Array;
      const rest = curtainGeo.rest;
      const gust = r.gust;
      for (let i = 0; i < arr.length; i += 3) {
        const x0 = rest[i];
        const y0 = rest[i + 1];
        const hang = (1.9 - y0) / 3.8;
        arr[i] = x0 + Math.sin(e * 0.6 + y0 * 0.7) * 0.03 * hang + gust * hang * 0.14;
        arr[i + 2] =
          Math.sin(x0 * 7 + e * 0.9 + y0 * 0.5) * 0.04 * (0.4 + hang) +
          gust * hang * hang * 0.4 * (0.7 + 0.3 * Math.sin(x0 * 5 + e * 3));
      }
      pa.needsUpdate = true;
    }

    /* ---------- sky life ---------- */
    for (let i = 0; i < CLOUDS.length; i++) {
      const cl = cloudRefs.current[i];
      if (!cl) continue;
      const c = CLOUDS[i];
      cl.position.x = ((((c.x + e * c.sp + 45) % 90) + 90) % 90) - 45;
    }
    const sp = starsRef.current;
    if (sp) {
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      const arr = ca.array as Float32Array;
      for (let i = 0; i < stars.n; i++) {
        const k = stars.lum[i] * (0.72 + 0.28 * Math.sin(e * (1.3 + (i % 7) * 0.4) + stars.ph[i]));
        arr[i * 3] = k;
        arr[i * 3 + 1] = k * 0.97;
        arr[i * 3 + 2] = k * 0.9;
      }
      ca.needsUpdate = true;
    }
    if (lampRef.current) lampRef.current.intensity = sky.lampI * (1 + letterK * 0.25);

    /* ---------- camera: still, except to keep the plane in view in flight ---------- */
    const cam = camRef.current;
    if (cam) {
      if (phase === "revealed" || !r.lookOk) {
        r.look.copy(LOOK);
        r.lookOk = true;
      }
      if (follow > 0 && sheet) {
        const wFollow = lerp(0.45, 0.16, clamp01((aspect - 0.5) / 1.3));
        _a.copy(LOOK).lerp(sheet.position, wFollow);
        r.look.lerp(_a, Math.min(1, dt * 2.4));
      } else if (phase !== "revealed") {
        r.look.lerp(LOOK, Math.min(1, dt * 2));
      }
      cam.position.set(_camBase.x + Math.sin(e * 0.21) * 0.02, _camBase.y + Math.sin(e * 0.29) * 0.012, _camBase.z);
      cam.lookAt(r.look);
    }

    if (opening && ft > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const wantHit = phase === "opening";

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault fov={FOV} near={0.05} far={120} position={[0, CAM_Y0, CAM_Z0]} />
      <ambientLight color={sky.amb} intensity={sky.ambI} />
      <directionalLight position={sky.keyAt} color={sky.key} intensity={sky.keyI} />
      {/* the room behind you: a lamp over your shoulder, which is what reads the letter */}
      <pointLight ref={lampRef} position={[-1.3, 1.7, 3.6]} color={sky.lamp} intensity={sky.lampI} decay={0} />

      {/* ---------- outside ---------- */}
      <mesh position={[0, SKY_TOP - SKY_H / 2, SKY_Z]} renderOrder={-2}>
        <planeGeometry args={[220, SKY_H]} />
        <meshBasicMaterial map={outside.sky} toneMapped={false} depthWrite={false} />
      </mesh>
      <sprite ref={haloRef} position={[sky.discAt[0], sky.discAt[1], SKY_Z + 2]} scale={sky.haloR} renderOrder={-1}>
        <spriteMaterial map={GLOW_TEX} color={sky.halo} transparent opacity={sky.disc === "sun" ? 0.26 : 0.3} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>
      <sprite ref={discRef} position={[sky.discAt[0], sky.discAt[1], SKY_Z + 3]} scale={sky.discR} renderOrder={-1}>
        <spriteMaterial map={outside.disc} transparent depthWrite={false} toneMapped={false} />
      </sprite>
      {stars.n > 0 && (
        <points ref={starsRef} frustumCulled={false} renderOrder={-1}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[stars.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[stars.col, 3]} />
          </bufferGeometry>
          <pointsMaterial map={GLOW_TEX} vertexColors size={4.5} sizeAttenuation={false} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </points>
      )}
      {CLOUDS.map((c, i) => (
        <sprite
          key={i}
          ref={(el) => {
            cloudRefs.current[i] = el;
          }}
          position={[c.x, c.y * (sky.cloudFlat < 0.6 ? 0.7 : 1), -36 + i * 0.3]}
          scale={[c.w * (sky.cloudFlat < 0.6 ? 1.5 : 1), c.h * sky.cloudFlat, 1]}
        >
          <spriteMaterial map={outside.cloud} color={sky.cloud} transparent opacity={sky.cloudK} depthWrite={false} toneMapped={false} />
        </sprite>
      ))}
      {LAYERS.map((L, i) => (
        <mesh key={i} position={[0, layerTop(L) - L.h / 2, L.z]}>
          <planeGeometry args={[L.w, L.h]} />
          <meshBasicMaterial map={outside.city[i]} transparent toneMapped={false} depthWrite={false} />
        </mesh>
      ))}

      {/* ---------- the window, the wall, the sill ---------- */}
      {PIECES.map((pc, i) => (
        <mesh
          key={i}
          ref={(el) => {
            pieceRefs.current[i] = el;
          }}
          geometry={pc.mat === "wall" || pc.mat === "under" ? unitPlane : unitBox}
        >
          {pc.mat === "frame" ? (
            <meshStandardMaterial map={PAINT_TEX} roughness={0.7} />
          ) : pc.mat === "sill" ? (
            <meshStandardMaterial map={WOOD_TEX} roughness={0.62} />
          ) : (
            // the wall under the sill sits in the sill's own shadow
            <meshStandardMaterial color={pc.mat === "under" ? "#7d705f" : "#d9ccb6"} roughness={0.95} />
          )}
        </mesh>
      ))}

      {/* its shadow, soft, on the sill */}
      <mesh ref={shadowRef} geometry={unitPlane} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial ref={shadowMatRef} map={SHADOW_TEX} color="#000000" transparent opacity={0.5} depthWrite={false} />
      </mesh>

      {/* ---------- the plane, which is the letter ---------- */}
      <mesh ref={sheetRef} geometry={sheetGeo} material={sheetMats} scale={PLANE_S} frustumCulled={false} />

      {/* the curtain edge, just inside the room */}
      <mesh ref={curtainRef} geometry={curtainGeo.geo} renderOrder={2}>
        <meshLambertMaterial map={VOILE_TEX} color={sky.curtain} transparent side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* throw-me: a ripple on the sill and dots arcing out of the window */}
      <mesh ref={ringRef} geometry={ringGeo} position={[REST_POS.x + 0.02, SILL_Y + 0.006, REST_POS.z + 0.06]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <meshBasicMaterial ref={ringMatRef} color="#fff4dc" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      {HINT_DOTS.map((p, i) => (
        <sprite
          key={i}
          ref={(el) => {
            dotRefs.current[i] = el;
          }}
          position={[p.x, p.y, p.z]}
          scale={0.065 - i * 0.004}
          visible={false}
        >
          {/* warm and normally blended: additive white vanishes into a pale morning sky */}
          <spriteMaterial map={GLOW_TEX} color="#ffc86a" transparent opacity={0} depthWrite={false} toneMapped={false} />
        </sprite>
      ))}

      {wantHit && (
        <mesh
          position={[REST_POS.x - 0.06, SILL_Y + 0.2, REST_POS.z]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
        >
          <boxGeometry args={[1.25, 0.6, 0.95]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
