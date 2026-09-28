import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite, radialBlob } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import { pick } from "../catalog";
import type { Lang } from "../../i18n";

/* ---------- variants ---------- */
const CAPS: Record<string, { fabric: string; button: string }> = {
  black: { fabric: "#24242c", button: "#34343f" },
  navy: { fabric: "#1c2a55", button: "#2d4078" },
  maroon: { fabric: "#5e1424", button: "#7e2537" },
};
const TASSELS: Record<string, { color: string; metal: number; rough: number; glint: string }> = {
  gold: { color: "#d9a93a", metal: 0.7, rough: 0.38, glint: "#ffe3a0" },
  silver: { color: "#cfd4de", metal: 0.75, rough: 0.32, glint: "#f2f6ff" },
  crimson: { color: "#b3182f", metal: 0.12, rough: 0.55, glint: "#ffa2ae" },
};

const TAU = Math.PI * 2;
const SCRIPT =
  "'Snell Roundhand', 'Apple Chancery', 'Zapf Chancery', 'URW Chancery L', 'Monotype Corsiva', 'Palatino Linotype', Palatino, Georgia, serif";
const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";
const ARABIC = "'Thmanyah Sans', system-ui, sans-serif";

/* ---------- the stage, in world units (a cap board is ~0.86) ---------- */
const FOV = 38;
const TAN = Math.tan((FOV * Math.PI) / 360);
const PT = 0.52; // plinth top
const PLINTH_W = 2.5;
const PLINTH_D = 1.36;
const PLINTH_Z = 0.1;

/* ---------- the diploma: one sheet, wound on a spiral that shrinks as it unrolls ---------- */
const SHEET_W = 1.6;
const SHEET_H = 2.0;
const SEG = 110;
const CURL = 0.0021; // radius lost per radian of wind — the paper's thickness, per turn / 2π
const CORE_R = 0.03; // the innermost turn never flattens: real scrolls keep their curl
const CORE_LEN = 0.1; // …so this much stays rolled at the foot of the open sheet
const P_MAX = (SHEET_H - CORE_LEN) / SHEET_H;
const ROUT0 = Math.sqrt(CORE_R * CORE_R + 2 * CURL * SHEET_H); // fully rolled radius
const CORE_OUT = Math.sqrt(CORE_R * CORE_R + 2 * CURL * CORE_LEN);
const ROLL_Z = -0.12; // roll centre while it lies on the plinth
const LEAN = -0.13; // the open sheet leans back, its foot forward, like a propped certificate
const YTOP = PT + 0.006 + (SHEET_H - CORE_LEN + 2 * CORE_OUT) * Math.cos(LEAN);
const ZTOP = -0.3;

/* ---------- the cap ---------- */
const BOARD = 0.86;
const BOARD_T = 0.026;
const SKULL_H = 0.17;
const TOP_Y = SKULL_H + BOARD_T;
const TASSEL_L = 0.2; // pendulum length, button-cord to bundle
const REST_YAW = 0.62;
const LAND_YAW = 0.45;
const HERO_REST_POS = new THREE.Vector3(-0.1, PT + 2 * ROUT0, ROLL_Z);
const HERO_REST_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.24, REST_YAW, -0.04));
const HERO_LAND_POS = new THREE.Vector3(-0.44, PT, 0.5);
const HERO_LAND_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, LAND_YAW, 0));
const HERO_SPIN = new THREE.Vector3(0.18, 1, 0.3).normalize();
const RIBBON_X = 0.64;

/* ---------- opening timeline, measured from the throw ---------- */
const HERO_T = 3.6; // up, hang, and back down onto the plinth
const HERO_APEX = 3.4;
const WARP = 0.58; // slow motion: flight time runs at (1 ± WARP) — fast off the hand, slow at the top
const BURST_AT = 1.35;
const TURN0 = 3.95; // the tassel crosses from right to left
const TURN_D = 0.8;
const RIB0 = 4.55;
const RIB_D = 0.8;
const RISE0 = 4.95;
const RISE_D = 0.8;
const UNROLL0 = 5.5;
const UNROLL_D = 1.45;
const REV0 = 4.6;
const REV_D = 1.35;
const END = 7.2;
/* Nobody throws it? The cap gets restless, then goes up on its own. */
const MERCY0 = 3.2;
const MERCY1 = 6.0;
const FLICK_PX = 26; // upward travel that counts as a throw
const TAP_PX = 10; // …and less than this, released, is a tap — which also throws

/* ---------- shots ---------- */
const STAGE_T = new THREE.Vector3(0, 0.8, 0.05);
const STAGE_DIR = new THREE.Vector3(0, 0.17, 1).normalize();
const STAGE_W = 2.6;
const STAGE_H = 1.6;
const SKY_T = new THREE.Vector3(0, 4.5, -2.1);
const SKY_LIFT = new THREE.Vector3(0, 0.3, 1.0);
const REV_T = new THREE.Vector3(0, 1.42, 0);
const REV_DIR = new THREE.Vector3(0, 0.16, 1).normalize();
const REV_W = 1.86;
const REV_H = 2.45;

/** Distance at which a w×h box around the target fills the frame on both axes. */
function fitDist(w: number, h: number, aspect: number): number {
  return Math.max(h / 2 / TAN, w / 2 / (TAN * aspect));
}
/** Slow-motion clock: the same 0..1, but it lingers at the top of the arc. */
const warp = (x: number) => x + (WARP * Math.sin(TAU * x)) / TAU;

/* ---------- textures ---------- */
function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
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

/** Stage boards, running up- and downstage, honey going to amber. */
function buildBoards(): THREE.CanvasTexture {
  const [c, g] = canvas2d(512, 512);
  const rand = mulberry32(88);
  const tones = ["#7a4a28", "#6c3f22", "#84532e", "#744626", "#6f4324", "#7f4d2a"];
  const pw = 512 / 6;
  for (let p = 0; p < 6; p++) {
    const x0 = p * pw;
    g.fillStyle = tones[p];
    g.fillRect(x0, 0, pw, 512);
    for (let k = 0; k < 16; k++) {
      g.strokeStyle = `rgba(${rand() < 0.6 ? "36,18,6" : "190,130,80"},${0.08 + rand() * 0.14})`;
      g.lineWidth = 0.6 + rand() * 1.4;
      const gx = x0 + 4 + rand() * (pw - 8);
      const ph = rand() * TAU;
      g.beginPath();
      for (let y = 0; y <= 512; y += 16) g.lineTo(gx + Math.sin(y * 0.02 + ph) * 2.4, y);
      g.stroke();
    }
    // a butt joint somewhere down each board
    g.fillStyle = "rgba(20,10,4,0.55)";
    g.fillRect(x0, rand() * 512, pw, 2);
    g.fillStyle = "rgba(18,8,2,0.7)";
    g.fillRect(x0, 0, 2, 512);
  }
  const t = srgb(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(18, 13);
  return t;
}
const BOARDS_TEX = buildBoards();

/** Polished walnut for the plinth: long streaks, one direction. */
function buildWalnut(): THREE.CanvasTexture {
  const [c, g] = canvas2d(256, 256);
  g.fillStyle = "#4e3322";
  g.fillRect(0, 0, 256, 256);
  const rand = mulberry32(311);
  for (let i = 0; i < 60; i++) {
    g.strokeStyle = `rgba(${rand() < 0.5 ? "30,16,8" : "132,92,60"},${0.08 + rand() * 0.14})`;
    g.lineWidth = 0.8 + rand() * 2.2;
    const y = rand() * 256;
    const ph = rand() * TAU;
    g.beginPath();
    for (let x = 0; x <= 256; x += 8) g.lineTo(x, y + Math.sin(x * 0.03 + ph) * 3);
    g.stroke();
  }
  const t = srgb(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const WALNUT_TEX = buildWalnut();

/** Velvet: two sets of folds beating against each other, darker toward the flies. */
function buildCurtain(): THREE.CanvasTexture {
  const [c, g] = canvas2d(512, 256);
  for (let x = 0; x < 512; x++) {
    const f = 0.5 + 0.3 * Math.sin((x / 512) * TAU * 6) + 0.2 * Math.sin((x / 512) * TAU * 15 + 1.3);
    // soft folds: a fold catches light over a wide crown and falls into a narrow crease
    const k = Math.pow(clamp01(f), 0.8);
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, `rgb(${10 + 22 * k},${2 + 4 * k},${4 + 5 * k})`);
    gr.addColorStop(0.7, `rgb(${24 + 60 * k},${4 + 10 * k},${8 + 13 * k})`);
    gr.addColorStop(1, `rgb(${30 + 76 * k},${5 + 14 * k},${9 + 17 * k})`);
    g.fillStyle = gr;
    g.fillRect(x, 0, 1, 256);
  }
  const t = srgb(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  return t;
}
const CURTAIN_TEX = buildCurtain();

/** A shaft of light: bright where it leaves the lamp, a soft bell across it. */
function buildBeam(): THREE.CanvasTexture {
  const [c, g] = canvas2d(64, 256);
  const img = g.createImageData(64, 256);
  for (let y = 0; y < 256; y++) {
    const v = y / 255;
    const along = (1 - v) * 0.75 + 0.25 * Math.pow(1 - v, 5) + 0.12;
    const tail = clamp01((1 - v) / 0.08); // no hard floor edge
    for (let x = 0; x < 64; x++) {
      const across = Math.pow(Math.max(0, 1 - Math.abs((x / 63) * 2 - 1)), 2.6);
      const a = across * along * tail;
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * clamp01(a));
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
const BEAM_TEX = buildBeam();
const GLOW = makeRadialSprite(64);
const FLARE = makeRadialSprite(128, [
  [0, "rgba(255,255,255,1)"],
  [0.12, "rgba(255,255,255,0.7)"],
  [0.4, "rgba(255,255,255,0.14)"],
  [1, "rgba(255,255,255,0)"],
]);

/** The up-chevron that says which way the cap wants to go. */
function buildChevron(): THREE.CanvasTexture {
  const [c, g] = canvas2d(128, 96);
  g.strokeStyle = "#fff";
  g.lineWidth = 13;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.shadowColor = "rgba(255,255,255,0.9)";
  g.shadowBlur = 14;
  g.beginPath();
  g.moveTo(26, 70);
  g.lineTo(64, 32);
  g.lineTo(102, 70);
  g.stroke();
  return new THREE.CanvasTexture(c);
}
const CHEVRON = buildChevron();

/** Loose threads, so the tassel reads as a bundle and not a cone. */
function buildStrands(): THREE.CanvasTexture {
  const [c, g] = canvas2d(64, 16);
  const rand = mulberry32(17);
  for (let x = 0; x < 64; x++) {
    const k = 150 + Math.round(rand() * 105);
    g.fillStyle = `rgb(${k},${k},${k})`;
    g.fillRect(x, 0, 1, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}
const STRANDS = buildStrands();

/* ---------- ornament shared by the diploma and the plinth crest ---------- */
function capGlyph(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, fill: string) {
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(cx - s * 0.52, cy + s * 0.1);
  g.lineTo(cx - s * 0.48, cy + s * 0.6);
  g.quadraticCurveTo(cx, cy + s * 0.78, cx + s * 0.48, cy + s * 0.6);
  g.lineTo(cx + s * 0.52, cy + s * 0.1);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(cx, cy - s * 0.36);
  g.lineTo(cx + s, cy);
  g.lineTo(cx, cy + s * 0.36);
  g.lineTo(cx - s, cy);
  g.closePath();
  g.fill();
  g.strokeStyle = fill;
  g.lineWidth = Math.max(1.5, s * 0.07);
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + s * 0.78, cy + s * 0.06);
  g.lineTo(cx + s * 0.78, cy + s * 0.62);
  g.stroke();
  g.beginPath();
  g.ellipse(cx + s * 0.78, cy + s * 0.72, s * 0.08, s * 0.14, 0, 0, TAU);
  g.fill();
}

function laurel(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, side: 1 | -1, fill: string) {
  // a sprig on an arc, leaves alternating, tips toward the top
  g.fillStyle = fill;
  g.strokeStyle = fill;
  g.lineWidth = Math.max(1.2, r * 0.03);
  const a0 = Math.PI * 0.62;
  const a1 = Math.PI * 1.32;
  g.beginPath();
  for (let i = 0; i <= 20; i++) {
    const a = lerp(a0, a1, i / 20);
    g.lineTo(cx - side * Math.cos(a) * r, cy - Math.sin(a) * r * 0.9);
  }
  g.stroke();
  for (let i = 0; i < 7; i++) {
    const a = lerp(a0 + 0.08, a1 - 0.02, i / 6);
    const x = cx - side * Math.cos(a) * r;
    const y = cy - Math.sin(a) * r * 0.9;
    const tang = Math.atan2(-Math.cos(a) * 0.9, side * Math.sin(a));
    for (const o of [-1, 1]) {
      g.save();
      g.translate(x, y);
      g.rotate(tang + o * 0.7);
      g.beginPath();
      g.ellipse(r * 0.1, 0, r * 0.11, r * 0.04, 0, 0, TAU);
      g.fill();
      g.restore();
    }
  }
}

/** Gilt crest for the plinth's front face. */
function buildCrest(): THREE.CanvasTexture {
  const [c, g] = canvas2d(256, 160);
  laurel(g, 128, 104, 70, -1, "#d8aa4c");
  laurel(g, 128, 104, 70, 1, "#d8aa4c");
  capGlyph(g, 128, 66, 40, "#e2b85a");
  return srgb(c);
}
const CREST_TEX = buildCrest();

/* ---------- the diploma, drawn ---------- */
/** Greedy word wrap that also breaks a single run longer than the column. */
function wrapWords(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (g.measureText(w).width > maxW && w.length > 1) {
        let lo = 1;
        let hi = w.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (g.measureText(w.slice(0, mid)).width <= maxW) lo = mid;
          else hi = mid - 1;
        }
        if (line) out.push(line);
        line = "";
        out.push(w.slice(0, lo));
        w = w.slice(lo);
      }
      const cand = line ? `${line} ${w}` : w;
      if (line && g.measureText(cand).width > maxW) {
        out.push(line);
        line = w;
      } else line = cand;
    }
    out.push(line);
  }
  return out;
}

/** Three phase-shifted waves braided round the border band. */
function guilloche(g: CanvasRenderingContext2D, inset: number, w: number, h: number) {
  const A = 8;
  const f = 0.07;
  for (let k = 0; k < 3; k++) {
    const ph = (k * TAU) / 3;
    g.beginPath();
    for (let x = inset; x <= w - inset; x += 3) g.lineTo(x, inset + A * Math.sin(x * f + ph));
    g.stroke();
    g.beginPath();
    for (let x = inset; x <= w - inset; x += 3) g.lineTo(x, h - inset + A * Math.sin(x * f + ph));
    g.stroke();
    g.beginPath();
    for (let y = inset; y <= h - inset; y += 3) g.lineTo(inset + A * Math.sin(y * f + ph), y);
    g.stroke();
    g.beginPath();
    for (let y = inset; y <= h - inset; y += 3) g.lineTo(w - inset + A * Math.sin(y * f + ph), y);
    g.stroke();
  }
}

function rosette(g: CanvasRenderingContext2D, x: number, y: number, fill: string, paper: string) {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(x, y, 17, 0, TAU);
  g.fill();
  g.fillStyle = paper;
  g.beginPath();
  g.arc(x, y, 10, 0, TAU);
  g.fill();
  g.fillStyle = fill;
  g.beginPath();
  g.arc(x, y, 5, 0, TAU);
  g.fill();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    g.beginPath();
    g.arc(x + Math.cos(a) * 25, y + Math.sin(a) * 25, 3, 0, TAU);
    g.fill();
  }
}

const DIP_W = 1024;
const DIP_H = 1280;
// The foot of the sheet stays wound in the core, so the design ends above it.
const DIP_VIS = Math.round(DIP_H * (1 - CORE_LEN / SHEET_H)) - 6;

function buildDiploma(recipient: string, sender: string, message: string, lang: Lang): THREE.CanvasTexture {
  const W = DIP_W;
  const H = DIP_VIS;
  const [c, g] = canvas2d(DIP_W, DIP_H);
  const ar = lang === "ar";
  const rand = mulberry32(1906);
  const PAPER = "#f2e3bd";
  const GILT = "#8f6a2c";
  const GILT_LIGHT = "#c29a4c";
  const INK = "#2a190b";

  /* paper: warm in the middle, foxed toward the edges, fibres throughout */
  g.fillStyle = PAPER;
  g.fillRect(0, 0, DIP_W, DIP_H);
  const warm = g.createRadialGradient(W * 0.5, H * 0.42, W * 0.1, W * 0.5, H * 0.5, W * 0.95);
  warm.addColorStop(0, "rgba(255,250,232,0.75)");
  warm.addColorStop(0.55, "rgba(255,244,214,0)");
  warm.addColorStop(1, "rgba(126,84,34,0.36)");
  g.fillStyle = warm;
  g.fillRect(0, 0, DIP_W, DIP_H);
  for (let i = 0; i < 26; i++) {
    radialBlob(g, rand() * W, rand() * DIP_H, 40 + rand() * 120, `rgba(160,112,52,${(0.025 + rand() * 0.035).toFixed(3)})`);
  }
  g.lineWidth = 1;
  for (let i = 0; i < 1500; i++) {
    const x = rand() * W;
    const y = rand() * DIP_H;
    const a = rand() * TAU;
    const l = 3 + rand() * 10;
    g.strokeStyle = `rgba(${rand() < 0.5 ? "120,82,36" : "255,250,235"},${(0.05 + rand() * 0.08).toFixed(3)})`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }

  /* border: heavy rule, braided band, fine rule, rosettes at the corners */
  g.strokeStyle = GILT;
  g.lineWidth = 8;
  g.strokeRect(34, 34, W - 68, H - 68);
  g.lineWidth = 2;
  g.strokeRect(48, 48, W - 96, H - 96);
  g.strokeStyle = GILT_LIGHT;
  g.lineWidth = 1.3;
  guilloche(g, 66, W, H);
  g.strokeStyle = GILT;
  g.lineWidth = 2;
  g.strokeRect(84, 84, W - 168, H - 168);
  for (const [x, y] of [
    [66, 66],
    [W - 66, 66],
    [66, H - 66],
    [W - 66, H - 66],
  ]) {
    rosette(g, x, y, GILT, PAPER);
  }

  g.direction = ar ? "rtl" : "ltr";
  g.textAlign = "center";
  g.textBaseline = "middle";

  /* crest */
  laurel(g, W / 2, 144, 48, -1, GILT);
  laurel(g, W / 2, 144, 48, 1, GILT);
  capGlyph(g, W / 2, 118, 25, GILT);

  /* header */
  g.fillStyle = "#7a5520";
  if (ar) {
    g.font = `600 36px ${ARABIC}`;
    g.fillText("تُمنح هذه الشهادة إلى", W / 2, 214);
  } else {
    g.font = `600 25px ${SERIF}`;
    g.letterSpacing = "6px";
    g.fillText("THIS DIPLOMA IS PRESENTED TO", W / 2, 214);
    g.letterSpacing = "0px";
  }

  /* the graduate — as large as their name allows, on two lines if it must */
  const name = recipient.trim() || pick(lang, "You", "أنت");
  const nameFont = (sz: number) => (ar ? `700 ${sz}px ${ARABIC}` : `700 ${sz}px ${SCRIPT}`);
  const NAME_W = 780;
  const widthAt = (text: string, sz: number) => {
    g.font = nameFont(sz);
    return g.measureText(text).width;
  };
  let nameLines = [name];
  let ns = ar ? 104 : 118;
  while (ns > 72 && widthAt(name, ns) > NAME_W) ns -= 4;
  const words = name.split(/\s+/).filter(Boolean);
  if (widthAt(name, ns) > NAME_W && words.length > 1) {
    // Split where the two halves come out most even, then size to the longer one.
    let best = 1;
    let bestD = Infinity;
    for (let k = 1; k < words.length; k++) {
      const d = Math.abs(widthAt(words.slice(0, k).join(" "), 60) - widthAt(words.slice(k).join(" "), 60));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    nameLines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
    ns = ar ? 62 : 64;
    while (ns > 44 && Math.max(...nameLines.map((l) => widthAt(l, ns))) > NAME_W) ns -= 2;
  }
  g.font = nameFont(ns);
  g.fillStyle = INK;
  const nameY = nameLines.length === 1 ? [302] : [276, 276 + ns * 0.88];
  nameLines.forEach((line, i) => {
    const w = g.measureText(line).width;
    g.save();
    g.translate(W / 2, nameY[i]);
    // one unbroken run that is still too wide at the floor size: squeeze, don't clip
    if (w > NAME_W) g.scale(NAME_W / w, 1);
    g.fillText(line, 0, 0);
    g.restore();
  });

  /* a swash under the name */
  g.strokeStyle = GILT;
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(W / 2 - 250, 372);
  g.bezierCurveTo(W / 2 - 150, 356, W / 2 - 60, 388, W / 2 - 12, 368);
  g.moveTo(W / 2 + 250, 372);
  g.bezierCurveTo(W / 2 + 150, 356, W / 2 + 60, 388, W / 2 + 12, 368);
  g.stroke();
  g.fillStyle = GILT;
  g.beginPath();
  g.moveTo(W / 2, 360);
  g.lineTo(W / 2 + 9, 369);
  g.lineTo(W / 2, 378);
  g.lineTo(W / 2 - 9, 369);
  g.closePath();
  g.fill();

  /* the honour */
  g.fillStyle = "#6a4a1e";
  g.font = ar ? `500 34px ${ARABIC}` : `italic 400 34px ${SERIF}`;
  g.fillText(pick(lang, "With highest honours in being amazing", "بمرتبة الشرف الأولى… في الروعة"), W / 2, 418);

  /* divider */
  g.strokeStyle = GILT;
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(W / 2 - 170, 462);
  g.lineTo(W / 2 - 18, 462);
  g.moveTo(W / 2 + 18, 462);
  g.lineTo(W / 2 + 170, 462);
  g.stroke();
  g.beginPath();
  g.moveTo(W / 2, 455);
  g.lineTo(W / 2 + 7, 462);
  g.lineTo(W / 2, 469);
  g.lineTo(W / 2 - 7, 462);
  g.closePath();
  g.fill();

  /* the message: shrink until it fits the box, largest first */
  const body =
    message.trim().replace(/\n{3,}/g, "\n\n") ||
    pick(lang, "Throw it high. You earned the sky.", "ارمِها عاليًا… السماء لك");
  const boxTop = 492;
  const boxH = 368;
  const boxW = 760;
  const lh = 1.4;
  let fs = 48;
  let lines: string[] = [];
  for (; fs >= 22; fs -= 2) {
    g.font = ar ? `500 ${fs + 2}px ${ARABIC}` : `400 ${fs}px ${SERIF}`;
    lines = wrapWords(g, body, boxW);
    if (lines.length * fs * lh <= boxH) break;
  }
  fs = Math.max(fs, 22);
  g.fillStyle = "#3a2713";
  const blockH = lines.length * fs * lh;
  const y0 = boxTop + Math.max(0, (boxH - blockH) / 2) + (fs * lh) / 2;
  lines.forEach((l, i) => g.fillText(l, W / 2, y0 + i * fs * lh, boxW + 20));

  /* signature, on its line, over the seal */
  const sig = sender.trim();
  if (sig) {
    const sigFont = (s: number) => (ar ? `600 ${s}px ${ARABIC}` : `700 ${s}px ${SCRIPT}`);
    let ss = ar ? 46 : 60;
    g.font = sigFont(ss);
    while (g.measureText(`— ${sig}`).width > 700 && ss > 34) {
      ss -= 2;
      g.font = sigFont(ss);
    }
    g.fillStyle = INK;
    // fillText's maxWidth squeezes the rare signature still too long at the floor size
    g.fillText(`— ${sig}`, W / 2, 904, 740);
  }
  g.strokeStyle = GILT;
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(W / 2 - 230, 936);
  g.lineTo(W / 2 + 230, 936);
  g.stroke();
  g.fillStyle = "#7a5520";
  if (ar) {
    g.font = `500 24px ${ARABIC}`;
    g.fillText("بكلّ فخر", W / 2, 960);
  } else {
    g.font = `600 17px ${SERIF}`;
    g.letterSpacing = "5px";
    g.fillText("SIGNED WITH PRIDE", W / 2, 960);
    g.letterSpacing = "0px";
  }

  /* the seal: gold ribbon tails, then red wax pressed over them */
  const sx = W / 2;
  const sy = 1044;
  const R = 54;
  for (const side of [-1, 1]) {
    g.save();
    g.translate(sx, sy);
    g.rotate(side * 0.42);
    const rg = g.createLinearGradient(-18, 0, 18, 0);
    rg.addColorStop(0, "#9a6c1c");
    rg.addColorStop(0.5, "#e8c46a");
    rg.addColorStop(1, "#9a6c1c");
    g.fillStyle = rg;
    g.beginPath();
    g.moveTo(-17, 0);
    g.lineTo(17, 0);
    g.lineTo(17, 84);
    g.lineTo(0, 70);
    g.lineTo(-17, 84);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.save();
  g.shadowColor = "rgba(60,20,10,0.45)";
  g.shadowBlur = 10;
  g.shadowOffsetY = 4;
  const wax = g.createRadialGradient(sx - R * 0.35, sy - R * 0.4, R * 0.1, sx, sy, R * 1.1);
  wax.addColorStop(0, "#e2505a");
  wax.addColorStop(0.45, "#b01f30");
  wax.addColorStop(1, "#6a0b17");
  g.fillStyle = wax;
  g.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * TAU;
    const r = R * (1 + 0.05 * Math.sin(a * 7 + 1) + 0.035 * Math.sin(a * 13 + 2.2));
    g.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.restore();
  // the stamp's ring and its device, pressed in: a dark edge and a lit edge
  for (const [dx, col] of [
    [1.5, "rgba(70,0,10,0.55)"],
    [-1, "rgba(255,170,170,0.35)"],
  ] as const) {
    g.strokeStyle = col;
    g.lineWidth = 2.2;
    g.beginPath();
    g.arc(sx + dx, sy + dx, R * 0.7, 0, TAU);
    g.stroke();
    capGlyph(g, sx + dx, sy - 8 + dx, 21, col);
  }
  const tex = srgb(c);
  tex.anisotropy = 8;
  return tex;
}

/* ---------- geometry ---------- */
const BOARD_GEO = new THREE.BoxGeometry(BOARD, BOARD_T, BOARD);
const SKULL_GEO = new THREE.CylinderGeometry(0.245, 0.27, SKULL_H, 32, 1, true);
const BUTTON_GEO = new THREE.CylinderGeometry(0.03, 0.034, 0.014, 16);
const CORD_GEO = new THREE.BoxGeometry(1, 0.009, 0.013);
const HANG_GEO = new THREE.CylinderGeometry(0.006, 0.006, 0.1, 6);
const BARREL_GEO = new THREE.CylinderGeometry(0.019, 0.022, 0.034, 12);
const STRANDS_GEO = new THREE.CylinderGeometry(0.022, 0.04, 0.13, 16, 1, true);
const RIBBON_GEO = new THREE.CylinderGeometry(ROUT0 + 0.004, ROUT0 + 0.004, 0.06, 28, 1, true);
const LOOP_GEO = new THREE.TorusGeometry(0.05, 0.012, 6, 16);
const TAIL_GEO = new THREE.PlaneGeometry(0.045, 0.16);
const CONF_GEO = new THREE.PlaneGeometry(0.6, 1);
const HALO_GEO = new THREE.PlaneGeometry(1, 1);

/** One geometry for a whole thrown cap — board, skull and button — so forty of
 *  them are a single instanced draw. Tassels are left off: at that distance and
 *  that spin nobody can see them, and a tassel per cap is forty more meshes. */
function buildCrowdCap(): THREE.BufferGeometry {
  const parts = [
    new THREE.BoxGeometry(BOARD, BOARD_T, BOARD).translate(0, SKULL_H + BOARD_T / 2, 0),
    new THREE.CylinderGeometry(0.245, 0.27, SKULL_H, 16, 1, false).translate(0, SKULL_H / 2, 0),
    new THREE.CylinderGeometry(0.03, 0.034, 0.014, 8).translate(0, TOP_Y + 0.007, 0),
  ];
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.attributes.position.count;
    ni += p.index!.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const idx = new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, vo * 3);
    nor.set(p.attributes.normal.array as Float32Array, vo * 3);
    const src = p.index!.array;
    for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
    vo += p.attributes.position.count;
    io += src.length;
    p.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}
const CROWD_GEO = buildCrowdCap();

/** A unit trapezoid, narrow at the lamp: a beam hung from its top edge. */
function buildBeamGeo(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(1, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < 2; i++) p.setX(i, p.getX(i) * 0.16); // the top row
  geo.translate(0, -0.5, 0);
  return geo;
}
const BEAM_GEO = buildBeamGeo();

/* Lamps on the truss and the shafts they throw at the plinth. Positions are world. */
const LAMP_Y = 6.05;
const LAMP_Z = -1.4;
const LAMPS = [-3.2, -1.6, 0, 1.6, 3.2];
const BEAMS: { from: [number, number]; to: [number, number]; w: number; z: number; a: number }[] = [
  { from: [-1.6, LAMP_Y], to: [-0.3, 0.3], w: 1.5, z: LAMP_Z + 0.2, a: 0.5 },
  { from: [1.6, LAMP_Y], to: [0.4, 0.3], w: 1.5, z: LAMP_Z + 0.25, a: 0.44 },
  { from: [0, LAMP_Y], to: [0.05, 0.2], w: 1.0, z: LAMP_Z + 0.1, a: 0.3 },
  { from: [-3.2, LAMP_Y], to: [-2.7, 0], w: 1.3, z: LAMP_Z, a: 0.3 },
  { from: [3.2, LAMP_Y], to: [2.8, 0], w: 1.3, z: LAMP_Z, a: 0.3 },
];

/* ---------- the rest of the class ---------- */
const CROWD_N = 40;
interface ThrownCap {
  side: number;
  sy: number;
  sz: number;
  out: number;
  delay: number;
  dur: number;
  apex: number;
  bend: number;
  lx: number;
  ly: number;
  lz: number;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
  turns: number;
  s: number;
  tint: number;
}
const ON_STAGE = 12;
const CROWD: ThrownCap[] = (() => {
  const rand = mulberry32(2026);
  const out: ThrownCap[] = [];
  const spots: [number, number][] = [];
  for (let i = 0; i < CROWD_N; i++) {
    const side = i % 2 ? 1 : -1;
    let lx: number;
    let lz: number;
    if (i < ON_STAGE) {
      // A dozen come down on the boards upstage, spread out so they read as caps
      // and not a heap — never in front of the diploma, never near the lens.
      let tries = 0;
      do {
        lx = (rand() * 2 - 1) * 3.7;
        lz = -3.5 + rand() * 1.5;
        tries++;
      } while (
        tries < 200 &&
        (Math.abs(lx) < 1.1 || spots.some(([x, z]) => (x - lx) ** 2 + (z - lz) ** 2 < 1.1))
      );
      spots.push([lx, lz]);
    } else {
      // …the rest land in the wings, out of every shot.
      lx = side * (5.6 + rand() * 2);
      lz = -3 + rand() * 3;
    }
    const flip = rand() < 0.3;
    const s = 0.82 + rand() * 0.22;
    const tilt = (rand() - 0.5) * 0.16;
    out.push({
      side,
      sy: 0.25 + rand() * 1.2,
      sz: -2.6 + rand() * 2.0,
      out: 0.3 + rand() * 0.8,
      delay: 0.06 + rand() * 0.55,
      dur: 3.0 + rand() * 1.15,
      apex: 3.0 + rand() * 2.6,
      bend: -side * (0.3 + rand() * 0.9),
      lx,
      ly: flip ? TOP_Y * s : 0,
      lz,
      rest: new THREE.Quaternion().setFromEuler(new THREE.Euler((flip ? Math.PI : 0) + tilt, rand() * TAU, tilt)),
      axis: new THREE.Vector3(rand() - 0.5, 1.4, rand() - 0.5).normalize(),
      turns: 1 + Math.floor(rand() * 3),
      s,
      tint: 0.78 + rand() * 0.4,
    });
  }
  return out;
})();

/* ---------- confetti: a few already on the boards, and the burst ---------- */
const REST_N = 26;
const BURST_N = 150;
const CONF_N = REST_N + BURST_N;
const BURST_O = new THREE.Vector3(0, 4.4, -0.6);
const CONF = (() => {
  const rand = mulberry32(515);
  const hues = ["#ffd35a", "#f2b233", "#e0334a", "#fff3d6", "#ffe08a", "#ffffff", "#d9a43a", "#ff6b7d"];
  const col: THREE.Color[] = [];
  const rest: THREE.Matrix4[] = [];
  const o = new THREE.Object3D();
  for (let i = 0; i < CONF_N; i++) col.push(new THREE.Color(hues[Math.floor(rand() * hues.length)]));
  for (let i = 0; i < REST_N; i++) {
    let x: number;
    let y: number;
    let z: number;
    if (i < 7) {
      // on the plinth, off to the right where nothing lands
      x = 0.95 + rand() * 0.3;
      y = PT + 0.002;
      z = -0.5 + rand() * 1.25;
    } else if (i < 10) {
      x = -1.25 + rand() * 0.3;
      y = PT + 0.002;
      z = -0.62 + rand() * 0.45;
    } else {
      const a = rand() * TAU;
      x = Math.cos(a) * (1.5 + rand() * 1.4);
      y = 0.002;
      z = PLINTH_Z + Math.sin(a) * (0.95 + rand() * 0.6);
    }
    o.position.set(x, y, z);
    o.rotation.set(-Math.PI / 2 + (rand() - 0.5) * 0.3, 0, rand() * TAU);
    o.scale.setScalar(0.035 + rand() * 0.015);
    o.updateMatrix();
    rest.push(o.matrix.clone());
  }
  const n = BURST_N;
  const f = () => new Float32Array(n);
  const b = { bx: f(), bz: f(), y0: f(), fall: f(), delay: f(), ph: f(), spin: f(), tilt: f(), drift: f(), s: f(), cyc: f() };
  for (let i = 0; i < n; i++) {
    b.bx[i] = (rand() * 2 - 1) * 2.6;
    b.bz[i] = -1.3 + rand() * 2.9;
    b.y0[i] = 3.6 + rand() * 1.3;
    b.fall[i] = 0.32 + rand() * 0.34;
    b.delay[i] = rand() * 0.3;
    b.ph[i] = rand() * TAU;
    b.spin[i] = (rand() - 0.5) * 9;
    b.tilt[i] = 2 + rand() * 4.5;
    b.drift[i] = (rand() - 0.5) * 0.7;
    b.s[i] = 0.032 + rand() * 0.022;
    b.cyc[i] = (b.y0[i] + 0.1) / b.fall[i];
  }
  return { col, rest, ...b };
})();

/* ---------- dust in the beams, in every phase ---------- */
const MOTE_N = 56;
const MOTES = (() => {
  const rand = mulberry32(1789);
  const f = () => new Float32Array(MOTE_N);
  const m = { x: f(), y: f(), z: f(), sp: f(), w: f(), ph: f(), k: f() };
  for (let i = 0; i < MOTE_N; i++) {
    m.x[i] = (rand() * 2 - 1) * 2.1;
    m.y[i] = rand() * 4.6;
    m.z[i] = -1.3 + rand() * 1.9;
    m.sp[i] = 0.04 + rand() * 0.08;
    m.w[i] = 0.3 + rand() * 0.9;
    m.ph[i] = rand() * TAU;
    m.k[i] = 0.3 + rand() * 0.7;
  }
  return m;
})();

/* ---------- the sheet's wind ---------- */
// Distance of each vertex from the top edge, and its x — for PlaneGeometry(W, H, 1, SEG),
// whose rows run top to bottom.
const SHEET_S = new Float32Array((SEG + 1) * 2);
const SHEET_X = new Float32Array((SEG + 1) * 2);
for (let iy = 0; iy <= SEG; iy++) {
  for (let ix = 0; ix <= 1; ix++) {
    SHEET_S[iy * 2 + ix] = (iy / SEG) * SHEET_H;
    SHEET_X[iy * 2 + ix] = (ix - 0.5) * SHEET_W;
  }
}

/**
 * Lay the top `p` of the sheet flat, hanging down from the top edge, and wind the
 * rest onto an Archimedean spiral that curls *toward the camera* — so the inked
 * face is inside the roll, and the outside shows the back of the paper. The roll
 * gets smaller as it gives up length: r = rOut − CURL·θ, with rOut sized so the
 * remaining paper ends exactly on the core.
 */
function rollSheet(pos: THREE.BufferAttribute, p: number) {
  const L = p * SHEET_H;
  const rOut = Math.sqrt(CORE_R * CORE_R + 2 * CURL * (SHEET_H - L));
  for (let i = 0; i < pos.count; i++) {
    const s = SHEET_S[i];
    const x = SHEET_X[i];
    if (s <= L) {
      pos.setXYZ(i, x, -s, 0);
    } else {
      const d = s - L;
      const th = (rOut - Math.sqrt(Math.max(0, rOut * rOut - 2 * CURL * d))) / CURL;
      const r = rOut - CURL * th;
      pos.setXYZ(i, x, -L - r * Math.sin(th), rOut - r * Math.cos(th));
    }
  }
  pos.needsUpdate = true;
}

/* ---------- scratch: nothing is allocated per frame ---------- */
const _obj = new THREE.Object3D();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _camS = new THREE.Vector3();
const _camR = new THREE.Vector3();
const _look = new THREE.Vector3();
const _e = new THREE.Euler();
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);

/** Everything the gesture and the one-shot sounds remember. Reset wholesale per run. */
function freshToss() {
  return {
    down: false,
    touched: false,
    hover: false,
    hoverK: 0,
    x0: 0,
    y0: 0,
    drag: 0, // upward drag, 0..1 of the throw threshold
    moved: 0,
    want: false,
    alone: 0,
    lift: 0,
    liftAt: 0,
    flickAt: -1,
    // the tassel's pendulum, in world angles, and the finite-difference state feeding it
    ax: 0,
    az: 0,
    vax: 0,
    vaz: 0,
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vz: 0,
    primed: false,
    popped: false,
    thud: false,
    chimed: false,
    slipped: false,
    rustled: false,
    fanfare: false,
    patter: 0,
  };
}

export default function MortarboardScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const cap = CAPS[variants.cap] ?? CAPS.black;
  const tassel = TASSELS[variants.tassel] ?? TASSELS.gold;

  const diploma = useMemo(
    () => buildDiploma(recipientName, senderName, message, lang),
    [recipientName, senderName, message, lang],
  );
  useEffect(() => () => diploma.dispose(), [diploma]);

  // Front and back share one grid, wound to the fully rolled pose before first paint.
  const sheetGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(SHEET_W, SHEET_H, 1, SEG);
    rollSheet(geo.attributes.position as THREE.BufferAttribute, 0);
    geo.computeVertexNormals();
    // How far this particular grid is unrolled lives on the grid itself, so a
    // rebuilt geometry can never be mistaken for one already wound elsewhere.
    geo.userData.p = 0;
    return geo;
  }, []);
  useEffect(() => () => sheetGeo.dispose(), [sheetGeo]);

  const moteBuf = useMemo(
    () => ({ pos: new Float32Array(MOTE_N * 3), col: new Float32Array(MOTE_N * 3) }),
    [],
  );

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const g = useRef(freshToss());
  const spawnRef = useRef({ x: new Float32Array(CROWD_N), z: new Float32Array(CROWD_N) });
  const revAtRef = useRef(-1);
  const confIdleRef = useRef(false);
  useEffect(() => {
    if (phase === "opening") {
      g.current = freshToss();
      confIdleRef.current = false;
    }
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const keyRef = useRef<THREE.SpotLight>(null);
  const rimRef = useRef<THREE.SpotLight>(null);
  const fillRef = useRef<THREE.PointLight>(null);
  const upRef = useRef<THREE.PointLight>(null);
  const heroRef = useRef<THREE.Group>(null);
  const pivotRef = useRef<THREE.Group>(null);
  const cordRef = useRef<THREE.Mesh>(null);
  const edgeRef = useRef<THREE.Group>(null);
  const hangRef = useRef<THREE.Group>(null);
  const scrollRef = useRef<THREE.Group>(null);
  const sheetRef = useRef<THREE.Mesh>(null);
  const ribbonRef = useRef<THREE.Group>(null);
  const bowRef = useRef<THREE.Group>(null);
  const crowdRef = useRef<THREE.InstancedMesh>(null);
  const confRef = useRef<THREE.InstancedMesh>(null);
  const motesRef = useRef<THREE.Points>(null);
  const beamMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const flareMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const hazeMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const poolMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const chevRef = useRef<THREE.Group>(null);
  const chevMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const glintRef = useRef<THREE.Mesh>(null);
  const glintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const turnGlintRef = useRef<THREE.Mesh>(null);
  const turnGlintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  // Spot targets are not in the scene graph, so their matrices are set by hand, once.
  useLayoutEffect(() => {
    const k = keyRef.current;
    if (k) {
      k.target.position.set(0, 0.9, 0.1);
      k.target.updateMatrixWorld();
    }
    const r = rimRef.current;
    if (r) {
      r.target.position.set(0, 0.7, 0);
      r.target.updateMatrixWorld();
    }
  }, []);

  // The class all wore the same colour; the light catches each one a little differently.
  useLayoutEffect(() => {
    const m = crowdRef.current;
    if (!m) return;
    const base = new THREE.Color(cap.fabric);
    const c = new THREE.Color();
    for (let i = 0; i < CROWD_N; i++) m.setColorAt(i, c.copy(base).multiplyScalar(CROWD[i].tint));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [cap]);

  // Confetti colours never change, and the pieces already on the boards never move.
  useLayoutEffect(() => {
    const m = confRef.current;
    if (!m) return;
    for (let i = 0; i < CONF_N; i++) m.setColorAt(i, CONF.col[i]);
    for (let i = 0; i < REST_N; i++) m.setMatrixAt(i, CONF.rest[i]);
    _obj.position.set(0, -5, 0);
    _obj.scale.setScalar(0);
    _obj.updateMatrix();
    for (let i = REST_N; i < CONF_N; i++) m.setMatrixAt(i, _obj.matrix);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, []);

  /* ---------- the throw ---------- */
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const c = g.current;
    if (phase !== "opening" || c.flickAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — the threshold throws mid-move anyway */
    }
    c.down = true;
    c.touched = true;
    c.alone = 0;
    c.x0 = ev.nativeEvent.clientX;
    c.y0 = ev.nativeEvent.clientY;
    c.moved = 0;
    c.drag = 0;
    // the fabric under your finger
    clack({ freq: 900, decay: 0.035, gain: 0.07 });
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (phase !== "opening" || c.flickAt >= 0) return;
    // anyone even hovering is somebody about to throw: the cap stops throwing itself
    c.alone = 0;
    if (!c.down) return;
    ev.stopPropagation();
    // Screen pixels, not world units: "up" is up on every canvas and at every zoom.
    const up = c.y0 - ev.nativeEvent.clientY;
    const dx = ev.nativeEvent.clientX - c.x0;
    c.moved = Math.max(c.moved, Math.hypot(dx, up));
    c.drag = clamp01(up / FLICK_PX);
    if (up >= FLICK_PX) c.want = true;
  };
  const onUp = () => {
    const c = g.current;
    // a tap on the cap throws it too — not everyone flicks
    if (c.down && phase === "opening" && c.flickAt < 0 && c.moved < TAP_PX) c.want = true;
    c.down = false;
    c.drag = 0;
  };
  const onCancel = () => {
    g.current.down = false;
    g.current.drag = 0;
  };
  const onOver = () => {
    g.current.hover = true;
  };
  const onOut = () => {
    g.current.hover = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    const opening = phase === "opening";
    if (opening) tRef.current += dt;
    const t = tRef.current;
    const c = g.current;
    const aspect = state.size.width / Math.max(1, state.size.height);

    /* ---- the stage shot, sized so the plinth fits on both axes ---- */
    const dS = fitDist(STAGE_W, STAGE_H, aspect);
    _camS.copy(STAGE_T).addScaledVector(STAGE_DIR, dS);

    /* ---- the throw: a real finger, or the cap finally going by itself ---- */
    if (opening && c.flickAt < 0) {
      // Idle is measured from the last *movement*, not from contact: a finger pressed
      // and forgotten on the glass must not hold the gift shut forever.
      c.alone += dt;
      if (c.want || c.alone >= MERCY1) {
        c.flickAt = t;
        c.liftAt = c.lift;
        // The rest of the class throws from just outside whatever this screen can
        // see — so on a phone and on a laptop they both arrive from off-frame.
        const cam = camRef.current;
        const cz = cam ? cam.position.z : _camS.z;
        const sp = spawnRef.current;
        for (let i = 0; i < CROWD_N; i++) {
          const k = CROWD[i];
          const z = Math.min(k.sz, cz - 2.8);
          const halfW = (cz - z) * TAN * aspect;
          sp.z[i] = z;
          sp.x[i] = k.side * (halfW + k.out);
        }
        swell({ source: "noise", filter: "highpass", cutoff: 1600, attack: 0.03, hold: 0.06, release: 0.4, gain: 0.12 });
        // the hall goes up with it
        swell({ source: "noise", cutoff: 850, q: 0.5, attack: 0.55, hold: 1.5, release: 2.4, gain: 0.26, when: 0.12 });
        tone(523, { seconds: 0.9, gain: 0.08, shimmer: true, when: 0.05 });
      }
    }
    const post = phase === "revealed" ? END : opening && c.flickAt >= 0 ? t - c.flickAt : -1;
    const thrown = post >= 0;

    const kSky = thrown ? smooth(clamp01((post - 0.08) / 1.25)) * (1 - smooth(clamp01((post - 2.2) / 1.35))) : 0;
    const kRev = thrown ? smooth(clamp01((post - REV0) / REV_D)) : 0;
    const flash = post > BURST_AT ? Math.exp(-(post - BURST_AT) * 1.4) : 0;

    /* ---- one-shot sounds, opening only (a cold `revealed` is silent) ---- */
    if (opening && thrown) {
      if (!c.popped && post >= BURST_AT) {
        c.popped = true;
        clack({ freq: 320, decay: 0.22, gain: 0.2 });
        clack({ freq: 2400, decay: 0.12, gain: 0.08, when: 0.03 });
      }
      if (!c.thud && post >= HERO_T) {
        c.thud = true;
        clack({ freq: 230, decay: 0.14, gain: 0.24 });
      }
      if (!c.chimed && post >= TURN0 + TURN_D * 0.55) {
        c.chimed = true;
        tone(784, { seconds: 1.2, gain: 0.16, shimmer: true });
        tone(1175, { seconds: 1.4, gain: 0.08, shimmer: true, when: 0.14 });
      }
      if (!c.slipped && post >= RIB0 + RIB_D * 0.2) {
        c.slipped = true;
        clack({ freq: 2600, decay: 0.05, gain: 0.05 });
      }
      if (!c.rustled && post >= UNROLL0) {
        c.rustled = true;
        swell({ source: "noise", cutoff: 3400, q: 0.7, attack: 0.15, hold: UNROLL_D * 0.7, release: 0.4, gain: 0.06 });
      }
      if (!c.fanfare && post >= UNROLL0 + UNROLL_D) {
        c.fanfare = true;
        tone(523, { seconds: 1.4, gain: 0.14, shimmer: true });
        tone(659, { seconds: 1.4, gain: 0.12, shimmer: true, when: 0.12 });
        tone(784, { seconds: 1.8, gain: 0.12, shimmer: true, when: 0.24 });
      }
    }

    /* ---- the hero cap ---- */
    const hero = heroRef.current;
    const mercy = opening && !thrown ? smooth(clamp01((c.alone - MERCY0) / (MERCY1 - MERCY0))) : 0;
    const wantHover = c.hover && opening && !thrown ? 1 : 0;
    c.hoverK += (wantHover - c.hoverK) * Math.min(1, dt * 8);
    if (hero) {
      if (!thrown) {
        // It sits; asked to go, it lifts a little and bobs — up is the hint. Left
        // alone long enough it starts straining to go on its own.
        let lift = 0;
        if (opening) {
          const invite = (0.028 + 0.02 * Math.sin(e * 3.1)) * clamp01(t / 0.6);
          lift = invite + c.hoverK * 0.035 + c.drag * 0.12 + mercy * (0.05 + 0.035 * Math.sin(e * 17));
        }
        c.lift = lift;
        hero.position.set(HERO_REST_POS.x, HERO_REST_POS.y + lift, HERO_REST_POS.z);
        _e.set(mercy * 0.06 * Math.sin(e * 23) + lift * 0.4, 0, mercy * 0.05 * Math.sin(e * 19 + 1));
        hero.quaternion.copy(HERO_REST_Q).multiply(_q.setFromEuler(_e));
      } else if (post < HERO_T) {
        // Up, a long hang at the top in slow motion, and down onto the plinth. Whole
        // turns only, so the spin lands exactly on the resting pose.
        const w = warp(post / HERO_T);
        const arc = Math.sin(Math.PI * w);
        hero.position.set(
          lerp(HERO_REST_POS.x, HERO_LAND_POS.x, w) + arc * 0.5,
          lerp(HERO_REST_POS.y + c.liftAt, HERO_LAND_POS.y, w) + 4 * HERO_APEX * w * (1 - w),
          lerp(HERO_REST_POS.z, HERO_LAND_POS.z, w) - arc * 1.1,
        );
        _q.slerpQuaternions(HERO_REST_Q, HERO_LAND_Q, smooth(w));
        _q.multiply(_q2.setFromAxisAngle(HERO_SPIN, TAU * 2 * w));
        _q.multiply(_q2.setFromAxisAngle(AX_X, TAU * w));
        hero.quaternion.copy(_q);
      } else {
        // it lands, bounces once off the felt, rocks, and is still
        const k = post - HERO_T;
        const live = k < 1.2 ? 1 : 0;
        const hop = live * Math.abs(Math.sin(k * 10)) * 0.05 * Math.exp(-k * 6);
        hero.position.set(HERO_LAND_POS.x, HERO_LAND_POS.y + hop, HERO_LAND_POS.z);
        const rock = live * Math.exp(-k * 4.5) * Math.sin(k * 17);
        hero.quaternion.copy(HERO_LAND_Q);
        hero.quaternion.multiply(_q.setFromAxisAngle(AX_X, rock * 0.1));
        hero.quaternion.multiply(_q.setFromAxisAngle(AX_Z, rock * 0.07));
      }
    }

    /* ---- the tassel: right to left across the front, then it hangs and swings ---- */
    const turnK = thrown ? easeInOut(clamp01((post - TURN0) / TURN_D)) : 0;
    const phi = lerp(-REST_YAW, -Math.PI - LAND_YAW, turnK);
    const cordLift = Math.sin(Math.PI * turnK) * 0.75;
    // a square board: the cord runs from the button to wherever the edge is
    const cordL = BOARD / 2 / Math.max(Math.abs(Math.cos(phi)), Math.abs(Math.sin(phi))) + 0.004;
    if (pivotRef.current) pivotRef.current.rotation.set(0, phi, cordLift);
    if (cordRef.current) {
      cordRef.current.scale.x = cordL;
      cordRef.current.position.x = cordL / 2;
    }
    const edge = edgeRef.current;
    const hang = hangRef.current;
    if (edge && hang) {
      edge.position.x = cordL;
      if (opening) {
        // A real pendulum while anything is moving it: the hanger's own acceleration
        // (the throw, the spin, the turn) is what swings the bundle.
        edge.getWorldPosition(_v);
        if (!c.primed) {
          c.primed = true;
          c.px = _v.x;
          c.pz = _v.z;
          c.vx = c.vz = 0;
        }
        // a zero-length frame would turn the differences into NaN and lose the tassel
        const idt = 1 / Math.max(dt, 1e-3);
        const nvx = (_v.x - c.px) * idt;
        const nvz = (_v.z - c.pz) * idt;
        const accX = Math.max(-40, Math.min(40, (nvx - c.vx) * idt));
        const accZ = Math.max(-40, Math.min(40, (nvz - c.vz) * idt));
        c.px = _v.x;
        c.pz = _v.z;
        c.vx = nvx;
        c.vz = nvz;
        const gl = 9.8 / TASSEL_L;
        c.vaz += (-gl * Math.sin(c.az) - (accX / TASSEL_L) * Math.cos(c.az) - 2.4 * c.vaz) * dt;
        c.vax += (-gl * Math.sin(c.ax) + (accZ / TASSEL_L) * Math.cos(c.ax) - 2.4 * c.vax) * dt;
        c.az = Math.max(-1.3, Math.min(1.3, c.az + c.vaz * dt));
        c.ax = Math.max(-1.3, Math.min(1.3, c.ax + c.vax * dt));
        // the invitation keeps it swaying a little until the throw
        if (!thrown) c.az += Math.sin(e * 2.1) * 0.004;
      } else {
        // Idle phases are closed forms, so a cold frame is already the settled one.
        const amp = phase === "preview" ? 0.2 : phase === "sealed" ? 0.1 : 0.05;
        c.az = amp * Math.sin(e * 1.9);
        c.ax = amp * 0.5 * Math.sin(e * 1.3 + 1);
        c.primed = false;
      }
      _e.set(c.ax, 0, c.az);
      _q.setFromEuler(_e);
      edge.getWorldQuaternion(_qp);
      hang.quaternion.copy(_qp.invert().multiply(_q));
      // The moment itself gets a glint: the bundle catches the light as it crosses.
      const tg = turnGlintRef.current;
      const tgm = turnGlintMatRef.current;
      if (tg && tgm) {
        const on = turnK > 0 && turnK < 1;
        tg.visible = on;
        if (on) {
          hang.getWorldPosition(tg.position);
          tg.position.y -= 0.12;
          tg.position.z += 0.08;
          const k = Math.sin(Math.PI * turnK);
          tg.scale.setScalar(0.3 + 0.35 * k);
          tgm.opacity = k * k * 0.9;
        }
      }
    }

    /* ---- the ribbon: bow undone, slid off the end, dropped on the plinth ---- */
    const rk = thrown ? clamp01((post - RIB0) / RIB_D) : 0;
    if (ribbonRef.current) {
      const slide = smooth(clamp01((rk - 0.1) / 0.45));
      const fall = clamp01((rk - 0.5) / 0.5);
      const drop = fall * fall;
      const r = ribbonRef.current;
      r.position.set(
        lerp(RIBBON_X, SHEET_W / 2 + 0.05, slide) + fall * 0.14,
        lerp(PT + ROUT0, PT + 0.009, drop),
        lerp(ROLL_Z, 0.42, smooth(fall)),
      );
      r.rotation.set(0, fall * 0.5, lerp(Math.PI / 2, 0, smooth(fall)));
      r.scale.set(1, lerp(1, 0.25, smooth(fall)), 1);
    }
    if (bowRef.current) bowRef.current.scale.setScalar(Math.max(0.001, 1 - smooth(clamp01(rk / 0.3))));

    /* ---- the diploma: up off the plinth, then unrolled toward the camera ---- */
    const riseK = thrown ? smooth(clamp01((post - RISE0) / RISE_D)) : 0;
    const unK = thrown ? easeInOut(clamp01((post - UNROLL0) / UNROLL_D)) : 0;
    if (scrollRef.current) {
      const s = scrollRef.current;
      s.position.set(
        0,
        lerp(PT + ROUT0, YTOP, riseK) + Math.sin(Math.PI * riseK) * 0.12,
        lerp(ROLL_Z - ROUT0, ZTOP, riseK) + Math.sin(Math.PI * riseK) * 0.2,
      );
      s.rotation.x = LEAN * riseK;
      // …and it breathes a little once it is open, so the reveal is not a photograph
      s.rotation.z = kRev * Math.sin(e * 0.6) * 0.006;
    }
    const p = unK * P_MAX;
    const sheet = sheetRef.current;
    if (sheet && Math.abs(p - (sheet.geometry.userData.p as number)) > 1e-5) {
      sheet.geometry.userData.p = p;
      rollSheet(sheet.geometry.attributes.position as THREE.BufferAttribute, p);
      sheet.geometry.computeVertexNormals();
    }

    /* ---- the rest of the class ---- */
    const crowd = crowdRef.current;
    if (crowd) {
      crowd.visible = thrown;
      if (thrown) {
        const sp = spawnRef.current;
        const cold = phase === "revealed";
        for (let i = 0; i < CROWD_N; i++) {
          const k = CROWD[i];
          const tl = post - k.delay;
          // A cold `revealed` never saw the throw, so it has no spawn points — it
          // does not need them: every cap is already down on the boards.
          const u = cold ? 1 : clamp01(tl / k.dur);
          const w = warp(u);
          const arc = Math.sin(Math.PI * w);
          if (u >= 1) {
            const kl = tl - k.dur;
            const hop = !cold && kl < 0.8 ? Math.abs(Math.sin(kl * 11)) * 0.05 * Math.exp(-kl * 7) : 0;
            _obj.position.set(k.lx, k.ly + hop, k.lz);
            _obj.quaternion.copy(k.rest);
            if (opening && c.patter <= i && kl >= 0) {
              c.patter = i + 1;
              if (i % 3 === 0) clack({ freq: 420 + (i % 5) * 60, decay: 0.05, gain: 0.05 });
            }
          } else {
            _obj.position.set(
              lerp(sp.x[i], k.lx, w) + arc * k.bend,
              lerp(k.sy, k.ly, w) + 4 * k.apex * w * (1 - w),
              lerp(sp.z[i], k.lz, w) - arc * 0.8,
            );
            _obj.quaternion.copy(k.rest).multiply(_q.setFromAxisAngle(k.axis, TAU * k.turns * w));
          }
          _obj.scale.setScalar(k.s);
          _obj.updateMatrix();
          crowd.setMatrixAt(i, _obj.matrix);
        }
        crowd.instanceMatrix.needsUpdate = true;
      }
    }

    /* ---- confetti ---- */
    if (phase === "revealed") {
      if (revAtRef.current < 0) revAtRef.current = e;
    } else revAtRef.current = -1;
    // `revealed` runs on wall time from where the opening left off, so the phase flip
    // does not teleport a hundred and fifty pieces.
    const confT = phase === "revealed" ? END + (e - revAtRef.current) : post;
    const conf = confRef.current;
    if (conf) {
      if (confT < BURST_AT) {
        if (!confIdleRef.current) {
          confIdleRef.current = true;
          _obj.position.set(0, -5, 0);
          _obj.rotation.set(0, 0, 0);
          _obj.scale.setScalar(0);
          _obj.updateMatrix();
          for (let i = REST_N; i < CONF_N; i++) conf.setMatrixAt(i, _obj.matrix);
          conf.instanceMatrix.needsUpdate = true;
        }
      } else {
        confIdleRef.current = false;
        const breeze = Math.sin(e * 0.31) * 0.5 + Math.sin(e * 0.11) * 0.3;
        for (let j = 0; j < BURST_N; j++) {
          const k = confT - BURST_AT - CONF.delay[j];
          const i = REST_N + j;
          if (k < 0) {
            _obj.scale.setScalar(0);
          } else {
            const cyc = CONF.cyc[j];
            const n = Math.floor(k / cyc);
            const kk = k - n * cyc;
            const ph = CONF.ph[j];
            let x = CONF.bx[j];
            let y = CONF.y0[j] - CONF.fall[j] * kk;
            let z = CONF.bz[j];
            if (n === 0) {
              // the first fall starts as a burst out of one point in the haze
              const out = 1 - Math.exp(-kk * 2.6);
              x = lerp(BURST_O.x, x, out);
              z = lerp(BURST_O.z, z, out);
              y = lerp(BURST_O.y, CONF.y0[j], out) + 0.7 * out * Math.exp(-kk * 1.2) - CONF.fall[j] * kk;
            }
            _obj.position.set(
              x + Math.sin(kk * 1.6 + ph) * CONF.drift[j] + breeze * kk * 0.06,
              y,
              z + Math.sin(kk * 1.1 + ph) * 0.08,
            );
            _obj.rotation.set(kk * CONF.tilt[j], kk * CONF.spin[j] + ph, Math.sin(kk * 2.7 + ph) * 0.6);
            // taper at both ends of each fall, so a recycled piece never pops
            _obj.scale.setScalar(CONF.s[j] * clamp01(kk * 4) * clamp01((cyc - kk) * 1.5));
          }
          _obj.updateMatrix();
          conf.setMatrixAt(i, _obj.matrix);
        }
        conf.instanceMatrix.needsUpdate = true;
      }
    }

    /* ---- dust drifting through the beams ---- */
    const mp = motesRef.current;
    if (mp) {
      const pa = mp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = mp.geometry.attributes.color as THREE.BufferAttribute;
      const gain = 0.5 + kSky * 0.4 + flash * 0.6;
      for (let i = 0; i < MOTE_N; i++) {
        pa.setXYZ(
          i,
          MOTES.x[i] + Math.sin(e * MOTES.w[i] + MOTES.ph[i]) * 0.12,
          0.3 + ((MOTES.y[i] + e * MOTES.sp[i]) % 4.6),
          MOTES.z[i],
        );
        const k = (0.3 + 0.7 * Math.abs(Math.sin(e * MOTES.w[i] * 1.6 + MOTES.ph[i]))) * MOTES.k[i] * gain;
        ca.setXYZ(i, k, k * 0.82, k * 0.56);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- light: lamps never sit quite still; the burst floods the haze ---- */
    const hum = 1 + 0.035 * Math.sin(e * 2.3) + 0.018 * Math.sin(e * 7.7 + 1.2);
    for (let i = 0; i < BEAMS.length; i++) {
      const m = beamMats.current[i];
      if (m) m.opacity = BEAMS[i].a * (1 + 0.08 * Math.sin(e * (0.9 + i * 0.37) + i)) * hum * (1 + 0.8 * flash + 0.3 * kSky);
    }
    for (let i = 0; i < flareMats.current.length; i++) {
      const m = flareMats.current[i];
      if (m) m.opacity = (0.75 + 0.1 * Math.sin(e * 3.1 + i * 1.7)) * (1 + flash);
    }
    if (hazeMatRef.current) hazeMatRef.current.opacity = (0.1 + 0.35 * kSky + 0.45 * flash) * hum;
    if (poolMatRef.current) poolMatRef.current.opacity = (0.22 + 0.06 * kRev) * hum;
    if (keyRef.current) keyRef.current.intensity = (2.4 + 0.5 * kRev) * hum;
    if (rimRef.current) rimRef.current.intensity = 1.6 * hum;
    if (fillRef.current) fillRef.current.intensity = 0.15 + 0.75 * kRev;
    if (upRef.current) upRef.current.intensity = 1.6 * kSky + 0.6 * flash;

    // the cap's shadow on the plinth, gone while it is in the air
    if (shadowRef.current && shadowMatRef.current && hero) {
      const air = clamp01((hero.position.y - PT - 0.25) / 0.8);
      shadowRef.current.position.set(hero.position.x, PT + 0.003, hero.position.z);
      shadowMatRef.current.opacity = 0.42 * (1 - air);
    }

    /* ---- the invitation: chevrons rising off the cap, until it goes ---- */
    const inviting = opening && !thrown ? clamp01((t - 0.5) / 0.6) : 0;
    if (chevRef.current) {
      chevRef.current.visible = inviting > 0.01;
      if (inviting > 0.01) {
        for (let i = 0; i < 3; i++) {
          const ch = chevRef.current.children[i];
          const ph = (e * 0.85 + i / 3) % 1;
          ch.position.y = ph * 0.42;
          const m = chevMats.current[i];
          if (m) m.opacity = Math.sin(ph * Math.PI) * 0.62 * inviting * (1 + c.hoverK * 0.5 + mercy * 0.4);
        }
      }
    }
    if (glintRef.current && glintMatRef.current) {
      const want = phase === "sealed" ? 0.2 + 0.08 * Math.sin(e * 2.2) : opening && !thrown ? 0.2 + 0.12 * Math.sin(e * 3.1) + c.hoverK * 0.2 : phase === "preview" ? 0.14 : 0;
      glintMatRef.current.opacity = want;
      glintRef.current.visible = want > 0.005;
    }

    /* ---- camera: stage → up into the caps → back down → the diploma ---- */
    const cam = camRef.current;
    if (cam) {
      _camR.copy(REV_T).addScaledVector(REV_DIR, fitDist(REV_W, REV_H, aspect));
      cam.position.lerpVectors(_camS, _camR, kRev).addScaledVector(SKY_LIFT, kSky);
      _look.lerpVectors(STAGE_T, REV_T, kRev).lerp(SKY_T, kSky);
      if (phase === "preview") {
        cam.position.x += Math.sin(e * 0.21) * 0.09 * dS;
        cam.position.y += Math.sin(e * 0.17) * 0.02 * dS;
      } else if (phase === "sealed") {
        cam.position.x += state.pointer.x * 0.12;
        cam.position.y += state.pointer.y * 0.05 + Math.sin(e * 0.4) * 0.01;
      } else {
        // handheld, and a knock when the cap comes down
        const k = post - HERO_T;
        const knock = k > 0 && k < 0.4 ? Math.exp(-k * 10) * Math.sin(k * 60) * 0.02 : 0;
        cam.position.x += Math.sin(e * 0.37) * 0.012;
        cam.position.y += Math.sin(e * 0.53) * 0.008 + knock;
      }
      cam.lookAt(_look);
    }

    if (opening && post > END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const fabric = <meshStandardMaterial color={cap.fabric} roughness={0.72} metalness={0.04} side={THREE.DoubleSide} />;
  const threadMat = <meshStandardMaterial color={tassel.color} metalness={tassel.metal} roughness={tassel.rough} />;

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault fov={FOV} near={0.1} far={80} position={[0, 1.5, 3]} />
      <ambientLight intensity={0.1} color="#ffe2c4" />
      <hemisphereLight args={["#ffd9a8", "#1c0d08", 0.3]} />
      {/* front-of-house key, and a rim from the flies behind */}
      <spotLight ref={keyRef} position={[-1.8, 5.6, 3.6]} angle={0.34} penumbra={0.65} intensity={2.4} decay={0} color="#ffd9a6" />
      <spotLight ref={rimRef} position={[2.2, 5.4, -2.6]} angle={0.5} penumbra={0.8} intensity={1.6} decay={0} color="#ffbf73" />
      <pointLight ref={fillRef} position={[0.5, 2.2, 3]} intensity={0.15} decay={0} color="#fff0dc" />
      {/* footlights: only up while the caps are in the air, so they are caps and not holes */}
      <pointLight ref={upRef} position={[0, 0.6, 3.2]} intensity={0} decay={0} color="#ffb877" />

      {/* the curtain at the back of the stage */}
      <mesh position={[0, 5, -4.2]}>
        <planeGeometry args={[30, 16]} />
        <meshStandardMaterial map={CURTAIN_TEX} roughness={0.95} />
      </mesh>
      {/* spill from the lamps on the velvet, behind the plinth */}
      <mesh position={[0, 1.6, -4.15]} geometry={HALO_GEO} scale={[7, 4.6, 1]}>
        <meshBasicMaterial map={GLOW} color="#a8502c" transparent opacity={0.26} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* the haze the lamps light up, and the caps against it */}
      <mesh position={[0, 5.6, -3.95]} geometry={HALO_GEO} scale={[17, 10, 1]}>
        <meshBasicMaterial ref={hazeMatRef} map={GLOW} color="#ffcf8c" transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      {/* the truss and its lamps */}
      <mesh position={[0, LAMP_Y + 0.22, LAMP_Z - 0.05]}>
        <boxGeometry args={[9, 0.1, 0.1]} />
        <meshStandardMaterial color="#1a1512" roughness={0.6} metalness={0.5} />
      </mesh>
      {LAMPS.map((x, i) => (
        <group key={i} position={[x, LAMP_Y, LAMP_Z]}>
          <mesh rotation={[0.5, 0, 0]}>
            <cylinderGeometry args={[0.12, 0.15, 0.3, 12]} />
            <meshStandardMaterial color="#141110" roughness={0.5} metalness={0.6} />
          </mesh>
          <mesh position={[0, -0.12, 0.12]} geometry={HALO_GEO} scale={1.3}>
            <meshBasicMaterial
              ref={(m) => {
                flareMats.current[i] = m;
              }}
              map={FLARE}
              color="#ffe2b0"
              transparent
              opacity={0.8}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
      {/* shafts of light down onto the plinth */}
      {BEAMS.map((b, i) => {
        const dx = b.to[0] - b.from[0];
        const dy = b.to[1] - b.from[1];
        const len = Math.hypot(dx, dy);
        return (
          <mesh key={i} geometry={BEAM_GEO} position={[b.from[0], b.from[1], b.z]} rotation={[0, 0, Math.atan2(dx, -dy)]} scale={[b.w, len, 1]}>
            <meshBasicMaterial
              ref={(m) => {
                beamMats.current[i] = m;
              }}
              map={BEAM_TEX}
              color="#ffd79c"
              transparent
              opacity={b.a}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        );
      })}

      {/* the boards */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1]}>
        <planeGeometry args={[30, 22]} />
        <meshStandardMaterial map={BOARDS_TEX} roughness={0.62} metalness={0.02} />
      </mesh>
      {/* the pool the key throws round the plinth */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0.3]} geometry={HALO_GEO} scale={[5.2, 3.6, 1]}>
        <meshBasicMaterial ref={poolMatRef} map={GLOW} color="#ffcf8a" transparent opacity={0.22} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* the plinth: walnut, a gilt edge, the school's crest on its face */}
      <group position={[0, 0, PLINTH_Z]}>
        <mesh position={[0, 0.25, 0]}>
          <boxGeometry args={[PLINTH_W, 0.46, PLINTH_D]} />
          <meshStandardMaterial map={WALNUT_TEX} color="#b09a88" roughness={0.42} metalness={0.05} />
        </mesh>
        <mesh position={[0, PT - 0.02, 0]}>
          <boxGeometry args={[PLINTH_W + 0.12, 0.04, PLINTH_D + 0.1]} />
          <meshStandardMaterial map={WALNUT_TEX} color="#f0dcc8" roughness={0.3} metalness={0.05} />
        </mesh>
        <mesh position={[0, 0.03, 0]}>
          <boxGeometry args={[PLINTH_W + 0.1, 0.06, PLINTH_D + 0.08]} />
          <meshStandardMaterial color="#2a170c" roughness={0.5} />
        </mesh>
        <mesh position={[0, PT - 0.048, PLINTH_D / 2 + 0.045]}>
          <boxGeometry args={[PLINTH_W + 0.1, 0.012, 0.012]} />
          <meshStandardMaterial color="#d6a84a" roughness={0.3} metalness={0.85} />
        </mesh>
        <mesh position={[0, 0.27, PLINTH_D / 2 + 0.003]} geometry={HALO_GEO} scale={[0.5, 0.31, 1]}>
          <meshStandardMaterial map={CREST_TEX} transparent roughness={0.35} metalness={0.7} color="#ffe2a0" />
        </mesh>
      </group>

      {/* the cap's shadow on the plinth */}
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, PT + 0.003, 0]} geometry={HALO_GEO} scale={0.95}>
        <meshBasicMaterial ref={shadowMatRef} map={GLOW} color="#000000" transparent opacity={0.42} depthWrite={false} />
      </mesh>

      {/* confetti — a handful already down on the boards, and the burst */}
      <instancedMesh ref={confRef} args={[CONF_GEO, undefined, CONF_N]} frustumCulled={false}>
        <meshBasicMaterial side={THREE.DoubleSide} color="#e8dccb" />
      </instancedMesh>

      {/* dust in the beams */}
      <points ref={motesRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[moteBuf.pos, 3]} />
          <bufferAttribute attach="attributes-color" args={[moteBuf.col, 3]} />
        </bufferGeometry>
        <pointsMaterial map={GLOW} vertexColors size={0.05} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </points>

      {/* the whole class, thrown with yours — one draw call */}
      <instancedMesh ref={crowdRef} args={[CROWD_GEO, undefined, CROWD_N]} frustumCulled={false} visible={false}>
        <meshStandardMaterial roughness={0.72} metalness={0.04} side={THREE.DoubleSide} />
      </instancedMesh>

      {/* the diploma: inked face inside the wind, plain back outside */}
      <group ref={scrollRef} position={[0, PT + ROUT0, ROLL_Z - ROUT0]}>
        <mesh ref={sheetRef} geometry={sheetGeo}>
          <meshStandardMaterial map={diploma} emissiveMap={diploma} emissive="#fff2dc" emissiveIntensity={0.38} roughness={0.9} />
        </mesh>
        <mesh geometry={sheetGeo}>
          <meshStandardMaterial color="#e6d2a4" roughness={0.9} side={THREE.BackSide} />
        </mesh>
      </group>

      {/* the ribbon round it, tied in a bow */}
      <group ref={ribbonRef} position={[RIBBON_X, PT + ROUT0, ROLL_Z]} rotation={[0, 0, Math.PI / 2]}>
        <mesh geometry={RIBBON_GEO}>
          <meshStandardMaterial color="#a8182a" roughness={0.4} metalness={0.1} side={THREE.DoubleSide} />
        </mesh>
        {/* the bow, on the front of the roll. After the group's quarter-turn about z,
            local +x points up and local y runs along the roll. */}
        <group ref={bowRef} position={[ROUT0 * 0.3, 0, ROUT0 * 0.97]}>
          {[-1, 1].map((sd) => (
            <mesh key={`l${sd}`} geometry={LOOP_GEO} position={[0.01, sd * 0.052, 0]} rotation={[0, 0, sd * 0.35]} scale={[0.7, 1.2, 0.5]}>
              <meshStandardMaterial color="#b51d30" roughness={0.4} />
            </mesh>
          ))}
          {[-1, 1].map((sd) => (
            <mesh key={`t${sd}`} geometry={TAIL_GEO} position={[-0.07, sd * 0.024, 0.006]} rotation={[0, 0, Math.PI / 2 - sd * 0.28]}>
              <meshStandardMaterial color="#9c1426" roughness={0.45} side={THREE.DoubleSide} />
            </mesh>
          ))}
          <mesh position={[0, 0, 0.008]}>
            <sphereGeometry args={[0.018, 10, 8]} />
            <meshStandardMaterial color="#9c1426" roughness={0.4} />
          </mesh>
        </group>
      </group>

      {/* your cap. Origin at the rim of the skull. */}
      <group ref={heroRef} position={HERO_REST_POS} quaternion={HERO_REST_Q}>
        <mesh geometry={SKULL_GEO} position={[0, SKULL_H / 2, 0]}>
          {fabric}
        </mesh>
        <mesh geometry={BOARD_GEO} position={[0, SKULL_H + BOARD_T / 2, 0]}>
          {fabric}
        </mesh>
        <mesh geometry={BUTTON_GEO} position={[0, TOP_Y + 0.007, 0]}>
          <meshStandardMaterial color={cap.button} roughness={0.6} />
        </mesh>
        {/* the cord runs over the board from the button to the edge; the bundle hangs */}
        <group ref={pivotRef} position={[0, TOP_Y + 0.006, 0]}>
          <mesh ref={cordRef} geometry={CORD_GEO}>
            {threadMat}
          </mesh>
          <group ref={edgeRef}>
            <group ref={hangRef}>
              <mesh geometry={HANG_GEO} position={[0, -0.05, 0]}>
                {threadMat}
              </mesh>
              <mesh geometry={BARREL_GEO} position={[0, -0.112, 0]}>
                {threadMat}
              </mesh>
              <mesh geometry={STRANDS_GEO} position={[0, -0.194, 0]}>
                <meshStandardMaterial map={STRANDS} color={tassel.color} metalness={tassel.metal * 0.7} roughness={tassel.rough + 0.1} side={THREE.DoubleSide} />
              </mesh>
            </group>
          </group>
        </group>
      </group>

      {/* up, up: the way it wants to go */}
      <group ref={chevRef} position={[HERO_REST_POS.x, HERO_REST_POS.y + 0.42, HERO_REST_POS.z + 0.2]} visible={false}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} geometry={HALO_GEO} scale={[0.2, 0.15, 1]}>
            <meshBasicMaterial
              ref={(m) => {
                chevMats.current[i] = m;
              }}
              map={CHEVRON}
              color={tassel.glint}
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      <mesh ref={turnGlintRef} geometry={HALO_GEO} visible={false}>
        <meshBasicMaterial ref={turnGlintMatRef} map={FLARE} color={tassel.glint} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <mesh ref={glintRef} position={[HERO_REST_POS.x, HERO_REST_POS.y + 0.22, HERO_REST_POS.z + 0.3]} geometry={HALO_GEO} scale={1.1}>
        <meshBasicMaterial ref={glintMatRef} map={GLOW} color={tassel.glint} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>

      {/* r185 raycasts straight through visible={false}, so the hit target is a
          transparent plane over the cap — generous, because thumbs are not precise */}
      {phase === "opening" && (
        <mesh
          position={[HERO_REST_POS.x, HERO_REST_POS.y + 0.12, HERO_REST_POS.z + 0.45]}
          rotation={[-0.35, 0, 0]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onPointerOver={onOver}
          onPointerOut={onOut}
        >
          <planeGeometry args={[1.5, 1.15]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
