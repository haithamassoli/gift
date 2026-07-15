import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";

/* ---------- palettes ---------- */
// The cabinet is not a paint swatch: the tubes are the only bright thing in the
// room, so their colour is what lights the plushes, the glass, the floor and the
// wall behind. Change `neon` and the whole box is relit.
interface Cab {
  neon: string;
  accent: string;
  paint: string;
  trim: string;
  glass: string;
  inner: string; // the fluorescent bank over the play field
  room: string;
  key: string;
  amb: string;
}
const CABINETS: Record<string, Cab> = {
  bubblegum: {
    neon: "#ff4d9e", accent: "#6fe9ff", paint: "#f0bcd4", trim: "#f6eef2",
    glass: "#e6f4ff", inner: "#ffd7ea", room: "#1d0a17", key: "#fff2f8", amb: "#ff9ec8",
  },
  midnight: {
    neon: "#9d6bff", accent: "#2fe3cf", paint: "#241b40", trim: "#6b6296",
    glass: "#d8e6ff", inner: "#c3aeff", room: "#08061a", key: "#e9e2ff", amb: "#8f7ae0",
  },
  mint: {
    neon: "#37f5bf", accent: "#ffe36b", paint: "#dcf4ea", trim: "#eefbf5",
    glass: "#e9fffb", inner: "#c9ffee", room: "#04150f", key: "#f2fffb", amb: "#79f0cd",
  },
};

// Ears and limbs hang off different places on a bear than on a star, so the few
// numbers that differ are data — the plush is assembled once, from all three.
interface Plush {
  fur: string;
  belly: string;
  nose: string;
  kind: "bear" | "bunny" | "star";
  ear: [number, number, number]; // scale of the one ear capsule: bear nub → bunny lop
  earPos: [number, number, number];
  armX: number;
  armY: number;
  legX: number;
  legY: number;
  tagY: number;
  tagZ: number;
}
const PLUSHES: Record<string, Plush> = {
  bear: {
    fur: "#c9884a", belly: "#f2dcba", nose: "#3d2517", kind: "bear",
    ear: [1, 0.55, 0.8], earPos: [0.058, 0.066, -0.004],
    armX: 0.105, armY: 0.03, legX: 0.062, legY: -0.112, tagY: 0.01, tagZ: 0.152,
  },
  bunny: {
    fur: "#f2e8f0", belly: "#ffd0e2", nose: "#d1739c", kind: "bunny",
    ear: [0.8, 2.5, 0.62], earPos: [0.04, 0.128, -0.012],
    armX: 0.105, armY: 0.03, legX: 0.062, legY: -0.112, tagY: 0.01, tagZ: 0.152,
  },
  star: {
    fur: "#ffd45c", belly: "#fff2bd", nose: "#9c5f0e", kind: "star",
    ear: [1, 1, 1], earPos: [0, 0, 0],
    // A bear wears its face on a head, 0.13 above the card's top edge. A star wears its face
    // where a bear wears the card, so the card has to hang from the mouth rather than sit on
    // the chest — at -0.03 it covered the eyes outright, on every message and in every phase.
    armX: 0.128, armY: -0.008, legX: 0.066, legY: -0.128, tagY: -0.13, tagZ: 0.115,
  },
};

/* ---------- the cabinet, in world units ---------- */
// 1 unit ≈ 0.55m — a real cabinet is ~1.8m tall, which is where the fall's g comes from.
const FOV = 40;
const CAM_Z = 4.5;
const CAM_Y = 1.05;
const CAM_DIST = Math.hypot(CAM_Y, CAM_Z); // the lens to the origin it is aimed at
const CAB_W = 2.2;
const CAB_D = 1.1;
const BASE_Y0 = -1.62;
const BASE_Y1 = -0.4;
const BOX_Y1 = 1.16;
const MARQ_Y1 = 1.62;
const FRONT_Z = CAB_D / 2;
const ACTION_W = 2.46; // outer bezel plus air — at 2.34 a 390px portrait shaved the tubes
const ACTION_H = 3.62; // the bare 3.24 plus the margin the marquee's depth costs it

/* the play field, inside the glass */
const FIELD_X = 0.94;
const FIELD_Z0 = -0.42;
const FIELD_Z1 = 0.44;
const FLOOR_Y = -0.34;
const RAIL_Y = 1.0;
const CLAW_HOME_Y = 0.86;
const GRIP_DROP = 0.2; // hub → the plush's middle, once the talons have it

/* the gantry's reach, and the one prize it will always find */
const AIM_X = 0.58;
const AIM_Z0 = -0.26;
const AIM_Z1 = 0.34;
const HERO_X = 0.2;
const HERO_Z = 0.02;

/* the drop hole, and the chute under it */
const HOLE_X = -0.62;
const HOLE_Z = 0.24;
const HOLE_R = 0.23;
const CHUTE_X = -0.62;
const CHUTE_Y0 = -1.26;
const CHUTE_Y1 = -0.6;
const CHUTE_W = 0.64;
const LAND_Y = -1.1;
const LAND_Z = 0.3; // mid-trough — the alcove is only as deep as the fascia is proud

/* where the prize ends up: out of the machine, in front of you */
const HERO_POSE = new THREE.Vector3(0.02, 0.12, 1.85);
const HERO_S = 2.1;
const G = 17.8; // gravity at this scale

/* ---------- opening timeline (seconds) ---------- */
const T_DESC1 = 0.82;
const T_CLOSE0 = 0.82;
const T_CLOSE1 = 1.2;
const T_RISE0 = 1.2;
const T_RISE1 = 2.3;
// The slip lands at 40% of the rise and lets go at 75% of it: late enough that the
// prize is high and the fall would cost everything, early enough that the recovery
// still has travel left to be a recovery. This beat is the gift.
const T_SLIP0 = 1.6;
const T_SLIP1 = 2.02;
const T_TRAV0 = 2.28;
const T_TRAV1 = 2.86;
const T_LET0 = 2.86;
const T_LET1 = 3.02;
const T_FALL0 = 2.98;
const FALL_Y0 = CLAW_HOME_Y - GRIP_DROP; // the talons let go at the traverse height
const T_LAND = T_FALL0 + Math.sqrt((2 * (FALL_Y0 - LAND_Y)) / G); // ≈ 3.43, and it is g that says so
const T_HOME0 = 3.2;
const T_FLAP0 = 3.72;
const T_FLAP1 = 4.1;
const T_ARR0 = 3.95;
const T_ARR1 = 4.9;
const T_TAG0 = 4.78;
const T_TAG1 = 5.68;
const OPEN_END = 5.75;
// A gift may never outlast 12s untouched, and the bound is on onOpenComplete, not on
// the grant — so the budget is the grant PLUS the whole show: 5.5 + 5.75 = 11.25, and
// measured at 11.4s cold, the rest being mount-to-first-frame. The doc's "~10s" reads
// the bound as the grant and would land the finish at 15.75.
const T_MERCY0 = 2.4; // the gantry starts leaning toward the prize on its own…
const T_MERCY1 = 5.5; // …and lets go here, if nobody ever touched the glass
const PREV_LEAD = 2.2;
const PREV_PERIOD = 13.0;
const PREV_OUT = 9.4;

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();
const shadowTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,1)"],
  [0.5, "rgba(255,255,255,0.88)"],
  [0.8, "rgba(255,255,255,0.3)"],
  [1, "rgba(255,255,255,0)"],
]);
// the floor puddle wants the opposite: all falloff, no core
const puddleTex = makeRadialSprite();

/* ---------- the arcade, as something for the chrome to reflect ---------- */
// Bare metal with no envMap renders black — the claw is the one chrome thing in
// the scene and it has to read as chrome, so the room gets an equirect: a dark
// hall with a bright ceiling strip and a smear of somebody else's cabinet.
function buildEnvTexture(): THREE.Texture {
  const W = 256, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#c2cee2"); // the box's own light bank, straight overhead
  sky.addColorStop(0.34, "#4b4557");
  sky.addColorStop(0.62, "#332e3e");
  sky.addColorStop(1, "#453e52"); // the field's floor bouncing the neon back up
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#e8f0ff"; // ceiling strip lights, the hard highlight on the talons
  for (let i = 0; i < 4; i++) g.fillRect(18 + i * 64, 8, 34, 5);
  const blob = (x: number, y: number, r: number, inner: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, inner);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(46, 62, 40, "#ff2e88");
  blob(150, 58, 34, "#22d3ee");
  blob(228, 70, 30, "#a855f7");
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const envTex = buildEnvTexture();

/* ---------- glass ---------- */
// Transparency is not what makes glass read — the reflection is. A hard diagonal
// smear of the ceiling strips across the pane does more than any opacity value.
function buildGlareTexture(): THREE.CanvasTexture {
  const W = 128, H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W * 0.36, 0);
  g.rotate(-0.42);
  for (const [x, w, a] of [[0, 9, 0.5], [17, 3.5, 0.28], [26, 1.6, 0.16]] as const) {
    const gr = g.createLinearGradient(x - w, 0, x + w, 0);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.5, `rgba(255,255,255,${a})`);
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(x - w, -H, w * 2, H * 3);
  }
  g.restore();
  // the pane is grubbier at the bottom where every hand has pressed on it
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, "rgba(255,255,255,0.1)");
  gr.addColorStop(0.7, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  return new THREE.CanvasTexture(c);
}
const glareTex = buildGlareTexture();

/* ---------- the room behind ---------- */
// Sized off the frustum, not by eye: the canvas jumps to aspect 2.53 the instant
// the reveal mounts the message under it, and a wall short of that leaves bare page.
const WALL_Z = -3.0;
const WALL_H = 2 * (CAM_Z - WALL_Z) * Math.tan((FOV * Math.PI) / 360); // 5.53
const WALL_W = WALL_H * 2.6; // the authored width — portrait never needs more than this
const WALL_Y = 0.4;
const WALL_FOOT_Y = WALL_Y - (WALL_H * 1.3) / 2;
// …but a *ratio* is not a width. The wall is vertical and the lens looks down at it, so its
// foot is the part furthest from the camera — and a frustum is widest where it is deepest.
// Measured: at the 2.53 the real desktop reveal has, 2.6 leaves ~15px of bare page down each
// edge, and an ultrawide is short by units. So the constant is only the floor, and the frame
// stretches it to whatever the live viewport turns out to be.
const WALL_FOOT_D = ((CAM_Y - WALL_FOOT_Y) * CAM_Y + (CAM_Z - WALL_Z) * CAM_Z) / CAM_DIST;
function buildWallTexture(): THREE.CanvasTexture {
  const W = 128, H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  // a vignette in white, tinted per-cabinet by the material's colour
  const gr = g.createRadialGradient(W / 2, H * 0.62, 4, W / 2, H * 0.62, W * 0.62);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.5, "rgba(120,120,140,1)");
  gr.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const wallTex = buildWallTexture();

/* ---------- neon tubing ---------- */
// A real tube is one bent length of glass with rounded corners — a rounded-rect
// swept as a closed tube, not four cylinders butted together.
function buildNeonLoop(w: number, h: number, r: number, tube: number): THREE.TubeGeometry {
  const pts: THREE.Vector3[] = [];
  const hw = w / 2 - r, hh = h / 2 - r;
  const corners: [number, number, number][] = [
    [hw, hh, 0], [-hw, hh, Math.PI / 2], [-hw, -hh, Math.PI], [hw, -hh, -Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= 5; i++) {
      const a = a0 + (i / 5) * (Math.PI / 2);
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
    }
  const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.0);
  return new THREE.TubeGeometry(curve, 96, tube, 7, true);
}
const marqueeNeon = buildNeonLoop(CAB_W - 0.14, MARQ_Y1 - BOX_Y1 - 0.08, 0.07, 0.021);
const chuteNeon = buildNeonLoop(CHUTE_W + 0.11, CHUTE_Y1 - CHUTE_Y0 + 0.11, 0.06, 0.017);
const postNeon = new THREE.CylinderGeometry(0.019, 0.019, BOX_Y1 - BASE_Y1, 7, 1);
const railGeo = new THREE.CylinderGeometry(0.014, 0.014, FIELD_Z1 - FIELD_Z0 + 0.1, 6);

/* ---------- the claw ---------- */
// One hinge per talon, at the hub — which is exactly how the real mechanism works;
// the hook shape is in the geometry, not in a second joint.
function buildTalonGeo(): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.052, -0.072, 0),
    new THREE.Vector3(0.072, -0.152, 0),
    new THREE.Vector3(0.05, -0.222, 0),
    new THREE.Vector3(0.012, -0.252, 0),
  ]);
  const SEG = 26, RAD = 8;
  // radius 1 so every ring sits one unit off the spine, ready to be pushed in
  const g = new THREE.TubeGeometry(curve, SEG, 1, RAD, false);
  const p = g.attributes.position;
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG;
    const r = 0.03 * Math.pow(1 - u, 0.7) + 0.005; // thick at the knuckle, a point at the tip
    curve.getPointAt(u, c);
    for (let j = 0; j <= RAD; j++) {
      const k = i * (RAD + 1) + j;
      v.fromBufferAttribute(p, k).sub(c).multiplyScalar(r).add(c);
      p.setXYZ(k, v.x, v.y, v.z);
    }
  }
  g.computeVertexNormals();
  return g;
}
const talonGeo = buildTalonGeo();
const hubGeo = new THREE.CylinderGeometry(0.062, 0.05, 0.075, 18);
const capGeo = new THREE.SphereGeometry(0.045, 14, 10);
const cableGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 6, 1);
const trolleyGeo = new THREE.BoxGeometry(0.13, 0.06, 0.11);

/* ---------- plush parts ---------- */
// Squashed, round, no hard edges anywhere — a plush is a bag of stuffing that has
// been sat on. The capsules are all wider than they are tall for that reason.
const bodyGeo = new THREE.CapsuleGeometry(0.1, 0.075, 5, 18);
const headGeo = new THREE.SphereGeometry(0.082, 18, 14);
const limbGeo = new THREE.CapsuleGeometry(0.032, 0.052, 4, 10);
const earGeo = new THREE.CapsuleGeometry(0.027, 0.03, 4, 10);
const snoutGeo = new THREE.SphereGeometry(0.036, 12, 10);
const eyeGeo = new THREE.SphereGeometry(0.012, 10, 8);
const noseGeo = new THREE.SphereGeometry(0.014, 10, 8);

// A star plush has no head to speak of — it is one puffy body with a face on it.
function buildStarGeo(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? 0.155 : 0.068;
    if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.05, bevelEnabled: true, bevelSize: 0.042, bevelThickness: 0.042,
    bevelSegments: 6, curveSegments: 3,
  });
  g.center();
  g.computeVertexNormals();
  return g;
}
const starGeo = buildStarGeo();

/* ---------- the two holes the machine is built around ---------- */
// A prize chute and a drop hole are *absences*, and faking either with a dark panel
// pinned to a solid face is what makes a cabinet read as a poster of a cabinet. Both
// are real openings cut with a Path, so the claw drops the prize through one and you
// see it land behind the other.
function buildFasciaGeo(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-CAB_W / 2, BASE_Y0);
  s.lineTo(CAB_W / 2, BASE_Y0);
  s.lineTo(CAB_W / 2, BASE_Y1);
  s.lineTo(-CAB_W / 2, BASE_Y1);
  s.closePath();
  const hole = new THREE.Path();
  const x0 = CHUTE_X - CHUTE_W / 2, x1 = CHUTE_X + CHUTE_W / 2;
  hole.moveTo(x0, CHUTE_Y0);
  hole.lineTo(x0, CHUTE_Y1);
  hole.lineTo(x1, CHUTE_Y1);
  hole.lineTo(x1, CHUTE_Y0);
  hole.closePath();
  s.holes.push(hole);
  return new THREE.ExtrudeGeometry(s, {
    depth: 0.09, bevelEnabled: true, bevelSize: 0.014, bevelThickness: 0.012, bevelSegments: 2,
  });
}
const fasciaGeo = buildFasciaGeo();

// authored in (x, -z) so the −90° tip about x lands it flat with z the right way round
function buildFieldFloorGeo(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(-FIELD_X, -FIELD_Z1);
  s.lineTo(FIELD_X, -FIELD_Z1);
  s.lineTo(FIELD_X, -FIELD_Z0);
  s.lineTo(-FIELD_X, -FIELD_Z0);
  s.closePath();
  const hole = new THREE.Path();
  hole.absarc(HOLE_X, -HOLE_Z, HOLE_R, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return new THREE.ExtrudeGeometry(s, {
    depth: 0.05, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.008,
    bevelSegments: 1, curveSegments: 24,
  });
}
const fieldFloorGeo = buildFieldFloorGeo();

/* ---------- the pile ---------- */
// The heap is defined as a height field first and populated second, so the plushes
// sit *on* a mound rather than being a mound by accident. One function then answers
// all three questions that matter: where a plush rests, how high the aiming shadow
// floats, and how deep the talons have sunk in.
const MOUNDS: [number, number, number, number][] = [
  [0.16, -0.04, 0.24, 0.5],
  [0.58, 0.18, 0.15, 0.34],
  [-0.28, -0.14, 0.17, 0.38],
  [-0.06, 0.3, 0.11, 0.3],
];
function pileHeight(x: number, z: number): number {
  let h = 0;
  for (const [mx, mz, ma, mr] of MOUNDS) {
    const dx = x - mx, dz = z - mz;
    h += ma * Math.exp(-(dx * dx + dz * dz) / (mr * mr));
  }
  return h;
}
/** Top of the heap at (x,z) — what the claw's shadow falls on. */
const pileTop = (x: number, z: number) => FLOOR_Y + pileHeight(x, z) + 0.1;

const PILE_N = 11;
const PILE_HUES = ["#e0748f", "#7fc4e8", "#f0d07a", "#a9dfa0", "#c9a4e8", "#f2a06a"];
// The head and the ears never move in their own plush's frame, so their matrices are
// baked once here and only multiplied through per frame. The ear's *length* is baked
// in with them: one scale is the whole difference between a bear and a lopped bunny.
const HEAD_M = new THREE.Matrix4().makeTranslation(0, 0.132, 0.012);
function buildPile() {
  const rand = mulberry32(4471);
  const px: number[] = [], py: number[] = [], pz: number[] = [], scl: number[] = [];
  const q: THREE.Quaternion[] = [], earM: THREE.Matrix4[] = [], col: THREE.Color[] = [];
  let guard = 0;
  while (px.length < PILE_N && guard++ < 400) {
    const x = -FIELD_X + 0.2 + rand() * (FIELD_X * 2 - 0.4);
    const z = FIELD_Z0 + 0.16 + rand() * (FIELD_Z1 - FIELD_Z0 - 0.3);
    // the drop hole has to stay clear or the heap would be resting on thin air
    if (Math.hypot(x - HOLE_X, z - HOLE_Z) < HOLE_R + 0.17) continue;
    if (Math.hypot(x - HERO_X, z - HERO_Z) < 0.21) continue; // the prize's own seat
    if (px.some((ox, i) => Math.hypot(x - ox, z - pz[i]) < 0.19)) continue;
    px.push(x);
    pz.push(z);
    py.push(FLOOR_Y + pileHeight(x, z) - 0.04); // settled into the heap, not perched
    scl.push(0.82 + rand() * 0.3);
    const tip = (rand() - 0.5) * 1.5; // nothing in a claw machine has landed upright
    q.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(tip * 0.6, rand() * 6.283, tip)));
    const ear = 0.7 + rand() * 1.9; // short and round through to long and lopped
    for (const side of [-1, 1])
      earM.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(side * 0.05, 0.186, -0.008),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, side * 0.3)),
          new THREE.Vector3(1, ear, 1),
        ),
      );
    col.push(new THREE.Color(PILE_HUES[Math.floor(rand() * PILE_HUES.length)]));
  }
  return { px, py, pz, scl, q, earM, col, n: px.length };
}
const PILE = buildPile();

/* ---------- fuzz ---------- */
// Fur catches the light where it turns away from you; that halo is the entire
// difference between a plush and a moulded plastic toy. Patching the standard
// material rather than hand-rolling one keeps three's lighting and colour
// management — and the rim is the cabinet's neon, so the box lights its own prizes.
function makeFuzzMaterial(color: string, rim: THREE.Color, k: number, fade = false) {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: 0.97, metalness: 0, transparent: fade, opacity: 1,
  });
  const uRim = { value: rim };
  const uK = { value: k };
  m.userData.uRim = uRim;
  m.userData.uK = uK;
  m.onBeforeCompile = (s) => {
    s.uniforms.uRim = uRim;
    s.uniforms.uK = uK;
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRim;\nuniform float uK;")
      .replace(
        "#include <dithering_fragment>",
        `float fz = pow(1.0 - abs(dot(geometryNormal, geometryViewDir)), 2.4);
         gl_FragColor.rgb += uRim * (uK * fz);
         #include <dithering_fragment>`,
      );
  };
  return m;
}

/* ---------- the tag ---------- */
// Unit planes carrying half the card's uv each, so one message texture spans a fold
// that a hinge can actually swing. Scaling the mesh sizes them per message.
function halfUvPlane(u0: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, 1);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * 0.5);
  return g;
}
const inkLeftGeo = halfUvPlane(0);
const inkRightGeo = halfUvPlane(0.5);
const stockGeo = new THREE.PlaneGeometry(1, 1);
const punchGeo = new THREE.TorusGeometry(0.014, 0.005, 6, 14);
// Sized against the plush, not against the message: a tag the prize can plausibly be
// hugging in the heap. It reads at the reveal because the prize is 2.1x by then — and
// the HTML under the canvas is what carries the words anyway.
const CARD_W = 0.36;
const CARD_H_MAX = 0.26;

/* ---------- the hum ---------- */
// 50Hz through a tired ballast: the tube never quite settles, and that unrest is
// what a photograph of neon can never show you.
const hum = (e: number) =>
  1 + 0.05 * Math.sin(e * 13.9) + 0.032 * Math.sin(e * 31.1) + 0.018 * Math.sin(e * 47.3);
// …and the one tube whose starter is going. Deterministic, but never on a beat.
const sputter = (e: number) => {
  const g = Math.sin(e * 1.7) * Math.sin(e * 4.3 + 1.1) * Math.sin(e * 9.7 + 2.4);
  return g > 0.4 ? 0.2 + 0.5 * Math.abs(Math.sin(e * 61)) : 1;
};

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

/* ---------- the gantry's attract sweep ---------- */
// Both phases of a real cabinet: it plays with itself until somebody stops it. Phased
// so u = 0 is dead centre, which is where the show parks the claw — the preview loop
// wraps through that point and the seam never shows.
const SWEEP_X = (u: number) => Math.sin(u * 0.9) * 0.42;
const SWEEP_Z = (u: number) => Math.sin(u * 0.62) * 0.2 + 0.04;
const PREV_SX = SWEEP_X(PREV_LEAD);
const PREV_SZ = SWEEP_Z(PREV_LEAD);

// the prize perches on the crown rather than sinking into it — it is the one you
// can see, which is the only honest reason to have aimed at it
const HERO_SEAT_Y = FLOOR_Y + pileHeight(HERO_X, HERO_Z) + 0.04;
const GRIP_Y = HERO_SEAT_Y + GRIP_DROP; // hub height with the talons around the prize
const PIVOT_Y = RAIL_Y - 0.05;
const T_GRAB = T_CLOSE0 + 0.16;
const FALL_DUR = T_LAND - T_FALL0;
const TUMBLE_Y = 0.55 + FALL_DUR * 3.0;
const TUMBLE_Z = FALL_DUR * 1.9;
const HIT_H = 2.0;
const heroTarget = new THREE.Vector3();
const hubPos = new THREE.Vector3();
const prizePos = new THREE.Vector3();

export default function ClawMachineScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const cab = CABINETS[variants.cabinet] ?? CABINETS.bubblegum;
  const plush = PLUSHES[variants.plush] ?? PLUSHES.bear;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // `message` is "" on the gallery card and live-per-keystroke from /create, so the
  // tag can never depend on having one: fall back to the shared "For you" copy.
  const cardText = message.trim() || forRecipient(lang, recipientName);
  const card = useMemo(() => {
    const { texture, aspect } = makeTextTexture(cardText, {
      fontSize: 44, fontWeight: "400", color: "#4a3a44", maxWidthPx: 660,
      lineHeight: 1.45, padding: 44, lang,
    });
    // a long message wraps tall — trade the card's width for height rather than overflow
    let w = CARD_W;
    if (aspect * w > CARD_H_MAX) w = CARD_H_MAX / aspect;
    return { texture, w, h: w * aspect };
  }, [cardText, lang]);
  useEffect(() => () => card.texture.dispose(), [card]);

  const marquee = useMemo(
    () =>
      makeTextTexture(forRecipient(lang, recipientName), {
        fontSize: 70, fontWeight: "800", color: "#ffffff", glow: 22,
        maxWidthPx: 900, padding: 26, lang,
      }),
    [recipientName, lang],
  );
  useEffect(() => () => marquee.texture.dispose(), [marquee]);

  const mats = useMemo(() => {
    const rim = new THREE.Color(cab.neon);
    const neonMat = (c: string) =>
      new THREE.MeshStandardMaterial({
        color: "#ffffff", emissive: new THREE.Color(c), emissiveIntensity: 2.4,
        roughness: 0.25, toneMapped: false,
      });
    const m = {
      rim,
      paint: new THREE.MeshStandardMaterial({
        color: cab.paint, roughness: 0.5, metalness: 0.14, envMap: envTex, envMapIntensity: 0.4,
      }),
      trim: new THREE.MeshStandardMaterial({
        color: cab.trim, roughness: 0.32, metalness: 0.55, envMap: envTex, envMapIntensity: 0.8,
      }),
      // the one chrome thing in the room, and the reason the arcade env exists
      chrome: new THREE.MeshStandardMaterial({
        color: "#e6ecf6", roughness: 0.17, metalness: 1, envMap: envTex, envMapIntensity: 1.7,
      }),
      dark: new THREE.MeshStandardMaterial({ color: "#2b2438", roughness: 0.75 }),
      glass: new THREE.MeshStandardMaterial({
        color: cab.glass, roughness: 0.05, metalness: 0.2, envMap: envTex, envMapIntensity: 0.55,
        transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide,
      }),
      // smoked plastic: you can just make out the prize behind it, which is the point
      flap: new THREE.MeshStandardMaterial({
        color: "#2a2438", roughness: 0.2, metalness: 0.1, envMap: envTex, envMapIntensity: 1.1,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide,
      }),
      neon: neonMat(cab.neon),
      accent: neonMat(cab.accent),
      dying: neonMat(cab.neon), // the post whose starter is going
      fur: makeFuzzMaterial(plush.fur, rim, 0.52, true),
      belly: makeFuzzMaterial(plush.belly, rim, 0.4, true),
      pile: makeFuzzMaterial("#ffffff", rim, 0.46), // instanceColor tints it per plush
      nose: makeFuzzMaterial(plush.nose, rim, 0.28, true),
      // transparent so the preview loop's fade can reach them: everything on the prize
      // has to go together, or two black beads hang in the air after the bear has left
      bead: new THREE.MeshStandardMaterial({
        color: "#191119", roughness: 0.1, metalness: 0.25, envMap: envTex, envMapIntensity: 1.2,
        transparent: true,
      }),
      // the tag's eyelet is trim-coloured but cannot *be* `trim`: that material is the
      // rails, the fascia and the whole box, and the fade would take them with it
      punch: new THREE.MeshStandardMaterial({
        color: cab.trim, roughness: 0.32, metalness: 0.55, envMap: envTex, envMapIntensity: 0.8,
        transparent: true,
      }),
      stock: new THREE.MeshStandardMaterial({
        color: "#fff6e4", roughness: 0.88, side: THREE.DoubleSide, transparent: true,
      }),
    };
    const list: THREE.Material[] = [
      m.paint, m.trim, m.chrome, m.dark, m.glass, m.flap, m.neon, m.accent, m.dying,
      m.fur, m.belly, m.pile, m.nose, m.bead, m.punch, m.stock,
    ];
    return { ...m, list };
    // NOT keyed on `card`: /create re-renders this scene on every keystroke, and the
    // tag's ink is the only thing the message touches. It is declared in the JSX so a
    // new message swaps one map instead of rebuilding and disposing sixteen materials.
  }, [cab, plush]);
  useEffect(() => () => mats.list.forEach((x) => x.dispose()), [mats]);

  const fitRef = useRef<THREE.Group>(null);
  const wallRef = useRef<THREE.Mesh>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const bridgeRef = useRef<THREE.Group>(null);
  const trolleyRef = useRef<THREE.Group>(null);
  const cableRef = useRef<THREE.Mesh>(null);
  const clawRef = useRef<THREE.Group>(null);
  const fingerRefs = useRef<(THREE.Group | null)[]>([null, null, null]);
  const shadowRef = useRef<THREE.Sprite>(null);
  const shadowMatRef = useRef<THREE.SpriteMaterial>(null);
  const heroRef = useRef<THREE.Group>(null);
  const squashRef = useRef<THREE.Group>(null);
  const armLRef = useRef<THREE.Group>(null);
  const armRRef = useRef<THREE.Group>(null);
  const tagRef = useRef<THREE.Group>(null);
  const hingeRef = useRef<THREE.Group>(null);
  const flapRef = useRef<THREE.Group>(null);
  const pileBodyRef = useRef<THREE.InstancedMesh>(null);
  const pileHeadRef = useRef<THREE.InstancedMesh>(null);
  const pileEarRef = useRef<THREE.InstancedMesh>(null);
  const innerLightRef = useRef<THREE.PointLight>(null);
  const chuteLightRef = useRef<THREE.PointLight>(null);
  const heroLightRef = useRef<THREE.PointLight>(null);
  // The memo owns construction and disposal; the frame owns state — so every material
  // the frame drives is reached through an object carrying it, never through `mats`.
  const neonRef = useRef<THREE.Mesh>(null);
  const accentRef = useRef<THREE.Mesh>(null);
  const dyingRef = useRef<THREE.Mesh>(null);
  const marqueeMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const marqueeGlowRef = useRef<THREE.SpriteMaterial>(null);
  const puddleMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hitRef = useRef<THREE.Mesh>(null);

  const aim = useRef({ on: false, touched: false, x: 0, z: 0.04, idle: 0, alone: 0, dropped: -1 });
  const rig = useRef({ x: 0, z: 0.04, px: 0, pz: 0.04, sx: 0, sz: 0, rx: 0, rz: 0.04, ha: 1 });

  // Replay re-enters "opening" and the clock restarts, so every follower and every
  // latch has to restart with it or run 2 would drop the claw before you touched it.
  useLayoutEffect(() => {
    const a = aim.current, r = rig.current;
    a.on = a.touched = false;
    a.x = 0;
    a.z = 0.04;
    a.idle = a.alone = 0;
    a.dropped = -1;
    r.x = r.px = r.rx = 0;
    r.z = r.pz = r.rz = 0.04;
    r.sx = r.sz = 0;
    r.ha = -1; // force the prize's alpha to be re-applied on the next frame
  }, [phase]);

  // one colour per plush; the heap never changes, so this is a mount-time job
  useLayoutEffect(() => {
    const b = pileBodyRef.current, h = pileHeadRef.current, ea = pileEarRef.current;
    for (let i = 0; i < PILE.n; i++) {
      b?.setColorAt(i, PILE.col[i]);
      h?.setColorAt(i, PILE.col[i]);
      ea?.setColorAt(i * 2, PILE.col[i]);
      ea?.setColorAt(i * 2 + 1, PILE.col[i]);
    }
    for (const im of [b, h, ea]) if (im?.instanceColor) im.instanceColor.needsUpdate = true;
  }, []);

  /* ---------- the aim ---------- */
  const readAim = (ev: ThreeEvent<PointerEvent>) => {
    const hit = hitRef.current;
    const a = aim.current;
    if (!hit) return;
    hit.worldToLocal(tmpV.copy(ev.point));
    a.x = Math.max(-AIM_X, Math.min(AIM_X, tmpV.x));
    // drag up sends the gantry away from you: the plane maps to the field, not the glass
    a.z = lerp(AIM_Z0, AIM_Z1, clamp01(0.5 - tmpV.y / HIT_H));
    a.idle = 0;
    a.touched = true;
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || aim.current.dropped >= 0) return;
    // Capture, or a finger that wanders off the glass never releases and the claw
    // hangs there forever.
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* a nicety — the pointer-out fallback below covers its absence */
    }
    aim.current.on = true;
    readAim(ev);
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (!aim.current.on || phase !== "opening" || aim.current.dropped >= 0) return;
    readAim(ev);
  };
  const release = () => {
    const a = aim.current;
    if (!a.on) return;
    a.on = false;
    if (phase !== "opening" || a.dropped >= 0) return;
    a.dropped = tRef.current; // letting go is the whole gesture
    rig.current.rx = rig.current.x;
    rig.current.rz = rig.current.z;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const a = aim.current;
    const r = rig.current;

    /* fit: the camera never moves, so height is fixed and width is the only constraint —
       but that width swings 1.5 → 8.5 between a 390px portrait and a desktop reveal */
    const s = Math.max(
      0.62,
      Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H),
    );
    fitRef.current?.scale.setScalar(s);

    /* the room is not the subject, so it is not fitted — it is stretched to cover. The viewport
       is measured at the origin; the wall's foot is further out than that, by a fixed ratio. */
    if (wallRef.current)
      wallRef.current.scale.x = Math.max(
        1,
        (state.viewport.width * WALL_FOOT_D) / (state.viewport.distance * WALL_W),
      );

    /* ---- clocks ---- */
    const cyc = e % PREV_PERIOD;
    let tau: number; // the show: < 0 while the claw is still being aimed
    if (phase === "opening") {
      a.idle += dt;
      // The mercy is the no-input path's and only its, so it runs on its own clock: one
      // that stops while a hand is actually working the glass and starts again the moment
      // that hand goes still. A finger parked on the pane is not aiming.
      if (!(a.on && a.idle < 0.5)) a.alone += dt;
      if (a.dropped < 0 && a.alone >= T_MERCY1) {
        a.dropped = t;
        r.rx = r.x;
        r.rz = r.z;
      }
      tau = a.dropped >= 0 ? t - a.dropped : -1;
    } else if (phase === "revealed") {
      tau = OPEN_END; // a complete tableau from `phase` alone — reduced motion lands here cold
    } else if (phase === "preview") {
      tau = cyc - PREV_LEAD; // the whole gift on a loop: sweep, drop, win, hand it over, reset
    } else {
      tau = -1;
    }
    // preview hides the prize inside the machine for the last beat, so the loop's seam
    // is spent on an empty chute rather than on a plush teleporting back to the heap
    const rewind = phase === "preview" ? smooth(clamp01((tau - PREV_OUT) / 1.0)) : 0;
    const heroA =
      phase === "preview"
        ? Math.min(smooth(clamp01((tau + PREV_LEAD) / 0.7)), 1 - smooth(clamp01((tau - PREV_OUT) / 1.0)))
        : 1;
    if (phase === "preview" && tau > PREV_OUT + 1.0) tau = -PREV_LEAD; // faded out: pose it back on the heap

    /* ---- where the gantry is told to go ---- */
    let ax: number, az: number;
    if (phase === "opening" && a.touched) {
      ax = a.x;
      az = a.z;
    } else {
      // `tau`, not `cyc`: the loop's last beat has already been rewound to -PREV_LEAD, so
      // the sweep reads u = 0 there — the same dead-centre the show parks on. Off `cyc` the
      // seam is SWEEP(12.6…13), and the claw teleports a third of the box and back, twice
      // a loop, whipping the cable with it.
      const u = phase === "preview" ? tau + PREV_LEAD : phase === "opening" ? t : e;
      ax = SWEEP_X(u);
      az = SWEEP_Z(u);
    }
    // eased in from 2.6s of being left alone, all the way over by 5.9s: the machine
    // losing patience and taking the shot itself, not a timer going off
    const merc = phase === "opening" ? smooth(clamp01((a.alone - T_MERCY0) / (T_MERCY1 - T_MERCY0))) : 0;
    if (merc > 0) {
      ax = lerp(ax, HERO_X, merc);
      az = lerp(az, HERO_Z, merc);
    }

    /* ---- the slip: lurch, hang, yank ---- */
    // The hang is the whole gift. It is where you decide you have lost, which is the
    // only place a win can be given to you — so it is 36% of the beat, and the recovery
    // overshoots past the grip so the machine reads as having *caught* it.
    let slip = 0;
    if (tau > T_SLIP0 && tau < T_SLIP1) {
      const u = (tau - T_SLIP0) / (T_SLIP1 - T_SLIP0);
      slip =
        u < 0.26 ? easeOutCubic(u / 0.26)
        : u < 0.62 ? 1
        : 1 - easeOutBack((u - 0.62) / 0.38);
    }

    /* ---- the rig ---- */
    // once the prize is in the chute the gantry parks itself, the way it does between
    // players — and that pose is also the cold `revealed` tableau
    const home = tau < 0 ? 0 : smooth(clamp01((tau - T_HOME0) / 1.0));
    let cx: number, cz: number;
    if (tau < 0) {
      if (phase === "opening" && a.touched) {
        // a gantry has a motor: it chases the finger, it does not teleport to it
        r.x += (ax - r.x) * Math.min(1, dt * 6);
        r.z += (az - r.z) * Math.min(1, dt * 6);
      } else {
        r.x = ax; // the sweep is already a motor's motion
        r.z = az;
      }
      cx = r.x;
      cz = r.z;
    } else {
      // THE RIG IS RIGGED. Whatever it was aimed at, it finds the prize on the way
      // down — over the first two thirds of the descent, while every eye in the room
      // is on the claw's height, and disguised as the cable's own sway.
      const corr = easeInOut(clamp01(tau / (T_DESC1 * 0.66)));
      cx = lerp(phase === "opening" ? r.rx : PREV_SX, HERO_X, corr);
      cz = lerp(phase === "opening" ? r.rz : PREV_SZ, HERO_Z, corr);
      const trav = smooth(clamp01((tau - T_TRAV0) / (T_TRAV1 - T_TRAV0)));
      cx = lerp(cx, HOLE_X, trav);
      cz = lerp(cz, HOLE_Z, trav);
      cx = lerp(cx, 0, home);
      cz = lerp(cz, 0.04, home);
    }

    let hubY: number;
    if (tau < 0) hubY = CLAW_HOME_Y;
    else if (tau < T_DESC1) hubY = lerp(CLAW_HOME_Y, GRIP_Y, easeInOut(tau / T_DESC1));
    else if (tau < T_RISE0) hubY = GRIP_Y;
    else if (tau < T_RISE1)
      hubY = lerp(GRIP_Y, CLAW_HOME_Y, easeInOut(clamp01((tau - T_RISE0) / (T_RISE1 - T_RISE0))));
    else hubY = CLAW_HOME_Y;
    // the cable gives under a load that is getting away, and the whole gantry judders
    hubY -= slip * 0.06;
    hubY += 0.006 * Math.sin(tau * 90) * Math.abs(slip);

    // the claw lags the trolley, because it hangs off a cable and not a rod
    const vx = (cx - r.px) / Math.max(dt, 1e-4);
    const vz = (cz - r.pz) / Math.max(dt, 1e-4);
    r.px = cx;
    r.pz = cz;
    const k = Math.min(1, dt * 8);
    r.sx += (Math.max(-0.22, Math.min(0.22, -vx * 0.1)) - r.sx) * k;
    r.sz += (Math.max(-0.22, Math.min(0.22, vz * 0.1)) - r.sz) * k;
    const s1 = Math.sin(r.sx), s2 = Math.sin(r.sz);
    const cosC = Math.sqrt(Math.max(0.2, 1 - s1 * s1 - s2 * s2));
    const len = (PIVOT_Y - hubY) / cosC;
    // the hub and the prize are two beads threaded on one cable, so both swing together
    hubPos.set(cx + len * s1, hubY, cz - len * s2);
    const gd = GRIP_DROP + Math.max(0, slip) * 0.17;
    prizePos.set(cx + (len + gd) * s1, PIVOT_Y - (len + gd) * cosC, cz - (len + gd) * s2);

    bridgeRef.current?.position.setZ(cz);
    if (trolleyRef.current) trolleyRef.current.position.set(cx, PIVOT_Y + 0.04, cz);
    if (clawRef.current) {
      clawRef.current.position.copy(hubPos);
      clawRef.current.rotation.set(r.sz, 0, r.sx);
    }
    if (cableRef.current) {
      cableRef.current.position.set((cx + hubPos.x) / 2, (PIVOT_Y + hubY) / 2, (cz + hubPos.z) / 2);
      cableRef.current.rotation.set(r.sz, 0, r.sx);
      cableRef.current.scale.y = len;
    }

    /* ---- the talons ---- */
    // shut on the prize with a sprung overshoot, splay as it slides, then clench harder
    // than they need to on the recovery — one scalar says all three
    const closeBase =
      tau < T_CLOSE0 ? 0
      : tau < T_CLOSE1 ? easeOutBack(clamp01((tau - T_CLOSE0) / (T_CLOSE1 - T_CLOSE0)))
      : tau < T_LET0 ? 1
      : tau < T_LET1 ? 1 - easeOutCubic(clamp01((tau - T_LET0) / (T_LET1 - T_LET0)))
      : 0;
    const close = lerp(closeBase - slip * 0.32, 0.34, home);
    for (const g of fingerRefs.current) if (g) g.rotation.z = lerp(-0.6, 0.34, close);

    /* ---- the shadow, which is the aim ---- */
    // No shadow maps on this canvas, and no other depth cue in a glass box: this blob
    // riding the heap's own surface is the entire readability of the gesture. It tightens
    // and darkens as the claw comes down, the way a real one would.
    const top = pileTop(cx, cz);
    const dropK = clamp01((CLAW_HOME_Y - hubY) / (CLAW_HOME_Y - top - GRIP_DROP));
    const arr = smooth(clamp01((tau - T_ARR0) / (T_ARR1 - T_ARR0))) * (1 - rewind);
    if (shadowRef.current) {
      const sw = lerp(0.56, 0.24, dropK);
      shadowRef.current.position.set(hubPos.x, top + 0.02, hubPos.z);
      shadowRef.current.scale.set(sw, sw * 0.72, 1); // squashed, the way a high lamp casts
    }
    // and it goes out entirely once the prize is out of the box: nobody is aiming any more,
    // and a depth-blind blob would otherwise paint itself across the bear's face
    if (shadowMatRef.current) shadowMatRef.current.opacity = lerp(0.5, 0.85, dropK) * (1 - arr);

    /* ---- the heap ---- */
    // The talons land *in* the stuffing rather than hovering over it: everything within
    // a claw's width of the touchdown gives, and springs back when it lifts away.
    const press = clamp01((top + 0.34 - hubY) / 0.34);
    const bIM = pileBodyRef.current, hIM = pileHeadRef.current, eIM = pileEarRef.current;
    if (bIM && hIM && eIM) {
      for (let i = 0; i < PILE.n; i++) {
        const dx = PILE.px[i] - hubPos.x, dz = PILE.pz[i] - hubPos.z;
        const sq = press * Math.exp(-(dx * dx + dz * dz) / 0.032);
        const sc = PILE.scl[i];
        tmpV.set(PILE.px[i], PILE.py[i] - 0.03 * sq, PILE.pz[i]);
        tmpV2.set(sc * (1 + 0.13 * sq), sc * (1 - 0.24 * sq), sc * (1 + 0.13 * sq));
        tmpM.compose(tmpV, PILE.q[i], tmpV2);
        bIM.setMatrixAt(i, tmpM);
        hIM.setMatrixAt(i, tmpM2.multiplyMatrices(tmpM, HEAD_M));
        eIM.setMatrixAt(i * 2, tmpM2.multiplyMatrices(tmpM, PILE.earM[i * 2]));
        eIM.setMatrixAt(i * 2 + 1, tmpM2.multiplyMatrices(tmpM, PILE.earM[i * 2 + 1]));
      }
      bIM.instanceMatrix.needsUpdate = true;
      hIM.instanceMatrix.needsUpdate = true;
      eIM.instanceMatrix.needsUpdate = true;
    }

    /* ---- the prize ---- */
    let hrx = 0, hry = 0.55, hrz = 0;
    tmpV.set(HERO_X, HERO_SEAT_Y, HERO_Z); // its seat on the crown of the heap
    if (tau >= T_GRAB && tau < T_FALL0) {
      // GRIP_Y was defined as the seat plus the grip drop, so this handoff is silent
      tmpV.copy(prizePos);
      hrz = r.sx * 0.7 + slip * 0.32; // it swings with the cable, and lolls as it slides
      hrx = r.sz * 0.7;
      hry = 0.55 + r.sx * 0.5;
    } else if (tau >= T_FALL0) {
      const f = Math.min(tau, T_LAND) - T_FALL0;
      const fk = smooth(clamp01(f / FALL_DUR));
      tmpV.set(
        lerp(HOLE_X, CHUTE_X, fk),
        Math.max(LAND_Y, FALL_Y0 - 0.5 * G * f * f), // g at this scale, not a number that looked right
        lerp(HOLE_Z, LAND_Z, fk),
      );
      hry = 0.55 + f * 3.0;
      hrz = f * 1.9;
      if (tau > T_LAND) {
        const b = tau - T_LAND;
        tmpV.y += Math.exp(-b * 7) * Math.abs(Math.sin(b * 15)) * 0.09; // it bounces once
        const st = smooth(clamp01(b / 0.35));
        hry = lerp(TUMBLE_Y, 0.25, st);
        hrz = lerp(TUMBLE_Z, 0.06, st);
      }
    }
    if (arr > 0) {
      // and then it is handed to you: out through the flap, and toward you, growing to
      // the only scale at which a plush is a plush. HERO_S is a *world* size, so it is
      // divided back out of the portrait fit or a phone would shrink the gift itself.
      heroTarget.set(HERO_POSE.x / s, HERO_POSE.y / s, HERO_POSE.z / s);
      tmpV.lerp(heroTarget, arr);
      const bulge = Math.sin(arr * Math.PI);
      tmpV.z += bulge * 0.12;
      tmpV.y += bulge * 0.14 / s;
      hry = lerp(hry, 0, arr);
      hrz = lerp(hrz, 0, arr);
      hrx = lerp(hrx, 0, arr);
      // held, it is never quite still
      tmpV.y += Math.sin(e * 1.15) * 0.03 * arr;
      hry += Math.sin(e * 0.7) * 0.1 * arr;
      hrz += Math.sin(e * 0.9 + 1) * 0.045 * arr;
    }
    if (heroRef.current) {
      heroRef.current.position.copy(tmpV);
      heroRef.current.rotation.set(hrx, hry, hrz);
      heroRef.current.scale.setScalar(lerp(1, HERO_S / s, arr));
      heroRef.current.visible = heroA > 0.01;
    }
    // the talons dig in, the yank knocks the stuffing about, the chute floor does the rest
    const landSq = tau > T_LAND ? Math.exp(-(tau - T_LAND) * 9) : 0;
    const grip = tau < T_LET0 ? clamp01(close) : 0;
    const sq = 0.1 * grip + 0.13 * Math.max(0, -slip) + 0.16 * landSq;
    squashRef.current?.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);

    /* ---- the tag ---- */
    const tagOpen = smooth(clamp01((tau - T_TAG0) / (T_TAG1 - T_TAG0))) * (1 - rewind);
    if (tagRef.current)
      tagRef.current.position.set(-card.w * 0.25 * tagOpen, plush.tagY, plush.tagZ);
    if (hingeRef.current) {
      // paper springs at the end of a fold, and never lies quite flat again
      const flut = Math.exp(-tagOpen * 5) * Math.sin(tagOpen * 19) * 0.11;
      hingeRef.current.rotation.y = (1 - tagOpen) * Math.PI + flut + 0.055 * tagOpen;
    }
    // the paws come round the card's edges and forward past its face, and the card
    // opening pushes them wider still — which is the hug, and the only reason the prize
    // reads as holding the thing rather than standing behind it
    const armA = lerp(0.5, 0.6, arr) + tagOpen * 0.2;
    const armF = lerp(0, -1.48, arr);
    if (armLRef.current) armLRef.current.rotation.set(armF, 0, -armA);
    if (armRRef.current) armRRef.current.rotation.set(armF, 0, armA);
    // The prize is six materials across three body plans, so they are reached off the
    // assembled thing rather than named — and only when the number actually moves,
    // which outside the preview loop's two fade windows is never.
    if (heroA !== r.ha) {
      r.ha = heroA;
      heroRef.current?.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m?.transparent) m.opacity = heroA;
      });
    }

    /* ---- the chute ---- */
    const won = smooth(clamp01((tau - T_LAND) / 0.35)) * (1 - rewind);
    if (flapRef.current) {
      const flap = smooth(clamp01((tau - T_FLAP0) / (T_FLAP1 - T_FLAP0))) * (1 - rewind);
      // it rattles when the prize hits it, before it ever opens
      flapRef.current.rotation.x = -flap * 1.15 - landSq * 0.09 * Math.sin(tau * 46);
    }

    /* ---- the neon ---- */
    const h = hum(e);
    // the machine strains under a load that is getting away, and every tube says so
    const strain = 1 - 0.34 * Math.max(0, slip) * (0.5 + 0.5 * Math.sin(tau * 42));
    const dim = lerp(1, 0.5, arr); // the prize is the subject now
    const kk = h * strain * dim;
    const neonMat = neonRef.current?.material as THREE.MeshStandardMaterial | undefined;
    const accentMat = accentRef.current?.material as THREE.MeshStandardMaterial | undefined;
    const dyingMat = dyingRef.current?.material as THREE.MeshStandardMaterial | undefined;
    if (neonMat) neonMat.emissiveIntensity = 2.6 * kk;
    if (accentMat) accentMat.emissiveIntensity = (1.5 + 1.5 * won) * kk;
    if (dyingMat) dyingMat.emissiveIntensity = 2.6 * kk * sputter(e);
    if (marqueeMatRef.current) marqueeMatRef.current.opacity = 0.92 * kk;
    if (marqueeGlowRef.current) marqueeGlowRef.current.opacity = 0.3 * kk;
    if (puddleMatRef.current) puddleMatRef.current.opacity = 0.26 * kk;
    if (innerLightRef.current) innerLightRef.current.intensity = 2.2 * h * dim;
    if (chuteLightRef.current) chuteLightRef.current.intensity = (1.1 + 2.2 * won) * h * dim;
    if (heroLightRef.current) heroLightRef.current.intensity = 2.1 * arr;

    /* ---- the cabinet leans toward the pointer, and flinches on the slip ---- */
    if (tiltRef.current) {
      const kt = Math.min(1, dt * 3);
      const shake = Math.abs(slip) * 0.008 * Math.sin(tau * 70);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.05, kt) + shake;
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.06, kt);
      tiltRef.current.rotation.z = shake * 0.6;
    }

    if (phase === "opening" && tau >= OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const cw = card.w, ch = card.h;
  // the marquee is 0.46 tall and a long name wraps to two lines: fit the sign to the
  // board rather than letting the board decide the name is too long
  const mw = Math.min(1.62, 0.3 / marquee.aspect);
  return (
    <>
      {/* A player stands over the glass and looks down into it. Nothing here is bought
          cheaply by that: every face of the cabinet is vertical, so only the field's
          floor foreshortens — and the field's floor is the one thing worth seeing. */}
      <PerspectiveCamera makeDefault position={[0, CAM_Y, CAM_Z]} fov={FOV} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.36} color={cab.amb} />
      {/* the key comes in over your shoulder; the back light is the cabinet's own tubes */}
      <directionalLight position={[-1.8, 2.6, 4]} intensity={0.8} color={cab.key} />
      <directionalLight position={[2.8, 0.9, -3]} intensity={0.7} color={cab.neon} />

      {/* the arcade — outside the fit, because it is the room and not the subject */}
      <mesh ref={wallRef} position={[0, WALL_Y, WALL_Z]}>
        <planeGeometry args={[WALL_W, WALL_H * 1.3]} />
        <meshBasicMaterial map={wallTex} color={cab.room} />
      </mesh>

      <group ref={fitRef}>
        {/* the floor sits outside the lean: a 24u plane tipped even 0.05 rad lifts its
            far edge half a unit and the horizon would swim */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, BASE_Y0, -0.7]}>
          <planeGeometry args={[24, 8]} />
          <meshStandardMaterial
            color="#0c0a12" roughness={0.34} metalness={0.55} envMap={envTex} envMapIntensity={0.55}
          />
        </mesh>
        {/* the tubes puddling on the floor — the only reason the room reads as an arcade */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, BASE_Y0 + 0.005, 0.55]}>
          <planeGeometry args={[3.8, 3.2]} />
          <meshBasicMaterial
            ref={puddleMatRef} map={puddleTex} color={cab.neon} transparent opacity={0.26}
            depthWrite={false} blending={THREE.AdditiveBlending}
          />
        </mesh>

        <group ref={tiltRef}>
          {/* ---- the base ---- */}
          <mesh position={[0, (BASE_Y0 + BASE_Y1) / 2, -0.22]} material={mats.paint}>
            <boxGeometry args={[CAB_W, BASE_Y1 - BASE_Y0, 0.66]} />
          </mesh>
          {/* the trough the prize lands in, and the walls that funnel it there */}
          <mesh position={[CHUTE_X, CHUTE_Y0, 0.29]} material={mats.dark}>
            <boxGeometry args={[CHUTE_W, 0.04, 0.4]} />
          </mesh>
          {[-1, 1].map((sx) => (
            <mesh key={sx} position={[CHUTE_X + (sx * CHUTE_W) / 2, -0.93, 0.29]} material={mats.dark}>
              <boxGeometry args={[0.03, 0.66, 0.4]} />
            </mesh>
          ))}
          {/* one plate with the chute cut out of it — the opening is an absence, not a decal */}
          <mesh position={[0, 0, FRONT_Z - 0.09]} geometry={fasciaGeo} material={mats.paint} />
          <pointLight
            ref={chuteLightRef} position={[CHUTE_X, -0.9, 0.32]} intensity={0.4}
            color={cab.accent} distance={2.2} decay={1.6}
          />
          <mesh
            ref={accentRef} geometry={chuteNeon}
            position={[CHUTE_X, (CHUTE_Y0 + CHUTE_Y1) / 2, FRONT_Z + 0.012]} material={mats.accent}
          />
          {/* smoked plastic, hinged at the top: you can just make out the prize behind it */}
          <group ref={flapRef} position={[CHUTE_X, CHUTE_Y1 - 0.02, FRONT_Z + 0.028]}>
            <mesh position={[0, -0.31, 0]} material={mats.flap}>
              <boxGeometry args={[CHUTE_W - 0.05, 0.62, 0.014]} />
            </mesh>
          </group>

          {/* the control panel nobody will ever need */}
          <group position={[0.46, BASE_Y1 - 0.13, FRONT_Z - 0.03]} rotation={[-0.42, 0, 0]}>
            <mesh material={mats.trim}>
              <boxGeometry args={[1.0, 0.3, 0.05]} />
            </mesh>
            <mesh position={[-0.3, 0.02, 0.04]} material={mats.chrome}>
              <cylinderGeometry args={[0.05, 0.055, 0.018, 16]} />
            </mesh>
            <mesh position={[-0.3, 0.055, 0.04]} material={mats.chrome}>
              <cylinderGeometry args={[0.008, 0.008, 0.06, 8]} />
            </mesh>
            <mesh position={[-0.3, 0.095, 0.04]} material={mats.neon}>
              <sphereGeometry args={[0.032, 14, 12]} />
            </mesh>
            {[0.02, 0.2].map((bx, i) => (
              <mesh key={bx} position={[bx, 0.01, 0.035]} material={i ? mats.accent : mats.neon}>
                <cylinderGeometry args={[0.045, 0.045, 0.022, 18]} />
              </mesh>
            ))}
            {/* the coin slot, for the money this one will never take */}
            <mesh position={[0.4, 0.02, 0.03]} material={mats.dark}>
              <boxGeometry args={[0.022, 0.09, 0.01]} />
            </mesh>
          </group>

          {/* ---- the glass box ---- */}
          {/* dark inside, so the prizes are the only thing the eye is offered */}
          <mesh position={[0, (BASE_Y1 + BOX_Y1) / 2, -CAB_D / 2 + 0.015]} material={mats.dark}>
            <boxGeometry args={[CAB_W - 0.06, BOX_Y1 - BASE_Y1, 0.03]} />
          </mesh>
          {[-1, 1].map((sx) =>
            [-1, 1].map((sz) => (
              <mesh
                key={`${sx}${sz}`}
                position={[(sx * (CAB_W - 0.05)) / 2, (BASE_Y1 + BOX_Y1) / 2, (sz * (CAB_D - 0.05)) / 2]}
                material={mats.trim}
              >
                <boxGeometry args={[0.05, BOX_Y1 - BASE_Y1, 0.05]} />
              </mesh>
            )),
          )}
          {/* the fluorescent bank, and the ceiling it is screwed to */}
          <mesh position={[0, BOX_Y1 - 0.02, 0]} material={mats.trim}>
            <boxGeometry args={[CAB_W - 0.06, 0.04, CAB_D - 0.06]} />
          </mesh>
          <mesh position={[0, BOX_Y1 - 0.045, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.72, 0.78]} />
            <meshBasicMaterial color={cab.inner} toneMapped={false} />
          </mesh>
          <pointLight
            ref={innerLightRef} position={[0, BOX_Y1 - 0.14, 0.12]} intensity={2.2}
            color={cab.inner} distance={3.4} decay={1.4}
          />

          {/* the play field's floor, with the drop hole actually cut through it */}
          <mesh
            rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y - 0.05, 0]}
            geometry={fieldFloorGeo} material={mats.trim}
          />

          {/* The heap: three instanced parts, eleven plushes, three draw calls. Only the
              count rides in `args` — R3F rebuilds an instance from scratch the moment any
              arg changes identity, and picking a cabinet is a new `pile` material, which
              would hand back three fresh meshes with their instanceColor gone and the
              whole heap white. Geometry and material are plain props, which just swap. */}
          <instancedMesh
            ref={pileBodyRef} args={[undefined, undefined, PILE.n]}
            geometry={bodyGeo} material={mats.pile} frustumCulled={false}
          />
          <instancedMesh
            ref={pileHeadRef} args={[undefined, undefined, PILE.n]}
            geometry={headGeo} material={mats.pile} frustumCulled={false}
          />
          <instancedMesh
            ref={pileEarRef} args={[undefined, undefined, PILE.n * 2]}
            geometry={earGeo} material={mats.pile} frustumCulled={false}
          />

          {/* The aiming shadow. A ground-plane quad is the honest way to fake one, and
              here it is the wrong way: the camera looks down at 8°, so a flat disc on the
              heap is an edge-on sliver worth four pixels. A billboard is within 8° of flat
              and always reads — and 8° of error in a soft blob is not a thing anyone can
              see. It tightens and darkens as the claw comes down, which is the only depth
              cue in a box with no shadow maps, and the whole readability of the gesture. */}
          <sprite ref={shadowRef} renderOrder={2}>
            <spriteMaterial
              ref={shadowMatRef} map={shadowTex} color="#000000" transparent opacity={0.5}
              depthWrite={false} depthTest={false}
            />
          </sprite>

          {/* ---- the gantry: rails in z, a bridge across them, a trolley along it ---- */}
          {[-1, 1].map((sx) => (
            <mesh
              key={sx} position={[(sx * (CAB_W - 0.28)) / 2, RAIL_Y, (FIELD_Z0 + FIELD_Z1) / 2]}
              rotation={[Math.PI / 2, 0, 0]} geometry={railGeo} material={mats.chrome}
            />
          ))}
          <group ref={bridgeRef}>
            <mesh position={[0, RAIL_Y, 0]} material={mats.trim}>
              <boxGeometry args={[CAB_W - 0.26, 0.028, 0.05]} />
            </mesh>
          </group>
          <mesh ref={trolleyRef} geometry={trolleyGeo} material={mats.trim} />
          <mesh ref={cableRef} geometry={cableGeo} material={mats.chrome} />
          <group ref={clawRef}>
            <mesh geometry={hubGeo} material={mats.chrome} />
            <mesh position={[0, 0.05, 0]} geometry={capGeo} material={mats.chrome} scale={[1, 0.7, 1]} />
            {[0, 1, 2].map((i) => (
              <group key={i} rotation={[0, (i * Math.PI * 2) / 3, 0]}>
                <group
                  ref={(el) => {
                    fingerRefs.current[i] = el;
                  }}
                  position={[0.048, -0.03, 0]}
                >
                  <mesh geometry={talonGeo} material={mats.chrome} />
                </group>
              </group>
            ))}
          </group>

          {/* ---- the prize ---- */}
          <group ref={heroRef}>
            <group ref={squashRef}>
              {plush.kind === "star" ? (
                <>
                  <mesh geometry={starGeo} material={mats.fur} scale={[1, 1, 0.8]} />
                  <mesh geometry={eyeGeo} material={mats.bead} position={[-0.042, 0.028, 0.062]} />
                  <mesh geometry={eyeGeo} material={mats.bead} position={[0.042, 0.028, 0.062]} />
                  <mesh
                    geometry={noseGeo} material={mats.nose} position={[0, -0.018, 0.06]}
                    scale={[2.2, 0.55, 0.5]}
                  />
                </>
              ) : (
                <>
                  {/* a bag of stuffing that has been sat on: wider than it is tall, everywhere */}
                  <mesh geometry={bodyGeo} material={mats.fur} scale={[1.18, 1, 1.06]} />
                  <mesh
                    geometry={bodyGeo} material={mats.belly} position={[0, -0.012, 0.048]}
                    scale={[0.76, 0.62, 0.78]}
                  />
                  <group position={[0, 0.132, 0.012]}>
                    <mesh geometry={headGeo} material={mats.fur} scale={[1.06, 0.94, 1]} />
                    {[-1, 1].map((sx) => (
                      <mesh
                        key={sx} geometry={earGeo} material={mats.fur}
                        position={[sx * plush.earPos[0], plush.earPos[1], plush.earPos[2]]}
                        rotation={[0, 0, sx * 0.3]}
                        scale={plush.ear}
                      />
                    ))}
                    <mesh
                      geometry={snoutGeo} material={mats.belly} position={[0, -0.024, 0.062]}
                      scale={[1.2, 0.8, 0.85]}
                    />
                    <mesh
                      geometry={noseGeo} material={mats.nose} position={[0, -0.008, 0.095]}
                      scale={[1.3, 0.85, 0.8]}
                    />
                    <mesh geometry={eyeGeo} material={mats.bead} position={[-0.036, 0.024, 0.07]} />
                    <mesh geometry={eyeGeo} material={mats.bead} position={[0.036, 0.024, 0.07]} />
                  </group>
                </>
              )}
              <group ref={armLRef} position={[-plush.armX, plush.armY, 0.055]}>
                <mesh geometry={limbGeo} material={mats.fur} position={[-0.026, -0.062, 0]} scale={[1, 1.25, 1]} />
              </group>
              <group ref={armRRef} position={[plush.armX, plush.armY, 0.055]}>
                <mesh geometry={limbGeo} material={mats.fur} position={[0.026, -0.062, 0]} scale={[1, 1.25, 1]} />
              </group>
              {[-1, 1].map((sx) => (
                <mesh
                  key={sx} geometry={limbGeo} material={mats.fur}
                  position={[sx * plush.legX, plush.legY, 0.03]}
                  rotation={[-0.5, 0, sx * 0.18]} scale={[1.15, 0.9, 1.15]}
                />
              ))}

              {/* the tag it has been hugging since it was on the heap — which is, if you
                  were wondering, exactly why it is the one you wanted */}
              <group ref={tagRef} position={[0, plush.tagY, plush.tagZ]}>
                <mesh geometry={stockGeo} material={mats.stock} scale={[cw / 2, ch * 1.04, 1]} />
                <mesh geometry={inkLeftGeo} position={[0, 0, 0.002]} scale={[cw / 2, ch, 1]}>
                  <meshBasicMaterial
                    map={card.texture} transparent depthWrite={false} toneMapped={false}
                  />
                </mesh>
                <mesh
                  geometry={punchGeo} material={mats.punch}
                  position={[-cw / 4 + 0.032, ch * 0.42, 0]}
                />
                <group ref={hingeRef} position={[cw / 4, 0, 0.004]}>
                  <mesh
                    geometry={stockGeo} material={mats.stock} position={[cw / 4, 0, 0]}
                    scale={[cw / 2, ch * 1.04, 1]}
                  />
                  <mesh geometry={inkRightGeo} position={[cw / 4, 0, 0.002]} scale={[cw / 2, ch, 1]}>
                    <meshBasicMaterial
                      map={card.texture} transparent depthWrite={false} toneMapped={false}
                    />
                  </mesh>
                </group>
              </group>
            </group>
          </group>
          <pointLight
            ref={heroLightRef} position={[0.1, 0.5, 3.1]} intensity={0} color={cab.key}
            distance={5} decay={1.5}
          />

          {/* ---- the glass, last, so it sits over everything it is holding in ---- */}
          {[
            [0, (BASE_Y1 + BOX_Y1) / 2, FRONT_Z, 0, CAB_W - 0.1],
            [-(CAB_W - 0.02) / 2, (BASE_Y1 + BOX_Y1) / 2, 0, Math.PI / 2, CAB_D - 0.1],
            [(CAB_W - 0.02) / 2, (BASE_Y1 + BOX_Y1) / 2, 0, Math.PI / 2, CAB_D - 0.1],
          ].map(([x, y, z, ry, w], i) => (
            <mesh key={i} position={[x, y, z]} rotation={[0, ry, 0]} material={mats.glass} renderOrder={3}>
              <planeGeometry args={[w, BOX_Y1 - BASE_Y1 - 0.06]} />
            </mesh>
          ))}
          {/* the ceiling strips smeared across the pane: the reflection is what makes it glass */}
          <mesh position={[0, (BASE_Y1 + BOX_Y1) / 2, FRONT_Z + 0.004]} renderOrder={4}>
            <planeGeometry args={[CAB_W - 0.1, BOX_Y1 - BASE_Y1 - 0.06]} />
            <meshBasicMaterial
              map={glareTex} color="#ffffff" transparent opacity={0.14} depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* ---- the marquee ---- */}
          <mesh position={[0, (BOX_Y1 + MARQ_Y1) / 2, -0.06]} material={mats.paint}>
            <boxGeometry args={[CAB_W, MARQ_Y1 - BOX_Y1, CAB_D - 0.12]} />
          </mesh>
          <mesh
            ref={neonRef} geometry={marqueeNeon} position={[0, (BOX_Y1 + MARQ_Y1) / 2, FRONT_Z - 0.07]}
            material={mats.neon}
          />
          <mesh position={[0, (BOX_Y1 + MARQ_Y1) / 2, FRONT_Z - 0.055]}>
            <planeGeometry args={[mw, mw * marquee.aspect]} />
            <meshBasicMaterial
              ref={marqueeMatRef} map={marquee.texture} color={cab.accent} transparent opacity={0.9}
              depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
            />
          </mesh>
          <sprite position={[0, (BOX_Y1 + MARQ_Y1) / 2, FRONT_Z - 0.04]} scale={[2.4, 1.0, 1]}>
            <spriteMaterial
              ref={marqueeGlowRef} map={glowTex} color={cab.neon} transparent opacity={0.3}
              depthWrite={false} blending={THREE.AdditiveBlending}
            />
          </sprite>

          {/* the corner tubes — and the left one's starter is on its way out */}
          <mesh
            ref={dyingRef} geometry={postNeon}
            position={[-(CAB_W + 0.02) / 2, (BASE_Y1 + BOX_Y1) / 2, FRONT_Z - 0.04]}
            material={mats.dying}
          />
          <mesh
            geometry={postNeon}
            position={[(CAB_W + 0.02) / 2, (BASE_Y1 + BOX_Y1) / 2, FRONT_Z - 0.04]}
            material={mats.neon}
          />

          {/* three r185 raycasts straight through `visible={false}`, so an invisible hit
              target has to be a transparent one or the aim is silently eaten. It sits at
              the field's own depth, not on the glass — a plane out at the pane would put
              the claw a parallax-width off the finger that is supposedly dragging it. */}
          {phase === "opening" && (
            <mesh
              ref={hitRef}
              position={[0, 0.3, 0.05]}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={release}
              onPointerCancel={release}
              onPointerOut={release}
            >
              <planeGeometry args={[3.0, HIT_H]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          )}
        </group>
      </group>
    </>
  );
}
