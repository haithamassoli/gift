import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";

/* ---------- palettes ---------- */
// The metal has to change the material read, not a tint. Brass is warm and only
// half-polished; silver is a near-mirror that lives off what the sky gives it;
// night-steel is blued — matte, barely metallic, and it takes light like slate.
interface Metal {
  body: string;
  deep: string;
  rough: number;
  metalness: number;
  env: number;
  engrave: string; // the colour the cut lines fill with
  index: string; // the inlaid stars at each ring's index
  peak: number; // how hard emissive has to push before this body shows it
}
const METALS: Record<string, Metal> = {
  brass: {
    body: "#b3862f", deep: "#6b4914", rough: 0.46, metalness: 0.97, env: 1.1,
    engrave: "#ffd07a", index: "#ffeab4", peak: 1.0,
  },
  silver: {
    body: "#b6bec7", deep: "#5a636d", rough: 0.24, metalness: 0.99, env: 1.45,
    engrave: "#dff0ff", index: "#ffffff", peak: 0.82,
  },
  "night-steel": {
    body: "#333a48", deep: "#141821", rough: 0.66, metalness: 0.82, env: 0.85,
    engrave: "#79b4ff", index: "#c2dcff", peak: 1.5,
  },
};

// The sky is not a backdrop swatch: it builds the env map the metal reflects, so
// picking it relights the instrument itself.
interface Sky {
  top: string;
  mid: string;
  horizon: string;
  glow: string;
  stars: number;
  key: string;
  keyI: number;
  fill: string;
  fillI: number;
  amb: number;
  ambC: string;
  chart: string;
}
const SKIES: Record<string, Sky> = {
  dawn: {
    top: "#101f40", mid: "#3a3a66", horizon: "#c2704a", glow: "#ffb36b",
    stars: 80, key: "#ffd3a4", keyI: 1.55, fill: "#5b7ec4", fillI: 0.72,
    amb: 0.30, ambC: "#ffe2c4", chart: "#ffd9a8",
  },
  dusk: {
    top: "#180e2e", mid: "#48224e", horizon: "#8a3a52", glow: "#ff7d5e",
    stars: 175, key: "#ffab8c", keyI: 1.22, fill: "#7f61d4", fillI: 0.82,
    amb: 0.23, ambC: "#e0c0ff", chart: "#ffc2dc",
  },
  night: {
    top: "#03050d", mid: "#0a1226", horizon: "#1d2c4c", glow: "#4a6ea8",
    stars: 320, key: "#c0d6ff", keyI: 1.15, fill: "#2c3f6a", fillI: 0.6,
    amb: 0.24, ambC: "#9fb8e8", chart: "#aad6ff",
  },
};

/* ---------- the instrument, radially, outside in ---------- */
const FOV = 42;
const CAM_Z = 5.9;
const INST_Y = -0.2; // the mater's centre in tilt space
const PIVOT_Y = INST_Y + 1.6; // where it hangs from
const R_MATER = 1.25;
const R_SCALE = 1.185; // the degree scale, cut just inside the limb
const SCALE_BAND = 0.06;
const R_RIM = 1.02; // the inscription's mid-radius
const RIM_H = 0.15; // …and the band width it wants, if the words will allow it
const RIM_H_MAX = 0.26;
const RIM_TH_MIN = 0.5;
const RIM_TH_MAX = 5.5;
const RING_R = [0.8, 0.625, 0.45];
const RING_TUBE = 0.05;
const R_PLATE = 0.405;
const NAME_W = 0.7;
const NAME_H = 0.26;
// Limb to limb is 2·(R_MATER + the limb torus's own tube) = 2.62, not 2·R_MATER —
// measured at aspect 0.46, where the smaller span had the brass touching both edges.
const ACTION_W = 3.0;
const DEAD_R = 0.26; // atan2 says nothing useful this close to the centre

/* ---------- opening timeline (seconds) ---------- */
const TARGET = 0; // every ring is aligned at rotation.z ≡ 0
const OFFSET = [2.05, -2.42, 1.78]; // …and starts this far from it
const MAGNET = 0.95; // ±54°: get it this close and the ring does the rest
const MAGNET_K = 13;
const SNAP_TOL = 0.11; // the magnet has already closed it; this only latches
const T_SETTLE = 0.4; // the beat between one ring clicking and the next waking
const T_ASSIST_WAIT = 2.2; // stillness the instrument allows before it helps
const T_ASSIST_RAMP = 1.1;
const T_HARD_LEAD = 4.0; // a backstop under the idle clock: this can never lock
const ASSIST_SPEED = 3.2;
const REVEAL_HOLD = 2.9; // the show after the third click — the mercy budget
const PREV_PERIOD = 15;
const PREV_SNAP0 = 2.6;
const PREV_STEP = 1.6;
const PREV_SPIN = 1.5;
const PREV_OUT = 12.4;
const PREV_LAST = PREV_SNAP0 + 2 * PREV_STEP;

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();
const starTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,1)"],
  [0.22, "rgba(255,255,255,0.55)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- arabesque ---------- */
// Cheaper and better than geometry: cut the strapwork once into a canvas and let
// the material read it twice. One draw, two textures, because the two readings
// disagree — light wants the groove white, wear wants it dark.
function buildArabesque() {
  const S = 256;
  const C = S / 2; // the star lattice repeats on a half-canvas cell, so it tiles
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  g.lineJoin = "round";

  // the eight-point khatim: two squares, one turned 45° — the workhorse of the craft
  const khatim = (cx: number, cy: number, r: number, lw: number) => {
    g.lineWidth = lw;
    for (let k = 0; k < 2; k++) {
      g.beginPath();
      for (let i = 0; i <= 4; i++) {
        const a = (k * Math.PI) / 4 + (i * Math.PI) / 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
  };

  for (let ty = -1; ty <= 2; ty++)
    for (let tx = -1; tx <= 2; tx++) {
      const cx = (tx + 0.5) * C;
      const cy = (ty + 0.5) * C;
      khatim(cx, cy, C * 0.3, 3);
      khatim(cx, cy, C * 0.145, 1.6);
      // Each tip reaches for a neighbour's: the orthogonals meet at the cell edge,
      // the diagonals at the corner, so the field closes into one continuous band.
      g.lineWidth = 2.2;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const reach = i % 2 === 0 ? C * 0.5 : C * 0.5 * Math.SQRT2;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * C * 0.3, cy + Math.sin(a) * C * 0.3);
        g.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
        g.stroke();
      }
      khatim(cx + C / 2, cy + C / 2, C * 0.105, 1.4); // the rosette the diagonals feed
    }

  const src = g.getImageData(0, 0, S, S).data;
  const mk = (paint: (v: number, o: Uint8ClampedArray, i: number) => void) => {
    const cc = document.createElement("canvas");
    cc.width = cc.height = S;
    const gg = cc.getContext("2d")!;
    const img = gg.createImageData(S, S);
    for (let i = 0; i < src.length; i += 4) paint(src[i] / 255, img.data, i);
    gg.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cc);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  // the groove, white on black: what lights up, and what dents the surface
  const light = mk((v, o, i) => {
    o[i] = o[i + 1] = o[i + 2] = Math.round(v * 255);
    o[i + 3] = 255;
  });
  // green scales roughness, blue scales metalness — the field is burnished to a
  // mirror while the cut lines stay matte and hold their tarnish
  const wear = mk((v, o, i) => {
    o[i] = 255;
    o[i + 1] = Math.round(255 * (0.45 + 0.55 * v));
    o[i + 2] = Math.round(255 * (1 - 0.35 * v));
    o[i + 3] = 255;
  });
  return { light, wear };
}
const ARAB = buildArabesque();
// repeat lives on the texture, not the material, so each surface needs its own
// view of the same canvas — clones share the upload and cost nothing
const arabRingL = ARAB.light.clone();
const arabRingW = ARAB.wear.clone();
arabRingL.repeat.set(10, 1.6);
arabRingW.repeat.set(10, 1.6);
ARAB.light.repeat.set(3.2, 3.2);
ARAB.wear.repeat.set(3.2, 3.2);

/* ---------- the plate ---------- */
// A real tympan is a stereographic projection of the sky from the south pole:
// declination δ lands at radius tan(45° - δ/2), so the equator is 1 and Capricorn
// is 1.523. The almucantars — circles of equal altitude around the zenith — are
// what make it unmistakably an astrolabe, and they fall straight out of that.
const LAT = (33 * Math.PI) / 180; // Baghdad, near enough
const proj = (dec: number) => Math.tan(Math.PI / 4 - dec / 2);
function buildPlateTexture(): THREE.CanvasTexture {
  const S = 512;
  const cx = S / 2;
  const cy = S / 2;
  const R = S * 0.46;
  const U = R / proj(-23.44 * (Math.PI / 180)); // scale so Capricorn lands on the rim
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  const circle = (ox: number, oy: number, r: number) => {
    g.beginPath();
    g.arc(cx + ox * U, cy - oy * U, r * U, 0, Math.PI * 2);
    g.stroke();
  };

  // everything is cut inside the limb
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.clip();

  // almucantars: the circle of altitude h has its meridian ends at declinations
  // φ ± (90° - h); project both and the circle is just the segment between them
  for (let h = 0; h <= 80; h += 10) {
    const rho = Math.PI / 2 - (h * Math.PI) / 180;
    const yA = proj(LAT + rho); // goes negative past the pole, which is correct
    const yB = proj(LAT - rho);
    g.lineWidth = h === 0 ? 2.6 : 1.1;
    g.globalAlpha = h === 0 ? 1 : 0.62;
    circle(0, (yA + yB) / 2, Math.abs(yB - yA) / 2);
  }
  // azimuths: every one passes through zenith and nadir, so their centres all sit
  // on that chord's bisector and only the offset changes
  const yZ = proj(LAT); // zenith, declination φ on the near meridian
  const yN = -proj(-LAT); // nadir, declination -φ on the far one
  const d = (yZ - yN) / 2;
  g.lineWidth = 0.9;
  g.globalAlpha = 0.4;
  for (const az of [30, 60]) {
    const xc = d / Math.tan((az * Math.PI) / 180);
    const r = Math.hypot(xc, d);
    circle(xc, yZ - d, r);
    circle(-xc, yZ - d, r);
  }
  circle(0, yZ - d, d); // the prime vertical
  g.globalAlpha = 0.5;
  g.lineWidth = 1;
  g.beginPath(); // the meridian
  g.moveTo(cx, cy - R);
  g.lineTo(cx, cy + R);
  g.stroke();
  // hour lines below the horizon — the unequal hours, the plate's other half
  g.globalAlpha = 0.3;
  for (let i = 1; i < 12; i++) {
    const a = (i * Math.PI) / 12;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * R, cy + Math.sin(a) * R * 0.98);
    g.quadraticCurveTo(cx, cy + R * 0.5, cx + Math.cos(a) * R, cy + Math.sin(a) * R * 0.98);
    g.stroke();
  }
  g.restore();

  // the three declination circles the whole plate hangs off
  g.globalAlpha = 0.9;
  for (const [dec, lw] of [[-23.44, 2.4], [0, 1.6], [23.44, 1.6]] as const) {
    g.lineWidth = lw;
    circle(0, 0, proj((dec * Math.PI) / 180));
  }

  // and the stars themselves, which is what the rings are arguing about
  const rand = mulberry32(9271);
  g.globalAlpha = 1;
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * R * 0.95;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    const m = 1 + Math.pow(rand(), 2) * 3.4;
    const gr = g.createRadialGradient(px, py, 0, px, py, m * 2.4);
    gr.addColorStop(0, "#fff");
    gr.addColorStop(0.35, "rgba(255,255,255,0.5)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(px - m * 2.4, py - m * 2.4, m * 4.8, m * 4.8);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
const plateTex = buildPlateTexture();

/* ---------- the degree scale ---------- */
// 360 ticks in one strip; the annulus below wraps it exactly once round the limb.
function buildScaleTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 48;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  for (let i = 0; i < 360; i++) {
    const x = ((i + 0.5) / 360) * W;
    const long = i % 30 === 0;
    const mid = i % 5 === 0;
    g.lineWidth = long ? 2.6 : mid ? 1.6 : 0.9;
    g.globalAlpha = long ? 1 : mid ? 0.8 : 0.45;
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x, H - (long ? H * 0.8 : mid ? H * 0.5 : H * 0.28));
    g.stroke();
  }
  g.globalAlpha = 0.7; // the rule the ticks hang from
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(0, H - 1);
  g.lineTo(W, H - 1);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}
const scaleTex = buildScaleTexture();

/* ---------- the sky, twice: once to look at, once for the metal to reflect ---------- */
function skyStops(g: CanvasGradient, s: Sky) {
  g.addColorStop(0, s.top);
  g.addColorStop(0.52, s.mid);
  g.addColorStop(0.84, s.horizon);
  g.addColorStop(1, s.glow);
}
function buildSkyTexture(s: Sky): THREE.CanvasTexture {
  const W = 16;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, H);
  skyStops(grad, s);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// A metal with no envMap renders black — direct lights only give it specular
// dots. Twenty lines of canvas is the difference between brass and grey plastic.
function buildEnvTexture(s: Sky): THREE.Texture {
  const W = 256;
  const H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Not the same gradient as the backdrop: an env map is everything the metal can
  // see, and half of that is the ground throwing the horizon back up at it. Skip
  // the bounce and a polished limb reflects only dark sky and reads as brown card.
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, s.top);
  grad.addColorStop(0.44, s.mid);
  grad.addColorStop(0.62, s.horizon);
  grad.addColorStop(0.72, s.glow); // the band the sun is behind
  grad.addColorStop(1, s.horizon); // and the warm floor under it
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(64, 86, 92, s.glow); // where the sun has not quite arrived
  blob(196, 40, 30, s.fill); // the cold quarter, which is what silver lives off
  blob(150, 96, 60, s.glow);
  const rand = mulberry32(4242);
  for (let i = 0; i < s.stars / 3; i++) {
    const x = rand() * W;
    const y = rand() * H * 0.7;
    blob(x, y, 1.4 + rand() * 1.6, "rgba(255,255,255,0.9)");
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const SKY_TEX: Record<string, THREE.CanvasTexture> = {};
const ENV_TEX: Record<string, THREE.Texture> = {};
for (const k of Object.keys(SKIES)) {
  SKY_TEX[k] = buildSkyTexture(SKIES[k]);
  ENV_TEX[k] = buildEnvTexture(SKIES[k]);
}

/* ---------- the inscription's surface ---------- */
// Text has to curve round the limb, and a RingGeometry cannot carry it: three
// gives a ring *planar* uvs, so a texture lands on it flat with a hole punched
// through. An open cylinder already has the uvs I want — u around, v along the
// axis — so take one and press it flat into the plane, keeping the uvs. The
// result is an annulus with polar uvs: the raster wraps round the rim on its own,
// letter tops facing outward, and nothing is mirrored, so Arabic reads the way
// makeTextTexture laid it out.
function buildAnnulusGeo(rMid: number, band: number, thetaStart: number, thetaLength: number) {
  const seg = Math.max(24, Math.round((thetaLength / (Math.PI * 2)) * 128));
  const g = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true, thetaStart, thetaLength);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // x = sinθ, z = cosθ, y = ±0.5 — so y is already the radial coordinate
    const r = rMid + p.getY(i) * band;
    p.setXYZ(i, r * p.getX(i), r * p.getZ(i), 0);
  }
  p.needsUpdate = true;
  g.deleteAttribute("normal"); // flat, unlit and double-sided; winding is moot
  return g;
}
const scaleGeo = buildAnnulusGeo(R_SCALE, SCALE_BAND, 0, Math.PI * 2);

/* ---------- the instrument ---------- */
const ringGeo = RING_R.map((r) => new THREE.TorusGeometry(r, RING_TUBE, 10, 96));
const materGeo = new THREE.CylinderGeometry(R_MATER, R_MATER, 0.09, 96);
const limbGeo = new THREE.TorusGeometry(R_MATER, 0.06, 10, 96);
const plateGeo = new THREE.CircleGeometry(R_PLATE, 72);
const reteGeo = new THREE.TorusGeometry(0.385, 0.014, 8, 72);
const eclipticGeo = new THREE.TorusGeometry(0.235, 0.013, 8, 56); // eccentric, as it must be
const hangGeo = new THREE.TorusGeometry(0.115, 0.026, 10, 40);
const shackleGeo = new THREE.TorusGeometry(0.055, 0.02, 8, 28);
const pointerGeo = new THREE.SphereGeometry(0.022, 10, 8);
const armGeo = new THREE.CylinderGeometry(0.006, 0.009, 1, 6);

// The same eight-point star as the strapwork, inlaid at each ring's index. Three
// of them stack at the top when the instrument agrees with itself.
function buildStarGeo(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 16; i++) {
    const r = i % 2 ? 0.42 : 1;
    const a = (i / 16) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i) s.lineTo(x, y);
    else s.moveTo(x, y);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.28, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.1, bevelSegments: 2,
  });
  g.center();
  return g;
}
const starGeo = buildStarGeo();

// The kursi: lobed shoulders carrying the neck the shackle swings in.
function buildThroneGeo(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.3, 0);
  s.lineTo(-0.22, 0.1);
  s.quadraticCurveTo(-0.15, 0.2, -0.075, 0.185);
  s.lineTo(-0.05, 0.25);
  s.lineTo(0.05, 0.25);
  s.lineTo(0.075, 0.185);
  s.quadraticCurveTo(0.15, 0.2, 0.22, 0.1);
  s.lineTo(0.3, 0);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, {
    depth: 0.075, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012,
    bevelSegments: 2, curveSegments: 12,
  });
}
const throneGeo = buildThroneGeo();

// The index the whole puzzle is measured against: a wedge cut into the limb at 12.
const indexGeo = new THREE.ConeGeometry(0.05, 0.11, 3);

/* ---------- the sky's own stars ---------- */
const STARS_MAX = 320;
function buildStars() {
  const rand = mulberry32(31415);
  const pos = new Float32Array(STARS_MAX * 3);
  const ph = new Float32Array(STARS_MAX);
  const mag = new Float32Array(STARS_MAX);
  for (let i = 0; i < STARS_MAX; i++) {
    pos[i * 3] = (rand() * 2 - 1) * 13;
    pos[i * 3 + 1] = (rand() * 2 - 1) * 5.2;
    pos[i * 3 + 2] = -6.6 - rand() * 0.8;
    ph[i] = rand() * Math.PI * 2;
    mag[i] = Math.pow(rand(), 2.4); // a handful bright, a great many faint
  }
  return { pos, ph, mag, col: new Float32Array(STARS_MAX * 3) };
}
const STARS = buildStars();

/* ---------- the rete's star pointers ---------- */
const POINTERS = (() => {
  const rand = mulberry32(1187);
  return Array.from({ length: 5 }, () => {
    const a = rand() * Math.PI * 2;
    const r = 0.14 + rand() * 0.22;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, a, r };
  });
})();

/* ---------- helpers ---------- */
const wrapPi = (a: number) => {
  const x = (a + Math.PI) % (Math.PI * 2);
  return (x < 0 ? x + Math.PI * 2 : x) - Math.PI;
};
// the click, and the ring rocking to rest on it — a pure function of its own age
const bounce = (age: number) =>
  age < 0 ? 0 : Math.exp(-age * 8) * Math.sin(age * 34) * 0.085;
// sealed: the escapement lets go every ~3s. Quantized, and it comes back, so the
// ring never wanders off its offset and "opening" starts where "sealed" stopped.
const escape = (e: number, i: number) => {
  const x = e * 0.31 + i * 0.29;
  const tri = 2 * Math.abs(x - Math.floor(x + 0.5));
  return (Math.round(tri * 6) / 6 - 0.5) * 0.09;
};

const tmpV = new THREE.Vector3();
const ANG = [0, 0, 0];
const AGE = [-1, -1, -1];

export default function AstrolabeScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const metal = METALS[variants.metal] ?? METALS.brass;
  const skyKey = SKIES[variants.sky] ? variants.sky : "dawn";
  const sky = SKIES[skyKey];
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" on the gallery card and live-per-keystroke from /create, so
  // this can never require one and can never cache on its absence.
  const rimSource = message.trim() || forRecipient(lang, recipientName);
  const rim = useMemo(() => {
    // one unbroken line of markings: paragraph breaks become separators, and the
    // canvas stays a sane width whatever the sender does with their 280 chars
    const one = rimSource.replace(/\s*\n+\s*/g, "  ·  ").slice(0, 200);
    // /create re-rasterizes this on every keystroke, so the canvas stays only as
    // big as the arc can actually show — a 200-char line at 36px is ~3600 wide.
    const { texture, aspect } = makeTextTexture(one, {
      fontSize: 36, fontWeight: "600", color: "#ffffff", maxWidthPx: 1e6, padding: 18, lang,
    });
    // Long words wrap small and far round the limb; short ones stand tall on a
    // short arc. Either way the letters keep their proportions — the arc gives,
    // not the type.
    let theta = RIM_H / (aspect * R_RIM);
    let h = RIM_H;
    if (theta > RIM_TH_MAX || theta < RIM_TH_MIN) {
      theta = Math.min(RIM_TH_MAX, Math.max(RIM_TH_MIN, theta));
      h = Math.min(theta * aspect * R_RIM, RIM_H_MAX);
    }
    return { texture, geo: buildAnnulusGeo(R_RIM, h, -theta / 2, theta) };
  }, [rimSource, lang]);
  useEffect(() => () => { rim.texture.dispose(); rim.geo.dispose(); }, [rim]);

  // The names go on the plate, under the pierced rete — where you read a real one.
  const names = useMemo(() => {
    const joined = [recipientName.trim(), senderName.trim()].filter(Boolean).join("  ·  ");
    if (!joined) return null;
    const { texture, aspect } = makeTextTexture(joined, {
      fontSize: 60, fontWeight: "600", color: "#ffffff", maxWidthPx: 620, padding: 24, lang,
    });
    const w = aspect * NAME_W > NAME_H ? NAME_H / aspect : NAME_W;
    return { texture, w, h: w * aspect };
  }, [recipientName, senderName, lang]);
  useEffect(() => () => names?.texture.dispose(), [names]);

  const mats = useMemo(() => {
    const env = ENV_TEX[skyKey];
    const mk = (color: string, rough: number, l: THREE.Texture | null, w: THREE.Texture | null) =>
      new THREE.MeshStandardMaterial({
        color, roughness: rough, metalness: metal.metalness,
        roughnessMap: w, metalnessMap: w,
        emissiveMap: l, bumpMap: l, bumpScale: l ? -0.004 : 0,
        envMap: env, envMapIntensity: metal.env,
        emissive: new THREE.Color(metal.engrave), emissiveIntensity: 0,
      });
    const idx = () =>
      new THREE.MeshStandardMaterial({
        color: metal.index, roughness: 0.2, metalness: 0.6, envMap: env,
        envMapIntensity: metal.env, emissive: new THREE.Color(metal.index),
        emissiveIntensity: 0,
      });
    return {
      // The rings are left plain and burnished on purpose. The arabesque is the
      // *field's* job; give the rings the same cut lines and all five surfaces
      // read as one engraved disc and the thing you are meant to turn disappears.
      rings: [0, 1, 2].map(() => mk(metal.body, metal.rough * 0.85, null, null)),
      stars: [0, 1, 2].map(idx),
      // each pointer lights on its own beat, so each needs its own material
      points: POINTERS.map(idx),
      index: idx(),
      mater: mk(metal.body, metal.rough, ARAB.light, ARAB.wear),
      trim: mk(metal.deep, Math.min(1, metal.rough * 1.25), arabRingL, arabRingW),
      // The plate wears the projection it will later throw on the sky. It sits
      // recessed under the rete, so it barely sees the sky — hand it the env at
      // full strength and it lights up as bright as the limb and the names, which
      // are additive over it, vanish into their own ground.
      plate: new THREE.MeshStandardMaterial({
        color: "#120b06", roughness: 0.85, metalness: 0.4,
        envMap: env, envMapIntensity: metal.env * 0.1, emissiveMap: plateTex,
        emissive: new THREE.Color(metal.engrave), emissiveIntensity: 0,
      }),
      // brass, not the inlay's white — the rete has to sit *on* the plate, not
      // hover over it as a separate bright object
      rete: mk(metal.body, metal.rough * 0.5, null, null),
    };
  }, [metal, skyKey]);
  useEffect(
    () => () => {
      for (const m of [
        ...mats.rings, ...mats.stars, ...mats.points,
        mats.index, mats.mater, mats.trim, mats.plate, mats.rete,
      ])
        m.dispose();
    },
    [mats],
  );

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const hangRef = useRef<THREE.Group>(null);
  const hitRef = useRef<THREE.Mesh>(null);
  // The memo owns construction and disposal; the frame owns state — so every
  // material is reached through the object carrying it, never through the memo.
  const ringsRef = useRef<(THREE.Group | null)[]>([]);
  const ringMeshRef = useRef<(THREE.Mesh | null)[]>([]);
  const starMeshRef = useRef<(THREE.Mesh | null)[]>([]);
  const pointMeshRef = useRef<(THREE.Mesh | null)[]>([]);
  const sparksRef = useRef<(THREE.Sprite | null)[]>([]);
  const materMeshRef = useRef<THREE.Mesh>(null);
  const indexMeshRef = useRef<THREE.Mesh>(null);
  const limbMeshRef = useRef<THREE.Mesh>(null);
  const plateMeshRef = useRef<THREE.Mesh>(null);
  const reteMeshRef = useRef<THREE.Mesh>(null);
  const chartRef = useRef<THREE.Mesh>(null);
  const chartMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const chartGlowRef = useRef<THREE.MeshBasicMaterial>(null);
  const rimMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const scaleMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const nameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const nameGlowRef = useRef<THREE.SpriteMaterial>(null);
  const hintRef = useRef<THREE.Sprite>(null);
  const hintMatRef = useRef<THREE.SpriteMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const skyStarsRef = useRef<THREE.Points>(null);

  const gest = useRef({
    ang: [0, 0, 0],
    snapT: [-1, -1, -1],
    live: 0,
    drag: false,
    seeded: false, // …and whether it has an angle to measure the next one against
    prevA: 0,
    idle: 0,
    touched: false,
  });

  // Replay re-enters "opening" and the clock resets, so the rings have to as
  // well — otherwise run two starts with the puzzle already solved.
  useLayoutEffect(() => {
    const g = gest.current;
    for (let i = 0; i < 3; i++) {
      g.ang[i] = OFFSET[i];
      g.snapT[i] = -1;
    }
    g.live = 0;
    g.drag = false;
    g.seeded = false;
    g.idle = 0;
    g.touched = false;
  }, [phase]);

  /* ---------- the rotate ---------- */
  // The angle *about the instrument's centre*, not the pointer's x: the moment a
  // hand crosses the middle, x reverses meaning and the ring would jump backwards.
  const localAngle = (ev: ThreeEvent<PointerEvent>) => {
    const h = hitRef.current;
    if (!h) return null;
    h.worldToLocal(tmpV.copy(ev.point));
    if (tmpV.x * tmpV.x + tmpV.y * tmpV.y < DEAD_R * DEAD_R) return null; // atan2 is noise here
    return Math.atan2(tmpV.y, tmpV.x);
  };
  const stop = () => {
    gest.current.drag = false;
    gest.current.seeded = false;
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — pointerout below covers its absence */
    }
    const a = localAngle(ev);
    const g = gest.current;
    g.touched = true;
    g.idle = 0;
    // A press is a grab wherever it lands — the dead zone owes it no angle yet,
    // but it is still a hand on the instrument. Seed on the first move that
    // leaves it; a grab that starts on the rete and drags out has to turn the
    // ring, not sit there doing nothing until the finger lifts.
    g.drag = true;
    g.seeded = a !== null;
    if (a !== null) g.prevA = a;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const g = gest.current;
    if (!g.drag || phase !== "opening" || g.live >= 3) return;
    const a = localAngle(ev);
    if (a === null) {
      g.seeded = false; // dragged through the middle — measure again on the far side
      return;
    }
    g.idle = 0;
    if (!g.seeded) {
      g.seeded = true;
      g.prevA = a;
      return;
    }
    const d = wrapPi(a - g.prevA);
    g.prevA = a;
    // a captured pointer parks at its last hit and jumps on re-entry
    if (Math.abs(d) < 1) g.ang[g.live] += d;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const g = gest.current;

    /* fit the limb into narrow (portrait) viewports */
    const fit = Math.max(0.68, Math.min(1, state.viewport.width / ACTION_W));
    fitRef.current?.scale.setScalar(fit);

    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.07, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.08, k);
    }

    /* ---- where each ring stands, and how far the reveal has got ---- */
    let tau: number; // clock since the third click; < 0 until then
    let rev: number; // …and how much of that show is wanted at all
    let hint = 0;

    if (phase === "opening") {
      if (!g.drag) g.idle += dt;
      // Eased in after 2.2s of stillness: the rings finding each other, not a
      // timer firing. A backstop under the idle clock keeps the no-input path
      // honest even if someone drags forever without ever crossing alignment.
      const gain = smooth(
        clamp01((Math.max(g.idle, t - T_HARD_LEAD) - T_ASSIST_WAIT) / T_ASSIST_RAMP),
      );
      const i = g.live;
      if (i < 3 && (i === 0 || t - g.snapT[i - 1] > T_SETTLE)) {
        let d = wrapPi(g.ang[i] - TARGET);
        // ±54° of magnetism is the whole design: a careless drag still lands, and
        // the pull is what makes the click feel earned rather than checked for.
        if (Math.abs(d) < MAGNET) {
          g.ang[i] -= d * Math.min(1, MAGNET_K * (1 - Math.abs(d) / MAGNET) * dt);
          d = wrapPi(g.ang[i] - TARGET);
        }
        if (gain > 0) {
          const step = Math.sign(d) * ASSIST_SPEED * gain * dt;
          g.ang[i] -= Math.abs(step) > Math.abs(d) ? d : step;
          d = wrapPi(g.ang[i] - TARGET);
        }
        if (Math.abs(d) < SNAP_TOL) {
          g.ang[i] -= d; // land on the exact multiple of 2π — no jump, no residue
          g.snapT[i] = t;
          g.live = i + 1;
        }
      }
      for (let k = 0; k < 3; k++) {
        ANG[k] = g.ang[k];
        AGE[k] = g.snapT[k] < 0 ? -1 : t - g.snapT[k];
      }
      tau = g.live >= 3 ? t - g.snapT[2] : -1;
      rev = 1;
      // Once the third has clicked there is nothing left waiting to be turned, so
      // the light goes out with the show starting. `revealed` has no hint at all —
      // leave it lit and it vanishes at the phase flip instead of landing on the
      // revealed pose. Only the untouched (mercy) path ever gets this far with it on.
      if (!g.touched) hint = clamp01((t - 1) / 0.8) * (1 - clamp01(tau / 0.4));
    } else if (phase === "revealed") {
      // A complete tableau from `phase` alone — reduced motion lands here cold.
      for (let k = 0; k < 3; k++) {
        ANG[k] = 0;
        AGE[k] = 99;
      }
      tau = REVEAL_HOLD;
      rev = 1;
    } else if (phase === "preview") {
      // the whole gift on a loop: three rings find their index, the sky answers,
      // it fades, the rings wander back out. Never asks for a finger.
      const cyc = e % PREV_PERIOD;
      const out = smooth(clamp01((cyc - PREV_OUT) / 1.6));
      for (let k = 0; k < 3; k++) {
        const s = PREV_SNAP0 + k * PREV_STEP;
        if (cyc < s) {
          ANG[k] = OFFSET[k] * (1 - smooth(clamp01((cyc - (s - PREV_SPIN)) / PREV_SPIN)));
          AGE[k] = -1;
        } else {
          ANG[k] = 0;
          AGE[k] = cyc - s;
        }
        ANG[k] = lerp(ANG[k], OFFSET[k], out); // …and back to the top of the loop
      }
      tau = cyc - PREV_LAST;
      rev = 1 - out;
    } else {
      for (let k = 0; k < 3; k++) {
        ANG[k] = OFFSET[k] + escape(e, k);
        AGE[k] = -1;
      }
      tau = -1;
      rev = 0;
    }

    /* ---- the show, staged off τ, gated by rev ---- */
    const lit = tau >= 0;
    const fillK = (lit ? smooth(clamp01((tau - 0.15) / 1)) : 0) * rev;
    const chartK = (lit ? smooth(clamp01((tau - 0.35) / 1.7)) : 0) * rev;
    const rimK = (lit ? smooth(clamp01((tau - 0.55) / 1.2)) : 0) * rev;
    const flash = (lit ? Math.exp(-tau * 4.2) : 0) * rev;

    /* ---- it hangs, and the third click rocks it ---- */
    if (hangRef.current)
      hangRef.current.rotation.z =
        0.02 * Math.sin(e * 0.62) + 0.012 * Math.sin(e * 0.41 + 1) + flash * 0.055 * Math.sin(tau * 40);

    /* ---- the rings ---- */
    const emis = (m: THREE.Mesh | null | undefined, v: number) => {
      if (m) (m.material as THREE.MeshStandardMaterial).emissiveIntensity = v * metal.peak;
    };
    for (let k = 0; k < 3; k++) {
      const ring = ringsRef.current[k];
      if (ring) ring.rotation.z = ANG[k] + bounce(AGE[k]);
      const clickK = AGE[k] >= 0 ? Math.exp(-AGE[k] * 3.5) : 0;
      const live = phase === "opening" && g.live === k;
      // Every channel of the look rides one scalar, so no metal floods on a path
      // the others don't take.
      // The rings carry no emissiveMap, so emissive has no grooves to hide in and
      // floods the whole tube — push it and brass turns to pale bone. Light the
      // *field's* engraving instead; the ring only needs to acknowledge the click.
      emis(
        ringMeshRef.current[k],
        0.02 + fillK * 0.1 + clickK * 0.55 + (live ? 0.12 + 0.07 * Math.sin(e * 4) : 0),
      );
      emis(starMeshRef.current[k], 0.1 + fillK * 1.5 + clickK * 2.4);
      const sp = sparksRef.current[k];
      if (sp) {
        const a = AGE[k];
        const on = a >= 0 && a < 1.2;
        sp.visible = on;
        if (on) {
          sp.scale.setScalar(0.1 + easeOutCubic(clamp01(a / 0.25)) * 0.42);
          (sp.material as THREE.SpriteMaterial).opacity = Math.exp(-a * 7);
        }
      }
    }
    // The cut lines never go fully dark, and breathe a little even sealed: this is
    // the "engraved arabesques catching the light" the instrument is meant to show
    // at rest, and without it night-steel under a night sky is a black disc.
    const idle = 0.11 + 0.025 * Math.sin(e * 0.9);
    emis(materMeshRef.current, idle + fillK * 0.68);
    // the index never goes dark: it is the thing being aimed at
    emis(indexMeshRef.current, 0.45 + fillK * 1.6);
    emis(limbMeshRef.current, idle * 0.8 + fillK * 0.55);
    // the plate's own lines stay under the names: they are the ground the names
    // are cut into, and at full glow they were eating them
    emis(plateMeshRef.current, 0.04 + fillK * 0.5);
    emis(reteMeshRef.current, 0.04 + fillK * 0.45);
    if (lightRef.current) lightRef.current.intensity = (fillK * 1.4 + flash * 2.6) * metal.peak;

    /* ---- the inscription and the scale ---- */
    if (rimMatRef.current) rimMatRef.current.opacity = 0.14 + rimK * 0.8;
    if (scaleMatRef.current) scaleMatRef.current.opacity = 0.22 + fillK * 0.7;
    if (nameMatRef.current) nameMatRef.current.opacity = fillK;
    if (nameGlowRef.current) nameGlowRef.current.opacity = fillK * 0.5;

    /* ---- the star pointers wake one at a time ---- */
    for (let k = 0; k < POINTERS.length; k++) {
      const m = pointMeshRef.current[k];
      if (!m) continue;
      const p = lit ? smooth(clamp01((tau - 0.85 - k * 0.22) / 0.5)) * rev : 0;
      m.scale.setScalar(0.6 + p * 0.9);
      emis(m, 0.1 + p * 3);
    }

    /* ---- what the aligned rings throw on the sky ---- */
    if (chartRef.current) {
      chartRef.current.visible = chartK > 0.002;
      chartRef.current.scale.setScalar(0.35 + chartK * 0.65);
      chartRef.current.rotation.z = -e * 0.035;
    }
    if (chartMatRef.current) chartMatRef.current.opacity = chartK * 0.85;
    if (chartGlowRef.current) chartGlowRef.current.opacity = chartK * 0.16;

    /* ---- a light circling the ring that is waiting to be turned ---- */
    if (hintRef.current) {
      const r = RING_R[Math.min(2, g.live)];
      const a = -t * 1.5 + Math.PI / 2;
      hintRef.current.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.17);
      hintRef.current.visible = hint > 0.01;
    }
    if (hintMatRef.current) hintMatRef.current.opacity = hint * 0.5;

    /* ---- the sky's own stars ---- */
    const sp = skyStarsRef.current;
    if (sp) {
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < sky.stars; i++) {
        // the chart washes the field out as it blooms, the way a real one would
        const b = STARS.mag[i] * (0.55 + 0.45 * Math.sin(e * 1.7 + STARS.ph[i])) * (1 - chartK * 0.35);
        ca.setXYZ(i, b, b * 0.94, b * 0.86);
      }
      ca.needsUpdate = true;
      sp.geometry.setDrawRange(0, sky.stars);
    }

    if (phase === "opening" && lit && tau >= REVEAL_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0, CAM_Z]} fov={FOV} />
      <ambientLight intensity={sky.amb} color={sky.ambC} />
      {/* the key comes in low from where the sun is not yet; the fill is the cold
          half of the sky, which is the only thing silver has to work with */}
      <directionalLight position={[-2.6, -1.2, 3.4]} intensity={sky.keyI} color={sky.key} />
      <directionalLight position={[3, 3.4, 1.6]} intensity={sky.fillI} color={sky.fill} />

      {/* Sized off the camera, not by eye, and left outside the fit group: the fit
          shrinks in portrait and would drag the sky's edges into frame with it.
          h = 2·dist·tan(fov/2) = 9.9 at 12.9u, w = h·2.6 covers past aspect 2.53. */}
      <mesh position={[0, 0, -7]}>
        <planeGeometry args={[28, 11]} />
        <meshBasicMaterial map={SKY_TEX[skyKey]} />
      </mesh>
      <points ref={skyStarsRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[STARS.pos, 3]} />
          <bufferAttribute attach="attributes-color" args={[STARS.col, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={starTex} vertexColors size={0.075} sizeAttenuation
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
        />
      </points>

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the plate's own engraving, thrown large — the projection *is* the
              instrument's reading of the sky, so it is the same texture */}
          <group position={[0, INST_Y, -2.4]}>
            <mesh ref={chartRef} visible={false}>
              <planeGeometry args={[5.6, 5.6]} />
              <meshBasicMaterial
                ref={chartMatRef} map={plateTex} color={sky.chart} transparent opacity={0}
                depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
              />
            </mesh>
            <mesh position={[0, 0, -0.1]}>
              <planeGeometry args={[5.4, 5.4]} />
              <meshBasicMaterial
                ref={chartGlowRef} map={glowTex} color={sky.chart} transparent opacity={0}
                depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>

          <group position={[0, PIVOT_Y, 0]}>
            <group ref={hangRef}>
              {/* it hangs from the ring, and the shackle swings across it */}
              <mesh geometry={hangGeo} material={mats.trim} />
              <mesh
                position={[0, -0.115, 0]} rotation={[0, Math.PI / 2, 0]}
                geometry={shackleGeo} material={mats.trim}
              />

              <group position={[0, -1.6, 0]}>
                {/* the kursi, welded to the limb and reaching up to the shackle */}
                <group position={[0, 1.25, -0.037]}>
                  <mesh geometry={throneGeo} material={mats.mater} />
                </group>

                {/* the mater: a disc turned on its edge, with the limb round it */}
                <mesh
                  ref={materMeshRef} rotation={[Math.PI / 2, 0, 0]}
                  geometry={materGeo} material={mats.mater}
                />
                <mesh ref={limbMeshRef} geometry={limbGeo} material={mats.trim} />

                {/* the degree scale, wrapped once by the annulus's polar uvs */}
                <mesh position={[0, 0, 0.047]} geometry={scaleGeo}>
                  <meshBasicMaterial
                    ref={scaleMatRef} map={scaleTex} color={metal.engrave} transparent
                    opacity={0.22} depthWrite={false} side={THREE.DoubleSide}
                    toneMapped={false} blending={THREE.AdditiveBlending}
                  />
                </mesh>

                {/* the message, cut round the limb like the rest of the markings */}
                <mesh position={[0, 0, 0.048]} geometry={rim.geo}>
                  <meshBasicMaterial
                    ref={rimMatRef} map={rim.texture} color={metal.engrave} transparent
                    opacity={0.14} depthWrite={false} side={THREE.DoubleSide}
                    toneMapped={false} blending={THREE.AdditiveBlending}
                  />
                </mesh>

                {/* the index every ring is measured against */}
                <mesh ref={indexMeshRef} position={[0, R_MATER - 0.02, 0.055]}
                  rotation={[0, 0, Math.PI]} geometry={indexGeo} material={mats.index} />

                {/* the plate: fixed, as it must be — the rete turns over it */}
                <mesh ref={plateMeshRef} position={[0, 0, 0.052]} geometry={plateGeo} material={mats.plate} />
                {names && (
                  <>
                    {/* the cartouche: the chart's lines run right under the names
                        and additive type has nothing to win against them, so sink
                        a soft dark ground in first — no shadow maps on this canvas */}
                    <mesh position={[0, 0, 0.054]}>
                      <planeGeometry args={[names.w * 1.7, names.h * 3.4]} />
                      <meshBasicMaterial
                        map={glowTex} color="#000000" transparent opacity={0.8} depthWrite={false}
                      />
                    </mesh>
                    <sprite position={[0, 0, 0.056]} scale={[names.w * 1.5, names.h * 3.2, 1]}>
                      <spriteMaterial
                        ref={nameGlowRef} map={glowTex} color={metal.engrave} transparent
                        opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
                      />
                    </sprite>
                    <mesh position={[0, 0, 0.058]}>
                      <planeGeometry args={[names.w, names.h]} />
                      <meshBasicMaterial
                        ref={nameMatRef} map={names.texture} color={metal.engrave} transparent
                        opacity={0} depthWrite={false} toneMapped={false}
                        blending={THREE.AdditiveBlending}
                      />
                    </mesh>
                  </>
                )}

                {/* three free rings. Each carries the same eight-point star the
                    strapwork is built from; align them and the stars stack at the
                    index, which is the whole conceit made literal. */}
                {RING_R.map((r, k) => (
                  <group
                    key={k}
                    ref={(m) => {
                      ringsRef.current[k] = m;
                    }}
                    position={[0, 0, 0.15 - k * 0.032]}
                  >
                    <mesh
                      ref={(m) => {
                        ringMeshRef.current[k] = m;
                      }}
                      geometry={ringGeo[k]}
                      material={mats.rings[k]}
                    />
                    {/* the star is inlaid: bedded into the tube, proud of its face */}
                    <mesh
                      ref={(m) => {
                        starMeshRef.current[k] = m;
                      }}
                      position={[0, r, 0.045]}
                      scale={0.085 - k * 0.01}
                      geometry={starGeo}
                      material={mats.stars[k]}
                    />
                    {k === 2 && (
                      // the rete rides the innermost ring: the last click turns the
                      // star map itself onto the plate
                      <group position={[0, 0, 0]}>
                        <mesh ref={reteMeshRef} geometry={reteGeo} material={mats.rete} />
                        <mesh position={[0, 0.14, 0]} geometry={eclipticGeo} material={mats.rete} />
                        {POINTERS.map((p, j) => (
                          <group key={j}>
                            <mesh
                              position={[p.x * 0.5, p.y * 0.5, 0]}
                              rotation={[0, 0, p.a - Math.PI / 2]}
                              scale={[1, p.r, 1]}
                              geometry={armGeo}
                              material={mats.rete}
                            />
                            <mesh
                              ref={(m) => {
                                pointMeshRef.current[j] = m;
                              }}
                              position={[p.x, p.y, 0]}
                              geometry={pointerGeo}
                              material={mats.points[j]}
                            />
                          </group>
                        ))}
                      </group>
                    )}
                  </group>
                ))}

                {/* the brass click, in the only currency this canvas has */}
                {RING_R.map((r, k) => (
                  <sprite
                    key={k}
                    ref={(m) => {
                      sparksRef.current[k] = m;
                    }}
                    position={[0, r, 0.2]}
                    visible={false}
                  >
                    <spriteMaterial
                      map={glowTex} color={metal.index} transparent opacity={0}
                      depthWrite={false} blending={THREE.AdditiveBlending}
                    />
                  </sprite>
                ))}
                <pointLight
                  ref={lightRef} position={[0, 0, 0.9]} intensity={0}
                  color={metal.engrave} distance={5} decay={1.6}
                />
                <sprite ref={hintRef} scale={0.32} visible={false}>
                  <spriteMaterial
                    ref={hintMatRef} map={glowTex} color={metal.index} transparent
                    opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
                  />
                </sprite>

                {/* three r185 raycasts straight through `visible={false}` — an
                    invisible hit target has to be a transparent one instead, or the
                    drag is silently eaten. Centred on the instrument, so
                    worldToLocal hands back the angle the ring turns by. */}
                {phase === "opening" && (
                  <mesh
                    ref={hitRef}
                    position={[0, 0, 0.42]}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={stop}
                    onPointerCancel={stop}
                    onPointerOut={stop}
                  >
                    <planeGeometry args={[3.4, 3.4]} />
                    <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                  </mesh>
                )}
              </group>
            </group>
          </group>
        </group>
      </group>
    </>
  );
}
