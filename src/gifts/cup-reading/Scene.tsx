import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, sampleTextPoints } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- patterns ---------- */
// The decoration is the variant, so it has to change the porcelain itself — the
// glaze it is fired onto, the metal in the rim, the light the majlis throws back
// off it — not just a swatch painted on the side.
interface Pattern {
  glaze: string; // the fired body colour
  accent: string; // rim metal / the lamplight caught in the grounds
  rim: string; // the cold bounce off the far wall
  draw: (g: CanvasRenderingContext2D, W: number, H: number) => void;
}

// One motif band per pattern, drawn foot-to-rim in a 512x256 strip: canvas y=0 is
// uv.y=1 (CanvasTexture flips V), which on both lathes is the rim.
//
// A lathe's uv is not square on the cup: 512px run 0.75 world round the belly while
// 256px run 0.90 world foot-to-rim, so a canvas pixel is 2.4x taller than it is wide
// once fired. Author every motif in a square space and squash it on the way out, or
// the arabesque comes off the kiln as a row of long thin petals.
const SQUASH = 2.4;
function band(
  g: CanvasRenderingContext2D,
  W: number, H: number, rep: number, cyFrac: number,
  unit: (g: CanvasRenderingContext2D, w: number) => void,
) {
  const w = W / rep;
  for (let i = 0; i < rep; i++) {
    g.save();
    g.translate(i * w, H * cyFrac);
    g.scale(1, 1 / SQUASH); // strokes squash with it, so the pen stays round in world
    unit(g, w);
    g.restore();
  }
}

const PATTERNS: Record<string, Pattern> = {
  gilded: {
    glaze: "#f6ecdc", accent: "#ffd47e", rim: "#4a5f86",
    draw: (g, W, H) => {
      g.fillStyle = "#c9962f";
      g.fillRect(0, 0, W, H * 0.055); // the gold lip
      g.fillRect(0, H * 0.085, W, H * 0.012);
      g.fillRect(0, H * 0.9, W, H * 0.02); // and a hairline round the foot
      // an arabesque: one vine turning back on itself, budding on each turn
      band(g, W, H, 3, 0.45, (c, w) => {
        c.strokeStyle = "#c9962f";
        c.fillStyle = "#c9962f";
        c.lineWidth = w * 0.036;
        c.beginPath();
        c.moveTo(0, 0);
        c.bezierCurveTo(w * 0.18, -w * 0.42, w * 0.42, -w * 0.44, w * 0.5, 0);
        c.bezierCurveTo(w * 0.58, w * 0.44, w * 0.82, w * 0.42, w, 0);
        c.stroke();
        for (const [bx, by, r] of [
          [w * 0.3, -w * 0.33, w * 0.032],
          [w * 0.7, w * 0.33, w * 0.032],
          [w * 0.5, 0, w * 0.018],
        ]) {
          c.beginPath();
          c.ellipse(bx, by, r, r * 1.9, 0, 0, Math.PI * 2);
          c.fill();
        }
      });
    },
  },
  cobalt: {
    glaze: "#f2f1ea", accent: "#7fa8f0", rim: "#2f4c92",
    draw: (g, W, H) => {
      g.fillStyle = "#1b3a86";
      g.fillRect(0, 0, W, H * 0.075); // the cobalt lip
      g.fillRect(0, H * 0.105, W, H * 0.016);
      g.fillRect(0, H * 0.88, W, H * 0.03);
      // khatam: two squares at 45° are the eight-point star, and a strap ties each to
      // the next — the band has to close on itself or it is not the pattern
      band(g, W, H, 3, 0.45, (c, w) => {
        c.strokeStyle = "#1b3a86";
        c.fillStyle = "#1b3a86";
        c.lineWidth = w * 0.04;
        const s = w * 0.3;
        for (const rot of [0, Math.PI / 4]) {
          c.beginPath();
          for (let k = 0; k < 4; k++) {
            const a = rot + (k / 4) * Math.PI * 2;
            const px = w * 0.5 + Math.cos(a) * s;
            const py = Math.sin(a) * s;
            if (k === 0) c.moveTo(px, py);
            else c.lineTo(px, py);
          }
          c.closePath();
          c.stroke();
        }
        c.beginPath();
        c.arc(w * 0.5, 0, s * 0.26, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.moveTo(w * 0.5 + s, 0);
        c.lineTo(w * 1.5 - s, 0);
        c.stroke();
      });
    },
  },
  blossom: {
    glaze: "#fbf1ee", accent: "#ffb3c6", rim: "#7a5f8e",
    draw: (g, W, H) => {
      g.fillStyle = "#b4436a";
      g.fillRect(0, 0, W, H * 0.03); // a thin rose line, nothing heavier
      g.fillRect(0, H * 0.92, W, H * 0.012);
      const rand = mulberry32(5309);
      band(g, W, H, 3, 0.42, (c, w) => {
        const cx = w * 0.5;
        // stem first, so the petals sit over where it starts
        c.strokeStyle = "#4f7a4a";
        c.lineWidth = w * 0.018;
        c.beginPath();
        c.moveTo(cx, 0);
        c.quadraticCurveTo(cx + w * 0.11, w * 0.24, cx + w * 0.03, w * 0.46);
        c.stroke();
        c.fillStyle = "#4f7a4a";
        for (const [lx, ly, lr] of [[cx + w * 0.1, w * 0.21, 1], [cx + w * 0.04, w * 0.38, -1]]) {
          c.beginPath();
          c.ellipse(lx, ly, w * 0.062, w * 0.024, lr * 0.7, 0, Math.PI * 2);
          c.fill();
        }
        // five petals, each off true by a hair — a painted flower, not a stamp
        const ph = rand() * Math.PI;
        for (let k = 0; k < 5; k++) {
          const a = ph + (k / 5) * Math.PI * 2 + (rand() - 0.5) * 0.16;
          c.fillStyle = k % 2 ? "#b4436a" : "#d9708f";
          c.beginPath();
          c.ellipse(cx + Math.cos(a) * w * 0.088, Math.sin(a) * w * 0.088, w * 0.07, w * 0.044, a, 0, Math.PI * 2);
          c.fill();
        }
        c.fillStyle = "#e8c264";
        c.beginPath();
        c.arc(cx, 0, w * 0.03, 0, Math.PI * 2);
        c.fill();
      });
    },
  },
};

function buildPatternTex(p: Pattern): THREE.CanvasTexture {
  const W = 512, H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = p.glaze;
  g.fillRect(0, 0, W, H);
  // glaze pools where the kiln let it: a faint mottle so the white is fired, not paper
  const rand = mulberry32(88);
  for (let i = 0; i < 40; i++) {
    const x = rand() * W, y = rand() * H, r = 18 + rand() * 46;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${0.05 + rand() * 0.07})`);
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  p.draw(g, W, H);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(3, 1); // the motif runs three times round a cup this small
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const PATTERN_TEX: Record<string, THREE.CanvasTexture> = {
  gilded: buildPatternTex(PATTERNS.gilded),
  cobalt: buildPatternTex(PATTERNS.cobalt),
  blossom: buildPatternTex(PATTERNS.blossom),
};

/* ---------- stage layout (tilt space) ---------- */
const FOV = 40;
const CAM_Z = 4.5;
// Sitting down, looking at a cup on a low table — which is also the only angle that
// sees far enough into it to find the coffee. At 21.5° the near wall stops hiding the
// far one at v 0.62, so the stain has to reach past that or the cup reads as empty.
const CAM_Y = 1.45;
const LOOK_Y = -0.32;
const TABLE_Y = -1.22;
const SAUCER_R = 0.78;
const CUP_H = 0.88;
const COFFEE_V = 0.8; // where the coffee stood: an Arabic pour, three-quarters up
const CUP_CY = CUP_H * 0.5; // the flip turns about the cup's own middle, so the
// mouth lands exactly where the foot was: on the saucer
const CUP_BASE_Y = TABLE_Y + 0.026; // the foot sits down in the saucer's well…
const SEAT_LIFT = 0.03; // …but upturned it rests on its rim, out on the brim, higher
const WALL = 0.036; // porcelain this thin is why a fenjan burns your fingers
const FLOOR_V = 0.095; // the inside of the base
// The fortune stands clear of the cup that was set down beside it — the parked cup
// reaches TABLE_Y + CUP_H, and a reading that crossed it would be read through porcelain.
const READ_Y = 0.42;
const CAP_MAX_Y = 1.32; // and the caption still has to be inside the frustum
const ACTION_W = 2.35;
const PARK_X = 0.82; // set down beside the saucer, out of the reading's way
const PARK_Z = -0.5;

/* ---------- the far wall of the majlis ---------- */
// Outside the fit group on purpose: the fit shrinks to 0.68 on a 390px phone and a
// backdrop that shrank with it would peel bare canvas off both edges.
const WALL_Z = -3.4;
const BACK_H = 2 * (CAM_Z - WALL_Z) * Math.tan((FOV * Math.PI) / 360); // 5.82 at its depth
const BACK_W = BACK_H * 2.6; // 15.1 — past the 2.53 of the widest canvas, lean included

/* ---------- opening timeline (seconds) ---------- */
const FLIP_DUR = 1.05;
const SETTLE = 1.45; // the grounds have to run down the porcelain; this is the ritual
const LIFT_DUR = 1.0;
const DRAG_TARGET = 0.62; // world units of downward drag to tip it over
const LEAN_MAX = 0.18; // how far the drag itself turns the cup before it commits
// The mercy tips the cup for anyone who never touches it: eased in from 1.0s so it
// reads as the cup going over on its own, not a timer firing.
const T_TIP0 = 1.0;
const T_TIP1 = 2.2;
// Nobody has touched it: flip at 2.2 → lands 3.25 → settles 4.70 → lift → the reading
// runs TAU_HOLD and onOpenComplete lands at 10.30s, inside the 12s bound with 1.7s of
// slack for a phone dropping frames (dt is clamped, so this clock runs behind the wall
// clock the bound is measured on). Someone who did touch it gets PATIENCE to tap.
const PATIENCE = 4.0;

/* ---------- the reading (clock τ, from the moment the cup starts to lift) ---------- */
const T_BIRD0 = 0.55, T_BIRD1 = 1.35;
const T_ROAD0 = 1.85, T_ROAD1 = 2.45;
const T_HEART0 = 2.95, T_HEART1 = 3.55;
const T_TEXT0 = 4.05; // + a per-particle stagger, so the words gather rather than snap
const TAU_HOLD = 5.6;
const PREV_PERIOD = 13.6;
const PREV_FLIP = 1.2;
const PREV_LIFT = PREV_FLIP + FLIP_DUR + SETTLE; // 3.70

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();
const siltTex = makeRadialSprite(48, [
  [0, "rgba(255,255,255,1)"],
  [0.55, "rgba(255,255,255,0.55)"],
  [1, "rgba(255,255,255,0)"],
]);
const steamTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.7)"],
  [0.5, "rgba(255,255,255,0.24)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- the room ---------- */
// A majlis at night: lamplight pooling low on a patterned wall, everything above it
// falling away into the dark. Nothing here is lit by the same lamp twice.
function buildWallTex(): THREE.CanvasTexture {
  const W = 256, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#0b0709");
  sky.addColorStop(0.52, "#1c1116");
  sky.addColorStop(0.78, "#3a2118"); // the lamp finds the wall at sitting height
  sky.addColorStop(1, "#150c0c");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(74, 84, 60, "rgba(255,178,92,0.5)"); // the lamp itself, off to the left
  blob(200, 92, 44, "rgba(180,96,48,0.28)"); // and its throw on the far cushions
  // a suggestion of the hanging carpet, never in focus
  g.globalAlpha = 0.12;
  g.strokeStyle = "#b8703a";
  g.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const x = 18 + i * 34;
    g.beginPath();
    g.moveTo(x, 62);
    g.lineTo(x + 11, 78);
    g.lineTo(x, 94);
    g.lineTo(x - 11, 78);
    g.closePath();
    g.stroke();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const wallTex = buildWallTex();

/* ---------- the fenjan ---------- */
// Small, handleless, waisted: a foot you can pinch, a body that pulls in just above
// it and then sweeps out, and a lip that turns back a hair at the very top. One
// formula, evaluated on the CPU to lathe the porcelain and again in the vertex
// shader to pin the grounds to it — so the grounds cannot drift off the wall, ever.
// A fenjan's foot is a good six-tenths of its rim, and the wall leaves it climbing —
// hold the radius flat down there for a quarter of the height and you have built a
// wine glass on a stem. Four terms, and each is doing one job: the foot, a flare that
// eases as it rises, a waist too slight to name, and a lip that rolls back in over the
// last few percent, which is the detail a fenjan is recognised by.
const R_FOOT = 0.27, R_FLARE = 0.2, R_WAIST = 0.022, R_LIP = 0.02;
const fenjanR = (v: number) =>
  R_FOOT + R_FLARE * Math.pow(v, 0.85) - R_WAIST * Math.sin(2 * Math.PI * v) - R_LIP * Math.pow(v, 14);
const GLSL_FENJAN = `
float fenjanR(float v) {
  return ${R_FOOT.toFixed(3)} + ${R_FLARE.toFixed(3)} * pow(v, 0.85)
       - ${R_WAIST.toFixed(3)} * sin(6.283185 * v)
       - ${R_LIP.toFixed(3)} * pow(v, 14.0);
}
`;
const R_RIM = fenjanR(1);
const FLOOR_Y = FLOOR_V * CUP_H;
const R_FLOOR = fenjanR(FLOOR_V) - WALL; // where the inner floor meets the inner wall

// The film a finished cup is coated in is a stain on the glaze, not eight hundred
// separate grains: scattering particles up the wall to stand in for it just reads as
// grit. The particles are the sludge that is going to move. This is the coffee that
// was drunk, and the tide line it stopped at is the whole tell that it ever existed.
const INNER_N = 30; // wall points on the inner lathe; the uv below is read off it
const COFFEE_UV = ((1 - COFFEE_V) / (1 - FLOOR_V)) * ((INNER_N - 1) / INNER_N);
function buildInnerTex(p: Pattern): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = p.glaze;
  g.fillRect(0, 0, S, S);
  // CanvasTexture flips V, and the inner lathe is traced rim→floor: canvas y=0 is the
  // floor, y=S the rim. So the coffee fills from the top down to its line.
  const lineY = (1 - COFFEE_UV) * S;
  const grd = g.createLinearGradient(0, 0, 0, lineY);
  grd.addColorStop(0, "#160b04"); // deepest where it pooled longest
  grd.addColorStop(0.72, "#2e1a0d");
  grd.addColorStop(1, "#5a3a22"); // and thin enough to see glaze through at the line
  g.fillStyle = grd;
  // a tide line is never level: three periodic terms, so it still closes round the cup
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(S, 0);
  for (let x = S; x >= 0; x -= 2) {
    const u = (x / S) * Math.PI * 2;
    g.lineTo(x, lineY + Math.sin(u * 3) * 5 + Math.sin(u * 5 + 1.7) * 3 + Math.sin(u * 11) * 1.5);
  }
  g.closePath();
  g.fill();
  // and it dries in streaks, because the cup was tipped while it was drunk
  const rand = mulberry32(771);
  g.globalAlpha = 0.5;
  for (let i = 0; i < 26; i++) {
    const x = rand() * S;
    const w = 3 + rand() * 9;
    const top = lineY - rand() * 26;
    const gr = g.createLinearGradient(0, top, 0, top - 40 - rand() * 50);
    gr.addColorStop(0, "#1b0e05");
    gr.addColorStop(1, "rgba(27,14,5,0)");
    g.fillStyle = gr;
    g.fillRect(x, top - 90, w, 90);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const INNER_TEX: Record<string, THREE.CanvasTexture> = {
  gilded: buildInnerTex(PATTERNS.gilded),
  cobalt: buildInnerTex(PATTERNS.cobalt),
  blossom: buildInnerTex(PATTERNS.blossom),
};

function latheProfile(n: number, f: (v: number) => THREE.Vector2): THREE.Vector2[] {
  return Array.from({ length: n }, (_, i) => f(i / (n - 1)));
}

// uv.y runs 0 at the foot to 1 at the rim, which is where the motif band is drawn
const cupOuterGeo = new THREE.LatheGeometry(
  latheProfile(40, (v) => new THREE.Vector2(fenjanR(v), v * CUP_H)),
  56,
);
// traced rim→floor, so three's lathe normals point back down the axis: the inside
const cupInnerGeo = new THREE.LatheGeometry(
  [
    ...latheProfile(INNER_N, (v) => {
      const t = 1 - v * (1 - FLOOR_V);
      return new THREE.Vector2(fenjanR(t) - WALL, t * CUP_H);
    }),
    new THREE.Vector2(0, FLOOR_Y),
  ],
  56,
);
const rimGeo = new THREE.RingGeometry(R_RIM - WALL, R_RIM, 56);
const footRingGeo = new THREE.TorusGeometry(R_FOOT - 0.012, 0.013, 6, 40);
const baseGeo = new THREE.CircleGeometry(R_FOOT - 0.02, 40);

// a shallow dish: a well the foot sits in, a brim, a lip that lifts. Traced lip→centre
// for the same normal reason, then the uv is flipped so the motif's rim band lands on
// the lip and the two pieces read as a set.
const saucerGeo = (() => {
  const p: [number, number][] = [
    [SAUCER_R - 0.005, 0.098], [SAUCER_R, 0.086], [SAUCER_R - 0.05, 0.066],
    [0.6, 0.06], [0.42, 0.05], [0.33, 0.021], [0.2, 0.016], [0, 0.02],
  ];
  const g = new THREE.LatheGeometry(p.map(([r, y]) => new THREE.Vector2(r, y)), 56);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, 1 - uv.getY(i));
    // the brim is two-thirds again the way round that the cup's belly is, so it takes
    // that many more motifs to keep them the same size on both pieces
    uv.setX(i, uv.getX(i) * 1.67);
  }
  uv.needsUpdate = true;
  return g;
})();

/* ---------- the omens ---------- */
// Read in the grounds since long before anyone wrote them down: a bird is news on
// its way, a road is a journey, a heart is the obvious one. Each authored in a
// roughly [-1,1] space and held for half a second — long enough to be seen, not
// long enough to be studied.
function omenBird(rand: () => number): [number, number] {
  if (rand() < 0.17) {
    const s = rand();
    const w = s < 0.14 ? 0.075 : s < 0.72 ? 0.115 * (1 - (s - 0.14) * 0.5) : 0.05 + (s - 0.72) * 0.42;
    return [(rand() * 2 - 1) * w, lerp(0.2, -0.36, s)];
  }
  const side = rand() < 0.5 ? -1 : 1;
  const s = Math.pow(rand(), 0.82); // denser at the shoulder, where a wing is thick
  const w = rand();
  return [side * (0.07 + 0.95 * s + 0.1 * w * s), 0.07 + 0.46 * s - 0.14 * s * s - 0.3 * (1 - s * s * 0.86) * w];
}
function omenRoad(rand: () => number): [number, number] {
  const s = rand(); // 0 underfoot, 1 at the vanishing point
  const width = 0.6 * (1 - 0.86 * s);
  const bend = 0.34 * Math.sin(s * 2.5) - 0.06;
  const y = -0.62 + 1.16 * s;
  const u = rand();
  const jit = (rand() - 0.5) * 0.05;
  if (u < 0.42) return [bend - width + jit, y];
  if (u < 0.84) return [bend + width + jit, y];
  // the centre line, and it is painted in dashes
  if ((s * 6) % 1 > 0.55) return [bend - width + jit, y];
  return [bend + jit, y];
}
function omenHeart(rand: () => number): [number, number] {
  const th = rand() * Math.PI * 2;
  const hx = 16 * Math.pow(Math.sin(th), 3);
  const hy = 13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th);
  const k = Math.sqrt(rand()); // filled, not outlined — grounds are a smear, not a line
  return [(hx * k) / 17, ((hy + 1) * k - 1) / 17 - 0.06];
}

/* ---------- the grounds ---------- */
// The whole sim is the vertex shader. Two scalars in — how far the grounds have run,
// and how long since the cup came off — and 820 particles out, nothing per-frame on
// the CPU. Every position is a closed form of those two, so the second reading is the
// same as the first, for free.
// Twelve specks per character is a smudge, not a word. Dense enough that the glyphs
// hold together and the sludge in the cup reads as sludge; they are 5px each and cost
// nothing, and the whole sim is one draw call either way.
const GROUND_N = 1400;

const GROUNDS_VERT = `
#define FLOOR_V ${FLOOR_V.toFixed(4)}
#define FLOOR_Y ${FLOOR_Y.toFixed(4)}
#define R_FLOOR ${R_FLOOR.toFixed(4)}
#define WALL ${WALL.toFixed(4)}
#define CUP_H ${CUP_H.toFixed(4)}
#define CUP_CY ${CUP_CY.toFixed(4)}
attribute vec4 aCup;    // x: the v it dried at (FLOOR_V = it is in the pool), y: its angle,
                        // z: how far it runs, w: where in the pool it lay
attribute vec4 aOmenA;  // bird.xy, road.xy
attribute vec2 aOmenB;  // heart.xy
attribute vec4 aRnd;
attribute vec2 aTim;    // when this speck is called to a letter, and how long it takes
uniform float uFlip;
uniform float uRun;
uniform float uTau;
uniform float uTextW;
uniform float uOmenW;
uniform float uScale;
uniform float uFade;
uniform float uSize;
uniform vec2 uCup;
uniform vec2 uTextC;
varying float vA;
varying float vLit;
${GLSL_FENJAN}

// Curl of a trig vector potential — divergence-free, so the grounds churn and fold
// instead of thinning out the way plain noise would.
vec3 curl(vec3 p) {
  vec3 s = sin(p), c = cos(p);
  return vec3(-s.x * s.y - c.z * c.x, -s.y * s.z - c.x * c.y, -s.z * s.x - c.y * c.z);
}

void main() {
  // ---- constrained: a point that cannot leave the porcelain ----
  // The run is staggered per speck, so the grounds go down in threads and not as a sheet.
  // fenjanR is the same curve the lathe was cut from, so every branch below rides the
  // glaze exactly and nothing can float off the wall into the middle of the cup.
  float k = clamp(uRun * 1.34 - aRnd.y * 0.34, 0.0, 1.0);
  float rad, hgt;
  if (aCup.x <= FLOOR_V + 0.001) {
    // the sludge in the bottom: out across the floor first, and only then up the wall
    if (k < 0.34) {
      rad = mix(aCup.w * R_FLOOR, R_FLOOR, k / 0.34);
      hgt = FLOOR_Y;
    } else {
      float v = mix(FLOOR_V, FLOOR_V + aCup.z, (k - 0.34) / 0.66);
      rad = fenjanR(v) - WALL;
      hgt = v * CUP_H;
    }
  } else {
    // the film, running for the rim from the line it dried at — which, the cup being
    // over, is downhill
    float v = mix(aCup.x, min(0.985, aCup.x + aCup.z), k);
    rad = fenjanR(v) - WALL;
    hgt = v * CUP_H;
  }
  // a grain sits ON the glaze, which means its sprite straddles it and the depth test
  // saws each one in half against the wall — so stand them off it by their own size
  rad -= 0.01;
  hgt += 0.006;
  vec3 cp = vec3(cos(aCup.y) * rad, hgt, sin(aCup.y) * rad);
  // the cup's own turn, off the same scalar the porcelain rides
  vec2 d = vec2(cp.x, cp.y - CUP_CY);
  float sa = sin(uFlip), ca = cos(uFlip);
  vec3 pCup = vec3(d.x * ca - d.y * sa, d.x * sa + d.y * ca, cp.z) + vec3(uCup, 0.0);

  // ---- released: the reading ----
  vec3 c = vec3(uTextC, 0.0);
  vec3 pBird = vec3(aOmenA.xy * uOmenW, aRnd.z * 0.07 - 0.035) + c;
  vec3 pRoad = vec3(aOmenA.zw * uOmenW, aRnd.w * 0.07 - 0.035) + c;
  vec3 pHeart = vec3(aOmenB.xy * uOmenW, aRnd.x * 0.07 - 0.035) + c;
  vec3 pText = vec3(position.xy * uTextW, position.z) + c;

  float f1 = smoothstep(${T_BIRD0.toFixed(2)}, ${T_BIRD1.toFixed(2)}, uTau);
  float f2 = smoothstep(${T_ROAD0.toFixed(2)}, ${T_ROAD1.toFixed(2)}, uTau);
  float f3 = smoothstep(${T_HEART0.toFixed(2)}, ${T_HEART1.toFixed(2)}, uTau);
  float f4 = smoothstep(aTim.x, aTim.x + aTim.y, uTau);
  vec3 p = mix(pCup, pBird, f1);
  p = mix(p, pRoad, f2);
  p = mix(p, pHeart, f3);
  p = mix(p, pText, f4);

  // an omen arrives out of a churn and holds only as long as it is being held: the
  // noise peaks mid-crossing and dies into every shape. τ drives its phase too, so
  // there is nothing here that a replay could land differently.
  float loose = 4.0 * max(max(f1 * (1.0 - f1), f2 * (1.0 - f2)), max(f3 * (1.0 - f3), f4 * (1.0 - f4)));
  vec3 q = p * 2.6 + vec3(aRnd.x * 9.0, uTau * 0.35, aRnd.y * 6.0);
  p += curl(q) * (0.06 * loose + 0.013 * f1 * (1.0 - f4));

  // In the cup they are wet silt in shadow. Off it, in the air, the majlis lamp finds
  // them — which is the only reason dark grounds can be read against a dark room.
  vLit = max(f1 * 0.5, f4);
  vA = uFade * (0.6 + 0.4 * aRnd.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // gl_PointSize is device pixels and ignores the model matrix, so the portrait fit
  // has to be folded back into uScale or the silt bloats on a phone
  // Silt is fine: a grain as big as the cup's own belly is not a grain. Off the
  // porcelain and in the lamp they bloom — the house's fake bloom done per particle,
  // and also the only way this many specks are ever going to read as words.
  float grow = mix(1.0, 1.7, max(f4, f1 * 0.5));
  gl_PointSize = min(uSize * (0.7 + aRnd.w * 0.55) * grow * uScale / max(-mv.z, 0.1), 64.0);
}
`;

const GROUNDS_FRAG = `
uniform sampler2D uTex;
uniform vec3 uSilt;
uniform vec3 uLit;
varying float vA;
varying float vLit;
void main() {
  float m = texture2D(uTex, gl_PointCoord).a;
  gl_FragColor = vec4(mix(uSilt, uLit, vLit), m * vA);
}
`;

function buildGrounds(textSource: string, lang: Lang) {
  const tp = sampleTextPoints(textSource, {
    maxPoints: GROUND_N, fontSize: 82, fontWeight: "700", maxWidthPx: 720, seed: 41, lang,
  });
  const rand = mulberry32(20260715);
  const pos = new Float32Array(GROUND_N * 3);
  const cup = new Float32Array(GROUND_N * 4);
  const oA = new Float32Array(GROUND_N * 4);
  const oB = new Float32Array(GROUND_N * 2);
  const rnd = new Float32Array(GROUND_N * 4);
  const tim = new Float32Array(GROUND_N * 2);

  for (let i = 0; i < GROUND_N; i++) {
    // Normalized (width 1) and scaled in the shader: the text has to be re-fitted every
    // frame against a canvas whose aspect jumps the instant the reveal lands.
    if (tp.count > 0) {
      const j = (i % tp.count) * 2;
      pos[i * 3] = tp.points[j] + (rand() - 0.5) * 0.004; // specks doubling up on one
      pos[i * 3 + 1] = tp.points[j + 1] + (rand() - 0.5) * 0.004; // pixel must not stack
    } else {
      // the words failed to raster; fate still owes them something
      const [hx, hy] = omenHeart(rand);
      pos[i * 3] = hx * 0.5;
      pos[i * 3 + 1] = hy * 0.5;
    }
    pos[i * 3 + 2] = (rand() - 0.5) * 0.05;

    const [bx, by] = omenBird(rand);
    const [rx, ry] = omenRoad(rand);
    const [hx, hy] = omenHeart(rand);
    oA[i * 4] = bx; oA[i * 4 + 1] = by; oA[i * 4 + 2] = rx; oA[i * 4 + 3] = ry;
    oB[i * 2] = hx; oB[i * 2 + 1] = hy;

    // A finished cup is not an empty one. A third of this is the sludge lying in the
    // bottom; the rest is the film the coffee left up the wall to the line it stood
    // at — which is the dark ring you can actually see, and the whole tell that there
    // was ever coffee in here.
    cup[i * 4] = rand() < 0.34 ? FLOOR_V : FLOOR_V + rand() * (COFFEE_V - FLOOR_V);
    cup[i * 4 + 1] = rand() * Math.PI * 2;
    // most of it runs the whole way to the rim and out onto the saucer; some clings
    cup[i * 4 + 2] = Math.min(0.985 - FLOOR_V, 0.2 + Math.pow(rand(), 0.55) * 0.79);
    cup[i * 4 + 3] = Math.sqrt(rand()); // uniform over the floor disc: a pool, not a ring

    for (let k = 0; k < 4; k++) rnd[i * 4 + k] = rand();
    tim[i * 2] = T_TEXT0 + rand() * 0.55; // the last speck lands at τ 5.45, inside the hold
    tim[i * 2 + 1] = 0.5 + rand() * 0.35;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aCup", new THREE.BufferAttribute(cup, 4));
  geo.setAttribute("aOmenA", new THREE.BufferAttribute(oA, 4));
  geo.setAttribute("aOmenB", new THREE.BufferAttribute(oB, 2));
  geo.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  geo.setAttribute("aTim", new THREE.BufferAttribute(tim, 2));
  return { geo, aspect: tp.aspect };
}

// The grounds start down the porcelain while the cup is still turning over, reach
// 0.55 by the time it has settled — all of it hidden under an opaque cup, which is
// the whole point of the pause — and finish the run in the open once it comes off.
const flipRun = (sinceFlip: number, tau: number) =>
  tau >= 0
    ? 0.55 + 0.45 * smooth(clamp01(tau / 0.5))
    : sinceFlip < 0
      ? 0
      : 0.55 * smooth(clamp01((sinceFlip - FLIP_DUR * 0.55) / SETTLE));

// porcelain rings when it lands; this is what that looks like
const wobble = (w: number) => (w > 0 ? 0.028 * Math.exp(-w * 5.5) * Math.sin(w * 24) : 0);

/* ---------- what the aunt says before she says anything else ---------- */
const CAPTION: Record<Lang, string> = { en: "Your fortune:", ar: "بختك:" };
const TEXT_W = 2.1;
const TEXT_H = 1.15;

/* ---------- steam off a cup that is still warm ---------- */
// Sparse steam is not steam, it is sparks: it wants enough overlapping puffs that no
// single one is ever the thing you see.
const STEAM_N = 80;
const steamPos = new Float32Array(STEAM_N * 3);
const steamCol = new Float32Array(STEAM_N * 3);
const STEAM = (() => {
  const rand = mulberry32(414);
  return {
    ph: Float32Array.from({ length: STEAM_N }, () => rand() * Math.PI * 2),
    r: Float32Array.from({ length: STEAM_N }, () => rand() * 0.3),
    sp: Float32Array.from({ length: STEAM_N }, () => 0.5 + rand() * 0.45),
    off: Float32Array.from({ length: STEAM_N }, () => rand()),
  };
})();

export default function CupReadingScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const pat = PATTERNS[variants.pattern] ?? PATTERNS.gilded;
  const patTex = PATTERN_TEX[variants.pattern] ?? PATTERN_TEX.gilded;
  const innerTex = INNER_TEX[variants.pattern] ?? INNER_TEX.gilded;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" on the gallery card and live per-keystroke from /create, so it is
  // never required and never assumed absent: with nothing to say, fate says "For you".
  const textSource = message.trim() || forRecipient(lang, recipientName);
  const grounds = useMemo(() => buildGrounds(textSource, lang), [textSource, lang]);
  useEffect(() => () => grounds.geo.dispose(), [grounds]);

  const groundsMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uFlip: { value: 0 }, uRun: { value: 0 }, uTau: { value: -1 },
          uTextW: { value: TEXT_W }, uOmenW: { value: 0.66 }, uScale: { value: 600 },
          uFade: { value: 1 }, uSize: { value: 0.018 },
          uCup: { value: new THREE.Vector2(0, CUP_BASE_Y + CUP_CY) },
          uTextC: { value: new THREE.Vector2(0, READ_Y) },
          uTex: { value: siltTex },
          uSilt: { value: new THREE.Color("#241309") }, // wet grounds in the cup's shade
          uLit: { value: new THREE.Color(pat.accent) }, // and the same grounds in the lamp
        },
        vertexShader: GROUNDS_VERT,
        fragmentShader: GROUNDS_FRAG,
        transparent: true,
        // Not additive: these are dark specks on white porcelain before they are
        // anything else, and depth-testing is what keeps the ones still inside the
        // upturned cup out of sight until it comes off.
        depthWrite: false,
      }),
    [pat],
  );
  useEffect(() => () => groundsMat.dispose(), [groundsMat]);

  const caption = useMemo(
    () => makeTextTexture(CAPTION[lang], { fontSize: 74, fontWeight: "400", color: "#f6e3c2", glow: 16, glowColor: pat.accent, lang }),
    [lang, pat],
  );
  useEffect(() => () => caption.texture.dispose(), [caption]);

  const mats = useMemo(() => {
    const glaze = new THREE.MeshStandardMaterial({ map: patTex, roughness: 0.24, metalness: 0.04 });
    // the inside carries no motif — it is where the reading happens, and a pattern
    // under the grounds would only be a second thing to look at — but it does carry
    // the coffee, which is the one thing in the sealed cup worth seeing
    const inner = new THREE.MeshStandardMaterial({
      // dried grounds are matte; it is wet coffee that has a mirror in it
      map: innerTex, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide,
    });
    const plain = new THREE.MeshStandardMaterial({
      color: pat.glaze, roughness: 0.3, metalness: 0.04, side: THREE.DoubleSide,
    });
    return { glaze, inner, plain };
  }, [patTex, innerTex, pat]);
  useEffect(
    () => () => { mats.glaze.dispose(); mats.inner.dispose(); mats.plain.dispose(); },
    [mats],
  );

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const cupRef = useRef<THREE.Group>(null);
  const groundsRef = useRef<THREE.Points>(null);
  const steamRef = useRef<THREE.Points>(null);
  const steamMatRef = useRef<THREE.PointsMaterial>(null);
  const capRef = useRef<THREE.Mesh>(null);
  const capMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const readGlowRef = useRef<THREE.Sprite>(null);
  const readGlowMatRef = useRef<THREE.SpriteMaterial>(null);
  const readLightRef = useRef<THREE.PointLight>(null);
  const hintRef = useRef<THREE.Sprite>(null);
  const hintMatRef = useRef<THREE.SpriteMaterial>(null);
  const shadowRef = useRef<THREE.Mesh>(null);

  const g = useRef({
    on: false,
    seeded: false,
    py: 0,
    drag: 0, // world units of downward drag banked so far
    idle: 0,
    alone: 0, // how long the cup has sat untouched — the mercy's own clock
    touched: false,
    flipAt: -1,
    liftAt: -1,
  });

  // Replay re-enters "opening" and the clock resets, so the ritual has to as well or
  // the second reading would flip before the recipient's finger was down.
  useLayoutEffect(() => {
    const r = g.current;
    r.on = r.seeded = r.touched = false;
    r.drag = r.idle = r.alone = r.py = 0;
    r.flipAt = -1;
    r.liftAt = -1;
  }, [phase]);

  /* ---------- the flip, and then the lift ---------- */
  const stop = () => {
    g.current.on = false;
    g.current.seeded = false;
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    const r = g.current;
    r.touched = true;
    // Capture, so the release lands here even when the finger wanders off the cup;
    // without it the drag latches on forever.
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* a nicety — the pointer-out fallback below covers its absence */
    }
    // Once the grounds have settled, the cup is not dragged any more: it is lifted,
    // and the touch that lifts it is a tap.
    if (r.flipAt >= 0 && r.liftAt < 0 && tRef.current >= r.flipAt + FLIP_DUR + SETTLE) {
      r.liftAt = tRef.current;
      return;
    }
    r.on = true;
    r.seeded = false;
    r.idle = 0;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const r = g.current;
    if (!r.on || phase !== "opening" || r.flipAt >= 0) return;
    const y = ev.point.y;
    if (r.seeded) {
      const dy = y - r.py;
      // Downward only. A captured pointer freezes at its last hit and jumps back in on
      // re-entry, so a leap that large is the capture talking, not a wrist.
      if (dy < 0 && dy > -0.4) {
        r.drag -= dy;
        r.idle = 0;
      }
    } else {
      r.seeded = true;
    }
    r.py = y;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const r = g.current;

    /* The canvas is not the window and its aspect jumps 1.60 → 2.53 the instant the
       reveal mounts the message under it, so every span here is measured off the
       viewport this frame and none of them is a constant. */
    const fit = Math.max(0.68, Math.min(1, state.viewport.width / ACTION_W));
    fitRef.current?.scale.setScalar(fit);
    const halfW = state.viewport.width / 2 / fit; // the stage's own half-width
    const parkX = Math.min(PARK_X, Math.max(0.55, halfW - R_RIM - 0.06));
    const wMax = Math.min(TEXT_W, halfW * 1.86);
    const textW = grounds.aspect * wMax > TEXT_H ? TEXT_H / grounds.aspect : wMax;
    const omenW = Math.min(0.66, halfW * 0.58);

    /* the room leans toward the pointer */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.05, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.07, k);
    }

    /* ---- the ritual, in three scalars: how far over, how far run, how long since ---- */
    let flip: number;
    let tau: number; // the reading's clock; < 0 until the cup comes off
    let run: number;
    let fade = 1;
    let hint = 0;
    let flipU = 0;
    let home = -1; // preview only: the cup going back to its saucer for the next reading

    if (phase === "opening") {
      r.idle += dt;
      // The mercy is the no-input path's and only its, so it runs on its own clock —
      // one that stops while a hand is working the cup and starts again the moment that
      // hand goes still. A finger resting on the porcelain is not a flip.
      if (!(r.on && r.idle < 0.5)) r.alone += dt;
      if (r.idle > 0.35 && r.flipAt < 0) r.drag = Math.max(0, r.drag - dt * 0.05);
      const mercy = smooth(clamp01((r.alone - T_TIP0) / (T_TIP1 - T_TIP0)));
      const lean = Math.max(clamp01(r.drag / DRAG_TARGET), mercy);
      if (lean >= 1 && r.flipAt < 0) r.flipAt = t;

      if (r.flipAt < 0) {
        // it tips under the hand and holds there, on the edge of going over
        flip = LEAN_MAX * lean;
        hint = clamp01((t - 0.8) / 0.6) * (1 - clamp01(r.drag / 0.1));
      } else {
        flipU = clamp01((t - r.flipAt) / FLIP_DUR);
        flip = lerp(LEAN_MAX, 1, easeInOut(flipU)) + wobble(t - r.flipAt - FLIP_DUR);
      }
      const gate = r.flipAt >= 0 ? r.flipAt + FLIP_DUR + SETTLE : Infinity;
      // A gift may never soft-lock. Untouched, the cup lifts itself the moment the
      // grounds have settled — onOpenComplete lands at 10.30s, inside the 12s bound.
      // Someone who did touch it gets PATIENCE to tap: the bound is the no-input
      // path's, and a recipient doing the ritual may take all the time they want.
      if (r.flipAt >= 0 && r.liftAt < 0 && t >= gate + (r.touched ? PATIENCE : 0)) r.liftAt = t;
      tau = r.liftAt >= 0 ? Math.min(t - r.liftAt, TAU_HOLD) : -1;
      if (r.liftAt < 0 && t >= gate) hint = 0.55 + 0.45 * Math.sin((t - gate) * 3.4);
      run = flipRun(r.flipAt >= 0 ? t - r.flipAt : -1, tau);
    } else if (phase === "revealed") {
      // A complete tableau off `phase` alone — reduced motion lands here cold, with
      // the cup already set aside and the fortune already read.
      flip = 1;
      tau = TAU_HOLD;
      run = 1;
      flipU = 1;
    } else if (phase === "preview") {
      // the whole ritual on a loop: flip, settle, lift, read, and set the cup back
      const cyc = e % PREV_PERIOD;
      const reset = cyc >= 12.9; // behind the fade: the grounds go back to being dregs
      flipU = clamp01((cyc - PREV_FLIP) / FLIP_DUR);
      flip = reset ? 0 : easeInOut(flipU) + wobble(cyc - PREV_FLIP - FLIP_DUR);
      tau = reset || cyc < PREV_LIFT ? -1 : Math.min(cyc - PREV_LIFT, TAU_HOLD);
      run = reset ? 0 : flipRun(cyc - PREV_FLIP, tau);
      fade = reset
        ? smooth(clamp01((cyc - 13.0) / 0.6))
        : 1 - smooth(clamp01((cyc - 11.6) / 1.2));
      if (cyc > 11.6) home = smooth(clamp01((cyc - 11.6) / 1.8));
    } else {
      flip = 0;
      tau = -1;
      run = 0;
    }
    const liftU = tau >= 0 ? easeInOut(clamp01(tau / LIFT_DUR)) : 0;

    /* ---- the cup ---- */
    let cx = 0;
    let cy = CUP_BASE_Y + CUP_CY;
    let cz = 0;
    let ang = -Math.PI * flip;
    if (tau >= 0) {
      // it keeps turning the same way it went over, so the half-turn that lifts it is
      // also the half-turn that stands it up again — a wrist, not a rewind
      ang = -Math.PI * (1 + liftU);
      cx = parkX * liftU;
      cy += Math.sin(Math.PI * liftU) * 0.62 + (TABLE_Y - CUP_BASE_Y) * liftU + SEAT_LIFT * (1 - liftU);
      cz = PARK_Z * smooth(clamp01(tau / LIFT_DUR));
    } else {
      // a wrist lifts, turns, and sets it down — on its rim now, which rides the brim
      cy += Math.sin(Math.PI * flipU) * 0.17 + SEAT_LIFT * flip;
    }
    if (home >= 0) {
      ang = -Math.PI * 2; // which is upright, so nothing has to snap when the loop turns
      cx = lerp(parkX, 0, home);
      cy = lerp(TABLE_Y + CUP_CY, CUP_BASE_Y + CUP_CY, home) + Math.sin(Math.PI * home) * 0.22;
      cz = PARK_Z * (1 - home);
    }
    cupRef.current?.position.set(cx, cy, cz);
    if (cupRef.current) cupRef.current.rotation.z = ang;

    if (shadowRef.current) {
      const off = clamp01((cy - CUP_BASE_Y - CUP_CY) / 0.6);
      shadowRef.current.position.set(cx, TABLE_Y + 0.005, cz);
      shadowRef.current.scale.setScalar(1 + off * 0.75);
      (shadowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - off * 0.6);
    }

    /* ---- the grounds ---- */
    const gm = groundsRef.current?.material as THREE.ShaderMaterial | undefined;
    if (gm) {
      const u = gm.uniforms;
      // The porcelain's frame freezes the moment the cup starts to lift: from here the
      // cup is going somewhere and the grounds are staying exactly where it left them.
      u.uFlip.value = tau >= 0 ? -Math.PI : ang;
      u.uCup.value.set(tau >= 0 ? 0 : cx, tau >= 0 ? CUP_BASE_Y + CUP_CY + SEAT_LIFT : cy);
      u.uRun.value = run;
      u.uTau.value = tau;
      u.uFade.value = fade;
      u.uTextW.value = textW;
      u.uOmenW.value = omenW;
      u.uScale.value =
        ((state.size.height * state.viewport.dpr) / (2 * Math.tan((FOV * Math.PI) / 360))) * fit;
    }

    /* ---- steam, while there is still something in it worth reading ---- */
    const sp = steamRef.current;
    if (sp) {
      sp.position.set(cx, CUP_BASE_Y, cz);
      const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < STEAM_N; i++) {
        const a = (STEAM.off[i] + e * STEAM.sp[i] * 0.26) % 1;
        const th = STEAM.ph[i] + a * 2.4; // it leaves the surface turning
        const rr = STEAM.r[i] * (0.3 + a * 1.1); // and spreads as it cools
        pa.setXYZ(
          i,
          Math.cos(th) * rr + Math.sin(e * 0.7 + STEAM.ph[i]) * a * 0.14,
          CUP_H * 0.82 + a * 0.52,
          Math.sin(th) * rr * 0.7,
        );
        // it has to be gone before it is high enough to be looked at individually
        const b = Math.sin(a * Math.PI) * (1 - a * 0.55) * 0.55;
        ca.setXYZ(i, b, b * 0.95, b * 0.9);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }
    if (steamMatRef.current) {
      // an upturned cup has nothing to give off, and a lifted one is empty
      const want = tau < 0 ? clamp01(Math.cos(ang)) * fade * 0.4 : 0;
      steamMatRef.current.opacity += (want - steamMatRef.current.opacity) * Math.min(1, dt * 2.4);
    }

    /* ---- the fortune, and the light it comes up in ---- */
    const omen = tau >= 0 ? smooth(clamp01((tau - T_BIRD0) / 0.8)) * fade : 0;
    const read = tau >= 0 ? easeOutCubic(clamp01((tau - T_TEXT0 + 0.2) / 1.2)) * fade : 0;
    if (capMatRef.current) capMatRef.current.opacity = read * 0.95;
    if (capRef.current) {
      // it sits on top of the words, so it has to move with them: the block's height is
      // the message's business and the width is the viewport's
      capRef.current.position.y = Math.min(CAP_MAX_Y, READ_Y + (textW * grounds.aspect) / 2 + 0.26);
      capRef.current.visible = read > 0.005;
    }
    if (readGlowRef.current) readGlowRef.current.scale.set(textW * 1.45, TEXT_H * 1.5, 1);
    if (readGlowMatRef.current) readGlowMatRef.current.opacity = 0.09 * omen + 0.17 * read;
    if (readLightRef.current) readLightRef.current.intensity = 0.6 * omen + 1.7 * read;

    /* ---- and until they take the hint ---- */
    const preFlip = phase === "opening" && r.flipAt < 0;
    if (hintRef.current) {
      const slide = (t * 0.62) % 1;
      hintRef.current.position.set(
        0,
        preFlip ? CUP_BASE_Y + CUP_H + 0.3 - slide * 0.52 : CUP_BASE_Y + CUP_H * 0.55,
        0.62,
      );
      hintRef.current.scale.setScalar(preFlip ? 0.36 : 0.66);
      if (hintMatRef.current)
        hintMatRef.current.opacity = hint * (preFlip ? Math.sin(slide * Math.PI) * 0.5 : 0.26);
    }

    if (phase === "opening" && tau >= TAU_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, CAM_Y, CAM_Z]}
        fov={FOV}
        onUpdate={(c) => c.lookAt(0, LOOK_Y, 0)}
      />
      <ambientLight intensity={0.3} color="#ffdcb0" />
      {/* the majlis lamp sits low and off to the left, the way they always do; the far
          wall gives back the little that is left */}
      <directionalLight position={[-2.6, 2.3, 2.6]} intensity={1.75} color="#ffd39a" />
      <directionalLight position={[2.9, 1.2, -2.2]} intensity={0.55} color={pat.rim} />

      <group ref={tiltRef}>
        {/* Sized off the frustum, not by eye — and outside the fit group, because the
            fit drops to 0.68 on a 390px phone and a wall that shrank with it would
            peel bare canvas off both edges. */}
        <mesh position={[0, 0.1, WALL_Z]}>
          <planeGeometry args={[BACK_W, BACK_H * 1.3]} />
          <meshBasicMaterial map={wallTex} />
        </mesh>

        <group ref={fitRef}>
          {/* the low table. Oversized on purpose: it runs under the wall at every fit,
              so the two never show a seam */}
          <mesh position={[0, TABLE_Y, -2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[30, 12]} />
            <meshStandardMaterial color="#2c1b12" roughness={0.88} />
          </mesh>
          {/* the lamp's pool on the wood — there are no shadow maps on this canvas */}
          <mesh position={[-0.12, TABLE_Y + 0.002, 0.1]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[4.4, 3.4]} />
            <meshBasicMaterial
              map={glowTex} color="#ffb761" transparent opacity={0.28}
              depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </mesh>

          <mesh position={[0, TABLE_Y, 0]} geometry={saucerGeo} material={mats.glaze} />
          {/* the cup's own shadow, and it grows soft as the cup leaves the saucer */}
          <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
            <planeGeometry args={[1.15, 1.15]} />
            <meshBasicMaterial map={glowTex} color="#000000" transparent opacity={0.5} depthWrite={false} />
          </mesh>

          {/* The pivot is the cup's own middle, so a half-turn puts the mouth exactly
              where the foot was: face down on the saucer. The porcelain hangs off it. */}
          <group ref={cupRef} position={[0, CUP_BASE_Y + CUP_CY, 0]}>
            <group position={[0, -CUP_CY, 0]}>
              <mesh geometry={cupOuterGeo} material={mats.glaze} />
              <mesh geometry={cupInnerGeo} material={mats.inner} />
              <mesh position={[0, CUP_H, 0]} rotation={[-Math.PI / 2, 0, 0]} geometry={rimGeo} material={mats.plain} />
              {/* nobody looks at a cup's foot until it is upside down, and then it is
                  the only thing to look at */}
              <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} geometry={footRingGeo} material={mats.glaze} />
              <mesh position={[0, 0.015, 0]} rotation={[Math.PI / 2, 0, 0]} geometry={baseGeo} material={mats.plain} />
            </group>
          </group>

          <points ref={steamRef} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[steamPos, 3]} />
              <bufferAttribute attach="attributes-color" args={[steamCol, 3]} />
            </bufferGeometry>
            <pointsMaterial
              ref={steamMatRef} map={steamTex} vertexColors size={0.34} sizeAttenuation
              transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </points>

          {/* the grounds: the dregs, the omens and the words, all the same 820 specks */}
          <points ref={groundsRef} geometry={grounds.geo} material={groundsMat} frustumCulled={false} />

          {/* fake bloom the house way: an additive sprite behind what is glowing */}
          <sprite ref={readGlowRef} position={[0, READ_Y, -0.25]} scale={[2, 1.7, 1]}>
            <spriteMaterial
              ref={readGlowMatRef} map={glowTex} color={pat.accent} transparent
              opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </sprite>
          <pointLight ref={readLightRef} position={[0, READ_Y, 0.9]} intensity={0} color={pat.accent} distance={4.5} decay={1.6} />

          <mesh ref={capRef} position={[0, CAP_MAX_Y, 0]} visible={false}>
            <planeGeometry args={[0.66, 0.66 * caption.aspect]} />
            <meshBasicMaterial
              ref={capMatRef} map={caption.texture} transparent opacity={0}
              depthWrite={false} toneMapped={false}
            />
          </mesh>

          {/* a hand that isn't there, showing them: down the porcelain first, then a
              tap on it once the grounds have had their minute */}
          <sprite ref={hintRef} scale={0.36}>
            <spriteMaterial
              ref={hintMatRef} map={glowTex} color="#fff0d0" transparent
              opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </sprite>

          {/* three r185 raycasts straight through `visible={false}`, so an invisible hit
              target has to be a transparent one or the flip is silently eaten */}
          {phase === "opening" && (
            <mesh
              position={[0, TABLE_Y + 0.75, 0.95]}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={stop}
              onPointerCancel={stop}
              onPointerOut={stop}
            >
              <planeGeometry args={[2.6, 2.2]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          )}
        </group>
      </group>
    </>
  );
}
