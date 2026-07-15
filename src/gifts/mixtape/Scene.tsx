import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, orderWritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- palettes ---------- */
// The shells are translucent plastic, so the variant is not a tint on a surface —
// it is what colour the lamp *behind* the hubs comes out as. `inner` is the light
// that has been through the plastic; `tint` is the plastic seen against the dark.
interface Shell {
  tint: string;
  opacity: number;
  inner: string;
  edge: string;
  glow: string;
  env: number;
}
const SHELLS: Record<string, Shell> = {
  smoke: {
    tint: "#3c4049", opacity: 0.56, inner: "#9db2d4",
    edge: "#d2dcec", glow: "#a8bcdc", env: 1.05,
  },
  cherry: {
    tint: "#8d1226", opacity: 0.5, inner: "#ff5f72",
    edge: "#ffa3ad", glow: "#ff6479", env: 1.25,
  },
  seafoam: {
    tint: "#0d6154", opacity: 0.48, inner: "#4fe0c0",
    edge: "#a9f3e3", glow: "#54e6c9", env: 1.2,
  },
};

// A biro on a paper inlay versus a typewriter platen: different face, different
// weight, different ink, and the hand-written one never sits quite square.
interface LabelStyle {
  font: string;
  weight: string;
  ink: string;
  slant: number;
  paper: string;
  band: string;
  caps: boolean;
  size: number;
}
const LABELS: Record<string, LabelStyle> = {
  handwritten: {
    font: "'Snell Roundhand','Segoe Script','Bradley Hand',cursive", weight: "400",
    ink: "#33477a", slant: -0.03, paper: "#f2e9d6", band: "#c4643c", caps: false, size: 74,
  },
  typed: {
    font: "'Courier New',Courier,monospace", weight: "700",
    ink: "#1b1b1f", slant: 0, paper: "#ecebe6", band: "#3d5c88", caps: true, size: 56,
  },
};

/* ---------- stage layout ---------- */
// The vertical fov fixes the visible height at 3.42u no matter the aspect, so the
// column is budgeted against ±1.71 and only the width is ever fitted.
const FOV = 40;
const CAM_Z = 4.7;
const CASS_W = 1.9;
const CASS_H = 1.2;
const CASS_D = 0.2;
const CASS_Y = -0.86;
const HUB_X = 0.44;
const HUB_R = 0.115; // the splined hub itself
const PACK_R = 0.4; // a full pack of tape on it
const EXIT = new THREE.Vector3(0, CASS_Y - 0.4, 0.1); // the head opening, where tape leaves
const BTN_Y = -1.54;
// The meter housing's centre, and the bar at full deflection. Both the plate and
// the bar are anchored off these: the bar's rest position is not its own width but
// the housing's edge, and hard-coding that twice is how it ends up somewhere else.
const VU_X = -0.72;
const VU_W = 0.72;
const TEXT_CY = 0.72;
const TEXT_W = 2.5;
const TEXT_H = 1.5;
const ACTION_W = 2.95;

/* ---------- opening timeline (seconds) ---------- */
const T_MERCY0 = 3.2; // the deck starts leaning on its own key…
const T_MERCY1 = 6.6; // …and presses it here if nobody ever does
const THUNK = 0.16; // button travel, then a hard mechanical stop
const TAU_LEAD = 0.3; // spools take up the slack before tape appears
const TAU_WRITE = 3.1; // the payout itself
const TAU_HOLD = 3.9; // reveal clock pins here: every glyph laid, slack gone
const PREV_LEAD = 1.3;
const PREV_PERIOD = 12.5;
// Mercy budget: the bound is on onOpenComplete, not on the grant — 6.6 + 3.9 = 10.5s
// on the no-input path (measured 10.8 with frame-loop startup), inside 12 with room
// to spare. Anyone who presses the key is on their own clock and may take all day.

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();

/* ---------- the deck, as something for the plastic to reflect ---------- */
// Clear plastic with no envMap is grey mud: its whole read is the highlight that
// slides over the shell, and a highlight needs something to be a highlight *of*.
function buildEnvTexture(): THREE.Texture {
  const W = 256;
  const H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#8794ad"); // ceiling over the hi-fi
  sky.addColorStop(0.44, "#2b3040");
  sky.addColorStop(0.7, "#12141c");
  sky.addColorStop(1, "#080a0e");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(70, 26, 62, "#ffffff"); // the room's one lamp — the streak the tape rolls through
  blob(186, 40, 44, "#7f9ac4");
  for (let i = 0; i < 4; i++) blob(24 + i * 66, 74, 16, "#ffc079"); // amber VU glow bouncing back up
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const envTex = buildEnvTexture();

/* ---------- the wound tape, as a texture ---------- */
// Concentric turns: it is what tells you the pack is *wound* and not a brown disc,
// and it is the only thing that makes the spool's rotation legible at all.
function buildPackTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2a1a12";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(3312);
  for (let i = 0; i < 74; i++) {
    const r = (i / 74) * (S / 2 - 4) + 6;
    g.strokeStyle = `rgba(${150 + rand() * 70 | 0},${96 + rand() * 54 | 0},${58 + rand() * 40 | 0},${0.14 + rand() * 0.3})`;
    g.lineWidth = 0.8 + rand() * 1.4;
    g.beginPath();
    g.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    g.stroke();
  }
  // one bright turn, so a spin is unmistakable even at a glance
  g.strokeStyle = "rgba(214,164,104,0.5)";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.31, -0.5, 0.5);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const packTex = buildPackTexture();

/* ---------- ink -> one continuous strip ---------- */
// `orderWritePath` hands back a dense sweep *through* the ink — column by column,
// snaking top-down then bottom-up. Splined directly it is a picket fence, and
// decimating it only turns the fence into a random walk (both measured). But the
// runs it sweeps are thin (a slanted cursive stroke crosses a column in ~3px), so
// the *midpoint of each run* is a true centreline sample. Recover those, walk them
// like a pen, and the letterforms come back.
interface Ink {
  pts: Float32Array; // xy pairs, in orderWritePath space (centered, y-up, width 1)
  leap: Uint8Array; // 1 where the pen left the ink and travelled
  n: number;
  aspect: number;
  stroke: number; // median run length — the face's own stroke weight
}

function buildInk(text: string, lang: Lang): Ink | null {
  // A blank line makes lineStarts and lineCount disagree; collapse them first.
  const src = text.replace(/\s*\n\s*\n+/g, "\n").trim();
  if (!src) return null;
  // Wrap toward the block aspect the stage has room for, rather than overflowing.
  // A roundhand is narrow for its size — 0.5em per character would wrap it into a
  // tall column and the height clamp would then shrink the whole block away.
  const CHAR_W = 0.42;
  const LH = 1.5;
  // Aim wider than the stage: the raster carries padding and the ascenders overhang
  // their band, so a block wrapped *to* the target comes back taller than asked and
  // the height clamp then shrinks the writing away to nothing.
  const chars = Math.min(26, Math.max(6, Math.round(Math.sqrt((src.length * LH) / (0.34 * CHAR_W)))));
  const fontSize = 96;
  const w = orderWritePath(src, {
    step: 3,
    fontSize,
    // Regular, not the 700 default: heavy faces are wider *and* thicker, and a
    // thick run has no centreline worth the name.
    fontWeight: "400",
    fontFamily: "'Snell Roundhand','Segoe Script','Bradley Hand',cursive",
    maxWidthPx: chars * CHAR_W * fontSize,
    lineHeight: LH,
    lang,
  });
  if (!w.count) return null;
  const rtl = lang === "ar";
  const starts = w.lineStarts.concat([w.count]);

  // The raster's pitch, read back off the data rather than assumed.
  const gaps: number[] = [];
  for (let i = 1; i < w.count; i++) {
    if (w.path[i * 2] === w.path[(i - 1) * 2]) {
      const d = Math.abs(w.path[i * 2 + 1] - w.path[(i - 1) * 2 + 1]);
      if (d > 0) gaps.push(d);
    }
  }
  gaps.sort((a, b) => a - b);
  const grid = gaps.length ? gaps[gaps.length >> 1] : 0.004;

  const outX: number[] = [];
  const outY: number[] = [];
  const outL: number[] = [];
  const runLen: number[] = [];

  for (let k = 0; k < w.lineStarts.length; k++) {
    // ---- centreline nodes: one per ink run per column
    const nx: number[] = [];
    const ny: number[] = [];
    let i = starts[k];
    while (i < starts[k + 1]) {
      const x = w.path[i * 2];
      let j = i;
      const ys: number[] = [];
      while (j < starts[k + 1] && w.path[j * 2] === x) ys.push(w.path[j++ * 2 + 1]);
      ys.sort((a, b) => b - a);
      let s = 0;
      for (let q = 1; q <= ys.length; q++) {
        if (q === ys.length || ys[q - 1] - ys[q] > grid * 1.6) {
          nx.push(x);
          ny.push((ys[s] + ys[q - 1]) / 2);
          runLen.push(ys[s] - ys[q - 1]);
          s = q;
        }
      }
      i = j;
    }
    const n = nx.length;
    if (!n) continue;

    // ---- walk them like a pen: nearest unvisited, but reluctant to turn, so it
    // commits to a stroke instead of hopping between two that pass near each other.
    const used = new Uint8Array(n);
    let cur = 0;
    let bx = rtl ? -Infinity : Infinity;
    for (let q = 0; q < n; q++) {
      if (rtl ? nx[q] > bx : nx[q] < bx) {
        bx = nx[q];
        cur = q;
      }
    }
    used[cur] = 1;
    const tour = new Int32Array(n);
    tour[0] = cur;
    let hx = rtl ? -1 : 1;
    let hy = 0;
    for (let step = 1; step < n; step++) {
      let best = -1;
      let bs = Infinity;
      for (let q = 0; q < n; q++) {
        if (used[q]) continue;
        const ex = nx[q] - nx[cur];
        const ey = ny[q] - ny[cur];
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d === 0) {
          best = q;
          break;
        }
        const s = d * (1 + 0.6 * (1 - (ex * hx + ey * hy) / d));
        if (s < bs) {
          bs = s;
          best = q;
        }
      }
      if (best < 0) break;
      const ex = nx[best] - nx[cur];
      const ey = ny[best] - ny[cur];
      const d = Math.sqrt(ex * ex + ey * ey) || 1;
      hx = hx * 0.4 + (ex / d) * 0.6;
      hy = hy * 0.4 + (ey / d) * 0.6;
      const hn = Math.sqrt(hx * hx + hy * hy) || 1;
      hx /= hn;
      hy /= hn;
      used[best] = 1;
      tour[step] = best;
      cur = best;
    }

    // ---- cut the tour into strokes wherever it left the ink
    const LEAP = grid * 3.2;
    const strokes: number[][] = [];
    let run: number[] = [tour[0]];
    for (let q = 1; q < n; q++) {
      const a = tour[q - 1];
      const b = tour[q];
      const dx = nx[b] - nx[a];
      const dy = ny[b] - ny[a];
      if (dx * dx + dy * dy > LEAP * LEAP) {
        strokes.push(run);
        run = [b];
      } else run.push(b);
    }
    strokes.push(run);

    // ---- and lay them down in reading order. This is the one place the promise
    // lands: in `ar` the strip is paid out right-to-left, so it writes the way it
    // is read, not merely mirrored.
    const rd = (q: number) => (rtl ? -nx[q] : nx[q]);
    for (const st of strokes) if (rd(st[st.length - 1]) < rd(st[0])) st.reverse();
    strokes.sort((a, b) => rd(a[0]) - rd(b[0]));
    for (const st of strokes) {
      for (let q = 0; q < st.length; q++) {
        outX.push(nx[st[q]]);
        outY.push(ny[st[q]]);
        outL.push(q === 0 && outX.length > 1 ? 1 : 0);
      }
    }
  }

  if (outX.length < 4) return null;
  const pts = new Float32Array(outX.length * 2);
  const leap = new Uint8Array(outX.length);
  for (let q = 0; q < outX.length; q++) {
    pts[q * 2] = outX[q];
    pts[q * 2 + 1] = outY[q];
    leap[q] = outL[q];
  }
  runLen.sort((a, b) => a - b);
  return { pts, leap, n: outX.length, aspect: w.aspect, stroke: runLen[runLen.length >> 1] || grid };
}

/* ---------- the strip itself ---------- */
// One tape. It leaves the head, climbs into the block, and from there every glyph
// and every hop between them is the same unbroken length of it — which is the whole
// conceit, so the travel moves are bowed out of the text plane and made the point
// rather than hidden. They are also what carries a counter: the strip crosses the
// hole in an "o" in front of the page, not through it.
const LEAP_ARC = 0.55; // travel is dead time to a reader; the tape crosses it faster than it writes
const TWIST = 5.2;

function buildRibbon(ink: Ink, lang: Lang) {
  // Trade width for height rather than overflowing a long message off the stage.
  let w = TEXT_W;
  if (ink.aspect * w > TEXT_H) w = TEXT_H / ink.aspect;
  // The strip is a rendering of the hand, so it is gauged off the *face's* own stroke
  // weight — which also keeps a long, small message from closing up into a solid slug.
  // Capped well under a true 1/8" against this cassette: tape at honest scale would be
  // five times the width of a stem here and every counter would fill in.
  const half = Math.min(0.017, Math.max(0.009, ink.stroke * w * 1.7));
  const rand = mulberry32(60809);

  const sx: number[] = [];
  const sy: number[] = [];
  const sz: number[] = [];
  const sl: number[] = []; // 0 on ink, 1 mid-travel — drives twist and slack

  const push = (x: number, y: number, z: number, l: number) => {
    sx.push(x);
    sy.push(y);
    sz.push(z);
    sl.push(l);
  };

  // ---- lead-in: out of the head, a bow toward the room, into the first glyph
  const fx = ink.pts[0] * w;
  const fy = TEXT_CY + ink.pts[1] * w;
  const side = Math.sign(fx) || (lang === "ar" ? 1 : -1);
  const lead = new THREE.CatmullRomCurve3([
    EXIT.clone(),
    new THREE.Vector3(EXIT.x + side * 0.42, EXIT.y + 0.3, 0.62),
    new THREE.Vector3(lerp(EXIT.x, fx, 0.62) - side * 0.16, lerp(EXIT.y, fy, 0.74), 0.44),
    new THREE.Vector3(fx, fy, 0),
  ]);
  const LEAD_N = 30;
  const v = new THREE.Vector3();
  for (let i = 0; i < LEAD_N; i++) {
    lead.getPoint(i / LEAD_N, v);
    push(v.x, v.y, v.z, 1);
  }

  // ---- the message
  for (let i = 0; i < ink.n; i++) {
    const x = ink.pts[i * 2] * w;
    const y = TEXT_CY + ink.pts[i * 2 + 1] * w;
    if (ink.leap[i] && i > 0) {
      const px = sx[sx.length - 1];
      const py = sy[sy.length - 1];
      const d = Math.hypot(x - px, y - py);
      // Bigger hop, bigger loop — and mostly toward the room, so the strip reads
      // as slack tape in front of the words rather than a scratch across them.
      const bow = Math.min(0.5, d * 0.85) * (rand() > 0.3 ? 1 : -0.55);
      const k = Math.min(14, Math.max(3, Math.ceil(d / (half * 2.4))));
      for (let q = 1; q < k; q++) {
        const s = q / k;
        const arc = Math.sin(s * Math.PI);
        push(lerp(px, x, s), lerp(py, y, s) + arc * d * 0.16, arc * bow, 1);
      }
    }
    push(x, y, 0, 0);
  }

  // ---- frames. The face is turned to the room, so its width is the nib's width
  // and the twist is what rolls it edge-on and back: that roll is the glint.
  const n = sx.length;
  const pos = new Float32Array(n * 4 * 3);
  const nrm = new Float32Array(n * 4 * 3);
  const aU = new Float32Array(n * 2);
  const aWave = new Float32Array(n * 2 * 3);
  const arc = new Float32Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    const dx = sx[i] - sx[i - 1];
    const dy = sy[i] - sy[i - 1];
    const dz = sz[i] - sz[i - 1];
    // weight the hops down so the writing keeps the rhythm, not the travel
    total += Math.sqrt(dx * dx + dy * dy + dz * dz) * (sl[i] > 0.5 ? LEAP_ARC : 1);
    arc[i] = total;
  }
  const T = new THREE.Vector3();
  const B = new THREE.Vector3();
  const N = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    T.set(sx[b] - sx[a], sy[b] - sy[a], sz[b] - sz[a]);
    if (T.lengthSq() < 1e-12) T.set(1, 0, 0);
    T.normalize();
    B.crossVectors(T, Z);
    if (B.lengthSq() < 1e-8) B.set(1, 0, 0); // tangent ran at the camera; any perpendicular will do
    B.normalize();
    N.crossVectors(B, T).normalize();
    const s = arc[i];
    const u = s / total;
    // Loose tape rolls hard; on the ink it only leans, so the letters stay solid.
    const amp = lerp(0.42, 1.15, sl[i]);
    const th = amp * (Math.sin(s * TWIST) * 0.6 + Math.sin(s * TWIST * 0.41 + 1.7) * 0.4);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const bx = B.x * ct + N.x * st;
    const by = B.y * ct + N.y * st;
    const bz = B.z * ct + N.z * st;
    const nx = -B.x * st + N.x * ct;
    const ny = -B.y * st + N.y * ct;
    const nz = -B.z * st + N.z * ct;
    // slack: a long, lazy wave that the tape shakes out as it comes taut
    const wa = (0.055 + 0.16 * sl[i]) * Math.sin(s * 2.9 + i * 0.021);
    const wb = (0.05 + 0.19 * sl[i]) * Math.cos(s * 2.1 + i * 0.013);
    for (let e = 0; e < 2; e++) {
      const k = i * 2 + e;
      const h = e === 0 ? -half : half;
      pos[k * 3] = sx[i] + bx * h;
      pos[k * 3 + 1] = sy[i] + by * h;
      pos[k * 3 + 2] = sz[i] + bz * h;
      nrm[k * 3] = nx;
      nrm[k * 3 + 1] = ny;
      nrm[k * 3 + 2] = nz;
      aU[k] = u;
      aWave[k * 3] = N.x * wa + Z.x * wb;
      aWave[k * 3 + 1] = N.y * wa + Z.y * wb;
      aWave[k * 3 + 2] = N.z * wa + Z.z * wb;
    }
  }
  const idx = new Uint32Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const k = i * 2;
    idx.set([k, k + 1, k + 2, k + 1, k + 3, k + 2], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, n * 2 * 3), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm.subarray(0, n * 2 * 3), 3));
  geo.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
  geo.setAttribute("aWave", new THREE.BufferAttribute(aWave, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return { geo, tip: total, half };
}

/* ---------- the deck's audio ---------- */
// Hiss is the tape's own floor and warble is a capstan that was never quite true —
// between them they are most of what a cassette actually sounds like. Everything is
// built on the press, never before it: browsers refuse anything else, and a gift
// that needed sound to work would be broken for half the people it reaches.
const BEAT = 60 / 68;
const LOOKAHEAD = 0.4;
const MOTIF = [261.63, 311.13, 392.0, 466.16, 392.0, 311.13, 349.23, 261.63];

interface Tape {
  ctx: AudioContext;
  master: GainNode;
  mech: GainNode;
  detune: GainNode;
  tone: BiquadFilterNode;
  clack: AudioBuffer;
  intervalId: number;
  nextNoteTime: number;
  noteIndex: number;
  play: boolean;
}

function createAudioContext(): AudioContext | null {
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

function buildTape(): Tape | null {
  const ctx = createAudioContext();
  if (!ctx) return null;
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  // The key is the machine, not the music, so it does not ride the tape's fade-in.
  // Through `master` the thunk peaks while that fade is still ~1% open and lands
  // ~35dB down — i.e. the one sound the press makes is inaudible. Same level the
  // fade settles at, so the mix is unchanged; it just arrives on time.
  const mech = ctx.createGain();
  mech.gain.value = 0.14;
  mech.connect(ctx.destination);

  const rand = mulberry32(4711);
  const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 380;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2500;
  const hiss = ctx.createGain();
  hiss.gain.value = 0.05;
  noise.connect(hp).connect(lp).connect(hiss).connect(master);
  noise.start();

  // wow (slow) and flutter (fast) summed in cents, fed to every note's detune
  const detune = ctx.createGain();
  detune.gain.value = 1;
  const wow = ctx.createOscillator();
  wow.frequency.value = 0.53;
  const wowG = ctx.createGain();
  wowG.gain.value = 17;
  wow.connect(wowG).connect(detune);
  const flutter = ctx.createOscillator();
  flutter.frequency.value = 5.7;
  const flG = ctx.createGain();
  flG.gain.value = 4.5;
  flutter.connect(flG).connect(detune);
  wow.start();
  flutter.start();

  // everything the tape plays has been through the same tired head
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 1500;
  tone.Q.value = 0.6;
  tone.connect(master);

  const clack = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
  const cd = clack.getChannelData(0);
  for (let i = 0; i < cd.length; i++) cd[i] = (rand() * 2 - 1) * (1 - i / cd.length);

  return { ctx, master, mech, detune, tone, clack, intervalId: 0, nextNoteTime: 0, noteIndex: 0, play: false };
}

function scheduleNote(a: Tape, freq: number, time: number) {
  const osc = a.ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, time);
  a.detune.connect(osc.detune);
  const g = a.ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(0.5, time + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0005, time + BEAT * 1.6);
  osc.connect(g).connect(a.tone);
  osc.start(time);
  osc.stop(time + BEAT * 1.7);
  osc.onended = () => {
    try {
      a.detune.disconnect(osc.detune);
    } catch {
      /* the graph is already gone */
    }
  };
}

function runScheduler(a: Tape) {
  if (!a.play) {
    a.nextNoteTime = Math.max(a.nextNoteTime, a.ctx.currentTime + 0.05);
    return;
  }
  while (a.nextNoteTime < a.ctx.currentTime + LOOKAHEAD) {
    scheduleNote(a, MOTIF[a.noteIndex % MOTIF.length], a.nextNoteTime);
    a.nextNoteTime += BEAT;
    a.noteIndex += 1;
  }
}

/** The mechanism, not a beep: a heavy latch dropping, plus the clack of the key. */
function playThunk(a: Tape) {
  const t = a.ctx.currentTime + 0.005;
  const o = a.ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(44, t + 0.1);
  const g = a.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.85, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  o.connect(g).connect(a.mech);
  o.start(t);
  o.stop(t + 0.17);
  const n = a.ctx.createBufferSource();
  n.buffer = a.clack;
  const bf = a.ctx.createBiquadFilter();
  bf.type = "bandpass";
  bf.frequency.value = 2100;
  bf.Q.value = 1.2;
  const ng = a.ctx.createGain();
  ng.gain.setValueAtTime(0.5, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  n.connect(bf).connect(ng).connect(a.mech);
  n.start(t);
}

/* ---------- shared bits of the machine ---------- */
const screwGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.03, 8);
const toothGeo = new THREE.BoxGeometry(0.026, 0.05, 0.055);
const rollerGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.1, 12);
const HUB_ANGLES = [0, 1, 2, 3, 4, 5].map((i) => (i / 6) * Math.PI * 2);

function Hub({ tint }: { tint: string }) {
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[HUB_R, HUB_R, CASS_D * 0.8, 20]} />
        <meshStandardMaterial color={tint} roughness={0.5} metalness={0.05} envMap={envTex} />
      </mesh>
      {HUB_ANGLES.map((a, i) => (
        <mesh key={i} position={[Math.cos(a) * HUB_R, Math.sin(a) * HUB_R, 0]} rotation={[0, 0, a]} geometry={toothGeo}>
          <meshStandardMaterial color={tint} roughness={0.55} metalness={0.05} envMap={envTex} />
        </mesh>
      ))}
    </group>
  );
}

export default function MixtapeScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const shell = SHELLS[variants.shell] ?? SHELLS.smoke;
  const label = LABELS[variants.label] ?? LABELS.handwritten;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // The gallery card sends no message and `/create` sends a live one per keystroke.
  // Both get the short fallback: the whole build is ~25ms, which is fine once, and
  // a 280-character hairball in a 400px panel would be neither legible nor honest
  // about what the reveal looks like. The signature move still plays either way.
  const ribbonText =
    phase === "preview" ? forRecipient(lang, recipientName) : message.trim() || forRecipient(lang, recipientName);

  // useMemo is load-bearing here: it owns the geometry and its buffers.
  const ribbon = useMemo(() => {
    const ink = buildInk(ribbonText, lang);
    return ink && buildRibbon(ink, lang);
  }, [ribbonText, lang]);
  useEffect(() => () => ribbon?.geo.dispose(), [ribbon]);

  const ribbonMat = useMemo(() => {
    // Oxide side is a dull brown, base side is polished mylar. One material can only
    // pick a compromise, so it takes the polished one: what sells tape is the streak
    // of the room sliding along it as it rolls, and a matte strip never catches that.
    const m = new THREE.MeshStandardMaterial({
      color: "#7d5533",
      roughness: 0.18,
      metalness: 0.62,
      envMap: envTex,
      envMapIntensity: 2.4,
      emissive: new THREE.Color(shell.glow),
      emissiveIntensity: 0,
      side: THREE.DoubleSide,
    });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uHead = { value: 0 };
      sh.uniforms.uSlack = { value: 1 };
      sh.uniforms.uGlint = { value: 0 };
      sh.vertexShader = `attribute float aU;
attribute vec3 aWave;
uniform float uHead;
uniform float uSlack;
varying float vLag;
${sh.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  // how long ago this bit of tape was laid down; behind the head it settles
  vLag = uHead - aU;
  transformed += aWave * (exp(-max(vLag, 0.0) * 3.0) * uSlack);`,
      );
      sh.fragmentShader = `uniform float uGlint;
varying float vLag;
${sh.fragmentShader}`
        .replace(
          "#include <clipping_planes_fragment>",
          `if (vLag < 0.0) discard; // tape that has not been paid out yet
  #include <clipping_planes_fragment>`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
  // the flare that rides the point where it is coming taut
  totalEmissiveRadiance += uGlint * exp(-abs(vLag) * 11.0);`,
        );
      m.userData.u = sh.uniforms;
    };
    return m;
  }, [shell]);
  useEffect(() => () => ribbonMat.dispose(), [ribbonMat]);

  const shellMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: shell.tint,
        // Enough tooth to spread the lamp behind the hubs into a bloom the size of the
        // shell; any sharper and it is a hard white pinprick sitting on the plastic.
        roughness: 0.34,
        metalness: 0.0,
        envMap: envTex,
        envMapIntensity: shell.env,
        transparent: true,
        opacity: shell.opacity,
        emissive: new THREE.Color(shell.tint),
        emissiveIntensity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false, // two translucent plates plus the pack between them
      }),
    [shell],
  );
  useEffect(() => () => shellMat.dispose(), [shellMat]);

  // The label carries the recipient's name in the hand of whoever dubbed the tape.
  const labelData = useMemo(() => {
    const raw = recipientName.trim();
    if (!raw) return null;
    // Letter-spacing a typewriter: only safe in Latin — spacing Arabic would break
    // the joins the shaper just made.
    const s = label.caps && lang !== "ar" ? raw.toUpperCase().split("").join(" ") : raw;
    const t = makeTextTexture(s, {
      fontSize: label.size,
      fontFamily: label.font,
      fontWeight: label.weight,
      color: label.ink,
      maxWidthPx: label.size * 9,
      lang,
    });
    let w = CASS_W * 0.62;
    let h = w * t.aspect;
    const maxH = 0.2;
    if (h > maxH) {
      w *= maxH / h;
      h = maxH;
    }
    return { tex: t.texture, w, h };
  }, [recipientName, label, lang]);
  useEffect(() => {
    const d = labelData;
    return () => d?.tex.dispose();
  }, [labelData]);

  const sideData = useMemo(() => {
    const s = senderName.trim();
    if (!s) return null;
    const t = makeTextTexture(lang === "ar" ? `من ${s}` : `from ${s}`, {
      fontSize: 40,
      fontFamily: label.font,
      fontWeight: label.weight,
      color: label.ink,
      maxWidthPx: 380,
      lang,
    });
    let w = CASS_W * 0.4;
    let h = w * t.aspect;
    const maxH = 0.1;
    if (h > maxH) {
      w *= maxH / h;
      h = maxH;
    }
    return { tex: t.texture, w, h };
  }, [senderName, label, lang]);
  useEffect(() => {
    const d = sideData;
    return () => d?.tex.dispose();
  }, [sideData]);

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const supplyRef = useRef<THREE.Group>(null);
  const takeupRef = useRef<THREE.Group>(null);
  const supplyPackRef = useRef<THREE.Mesh>(null);
  const takeupPackRef = useRef<THREE.Mesh>(null);
  const cassetteRef = useRef<THREE.Group>(null);
  const btnRef = useRef<THREE.Group>(null);
  const btnMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const ribbonRef = useRef<THREE.Mesh>(null);
  const innerLightRef = useRef<THREE.PointLight>(null);
  const glintLightRef = useRef<THREE.PointLight>(null);
  const headGlowRef = useRef<THREE.Sprite>(null);
  const headGlowMatRef = useRef<THREE.SpriteMaterial>(null);
  const vuRef = useRef<THREE.Mesh>(null);
  const vuMatRef = useRef<THREE.MeshBasicMaterial>(null);

  // The press is a single event, so it is one number: when it happened.
  const pressRef = useRef(-1);
  const thunkRef = useRef(false);

  // Replay re-enters "opening" and the clock resets; the press has to reset with
  // it or run 2 would already be playing before anyone touched the key.
  useLayoutEffect(() => {
    pressRef.current = -1;
    thunkRef.current = false;
  }, [phase]);

  /* ---------- audio ---------- */
  const audioRef = useRef<Tape | null>(null);
  useEffect(() => {
    const wanted = phase === "opening" || phase === "revealed";
    if (!wanted) {
      const a = audioRef.current;
      if (a) {
        if (a.intervalId) {
          clearInterval(a.intervalId);
          a.intervalId = 0;
        }
        a.play = false;
        if (a.ctx.state === "running") a.ctx.suspend().catch(() => {});
      }
      return;
    }
    let a = audioRef.current;
    if (!a) {
      a = buildTape();
      if (!a) return; // no WebAudio: the tape is silent and the scene is unchanged
      audioRef.current = a;
    }
    const aa = a;
    aa.ctx.resume().catch(() => {});
    if (!aa.intervalId) {
      aa.nextNoteTime = aa.ctx.currentTime + 0.1;
      aa.noteIndex = 0;
      aa.intervalId = window.setInterval(() => runScheduler(aa), 190);
    }
  }, [phase]);
  useEffect(
    () => () => {
      const a = audioRef.current;
      if (a) {
        if (a.intervalId) clearInterval(a.intervalId);
        a.ctx.close().catch(() => {});
        audioRef.current = null;
      }
    },
    [],
  );

  const onPress = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || pressRef.current >= 0) return;
    pressRef.current = tRef.current;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    /* fit the machine into narrow (portrait) viewports */
    const fit = Math.max(0.68, Math.min(1, state.viewport.width / ACTION_W));
    fitRef.current?.scale.setScalar(fit);

    /* the deck leans toward the pointer */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.07, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.09, k);
    }

    /* ---- the clock the whole reveal hangs off ---- */
    let tau: number; // < 0 until the key is down
    let press = 0; // button travel, 0..1
    let invite = 0;
    if (phase === "opening") {
      // A press in the future is a stale one. The clock resets in a passive effect
      // but this ref resets in a layout effect, so a replay can slip a frame in
      // between and latch the mercy press at the *previous* run's t — after which
      // tau stays negative until the clock crawls back up to it, and the reveal
      // lands outside the 12s bound. Drop it and let mercy re-arm from the reset.
      if (pressRef.current > t) pressRef.current = -1;
      // Eased in from T_MERCY0 and down by T_MERCY1: the deck leaning on its own
      // key, not a timer firing. Anyone who presses it never sees this happen.
      const mercy = smooth(clamp01((t - T_MERCY0) / (T_MERCY1 - T_MERCY0)));
      if (mercy >= 1 && pressRef.current < 0) pressRef.current = t;
      const p = pressRef.current;
      tau = p >= 0 ? Math.min(t - p, TAU_HOLD) : -1;
      // Deliberately not clamped at 1: past the stop is where `trav` rings the key,
      // and clamping here is what silences it. Floored instead, so travel can never
      // invert. It converges on 1 as the exponential underflows.
      press = p >= 0 ? Math.max(0, (t - p) / THUNK) : mercy * 0.35;
      if (p < 0) invite = clamp01((t - 0.6) / 0.6);
    } else if (phase === "revealed") {
      // A finished tableau out of `phase` alone: reduced motion lands here cold and
      // never presses anything.
      tau = TAU_HOLD;
      press = 1;
    } else if (phase === "preview") {
      // the whole gift on a loop, so the gallery card is never a dead tile
      const cyc = e % PREV_PERIOD;
      tau = Math.min(cyc - PREV_LEAD, TAU_HOLD);
      press = clamp01((cyc - PREV_LEAD) / THUNK) * (1 - smooth(clamp01((cyc - PREV_PERIOD + 1.6) / 1.4)));
    } else {
      tau = -1;
      invite = 0.35 + 0.35 * Math.sin(e * 1.9); // sealed: the key is still asking
    }

    const lit = tau >= 0;
    // The tape pays out at a constant rate, because a capstan does.
    const w = lit ? clamp01((tau - TAU_LEAD) / TAU_WRITE) : 0;
    // preview fades the strip out at the end of the loop rather than cutting it
    const fade = phase === "preview" ? 1 - smooth(clamp01((e % PREV_PERIOD) - PREV_PERIOD + 1.6)) : 1;

    /* ---- the key ---- */
    // Travel, then a stop that is a stop: it arrives early and the last of the
    // motion is the mechanism ringing, not the finger.
    const trav = press < 1 ? easeOutCubic(press) : 1 + Math.exp(-(press - 1) * 26) * Math.sin((press - 1) * 150) * 0.1;
    if (btnRef.current) btnRef.current.position.z = 0.11 - trav * 0.062;
    if (btnMatRef.current) {
      btnMatRef.current.emissiveIntensity = lit ? 0.55 : 0.1 + invite * 0.5;
    }
    if (phase === "opening" && pressRef.current >= 0 && !thunkRef.current) {
      thunkRef.current = true;
      const a = audioRef.current;
      if (a && a.ctx.state === "running") playThunk(a);
    }
    // the whole deck takes the blow
    const jolt = lit && tau < 0.3 ? Math.exp(-tau * 17) * Math.sin(tau * 105) * 0.012 : 0;
    if (cassetteRef.current) {
      cassetteRef.current.position.y = CASS_Y + jolt;
      cassetteRef.current.rotation.z = jolt * 0.3;
    }

    /* ---- the spools ---- */
    // Constant linear speed against a shrinking radius: the supply spool visibly
    // runs away with itself as it empties, which is the tell that this is tape and
    // not a pair of wheels. r = sqrt(R1² - (R1² - R0²)w) conserves the pack's area,
    // and theta integrates to a closed form of w — so a replay is exact for free.
    const B2 = PACK_R * PACK_R - HUB_R * HUB_R;
    const rS = Math.sqrt(PACK_R * PACK_R - B2 * w * 0.86);
    const rT = HUB_R * 1.24;
    const spin = ((2 * 2.6) / B2) * (PACK_R - rS);
    if (supplyRef.current) supplyRef.current.rotation.z = -spin;
    if (takeupRef.current) takeupRef.current.rotation.z = -(w * 2.6) / rT;
    if (supplyPackRef.current) supplyPackRef.current.scale.set(rS, rS, 1);
    if (takeupPackRef.current) takeupPackRef.current.scale.set(rT, rT, 1);

    /* ---- the strip ---- */
    const u = ribbonRef.current && (ribbonRef.current.material as THREE.Material).userData.u;
    if (u) {
      // A beat of lead-in so the spools take up slack before any tape shows.
      u.uHead.value = lit ? w : -1;
      // It comes out of the machine loose and shakes itself straight.
      u.uSlack.value = lerp(1, 0, smooth(clamp01((tau - TAU_LEAD - TAU_WRITE + 0.5) / 0.9)));
      u.uGlint.value = lit && w < 1 ? 0.9 * fade : 0;
    }
    if (ribbonRef.current) ribbonRef.current.visible = lit && fade > 0.01;
    const rm = ribbonRef.current?.material as THREE.MeshStandardMaterial | undefined;
    if (rm) rm.envMapIntensity = 1.5 * fade;

    /* ---- light through the shell, and the flare at the head ---- */
    const run = lit ? clamp01(tau / 0.4) * fade : 0;
    if (innerLightRef.current) innerLightRef.current.intensity = 0.4 + run * 1.7;
    if (glintLightRef.current) glintLightRef.current.intensity = run * 0.9;
    const spill = lit && w < 1 ? 1 : 0;
    if (headGlowRef.current) headGlowRef.current.scale.setScalar(0.22 + spill * 0.3);
    if (headGlowMatRef.current) headGlowMatRef.current.opacity = spill * 0.6 * fade;

    /* ---- the meter, riding the motif ---- */
    if (vuRef.current && vuMatRef.current) {
      const drive = run * (0.45 + 0.3 * Math.sin(e * 7.3) + 0.2 * Math.sin(e * 2.9 + 1.1));
      const s = clamp01(drive);
      // A plane scales about its own centre, so a bar pinned at the housing's left
      // inner edge has to walk its centre right by half of whatever it just grew.
      vuRef.current.scale.x = Math.max(0.001, s);
      vuRef.current.position.x = VU_X - VU_W / 2 + (s * VU_W) / 2;
      vuMatRef.current.opacity = 0.25 + s * 0.75;
    }

    /* ---- audio follows the picture ---- */
    const a = audioRef.current;
    if (a && a.ctx.state === "running") {
      a.play = lit;
      a.master.gain.value = lerp(a.master.gain.value, lit ? 0.14 : 0, Math.min(1, dt * 2.4));
    }

    if (phase === "opening" && lit && tau >= TAU_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const HALF_W = CASS_W / 2;
  const HALF_H = CASS_H / 2;

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.16, CAM_Z]} fov={FOV} onUpdate={(c) => c.lookAt(0, -0.08, 0)} />
      <ambientLight intensity={0.5} color="#b9c6e0" />
      {/* the room's lamp, high and to the left, and a cold bounce off the wall */}
      <directionalLight position={[-2.6, 3.4, 3.2]} intensity={2.1} color="#fff1dc" />
      <directionalLight position={[3.0, 0.8, -2.4]} intensity={0.8} color={shell.edge} />
      {/* A fill for the face the strip turns to the room. Kept off-axis: the faceplate
          is a flat metal plane pointing at the camera, so anything lit from straight in
          front reflects square back down the lens as one blown highlight. */}
      <directionalLight position={[-3.4, -1.6, 2.2]} intensity={0.6} color="#cfe0ff" />

      {/* Sized, not eyeballed: at the 2.53 aspect the real desktop `revealed` canvas
          has, z=-1.6 needs 2*6.3*tan(20°)*2.53 = 11.6u of width. Outside the fit
          group, so shrinking the machine never uncovers it. */}
      <mesh position={[0, 0.1, -1.6]}>
        <planeGeometry args={[13, 5.2]} />
        <meshStandardMaterial color="#0b0c11" roughness={1} metalness={0} />
      </mesh>

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the deck's faceplate, and the well the cassette drops into */}
          <mesh position={[0, -0.62, -0.36]}>
            <boxGeometry args={[3.3, 2.3, 0.5]} />
            <meshStandardMaterial color="#191b21" roughness={0.66} metalness={0.45} envMap={envTex} envMapIntensity={0.55} />
          </mesh>
          <mesh position={[0, CASS_Y, -0.13]}>
            <boxGeometry args={[CASS_W + 0.16, CASS_H + 0.14, 0.06]} />
            <meshStandardMaterial color="#0a0b0e" roughness={0.9} />
          </mesh>
          {/* brushed-alloy trim under the well */}
          <mesh position={[0, -1.72, -0.3]}>
            <boxGeometry args={[3.3, 0.14, 0.54]} />
            <meshStandardMaterial color="#2c2f38" roughness={0.3} metalness={0.9} envMap={envTex} />
          </mesh>

          {/* the meter: the only part of the deck that knows the tape is running */}
          <mesh position={[VU_X, BTN_Y + 0.3, 0.02]}>
            <planeGeometry args={[VU_W + 0.04, 0.075]} />
            <meshBasicMaterial color="#0d1014" />
          </mesh>
          <mesh ref={vuRef} position={[VU_X, BTN_Y + 0.3, 0.03]}>
            <planeGeometry args={[VU_W, 0.05]} />
            <meshBasicMaterial ref={vuMatRef} color={shell.glow} transparent opacity={0.25} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>

          {/* the transport row — the play key is the only one that is chunky */}
          {[-0.62, -0.4, -0.18].map((x, i) => (
            <mesh key={i} position={[x, BTN_Y, 0.06]}>
              <boxGeometry args={[0.17, 0.13, 0.09]} />
              <meshStandardMaterial color="#20232b" roughness={0.55} metalness={0.35} envMap={envTex} />
            </mesh>
          ))}
          <group ref={btnRef} position={[0.13, BTN_Y, 0.11]}>
            <mesh>
              <boxGeometry args={[0.3, 0.2, 0.16]} />
              <meshStandardMaterial
                ref={btnMatRef}
                color="#2b2f3a"
                roughness={0.4}
                metalness={0.5}
                envMap={envTex}
                emissive={shell.glow}
                emissiveIntensity={0.1}
              />
            </mesh>
            {/* the triangle, proud of the key. A cylinder's axis is +y, so it takes a
                turn about x to face the room; thetaStart then puts the apex at +x,
                because a 3-gon's first vertex sits at +z and tips to -y — a play
                symbol pointing at the floor. */}
            <mesh position={[0.005, 0, 0.085]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.05, 0.05, 0.014, 3, 1, false, Math.PI / 2]} />
              <meshStandardMaterial color="#cfd8e8" roughness={0.35} metalness={0.6} envMap={envTex} emissive="#8fa6c8" emissiveIntensity={0.3} />
            </mesh>
          </group>
          {/* Raycasts go straight through `visible={false}` in three r185, so the
              key's hit target is transparent instead — and generous, because a
              0.3u key is a small thing to hit on a phone. */}
          {phase === "opening" && (
            <mesh position={[0.13, BTN_Y, 0.24]} onPointerDown={onPress}>
              <planeGeometry args={[0.62, 0.44]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          )}

          {/* ---- the cassette ---- */}
          <group ref={cassetteRef} position={[0, CASS_Y, 0]}>
            {/* the lamp inside the shell: with translucent plastic the light behind
                the hubs is the entire variant, so it is a real light, not a tint */}
            <pointLight ref={innerLightRef} position={[0, 0, -0.02]} intensity={0.5} color={shell.inner} distance={2.4} decay={1.6} />
            {/* Down at the head, not out in front of the shell: parked near a plate this
                flat it is just a hot white pinprick sitting on the plastic. Its job is
                the first stretch of tape, which is the only thing this close to it. */}
            <pointLight ref={glintLightRef} position={[0, -0.46, 0.3]} intensity={0} color={shell.glow} distance={1.9} decay={2} />

            {/* back plate, then everything inside, then the front plate over it */}
            <mesh position={[0, 0, -CASS_D / 2]} material={shellMat}>
              <boxGeometry args={[CASS_W, CASS_H, 0.03]} />
            </mesh>

            {/* the packs and their hubs */}
            <group position={[-HUB_X, 0.06, 0]}>
              <group ref={supplyRef}>
                <mesh ref={supplyPackRef}>
                  <circleGeometry args={[1, 40]} />
                  <meshStandardMaterial map={packTex} roughness={0.72} metalness={0.15} envMap={envTex} envMapIntensity={0.5} />
                </mesh>
                <Hub tint={shell.tint} />
              </group>
            </group>
            <group position={[HUB_X, 0.06, 0]}>
              <group ref={takeupRef}>
                <mesh ref={takeupPackRef}>
                  <circleGeometry args={[1, 40]} />
                  <meshStandardMaterial map={packTex} roughness={0.72} metalness={0.15} envMap={envTex} envMapIntensity={0.5} />
                </mesh>
                <Hub tint={shell.tint} />
              </group>
            </group>

            {/* the run of tape across the front, between the two packs */}
            <mesh position={[0, -0.32, 0.01]}>
              <boxGeometry args={[CASS_W * 0.72, 0.075, 0.004]} />
              <meshStandardMaterial color="#3a2416" roughness={0.35} metalness={0.3} envMap={envTex} />
            </mesh>
            {[-0.34, 0.34].map((x, i) => (
              <mesh key={i} position={[x, -0.32, 0]} rotation={[Math.PI / 2, 0, 0]} geometry={rollerGeo}>
                <meshStandardMaterial color="#c9ced8" roughness={0.3} metalness={0.85} envMap={envTex} />
              </mesh>
            ))}
            {/* the head opening, the pressure pad behind it, the capstan holes */}
            <mesh position={[0, -0.4, 0.02]}>
              <boxGeometry args={[0.34, 0.2, 0.02]} />
              <meshStandardMaterial color="#07080b" roughness={1} />
            </mesh>
            <mesh position={[0, -0.33, -0.04]}>
              <boxGeometry args={[0.16, 0.07, 0.02]} />
              <meshStandardMaterial color="#d8d2c4" roughness={1} />
            </mesh>
            {[-0.2, 0.2].map((x, i) => (
              <mesh key={i} position={[x, -0.44, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.048, 0.048, CASS_D + 0.02, 12]} />
                <meshBasicMaterial color="#05060a" />
              </mesh>
            ))}

            {/* front plate */}
            <mesh position={[0, 0, CASS_D / 2]} material={shellMat}>
              <boxGeometry args={[CASS_W, CASS_H, 0.03]} />
            </mesh>
            {/* the window: a thinner, clearer pane, so you read it as a cut-out */}
            <mesh position={[0, 0.06, CASS_D / 2 + 0.004]}>
              <planeGeometry args={[CASS_W * 0.56, 0.44]} />
              <meshStandardMaterial
                color={shell.edge}
                roughness={0.04}
                metalness={0}
                envMap={envTex}
                envMapIntensity={shell.env * 1.4}
                transparent
                opacity={0.12}
                depthWrite={false}
              />
            </mesh>

            {/* the inlay, and the hand on it */}
            <mesh position={[0, 0.34, CASS_D / 2 + 0.017]} rotation={[0, 0, label.slant]}>
              <planeGeometry args={[CASS_W * 0.8, 0.4]} />
              <meshStandardMaterial color={label.paper} roughness={0.94} metalness={0} />
            </mesh>
            <mesh position={[0, 0.505, CASS_D / 2 + 0.018]} rotation={[0, 0, label.slant]}>
              <planeGeometry args={[CASS_W * 0.8, 0.07]} />
              <meshStandardMaterial color={label.band} roughness={0.86} />
            </mesh>
            {labelData && (
              <mesh position={[0, 0.36, CASS_D / 2 + 0.019]} rotation={[0, 0, label.slant]}>
                <planeGeometry args={[labelData.w, labelData.h]} />
                <meshBasicMaterial map={labelData.tex} transparent depthWrite={false} toneMapped={false} />
              </mesh>
            )}
            {sideData && (
              <mesh position={[0, 0.21, CASS_D / 2 + 0.019]} rotation={[0, 0, label.slant]}>
                <planeGeometry args={[sideData.w, sideData.h]} />
                <meshBasicMaterial map={sideData.tex} transparent depthWrite={false} toneMapped={false} />
              </mesh>
            )}

            {/* five screws, where a real shell has them */}
            {[
              [-HALF_W + 0.09, -HALF_H + 0.09],
              [HALF_W - 0.09, -HALF_H + 0.09],
              [-HALF_W + 0.09, HALF_H - 0.09],
              [HALF_W - 0.09, HALF_H - 0.09],
              [0, -HALF_H + 0.09],
            ].map(([x, y], i) => (
              <mesh key={i} position={[x, y, CASS_D / 2 + 0.012]} rotation={[Math.PI / 2, 0, 0]} geometry={screwGeo}>
                <meshStandardMaterial color="#8f96a6" roughness={0.34} metalness={0.9} envMap={envTex} />
              </mesh>
            ))}
          </group>

          {/* the flare where the tape leaves the head */}
          <sprite ref={headGlowRef} position={[EXIT.x, EXIT.y, EXIT.z + 0.15]} scale={0.22}>
            <spriteMaterial
              ref={headGlowMatRef}
              map={glowTex}
              color={shell.glow}
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </sprite>

          {/* the tape: lead-in, every glyph, and every hop between them — one strip.
              Its bounds are the taut pose but the slack pushes past them, so culling
              it by that box would pop it off mid-reveal. */}
          {ribbon && <mesh ref={ribbonRef} geometry={ribbon.geo} material={ribbonMat} frustumCulled={false} visible={false} />}
        </group>
      </group>
    </>
  );
}
