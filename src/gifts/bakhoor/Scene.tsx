import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { sampleTextPoints } from "../text3d";
import { makeRadialSprite, radialBlob } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, lerp, mulberry32, smooth } from "../math";
import { clack, pluck, resumeAudio, swell } from "../audio";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
// The burner changes the *material*, not a tint: carved wood is matte and cut deep,
// silver is a mirror with the pattern scratched into it, ceramic is a gloss glaze
// with the pattern painted on — so each needs its own skin, not a recoloured one.
type BurnerKind = "wood" | "silver" | "ceramic";
interface Burner {
  kind: BurnerKind;
  rough: number;
  metal: number;
  env: number;
  bump: number;
  trim: string;
  trimRough: number;
}
const BURNERS: Record<string, Burner> = {
  wood: { kind: "wood", rough: 0.7, metal: 0, env: 0.35, bump: 2.2, trim: "#c99a4e", trimRough: 0.34 },
  silver: { kind: "silver", rough: 0.3, metal: 1, env: 1.15, bump: 1.4, trim: "#e2e5ea", trimRough: 0.22 },
  ceramic: { kind: "ceramic", rough: 0.16, metal: 0, env: 0.7, bump: 0, trim: "#d9aa52", trimRough: 0.26 },
};

// Scent is the smoke's colour and the heat under it. Oud is the warm grey the whole
// region knows; rose is only *faintly* pink — a pink cloud would be a cartoon.
interface Scent {
  smoke: THREE.Color;
  warm: THREE.Color;
  ember: THREE.Color;
}
const SCENTS: Record<string, Scent> = {
  oud: { smoke: new THREE.Color("#dcd2c6"), warm: new THREE.Color("#ffa65e"), ember: new THREE.Color("#ff6a1c") },
  rose: { smoke: new THREE.Color("#f3d7dd"), warm: new THREE.Color("#ff9a86"), ember: new THREE.Color("#ff5a30") },
  musk: { smoke: new THREE.Color("#f6f5f2"), warm: new THREE.Color("#ffd3aa"), ember: new THREE.Color("#ff7a2c") },
};

/* ---------- stage (world units, floor at y = 0) ---------- */
const FOV = 32;
const TAN = Math.tan((FOV * Math.PI) / 360);
const BG = "#0b0807";
const TAU = Math.PI * 2;
const TRAY_TOP = 0.024;
const B0 = TRAY_TOP; // the burner stands on the tray
const COAL = new THREE.Vector3(0, B0 + 0.975, 0);
const ON_COAL = new THREE.Vector3(0.012, B0 + 1.046, 0.006); // where the chip comes to rest
const HOVER = new THREE.Vector3(0, B0 + 1.22, 0.03); // just above the coal
const REST = new THREE.Vector3(0.56, TRAY_TOP + 0.017, 0.46); // on the tray, in front
const SRC = new THREE.Vector3(0, B0 + 1.07, 0); // where the smoke leaves the coal
const TEXT_BOTTOM = 1.56;

/* ---------- opening timeline (seconds) ---------- */
const MERCY_AT = 6.0; // this long with nobody reaching for the chip, and it goes in by itself
const MERCY_DUR = 1.1;
const TAP_DUR = 0.72;
const FALL_DUR = 0.2;
const BACK_DUR = 0.5;
const HOP_EVERY = 2.1;
// Reveal clock pins here. The last glyph's spring lands at τ≈4.6 and the texture's
// front clears the last line at τ≈4.1; the rest is the settle.
const TAU_HOLD = 4.9;
const CHIME_AT = 2.3;

/* ---------- camera framings: a box to hold, and the angle to hold it from ---------- */
interface Frame {
  cy: number;
  w: number;
  h: number;
  pitch: number;
}
const SEAL_L: Frame = { cy: 0.64, w: 3.1, h: 2.3, pitch: 0.32 };
// A phone is too narrow for the whole tray and a burner worth looking at, so the
// tray gives way at the sides — the chip, at x 0.56, still sits well inside.
const SEAL_P: Frame = { cy: 0.66, w: 1.95, h: 2.3, pitch: 0.34 };
const PREVIEW: Frame = { cy: 0.95, w: 2.7, h: 2.35, pitch: 0.26 };

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();
const smokeTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.9)"],
  [0.4, "rgba(255,255,255,0.36)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- the mabkhara: a lathe with four flat sides ---------- */
// A square censer is still a turned profile — base, waist, bowl — only swept
// around four flat faces instead of a circle. Each face gets its own vertices, so
// it shades flat across and smooth along the profile, and u runs 0→1 across every
// face so one carving texture wraps all four sides.
type P2 = [number, number];
type Band = "plinth" | "body" | "flare" | "bowl";
interface Seg {
  m: 0 | 1 | 2; // 0 carved body, 1 metal trim, 2 soot-black inside of the bowl
  pts: P2[];
  band?: Band;
}
const PROFILE: Seg[] = [
  { m: 1, pts: [[0.366, 0.05], [0.373, 0.056], [0.373, 0.07], [0.366, 0.076]] },
  { m: 0, band: "plinth", pts: [[0.36, 0.076], [0.36, 0.17]] },
  { m: 1, pts: [[0.368, 0.168], [0.375, 0.174], [0.375, 0.188], [0.366, 0.194], [0.328, 0.194]] },
  { m: 0, band: "body", pts: [[0.325, 0.194], [0.318, 0.25], [0.293, 0.33], [0.252, 0.42], [0.205, 0.5], [0.168, 0.56]] },
  { m: 1, pts: [[0.168, 0.56], [0.197, 0.572], [0.201, 0.595], [0.197, 0.618], [0.168, 0.63]] },
  { m: 0, band: "flare", pts: [[0.168, 0.63], [0.19, 0.675], [0.24, 0.722], [0.3, 0.76], [0.335, 0.785]] },
  { m: 1, pts: [[0.338, 0.783], [0.348, 0.79], [0.348, 0.812], [0.34, 0.818]] },
  { m: 0, band: "bowl", pts: [[0.338, 0.818], [0.338, 0.95]] },
  { m: 1, pts: [[0.346, 0.948], [0.355, 0.956], [0.355, 0.984], [0.346, 0.99], [0.29, 0.99]] },
  { m: 2, pts: [[0.29, 0.99], [0.284, 0.88], [0.0, 0.88]] },
];

// v is arc length along the whole profile, so the carving bands land on the
// sections they were drawn for whatever the proportions.
const PROFILE_V: number[][] = (() => {
  let acc = 0;
  let prev: P2 | null = null;
  const out: number[][] = [];
  for (const s of PROFILE) {
    const vs: number[] = [];
    for (const p of s.pts) {
      if (prev) acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      vs.push(acc);
      prev = p;
    }
    out.push(vs);
  }
  return out.map((vs) => vs.map((v) => v / acc));
})();

const CX = [1, -1, -1, 1];
const CZ = [1, 1, -1, -1];
function squareLathe(parts: { pts: P2[]; v: number[] }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const { pts, v } of parts) {
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const base = pos.length / 3;
      pts.forEach(([r, y], i) => {
        pos.push(r * CX[k], y, r * CZ[k], r * CX[k2], y, r * CZ[k2]);
        uv.push(0, v[i], 1, v[i]);
      });
      // Winding puts the normal on the left of the profile's direction: up the
      // outside faces out, inward across a top faces up, down the inside faces in.
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const profileParts = (m: 0 | 1 | 2) =>
  PROFILE.flatMap((s, i) => (s.m === m ? [{ pts: s.pts, v: PROFILE_V[i] }] : []));

/** Point at fraction f of a profile segment's arc length — how studs find the motif they sit on. */
function alongSeg(s: Seg, f: number): P2 {
  const lens: number[] = [0];
  for (let i = 1; i < s.pts.length; i++)
    lens.push(lens[i - 1] + Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]));
  const L = lens[lens.length - 1] * f;
  for (let i = 1; i < s.pts.length; i++) {
    if (L <= lens[i] || i === s.pts.length - 1) {
      const k = clamp01((L - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]));
      return [lerp(s.pts[i - 1][0], s.pts[i][0], k), lerp(s.pts[i - 1][1], s.pts[i][1], k)];
    }
  }
  return s.pts[0];
}

/** Flatten a handful of placed geometries into one: one material, one draw call. */
function bake(parts: { geo: THREE.BufferGeometry; at: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const { geo, at } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    nm.getNormalMatrix(at);
    const P = g.attributes.position;
    const N = g.attributes.normal;
    const U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(at);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
      uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    }
    if (g !== geo) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

const BODY_GEO = squareLathe(profileParts(0));
const INNER_GEO = squareLathe(profileParts(2));

// Everything in metal is one mesh: the profile's bands, the crown on the rim (a
// pinnacle at each corner, merlons between), the feet, and the studs hammered
// into the carving.
const TRIM_GEO = (() => {
  const M = (x: number, y: number, z: number, ry = 0) =>
    new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
  const parts: { geo: THREE.BufferGeometry; at: THREE.Matrix4 }[] = [];
  const bands = squareLathe(profileParts(1));
  parts.push({ geo: bands, at: new THREE.Matrix4() });
  const spire = squareLathe([
    {
      pts: [[0.04, 0], [0.04, 0.045], [0.05, 0.052], [0.05, 0.064], [0.036, 0.072], [0.0, 0.17]],
      v: [0, 0.2, 0.3, 0.4, 0.5, 1],
    },
  ]);
  const ball = new THREE.SphereGeometry(0.017, 10, 8);
  const merlon = new THREE.BoxGeometry(0.07, 0.03, 0.064);
  const foot = new THREE.BoxGeometry(0.1, 0.05, 0.1);
  const stud = new THREE.SphereGeometry(0.0135, 8, 6);
  const bigStud = new THREE.SphereGeometry(0.02, 10, 7);
  const RIM = 0.322; // centreline of the bowl's wall
  for (let k = 0; k < 4; k++) {
    const x = RIM * CX[k];
    const z = RIM * CZ[k];
    parts.push({ geo: spire, at: M(x, 0.99, z) });
    parts.push({ geo: ball, at: M(x, 0.99 + 0.178, z) });
    parts.push({ geo: foot, at: M(0.29 * CX[k], 0.025, 0.29 * CZ[k]) });
  }
  // merlons: two per side, standing on the rim between the pinnacles
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    for (const s of [-0.1, 0.1]) {
      const lx = s;
      const lz = RIM;
      parts.push({ geo: merlon, at: M(lx * Math.cos(ry) + lz * Math.sin(ry), 0.99 + 0.015, -lx * Math.sin(ry) + lz * Math.cos(ry), ry) });
    }
  }
  // Studs sit exactly where the carving's own drawing puts them (see motif()): the
  // same (u, fraction-of-band) coordinates, pushed onto the face at that height.
  const studOn = (band: Band, u: number, f: number, big = false) => {
    const seg = PROFILE.find((s) => s.band === band)!;
    const [r, y] = alongSeg(seg, 1 - f); // f runs top-down in canvas space
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const x = lerp(r * CX[k], r * CX[k2], u);
      const z = lerp(r * CZ[k], r * CZ[k2], u);
      parts.push({ geo: big ? bigStud : stud, at: M(x, y, z) });
    }
  };
  for (let i = 1; i < 6; i++) studOn("plinth", i / 6, 0.24);
  studOn("body", 0.5, 0.5, true);
  studOn("body", 0.5 - 0.38, 0.5);
  studOn("body", 0.5 + 0.38, 0.5);
  for (let i = 0; i < 3; i++) studOn("bowl", (i + 0.5) / 3, 0.14);
  const out = bake(parts);
  for (const g of [bands, spire, ball, merlon, foot, stud, bigStud]) g.dispose();
  return out;
})();

/* ---------- the burner's skin: carved, engraved, or glazed ---------- */
function diamond(p: Path2D, cx: number, cy: number, rx: number, ry: number) {
  p.moveTo(cx, cy - ry);
  p.lineTo(cx + rx, cy);
  p.lineTo(cx, cy + ry);
  p.lineTo(cx - rx, cy);
  p.closePath();
}
function star8(p: Path2D, cx: number, cy: number, r: number) {
  // two squares, one turned 45° — the workhorse of the whole region's geometry
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.62;
    if (i === 0) p.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else p.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  p.closePath();
}
function dot(p: Path2D, x: number, y: number, r: number) {
  p.moveTo(x + r, y);
  p.arc(x, y, r, 0, TAU);
}

/** One band's motif in canvas space: `fill` is cut/painted (evenodd), `line` is stroked. */
function motif(band: Band, W: number, y0: number, y1: number) {
  const fill = new Path2D();
  const line = new Path2D();
  const dots = new Path2D();
  const h = y1 - y0;
  if (band === "plinth") {
    line.moveTo(0, y0 + 9);
    line.lineTo(W, y0 + 9);
    line.moveTo(0, y1 - 9);
    line.lineTo(W, y1 - 9);
    const n = 6;
    const w = W / n;
    for (let i = 0; i < n; i++) {
      const x = i * w;
      fill.moveTo(x + w * 0.14, y1 - 17);
      fill.lineTo(x + w * 0.5, y0 + 20);
      fill.lineTo(x + w * 0.86, y1 - 17);
      fill.closePath();
    }
  } else if (band === "body") {
    line.rect(14, y0 + 12, W - 28, h - 24);
    const cx = W / 2;
    const cy = y0 + h / 2;
    const rx = W * 0.38;
    const ry = h * 0.4;
    // the lozenge as a band: an outer diamond with an inner one cut back out of it
    diamond(fill, cx, cy, rx, ry);
    diamond(fill, cx, cy, rx * 0.8, ry * 0.84);
    star8(fill, cx, cy, Math.min(rx * 0.55, ry * 0.42));
    // a triangle into each corner the lozenge leaves behind
    const cw = W * 0.2;
    const ch = h * 0.2;
    for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = sx ? W - 30 : 30;
      const y = sy ? y1 - 26 : y0 + 26;
      fill.moveTo(x, y);
      fill.lineTo(x + (sx ? -cw : cw), y);
      fill.lineTo(x, y + (sy ? -ch : ch));
      fill.closePath();
    }
    dot(dots, cx - rx, cy, 9);
    dot(dots, cx + rx, cy, 9);
  } else if (band === "flare") {
    const n = 9;
    const w = W / n;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * w;
      fill.moveTo(x - w * 0.24, y0 + 6);
      fill.lineTo(x, y1 - 8);
      fill.lineTo(x + w * 0.24, y0 + 6);
      fill.closePath();
    }
  } else {
    line.moveTo(0, y0 + 7);
    line.lineTo(W, y0 + 7);
    line.moveTo(0, y1 - 7);
    line.lineTo(W, y1 - 7);
    // three pointed arches, as outlines: each is its own arch with a smaller one cut out
    const n = 3;
    const w = W / n;
    const arch = (x0: number, x1: number, yb: number, yt: number) => {
      const xm = (x0 + x1) / 2;
      const ys = yb - (yb - yt) * 0.45;
      fill.moveTo(x0, yb);
      fill.lineTo(x0, ys);
      fill.quadraticCurveTo(x0, yt + (ys - yt) * 0.2, xm, yt);
      fill.quadraticCurveTo(x1, yt + (ys - yt) * 0.2, x1, ys);
      fill.lineTo(x1, yb);
      fill.closePath();
    };
    for (let i = 0; i < n; i++) {
      const x = i * w;
      arch(x + w * 0.16, x + w * 0.84, y1 - 14, y0 + h * 0.26);
      arch(x + w * 0.27, x + w * 0.73, y1 - 14, y0 + h * 0.42);
      dot(dots, x + w / 2, y1 - h * 0.3, 7);
    }
  }
  return { fill, line, dots };
}

function buildSkin(kind: BurnerKind): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture | null } {
  const W = 512;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bc = kind === "ceramic" ? null : document.createElement("canvas");
  let gb: CanvasRenderingContext2D | null = null;
  if (bc) {
    bc.width = W;
    bc.height = H;
    gb = bc.getContext("2d")!;
    gb.fillStyle = "#fff";
    gb.fillRect(0, 0, W, H);
  }
  const rand = mulberry32(kind === "wood" ? 71 : kind === "silver" ? 72 : 73);

  /* the ground the pattern is cut into */
  if (kind === "wood") {
    g.fillStyle = "#3d2616";
    g.fillRect(0, 0, W, H);
    // grain runs up the burner — it was turned from one block, standing
    for (let i = 0; i < 240; i++) {
      const x = rand() * W;
      g.strokeStyle = rand() > 0.5 ? `rgba(18,9,4,${0.18 + rand() * 0.34})` : `rgba(118,78,44,${0.1 + rand() * 0.2})`;
      g.lineWidth = 0.6 + rand() * 2.6;
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= H; y += 32) g.lineTo(x + Math.sin(y * 0.011 + i) * 7 + Math.sin(y * 0.05 + i * 3) * 1.4, y);
      g.stroke();
    }
  } else if (kind === "silver") {
    g.fillStyle = "#d8dbe0";
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = rand() > 0.5 ? `rgba(255,255,255,${rand() * 0.25})` : `rgba(90,96,108,${rand() * 0.18})`;
      g.fillRect(0, rand() * H, W, 0.6 + rand());
    }
  } else {
    g.fillStyle = "#f4efe5";
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(150,130,100,${rand() * 0.12})`;
      g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
    }
  }

  PROFILE.forEach((s, si) => {
    if (!s.band) return;
    const vs = PROFILE_V[si];
    const y0 = (1 - vs[vs.length - 1]) * H; // canvas top = top of the band (flipY)
    const y1 = (1 - vs[0]) * H;
    const { fill, line, dots } = motif(s.band, W, y0, y1);
    if (kind === "wood") {
      // cut: dark in the recess, a lit bevel along the upper-left of every edge
      g.fillStyle = "rgba(14,7,3,0.86)";
      g.fill(fill, "evenodd");
      g.fill(dots);
      g.lineWidth = 4;
      g.strokeStyle = "rgba(14,7,3,0.82)";
      g.stroke(line);
      g.save();
      g.translate(-1.6, -1.6);
      g.strokeStyle = "rgba(170,120,70,0.5)";
      g.lineWidth = 1.4;
      g.stroke(fill);
      g.stroke(line);
      g.restore();
    } else if (kind === "silver") {
      // engraved: hatched inside, a hard graver line round every shape
      g.save();
      g.clip(fill, "evenodd");
      g.strokeStyle = "rgba(58,62,70,0.55)";
      g.lineWidth = 1.2;
      for (let d = -H; d < W + H; d += 6) {
        g.beginPath();
        g.moveTo(d, y0);
        g.lineTo(d + (y1 - y0), y1);
        g.stroke();
      }
      g.restore();
      g.strokeStyle = "rgba(44,48,56,0.95)";
      g.lineWidth = 2.4;
      g.stroke(fill);
      g.stroke(line);
      g.fillStyle = "rgba(44,48,56,0.95)";
      g.fill(dots);
    } else {
      // glazed: gold painted on, cobalt lines ruling each band
      g.fillStyle = "#c8973c";
      g.fill(fill, "evenodd");
      g.strokeStyle = "#86601f";
      g.lineWidth = 1.3;
      g.stroke(fill);
      g.strokeStyle = "#2c4b8e";
      g.lineWidth = 3.2;
      g.stroke(line);
      g.fillStyle = "#2c4b8e";
      g.fill(dots);
    }
    if (gb) {
      // a blurred shadow of the same cut is the bevel: the recess slopes, not steps
      gb.save();
      gb.shadowColor = "#000";
      gb.shadowBlur = kind === "wood" ? 4 : 1.5;
      gb.fillStyle = "#000";
      gb.strokeStyle = "#000";
      if (kind === "wood") {
        gb.fill(fill, "evenodd");
        gb.lineWidth = 4;
      } else {
        gb.lineWidth = 2.4;
        gb.stroke(fill);
      }
      gb.stroke(line);
      gb.fill(dots);
      gb.restore();
    }
  });

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = bc ? new THREE.CanvasTexture(bc) : null;
  return { map, bump };
}

/* ---------- the room: a majlis at night ---------- */
/** Sadu: bands of madder red, black and cream, checks between, teeth and eyes in them. */
function buildSadu(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const RED = "#7c1a16";
  const DARK = "#160f0c";
  const CREAM = "#d6c5a2";
  const ORANGE = "#b35a1e";
  const BROWN = "#40241a";
  const fillBand = (y: number, h: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(0, y, S, h);
  };
  // the little two-colour checks that run between every band of a sadu
  const checks = (y: number, s: number) => {
    for (let x = 0; x < S; x += s)
      for (let r = 0; r < 2; r++) {
        g.fillStyle = (x / s + r) % 2 ? CREAM : DARK;
        g.fillRect(x, y + r * s, s, s);
      }
  };
  const teeth = (y: number, h: number, w: number, col: string, up: boolean) => {
    g.fillStyle = col;
    for (let x = 0; x < S; x += w) {
      g.beginPath();
      g.moveTo(x, up ? y + h : y);
      g.lineTo(x + w / 2, up ? y : y + h);
      g.lineTo(x + w, up ? y + h : y);
      g.fill();
    }
  };
  const eyes = (cy: number, rx: number, ry: number, step: number, a: string, b: string, core: string) => {
    for (let x = step / 2; x < S + step; x += step) {
      g.fillStyle = a;
      const p = new Path2D();
      diamond(p, x, cy, rx, ry);
      g.fill(p);
      g.fillStyle = b;
      const q = new Path2D();
      diamond(q, x, cy, rx * 0.66, ry * 0.66);
      g.fill(q);
      g.fillStyle = core;
      const r = new Path2D();
      diamond(r, x, cy, rx * 0.3, ry * 0.3);
      g.fill(r);
    }
  };
  checks(0, 9);
  fillBand(18, 112, RED);
  teeth(18, 12, 16, DARK, false);
  teeth(118, 12, 16, DARK, true);
  eyes(74, 22, 34, 64, CREAM, DARK, ORANGE);
  checks(130, 9);
  fillBand(148, 102, DARK);
  g.strokeStyle = CREAM;
  g.lineWidth = 6;
  g.beginPath();
  for (let x = 0; x <= S; x += 32) g.lineTo(x, x % 64 ? 174 : 224);
  g.stroke();
  g.fillStyle = ORANGE;
  for (let x = 0; x < S; x += 64) {
    g.fillRect(x + 28, 160, 8, 8);
    g.fillRect(x - 4, 230, 8, 8);
  }
  checks(250, 9);
  fillBand(268, 132, RED);
  eyes(334, 40, 54, 128, CREAM, DARK, RED);
  eyes(334, 12, 18, 128, DARK, "#000", CREAM);
  g.save();
  g.translate(64, 0);
  eyes(334, 16, 24, 128, DARK, ORANGE, DARK);
  g.restore();
  checks(400, 9);
  fillBand(418, 94, BROWN);
  teeth(426, 34, 32, RED, true);
  teeth(462, 34, 32, CREAM, false);
  fillBand(500, 12, DARK);
  // the weave: every row a rib of wool, and the dye never quite even
  const rand = mulberry32(313);
  for (let y = 0; y < S; y += 3) {
    g.fillStyle = `rgba(0,0,0,${0.08 + rand() * 0.08})`;
    g.fillRect(0, y, S, 1);
  }
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = rand() > 0.5 ? "rgba(255,240,210,0.05)" : "rgba(0,0,0,0.1)";
    g.fillRect(rand() * S, rand() * S, 2 + rand() * 5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const SADU = buildSadu();
const CARPET_TEX = (() => {
  const t = SADU.clone();
  t.repeat.set(7, 5);
  return t;
})();
const CUSHION_TEX = (() => {
  const t = SADU.clone();
  t.repeat.set(4, 1);
  return t;
})();

/** A metal with nothing around it renders black; this is the room for it to reflect. */
function buildEnv(): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#1f150e");
  sky.addColorStop(0.5, "#0d0907");
  sky.addColorStop(0.62, "#2a120d");
  sky.addColorStop(1, "#3b1712"); // the carpet's red, bounced up into the brass
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  radialBlob(g, 72, 34, 40, "#ffd9a2"); // the lamp the room is lit by
  radialBlob(g, 196, 48, 26, "#3a4760"); // a doorway, cool
  radialBlob(g, 128, 76, 22, "#ff8a3c"); // the coal itself
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ENV_TEX = buildEnv();

function buildWall(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0b0807";
  g.fillRect(0, 0, 128, 128);
  // the lamp's pool on the plaster, off to the left where the key comes from
  const gr = g.createRadialGradient(46, 70, 2, 46, 70, 80);
  gr.addColorStop(0, "#2e1d12");
  gr.addColorStop(0.5, "#170f0b");
  gr.addColorStop(1, "#0b0807");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const WALL_TEX = buildWall();

/** The brass tray: lathe rings, and a band of engraved leaves round the burner. */
function buildTray(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const cx = S / 2;
  const gr = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
  gr.addColorStop(0, "#d2a553");
  gr.addColorStop(0.7, "#b98c3e");
  gr.addColorStop(1, "#94702e");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(909);
  const ring = (r: number) => {
    g.beginPath();
    g.arc(cx, cx, r, 0, TAU);
    g.stroke();
  };
  for (let r = 4; r < cx; r += 2.5) {
    g.strokeStyle = rand() > 0.5 ? `rgba(255,236,180,${0.03 + rand() * 0.06})` : `rgba(70,46,14,${0.03 + rand() * 0.07})`;
    g.lineWidth = 1;
    ring(r);
  }
  g.strokeStyle = "rgba(64,40,12,0.8)";
  g.lineWidth = 3;
  for (const f of [0.965, 0.925, 0.64, 0.6]) ring(cx * f);
  g.lineWidth = 2.2;
  const n = 30;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    g.save();
    g.translate(cx + Math.cos(a) * cx * 0.78, cx + Math.sin(a) * cx * 0.78);
    g.rotate(a);
    g.beginPath();
    g.ellipse(0, 0, cx * 0.12, cx * 0.035, 0, 0, TAU);
    g.stroke();
    g.beginPath();
    g.moveTo(-cx * 0.1, 0);
    g.lineTo(cx * 0.1, 0);
    g.stroke();
    g.restore();
    g.fillStyle = "rgba(64,40,12,0.8)";
    g.beginPath();
    g.arc(cx + Math.cos(a + Math.PI / n) * cx * 0.945, cx + Math.sin(a + Math.PI / n) * cx * 0.945, 3.2, 0, TAU);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const TRAY_TEX = buildTray();
const TRAY_TOP_GEO = new THREE.CircleGeometry(0.935, 72);
const TRAY_RIM_GEO = new THREE.LatheGeometry(
  [
    new THREE.Vector2(0.97, 0.0),
    new THREE.Vector2(0.985, 0.034),
    new THREE.Vector2(1.003, 0.056),
    new THREE.Vector2(0.99, 0.064),
    new THREE.Vector2(0.964, 0.05),
    new THREE.Vector2(0.945, 0.03),
    new THREE.Vector2(0.935, TRAY_TOP),
  ],
  72,
);
const TRAY_MAT = new THREE.MeshStandardMaterial({
  map: TRAY_TEX,
  bumpMap: TRAY_TEX,
  bumpScale: 1.2,
  metalness: 1,
  roughness: 0.34,
  envMap: ENV_TEX,
  envMapIntensity: 1.0,
});
const TRAY_RIM_MAT = new THREE.MeshStandardMaterial({
  color: "#c1914a",
  metalness: 1,
  roughness: 0.3,
  envMap: ENV_TEX,
  envMapIntensity: 1.1,
  side: THREE.DoubleSide,
});
const INNER_MAT = new THREE.MeshStandardMaterial({ color: "#120c0a", roughness: 1 });

// The masnad along the wall: a box pushed into a bolster.
const CUSHION_GEO = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1, 24, 6, 10);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const puff = Math.pow(Math.max(0, Math.cos(v.z * 2 * 1.5708) * Math.cos(v.y * 2 * 1.5708)), 0.45);
    p.setXYZ(i, v.x, v.y * (0.35 + 0.65 * puff), v.z * (0.35 + 0.65 * puff));
  }
  g.computeVertexNormals();
  return g;
})();

/* ---------- the coal, its ash, and the oud ---------- */
function buildCoalTextures() {
  const S = 128;
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = c.height = S;
    return c;
  };
  const rand = mulberry32(4411);
  const mc = mk();
  const m = mc.getContext("2d")!;
  m.fillStyle = "#1a1412";
  m.fillRect(0, 0, S, S);
  for (let i = 0; i < 500; i++) {
    m.fillStyle = rand() > 0.6 ? `rgba(120,110,104,${rand() * 0.35})` : `rgba(0,0,0,${rand() * 0.5})`;
    m.fillRect(rand() * S, rand() * S, 1 + rand() * 3, 1 + rand() * 3);
  }
  // the cracks are where it is still burning
  const ec = mk();
  const e = ec.getContext("2d")!;
  e.fillStyle = "#000";
  e.fillRect(0, 0, S, S);
  for (let i = 0; i < 13; i++) {
    let x = rand() * S;
    let y = rand() * S;
    let a = rand() * TAU;
    e.strokeStyle = "#ff5a12";
    e.shadowColor = "#ff3000";
    e.shadowBlur = 3;
    e.lineWidth = 1.2 + rand() * 1.2;
    e.beginPath();
    e.moveTo(x, y);
    for (let k = 0; k < 7; k++) {
      a += (rand() - 0.5) * 1.4;
      x += Math.cos(a) * 7;
      y += Math.sin(a) * 7;
      e.lineTo(x, y);
    }
    e.stroke();
  }
  e.shadowBlur = 0;
  for (let i = 0; i < 50; i++) {
    e.fillStyle = rand() > 0.5 ? "rgba(255,210,140,0.9)" : "rgba(255,110,30,0.7)";
    e.fillRect(rand() * S, rand() * S, 1.5, 1.5);
  }
  const map = new THREE.CanvasTexture(mc);
  map.colorSpace = THREE.SRGBColorSpace;
  const emit = new THREE.CanvasTexture(ec);
  emit.colorSpace = THREE.SRGBColorSpace;
  return { map, emit };
}
const COAL_TEX = buildCoalTextures();

function buildAsh(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4f4843";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(1212);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rand() > 0.5 ? `rgba(210,200,190,${rand() * 0.4})` : `rgba(30,26,24,${rand() * 0.5})`;
    g.fillRect(rand() * S, rand() * S, 1 + rand() * 2, 1 + rand() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ASH_TEX = buildAsh();

function buildChipTex(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4a2d17";
  g.fillRect(0, 0, 128, 32);
  const rand = mulberry32(8080);
  // oud is resin-shot heartwood: streaks nearly black, a few that still catch light
  for (let i = 0; i < 70; i++) {
    g.fillStyle = rand() > 0.35 ? `rgba(8,4,2,${0.3 + rand() * 0.5})` : `rgba(122,80,44,${0.2 + rand() * 0.3})`;
    g.fillRect(rand() * 128, rand() * 32, 12 + rand() * 50, 0.8 + rand() * 1.6);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const CHIP_TEX = buildChipTex();

const COAL_GEO = (() => {
  const g = new THREE.IcosahedronGeometry(0.1, 3);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = 1 + Math.sin(v.x * 44 + 1.3) * Math.sin(v.z * 38) * 0.08 + Math.sin(v.y * 60 + v.x * 20) * 0.04;
    p.setXYZ(i, v.x * d * 1.08, v.y * d * 0.62, v.z * d);
  }
  g.computeVertexNormals();
  return g;
})();
const ASH_GEO = (() => {
  const g = new THREE.SphereGeometry(0.3, 28, 10, 0, TAU, 0, Math.PI / 2);
  g.scale(0.95, 0.14, 0.95);
  return g;
})();

// A splinter, not a block: tapered at both ends, lumpy along the grain.
const CHIP_GEO = (() => {
  const g = new THREE.BoxGeometry(0.19, 0.032, 0.07, 10, 2, 3);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const u = Math.abs(v.x) / 0.095;
    const taper = 1 - 0.55 * Math.pow(u, 1.6);
    v.z = v.z * taper + Math.sin(v.x * 40) * 0.004;
    v.y = v.y * (0.6 + 0.4 * taper) + Math.sin(v.x * 70 + v.z * 30) * 0.002;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
})();

/* ---------- the hint: a dotted arc from the chip to the coal ---------- */
const DOT_N = 16;
const DOT_CTRL = new THREE.Vector3((REST.x + HOVER.x) / 2, B0 + 1.34, (REST.z + HOVER.z) / 2 + 0.12);
const DOT_POS = (() => {
  const out = new Float32Array(DOT_N * 3);
  for (let i = 0; i < DOT_N; i++) {
    const u = 0.08 + (i / (DOT_N - 1)) * 0.86;
    const a = (1 - u) * (1 - u);
    const b = 2 * u * (1 - u);
    const c = u * u;
    out[i * 3] = a * REST.x + b * DOT_CTRL.x + c * HOVER.x;
    out[i * 3 + 1] = a * (REST.y + 0.05) + b * DOT_CTRL.y + c * HOVER.y;
    out[i * 3 + 2] = a * REST.z + b * DOT_CTRL.z + c * HOVER.z;
  }
  return out;
})();

/* ---------- sparks off the coal when the oud lands ---------- */
const SPARK_N = 24;
const SPARKS = (() => {
  const rand = mulberry32(606);
  return Array.from({ length: SPARK_N }, () => {
    const a = rand() * TAU;
    const s = 0.12 + rand() * 0.3;
    return { vx: Math.cos(a) * s, vz: Math.sin(a) * s * 0.7, vy: 0.5 + rand() * 0.7, delay: rand() * 0.18, life: 0.45 + rand() * 0.45 };
  });
})();

/* ---------- the smoke ---------- */
// One thread of incense, closed-form in the shader so every frame is a pure function
// of two clocks — and a replay is identical to the first run for free. Laminar off
// the coal, then a wave travelling up it (the S every incense thread makes), then
// curl turbulence that only switches on with height.
const SMOKE_COMMON = `
uniform float uTime;
uniform vec3 uSrc;
vec3 curl(vec3 p) {
  vec3 s = sin(p), c = cos(p);
  return vec3(-s.x * s.y - c.z * c.x, -s.y * s.z - c.x * c.y, -s.z * s.x - c.y * c.z);
}
vec3 column(float age, vec4 r, float lift, float churn) {
  float h = lift * (1.0 - exp(-age / 1.2));
  float th = r.y * 6.2832 + age * (2.1 + r.z * 1.5);
  float rad = 0.006 + h * (0.034 + r.w * 0.06) * churn;
  vec3 p = uSrc + vec3(cos(th) * rad, h, sin(th) * rad);
  float lam = smoothstep(0.05, 0.5, h);
  p.x += sin(h * 3.4 - uTime * 1.05) * 0.07 * lam;
  p.z += sin(h * 2.2 - uTime * 0.7 + 1.3) * 0.04 * lam;
  vec3 q = p * 1.8 + vec3(r.x * 4.0, -uTime * 0.24, r.y * 1.7);
  p += curl(q) * (0.03 + 0.06 * h) * lam * churn;
  p += curl(q * 2.4 + 2.1) * 0.02 * lam * churn;
  return p;
}
`;

const PLUME_VERT = `
attribute vec4 aRnd;   // life phase, swirl phase, rate, spread
attribute vec2 aAux;   // x: count threshold, y: puff size (world)
uniform float uLift;
uniform float uChurn;
uniform float uAlpha;
uniform float uCount;  // a thin thread is fewer puffs, not the same puffs made faint
uniform float uScale;
varying float vA;
varying float vH;
${SMOKE_COMMON}
void main() {
  if (aAux.x > uCount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0;
    vH = 0.0;
    return;
  }
  float life = 4.0;
  float age = mod(uTime * (0.6 + aRnd.z * 0.35) + aRnd.x * life, life);
  vec3 p = column(age, aRnd, uLift, uChurn);
  float h = p.y - uSrc.y;
  vH = h;
  vA = smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(life * 0.45, life, age))
     * (1.0 - smoothstep(uLift * 0.7, uLift * 1.02, h)) * uAlpha;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aAux.y * (0.3 + h * 1.25) * uScale / max(-mv.z, 0.1), 110.0);
}
`;

const WORDS_VERT = `
attribute vec4 aRnd;
attribute vec4 aTim;   // birth (τ), release age, spring time, puff size
uniform float uTau;
uniform float uLift;
uniform float uScale;
uniform float uAlpha;
varying float vA;
varying float vH;
${SMOKE_COMMON}
// Under-damped: a puff arrives, overshoots its place in the letter a little, settles.
float spring(float x) {
  return x <= 0.0 ? 0.0 : 1.0 - exp(-5.2 * x) * (cos(7.5 * x) + 0.693 * sin(7.5 * x));
}
void main() {
  float age = uTau - aTim.x;
  if (age < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0;
    vH = 0.0;
    return;
  }
  vec3 pc = column(age, aRnd, uLift, 1.35);
  float s = (age - aTim.y) / aTim.z;
  float f = spring(s);
  float g = clamp(s, 0.0, 1.0);
  float settled = smoothstep(0.7, 1.0, g);
  // every puff wanders a little round its place — the words breathe
  vec3 tgt = position + curl(position * 3.3 + vec3(uTime * 0.23, uTime * 0.19, aRnd.z * 6.0)) * 0.011;
  // …and some peel off upward, thin out and are replaced: the edges keep smoking
  float peel = step(0.7, aRnd.w) * settled;
  float cyc = fract(uTime * (0.12 + aRnd.z * 0.1) + aRnd.x);
  float up = peel * smoothstep(0.45, 1.0, cyc);
  tgt += vec3(sin(cyc * 6.0 + aRnd.y * 6.28) * 0.04 * up, up * up * 0.3, 0.0);
  // in transit it curls rather than flying straight
  vec3 sw = curl(pc * 1.3 + aRnd.xyz * 5.0) * 0.16 * sin(3.14159 * clamp(f, 0.0, 1.0));
  vec3 p = mix(pc, tgt, f) + sw;
  float hc = pc.y - uSrc.y;
  vH = mix(hc, 2.0, g);
  float ride = smoothstep(0.0, 0.25, age) * 0.2;
  float formed = 0.26 * (1.0 - up) * mix(1.0, smoothstep(0.0, 0.12, cyc), peel);
  vA = mix(ride, formed, g) * uAlpha;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // in flight a puff swells and thins, the way smoke does when it is pulled — so the
  // gathering reads as wisps being drawn in, not as glitter
  float fly = sin(3.14159 * g);
  vA *= 1.0 - 0.55 * fly;
  float size = mix(aTim.w * (1.0 + hc * 0.7), aTim.w * 0.95, g) * (1.0 + up * 1.6) * (1.0 + 1.8 * fly);
  gl_PointSize = min(size * uScale / max(-mv.z, 0.1), 96.0);
}
`;

const PUFF_FRAG = `
uniform sampler2D uTex;
uniform vec3 uSmoke;
uniform vec3 uWarm;
uniform float uEmber;
varying float vA;
varying float vH;
void main() {
  float m = texture2D(uTex, gl_PointCoord).a;
  // lit from below by the coal: warm near it, its own colour higher up
  vec3 col = mix(uSmoke, uWarm, uEmber * exp(-max(vH, 0.0) * 2.4) * 0.8);
  gl_FragColor = vec4(col, m * vA);
  // three only injects this for built-in materials; without it the smoke is linear
  // values in an sRGB buffer and comes out a dirty grey
  #include <colorspace_fragment>
}
`;

/* ---------- the words, in smoke ---------- */
// Points alone cannot carry a 280-character message legibly — the magic-lamp genie
// shows where that ends. So the puffs gather onto the glyphs, and underneath them the
// same glyphs condense out of haze as a texture: crisp, softened and hazed in three
// channels, wavering and mottled by noise in the shader, sampled again from below for
// the smoke that rises off each letter. The puffs make it smoke; the texture makes it
// words.
const TEXT_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const TEXT_FRAG = `
uniform sampler2D uMap;   // r: crisp, g: softened, b: haze
uniform float uTime;
uniform float uFront;     // reading-order condensation front
uniform float uRtl;
uniform vec4 uBox;        // x: margin u, y: margin v, z: height/width, w: a line, in v
uniform vec3 uSmoke;
uniform vec3 uWarm;
uniform float uEmber;
varying vec2 vUv;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.01 + 3.3);
}
float fbm2(vec2 p) {
  return 0.62 * vnoise(p) + 0.38 * vnoise(p * 2.03 + 7.1);
}
void main() {
  vec2 uv = vUv;
  // Most of the plane is air between lines and round the block: two cheap haze reads
  // (here, and half a line below where the tendrils come from) let those fragments
  // leave before any noise is paid for. It is a big plane on a phone.
  float near = texture2D(uMap, uv).b + texture2D(uMap, uv - vec2(0.0, uBox.w * 0.5)).b;
  if (near < 0.004) discard;
  vec2 q = vec2(uv.x, uv.y * uBox.z) * 7.0;
  float n1 = fbm(q + vec2(0.0, -uTime * 0.22));
  float n2 = fbm2(q * 2.2 + vec2(4.1, -uTime * 0.5));
  // the waver: slow and small — it breathes, it never smears past reading
  vec2 w = vec2(n1 - 0.5, (n2 - 0.5) * 0.6) * 0.0045;
  vec3 s = texture2D(uMap, uv + w).rgb;
  float n3 = vnoise(q * 5.0 + vec2(1.7, -uTime * 0.7));
  // Smoky edges: the softened glyph cut at a threshold that wanders, so the outline
  // frays and breathes; the crisp glyph under it is the floor that keeps it readable.
  float th = 0.5 + (n3 - 0.5) * 0.55;
  float edge = smoothstep(th - 0.16, th + 0.16, s.g);
  float core = max(s.r * 0.62, edge * 0.92);
  // What rises off the letters is the haze of the letters, from under half a line
  // below, cut into streaks that drift up — tendrils leaving the strokes, and blurred
  // too far to ever read as a second copy of the words.
  float climb = uBox.w * (0.3 + 0.35 * n1);
  vec2 ru = uv + vec2((n2 - 0.5) * 0.02 + sin(uv.y * 40.0 + uTime * 0.8) * 0.004, -climb);
  vec2 sq = vec2(
    uv.x * 13.0 + (n1 - 0.5) * 2.4 + sin(uv.y * uBox.z * 16.0 - uTime * 0.55) * 0.4,
    uv.y * uBox.z * 3.0 - uTime * 0.3
  );
  float streak = smoothstep(0.46, 0.8, fbm2(sq));
  float rise = texture2D(uMap, ru).b * streak;

  // condensation front, in reading order: down the lines, along each one
  float yTop = clamp((1.0 - uv.y - uBox.y) / (1.0 - 2.0 * uBox.y), 0.0, 1.0);
  float xr = clamp((mix(uv.x, 1.0 - uv.x, uRtl) - uBox.x) / (1.0 - 2.0 * uBox.x), 0.0, 1.0);
  float rp = yTop * 0.8 + xr * 0.2 + (n1 - 0.5) * 0.12;
  float k = clamp((uFront - rp) / 0.5, 0.0, 1.0);
  float kh = smoothstep(0.0, 0.45, k);
  float ks = smoothstep(0.2, 0.75, k);
  float kc = smoothstep(0.45, 1.0, k);

  // the core is kept just strong enough to read; the rest is the soft body and haze
  float a = s.b * 0.24 * kh + s.g * 0.2 * ks + core * 0.74 * kc;
  a *= (0.62 + 0.52 * n2) * (0.86 + 0.3 * (n3 - 0.5)); // mottled, and grained, like smoke is
  a += rise * 0.3 * kc;
  a = clamp(a, 0.0, 0.92);
  float under = (1.0 - uv.y) * (1.0 - uv.y) * uEmber * 0.35;
  vec3 col = mix(uSmoke, uWarm, under) * (0.86 + 0.2 * s.r);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

const AR_FONT = "'Thmanyah Sans', system-ui, sans-serif";
const EN_FONT = "Georgia, 'Times New Roman', serif";
const TXT_F = 72;
const TXT_LH = 1.28;
const TXT_WEIGHT = "700";
const HEAD_S = 1.3; // the name is written a size up from the message
const MG = 30; // canvas margin so the haze has somewhere to go
const HEAD_PTS = 420;
const BODY_PTS = 1100;
const SOLO_PTS = 1100;

// text3d's wrap, verbatim (it is not exported): the texture has to break lines exactly
// where sampleTextPoints did, or the smoke gathers onto words the letters are not in.
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidthPx: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidthPx) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

interface Block {
  lines: string[];
  w: number;
  h: number;
  pad: number;
  pts: Float32Array;
  count: number;
}
/** sampleTextPoints, plus the raster box it used — rebuilt the same way it builds it. */
function layBlock(text: string, maxWidthPx: number, maxPoints: number, lang: Lang, seed: number, ctx: CanvasRenderingContext2D): Block {
  const tp = sampleTextPoints(text, {
    maxPoints, fontSize: TXT_F, fontFamily: EN_FONT, fontWeight: TXT_WEIGHT, maxWidthPx, lineHeight: TXT_LH, seed, lang,
  });
  ctx.font = `${TXT_WEIGHT} ${TXT_F}px ${lang === "ar" ? AR_FONT : EN_FONT}`;
  if (lang === "ar") ctx.direction = "rtl";
  const lines = wrapLines(ctx, text, maxWidthPx);
  const pad = Math.ceil(TXT_F * 0.25);
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width), 1)) + pad * 2;
  const h = Math.ceil(lines.length * TXT_F * TXT_LH) + pad * 2;
  return { lines, w, h, pad, pts: tp.points, count: tp.count };
}

/** pass 0 crisp, 1 softened, 2 haze. The blurs are shadows of text drawn off-canvas. */
function drawBlock(g: CanvasRenderingContext2D, b: Block, x0: number, y0: number, s: number, lang: Lang, pass: number) {
  const OFF = 6000;
  g.save();
  g.translate(x0, y0);
  g.scale(s, s);
  g.font = `${TXT_WEIGHT} ${TXT_F}px ${lang === "ar" ? AR_FONT : EN_FONT}`;
  if (lang === "ar") g.direction = "rtl";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#fff";
  if (pass > 0) {
    // shadow offset and blur ignore the transform — the one reliable canvas blur
    g.shadowColor = "#fff";
    g.shadowBlur = pass === 1 ? 5 : 18;
    g.shadowOffsetX = OFF;
  }
  const dx = pass > 0 ? OFF / s : 0;
  b.lines.forEach((line, i) => g.fillText(line, b.w / 2 - dx, b.pad + (i + 0.5) * TXT_F * TXT_LH));
  g.restore();
}

interface SmokeWords {
  geo: THREE.BufferGeometry;
  tex: THREE.CanvasTexture;
  mat: THREE.ShaderMaterial;
  pw: number;
  ph: number;
  pcy: number;
  frame: Frame;
  lift: number;
}

function buildWords(header: string, body: string, lang: Lang, portrait: boolean): SmokeWords {
  const rtl = lang === "ar";
  const scratch = document.createElement("canvas").getContext("2d")!;
  // Chars per line from the length: long messages go wide rather than tall, because
  // the words share the frame with a burner; a phone gets a narrower measure.
  const n = Array.from(body).length;
  const cpl = portrait
    ? Math.min(24, Math.max(11, Math.sqrt(n * 3.6)))
    : Math.min(52, Math.max(16, Math.sqrt(n * 12)));
  const wrap = cpl * TXT_F * (rtl ? 0.5 : 0.57); // average advance, bold Georgia / Thmanyah
  const head = layBlock(header, Math.max(TXT_F * 7, wrap / HEAD_S), body ? HEAD_PTS : SOLO_PTS, lang, 11, scratch);
  const main = body ? layBlock(body, wrap, BODY_PTS, lang, 23, scratch) : null;
  const gap = TXT_F * 0.3;
  const innerW = Math.max(head.w * HEAD_S, main ? main.w : 0);
  const innerH = head.h * HEAD_S + (main ? gap + main.h : 0);
  const Wc = Math.ceil(innerW) + MG * 2;
  const Hc = Math.ceil(innerH) + MG * 2;
  const placed = [{ b: head, s: HEAD_S, x0: (Wc - head.w * HEAD_S) / 2, y0: MG }];
  if (main) placed.push({ b: main, s: 1, x0: (Wc - main.w) / 2, y0: MG + head.h * HEAD_S + gap });

  /* three passes of the same words, packed into one texture's channels */
  const alphas = [0, 1, 2].map((pass) => {
    const cv = document.createElement("canvas");
    cv.width = Wc;
    cv.height = Hc;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    for (const p of placed) drawBlock(g, p.b, p.x0, p.y0, p.s, lang, pass);
    return g.getImageData(0, 0, Wc, Hc).data;
  });
  const out = document.createElement("canvas");
  out.width = Wc;
  out.height = Hc;
  const og = out.getContext("2d")!;
  const img = og.createImageData(Wc, Hc);
  const d = img.data;
  for (let i = 0; i < Wc * Hc; i++) {
    d[i * 4] = alphas[0][i * 4 + 3];
    d[i * 4 + 1] = Math.min(255, alphas[1][i * 4 + 3] * 1.3);
    d[i * 4 + 2] = Math.min(255, alphas[2][i * 4 + 3] * 1.8);
    d[i * 4 + 3] = 255;
  }
  og.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(out);

  /* world size: as big as fits, but a short message is not shouted */
  const lim = portrait ? { w: 2.3, h: 2.0, f: 0.21 } : { w: 4.2, h: 1.5, f: 0.23 };
  const k = Math.min(lim.w / innerW, lim.h / innerH, lim.f / TXT_F);
  const pw = Wc * k;
  const ph = Hc * k;
  const pcy = TEXT_BOTTOM + (innerH * k) / 2;

  /* puffs: one per sampled glyph pixel, timed in reading order */
  const count = head.count + (main ? main.count : 0);
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 4);
  const tim = new Float32Array(count * 4);
  const rand = mulberry32(20260928);
  let j = 0;
  for (const p of placed) {
    for (let i = 0; i < p.b.count; i++, j++) {
      const px = p.x0 + (p.b.pts[i * 2] + 0.5) * p.b.w * p.s;
      const py = p.y0 + (p.b.h / 2 - p.b.pts[i * 2 + 1] * p.b.w) * p.s;
      pos[j * 3] = (px - Wc / 2) * k;
      pos[j * 3 + 1] = pcy + (Hc / 2 - py) * k;
      pos[j * 3 + 2] = (rand() - 0.5) * 0.05;
      // the same reading position the texture's condensation front uses
      const rp = clamp01((py - MG) / innerH) * 0.8 + clamp01(((rtl ? Wc - px : px) - MG) / innerW) * 0.2;
      for (let c = 0; c < 4; c++) rnd[j * 4 + c] = rand();
      tim[j * 4] = 0.15 + rp * 1.35 + rand() * 0.25; // leaves the coal
      tim[j * 4 + 1] = 0.85 + rand() * 0.45; // rides the column this long
      tim[j * 4 + 2] = 1.05 + rand() * 0.5; // then springs to its letter
      tim[j * 4 + 3] = 0.042 + rand() * 0.03;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  geo.setAttribute("aTim", new THREE.BufferAttribute(tim, 4));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uTime: { value: 0 },
      uFront: { value: -1 },
      uRtl: { value: rtl ? 1 : 0 },
      uBox: { value: new THREE.Vector4(MG / Wc, MG / Hc, Hc / Wc, (TXT_F * TXT_LH) / Hc) },
      uSmoke: { value: new THREE.Color() },
      uWarm: { value: new THREE.Color() },
      uEmber: { value: 0 },
    },
    vertexShader: TEXT_VERT,
    fragmentShader: TEXT_FRAG,
    transparent: true,
    depthWrite: false,
  });

  // What the camera must hold once it is written: the words and the burner under
  // them — on a phone the tray may go, the bowl the smoke comes out of may not.
  const yLow = portrait ? 0.5 : 0.05;
  const top = TEXT_BOTTOM + innerH * k + 0.1;
  const frame: Frame = {
    cy: (yLow + top) / 2,
    w: Math.max(innerW * k + 0.45, portrait ? 1.4 : 2.3),
    h: top - yLow + 0.12,
    pitch: 0.16,
  };
  return { geo, tex, mat, pw, ph, pcy, frame, lift: (pcy - SRC.y) * 1.3 };
}

/* ---------- the plume that never stops ---------- */
const PLUME_N = 380;
const PLUME_GEO = (() => {
  const rand = mulberry32(5150);
  const pos = new Float32Array(PLUME_N * 3);
  const rnd = new Float32Array(PLUME_N * 4);
  const aux = new Float32Array(PLUME_N * 2);
  for (let i = 0; i < PLUME_N; i++) {
    for (let c = 0; c < 4; c++) rnd[i * 4 + c] = rand();
    aux[i * 2] = rand();
    aux[i * 2 + 1] = 0.06 + rand() * 0.05;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  g.setAttribute("aAux", new THREE.BufferAttribute(aux, 2));
  return g;
})();

function puffMaterial(vert: string, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSrc: { value: SRC.clone() },
      uScale: { value: 600 },
      uAlpha: { value: 0 },
      uLift: { value: 0.5 },
      uTex: { value: smokeTex },
      uSmoke: { value: new THREE.Color() },
      uWarm: { value: new THREE.Color() },
      uEmber: { value: 0 },
      ...extra,
    },
    vertexShader: vert,
    fragmentShader: PUFF_FRAG,
    transparent: true,
    depthWrite: false,
    // Normal blending, low alpha: smoke occludes a little of what is behind it. Additive
    // would make it a light source, and oud smoke is not neon.
  });
}

/* ---------- the chip's little life ---------- */
const M_REST = 0;
const M_DRAG = 1;
const M_FLY = 2;
const M_FALL = 3;
const M_BACK = 4;
const M_BURN = 5;
function freshChip() {
  return {
    mode: M_REST,
    px: REST.x,
    py: REST.y,
    pz: REST.z,
    rx: 0,
    ry: -0.55,
    rz: 0,
    tx: REST.x,
    ty: REST.y,
    tz: REST.z,
    ox: 0,
    oy: 0,
    oz: 0,
    fx: 0,
    fy: 0,
    fz: 0,
    t0: 0,
    dur: 1,
    near: 9, // how close the finger's ray passes to the coal
    moved: 0,
    alone: 0, // seconds since anyone last reached for it — the mercy's own clock
    hover: false,
    hoverK: 0,
    dropAt: -1,
    chimed: false,
  };
}
type Chip = ReturnType<typeof freshChip>;
function launch(c: Chip, t: number, mode: number, dur: number) {
  c.mode = mode;
  c.t0 = t;
  c.dur = dur;
  c.fx = c.px;
  c.fy = c.py;
  c.fz = c.pz;
}
const DRAG_PLANE = new THREE.Plane();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
/** Quadratic arc from the chip's launch point to `to`, bowed up by `lift`. */
function arc(c: Chip, to: THREE.Vector3, lift: number, u: number, out: THREE.Vector3) {
  const mx = (c.fx + to.x) / 2;
  const my = Math.max(c.fy, to.y) + lift;
  const mz = (c.fz + to.z) / 2;
  const a = (1 - u) * (1 - u);
  const b = 2 * u * (1 - u);
  const d = u * u;
  out.set(a * c.fx + b * mx + d * to.x, a * c.fy + b * my + d * to.y, a * c.fz + b * mz + d * to.z);
}

export default function BakhoorScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const burner = BURNERS[variants.burner] ?? BURNERS.wood;
  const scent = SCENTS[variants.scent] ?? SCENTS.oud;
  const preview = phase === "preview";
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // The measure the words wrap to depends on the canvas's shape — but only on which
  // side of square it is, so a resize never re-rasterizes and a rotation does.
  const portrait = useThree((s) => s.size.width < s.size.height * 0.95);

  /* ---- the burner's skin and metal ---- */
  const mats = useMemo(() => {
    const skin = buildSkin(burner.kind);
    const body = new THREE.MeshStandardMaterial({
      map: skin.map,
      bumpMap: skin.bump,
      bumpScale: burner.bump,
      roughness: burner.rough,
      metalness: burner.metal,
      envMap: ENV_TEX,
      envMapIntensity: burner.env,
    });
    const trim = new THREE.MeshStandardMaterial({
      color: burner.trim,
      roughness: burner.trimRough,
      metalness: 1,
      envMap: ENV_TEX,
      envMapIntensity: 1.15,
    });
    return { skin, body, trim };
  }, [burner]);
  useEffect(
    () => () => {
      mats.skin.map.dispose();
      mats.skin.bump?.dispose();
      mats.body.dispose();
      mats.trim.dispose();
    },
    [mats],
  );

  /* ---- the coal and the chip glow, so they are this scene's own ---- */
  const hot = useMemo(
    () => ({
      coal: new THREE.MeshStandardMaterial({
        map: COAL_TEX.map,
        emissiveMap: COAL_TEX.emit,
        emissive: new THREE.Color("#ff6a1c"),
        emissiveIntensity: 1,
        roughness: 0.95,
      }),
      chip: new THREE.MeshStandardMaterial({
        map: CHIP_TEX,
        roughness: 0.46,
        metalness: 0.05,
        emissiveMap: COAL_TEX.emit,
        emissive: new THREE.Color("#ff6a1c"),
        emissiveIntensity: 0,
      }),
      ash: new THREE.MeshStandardMaterial({ map: ASH_TEX, roughness: 1, emissive: new THREE.Color("#ff5a1a"), emissiveIntensity: 0 }),
      keyTarget: new THREE.Object3D(),
    }),
    [],
  );
  useEffect(
    () => () => {
      hot.coal.dispose();
      hot.chip.dispose();
      hot.ash.dispose();
    },
    [hot],
  );

  /* ---- smoke: the plume always, the words only once there is someone to read them ---- */
  const plumeMat = useMemo(
    () => puffMaterial(PLUME_VERT, { uChurn: { value: 0.6 }, uCount: { value: 0.5 } }),
    [],
  );
  const wordsMat = useMemo(() => puffMaterial(WORDS_VERT, { uTau: { value: -1 } }), []);
  useEffect(
    () => () => {
      plumeMat.dispose();
      wordsMat.dispose();
    },
    [plumeMat, wordsMat],
  );

  // Preview is every gallery card and every keystroke on /create: no words, no raster.
  const header = forRecipient(lang, recipientName);
  const body = message.trim();
  const words = useMemo(
    () => (preview ? null : buildWords(header, body, lang, portrait)),
    [preview, header, body, lang, portrait],
  );
  useEffect(
    () => () => {
      if (!words) return;
      words.geo.dispose();
      words.tex.dispose();
      words.mat.dispose();
    },
    [words],
  );

  // Buffers feed <bufferAttribute> and are only written through the points refs.
  const bufs = useMemo(
    () => ({
      dotCol: new Float32Array(DOT_N * 3),
      sparkPos: new Float32Array(SPARK_N * 3),
      sparkCol: new Float32Array(SPARK_N * 3),
    }),
    [],
  );

  const stRef = useRef(freshChip());
  // Replay re-enters "opening": the chip goes back on the tray, the coal back to
  // waiting — or the second run would start with the oud already burning.
  useLayoutEffect(() => {
    if (phase === "opening") stRef.current = freshChip();
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fogRef = useRef<THREE.Fog>(null);
  const coalLightRef = useRef<THREE.PointLight>(null);
  const coalMeshRef = useRef<THREE.Mesh>(null);
  const ashMeshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Sprite>(null);
  const glowMatRef = useRef<THREE.SpriteMaterial>(null);
  const chipRef = useRef<THREE.Group>(null);
  const chipMeshRef = useRef<THREE.Mesh>(null);
  const chipShadowRef = useRef<THREE.Mesh>(null);
  const chipShadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const chipHaloRef = useRef<THREE.Sprite>(null);
  const chipHaloMatRef = useRef<THREE.SpriteMaterial>(null);
  const chipHitRef = useRef<THREE.Mesh>(null);
  const dotsRef = useRef<THREE.Points>(null);
  const sparksRef = useRef<THREE.Points>(null);
  const plumeRef = useRef<THREE.Points>(null);
  const wordsPtsRef = useRef<THREE.Points>(null);
  const wordsPlaneRef = useRef<THREE.Mesh>(null);

  /* ---------- the gesture: pick up the oud, put it on the coal ---------- */
  const onChipDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const c = stRef.current;
    if (phase !== "opening" || c.dropAt >= 0 || c.mode === M_FALL || c.mode === M_BURN) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — pointer-up still ends the drag */
    }
    // A real hand always wins, even over the invisible one mid-flight.
    c.mode = M_DRAG;
    c.alone = 0;
    c.moved = 0;
    c.near = 9;
    // Drag on an upright plane through the chip, turned to the camera: it stays under
    // the finger at its own depth. Not square to the view — the camera looks down, so
    // a tilted plane would carry the chip backwards into the bowl as it rose, behind
    // the bowl's own wall. Upright, it climbs the burner's front until the coal pulls
    // it over. ev.point is on the hit sphere, so keep the offset to the chip.
    tmpA.set(c.px, c.py, c.pz);
    tmpB.copy(ev.camera.position).sub(tmpA);
    tmpB.y = 0;
    tmpB.normalize();
    DRAG_PLANE.setFromNormalAndCoplanarPoint(tmpB, tmpA);
    if (ev.ray.intersectPlane(DRAG_PLANE, tmpB)) {
      c.ox = c.px - tmpB.x;
      c.oy = c.py - tmpB.y;
      c.oz = c.pz - tmpB.z;
    } else {
      c.ox = c.oy = c.oz = 0;
    }
    c.tx = c.px;
    c.ty = c.py;
    c.tz = c.pz;
    clack({ freq: 2600, decay: 0.03, gain: 0.07 });
  };
  const onChipMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = stRef.current;
    if (c.mode !== M_DRAG) return;
    ev.stopPropagation();
    c.alone = 0;
    // A captured pointer's ev.point freezes on the sphere; the ray is always live.
    if (!ev.ray.intersectPlane(DRAG_PLANE, tmpB)) return;
    const nx = tmpB.x + c.ox;
    const ny = Math.max(REST.y, tmpB.y + c.oy);
    const nz = tmpB.z + c.oz;
    c.moved += Math.hypot(nx - c.tx, ny - c.ty, nz - c.tz);
    c.tx = nx;
    c.ty = ny;
    c.tz = nz;
    // "over the coal" is where the finger points, not where the chip's plane is
    c.near = Math.min(ev.ray.distanceToPoint(HOVER), tmpA.set(nx, ny, nz).distanceTo(HOVER));
  };
  const release = (tap: boolean) => {
    const c = stRef.current;
    if (c.mode !== M_DRAG) return;
    const t = tRef.current;
    c.alone = 0;
    if (tap) launch(c, t, M_FLY, TAP_DUR); // a tap sends it there
    else if (c.near < 0.45) launch(c, t, M_FALL, FALL_DUR); // generous: anywhere over the bowl
    else launch(c, t, M_BACK, BACK_DUR);
  };
  const onChipUp = (ev: ThreeEvent<PointerEvent>) => {
    const c = stRef.current;
    if (c.mode !== M_DRAG) return;
    ev.stopPropagation();
    // a press that never became a drag is a tap, however long the finger rested
    release(c.moved < 0.06);
  };
  const onChipCancel = () => release(false);
  const onChipOver = () => {
    stRef.current.hover = true;
  };
  const onChipOut = () => {
    stRef.current.hover = false;
  };
  // Tapping the burner itself is the same wish: the chip goes to the coal.
  const onBowlDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const c = stRef.current;
    if (phase !== "opening" || c.dropAt >= 0 || (c.mode !== M_REST && c.mode !== M_BACK)) return;
    resumeAudio();
    c.alone = 0;
    launch(c, tRef.current, M_FLY, TAP_DUR + 0.1);
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const c = stRef.current;
    const opening = phase === "opening";
    const revealed = phase === "revealed";

    /* ---- the chip ---- */
    let hint = 0;
    let hop = 0;
    if (opening) {
      if (c.mode === M_REST && c.dropAt < 0) {
        // Nobody came. The mercy is patient — long enough that a hand about to
        // arrive is never overridden — and then the oud goes in anyway.
        c.alone += dt;
        if (c.alone >= MERCY_AT) launch(c, t, M_FLY, MERCY_DUR);
      }
      if (c.mode === M_REST || c.mode === M_BACK) {
        hint = smooth(clamp01((t - 0.5) / 0.7)) * (1 - smooth(clamp01((c.alone - (MERCY_AT - 0.9)) / 0.8)));
        const hp = ((t % HOP_EVERY) - 0.3) / 0.5;
        hop = c.mode === M_REST && hp > 0 && hp < 1 ? Math.sin(hp * Math.PI) * hint : 0;
      }
      switch (c.mode) {
        case M_REST:
          c.px = REST.x - hop * 0.03;
          c.py = REST.y + hop * 0.07;
          c.pz = REST.z - hop * 0.02;
          break;
        case M_DRAG: {
          // it leans toward the coal the moment it is over it — the drop zone pulls
          const m = c.near < 0.32 ? 0.65 * smooth(1 - c.near / 0.32) : 0;
          const k = Math.min(1, dt * 20);
          c.px += (lerp(c.tx, HOVER.x, m) - c.px) * k;
          c.py += (lerp(c.ty, HOVER.y, m) - c.py) * k;
          c.pz += (lerp(c.tz, HOVER.z, m) - c.pz) * k;
          break;
        }
        case M_FLY: {
          const u = clamp01((t - c.t0) / c.dur);
          arc(c, HOVER, 0.16, easeInOut(u), tmpA);
          c.px = tmpA.x;
          c.py = tmpA.y;
          c.pz = tmpA.z;
          if (u >= 1) launch(c, t, M_FALL, FALL_DUR);
          break;
        }
        case M_FALL: {
          const u = clamp01((t - c.t0) / c.dur);
          c.px = lerp(c.fx, ON_COAL.x, u);
          c.py = lerp(c.fy, ON_COAL.y, u * u);
          c.pz = lerp(c.fz, ON_COAL.z, u);
          if (u >= 1) {
            c.mode = M_BURN;
            c.dropAt = t;
            // the tap of wood on coal, the hiss of resin meeting heat, the breath of the flare
            clack({ freq: 820, decay: 0.05, gain: 0.16 });
            swell({ source: "noise", filter: "highpass", cutoff: 3200, q: 0.6, attack: 0.015, hold: 0.22, release: 1.2, gain: 0.09 });
            swell({ source: "sine", freq: 62, filter: "lowpass", cutoff: 220, attack: 0.05, hold: 0.08, release: 0.9, gain: 0.14 });
          }
          break;
        }
        case M_BACK: {
          const u = clamp01((t - c.t0) / c.dur);
          arc(c, REST, 0.08, easeInOut(u), tmpA);
          c.px = tmpA.x;
          c.py = tmpA.y;
          c.pz = tmpA.z;
          if (u >= 1) c.mode = M_REST;
          break;
        }
        default:
          c.px = ON_COAL.x;
          c.py = ON_COAL.y;
          c.pz = ON_COAL.z;
      }
    }
    // The revealed pose is a function of the phase alone: reduced motion lands here
    // cold from sealed, and nothing may depend on a run that never happened.
    const burning = revealed || (opening && c.mode === M_BURN);
    const onTray = !opening && !revealed;
    const tau = revealed ? TAU_HOLD : opening && c.dropAt >= 0 ? Math.min(t - c.dropAt, TAU_HOLD) : -1;
    const lit = tau >= 0;

    c.hoverK = lerp(c.hoverK, opening && c.hover && !burning ? 1 : 0, Math.min(1, dt * 8));
    const chip = chipRef.current;
    if (chip) {
      if (burning) {
        chip.position.copy(ON_COAL);
        chip.rotation.set(0.24, 0.5, 0.16);
        const sink = lit ? smooth(clamp01(tau / TAU_HOLD)) : 1;
        chip.scale.setScalar(1 - 0.14 * sink); // resin burns off; the chip shrinks a little
      } else if (onTray) {
        chip.position.copy(REST);
        chip.rotation.set(0, -0.55, 0);
        chip.scale.setScalar(1);
      } else {
        const airborne = c.mode !== M_REST;
        const vx = (c.px - chip.position.x) / Math.max(dt, 1e-3);
        const k = Math.min(1, dt * 10);
        c.rz = lerp(c.rz, airborne ? Math.max(-0.6, Math.min(0.6, -vx * 0.18)) : hop * 0.35, k);
        c.ry = lerp(c.ry, airborne ? -0.55 + (c.py - REST.y) * 1.2 : -0.55, k);
        c.rx = lerp(c.rx, airborne ? 0.18 : 0, k);
        chip.position.set(c.px, c.py, c.pz);
        chip.rotation.set(c.rx, c.ry, c.rz);
        chip.scale.setScalar(1 + c.hoverK * 0.08 + (c.mode === M_DRAG ? 0.12 : 0));
      }
    }
    if (chipHitRef.current) chipHitRef.current.position.set(c.px, c.py + 0.02, c.pz);
    if (chipShadowRef.current && chipShadowMatRef.current) {
      const cx = burning ? REST.x : chip ? chip.position.x : REST.x;
      const cz = burning ? REST.z : chip ? chip.position.z : REST.z;
      const lift = burning ? 1 : chip ? clamp01((chip.position.y - REST.y) / 0.35) : 0;
      chipShadowRef.current.position.set(cx, TRAY_TOP + 0.002, cz);
      chipShadowMatRef.current.opacity = 0.55 * (1 - lift);
    }

    /* ---- ember: the coal breathes in every phase, flares once ---- */
    const pulse = 1 + 0.16 * Math.sin(e * 1.7) + 0.07 * Math.sin(e * 4.3 + 1.1);
    let ember: number;
    if (lit) {
      const flare = 2.6 * Math.exp(-tau * 1.5) * smooth(clamp01(tau / 0.08));
      ember = lerp(0.6, 1.25, smooth(clamp01(tau / 1.5))) * pulse + flare;
    } else if (preview) ember = 0.85 * pulse;
    else ember = 0.55 * pulse + hint * 0.35 * (0.5 + 0.5 * Math.sin(t * 4.2));
    if (coalMeshRef.current) {
      const m = coalMeshRef.current.material as THREE.MeshStandardMaterial;
      m.emissive.copy(scent.ember);
      m.emissiveIntensity = 0.35 + ember * 0.9;
    }
    if (ashMeshRef.current) {
      const m = ashMeshRef.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = ember * 0.05;
    }
    if (coalLightRef.current) {
      coalLightRef.current.color.copy(scent.ember);
      coalLightRef.current.intensity = ember * 1.5;
    }
    if (glowRef.current && glowMatRef.current) {
      glowRef.current.scale.setScalar(0.34 + ember * 0.16);
      glowMatRef.current.color.copy(scent.ember);
      glowMatRef.current.opacity = Math.min(0.95, 0.22 + ember * 0.22);
    }
    if (chipMeshRef.current) {
      const m = chipMeshRef.current.material as THREE.MeshStandardMaterial;
      // it smoulders on the coal: the cracks catch, flare with the coal, settle to a glow
      m.emissive.copy(scent.ember);
      m.emissiveIntensity = burning ? (lit ? smooth(clamp01(tau / 0.4)) : 1) * (0.04 + ember * 0.1) : 0;
      // and chars: the resin cooks off and the wood goes nearly black
      const char = burning ? (lit ? smooth(clamp01(tau / 2.5)) : 1) : 0;
      m.color.setScalar(1 - 0.72 * char);
    }

    /* ---- the hint: the chip glows, and a dotted arc shows where it goes ---- */
    if (chipHaloRef.current && chipHaloMatRef.current) {
      chipHaloRef.current.position.set(c.px, c.py + 0.03, c.pz);
      chipHaloMatRef.current.opacity = opening && !burning ? hint * (0.5 + 0.25 * Math.sin(t * 4.2)) + c.hoverK * 0.3 : 0;
    }
    const dp = dotsRef.current;
    if (dp) {
      dp.visible = hint > 0.01;
      if (dp.visible) {
        const ca = dp.geometry.attributes.color as THREE.BufferAttribute;
        const head = ((t * 0.75) % 1.35) - 0.1; // a pulse runs chip → coal, then rests
        for (let i = 0; i < DOT_N; i++) {
          const u = i / (DOT_N - 1);
          const wave = Math.max(0, 1 - Math.abs(head - u) * 6);
          const b = hint * (0.3 + 1.1 * wave);
          ca.setXYZ(i, b, b * 0.72, b * 0.42);
        }
        ca.needsUpdate = true;
      }
    }

    /* ---- sparks, once, when it lands ---- */
    const sp = sparksRef.current;
    if (sp) {
      sp.visible = opening && lit && tau < 1.2;
      if (sp.visible) {
        const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
        const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
        for (let i = 0; i < SPARK_N; i++) {
          const s = SPARKS[i];
          const a = tau - s.delay;
          if (a < 0 || a > s.life) {
            ca.setXYZ(i, 0, 0, 0);
            continue;
          }
          pa.setXYZ(i, COAL.x + s.vx * a, COAL.y + 0.06 + s.vy * a - 1.4 * a * a, COAL.z + s.vz * a);
          const k = 1 - a / s.life;
          ca.setXYZ(i, k, k * 0.55, k * 0.2);
        }
        pa.needsUpdate = true;
        ca.needsUpdate = true;
      }
    }

    /* ---- the plume ---- */
    const revLift = words ? TEXT_BOTTOM + 0.35 - SRC.y : 1.0;
    const flareLift = words ? words.lift : 1.6;
    let pLift: number;
    let pAlpha: number;
    let pCount: number;
    let pChurn: number;
    if (preview) {
      // the lazy plume a gallery card sells itself on
      pLift = 1.55;
      pAlpha = 0.3;
      pCount = 0.9;
      pChurn = 0.85;
    } else if (lit) {
      // a column goes up with the flare, then thins to the thread feeding the words
      const up = smooth(clamp01(tau / 0.9));
      const fl = up * (1 - smooth(clamp01((tau - 2.0) / 2.4)));
      pLift = lerp(0.5, revLift, up) + fl * (flareLift - revLift);
      pAlpha = lerp(0.13, 0.2, up) + fl * 0.12;
      pCount = Math.min(1, lerp(0.45, 0.8, up) + fl * 0.2);
      pChurn = lerp(0.5, 0.7, up) + fl * 0.6;
    } else {
      // sealed, and waiting: a barely-there wisp
      pLift = 0.5;
      pAlpha = 0.13;
      pCount = 0.45;
      pChurn = 0.5;
    }
    // gl_PointSize is device pixels: fold the viewport's pixel height in
    const pxScale = (state.size.height * state.viewport.dpr) / (2 * TAN);
    const emberK = Math.min(1, ember * 0.5);
    const pm = plumeRef.current?.material as THREE.ShaderMaterial | undefined;
    if (pm) {
      const u = pm.uniforms;
      u.uTime.value = e % 600;
      u.uLift.value = pLift;
      u.uAlpha.value = pAlpha;
      u.uCount.value = pCount;
      u.uChurn.value = pChurn;
      u.uScale.value = pxScale;
      u.uEmber.value = emberK;
      u.uSmoke.value.copy(scent.smoke);
      u.uWarm.value.copy(scent.warm);
    }

    /* ---- the words ---- */
    const wp = wordsPtsRef.current;
    if (wp) {
      wp.visible = lit;
      const u = (wp.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = e % 600;
      u.uTau.value = tau;
      u.uLift.value = flareLift;
      u.uAlpha.value = 1;
      u.uScale.value = pxScale;
      u.uEmber.value = emberK;
      u.uSmoke.value.copy(scent.smoke);
      u.uWarm.value.copy(scent.warm);
    }
    const wpl = wordsPlaneRef.current;
    if (wpl) {
      // the front reaches the first line as the first puffs land, the last by τ≈4.1
      const front = revealed ? 3 : lit ? (tau - 2.0) / 1.35 : -1;
      wpl.visible = front > -0.2;
      const u = (wpl.material as THREE.ShaderMaterial).uniforms;
      u.uTime.value = e % 600;
      u.uFront.value = front;
      u.uEmber.value = emberK;
      u.uSmoke.value.copy(scent.smoke);
      u.uWarm.value.copy(scent.warm);
    }
    if (opening && lit && !c.chimed && tau >= CHIME_AT) {
      // the name has condensed: three notes on an oud, the way a welcome sounds
      c.chimed = true;
      pluck(147, { gain: 0.2, body: 1800 });
      pluck(220, { gain: 0.16, body: 1900, when: 0.3, seed: 2 });
      pluck(294, { gain: 0.13, body: 2000, when: 0.62, seed: 3 });
    }

    /* ---- camera: close on the burner, then up and back for the words ---- */
    const aspect = state.size.width / Math.max(1, state.size.height);
    const seal = portrait ? SEAL_P : SEAL_L;
    const to = preview ? PREVIEW : words ? words.frame : seal;
    const k = preview ? 1 : revealed ? 1 : lit ? easeInOut(clamp01((tau - 0.1) / 2.3)) : 0;
    const cy = lerp(seal.cy, to.cy, k);
    const fw = lerp(seal.w, to.w, k);
    const fh = lerp(seal.h, to.h, k);
    const pitch = lerp(seal.pitch, to.pitch, k);
    // Fit both axes: whichever of height or width runs out first sets the distance.
    const D = Math.max(fh / (2 * TAN), fw / (2 * TAN * aspect));
    const cam = camRef.current;
    if (cam) {
      cam.position.set(
        Math.sin(e * 0.21) * 0.035 * D,
        cy + Math.sin(pitch) * D + Math.sin(e * 0.29) * 0.01 * D,
        Math.cos(pitch) * D,
      );
      cam.lookAt(0, cy, 0);
    }
    // fog starts just past the burner wherever the camera has had to go
    if (fogRef.current) {
      fogRef.current.near = D + 0.6;
      fogRef.current.far = D + 5.5;
    }

    if (opening && lit && tau >= TAU_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const opening = phase === "opening";
  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault fov={FOV} near={0.05} far={40} position={[0, 1.2, 4]} />
      <color attach="background" args={[BG]} />
      <fog ref={fogRef} attach="fog" args={[BG, 5, 10]} />

      {/* low and warm: one lamp off to the left, a cool bounce from the doorway, the coal */}
      <ambientLight intensity={0.16} color="#ffd6ae" />
      <primitive object={hot.keyTarget} position={[0, 0.5, 0]} />
      <spotLight
        position={[-1.4, 4.4, 2.8]} target={hot.keyTarget} angle={0.46} penumbra={1}
        intensity={3.2} decay={0} color="#ffd3a0"
      />
      <directionalLight position={[2.6, 2.2, -2.4]} intensity={0.65} color="#8b9ac4" />
      <pointLight ref={coalLightRef} position={[0, B0 + 1.5, 0.3]} intensity={1} distance={3} decay={1.6} />

      {/* the majlis: plaster wall, a bolster along it, sadu on the floor */}
      <mesh position={[0, 2.4, -3.2]}>
        <planeGeometry args={[30, 10]} />
        <meshBasicMaterial map={WALL_TEX} />
      </mesh>
      <mesh geometry={CUSHION_GEO} position={[0, 0.3, -2.3]} scale={[10, 0.6, 0.78]}>
        <meshStandardMaterial map={CUSHION_TEX} color="#8a7066" roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.5]}>
        <planeGeometry args={[18, 12]} />
        <meshStandardMaterial map={CARPET_TEX} color="#8a7670" roughness={0.95} />
      </mesh>
      {/* no shadow maps: a soft dark under the tray, and one under the burner */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.04, 0.003, 0.02]} renderOrder={1}>
        <planeGeometry args={[2.9, 2.6]} />
        <meshBasicMaterial map={glowTex} color="#000" transparent opacity={0.7} depthWrite={false} />
      </mesh>

      {/* the tray */}
      <mesh geometry={TRAY_RIM_GEO} material={TRAY_RIM_MAT} />
      <mesh geometry={TRAY_TOP_GEO} material={TRAY_MAT} rotation={[-Math.PI / 2, 0, 0]} position={[0, TRAY_TOP, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0.03, TRAY_TOP + 0.002, 0.03]} renderOrder={2}>
        <planeGeometry args={[1.2, 1.2]} />
        <meshBasicMaterial map={glowTex} color="#000" transparent opacity={0.62} depthWrite={false} />
      </mesh>

      {/* the mabkhara */}
      <group position={[0, B0, 0]}>
        <mesh geometry={BODY_GEO} material={mats.body} />
        <mesh geometry={TRIM_GEO} material={mats.trim} />
        <mesh geometry={INNER_GEO} material={INNER_MAT} />
        <mesh ref={ashMeshRef} geometry={ASH_GEO} material={hot.ash} position={[0, 0.925, 0]} />
      </group>
      <mesh ref={coalMeshRef} geometry={COAL_GEO} material={hot.coal} position={COAL} rotation={[0.1, 0.7, 0]} />
      <sprite ref={glowRef} position={[0, COAL.y + 0.05, 0.02]} scale={0.4}>
        <spriteMaterial ref={glowMatRef} map={glowTex} transparent opacity={0.3} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* the oud */}
      <group ref={chipRef} position={REST}>
        <mesh ref={chipMeshRef} geometry={CHIP_GEO} material={hot.chip} />
      </group>
      <mesh ref={chipShadowRef} rotation={[-Math.PI / 2, 0, -0.55]} position={[REST.x, TRAY_TOP + 0.002, REST.z]} renderOrder={3}>
        <planeGeometry args={[0.26, 0.12]} />
        <meshBasicMaterial ref={chipShadowMatRef} map={glowTex} color="#000" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <sprite ref={chipHaloRef} position={REST} scale={0.5} renderOrder={8}>
        <spriteMaterial ref={chipHaloMatRef} map={glowTex} color="#ffc98a" transparent opacity={0} depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <points ref={dotsRef} frustumCulled={false} visible={false} renderOrder={8}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[DOT_POS, 3]} />
          <bufferAttribute attach="attributes-color" args={[bufs.dotCol, 3]} />
        </bufferGeometry>
        <pointsMaterial map={glowTex} vertexColors size={0.14} sizeAttenuation transparent depthWrite={false} depthTest={false} blending={THREE.AdditiveBlending} />
      </points>
      <points ref={sparksRef} frustumCulled={false} visible={false} renderOrder={9}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[bufs.sparkPos, 3]} />
          <bufferAttribute attach="attributes-color" args={[bufs.sparkCol, 3]} />
        </bufferGeometry>
        <pointsMaterial map={glowTex} vertexColors size={0.05} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>

      {/* smoke: the thread off the coal, and the words it becomes */}
      <points ref={plumeRef} geometry={PLUME_GEO} material={plumeMat} frustumCulled={false} renderOrder={5} />
      {words && (
        <>
          <mesh ref={wordsPlaneRef} material={words.mat} position={[0, words.pcy, 0]} visible={false} renderOrder={6}>
            <planeGeometry args={[words.pw, words.ph]} />
          </mesh>
          <points ref={wordsPtsRef} geometry={words.geo} material={wordsMat} frustumCulled={false} visible={false} renderOrder={7} />
        </>
      )}

      {/* three raycasts straight through visible={false}, so the targets are transparent
          instead — and only exist while there is something to do with them */}
      {opening && (
        <>
          <mesh
            ref={chipHitRef}
            position={REST}
            onPointerDown={onChipDown}
            onPointerMove={onChipMove}
            onPointerUp={onChipUp}
            onPointerCancel={onChipCancel}
            onPointerOver={onChipOver}
            onPointerOut={onChipOut}
          >
            <sphereGeometry args={[0.2, 12, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <mesh position={[0, B0 + 0.78, 0]} onPointerDown={onBowlDown}>
            <boxGeometry args={[0.78, 0.5, 0.78]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </>
      )}
    </>
  );
}
