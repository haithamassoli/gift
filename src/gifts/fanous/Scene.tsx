import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import {
  clamp01,
  easeOutBack,
  easeOutCubic,
  lerp,
  mulberry32,
  smooth,
} from "../math";
import { forRecipient } from "../../i18n";

/* ============================================================================
   FANOUS — the Ramadan lantern. The message becomes LIGHT itself, thrown
   through pierced brass onto a stone wall. Drag the little glass door open,
   press-and-hold to light the wick, then the walls learn your words.

   There is no SpotLight cookie in this stack, so the projection is faked the
   house way: the pierced pattern and the message are drawn to CanvasTextures
   and mapped on ADDITIVE, warm-tinted planes that sit just off the stone wall
   behind the lantern. Early the lantern turns and throws its lace across the
   stone; then the perforations "align" — the lace fades and the message plane
   de-skews into place until the words read.
   ========================================================================== */

/* ---------- variants: glass tint, and the shape the light throws ---------- */
type GlassPal = { glass: string; halo: string; rim: string };
// The glass pane colour tints the chamber, the flame's halo and the lantern's
// own glow. The PROJECTED light stays warm regardless (see PROJ_WARM): a green
// or red word washed onto dark stone is unreadable, and a real fanous throws a
// warm candle glow whatever the glass — the colour lives in the lantern, the
// legibility lives on the wall.
const GLASS: Record<string, GlassPal> = {
  amber: { glass: "#e8901f", halo: "#ffbf63", rim: "#5a3e14" },
  emerald: { glass: "#12a06a", halo: "#5fe0a8", rim: "#0d3a2a" },
  ruby: { glass: "#c62a4c", halo: "#ff728c", rim: "#4a1020" },
};
const PROJ_WARM = "#ffd7a0"; // the candlelight itself, on the stone
const BRASS = "#c08a2e";
const BRASS_DARK = "#7a5418";

type PatternKind = "stars" | "arabesque" | "crescents";
const PATTERNS: Record<string, PatternKind> = {
  stars: "stars",
  arabesque: "arabesque",
  crescents: "crescents",
};

/* ---------- stage geometry (all fixed: the camera never orbits) ---------- */
const FOV = 42;
const CAM_Z = 5.0;
const WALL_Z = -3.0;
const LANTERN_Y = -0.72; // hangs so the chamber centre sits near screen centre

// the light chamber, in lantern-local space (foot of the lantern at y = 0)
const CH_Y0 = 0.3;
const CH_Y1 = 1.1;
const CH_H = CH_Y1 - CH_Y0;
const CH_CY = (CH_Y0 + CH_Y1) / 2;
const CH_R = 0.4; // the tinted glass cylinder
const CAGE_R = 0.435; // the pierced brass over it
const DOOR_ARC = 1.18; // radians of the front the door occupies
// The door hinges on its left edge. A cylinder section is centred on the
// lantern axis, so to swing it on an edge we hang it in a group pinned at that
// edge and translate the geometry back onto the axis inside — then the group's
// own rotation.y opens the door about the hinge.
const HINGE_A = Math.PI / 2 + DOOR_ARC / 2; // front faces +z (θ = π/2); left edge is the far side of the arc
const HINGE_X = CAGE_R * Math.cos(HINGE_A);
const HINGE_Z = CAGE_R * Math.sin(HINGE_A);
const DOOR_MAX = 1.25; // radians the door swings when fully pried open

/* ---------- opening timeline (seconds) ---------- */
// A gift may never outlast ~12s untouched, and the bound is on onOpenComplete.
// The whole no-input show is the budget, so it is kept well short of it: the
// door opens itself by ~2.4s, the wick lights itself by ~4.4s, and TAU_HOLD is
// 4.6s → done near t = 9. The remaining slack is deliberate — `dt` is clamped
// to 0.05, so on a phone dropping frames this clock runs behind the wall clock
// the bound is measured on, and the show has seconds to spare.
const T_DOOR0 = 1.6; // the door begins easing open on its own here…
const T_DOOR_RAMP = 1.3; // …reaching wide open ~2.9s, if no one drags it first
const DOOR_OPEN_THRESH = 0.82; // "open enough to reach the wick"
const T_HOLD_LAG = 0.7; // the wick starts catching on its own this long after the door opens
const T_HOLD_RAMP = 1.3;
const HOLD_FILL = 1.15; // seconds of held pressure to light the wick
const HOLD_DECAY = 1.6; // and how fast the ember cools if they let go early
const SPIN_ANG = Math.PI * 3.5; // 1.75 turns of decelerating spin as the lace sweeps
const SPIN_T = 3.0; // …braking to a stop, front-forward, by here
const RES0 = 1.9; // the lace begins resolving into words
const RES1 = 3.3; // …and the message is fully aligned by here
const TAU_HOLD = 4.6; // the reveal clock pins here; the flip to "revealed" is seamless

/* ---------- shared, module-level resources (never per-instance state) ---------- */
const glowTex = makeRadialSprite();

// A metal with nothing around it renders black under direct lights — it needs
// something to reflect. Twenty lines of warm-alcove canvas is the difference
// between brass and grey plastic (same trick as the magic lamp's stall).
function buildEnvTexture(): THREE.Texture {
  const W = 256,
    H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#4a3016"); // the niche's warm vault
  sky.addColorStop(0.5, "#1a120c");
  sky.addColorStop(1, "#070506"); // the stone floor
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(64, 34, 40, "#ffdca0"); // a lantern burning across the alley
  blob(190, 46, 30, "#3a4b66"); // cold night at the arch's mouth
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const envTex = buildEnvTexture();

// dark, mottled sandstone for the alcove wall
function buildWallTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0d0a0b";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(4711);
  // faint blocky courses of stone, then a warm central bounce so the wall is
  // not a flat void even before the lantern lights
  g.strokeStyle = "rgba(60,44,34,0.35)";
  g.lineWidth = 1;
  for (let y = 16; y < S; y += 22) {
    g.beginPath();
    g.moveTo(0, y + (rand() - 0.5) * 4);
    g.lineTo(S, y + (rand() - 0.5) * 4);
    g.stroke();
  }
  for (let i = 0; i < 90; i++) {
    const x = rand() * S,
      y = rand() * S,
      r = 2 + rand() * 9;
    const a = 0.04 + rand() * 0.1;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(70,52,38,${a})`);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const wallTex = buildWallTexture();

/* ---------- the pierced pattern, drawn once per motif ---------- */
// One motif function, two readings: as a HOLE in the brass (a black shape on a
// white field → an alphaMap where black is cut away) and as the LIGHT that hole
// lets through (a warm shape on a clear field → an additive projection). The
// two must be the same shape so what the wall shows is what the brass omits.
function drawMotif(
  g: CanvasRenderingContext2D,
  kind: PatternKind,
  cx: number,
  cy: number,
  r: number,
) {
  if (kind === "stars") {
    // the eight-point star — the workhorse of the craft
    const P = 8;
    g.beginPath();
    for (let i = 0; i < P * 2; i++) {
      const rr = i % 2 ? r * 0.42 : r;
      const a = (i / (P * 2)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * rr,
        y = cy + Math.sin(a) * rr;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
    g.fill();
  } else if (kind === "crescents") {
    // a circle with an offset circle punched out of it, even-odd
    g.beginPath();
    g.arc(cx, cy - r * 0.05, r * 0.92, 0, Math.PI * 2);
    g.arc(cx + r * 0.5, cy - r * 0.12, r * 0.82, 0, Math.PI * 2, true);
    g.fill("evenodd");
    // a little star tucked in the crook, the way the flag carries one
    drawMotif(g, "stars", cx + r * 0.62, cy - r * 0.02, r * 0.22);
  } else {
    // arabesque: an eight-fold rosette of overlapping petals around a hub
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = cx + Math.cos(a) * r * 0.5,
        y = cy + Math.sin(a) * r * 0.5;
      g.beginPath();
      g.ellipse(x, y, r * 0.34, r * 0.16, a, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    g.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
    g.fill();
  }
}

// Tile the motif across a canvas. The cage repeats this map many times around
// the cylinder (repeat.set below), so a 2×2 tile is plenty of variety.
function paintMotifField(
  g: CanvasRenderingContext2D,
  kind: PatternKind,
  S: number,
  glow: boolean,
) {
  const GRID = 2;
  const cell = S / GRID;
  const r = cell * 0.34;
  for (let gy = 0; gy < GRID; gy++)
    for (let gx = 0; gx < GRID; gx++) {
      // brick offset every other row, the way a real pierced screen staggers
      const off = gy % 2 ? cell * 0.5 : 0;
      const cx = ((gx + 0.5) * cell + off) % S;
      const cy = (gy + 0.5) * cell;
      if (glow) {
        // soften the projected light — a real cast shape has no hard edge
        g.shadowColor = PROJ_WARM;
        g.shadowBlur = cell * 0.16;
      }
      drawMotif(g, kind, cx, cy, r);
    }
}

interface PatternTextures {
  cageAlpha: THREE.CanvasTexture; // white = brass, black = hole
  projTex: THREE.CanvasTexture; // warm holes on clear, for the wall
}
function buildPattern(kind: PatternKind): PatternTextures {
  const S = 256;

  const ca = document.createElement("canvas");
  ca.width = ca.height = S;
  const gc = ca.getContext("2d")!;
  gc.fillStyle = "#fff"; // solid brass everywhere…
  gc.fillRect(0, 0, S, S);
  gc.fillStyle = "#000"; // …minus the holes
  paintMotifField(gc, kind, S, false);
  const cageAlpha = new THREE.CanvasTexture(ca);
  cageAlpha.wrapS = cageAlpha.wrapT = THREE.RepeatWrapping;
  cageAlpha.repeat.set(6, 2); // six panels of lace around, two courses tall

  const pc = document.createElement("canvas");
  pc.width = pc.height = S;
  const gp = pc.getContext("2d")!;
  gp.clearRect(0, 0, S, S);
  gp.fillStyle = PROJ_WARM;
  paintMotifField(gp, kind, S, true);
  const projTex = new THREE.CanvasTexture(pc);
  projTex.wrapS = projTex.wrapT = THREE.RepeatWrapping;
  projTex.repeat.set(5, 3);

  return { cageAlpha, projTex };
}

/* ---------- the brass, lathed ---------- */
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
// the base cup the chamber sits in — a turned foot flaring up to the rim
const BASE_PROFILE = [
  V2(0.0, 0.0),
  V2(0.2, 0.0),
  V2(0.26, 0.02),
  V2(0.235, 0.05), // foot ring
  V2(0.28, 0.1),
  V2(0.36, 0.17),
  V2(0.41, 0.24),
  V2(0.44, 0.3), // up to the chamber's lip
  V2(0.43, 0.315),
];
const baseGeo = new THREE.LatheGeometry(BASE_PROFILE, 48);
// the shoulder and dome above the chamber, up to the finial neck
const CROWN_PROFILE = [
  V2(0.43, CH_Y1 - 0.005),
  V2(0.45, CH_Y1 + 0.02), // rim lip capping the chamber
  V2(0.4, CH_Y1 + 0.06),
  V2(0.33, CH_Y1 + 0.16),
  V2(0.24, CH_Y1 + 0.26),
  V2(0.15, CH_Y1 + 0.34),
  V2(0.08, CH_Y1 + 0.4),
  V2(0.04, CH_Y1 + 0.43),
  V2(0.032, CH_Y1 + 0.46),
];
const crownGeo = new THREE.LatheGeometry(CROWN_PROFILE, 48);

const finialGeo = new THREE.SphereGeometry(0.045, 14, 12);
const ringGeo = new THREE.TorusGeometry(0.07, 0.014, 8, 28); // the loop it hangs from
const chamberRingGeo = new THREE.TorusGeometry(CAGE_R, 0.02, 8, 40); // brass hoops top & bottom
const glassGeo = new THREE.CylinderGeometry(CH_R, CH_R, CH_H, 40, 1, true);
// the cage: the front arc is the door's, so this spans everything but that arc
const cageGeo = new THREE.CylinderGeometry(
  CAGE_R,
  CAGE_R,
  CH_H,
  40,
  1,
  true,
  HINGE_A, // start at the door's far (hinge) edge…
  Math.PI * 2 - DOOR_ARC, // …and run all the way round to its near edge
);
// the door's own curved sections — a pierced-brass panel with tinted glass behind
const doorCageGeo = new THREE.CylinderGeometry(
  CAGE_R,
  CAGE_R,
  CH_H,
  12,
  1,
  true,
  Math.PI / 2 - DOOR_ARC / 2,
  DOOR_ARC,
);
const doorGlassGeo = new THREE.CylinderGeometry(
  CH_R,
  CH_R,
  CH_H - 0.04,
  12,
  1,
  true,
  Math.PI / 2 - DOOR_ARC / 2,
  DOOR_ARC,
);
const wickGeo = new THREE.CylinderGeometry(0.012, 0.016, 0.09, 8);
const meterRingGeo = new THREE.RingGeometry(0.16, 0.185, 40);

/* ---------- rising embers ---------- */
const EMBER_N = 14;

export default function FanousScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const pal = GLASS[variants.glass] ?? GLASS.amber;
  const kind = PATTERNS[variants.pattern] ?? "stars";
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" on the gallery card and empty until the sender types, so
  // the wall falls back to the shared "For {name}" copy — the gift's signature
  // (the walls learning your words) has to read on the thumbnail too.
  const source = message.trim() || forRecipient(lang, recipientName);

  /* useMemo is load-bearing: it owns every canvas texture and material and the
     matching useEffect disposes them. */
  const pattern = useMemo(() => buildPattern(kind), [kind]);
  useEffect(
    () => () => {
      pattern.cageAlpha.dispose();
      pattern.projTex.dispose();
    },
    [pattern],
  );

  // the message, rasterized once, warm with a soft bloom so it reads as cast light
  const msg = useMemo(
    () =>
      makeTextTexture(source, {
        fontSize: 84,
        fontWeight: "600",
        color: "#ffe9c4",
        glow: 16,
        glowColor: PROJ_WARM,
        maxWidthPx: 1180,
        lineHeight: 1.35,
        lang,
      }),
    [source, lang],
  );
  useEffect(() => () => msg.texture.dispose(), [msg]);

  // both names, in a cartouche on the front pane (empty in the rare nameless case)
  const cartouche = useMemo(() => {
    const names = [recipientName.trim(), senderName.trim()]
      .filter(Boolean)
      .join("  ·  ");
    if (!names) return null;
    return makeTextTexture(names, {
      fontSize: 60,
      fontWeight: "600",
      color: "#fff0cf",
      glow: 10,
      glowColor: pal.halo,
      maxWidthPx: 620,
      lineHeight: 1.3,
      lang,
    });
  }, [recipientName, senderName, lang, pal]);
  useEffect(() => () => cartouche?.texture.dispose(), [cartouche]);

  // the brass, the glass and the pierced cage. Reached per-frame through the
  // *Ref bindings below, never through these memo variables — the memo owns
  // construction and disposal, the frame owns state.
  const mats = useMemo(() => {
    const brass = new THREE.MeshStandardMaterial({
      color: BRASS,
      roughness: 0.4,
      metalness: 0.95,
      envMap: envTex,
      envMapIntensity: 1.15,
      emissive: new THREE.Color(pal.halo),
      emissiveIntensity: 0,
    });
    const brassDark = new THREE.MeshStandardMaterial({
      color: BRASS_DARK,
      roughness: 0.55,
      metalness: 0.9,
      envMap: envTex,
      envMapIntensity: 1.0,
      emissive: new THREE.Color(pal.halo),
      emissiveIntensity: 0,
    });
    const cage = new THREE.MeshStandardMaterial({
      color: BRASS,
      roughness: 0.42,
      metalness: 0.95,
      envMap: envTex,
      envMapIntensity: 1.1,
      alphaMap: pattern.cageAlpha,
      transparent: true,
      alphaTest: 0.5, // crisp holes, not a soft fade
      side: THREE.DoubleSide,
      emissive: new THREE.Color(pal.halo),
      emissiveIntensity: 0,
    });
    // Tinted glass: dark and reflective at rest, glowing from within once lit.
    // The emissive is what "the flame behind the glass" is.
    const glass = new THREE.MeshStandardMaterial({
      color: pal.glass,
      roughness: 0.14,
      metalness: 0.0,
      envMap: envTex,
      envMapIntensity: 0.8,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
      emissive: new THREE.Color(pal.glass),
      emissiveIntensity: 0,
    });
    return { brass, brassDark, cage, glass };
  }, [pal, pattern]);
  useEffect(
    () => () => {
      mats.brass.dispose();
      mats.brassDark.dispose();
      mats.cage.dispose();
      mats.glass.dispose();
    },
    [mats],
  );

  const embers = useMemo(() => {
    const rand = mulberry32(9021);
    return {
      pos: new Float32Array(EMBER_N * 3),
      seed: Array.from({ length: EMBER_N }, () => ({
        x: (rand() - 0.5) * 0.22,
        z: (rand() - 0.5) * 0.22,
        sp: 0.12 + rand() * 0.16,
        ph: rand(),
        sway: rand() * Math.PI * 2,
      })),
    };
  }, []);

  /* ---------- refs: groups & meshes posed each frame ---------- */
  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const lanternRef = useRef<THREE.Group>(null);
  const doorRef = useRef<THREE.Group>(null);
  const flameRef = useRef<THREE.Group>(null);
  const wallRef = useRef<THREE.Mesh>(null);
  const patternProjRef = useRef<THREE.Mesh>(null);
  const messageProjRef = useRef<THREE.Mesh>(null);
  const meterRef = useRef<THREE.Group>(null);
  const meterSparkRef = useRef<THREE.Sprite>(null);
  const wickLightRef = useRef<THREE.PointLight>(null);
  const emberRef = useRef<THREE.Points>(null);

  // per-frame material writes go through *Ref bindings (react-hooks lint reads
  // the Ref suffix); the memo above owns the objects themselves
  const brassMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const cageMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const glassMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const projTexRef = useRef<THREE.Texture | null>(null);
  useLayoutEffect(() => {
    brassMatRef.current = mats.brass;
    cageMatRef.current = mats.cage;
    glassMatRef.current = mats.glass;
    projTexRef.current = pattern.projTex;
  }, [mats, pattern]);

  // material-element refs for the additive planes and sprites (R3F owns these,
  // so no manual disposal — only their opacities/scales are touched)
  const patMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const msgMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const cartMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const meterMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const flameCoreRef = useRef<THREE.SpriteMaterial>(null);
  const flameMidRef = useRef<THREE.SpriteMaterial>(null);
  const flameHaloRef = useRef<THREE.SpriteMaterial>(null);
  const emberMatRef = useRef<THREE.PointsMaterial>(null);
  const doorHintRef = useRef<THREE.SpriteMaterial>(null);
  const wickHintRef = useRef<THREE.SpriteMaterial>(null);

  /* ---------- interaction state (mutable, so it lives in refs) ---------- */
  const doorDragRef = useRef({ down: false, last: 0, open: 0 });
  const holdRef = useRef({ down: false, meter: 0 });
  const igniteRef = useRef(-1); // t at which the wick caught; -1 until lit
  const doorOpenTRef = useRef(-1); // t at which the door reached open-enough

  // Replay re-enters "opening": reset everything the show accumulates, or the
  // second run would start half-lit.
  useLayoutEffect(() => {
    doorDragRef.current = { down: false, last: 0, open: 0 };
    holdRef.current = { down: false, meter: 0 };
    igniteRef.current = -1;
    doorOpenTRef.current = -1;
  }, [phase]);

  /* ---------- pointer gestures ---------- */
  // Stage 1: pry the glass door. Any horizontal wander opens it a little more —
  // it reads as working a stiff latch loose, and works with a mouse drag too.
  const onDoorDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || igniteRef.current >= 0) return;
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety; pointer-up/out cover its absence */
    }
    const d = doorDragRef.current;
    d.down = true;
    d.last = ev.point.x;
  };
  const onDoorMove = (ev: ThreeEvent<PointerEvent>) => {
    const d = doorDragRef.current;
    if (!d.down || phase !== "opening" || igniteRef.current >= 0) return;
    ev.stopPropagation();
    d.open = clamp01(d.open + Math.abs(ev.point.x - d.last) * 1.9);
    d.last = ev.point.x;
  };
  const doorUp = () => {
    doorDragRef.current.down = false;
  };
  // Stage 2: press and hold to light the wick. This plane sits nearer the
  // camera than the door plane and overlaps it, so while it is INACTIVE (door
  // still shut, or already lit) it must NOT stop propagation — the door plane
  // behind it needs the event. Only claim the pointer once holding is live.
  const onWickDown = (ev: ThreeEvent<PointerEvent>) => {
    if (phase !== "opening" || doorOpenTRef.current < 0 || igniteRef.current >= 0)
      return;
    ev.stopPropagation();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* see above */
    }
    holdRef.current.down = true;
  };
  const wickUp = () => {
    holdRef.current.down = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    /* ---- fit: shrink the lantern into a narrow (portrait) viewport ---- */
    const fit = Math.max(0.72, Math.min(1.05, state.viewport.width / 1.35));
    fitRef.current?.scale.setScalar(fit);

    /* ---- the whole alcove leans a touch toward the pointer ---- */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(
        tiltRef.current.rotation.x,
        state.pointer.y * 0.05,
        k,
      );
      tiltRef.current.rotation.y = lerp(
        tiltRef.current.rotation.y,
        state.pointer.x * 0.06,
        k,
      );
    }

    /* ---- size the wall & projection to the frustum at their depth ---- */
    // The camera is fixed, so the visible half-extents at WALL_Z are constant
    // per aspect. Computed from size+fov (not viewport, which is the z=0 plane).
    const aspect = state.size.width / Math.max(1, state.size.height);
    const Hh = (CAM_Z - WALL_Z) * Math.tan((FOV * Math.PI) / 360);
    const Hw = Hh * aspect;
    if (wallRef.current) wallRef.current.scale.set(Hw * 2.3, Hh * 2.3, 1);
    if (patternProjRef.current)
      patternProjRef.current.scale.set(Hw * 2.2, Hh * 2.2, 1);

    /* ======================================================================
       Resolve the show into a handful of scalars. Every phase drives them, so
       "revealed" (and reduced motion) draws the finished piece cold from phase
       alone — no clock, no replay.
       ==================================================================== */
    let flame: number; // 0..1 flame/glow intensity
    let flash = 0; // the catch's brief overshoot
    let doorAngle: number; // radians the door is swung open
    let meter = 0; // hold-to-light progress, 0..1
    let spin: number; // lantern rotation.y
    let patternA: number; // wall lace opacity
    let msgK: number; // message resolve, 0 (swept) → 1 (aligned)
    let msgA: number; // message plane opacity
    let cartA: number; // cartouche opacity
    let doorHintA = 0;
    let wickHintA = 0;
    // a gentle pendulum, always: it hangs from a chain
    const swayZ = 0.035 * Math.sin(e * 0.7);
    const swayY = 0.045 * Math.sin(e * 0.55);

    if (phase === "opening") {
      /* --- Stage 1: the door, pried by the finger or eased open by mercy --- */
      const doorMercy = smooth(clamp01((t - T_DOOR0) / T_DOOR_RAMP));
      const doorOpen = Math.max(doorDragRef.current.open, doorMercy);
      if (doorOpen >= DOOR_OPEN_THRESH && doorOpenTRef.current < 0)
        doorOpenTRef.current = t;
      const doorIsOpen = doorOpenTRef.current >= 0;

      /* --- Stage 2: the wick, held to light or caught on its own --- */
      const h = holdRef.current;
      if (doorIsOpen && igniteRef.current < 0) {
        if (h.down) h.meter = clamp01(h.meter + dt / HOLD_FILL);
        else h.meter = Math.max(0, h.meter - dt / HOLD_DECAY);
        const holdMercy = smooth(
          clamp01((t - (doorOpenTRef.current + T_HOLD_LAG)) / T_HOLD_RAMP),
        );
        meter = Math.max(h.meter, holdMercy);
        if (meter >= 1) igniteRef.current = t;
      } else if (igniteRef.current < 0) {
        meter = 0;
      } else {
        meter = 1;
      }

      const lit = igniteRef.current >= 0;
      const tau = lit ? t - igniteRef.current : -1;

      if (!lit) {
        // pre-ignition: door swings to however far it is pried; a spark builds
        // at the wick as they hold
        doorAngle = DOOR_MAX * doorOpen;
        flame = doorIsOpen ? meter * 0.28 : 0;
        spin = swayZ * 0.4; // barely stirring
        patternA = 0;
        msgK = 0;
        msgA = 0;
        cartA = 0;
        doorHintA = doorIsOpen ? 0 : 0.35 + 0.22 * Math.sin(e * 3.2);
        wickHintA = doorIsOpen ? 0.35 + 0.22 * Math.sin(e * 3.6) : 0;
      } else {
        // the catch: the flame floods, the door clicks shut with a little
        // overshoot, the lantern spins its lace across the stone, then brakes
        // front-forward as the words resolve
        flash = Math.exp(-tau * 4) * 0.7;
        flame = smooth(clamp01(tau / 0.4));
        const shut = easeOutBack(clamp01((tau - 0.1) / 0.45)); // >1 near the end = the click
        doorAngle = DOOR_MAX * (1 - shut);
        spin = SPIN_ANG * (1 - easeOutCubic(clamp01(tau / SPIN_T)));
        msgK = smooth(clamp01((tau - RES0) / (RES1 - RES0)));
        patternA = smooth(clamp01((tau - 0.15) / 0.5)) * (1 - msgK) * 0.85;
        msgA = msgK * 0.95;
        cartA = smooth(clamp01((tau - 2.6) / 1.3));
      }

      if (lit && tau >= TAU_HOLD && !doneRef.current) {
        doneRef.current = true;
        onOpenComplete?.();
      }
    } else if (phase === "revealed") {
      // the finished tableau, cold — reduced motion lands straight here
      flame = 1;
      doorAngle = 0;
      spin = swayZ * 0.3;
      patternA = 0;
      msgK = 1;
      msgA = 0.95;
      cartA = 1;
    } else if (phase === "preview") {
      // the sealed lantern, gently living: a low ember behind the glass, the
      // faintest promise of words on the stone. Inviting, not opened.
      flame = 0.12 + 0.05 * Math.sin(e * 1.6);
      doorAngle = 0;
      spin = swayZ;
      patternA = 0.1 + 0.05 * Math.sin(e * 0.5);
      msgK = 1;
      msgA = 0.2 + 0.06 * Math.sin(e * 0.5 + 1.5);
      cartA = 0.3;
    } else {
      // sealed: unlit, at rest, with a "drag the door" invitation
      flame = 0;
      doorAngle = 0;
      spin = swayZ;
      patternA = 0;
      msgK = 0;
      msgA = 0;
      cartA = 0.12;
      doorHintA = 0.35 + 0.22 * Math.sin(e * 2.6);
    }

    /* ---- pose the lantern ---- */
    const lantern = lanternRef.current;
    if (lantern) {
      lantern.rotation.y = spin;
      lantern.rotation.z = swayZ + flash * 0.05 * Math.sin(e * 40);
      lantern.position.set(0, LANTERN_Y + swayY * 0.15, 0);
    }
    if (doorRef.current) doorRef.current.rotation.y = -doorAngle;

    /* ---- brass, cage, glass: emissive rides the flame ---- */
    const glow = clamp01(flame + flash);
    setEmissive(brassMatRef.current, pal.halo, glow * 0.85);
    setEmissive(cageMatRef.current, pal.halo, glow * 1.1);
    if (glassMatRef.current) {
      glassMatRef.current.emissiveIntensity = glow * 1.5;
      // the glass clears a touch as the flame lights it from behind
      glassMatRef.current.opacity = 0.5 + glow * 0.28;
    }
    if (wickLightRef.current)
      wickLightRef.current.intensity = (flame * 3.2 + flash * 3) * 1.0;

    /* ---- the flame ---- */
    const fg = flameRef.current;
    if (fg) {
      fg.visible = flame > 0.01;
      const flick = 0.85 + 0.15 * Math.sin(e * 18) + 0.08 * Math.sin(e * 47);
      fg.position.set(
        0.012 * Math.sin(e * 9),
        0.42 + 0.01 * Math.sin(e * 13),
        0,
      );
      fg.scale.setScalar((0.6 + 0.4 * flame) * flick);
    }
    if (flameCoreRef.current) flameCoreRef.current.opacity = (0.8 + flash) * flame;
    if (flameMidRef.current) flameMidRef.current.opacity = 0.7 * flame;
    if (flameHaloRef.current) flameHaloRef.current.opacity = 0.55 * flame;

    /* ---- the projection ---- */
    if (projTexRef.current) {
      // as the lantern turns, the lace sweeps sideways across the wall; a slow
      // vertical drift keeps it breathing even at rest
      projTexRef.current.offset.x = spin * 0.11 + e * 0.008;
      projTexRef.current.offset.y = e * 0.006;
    }
    if (patMatRef.current) patMatRef.current.opacity = patternA;
    if (patternProjRef.current)
      patternProjRef.current.rotation.z = 0.06 * Math.sin(spin);

    if (msgMatRef.current) msgMatRef.current.opacity = msgA;
    if (messageProjRef.current) {
      // fit the words to the wall by their own aspect, then let them de-skew
      // from a swept, oversized blur into crisp alignment as msgK → 1
      const W = Math.min(Hw * 1.55, (Hh * 1.5) / Math.max(0.15, msg.aspect));
      const sc = lerp(1.45, 1.0, msgK);
      messageProjRef.current.scale.set(W * sc, W * msg.aspect * sc, 1);
      messageProjRef.current.rotation.z = lerp(0.24, 0, msgK);
    }

    /* ---- the cartouche of names, on the front pane ---- */
    if (cartMatRef.current) cartMatRef.current.opacity = cartA;

    /* ---- the hold-meter (a charging ring at the wick) ---- */
    const mg = meterRef.current;
    if (mg) {
      mg.visible = meter > 0.001 && meter < 0.999;
      if (meterMatRef.current) meterMatRef.current.opacity = 0.35 + meter * 0.5;
      // a spark orbits the ring to the filled angle, so progress is legible
      if (meterSparkRef.current) {
        const a = -Math.PI / 2 + meter * Math.PI * 2;
        meterSparkRef.current.position.set(
          Math.cos(a) * 0.172,
          Math.sin(a) * 0.172,
          0.001,
        );
      }
    }

    /* ---- affordance hints ---- */
    if (doorHintRef.current) doorHintRef.current.opacity = doorHintA * 0.6;
    if (wickHintRef.current) wickHintRef.current.opacity = wickHintA * 0.7;

    /* ---- rising embers off the flame ---- */
    const ep = emberRef.current;
    if (ep) {
      const pa = ep.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < EMBER_N; i++) {
        const s = embers.seed[i];
        const v = (s.ph + e * s.sp) % 1; // 0 at the wick, 1 at the top of its climb
        const rise = 0.42 + v * 0.55;
        const spread = 1 + v * 1.2;
        pa.setXYZ(
          i,
          s.x * spread + Math.sin(e * 2 + s.sway) * 0.02 * v,
          rise,
          s.z * spread,
        );
      }
      pa.needsUpdate = true;
      ep.visible = flame > 0.2;
      if (emberMatRef.current) emberMatRef.current.opacity = flame * 0.7;
    }
  });

  return (
    <>
      {/* aimed a touch high so the message on the wall is not cropped low */}
      <PerspectiveCamera makeDefault position={[0, 0.05, CAM_Z]} fov={FOV} />
      <ambientLight intensity={0.28} color="#ffdcae" />
      {/* a warm key raking down the niche, a cold rim off the night outside */}
      <directionalLight position={[-2, 3.4, 2.4]} intensity={1.3} color="#ffd6a0" />
      <directionalLight position={[3, 1.2, -2]} intensity={0.6} color={pal.rim} />

      <group ref={tiltRef}>
        {/* the stone wall of the alcove */}
        <mesh ref={wallRef} position={[0, 0.15, WALL_Z]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={wallTex} toneMapped={false} />
        </mesh>

        {/* the lace the lantern throws, swept across the stone (below the words) */}
        <mesh ref={patternProjRef} position={[0, 0.15, WALL_Z + 0.01]} renderOrder={1}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={patMatRef}
            map={pattern.projTex}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>

        {/* the message, resolving out of the moving light */}
        <mesh ref={messageProjRef} position={[0, 0.18, WALL_Z + 0.03]} renderOrder={2}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={msgMatRef}
            map={msg.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>

        {/* the lantern, and everything that swings, spins or burns with it */}
        <group ref={fitRef}>
          <group ref={lanternRef} position={[0, LANTERN_Y, 0]}>
            {/* lathed brass: base, crown, finial, hanging ring */}
            <mesh geometry={baseGeo} material={mats.brass} />
            <mesh geometry={crownGeo} material={mats.brass} />
            <mesh
              geometry={finialGeo}
              material={mats.brassDark}
              position={[0, CH_Y1 + 0.49, 0]}
            />
            <mesh
              geometry={ringGeo}
              material={mats.brassDark}
              position={[0, CH_Y1 + 0.56, 0]}
              rotation={[Math.PI / 2, 0, 0]}
            />
            {/* brass hoops closing the top and bottom of the cage */}
            <mesh
              geometry={chamberRingGeo}
              material={mats.brassDark}
              position={[0, CH_Y0, 0]}
              rotation={[Math.PI / 2, 0, 0]}
            />
            <mesh
              geometry={chamberRingGeo}
              material={mats.brassDark}
              position={[0, CH_Y1, 0]}
              rotation={[Math.PI / 2, 0, 0]}
            />

            {/* the tinted glass chamber, then the pierced brass over it */}
            <mesh geometry={glassGeo} material={mats.glass} position={[0, CH_CY, 0]} />
            <mesh geometry={cageGeo} material={mats.cage} position={[0, CH_CY, 0]} />

            {/* the wick, and the flame that catches on it */}
            <mesh geometry={wickGeo} material={mats.brassDark} position={[0, CH_Y0 + 0.05, 0]} />
            <group ref={flameRef} position={[0, 0.42, 0]} visible={false}>
              <sprite scale={[0.5, 0.72, 1]}>
                <spriteMaterial
                  ref={flameHaloRef}
                  map={glowTex}
                  color={pal.halo}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
              <sprite scale={[0.22, 0.44, 1]} position={[0, 0.04, 0.01]}>
                <spriteMaterial
                  ref={flameMidRef}
                  map={glowTex}
                  color="#ffb347"
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
              <sprite scale={[0.1, 0.26, 1]} position={[0, 0.05, 0.02]}>
                <spriteMaterial
                  ref={flameCoreRef}
                  map={glowTex}
                  color="#fff3d6"
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
            </group>
            <pointLight
              ref={wickLightRef}
              position={[0, CH_CY, 0]}
              intensity={0}
              color={pal.halo}
              distance={3.2}
              decay={1.4}
            />

            {/* rising embers */}
            <points ref={emberRef} frustumCulled={false} visible={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[embers.pos, 3]} />
              </bufferGeometry>
              <pointsMaterial
                ref={emberMatRef}
                map={glowTex}
                color={pal.halo}
                size={0.05}
                sizeAttenuation
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </points>

            {/* the little glass door, hinged on its left edge */}
            <group ref={doorRef} position={[HINGE_X, CH_CY, HINGE_Z]}>
              <group position={[-HINGE_X, -CH_CY, -HINGE_Z]}>
                <mesh geometry={doorGlassGeo} material={mats.glass} position={[0, CH_CY, 0]} />
                <mesh geometry={doorCageGeo} material={mats.cage} position={[0, CH_CY, 0]} />
              </group>
            </group>

            {/* the cartouche of both names, on the front pane */}
            {cartouche && (
              <mesh position={[0, CH_CY, CH_R + 0.03]}>
                <planeGeometry args={[0.5, 0.5 * cartouche.aspect]} />
                <meshBasicMaterial
                  ref={cartMatRef}
                  map={cartouche.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
            )}

            {/* the hold-to-light meter: a charging ring with an orbiting spark */}
            <group ref={meterRef} position={[0, CH_Y0 + 0.05, CH_R + 0.1]} visible={false}>
              <mesh geometry={meterRingGeo}>
                <meshBasicMaterial
                  ref={meterMatRef}
                  color={pal.halo}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
              <sprite ref={meterSparkRef} scale={[0.09, 0.09, 1]}>
                <spriteMaterial
                  map={glowTex}
                  color="#fff3d6"
                  transparent
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </sprite>
            </group>

            {/* a soft glint riding the door, until they take the hint */}
            <sprite position={[0, CH_CY, CAGE_R + 0.06]} scale={[0.5, 0.9, 1]}>
              <spriteMaterial
                ref={doorHintRef}
                map={glowTex}
                color={pal.halo}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </sprite>
            {/* and a pulse at the wick, once the door is open */}
            <sprite position={[0, CH_Y0 + 0.08, CH_R + 0.02]} scale={[0.34, 0.34, 1]}>
              <spriteMaterial
                ref={wickHintRef}
                map={glowTex}
                color="#fff0cf"
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </sprite>
          </group>

          {/* --- gesture hit targets, only while the show wants them --- */}
          {phase === "opening" && (
            <>
              {/* pry the door open (a wide plane over the front) */}
              <mesh
                position={[0, LANTERN_Y + CH_CY, CAGE_R + 0.5]}
                onPointerDown={onDoorDown}
                onPointerMove={onDoorMove}
                onPointerUp={doorUp}
                onPointerCancel={doorUp}
                onPointerOut={doorUp}
              >
                <planeGeometry args={[1.4, 1.2]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
              {/* press-and-hold the wick (only reachable once the door is open,
                  which the handler enforces; it sits nearer the camera) */}
              <mesh
                position={[0, LANTERN_Y + CH_Y0 + 0.1, CAGE_R + 0.9]}
                onPointerDown={onWickDown}
                onPointerUp={wickUp}
                onPointerCancel={wickUp}
                onPointerOut={wickUp}
              >
                <planeGeometry args={[1.0, 0.8]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </>
          )}
        </group>
      </group>
    </>
  );
}

/* ---------- helpers ---------- */
// Point a standard material's emissive at the hot colour and set its gain.
// Kept out of the frame body so the two call sites read cleanly.
const _tmpC = new THREE.Color();
function setEmissive(
  mat: THREE.MeshStandardMaterial | null,
  hot: string,
  intensity: number,
) {
  if (!mat) return;
  mat.emissive.copy(_tmpC.set(hot));
  mat.emissiveIntensity = intensity;
}
