import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makePaintMask } from "../mask";
import { makeTextTexture, type TextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- palettes: the metal in the foil ---------- */
// The foil is a real metal here — metalness 1, so `base` is not a tint but the whole
// specular colour, and everything it is ever going to look like comes off the envMap.
interface Foil {
  base: string; // the sheet
  tear: string; // the burnished sliver right at the tear
  shine: string; // a flake's lit face, and the fingertip's own burnish
  dark: string; // and the flake's shadowed one
  rough: number;
  aniso: number;
  env: number;
  card: string; // the ticket's paper
  ink: string; // what is printed on it
  stamp: string; // and what the stamp prints in
  conf: string[];
}
const FOILS: Record<string, Foil> = {
  gold: {
    base: "#c9971f", tear: "#fff2c4", shine: "#ffe9a8", dark: "#59410f",
    rough: 0.3, aniso: 0.88, env: 1.35,
    card: "#f2e9d6", ink: "#4a3410", stamp: "#b4202e",
    conf: ["#ffd23f", "#ff5f6d", "#3fd0c9", "#fff3d0", "#ff9f45"],
  },
  silver: {
    base: "#b7bfc8", tear: "#ffffff", shine: "#eaf2ff", dark: "#3d454e",
    rough: 0.24, aniso: 0.92, env: 1.5,
    card: "#eef1f4", ink: "#22303c", stamp: "#1f4fa8",
    conf: ["#8fd3ff", "#ffffff", "#ff5f9e", "#c6a2ff", "#5fe0c0"],
  },
  rose: {
    base: "#cf8670", tear: "#ffe4d8", shine: "#ffd0bd", dark: "#6a3426",
    rough: 0.32, aniso: 0.85, env: 1.3,
    card: "#f5ebe6", ink: "#5a2a24", stamp: "#a8305c",
    conf: ["#ff9ec4", "#ffd9a8", "#fff0f4", "#c98bd8", "#ff6f8f"],
  },
};

/** The one word the whole gift is for. Never a hardcoded Latin string. */
const WINNER: Record<Lang, string> = { en: "WINNER", ar: "رابح" };

/* ---------- the card, in the tabletop's own xy ---------- */
const CARD_W = 1.72;
const CARD_H = 2.1;
const CARD_T = 0.024;
const CARD_R = 0.1;
const BEVEL_T = 0.004;
const FACE_Z = CARD_T / 2 + BEVEL_T;

// Square, because makePaintMask is square: a landscape panel would either stretch
// the brush into an ellipse or throw half the mask's texels away.
const PANEL = 1.44;
const PANEL_CY = 0.22;
const PANEL_Z = FACE_Z + 0.003;
const MSG_CY = PANEL_CY + 0.06;
const MSG_W = PANEL * 0.84;
const MSG_H = PANEL * 0.56;
const STAMP_CX = 0.0;
const STAMP_CY = -0.5; // straddling the panel's bottom edge, the way a real one lands
const STAMP_W = 1.34;
const STAMP_Z = FACE_Z + 0.006;
const STAMP_ROT = -0.105;
const STAMP_PUNCH = 1.6;

const MASK_SIZE = 512;
// The panel is a fixed size in the card's own space and the card only ever scales
// uniformly, so the mask's world mapping never moves and every uv constant below is
// safe — which is exactly the case a viewport-sized mask is not.
const MASK_SPAN = PANEL * 1.04; // 4% of margin, so a stroke at the very edge still has mask to bite
const UV_SCALE = PANEL / MASK_SPAN;
const COV_VIS = UV_SCALE * UV_SCALE; // the share of the square mask the panel can ever reach
const SCRATCH_RW = 0.128; // a fingertip, in world units — the card is 1.72 across
const SCRATCH_R = SCRATCH_RW / MASK_SPAN;

const FOV = 38;
const ACTION_W = 1.98;
const ACTION_H = 2.52;

const toMask = (p: number) => 0.5 + (p - 0.5) * UV_SCALE;
const uToX = (u: number) => (u - 0.5) * MASK_SPAN;
const vToY = (v: number) => PANEL_CY + (v - 0.5) * MASK_SPAN;

/* ---------- opening timeline (seconds) ---------- */
const SLIDE_DUR = 0.85;
const T_MERCY0 = 3.4; // the card starts scratching itself…
const MERCY_RAMP = 1.4; // …easing in, so it reads as company and not as a timer
const GHOST_DUR = 4.6; // full-rate seconds for the invisible finger to work the panel
// The hard floor, and it is the *no-input* path's — so it runs on the card's own idle
// clock and not on t. Whoever is actually scratching is not on a timer; they finish on
// coverage, whenever they like. Left alone from the first frame that clock *is* t, so a
// hands-off run still clears at 9.2 and lands onOpenComplete at 9.2 + SHOW_DUR = 11.6s.
const T_MERCY_MAX = 9.2;
// Scratching is not a promise either: the ghost's seven passes top out near 0.77, and a
// finger that scrubs one spot and never lets go saturates it and holds that plateau. The
// idle clock never runs for them, so only this catches it. A gift cannot lock.
const T_MERCY_MAX_HELD = 20;
const COV_TARGET = 0.85;
const COV_POLL = 0.15; // coverage() allocates a whole ImageData — never sample it per frame

const CLEAR_DUR = 0.55;
const T_STAMP = 0.42;
const PUNCH = 0.16;
const SHOW_DUR = 2.35;

const PREV_PERIOD = 11.5;
const PREV_START = 0.6;
const PREV_GHOST = 4.4;
const PREV_CLEAR = 5.2;
const PREV_SEAL = 9.6;
const PREV_SEAL_DUR = 1.3;

/* ---------- noise ---------- */
/** One octave of tileable value noise over [0,1)² — it wraps, so every tile below is seamless. */
function lattice(period: number, rand: () => number): (x: number, y: number) => number {
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (x, y) => {
    const fx = x * period;
    const fy = y * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const r0 = (((y0 % period) + period) % period) * period;
    const r1 = ((((y0 + 1) % period) + period) % period) * period;
    const c0 = (((x0 % period) + period) % period);
    const c1 = ((((x0 + 1) % period) + period) % period);
    return lerp(lerp(grid[r0 + c0], grid[r0 + c1], tx), lerp(grid[r1 + c0], grid[r1 + c1], tx), ty);
  };
}

// Foil is never smooth and its tear is never a curve: this one texture is the grain
// the mask's compass edge gets chewed up by, the crumble the auto-clear eats along,
// and the patchy ink of the rubber stamp. Stretched to fill 0..1 — an fbm's raw bell
// sits in the middle third, and a threshold sweeping it would stall at both ends.
function buildGrainTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const rand = mulberry32(90211);
  const octs: [(x: number, y: number) => number, number][] = [
    [lattice(3, rand), 0.5],
    [lattice(7, rand), 0.31],
    [lattice(17, rand), 0.19],
  ];
  const buf = new Float32Array(S * S);
  let lo = 1;
  let hi = 0;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let n = 0;
      for (const [f, a] of octs) n += f(x / S, y / S) * a;
      buf[y * S + x] = n;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
  const k = 1 / Math.max(1e-4, hi - lo);
  for (let i = 0; i < S * S; i++) {
    const v = Math.round(clamp01((buf[i] - lo) * k) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const grainTex = buildGrainTexture();
const glowTex = makeRadialSprite();

/* ---------- the mill ---------- */
// Which way the sheet was rolled, and how hard — three's own GGX anisotropy reads
// rg as the tangent and b as the strength. The field itself is isotropic; the
// squash in `repeat` is what turns its blobs into filaments running across the card,
// and filaments are the whole difference between foil and shiny plastic.
function buildMillTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const img = g.createImageData(S, S);
  const rand = mulberry32(31337);
  const wander = lattice(6, rand);
  const strength = lattice(14, rand);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      // ±0.5 rad: rollers are not perfect and the grain drifts across the sheet
      const th = (wander(x / S, y / S) - 0.5) * 1.0;
      const i = (y * S + x) * 4;
      img.data[i] = Math.round((Math.cos(th) * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((Math.sin(th) * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((0.55 + 0.45 * strength(x / S, y / S)) * 255);
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Squashed, not tight: past about eight the filaments alias into corduroy.
  t.repeat.set(1.2, 7);
  return t;
}
const millTex = buildMillTexture();

/* ---------- the room the foil has to reflect ---------- */
// A metal with no envMap renders black: direct lights only give it specular dots.
// And this is where the moving highlight actually lives — a card lying on a table
// reflects the ceiling, so the softbox goes at the top of the equirect and tipping
// the card sweeps its edge across the foil. Narrow on purpose: a broad one would
// wash the whole sheet and never appear to travel.
function buildEnvTexture(): THREE.Texture {
  const W = 256;
  const H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // At metalness 1 there is no diffuse at all: this gradient *is* the foil's colour,
  // so a dim room does not read as dim gold, it reads as brown wood.
  const room = g.createLinearGradient(0, 0, 0, H);
  room.addColorStop(0, "#6d5a48"); // straight up, off to the side of the light
  room.addColorStop(0.4, "#b09071"); // the warm room the card is lying in
  room.addColorStop(0.6, "#4a3a35");
  room.addColorStop(1, "#120d12"); // and the table's own darkness below it
  g.fillStyle = room;
  g.fillRect(0, 0, W, H);
  const band = g.createLinearGradient(0, H * 0.04, 0, H * 0.3);
  band.addColorStop(0, "rgba(255,240,212,0)");
  band.addColorStop(0.5, "rgba(255,250,238,1)");
  band.addColorStop(1, "rgba(255,240,212,0)");
  g.fillStyle = band;
  g.fillRect(0, H * 0.04, W, H * 0.26);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  // two lamps off the sides, so rolling the card left or right also has something to find
  blob(48, 30, 22, "#ffd9a2");
  blob(198, 24, 17, "#bcd6ff");
  blob(126, 96, 30, "#191216"); // and one dark patch, or the sheet never has a shadow
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const envTex = buildEnvTexture();

/* ---------- the motif, stamped into the foil ---------- */
type MotifKind = "hearts" | "stars" | "clovers";

function motifPath(g: CanvasRenderingContext2D, kind: MotifKind, cx: number, cy: number, r: number, rot: number) {
  g.save();
  g.translate(cx, cy);
  g.rotate(rot);
  g.beginPath();
  if (kind === "stars") {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.44 : r;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
    g.fill();
  } else if (kind === "clovers") {
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      g.ellipse(Math.cos(a) * r * 0.44, Math.sin(a) * r * 0.44, r * 0.42, r * 0.31, a, 0, Math.PI * 2);
    }
    g.fill();
    // the stem, curling out from under the lower leaf the way it grows
    g.beginPath();
    g.moveTo(r * 0.03, r * 0.12);
    g.quadraticCurveTo(r * 0.32, r * 0.56, r * 0.16, r * 0.98);
    g.lineTo(r * 0.02, r * 0.92);
    g.quadraticCurveTo(r * 0.16, r * 0.5, -r * 0.08, r * 0.18);
    g.fill();
  } else {
    // two lobes swept off one tip — the shape everybody draws without looking
    g.moveTo(0, r * 0.66);
    g.bezierCurveTo(-r * 1.18, -r * 0.2, -r * 0.52, -r * 1.02, 0, -r * 0.34);
    g.bezierCurveTo(r * 0.52, -r * 1.02, r * 1.18, -r * 0.2, 0, r * 0.66);
    g.fill();
  }
  g.restore();
}

/** Separable box blur that wraps, so the tile stays seamless. */
function blurWrap(h: Float32Array, S: number, r: number) {
  const tmp = new Float32Array(S * S);
  const n = r * 2 + 1;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += h[y * S + ((x + k + S) % S)];
      tmp[y * S + x] = s / n;
    }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[(((y + k + S) % S) * S) + x];
      h[y * S + x] = s / n;
    }
}

// Foil stamping is a relief, not a print, so the motif is a normal map: three lights
// it properly and it appears and vanishes as the highlight sweeps over it, which is
// exactly what stamped foil does. The mill's fine crinkle rides on the same map —
// the normalMap slot is the only one going, and one texture buys both.
function buildMotifNormal(kind: MotifKind): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#fff";
  // a half-drop repeat: two per tile on the diagonal, each drawn nine times so the
  // ones crossing an edge come back on the far side
  for (const [px, py, rot] of [
    [0.25, 0.25, 0.2],
    [0.75, 0.75, -0.35],
  ]) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) motifPath(g, kind, (px + dx) * S, (py + dy) * S, S * 0.17, rot);
  }

  const src = g.getImageData(0, 0, S, S).data;
  const h = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) h[i] = src[i * 4] / 255;
  // A step function differentiates to a hairline, so it has to be softened first —
  // but only just. Stamped foil is a flat top with a rolled edge, and a blur wide
  // enough to eat the plateau turns every motif into a blob of chewing gum.
  blurWrap(h, S, 2);
  const crinkle = lattice(19, mulberry32(4471));
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) h[y * S + x] += (crinkle(x / S, y / S) - 0.5) * 0.14;

  const out = g.createImageData(S, S);
  const at = (x: number, y: number) => h[(((y % S) + S) % S) * S + (((x % S) + S) % S)];
  const v = new THREE.Vector3();
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      // n = (-dh/du, -dh/dv, 1); flipY on upload means canvas +y is texture -v, so
      // the v derivative comes back with the sign it went in with.
      v.set(-(at(x + 1, y) - at(x - 1, y)) * 5.5, (at(x, y + 1) - at(x, y - 1)) * 5.5, 1).normalize();
      const i = (y * S + x) * 4;
      out.data[i] = Math.round((v.x * 0.5 + 0.5) * 255);
      out.data[i + 1] = Math.round((v.y * 0.5 + 0.5) * 255);
      out.data[i + 2] = Math.round((v.z * 0.5 + 0.5) * 255);
      out.data[i + 3] = 255;
    }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  return t;
}

// Cached rather than built eagerly: one mount only ever wants one of the three, and
// the blur is the most expensive thing in this file.
const MOTIF_CACHE: Partial<Record<MotifKind, THREE.CanvasTexture>> = {};
function motifNormal(kind: MotifKind): THREE.CanvasTexture {
  return (MOTIF_CACHE[kind] ??= buildMotifNormal(kind));
}

/* ---------- the ticket printed underneath ---------- */
// Drawn white and tinted by the material, so one texture serves all three foils.
function buildCardTexture(): THREE.CanvasTexture {
  const W = 344;
  const H = 420;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fbf7ee";
  g.fillRect(0, 0, W, H);
  const rand = mulberry32(2207);
  g.fillStyle = "rgba(120,104,84,0.07)"; // rag fibre, so the paper is paper
  for (let i = 0; i < 1100; i++) g.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1);

  // The guilloche. A hypotrochoid is the rosette on the back of every ticket and
  // banknote ever printed, and it costs twelve lines.
  const rose = (R: number, r: number, d: number, turns: number) => {
    g.beginPath();
    for (let i = 0; i <= 1400; i++) {
      const th = (i / 1400) * Math.PI * 2 * turns;
      const x = W / 2 + (R - r) * Math.cos(th) + d * Math.cos(((R - r) / r) * th);
      const y = H * 0.5 + (R - r) * Math.sin(th) - d * Math.sin(((R - r) / r) * th);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  };
  g.strokeStyle = "rgba(150,120,86,0.3)";
  g.lineWidth = 0.7;
  rose(152, 24, 62, 3);
  g.strokeStyle = "rgba(150,120,86,0.19)";
  rose(152, 40, 34, 5);

  g.strokeStyle = "rgba(120,94,60,0.5)"; // the hairline border
  g.lineWidth = 1.6;
  g.strokeRect(9, 9, W - 18, H - 18);
  g.lineWidth = 0.7;
  g.strokeRect(15, 15, W - 30, H - 30);

  // The scratch panel's own substrate: a matte box, printed square-cornered exactly
  // like the real thing. Baked in rather than a second quad — one less draw call and
  // nothing to z-fight with.
  const px = (0.5 - PANEL / CARD_W / 2) * W;
  const py = (0.5 - (PANEL_CY + PANEL / 2) / CARD_H) * H;
  const pw = (PANEL / CARD_W) * W;
  const ph = (PANEL / CARD_H) * H;
  g.fillStyle = "rgba(228,221,206,0.9)";
  g.fillRect(px, py, pw, ph);
  g.strokeStyle = "rgba(120,94,60,0.35)";
  g.strokeRect(px, py, pw, ph);

  // and the fine print the stamp lands across
  g.strokeStyle = "rgba(120,94,60,0.3)";
  for (const fy of [0.855, 0.925]) {
    g.beginPath();
    g.moveTo(W * 0.16, H * fy);
    g.lineTo(W * 0.84, H * fy);
    g.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // ExtrudeGeometry's world uv generator hands back shape coordinates, so pull them
  // back into 0..1 here rather than writing a uv generator.
  t.repeat.set(1 / CARD_W, 1 / CARD_H);
  t.offset.set(0.5, 0.5);
  return t;
}
const cardTex = buildCardTexture();

/* ---------- geometry ---------- */
function buildCardGeo(): THREE.ExtrudeGeometry {
  const w = CARD_W / 2;
  const h = CARD_H / 2;
  const r = CARD_R;
  const s = new THREE.Shape();
  s.moveTo(-w + r, -h);
  s.lineTo(w - r, -h);
  s.quadraticCurveTo(w, -h, w, -h + r);
  s.lineTo(w, h - r);
  s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h);
  s.quadraticCurveTo(-w, h, -w, h - r);
  s.lineTo(-w, -h + r);
  s.quadraticCurveTo(-w, -h, -w + r, -h);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: CARD_T,
    bevelEnabled: true,
    bevelSize: 0.005,
    bevelThickness: BEVEL_T,
    bevelSegments: 2,
    curveSegments: 6,
  });
  g.translate(0, 0, -CARD_T / 2);
  return g;
}
const cardGeo = buildCardGeo();
const panelGeo = new THREE.PlaneGeometry(PANEL, PANEL);
const quadGeo = new THREE.PlaneGeometry(1, 1);

/* ---------- the foil ---------- */
const DISS_W = 0.19; // how wide a band of the crumble the auto-clear eats at once

// three's stock alphaMap samples GREEN, and the brush's falloff lives in ALPHA — hand
// the mask straight over and the tear comes back as a hard-edged disc with the
// softness thrown away. So it is sampled by hand. Patching MeshPhysicalMaterial
// rather than hand-rolling a ShaderMaterial keeps three's colour management, its
// envMap and — the whole reason this material and not MeshStandard — its GGX
// anisotropy, which is what smears the reflection into a streak.
const FOIL_GLSL = /* glsl */ `
  vec2 scUv = (vUv - 0.5) * ${UV_SCALE.toFixed(4)} + 0.5;
  float scGone = 1.0 - texture2D(uMask, scUv).a;
  float scG = texture2D(uGrain, vUv * 5.5).r;
  float scC = texture2D(uGrain, vUv * 2.3 + 0.41).r;

  // Foil has no airbrushed edge — it tears. Chewing the brush's soft falloff up with
  // the grain is what turns a compass circle into something that came away in flakes.
  float scFoil = 1.0 - smoothstep(0.30, 0.66, scGone + (scG - 0.5) * 0.5);

  // The auto-clear: the last of it crumbles off rather than politely fading. The
  // threshold falls *through* the grain — high keeps every scrap, low takes it all —
  // and it has to overshoot both ends, or uClear = 0 would already have eaten the
  // sheet and uClear = 1 would leave half of it standing.
  float scD = (1.0 - uClear) * ${(1 + 2 * DISS_W).toFixed(3)} - ${DISS_W.toFixed(3)};
  scFoil *= 1.0 - smoothstep(scD - ${DISS_W.toFixed(3)}, scD + ${DISS_W.toFixed(3)}, scC);

  // A fingertip drags the metal as it lifts it, so the last sliver at the tear is
  // burnished — and at metalness 1, diffuseColor *is* the specular tint.
  float scTear = scFoil * (1.0 - scFoil) * 4.0;
  diffuseColor.rgb = mix(diffuseColor.rgb, uTear, scTear * 0.75);
  diffuseColor.a *= scFoil;
`;

const FOIL_ROUGH_GLSL = /* glsl */ `
  #include <roughnessmap_fragment>
  // and scuffed with it: the tear is where the mill's polish has gone
  roughnessFactor = clamp(roughnessFactor + scTear * 0.45, 0.0, 1.0);
`;

interface FoilUniforms {
  uMask: { value: THREE.Texture };
  uGrain: { value: THREE.Texture };
  uTear: { value: THREE.Color };
  uClear: { value: number };
}

function makeFoilMat(f: Foil, motif: THREE.Texture, mask: THREE.Texture) {
  const uniforms: FoilUniforms = {
    uMask: { value: mask },
    uGrain: { value: grainTex },
    uTear: { value: new THREE.Color(f.tear) },
    uClear: { value: 0 },
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: f.base,
    metalness: 1,
    roughness: f.rough,
    // aimed along +u by the mill map, so the streak runs across the card and rides
    // up and down it as the card tips — the whole tell of rolled foil
    anisotropy: f.aniso,
    anisotropyMap: millTex,
    envMap: envTex,
    envMapIntensity: f.env,
    normalMap: motif,
    normalScale: new THREE.Vector2(0.42, 0.42),
    transparent: true,
    depthWrite: false,
  });
  // Merged, never replaced: MeshPhysicalMaterial's own STANDARD/PHYSICAL live here.
  // three never emits USE_UV itself, so vUv is only ever ours to ask for.
  mat.defines = { ...mat.defines, USE_UV: "" };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uMask;
uniform sampler2D uGrain;
uniform vec3 uTear;
uniform float uClear;`,
      )
      .replace("#include <alphamap_fragment>", FOIL_GLSL)
      .replace("#include <roughnessmap_fragment>", FOIL_ROUGH_GLSL);
  };
  return { mat, uniforms };
}

/* ---------- the stamp ---------- */
// Composited into one canvas rather than assembled from planes: a rubber pad inks
// unevenly across its whole face, and the patchiness only reads if it is one
// coherent field over the border and the letters at once. One quad, one uv, one ink.
const INK_GLSL = /* glsl */ `
  float skInk = texture2D(uInk, vUv * 3.1).r;
  // a pad presses hardest in the middle, so the rim is always the first thing to go
  vec2 skC = (vUv - 0.5) * 2.0;
  skInk += 0.17 * (1.0 - min(dot(skC, skC), 1.0));
  diffuseColor.a *= smoothstep(0.33, 0.49, skInk);
`;

function makeInkMat(color: string, map: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color,
    map,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  mat.defines = { USE_UV: "" };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uInk = { value: grainTex };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uInk;")
      .replace("#include <alphamap_fragment>", INK_GLSL);
  };
  return mat;
}

function buildStamp(word: string, names: string, lang: Lang): TextTexture {
  // 1024 wide, not 512: the word is rasterized once by makeTextTexture and resampled
  // twice more on its way here and onto the card, and at 512 the letters arrive soft
  // enough to read as a blur rather than as ink.
  const W = 1024;
  const H = 600;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.fillStyle = "#fff";
  const oval = (k: number, lw: number) => {
    g.lineWidth = lw;
    g.beginPath();
    g.ellipse(W / 2, H / 2, W * 0.47 * k, H * 0.44 * k, 0, 0, Math.PI * 2);
    g.stroke();
  };
  oval(1, 18);
  oval(0.93, 7);

  // makeTextTexture hands back the canvas it drew on, so the lines composite straight
  // in — and Arabic arrives already shaped and bidi'd, in Thmanyah, for free.
  const place = (tt: TextTexture, cy: number, maxW: number, maxH: number) => {
    let w = maxW;
    if (w * tt.aspect > maxH) w = maxH / tt.aspect;
    g.drawImage(tt.texture.image as HTMLCanvasElement, (W - w) / 2, cy - (w * tt.aspect) / 2, w, w * tt.aspect);
    tt.texture.dispose();
  };
  place(
    makeTextTexture(word, { fontSize: 220, fontWeight: "800", color: "#ffffff", padding: 16, lang }),
    H * 0.42,
    W * 0.7,
    H * 0.34,
  );
  if (names) {
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(W * 0.3, H * 0.575);
    g.lineTo(W * 0.7, H * 0.575);
    g.stroke();
    place(
      makeTextTexture(names, { fontSize: 108, fontWeight: "600", color: "#ffffff", padding: 14, maxWidthPx: 3200, lang }),
      H * 0.705,
      W * 0.58,
      H * 0.16,
    );
  }
  const texture = new THREE.CanvasTexture(c);
  texture.anisotropy = 4;
  return { texture, aspect: H / W };
}

/* ---------- the invisible finger ---------- */
// Preview has no gesture and mercy has no finger, and both want the same thing: the
// card scratching itself, believably. One path serves both — and because it is
// stamped on a fixed grid, every run lays down identical strokes.
const GHOST_PASSES = 7;
const GHOST_STEPS = 240;
const GHOST_CATCHUP = 24; // a card scrolled offscreen and back returns with its clock jumped

const gp0 = { u: 0, v: 0 };
const gp1 = { u: 0, v: 0 };
function ghostAt(out: { u: number; v: number }, k: number) {
  const p = clamp01(k) * GHOST_PASSES;
  const i = Math.min(GHOST_PASSES - 1, Math.floor(p));
  const f = p - i;
  // back and forth, top to bottom, sagging in the middle of each pass — the way
  // anyone has ever scratched a card
  const s = i % 2 === 0 ? f : 1 - f;
  const pu = 0.07 + 0.86 * s;
  const pv = 0.92 - ((i + f) / GHOST_PASSES) * 0.84 + Math.sin(f * Math.PI) * 0.02;
  out.u = toMask(pu);
  out.v = toMask(pv);
}

/* ---------- flakes ---------- */
// The flakes are what make it feel like scraping rather than erasing, so they are
// spawned per unit of stroke and not per event: a flung drag has to spray more, not
// less. Thrown backward off the fingertip, because that is where a scraper puts its
// swarf, and that direction is the entire physical read.
const FLAKE_N = 150;
const FLAKE_LIFE = 0.7;
const FLAKE_DRAG = 0.13; // dust has far more drag than mass: it is thrown, and it stops
const FLAKE_G = 1.1; // the hop up off the sheet, and back down onto it
const FLAKE_PER_UNIT = 34;
const CRUMB_RATE = 92;

interface Flakes {
  t0: Float32Array;
  p: Float32Array;
  v: Float32Array;
  ax: Float32Array;
  s: Float32Array; // spin, size x, size y
  cursor: number;
  debt: number;
  crumb: number;
}
function makeFlakes(): Flakes {
  return {
    t0: new Float32Array(FLAKE_N).fill(-99),
    p: new Float32Array(FLAKE_N * 3),
    v: new Float32Array(FLAKE_N * 3),
    ax: new Float32Array(FLAKE_N * 3),
    s: new Float32Array(FLAKE_N * 3),
    cursor: 0,
    debt: 0,
    crumb: 0,
  };
}

const tmpAxis = new THREE.Vector3();
function spawnFlake(f: Flakes, now: number, x: number, y: number, dx: number, dy: number) {
  const i = f.cursor;
  f.cursor = (i + 1) % FLAKE_N;
  f.t0[i] = now;
  f.p[i * 3] = x + (Math.random() - 0.5) * 0.05;
  f.p[i * 3 + 1] = y + (Math.random() - 0.5) * 0.05;
  f.p[i * 3 + 2] = PANEL_Z + 0.002;
  const back = 0.5 + Math.random() * 1.1;
  const side = (Math.random() - 0.5) * 0.9;
  f.v[i * 3] = -dx * back - dy * side;
  f.v[i * 3 + 1] = -dy * back + dx * side;
  f.v[i * 3 + 2] = 0.16 + Math.random() * 0.34;
  tmpAxis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
  f.ax[i * 3] = tmpAxis.x;
  f.ax[i * 3 + 1] = tmpAxis.y;
  f.ax[i * 3 + 2] = tmpAxis.z;
  f.s[i * 3] = (Math.random() < 0.5 ? -1 : 1) * (11 + Math.random() * 22);
  f.s[i * 3 + 1] = 0.012 + Math.random() * 0.017;
  f.s[i * 3 + 2] = 0.01 + Math.random() * 0.02;
}

/* ---------- confetti ---------- */
// Every position is a closed form of the show clock, so `revealed` is simply this
// pinned at its end — a winning ticket lying in settled confetti, drawn cold under
// reduced motion, and identical on every replay for free.
const CONF_N = 96;
const CONF_DRAG = 0.3;
const CONF_G = 4.2;
const CONF_LAND = 0.02;

function buildConfetti() {
  const rand = mulberry32(770214);
  const ori = new Float32Array(CONF_N * 3);
  const dir = new Float32Array(CONF_N * 3);
  const ax = new Float32Array(CONF_N * 3);
  const spin = new Float32Array(CONF_N);
  const roll = new Float32Array(CONF_N);
  const size = new Float32Array(CONF_N * 2);
  const tint = new Float32Array(CONF_N);
  const v = new THREE.Vector3();
  for (let i = 0; i < CONF_N; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    ori[i * 3] = Math.cos(a) * r * 0.34;
    ori[i * 3 + 1] = Math.sin(a) * r * 0.2;
    ori[i * 3 + 2] = 0.02;
    const sp = 0.55 + rand() * 1.5;
    dir[i * 3] = Math.cos(a) * sp * (0.5 + rand());
    dir[i * 3 + 1] = Math.sin(a) * sp * (0.5 + rand()) + 0.3;
    dir[i * 3 + 2] = 1.1 + rand() * 1.5;
    v.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    ax[i * 3] = v.x;
    ax[i * 3 + 1] = v.y;
    ax[i * 3 + 2] = v.z;
    spin[i] = (rand() < 0.5 ? -1 : 1) * (9 + rand() * 16);
    roll[i] = rand() * Math.PI * 2;
    size[i * 2] = 0.022 + rand() * 0.018;
    size[i * 2 + 1] = 0.036 + rand() * 0.03;
    tint[i] = rand();
  }
  return { ori, dir, ax, spin, roll, size, tint };
}
const CONF = buildConfetti();

/** InstancedMesh has no per-instance opacity, and a flake that fades by going black
 *  is a black flake. One attribute is cheaper than a whole ShaderMaterial. */
function makeChipMat(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = `attribute float aFade;\nvarying float vFade;\n${sh.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n\tvFade = aFade;",
    );
    sh.fragmentShader = `varying float vFade;\n${sh.fragmentShader}`.replace(
      "#include <dithering_fragment>",
      "#include <dithering_fragment>\n\tgl_FragColor.a *= vFade;",
    );
  };
  return m;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpFlat = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpC = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export default function ScratchCardScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const foil = FOILS[variants.foil] ?? FOILS.gold;
  const motif: MotifKind =
    variants.motif === "stars" || variants.motif === "clovers" ? variants.motif : "hearts";

  /* useMemo is load-bearing all through here: it owns the mask canvas, the textures
     and the materials, and every one of them is paired with a dispose. */
  const mask = useMemo(() => makePaintMask({ size: MASK_SIZE }), []); // filled: erase to reveal
  useEffect(() => () => mask.dispose(), [mask]);

  const foilRes = useMemo(
    () => makeFoilMat(foil, motifNormal(motif), mask.texture),
    [foil, motif, mask],
  );
  useEffect(() => () => foilRes.mat.dispose(), [foilRes]);

  const cardMat = useMemo(
    () => new THREE.MeshStandardMaterial({ map: cardTex, color: foil.card, roughness: 0.86 }),
    [foil],
  );
  useEffect(() => () => cardMat.dispose(), [cardMat]);

  const names = [recipientName.trim(), senderName.trim()].filter(Boolean).join("  ·  ");
  const stamp = useMemo(() => buildStamp(WINNER[lang], names, lang), [names, lang]);
  useEffect(() => () => stamp.texture.dispose(), [stamp]);

  const inkMat = useMemo(() => makeInkMat(foil.stamp, stamp.texture), [foil, stamp]);
  useEffect(() => () => inkMat.dispose(), [inkMat]);

  // `message` is "" on a gallery card and live per-keystroke from /create, so this
  // memo has to be cheap and it can never require a message: an empty one still gets
  // the gift's signature move, over the shared "For you" copy.
  const textSource = message.trim() || forRecipient(lang, recipientName);
  const msg = useMemo(
    () =>
      makeTextTexture(textSource, {
        fontSize: 60,
        fontWeight: "600",
        color: "#ffffff",
        maxWidthPx: 620,
        lineHeight: 1.35,
        lang,
      }),
    [textSource, lang],
  );
  useEffect(() => () => msg.texture.dispose(), [msg]);

  const chips = useMemo(() => {
    const geo = (n: number) => {
      const g = quadGeo.clone();
      g.setAttribute("aFade", new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
      return g;
    };
    return { flakeGeo: geo(FLAKE_N), confGeo: geo(CONF_N), flakeMat: makeChipMat(), confMat: makeChipMat() };
  }, []);
  useEffect(
    () => () => {
      chips.flakeGeo.dispose();
      chips.confGeo.dispose();
      chips.flakeMat.dispose();
      chips.confMat.dispose();
    },
    [chips],
  );

  // A long message wraps tall, so trade width for height rather than overflow the panel.
  const msgW = Math.min(MSG_W, MSG_H / Math.max(0.2, msg.aspect));
  // The flakes' two faces, kept off the frame loop: instanceColor wants the working
  // colour space, and re-parsing a hex string 150 times a frame is not free.
  const tone = useMemo(
    () => ({
      shine: new THREE.Color(foil.shine),
      dark: new THREE.Color(foil.dark),
      conf: foil.conf.map((c) => new THREE.Color(c)),
    }),
    [foil],
  );

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const cardRef = useRef<THREE.Group>(null);
  const stampRef = useRef<THREE.Mesh>(null);
  const tipRef = useRef<THREE.Mesh>(null);
  const flakeRef = useRef<THREE.InstancedMesh>(null);
  const confRef = useRef<THREE.InstancedMesh>(null);

  // Per-frame uniform writes go through a ref: the memo owns construction and
  // disposal, the frame owns state — and the lint only accepts mutation through a *Ref.
  const uniformsRef = useRef<FoilUniforms | null>(null);
  useLayoutEffect(() => {
    uniformsRef.current = foilRes.uniforms;
  }, [foilRes]);

  const flakes = useRef(makeFlakes());
  // `alone`: how long the card has been left to itself — the mercy floor's own clock
  const grab = useRef({ seeded: false, touched: false, ghost: 0, idle: 9, alone: 0, pu: 0.5, pv: 0.5, hu: 0.5, hv: 0.5 });
  const clearRef = useRef(-1);
  const ghostAtRef = useRef(0);
  const covRef = useRef(0);
  const pollRef = useRef(0);
  const introRef = useRef(0);
  const clockRef = useRef(0);
  const dirtyRef = useRef(true);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  /* The mask is the one thing here that accumulates, so it is rebuilt from `phase`
     alone: a replay must re-foil and re-scratch from scratch, and reduced motion
     lands on `revealed` having never run the opening. Nothing special is painted for
     `revealed` — uClear = 1 takes every scrap of foil regardless of the mask. */
  useLayoutEffect(() => {
    dirtyRef.current = true;
  }, [phase, mask]);

  const spray = (u0: number, v0: number, u1: number, v1: number, dx: number, dy: number, d: number) => {
    const f = flakes.current;
    f.debt = Math.min(5, f.debt + d * MASK_SPAN * FLAKE_PER_UNIT);
    let n = Math.floor(f.debt);
    f.debt -= n;
    while (n-- > 0) {
      const k = Math.random();
      spawnFlake(f, clockRef.current, uToX(lerp(u0, u1, k)), vToY(lerp(v0, v1, k)), dx, dy);
    }
  };

  const scrape = (u: number, v: number) => {
    const g = grab.current;
    if (g.seeded) {
      const du = u - g.pu;
      const dv = v - g.pv;
      const d = Math.hypot(du, dv);
      if (d > 1e-4) {
        // pointermove is sparse on a fast drag: a dab per event alone leaves a dotted trail
        mask.stroke(g.pu, g.pv, u, v, SCRATCH_R, "erase");
        spray(g.pu, g.pv, u, v, du / d, dv / d, d);
      }
    }
    g.seeded = true;
    g.touched = true;
    g.idle = 0;
    g.pu = u;
    g.pv = v;
    g.hu = u;
    g.hv = v;
  };

  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || clearRef.current >= 0 || !ev.uv) return;
    // A touch pointer only ever moves while it is down, and a mouse reports its
    // buttons on every event. Between them there is no press flag to latch — and so
    // no way for a stroke to weld itself on after the finger has quietly gone.
    if (ev.buttons === 0) {
      grab.current.seeded = false;
      return;
    }
    scrape(toMask(ev.uv.x), toMask(ev.uv.y));
  };

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || clearRef.current >= 0 || !ev.uv) return;
    const g = grab.current;
    g.seeded = false;
    scrape(toMask(ev.uv.x), toMask(ev.uv.y));
    // the press itself takes a dab: a tap with no drag should still lift some foil
    mask.paint(g.pu, g.pv, SCRATCH_R, "erase");
  };

  // Leaving the panel lifts the pen rather than ending the scratch: coming back must
  // not drag a chord across everything in between.
  const lift = () => {
    grab.current.seeded = false;
  };

  const ghostStroke = (from: number, to: number) => {
    for (let s = from + 1; s <= to; s++) {
      ghostAt(gp0, (s - 1) / GHOST_STEPS);
      ghostAt(gp1, s / GHOST_STEPS);
      mask.stroke(gp0.u, gp0.v, gp1.u, gp1.v, SCRATCH_R, "erase");
      const du = gp1.u - gp0.u;
      const dv = gp1.v - gp0.v;
      const d = Math.hypot(du, dv);
      if (d > 1e-5) spray(gp0.u, gp0.v, gp1.u, gp1.v, du / d, dv / d, d);
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    clockRef.current = e;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const g = grab.current;
    const f = flakes.current;
    const uni = uniformsRef.current;
    if (!uni) return; // the foil's uniforms are half this scene's state; nothing to pose without them
    g.idle += dt;

    /* ---------- fit ---------- */
    // The camera never moves, so viewport.height is a constant — which is precisely
    // why the card does not jump when GiftView mounts the message block and the
    // canvas loses a third of its pixels: only the width bound moves, and it only
    // ever bites on a phone. The house's `min(1, …)` cap is no use here; a scratch
    // panel whose corners you cannot reach is a broken gift, so this fits both axes
    // or nothing.
    fitRef.current?.scale.setScalar(
      Math.min(state.viewport.width / ACTION_W, state.viewport.height / ACTION_H),
    );

    /* ---------- the card, tipping ---------- */
    // A gallery card never sees a pointer, and a foil whose highlight does not move
    // is a gold rectangle — so the table breathes on its own as well.
    const sway = phase === "preview" ? 1 : phase === "sealed" ? 0.8 : opening && !g.touched ? 0.85 : 0.3;
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(
        tiltRef.current.rotation.x,
        state.pointer.y * 0.1 + Math.sin(e * 0.47) * 0.04 * sway,
        k,
      );
      tiltRef.current.rotation.z = lerp(
        tiltRef.current.rotation.z,
        -state.pointer.x * 0.11 + Math.sin(e * 0.31 + 1.1) * 0.05 * sway,
        k,
      );
    }

    if (dirtyRef.current) {
      dirtyRef.current = false;
      mask.reset();
      f.t0.fill(-99);
      f.debt = f.crumb = 0;
      g.seeded = g.touched = false;
      g.ghost = 0;
      g.idle = 9;
      g.alone = 0;
      ghostAtRef.current = 0;
      clearRef.current = -1;
      covRef.current = 0;
      pollRef.current = 0;
    }
    // Reduced motion lands here cold and gets ~40 frames of almost no clock, so the
    // slide is skipped outright rather than eased: `revealed` is at rest on frame one.
    if (phase === "revealed") introRef.current = 1;
    else introRef.current = Math.min(1, introRef.current + dt / SLIDE_DUR);

    /* ---------- has it been scratched enough ---------- */
    if (opening && clearRef.current < 0) {
      // The same gate the ghost runs on, and for the same reason: this is the card
      // sitting untouched, not the clock running. It stops dead under a working finger
      // and picks up again the beat after that finger goes, so a card tapped once and
      // walked away from still clears itself.
      if (g.idle > 0.3) g.alone += dt;
      pollRef.current -= dt;
      if (pollRef.current <= 0) {
        pollRef.current = COV_POLL;
        // coverage() spans the whole square mask and only the panel's share of it can
        // ever be scratched, so renormalize or the threshold is unreachable
        covRef.current = (1 - mask.coverage()) / COV_VIS;
      }
      if (covRef.current >= COV_TARGET || g.alone > T_MERCY_MAX || t > T_MERCY_MAX_HELD)
        clearRef.current = t;
    }

    /* ---------- the show ---------- */
    // One clock for the crumble, the stamp and the confetti, so `revealed` is just
    // this pinned at its end — and the opening lands exactly on that pose.
    const cyc = e % PREV_PERIOD;
    const reseal = phase === "preview" ? smooth(clamp01((cyc - PREV_SEAL) / PREV_SEAL_DUR)) : 0;
    const show =
      phase === "revealed"
        ? SHOW_DUR
        : phase === "preview"
          ? cyc - PREV_CLEAR
          : opening && clearRef.current >= 0
            ? t - clearRef.current
            : -1;

    /* ---------- the invisible finger ---------- */
    let gk = 0;
    if (phase === "preview") {
      // the whole gift on a loop: scratch, clear, stamp, confetti, and seal itself
      // back up for the next visitor
      gk = cyc < PREV_SEAL ? clamp01((cyc - PREV_START) / PREV_GHOST) : 0;
    } else if (opening) {
      if (clearRef.current < 0) {
        const mercy = smooth(clamp01((t - T_MERCY0) / MERCY_RAMP));
        // it yields the instant a real finger arrives and picks the card back up a
        // beat after that finger goes
        g.ghost = Math.min(1, g.ghost + (dt * (g.idle > 0.3 ? mercy : 0)) / GHOST_DUR);
      }
      gk = g.ghost;
    }
    let tipOn = g.idle < 0.1;
    const want = Math.round(gk * GHOST_STEPS);
    if (want < ghostAtRef.current) {
      // preview rewound: re-foil now, while uClear still has every scrap hidden
      mask.reset();
      ghostAtRef.current = 0;
    } else if (want > ghostAtRef.current) {
      const step = Math.min(want, ghostAtRef.current + GHOST_CATCHUP);
      ghostStroke(ghostAtRef.current, step);
      ghostAtRef.current = step;
      g.hu = gp1.u;
      g.hv = gp1.v;
      tipOn = true;
    }
    if (clearRef.current >= 0 || (!opening && phase !== "preview")) tipOn = false;

    /* ---------- the foil ---------- */
    const clearK = clamp01(show / CLEAR_DUR) * (1 - reseal);
    uni.uClear.value = clearK;

    // the last of it does not fade, it comes apart
    if (show >= 0 && show < CLEAR_DUR && clearK > 0.02) {
      f.crumb += dt * CRUMB_RATE;
      let n = Math.min(4, Math.floor(f.crumb));
      f.crumb -= n;
      while (n-- > 0) {
        const a = Math.random() * Math.PI * 2;
        spawnFlake(
          f,
          e,
          (Math.random() - 0.5) * PANEL * 0.94,
          PANEL_CY + (Math.random() - 0.5) * PANEL * 0.94,
          Math.cos(a),
          Math.sin(a),
        );
      }
    }

    /* ---------- the stamp ---------- */
    const sT = show - T_STAMP;
    const drop = clamp01(sT / PUNCH);
    const hit = 1 - Math.pow(1 - drop, 4); // it does not ease out, it hits
    const jolt = sT > PUNCH ? Math.exp(-(sT - PUNCH) * 15) : 0;
    const ring = Math.cos((sT - PUNCH) * 46);
    const st = stampRef.current;
    if (st) {
      st.visible = sT >= 0;
      if (st.visible) {
        // the rubber compresses on the strike and springs back; that beat is the weight
        st.scale.setScalar(lerp(STAMP_PUNCH, 1, hit) + jolt * 0.055 * ring);
        st.position.set(STAMP_CX, STAMP_CY, lerp(0.42, STAMP_Z, hit));
        st.rotation.z = lerp(STAMP_ROT - 0.19, STAMP_ROT, hit);
        // reached through the mesh, never through the memo binding: the memo owns
        // construction and disposal, the frame owns state
        (st.material as THREE.MeshBasicMaterial).opacity = (0.25 + 0.75 * hit * hit) * (1 - reseal);
      }
    }

    /* ---------- the card ---------- */
    const intro = easeOutCubic(introRef.current);
    if (cardRef.current) {
      // slid in from off the table, then knocked into it by the stamp
      cardRef.current.position.set(lerp(1.35, 0, intro), lerp(-1.15, 0, intro), -jolt * 0.016);
      cardRef.current.rotation.set(jolt * 0.03 * ring, 0, lerp(0.28, 0, intro) + jolt * 0.012 * ring);
    }

    /* ---------- the fingertip ---------- */
    if (tipRef.current) {
      const m = tipRef.current.material as THREE.MeshBasicMaterial;
      m.opacity += ((tipOn ? 0.55 : 0) - m.opacity) * Math.min(1, dt * 9);
      tipRef.current.visible = m.opacity > 0.01;
      tipRef.current.position.set(uToX(g.hu), vToY(g.hv), PANEL_Z + 0.001);
    }

    /* ---------- flakes ---------- */
    const fm = flakeRef.current;
    if (fm) {
      const fade = fm.geometry.attributes.aFade as THREE.InstancedBufferAttribute;
      for (let i = 0; i < FLAKE_N; i++) {
        const a = e - f.t0[i];
        if (a < 0 || a > FLAKE_LIFE) {
          tmpM.compose(tmpV.set(0, 0, 0), tmpQ.identity(), tmpS.set(0, 0, 0));
          fm.setMatrixAt(i, tmpM);
          // seeded even while dead: setColorAt is what allocates instanceColor, and
          // three recompiles the program the frame it first appears — which would
          // otherwise be the exact frame the finger first touches the foil
          fm.setColorAt(i, tone.dark);
          fade.setX(i, 0);
          continue;
        }
        const k = FLAKE_DRAG * (1 - Math.exp(-a / FLAKE_DRAG));
        const ang = f.s[i * 3] * a;
        tmpV.set(
          f.p[i * 3] + f.v[i * 3] * k,
          f.p[i * 3 + 1] + f.v[i * 3 + 1] * k,
          f.p[i * 3 + 2] + Math.max(0, f.v[i * 3 + 2] * a - 0.5 * FLAKE_G * a * a),
        );
        tmpAxis.set(f.ax[i * 3], f.ax[i * 3 + 1], f.ax[i * 3 + 2]);
        tmpM.compose(tmpV, tmpQ.setFromAxisAngle(tmpAxis, ang), tmpS.set(f.s[i * 3 + 1], f.s[i * 3 + 2], 1));
        fm.setMatrixAt(i, tmpM);
        // a chip of metal is only ever visible when it turns and catches something
        fm.setColorAt(i, tmpC.copy(tone.dark).lerp(tone.shine, Math.pow(Math.abs(Math.cos(ang)), 4)));
        fade.setX(i, clamp01((FLAKE_LIFE - a) / 0.25));
      }
      fm.instanceMatrix.needsUpdate = true;
      fade.needsUpdate = true;
      if (fm.instanceColor) fm.instanceColor.needsUpdate = true;
    }

    /* ---------- confetti ---------- */
    const cm = confRef.current;
    if (cm) {
      const fade = cm.geometry.attributes.aFade as THREE.InstancedBufferAttribute;
      const ca = show - T_STAMP - PUNCH;
      for (let i = 0; i < CONF_N; i++) {
        cm.setColorAt(i, tone.conf[Math.floor(CONF.tint[i] * tone.conf.length)]);
        if (ca < 0) {
          tmpM.compose(tmpV.set(0, 0, 0), tmpQ.identity(), tmpS.set(0, 0, 0));
          cm.setMatrixAt(i, tmpM);
          fade.setX(i, 0);
          continue;
        }
        const k = CONF_DRAG * (1 - Math.exp(-ca / CONF_DRAG));
        tmpV.set(
          STAMP_CX + CONF.ori[i * 3] + CONF.dir[i * 3] * k,
          STAMP_CY + CONF.ori[i * 3 + 1] + CONF.dir[i * 3 + 1] * k,
          Math.max(CONF_LAND, CONF.ori[i * 3 + 2] + CONF.dir[i * 3 + 2] * ca - 0.5 * CONF_G * ca * ca),
        );
        tmpAxis.set(CONF.ax[i * 3], CONF.ax[i * 3 + 1], CONF.ax[i * 3 + 2]);
        tmpQ.setFromAxisAngle(tmpAxis, CONF.spin[i] * k);
        // and it comes to rest lying flat, or the static tableau reads as a freeze-frame
        tmpFlat.setFromAxisAngle(Z_AXIS, CONF.roll[i]);
        tmpQ.slerp(tmpFlat, smooth(clamp01((ca - 0.85) / 0.55)));
        tmpM.compose(tmpV, tmpQ, tmpS.set(CONF.size[i * 2], CONF.size[i * 2 + 1], 1));
        cm.setMatrixAt(i, tmpM);
        fade.setX(i, 1 - reseal);
      }
      cm.instanceMatrix.needsUpdate = true;
      fade.needsUpdate = true;
      if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
    }

    if (opening && show >= SHOW_DUR && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      {/* Nearly overhead: a card on a table is unreadable at a raking angle, and the
          foil's highlight only travels when you are close to face-on. Everything
          under the flat-lay group below is authored in the tabletop's own xy. */}
      <PerspectiveCamera makeDefault position={[0, 4.02, 1.3]} fov={FOV} onUpdate={(c) => c.lookAt(0, 0, 0.02)} />
      <ambientLight intensity={0.4} color="#ffeedd" />
      {/* the key rides in over the viewer's shoulder, so the foil throws it back at them */}
      <directionalLight position={[-1.8, 4.4, 2.6]} intensity={1.7} color="#fff0d4" />
      <directionalLight position={[2.6, 2.2, -2.2]} intensity={0.45} color="#8fb4e0" />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          <group rotation={[-Math.PI / 2, 0, 0]}>
            {/* The table. Its falloff is its own edge, so there is no size at which it
                can leave a seam — which is the only way to survive aspect 0.46 → 2.53
                without measuring anything. */}
            <mesh position={[0, 0, -0.02]} renderOrder={-1}>
              <planeGeometry args={[9, 8]} />
              <meshBasicMaterial map={glowTex} color="#3a2b22" transparent opacity={0.92} depthWrite={false} />
            </mesh>
            {/* no shadow maps on this canvas: a soft dark plane under the card's foot */}
            <mesh position={[0.04, -0.06, -0.01]}>
              <planeGeometry args={[2.9, 3.2]} />
              <meshBasicMaterial map={glowTex} color="#000000" transparent opacity={0.55} depthWrite={false} />
            </mesh>

            <group ref={cardRef}>
              <mesh geometry={cardGeo} material={cardMat} />

              {/* the message, printed on the ticket and waiting under the foil */}
              <mesh position={[0, MSG_CY, FACE_Z + 0.0015]} renderOrder={1}>
                <planeGeometry args={[msgW, msgW * msg.aspect]} />
                <meshStandardMaterial
                  map={msg.texture}
                  color={foil.ink}
                  roughness={0.9}
                  transparent
                  depthWrite={false}
                />
              </mesh>

              {/* The foil, and its own hit target: the mask's uv is the panel's uv, so
                  a raycast's e.uv goes straight in and the fingertip lands where it
                  looks like it lands. */}
              <mesh
                position={[0, PANEL_CY, PANEL_Z]}
                geometry={panelGeo}
                material={foilRes.mat}
                renderOrder={2}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={lift}
                onPointerCancel={lift}
                onPointerOut={lift}
              />

              {/* the light the fingertip burnishes out of the metal as it lifts it */}
              <mesh ref={tipRef} geometry={quadGeo} scale={0.34} renderOrder={3} visible={false}>
                <meshBasicMaterial
                  map={glowTex}
                  color={foil.shine}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>

              <mesh ref={stampRef} material={inkMat} renderOrder={4} visible={false}>
                <planeGeometry args={[STAMP_W, STAMP_W * stamp.aspect]} />
              </mesh>

              <instancedMesh
                ref={flakeRef}
                args={[chips.flakeGeo, chips.flakeMat, FLAKE_N]}
                renderOrder={5}
                frustumCulled={false}
              />
              <instancedMesh
                ref={confRef}
                args={[chips.confGeo, chips.confMat, CONF_N]}
                renderOrder={6}
                frustumCulled={false}
              />
            </group>
          </group>
        </group>
      </group>
    </>
  );
}
