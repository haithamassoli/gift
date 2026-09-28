import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite, radialBlob } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import type { Lang } from "../../i18n";

/* ---------- variants ---------- */
// `light`/`deep` are the felt's own mottling; `blush` is the cheeks, which have to
// read as warm on every body colour (so the blue heart still blushes pink).
interface Felt {
  base: string;
  light: string;
  deep: string;
  blush: string;
  sheen: string;
  thread: string;
}
const HEARTS: Record<string, Felt> = {
  red: { base: "#c93341", light: "#e65a68", deep: "#7a1520", blush: "#ff9a92", sheen: "#ffb8bf", thread: "#fbe9d6" },
  pink: { base: "#ef8aa7", light: "#ffb6c9", deep: "#a8475f", blush: "#ff5f8c", sheen: "#ffe2eb", thread: "#fff7ef" },
  blue: { base: "#6c98d6", light: "#9cc0f0", deep: "#2d4d86", blush: "#f59bb6", sheen: "#dcebff", thread: "#fff3e2" },
};
type PlasterKind = "classic" | "stars" | "clear";
const PLASTERS: Record<string, PlasterKind> = { classic: "classic", stars: "stars", clear: "clear" };

const TAU = Math.PI * 2;
const AR_FONT = "'Thmanyah Sans', system-ui, sans-serif";
const HAND_FONT = "'Bradley Hand', 'Segoe Print', 'Marker Felt', 'Comic Sans MS', cursive";
const MARKER_FONT = "'Marker Felt', 'Comic Sans MS', 'Segoe Print', cursive";

/* ---------- the heart's outline ---------- */
// Drawn chubby on purpose: a plush heart is two rounded lobes and a soft point, not
// the long-tipped valentine the parametric curve gives you.
const OUT_N = 150;
const OUT = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, 0.3);
  s.bezierCurveTo(0.03, 0.52, 0.2, 0.64, 0.38, 0.64);
  s.bezierCurveTo(0.62, 0.64, 0.78, 0.46, 0.78, 0.2);
  s.bezierCurveTo(0.78, -0.12, 0.42, -0.36, 0.07, -0.63);
  s.quadraticCurveTo(0, -0.69, -0.07, -0.63);
  s.bezierCurveTo(-0.42, -0.36, -0.78, -0.12, -0.78, 0.2);
  s.bezierCurveTo(-0.78, 0.46, -0.62, 0.64, -0.38, 0.64);
  s.bezierCurveTo(-0.2, 0.64, -0.03, 0.52, 0, 0.3);
  // arc-length spaced, and clockwise: i+1 is always one step round to the right
  const pts = s.getSpacedPoints(OUT_N);
  const x = new Float32Array(OUT_N);
  const y = new Float32Array(OUT_N);
  for (let i = 0; i < OUT_N; i++) {
    x[i] = pts[i].x;
    y[i] = pts[i].y;
  }
  return { x, y };
})();
const TIP_Y = -0.66; // the lowest point of the outline: the heart stands on it
const TEX_HALF = 0.82; // the felt canvas spans ±TEX_HALF of heart space

function distToOutline(px: number, py: number): number {
  let best = 1e9;
  for (let i = 0; i < OUT_N; i++) {
    const ax = OUT.x[i];
    const ay = OUT.y[i];
    const j = (i + 1) % OUT_N;
    const dx = OUT.x[j] - ax;
    const dy = OUT.y[j] - ay;
    const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
    const ex = ax + dx * t - px;
    const ey = ay + dy * t - py;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/* ---------- inflation ---------- */
// A pillow, not an extrusion: height is a function of distance to the seam, so each
// lobe domes on its own and the cusp pinches in where the two lobes meet — which is
// where a stuffed heart pinches. The rim profile is a quarter circle, so the surface
// comes into the seam vertically and the seam reads as a real sewn crease.
const PUFF_RIM = 0.19;
const PUFF_RIM_W = 0.2;
const PUFF_DOME = 0.09;
const PUFF_DOME_W = 0.42;
function puff(d: number): number {
  const u = Math.min(d / PUFF_RIM_W, 1);
  return PUFF_RIM * Math.sqrt(u * (2 - u)) + PUFF_DOME * smooth(Math.min(d / PUFF_DOME_W, 1));
}
const surfZ = (x: number, y: number) => puff(distToOutline(x, y));
/** Front-surface normal by finite differences, into `out`. */
function surfNormal(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
  const h = 0.004;
  const gx = (surfZ(x + h, y) - surfZ(x - h, y)) / (2 * h);
  const gy = (surfZ(x, y + h) - surfZ(x, y - h)) / (2 * h);
  return out.set(-gx, -gy, 1).normalize();
}

const RINGS = 16;
function buildHeart(): THREE.BufferGeometry {
  const per = OUT_N * (RINGS + 1);
  const pos = new Float32Array(per * 2 * 3);
  const uv = new Float32Array(per * 2 * 2);
  const idx: number[] = [];
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    const base = side * per;
    for (let k = 0; k <= RINGS; k++) {
      // rings bunch up toward the seam, where the profile turns fastest
      const s = 1 - Math.pow(1 - k / RINGS, 1.7);
      for (let i = 0; i < OUT_N; i++) {
        const x = s * OUT.x[i];
        const y = s * OUT.y[i];
        const z = k === RINGS ? 0 : puff(distToOutline(x, y));
        const vi = base + k * OUT_N + i;
        pos[vi * 3] = x;
        pos[vi * 3 + 1] = y;
        pos[vi * 3 + 2] = z * sgn;
        const u = (x + TEX_HALF) / (2 * TEX_HALF);
        uv[vi * 2] = side === 0 ? u : 1 - u;
        uv[vi * 2 + 1] = (y + TEX_HALF) / (2 * TEX_HALF);
      }
    }
    for (let k = 0; k < RINGS; k++) {
      for (let i = 0; i < OUT_N; i++) {
        const i1 = (i + 1) % OUT_N;
        const a = base + k * OUT_N + i;
        const b = base + k * OUT_N + i1;
        const c = base + (k + 1) * OUT_N + i1;
        const d = base + (k + 1) * OUT_N + i;
        // front and back are separate vertex sets that only meet at the rim, so the
        // normals do not smooth across it: that crease is the seam
        if (side === 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
const HEART_GEO = buildHeart();

/* ---------- the face: two stitched eyes, closed ---------- */
const EYES: [number, number][] = [
  [-0.2, -0.05],
  [0.2, -0.05],
];
const CHEEKS: [number, number][] = [
  [-0.37, -0.17],
  [0.37, -0.17],
];
// One arc that bulges down (a tired, shut eye). Flipped by scale.y it bulges up —
// ^ ^ — which is the whole emotional arc of the gift in one negative number.
const EYE_GEO = (() => {
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    pts.push(new THREE.Vector3((t - 0.5) * 0.13, 0.016 - Math.sin(t * Math.PI) * 0.034, 0));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0115, 6, false);
})();
const EYE_POSE = EYES.map(([x, y]) => {
  const n = surfNormal(x, y, new THREE.Vector3());
  return {
    p: new THREE.Vector3(x, y, surfZ(x, y) + 0.003),
    q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n),
  };
});

/* ---------- the plaster, as it lies on the heart ---------- */
// Across the right lobe, the way a cartoon wears one on its forehead, and clear of
// the face. `+u` runs to the lower-right end, which is the tab.
const PL_L = 0.74;
const PL_W = 0.25;
const PL_NU = 60;
const PL_NV = 3;
const PL_CX = 0.4;
const PL_CY = 0.24;
const PL_A = -0.72;
const PL_LIFT = 0.022;
const PL_TAB = 0.11; // the corner that never quite stuck down
const PL_VERTS = (PL_NU + 1) * (PL_NV + 1);
const TAB_COL = Math.round((1 - PL_TAB / PL_L) * PL_NU);
const PL = (() => {
  const dx = Math.cos(PL_A);
  const dy = Math.sin(PL_A);
  const rest = new Float32Array(PL_VERTS * 3);
  const colT = new Float32Array((PL_NU + 1) * 3);
  const colN = new Float32Array((PL_NU + 1) * 3);
  const n = new THREE.Vector3();
  for (let i = 0; i <= PL_NU; i++) {
    const u = -PL_L / 2 + (PL_L * i) / PL_NU;
    for (let j = 0; j <= PL_NV; j++) {
      const v = -PL_W / 2 + (PL_W * j) / PL_NV;
      const x = PL_CX + u * dx - v * dy;
      const y = PL_CY + u * dy + v * dx;
      surfNormal(x, y, n);
      const z = surfZ(x, y);
      const vi = i * (PL_NV + 1) + j;
      // lifted along the normal, not along z, so the edges on the slope stay clear
      rest[vi * 3] = x + n.x * PL_LIFT;
      rest[vi * 3 + 1] = y + n.y * PL_LIFT;
      rest[vi * 3 + 2] = z + n.z * PL_LIFT;
    }
    const cx = PL_CX + u * dx;
    const cy = PL_CY + u * dy;
    surfNormal(cx, cy, n);
    colN[i * 3] = n.x;
    colN[i * 3 + 1] = n.y;
    colN[i * 3 + 2] = n.z;
  }
  // the tangent is read off the draped centre line, so it follows the dome
  for (let i = 0; i <= PL_NU; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(PL_NU, i + 1);
    const mid = Math.floor(PL_NV / 2);
    const ia = (a * (PL_NV + 1) + mid) * 3;
    const ib = (b * (PL_NV + 1) + mid) * 3;
    const tx = rest[ib] - rest[ia];
    const ty = rest[ib + 1] - rest[ia + 1];
    const tz = rest[ib + 2] - rest[ia + 2];
    const l = Math.hypot(tx, ty, tz) || 1;
    colT[i * 3] = tx / l;
    colT[i * 3 + 1] = ty / l;
    colT[i * 3 + 2] = tz / l;
  }
  return { rest, colT, colN };
})();

function buildPlasterGeo(): THREE.BufferGeometry {
  const pos = new Float32Array(PL_VERTS * 3);
  const nor = new Float32Array(PL_VERTS * 3);
  const uv = new Float32Array(PL_VERTS * 2);
  const idx: number[] = [];
  for (let i = 0; i <= PL_NU; i++) {
    for (let j = 0; j <= PL_NV; j++) {
      const vi = i * (PL_NV + 1) + j;
      uv[vi * 2] = i / PL_NU;
      uv[vi * 2 + 1] = j / PL_NV;
      nor[vi * 3 + 2] = 1;
    }
  }
  for (let i = 0; i < PL_NU; i++) {
    for (let j = 0; j < PL_NV; j++) {
      const a = i * (PL_NV + 1) + j;
      const b = (i + 1) * (PL_NV + 1) + j;
      const c = b + 1;
      const d = a + 1;
      // counter-clockwise about du × dv: the front face is the side facing away from the heart
      idx.push(a, b, c, a, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/* ---------- plaster shapes (pure; written straight into a buffer) ---------- */
const SCR_S = new Float32Array((PL_NV + 1) * 3);
const SCR_A = new Float32Array(PL_VERTS * 3);
const SCR_B = new Float32Array(PL_VERTS * 3);

/**
 * The peel. Everything behind the front `uf` is still stuck; everything past it
 * wraps round a cylinder of radius r for `theta` radians and then runs straight on,
 * which is exactly how tape comes off skin: a tight roll at the line of adhesion
 * and a flat tail. Built in the heart's space, written out through `m` (world).
 */
function curlShape(out: Float32Array, uf: number, theta: number, r: number, m: ArrayLike<number>) {
  const fi = Math.min(PL_NU, Math.max(0, ((uf + PL_L / 2) / PL_L) * PL_NU));
  const i0 = Math.min(PL_NU - 1, Math.floor(fi));
  const i1 = i0 + 1;
  const f = fi - i0;
  const { rest, colT, colN } = PL;
  const tx = lerp(colT[i0 * 3], colT[i1 * 3], f);
  const ty = lerp(colT[i0 * 3 + 1], colT[i1 * 3 + 1], f);
  const tz = lerp(colT[i0 * 3 + 2], colT[i1 * 3 + 2], f);
  const nx = lerp(colN[i0 * 3], colN[i1 * 3], f);
  const ny = lerp(colN[i0 * 3 + 1], colN[i1 * 3 + 1], f);
  const nz = lerp(colN[i0 * 3 + 2], colN[i1 * 3 + 2], f);
  for (let j = 0; j <= PL_NV; j++) {
    const a = (i0 * (PL_NV + 1) + j) * 3;
    const b = (i1 * (PL_NV + 1) + j) * 3;
    SCR_S[j * 3] = lerp(rest[a], rest[b], f);
    SCR_S[j * 3 + 1] = lerp(rest[a + 1], rest[b + 1], f);
    SCR_S[j * 3 + 2] = lerp(rest[a + 2], rest[b + 2], f);
  }
  const rt = r * theta;
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  for (let i = 0; i <= PL_NU; i++) {
    const u = -PL_L / 2 + (PL_L * i) / PL_NU;
    for (let j = 0; j <= PL_NV; j++) {
      const vi = i * (PL_NV + 1) + j;
      let lx: number;
      let ly: number;
      let lz: number;
      if (u <= uf) {
        lx = rest[vi * 3];
        ly = rest[vi * 3 + 1];
        lz = rest[vi * 3 + 2];
      } else {
        const a = u - uf;
        let X: number;
        let Y: number;
        if (a < rt) {
          const ph = a / r;
          X = r * Math.sin(ph);
          Y = r * (1 - Math.cos(ph));
        } else {
          const b = a - rt;
          X = r * st + b * ct;
          Y = r * (1 - ct) + b * st;
        }
        lx = SCR_S[j * 3] + tx * X + nx * Y;
        ly = SCR_S[j * 3 + 1] + ty * X + ny * Y;
        lz = SCR_S[j * 3 + 2] + tz * X + nz * Y;
      }
      out[vi * 3] = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      out[vi * 3 + 1] = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      out[vi * 3 + 2] = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    }
  }
}

/** Where it ends up: on the blanket, sticky side up, both ends curling the way a
 *  used plaster does. u → along the yaw, v → toward the camera, so du × dv points
 *  down and the underside (the pad, the writing) faces the sky. */
function lieShape(out: Float32Array, cx: number, cz: number, yaw: number, floorY: number) {
  const ax = Math.cos(yaw);
  const az = -Math.sin(yaw);
  const bx = Math.sin(yaw);
  const bz = Math.cos(yaw);
  for (let i = 0; i <= PL_NU; i++) {
    const u = -PL_L / 2 + (PL_L * i) / PL_NU;
    const end = Math.max(0, Math.abs(u) - (PL_L / 2 - 0.15));
    const lift = end * end * (u > 0 ? 3.4 : 1.8);
    for (let j = 0; j <= PL_NV; j++) {
      const v = -PL_W / 2 + (PL_W * j) / PL_NV;
      const vi = i * (PL_NV + 1) + j;
      out[vi * 3] = cx + u * ax + v * bx;
      out[vi * 3 + 1] = floorY + 0.004 + lift;
      out[vi * 3 + 2] = cz + u * az + v * bz;
    }
  }
}

/** Grid normals by central differences — computeVertexNormals would allocate. */
function gridNormals(p: ArrayLike<number>, n: Float32Array) {
  const W = PL_NV + 1;
  for (let i = 0; i <= PL_NU; i++) {
    const ia = Math.min(PL_NU, i + 1);
    const ib = Math.max(0, i - 1);
    for (let j = 0; j <= PL_NV; j++) {
      const ja = Math.min(PL_NV, j + 1);
      const jb = Math.max(0, j - 1);
      const a = (ia * W + j) * 3;
      const b = (ib * W + j) * 3;
      const c = (i * W + ja) * 3;
      const d = (i * W + jb) * 3;
      const ux = p[a] - p[b];
      const uy = p[a + 1] - p[b + 1];
      const uz = p[a + 2] - p[b + 2];
      const vx = p[c] - p[d];
      const vy = p[c + 1] - p[d + 1];
      const vz = p[c + 2] - p[d + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (i * W + j) * 3;
      n[o] = nx;
      n[o + 1] = ny;
      n[o + 2] = nz;
    }
  }
}

/* ---------- the mend: gold, under the pad ---------- */
// The tear runs under the pad (so even the clear plaster never gives it away) and is
// held shut by a row of little gold cross-stitches. Already done by the time anyone
// looks: the point of the gift is that it had been healing the whole time.
const TEAR_A = PL_A + 0.25;
const TEAR_HALF = 0.115;
const X_N = 5;
const X_GEO = new THREE.CapsuleGeometry(0.009, 0.068, 2, 6);
const GOLD = (() => {
  const dx = Math.cos(TEAR_A);
  const dy = Math.sin(TEAR_A);
  const mats: THREE.Matrix4[] = [];
  const o = new THREE.Object3D();
  const n = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const samples = new Float32Array(X_N * 3);
  for (let k = 0; k < X_N; k++) {
    const along = -TEAR_HALF * 0.9 + (1.8 * TEAR_HALF * k) / (X_N - 1);
    const x = PL_CX + along * dx;
    const y = PL_CY + along * dy;
    surfNormal(x, y, n);
    const z = surfZ(x, y);
    for (const s of [-1, 1]) {
      // one arm of the X, laid flat in the surface's tangent plane
      const a = TEAR_A + Math.PI / 2 + s * 0.62;
      axis.set(Math.cos(a), Math.sin(a), 0);
      axis.addScaledVector(n, -axis.dot(n)).normalize();
      o.position.set(x + n.x * 0.003, y + n.y * 0.003, z + n.z * 0.003);
      o.quaternion.setFromUnitVectors(up, axis);
      o.updateMatrix();
      mats.push(o.matrix.clone());
    }
    samples[k * 3] = x + n.x * 0.02;
    samples[k * 3 + 1] = y + n.y * 0.02;
    samples[k * 3 + 2] = z + n.z * 0.02;
  }
  return { mats, samples, cx: PL_CX, cy: PL_CY, cz: surfZ(PL_CX, PL_CY) + 0.02 };
})();

/* ---------- the rim seam: a whip stitch all the way round ---------- */
const RIM_STEP = 2;
const RIM_N = Math.floor(OUT_N / RIM_STEP);
const RIM_GEO = new THREE.CapsuleGeometry(0.0072, 0.05, 2, 5);
const RIM_MATS = (() => {
  const out: THREE.Matrix4[] = [];
  const o = new THREE.Object3D();
  const axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < RIM_N; k++) {
    const i = k * RIM_STEP;
    const a = (i + OUT_N - 1) % OUT_N;
    const b = (i + 1) % OUT_N;
    let tx = OUT.x[b] - OUT.x[a];
    let ty = OUT.y[b] - OUT.y[a];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    let nx = -ty;
    let ny = tx;
    if (nx * OUT.x[i] + ny * OUT.y[i] < 0) {
      nx = -nx;
      ny = -ny;
    }
    o.position.set(OUT.x[i] + nx * 0.004, OUT.y[i] + ny * 0.004, 0);
    // slanted across the seam, the way a hand-sewn whip stitch sits
    axis.set(tx * 0.5, ty * 0.5, 1).normalize();
    o.quaternion.setFromUnitVectors(up, axis);
    o.updateMatrix();
    out.push(o.matrix.clone());
  }
  return out;
})();

/** Both seams are static relative to the heart, so their matrices are written once
 *  per instance — from a callback ref, which also fires if the instance is rebuilt. */
function placeAll(mats: THREE.Matrix4[]) {
  return (m: THREE.InstancedMesh | null) => {
    if (!m) return;
    for (let i = 0; i < mats.length; i++) m.setMatrixAt(i, mats[i]);
    m.instanceMatrix.needsUpdate = true;
  };
}
const placeRim = placeAll(RIM_MATS);
const placeGold = placeAll(GOLD.mats);

/* ---------- the little twine bow at the tip, where the tag is tied ---------- */
const BOW_Y = -0.55;
const BOW_Z = surfZ(0, BOW_Y) + 0.012;
const BOW_LOOP = new THREE.TorusGeometry(0.034, 0.009, 6, 16);
const BOW_KNOT = new THREE.SphereGeometry(0.018, 10, 8);
const ANCHOR = new THREE.Vector3(0, BOW_Y - 0.01, BOW_Z);

/* ---------- textures that do not depend on the variant ---------- */
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}
function srgb(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const hx2c = (x: number, s: number) => ((x + TEX_HALF) / (2 * TEX_HALF)) * s;
const hy2c = (y: number, s: number) => (1 - (y + TEX_HALF) / (2 * TEX_HALF)) * s;

/** Short fibres scattered every which way — the thing that makes felt felt. */
function fibres(g: CanvasRenderingContext2D, s: number, n: number, seed: number, light: string, dark: string) {
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const x = rand() * s;
    const y = rand() * s;
    const a = rand() * TAU;
    const l = 2 + rand() * 7;
    g.globalAlpha = 0.05 + rand() * 0.16;
    g.strokeStyle = rand() > 0.5 ? light : dark;
    g.lineWidth = 0.6 + rand() * 0.9;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** The tear, a slightly crooked line: drawn into both the colour and the bump. */
function tearPath(g: CanvasRenderingContext2D, s: number) {
  const rand = mulberry32(611);
  const dx = Math.cos(TEAR_A);
  const dy = Math.sin(TEAR_A);
  g.beginPath();
  for (let k = 0; k <= 12; k++) {
    const along = -TEAR_HALF * 1.05 + (2.1 * TEAR_HALF * k) / 12;
    const jit = (rand() - 0.5) * 0.008;
    const x = PL_CX + along * dx - jit * dy;
    const y = PL_CY + along * dy + jit * dx;
    if (k === 0) g.moveTo(hx2c(x, s), hy2c(y, s));
    else g.lineTo(hx2c(x, s), hy2c(y, s));
  }
}

const FELT_BUMP = (() => {
  const s = 512;
  const [c, g] = canvas(s, s);
  g.fillStyle = "#808080";
  g.fillRect(0, 0, s, s);
  fibres(g, s, 7000, 404, "#d8d8d8", "#303030");
  g.strokeStyle = "#202020";
  g.lineWidth = 4;
  tearPath(g, s);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
})();

function buildFelt(f: Felt): THREE.CanvasTexture {
  const s = 512;
  const [c, g] = canvas(s, s);
  g.fillStyle = f.base;
  g.fillRect(0, 0, s, s);
  // felt is never one flat colour: big soft clouds of lighter and darker wool
  const rand = mulberry32(90);
  for (let i = 0; i < 26; i++) {
    g.globalAlpha = 0.1 + rand() * 0.12;
    radialBlob(g, rand() * s, rand() * s, 40 + rand() * 90, rand() > 0.5 ? f.light : f.deep);
  }
  g.globalAlpha = 1;
  fibres(g, s, 7000, 404, f.light, f.deep);
  // cheeks
  for (const [x, y] of CHEEKS) {
    g.globalAlpha = 0.85;
    g.save();
    g.translate(hx2c(x, s), hy2c(y, s));
    g.scale(1.35, 1);
    radialBlob(g, 0, 0, 34, f.blush);
    g.restore();
  }
  g.globalAlpha = 1;
  // the tear, already pulled shut
  g.strokeStyle = f.deep;
  g.lineWidth = 4;
  g.lineCap = "round";
  tearPath(g, s);
  g.stroke();
  return srgb(c);
}

/** Chunky oatmeal knit: rows of V-shaped loops, each one shaded like a little pillow. */
function buildKnit(bump: boolean): THREE.CanvasTexture {
  const s = 256;
  const [c, g] = canvas(s, s);
  g.fillStyle = bump ? "#303030" : "#8a705f";
  g.fillRect(0, 0, s, s);
  const cw = 16;
  const rh = 16;
  const rand = mulberry32(3);
  for (let r = -1; r <= s / rh; r++) {
    for (let col = 0; col < s / cw; col++) {
      const x0 = col * cw;
      const y0 = r * rh;
      for (const side of [-1, 1]) {
        const cx = x0 + cw / 2 + side * 3.6;
        const cy = y0 + rh / 2 + 2;
        g.save();
        g.translate(cx, cy);
        g.rotate(side * -0.55);
        const gr = g.createRadialGradient(0, -2, 0, 0, 0, 9);
        if (bump) {
          gr.addColorStop(0, "#ffffff");
          gr.addColorStop(1, "#404040");
        } else {
          const l = 70 + rand() * 6;
          gr.addColorStop(0, `hsl(30 30% ${l}%)`);
          gr.addColorStop(0.7, `hsl(27 25% ${l - 9}%)`);
          gr.addColorStop(1, `hsl(24 22% ${l - 18}%)`);
        }
        g.fillStyle = gr;
        g.beginPath();
        g.ellipse(0, 0, 4.4, 9.2, 0, 0, TAU);
        g.fill();
        g.restore();
      }
    }
  }
  const t = bump ? new THREE.CanvasTexture(c) : srgb(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(20, 13);
  return t;
}
const KNIT = buildKnit(false);
const KNIT_BUMP = buildKnit(true);

/** A dark bedroom wall and a string of fairy lights gone soft out of focus. */
const BOKEH: [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  const rand = mulberry32(2024);
  for (let i = 0; i < 22; i++) {
    const x = 0.18 + (i / 21) * 0.64;
    // the string droops between two nails
    const y = 0.62 + 0.035 * Math.sin(((i / 21) * 2 + 0.2) * Math.PI) + (rand() - 0.5) * 0.01;
    out.push([x, y, 0.5 + rand() * 0.8]);
  }
  return out;
})();
const BACKDROP = (() => {
  const w = 1024;
  const h = 512;
  const [c, g] = canvas(w, h);
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, "#140c11");
  gr.addColorStop(0.5, "#1d1217");
  gr.addColorStop(0.72, "#2c1d20");
  gr.addColorStop(1, "#2c1d20");
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  // the lamp off to one side
  g.globalAlpha = 0.5;
  radialBlob(g, w * 0.18, h * 0.62, h * 0.7, "#6a3d2c");
  g.globalAlpha = 1;
  for (const [x, y, k] of BOKEH) {
    g.globalAlpha = 0.22 + 0.25 * k;
    radialBlob(g, x * w, y * h, 4 + k * 6, "#ffcf8f");
  }
  g.globalAlpha = 1;
  return srgb(c);
})();

const GOLD_ENV = (() => {
  const w = 256;
  const h = 128;
  const [c, g] = canvas(w, h);
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, "#3a2a24");
  gr.addColorStop(0.45, "#f7e3c0");
  gr.addColorStop(0.6, "#6a4a36");
  gr.addColorStop(1, "#1a110e");
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  radialBlob(g, w * 0.7, h * 0.4, 40, "rgba(255,248,230,0.95)");
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const GLOW = makeRadialSprite();
const SPARK = makeRadialSprite(32, [
  [0, "rgba(255,255,255,1)"],
  [0.25, "rgba(255,236,170,0.9)"],
  [1, "rgba(255,170,40,0)"],
]);
const SHADOW = makeRadialSprite(64, [
  [0, "rgba(0,0,0,0.75)"],
  [0.55, "rgba(0,0,0,0.35)"],
  [1, "rgba(0,0,0,0)"],
]);
const WISP = (() => {
  const [c, g] = canvas(64, 128);
  g.save();
  g.translate(32, 64);
  g.scale(1, 2);
  radialBlob(g, 0, 0, 30, "rgba(255,255,255,0.9)");
  g.restore();
  return new THREE.CanvasTexture(c);
})();

function heartPath(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  g.moveTo(x, y + r * 0.9);
  g.bezierCurveTo(x - r * 1.3, y - r * 0.1, x - r * 0.7, y - r * 1.1, x, y - r * 0.45);
  g.bezierCurveTo(x + r * 0.7, y - r * 1.1, x + r * 1.3, y - r * 0.1, x, y + r * 0.9);
  g.closePath();
}
const HEART_SPRITE = (() => {
  const [c, g] = canvas(64, 64);
  g.fillStyle = "#ffffff";
  heartPath(g, 32, 34, 24);
  g.fill();
  return new THREE.CanvasTexture(c);
})();

/* ---------- the tea: lathe profiles ---------- */
const CUP_GEO = new THREE.LatheGeometry(
  [
    [0, 0],
    [0.12, 0],
    [0.135, 0.012],
    [0.15, 0.07],
    [0.178, 0.19],
    [0.186, 0.235],
    [0.176, 0.238],
    [0.166, 0.19],
    [0.14, 0.08],
    [0.11, 0.03],
    [0, 0.028],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  36,
);
const SAUCER_GEO = new THREE.LatheGeometry(
  [
    [0, 0],
    [0.25, 0],
    [0.3, 0.028],
    [0.296, 0.034],
    [0.24, 0.014],
    [0, 0.012],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  36,
);
const HANDLE_GEO = new THREE.TorusGeometry(0.058, 0.016, 8, 18, Math.PI * 1.25);
const TEA_GEO = new THREE.CircleGeometry(0.166, 30);

/* ---------- plaster art ---------- */
function stadium(g: CanvasRenderingContext2D, w: number, h: number, inset: number) {
  const r = h * 0.44 - inset;
  g.beginPath();
  g.roundRect(inset, inset, w - inset * 2, h - inset * 2, r);
}
const PAD_FW = 0.4; // pad as a fraction of the plaster's length…
const PAD_FH = 0.7; // …and of its width

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = rot + (k * Math.PI) / 5 - Math.PI / 2;
    const rr = k % 2 === 0 ? r : r * 0.45;
    if (k === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

/** The side you see while it is stuck on. */
function buildPlasterTop(kind: PlasterKind): THREE.CanvasTexture {
  const w = 512;
  const h = Math.round((w * PL_W) / PL_L);
  const [c, g] = canvas(w, h);
  const pw = w * PAD_FW;
  const ph = h * PAD_FH;
  const px = (w - pw) / 2;
  const py = (h - ph) / 2;
  stadium(g, w, h, 1);
  g.save();
  g.clip();
  if (kind === "classic") {
    g.fillStyle = "#dca47b";
    g.fillRect(0, 0, w, h);
    // woven fabric
    for (let y = 0; y < h; y += 3) {
      g.fillStyle = "rgba(120,70,40,0.07)";
      g.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 3) {
      g.fillStyle = "rgba(255,230,200,0.06)";
      g.fillRect(x, 0, 1, h);
    }
    g.fillStyle = "rgba(125,72,40,0.5)";
    for (let y = 16; y < h - 8; y += 18) {
      for (let x = 14 + ((y / 18) % 2) * 9; x < w - 8; x += 18) {
        if (x > px - 6 && x < px + pw + 6) continue;
        g.beginPath();
        g.arc(x, y, 2.3, 0, TAU);
        g.fill();
      }
    }
  } else if (kind === "stars") {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, "#ff9fc2");
    gr.addColorStop(0.5, "#b7a2f7");
    gr.addColorStop(1, "#8fd3ef");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    const rand = mulberry32(77);
    const cols = ["#fff28a", "#ffffff", "#ffd94d", "#fff6c9"];
    g.strokeStyle = "rgba(120,80,160,0.35)";
    g.lineWidth = 1.2;
    for (let i = 0; i < 26; i++) {
      g.fillStyle = cols[i % cols.length];
      star(g, 10 + rand() * (w - 20), 8 + rand() * (h - 16), 6 + rand() * 8, rand() * TAU);
      g.fill();
      g.stroke();
    }
    g.fillStyle = "rgba(255,255,255,0.7)";
    for (let i = 0; i < 60; i++) {
      g.beginPath();
      g.arc(rand() * w, rand() * h, 1 + rand() * 1.4, 0, TAU);
      g.fill();
    }
  } else {
    // clear film: mostly the heart underneath, a few breathing holes, and the pad
    g.fillStyle = "rgba(255,246,236,0.26)";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,0.55)";
    for (let y = 14; y < h - 8; y += 16) {
      for (let x = 12; x < w - 8; x += 16) {
        if (x > px - 6 && x < px + pw + 6) continue;
        g.beginPath();
        g.arc(x, y, 1.8, 0, TAU);
        g.fill();
      }
    }
    g.fillStyle = "rgba(250,246,240,0.97)";
    g.beginPath();
    g.roundRect(px, py, pw, ph, 8);
    g.fill();
    g.strokeStyle = "rgba(210,200,190,0.8)";
    g.lineWidth = 1.2;
    for (let x = px + 8; x < px + pw; x += 10) {
      g.beginPath();
      g.moveTo(x, py);
      g.lineTo(x - 6, py + ph);
      g.stroke();
    }
  }
  // the pad pushes up through the backing: a highlight on its top edge, a shade on
  // its bottom one, and nothing else — you feel it more than you see it
  g.strokeStyle = "rgba(255,255,255,0.22)";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(px + 6, py);
  g.lineTo(px + pw - 6, py);
  g.stroke();
  g.strokeStyle = "rgba(60,30,20,0.12)";
  g.beginPath();
  g.moveTo(px + 6, py + ph);
  g.lineTo(px + pw - 6, py + ph);
  g.stroke();
  g.restore();
  stadium(g, w, h, 2);
  g.strokeStyle = kind === "classic" ? "rgba(150,92,56,0.8)" : kind === "stars" ? "rgba(214,130,170,0.9)" : "rgba(255,255,255,0.7)";
  g.lineWidth = 3;
  g.stroke();
  return srgb(c);
}

/** The sticky side: adhesive, the gauze pad, and what the sender wrote on it. */
function buildPlasterUnder(kind: PlasterKind, label: string, lang: Lang): THREE.CanvasTexture {
  const w = 1024;
  const h = Math.round((w * PL_W) / PL_L);
  const [c, g] = canvas(w, h);
  const pw = w * PAD_FW;
  const ph = h * PAD_FH;
  const px = (w - pw) / 2;
  const py = (h - ph) / 2;
  stadium(g, w, h, 2);
  g.save();
  g.clip();
  g.fillStyle = kind === "classic" ? "#f1e2cd" : kind === "stars" ? "#fbe9f1" : "rgba(252,244,236,0.4)";
  g.fillRect(0, 0, w, h);
  if (kind !== "clear") {
    g.fillStyle = kind === "classic" ? "rgba(170,120,80,0.22)" : "rgba(200,140,170,0.22)";
    for (let y = 28; y < h - 16; y += 36) {
      for (let x = 26 + ((y / 36) % 2) * 18; x < w - 16; x += 36) {
        if (x > px - 12 && x < px + pw + 12) continue;
        g.beginPath();
        g.arc(x, y, 4, 0, TAU);
        g.fill();
      }
    }
  }
  // the pad: quilted gauze
  g.fillStyle = "#fdfbf6";
  g.beginPath();
  g.roundRect(px, py, pw, ph, 16);
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = "rgba(170,160,150,0.28)";
  g.lineWidth = 2;
  for (let x = px - ph; x < px + pw + ph; x += 22) {
    g.beginPath();
    g.moveTo(x, py);
    g.lineTo(x + ph, py + ph);
    g.moveTo(x + ph, py);
    g.lineTo(x, py + ph);
    g.stroke();
  }
  g.restore();
  g.strokeStyle = "rgba(190,178,165,0.9)";
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(px, py, pw, ph, 16);
  g.stroke();
  g.restore();
  stadium(g, w, h, 3);
  g.strokeStyle = kind === "clear" ? "rgba(255,255,255,0.7)" : "rgba(190,160,140,0.8)";
  g.lineWidth = 4;
  g.stroke();

  // Marker, right across it. It is read lying on the blanket with its v axis toward
  // the camera, which shows the canvas upside down — so the words are written
  // flipped and land the right way up.
  const ar = lang === "ar";
  const fam = ar ? AR_FONT : MARKER_FONT;
  const weight = ar ? "700" : "600";
  g.save();
  g.translate(0, h);
  g.scale(1, -1);
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#23336a";
  const maxW = w * 0.84;
  // One line if it will go; otherwise wrap and keep stepping down until every line
  // of a long name fits across and the block fits the plaster's width.
  let size = Math.round(h * 0.4);
  let lines = [label];
  for (;;) {
    g.font = `${weight} ${size}px ${fam}`;
    const one = g.measureText(label).width <= maxW;
    lines = one || size > h * 0.24 ? [label] : wrapText(g, label, maxW);
    const fits = lines.every((l) => g.measureText(l).width <= maxW) && lines.length * size * 1.08 <= h * 0.86;
    if (fits || size <= 18) break;
    size -= 3;
  }
  const lh = size * 1.08;
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * lh + size * 0.04));
  if (lines.length === 1) {
    // a doodled heart after the last word — at the end of the line, whichever end that is
    const tw = g.measureText(label).width;
    const hxp = w / 2 + (ar ? -1 : 1) * (tw / 2 + size * 0.38);
    g.fillStyle = "#e0506f";
    heartPath(g, hxp, h / 2, size * 0.24);
    g.fill();
  }
  g.restore();
  return srgb(c);
}

/* ---------- the tag ---------- */
function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
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
  // A single word wider than the tag (a pasted link, a very long name) is broken by
  // character rather than allowed off the paper.
  const fixed: string[] = [];
  for (const l of out) {
    if (g.measureText(l).width <= maxW) {
      fixed.push(l);
      continue;
    }
    let cur = "";
    for (const ch of Array.from(l)) {
      if (cur && g.measureText(cur + ch).width > maxW) {
        fixed.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    fixed.push(cur);
  }
  return fixed.length ? fixed : [""];
}

const TAG_CW = 720;
const TAG_HOLE = 64;
const TAG_W = 1.15;
function tagPath(g: CanvasRenderingContext2D, w: number, h: number, k: number) {
  const cut = 92;
  const r = 22;
  g.beginPath();
  g.moveTo(cut + k * 0.6, k);
  g.lineTo(w - cut - k * 0.6, k);
  g.lineTo(w - k, cut + k * 0.6);
  g.lineTo(w - k, h - r - k);
  g.quadraticCurveTo(w - k, h - k, w - r - k, h - k);
  g.lineTo(r + k, h - k);
  g.quadraticCurveTo(k, h - k, k, h - r - k);
  g.lineTo(k, cut + k * 0.6);
  g.closePath();
}
function tagHole(g: CanvasRenderingContext2D, w: number, ring: string) {
  g.fillStyle = ring;
  g.beginPath();
  g.arc(w / 2, TAG_HOLE, 31, 0, TAU);
  g.fill();
  g.strokeStyle = "rgba(120,80,50,0.35)";
  g.lineWidth = 2;
  g.stroke();
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(w / 2, TAG_HOLE, 13, 0, TAU);
  g.fill();
  g.globalCompositeOperation = "source-over";
}
function paperTooth(g: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const rand = mulberry32(seed);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = rand() > 0.5 ? "rgba(120,90,60,0.05)" : "rgba(255,255,255,0.3)";
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

interface TagArt {
  front: THREE.CanvasTexture;
  back: THREE.CanvasTexture;
  aspect: number;
  holeFrac: number;
}
/** Sized to the message: the font steps down until it fits, then the tag grows to
 *  hold exactly as many lines as it took. */
function buildTag(message: string, sender: string, lang: Lang): TagArt {
  const ar = lang === "ar";
  const fam = ar ? AR_FONT : HAND_FONT;
  const weight = ar ? "500" : "700";
  const body = (message.trim() || (ar ? "ألف سلامة عليك" : "Feel better soon.")).replace(/\n{3,}/g, "\n\n");
  const W = TAG_CW;
  const PAD = 70;
  const maxW = W - PAD * 2;
  const LH = ar ? 1.55 : 1.3;
  const MAX_TEXT = 560;
  const [, m] = canvas(8, 8);
  if (ar) m.direction = "rtl";
  let size = 58;
  let lines: string[] = [];
  for (const s of [58, 52, 46, 41, 37, 33, 30, 27, 24]) {
    size = s;
    m.font = `${weight} ${s}px ${fam}`;
    lines = wrapText(m, body, maxW);
    if (lines.length * s * LH <= MAX_TEXT) break;
  }
  const TOP = 172;
  const FOOT = 112;
  const H = Math.round(TOP + lines.length * size * LH + FOOT);

  /* front: the message */
  const [fc, g] = canvas(W, H);
  tagPath(g, W, H, 0);
  g.fillStyle = "#fcf5e8";
  g.fill();
  g.save();
  tagPath(g, W, H, 0);
  g.clip();
  paperTooth(g, W, H, 5150);
  g.restore();
  g.setLineDash([12, 10]);
  g.strokeStyle = "rgba(212,112,138,0.75)";
  g.lineWidth = 3.5;
  tagPath(g, W, H, 22);
  g.stroke();
  g.setLineDash([]);
  tagHole(g, W, "#e9c9a0");
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#cf6a84";
  g.font = ar ? `700 38px ${AR_FONT}` : "italic 600 32px Georgia, 'Times New Roman', serif";
  const head = ar ? "سلامتك" : "get well soon";
  g.fillText(head, W / 2, 132);
  const hw = g.measureText(head).width;
  g.fillStyle = "#e7869d";
  heartPath(g, W / 2 - hw / 2 - 26, 132, 10);
  g.fill();
  heartPath(g, W / 2 + hw / 2 + 26, 132, 10);
  g.fill();
  g.fillStyle = "#3a2830";
  g.font = `${weight} ${size}px ${fam}`;
  lines.forEach((l, i) => g.fillText(l, W / 2, TOP + (i + 0.5) * size * LH));
  const sig = sender.trim();
  if (sig) {
    let ss = ar ? 38 : 40;
    g.font = `${weight} ${ss}px ${fam}`;
    while (ss > 22 && g.measureText(`— ${sig}`).width > maxW) {
      ss -= 2;
      g.font = `${weight} ${ss}px ${fam}`;
    }
    g.fillStyle = "#6a4655";
    g.textAlign = "end";
    g.fillText(`— ${sig}`, ar ? PAD : W - PAD, H - FOOT / 2 - 2);
  }
  const front = srgb(fc);

  /* back: what shows while it is still turning over */
  const [bc, b] = canvas(W, H);
  tagPath(b, W, H, 0);
  b.fillStyle = "#efdcc0";
  b.fill();
  b.save();
  tagPath(b, W, H, 0);
  b.clip();
  paperTooth(b, W, H, 818);
  b.restore();
  b.setLineDash([12, 10]);
  b.strokeStyle = "rgba(150,105,70,0.6)";
  b.lineWidth = 3.5;
  tagPath(b, W, H, 22);
  b.stroke();
  b.setLineDash([]);
  tagHole(b, W, "#d7b27f");
  b.strokeStyle = "rgba(206,98,126,0.8)";
  b.lineWidth = 8;
  heartPath(b, W / 2, H * 0.55, Math.min(W, H) * 0.2);
  b.stroke();
  const back = srgb(bc);

  return { front, back, aspect: H / W, holeFrac: TAG_HOLE / H };
}

/* ---------- timing ---------- */
// The gesture
const DRAG_LEN = 0.68; // world units of drag that would take it all the way off
const AUTO_AT = 0.7; // let go past here and the rest comes away by itself
const THETA_MAX = 2.72; // peeled back low and slow, nearly flat over itself — the way you are told to
const CRACK_STEP = 0.016;
// A gift may never lock waiting for a hand. Left alone this long, the plaster starts
// coming away by itself, slowly, as if someone patient were doing it for them.
const MERCY0 = 4.2;
const MERCY1 = 7.2;
// After it comes off (seconds since the last of it lets go)
const FLY_DUR = 0.8;
const GLINT0 = 0.2;
const GLINT1 = 1.0;
const INHALE0 = 0.35;
const INHALE1 = 1.05;
const HOP0 = 1.05;
const HOP1 = 1.55;
const TAG0 = 1.35;
const TAG_DUR = 1.15;
const POST_END = 3.2;

const FLOOR = -0.7;
const SINK = 0.035;
const TAG_PROP = 0.36; // how far the tag's top edge is propped up off the blanket
const FOV = 36;
const TAN_H = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

const CUP_X = -1.42;
const CUP_Z = -0.52;
const STEAM_N = 3;
const FLOAT_N = 6;
const SPARK_N = 22;
const SPARK_LIFE = 1.1;
const FAIRY_N = 6;

/* ---------- scratch (per frame, never allocated there) ---------- */
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const V4 = new THREE.Vector3();
const STR_N = 20;

/** Everything the gesture knows. Reset wholesale when a run starts. */
function freshPeel() {
  return {
    down: false,
    touched: false,
    sx: 0,
    sy: 0,
    base: 0,
    target: 0,
    peel: 0,
    crack: 0,
    alone: 0,
    detachAt: -1,
    pdx: -0.7,
    pdy: 0.7,
    px: 99,
    py: 99,
    hoverK: 0,
    sfx: 0, // bitmask of the reveal's one-shot sounds already played
  };
}

type PeelState = ReturnType<typeof freshPeel>;
/** True exactly once: the first frame `post` passes `at` (bit marks it as played). */
function firstPast(g: PeelState, bit: number, post: number, at: number): boolean {
  if (post < at || g.sfx & bit) return false;
  g.sfx |= bit;
  return true;
}

export default function PlasterScene({ variants, phase, senderName, recipientName, message, lang, onOpenComplete }: SceneProps) {
  const felt = HEARTS[variants.heart] ?? HEARTS.red;
  const kind = PLASTERS[variants.plaster] ?? "classic";

  const feltTex = useMemo(() => buildFelt(felt), [felt]);
  useEffect(() => () => feltTex.dispose(), [feltTex]);

  const plasterGeo = useMemo(() => buildPlasterGeo(), []);
  useEffect(() => () => plasterGeo.dispose(), [plasterGeo]);

  const topTex = useMemo(() => buildPlasterTop(kind), [kind]);
  useEffect(() => () => topTex.dispose(), [topTex]);

  const underTex = useMemo(() => {
    const name = recipientName.trim();
    const label =
      lang === "ar" ? (name ? `سلامتك يا ${name}` : "سلامتك") : name ? `Get well, ${name}` : "Get well soon";
    return buildPlasterUnder(kind, label, lang);
  }, [kind, recipientName, lang]);
  useEffect(() => () => underTex.dispose(), [underTex]);

  // A gallery card never gets as far as the tag, and there can be a dozen of them:
  // it is only painted once the gift is somebody's.
  const wantTag = phase !== "preview";
  const tag = useMemo(() => (wantTag ? buildTag(message, senderName, lang) : null), [wantTag, message, senderName, lang]);
  useEffect(
    () => () => {
      tag?.front.dispose();
      tag?.back.dispose();
    },
    [tag],
  );
  const tagH = TAG_W * (tag?.aspect ?? 0.8);
  const holeFrac = tag?.holeFrac ?? 0.1;

  // The string is a camera-facing ribbon rewritten every frame; its buffers are made
  // once and only ever reached through the mesh ref.
  const stringGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((STR_N + 1) * 2 * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < STR_N; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    return geo;
  }, []);
  useEffect(() => () => stringGeo.dispose(), [stringGeo]);

  const sparkBuf = useMemo(() => ({ pos: new Float32Array(SPARK_N * 3), col: new Float32Array(SPARK_N * 3) }), []);
  const sparksRef = useRef({
    t0: -99,
    o: new Float32Array(SPARK_N * 3),
    v: new Float32Array(SPARK_N * 3),
    k: new Float32Array(SPARK_N),
  });

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const gRef = useRef(freshPeel());
  useEffect(() => {
    if (phase === "opening") {
      gRef.current = freshPeel();
      sparksRef.current.t0 = -99;
    }
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const heartRef = useRef<THREE.Group>(null);
  const squashRef = useRef<THREE.Group>(null);
  const contentRef = useRef<THREE.Group>(null);
  const eyeRefs = useRef<(THREE.Mesh | null)[]>([]);
  const goldMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const goldLightRef = useRef<THREE.PointLight>(null);
  const plTopRef = useRef<THREE.Mesh>(null);
  const tagRef = useRef<THREE.Group>(null);
  const strRef = useRef<THREE.Mesh>(null);
  const tabGlowRef = useRef<THREE.Sprite>(null);
  const tabGlowMatRef = useRef<THREE.SpriteMaterial>(null);
  const glintRef = useRef<THREE.Sprite>(null);
  const glintMatRef = useRef<THREE.SpriteMaterial>(null);
  const sparkPtsRef = useRef<THREE.Points>(null);
  const floatRefs = useRef<(THREE.Sprite | null)[]>([]);
  const floatMatRefs = useRef<(THREE.SpriteMaterial | null)[]>([]);
  const steamRefs = useRef<(THREE.Sprite | null)[]>([]);
  const steamMatRefs = useRef<(THREE.SpriteMaterial | null)[]>([]);
  const fairyMatRefs = useRef<(THREE.SpriteMaterial | null)[]>([]);
  const heartShadowRef = useRef<THREE.Mesh>(null);
  const heartShadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const plShadowRef = useRef<THREE.Mesh>(null);
  const plShadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const tagShadowRef = useRef<THREE.Mesh>(null);
  const tagShadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const keyRef = useRef<THREE.SpotLight>(null);


  /* ---------- the hand ---------- */
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const g = gRef.current;
    if (phase !== "opening" || g.detachAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — pointer-out below covers its absence */
    }
    g.down = true;
    g.touched = true;
    g.alone = 0;
    g.sx = ev.point.x;
    g.sy = ev.point.y;
    g.base = g.target;
    // the first catch of a fingernail under the edge
    clack({ freq: 2600, decay: 0.03, gain: 0.1 });
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const g = gRef.current;
    if (phase !== "opening" || g.detachAt >= 0) return;
    // a pointer merely crossing the heart counts as someone being here
    g.alone = 0;
    g.px = ev.point.x;
    g.py = ev.point.y;
    if (!g.down) return;
    ev.stopPropagation();
    const dx = ev.point.x - g.sx;
    const dy = ev.point.y - g.sy;
    // Back along the plaster is the honest direction, but nobody should have to find
    // it: any pull away from where they grabbed counts for at least half.
    const along = dx * g.pdx + dy * g.pdy;
    const eff = Math.max(along, Math.hypot(dx, dy) * 0.55);
    // it does not stick back down
    g.target = Math.max(g.target, clamp01(g.base + eff / DRAG_LEN));
  };
  const onUp = (ev: ThreeEvent<PointerEvent>) => {
    gRef.current.down = false;
    // Hand the capture back now, while the pointer still exists. R3F books a capture
    // before the DOM call that can refuse it, and releases whatever is still booked
    // when the drag plane unmounts — for a touch that was cancelled meanwhile, that
    // release throws during the commit and takes the whole gift down with it.
    try {
      (ev.target as Element).releasePointerCapture(ev.pointerId);
    } catch {
      /* nothing was captured, or it is already gone — both fine */
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    const opening = phase === "opening";
    if (opening) tRef.current += dt;
    const t = tRef.current;
    const g = gRef.current;

    const aspect = state.size.width / Math.max(1, state.size.height);
    // 0 = a phone held upright (stack things), 1 = a laptop (spread them out)
    const wide = smooth(clamp01((aspect - 0.95) / 0.55));

    /* ---- the peel ---- */
    if (opening && g.detachAt < 0) {
      if (!g.down) g.alone += dt;
      const mercy = smooth(clamp01((g.alone - MERCY0) / (MERCY1 - MERCY0)));
      // a floor, never a rate: it cannot pull back what a real hand has done
      if (mercy > 0) g.target = Math.max(g.target, mercy);
      if (!g.down && g.peel > AUTO_AT) g.target = 1;
      const prev = g.peel;
      // adhesive lags the finger a touch: that lag is the stickiness
      g.peel += (g.target - g.peel) * Math.min(1, dt * 11);
      if (g.target >= 1 && g.peel > 0.985) g.peel = 1;
      g.crack += g.peel - prev;
      let n = 0;
      while (g.crack > CRACK_STEP && n < 3) {
        g.crack -= CRACK_STEP;
        n++;
        // A peel is not one sound, it is a hundred tiny ones: every fibre of the
        // adhesive letting go. Bright, short, never twice the same.
        clack({ freq: 1700 + Math.random() * 3600, decay: 0.014 + Math.random() * 0.022, gain: 0.05 + Math.random() * 0.08 });
      }
      if (g.crack > CRACK_STEP * 3) g.crack = 0;
      if (g.peel >= 1) {
        g.detachAt = t;
        clack({ freq: 900, decay: 0.1, gain: 0.2 });
        clack({ freq: 3400, decay: 0.035, gain: 0.12, when: 0.01 });
      }
    }
    // Revealed is a pose, not a memory: it never reads what the opening left behind.
    const post = phase === "revealed" ? POST_END : opening && g.detachAt >= 0 ? t - g.detachAt : -1;
    const peel = phase === "revealed" ? 1 : opening ? g.peel : 0;

    /* ---- the reveal's sounds, once each ---- */
    if (opening && post >= 0) {
      if (firstPast(g, 1, post, GLINT0)) {
        tone(1318.5, { shimmer: true, seconds: 1.3, gain: 0.13 });
        tone(1975.5, { shimmer: true, seconds: 1.1, gain: 0.07, when: 0.14 });
      }
      if (firstPast(g, 2, post, INHALE0)) swell({ source: "noise", filter: "lowpass", cutoff: 820, attack: 0.5, hold: 0.08, release: 0.4, gain: 0.08 });
      if (firstPast(g, 4, post, HOP1)) clack({ freq: 240, decay: 0.16, gain: 0.22 });
      if (firstPast(g, 8, post, HOP1 + 0.3)) {
        // its first heartbeat back: lub… dub
        tone(72, { seconds: 0.22, gain: 0.42 });
        tone(64, { seconds: 0.26, gain: 0.34, when: 0.2 });
      }
      if (firstPast(g, 16, post, TAG0 + TAG_DUR * 0.92)) clack({ freq: 1500, decay: 0.05, gain: 0.1 });
    }

    /* ---- where things go once it is healed ---- */
    const layHX = lerp(0, -0.64, wide);
    const layHZ = lerp(-0.5, -0.14, wide);
    const layTX = lerp(0.02, 0.8, wide);
    const layTZ = lerp(0.66, 0.2, wide);
    const layTYaw = lerp(-0.04, -0.13, wide);
    const layPX = lerp(-0.14, -0.46, wide);
    const layPZ = lerp(1.5, 0.92, wide);
    const layPYaw = lerp(0.1, 0.16, wide);
    // a laptop has the room to make the words bigger; a phone already spends its width on them
    const tagS = lerp(1, 1.2, wide);

    /* ---- the heart ---- */
    const droop = post < 0 ? 1 : 1 - smooth(clamp01((post - INHALE0) / (INHALE1 - INHALE0)));
    const moveK = post < 0 ? 0 : smooth(clamp01((post - HOP0) / (HOP1 - HOP0)));
    const hopK = post < 0 ? -1 : (post - HOP0) / (HOP1 - HOP0);
    const air = hopK > 0 && hopK < 1 ? Math.sin(hopK * Math.PI) : 0;
    const hx = lerp(0, layHX, moveK);
    const hz = lerp(0, layHZ, moveK);
    if (heartRef.current) {
      const h = heartRef.current;
      h.position.set(hx, FLOOR - SINK + air * 0.32, hz);
      // Slumped forward and leaning, the way a thing that feels poorly sits. The sway
      // is slow and a little uneven — breathing, not a metronome.
      const sway = Math.sin(e * 0.7) * 0.02 + Math.sin(e * 0.31 + 1) * 0.012;
      // …and once it is well it turns a little toward the tag, which is where you are looking
      const turn = lerp(-0.2, lerp(0.02, 0.2, wide), 1 - droop) + Math.sin(e * 0.4) * 0.03;
      h.rotation.set(droop * 0.22, turn, droop * 0.16 + sway * droop + (1 - droop) * sway * 0.4);
    }
    if (squashRef.current) {
      let sy: number;
      let sxz: number;
      if (post < 0) {
        // a slow, shallow breath with a sigh on the way out
        const b = Math.sin(e * 1.15);
        sy = 0.95 + b * 0.018;
        sxz = 1.03 - b * 0.01;
      } else {
        const inh = clamp01((post - INHALE0) / (INHALE1 - INHALE0 + 0.25));
        const swellK = Math.sin(inh * Math.PI);
        // the big breath in: it fills out and stands up
        sy = lerp(0.95, 1.02, 1 - droop) + swellK * 0.08;
        sxz = lerp(1.03, 1.02, 1 - droop) + swellK * 0.05;
        // crouch before the hop, stretch in the air, squash on the landing
        const crouch = Math.max(0, 1 - Math.abs(post - (HOP0 - 0.07)) / 0.1);
        sy -= crouch * 0.1;
        sxz += crouch * 0.06;
        sy += air * 0.09;
        sxz -= air * 0.045;
        const land = post - HOP1;
        if (land > 0) {
          const sq = Math.exp(-land * 6) * Math.cos(land * 19) * 0.13;
          sy -= sq;
          sxz += sq * 0.6;
        }
        // …and then it beats: lub-dub, a rest, lub-dub
        if (post > HOP1 + 0.3) {
          const p = (e % 1.25) / 1.25;
          const beat = Math.exp(-Math.pow((p - 0.05) / 0.035, 2)) * 0.04 + Math.exp(-Math.pow((p - 0.2) / 0.035, 2)) * 0.028;
          sy += beat;
          sxz += beat;
        }
      }
      squashRef.current.scale.set(sxz, sy, sxz);
    }
    const content = contentRef.current;
    if (!content) return;
    content.updateWorldMatrix(true, false);
    const m = content.matrixWorld.elements;

    /* ---- eyes: tired ∪ ∪ until the plaster is off, then ^ ^ ---- */
    const flip = post < 0 ? 0 : smooth(clamp01((post - 0.6) / 0.28));
    for (let i = 0; i < 2; i++) {
      const eye = eyeRefs.current[i];
      if (!eye) continue;
      eye.scale.set(1, 1 - 2 * flip, 1);
      // a worried slant while unwell, inner ends up
      eye.rotation.z = (i === 0 ? -1 : 1) * 0.24 * (1 - flip);
    }

    /* ---- the invitation, until a hand takes it ---- */
    const inviting = opening && !g.touched && g.detachAt < 0 ? 1 - clamp01((g.alone - MERCY0) / 0.8) : 0;
    const askIn = clamp01((t - 0.5) / 0.6);
    // every couple of seconds the tab lifts by itself, as if tugged — the hint is the
    // gesture itself, done small
    const tugP = ((t - 0.9) % 2.3) / 0.75;
    const tug = inviting * askIn * (t > 0.9 && tugP < 1 ? Math.sin(tugP * Math.PI) : 0);
    // hover: the pointer near the tab lifts it a little more
    // the fold line of the tab (not the plaster's far end, which is folded back under it)
    const tabI = (TAB_COL * (PL_NV + 1) + 1) * 3;
    V1.set(PL.rest[tabI], PL.rest[tabI + 1], PL.rest[tabI + 2]).applyMatrix4(content.matrixWorld);
    const tabX = V1.x;
    const tabY = V1.y;
    const tabZ = V1.z;
    V2.set(PL.rest[3], PL.rest[4], PL.rest[5]).applyMatrix4(content.matrixWorld);
    const pl = Math.hypot(V2.x - tabX, V2.y - tabY) || 1;
    g.pdx = (V2.x - tabX) / pl;
    g.pdy = (V2.y - tabY) / pl;
    const near = opening && g.detachAt < 0 && Math.hypot(g.px - tabX, g.py - tabY) < 0.3 ? 1 : 0;
    g.hoverK += (near - g.hoverK) * Math.min(1, dt * 8);

    /* ---- the plaster ---- */
    const pm = plTopRef.current;
    if (pm) {
      const pa = pm.geometry.attributes.position as THREE.BufferAttribute;
      const na = pm.geometry.attributes.normal as THREE.BufferAttribute;
      const out = pa.array as Float32Array;
      const flutter = phase === "preview" ? Math.max(0, Math.sin(e * 1.3)) * 0.35 : phase === "sealed" ? Math.max(0, Math.sin(e * 0.9)) * 0.15 : 0;
      // at rest the corner is folded right back on itself (pale side up — the universal
      // "start here"); a hover or the ghost tug lifts it off toward the finger
      const theta0 = 2.9 - flutter * 0.9 - g.hoverK * 0.7 - tug * 1.1;
      const ghost = tug * 0.07;
      const pk = Math.max(peel, ghost);
      const uf = lerp(PL_L / 2 - PL_TAB, -PL_L / 2, pk);
      const theta = lerp(theta0, THETA_MAX, smooth(clamp01(pk / 0.22)));
      // at rest the fold is tight (a creased corner); a real peel rolls wider
      const r = lerp(0.011 + g.hoverK * 0.01 + tug * 0.012, 0.05, smooth(clamp01(pk / 0.3)));
      if (post < 0) {
        curlShape(out, uf, theta, r, m);
      } else {
        const fk = easeInOut(clamp01(post / FLY_DUR));
        curlShape(SCR_A, -PL_L / 2, THETA_MAX, 0.06, m);
        lieShape(SCR_B, layPX, layPZ, layPYaw, FLOOR);
        const arc = Math.sin(fk * Math.PI) * 0.42;
        // it tumbles as it goes: the two ends trade heights mid-flight
        for (let i = 0; i <= PL_NU; i++) {
          const spin = Math.sin(fk * Math.PI) * ((i / PL_NU) - 0.5) * 0.3;
          for (let j = 0; j <= PL_NV; j++) {
            const o = (i * (PL_NV + 1) + j) * 3;
            out[o] = lerp(SCR_A[o], SCR_B[o], fk);
            out[o + 1] = lerp(SCR_A[o + 1], SCR_B[o + 1], fk) + arc + spin;
            out[o + 2] = lerp(SCR_A[o + 2], SCR_B[o + 2], fk);
          }
        }
      }
      gridNormals(out, na.array as Float32Array);
      pa.needsUpdate = true;
      na.needsUpdate = true;
    }

    /* ---- the gold, found ---- */
    const reveal = post < 0 ? 0 : clamp01(post / 0.6);
    const glintK = post < 0 ? -1 : (post - GLINT0) / (GLINT1 - GLINT0);
    if (goldMatRef.current) {
      const shine = glintK > 0 && glintK < 1.3 ? Math.sin(Math.min(1, glintK) * Math.PI) : 0;
      const idle = phase === "revealed" || post > GLINT1 ? Math.max(0, Math.sin(e * 1.6)) * 0.12 : 0;
      goldMatRef.current.emissiveIntensity = 0.18 + reveal * 0.12 + shine * 0.9 + idle;
    }
    if (goldLightRef.current) {
      const shine = glintK > 0 && glintK < 1 ? Math.sin(glintK * Math.PI) : 0;
      goldLightRef.current.intensity = shine * 0.7 + (post >= 0 ? 0.12 : 0);
    }
    if (glintRef.current && glintMatRef.current) {
      const on = glintK > 0 && glintK < 1;
      glintRef.current.visible = on;
      if (on) {
        const f = glintK * (X_N - 1);
        const i0 = Math.min(X_N - 2, Math.floor(f));
        const fr = f - i0;
        const s = GOLD.samples;
        const o = i0 * 3;
        V3.set(lerp(s[o], s[o + 3], fr), lerp(s[o + 1], s[o + 4], fr), lerp(s[o + 2], s[o + 5], fr));
        V3.applyMatrix4(content.matrixWorld);
        glintRef.current.position.copy(V3);
        glintRef.current.scale.setScalar(0.16 + Math.sin(glintK * Math.PI) * 0.08);
        glintMatRef.current.opacity = Math.sin(glintK * Math.PI);
      }
    }

    /* ---- sparks thrown off the mend ---- */
    const sk = sparksRef.current;
    if (opening && post >= GLINT0 && sk.t0 < 0) {
      sk.t0 = e;
      V3.set(GOLD.cx, GOLD.cy, GOLD.cz).applyMatrix4(content.matrixWorld);
      for (let i = 0; i < SPARK_N; i++) {
        const a = Math.random() * TAU;
        const sp = 0.35 + Math.random() * 0.9;
        sk.o[i * 3] = V3.x + (Math.random() - 0.5) * 0.12;
        sk.o[i * 3 + 1] = V3.y + (Math.random() - 0.5) * 0.12;
        sk.o[i * 3 + 2] = V3.z;
        sk.v[i * 3] = Math.cos(a) * sp;
        sk.v[i * 3 + 1] = Math.sin(a) * sp * 0.7 + 0.55;
        sk.v[i * 3 + 2] = 0.3 + Math.random() * 0.5;
        sk.k[i] = 0.5 + Math.random() * 0.5;
      }
    }
    const sp = sparkPtsRef.current;
    if (sp) {
      const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      const a = e - sk.t0;
      const live = opening && a >= 0 && a < SPARK_LIFE;
      sp.visible = live;
      if (live) {
        for (let i = 0; i < SPARK_N; i++) {
          pa.setXYZ(i, sk.o[i * 3] + sk.v[i * 3] * a, sk.o[i * 3 + 1] + sk.v[i * 3 + 1] * a - 0.9 * a * a, sk.o[i * 3 + 2] + sk.v[i * 3 + 2] * a);
          const k = (1 - a / SPARK_LIFE) * sk.k[i] * (0.6 + 0.4 * Math.sin(e * 30 + i));
          ca.setXYZ(i, k * 1.2, k, k * 0.6);
        }
        pa.needsUpdate = true;
        ca.needsUpdate = true;
      }
    }

    /* ---- little hearts rising while it beats ---- */
    const floatOn = post < 0 ? 0 : clamp01((post - HOP1) / 0.6);
    for (let i = 0; i < FLOAT_N; i++) {
      const s = floatRefs.current[i];
      const sm = floatMatRefs.current[i];
      if (!s || !sm) continue;
      s.visible = floatOn > 0;
      if (!s.visible) continue;
      const k = ((e * 0.24 + i / FLOAT_N) % 1 + 1) % 1;
      const side = i % 2 === 0 ? -1 : 1;
      s.position.set(hx + side * (0.45 + (i % 3) * 0.12) + Math.sin(e * 1.3 + i * 2) * 0.05, FLOOR + 0.9 + k * 0.95, hz + 0.1 + (i % 3) * 0.06);
      s.scale.setScalar(0.06 + k * 0.05 + (i % 2) * 0.015);
      sm.opacity = Math.pow(Math.sin(k * Math.PI), 1.4) * 0.8 * floatOn;
      sm.rotation = Math.sin(e * 1.1 + i) * 0.25;
    }

    /* ---- the tag: out from behind, over, and down on the blanket face up ---- */
    const tg = tagRef.current;
    let tagVisible = false;
    if (tg) {
      const k = post < 0 ? 0 : clamp01((post - TAG0) / TAG_DUR);
      tagVisible = post >= TAG0;
      tg.visible = tagVisible;
      if (tagVisible) {
        const kk = easeOutCubic(k);
        const sx = hx + 0.22;
        const sy = FLOOR + 0.85;
        const sz = hz - 0.4;
        const ex = layTX;
        const ey = FLOOR + ((tagH * tagS) / 2) * Math.sin(TAG_PROP) + 0.006;
        const ez = layTZ;
        tg.position.set(lerp(sx, ex, kk), lerp(sy, ey, kk) + Math.sin(k * Math.PI) * 0.55, lerp(sz, ez, kk));
        const land = post - (TAG0 + TAG_DUR);
        const wob = land > 0 ? Math.exp(-land * 6) * Math.sin(land * 17) * 0.07 : 0;
        tg.rotation.set(lerp(0.15, -(Math.PI / 2 - TAG_PROP), easeInOut(k)) + wob, lerp(Math.PI, layTYaw, smooth(k)), Math.sin(k * Math.PI) * 0.35);
        tg.scale.setScalar(tagS * lerp(0.3, 1, easeOutCubic(Math.min(1, k * 1.5))));
      }
    }

    /* ---- the string from the bow to the tag ---- */
    const str = strRef.current;
    if (str && tg) {
      str.visible = tagVisible;
      if (tagVisible) {
        tg.updateWorldMatrix(true, false);
        V1.copy(ANCHOR).applyMatrix4(content.matrixWorld);
        V2.set(0, tagH / 2 - tagH * holeFrac, 0).applyMatrix4(tg.matrixWorld);
        // control point: sags onto the blanket between the two, bellied toward us
        const cx = (V1.x + V2.x) / 2 + 0.06;
        const cy = Math.max(FLOOR + 0.01, Math.min(V1.y, V2.y) - 0.12);
        const cz = (V1.z + V2.z) / 2 + 0.12;
        const cam = state.camera.position;
        const arr = (str.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let i = 0; i <= STR_N; i++) {
          const u = i / STR_N;
          const a = (1 - u) * (1 - u);
          const b = 2 * (1 - u) * u;
          const c = u * u;
          const px = a * V1.x + b * cx + c * V2.x;
          const py = a * V1.y + b * cy + c * V2.y;
          const pz = a * V1.z + b * cz + c * V2.z;
          // tangent × view gives the ribbon's width direction
          const tx = 2 * (1 - u) * (cx - V1.x) + 2 * u * (V2.x - cx);
          const ty = 2 * (1 - u) * (cy - V1.y) + 2 * u * (V2.y - cy);
          const tz = 2 * (1 - u) * (cz - V1.z) + 2 * u * (V2.z - cz);
          V3.set(tx, ty, tz);
          V4.set(cam.x - px, cam.y - py, cam.z - pz);
          V3.cross(V4).normalize().multiplyScalar(0.007);
          arr[i * 6] = px + V3.x;
          arr[i * 6 + 1] = py + V3.y;
          arr[i * 6 + 2] = pz + V3.z;
          arr[i * 6 + 3] = px - V3.x;
          arr[i * 6 + 4] = py - V3.y;
          arr[i * 6 + 5] = pz - V3.z;
        }
        str.geometry.attributes.position.needsUpdate = true;
      }
    }

    /* ---- the tab's glow ---- */
    if (tabGlowRef.current && tabGlowMatRef.current) {
      const want = inviting * askIn * (0.45 + 0.25 * Math.sin(e * 3.4)) + g.hoverK * 0.35 * (g.detachAt < 0 && opening ? 1 : 0);
      tabGlowMatRef.current.opacity += (want - tabGlowMatRef.current.opacity) * Math.min(1, dt * 6);
      tabGlowRef.current.visible = tabGlowMatRef.current.opacity > 0.01;
      tabGlowRef.current.position.set(tabX, tabY, tabZ + 0.05);
      tabGlowRef.current.scale.setScalar(0.24 + 0.05 * Math.sin(e * 3.4) + tug * 0.08);
    }

    /* ---- steam off the tea ---- */
    for (let i = 0; i < STEAM_N; i++) {
      const s = steamRefs.current[i];
      const sm = steamMatRefs.current[i];
      if (!s || !sm) continue;
      const k = (e * 0.3 + i / STEAM_N) % 1;
      s.position.set(CUP_X + Math.sin(k * 5 + i * 2.1 + e * 0.6) * 0.045 * (0.4 + k), FLOOR + 0.3 + k * 0.6, CUP_Z);
      s.scale.set(0.14 + k * 0.2, 0.3 + k * 0.26, 1);
      sm.opacity = Math.pow(Math.sin(k * Math.PI), 1.5) * 0.34;
      sm.rotation = Math.sin(e * 0.8 + i) * 0.3;
    }

    /* ---- fairy lights on the wall, each with its own slow flicker ---- */
    for (let i = 0; i < FAIRY_N; i++) {
      const fm = fairyMatRefs.current[i];
      if (fm) fm.opacity = 0.25 + 0.3 * Math.max(0, Math.sin(e * (0.6 + i * 0.17) + i * 2.3));
    }

    /* ---- contact shadows ---- */
    if (heartShadowRef.current && heartShadowMatRef.current) {
      heartShadowRef.current.position.set(hx, FLOOR + 0.004, hz + 0.02);
      heartShadowRef.current.scale.set(1.3 - air * 0.3, 0.55 - air * 0.12, 1);
      heartShadowMatRef.current.opacity = 0.55 - air * 0.25;
    }
    if (plShadowRef.current && plShadowMatRef.current) {
      const k = post < 0 ? 0 : clamp01((post - FLY_DUR * 0.7) / 0.3);
      plShadowRef.current.visible = k > 0;
      plShadowRef.current.position.set(layPX, FLOOR + 0.003, layPZ);
      plShadowRef.current.rotation.z = layPYaw;
      plShadowMatRef.current.opacity = 0.3 * k;
    }
    if (tagShadowRef.current && tagShadowMatRef.current) {
      const k = post < 0 ? 0 : clamp01((post - TAG0 - TAG_DUR * 0.6) / (TAG_DUR * 0.4));
      tagShadowRef.current.visible = k > 0;
      tagShadowRef.current.position.set(layTX, FLOOR + 0.003, layTZ + 0.03);
      tagShadowRef.current.rotation.z = layTYaw;
      tagShadowRef.current.scale.set(TAG_W * 1.2 * tagS, tagH * 0.95 * Math.cos(TAG_PROP) * tagS, 1);
      tagShadowMatRef.current.opacity = 0.32 * k;
    }

    if (keyRef.current) keyRef.current.intensity = 3.1 + (1 - droop) * 0.2;

    /* ---- camera: dollied to fit both axes, craning up for the reveal ---- */
    const camK = post < 0 ? 0 : smooth(clamp01((post - 0.95) / 1.7));
    const cam = camRef.current;
    if (cam) {
      const tx = lerp(0, lerp(0.02, 0.1, wide), camK);
      const ty = lerp(-0.06, lerp(-0.38, -0.2, wide), camK);
      const tz = lerp(0.05, lerp(0.42, 0.25, wide), camK);
      const halfW = lerp(1.12, lerp(1.02, 1.82, wide), camK);
      const halfH = lerp(0.98, lerp(1.34, 1.04, wide), camK);
      const el = lerp(0.17, 0.5, camK);
      const dist = Math.max(halfH / TAN_H, halfW / (TAN_H * aspect));
      const az = Math.sin(e * 0.19) * 0.035;
      cam.position.set(tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist + Math.sin(e * 0.27) * 0.01, tz + Math.cos(az) * Math.cos(el) * dist);
      cam.lookAt(tx, ty, tz);
    }

    if (opening && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const clear = kind === "clear";

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault fov={FOV} near={0.1} far={40} position={[0, 0.8, 5]} />
      <fog attach="fog" args={["#2c1d20", 4, 8.6]} />
      <hemisphereLight args={["#ffe6d2", "#3b2520", 0.55]} />
      <spotLight ref={keyRef} position={[1.4, 4.2, 3.4]} angle={0.62} penumbra={0.95} decay={0} intensity={3.1} color="#fff0dc" />
      {/* a rose rim from behind: it is what makes the felt's fuzz show on the silhouette */}
      <directionalLight position={[-2.4, 2, -2.6]} intensity={1.4} color="#ffbfd0" />
      <directionalLight position={[-3, 1.2, 3]} intensity={0.45} color="#ffd6c8" />
      {/* the tea's warmth, low on the left */}
      <pointLight position={[CUP_X + 0.2, FLOOR + 0.6, CUP_Z + 0.6]} intensity={1.2} distance={3.5} decay={1.4} color="#ffb06a" />

      {/* the wall */}
      <mesh position={[0, 2.2, -6]}>
        <planeGeometry args={[26, 13]} />
        {/* fog lands after tone mapping; the wall has to skip tone mapping too, or the
            blanket's fogged far edge and the wall's foot never match and the seam shows */}
        <meshBasicMaterial map={BACKDROP} fog={false} depthWrite={false} toneMapped={false} />
      </mesh>
      {FAIRY_N > 0 &&
        BOKEH.slice(3, 3 + FAIRY_N * 3)
          .filter((_, i) => i % 3 === 0)
          .map(([x, y], i) => (
            <sprite key={i} position={[(x - 0.5) * 26, 2.2 + (0.5 - y) * 13, -5.95]} scale={0.42}>
              <spriteMaterial
                ref={(mm) => {
                  fairyMatRefs.current[i] = mm;
                }}
                map={GLOW}
                color="#ffd79a"
                transparent
                opacity={0.3}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                fog={false}
              />
            </sprite>
          ))}

      {/* the blanket */}
      <mesh position={[0, FLOOR, -1]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[18, 12]} />
        <meshStandardMaterial map={KNIT} bumpMap={KNIT_BUMP} bumpScale={1.2} roughness={0.95} />
      </mesh>

      {/* soft contact shadows, painted */}
      <mesh ref={heartShadowRef} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={heartShadowMatRef} map={SHADOW} transparent depthWrite={false} opacity={0.55} />
      </mesh>
      <mesh ref={plShadowRef} rotation={[-Math.PI / 2, 0, 0]} scale={[PL_L * 1.2, PL_W * 1.6, 1]} visible={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={plShadowMatRef} map={SHADOW} transparent depthWrite={false} opacity={0} />
      </mesh>
      <mesh ref={tagShadowRef} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={tagShadowMatRef} map={SHADOW} transparent depthWrite={false} opacity={0} />
      </mesh>

      {/* a cup of tea, going cold because nobody is drinking it */}
      <group position={[CUP_X, FLOOR, CUP_Z]} rotation={[0, 0.5, 0]}>
        <mesh geometry={SAUCER_GEO}>
          <meshStandardMaterial color="#eaa7b3" roughness={0.35} />
        </mesh>
        <mesh geometry={CUP_GEO} position={[0, 0.012, 0]}>
          <meshStandardMaterial color="#f5ede2" roughness={0.3} side={THREE.DoubleSide} />
        </mesh>
        <mesh geometry={TEA_GEO} position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshStandardMaterial color="#8a4a20" roughness={0.12} />
        </mesh>
        <mesh geometry={HANDLE_GEO} position={[0.19, 0.14, 0]} rotation={[0, 0, -Math.PI * 0.62]}>
          <meshStandardMaterial color="#f5ede2" roughness={0.3} />
        </mesh>
        {/* the tea bag's tag over the rim */}
        <mesh position={[-0.02, 0.2, 0.2]} rotation={[0.25, 0, 0]}>
          <boxGeometry args={[0.004, 0.14, 0.004]} />
          <meshStandardMaterial color="#eee4d4" />
        </mesh>
        <mesh position={[-0.02, 0.1, 0.225]} rotation={[0.2, 0, 0]}>
          <planeGeometry args={[0.07, 0.08]} />
          <meshStandardMaterial color="#f2c35b" roughness={0.8} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <mesh position={[CUP_X, FLOOR + 0.003, CUP_Z]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.8, 0.6, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={SHADOW} transparent depthWrite={false} opacity={0.4} />
      </mesh>
      {Array.from({ length: STEAM_N }, (_, i) => (
        <sprite
          key={i}
          ref={(s) => {
            steamRefs.current[i] = s;
          }}
        >
          <spriteMaterial
            ref={(mm) => {
              steamMatRefs.current[i] = mm;
            }}
            map={WISP}
            color="#fff4ea"
            transparent
            opacity={0}
            depthWrite={false}
          />
        </sprite>
      ))}

      {/* the heart: pivots on its tip, so it leans, slumps and squashes like it sits */}
      <group ref={heartRef}>
        <group ref={squashRef}>
          <group ref={contentRef} position={[0, -TIP_Y, 0]}>
            <mesh geometry={HEART_GEO}>
              <meshPhysicalMaterial map={feltTex} bumpMap={FELT_BUMP} bumpScale={1.6} roughness={0.95} sheen={1} sheenRoughness={0.5} sheenColor={felt.sheen} />
            </mesh>
            <instancedMesh ref={placeRim} args={[RIM_GEO, undefined, RIM_N]}>
              <meshStandardMaterial color={felt.thread} roughness={0.85} />
            </instancedMesh>
            {EYE_POSE.map((ep, i) => (
              <group key={i} position={ep.p} quaternion={ep.q}>
                <mesh
                  ref={(mm) => {
                    eyeRefs.current[i] = mm;
                  }}
                  geometry={EYE_GEO}
                >
                  <meshStandardMaterial color="#3a1c22" roughness={0.8} />
                </mesh>
              </group>
            ))}
            <instancedMesh ref={placeGold} args={[X_GEO, undefined, X_N * 2]}>
              <meshStandardMaterial
                ref={goldMatRef}
                color="#e8b64a"
                metalness={0.85}
                roughness={0.28}
                envMap={GOLD_ENV}
                envMapIntensity={1.3}
                emissive="#ffae2a"
                emissiveIntensity={0.18}
              />
            </instancedMesh>
            <pointLight ref={goldLightRef} position={[GOLD.cx, GOLD.cy, GOLD.cz + 0.25]} intensity={0} distance={0.7} decay={1.5} color="#ffcf6a" />
            {/* the bow the tag is tied with */}
            <group position={[0, BOW_Y, BOW_Z]}>
              <mesh geometry={BOW_LOOP} position={[-0.032, 0.006, 0]} rotation={[0, 0, 0.35]} scale={[1, 0.62, 1]}>
                <meshStandardMaterial color="#c89a68" roughness={0.9} />
              </mesh>
              <mesh geometry={BOW_LOOP} position={[0.032, 0.006, 0]} rotation={[0, 0, -0.35]} scale={[1, 0.62, 1]}>
                <meshStandardMaterial color="#c89a68" roughness={0.9} />
              </mesh>
              <mesh geometry={BOW_KNOT}>
                <meshStandardMaterial color="#b98a58" roughness={0.9} />
              </mesh>
            </group>
          </group>
        </group>
      </group>

      {/* the plaster: one grid, two faces — the backing outward, the pad and the
          writing on the sticky side. World-space vertices, so no culling box. */}
      {/* keyed on the kind: `transparent` is baked into the compiled shader (three's
          OPAQUE define), so a live switch to the clear film needs a fresh material */}
      <mesh ref={plTopRef} geometry={plasterGeo} frustumCulled={false}>
        <meshStandardMaterial
          key={kind}
          map={topTex}
          roughness={clear ? 0.22 : 0.85}
          transparent={clear}
          depthWrite={!clear}
          alphaTest={clear ? 0.02 : 0.5}
          side={THREE.FrontSide}
        />
      </mesh>
      <mesh geometry={plasterGeo} frustumCulled={false}>
        <meshStandardMaterial
          key={kind}
          map={underTex}
          roughness={0.8}
          transparent={clear}
          depthWrite={!clear}
          alphaTest={clear ? 0.02 : 0.5}
          side={THREE.BackSide}
        />
      </mesh>

      {/* the tag */}
      <group ref={tagRef} visible={false} rotation-order="YXZ">
        {tag && (
          <>
            <mesh>
              <planeGeometry args={[TAG_W, tagH]} />
              <meshStandardMaterial map={tag.front} emissiveMap={tag.front} emissive="#ffffff" emissiveIntensity={0.35} roughness={0.9} alphaTest={0.5} />
            </mesh>
            <mesh rotation={[0, Math.PI, 0]} position={[0, 0, -0.002]}>
              <planeGeometry args={[TAG_W, tagH]} />
              <meshStandardMaterial map={tag.back} roughness={0.9} alphaTest={0.5} />
            </mesh>
          </>
        )}
      </group>
      <mesh ref={strRef} geometry={stringGeo} frustumCulled={false} visible={false}>
        <meshStandardMaterial color="#c49868" roughness={0.9} side={THREE.DoubleSide} />
      </mesh>

      {/* light: the tab's come-hither, the glint that runs the gold, the sparks */}
      <sprite ref={tabGlowRef} visible={false}>
        <spriteMaterial
          ref={tabGlowMatRef}
          map={GLOW}
          color="#fff1d6"
          transparent
          opacity={0}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          fog={false}
        />
      </sprite>
      <sprite ref={glintRef} visible={false}>
        <spriteMaterial
          ref={glintMatRef}
          map={SPARK}
          color="#fff0c0"
          transparent
          opacity={0}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          fog={false}
        />
      </sprite>
      <points ref={sparkPtsRef} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[sparkBuf.pos, 3]} />
          <bufferAttribute attach="attributes-color" args={[sparkBuf.col, 3]} />
        </bufferGeometry>
        <pointsMaterial map={SPARK} vertexColors size={0.07} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} fog={false} />
      </points>
      {Array.from({ length: FLOAT_N }, (_, i) => (
        <sprite
          key={i}
          visible={false}
          ref={(s) => {
            floatRefs.current[i] = s;
          }}
        >
          <spriteMaterial
            ref={(mm) => {
              floatMatRefs.current[i] = mm;
            }}
            map={HEART_SPRITE}
            color={i % 3 === 0 ? "#ffd27a" : "#ff8fb0"}
            transparent
            opacity={0}
            depthWrite={false}
            fog={false}
          />
        </sprite>
      ))}

      {phase === "opening" && (
        <mesh position={[0, 0, 0.95]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerOut={onUp}>
          <planeGeometry args={[14, 9]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
