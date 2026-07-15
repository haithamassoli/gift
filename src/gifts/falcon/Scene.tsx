import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { pick } from "../catalog";
import { forRecipient } from "../../i18n";

/* ---------- plumage ---------- */
// A falcon's identity is its markings, not a tint: the shaheen is slate over a
// barred cream breast with a dark hood; the saker is warm desert brown with a
// pale crown; the white gyr is near-albino with grey-flecked primaries. Change
// `back`/`head`/`primary` and the same low-poly bird reads as a different raptor.
interface Plumage {
  back: string; // mantle and the upper wing
  belly: string; // the breast and underparts
  head: string; // the crown / hood
  primary: string; // the dark wingtips — a falcon's most legible feature in flight
  beak: string;
  cere: string; // the waxy skin at the beak's base
}
const PLUMAGES: Record<string, Plumage> = {
  shaheen: {
    back: "#4b4e57", belly: "#e6dcc2", head: "#34353d",
    primary: "#26272d", beak: "#2b2b30", cere: "#e6c24a",
  },
  saker: {
    back: "#6f5a3e", belly: "#e4d6b4", head: "#c3b28e",
    primary: "#463823", beak: "#3a352c", cere: "#a9c0d0",
  },
  "white-gyr": {
    back: "#d8dade", belly: "#f2f2ec", head: "#dfe0e4",
    primary: "#99a0a8", beak: "#484d55", cere: "#d6b64a",
  },
};

/* ---------- the desert hour ---------- */
// The light is the whole mood. dusk burns orange under a violet sky and lays warm
// sand; dawn is cool gold; moonlit is deep blue lit by a silver key. The sky, the
// sun/moon disc, the sand and the three lights are all cut from this one record so
// the falcon, the glove and the dunes always sit in the same air.
interface Hour {
  skyTop: string;
  skyHorizon: string;
  ground: string; // below the horizon band, mostly hidden by the dunes
  sand: string;
  sandFar: string;
  disc: string; // the sun or the moon
  discPos: [number, number, number];
  discR: number;
  ambient: string;
  ambientI: number;
  key: string; // the low sun/moon as a directional light
  keyI: number;
  fill: string;
  fillI: number;
  shimmer: number; // heat haze strength — real at dusk, almost none by moonlight
}
const HOURS: Record<string, Hour> = {
  dusk: {
    skyTop: "#241a38", skyHorizon: "#ef8a44", ground: "#5a3320",
    sand: "#c88a54", sandFar: "#9a6238", disc: "#ffcf88", discPos: [-3.6, 0.1, -13],
    discR: 1.5, ambient: "#4a3550", ambientI: 0.5, key: "#ffb268", keyI: 1.55,
    fill: "#b56a8a", fillI: 0.4, shimmer: 1,
  },
  dawn: {
    skyTop: "#2c3360", skyHorizon: "#f2cf94", ground: "#6a5238",
    sand: "#d7b389", sandFar: "#a3855e", disc: "#fff0cc", discPos: [3.2, 0.4, -13],
    discR: 1.3, ambient: "#565a7c", ambientI: 0.55, key: "#ffe6bc", keyI: 1.4,
    fill: "#9aa6d0", fillI: 0.4, shimmer: 0.55,
  },
  moonlit: {
    skyTop: "#050a1a", skyHorizon: "#324a76", ground: "#1a2740",
    sand: "#6c7c96", sandFar: "#3d4c66", disc: "#e8eeff", discPos: [3.0, 3.1, -12.5],
    discR: 0.9, ambient: "#243050", ambientI: 0.62, key: "#b9c8ee", keyI: 0.95,
    fill: "#3a4e78", fillI: 0.5, shimmer: 0.18,
  },
};

/* ---------- stage geography (world units) ---------- */
const FOV = 42;
const HALF_TAN = Math.tan((FOV * Math.PI) / 360);
// what the resting tableau has to hold: the gauntlet, the perched falcon above it
// and the unrolled scroll in front. The camera pulls back off these to fit a phone.
const ACTION_W = 2.6;
const ACTION_H = 2.9;

// the falcon's seat on the fist, and the pose she holds there — a three-quarter
// lean toward the lens (nose is −Z on the model, so this is the direction −Z faces)
const PERCH = new THREE.Vector3(0, -0.3, 0.55);
const PERCH_DIR = new THREE.Vector3(-0.5, 0.16, 0.85).normalize();
const GLOVE = new THREE.Vector3(0, -0.72, 0.5);
const LOOK_HOME = new THREE.Vector3(0.04, -0.42, 0.58);
const HOME_DIR = new THREE.Vector3(0, 0.12, 1).normalize(); // camera sits off the look point along this

// where the scroll unrolls: between the glove and the lens, square to the camera
const SCROLL_AT = new THREE.Vector3(0.16, -0.5, 1.06);

/* ---------- the flight ---------- */
// Outbound: she rows up off the fist and banks out over the dunes to a high
// holding point, deep in −Z. A CatmullRom sweep, sampled by arc length so the
// speed reads even through the corners.
const OUT_CURVE = new THREE.CatmullRomCurve3(
  [
    PERCH.clone(),
    new THREE.Vector3(-0.9, 0.7, -0.6),
    new THREE.Vector3(-2.6, 1.7, -3.2),
    new THREE.Vector3(-1.2, 2.3, -6.0),
    new THREE.Vector3(1.8, 2.0, -8.2),
  ],
  false,
  "centripetal",
  0.5,
);
// the holding pattern she flies while waiting to be called home
const HOLD_C = new THREE.Vector3(0.2, 2.1, -7.8);
const HOLD_R = 2.6;
const HOLD_W = 0.7; // rad/s — a slow, patient circle
const APPROACH = new THREE.Vector3(0.3, 1.2, 2.0); // high in front of the viewer on the way back
const FLARE_POS = new THREE.Vector3(0.1, 0.16, 1.05); // where she throws the brakes, just off the fist

/* ---------- opening timeline (seconds) ---------- */
// A gift may never outlast 12s untouched, and the bound is on onOpenComplete —
// so the no-input worst case is the whole budget:
//   CAST_MERCY + CAST_DUR + HOLD_MERCY + RETURN_DUR + FLARE_DUR + SCROLL_DUR + SETTLE
//   = 2.0 + 2.4 + 1.4 + 2.2 + 0.75 + 1.5 + 0.3 = 10.55s.
// The rest of the 12 is slack: dt clamps to 0.05, so on a phone that drops frames
// this clock runs behind the wall clock the bound is actually measured on.
const CAST_MERCY = 2.0; // if she is never cast, she leaves on her own
const CAST_DUR = 2.4; // the outbound flight
const HOLD_MERCY = 1.4; // time circling before she turns for home unbidden
const HOLD_FILL = 1.05; // press-and-hold seconds to fill the recall meter
const RETURN_DUR = 2.2; // the flight back
const FLARE_DUR = 0.75; // flare, wing-thump, touchdown
const SCROLL_DUR = 1.5; // the jess-scroll unrolling into the message
const SETTLE = 0.3;

const FLAP_HZ = 6.6; // wingbeats: ~1.05Hz, a falcon's cruising cadence
const DIHEDRAL = 0.12; // the shallow V a soaring raptor holds its wings in
const BANK_MAX = 0.85; // hardest roll into a turn
const BANK_K = 0.22; // roll per unit of turn rate

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();

/* ---------- geometry (variant-independent, built once) ---------- */
// Scale a geometry's vertices in place and re-derive normals — so a stretched body
// still lights correctly, which a non-uniform mesh scale would not.
function scaled(geo: THREE.BufferGeometry, sx: number, sy: number, sz: number) {
  geo.scale(sx, sy, sz);
  geo.computeVertexNormals();
  return geo;
}
// body: a tapered ellipsoid, long in −Z (the nose), the falcon's whole low-poly mass
const bodyGeo = scaled(new THREE.SphereGeometry(0.16, 20, 14), 1, 1, 1.9);
const headGeo = new THREE.SphereGeometry(0.11, 18, 14);
const beakGeo = new THREE.ConeGeometry(0.032, 0.1, 10); // apex −Z once tipped down
const eyeGeo = new THREE.SphereGeometry(0.024, 10, 8);
const legGeo = new THREE.CylinderGeometry(0.013, 0.011, 0.16, 7);
const footGeo = new THREE.SphereGeometry(0.02, 8, 6);
const furlGeo = new THREE.CylinderGeometry(0.026, 0.026, 0.14, 12); // the rolled scroll on the jess

// A wing is two flat triangle fans in the bird's own frame: the inner membrane in
// `back` colour and a swept `primary` tip. Built per side (dir = ±1) so no negative
// mesh scale ever flips a normal — the flap is a clean rotation about the shoulder.
function buildWing(dir: number) {
  const P = (x: number, y: number, z: number) => [dir * x, y, z];
  const inner = [
    ...P(0.03, 0, -0.08), ...P(0.03, 0, 0.17), ...P(0.4, 0.015, -0.17),
    ...P(0.38, 0, 0.11), ...P(0.8, 0, -0.02),
  ];
  const wing = new THREE.BufferGeometry();
  wing.setAttribute("position", new THREE.Float32BufferAttribute(inner, 3));
  wing.setIndex(dir > 0 ? [0, 1, 3, 0, 3, 2, 2, 3, 4] : [0, 3, 1, 0, 2, 3, 2, 4, 3]);
  wing.computeVertexNormals();
  const tipV = [...P(0.72, 0, -0.06), ...P(0.7, 0, 0.08), ...P(1.02, 0, 0.0)];
  const tip = new THREE.BufferGeometry();
  tip.setAttribute("position", new THREE.Float32BufferAttribute(tipV, 3));
  tip.setIndex(dir > 0 ? [0, 1, 2] : [0, 2, 1]);
  tip.computeVertexNormals();
  return { wing, tip };
}
const wingR = buildWing(1);
const wingL = buildWing(-1);

// tail: a tapered fan trailing from the body, spread on the flare
function buildTailGeo() {
  const v = [0, 0, 0.12, -0.15, 0, 0.62, 0.15, 0, 0.62, 0, -0.01, 0.66];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setIndex([0, 1, 3, 0, 3, 2]);
  g.computeVertexNormals();
  return g;
}
const tailGeo = buildTailGeo();

// the hood: a little leather cap with a topknot plume, worn until she is cast
const hoodGeo = scaled(new THREE.SphereGeometry(0.115, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), 1, 1, 1.05);
const plumeGeo = new THREE.ConeGeometry(0.02, 0.08, 8);

// the gauntlet: a tooled cuff (truncated cone) under a rounded fist the bird grips
const cuffGeo = new THREE.CylinderGeometry(0.34, 0.28, 0.46, 24, 1, true);
const fistGeo = scaled(new THREE.SphereGeometry(0.24, 18, 14), 1.15, 0.82, 1.1);

// dunes: three billboard ridges at receding depths. Each is a ribbon whose top edge
// rolls on summed sines; the camera looks −Z through the flight, so a flat facing
// ridge is all the desert this stylized piece needs.
function buildDuneGeo(seed: number, span: number, floorY: number, crestY: number, amp: number) {
  const rand = mulberry32(seed);
  const cols = 40;
  const a = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const x = -span / 2 + (span * i) / cols;
    const u = (i / cols) * Math.PI * 2;
    const crest =
      crestY + amp * (0.6 * Math.sin(u * 1.3 + a[0]) + 0.3 * Math.sin(u * 2.7 + a[1]) + 0.1 * Math.sin(u * 5.1 + a[2]));
    pos.push(x, floorY, 0, x, crest, 0);
    if (i < cols) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const duneNear = buildDuneGeo(101, 34, -6, -1.55, 0.55);
const duneMid = buildDuneGeo(207, 40, -6, -2.1, 0.7);
const duneFar = buildDuneGeo(311, 52, -6, -2.6, 0.9);

// the hold-meter over the glove, and its guide ring
const ringGeo = new THREE.RingGeometry(0.3, 0.36, 40);
const meterGeo = new THREE.CircleGeometry(0.28, 32);

/* ---------- sky ---------- */
function makeSkyTexture(top: string, horizon: string, ground: string) {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top); // maps to the top of the sphere (flipY)
  grad.addColorStop(0.46, top);
  grad.addColorStop(0.52, horizon); // the bright band the sun sits on
  grad.addColorStop(0.56, ground);
  grad.addColorStop(1, ground);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- module temporaries (never allocate in useFrame) ---------- */
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDesired = new THREE.Vector3();

/** Point a group's nose (−Z) along `dir` from `pos`, then bank by `roll`. */
function faceAlong(obj: THREE.Object3D, pos: THREE.Vector3, dir: THREE.Vector3, roll: number) {
  obj.position.copy(pos);
  obj.up.set(0, 1, 0);
  _tgt.copy(pos).add(dir);
  obj.lookAt(_tgt);
  obj.rotateZ(roll);
}

function setWing(
  g: THREE.Object3D | null,
  sign: number,
  fold: number,
  flap: number,
  cup: number,
) {
  if (!g) return;
  // spread: dihedral V plus the wingbeat; folded: tucked up and swept back
  const zSpread = sign * (DIHEDRAL + flap);
  const ySpread = -sign * 0.03;
  const zFold = sign * 1.15;
  const yFold = -sign * 0.5;
  g.rotation.z = lerp(zSpread, zFold, fold);
  g.rotation.y = lerp(ySpread, yFold, fold);
  g.rotation.x = cup; // leading edge lifts as she brakes into the flare
}

export default function FalconScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const plume = PLUMAGES[variants.falcon] ?? PLUMAGES.shaheen;
  const hour = HOURS[variants.hour] ?? HOURS.dusk;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" on the gallery card and arrives per-keystroke from /create, so
  // the scroll always has copy: the shared "For you" line when there is no message.
  const scrollText = message.trim() || forRecipient(lang, recipientName);
  const scroll = useMemo(() => {
    const { texture, aspect } = makeTextTexture(scrollText, {
      fontSize: 46, fontWeight: "400", color: "#4a3320", maxWidthPx: 620,
      lineHeight: 1.5, padding: 40, lang,
    });
    // a long message wraps tall — trade the scroll's width for height rather than overflow
    let w = 1.5;
    if (aspect * w > 1.05) w = 1.05 / aspect;
    return { texture, w, h: w * aspect };
  }, [scrollText, lang]);
  useEffect(() => () => scroll.texture.dispose(), [scroll]);

  // Names tooled into the cuff leather. In preview the names are placeholders and the
  // message is empty, so the card shows the "For you" line instead; everywhere else it
  // carries both people, which is the keepsake the brief asks the reveal to hold.
  const toolText =
    phase === "preview"
      ? forRecipient(lang, recipientName)
      : (() => {
          const you = recipientName.trim();
          const me = senderName.trim();
          if (!you && !me) return forRecipient(lang, recipientName);
          if (!me) return you;
          if (!you) return me;
          return pick(lang, `${me}  ·  ${you}`, `${you}  ·  ${me}`);
        })();
  const tool = useMemo(
    () =>
      makeTextTexture(toolText, {
        fontSize: 40, fontWeight: "600", color: "#e9c877", maxWidthPx: 520, padding: 26, lang,
      }),
    [toolText, lang],
  );
  useEffect(() => () => tool.texture.dispose(), [tool]);

  const sky = useMemo(() => makeSkyTexture(hour.skyTop, hour.skyHorizon, hour.ground), [hour]);
  useEffect(() => () => sky.dispose(), [sky]);

  // Every lit material the falcon, glove and desert wear — built from the two variants,
  // owned and disposed here. Reached in the frame only through the meshes that carry
  // them, never through this binding.
  const mat = useMemo(() => {
    const std = (color: string, rough: number) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, side: THREE.DoubleSide });
    const m = {
      back: std(plume.back, 0.7),
      belly: std(plume.belly, 0.72),
      head: std(plume.head, 0.68),
      primary: std(plume.primary, 0.66),
      beak: new THREE.MeshStandardMaterial({ color: plume.beak, roughness: 0.35, metalness: 0.1 }),
      cere: new THREE.MeshStandardMaterial({ color: plume.cere, roughness: 0.5 }),
      eye: new THREE.MeshStandardMaterial({ color: "#0a0a0c", roughness: 0.15, metalness: 0.2 }),
      hood: new THREE.MeshStandardMaterial({
        color: "#6a3d22", roughness: 0.6, metalness: 0.1, transparent: true, side: THREE.DoubleSide,
      }),
      leather: new THREE.MeshStandardMaterial({ color: "#7a4a28", roughness: 0.82, metalness: 0.05 }),
      leatherDark: new THREE.MeshStandardMaterial({ color: "#5c3720", roughness: 0.85 }),
      sand: new THREE.MeshStandardMaterial({ color: hour.sand, roughness: 0.95, side: THREE.DoubleSide }),
      sandMid: new THREE.MeshStandardMaterial({ color: hour.sand, roughness: 0.96, side: THREE.DoubleSide }),
      sandFar: new THREE.MeshStandardMaterial({ color: hour.sandFar, roughness: 0.97, side: THREE.DoubleSide }),
    };
    const list = Object.values(m) as THREE.Material[];
    return { ...m, list };
  }, [plume, hour]);
  useEffect(() => () => mat.list.forEach((x) => x.dispose()), [mat]);

  /* ---------- refs ---------- */
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const birdRef = useRef<THREE.Group>(null); // world transform: position, heading, bank
  const bobRef = useRef<THREE.Group>(null); // scale + breathing/thrust bob
  const headRef = useRef<THREE.Group>(null);
  const wingLRef = useRef<THREE.Group>(null);
  const wingRRef = useRef<THREE.Group>(null);
  const tailRef = useRef<THREE.Group>(null);
  const legsRef = useRef<THREE.Group>(null);
  const hoodRef = useRef<THREE.Group>(null);
  const hoodMeshRef = useRef<THREE.Mesh>(null);
  const furlRef = useRef<THREE.Group>(null);
  const furlMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const scrollRef = useRef<THREE.Group>(null);
  const scrollInkRef = useRef<THREE.MeshBasicMaterial>(null);
  const scrollPaperRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const meterRef = useRef<THREE.Mesh>(null);
  const meterMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shimmerRef = useRef<THREE.Group>(null);
  const discRef = useRef<THREE.Sprite>(null);
  const birdHitRef = useRef<THREE.Mesh>(null);
  const gloveHitRef = useRef<THREE.Mesh>(null);

  // opening state — plain mutable refs, restart with the clock on a replay
  const st = useRef({
    castAt: -1, // opening-clock time she was released (swipe or mercy)
    swDown: false,
    swY0: 0, // swipe start, in world Y
    holdDown: false,
    meter: 0, // recall press-and-hold, 0..1
    recallAt: -1,
    heading: 0, // last flight heading, for banking
    roll: 0,
    flap: 0, // accumulated wingbeat phase
    lastDir: PERCH_DIR.clone(),
  });
  const returnCurveRef = useRef<THREE.CatmullRomCurve3 | null>(null);

  useLayoutEffect(() => {
    const s = st.current;
    s.castAt = -1;
    s.swDown = false;
    s.holdDown = false;
    s.meter = 0;
    s.recallAt = -1;
    s.roll = 0;
    s.flap = 0;
    s.lastDir.copy(PERCH_DIR);
    returnCurveRef.current = null;
    // start framed on the glove, so the very first frame of any phase already reads
    _camPos.copy(LOOK_HOME).addScaledVector(HOME_DIR, 4.2);
  }, [phase]);

  const fireRecall = (tNow: number) => {
    const s = st.current;
    if (s.recallAt >= 0) return;
    s.recallAt = tNow;
    // build the way home from wherever she happens to be circling — a JS curve, once,
    // not a GPU resource; the return is a scripted rig, like the outbound sweep
    returnCurveRef.current = new THREE.CatmullRomCurve3(
      [
        _pos.clone(), // her position this frame (set below before recall can fire)
        new THREE.Vector3(_pos.x * 0.3, 2.4, _pos.z * 0.35 + 1.0),
        APPROACH.clone(),
        FLARE_POS.clone(),
      ],
      false,
      "centripetal",
      0.5,
    );
  };

  /* ---------- gestures ---------- */
  // Cast: a swipe up-and-out on the falcon flings her to the wind. Forgiving — an
  // upward drag past the threshold releases her mid-gesture, and a plain tap-release
  // casts too, so nobody is stranded hunting for the motion.
  const onBirdDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || st.current.castAt >= 0) return;
    st.current.swDown = true;
    st.current.swY0 = ev.point.y;
  };
  const onBirdMove = (ev: ThreeEvent<PointerEvent>) => {
    const s = st.current;
    if (!s.swDown || phase !== "opening" || s.castAt >= 0) return;
    ev.stopPropagation();
    if (ev.point.y - s.swY0 > 0.28) s.castAt = tRef.current; // she leaps as the hand lifts
  };
  const onBirdUp = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const s = st.current;
    if (s.swDown && phase === "opening" && s.castAt < 0) s.castAt = tRef.current;
    s.swDown = false;
  };

  // Recall: press and hold the glove and she reads the call, turns, and comes home.
  const onGloveDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety; the pointer-out fallback covers its absence */
    }
    st.current.holdDown = true;
  };
  const releaseGlove = () => {
    st.current.holdDown = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const s = st.current;

    /* ---------- responsive framing: pull the lens back to fit the tableau ---------- */
    const aspect = state.size.width / Math.max(1, state.size.height);
    const needH = ACTION_H / 2 / HALF_TAN;
    const needW = ACTION_W / 2 / (HALF_TAN * aspect);
    const homeDist = Math.max(needH, needW) + 0.3;
    _camDesired.copy(LOOK_HOME).addScaledVector(HOME_DIR, homeDist);

    /* ---------- decide the stage and where the falcon is ---------- */
    // Defaults: the resting, perched pose (preview / sealed / pre-cast / landed / revealed).
    let fold = 1; // wings tucked
    let flapAmp = 0;
    let cup = 0;
    let bodyBob = 0;
    let chase = 0; // 0 = frame the glove, 1 = chase the bird
    let hoodOn = 1; // 1 = worn, 0 = off
    let scrollOpen = 0; // 0 = furled on the jess, 1 = unrolled message
    let hintKind = 0; // 0 none, 1 swipe-to-cast, 2 hold-to-recall
    let landed = false;

    // idle life for the resting pose
    _pos.copy(PERCH);
    _pos.y += 0.012 * Math.sin(e * 1.4);
    _dir.copy(PERCH_DIR);

    if (phase === "revealed") {
      hoodOn = 0;
      scrollOpen = 1;
      landed = true;
    } else if (phase === "opening") {
      // cast mercy: if she is never thrown, she takes the wind herself
      if (s.castAt < 0 && t > CAST_MERCY) s.castAt = t;
      hintKind = s.castAt < 0 ? 1 : 0;

      if (s.castAt >= 0) {
        const ft = t - s.castAt;
        hoodOn = 1 - clamp01(ft / 0.45); // the falconer slips the hood as she goes

        if (ft < CAST_DUR) {
          /* ---- outbound: rowing hard, then settling to a banked glide ---- */
          const u = easeInOut(clamp01(ft / CAST_DUR));
          OUT_CURVE.getPointAt(u, _pos);
          OUT_CURVE.getTangentAt(u, _dir);
          fold = 1 - clamp01(ft / 0.3); // wings open the instant she leaves the fist
          // two hard downstrokes to get airborne, then she rides it out
          flapAmp = 0.85 * (1 - smooth(clamp01((ft - 0.2) / 1.5))) + 0.12;
          chase = 1;
        } else if (s.recallAt < 0) {
          /* ---- holding pattern: a patient circle, waiting to be called ---- */
          const ht = ft - CAST_DUR;
          const ang = ht * HOLD_W;
          _pos.set(
            HOLD_C.x + Math.cos(ang) * HOLD_R,
            HOLD_C.y + 0.15 * Math.sin(ht * 1.3),
            HOLD_C.z + Math.sin(ang) * HOLD_R * 0.6,
          );
          // tangent of the circle, for heading
          _dir.set(-Math.sin(ang) * HOLD_R, 0.02, Math.cos(ang) * HOLD_R * 0.6).normalize();
          fold = 0;
          flapAmp = 0.12 + 0.5 * Math.pow(Math.max(0, Math.sin(ht * 1.9)), 6); // an occasional flap
          chase = 1;
          hintKind = 2;

          // recall meter — press-and-hold, decays when let go
          if (s.holdDown) s.meter = clamp01(s.meter + dt / HOLD_FILL);
          else s.meter = clamp01(s.meter - dt / (HOLD_FILL * 0.8));
          // she comes when the meter fills, or when patience runs out
          if (s.meter >= 1 || ht > HOLD_MERCY) fireRecall(t);
        }

        if (s.recallAt >= 0) {
          const rt = t - s.recallAt;
          const rc = returnCurveRef.current;
          if (rt < RETURN_DUR && rc) {
            /* ---- the flight home ---- */
            const u = easeInOut(clamp01(rt / RETURN_DUR));
            rc.getPointAt(u, _pos);
            rc.getTangentAt(u, _dir);
            fold = 0;
            flapAmp = 0.75 * (1 - smooth(clamp01((rt - RETURN_DUR + 0.9) / 0.9))) + 0.1;
            chase = 1 - easeInOut(clamp01((rt - (RETURN_DUR - 0.6)) / 0.6)); // hand the frame back to the glove
          } else {
            /* ---- flare, wing-thump, touchdown ---- */
            const fk = clamp01((rt - RETURN_DUR) / FLARE_DUR);
            _pos.copy(FLARE_POS).lerp(PERCH, easeOutCubic(fk));
            _pos.y += 0.35 * Math.sin(fk * Math.PI) * (1 - fk); // she rises to brake, then settles
            _dir.copy(s.lastDir).lerp(PERCH_DIR, easeInOut(fk)).normalize();
            fold = smooth(clamp01((fk - 0.55) / 0.45)); // wings held wide, then fold once down
            cup = -0.35 * Math.sin(fk * Math.PI) * (1 - fold); // leading edge up: braking
            // the wing-thump — one big downstroke at ~60% of the flare
            flapAmp = 1.15 * Math.max(0, Math.sin(clamp01(fk / 0.6) * Math.PI)) * (1 - fold);
            bodyBob = -0.05 * smooth(clamp01((fk - 0.7) / 0.3)); // the weight coming down
            chase = 0;
            if (fk >= 1) landed = true;
          }
        }
      }

      // scroll unrolls once she is home and offering the jess
      if (landed) {
        const landAt = s.recallAt + RETURN_DUR + FLARE_DUR;
        scrollOpen = clamp01((t - landAt) / SCROLL_DUR);
        hoodOn = 0;
        if (t > landAt + SCROLL_DUR + SETTLE && !doneRef.current) {
          doneRef.current = true;
          onOpenComplete?.();
        }
      }
    }
    // preview & sealed fall through with the resting pose; sealed invites the swipe
    if (phase === "sealed") hintKind = 1;

    /* ---------- banking: roll into the turn ---------- */
    let roll: number;
    if (chase > 0.001) {
      const heading = Math.atan2(_dir.x, _dir.z);
      let dh = heading - s.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      s.heading = heading;
      const target = THREE.MathUtils.clamp((-dh / Math.max(dt, 1e-3)) * BANK_K, -BANK_MAX, BANK_MAX);
      s.roll += (target - s.roll) * Math.min(1, dt * 4);
      roll = s.roll;
      s.lastDir.copy(_dir);
    } else {
      s.heading = Math.atan2(_dir.x, _dir.z);
      s.roll += (0 - s.roll) * Math.min(1, dt * 4);
      roll = s.roll * (1 - chase);
    }

    /* ---------- pose the falcon ---------- */
    if (birdRef.current) faceAlong(birdRef.current, _pos, _dir, roll);
    // wingbeat: advance the phase, size the amplitude by the stage
    s.flap += dt * FLAP_HZ * (flapAmp > 0.02 ? 1 : 0.15);
    const wave = Math.sin(s.flap) * flapAmp;
    setWing(wingLRef.current, -1, fold, wave, cup);
    setWing(wingRRef.current, 1, fold, wave, cup);
    if (bobRef.current) {
      // body rises on the downstroke (wave < 0) and breathes at rest
      bobRef.current.position.y = -wave * 0.045 + bodyBob + (fold > 0.5 ? 0.006 * Math.sin(e * 1.6) : 0);
    }
    if (tailRef.current) {
      tailRef.current.scale.x = lerp(1, 1.6, clamp01(-cup / 0.35)); // fans wide while braking
      tailRef.current.rotation.z = roll * 0.3; // and twists into the bank as a rudder
    }
    if (headRef.current) {
      // she stabilises her gaze in flight and glances about at rest
      const look = fold > 0.5 && chase < 0.5;
      headRef.current.rotation.y = look ? 0.32 * Math.sin(e * 0.5) : -roll * 0.5;
      headRef.current.rotation.x = look ? 0.06 * Math.sin(e * 0.9) : -0.12 * flapAmp;
    }
    if (legsRef.current) legsRef.current.visible = fold > 0.5; // tucked away in flight

    /* ---------- hood ---------- */
    if (hoodRef.current) {
      hoodRef.current.visible = hoodOn > 0.01;
      hoodRef.current.position.y = 0.06 + (1 - hoodOn) * 0.5; // lifts away as it comes off
    }
    const hm = hoodMeshRef.current?.material as THREE.MeshStandardMaterial | undefined;
    if (hm) hm.opacity = hoodOn; // and fades over the same half-second

    /* ---------- the scroll: furled on the jess, then unrolled ---------- */
    if (furlRef.current) furlRef.current.visible = scrollOpen < 0.5 && !landed ? true : scrollOpen < 0.05;
    if (furlMatRef.current) furlMatRef.current.opacity = 1 - smooth(clamp01(scrollOpen / 0.3));
    if (scrollRef.current) {
      const open = smooth(scrollOpen);
      scrollRef.current.visible = open > 0.01;
      scrollRef.current.scale.set(scroll.w * open, scroll.h, 1);
      // it hangs from the falcon's foot, then rests forward between her and the lens
      scrollRef.current.position.set(SCROLL_AT.x, SCROLL_AT.y - (1 - open) * 0.1, SCROLL_AT.z);
    }
    if (scrollPaperRef.current) scrollPaperRef.current.opacity = smooth(clamp01(scrollOpen / 0.5)) * 0.98;
    if (scrollInkRef.current) scrollInkRef.current.opacity = smooth(clamp01((scrollOpen - 0.25) / 0.5));

    /* ---------- affordances ---------- */
    if (hintRef.current) {
      hintRef.current.visible = hintKind === 1;
      if (hintKind === 1) {
        // three chevrons streaming up off the bird: swipe this way
        for (let i = 0; i < hintRef.current.children.length; i++) {
          const c = hintRef.current.children[i] as THREE.Sprite;
          const ph = (e * 0.9 + i * 0.33) % 1;
          c.position.y = 0.55 + ph * 0.5;
          (c.material as THREE.SpriteMaterial).opacity = Math.sin(ph * Math.PI) * 0.5;
        }
      }
    }
    const showRing = hintKind === 2;
    if (ringRef.current) ringRef.current.visible = showRing;
    if (meterRef.current) meterRef.current.visible = showRing;
    if (showRing) {
      if (ringMatRef.current) ringMatRef.current.opacity = 0.3 + 0.2 * Math.sin(e * 3);
      if (meterRef.current) meterRef.current.scale.setScalar(0.15 + 0.85 * s.meter);
      if (meterMatRef.current) meterMatRef.current.opacity = 0.25 + 0.55 * s.meter;
    }

    /* ---------- heat shimmer over the near dune ---------- */
    if (shimmerRef.current) {
      for (let i = 0; i < shimmerRef.current.children.length; i++) {
        const c = shimmerRef.current.children[i] as THREE.Sprite;
        const ph = (e * 0.35 + i * 0.4) % 1;
        c.position.y = -1.5 + ph * 0.6;
        (c.material as THREE.SpriteMaterial).opacity = Math.sin(ph * Math.PI) * 0.16 * hour.shimmer;
        c.scale.x = 2.2 + 0.3 * Math.sin(e * 2 + i);
      }
    }
    if (discRef.current) {
      const m = discRef.current.material as THREE.SpriteMaterial;
      m.opacity = 0.85 + 0.12 * Math.sin(e * 0.7); // the low sun/moon breathing through the haze
    }

    /* ---------- camera ---------- */
    if (chase > 0.001 && birdRef.current) {
      // ride behind and above her; blend off the glued-to-glove home pose by `chase`
      _v.copy(birdRef.current.position).addScaledVector(_dir, -3.2);
      _v.y += 1.1;
      _camDesired.lerp(_v, chase);
    }
    if (camRef.current) {
      const cam = camRef.current;
      if (phase === "opening") {
        // smooth chase; snapping would jerk on every recomputed frame
        _camPos.lerp(_camDesired, Math.min(1, dt * 3));
      } else {
        _camPos.copy(_camDesired); // static tableaux: framed cold, no drift
      }
      cam.position.copy(_camPos);
      if (chase > 0.001 && birdRef.current) {
        _tgt.copy(birdRef.current.position).addScaledVector(_dir, 1.2);
        _v.copy(LOOK_HOME).lerp(_tgt, chase);
        cam.lookAt(_v);
      } else {
        cam.lookAt(LOOK_HOME);
      }
    }
  });

  /* the hit targets only exist while they are wanted, and never overlap in time:
     the bird catches the cast until she leaves, the glove catches the recall after */
  const wantBirdHit = phase === "opening";
  const wantGloveHit = phase === "opening";

  return (
    <>
      <PerspectiveCamera
        ref={camRef}
        makeDefault
        position={[LOOK_HOME.x, LOOK_HOME.y + 0.5, LOOK_HOME.z + 4.2]}
        fov={FOV}
      />
      <ambientLight intensity={hour.ambientI} color={hour.ambient} />
      {/* the low sun/moon as the key, and a cool bounce off the sand for the fill */}
      <directionalLight position={hour.discPos} intensity={hour.keyI} color={hour.key} />
      <directionalLight position={[-hour.discPos[0], 2, 4]} intensity={hour.fillI} color={hour.fill} />

      {/* the sky, wrapped right around the flight so the chase never runs off its edge */}
      <mesh>
        <sphereGeometry args={[45, 32, 20]} />
        <meshBasicMaterial map={sky} side={THREE.BackSide} toneMapped={false} depthWrite={false} />
      </mesh>
      {/* the sun / the moon */}
      <sprite ref={discRef} position={hour.discPos} scale={hour.discR}>
        <spriteMaterial map={glowTex} color={hour.disc} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>

      {/* the dunes, receding */}
      <mesh geometry={duneFar} material={mat.sandFar} position={[0, 0, -13]} />
      <mesh geometry={duneMid} material={mat.sandMid} position={[0, 0, -8]} />
      <mesh geometry={duneNear} material={mat.sand} position={[0, 0, -3.4]} />

      {/* heat rising off the near sand */}
      <group ref={shimmerRef}>
        {[0, 1, 2].map((i) => (
          <sprite key={i} position={[(i - 1) * 1.4, -1.5, -3.1]} scale={[2.2, 0.5, 1]}>
            <spriteMaterial
              map={glowTex} color={hour.sand} transparent opacity={0}
              depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false}
            />
          </sprite>
        ))}
      </group>

      {/* ---------- the gauntlet ---------- */}
      <group position={[GLOVE.x, GLOVE.y, GLOVE.z]}>
        <mesh geometry={cuffGeo} material={mat.leather} position={[0, -0.2, 0]} />
        {/* the tooled band — names burned into the leather in gilt */}
        <mesh position={[0, -0.16, 0.31]} rotation={[0, 0, 0]}>
          <planeGeometry args={[0.5, 0.5 * tool.aspect]} />
          <meshBasicMaterial
            map={tool.texture} transparent depthWrite={false} toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
        {/* the fist she grips */}
        <mesh geometry={fistGeo} material={mat.leatherDark} position={[0, 0.06, 0.02]} />
      </group>

      {/* ---------- the falcon ---------- */}
      <group ref={birdRef}>
        <group ref={bobRef} scale={0.9}>
          <mesh geometry={bodyGeo} material={mat.back} />
          {/* the pale breast, a shade forward and under */}
          <mesh geometry={bodyGeo} material={mat.belly} scale={[0.9, 0.86, 0.94]} position={[0, -0.03, 0.02]} />

          {/* head, beak, eyes, hood */}
          <group ref={headRef} position={[0, 0.07, -0.32]}>
            <mesh geometry={headGeo} material={mat.head} />
            <mesh geometry={beakGeo} material={mat.beak} position={[0, -0.01, -0.11]} rotation={[-Math.PI / 2, 0, 0]} />
            <mesh geometry={eyeGeo} material={mat.eye} position={[0.06, 0.03, -0.05]} />
            <mesh geometry={eyeGeo} material={mat.eye} position={[-0.06, 0.03, -0.05]} />
            {/* the cere, a bright wax patch above the beak */}
            <mesh material={mat.cere} position={[0, 0.02, -0.09]}>
              <sphereGeometry args={[0.03, 8, 6]} />
            </mesh>
            <group ref={hoodRef} position={[0, 0.06, 0]}>
              <mesh ref={hoodMeshRef} geometry={hoodGeo} material={mat.hood} />
              <mesh geometry={plumeGeo} material={mat.hood} position={[0, 0.11, 0]} />
            </group>
          </group>

          {/* wings — each pivots at its own shoulder */}
          <group ref={wingRRef} position={[0.1, 0.03, 0]}>
            <mesh geometry={wingR.wing} material={mat.back} />
            <mesh geometry={wingR.tip} material={mat.primary} />
          </group>
          <group ref={wingLRef} position={[-0.1, 0.03, 0]}>
            <mesh geometry={wingL.wing} material={mat.back} />
            <mesh geometry={wingL.tip} material={mat.primary} />
          </group>

          {/* tail */}
          <group ref={tailRef} position={[0, 0.0, 0.14]}>
            <mesh geometry={tailGeo} material={mat.back} />
          </group>

          {/* legs + the jess, and the furled scroll knotted to it */}
          <group ref={legsRef}>
            <mesh geometry={legGeo} material={mat.cere} position={[0.05, -0.16, 0.06]} />
            <mesh geometry={legGeo} material={mat.cere} position={[-0.05, -0.16, 0.06]} />
            <mesh geometry={footGeo} material={mat.cere} position={[0.05, -0.24, 0.06]} />
            <mesh geometry={footGeo} material={mat.cere} position={[-0.05, -0.24, 0.06]} />
            <group ref={furlRef} position={[0.05, -0.3, 0.1]} rotation={[0, 0, Math.PI / 2]}>
              <mesh geometry={furlGeo}>
                <meshStandardMaterial ref={furlMatRef} color="#efe2c4" roughness={0.7} transparent />
              </mesh>
            </group>
          </group>
        </group>
      </group>

      {/* ---------- the unrolled message ---------- */}
      <group ref={scrollRef} position={[SCROLL_AT.x, SCROLL_AT.y, SCROLL_AT.z]} visible={false}>
        <mesh>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial ref={scrollPaperRef} color="#efe2c4" transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, 0.001]}>
          <planeGeometry args={[0.92, 0.86]} />
          <meshBasicMaterial ref={scrollInkRef} map={scroll.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>

      {/* swipe-to-cast chevrons */}
      <group ref={hintRef} position={[PERCH.x, PERCH.y, PERCH.z]} visible={false}>
        {[0, 1, 2].map((i) => (
          <sprite key={i} scale={0.22}>
            <spriteMaterial map={glowTex} color="#ffffff" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
          </sprite>
        ))}
      </group>

      {/* hold-to-recall meter, over the glove */}
      <mesh ref={ringRef} geometry={ringGeo} position={[GLOVE.x, GLOVE.y + 0.34, GLOVE.z + 0.2]} visible={false}>
        <meshBasicMaterial ref={ringMatRef} color="#ffe6bc" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      <mesh ref={meterRef} geometry={meterGeo} position={[GLOVE.x, GLOVE.y + 0.34, GLOVE.z + 0.19]} visible={false}>
        <meshBasicMaterial ref={meterMatRef} color="#ffcf88" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>

      {/* ---------- hit targets ---------- */}
      {wantBirdHit && (
        <mesh
          ref={birdHitRef}
          position={[PERCH.x, PERCH.y + 0.05, PERCH.z + 0.1]}
          onPointerDown={onBirdDown}
          onPointerMove={onBirdMove}
          onPointerUp={onBirdUp}
          onPointerCancel={onBirdUp}
        >
          <sphereGeometry args={[0.55, 12, 10]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {wantGloveHit && (
        <mesh
          ref={gloveHitRef}
          position={[GLOVE.x, GLOVE.y - 0.05, GLOVE.z + 0.15]}
          onPointerDown={onGloveDown}
          onPointerUp={releaseGlove}
          onPointerCancel={releaseGlove}
          onPointerOut={releaseGlove}
        >
          <boxGeometry args={[0.8, 0.7, 0.5]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
