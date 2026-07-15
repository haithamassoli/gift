import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, sampleTextPoints } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";
import { pick } from "../catalog";

/* ===========================================================================
   HOURGLASS — the anti-fireworks. Sand falls like sand, but lands DELIBERATELY,
   piling into the message: time itself, spelling it out.

   The whole rig (frame + glass + every grain) is one group that swings 180° on
   the flip; the sand lives in the group's LOCAL space, so it stays inside the
   glass while it turns. After the flip, the group rests at A=0 and the reveal
   plays entirely in local coordinates — which is also exactly the frame a cold
   (reduced-motion) reveal draws, with A=0 and the fall-progress p pinned to 1.
   =========================================================================== */

/* ---------- the sand ---------- */
// Not additive: sand is opaque grit before it is anything, and the "glow through
// the glass" at the end is a separate additive plane behind the pile, not the
// grains lighting each other. Three brightnesses do all the depth work — grains
// waiting in the shadowed bulb, grains catching the low sun as they fall, grains
// settled and lit on the pile.
const SAND: Record<string, { base: string; glow: string; seed: number }> = {
  gold: { base: "#e3b24e", glow: "#f6c65a", seed: 7411 },
  rose: { base: "#e2a19b", glow: "#f2b3ab", seed: 2203 },
  silver: { base: "#c4ccd6", glow: "#e6edf5", seed: 5099 },
};

/* ---------- the frame ---------- */
// The variant has to change the metal itself — what the low sun catches on it and
// the light its engraving throws back — not a swatch. Brass is warm and bright,
// ebony drinks the light, steel is cool and mirror-hard.
const FRAME: Record<string, { color: string; metal: number; rough: number; emissive: string; accent: string }> = {
  brass: { color: "#8c6a2f", metal: 0.85, rough: 0.34, emissive: "#3a2a10", accent: "#e6b45a" },
  ebony: { color: "#241a15", metal: 0.14, rough: 0.62, emissive: "#0a0705", accent: "#caa76c" },
  steel: { color: "#9aa2ab", metal: 0.9, rough: 0.26, emissive: "#12161c", accent: "#e4ecf4" },
};

/* ---------- geometry of the glass ---------- */
// A double-bulb is a lathe. One radius function serves twice — it cuts the glass
// on the CPU and, evaluated again in JS, keeps every grain riding the inside of
// the wall so nothing can float through it. a = |y|/BH runs 0 at the neck to 1 at
// the plate: the body swells on a sine (an ovoid, not a straight cone), then a
// collar pulls it back in over the last fifth where the wood clamps it.
const BH = 0.92; // half-height of the glass, neck to plate
const BR = 0.6; // widest radius, out at the belly
const NR = 0.055; // the neck, where the thread is a hair wide
function bulbR(ay: number): number {
  const a = clamp01(ay / BH);
  const body = NR + (BR - NR) * Math.pow(Math.sin(a * Math.PI * 0.62), 0.85);
  const collar = 1 - 0.5 * smooth(clamp01((a - 0.8) / 0.2));
  return body * collar;
}

const glassGeo = (() => {
  const STEPS = 72;
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const y = BH - (2 * BH * i) / STEPS; // +BH (top plate) down to -BH (bottom plate)
    profile.push(new THREE.Vector2(Math.max(0.0006, bulbR(Math.abs(y))), y));
  }
  return new THREE.LatheGeometry(profile, 60);
})();

/* ---------- geometry of the woodwork ---------- */
// Two turned caps and four corner posts. The posts ride OUTSIDE the belly (PR >
// BR) so they frame the glass without ever clipping it, and the front pair sit at
// the diagonals so the message reads between them, never behind one.
const CAP_Y = 0.98;
const RCAP = 0.7;
const PR = 0.66; // post ring, clear of the belly at 0.60
const capGeo = new THREE.CylinderGeometry(RCAP, RCAP * 0.96, 0.075, 40);
const capLipGeo = new THREE.CylinderGeometry(RCAP * 0.62, RCAP * 0.62, 0.045, 32);
const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 2 * CAP_Y, 14);
const POST_ANG = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);
const plateGeo = new THREE.BoxGeometry(0.62, 0.15, 0.028);

/* ---------- the pile layout ---------- */
const FLOOR_Y = -0.74; // where the loose spill drift settles
const MOUND_H = 0.12;
const MSG_CENTER_Y = -0.44; // the message block sits low in the bottom bulb
const MSG_W = 1.0;
const MSG_MAXH = 0.72; // and its height is capped to what the bulb can hold
const Z_SPREAD = 0.06; // the pile has depth, so it reads as sand and not a decal
const NECK_GAP = 0.05; // grains start a hair above the neck, never in it
const MSG_MAX = 1000;

/* ---------- the fall ---------- */
// One grain's fall lasts FALL of the reveal's progress; the reveal is time-lapse,
// so the schedule warps: pow(s, 0.72) spends the opening slow — a thin trickle —
// and packs the last grains in fast, the way a time-lapse of an hourglass speeds
// toward the end. Every grain is a closed form of `p`, so p=1 draws the finished
// pile cold in one frame.
const FALL = 0.13;
const WARP = 0.72;

/* ---------- opening timeline (seconds) ---------- */
// No-input path (the only one the 12s bound measures): the mercy commits the flip
// by T_TIP1=2.3, the swing lands at 3.2 and clunks to rest by 3.55, the sand runs
// REVEAL_DUR and onOpenComplete lands at ~9.25s — inside 12 with slack for a phone
// dropping frames (dt is clamped, so this clock runs behind the wall clock the
// bound is read on). A recipient who turns it themselves is on no timer.
const FLIP_DUR = 0.9;
const CLUNK_HOLD = 0.35;
const REVEAL_DUR = 5.2;
const END_HOLD = 0.5;
const T_TIP0 = 1.0;
const T_TIP1 = 2.3;
const LEAN_MAX = 0.42 * Math.PI; // how far a drag turns it before it tips and commits
const DRAG_TARGET = 1.6; // world units of drag to send it over

/* ---------- shared textures ---------- */
const sandTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,1)"],
  [0.45, "rgba(255,255,255,0.75)"],
  [1, "rgba(255,255,255,0)"],
]);
const glowTex = makeRadialSprite();
const dustTex = makeRadialSprite();

// A late-afternoon room behind the sill: warm at the height the sun reaches,
// falling to dark above. Never in focus — it is only there so the glass has
// something to be transparent against.
function buildBackdrop(): THREE.CanvasTexture {
  const W = 64, H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#0c0a0f");
  grad.addColorStop(0.42, "#22161a");
  grad.addColorStop(0.72, "#4a2c1c"); // the sun on the far wall, low
  grad.addColorStop(0.9, "#2a1810");
  grad.addColorStop(1, "#140c0a");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const backdropTex = buildBackdrop();

const smoothstep = (a: number, b: number, x: number) => smooth(clamp01((x - a) / (b - a)));
// The clunk: the swing overshoots and rings down, the way something heavy settles.
const wobble = (w: number) => (w > 0 ? 0.05 * Math.exp(-w * 5) * Math.sin(w * 22) : 0);
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* ---------- the grains ---------- */
// One array does everything: a heap position up in the source bulb, a target in
// the message pile, a schedule, a seed. The heap is filled volumetrically and its
// slots handed out by schedule so the top surface SINKS cleanly as it drains —
// the grains that leave first are the ones sitting highest.
// pos/col are NOT returned: they belong to the geometry, and per-frame writes go
// through the attribute arrays fetched off the points ref (the react-hooks
// immutability rule forbids mutating anything a hook memoized). heap/tgt/sched/
// seed/base are read-only inputs to the fall and are only ever read.
interface Grains {
  geo: THREE.BufferGeometry;
  heap: Float32Array;
  tgt: Float32Array;
  sched: Float32Array;
  seed: Float32Array;
  base: Float32Array;
  n: number;
}

function buildGrains(text: string, lang: "en" | "ar", sandKey: string): Grains {
  const sand = SAND[sandKey] ?? SAND.gold;
  const tp = sampleTextPoints(text, {
    maxPoints: MSG_MAX,
    fontSize: 84,
    fontWeight: "700",
    maxWidthPx: 660,
    lineHeight: 1.16,
    lang,
  });
  const M = tp.count;
  const BASE = Math.min(240, Math.max(60, Math.round(M * 0.14) || 120));
  const N = M + BASE;
  const rand = mulberry32((hashStr(text) ^ sand.seed) >>> 0);

  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const heap = new Float32Array(N * 3);
  const tgt = new Float32Array(N * 3);
  const sched = new Float32Array(N);
  const seed = new Float32Array(N);
  const base = new Float32Array(N * 3);

  // Fit the message to the bulb: the block's height is the message's business,
  // its width the bulb's — whichever bound bites first sets the scale.
  const MW = Math.min(MSG_W, MSG_MAXH / Math.max(0.25, tp.aspect));

  const msgX = new Float32Array(M);
  const msgY = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    let tx = tp.points[k * 2] * MW + (rand() - 0.5) * 0.01;
    const ty = MSG_CENTER_Y + tp.points[k * 2 + 1] * MW + (rand() - 0.5) * 0.01;
    let tz = (rand() - 0.5) * Z_SPREAD;
    // Clamp each grain inside the wall: a letter's far edge can reach past the
    // narrow lower bulb, and a grain outside the glass reads as a bug.
    const maxR = bulbR(Math.abs(ty)) * 0.86;
    const rr = Math.hypot(tx, tz);
    if (rr > maxR) {
      const s = maxR / rr;
      tx *= s;
      tz *= s;
    }
    tgt[k * 3] = msgX[k] = tx;
    tgt[k * 3 + 1] = msgY[k] = ty;
    tgt[k * 3 + 2] = tz;
    seed[k] = rand();
  }

  // Pile-up ordering: reading-order columns (left→right, or right→left in Arabic)
  // as the major key, bottom-up WITHIN each column as the minor. So the drifts
  // grow from their base like real sand, and the message writes itself on letter
  // by letter rather than fading in all at once.
  const dir = lang === "ar" ? -1 : 1;
  const COLW = Math.max(0.001, MW / 26);
  const order = Array.from({ length: M }, (_, i) => i);
  order.sort((a, b) => {
    const ca = Math.round(msgX[a] / COLW);
    const cb = Math.round(msgX[b] / COLW);
    return (ca - cb) * dir || msgY[a] - msgY[b];
  });
  order.forEach((idx, rank) => {
    sched[idx] = M > 1 ? rank / (M - 1) : 0;
  });

  // The loose spill: a shallow mound on the bulb floor, higher toward the middle,
  // trickling in at random moments so there is always a little settling sand under
  // the words — a bed for them to land on, not text hanging in air.
  const floorR = bulbR(Math.abs(FLOOR_Y)) * 0.9;
  for (let j = 0; j < BASE; j++) {
    const i = M + j;
    const ang = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * floorR;
    tgt[i * 3] = Math.cos(ang) * rr;
    tgt[i * 3 + 1] = FLOOR_Y + MOUND_H * (1 - rr / floorR) * (0.25 + 0.75 * rand());
    tgt[i * 3 + 2] = Math.sin(ang) * rr;
    sched[i] = rand();
    seed[i] = rand();
  }

  // Heap slots, area-weighted so the wide belly is not sparse and the neck is not
  // packed (rejection on (r/BR)^2 is the disc's area at that height).
  const slots: [number, number, number][] = []; // y, x, z
  let guard = 0;
  while (slots.length < N && guard < N * 60) {
    guard++;
    const y = NECK_GAP + rand() * (BH * 0.98 - NECK_GAP);
    const rN = bulbR(y) / BR;
    if (rand() < rN * rN) {
      const rr = bulbR(y) * 0.9 * Math.sqrt(rand());
      const ang = rand() * Math.PI * 2;
      slots.push([y, Math.cos(ang) * rr, Math.sin(ang) * rr]);
    }
  }
  while (slots.length < N) {
    const y = NECK_GAP + rand() * (BH * 0.5);
    const rr = bulbR(y) * 0.9 * Math.sqrt(rand());
    const ang = rand() * Math.PI * 2;
    slots.push([y, Math.cos(ang) * rr, Math.sin(ang) * rr]);
  }
  // Highest slot to the earliest-departing grain: the surface then recedes toward
  // the neck as the reveal runs, last sand pooling low — an hourglass draining.
  slots.sort((a, b) => b[0] - a[0]);
  const bySched = Array.from({ length: N }, (_, i) => i).sort((a, b) => sched[a] - sched[b]);
  for (let k = 0; k < N; k++) {
    const idx = bySched[k];
    const s = slots[k];
    heap[idx * 3] = s[1];
    heap[idx * 3 + 1] = s[0];
    heap[idx * 3 + 2] = s[2];
  }

  // Base colour with a per-grain brightness scatter, so a flat fill of one hex
  // reads as thousands of grains and not a painted mass.
  const c = new THREE.Color(sand.base);
  for (let i = 0; i < N; i++) {
    const b = 0.78 + rand() * 0.4;
    base[i * 3] = c.r * b;
    base[i * 3 + 1] = c.g * b;
    base[i * 3 + 2] = c.b * b;
    // start every grain in its heap slot, so a first cold frame is a full bulb
    pos[i * 3] = heap[i * 3];
    pos[i * 3 + 1] = heap[i * 3 + 1];
    pos[i * 3 + 2] = heap[i * 3 + 2];
    col[i * 3] = base[i * 3];
    col[i * 3 + 1] = base[i * 3 + 1];
    col[i * 3 + 2] = base[i * 3 + 2];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return { geo, heap, tgt, sched, seed, base, n: N };
}

/* ---------- dust motes in the late light ---------- */
const DUST_N = 70;

export default function HourglassScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const sandKey = SAND[variants.sand] ? variants.sand : "gold";
  const frame = FRAME[variants.frame] ?? FRAME.brass;

  // `message` is "" on the gallery card and arrives per-keystroke on /create, so
  // the fall always has something to spell: with nothing to say, it spells "For you".
  const textSource = message.trim() || forRecipient(lang, recipientName);

  /* useMemo is load-bearing: it owns the grain geometry, the materials, the
     name textures — every GPU resource here — and each is disposed below. */
  const grains = useMemo(() => buildGrains(textSource, lang, sandKey), [textSource, lang, sandKey]);
  useEffect(() => () => grains.geo.dispose(), [grains]);

  const mats = useMemo(() => {
    const wood = new THREE.MeshStandardMaterial({
      color: frame.color,
      metalness: frame.metal,
      roughness: frame.rough,
      emissive: new THREE.Color(frame.emissive),
      emissiveIntensity: 0.4,
    });
    // Faint glass the cheap way: Phong gives a specular glint along the curve with
    // no environment map and no transmission pass — a bright edge on a nearly clear
    // body is all a bulb of glass really is, seen against a dim room.
    const glass = new THREE.MeshPhongMaterial({
      color: "#dfe8ef",
      specular: "#ffffff",
      shininess: 90,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plate = new THREE.MeshStandardMaterial({
      color: frame.color,
      metalness: frame.metal,
      roughness: frame.rough * 0.7,
      emissive: new THREE.Color(frame.emissive),
      emissiveIntensity: 0.3,
    });
    const sand = new THREE.PointsMaterial({
      map: sandTex,
      vertexColors: true,
      size: 0.033,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    return { wood, glass, plate, sand };
  }, [frame]);
  useEffect(
    () => () => {
      mats.wood.dispose();
      mats.glass.dispose();
      mats.plate.dispose();
      mats.sand.dispose();
    },
    [mats],
  );

  const names = useMemo(() => {
    const recip = makeTextTexture(forRecipient(lang, recipientName), {
      fontSize: 60,
      fontWeight: "500",
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: frame.accent,
      glow: 10,
      glowColor: frame.accent,
      lang,
    });
    const from = senderName.trim()
      ? makeTextTexture(pick(lang, `from ${senderName}`, `من ${senderName}`), {
          fontSize: 60,
          fontWeight: "500",
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: frame.accent,
          glow: 10,
          glowColor: frame.accent,
          lang,
        })
      : null;
    return { recip, from };
  }, [lang, recipientName, senderName, frame]);
  useEffect(
    () => () => {
      names.recip.texture.dispose();
      names.from?.texture.dispose();
    },
    [names],
  );

  const dust = useMemo(() => {
    const rand = mulberry32(9080);
    const pos = new Float32Array(DUST_N * 3);
    const ph = new Float32Array(DUST_N);
    const sp = new Float32Array(DUST_N);
    for (let i = 0; i < DUST_N; i++) {
      pos[i * 3] = (rand() - 0.5) * 2.6;
      pos[i * 3 + 1] = (rand() - 0.5) * 3.0;
      pos[i * 3 + 2] = 0.2 + rand() * 1.2;
      ph[i] = rand() * Math.PI * 2;
      sp[i] = 0.03 + rand() * 0.05;
    }
    return { pos, ph, sp };
  }, []);

  /* ---------- refs ---------- */
  const fitRef = useRef<THREE.Group>(null);
  const rigRef = useRef<THREE.Group>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const dustRef = useRef<THREE.Points>(null);
  const dustMatRef = useRef<THREE.PointsMaterial>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const glowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const pileLightRef = useRef<THREE.PointLight>(null);
  const recipRef = useRef<THREE.Group>(null);
  const recipMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const fromRef = useRef<THREE.Group>(null);
  const fromMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintRef = useRef<THREE.Mesh>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // The one piece of accumulating state is the flip gesture. Replay re-enters
  // "opening" and the clock resets, so this must too, or a second run would flip
  // before a finger was down.
  const g = useRef({
    active: false,
    touched: false,
    committed: false,
    flipAt: -1,
    drag: 0,
    px: 0,
    idle: 0,
    alone: 0,
  });
  useLayoutEffect(() => {
    const r = g.current;
    r.active = r.touched = r.committed = false;
    r.flipAt = -1;
    r.drag = r.px = r.idle = r.alone = 0;
  }, [phase]);

  /* ---------- the turn ---------- */
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.committed) return;
    const r = g.current;
    r.active = true;
    r.touched = true;
    r.px = ev.point.x;
    r.idle = 0;
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* the pointer-out fallback covers a browser that refuses capture */
    }
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const r = g.current;
    if (!r.active || phase !== "opening" || r.committed) return;
    ev.stopPropagation();
    // Any sideways travel is effort toward the swing — a heavy thing turned by hand.
    r.drag += Math.abs(ev.point.x - r.px);
    r.px = ev.point.x;
    r.idle = 0;
  };
  const stop = () => {
    g.current.active = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const r = g.current;

    /* Fit: the canvas runs from a narrow phone to a wide desktop, so the rig is
       scaled to whichever axis is tighter and the hourglass always sits whole
       in frame. */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const fit = Math.max(0.62, Math.min(1.05, Math.min(vw / 1.55, vh / 2.5)));
    fitRef.current?.scale.setScalar(fit);

    /* ---- A: the flip. p: how far the sand has run. ---- */
    let A: number;
    let p: number;
    if (phase === "revealed") {
      // The finished tableau, from `phase` alone — reduced motion lands here cold.
      A = 0;
      p = 1;
    } else if (phase === "opening") {
      r.idle += dt;
      // The mercy is the no-input path's alone, so it runs on its own clock — one
      // that stops while a hand is turning the glass and starts again when it goes
      // still. A finger resting on the frame is not a turn.
      if (!(r.active && r.idle < 0.5)) r.alone += dt;
      if (r.idle > 0.35 && !r.committed) r.drag = Math.max(0, r.drag - dt * 0.15);
      const mercy = smooth(clamp01((r.alone - T_TIP0) / (T_TIP1 - T_TIP0)));
      const lean = Math.max(clamp01(r.drag / DRAG_TARGET), mercy);
      if (lean >= 1 && !r.committed) {
        r.committed = true;
        r.flipAt = t;
      }
      if (!r.committed) {
        // it leans under the hand, on the edge of going over
        A = Math.PI - LEAN_MAX * lean;
        p = 0;
      } else {
        const u = clamp01((t - r.flipAt) / FLIP_DUR);
        A = lerp(Math.PI - LEAN_MAX, 0, easeOutCubic(u)) + wobble(t - r.flipAt - FLIP_DUR);
        const revealStart = r.flipAt + FLIP_DUR + CLUNK_HOLD;
        p = clamp01((t - revealStart) / REVEAL_DUR);
        if (p >= 1 && t > revealStart + REVEAL_DUR + END_HOLD && !doneRef.current) {
          doneRef.current = true;
          onOpenComplete?.();
        }
      }
    } else {
      // sealed / preview: settled and waiting, the full bulb hanging low, a slow
      // breath of a rock to say it wants to be turned
      A = Math.PI + (phase === "sealed" ? 0.05 * Math.sin(e * 1.1) : 0.03 * Math.sin(e * 0.7));
      p = 0;
    }
    if (rigRef.current) rigRef.current.rotation.z = A;

    /* ---- the grains ---- */
    // Each grain is a closed form of p: waiting in the heap, threading down, or
    // settled. The drain needs no bookkeeping — the grains that have left the heap
    // are simply the ones whose schedule has passed, and they were the high ones.
    if (pointsRef.current) {
      const { heap, tgt, sched, seed, base, n } = grains;
      // Writable arrays come off the ref's geometry, never off the memoized grains.
      const geo = pointsRef.current.geometry;
      const pos = geo.attributes.position.array as Float32Array;
      const col = geo.attributes.color.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const s = sched[i];
        const arrive = Math.pow(s, WARP);
        const depart = Math.max(0, arrive - FALL);
        let x: number, y: number, z: number, fac: number;
        if (p >= arrive) {
          x = tgt[i * 3];
          y = tgt[i * 3 + 1];
          z = tgt[i * 3 + 2];
          fac = 1.05; // settled and lit on the pile
        } else if (p <= depart) {
          x = heap[i * 3];
          y = heap[i * 3 + 1];
          z = heap[i * 3 + 2];
          fac = 0.9; // waiting in the bulb's shade
        } else {
          const f = (p - depart) / FALL;
          const g1 = smoothstep(0, 0.3, f); // gather to the neck
          const g2 = smoothstep(0.6, 1, f); // then fan out to the letter
          const yp = Math.pow(f, 1.45); // gravity: it falls faster as it goes
          y = lerp(heap[i * 3 + 1], tgt[i * 3 + 1], yp);
          const convX = lerp(heap[i * 3], 0, g1);
          const convZ = lerp(heap[i * 3 + 2], 0, g1);
          x = lerp(convX, tgt[i * 3], g2);
          z = lerp(convZ, tgt[i * 3 + 2], g2);
          // a live thread trembles where it is thinnest — only in the neck, and
          // gone by the time it lands, so a cold pile is never jittered
          const jit = 0.01 * g1 * (1 - g2);
          x += Math.sin(seed[i] * 41 + e * 9) * jit;
          z += Math.cos(seed[i] * 57 + e * 11) * jit;
          fac = 1.3; // caught by the low sun on the way down
        }
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        col[i * 3] = base[i * 3] * fac;
        col[i * 3 + 1] = base[i * 3 + 1] * fac;
        col[i * 3 + 2] = base[i * 3 + 2] * fac;
      }
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

    /* ---- the low sun glowing through the finished pile ---- */
    const glow = phase === "revealed" ? 1 : p;
    if (glowMatRef.current) glowMatRef.current.opacity = 0.34 * glow;
    if (glowRef.current) glowRef.current.visible = glow > 0.01;
    if (pileLightRef.current) pileLightRef.current.intensity = 1.3 * glow;

    /* ---- the etched names, upright however the frame is turned ---- */
    // The plaques ride the caps, so the swing carries them; counter-rotating each
    // by -A keeps the engraving readable at rest in both static poses.
    const showRecip = phase === "revealed" ? 0.95 : phase === "preview" ? 0.85 : 0;
    const showFrom = phase === "revealed" && names.from ? 0.9 : 0;
    if (recipRef.current) recipRef.current.rotation.z = -A;
    if (fromRef.current) fromRef.current.rotation.z = -A;
    if (recipMatRef.current) {
      recipMatRef.current.opacity += (showRecip - recipMatRef.current.opacity) * Math.min(1, dt * 3);
      if (recipRef.current) recipRef.current.visible = recipMatRef.current.opacity > 0.02;
    }
    if (fromMatRef.current) {
      fromMatRef.current.opacity += (showFrom - fromMatRef.current.opacity) * Math.min(1, dt * 3);
      if (fromRef.current) fromRef.current.visible = fromMatRef.current.opacity > 0.02;
    }

    /* ---- the hint: a soft turn-me glow, only before the flip commits ---- */
    if (hintMatRef.current) {
      const want = phase === "sealed" || (phase === "opening" && !r.committed) ? 0.16 + 0.1 * Math.sin(e * 2.2) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 3);
      if (hintRef.current) hintRef.current.visible = hintMatRef.current.opacity > 0.01;
    }

    /* ---- dust in the light, thinning once the show begins ---- */
    if (dustRef.current) {
      const pa = dustRef.current.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < DUST_N; i++) {
        let y = pa.getY(i) + dust.sp[i] * dt;
        if (y > 1.6) y = -1.6;
        pa.setXYZ(
          i,
          dust.pos[i * 3] + Math.sin(e * 0.3 + dust.ph[i]) * 0.12,
          y,
          dust.pos[i * 3 + 2],
        );
      }
      pa.needsUpdate = true;
    }
    if (dustMatRef.current) {
      const want = phase === "preview" || phase === "sealed" ? 0.5 : 0.24;
      dustMatRef.current.opacity += (want - dustMatRef.current.opacity) * Math.min(1, dt * 2);
    }
  });

  const recipAsp = names.recip.aspect;
  const fromAsp = names.from?.aspect ?? 0.3;

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.05, 4.6]} fov={42} onUpdate={(c) => c.lookAt(0, -0.05, 0)} />
      {/* Warm and low, the way an afternoon sun lands: one strong side light for
          the glint on the glass and the sheen on the metal, a cool fill so the
          shadow side is not black. */}
      <ambientLight intensity={0.34} color="#ffe6c8" />
      <directionalLight position={[-3.2, 1.4, 2.4]} intensity={1.7} color="#ffd39a" />
      <directionalLight position={[3.0, 0.6, -1.4]} intensity={0.4} color="#9fb6d8" />

      {/* the room behind the sill, and the sun itself off to the side */}
      <mesh position={[0, 0, -3]}>
        <planeGeometry args={[16, 9]} />
        <meshBasicMaterial map={backdropTex} />
      </mesh>
      <mesh position={[-2.5, 1.2, -1.8]}>
        <planeGeometry args={[5, 5]} />
        <meshBasicMaterial map={glowTex} color="#ffb060" transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* the windowsill */}
      <mesh position={[0, -1.62, -0.2]}>
        <boxGeometry args={[7, 0.22, 1.4]} />
        <meshStandardMaterial color="#2a1a12" roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0, -1.5, 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5, 1.6]} />
        <meshBasicMaterial map={glowTex} color="#ffbf72" transparent opacity={0.22} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* dust motes, in world space so the swing never carries them */}
      <points ref={dustRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dust.pos, 3]} />
        </bufferGeometry>
        <pointsMaterial
          ref={dustMatRef}
          map={dustTex}
          color="#ffe0b0"
          size={0.03}
          sizeAttenuation
          transparent
          opacity={0.4}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <group ref={fitRef}>
        {/* the whole hourglass — glass, wood, sand, plaques — turns as one */}
        <group ref={rigRef}>
          {/* fake bloom the house way: an additive plane behind the pile, warming
              as the sand settles, so the low sun reads as glowing through it */}
          <mesh ref={glowRef} position={[0, MSG_CENTER_Y, -0.25]} visible={false}>
            <planeGeometry args={[1.5, 1.1]} />
            <meshBasicMaterial
              ref={glowMatRef}
              map={glowTex}
              color={(SAND[sandKey] ?? SAND.gold).glow}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
          <pointLight ref={pileLightRef} position={[0, MSG_CENTER_Y, 0.4]} intensity={0} color={(SAND[sandKey] ?? SAND.gold).glow} distance={2.6} decay={1.8} />

          {/* the sand: heap, thread and message, all the same grains */}
          <points ref={pointsRef} geometry={grains.geo} material={mats.sand} frustumCulled={false} renderOrder={1} />

          {/* the glass, faint over the sand */}
          <mesh geometry={glassGeo} material={mats.glass} renderOrder={2} />

          {/* the caps and their turned lips */}
          <mesh position={[0, CAP_Y, 0]} geometry={capGeo} material={mats.wood} />
          <mesh position={[0, CAP_Y - 0.06, 0]} geometry={capLipGeo} material={mats.wood} />
          <mesh position={[0, -CAP_Y, 0]} geometry={capGeo} material={mats.wood} />
          <mesh position={[0, -CAP_Y + 0.06, 0]} geometry={capLipGeo} material={mats.wood} />

          {/* four corner posts, clear of the belly */}
          {POST_ANG.map((a, i) => (
            <mesh key={i} position={[Math.cos(a) * PR, 0, Math.sin(a) * PR]} geometry={postGeo} material={mats.wood} />
          ))}

          {/* etched names on the frame — recipient below, sender above */}
          <group ref={recipRef} position={[0, -(CAP_Y - 0.02), 0.52]} visible={false}>
            <mesh geometry={plateGeo} material={mats.plate} />
            <mesh position={[0, 0, 0.03]}>
              <planeGeometry args={[0.5, 0.5 * recipAsp]} />
              <meshBasicMaterial ref={recipMatRef} map={names.recip.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
          {names.from && (
            <group ref={fromRef} position={[0, CAP_Y - 0.02, 0.52]} visible={false}>
              <mesh geometry={plateGeo} material={mats.plate} />
              <mesh position={[0, 0, 0.03]}>
                <planeGeometry args={[0.5, 0.5 * fromAsp]} />
                <meshBasicMaterial ref={fromMatRef} map={names.from.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
              </mesh>
            </group>
          )}

          {/* a soft glow around the whole piece, saying turn me */}
          <mesh ref={hintRef} position={[0, 0, -0.4]} visible={false}>
            <planeGeometry args={[2.2, 2.8]} />
            <meshBasicMaterial ref={hintMatRef} map={glowTex} color={frame.accent} transparent opacity={0} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      </group>

      {/* the hand target for the turn — a plane in world space, so a drag that
          wanders off the swinging glass still lands here */}
      {phase === "opening" && (
        <mesh position={[0, 0, 1.2]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[3.2, 3.6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
