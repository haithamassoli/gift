import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeTextTexture } from "../text3d";
import { makeRadialSprite } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
const ROCKS: Record<string, { base: string; fleck: string; rough: number; metal: number; lump: number }> = {
  granite: { base: "#7d7a78", fleck: "#c8c4bd", rough: 0.88, metal: 0.06, lump: 1 },
  sandstone: { base: "#b98f5f", fleck: "#e3c69a", rough: 0.95, metal: 0, lump: 0.7 },
  geode: { base: "#5b4f68", fleck: "#c9a7ff", rough: 0.45, metal: 0.22, lump: 1.2 },
};
type EyeKind = "googly" | "sleepy" | "heart";
const EYES: Record<string, EyeKind> = { googly: "googly", sleepy: "sleepy", heart: "heart" };

const TAU = Math.PI * 2;
const ACTION_W = 2.9;
const ACTION_H = 2.3;

/* ---------- the rock: a noise-displaced sphere, built once ---------- */
function buildRock(lump: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.5, 40, 28);
  const pos = geo.attributes.position;
  const rand = mulberry32(1618);
  // Four fixed lobes, so the same rock every time — this rock is somebody's pet
  // and it does not get to be a different shape on reload.
  const lobes = Array.from({ length: 5 }, () => ({
    x: rand() * 2 - 1,
    y: rand() * 2 - 1,
    z: rand() * 2 - 1,
    k: 0.06 + rand() * 0.1,
    f: 1.4 + rand() * 2.6,
  }));
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let d = 0;
    for (const l of lobes) d += Math.sin(v.x * l.f + l.x * 4) * Math.cos(v.y * l.f + l.y * 4) * Math.sin(v.z * l.f + l.z * 4) * l.k;
    v.multiplyScalar(1 + d * lump);
    v.y *= 0.86; // it sits, it does not roll away
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Speckled stone, so the rock is a rock and not a grey ball. */
function buildSpeckle(base: string, fleck: string): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(2357);
  for (let i = 0; i < 5200; i++) {
    g.globalAlpha = 0.1 + rand() * 0.5;
    g.fillStyle = rand() > 0.5 ? fleck : "#3a3632";
    const r = 1 + rand() * 3;
    g.beginPath();
    g.arc(rand() * s, rand() * s, r, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** Cardboard, with the breathing holes it does not need. */
function buildCardboard(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b48a5c";
  g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(120,86,52,0.4)";
  g.lineWidth = 2;
  for (let y = 0; y < s; y += 7) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(s, y);
    g.stroke();
  }
  g.fillStyle = "#3a2a1a";
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.arc(s * (0.2 + i * 0.15), s * 0.32, s * 0.022, 0, TAU);
    g.fill();
  }
  return new THREE.CanvasTexture(c);
}
const CARDBOARD = buildCardboard();

/** Straw: short instanced-free strokes baked straight into a texture. */
function buildStraw(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#8a6a3c";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(97);
  for (let i = 0; i < 500; i++) {
    g.strokeStyle = `hsl(${38 + rand() * 14} ${45 + rand() * 25}% ${44 + rand() * 30}%)`;
    g.lineWidth = 1 + rand() * 1.6;
    const x = rand() * s;
    const y = rand() * s;
    const a = rand() * TAU;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * 26, y + Math.sin(a) * 26);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}
const STRAW_TEX = buildStraw();

/* ---------- loose straw, the part that gets thrown about ---------- */
// The baked texture is the bedding; these are the pieces sitting on top of it, and
// they are the only thing in the box that reports what the rock just did.
const STRAW_N = 34;
const STRAW_FLOOR = -0.132; // just clear of the bedding plane at -0.14
const STRAWS = (() => {
  const rand = mulberry32(4242);
  const x = new Float32Array(STRAW_N);
  const z = new Float32Array(STRAW_N);
  const a = new Float32Array(STRAW_N);
  const s = new Float32Array(STRAW_N);
  for (let i = 0; i < STRAW_N; i++) {
    // A ring, not a scatter: the rock is sunk into the bedding and anything sampled
    // inside its waist would spend the whole scene buried in granite.
    const th = rand() * TAU;
    const r = 0.48 + rand() * 0.1;
    x[i] = Math.cos(th) * r;
    z[i] = Math.sin(th) * r * 0.62; // the box is shallower than it is wide
    a[i] = rand() * TAU;
    s[i] = 0.68 + rand() * 0.62;
  }
  return { x, z, a, s };
})();
const STRAW_COLS = (() => {
  const rand = mulberry32(881);
  return Array.from({ length: STRAW_N }, () =>
    new THREE.Color().setHSL((36 + rand() * 18) / 360, 0.38 + rand() * 0.26, 0.34 + rand() * 0.26),
  );
})();
const strawGeo = new THREE.BoxGeometry(0.17, 0.007, 0.014);
const strawScratch = new THREE.Object3D();

const eyeGeo = new THREE.SphereGeometry(0.088, 18, 14);
const pupilGeo = new THREE.SphereGeometry(0.042, 14, 10);
const lidGeo = new THREE.CircleGeometry(0.096, 18);
/* A heart, for the variant that has them instead of pupils. */
const heartShape = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, -0.045);
  s.bezierCurveTo(0.06, 0.02, 0.055, 0.06, 0.022, 0.06);
  s.bezierCurveTo(0.008, 0.06, 0.002, 0.05, 0, 0.042);
  s.bezierCurveTo(-0.002, 0.05, -0.008, 0.06, -0.022, 0.06);
  s.bezierCurveTo(-0.055, 0.06, -0.06, 0.02, 0, -0.045);
  return new THREE.ShapeGeometry(s, 8);
})();

const glowTex = makeRadialSprite();

/* ---------- dust ---------- */
// One Points, two populations: the first AMB_N are ambient specks that hang in the
// box forever (closed form of the clock, so every phase has something moving in it),
// the rest are the puff a hop or a landing knocks off the bedding.
const AMB_N = 26;
const BURST_N = 30;
const MOTE_N = AMB_N + BURST_N;
const BURST_LIFE = 0.95;
const AMB = (() => {
  const rand = mulberry32(31337);
  const ox = new Float32Array(AMB_N);
  const oz = new Float32Array(AMB_N);
  const sp = new Float32Array(AMB_N);
  const ph = new Float32Array(AMB_N);
  for (let i = 0; i < AMB_N; i++) {
    ox[i] = (rand() * 2 - 1) * 0.52;
    oz[i] = (rand() * 2 - 1) * 0.3;
    sp[i] = 0.035 + rand() * 0.055;
    ph[i] = rand();
  }
  return { ox, oz, sp, ph };
})();

/* ---------- opening ---------- */
const PURR_STEP = 0.42; // seconds between purr bursts while a hand is on it
const MIN_PET = 1.6; // it will not roll over for anyone who has not put the time in
const ROLL_LEAD = 0.2; // the crouch before it commits
const ROLL_DUR = 0.9;
const ROLL_END = ROLL_LEAD + ROLL_DUR;
const HOP_DUR = 0.44;
const SULK_WAIT = 0.62; // long enough after your hand leaves that it reads as a comment
const PAPERS_AT = 0.75; // after the roll: the certificate flutters in
const PAPERS_DUR = 0.9;
const POST_END = 2.6;

/* ---------- the invisible hand ---------- */
// A gift may never lock waiting for input — and this scene is also every gallery
// card's whole loop, which has no hands in it at all. Left to itself, the rock gets
// petted anyway, by nobody: the same passes, the same purr, the same roll over.
const MERCY0 = 2.4; // grace — long enough that a hand about to arrive is never overridden
const MERCY1 = 6.6; // …and by here it has been rubbed all the way over (+POST_END ≈ 9.2s)
const MERCY_PASS = 0.55; // seconds per stroke of the hand that is not there

const BOX_WALLS: [number, number, number, number][] = [
  [0, 0, -0.42, 0],
  [-0.62, 0, 0, Math.PI / 2],
  [0.62, 0, 0, Math.PI / 2],
];
const EYE_AT: [number, number, number][] = [
  [-0.17, 0.16, 0.4],
  [0.17, 0.16, 0.4],
];

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

/** Adoption papers. Notarised by nobody. Care instructions: three blank lines. */
function buildCertificate(sender: string, recipient: string, lang: Lang): THREE.CanvasTexture {
  const w = 560;
  const h = 400;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6efdd";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#9a7b46";
  g.lineWidth = 5;
  g.strokeRect(14, 14, w - 28, h - 28);
  g.lineWidth = 1.5;
  g.strokeRect(24, 24, w - 48, h - 48);
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "Georgia, serif";
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.fillStyle = "#5b4526";
  g.font = `700 34px ${fam}`;
  g.fillText(ar ? "شهادة تبنٍّ" : "CERTIFICATE OF ADOPTION", w / 2, 84);
  g.font = `400 22px ${fam}`;
  g.fillText(ar ? "لصخرةٍ واحدة، تخصّ:" : "for one (1) rock, belonging to:", w / 2, 126);
  g.font = `600 30px ${fam}`;
  g.fillText(`${recipient || "—"}  ·  ${sender || "—"}`, w / 2, 176);
  g.font = `400 18px ${fam}`;
  g.fillText(ar ? "تعليمات العناية:" : "CARE INSTRUCTIONS:", w / 2, 224);
  // Three lines, all blank. It is the whole joke and it needs no caption.
  g.strokeStyle = "#b9a071";
  g.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    const y = 254 + i * 34;
    g.beginPath();
    g.moveTo(90, y);
    g.lineTo(w - 90, y);
    g.stroke();
  }
  g.font = `italic 400 15px ${fam}`;
  g.fillStyle = "#8a7350";
  g.fillText(ar ? "موثّقة من: لا أحد" : "notarised by: nobody", w / 2, h - 44);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** Everything the rock is currently feeling. Reset wholesale when a run restarts. */
function freshPet() {
  return {
    down: false,
    touched: false,
    hover: false,
    hoverK: 0,
    px: 0,
    leanX: 0,
    acc: 0, // distance rubbed since the last frame read it
    pet: 0, // *recent* travel: a parked finger is not petting
    speed: 0,
    dir: 0,
    run: 0,
    rub: 0,
    purrAt: 0,
    semis: 0,
    wob: 0, // the spring: angle…
    wobV: 0, // …and its velocity, which is what makes it overshoot
    hopAt: -1,
    hopped: false,
    hopLanded: false,
    sulkPend: false,
    sulkAt: -1,
    rollAt: -1,
    landed: false,
    papered: false,
    burst: 0,
    kick: 0,
    blink: 0,
    blinkAt: 1.4,
    dbl: 0,
    look: 0,
    lastPx: 0,
    lastPy: 0,
    cycle: -1,
    alone: 0, // seconds since the last real pointer event
    mpass: -1, // which stroke of the invisible hand we last counted
  };
}

export default function PetRockScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const rock = ROCKS[variants.rock] ?? ROCKS.granite;
  const eyeKind = EYES[variants.eyes] ?? "googly";

  const rockGeo = useMemo(() => buildRock(rock.lump), [rock]);
  useEffect(() => () => rockGeo.dispose(), [rockGeo]);

  const speckle = useMemo(() => buildSpeckle(rock.base, rock.fleck), [rock]);
  useEffect(() => () => speckle.dispose(), [speckle]);

  /* The message is in marker, on its belly. Nowhere else. */
  const belly = useMemo(() => {
    const body = message.trim() || forRecipient(lang, recipientName);
    const t = makeTextTexture(body, {
      fontFamily: "'Marker Felt', 'Comic Sans MS', 'Segoe Print', cursive",
      fontWeight: "600",
      fontSize: 60,
      color: "#f4f1e8",
      maxWidthPx: 60 * 8,
      lineHeight: 1.26,
      padding: 18,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 0.72, 0.56) };
  }, [message, recipientName, lang]);
  useEffect(() => () => belly.t.texture.dispose(), [belly]);

  const cert = useMemo(() => buildCertificate(senderName, recipientName, lang), [senderName, recipientName, lang]);
  useEffect(() => () => cert.dispose(), [cert]);

  // Buffers feed <bufferAttribute> and are only written through the points ref in
  // useFrame; the burst sim is mutable per-particle state, so it lives in a ref.
  const moteBuf = useMemo(
    () => ({ pos: new Float32Array(MOTE_N * 3), col: new Float32Array(MOTE_N * 3) }),
    [],
  );
  const burst = useRef({
    t0: new Float32Array(BURST_N).fill(-99),
    ox: new Float32Array(BURST_N),
    oy: new Float32Array(BURST_N),
    oz: new Float32Array(BURST_N),
    vx: new Float32Array(BURST_N),
    vy: new Float32Array(BURST_N),
    vz: new Float32Array(BURST_N),
    cur: 0,
  });
  const straw = useRef({
    y: new Float32Array(STRAW_N),
    v: new Float32Array(STRAW_N),
    sp: new Float32Array(STRAW_N),
    spv: new Float32Array(STRAW_N),
  });

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const g = useRef(freshPet());
  useEffect(() => {
    if (phase === "opening") {
      g.current = freshPet();
      burst.current.t0.fill(-99);
    }
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const warmRef = useRef<THREE.PointLight>(null);
  const fitRef = useRef<THREE.Group>(null);
  const boxRef = useRef<THREE.Group>(null);
  const rollRef = useRef<THREE.Group>(null);
  const wobbleRef = useRef<THREE.Group>(null);
  const socketRefs = useRef<(THREE.Group | null)[]>([]);
  const eyeRefs = useRef<(THREE.Group | null)[]>([]);
  const lidRefs = useRef<(THREE.Mesh | null)[]>([]);
  const bellyRef = useRef<THREE.Group>(null);
  const bellyMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const certRef = useRef<THREE.Group>(null);
  const certMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lidTop = useRef<THREE.Group>(null);
  const strawRef = useRef<THREE.InstancedMesh>(null);
  const motesRef = useRef<THREE.Points>(null);
  const glintRef = useRef<THREE.Sprite>(null);
  const glintMatRef = useRef<THREE.SpriteMaterial>(null);

  // Per-straw colour is set once — the bedding underneath is one flat texture and
  // uniformly-coloured sticks on top of it read as plastic.
  useEffect(() => {
    const m = strawRef.current;
    if (!m) return;
    for (let i = 0; i < STRAW_N; i++) m.setColorAt(i, STRAW_COLS[i]);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, []);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.rollAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    const c = g.current;
    c.down = true;
    c.touched = true;
    // A real hand always wins: the invisible one gives up the moment one lands.
    c.alone = 0;
    c.mpass = -1;
    c.px = ev.point.x;
    c.dir = 0;
    c.run = 0;
    // A hand back on the rock cancels the sulk it had queued up. It is not proud.
    c.sulkPend = false;
    c.sulkAt = -1;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (phase !== "opening" || c.rollAt >= 0) return;
    // Even a pointer only crossing the box counts as somebody being here — the
    // invisible hand backs off and restarts its grace period.
    c.alone = 0;
    c.mpass = -1;
    if (!c.down) return;
    ev.stopPropagation();
    const dx = ev.point.x - c.px;
    c.px = ev.point.x;
    // A captured pointer freezes at its last hit and jumps on re-entry.
    if (Math.abs(dx) > 0.4) return;
    // Back and forth: distance is what counts, so a rub in either direction is a rub.
    const d = Math.abs(dx);
    c.pet += d;
    c.acc += d;
    c.run += d;
    // How far off-centre the hand is, which is the direction it wants to fall.
    c.leanX = Math.max(-1, Math.min(1, ev.point.x / 0.5));
    const s = Math.sign(dx);
    if (s !== 0 && c.dir !== 0 && s !== c.dir && c.run > 0.055) {
      // End of a pass: shove the spring the other way. Harder if the hand is quick,
      // which is the whole reason the wobble has a velocity and not an amplitude.
      c.wobV += s * (0.9 + 2.2 * clamp01(c.speed / 1.5));
      c.kick = Math.max(c.kick, 0.35 + 0.5 * clamp01(c.speed / 1.5));
      c.run = 0;
    }
    if (s !== 0 && d > 0.003) c.dir = s;
  };
  const stop = () => {
    const c = g.current;
    if (c.down && c.rub > 0.12 && c.rollAt < 0) c.sulkPend = true;
    c.down = false;
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
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const c = g.current;
    const opening = phase === "opening";

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.62, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- the gaze, in every phase. "It is looking at you" is the whole invitation. ---- */
    const dpx = state.pointer.x - c.lastPx;
    const dpy = state.pointer.y - c.lastPy;
    if (dpx * dpx + dpy * dpy > 4e-6) c.look = 1;
    c.lastPx = state.pointer.x;
    c.lastPy = state.pointer.y;
    // Attention bleeds off slowly: a still pointer eventually lets it go back to
    // staring at the middle distance, which is what a rock does.
    c.look = Math.max(0, c.look - dt * 0.24);
    const att = smooth(clamp01(c.look));
    const gazeX = lerp(Math.sin(e * 0.37) * 0.6 + Math.sin(e * 0.11 + 1.7) * 0.3, state.pointer.x * 1.15, att);
    const gazeY = lerp(Math.sin(e * 0.29 + 2.2) * 0.35, state.pointer.y * 0.85, att);
    c.hoverK = lerp(c.hoverK, c.hover && opening ? 1 : 0, Math.min(1, dt * 7));

    /* ---- petting ---- */
    // `speed` is smoothed pointer travel per second: it drives the purr's pitch, how
    // fast the rock warms to you, and how hard the spring gets shoved.
    const inst = c.acc / Math.max(dt, 1e-3);
    c.acc = 0;
    c.speed = lerp(c.speed, inst, Math.min(1, dt * 9));
    const fast = clamp01(c.speed / 1.5);
    // Nobody came. `alone` is seconds since the last real pointer event; past MERCY0
    // a hand that is not there starts petting it anyway, eased in so it reads as
    // somebody sitting down to the rock rather than as a timer giving up on you.
    if (opening && c.rollAt < 0) c.alone += dt;
    const mercy = opening ? smooth(clamp01((c.alone - MERCY0) / (MERCY1 - MERCY0))) : 0;
    const mPhase = (c.alone - MERCY0) / MERCY_PASS; // one stroke out and back per unit
    if (opening && c.rollAt < 0) {
      // `pet` bleeds away, so a finger parked on the rock without moving is not
      // petting it and the purr knows.
      c.pet = Math.max(0, c.pet - dt * 0.7);
      const petting = c.down && c.pet > 0.015;
      c.rub = clamp01(c.rub + (petting ? dt * (0.3 + 0.34 * fast) : -dt * 0.5));
      // What the invisible hand is worth, as a *floor* under `rub` and never a rate:
      // the decay on the line above cannot argue with a floor, and a real hand's own
      // progress is never pulled back down to it.
      if (mercy > 0) c.rub = Math.max(c.rub, mercy);
      // Each stroke ends the way a real pass does — one shove into the spring,
      // alternating sides, which is the whole reason the wobble carries a velocity.
      const stroke = Math.floor(mPhase);
      if (mercy > 0 && stroke !== c.mpass) {
        c.mpass = stroke;
        c.wobV += (stroke % 2 === 0 ? -1 : 1) * (0.55 + 0.9 * mercy);
        c.kick = Math.max(c.kick, 0.2 + 0.2 * mercy);
      }
      // Below here neither the rock nor the code cares whose hand it is; the
      // invisible one just strokes slower, so the purr climbs slower with it.
      const hand = petting || mercy > 0;
      const hfast = petting ? fast : 0.15 + 0.4 * mercy;
      if (hand) {
        c.purrAt -= dt;
        if (c.purrAt <= 0) {
          // Bursts come quicker and higher the faster you go — a purr is a rate, not
          // a note, and this one is bad at hiding how it feels.
          c.purrAt = PURR_STEP * (1 - 0.4 * hfast);
          c.semis = Math.min(12, c.semis + 1);
          swell({
            source: "sawtooth",
            freq: 58 * Math.pow(2, c.semis / 12) * (1 + 0.17 * hfast),
            cutoff: 340 + 180 * hfast,
            attack: 0.09,
            hold: 0.16,
            release: 0.22,
            gain: 0.13 + 0.05 * hfast,
            tremolo: 20 + 12 * hfast,
            tremoloDepth: 0.75,
          });
        }
        // Halfway: a delighted little hop it did not plan and cannot take back.
        if (!c.hopped && c.rub >= 0.5) {
          c.hopped = true;
          c.hopAt = t;
          c.wobV += 1.6;
          tone(880, { seconds: 0.26, gain: 0.15, shimmer: true });
        }
        if (c.rub >= 1 && t > MIN_PET) {
          c.rollAt = t;
          tone(659, { shimmer: true, seconds: 1.1, gain: 0.22 });
        }
      }
    }

    /* ---- the sulk: one pointed wobble, on a delay, once your hand is gone ---- */
    if (opening && c.sulkPend && !c.down) {
      c.sulkAt = t + SULK_WAIT;
      c.sulkPend = false;
    }
    if (opening && c.sulkAt >= 0 && t >= c.sulkAt) {
      c.sulkAt = -1;
      c.wobV += 3.4;
      c.kick = Math.max(c.kick, 0.4);
      swell({ source: "sawtooth", freq: 52, cutoff: 220, attack: 0.05, hold: 0.06, release: 0.3, gain: 0.12, tremolo: 14, tremoloDepth: 0.6 });
    }

    /* ---- preview and sealed keep themselves company ---- */
    // Preview shimmies on a short loop because a gallery card has to sell itself;
    // sealed only shifts occasionally, because sealed is waiting.
    if (!opening && phase !== "revealed") {
      const period = phase === "preview" ? 5.6 : 9.4;
      const cyc = Math.floor(e / period);
      if (c.cycle < 0) c.cycle = cyc;
      else if (cyc !== c.cycle) {
        c.cycle = cyc;
        c.wobV += phase === "preview" ? 2.6 : 1.3;
        c.kick = Math.max(c.kick, phase === "preview" ? 0.3 : 0.16);
      }
    }

    /* ---- the reveal clock ---- */
    const post = phase === "revealed" ? POST_END : c.rollAt >= 0 ? t - c.rollAt : -1;
    const rolling = post >= 0;
    const u = rolling ? clamp01((post - ROLL_LEAD) / ROLL_DUR) : 0;
    // easeOutBack carries it past the horizontal and lets it fall back — a rock that
    // stops dead at exactly a quarter-turn is a rock on rails.
    const spin = rolling ? easeOutBack(u) : 0;
    const land = post - ROLL_END;
    const settle = land > 0 ? Math.exp(-land * 5.4) * Math.sin(land * 24) : 0;
    const roll = clamp01(spin);
    const reveal = rolling ? smooth(clamp01((post - 0.35) / 1.1)) : 0;

    // Opening only: `revealed` entered cold is a settled tableau, and a puff of dust
    // frozen mid-air on frame 40 is exactly the artefact reduced motion must not show.
    // …and on ROLL_END exactly, which is where `arc` returns to zero and `settle`
    // starts: the thud, the dust and the bounce all have to be the same instant.
    if (opening && rolling && !c.landed && post >= ROLL_END) {
      c.landed = true;
      c.kick = 1;
      c.burst = 14;
      clack({ freq: 240, decay: 0.18, gain: 0.26 });
    }

    /* ---- it rolls over, delighted, and the message is on its belly ---- */
    if (rollRef.current) {
      const r = rollRef.current;
      // A *negative* quarter-turn about X is what brings the underside round to the
      // camera (it maps -Y to +Z); the belly plane is then normal -Y so it ends up
      // facing us. Get either sign wrong and the rock lies down on its own message.
      const crouch = rolling && post < ROLL_LEAD ? Math.sin((post / ROLL_LEAD) * Math.PI) * 0.13 : 0;
      r.rotation.x = -Math.PI * 0.5 * spin + settle * 0.09 + crouch;
      // it kicks out sideways going over, and squares itself again on the way down
      r.rotation.z = rolling ? Math.sin(u * Math.PI) * 0.2 + settle * 0.05 : 0;
      const arc = rolling && u > 0 && u < 1 ? Math.sin(u * Math.PI) * 0.14 : 0;
      r.position.y = roll * 0.16 + arc + Math.sin(e * 1.4) * 0.006 * (1 - roll);
    }

    /* ---- the spring: leans toward the finger, overshoots, and rings down ---- */
    // Velocity + damping, not a sine: the shoves it takes on each pass and each
    // landing are impulses, and a sine has nowhere to put an impulse.
    let target = 0;
    if (c.down && !rolling) target = -c.leanX * 0.3 * (0.35 + c.rub);
    else if (mercy > 0 && !rolling) {
      // It leans into the hand that is not there exactly as it leans into a real one:
      // same lean, same amount, tracking the stroke instead of a finger.
      target = -Math.sin(mPhase * Math.PI) * 0.3 * (0.35 + c.rub) * mercy;
    } else if (!rolling) {
      // The lean-toward-the-pointer invitation. In `opening` it stops the instant a
      // finger lands, because by then the invitation has been accepted.
      const invite = opening ? (c.touched ? 0 : 1) : 1;
      target = -state.pointer.x * 0.1 * invite - c.hoverK * 0.02;
    }
    c.wobV += (-(c.wob - target) * 92 - c.wobV * 7.4) * dt;
    c.wob += c.wobV * dt;

    const hopK = c.hopAt >= 0 ? (t - c.hopAt) / HOP_DUR : 2;
    const airborne = hopK > 0 && hopK < 1;
    const hop = airborne ? Math.sin(hopK * Math.PI) * 0.13 : 0;
    if (c.hopAt >= 0 && !c.hopLanded && hopK >= 1) {
      c.hopLanded = true;
      c.wobV += 1.1;
      c.kick = Math.max(c.kick, 0.7);
      c.burst = Math.max(c.burst, 8);
      if (opening) clack({ freq: 320, decay: 0.11, gain: 0.16 });
    }

    if (wobbleRef.current) {
      const w = wobbleRef.current;
      w.rotation.z = c.wob;
      // breathing, stretch in the air, and a contented settle onto the belly
      const breath = Math.sin(e * (phase === "revealed" ? 1.1 : 1.6)) * (phase === "revealed" ? 0.016 : 0.012);
      const air = airborne ? Math.sin(hopK * Math.PI) : 0;
      const sy = 1 + breath + air * 0.07 - c.rub * 0.035 * (c.down ? 1 : 0) - roll * 0.02;
      const sxz = 1 - breath * 0.6 - air * 0.05 + c.rub * 0.02 * (c.down ? 1 : 0) + c.hoverK * 0.012;
      w.scale.set(sxz, sy, sxz);
      w.position.y = -0.14 + hop + Math.abs(c.wob) * 0.02;
    }

    /* ---- the box takes the rock's momentum, because cardboard would ---- */
    if (boxRef.current) {
      const b = boxRef.current;
      // …and as the rock goes over, the weight crosses the floor and the box tips
      // after it, one way then the other, square again by the time it lands.
      const shift = rolling ? Math.sin(u * TAU) * 0.035 : 0;
      const tip = -c.wob * 0.1 + shift + (land > 0 ? Math.exp(-land * 4) * Math.sin(land * 13) * 0.05 : 0);
      b.rotation.z = lerp(b.rotation.z, tip, Math.min(1, dt * 7));
      b.position.y = lerp(b.position.y, -0.3 + Math.abs(c.wobV) * 0.002, Math.min(1, dt * 6));
    }

    /* ---- straw: thrown up by whatever just happened, then dropped ---- */
    const st = straw.current;
    const kick = c.kick;
    c.kick = 0;
    const smesh = strawRef.current;
    for (let i = 0; i < STRAW_N; i++) {
      if (kick > 0) {
        // Pieces near the middle catch the most of it — the rock is in the middle.
        const near = 1 - Math.min(1, Math.abs(STRAWS.x[i]) / 0.6);
        const k = kick * (0.35 + 0.65 * near);
        st.v[i] += k * (0.22 + Math.random() * 0.5);
        st.spv[i] += (Math.random() - 0.5) * 7 * k;
      }
      st.v[i] -= 3.4 * dt;
      st.y[i] += st.v[i] * dt;
      if (st.y[i] <= 0) {
        st.y[i] = 0;
        // one small bounce, then it stays down
        st.v[i] = st.v[i] < -0.35 ? -st.v[i] * 0.26 : 0;
      }
      st.sp[i] += st.spv[i] * dt;
      st.spv[i] *= Math.max(0, 1 - dt * 3.2);
      if (smesh) {
        strawScratch.position.set(STRAWS.x[i], STRAW_FLOOR + st.y[i], STRAWS.z[i]);
        strawScratch.rotation.set(0, STRAWS.a[i] + st.sp[i] * 0.5, st.sp[i] * 0.4 + Math.sin(e * 1.7 + i) * 0.02);
        strawScratch.scale.set(STRAWS.s[i], 1, 1);
        strawScratch.updateMatrix();
        smesh.setMatrixAt(i, strawScratch.matrix);
      }
    }
    if (smesh) smesh.instanceMatrix.needsUpdate = true;

    /* ---- dust ---- */
    const b = burst.current;
    if (c.burst > 0) {
      for (let k = 0; k < c.burst; k++) {
        const i = b.cur;
        b.cur = (i + 1) % BURST_N;
        const a = Math.random() * TAU;
        const sp = 0.22 + Math.random() * 0.5;
        b.t0[i] = e;
        b.ox[i] = Math.cos(a) * 0.26;
        b.oy[i] = -0.26;
        b.oz[i] = Math.sin(a) * 0.18;
        b.vx[i] = Math.cos(a) * sp;
        b.vy[i] = 0.5 + Math.random() * 0.75;
        b.vz[i] = Math.sin(a) * sp * 0.6;
      }
      c.burst = 0;
    }
    const mp = motesRef.current;
    if (mp) {
      const pa = mp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = mp.geometry.attributes.color as THREE.BufferAttribute;
      const moteA = phase === "sealed" ? 0.42 : phase === "revealed" ? 0.5 : 0.58;
      for (let i = 0; i < AMB_N; i++) {
        const v = (AMB.ph[i] + e * AMB.sp[i]) % 1;
        pa.setXYZ(
          i,
          AMB.ox[i] + Math.sin(e * 0.6 + AMB.ph[i] * 9) * 0.05,
          -0.24 + v * 0.44,
          AMB.oz[i] + Math.cos(e * 0.45 + AMB.ph[i] * 7) * 0.04,
        );
        const k = Math.sin(v * Math.PI) * (0.4 + 0.3 * Math.sin(e * 1.7 + AMB.ph[i] * 6)) * moteA;
        const kk = Math.max(0, k);
        ca.setXYZ(i, kk, kk * 0.82, kk * 0.56);
      }
      for (let j = 0; j < BURST_N; j++) {
        const i = AMB_N + j;
        const a = e - b.t0[j];
        if (a < 0 || a > BURST_LIFE) {
          ca.setXYZ(i, 0, 0, 0);
          continue;
        }
        pa.setXYZ(i, b.ox[j] + b.vx[j] * a, b.oy[j] + b.vy[j] * a - 1.6 * a * a, b.oz[j] + b.vz[j] * a);
        const k = (1 - a / BURST_LIFE) * 0.95;
        ca.setXYZ(i, k, k * 0.84, k * 0.58);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- the blink. One lid a beat late, which is where the joke lives. ---- */
    c.blinkAt -= dt;
    if (c.blinkAt <= 0) {
      c.blink = 1;
      if (c.dbl > 0) {
        c.dbl = 0;
        c.blinkAt = 2.4 + Math.random() * 3;
      } else if (Math.random() < 0.26) {
        // it does this sometimes, for no reason anyone has established
        c.dbl = 1;
        c.blinkAt = 0.21;
      } else {
        c.blinkAt = 2 + Math.random() * 3.2;
      }
    }
    c.blink = Math.max(0, c.blink - dt * 5.6);
    // Being petted makes it squint; going over the top opens both eyes wide.
    const squint = c.rub * 0.3 * (c.down ? 1 : 0.4);
    const wide = rolling ? Math.exp(-Math.max(0, post - ROLL_LEAD) * 2.2) * 0.5 : 0;
    for (let i = 0; i < 2; i++) {
      const lid = lidRefs.current[i];
      if (!lid) continue;
      // The right eye is ~90ms behind the left. Always. It is not broken.
      const k = clamp01(i === 0 ? c.blink : c.blink - 0.42);
      const base = eyeKind === "sleepy" ? 0.55 + 0.45 * Math.sin(Math.PI * k) : Math.sin(Math.PI * clamp01(k * 2));
      const shut = clamp01(Math.max(base, squint) * (1 - wide));
      lid.scale.y = Math.max(0.001, shut);
      lid.position.y = 0.096 * (1 - shut);
    }
    /* Pupils follow the gaze in every phase; hearts pulse on top of it. */
    for (let i = 0; i < 2; i++) {
      const eye = eyeRefs.current[i];
      const socket = socketRefs.current[i];
      if (socket) socket.scale.setScalar(1 + c.hoverK * 0.07 + wide * 0.2 + (eyeKind === "heart" ? Math.sin(e * 3.4 + i) * 0.05 * (0.4 + c.rub) : 0));
      if (!eye) continue;
      // Sleepy eyes get there eventually. That is what makes them sleepy.
      const rate = Math.min(1, dt * (eyeKind === "sleepy" ? 1.8 : 6));
      eye.rotation.y = lerp(eye.rotation.y, gazeX * 0.5, rate);
      eye.rotation.x = lerp(eye.rotation.x, -gazeY * 0.4, rate);
    }

    /* ---- the belly, once there is a belly to look at ---- */
    if (bellyMatRef.current) bellyMatRef.current.opacity = phase === "preview" ? 0 : clamp01((roll - 0.55) / 0.35);
    if (bellyRef.current) {
      // the marker settles onto the stone rather than dissolving through it
      const k = rolling ? clamp01((post - 0.85) / 0.45) : 0;
      bellyRef.current.scale.setScalar(rolling ? lerp(0.84, 1, easeOutBack(k)) : 0.84);
    }

    /* ---- the papers, arriving on a draught ---- */
    if (certRef.current && certMatRef.current) {
      const k = phase === "preview" || !rolling ? 0 : clamp01((post - PAPERS_AT) / PAPERS_DUR);
      const cg = certRef.current;
      cg.visible = k > 0.001;
      const eK = easeOutCubic(k);
      // Paper does not slide, it flutters: a decaying flap on two axes, forced to
      // exactly zero at k = 1 so the settled pose is a clean static frame.
      const flap = k > 0 ? Math.exp(-k * 2.6) * (1 - k) : 0;
      cg.position.set(lerp(2.15, 0.98, eK), lerp(-0.72, -0.42, eK) + Math.sin(Math.PI * k) * 0.26, lerp(0.9, 0.5, eK));
      cg.rotation.set(
        lerp(-0.45, -1.1, eK) + flap * Math.sin(k * 34) * 0.5,
        flap * Math.sin(k * 27 + 1.1) * 0.9,
        lerp(-0.85, -0.14, eK) + flap * Math.sin(k * 41 + 2.2) * 0.6 + Math.sin(e * 0.8) * 0.006 * eK,
      );
      // it arrives as an object, not as a fade — opaque almost immediately
      certMatRef.current.opacity = clamp01(k / 0.14);
      if (rolling && !c.papered && k >= 1) {
        c.papered = true;
        if (opening) clack({ freq: 1400, decay: 0.08, gain: 0.13 });
      }
    }

    /* ---- the lid, off in every phase but sealed ---- */
    if (lidTop.current) {
      const shut = phase === "sealed" ? 1 : 0;
      const l = lidTop.current;
      l.rotation.x = lerp(l.rotation.x, lerp(-2.1, 0, shut), Math.min(1, dt * 3)) + Math.sin(e * 0.9) * 0.006;
      l.position.y = lerp(l.position.y, lerp(0.42, 0.3, shut), Math.min(1, dt * 3));
    }

    /* ---- the glint: the thing that says touch me, until you do ---- */
    if (glintRef.current && glintMatRef.current) {
      // sealed pulses, preview shows off, revealed keeps a contented sheen, and the
      // opening one dies the instant a finger lands: the invitation has been taken.
      // …and it dies just as fast when the invisible hand takes over, because an
      // invitation that outlives the thing it was inviting burns through the whole
      // auto-reveal with a "touch me" still glowing on it.
      const asked = clamp01((t - 0.6) / 0.8) * (1 - clamp01((c.alone - MERCY0) / 1));
      const invite = opening ? (c.touched ? 0 : asked) : phase === "sealed" ? 0.55 : phase === "preview" ? 0.7 : 0.22;
      glintRef.current.position.x = Math.sin(e * 1.5) * 0.34;
      glintRef.current.position.y = 0.06 + Math.cos(e * 1.5) * 0.05;
      glintMatRef.current.opacity = invite * (0.26 + 0.14 * Math.sin(e * 2.6)) + c.hoverK * 0.12;
    }

    /* ---- light. The reveal warms the whole box; the key never sits perfectly still. ---- */
    if (keyRef.current) keyRef.current.intensity = (1.5 + reveal * 0.5) * (1 + Math.sin(e * 2.3) * 0.02 + Math.sin(e * 7.1) * 0.008);
    if (warmRef.current) warmRef.current.intensity = reveal * 1.5 * (1 + Math.sin(e * 1.9) * 0.05);

    /* ---- camera: a small push-in on the reveal, and a drift that never stops ---- */
    const cam = camRef.current;
    if (cam) {
      const shk = land > 0 && land < 0.4 ? Math.exp(-land * 9) * Math.sin(land * 44) * 0.014 : 0;
      cam.position.set(
        Math.sin(e * 0.23) * 0.028,
        lerp(0.35, 0.27, reveal) + Math.sin(e * 0.31) * 0.012 + shk,
        lerp(2.5, 2.2, reveal),
      );
      cam.lookAt(0, lerp(-0.06, -0.12, reveal), 0);
    }

    if (opening && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, 0.35, 2.5]} fov={42} onUpdate={(c) => c.lookAt(0, -0.06, 0)} />
      <ambientLight intensity={0.55} />
      <directionalLight ref={keyRef} position={[1.6, 2.4, 2.2]} intensity={1.5} color="#fff4e2" />
      <pointLight position={[-1.6, 0.4, 1.4]} intensity={0.5} color="#cfe0ff" />
      {/* comes up only on the reveal, low and warm, so the belly is the lit thing */}
      <pointLight ref={warmRef} position={[0, -0.1, 1.1]} intensity={0} color="#ffcf94" distance={4} decay={1.6} />

      <mesh position={[0, 0, -2]}>
        <planeGeometry args={[14, 10]} />
        <meshBasicMaterial color="#221b16" depthWrite={false} />
      </mesh>
      {/* the table */}
      <mesh position={[0, -0.62, 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[9, 5]} />
        <meshStandardMaterial color="#4a382a" roughness={0.85} />
      </mesh>

      <group ref={fitRef}>
        {/* the box */}
        <group ref={boxRef} position={[0, -0.3, 0]}>
          {BOX_WALLS.map(([x, y, z, ry], i) => (
            <mesh key={i} position={[x, y + 0.16, z]} rotation={[0, ry, 0]}>
              <planeGeometry args={[1.24, 0.62]} />
              <meshStandardMaterial map={CARDBOARD} roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
          ))}
          {/* the front wall, cut low so we can see in */}
          <mesh position={[0, -0.02, 0.42]}>
            <planeGeometry args={[1.24, 0.3]} />
            <meshStandardMaterial map={CARDBOARD} roughness={0.9} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, -0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.24, 0.84]} />
            <meshStandardMaterial map={STRAW_TEX} roughness={0.95} />
          </mesh>
          {/* the loose pieces on top of the bedding — one draw call, thirty-four straws */}
          <instancedMesh ref={strawRef} args={[strawGeo, undefined, STRAW_N]} frustumCulled={false}>
            <meshStandardMaterial roughness={0.92} />
          </instancedMesh>
          {/* the lid, hinged at the back */}
          <group ref={lidTop} position={[0, 0.3, -0.42]}>
            <mesh position={[0, 0, 0.42]}>
              <planeGeometry args={[1.24, 0.84]} />
              <meshStandardMaterial map={CARDBOARD} roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>

        {/* dust in the box: a few specks always, a puff whenever it moves */}
        <points ref={motesRef} position={[0, -0.18, 0.05]} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[moteBuf.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[moteBuf.col, 3]} />
          </bufferGeometry>
          <pointsMaterial map={glowTex} vertexColors size={0.03} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} />
        </points>

        {/* the rock. It is looking at you. */}
        <group ref={wobbleRef} position={[0, -0.14, 0.05]}>
          <group ref={rollRef}>
            <mesh geometry={rockGeo}>
              <meshStandardMaterial map={speckle} roughness={rock.rough} metalness={rock.metal} />
            </mesh>

            {/* eyes: glued on, slightly crooked, the way they always are */}
            {EYE_AT.map((p, i) => (
              <group
                key={i}
                position={p}
                ref={(el) => {
                  socketRefs.current[i] = el;
                }}
              >
                <mesh geometry={eyeGeo}>
                  <meshStandardMaterial color="#fbfbf8" roughness={0.28} />
                </mesh>
                <group
                  ref={(el) => {
                    eyeRefs.current[i] = el;
                  }}
                >
                  {eyeKind === "heart" ? (
                    <mesh geometry={heartShape} position={[0, 0, 0.086]}>
                      <meshBasicMaterial color="#d63a5a" side={THREE.DoubleSide} />
                    </mesh>
                  ) : (
                    <mesh geometry={pupilGeo} position={[0, 0, 0.062]}>
                      <meshStandardMaterial color="#15161c" roughness={0.3} />
                    </mesh>
                  )}
                </group>
                {/* The lid, scaled down from the top. It has to clear the pupil's
                    bulge (0.104) or a shut eye draws the pupil through its own lid —
                    and `sleepy` never opens past 45%, so that dot would never leave. */}
                <mesh
                  ref={(m) => {
                    lidRefs.current[i] = m;
                  }}
                  geometry={lidGeo}
                  position={[0, 0, 0.108]}
                >
                  <meshStandardMaterial color={rock.base} roughness={rock.rough} side={THREE.DoubleSide} />
                </mesh>
              </group>
            ))}

            {/* the belly. In marker. */}
            <group ref={bellyRef} position={[0, -0.47, 0.01]} rotation={[Math.PI / 2, 0, 0]}>
              <mesh>
                <planeGeometry args={belly.size} />
                <meshBasicMaterial ref={bellyMatRef} map={belly.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
              </mesh>
            </group>
          </group>
        </group>

        {/* a light sliding over the stone, until they take the hint */}
        <sprite ref={glintRef} position={[0, -0.08, 0.62]} scale={0.5}>
          <spriteMaterial ref={glintMatRef} map={glowTex} color="#fff2d8" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>

        {/* Certificate of Adoption, in both names */}
        <group ref={certRef} position={[2.15, -0.72, 0.9]} rotation={[-0.45, 0, -0.85]} visible={false}>
          <mesh>
            <planeGeometry args={[0.78, 0.56]} />
            <meshBasicMaterial ref={certMatRef} map={cert} transparent opacity={0} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      </group>

      {phase === "opening" && (
        <>
          {/* nearer than the drag plane and handler-free apart from hover, so the
              pointer still reaches the plane behind it and the drag is unbroken */}
          <mesh position={[0, -0.12, 1.05]} onPointerOver={onOver} onPointerOut={onOut}>
            <planeGeometry args={[1.15, 0.95]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <mesh position={[0, 0, 0.9]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
            <planeGeometry args={[9, 7]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </>
      )}
    </>
  );
}
