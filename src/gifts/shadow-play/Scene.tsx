import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
// We sit on the audience side of a lit sheet, so the lamp is only ever its glow
// through the linen: colour, how wide the hotspot spreads, how badly it gutters,
// and how small its flame is — a pinpoint gas mantle throws a hard edge, a broad
// candle flame throws a penumbra you could lose a hand in.
const LAMPS: Record<string, { warm: string; core: string; spread: number; gutter: number; rate: number; sharp: number }> = {
  oil: { warm: "#ffb765", core: "#fff0cf", spread: 0.62, gutter: 0.16, rate: 2.1, sharp: 0.6 },
  candle: { warm: "#ff9a45", core: "#ffe0ae", spread: 0.48, gutter: 0.26, rate: 5.4, sharp: 0.34 },
  gas: { warm: "#dfe9c9", core: "#ffffff", spread: 0.74, gutter: 0.05, rate: 1.2, sharp: 0.86 },
};
// `sway` is how freely the cloth carries a wave: silk is loose and quick, paper
// barely moves at all and creases instead of rippling.
const SCREENS: Record<string, { tint: string; weave: number; grain: number; sway: number }> = {
  linen: { tint: "#e8d6b2", weave: 12, grain: 0.16, sway: 1 },
  silk: { tint: "#f2e2cd", weave: 26, grain: 0.06, sway: 1.55 },
  paper: { tint: "#efe6d2", weave: 0, grain: 0.24, sway: 0.42 },
};

const SCREEN_W = 3.05;
const SCREEN_H = 1.95;
const ACTION_W = 3.35;
const ACTION_H = 2.45;
// Where the lamp sits behind the cloth — buildScreen burns its hotspot here, and
// everything that cares about distance-to-flame measures from the same point.
const LAMP_CY = -0.12;
// Enough segments for a wave to read across the sheet and no more: the ripple is
// carried by per-vertex brightness, so this is 345 colours a frame, not a shader.
const SEG_X = 22;
const SEG_Y = 14;
const VERTS = (SEG_X + 1) * (SEG_Y + 1);
// Everything in the cloth's wave that depends on one axis only, worked out once per
// column instead of once per vertex. Scratch, so it lives at module scope.
const COL_S1 = new Float32Array(SEG_X + 1);
const COL_S3 = new Float32Array(SEG_X + 1);
const COL_A = new Float32Array(SEG_X + 1);
const COL_B = new Float32Array(SEG_X + 1);
const COL_G = new Float32Array(SEG_X + 1);
const COL_X2 = new Float32Array(SEG_X + 1);

/** The lit sheet: weave, grain, and the lamp's hotspot burnt into the middle. */
function buildScreen(tint: string, weave: number, grain: number, warm: string, spread: number): THREE.CanvasTexture {
  const w = 512;
  const h = 340;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = tint;
  g.fillRect(0, 0, w, h);
  // the lamp behind, seen through the cloth
  const hot = g.createRadialGradient(w / 2, h * 0.56, 0, w / 2, h * 0.56, w * spread);
  hot.addColorStop(0, "rgba(255,255,255,0.95)");
  hot.addColorStop(0.45, "rgba(255,236,196,0.4)");
  hot.addColorStop(1, "rgba(60,34,18,0.5)");
  g.fillStyle = hot;
  g.fillRect(0, 0, w, h);
  if (weave > 0) {
    g.strokeStyle = "rgba(90,62,32,0.13)";
    g.lineWidth = 1;
    for (let x = 0; x < w; x += weave) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y < h; y += weave) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
  }
  const rand = mulberry32(6131);
  g.fillStyle = warm;
  for (let i = 0; i < 2600; i++) {
    g.globalAlpha = rand() * grain * 0.5;
    g.fillRect(rand() * w, rand() * h, 2, 2);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- the puppets: flat cut-outs, three hinges each ---------- */
// خيال الظل puppets are jointed leather, and from the audience they are pure
// silhouette — so these are plain dark shapes and there is not a shadow map in
// sight. Alpha-tested cutouts fringe under one; flat quads never can.
const headGeo = new THREE.CircleGeometry(0.088, 20);
const torsoGeo = new THREE.PlaneGeometry(0.14, 0.34);
const limbGeo = new THREE.PlaneGeometry(0.048, 0.24);
const hatGeo = new THREE.CircleGeometry(0.062, 3);
const rodGeo = new THREE.PlaneGeometry(0.012, 1.1);
const haloGeo = new THREE.PlaneGeometry(1, 1);
const DUST_TEX = makeRadialSprite(32);
const DUST = 84;

// Hinges are pendulums, not keyframes: stiffness, damping, how much of the pivot's
// own acceleration each one feels, and which way the gait throws it. Arms oppose
// legs. The rod is last — heavy, slack, and always late, which is why its shadow
// keeps swaying long after the figure has stopped.
const HINGE_K = [44, 44, 66, 66, 8.5];
const HINGE_D = [7.4, 7.4, 8.8, 8.8, 2.4];
const HINGE_M = [0.055, 0.055, 0.03, 0.03, 0.085];
const HINGE_G = [1, -1, -1, 1, 0];

/** The handle a posed puppet exposes: the parent's useFrame drives it through this
 *  and never reaches into the puppet's own refs, which is both tidier and the only
 *  way the hooks lint will let a child's refs be touched from outside. */
export interface PuppetHandle {
  /** Put it at (`x`,`y`) this frame and let it work the rest out: it measures its own
   *  velocity and hangs every hinge off that, so the walk *is* the drag — flick it and
   *  the limbs fly, stop and they damp down to nothing. `near` is closeness to the
   *  flame (size, and how far the penumbra blooms), `met` 0 apart → 1 folded into the
   *  words, `face` the turn about its own axis (π mirrors it), `sharp` how hard an
   *  edge the lamp is throwing just now. */
  pose(x: number, y: number, near: number, met: number, face: number, sharp: number, dt: number): void;
}

/** One jointed silhouette, driven entirely by where it is being dragged. */
const Puppet = forwardRef<PuppetHandle, { hat: boolean; ink: THREE.Material }>(function Puppet(
  { hat, ink },
  handle,
) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const armRef = useRef<THREE.Group>(null);
  const arm2Ref = useRef<THREE.Group>(null);
  const legRef = useRef<THREE.Group>(null);
  const leg2Ref = useRef<THREE.Group>(null);
  const rodRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const haloMatRef = useRef<THREE.MeshBasicMaterial>(null);

  // Angle and angular velocity per hinge, plus the pivot's smoothed velocity: the
  // whole gait is these six numbers integrated, so nothing here needs a clock from
  // outside and every phase gets the same living body for free.
  const sim = useRef({
    on: false,
    t: 0,
    px: 0,
    vx: 0,
    av: 0,
    gait: 0,
    a: new Float32Array(5),
    w: new Float32Array(5),
  });

  useImperativeHandle(handle, () => ({
    pose(x, y, near, met, face, sharp, dt) {
      const s = sim.current;
      const inv = 1 / Math.max(dt, 1e-3);
      s.t += dt;
      // A dropped frame would otherwise crack the whip, so the velocity is lagged
      // and the acceleration read off the lagged one.
      const raw = s.on ? (x - s.px) * inv : 0;
      const prev = s.vx;
      s.on = true;
      s.px = x;
      s.vx += (Math.max(-6, Math.min(6, raw)) - s.vx) * Math.min(1, dt * 14);
      s.av = Math.max(-40, Math.min(40, (s.vx - prev) * inv));
      // The cycle is distance walked, not wall time — that is the whole reason the
      // feet never skate no matter how fast or slow the finger goes.
      s.gait += s.vx * dt * 7.6;

      const step = Math.sin(s.gait) * Math.min(1, Math.abs(s.vx) * 0.9) * 0.5 * (1 - met);
      for (let i = 0; i < 5; i++) {
        const rest = HINGE_G[i] * step;
        s.w[i] += (-HINGE_K[i] * (s.a[i] - rest) - HINGE_D[i] * s.w[i] - s.av * HINGE_M[i]) * dt;
        s.a[i] = Math.max(-1.3, Math.min(1.3, s.a[i] + s.w[i] * dt));
      }

      const r = rootRef.current;
      if (r) {
        r.position.set(x, y, 0);
        // Nearer the flame is bigger — the sheet is the lamp's plane. And as the two
        // overlap they shrink into the words that replace them: they do not fade,
        // nothing here can, the ink is one shared material.
        const sc = lerp(0.88, 1.2, clamp01(near)) * lerp(1, 0.04, met);
        r.scale.setScalar(sc);
        // A cut-out turning about its own axis foreshortens for free, which is worth
        // more than any amount of drawn perspective. DoubleSide is load-bearing: past
        // a quarter turn we are looking at the leather's back.
        r.rotation.y = face;
      }

      // Breathing runs under everything, so a puppet standing still is never still.
      const breath = Math.sin(s.t * 1.15) * 0.008 + Math.sin(s.t * 0.41) * 0.004;
      if (armRef.current) armRef.current.rotation.z = s.a[0] + met * 0.9;
      if (arm2Ref.current) arm2Ref.current.rotation.z = s.a[1];
      if (legRef.current) legRef.current.rotation.z = s.a[2];
      if (leg2Ref.current) leg2Ref.current.rotation.z = s.a[3];
      if (rodRef.current) rodRef.current.rotation.z = s.a[4] * 0.55 + Math.sin(s.t * 0.63) * 0.02;
      if (bodyRef.current) {
        // it leans into its own travel, and rides a hair up on each step
        bodyRef.current.rotation.z = -Math.max(-0.22, Math.min(0.22, s.vx * 0.07));
        bodyRef.current.position.y = breath + Math.abs(Math.sin(s.gait)) * 0.014 * Math.min(1, Math.abs(s.vx));
      }
      if (headRef.current) headRef.current.rotation.z = -s.a[0] * 0.18 + Math.sin(s.t * 0.9) * 0.035;

      const h = haloRef.current;
      if (h) {
        // A real shadow is a hard core inside a soft spread, and it is the spread
        // that swells as the figure walks into the flame.
        const bloom = lerp(0.9, 1.9, clamp01(near)) * lerp(1.5, 1, sharp);
        h.scale.set(0.62 * bloom, 1.15 * bloom, 1);
      }
      if (haloMatRef.current) {
        haloMatRef.current.opacity = (0.12 + 0.24 * clamp01(near)) * (1 - sharp * 0.45) * (1 - met);
      }
    },
  }));

  return (
    <group ref={rootRef}>
      <mesh ref={haloRef} position={[0, 0.04, -0.02]} geometry={haloGeo}>
        <meshBasicMaterial ref={haloMatRef} map={DUST_TEX} color="#1d1109" transparent opacity={0} depthWrite={false} />
      </mesh>
      <group ref={bodyRef}>
        <group ref={headRef} position={[0, 0.29, 0]}>
          <mesh geometry={headGeo} material={ink} />
          {hat ? <mesh geometry={hatGeo} position={[0, 0.11, 0]} material={ink} /> : null}
        </group>
        <mesh geometry={torsoGeo} position={[0, 0.05, 0]} material={ink} />
        <group ref={armRef} position={[-0.05, 0.19, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
        <group ref={arm2Ref} position={[0.05, 0.19, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
        <group ref={legRef} position={[-0.04, -0.11, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
        <group ref={leg2Ref} position={[0.04, -0.11, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
      </group>
      {/* the rod the puppeteer holds — hung off its own slack hinge, so its shadow
          keeps swaying below long after the figure above it has settled */}
      <group ref={rodRef} position={[0, -0.24, 0]}>
        <mesh geometry={rodGeo} position={[0, -0.54, 0]} material={ink} />
      </group>
    </group>
  );
});

/* ---------- the words, written by a wipe ---------- */
// The overlap does not crossfade in — a light source travels out from the join and
// the message is simply what it leaves behind, brightest right at the front. One
// tiny ShaderMaterial buys that; a basic material cannot mask along an axis at all.
const WIPE_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const WIPE_FRAG = `
uniform sampler2D uMap;
uniform float uWipe;
uniform float uAlpha;
uniform vec3 uGlow;
varying vec2 vUv;
void main() {
  float d = abs(vUv.x - 0.5) * 2.0; // 0 at the join the two shadows share
  float m = smoothstep(uWipe, uWipe - 0.22, d);
  float edge = m * smoothstep(uWipe - 0.34, uWipe - 0.02, d);
  vec4 t = texture2D(uMap, vUv);
  gl_FragColor = vec4(mix(t.rgb, uGlow, edge * 0.75), t.a * m * uAlpha);
  gl_FragColor = linearToOutputTexel(gl_FragColor);
}
`;

/* ---------- opening ---------- */
const MEET_TRAVEL = 1.9; // world units of drag that walk your puppet to the middle
const RESOLVE = 0.9; // seconds from the meeting to the words
const WIPE_T0 = 0.32; // the light starts out of the join here…
const WIPE_T1 = 1.4; // …and has cleared the sheet here
const NAME_T0 = 0.95;
const POST_END = 2.4;
const CAM_Z = 2.55;
// A gift may never lock waiting for a gesture, and this scene is also the gallery
// card's whole loop, which has no hands in it at all. Left alone this long, your
// puppet starts across the lit sheet by itself — driven through the same `walk` the
// drag writes to, so it is the same walk, the same limb swing, the same beats in the
// same order, and not a second timeline running beside the first.
const MERCY0 = 2.4; // long enough that a hand about to move is never overridden
const MERCY1 = 5.9; // …and the two have met by here, so the words land around 8.3s

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

/** Theirs never walks on rails: it comes on quickly, notices, slows hard, and holds
 *  a beat just short of contact before closing the last of the gap. */
function approach(w: number): number {
  if (w < 0.62) return smooth(w / 0.62) * 0.62;
  if (w < 0.78) return 0.62 + (w - 0.62) * 0.15;
  return 0.644 + easeOutCubic((w - 0.78) / 0.22) * 0.356;
}

export default function ShadowPlayScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const lamp = LAMPS[variants.lamp] ?? LAMPS.oil;
  const screen = SCREENS[variants.screen] ?? SCREENS.linen;

  const screenTex = useMemo(
    () => buildScreen(screen.tint, screen.weave, screen.grain, lamp.warm, lamp.spread),
    [screen, lamp],
  );
  useEffect(() => () => screenTex.dispose(), [screenTex]);

  // Segmented, and carrying a colour attribute: the cloth's wave is written into
  // per-vertex brightness rather than into geometry we would then have to light.
  const screenGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(SCREEN_W, SCREEN_H, SEG_X, SEG_Y);
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(VERTS * 3).fill(1), 3));
    return g;
  }, []);
  useEffect(() => () => screenGeo.dispose(), [screenGeo]);

  // DoubleSide is load-bearing: the puppets turn about their own vertical axis to
  // face each other, and past a quarter turn we are looking at the leather's back.
  const ink = useMemo(
    () => new THREE.MeshBasicMaterial({ color: "#1a0f08", transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    [],
  );
  useEffect(() => () => ink.dispose(), [ink]);

  /* The words are written with absence: dark where the two outlines overlap. */
  const text = useMemo(() => {
    const body = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    const msg = makeTextTexture(body, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "700",
      fontSize: 82,
      color: "#150c06",
      maxWidthPx: 82 * 9,
      lineHeight: 1.3,
      padding: 24,
      lang,
    });
    const mk = (n: string) =>
      makeTextTexture(n || "—", {
        fontFamily: "Georgia, serif",
        fontWeight: "600",
        fontSize: 40,
        color: "#150c06",
        maxWidthPx: 40 * 9,
        padding: 10,
        lang,
      });
    const a = mk(recipientName);
    const b = mk(senderName);
    return {
      msg,
      a,
      b,
      msgSize: fitPlane(msg.aspect, SCREEN_W * 0.72, SCREEN_H * 0.5),
      aSize: fitPlane(a.aspect, 0.5, 0.1),
      bSize: fitPlane(b.aspect, 0.5, 0.1),
    };
  }, [message, senderName, recipientName, lang]);
  useEffect(
    () => () => {
      text.msg.texture.dispose();
      text.a.texture.dispose();
      text.b.texture.dispose();
    },
    [text],
  );

  const wipeMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: text.msg.texture },
          uWipe: { value: 0 },
          uAlpha: { value: 0 },
          uGlow: { value: new THREE.Color(lamp.core) },
        },
        vertexShader: WIPE_VERT,
        fragmentShader: WIPE_FRAG,
        transparent: true,
        depthWrite: false,
      }),
    [text, lamp],
  );
  useEffect(() => () => wipeMat.dispose(), [wipeMat]);

  const dust = useMemo(() => {
    const rand = mulberry32(1729);
    const pos = new Float32Array(DUST * 3);
    const spd = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      pos[i * 3] = (rand() - 0.5) * SCREEN_W;
      pos[i * 3 + 1] = (rand() - 0.5) * SCREEN_H;
      pos[i * 3 + 2] = 0.1 + rand() * 0.5;
      spd[i] = 0.02 + rand() * 0.06;
    }
    return { pos, spd };
  }, []);
  // The motes' own drift is sim state, not a buffer, so it lives where the lint can
  // see it being written: positions go out through the points ref, this stays here.
  const air = useRef({ vx: new Float32Array(DUST), vy: new Float32Array(DUST) });

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const g = useRef({
    walk: 0,
    shown: 0,
    sv: 0,
    vel: 0,
    drag: 0,
    ty: 0,
    y: 0,
    metAt: -1,
    hesAt: -1,
    wipeAt: -1,
    down: false,
    px: 0,
    touched: false,
    alone: 0,
    hover: 0,
    gut: 0,
    gutAmp: 0,
    gutNext: 0,
    ax: 0,
    bx: 0,
    seen: false,
    burst: 0,
  });
  useEffect(() => {
    const c = g.current;
    if (phase === "opening") {
      c.walk = c.shown = c.sv = c.vel = c.drag = c.ty = c.y = 0;
      c.metAt = c.hesAt = c.wipeAt = -1;
      c.down = c.touched = false;
      c.alone = 0;
      c.hover = 0;
      c.seen = false;
      c.burst = 0;
    }
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const screenRef = useRef<THREE.Mesh>(null);
  const yoursRef = useRef<PuppetHandle>(null);
  const theirsRef = useRef<PuppetHandle>(null);
  const glowRef = useRef<THREE.PointLight>(null);
  const msgRef = useRef<THREE.Mesh>(null);
  const nameRefs = useRef<(THREE.Mesh | null)[]>([]);
  const nameMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const dustRef = useRef<THREE.Points>(null);
  const dustMatRef = useRef<THREE.PointsMaterial>(null);
  const joinRef = useRef<THREE.Mesh>(null);
  const joinMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const washMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintRef = useRef<THREE.Mesh>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.metAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    // the rod taken up off the boards — once, on the first grab, not on every re-grip
    if (!g.current.touched) clack({ freq: 880, decay: 0.07, gain: 0.14 });
    g.current.down = true;
    g.current.touched = true;
    g.current.alone = 0;
    g.current.px = ev.point.x;
    g.current.ty = Math.max(-0.42, Math.min(0.34, ev.point.y));
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (phase !== "opening") return;
    // a hand moving over the sheet without pressing is a desktop hand, and the
    // puppet answers it before it ever lands
    if (!c.down) {
      c.hover = 1;
      return;
    }
    if (c.walk >= 1) return;
    ev.stopPropagation();
    // Toward the middle walks it on; away lets it back off, so the walk is a walk
    // and not a ratchet. A quick shove buys a little more than a slow one — the
    // figure has mass and you can feel it once you throw it.
    const dx = c.px - ev.point.x;
    c.walk = clamp01(c.walk + (dx / MEET_TRAVEL) * (1 + Math.min(0.6, Math.abs(c.vel) * 0.35)));
    c.drag += dx;
    c.px = ev.point.x;
    // and up-screen is toward the flame, which is what makes the shadow bloom
    c.ty = Math.max(-0.42, Math.min(0.34, ev.point.y));
    // A hand that is working the rod owns the pace: the mercy walk below only gets
    // it back once that hand has gone still. A bare hover does not count — it is
    // answered by the lean and the hint instead, and letting it hold the clock open
    // would mean a cursor parked on the sheet could stall the gift for good.
    c.alone = 0;
  };
  const stop = () => {
    g.current.down = false;
    g.current.hover = 0;
  };
  const onOver = () => {
    if (phase === "opening") g.current.hover = 1;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = g.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.6, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- the lamp, guttering on nobody's schedule ---- */
    // A flame does not tick. It catches, flares, and falls back at intervals the
    // draught decides, so the next one is drawn the moment the last one lands.
    if (e > c.gutNext) {
      c.gutAmp = 0.3 + Math.random() * 0.7;
      c.gutNext = e + 0.25 + (Math.random() * 2.6) / lamp.rate;
    }
    c.gut += (c.gutAmp - c.gut) * Math.min(1, dt * 14);
    c.gutAmp *= Math.exp(-dt * 2.4);

    /* ---- how far the pair has closed ---- */
    let walk: number;
    if (phase === "opening") {
      // momentum: let go mid-shove and the figure coasts on and settles, it does
      // not stop dead the instant the finger leaves the glass
      if (c.down) {
        c.vel = c.drag / Math.max(dt, 1e-3);
        c.drag = 0;
      } else {
        c.walk = clamp01(c.walk + c.vel * dt * 0.42);
        c.vel *= Math.exp(-dt * 3.1);
      }
      // Nobody has taken the rod: the puppet goes across on its own. A floor under
      // `walk` that only ever rises, laid *after* the coast and its decay above so
      // neither can argue with it, and eased in so the first steps are slow — the
      // gait is distance walked, so this reads as the figure deciding to set off
      // rather than as a timer running out. A real drag zeroes `alone` and is well
      // ahead of the floor anyway, so a hand always wins and is never pulled back.
      c.alone += dt;
      c.walk = Math.max(c.walk, smooth(clamp01((c.alone - MERCY0) / (MERCY1 - MERCY0))));
      if (c.walk >= 1 && c.metAt < 0) {
        c.metAt = tRef.current;
        c.burst = 1;
        tone(392, { type: "triangle", seconds: 1.1, gain: 0.2, shimmer: true });
      }
      if (c.walk > 0.63 && c.hesAt < 0) {
        c.hesAt = tRef.current;
        clack({ freq: 560, decay: 0.09, gain: 0.11 }); // theirs checks its step
      }
      walk = c.walk;
    } else if (phase === "sealed") {
      walk = 0;
    } else if (phase === "preview") {
      // one still waiting, one nearly there, forever
      walk = 0.58 + Math.sin(e * 0.55) * 0.24 + Math.sin(e * 1.9) * 0.02;
    } else {
      walk = 1;
    }

    // Resistance and overshoot: the figure is on the end of a rod, not on rails, so
    // what you drag is a target and what you see is the thing chasing it.
    if (phase === "opening") {
      c.sv += ((c.walk - c.shown) * 88 - c.sv * 12) * dt;
      c.shown += c.sv * dt;
    } else {
      c.shown = walk;
      c.sv = 0;
    }
    const sw = clamp01(c.shown);

    const post = phase === "revealed" ? POST_END : c.metAt >= 0 ? tRef.current - c.metAt : -1;
    const resolve = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / RESOLVE));
    const wipe = post < 0 ? 0 : 1.3 * easeOutCubic(clamp01((post - WIPE_T0) / (WIPE_T1 - WIPE_T0)));
    if (phase === "opening" && post >= WIPE_T0 && c.wipeAt < 0) {
      c.wipeAt = post;
      tone(587.33, { type: "sine", seconds: 1.6, gain: 0.13, shimmer: true });
    }

    /* ---- the two walk toward each other; theirs starts off-frame ---- */
    // The overlap does not darken: as the two meet they shrink away into the shape
    // the words take, which is the same ink and the same place on the sheet.
    const shrink = 1 - resolve * 0.9;
    // contact recoil, then a damped decaying sine settling out of it
    const bump = post < 0 ? 0 : Math.exp(-post * 6.5) * Math.sin(post * 34) * 0.055;
    // and a wind-up just short of contact, so the last of the gap is closed and not crossed
    const anticip = 0.035 * Math.sin(clamp01((sw - 0.86) / 0.14) * Math.PI);
    // Before the first touch it leans toward wherever the pointer is, and stops the
    // instant the finger lands. It also has to stand down as the mercy walk takes
    // over — a glint and a hint still asking for a hand while the puppet is already
    // walking would burn through the whole auto-reveal. It fades out over the same
    // beat the floor fades in, so nothing snaps.
    const invite =
      phase === "opening" && !c.touched ? 1 - smooth(clamp01((c.alone - MERCY0) / 0.6)) : 0;
    const lean = invite * state.pointer.x * 0.06;

    c.y += (c.ty - c.y) * Math.min(1, dt * 3.4);
    const ay = 0.06 + c.y * 0.55 + (phase === "opening" ? c.hover * 0.012 : 0);
    const ax = lerp(SCREEN_W * 0.36, 0.1, sw) * shrink + bump + anticip + lean;
    const app = approach(sw);
    const by = lerp(0.02, ay, smooth(app)) + Math.sin(e * 0.7) * 0.006;
    const bx = lerp(-SCREEN_W * 0.78, -0.1, app) * shrink - bump;

    // distance to the flame, which is what sets both size and how far the penumbra runs
    const nearA = clamp01(1 - Math.hypot(ax, (ay - LAMP_CY) * 1.4) / (SCREEN_W * 0.6));
    const nearB = clamp01(1 - Math.hypot(bx, (by - LAMP_CY) * 1.4) / (SCREEN_W * 0.6));
    // a steady flame throws a hard edge; a guttering one smears every shadow at once
    const sharp = clamp01(lamp.sharp * (1 - 0.45 * c.gut) + resolve * 0.35);

    // theirs turns to square up as it closes, and glances back over the hesitation
    const faceB = Math.PI + 0.44 * (1 - smooth(clamp01((sw - 0.4) / 0.42))) + 0.14 * Math.sin(sw * 26) * clamp01((sw - 0.6) / 0.12) * (1 - smooth(clamp01((sw - 0.62) / 0.2)));
    yoursRef.current?.pose(ax, ay, nearA, resolve, -0.22 * sw + lean * 1.6, sharp, dt);
    theirsRef.current?.pose(bx, by, nearB, resolve, faceB, sharp, dt);

    const spA = c.seen ? Math.max(-4, Math.min(4, (ax - c.ax) / Math.max(dt, 1e-3))) : 0;
    const spB = c.seen ? Math.max(-4, Math.min(4, (bx - c.bx) / Math.max(dt, 1e-3))) : 0;
    c.ax = ax;
    c.bx = bx;
    c.seen = true;

    /* ---- the words, arriving on a travelling wipe ---- */
    const mm = msgRef.current?.material as THREE.ShaderMaterial | undefined;
    if (mm) {
      mm.uniforms.uWipe.value = wipe;
      mm.uniforms.uAlpha.value = phase === "preview" ? 0 : clamp01(post / 0.2) * 0.96;
    }
    const nameT = post < 0 ? 0 : clamp01((post - NAME_T0) / 0.6);
    for (let i = 0; i < 2; i++) {
      const k = clamp01(nameT - i * 0.12) / (1 - 0.12);
      const m = nameMats.current[i];
      const o = nameRefs.current[i];
      if (m) m.opacity = smooth(clamp01(k)) * 0.9;
      if (o) {
        // they rise into the rods' shadows and settle back, rather than fading up
        const b = easeOutBack(clamp01(k));
        o.position.y = -SCREEN_H * 0.38 + (b - 1) * 0.05;
        o.position.x = (i === 0 ? -0.62 : 0.62) + Math.sin(e * 0.8 + i * 2.1) * 0.005;
        o.scale.setScalar(0.72 + 0.28 * b);
      }
    }

    /* ---- the light, and what the contact does to it ---- */
    const flare = post < 0 ? 0 : Math.exp(-post * 3.2) * 0.6;
    const micro = 1 - lamp.gutter * 0.25 * (0.5 + 0.5 * Math.sin(e * lamp.rate * 3.1)) * (1 - resolve);
    const flick = (1 - lamp.gutter * c.gut * (1 - resolve * 0.9)) * micro;
    if (glowRef.current) glowRef.current.intensity = 0.9 * flick + 0.35 * resolve + flare * 1.4;
    if (washMatRef.current) washMatRef.current.opacity = flare * 0.5 + resolve * 0.1;
    if (joinRef.current && joinMatRef.current) {
      // the ink pools where the two outlines cross, swells, and is eaten by the wipe
      const pool = post < 0 ? 0 : smooth(clamp01(post / 0.22)) * Math.exp(-Math.max(0, post - 0.22) * 1.7) * clamp01(1.15 - wipe);
      joinRef.current.scale.setScalar(0.26 + pool * 0.8);
      joinMatRef.current.opacity = pool * 0.6;
    }

    /* ---- the linen: a slow wave, and it bellies where a puppet crowds it ---- */
    const sg = screenRef.current?.geometry;
    if (sg) {
      const pos = sg.attributes.position as THREE.BufferAttribute;
      const col = sg.attributes.color as THREE.BufferAttribute;
      // capped so the sheet's belly can never poke through the figures standing off it
      const amp = 0.016 * screen.sway;
      const w1 = e * 0.9 * screen.sway;
      const w2 = e * 0.62 * screen.sway;
      // a glint travelling the sheet until someone takes the hint
      const glint = invite > 0.002 ? invite * (0.22 + 0.1 * Math.sin(e * 2.6)) : 0;
      const gx = Math.sin(e * 0.75) * SCREEN_W * 0.42;
      // the bigger a figure looms and the harder it is travelling, the more of the
      // cloth it drags after it
      const pushA = (0.4 + 0.6 * nearA) * (0.55 + 0.45 * Math.min(1, Math.abs(spA))) * 0.5;
      const pushB = (0.4 + 0.6 * nearB) * (0.55 + 0.45 * Math.min(1, Math.abs(spB))) * 0.5;
      for (let ix = 0; ix <= SEG_X; ix++) {
        const wx = SCREEN_W * (ix / SEG_X - 0.5);
        const da = wx - ax;
        const db = wx - bx;
        COL_S1[ix] = Math.sin(wx * 2.1 + w1);
        COL_S3[ix] = Math.sin(wx * 4.3 - w2 * 1.7);
        COL_A[ix] = Math.exp(-da * da * 4.2) * pushA;
        COL_B[ix] = Math.exp(-db * db * 4.2) * pushB;
        COL_G[ix] = glint > 0 ? glint * Math.exp(-(wx - gx) * (wx - gx) * 7) : 0;
        COL_X2[ix] = wx * wx;
      }
      const lit = flare > 0.002;
      for (let iy = 0; iy <= SEG_Y; iy++) {
        const wy = SCREEN_H * (0.5 - iy / SEG_Y);
        const s2 = Math.sin(wy * 1.7 - w2) * 0.7;
        const ra = Math.sin(wy * 2.6 + e * 2.4 + spA);
        const rb = Math.sin(wy * 2.6 + e * 2.1 + spB);
        const dy2 = (wy - LAMP_CY) * (wy - LAMP_CY);
        const row = iy * (SEG_X + 1);
        for (let ix = 0; ix <= SEG_X; ix++) {
          const wv = COL_S1[ix] * s2 + COL_S3[ix] * 0.3 + COL_A[ix] * ra + COL_B[ix] * rb;
          const i = row + ix;
          pos.setZ(i, wv * amp);
          // the wave is read as brightness, not as shading: a lit sheet ripples in
          // light, and nothing here has a normal worth lighting anyway
          const b =
            flick * (1 + wv * 0.15) +
            (lit ? flare * Math.exp(-(COL_X2[ix] + dy2) * 0.9) : 0) +
            COL_G[ix];
          col.setXYZ(i, b, b * 0.99, b * 0.965);
        }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    /* ---- dust in the beam, stirred by whatever walks through it ---- */
    if (dustRef.current) {
      const arr = dustRef.current.geometry.attributes.position;
      const a = air.current;
      for (let i = 0; i < DUST; i++) {
        let x = arr.getX(i);
        let y = arr.getY(i);
        // the beam's own convection
        let tx = Math.sin(e * 0.6 + i * 1.7) * 0.025;
        let ty = dust.spd[i];
        // a figure passing drags the air round with it, and the wake outlives the pass
        const dxa = x - ax;
        const dya = y - ay;
        const ra = dxa * dxa + dya * dya;
        if (ra < 0.3) {
          const f = (1 - ra / 0.3) * spA;
          tx += -dya * f * 1.6 + f * 0.5;
          ty += dxa * f * 1.6;
        }
        const dxb = x - bx;
        const dyb = y - by;
        const rb = dxb * dxb + dyb * dyb;
        if (rb < 0.3) {
          const f = (1 - rb / 0.3) * spB;
          tx += -dyb * f * 1.6 + f * 0.5;
          ty += dxb * f * 1.6;
        }
        if (c.burst > 0 && ra < 0.9) {
          // the moment of contact throws the motes off the join
          const inv = 1 / Math.max(0.08, Math.sqrt(ra));
          a.vx[i] += dxa * inv * 0.75;
          a.vy[i] += dya * inv * 0.75 + 0.15;
        }
        const k = Math.min(1, dt * 3.2);
        a.vx[i] += (tx - a.vx[i]) * k;
        a.vy[i] += (ty - a.vy[i]) * k;
        x += a.vx[i] * dt;
        y += a.vy[i] * dt;
        if (y > SCREEN_H / 2) y = -SCREEN_H / 2;
        else if (y < -SCREEN_H / 2) y = SCREEN_H / 2;
        if (x > SCREEN_W / 2) x = -SCREEN_W / 2;
        else if (x < -SCREEN_W / 2) x = SCREEN_W / 2;
        arr.setX(i, x);
        arr.setY(i, y);
      }
      arr.needsUpdate = true;
    }
    c.burst = 0;
    if (dustMatRef.current) dustMatRef.current.opacity = 0.24 + 0.2 * flick + flare * 0.45;

    /* ---- the invitation, and the hand hovering over it ---- */
    c.hover *= Math.exp(-dt * 1.6);
    if (hintRef.current) hintRef.current.position.y = 0.06 + Math.sin(e * 1.4) * 0.05;
    if (hintMatRef.current) {
      const want = invite * (0.28 + 0.18 * Math.sin(e * 2.8) + c.hover * 0.3);
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- camera: a slow push into the join, settling as the words land ---- */
    const cam = camRef.current;
    if (cam) {
      const push = phase === "revealed" ? 0.21 : phase === "opening" ? sw * 0.09 + resolve * 0.12 : 0;
      const tx = Math.sin(e * 0.13) * 0.035;
      const ty = 0.02 * Math.sin(e * 0.19) + resolve * 0.015;
      if (phase === "opening") {
        const k = Math.min(1, dt * 2.4);
        cam.position.x = lerp(cam.position.x, tx, k);
        cam.position.y = lerp(cam.position.y, ty, k);
        cam.position.z = lerp(cam.position.z, CAM_Z - push, k);
      } else {
        // the settled tableaux are framed cold — reduced motion lands on this frame
        cam.position.set(tx, ty, CAM_Z - push);
      }
      cam.lookAt(0, 0, 0);
      // the contact's jolt goes on after the aim, so the frame kicks without the
      // whole shot swinging round to follow it
      cam.position.x += bump * 0.5;
      cam.position.y += bump * 0.22;
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, 0, CAM_Z]} fov={44} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.9} />
      <pointLight ref={glowRef} position={[0, LAMP_CY, -1.4]} intensity={0.9} color={lamp.core} distance={7} decay={1.3} />

      {/* the dark theatre around the sheet */}
      <mesh position={[0, 0, -0.5]}>
        <planeGeometry args={[14, 10]} />
        <meshBasicMaterial color="#0b0705" depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        {/* the screen — one quad, lit from behind, and everything else is a silhouette on it */}
        <mesh ref={screenRef} geometry={screenGeo}>
          <meshBasicMaterial map={screenTex} vertexColors toneMapped={false} />
        </mesh>
        {/* batten and frame */}
        <mesh position={[0, SCREEN_H / 2 + 0.045, 0.02]}>
          <planeGeometry args={[SCREEN_W + 0.16, 0.09]} />
          <meshBasicMaterial color="#2a1a10" />
        </mesh>
        <mesh position={[0, -SCREEN_H / 2 - 0.045, 0.02]}>
          <planeGeometry args={[SCREEN_W + 0.16, 0.09]} />
          <meshBasicMaterial color="#2a1a10" />
        </mesh>

        {/* the light that spills through as the shadows come apart */}
        <mesh position={[0, LAMP_CY, 0.1]}>
          <planeGeometry args={[SCREEN_W * 1.1, SCREEN_H * 1.1]} />
          <meshBasicMaterial
            ref={washMatRef}
            map={DUST_TEX}
            color={lamp.core}
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>

        {/* the words, in shadow, where the overlap was */}
        <mesh ref={msgRef} position={[0, 0.04, 0.08]} material={wipeMat}>
          <planeGeometry args={text.msgSize} />
        </mesh>

        {/* both names, down in the rods' shadows */}
        <mesh
          ref={(m) => {
            nameRefs.current[0] = m;
          }}
          position={[-0.62, -SCREEN_H * 0.38, 0.08]}
        >
          <planeGeometry args={text.bSize} />
          <meshBasicMaterial
            ref={(m) => {
              nameMats.current[0] = m;
            }}
            map={text.b.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh
          ref={(m) => {
            nameRefs.current[1] = m;
          }}
          position={[0.62, -SCREEN_H * 0.38, 0.08]}
        >
          <planeGeometry args={text.aSize} />
          <meshBasicMaterial
            ref={(m) => {
              nameMats.current[1] = m;
            }}
            map={text.a.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        {/* the puppets, a hair in front of the sheet */}
        <group position={[0, 0, 0.07]}>
          <Puppet ref={yoursRef} hat ink={ink} />
          <Puppet ref={theirsRef} hat={false} ink={ink} />
          {/* where the two outlines cross */}
          <mesh ref={joinRef} position={[0, 0.06, 0.004]} geometry={haloGeo}>
            <meshBasicMaterial ref={joinMatRef} map={DUST_TEX} color="#160c06" transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>

        {/* dust in the beam */}
        <points ref={dustRef} position={[0, 0, 0.12]} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[dust.pos, 3]} />
          </bufferGeometry>
          <pointsMaterial
            ref={dustMatRef}
            map={DUST_TEX}
            color={lamp.core}
            size={0.035}
            sizeAttenuation
            transparent
            opacity={0.4}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>

        <mesh ref={hintRef} position={[SCREEN_W * 0.34, 0.06, 0.14]}>
          <planeGeometry args={[0.6, 0.9]} />
          <meshBasicMaterial ref={hintMatRef} map={DUST_TEX} color={lamp.core} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh
          position={[0, 0, 0.6]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={stop}
          onPointerCancel={stop}
          onPointerOver={onOver}
          onPointerOut={stop}
        >
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
