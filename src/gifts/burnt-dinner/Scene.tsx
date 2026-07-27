import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite, radialBlob } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
const KITCHENS: Record<string, { wall: string; cloth: string; key: string; amb: number; fill: string }> = {
  cozy: { wall: "#2e211a", cloth: "#c9b394", key: "#ffd9a0", amb: 0.45, fill: "#8a5a3a" },
  marble: { wall: "#33353c", cloth: "#e6e4dd", key: "#f2f4ff", amb: 0.6, fill: "#6d7a92" },
  candlelit: { wall: "#1d1310", cloth: "#a88d6b", key: "#ff9f4a", amb: 0.28, fill: "#5a2f1c" },
};
/* What is under the dome — only ever a silhouette, since it is charcoal by the
   time anyone sees it: a squat roast, a tall cake, a wide flat tangle of pasta. */
const DISHES: Record<string, { r: number; h: number; seg: number }> = {
  roast: { r: 0.3, h: 0.16, seg: 14 },
  cake: { r: 0.26, h: 0.24, seg: 22 },
  pasta: { r: 0.34, h: 0.1, seg: 18 },
};

const TAU = Math.PI * 2;
const ACTION_W = 2.7;
const ACTION_H = 2.1;
const SMOKE_N = 176;
const WISP_N = 34;
const EMBER_N = 36;
const FOV = 44;

/* ---------- char: the burnt crust the message is legible in ---------- */
function buildChar(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1a1512";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(6421);
  // cracked crust: dark cells with hot cracks between them, like a thing left on
  for (let i = 0; i < 800; i++) {
    const v = 12 + rand() * 26;
    g.fillStyle = `rgb(${v + 8},${v},${v - 4})`;
    g.beginPath();
    g.arc(rand() * s, rand() * s, 6 + rand() * 22, 0, TAU);
    g.fill();
  }
  g.strokeStyle = "rgba(120,44,12,0.5)";
  for (let i = 0; i < 160; i++) {
    g.lineWidth = 1 + rand() * 2;
    const x = rand() * s;
    const y = rand() * s;
    const a = rand() * TAU;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * (10 + rand() * 40), y + Math.sin(a) * (10 + rand() * 40));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}
const CHAR = buildChar();
const SMOKE_TEX = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.85)"],
  [0.45, "rgba(255,255,255,0.32)"],
  [1, "rgba(255,255,255,0)"],
]);
const HINT = makeRadialSprite(64);

/* ---------- the room, as something for the silver to reflect ---------- */
// A metal with nothing around it renders black: direct lights only give it
// specular dots, and a black cloche is a hole in the table rather than the one
// bright thing on it. Twenty lines of canvas buys the whole silhouette back.
function buildEnv(kit: { wall: string; cloth: string; key: string; fill: string }): THREE.Texture {
  const W = 128;
  const H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const room = g.createLinearGradient(0, 0, 0, H);
  room.addColorStop(0, kit.key); // the ceiling the key comes off
  room.addColorStop(0.4, kit.wall);
  room.addColorStop(0.56, kit.cloth); // the horizon is the table itself, from down here
  room.addColorStop(1, kit.fill);
  g.fillStyle = room;
  g.fillRect(0, 0, W, H);
  radialBlob(g, 34, 16, 24, kit.key); // whatever is lighting the kitchen
  radialBlob(g, 30, 33, 8, "#ffcf72"); // and the two candles it was set with
  radialBlob(g, 98, 33, 8, "#ffcf72");
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The takeout menu, with a number circled and the reservation in both names. */
function buildMenu(sender: string, recipient: string, lang: Lang): THREE.CanvasTexture {
  const w = 420;
  const h = 560;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f7f0e2";
  g.fillRect(0, 0, w, h);
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "Georgia, serif";
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.fillStyle = "#8c2f22";
  g.fillRect(0, 0, w, 74);
  g.fillStyle = "#fbf5e8";
  g.font = `700 34px ${fam}`;
  g.fillText(ar ? "توصيل" : "TAKEOUT", w / 2, 48);
  g.fillStyle = "#3a332a";
  g.font = `400 19px ${fam}`;
  const rand = mulberry32(311);
  for (let i = 0; i < 9; i++) {
    const y = 122 + i * 34;
    g.textAlign = ar ? "right" : "left";
    g.fillText("• • • • • • • •".slice(0, 8 + Math.floor(rand() * 8)), ar ? w - 44 : 44, y);
    g.textAlign = ar ? "left" : "right";
    g.fillText(`${8 + Math.floor(rand() * 40)}`, ar ? 44 : w - 44, y);
  }
  // the number, circled by hand and slightly wonky
  g.textAlign = "center";
  g.fillStyle = "#26221d";
  g.font = `700 30px ${fam}`;
  g.fillText("0800 · 1 1 1 · 900", w / 2, 462);
  g.strokeStyle = "#c0392b";
  g.lineWidth = 4;
  g.beginPath();
  g.ellipse(w / 2, 452, 156, 34, 0.04, 0, TAU);
  g.stroke();
  g.font = `italic 400 20px ${fam}`;
  g.fillStyle = "#6d5f4a";
  g.fillText(ar ? `الحجز باسم: ${recipient || "—"} و${sender || "—"}` : `reservation: ${recipient || "—"} & ${sender || "—"}`, w / 2, 520);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- the smoke ---------- */
// `magic-lamp`'s plume, kept whole: the sim is the vertex shader, every position
// is a closed form of the clock, and the CPU touches four uniforms a frame. That
// is what lets the volume track the dome's height continuously instead of
// switching between a thread and a cloud.
const SMOKE_LIFE = 3.2;
const SMOKE_VERT = `
#define LIFE ${SMOKE_LIFE.toFixed(2)}
attribute vec4 aRnd;   // birth offset, swirl phase, rise rate, puff size
uniform float uTime;
uniform float uSpread;
uniform float uHeight;
uniform float uAlpha;
uniform float uScale;
uniform float uLean;
uniform float uChurn; // how hard it is coming out: the billow, not the volume
uniform float uCount; // a thread is fewer puffs, not the same puffs made faint
varying float vA;
varying float vD;

// Curl of a trig vector potential. Divergence-free by construction, which is why
// it folds and churns instead of just thinning out like plain noise.
vec3 curl(vec3 p) {
  vec3 s = sin(p), c = cos(p);
  return vec3(
    -s.x * s.y - c.z * c.x,
    -s.y * s.z - c.x * c.y,
    -s.z * s.x - c.y * c.z
  );
}

void main() {
  // aRnd.y is a phase over TAU, so scaling it back down is a second uniform
  // random that is independent of the one the life cycle rides on
  if (aRnd.y * 0.15915 > uCount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    gl_PointSize = 0.0;
    return;
  }
  float age = mod(uTime * (0.30 + aRnd.z * 0.36) + aRnd.x, 1.0) * LIFE;
  // buoyancy against drag: it leaves fast, cools, and stalls into a layer
  vec3 p = vec3(0.0, uHeight * (1.0 - exp(-age / 1.35)), 0.0);
  float th = aRnd.y + age * (0.9 + aRnd.z * 0.8);
  float rad = uSpread * (0.08 + age * 0.44);
  p.x += cos(th) * rad;
  p.z += sin(th) * rad * 0.7;
  p.x += uLean * smoothstep(0.0, 1.6, age);
  vec3 q = p * 1.9 + vec3(aRnd.x * 11.0, -uTime * 0.17, aRnd.y * 3.0);
  p += curl(q) * (0.04 + age * 0.14) * uChurn;
  p += curl(q * 2.6 + 2.3) * (0.012 + age * 0.05) * uChurn;

  vA = smoothstep(0.0, 0.32, age) * (1.0 - smoothstep(LIFE * 0.42, LIFE, age)) * uAlpha;
  vD = clamp(age / LIFE, 0.0, 1.0); // young smoke is dense and dark, old smoke is a haze
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // puffs expand as they rise, which is the whole difference between smoke and dust
  gl_PointSize = min(aRnd.w * (0.45 + age * 0.5) * uScale / max(-mv.z, 0.1), 140.0);
}
`;
const SMOKE_FRAG = `
uniform sampler2D uTex;
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uLight; // the alarm strobe catches the plume too
varying float vA;
varying float vD;
void main() {
  float m = texture2D(uTex, gl_PointCoord).a;
  gl_FragColor = vec4(mix(uCore, uEdge, vD) * (1.0 + uLight * 1.4), m * vA);
  // three only injects this for built-in materials; without it a hand-written
  // shader writes linear values into an sRGB buffer and the smoke comes out black
  #include <colorspace_fragment>
}
`;

function makeSmokeGeo(n: number, seed: number, size: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const pos = new Float32Array(n * 3);
  const rnd = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    rnd[i * 4] = rand();
    rnd[i * 4 + 1] = rand() * TAU;
    rnd[i * 4 + 2] = rand();
    rnd[i * 4 + 3] = size * (0.6 + rand() * 0.85);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRnd", new THREE.BufferAttribute(rnd, 4));
  return geo;
}

function makeSmokeMat(core: string, edge: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpread: { value: 0.1 },
      uHeight: { value: 0.5 },
      uAlpha: { value: 0 },
      uScale: { value: 600 },
      uLean: { value: 0 },
      uChurn: { value: 1 },
      uCount: { value: 1 },
      uLight: { value: 0 },
      uTex: { value: SMOKE_TEX },
      uCore: { value: new THREE.Color(core) },
      uEdge: { value: new THREE.Color(edge) },
    },
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

/* ---------- the message, arriving as heat ---------- */
// Fading a plane in says "a caption appeared". A front creeping along the glyphs
// says the char is still hot enough to write in — same texture, different verb.
const HEAT_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const HEAT_FRAG = `
uniform sampler2D uMap;
uniform float uHeat;  // where the front has got to, 0..1
uniform float uAlpha;
uniform float uDir;   // -1 for Arabic: heat creeps the way the line is read
uniform float uPulse;
uniform vec3 uHot;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float x = uDir > 0.0 ? vUv.x : 1.0 - vUv.x;
  // the wobble is what keeps it from reading as a wipe
  float front = uHeat * 1.62 - 0.26 + sin(vUv.y * 11.0 + uHeat * 4.0) * 0.035;
  float lit = 1.0 - smoothstep(front - 0.26, front, x);
  float edge = lit * (1.0 - lit) * 4.0;
  vec3 col = mix(t.rgb, uHot, edge * 0.9) * (1.0 + uPulse * 0.3);
  gl_FragColor = vec4(col, t.a * lit * uAlpha);
  #include <colorspace_fragment>
}
`;

/* ---------- embers in the crust ---------- */
// Layout is a module constant and the sim is closed form on the clock, so the
// per-frame loop only ever writes into the two attribute buffers.
const EMBERS = (() => {
  const rand = mulberry32(4477);
  const u = new Float32Array(EMBER_N);
  const th = new Float32Array(EMBER_N);
  const ph = new Float32Array(EMBER_N);
  const rt = new Float32Array(EMBER_N);
  for (let i = 0; i < EMBER_N; i++) {
    u[i] = Math.sqrt(rand()) * 0.94; // uniform over the disc
    th[i] = rand() * TAU;
    ph[i] = rand();
    rt[i] = 0.13 + rand() * 0.13;
  }
  return { u, th, ph, rt };
})();
const EMBER_SIT = 0.76; // the fraction of a life it spends glowing in a crack

/* ---------- opening ---------- */
// World units of drag that get the dome off, measured against the screen rather
// than picked: the hit plane sits at z=1 and the camera at z=2.05 with a 44° fov,
// so the whole canvas is only 2·1.05·tan(22°) ≈ 0.85 units tall. At 0.68 — and
// with the grip below eating the early part — a full pull came to ~1.08 units,
// i.e. more than one screen height, which is two or three swipes on a phone.
// 0.32 puts it at ~0.35 units, a little under half the screen: one thumb.
const LIFT_TRAVEL = 0.32;
const LIFT_H = 0.55; // how far up that is, in world units — the top of frame is 0.7
const REST_Y = -0.405; // the rim, sitting on the cloth around the plate
const SEAL = 0.18; // the rim is stuck until here, then it comes easily
const POUR = 1.9; // the smoke, all of it, far more than the dish can account for
const CLEAR_END = 4.6;
const CHIRP_1 = 0.55;
const CHIRP_2 = 0.95;
const CANDLE_OUT = 1.2;
const HEAT_AT = 2.2;
const HEAT_DUR = 2.1;
const MENU_AT = 3.4;
const POST_END = 5.6;
// A gift may never lock waiting for a hand. Left alone this long, something else
// lifts the dome — the same pull, through the same spring, so the smoke pours on
// the same curve. MERCY0 is late enough that a hand about to reach for it is
// never overridden; MERCY1 is where the rim comes free, and POST_END lands the
// whole thing at ~9.6s, well inside the twelve-second bound on onOpenComplete.
const MERCY0 = 2.4;
const MERCY1 = 4.0;

/* the gallery card runs the whole gift and then puts the dome back over it */
const PREV_PERIOD = 13.4;
const PV_UP = 1.5;
const PV_OFF = 2.7;
const PV_BACK = 10.8;
const PV_BACK_DUR = 1.8;

/** Two hard blinks and out — a smoke alarm's strobe, not lightning. */
function blink(a: number): number {
  if (a < 0 || a > 0.34) return 0;
  return Math.exp(-(a % 0.17) * 30) * (1 - a / 0.34);
}

/** Noise enough for a flame: three incommensurate sines, so it never repeats. */
function flicker(e: number, i: number): number {
  return (
    Math.sin(e * (10.7 + i * 2.9) + i * 2.1) * 0.5 +
    Math.sin(e * (23.3 + i * 3.7) + i) * 0.3 +
    Math.sin(e * (5.1 + i * 1.3)) * 0.2
  );
}

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

const WHITE = new THREE.Color("#ffffff");

export default function BurntDinnerScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const kit = KITCHENS[variants.kitchen] ?? KITCHENS.cozy;
  const dish = DISHES[variants.dish] ?? DISHES.roast;

  /* Written in the char. Legible, and apologetic. */
  const text = useMemo(() => {
    const body = message.trim() || forRecipient(lang, recipientName);
    const t = makeTextTexture(body, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "600",
      fontSize: 64,
      color: "#ffb877",
      glow: 22,
      glowColor: "#ff6a1e",
      maxWidthPx: 64 * 8,
      lineHeight: 1.3,
      padding: 24,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 1.02, 0.68) };
  }, [message, recipientName, lang]);
  useEffect(() => () => text.t.texture.dispose(), [text]);

  const heatMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: text.t.texture },
          uHeat: { value: 0 },
          uAlpha: { value: 0 },
          uDir: { value: lang === "ar" ? -1 : 1 },
          uPulse: { value: 0 },
          uHot: { value: new THREE.Color("#fff0c8") },
        },
        vertexShader: HEAT_VERT,
        fragmentShader: HEAT_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [text, lang],
  );
  useEffect(() => () => heatMat.dispose(), [heatMat]);

  const menu = useMemo(() => buildMenu(senderName, recipientName, lang), [senderName, recipientName, lang]);
  useEffect(() => () => menu.dispose(), [menu]);

  const smoke = useMemo(
    () => ({
      geo: makeSmokeGeo(SMOKE_N, 8123, 0.08),
      mat: makeSmokeMat("#3a322c", "#8a8078"),
      wispGeo: makeSmokeGeo(WISP_N, 5519, 0.022),
      wispMat: makeSmokeMat("#6a6058", "#a9a099"),
    }),
    [],
  );
  useEffect(
    () => () => {
      smoke.geo.dispose();
      smoke.mat.dispose();
      smoke.wispGeo.dispose();
      smoke.wispMat.dispose();
    },
    [smoke],
  );

  const emberBuf = useMemo(
    () => ({ pos: new Float32Array(EMBER_N * 3), col: new Float32Array(EMBER_N * 3) }),
    [],
  );

  const clothC = useMemo(() => new THREE.Color(kit.cloth), [kit]);
  const env = useMemo(() => buildEnv(kit), [kit]);
  useEffect(() => () => env.dispose(), [env]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  // `shown` is what the dome is actually doing; `lift` is what the hand asked for.
  // The gap between them is the weight.
  const g = useRef({
    lift: 0,
    shown: 0,
    sv: 0,
    offAt: -1,
    down: false,
    py: 0,
    touched: false,
    alone: 0,
    hover: 0,
    hov: 0,
    chirped: 0,
    broke: false,
    slid: false,
    puff: 0,
    spread: 0.08,
    height: 0.42,
  });
  useEffect(() => {
    if (phase === "opening")
      g.current = {
        lift: 0,
        shown: 0,
        sv: 0,
        offAt: -1,
        down: false,
        py: 0,
        touched: false,
        alone: 0,
        hover: 0,
        hov: 0,
        chirped: 0,
        broke: false,
        slid: false,
        puff: 0,
        spread: 0.08,
        height: 0.42,
      };
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const clocheRef = useRef<THREE.Group>(null);
  const smokeRef = useRef<THREE.Points>(null);
  const smokeGrpRef = useRef<THREE.Group>(null);
  const wispRef = useRef<THREE.Points>(null);
  const charMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const textRef = useRef<THREE.Mesh>(null);
  const menuRef = useRef<THREE.Group>(null);
  const menuMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const flameRefs = useRef<(THREE.Group | null)[]>([]);
  const flameGlowRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const settingRefs = useRef<(THREE.Group | null)[]>([]);
  const emberRef = useRef<THREE.PointLight>(null);
  const emberPtsRef = useRef<THREE.Points>(null);
  const strobeRef = useRef<THREE.PointLight>(null);
  const ambRef = useRef<THREE.AmbientLight>(null);
  const clothMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const glintRef = useRef<THREE.Mesh>(null);
  const glintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.offAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.current.down = true;
    g.current.touched = true;
    g.current.alone = 0;
    g.current.py = ev.point.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening" || c.lift >= 1) return;
    ev.stopPropagation();
    // a hand still working the dome owns the pace; one that has gone still does not
    c.alone = 0;
    const dy = ev.point.y - c.py;
    c.py = ev.point.y;
    // Resistance: the rim is stuck to the plate for the first fraction of the
    // lift, so early drag buys less than late drag and the release has a moment.
    const grip = 0.4 + 0.6 * smooth(clamp01(c.lift / SEAL));
    c.lift = clamp01(c.lift + (dy / LIFT_TRAVEL) * grip);
  };
  const stop = () => {
    g.current.down = false;
  };
  const onOver = () => {
    if (phase === "sealed" || (phase === "opening" && g.current.offAt < 0)) g.current.hover = 1;
  };
  const onOut = () => {
    g.current.hover = 0;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = g.current;

    const fit = Math.max(0.6, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H));
    fitRef.current?.scale.setScalar(fit);
    // the desktop hover, eased — a pointer arriving is still an arrival
    c.hov += ((c.touched || c.down ? 0 : c.hover) - c.hov) * Math.min(1, dt * 7);

    /* ---- where in the show we are ---- */
    // `post` is seconds since the dome came free; every beat downstream is a
    // closed form of it, which is what makes `revealed` correct as one frame.
    let post = -1;
    let liftK: number;
    let show = 1; // preview fades the reveal back out before the dome returns
    let tilt = 0;
    if (phase === "preview") {
      const pv = e % PREV_PERIOD;
      const back = smooth(clamp01((pv - PV_BACK) / PV_BACK_DUR));
      show = 1 - back;
      liftK = easeOutCubic(clamp01((pv - PV_UP) / (PV_OFF - PV_UP))) * show;
      post = pv - PV_OFF;
      tilt = Math.sin(pv * 1.1) * 0.05 * liftK;
    } else if (phase === "revealed") {
      post = POST_END;
      liftK = 1;
    } else if (phase === "opening") {
      if (!c.down && c.offAt < 0) c.lift = Math.max(0, c.lift - dt * 0.2); // it wants to sit back down
      // Nobody came: something else takes the handle. A floor under `lift` that
      // only ever rises, applied after the settle-back above so the dome's own
      // weight cannot argue with it, and before the spring below so it arrives
      // through the same lag, the same rock and the same tilt a drag gives it.
      // Eased in, so it reads as a slow pull rather than a timer running out.
      c.alone += dt;
      c.lift = Math.max(c.lift, smooth(clamp01((c.alone - MERCY0) / (MERCY1 - MERCY0))));
      // A spring, not a lerp: the dome lags the hand, carries momentum past a
      // fast pull, and rocks once when it arrives.
      c.sv += ((c.lift - c.shown) * 52 - c.sv * 9.5) * dt;
      c.shown = Math.max(0, c.shown + c.sv * dt);
      liftK = c.shown;
      tilt = Math.max(-0.14, Math.min(0.14, -c.sv * 0.05));
      post = c.offAt >= 0 ? tRef.current - c.offAt : -1;

      if (!c.broke && c.lift > SEAL) {
        c.broke = true;
        c.puff = 1;
        clack({ freq: 640, decay: 0.1, gain: 0.09 }); // the rim letting go
      }
      if (c.lift >= 1 && c.offAt < 0) {
        c.offAt = tRef.current;
        clack({ freq: 2600, decay: 0.14, gain: 0.11 });
        tone(180, { type: "sine", seconds: 0.7, gain: 0.14 });
      }
      c.puff = Math.max(0, c.puff - dt * 1.6);
    } else {
      // sealed: waiting, and not quite still — the dome breathes on the cloth
      liftK = 0.006 * (1 + Math.sin(e * 0.9)) + c.hov * 0.035;
      tilt = Math.sin(e * 0.5) * 0.006;
    }

    // The alarm, off-screen, twice. It is worth more than any of the geometry.
    if (post >= 0 && phase === "opening") {
      if (c.chirped === 0 && post > CHIRP_1) {
        c.chirped = 1;
        tone(3150, { type: "square", seconds: 0.11, gain: 0.2 });
      } else if (c.chirped === 1 && post > CHIRP_2) {
        c.chirped = 2;
        tone(3150, { type: "square", seconds: 0.11, gain: 0.2 });
      }
    }
    const strobe = post < 0 ? 0 : (blink(post - CHIRP_1) + blink(post - CHIRP_2)) * show;

    /* ---- the table leans a little toward whoever is looking at it ---- */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 2.6);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.035, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.05, k);
    }

    /* ---- the dome ---- */
    // Anticipation: it dips back into the plate before it goes. The gallery card
    // never lets it leave — it lowers the dome again at the end of the loop, and
    // a dome that had flown off could not.
    const flies = phase !== "preview" && post >= 0;
    const away = flies ? easeOutCubic(clamp01((post - 0.14) / 1.5)) : 0;
    const dip = flies && post < 0.14 ? Math.sin((post / 0.14) * Math.PI) * 0.05 : 0;
    if (clocheRef.current) {
      const d = clocheRef.current;
      d.position.y = REST_Y + liftK * LIFT_H - dip + away * 0.66;
      d.position.x = away * 1.15 + tilt * 0.06;
      d.rotation.z = tilt + away * 0.72;
      // untouched, it leans toward the pointer: an object that answers is an
      // object you reach for
      if (phase !== "revealed" && post < 0 && !c.touched) {
        d.rotation.x = lerp(d.rotation.x, state.pointer.y * -0.05, Math.min(1, dt * 3));
        d.rotation.z += state.pointer.x * 0.03;
      } else {
        d.rotation.x = lerp(d.rotation.x, 0, Math.min(1, dt * 4));
      }
      d.visible = phase !== "revealed" && away < 0.99;
    }
    // a highlight sliding round polished metal — the dome is never a still object.
    // Held on a shell a little wider than the metal: at a fixed z the far half of
    // the orbit falls *inside* the dome and the highlight blinks out entirely.
    if (glintRef.current) {
      const a = e * 0.55 + liftK * 1.4;
      const gx = Math.sin(a) * 0.3;
      const gy = 0.2 + Math.cos(a * 0.7) * 0.12;
      glintRef.current.position.set(gx, gy, Math.sqrt(0.33 - gx * gx - gy * gy));
    }
    // The pulse is an invitation, and an invitation that is being answered — by a
    // hand or by the mercy — has nothing left to ask for. Both fade out the moment
    // the dome starts moving on its own, rather than burning through the reveal.
    const asking = phase === "opening" && !c.touched && c.alone < MERCY0;
    if (glintMatRef.current) {
      const invite = asking ? 0.22 + 0.16 * Math.sin(e * 2.7) : 0;
      const want = 0.16 + invite + c.hov * 0.28 + strobe * 0.5;
      glintMatRef.current.opacity += (want - glintMatRef.current.opacity) * Math.min(1, dt * 6);
    }
    if (hintMatRef.current) {
      const want = asking ? 0.32 + 0.2 * Math.sin(e * 2.7) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- the smoke: a thread at the rim, a great deal of it once lifted ---- */
    // Volume, spread and rise all ride the dome's actual height, so a slow lift
    // seeps and a fast one dumps.
    const seep = clamp01(liftK * 1.3);
    // Before the dome is off, the height of the gap is the whole story; after, the
    // timeline owns it, or the settled scene would still be pouring.
    const vol =
      (post < 0
        ? seep * 0.55
        : Math.exp(-Math.max(0, post - POUR) / 1.5) * smooth(clamp01(post / 0.3))) * show;
    const gust = Math.max(vol, c.puff * 0.5);
    // smoothed, because the plume is a body of gas and cannot change shape on a frame
    c.spread += (lerp(0.07, 0.72, gust) - c.spread) * Math.min(1, dt * 2.2);
    c.height += (lerp(0.42, 1.55, gust) - c.height) * Math.min(1, dt * 1.8);
    const sm = smokeRef.current?.material as THREE.ShaderMaterial | undefined;
    const pxScale = ((state.size.height * state.viewport.dpr) / (2 * Math.tan((FOV * Math.PI) / 360))) * fit;
    if (sm) {
      const u = sm.uniforms;
      u.uTime.value = e;
      u.uSpread.value = c.spread;
      u.uHeight.value = c.height;
      u.uChurn.value = 0.6 + gust * 0.9;
      u.uCount.value = 0.1 + 0.9 * clamp01(gust * 1.7);
      u.uLean.value = Math.sin(e * 0.31) * 0.12 + state.pointer.x * 0.04;
      u.uScale.value = pxScale;
      // The one thread at the rim is a function of the gap, not of the phase, so
      // it hands over to the pour continuously and the preview loop never pops.
      const idle = 0.34 * (1 - clamp01(seep * 2));
      u.uAlpha.value = Math.max(idle, post < 0 ? 0 : 0.14 * show, 0.62 * vol);
      u.uLight.value = strobe;
    }
    // While the dome is down the only way out is the rim, so that is where it comes
    // from — just outside the metal, or the dome's own depth would eat it.
    if (smokeGrpRef.current) {
      const k = smooth(clamp01(seep));
      smokeGrpRef.current.position.set(lerp(0.33, 0, k), lerp(-0.4, -0.26, k), lerp(0.39, 0.02, k));
    }

    /* ---- what is left of dinner ---- */
    const cleared = (post < 0 ? 0 : smooth(clamp01((post - POUR) / (CLEAR_END - POUR)))) * show;
    // Embers in the cracks, not a hot coal: any real emissive here and the char
    // reads as a bright orange dome and the word "cremated" stops landing.
    if (charMatRef.current)
      charMatRef.current.emissiveIntensity = 0.05 + (0.03 + 0.018 * flicker(e, 3)) * (1 + Math.sin(e * 1.3)) * cleared;
    if (emberRef.current)
      emberRef.current.intensity = 0.18 + cleared * 0.26 + flicker(e, 1) * 0.05 + strobe * 0.4;

    const ep = emberPtsRef.current;
    if (ep) {
      const pa = ep.geometry.attributes.position as THREE.BufferAttribute;
      const ca = ep.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < EMBER_N; i++) {
        const a = (EMBERS.ph[i] + e * EMBERS.rt[i]) % 1;
        // most of a life is spent glowing in a crack; the last of it is spent
        // riding the plume, which is where the smoke gets its sparks
        const rise = a > EMBER_SIT ? (a - EMBER_SIT) / (1 - EMBER_SIT) : 0;
        const u = EMBERS.u[i];
        const r = u * dish.r * (1 + rise * 0.55);
        const surf = dish.h * Math.sqrt(Math.max(0, 1 - u * u));
        pa.setXYZ(
          i,
          Math.cos(EMBERS.th[i]) * r + Math.sin(e * 2 + i) * rise * 0.05,
          surf + rise * rise * 0.95,
          Math.sin(EMBERS.th[i]) * r * 0.9,
        );
        const puls = 0.45 + 0.55 * Math.sin(e * (2.6 + (i % 5) * 0.7) + EMBERS.ph[i] * TAU);
        const b = cleared * (rise > 0 ? (1 - rise) * (1 - rise) * 1.1 : 0.3 + 0.55 * puls);
        ca.setXYZ(i, b, b * 0.4, b * 0.1);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- the message, arriving as heat rather than as a caption ---- */
    const tm = textRef.current?.material as THREE.ShaderMaterial | undefined;
    if (tm) {
      const u = tm.uniforms;
      u.uHeat.value = post < 0 ? 0 : clamp01((post - HEAT_AT) / HEAT_DUR);
      u.uAlpha.value = show * (post < 0 ? 0 : smooth(clamp01((post - HEAT_AT + 0.3) / 0.6)));
      // once written it keeps breathing, the way something still hot does
      u.uPulse.value = 0.18 + 0.18 * Math.sin(e * 1.7) + strobe * 0.5;
    }

    /* ---- the menu, underneath the plate, where it was always going to be ---- */
    if (menuRef.current && menuMatRef.current) {
      const k = post < 0 ? 0 : smooth(clamp01((post - MENU_AT) / 1.1));
      const kb = post < 0 ? 0 : easeOutBack(clamp01((post - MENU_AT) / 0.9));
      const s = Math.max(0, post - MENU_AT - 0.45);
      menuRef.current.visible = k * show > 0.01;
      menuRef.current.position.x = lerp(0.06, 0.76, kb);
      menuRef.current.position.z = lerp(0.3, 0.42, kb);
      // paper slides, overshoots, and rocks itself flat
      menuRef.current.position.y = -0.404 + Math.sin(clamp01(kb) * Math.PI) * 0.014;
      menuRef.current.rotation.z =
        lerp(0.62, 0.14, k) + Math.sin(s * 13) * 0.07 * Math.exp(-s * 3.2) + Math.sin(e * 0.8) * 0.004;
      menuMatRef.current.opacity = k * show;
    }
    if (phase === "opening" && !c.slid && post > MENU_AT) {
      c.slid = true;
      clack({ freq: 1150, decay: 0.24, gain: 0.07 }); // card on cloth, once
    }

    /* ---- two candles. One of them is about to have a bad time. ---- */
    for (let i = 0; i < 2; i++) {
      const f = flameRefs.current[i];
      if (!f) continue;
      const sgn = i ? 1 : -1;
      // Both the guttering and the relight ride `show`, so the gallery loop grows
      // the wick back as the dome comes down instead of snapping a lit flame on at
      // the seam — and post wrapping to -2.7 lands on the same flame it left.
      const doom = i === 1 && post >= 0 ? clamp01((post - 0.5) / (CANDLE_OUT - 0.5)) * show : 0;
      const alive = i === 1 && post > CANDLE_OUT ? 1 - show : 1;
      const n = flicker(e, i) * (1 + doom * 2.6);
      f.visible = alive > 0.02;
      f.scale.set(1 - n * 0.09, (1 + n * 0.2 - doom * 0.45) * alive, 1 - n * 0.09);
      // leaning away from whatever came off the plate, harder the more of it there is
      f.rotation.z = -sgn * (vol * 0.55 + doom * 0.3) + n * 0.1;
      const gm = flameGlowRefs.current[i];
      if (gm) gm.opacity = (0.5 + n * 0.16 - doom * 0.3) * alive + strobe * 0.2;
    }
    // the wisp the dead wick leaves behind, on its own small clock
    const wm = wispRef.current?.material as THREE.ShaderMaterial | undefined;
    if (wm) {
      const a = post < 0 ? -1 : post - CANDLE_OUT;
      const u = wm.uniforms;
      u.uTime.value = e;
      u.uSpread.value = 0.06;
      u.uHeight.value = 0.42;
      u.uChurn.value = 0.8;
      u.uLean.value = 0.06;
      u.uScale.value = pxScale;
      u.uLight.value = strobe;
      u.uAlpha.value = a < 0 ? 0 : smooth(clamp01(a / 0.35)) * Math.exp(-Math.max(0, a - 0.5) / 1.6) * 0.5 * show;
    }

    /* ---- the room, when the alarm goes ---- */
    if (strobeRef.current) strobeRef.current.intensity = strobe * 7;
    if (ambRef.current) ambRef.current.intensity = kit.amb * (1 + strobe * 0.8);
    // the cloth is the biggest flat thing on screen, so it is what sells the flash
    if (clothMatRef.current) clothMatRef.current.color.copy(clothC).lerp(WHITE, strobe * 0.5);
    // the settings rattle on the plate the way loose metal does
    const rattle = post < 0 ? 0 : strobe + Math.exp(-post * 5) * 0.6;
    for (let i = 0; i < 2; i++) {
      const s = settingRefs.current[i];
      if (!s) continue;
      // it skitters in the plane of the cloth and only just leaves it
      s.rotation.y = (i ? 0.1 : -0.1) + Math.sin(e * 61 + i * 2) * 0.06 * rattle;
      s.rotation.z = Math.sin(e * 47 + i) * 0.02 * rattle;
      s.position.y = -0.414 + Math.abs(Math.sin(e * 44 + i)) * 0.008 * rattle;
    }

    /* ---- the camera: in for the smoke, back and down over the message ---- */
    const cam = camRef.current;
    if (cam) {
      const k1 = post < 0 ? 0 : smooth(clamp01(post / 0.9));
      const k2 = post < 0 ? 0 : smooth(clamp01((post - 2.4) / 2.0));
      const z = lerp(lerp(2.05 - liftK * 0.05, 1.86, k1), 1.97, k2);
      const y = lerp(lerp(0.34, 0.3, k1), 0.26, k2);
      cam.position.set(
        Math.sin(e * 0.23) * 0.014 + Math.sin(e * 63) * 0.007 * strobe,
        y + Math.cos(e * 0.31) * 0.008,
        z,
      );
      cam.lookAt(0, lerp(-0.16, -0.2, k2), 0);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const candle = (x: number, i: number) => (
    /* the foot of the candle stands on the cloth, not above it */
    <group key={i} position={[x, -0.25, -0.24]}>
      <mesh>
        <cylinderGeometry args={[0.035, 0.04, 0.34, 12]} />
        <meshStandardMaterial color="#efe6d2" roughness={0.7} />
      </mesh>
      {/* the flame hangs off the wick so it leans from its base, not its middle */}
      <group
        ref={(m) => {
          flameRefs.current[i] = m;
        }}
        position={[0, 0.17, 0]}
      >
        <mesh position={[0, 0.045, 0]}>
          <coneGeometry args={[0.024, 0.08, 8]} />
          <meshBasicMaterial color="#ffcf72" toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.05, 0.01]}>
          <planeGeometry args={[0.3, 0.3]} />
          <meshBasicMaterial
            ref={(m) => {
              flameGlowRefs.current[i] = m;
            }}
            map={HINT}
            color="#ffb055"
            transparent
            opacity={0.5}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>
      {/* the smoke off the wick that loses — its own beat, its own little plume */}
      {i === 1 ? (
        <points ref={wispRef} geometry={smoke.wispGeo} material={smoke.wispMat} position={[0, 0.2, 0]} frustumCulled={false} />
      ) : null}
    </group>
  );

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, 0.34, 2.05]} fov={FOV} />
      <ambientLight ref={ambRef} intensity={kit.amb} color={kit.fill} />
      <directionalLight position={[1.2, 2.2, 1.8]} intensity={1.15} color={kit.key} />
      <pointLight ref={emberRef} position={[0, -0.05, 0.5]} intensity={0.5} color="#ff7a30" distance={3.4} decay={1.6} />
      {/* the alarm is off-screen; only its strobe is in the room */}
      <pointLight ref={strobeRef} position={[-2.2, 1.7, 1.5]} intensity={0} color="#dfe9ff" distance={11} decay={1.1} />

      <mesh position={[0, 0.5, -1.6]}>
        <planeGeometry args={[14, 9]} />
        <meshStandardMaterial color={kit.wall} roughness={0.95} />
      </mesh>

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the table, set properly */}
          <mesh position={[0, -0.42, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[3.2, 2.0]} />
            <meshStandardMaterial ref={clothMatRef} color={kit.cloth} roughness={0.92} />
          </mesh>
          {/* napkin and something to eat with, both of which rattle when it goes off */}
          {[-0.78, 0.78].map((x, i) => (
            <group
              key={i}
              ref={(m) => {
                settingRefs.current[i] = m;
              }}
              position={[x, -0.414, 0.32]}
              rotation={[0, i ? 0.1 : -0.1, 0]}
            >
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.22, 0.3]} />
                <meshStandardMaterial color="#f2ece0" roughness={0.9} />
              </mesh>
              <mesh position={[i ? 0.07 : -0.07, 0.004, 0]}>
                <boxGeometry args={[0.022, 0.006, 0.26]} />
                <meshStandardMaterial color="#c3c8cf" roughness={0.24} metalness={0.9} envMap={env} envMapIntensity={1.1} />
              </mesh>
            </group>
          ))}
          {candle(-0.62, 0)}
          {candle(0.62, 1)}

          {/* the plate */}
          <mesh position={[0, -0.4, 0.02]}>
            <cylinderGeometry args={[0.46, 0.44, 0.03, 40]} />
            <meshStandardMaterial color="#f4efe6" roughness={0.32} />
          </mesh>

          {/* dinner. It is cremated. (The squash is on the mesh: `scale` on a
              geometry element would collide with BufferGeometry.scale(), the method.) */}
          <mesh position={[0, -0.34, 0.02]} scale={[1, dish.h / dish.r, 1]}>
            <sphereGeometry args={[dish.r, dish.seg, 12]} />
            <meshStandardMaterial
              ref={charMatRef}
              map={CHAR}
              color="#2b241f"
              emissive="#ff5a12"
              emissiveIntensity={0.05}
              roughness={0.95}
            />
          </mesh>
          {/* embers in the cracks, a few of which leave with the smoke */}
          <points ref={emberPtsRef} position={[0, -0.34, 0.02]} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[emberBuf.pos, 3]} />
              <bufferAttribute attach="attributes-color" args={[emberBuf.col, 3]} />
            </bufferGeometry>
            <pointsMaterial
              map={HINT}
              vertexColors
              size={0.05}
              sizeAttenuation
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </points>
          {/* the message, written in the char and arriving as heat */}
          {/* Lifted and pushed forward so the tallest message still clears both the
              char's equator and the plate rim: at [-0.16, 0.22] the last line of a
              long one was swallowed by the plate. */}
          <mesh ref={textRef} position={[0, -0.06, 0.3]} rotation={[-0.55, 0, 0]} material={heatMat}>
            <planeGeometry args={text.size} />
          </mesh>

          {/* the takeout menu, from under the plate */}
          <group ref={menuRef} position={[0.06, -0.404, 0.3]} rotation={[-Math.PI / 2, 0, 0.62]} visible={false}>
            <mesh>
              <planeGeometry args={[0.52, 0.7]} />
              <meshBasicMaterial ref={menuMatRef} map={menu} transparent opacity={0} toneMapped={false} side={THREE.DoubleSide} />
            </mesh>
          </group>

          {/* the smoke — the origin walks from the rim to the dish as the dome rises */}
          <group ref={smokeGrpRef} position={[0.33, -0.4, 0.39]}>
            <points ref={smokeRef} geometry={smoke.geo} material={smoke.mat} frustumCulled={false} />
          </group>

          {/* the cloche */}
          <group ref={clocheRef} position={[0, REST_Y, 0.02]}>
            <mesh onPointerOver={onOver} onPointerOut={onOut}>
              <sphereGeometry args={[0.5, 34, 20, 0, TAU, 0, Math.PI / 2]} />
              <meshStandardMaterial
                color="#c9ced6"
                roughness={0.14}
                metalness={0.96}
                envMap={env}
                envMapIntensity={1.35}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0.5, 0]}>
              <sphereGeometry args={[0.055, 14, 12]} />
              <meshStandardMaterial color="#dfe4ea" roughness={0.12} metalness={0.96} envMap={env} envMapIntensity={1.35} />
            </mesh>
            {/* the specular that never sits still, and the pulse that asks to be pulled */}
            <mesh ref={glintRef} position={[0, 0.2, 0.4]}>
              <planeGeometry args={[0.34, 0.34]} />
              <meshBasicMaterial
                ref={glintMatRef}
                map={HINT}
                color="#eaf2ff"
                transparent
                opacity={0.16}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
            <mesh position={[0, 0.5, 0]}>
              <planeGeometry args={[0.6, 0.6]} />
              <meshBasicMaterial ref={hintMatRef} map={HINT} color="#ffe3b0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
            </mesh>
          </group>
        </group>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 1]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
