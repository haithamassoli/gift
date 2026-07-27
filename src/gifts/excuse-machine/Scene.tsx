import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import { pick } from "../catalog";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
// `claw-machine` already owns the neon arcade cabinet. This one is dim, chrome
// and lonely — one bulb, an empty room, nobody watching.
const CABINETS: Record<string, { body: string; trim: string; rough: number; metal: number; bulb: string; room: string }> = {
  chrome: { body: "#8e959c", trim: "#cfd6dd", rough: 0.26, metal: 0.94, bulb: "#ffe9b8", room: "#15181c" },
  cherry: { body: "#5c2320", trim: "#c9a15a", rough: 0.42, metal: 0.35, bulb: "#ffd7a0", room: "#1a1312" },
  brass: { body: "#9a7434", trim: "#e0c07a", rough: 0.34, metal: 0.88, bulb: "#fff0c4", room: "#191510" },
};
const SYMBOLS: Record<string, string[]> = {
  fruit: ["🍒", "🍋", "🍇"],
  hearts: ["♥", "♡", "♥"],
  question: ["?", "?!", "??"],
};

const TAU = Math.PI * 2;
const SEGMENTS = 6; // faces around each reel
const REEL_R = 0.34;
const REEL_W = 0.42;
const ACTION_W = 2.6;
const ACTION_H = 2.98;
const SEG = TAU / SEGMENTS;

/* the lens, and where it goes once the tray is the only thing worth looking at */
const CAM_Z = 3.0;
const CAM_Y = 0.05;
const CAM_LOOK = -0.05;
const CAM_Z1 = 2.64;
const CAM_Y1 = -0.1;
const CAM_LOOK1 = -0.3;

const LEVER_X = 0.86;
const LEVER_Y = 0.28;

/* ---------- the excuses ---------- */
// Three columns that are supposed to line up and never once do. The sender's real
// message is not in here: the joke has to survive a completely sincere one.
const EXCUSES: Record<Lang, [string[], string[], string[]]> = {
  en: [
    ["I WAS", "THERE WAS", "MY PHONE", "THE CAT", "I THOUGHT", "TIME ITSELF"],
    ["STUCK IN", "ACTUALLY", "EATEN BY", "PRETTY MUCH", "SOMEHOW", "DEFINITELY"],
    ["TRAFFIC", "ASLEEP", "THE CAT", "ON FIRE", "A TUESDAY", "NOT MY FAULT"],
  ],
  ar: [
    ["كنتُ", "كان هناك", "هاتفي", "القطة", "ظننتُ", "الوقت نفسه"],
    ["عالقًا في", "في الحقيقة", "أكلها", "تقريبًا", "بطريقةٍ ما", "بالتأكيد"],
    ["الزحمة", "نائمًا", "القطة", "يحترق", "يوم ثلاثاء", "ليس ذنبي"],
  ],
};

interface ReelTex {
  sharp: THREE.CanvasTexture;
  blur: THREE.CanvasTexture;
}

/**
 * One reel: SEGMENTS panels of text laid side by side around a cylinder. The strip
 * runs along u (the way round), which is the axis the reel actually turns on — a
 * vertical strip would scroll the wrong way and no amount of rotation fixes it.
 *
 * The second texture is the same strip smeared along u. There is no post-processing
 * anywhere in this codebase, so a spinning reel gets its blur baked: cross-fade to
 * this one by how fast the thing is actually turning and the streak is free.
 */
function buildReel(words: string[], symbol: string, ink: string, lang: Lang): ReelTex {
  const cw = 384;
  const ch = 200;
  const c = document.createElement("canvas");
  c.width = cw * SEGMENTS;
  c.height = ch;
  const g = c.getContext("2d")!;
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "'Helvetica Neue', Arial, sans-serif";
  for (let i = 0; i < SEGMENTS; i++) {
    const x0 = i * cw;
    g.fillStyle = i % 2 ? "#f4efe4" : "#fbf7ee";
    g.fillRect(x0, 0, cw, ch);
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x0, ch);
    g.stroke();
    // One fillText per panel, so shaping and bidi are the canvas's problem.
    if (ar) g.direction = "rtl";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = ink;
    const word = words[i % words.length];
    let size = 46;
    g.font = `700 ${size}px ${fam}`;
    while (g.measureText(word).width > cw * 0.84 && size > 18) {
      size -= 2;
      g.font = `700 ${size}px ${fam}`;
    }
    g.fillText(word, x0 + cw / 2, ch * 0.42);
    g.font = `400 40px ${fam}`;
    g.fillText(symbol, x0 + cw / 2, ch * 0.78);
  }
  const sharp = new THREE.CanvasTexture(c);
  sharp.wrapS = THREE.RepeatWrapping;
  sharp.anisotropy = 4;

  const b = document.createElement("canvas");
  b.width = c.width;
  b.height = ch;
  const bg = b.getContext("2d")!;
  const TAPS = 13;
  bg.globalAlpha = 1 / TAPS;
  for (let k = 0; k < TAPS; k++) {
    const dx = (k / (TAPS - 1) - 0.5) * cw * 1.15;
    // the strip wraps, so the smear has to wrap with it or the seam shows a hard edge
    bg.drawImage(c, dx - b.width, 0);
    bg.drawImage(c, dx, 0);
    bg.drawImage(c, dx + b.width, 0);
  }
  const blur = new THREE.CanvasTexture(b);
  blur.wrapS = THREE.RepeatWrapping;
  return { sharp, blur };
}

const reelGeo = new THREE.CylinderGeometry(REEL_R, REEL_R, REEL_W, 44, 1, true);
const blurGeo = new THREE.CylinderGeometry(REEL_R + 0.004, REEL_R + 0.004, REEL_W, 32, 1, true);
const HINT = makeRadialSprite(64);
const MOTE = makeRadialSprite(32);

/* ---------- the printed slip ---------- */
// A receipt, not a card: fixed proportions, so the strip it is sliced into is a
// module constant and the printer can push it out one row at a time.
const SLIP_W = 1.0;
const SLIP_ASPECT = 0.92;
const SLIP_H = SLIP_W * SLIP_ASPECT;
const SLIP_ROWS = 10;
const SLIP_ROW_H = SLIP_H / SLIP_ROWS;
// Constant curvature: paper leaving a slot bends at a fixed rate along its own
// length, which is the whole difference between a curl and a hinge.
const SLIP_CURL = 0.46;
const SLOT_Y = -0.78;
const SLOT_Z = 0.245;

function buildSlipRows(): THREE.PlaneGeometry[] {
  const out: THREE.PlaneGeometry[] = [];
  for (let i = 0; i < SLIP_ROWS; i++) {
    const g = new THREE.PlaneGeometry(SLIP_W, SLIP_ROW_H, 1, 1);
    const uv = g.attributes.uv;
    // row 0 is the top of the texture — the first line printed is the first out
    for (let k = 0; k < uv.count; k++) uv.setY(k, (SLIP_ROWS - 1 - i + uv.getY(k)) / SLIP_ROWS);
    out.push(g);
  }
  return out;
}
const slipRowGeos = buildSlipRows();

/** Drop one of `makeTextTexture`'s canvases into the slip, scaled to fit its box. */
function stamp(g: CanvasRenderingContext2D, src: HTMLCanvasElement, cx: number, top: number, maxW: number, maxH: number) {
  const s = Math.min(maxW / src.width, maxH / src.height);
  g.drawImage(src, cx - (src.width * s) / 2, top, src.width * s, src.height * s);
}

function buildSlip(message: string, senderName: string, recipientName: string, lang: Lang): THREE.CanvasTexture {
  const W = 600;
  const H = Math.round(W * SLIP_ASPECT);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const ar = lang === "ar";
  const mono = "'Courier New', Courier, monospace";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : mono;

  g.fillStyle = "#f6f1e3";
  g.fillRect(0, 0, W, H);
  // thermal paper: the print head lays down bands, and cheap stock shows them
  for (let y = 0; y < H; y += 6) {
    g.fillStyle = "rgba(0,0,0,0.014)";
    g.fillRect(0, y, W, 3);
  }
  g.fillStyle = "rgba(0,0,0,0.15)";
  for (let y = 18; y < H; y += 34) {
    g.beginPath();
    g.arc(15, y, 4.5, 0, TAU);
    g.arc(W - 15, y, 4.5, 0, TAU);
    g.fill();
  }
  // torn off a roll at the top, perforated for the next one at the bottom
  g.fillStyle = "rgba(0,0,0,0.1)";
  for (let x = 0; x < W; x += 11) g.fillRect(x, 0, 6, 3 + ((x * 7) % 5));
  g.fillStyle = "rgba(0,0,0,0.22)";
  for (let x = 8; x < W - 8; x += 14) g.fillRect(x, H - 26, 7, 2);

  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#8d8272";
  g.font = `700 26px ${fam}`;
  g.fillText(pick(lang, "EXCUSE MACHINE", "آلة الأعذار"), W / 2, 44);

  // the machine admitting it, in its own dot-matrix voice
  const gaveUp = pick(lang, "NO EXCUSE FOUND", "لا يوجد عذر");
  g.font = `700 30px ${fam}`;
  g.fillStyle = "#a2503f";
  g.fillText(gaveUp, W / 2, 92);
  const gw = g.measureText(gaveUp).width;
  g.strokeStyle = "#a2503f";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(W / 2 - gw / 2 - 8, 93);
  g.lineTo(W / 2 + gw / 2 + 8, 93);
  g.stroke();

  // Both text blocks go through makeTextTexture and are composited in: it already
  // owns wrapping and bidi, and re-solving either here would be a second bug.
  const body = makeTextTexture(message.trim() || forRecipient(lang, recipientName), {
    fontFamily: mono,
    fontWeight: "700",
    fontSize: 54,
    color: "#26221d",
    maxWidthPx: 54 * 9,
    lineHeight: 1.34,
    padding: 16,
    lang,
  });
  stamp(g, body.texture.image as HTMLCanvasElement, W / 2, 118, W - 76, H - 232);
  body.texture.dispose();

  const names = makeTextTexture(`${senderName || "—"}  ·  ${recipientName || "—"}`, {
    fontFamily: mono,
    fontWeight: "700",
    fontSize: 34,
    color: "#6a5f52",
    maxWidthPx: 34 * 16,
    padding: 8,
    lang,
  });
  stamp(g, names.texture.image as HTMLCanvasElement, W / 2, H - 96, W - 110, 52);
  names.texture.dispose();

  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/* ---------- the crown's bulbs ---------- */
// A ring, not a row: the chase has to come back round or it reads as a progress bar.
const MARQ_N = 16;
function buildMarquee(): [number, number][] {
  const w = 1.4;
  const h = 0.26;
  const per = 2 * (w + h);
  const out: [number, number][] = [];
  for (let i = 0; i < MARQ_N; i++) {
    const d = ((i + 0.5) / MARQ_N) * per;
    if (d < w) out.push([-w / 2 + d, h / 2]);
    else if (d < w + h) out.push([w / 2, h / 2 - (d - w)]);
    else if (d < 2 * w + h) out.push([w / 2 - (d - w - h), -h / 2]);
    else out.push([-w / 2, -h / 2 + (d - 2 * w - h)]);
  }
  return out;
}
const MARQ_POS = buildMarquee();
const marqGeo = new THREE.SphereGeometry(0.028, 8, 6);

/* ---------- the highlight that crosses the chrome ---------- */
// Bare metal with no envMap has nothing to reflect, so the reflection is painted:
// one soft vertical bar sliding across the front, forever.
function buildGlint(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 4;
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 64, 0);
  gr.addColorStop(0, "rgba(255,255,255,0)");
  gr.addColorStop(0.42, "rgba(255,255,255,0.55)");
  gr.addColorStop(0.5, "rgba(255,255,255,1)");
  gr.addColorStop(0.58, "rgba(255,255,255,0.55)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 4);
  return new THREE.CanvasTexture(c);
}
const GLINT = buildGlint();

/* ---------- the air in the room ---------- */
const MOTE_N = 60;
const SPARK_N = 40;
const PT_N = MOTE_N + SPARK_N;
function buildAir() {
  const rand = mulberry32(7717);
  const mx = new Float32Array(MOTE_N);
  const mz = new Float32Array(MOTE_N);
  const ms = new Float32Array(MOTE_N);
  const mp = new Float32Array(MOTE_N);
  const mb = new Float32Array(MOTE_N);
  for (let i = 0; i < MOTE_N; i++) {
    mx[i] = (rand() - 0.5) * 3.1;
    mz[i] = 0.3 + rand() * 1.1;
    ms[i] = 0.014 + rand() * 0.036;
    mp[i] = rand();
    mb[i] = 0.18 + rand() * 0.42;
  }
  // the bay's contents, thrown out when the reels let go
  const vx = new Float32Array(SPARK_N);
  const vy = new Float32Array(SPARK_N);
  const vz = new Float32Array(SPARK_N);
  const sd = new Float32Array(SPARK_N);
  const sh = new Float32Array(SPARK_N);
  for (let i = 0; i < SPARK_N; i++) {
    const a = rand() * TAU;
    const sp = 0.4 + rand() * 1.3;
    vx[i] = Math.cos(a) * sp * 0.8;
    vy[i] = 0.3 + Math.abs(Math.sin(a)) * sp;
    vz[i] = 0.35 + rand() * 0.9;
    sd[i] = rand() * 0.26;
    sh[i] = 0.3 + rand() * 0.7;
  }
  return { mx, mz, ms, mp, mb, vx, vy, vz, sd, sh };
}
const AIR = buildAir();

/* ---------- opening ---------- */
const PULLS = 3; // three, and then it stops trying
const SPIN_MIN = 0.45; // a pull with nothing behind it
const SPIN_SPAN = 1.15;
const DETENT = 0.085; // how far the reel rings past the detent before it settles
const GIVE_UP = 0.95; // seconds of buzzing before the reels drop out of true
const REEL_TIP = 0.3;
const REEL_FALL = 0.98;
const BURST_AT = 1.02;
const TRAY_AT = 1.3;
const PRINT0 = 1.6;
const PRINT1 = 3.15;
const COIN_AT = 2.6;
const COIN_TOPPLE = 3.45;
const POST_END = 4.35;
// Gravity at this scale, and it is deliberately steep: the reels have to be off the
// front of the cabinet before the printer starts, or they fall past the slip.
const G_FALL = 14;

const RING = 0.24; // the detent ring is 87% dead by here — past it the spin is over

/* A gift may never outlast 12s untouched, and the bound is on onOpenComplete. Nobody
   is obliged to play — a gallery card has no finger on it at all — so left alone the
   machine pulls its own lever, three half-hearted times, which is also the only way a
   machine would pull it. Walked through with nobody touching anything:
     pull 1 at 1.87 → 3.30 → pull 2 at 3.75 → 5.18 → pull 3 at 5.63 → gives up 7.07,
   and onOpenComplete lands at 11.42s. The slack is for the clamped `dt`, which runs
   this clock *behind* the wall clock the bound is measured on. */
const MERCY0 = 1.5; // the beat it waits for a hand before it starts working itself
const MERCY_GAP = 0.1; // …and between its own pulls, once it has stopped waiting
const MERCY_HAND = 2.2; // a hand that arrived and left gets much longer to come back
const MERCY_DRAW = 0.35; // how long the lever takes to draw itself down
// Weaker than any pull a hand can give it, which is the tell: barely a turn and a half.
const MERCY_POWER = 0.25;

/* A reel runs flat out and *then* the brake comes on. An ease from frame one is a
   reel that was never spinning, which is exactly what the old lerp looked like. */
const spinK = (u: number) => (u < 0.55 ? (u / 0.55) * 0.62 : 0.62 + 0.38 * easeOutCubic((u - 0.55) / 0.45));

/* ---------- the one bulb that still works ---------- */
// Not on a beat, and never quite off: three sines beaten against each other, so the
// eye reads a fault rather than an animation.
const flick = (t: number) => {
  const s = Math.sin(t * 1.31) * Math.sin(t * 3.77 + 1.1) * Math.sin(t * 8.93 + 2.4);
  return s > 0.4 ? 0.22 + 0.55 * Math.abs(Math.sin(t * 57)) : 0.94 + 0.06 * Math.sin(t * 12.7);
};

const tmpCol = new THREE.Color();
const tmpObj = new THREE.Object3D();

export default function ExcuseMachineScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const cab = CABINETS[variants.cabinet] ?? CABINETS.chrome;
  const symbols = SYMBOLS[variants.reels] ?? SYMBOLS.fruit;

  const reels = useMemo(() => {
    const cols = EXCUSES[lang];
    return cols.map((words, i) => buildReel(words, symbols[i], "#231f1c", lang));
  }, [lang, symbols]);
  useEffect(
    () => () =>
      reels.forEach((t) => {
        t.sharp.dispose();
        t.blur.dispose();
      }),
    [reels],
  );

  /* The printed slip in the payout tray — the only honest thing in the cabinet. */
  const slip = useMemo(
    () => buildSlip(message, senderName, recipientName, lang),
    [message, senderName, recipientName, lang],
  );
  useEffect(() => () => slip.dispose(), [slip]);
  // One material for all ten rows: they are ten slices of one sheet, and ten
  // materials would be ten more things to keep in step.
  const slipMat = useMemo(
    () => new THREE.MeshStandardMaterial({ map: slip, roughness: 0.88, side: THREE.DoubleSide }),
    [slip],
  );
  useEffect(() => () => slipMat.dispose(), [slipMat]);

  const header = useMemo(
    () =>
      makeTextTexture(pick(lang, "EXCUSES", "أعذار"), {
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        fontWeight: "700",
        fontSize: 60,
        color: cab.trim,
        maxWidthPx: 60 * 10,
        padding: 12,
        lang,
      }),
    [lang, cab],
  );
  useEffect(() => () => header.texture.dispose(), [header]);

  const ptBuf = useMemo(
    () => ({ pos: new Float32Array(PT_N * 3), col: new Float32Array(PT_N * 3) }),
    [],
  );
  // Parsed once: `Color.set(string)` runs a regex, and the crown asks sixteen times a frame.
  const bulbCol = useMemo(() => new THREE.Color(cab.bulb), [cab]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* Each reel carries an angle, the detent it was rigged to land on and how long it
     was given to get there — a lazy pull barely turns them at all. */
  const g = useRef({
    pulls: 0,
    lever: 0,
    leverV: 0,
    down: false,
    py: 0,
    moved: 0, // travel since the last frame; the frame turns it into a speed
    speed: 0, // peak-held stroke speed, which is half of how hard the pull was
    kick: 0, // the cabinet taking the lever's force
    hover: 0,
    alone: 0, // seconds since the last pointer, which is what the mercy runs on
    took: false, // …and whether it has stopped waiting for one and taken over
    touched: false,
    ang: [0, 0, 0],
    prev: [0, 0, 0],
    rate: [0, 0, 0], // measured turn rate — the blur reads this, nothing else
    from: [0, 0, 0],
    target: [0, 0, 0],
    dur: [0, 0, 0],
    landed: [false, false, false],
    spinning: false,
    spunAt: -99,
    gaveUpAt: -1,
    rows: 0, // rows the print head has cleared, for the clacks
    rattled: false,
    whirred: false,
    rang: false,
    cx: 0,
    cy: CAM_Y,
    cz: CAM_Z,
  });

  // Replay re-enters "opening" on the same mounted scene, so every latch has to come
  // back with it — and the lens has to be parked where the incoming phase wants it,
  // pre-paint, or reduced motion's first frame renders from the last one's pose.
  useLayoutEffect(() => {
    const c = g.current;
    if (phase === "opening") tRef.current = 0;
    c.pulls = 0;
    c.lever = c.leverV = c.moved = c.speed = c.kick = c.hover = c.alone = 0;
    c.down = c.took = c.touched = c.spinning = c.rattled = c.whirred = c.rang = false;
    c.py = 0;
    c.spunAt = -99;
    c.gaveUpAt = -1;
    c.rows = 0;
    for (let i = 0; i < 3; i++) {
      // out of true from the very first frame: at zero all three sit on segment 0 and
      // the machine opens showing a sentence it is never supposed to be able to make
      c.ang[i] = c.prev[i] = i * 0.9;
      c.rate[i] = c.from[i] = c.target[i] = 0;
      c.dur[i] = 1;
      c.landed[i] = false;
    }
    const settled = phase === "revealed";
    c.cx = 0;
    c.cy = settled ? CAM_Y1 : CAM_Y;
    c.cz = settled ? CAM_Z1 : CAM_Z;
  }, [phase, tRef]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const shakeRef = useRef<THREE.Group>(null);
  const reelRefs = useRef<(THREE.Mesh | null)[]>([]);
  const blurMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const reelGroupRefs = useRef<(THREE.Group | null)[]>([]);
  const leverRef = useRef<THREE.Group>(null);
  const knobRef = useRef<THREE.Mesh>(null);
  const knobMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const slipRowRefs = useRef<(THREE.Mesh | null)[]>([]);
  const coinRef = useRef<THREE.Group>(null);
  const trayLightRef = useRef<THREE.PointLight>(null);
  const bulbRef = useRef<THREE.PointLight>(null);
  const bulbMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bulbGlowRef = useRef<THREE.Sprite>(null);
  const bulbGlowMatRef = useRef<THREE.SpriteMaterial>(null);
  const bulbSwingRef = useRef<THREE.Group>(null);
  const marqRef = useRef<THREE.InstancedMesh>(null);
  const glintRef = useRef<THREE.Mesh>(null);
  const glintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ptRef = useRef<THREE.Points>(null);

  // the crown's bulbs never move; only their colour does
  useLayoutEffect(() => {
    const im = marqRef.current;
    if (!im) return;
    for (let i = 0; i < MARQ_N; i++) {
      tmpObj.position.set(MARQ_POS[i][0], MARQ_POS[i][1], 0);
      tmpObj.updateMatrix();
      im.setMatrixAt(i, tmpObj.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
  }, []);

  /** Pull. `power` is distance and speed together, and it buys both spin and length. */
  const pull = (power: number) => {
    const c = g.current;
    if (c.spinning || c.gaveUpAt >= 0) return;
    c.pulls += 1;
    c.spinning = true;
    c.spunAt = tRef.current;
    c.alone = 0;
    const rand = mulberry32(1301 + c.pulls * 97);
    for (let i = 0; i < 3; i++) {
      // The rig: pull 1 and 2 land on deliberately different segments, and by pull
      // 3 they are not even trying to be a sentence.
      const seg = c.pulls >= PULLS ? Math.floor(rand() * SEGMENTS) : (i * 2 + c.pulls) % SEGMENTS;
      const turns = 0.4 + power * (2.3 + i * 0.55) + rand() * 0.3;
      c.from[i] = c.ang[i];
      // the first detent at `seg` that is at least that far round — never a shortcut back
      const min = c.ang[i] + turns * TAU;
      c.target[i] = Math.ceil((min - seg * SEG) / TAU) * TAU + seg * SEG;
      c.dur[i] = SPIN_MIN + power * SPIN_SPAN + i * 0.22;
      c.landed[i] = false;
    }
    c.kick = 1;
    clack({ freq: 320, decay: 0.2, gain: 0.3 });
  };

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.gaveUpAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.current.down = true;
    g.current.touched = true;
    g.current.took = false; // a hand back on it buys the long courtesy wait again
    g.current.speed = 0;
    g.current.alone = 0;
    g.current.py = ev.point.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening") return;
    ev.stopPropagation();
    const dy = c.py - ev.point.y;
    c.py = ev.point.y;
    c.moved += Math.abs(dy);
    c.alone = 0;
    // A return spring stiffens as it compresses, so the last third of the stroke
    // costs nearly double the travel the first third did.
    c.lever = clamp01(c.lever + dy / (0.85 * (1 + c.lever * 1.1)));
    c.leverV = 0;
    if (c.lever >= 1 && !c.spinning) {
      // bottomed out against the stop: whatever speed it arrived with is the pull
      pull(clamp01(0.6 + Math.min(1, c.speed / 3.4) * 0.4));
      c.down = false;
      c.leverV = 0.5;
    }
  };
  const stop = () => {
    const c = g.current;
    if (!c.down) return;
    c.down = false;
    // Letting go short still counts — distance is most of the power, so a half pull
    // is a half spin and the reels barely turn.
    if (phase === "opening" && !c.spinning && c.gaveUpAt < 0 && c.lever > 0.3) {
      pull(clamp01(c.lever * 0.68 + Math.min(1, c.speed / 3.4) * 0.4));
    }
    c.leverV = -c.lever * 1.1; // it leaves with the travel it had
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = g.current;
    const opening = phase === "opening";
    // preview is the gallery card: the machine has already been beaten once and the
    // tray is holding the proof, while the reels go on offering excuses to nobody
    const settled = phase === "preview" || phase === "revealed";

    const fit = fitRef.current;
    if (fit) fit.scale.setScalar(Math.max(0.58, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    const fs = fit ? fit.scale.x : 1;

    /* ---- the lever ---- */
    // Distance is read in the handler; speed can only be read here, where there is a dt.
    c.speed = Math.max(c.speed * Math.pow(0.02, dt), c.moved / Math.max(dt, 1e-4));
    c.moved = 0;
    c.kick = Math.max(0, c.kick - dt * 3.4);
    let mercy = 0; // the machine drawing its own lever down, when nobody will
    if (opening) {
      if (!c.down) {
        // `alone` is time since the last pointer, and it is the only clock the mercy
        // runs on — a hand on the lever resets it, so an engaged pull never sees this.
        if (!c.spinning && c.gaveUpAt < 0) c.alone += dt;
        mercy = clamp01(
          (c.alone - (c.took ? MERCY_GAP : c.touched ? MERCY_HAND : MERCY0)) / MERCY_DRAW,
        );
        if (mercy > 0) {
          c.lever = mercy;
          c.leverV = 0.5; // and letting go of it the way a hand does
          if (mercy >= 1) {
            pull(MERCY_POWER);
            c.took = true;
          }
        } else {
          // the return spring, underdamped, because a real one always overshoots its rest
          c.leverV += -c.lever * 150 * dt;
          c.leverV *= Math.pow(0.02, dt);
          c.lever = Math.max(-0.14, Math.min(1, c.lever + c.leverV * dt));
        }
      }
      // The drag plane swallows the lever's own pointer events, so hover is read off
      // the cursor against where the knob projects — near enough for a glow.
      const nx = (LEVER_X * fs) / Math.max(0.01, state.viewport.width / 2);
      const ny = ((LEVER_Y + 0.5) * fs - CAM_LOOK) / Math.max(0.01, state.viewport.height / 2);
      const d = Math.hypot(state.pointer.x - nx, state.pointer.y - ny);
      c.hover += (clamp01(1 - d / 0.5) - c.hover) * Math.min(1, dt * 8);
    } else {
      // nobody is playing: the handle hangs and drifts the way a sprung thing does
      const rest = phase === "revealed" ? 0.12 : 0;
      c.lever = lerp(c.lever, rest + Math.sin(e * 0.62) * 0.012, Math.min(1, dt * 3));
      c.hover += (0 - c.hover) * Math.min(1, dt * 6);
    }

    /* ---- the reels ---- */
    if (opening && c.spinning) {
      let all = true;
      const age = tRef.current - c.spunAt;
      for (let i = 0; i < 3; i++) {
        const u = clamp01(age / c.dur[i]);
        if (u < 1) {
          c.ang[i] = lerp(c.from[i], c.target[i], spinK(u));
          all = false;
        } else {
          // The detent grabs and the reel rings against it — that ring is the whole
          // difference between a stop and a fade.
          const b = age - c.dur[i];
          c.ang[i] = c.target[i] + DETENT * Math.exp(-b * 8.5) * Math.sin(b * 44);
          if (!c.landed[i]) {
            c.landed[i] = true;
            clack({ freq: 1250 + i * 190, decay: 0.07, gain: 0.18 });
          }
          if (b < RING) all = false;
        }
      }
      if (all) {
        c.spinning = false;
        if (c.pulls >= PULLS) {
          c.gaveUpAt = tRef.current;
          // It buzzes. It is not a jackpot noise.
          tone(110, { type: "square", seconds: GIVE_UP, gain: 0.2 });
          tone(73, { type: "sawtooth", seconds: GIVE_UP * 0.8, gain: 0.1 });
        }
      }
    } else if (phase === "preview") {
      // Attract: it plays itself for whoever walks past, landing somewhere new each
      // loop. Only `ang mod TAU` is ever seen, so the wrap at the seam is invisible.
      const P = 6.4;
      const n = Math.floor(e / P);
      const cyc = e % P;
      for (let i = 0; i < 3; i++) {
        const s0 = ((n - 1) * 5 + i * 3) % SEGMENTS;
        const s1 = (n * 5 + i * 3) % SEGMENTS;
        const a0 = s0 * SEG;
        // whole turns, so the seam lands on exactly the detent the next loop starts from
        const a1 = a0 + TAU * (2 + i) + ((s1 - s0 + SEGMENTS) % SEGMENTS) * SEG;
        const u = clamp01((cyc - i * 0.22) / (1.5 + i * 0.26));
        const b = Math.max(0, cyc - i * 0.22 - (1.5 + i * 0.26));
        c.ang[i] =
          lerp(a0, a1, spinK(u)) +
          (u >= 1 ? DETENT * Math.exp(-b * 8.5) * Math.sin(b * 44) + Math.sin(e * 0.4 + i) * 0.012 : 0);
      }
    } else if (phase === "sealed") {
      // idling, out of true, the way a machine nobody is playing sits — and never
      // quite still, because the motor brake creeps
      for (let i = 0; i < 3; i++) c.ang[i] = i * 0.9 + Math.sin(e * 0.3 + i) * 0.05 + Math.sin(e * 0.11 + i * 1.7) * 0.022;
    } else if (!opening) {
      for (let i = 0; i < 3; i++) c.ang[i] = i * 1.7 + 0.4;
    }

    const post = phase === "revealed" ? POST_END : c.gaveUpAt >= 0 ? tRef.current - c.gaveUpAt : -1;
    const buzz = post < 0 ? 0 : Math.pow(clamp01(1 - post / (GIVE_UP + 0.45)), 1.5);
    const sh = Math.min(1, buzz + c.kick * 0.5);

    for (let i = 0; i < 3; i++) {
      const m = reelRefs.current[i];
      const grp = reelGroupRefs.current[i];
      // a reel parked against a detent still creeps, and the machine shaking itself
      // apart shakes what is bolted inside it too
      const idle = opening && !c.spinning ? Math.sin(e * 0.9 + i * 2.2) * 0.006 : 0;
      const a = c.ang[i] + idle + (buzz > 0 ? Math.sin(e * 71 + i * 2.1) * 0.03 * buzz : 0);
      if (m) m.rotation.y = a;
      // The blur is the measured turn rate, so it is right for a hand-driven spin too
      // — but the angle wraps (the attract loop rewinds two whole turns at its seam),
      // and a wrap read literally is a full-blur flash on a reel that never moved.
      let d = (a - c.prev[i]) % TAU;
      if (d > Math.PI) d -= TAU;
      else if (d < -Math.PI) d += TAU;
      const rate = Math.abs(d) / Math.max(dt, 1e-4);
      c.prev[i] = a;
      c.rate[i] = lerp(c.rate[i], rate, Math.min(1, dt * 18));
      const bm = blurMats.current[i];
      if (bm) bm.opacity = clamp01((c.rate[i] - 2.2) / 11);
      if (grp) {
        // out of true first — each one tips a different way — then it lets go and falls
        // for real: g, its own release time, and a tumble it keeps all the way down
        const tip = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01((post - REEL_TIP) / (REEL_FALL - REEL_TIP)));
        const f = phase === "revealed" ? 2.2 : post < 0 ? 0 : Math.max(0, post - REEL_FALL - i * 0.07);
        grp.rotation.z = tip * (i - 1) * 0.34 + f * (0.9 + i * 0.7);
        grp.position.x = f * (i - 1) * 0.22;
        grp.position.y = 0.22 - tip * 0.04 - 0.5 * G_FALL * f * f;
        grp.visible = grp.position.y > -1.7;
      }
    }
    if (post >= REEL_FALL && !c.rattled && opening) {
      c.rattled = true;
      clack({ freq: 240, decay: 0.34, gain: 0.3 });
    }

    /* ---- the cabinet, taking it badly ---- */
    if (shakeRef.current) {
      // it is never fully still even at rest: there is a transformer in there
      const hum = 0.0009 * Math.sin(e * 41) + 0.0006 * Math.sin(e * 23.3);
      shakeRef.current.position.x = Math.sin(e * 97) * 0.016 * sh + hum;
      shakeRef.current.position.y = Math.sin(e * 131 + 1.1) * 0.011 * sh;
      shakeRef.current.rotation.z = Math.sin(e * 73 + 0.4) * 0.008 * sh + hum * 0.7;
    }

    /* ---- the lever, posed ---- */
    if (leverRef.current) {
      leverRef.current.rotation.x = c.lever * 1.15;
      // before the first touch it leans toward whoever is hovering, and the instant
      // they take hold it stops asking
      leverRef.current.rotation.z = opening && !c.touched ? -c.hover * 0.09 : 0;
    }
    if (knobRef.current) {
      // the ball squashes against the stop at the bottom of the stroke
      const q = clamp01((c.lever - 0.82) / 0.18);
      knobRef.current.scale.set(1 + q * 0.14 + c.hover * 0.05, 1 - q * 0.16 + c.hover * 0.05, 1 + q * 0.14 + c.hover * 0.05);
    }
    if (knobMatRef.current) knobMatRef.current.emissiveIntensity = c.hover * 0.5;

    /* ---- the printer ---- */
    const printK = settled ? 1 : post < 0 ? 0 : smooth(clamp01((post - PRINT0) / (PRINT1 - PRINT0)));
    const rows = printK * SLIP_ROWS;
    // a sheet this far out of a slot is not rigid; it breathes where it overhangs
    const sway = Math.sin(e * 1.05) * 0.011 + Math.sin(e * 2.3 + 1.1) * 0.004;
    const step = printK > 0 && printK < 1 ? Math.sin(rows * TAU) * 0.004 : 0;
    for (let i = 0; i < SLIP_ROWS; i++) {
      const m = slipRowRefs.current[i];
      if (!m) continue;
      const s = (rows - i - 0.5) * SLIP_ROW_H;
      if (s <= 0.002) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const th = s * SLIP_CURL;
      m.position.set(0, SLOT_Y + Math.sin(th) / SLIP_CURL + step, SLOT_Z + (1 - Math.cos(th)) / SLIP_CURL);
      m.rotation.x = th;
      m.rotation.z = sway * (s / SLIP_H);
    }
    if (opening && printK > 0 && printK < 1) {
      if (!c.whirred) {
        c.whirred = true;
        swell({ source: "sawtooth", freq: 58, cutoff: 300, attack: 0.1, hold: 0.9, release: 0.5, gain: 0.09, tremolo: 26, tremoloDepth: 0.5 });
      }
      const n = Math.floor(rows);
      if (n > c.rows) {
        // one tick every third line, or the head sounds like a machine gun
        if (n % 3 === 0) clack({ freq: 2100, decay: 0.04, gain: 0.13 });
        c.rows = n;
      }
    }

    if (trayLightRef.current) {
      const k = settled ? 1 : post < 0 ? 0 : clamp01((post - TRAY_AT) / 0.8);
      // it settles into a slow warm breath rather than a level — a light nobody is
      // driving still moves
      trayLightRef.current.intensity = k * (2.2 + 0.18 * Math.sin(e * 0.9));
    }

    /* ---- one sad coin, which rolls out and falls over ---- */
    if (coinRef.current) {
      const k = settled ? 1 : post < 0 ? 0 : clamp01((post - COIN_AT) / 1.0);
      coinRef.current.visible = k > 0.01;
      const roll = easeOutCubic(k);
      coinRef.current.position.x = lerp(-0.06, 0.36, roll);
      // out of the tray on an arc: it has to clear the lip before it can roll at all
      coinRef.current.position.y = -1.02 + Math.sin(Math.PI * clamp01(k * 1.25)) * 0.07;
      coinRef.current.rotation.z = -roll * 5.4;
      // then it topples, and a toppling coin spins down on its rim before it lies flat
      const tp = settled ? 1 : post < 0 ? 0 : clamp01((post - COIN_TOPPLE) / 0.45);
      const b = settled ? POST_END - COIN_TOPPLE - 0.45 : Math.max(0, post - COIN_TOPPLE - 0.45);
      const wob = Math.exp(-b * 4.6) * Math.sin(b * 27) * 0.17;
      coinRef.current.rotation.x = easeOutBack(tp) * (Math.PI / 2) - wob + tp * 0.02 * Math.sin(e * 0.9);
      coinRef.current.rotation.y = easeOutCubic(tp) * 9.2;
      if (opening && tp >= 1 && !c.rang) {
        c.rang = true;
        tone(880, { seconds: 0.5, gain: 0.11, shimmer: true });
      }
    }

    /* ---- the one bulb that still works ---- */
    // It flares when the machine gives up, browns out while it buzzes, and comes back
    // as the tray lights: the light change is what sells the reveal, not the reels.
    const bulbK = post < 0 ? 1 : post < 0.24 ? 1 + 3.4 * (1 - post / 0.24) : lerp(0.3, 1, smooth(clamp01((post - GIVE_UP) / 1.5)));
    const fl = flick(e);
    const lv = fl * bulbK;
    if (bulbRef.current) bulbRef.current.intensity = 7 * lv;
    if (bulbMatRef.current) bulbMatRef.current.opacity = clamp01(0.32 + lv * 0.68);
    if (bulbGlowRef.current) bulbGlowRef.current.scale.setScalar(0.36 + lv * 0.2);
    if (bulbGlowMatRef.current) bulbGlowMatRef.current.opacity = clamp01(lv * 0.42);
    // a bulb on 1.2m of flex is a pendulum: it drifts on its own, and it takes the
    // buzz through the floor a beat after the cabinet does
    if (bulbSwingRef.current) bulbSwingRef.current.rotation.z = Math.sin(e * 0.9) * 0.011 + Math.sin(e * 6.2) * 0.08 * sh;

    /* ---- the crown ---- */
    const im = marqRef.current;
    if (im) {
      const chase = opening ? 4.6 : phase === "preview" ? 3.2 : 1.5;
      for (let i = 0; i < MARQ_N; i++) {
        let k = 0.22 + 0.78 * Math.pow(0.5 + 0.5 * Math.sin(e * chase - i * 0.62), 2.2);
        // it gives up in the crown first: every bulb at once, and then the marquee
        // stays out — the tray is the only lit thing left, which is the whole point
        if (post >= 0) k = post < 0.26 ? 1 : lerp(k, 0.05, smooth(clamp01((post - 0.26) / 0.7)));
        k *= fl * 0.55 + 0.45;
        tmpCol.copy(bulbCol).multiplyScalar(k);
        im.setColorAt(i, tmpCol);
      }
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }

    /* ---- the highlight crossing the chrome ---- */
    if (glintRef.current && glintMatRef.current) {
      const u = (e * 0.13) % 1;
      glintRef.current.position.x = lerp(-1.1, 1.1, u);
      glintMatRef.current.opacity = Math.sin(Math.PI * u) * (0.12 + 0.05 * Math.sin(e * 0.7));
    }

    /* ---- the air ---- */
    const pts = ptRef.current;
    if (pts) {
      const pa = pts.geometry.attributes.position as THREE.BufferAttribute;
      const ca = pts.geometry.attributes.color as THREE.BufferAttribute;
      const drift = phase === "revealed" ? 0.55 : opening ? 1.2 : 0.85;
      for (let i = 0; i < MOTE_N; i++) {
        const u = (e * AIR.ms[i] * drift + AIR.mp[i]) % 1;
        pa.setXYZ(i, AIR.mx[i] + Math.sin(e * 0.42 + AIR.mp[i] * 9) * 0.1, -1.3 + u * 2.8, AIR.mz[i]);
        const a = Math.sin(u * Math.PI) * AIR.mb[i] * lv * 0.5;
        ca.setXYZ(i, a, a * 0.92, a * 0.74);
      }
      for (let i = 0; i < SPARK_N; i++) {
        const j = MOTE_N + i;
        const a = post < 0 || phase === "preview" ? -1 : post - BURST_AT - AIR.sd[i];
        if (a < 0 || a > 1.1) {
          ca.setXYZ(j, 0, 0, 0);
          continue;
        }
        // whatever was living in the reel bay, thrown out when the reels let go
        pa.setXYZ(j, AIR.vx[i] * a, 0.2 + AIR.vy[i] * a - 2.6 * a * a, 0.14 + AIR.vz[i] * a * 0.4);
        const k = (1 - a / 1.1) * AIR.sh[i];
        ca.setXYZ(j, k * 1.5, k * k * 1.0, k * k * k * 0.5);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    if (hintMatRef.current) {
      // it stops asking the moment a hand takes hold — or the moment it gives up
      // waiting for one and reaches for the lever itself
      const want = opening && !c.touched && mercy <= 0 ? 0.3 + 0.2 * Math.sin(e * 2.8) + c.hover * 0.3 : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- the lens ---- */
    // A few tenths, and only once the reels are out of the way: the tray is the
    // subject from there on and the frame should agree.
    const cam = camRef.current;
    if (cam) {
      const push = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01((post - REEL_FALL) / 1.6));
      const k = Math.min(1, dt * 8);
      c.cx += (Math.sin(e * 0.21) * 0.04 - c.cx) * k;
      c.cy += (lerp(CAM_Y, CAM_Y1, push) + Math.sin(e * 0.17 + 1.4) * 0.02 - c.cy) * k;
      c.cz += (lerp(CAM_Z, CAM_Z1, push) - c.cz) * k;
      cam.position.set(
        c.cx + Math.sin(e * 143) * 0.03 * sh,
        c.cy + Math.sin(e * 187 + 1.1) * 0.024 * sh,
        c.cz,
      );
      cam.lookAt(0, lerp(CAM_LOOK, CAM_LOOK1, push), 0);
      cam.rotation.z += Math.sin(e * 121) * 0.012 * sh;
    }

    if (opening && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, CAM_Y, CAM_Z]} fov={44} onUpdate={(o) => o.lookAt(0, CAM_LOOK, 0)} />
      <ambientLight intensity={0.4} />
      <pointLight ref={trayLightRef} position={[0, -0.72, 0.5]} intensity={0} color="#ffe6a8" distance={2.4} decay={1.5} />

      {/* the empty room */}
      <mesh position={[0, 0, -1.4]}>
        <planeGeometry args={[16, 11]} />
        <meshStandardMaterial color={cab.room} roughness={0.95} />
      </mesh>
      <mesh position={[0, -1.35, 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[16, 6]} />
        <meshStandardMaterial color="#0e1013" roughness={0.9} />
      </mesh>

      <group ref={fitRef}>
        {/* The one bulb in the room, on its own cord, hung where it can light the lever
            — and pivoted at the ceiling, so when the cabinet shakes the whole room's
            light swings with it. */}
        <group ref={bulbSwingRef} position={[1.02, 2.2, 0.55]}>
          <mesh position={[0, -0.6, 0]}>
            <cylinderGeometry args={[0.006, 0.006, 1.2, 5]} />
            <meshStandardMaterial color="#16181c" roughness={0.9} />
          </mesh>
          <mesh position={[0, -1.165, 0]}>
            <cylinderGeometry args={[0.032, 0.038, 0.07, 10]} />
            <meshStandardMaterial color="#2b2f36" roughness={0.5} metalness={0.7} />
          </mesh>
          <mesh position={[0, -1.22, 0]}>
            <sphereGeometry args={[0.055, 14, 10]} />
            <meshBasicMaterial ref={bulbMatRef} color={cab.bulb} transparent opacity={1} toneMapped={false} />
          </mesh>
          <sprite ref={bulbGlowRef} position={[0, -1.22, 0]} scale={0.5}>
            <spriteMaterial ref={bulbGlowMatRef} map={HINT} color={cab.bulb} transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
          </sprite>
          <pointLight ref={bulbRef} position={[0, -1.2, 0]} intensity={7} color={cab.bulb} distance={9} decay={1.1} />
        </group>

        <group ref={shakeRef}>
          {/* the cabinet */}
          <mesh position={[0, -0.1, -0.24]}>
            <boxGeometry args={[1.42, 2.1, 0.5]} />
            <meshStandardMaterial color={cab.body} roughness={cab.rough} metalness={cab.metal} />
          </mesh>
          {/* the crown */}
          <mesh position={[0, 1.02, -0.18]}>
            <boxGeometry args={[1.5, 0.34, 0.4]} />
            <meshStandardMaterial color={cab.trim} roughness={cab.rough * 0.8} metalness={cab.metal} />
          </mesh>
          <mesh position={[0, 1.02, 0.03]}>
            <planeGeometry args={[0.86, 0.19]} />
            <meshBasicMaterial map={header.texture} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          <instancedMesh ref={marqRef} args={[marqGeo, undefined, MARQ_N]} position={[0, 1.02, 0.06]} frustumCulled={false}>
            <meshBasicMaterial toneMapped={false} />
          </instancedMesh>

          {/* the window the reels sit behind */}
          <mesh position={[0, 0.22, 0.015]}>
            <planeGeometry args={[1.18, 0.62]} />
            <meshBasicMaterial color="#08090b" />
          </mesh>

          {[-0.38, 0, 0.38].map((x, i) => (
            <group
              key={i}
              ref={(el) => {
                reelGroupRefs.current[i] = el;
              }}
              position={[x, 0.22, 0.05]}
            >
              {/* axis along x: the reel turns on its own local y inside a tipped group */}
              <group rotation={[0, 0, Math.PI / 2]}>
                <mesh
                  ref={(m) => {
                    reelRefs.current[i] = m;
                  }}
                  geometry={reelGeo}
                >
                  <meshStandardMaterial map={reels[i].sharp} roughness={0.55} side={THREE.DoubleSide} />
                  {/* a child, so it turns with the reel it is smearing — otherwise the
                      two strips slide past each other through the cross-fade */}
                  <mesh geometry={blurGeo}>
                    <meshStandardMaterial
                      ref={(m) => {
                        blurMats.current[i] = m;
                      }}
                      map={reels[i].blur}
                      roughness={0.6}
                      side={THREE.DoubleSide}
                      transparent
                      opacity={0}
                      depthWrite={false}
                    />
                  </mesh>
                </mesh>
              </group>
            </group>
          ))}

          {/* the window's glass and its shadowed lip, over the reels */}
          <mesh position={[0, 0.22, 0.3]}>
            <planeGeometry args={[1.18, 0.62]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.05} depthWrite={false} />
          </mesh>
          <mesh position={[0, 0.56, 0.31]}>
            <planeGeometry args={[1.2, 0.09]} />
            <meshBasicMaterial color="#000000" transparent opacity={0.5} depthWrite={false} />
          </mesh>

          {/* the slot the slip comes out of, and the payout tray under it */}
          <mesh position={[0, SLOT_Y - 0.03, 0.235]}>
            <boxGeometry args={[1.08, 0.05, 0.06]} />
            <meshStandardMaterial color="#101215" roughness={0.8} metalness={0.4} />
          </mesh>
          <mesh position={[0, -0.86, 0.06]}>
            <boxGeometry args={[1.06, 0.4, 0.34]} />
            <meshStandardMaterial color="#141619" roughness={0.85} />
          </mesh>

          <mesh ref={glintRef} position={[0, 0.1, 0.34]}>
            <planeGeometry args={[0.34, 2.2]} />
            <meshBasicMaterial ref={glintMatRef} map={GLINT} color="#dfe9f5" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>

          {/* the lever, hinged at the cabinet's flank */}
          <group position={[LEVER_X, LEVER_Y, 0]}>
            <mesh>
              <sphereGeometry args={[0.075, 14, 12]} />
              <meshStandardMaterial color={cab.trim} roughness={0.3} metalness={0.8} />
            </mesh>
            <group ref={leverRef}>
              <mesh position={[0, 0.24, 0]}>
                <cylinderGeometry args={[0.028, 0.028, 0.48, 12]} />
                <meshStandardMaterial color={cab.trim} roughness={0.28} metalness={0.9} />
              </mesh>
              <mesh ref={knobRef} position={[0, 0.5, 0]}>
                <sphereGeometry args={[0.085, 18, 14]} />
                <meshStandardMaterial ref={knobMatRef} color="#b8362f" roughness={0.34} metalness={0.25} emissive="#ff7a5e" emissiveIntensity={0} />
              </mesh>
              <mesh position={[0, 0.5, 0]}>
                <planeGeometry args={[0.52, 0.52]} />
                <meshBasicMaterial ref={hintMatRef} map={HINT} color="#ffcf8a" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
              </mesh>
            </group>
          </group>

          {/* the slip, one printed row at a time, curling as it clears the slot */}
          {slipRowGeos.map((geo, i) => (
            <mesh
              key={i}
              ref={(m) => {
                slipRowRefs.current[i] = m;
              }}
              geometry={geo}
              material={slipMat}
              visible={false}
            />
          ))}
        </group>

        {/* the coin */}
        <group ref={coinRef} position={[-0.06, -1.02, 0.3]} visible={false}>
          <mesh>
            <cylinderGeometry args={[0.07, 0.07, 0.012, 22]} />
            <meshStandardMaterial color="#b9a05e" roughness={0.35} metalness={0.9} />
          </mesh>
        </group>

        <points ref={ptRef} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[ptBuf.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[ptBuf.col, 3]} />
          </bufferGeometry>
          <pointsMaterial map={MOTE} vertexColors size={0.03} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </points>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 1.2]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
