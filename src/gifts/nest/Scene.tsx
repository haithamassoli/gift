import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, orderWritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
const BIRDS: Record<string, { body: string; wing: string; cap: string; call: number }> = {
  bulbul: { body: "#4b3a2e", wing: "#2e241c", cap: "#151011", call: 1174 },
  swallow: { body: "#22304a", wing: "#151d2e", cap: "#8b3a2a", call: 1568 },
  sparrow: { body: "#7a6242", wing: "#4e3d28", cap: "#8f6a3a", call: 1046 },
};
/* `cold` and `warm` are the same key light before and after the sun is over the
   horizon — the build is what carries it from one to the other, so the hour of the
   day is a readout of how much nest there is. */
const LIGHTS: Record<
  string,
  { top: string; low: string; sun: string; amb: number; twig: string; cold: THREE.Color; warm: THREE.Color }
> = {
  dawn: {
    top: "#9fb6cf", low: "#f2d3b0", sun: "#ffe2bd", amb: 0.62, twig: "#6b543a",
    cold: new THREE.Color("#6d84a8"), warm: new THREE.Color("#ffe2bd"),
  },
  golden: {
    top: "#7fa0c4", low: "#ffc477", sun: "#ffb254", amb: 0.7, twig: "#7d6038",
    cold: new THREE.Color("#63799e"), warm: new THREE.Color("#ffb254"),
  },
  dusk: {
    top: "#2f3a5c", low: "#c07a6a", sun: "#ff9a72", amb: 0.42, twig: "#4a3a2a",
    cold: new THREE.Color("#38466b"), warm: new THREE.Color("#ff9a72"),
  },
};

const TWIGS = 900;
const TRIPS = 8; // swipes to build the whole nest
const PER_TRIP = TWIGS / TRIPS;
const ARRIVE = PER_TRIP * 0.28; // twigs still visibly dropping behind the newest one
const ACTION_W = 3.0;
const ACTION_H = 2.5;
const REVEAL_HOLD = 2.3; // the reveal is six beats long, and this covers all of them

/* ---------- the gesture ---------- */
const SWIPE_MIN = 0.32; // what counts as a swipe at all
const SWIPE_FULL = 1.1; // …and what counts as throwing them
const V_FULL = 3.2; // world units·s⁻¹ at full strength
const V_DECAY = 0.09; // peak-hold, so the launch reads the stroke and not one sample

/* ---------- the mercy: a gift may never lock waiting for input ----------
   Left alone, the pair keeps working. It is the same event as a swipe — the same
   push-off, the same arc, the same twig, the same landing — only nobody asked for
   it. MERCY_GRACE is long enough that a hand already on its way down is never
   overridden; after that one trip leaves every MERCY_DUR + MERCY_GAP, tentative at
   first and brisker as they settle into the work. The whole no-input build lands
   ~2.2 + 8·(≈0.54 + 0.03) + REVEAL_HOLD ≈ 9s of scene clock — measured at ~9.5s of
   wall clock in the browser, well inside the 12s house bound. */
const MERCY_GRACE = 2.2;
const MERCY_GAP = 0.03; // the beat on the perch between one landing and the next launch
const MERCY_DUR0 = 0.66; // the first unattended trip is the slow one…
const MERCY_DUR1 = 0.42; // …and the last is flown by birds who have done it seven times
const MERCY_STR0 = 0.45; // arc size / voice of the first auto trip…
const MERCY_STR1 = 0.9; // …and of the last

/* ---------- the trip ---------- */
const TRIP_SLOW = 1.4;
const TRIP_FAST = 0.82;
const REACH_MIN = 1.1;
const REACH_MAX = 2.05;
const CLIMB_MIN = 0.34;
const CLIMB_MAX = 0.95;
const SWING = 0.34; // how far out of plane the arc bows — the turn you see them bank into

/* ---------- the branch ---------- */
const PERCH_X = 0.3;
const PERCH_Y = -0.845;
const PERCH_Z = -0.06;
const BRANCH_Y = -0.95;
const BRANCH_K = 46; // a bare branch is springy; two small birds are not much load
const BRANCH_C = 5.2; // …and it is still a branch, so it stops after two bounces

const DOWN_N = 36; // down feathers, shaken loose
const DOWN_LIFE = 2.6;
const LEAF_N = 12;
const MOTE_N = 60;
const PREV_PERIOD = 9;

/* A twig is a short cylinder. Instanced, because 900 of them is the aesthetic and
   900 draw calls is not. */
const twigGeo = new THREE.CylinderGeometry(0.0045, 0.003, 1, 4);
const eggGeo = new THREE.SphereGeometry(0.062, 16, 12);
eggGeo.scale(1, 1.28, 1);
/* a leaf is a hexagon squashed along one axis — from this distance that is a leaf */
const leafGeo = new THREE.CircleGeometry(1, 6);
leafGeo.scale(1, 0.42, 1);

/* ---------- the bird: two-triangle wings, two-frame flap ---------- */
const bodyGeo = new THREE.SphereGeometry(0.05, 12, 9);
bodyGeo.scale(1.5, 1, 1);
const headGeo = new THREE.SphereGeometry(0.032, 10, 8);
const beakGeo = new THREE.ConeGeometry(0.011, 0.045, 6);
const tailGeo = new THREE.PlaneGeometry(0.07, 0.028);
const legGeo = new THREE.CylinderGeometry(0.004, 0.003, 0.06, 4);
const wingGeo = (() => {
  // one triangle, hinged at the shoulder
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 0.13, 0.015, -0.03, 0.03, -0.004, -0.075], 3),
  );
  g.computeVertexNormals();
  return g;
})();

/** Everything the parent decides about a bird in one frame. A plain module-level
 *  bag, filled and read inside a single synchronous call, so posing the pair costs
 *  no allocation and nothing outside the bird ever touches the bird's own refs. */
interface BirdPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  bank: number;
  /** 0 = gliding on a held wing, 1 = working. */
  flap: number;
  /** wingbeats per second·2π — faster on the climb. */
  hz: number;
  /** legs folded under, body low: the wind-up before a push-off. */
  crouch: number;
  headYaw: number;
  headPitch: number;
  tail: number;
  carry: number;
  /** feathers fluffed — waiting in the cold, or just landed. */
  puff: number;
  /** feet down on something. */
  perch: number;
  /** the frame, for the one thing about a bird that has to be integrated. */
  dt: number;
}
const BP: BirdPose = {
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0, flap: 0, hz: 22,
  crouch: 0, headYaw: 0, headPitch: 0, tail: 0, carry: 0, puff: 0, perch: 1, dt: 0,
};

export interface BirdHandle {
  pose(p: BirdPose): void;
}

const Bird = forwardRef<BirdHandle, { pal: (typeof BIRDS)[string] }>(function Bird({ pal }, handle) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const tailRef = useRef<THREE.Group>(null);
  const legsRef = useRef<THREE.Group>(null);
  const wingLRef = useRef<THREE.Group>(null);
  const wingRRef = useRef<THREE.Group>(null);
  const twigRef = useRef<THREE.Mesh>(null);
  const beatRef = useRef(0);

  useImperativeHandle(handle, () => ({
    pose(p) {
      const root = rootRef.current;
      if (!root) return;
      root.position.set(p.x, p.y, p.z);
      // Yaw about world up, then pitch and roll about the body's own axes — an Euler
      // triple would roll about world x and bank a bird flying across the frame the
      // wrong way entirely. Turning, never a negative scale: that would reverse the
      // winding and let us see the inside of the bird.
      root.rotation.set(0, p.yaw, 0);
      root.rotateZ(p.pitch);
      root.rotateX(p.bank);

      const body = bodyRef.current;
      if (body) {
        body.position.y = -p.crouch * 0.026;
        body.rotation.z = -p.crouch * 0.26;
        body.scale.setScalar(1 + p.puff * 0.1);
      }
      const head = headRef.current;
      if (head) head.rotation.set(0, p.headYaw, p.headPitch);
      const tail = tailRef.current;
      if (tail) {
        tail.rotation.z = p.tail * 0.55 - p.crouch * 0.3;
        tail.rotation.x = p.tail * 0.4;
      }
      const legs = legsRef.current;
      if (legs) {
        legs.visible = p.perch > 0.02;
        legs.scale.set(1, Math.max(0.15, p.perch * (1 - p.crouch * 0.5)), 1);
      }
      // A two-frame flap: up or down, nothing between. Small birds do not ease. What
      // does ease is how much of it there is — a bird gliding down holds the wing out.
      // The phase is integrated, not sin(clock·rate): the rate changes every frame of a
      // trip, and a rate read against a clock minutes old jumps the phase by radians
      // per frame — which is a strobe, not a wingbeat, and a different one each replay.
      beatRef.current = (beatRef.current + p.hz * p.dt) % (Math.PI * 2);
      const beat = Math.sin(beatRef.current) > 0 ? 1 : -1;
      const a = lerp(-0.16 - p.crouch * 0.45, beat * 0.95, p.flap);
      if (wingLRef.current) {
        wingLRef.current.rotation.x = a;
        wingLRef.current.rotation.y = -p.flap * 0.14 * beat;
      }
      if (wingRRef.current) {
        wingRRef.current.rotation.x = -a;
        wingRRef.current.rotation.y = p.flap * 0.14 * beat;
      }
      if (twigRef.current) twigRef.current.visible = p.carry > 0.5;
    },
  }));

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        <mesh geometry={bodyGeo}>
          <meshStandardMaterial color={pal.body} roughness={0.85} />
        </mesh>
        {/* the head is its own group so a head turn is a head turn and not a whole bird */}
        <group ref={headRef} position={[0.062, 0.028, 0]}>
          <mesh geometry={headGeo}>
            <meshStandardMaterial color={pal.cap} roughness={0.85} />
          </mesh>
          <mesh geometry={beakGeo} position={[0.036, -0.004, 0]} rotation={[0, 0, -Math.PI / 2]}>
            <meshStandardMaterial color="#2a2018" roughness={0.7} />
          </mesh>
          {/* the twig in the beak, only on the way home */}
          <mesh
            ref={twigRef}
            geometry={twigGeo}
            position={[0.07, -0.008, 0]}
            rotation={[0, 0.5, Math.PI / 2]}
            scale={[1, 0.085, 1]}
            visible={false}
          >
            <meshStandardMaterial color="#6b543a" roughness={0.9} />
          </mesh>
        </group>
        <group ref={tailRef} position={[-0.062, 0.006, 0]}>
          <mesh geometry={tailGeo} position={[-0.03, 0, 0]}>
            <meshStandardMaterial color={pal.wing} roughness={0.85} side={THREE.DoubleSide} />
          </mesh>
        </group>
        <group ref={wingLRef} position={[0, 0.02, 0.018]}>
          <mesh geometry={wingGeo}>
            <meshStandardMaterial color={pal.wing} roughness={0.85} side={THREE.DoubleSide} />
          </mesh>
        </group>
        <group ref={wingRRef} position={[0, 0.02, -0.018]} scale={[1, 1, -1]}>
          <mesh geometry={wingGeo}>
            <meshStandardMaterial color={pal.wing} roughness={0.85} side={THREE.DoubleSide} />
          </mesh>
        </group>
      </group>
      {/* tucked away in flight — a bird in the air has no legs to speak of */}
      <group ref={legsRef} position={[0.008, -0.048, 0]} visible={false}>
        <mesh geometry={legGeo} position={[0, -0.03, 0.016]}>
          <meshStandardMaterial color="#3a2c20" roughness={0.8} />
        </mesh>
        <mesh geometry={legGeo} position={[0, -0.03, -0.016]}>
          <meshStandardMaterial color="#3a2c20" roughness={0.8} />
        </mesh>
      </group>
    </group>
  );
});

/** A dawn sky, painted once. */
function buildSky(top: string, low: string, sun: string): THREE.CanvasTexture {
  const w = 8;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, top);
  grad.addColorStop(0.62, low);
  grad.addColorStop(1, sun);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return new THREE.CanvasTexture(c);
}

const HINT_SPRITE = makeRadialSprite(64);
const GLOW_SPRITE = makeRadialSprite(64, [
  [0, "rgba(255,255,255,1)"],
  [0.35, "rgba(255,255,255,0.55)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- what drifts past ---------- */
// Pure functions of the clock, so nothing accumulates and no leaf ever pops back in
// at the far side of a frame somebody is looking straight at.
const LEAVES = (() => {
  const rand = mulberry32(4821);
  return Array.from({ length: LEAF_N }, () => ({
    y0: -1.15 + rand() * 2.3,
    sp: 0.045 + rand() * 0.06,
    ph: rand(),
    amp: 0.08 + rand() * 0.2,
    sc: 0.016 + rand() * 0.03,
    z: -0.7 + rand() * 1.5,
    spin: (rand() - 0.5) * 2.2,
    dir: rand() < 0.5 ? -1 : 1,
  }));
})();

/* ---------- one round trip, as a curve ---------- */
// x sweeps out and back on a half-sine, z bows a full one — so the trip is a real
// loop in plan and not a there-and-back along its own line. Velocity and
// acceleration come out of the same closed form, which is what banks the bird.
const ARC = new Float32Array(8);
function arcAt(u: number, hx: number, hy: number, hz: number, R: number, D: number, H: number, dur: number) {
  const s1 = Math.sin(Math.PI * u);
  const c1 = Math.cos(Math.PI * u);
  const s2 = Math.sin(2 * Math.PI * u);
  const c2 = Math.cos(2 * Math.PI * u);
  const iv = 1 / dur;
  ARC[0] = hx + R * s1;
  ARC[1] = hy + H * s1;
  ARC[2] = hz + D * s2;
  ARC[3] = R * Math.PI * c1 * iv;
  ARC[4] = H * Math.PI * c1 * iv;
  ARC[5] = D * 2 * Math.PI * c2 * iv;
  ARC[6] = -R * Math.PI * Math.PI * s1 * iv * iv;
  ARC[7] = -D * 4 * Math.PI * Math.PI * s2 * iv * iv;
}

/* ---------- scratch; a nest allocates nothing per frame ---------- */
const dummy = new THREE.Object3D();

/** A soft square wave: holds at one extreme, snaps across, holds at the other. Which
 *  is what a bird's head does, and — because it is a pure function of the clock —
 *  every frozen frame of it is a pose the bird could really be in. */
const glance = (x: number) => Math.tanh(2.8 * Math.sin(x));

/** The frame's own scalars. Posing the pair reads a dozen of them, and hoisting them
 *  here is what keeps `poseBird` a module-level function rather than a closure
 *  allocated sixty times a second. */
const F = {
  e: 0,
  dt: 0,
  branchY: 0,
  post: -1,
  lift: 0,
  dawn: 0,
  pull: 0,
  hov: 0,
  pointerX: 0,
  landAt: -9,
  flying: -1,
  dur: 1.05,
  reach: 1.5,
  climb: 0.6,
  dirX: 0,
  preview: false,
  prevFly: -1,
};

/** One bird, this frame. `side` is which end of the branch it belongs to; the arc,
 *  the perch, the facing and the head all mirror off it. */
function poseBird(h: BirdHandle | null, side: number) {
  if (!h) return;
  const e = F.e;
  const hx = side * PERCH_X;
  const hy = PERCH_Y + F.branchY;
  const ph = side > 0 ? 1.7 : 0;
  const u = F.preview ? (side > 0 ? F.prevFly : -1) : F.flying;

  if (u >= 0) {
    const dur = F.preview ? 4.2 : F.dur;
    // Which way the swipe went reads straight through: the bird downwind of it is
    // thrown further and swings wider, the other one has to work against it.
    const R = side * (F.preview ? 1.5 : F.reach) * (1 + side * F.dirX * 0.3);
    const D = side * SWING * (1 - side * F.dirX * 0.25);
    const H = F.preview ? 0.62 : F.climb;
    arcAt(u, hx, hy, PERCH_Z, R, D, H, dur);
    const vx = ARC[3];
    const vy = ARC[4];
    const vz = ARC[5];
    const spd = Math.max(0.001, Math.hypot(vx, vz));
    BP.x = ARC[0];
    BP.y = ARC[1] + Math.sin(u * Math.PI * 9) * 0.012;
    BP.z = ARC[2];
    BP.yaw = Math.atan2(-vz, vx);
    BP.pitch = Math.max(-0.6, Math.min(0.6, Math.atan2(vy, spd) * 0.7));
    // Banking into the turn: the lift tilts toward the centre of it, which is
    // whichever side the lateral acceleration is pointing at.
    BP.bank = Math.max(-0.6, Math.min(0.6, ((vx * ARC[7] - vz * ARC[6]) / spd) * 0.055));
    // Wings work on the climb and are held out on the way down — then a hard flare in
    // the last of the approach, because stopping is the expensive part of flying.
    const flare = clamp01((u - 0.87) / 0.13);
    BP.flap = Math.max(clamp01(0.18 + vy * 0.55), flare);
    BP.hz = 15 + 15 * BP.flap;
    BP.pitch += flare * 0.5;
    BP.crouch = 0;
    BP.perch = flare * 0.8;
    BP.carry = u > 0.5 ? 1 : 0;
    BP.tail = 0.25 + flare * 0.7;
    BP.puff = 0;
    BP.headYaw = -BP.bank * 0.5;
    BP.headPitch = -BP.pitch * 0.5;
  } else {
    // Perched. Waiting is not holding still: it breathes, it fluffs, the tail flicks,
    // and the head keeps going somewhere else.
    const post = F.post;
    const since = e - F.landAt;
    const bob = Math.exp(-since * 3.2) * Math.sin(since * 16) * 0.02;
    const shuffle = post > 0.2 ? Math.exp(-Math.max(0, post - 1.2) * 3) * Math.sin(post * 9 + ph) * 0.012 : 0;
    // At the reveal they cross to the rim of what they built and settle onto it.
    const inK = F.lift <= 0 ? 0 : smooth(clamp01((post - 0.35) / 0.9));
    BP.x = lerp(hx, side * 0.34, inK) + shuffle;
    BP.y = lerp(hy, 0.1 + Math.sin(e * 0.7 + ph) * 0.005 + F.branchY * 0.4, inK) + bob;
    BP.z = lerp(PERCH_Z, 0.14, inK);
    // Facing each other across the branch — the pair is the picture, and a low-poly
    // bird only reads in profile anyway.
    BP.yaw = side > 0 ? Math.PI : 0;
    BP.pitch = -F.pull * 0.22 + Math.sin(e * 0.9 + ph) * 0.02;
    BP.bank = 0;
    // Halfway across they still have to fly it, so they keep a wingbeat going.
    const cross = inK > 0.02 && inK < 0.98 ? Math.sin(inK * Math.PI) : 0;
    BP.flap = Math.max(cross, F.pull * 0.3 + Math.pow(Math.max(0, Math.sin(e * 0.53 + ph * 2)), 40) * 0.6);
    BP.hz = 20;
    BP.crouch = F.pull;
    BP.perch = 1 - cross * 0.9;
    BP.carry = 0;
    BP.tail = Math.pow(Math.max(0, Math.sin(e * 0.87 + ph)), 22) * 0.9 + F.pull * 0.3;
    BP.puff = 0.5 + 0.5 * Math.sin(e * 0.31 + ph) - F.dawn * 0.4;
    // Before the first touch they lean toward whoever is hovering, and the whole
    // invitation stops the instant they are touched.
    const lookAt = F.hov * F.pointerX * 0.6;
    // …and after everything else has stopped, one last look down at the eggs.
    const lastK = clamp01((post - 1.55) / 0.5);
    BP.headYaw =
      lerp(0.45 * glance(e * 0.29 + ph), lookAt, F.hov) * (1 - F.lift) +
      lastK * (0.26 + 0.4 * glance(e * 0.27 + ph));
    BP.headPitch = -0.12 * glance(e * 0.19 + ph * 1.4) - F.pull * 0.2 - lastK * 0.22;
  }
  BP.dt = F.dt;
  h.pose(BP);
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

export default function NestScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const bird = BIRDS[variants.bird] ?? BIRDS.bulbul;
  const light = LIGHTS[variants.light] ?? LIGHTS.dawn;

  const sky = useMemo(() => buildSky(light.top, light.low, light.sun), [light]);
  useEffect(() => () => sky.dispose(), [sky]);

  /* The twigs ARE the strokes. orderWritePath gives the order a hand would lay
     them in; the jitter in angle and length is the entire look, so it is generous. */
  const nest = useMemo(() => {
    const text = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    const w = orderWritePath(text, {
      step: 3,
      fontSize: 88,
      fontWeight: "700",
      maxWidthPx: 88 * 8,
      lineHeight: 1.3,
      lang,
    });
    const rand = mulberry32(31337);
    const span = Math.min(2.5, 2.5 / Math.max(0.42, w.aspect * 1.4)); // world width of the block
    const out = new Float32Array(TWIGS * 6); // x, y, angle, length, tilt, phase
    for (let i = 0; i < TWIGS; i++) {
      // Walk the path in order so the words assemble the way they are written.
      const k = w.count > 1 ? Math.floor((i / (TWIGS - 1)) * (w.count - 1)) : 0;
      out[i * 6] = w.path[k * 2] * span + (rand() - 0.5) * 0.01;
      out[i * 6 + 1] = w.path[k * 2 + 1] * span + (rand() - 0.5) * 0.01;
      // A twig laid along the local stroke direction, give or take a real bird.
      const next = Math.min(w.count - 1, k + 6);
      const dx = w.path[next * 2] - w.path[k * 2];
      const dy = w.path[next * 2 + 1] - w.path[k * 2 + 1];
      const along = Math.abs(dx) + Math.abs(dy) > 1e-6 ? Math.atan2(dy, dx) : 0;
      out[i * 6 + 2] = along + (rand() - 0.5) * 0.9;
      out[i * 6 + 3] = 0.022 + rand() * 0.026;
      out[i * 6 + 4] = (rand() - 0.5) * 0.5;
      out[i * 6 + 5] = rand() * Math.PI * 2;
    }
    return { twigs: out, span };
  }, [message, recipientName, lang]);

  const names = useMemo(() => {
    const mk = (n: string) =>
      makeTextTexture(n || "—", {
        fontFamily: "Georgia, serif",
        fontWeight: "600",
        fontSize: 40,
        color: "#6b5a44",
        maxWidthPx: 40 * 8,
        padding: 8,
        lang,
      });
    const a = mk(recipientName);
    const b = mk(senderName);
    return { a, b, aSize: fitPlane(a.aspect, 0.11, 0.036), bSize: fitPlane(b.aspect, 0.11, 0.036) };
  }, [senderName, recipientName, lang]);
  useEffect(
    () => () => {
      names.a.texture.dispose();
      names.b.texture.dispose();
    },
    [names],
  );

  // Per mount, not module scope: the gallery renders a wall of these at once, and a
  // shared buffer would have them all shedding each other's feathers.
  const down = useMemo(
    () => ({ pos: new Float32Array(DOWN_N * 3), col: new Float32Array(DOWN_N * 3) }),
    [],
  );
  const motes = useMemo(() => {
    const rand = mulberry32(70117);
    const pos = new Float32Array(MOTE_N * 3);
    for (let i = 0; i < MOTE_N; i++) {
      pos[i * 3] = (rand() - 0.5) * 3.2;
      pos[i * 3 + 1] = (rand() - 0.5) * 2.2;
      pos[i * 3 + 2] = (rand() - 0.5) * 1.2;
    }
    return pos;
  }, []);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* `trip` counts finished round trips; `flying` is where inside the current one we
     are; everything else is what the hand did and what the branch is still doing
     about it. The only mutable state in the scene, and it all resets on replay. */
  const g = useRef({
    trip: 0,
    flying: -1,
    doneAt: -1,
    touched: false,
    down: false,
    px: 0,
    py: 0,
    qx: 0,
    qy: 0,
    moved: 0,
    v: 0,
    pull: 0,
    str: 0.5,
    reach: 1.5,
    climb: 0.6,
    dur: 1.05,
    dirX: 0,
    hover: 0,
    hov: 0,
    bY: 0,
    bV: 0,
    landAt: -9,
    alone: 0, // seconds since the last real pointer input, while opening
    wait: 0, // …and how long the pair has been sitting there once mercy is driving
    auto: false, // the mercy has taken a trip: the invitation has been answered
  });
  // …born last, and -99 across the board so nothing is alive at the origin on frame
  // one: the reset effect below only lands after the first paint.
  const dn = useRef(new Float32Array(DOWN_N * 7).fill(-99)); // x, y, z, vx, vy, vz, born
  const dnAt = useRef(0);
  useEffect(() => {
    const c = g.current;
    c.trip = 0;
    c.flying = -1;
    c.doneAt = -1;
    c.touched = false;
    c.down = false;
    c.moved = c.v = c.pull = c.bY = c.bV = c.alone = c.wait = 0;
    c.auto = false;
    c.str = 0.5;
    c.landAt = -9;
    for (let i = 0; i < DOWN_N; i++) dn.current[i * 7 + 6] = -99;
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const branchRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const twigRef = useRef<THREE.InstancedMesh>(null);
  const heRef = useRef<BirdHandle>(null);
  const sheRef = useRef<BirdHandle>(null);
  const eggRefs = useRef<(THREE.Group | null)[]>([]);
  const nameMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const hintRef = useRef<THREE.Mesh>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const fillRef = useRef<THREE.DirectionalLight>(null);
  const ambRef = useRef<THREE.AmbientLight>(null);
  const skyMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const sunRef = useRef<THREE.Mesh>(null);
  const sunMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const sheenRef = useRef<THREE.Mesh>(null);
  const sheenMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const leafRef = useRef<THREE.InstancedMesh>(null);
  const downRef = useRef<THREE.Points>(null);
  const moteRef = useRef<THREE.Points>(null);

  /** Down does not fall so much as hang about, so it is emitted with a direction and
   *  then mostly forgotten. Landings shake some loose; so does a push-off. */
  const shed = (n: number, x: number, y: number, z: number, power: number, e: number) => {
    const d = dn.current;
    for (let k = 0; k < n; k++) {
      const i = dnAt.current % DOWN_N;
      dnAt.current = i + 1;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.2 + Math.random() * 0.8) * power;
      d[i * 7] = x + (Math.random() - 0.5) * 0.05;
      d[i * 7 + 1] = y + (Math.random() - 0.5) * 0.04;
      d[i * 7 + 2] = z + (Math.random() - 0.5) * 0.05;
      d[i * 7 + 3] = Math.cos(a) * sp;
      d[i * 7 + 4] = 0.12 + Math.abs(Math.sin(a)) * sp * 0.7;
      d[i * 7 + 5] = Math.sin(a) * sp * 0.6;
      d[i * 7 + 6] = e;
    }
  };

  /** Commit one round trip. `str` is the whole of how hard it was thrown — it writes
   *  the arc, the recoil into the branch and the voice — and `dur` is how long the
   *  trip takes. Shared by the hand and by the mercy path, so an unattended trip is
   *  the same event as a swiped one and lands the same twig on the same beat. */
  const launch = (str: number, dirX: number, up: number, dur: number) => {
    const c = g.current;
    c.str = str;
    c.dirX = dirX;
    c.reach = lerp(REACH_MIN, REACH_MAX, c.str);
    c.climb = lerp(CLIMB_MIN, CLIMB_MAX, c.str) * (1 + up * 0.45);
    c.dur = dur;
    c.down = false;
    c.pull = 0;
    c.flying = 0;
    c.bV -= 0.15 * c.str; // they shove off, and the branch knows about it
    tone(bird.call * (1 + c.trip * 0.045), {
      type: "sine",
      seconds: 0.1 + 0.1 * c.str,
      gain: 0.07 + 0.07 * c.str,
    });
  };

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    g.current.alone = 0; // a hand on the glass: the trips are theirs again
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    const c = g.current;
    c.down = true;
    c.px = c.qx = ev.point.x;
    c.py = c.qy = ev.point.y;
    c.moved = 0;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (phase === "opening") c.alone = 0;
    if (!c.down || phase !== "opening" || c.flying >= 0 || c.trip >= TRIPS) return;
    ev.stopPropagation();
    c.moved += Math.hypot(ev.point.x - c.qx, ev.point.y - c.qy);
    c.qx = ev.point.x;
    c.qy = ev.point.y;
    const dx = ev.point.x - c.px;
    const dy = ev.point.y - c.py;
    const d = Math.hypot(dx, dy);
    // The whole of the drag before the threshold is the wind-up: they sink onto their
    // legs, the branch takes the load, and letting go early lets it all back out.
    c.pull = clamp01(d / SWIPE_MIN);
    // One swipe, one round trip. A long drag is still one trip: the birds are not a
    // scroll bar, and the labour is supposed to take as many gestures as it takes.
    // How *hard* it was, though, reads straight through into the arc they fly.
    if (d < SWIPE_MIN) return;
    const str = clamp01(
      0.45 * ((d - SWIPE_MIN) / (SWIPE_FULL - SWIPE_MIN)) + 0.55 * (c.v / V_FULL),
    );
    const s = 0.2 + 0.8 * str;
    c.touched = true;
    launch(s, dx / d, dy / d, lerp(TRIP_SLOW, TRIP_FAST, s));
  };
  const stop = () => {
    g.current.down = false;
  };
  const leave = () => {
    g.current.down = false;
    g.current.hover = 0;
  };
  const enter = () => {
    g.current.hover = 1;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = g.current;
    const opening = phase === "opening";
    // Nothing outside `opening` eases: reduced motion gets ~40 frames and then the
    // loop stops, so a lerp that needs a second to cross would freeze part-way there.
    const ease = opening ? Math.min(1, dt * 3.4) : 1;

    /* ---- how fast the hand is actually going ---- */
    // Measured over the frame clock, not event timestamps: pointer moves coalesce and
    // can share a timestamp, and dividing by that zero would hand a lazy drag an
    // infinite velocity. Peak-held for ~90ms so the launch reads the stroke.
    c.v = Math.max(c.v * Math.exp(-dt / V_DECAY), c.moved / dt);
    c.moved = 0;
    if (!c.down) c.pull += (0 - c.pull) * Math.min(1, dt * 6);
    c.hov += ((opening && !c.touched ? c.hover : 0) - c.hov) * Math.min(1, dt * 6);

    const fit = Math.max(
      0.6,
      Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H),
    );
    if (fitRef.current) fitRef.current.scale.setScalar(fit);

    /* ---- the mercy ---- */
    // Nobody has touched anything for MERCY_GRACE, so the pair gets on with it: one
    // trip at a time, on the same clock and through the same `launch` the hand uses,
    // so the build reads as somebody else doing the gesture rather than a second
    // timeline. It runs *before* the trip clock below, so a trip started this frame
    // is already flying by the time anything is posed. Any real input resets `alone`
    // in the handlers and the trips go straight back to the hand — and because a
    // trip is only ever added, never taken away, their own progress is never undone.
    if (opening) {
      c.alone += dt;
      if (c.alone > MERCY_GRACE && c.flying < 0 && c.trip < TRIPS) {
        c.wait += dt;
        if (c.wait >= MERCY_GAP) {
          c.wait = 0;
          c.auto = true;
          const k = c.trip / (TRIPS - 1); // they warm to the work as the nest grows
          launch(
            lerp(MERCY_STR0, MERCY_STR1, k),
            c.trip % 2 ? 1 : -1, // taking it in turns, the way the pair does
            0.22,
            lerp(MERCY_DUR0, MERCY_DUR1, k),
          );
        }
      }
    }

    /* ---- the trip clock ---- */
    if (opening && c.flying >= 0) {
      // onMove parks it at exactly 0 and this is the only thing that ever moves it off,
      // so the push-off is caught here rather than in a handler with no clock to hand.
      if (c.flying === 0) shed(5, 0, PERCH_Y + 0.03, PERCH_Z, 0.55, e);
      const was = c.flying;
      c.flying += dt / c.dur;
      // Latched on the crossing rather than on `>= 1`, so a frame that overshoots the
      // end of the trip still books exactly one landing and one twig.
      if (was < 1 && c.flying >= 1) {
        c.flying = -1;
        c.trip += 1;
        c.landAt = e;
        c.bV -= 0.12; // and the branch takes them back
        shed(4, 0, -0.3, 0.1, 0.5, e);
        clack({ freq: 760 + c.trip * 40, decay: 0.05, gain: 0.1 + 0.06 * c.str });
        if (c.trip >= TRIPS) {
          c.doneAt = tRef.current;
          tone(784, { shimmer: true, seconds: 1.6, gain: 0.2 });
          swell({ source: "sine", freq: 196, attack: 0.5, hold: 0.7, release: 1.4, gain: 0.06 });
          clack({ freq: 620, decay: 0.07, gain: 0.07, when: 0.78 }); // the eggs, settling
          shed(14, 0, -0.1, 0.12, 0.9, e);
        }
      }
    }

    /* ---- how much nest exists ---- */
    let built: number;
    if (opening) {
      // The share lands on the way *home*, not across the whole trip: an empty beak
      // that leaves twigs behind it is the one thing this gift cannot show.
      const land = c.flying >= 0 ? smooth(clamp01((c.flying - 0.42) / 0.5)) : 0;
      built = clamp01((c.trip + land) / TRIPS);
    } else if (phase === "sealed") {
      built = 0;
    } else {
      built = 1;
    }

    const post = phase === "revealed" ? REVEAL_HOLD : c.doneAt >= 0 ? tRef.current - c.doneAt : -1;
    const lift = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / 1.25));
    // Every settle in the reveal is the same damped sine on the same clock, so the
    // whole tableau rings down together — and at REVEAL_HOLD it is already nothing,
    // which is why `revealed` is correct as a single frozen frame.
    const ring = post > 0 ? Math.sin(post * 5.4) * Math.exp(-post * 2.6) : 0;

    /* ---- first light, creeping up ---- */
    // The build is what carries the hour: the sun clears the horizon over the eight
    // trips, and the shadow it throws across the branch swings and shortens with it.
    const dawn =
      phase === "sealed"
        ? 0.05
        : phase === "preview"
          ? 0.62 + 0.1 * Math.sin(e * 0.21)
          : phase === "revealed"
            ? 1
            : clamp01(built * 0.82 + lift * 0.18);
    const sunX = lerp(-1.55, -0.55, dawn);
    const sunY = lerp(0.28, 1.85, dawn);
    if (keyRef.current) {
      keyRef.current.position.set(sunX, sunY, 2.2);
      keyRef.current.intensity = lerp(0.55, 1.5, dawn) * (1 + 0.03 * Math.sin(e * 0.7));
      keyRef.current.color.lerpColors(light.cold, light.warm, dawn);
    }
    if (fillRef.current) fillRef.current.intensity = lerp(0.5, 0.3, dawn);
    if (ambRef.current) ambRef.current.intensity = light.amb * lerp(0.62, 1.05, dawn);
    // The sky itself comes up out of the dark rather than being a different sky.
    if (skyMatRef.current) {
      const s = lerp(0.5, 1, dawn);
      skyMatRef.current.color.setRGB(s, s * lerp(0.94, 1, dawn), s * lerp(1.12, 1, dawn));
    }
    if (sunRef.current && sunMatRef.current) {
      sunRef.current.position.set(sunX * 0.85, lerp(-1.5, -0.55, dawn), -2.6);
      sunRef.current.scale.setScalar(lerp(1, 2.2, dawn));
      sunMatRef.current.opacity = lerp(0.06, 0.4, dawn);
    }

    /* ---- the branch, which is a spring with two birds on it ---- */
    c.bV += (-BRANCH_K * c.bY - BRANCH_C * c.bV) * dt;
    c.bY += c.bV * dt;
    const wind = Math.sin(e * 0.63) * 0.008 + Math.sin(e * 1.27 + 1.1) * 0.004;
    const branchY = c.bY + wind - c.pull * 0.018;
    if (branchRef.current) {
      branchRef.current.position.y = branchY;
      // a loaded branch does not only drop, it rolls a little under the load
      branchRef.current.rotation.z = branchY * 1.6 + Math.sin(e * 0.41) * 0.006;
    }
    if (shadowRef.current && shadowMatRef.current) {
      // Thrown by the nest, onto the branch: it swings back toward centre and shortens
      // as the sun climbs, which is the only clock in the scene you can read at a glance.
      shadowRef.current.position.x = -sunX * lerp(0.62, 0.2, dawn);
      shadowRef.current.scale.set(lerp(1.5, 0.72, dawn), 0.1, 1);
      shadowMatRef.current.opacity = 0.5 * dawn * (0.25 + 0.75 * built);
    }
    if (sheenRef.current && sheenMatRef.current) {
      sheenRef.current.position.x = sunX * 0.35;
      sheenMatRef.current.opacity = 0.34 * dawn;
    }

    /* ---- the trick: while it is being built the nest is nearly edge-on, so it
            reads as a pile. The camera lifting is what turns the pile into words. ---- */
    if (tiltRef.current) {
      const t = tiltRef.current;
      const want =
        phase === "preview"
          ? 0.24 + 0.045 * Math.sin(e * 0.23)
          : lerp(1.16, 0, lift) + ring * 0.06;
      t.rotation.x = lerp(t.rotation.x, want, ease);
      t.position.y = lerp(t.position.y, lerp(-0.5, 0.05, lift) + branchY * 0.55, ease);
      // it hangs off a branch that is moving, so it swings a little behind it
      t.rotation.z = lerp(t.rotation.z, branchY * 1.4 + Math.sin(e * 0.53) * 0.005, ease);
    }

    /* ---- the twigs ---- */
    if (twigRef.current) {
      const n = built * TWIGS;
      // Once the last trip is in, everything that is still dropping finishes dropping —
      // otherwise `revealed` holds three dozen twigs forever half-way to their place.
      const settled = opening ? clamp01(post / 0.55) : 1;
      // How hard the pile is being disturbed right now: a twig arriving shoulders the
      // ones already there aside, and they take a moment to accept it.
      const busy = opening && c.flying > 0.4 ? 1 : 0.12;
      const twigs = nest.twigs;
      for (let i = 0; i < TWIGS; i++) {
        const q = n - i;
        if (q <= 0) {
          dummy.scale.set(0, 0, 0);
          dummy.position.set(0, 0, 0);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          twigRef.current.setMatrixAt(i, dummy.matrix);
          continue;
        }
        const x = twigs[i * 6];
        const y = twigs[i * 6 + 1];
        const ang = twigs[i * 6 + 2];
        const len = twigs[i * 6 + 3];
        const tilt = twigs[i * 6 + 4];
        const ph = twigs[i * 6 + 5];
        const a = Math.max(clamp01(q / ARRIVE), settled);
        // Only the shoulder of the pile is still doing anything, and 900 twigs is
        // exactly the count where paying six transcendentals each for the other 700
        // shows up on a mid phone. Past this depth both terms are under a thousandth.
        const near = q < ARRIVE + 170;
        // easeOutBack overshoots, so the twig dips a hair past its place and comes back
        // up — which is what a stick dropped onto a pile of sticks does.
        const drop = 1 - easeOutBack(a);
        const jolt = near ? Math.exp(-Math.max(0, q - ARRIVE) / 34) * busy : 0;
        const wob = a < 0.9 ? Math.sin(a * 22 + ph) * Math.exp(-a * 5) : 0;
        // and it does not fall straight in, it threads: the last of the travel is along
        // the twig's own length, over and under what is already there
        const thread = (1 - a) * 0.055;
        dummy.position.set(
          x + Math.cos(ang) * thread + (near ? Math.sin(e * 26 + ph) * 0.004 * jolt : 0),
          y + drop * 0.26 + (near ? Math.sin(e * 21 + ph * 1.7) * 0.003 * jolt : 0),
          // later twigs sit proud of earlier ones, alternating over and under: that
          // stagger is the whole difference between a weave and a heap
          tilt * 0.045 + (i / TWIGS) * 0.07 + (i % 3 === 0 ? 0.012 : -0.006),
        );
        dummy.rotation.set(
          0,
          tilt + (1 - a) * 0.8,
          ang + Math.PI / 2 + (1 - a) * 1.2 + wob * 0.22 + (near ? jolt * 0.03 * Math.sin(e * 18 + ph) : 0),
        );
        dummy.scale.set(1, len * clamp01(a * 3), 1);
        dummy.updateMatrix();
        twigRef.current.setMatrixAt(i, dummy.matrix);
      }
      twigRef.current.instanceMatrix.needsUpdate = true;
    }

    /* ---- the pair ---- */
    // preview never waits for a gesture it will not get: one bird goes out on a loop
    // and the other watches it the whole way round.
    const cyc = e % PREV_PERIOD;
    F.e = e;
    F.dt = dt;
    F.branchY = branchY;
    F.post = post;
    F.lift = lift;
    F.dawn = dawn;
    F.pull = c.pull;
    F.hov = c.hov;
    F.pointerX = state.pointer.x;
    F.landAt = c.landAt;
    F.flying = opening ? c.flying : -1;
    F.dur = c.dur;
    F.reach = c.reach;
    F.climb = c.climb;
    F.dirX = c.dirX;
    F.preview = phase === "preview";
    F.prevFly = F.preview && cyc > 1.2 && cyc < 5.4 ? clamp01((cyc - 1.2) / 4.2) : -1;
    poseBird(heRef.current, -1);
    poseBird(sheRef.current, 1);

    /* ---- two pale eggs, and both names on them ---- */
    // They arrive on their own beat, a little after the nest has finished turning to
    // face us, and rock for a moment before they lie still.
    const eggK = phase === "preview" ? 1 : phase === "revealed" ? 1 : clamp01((post - 0.7) / 0.45);
    for (let i = 0; i < 2; i++) {
      const m = eggRefs.current[i];
      if (!m) continue;
      m.visible = eggK > 0.01;
      const s = eggK >= 1 ? 1 : easeOutBack(eggK);
      m.scale.setScalar(s);
      m.position.set((i ? 0.1 : -0.1), -0.02 + (1 - s) * 0.07, 0.05);
      m.rotation.z = Math.sin(e * (1.05 + i * 0.17) + i) * 0.035 + ring * 0.16 * (i ? -1 : 1);
    }
    const nameK = phase === "preview" ? 1 : phase === "revealed" ? 1 : clamp01((post - 1) / 0.7);
    for (const m of nameMats.current) if (m) m.opacity = smooth(nameK);

    /* ---- what is drifting past ---- */
    if (leafRef.current) {
      for (let i = 0; i < LEAF_N; i++) {
        const l = LEAVES[i];
        const u = (e * l.sp + l.ph) % 1;
        dummy.position.set(
          l.dir * lerp(-2.3, 2.3, u),
          l.y0 + Math.sin(e * 0.6 + l.ph * 9) * l.amp - u * 0.45,
          l.z,
        );
        dummy.rotation.set(e * l.spin * 0.6, e * l.spin, Math.sin(e * 1.3 + l.ph * 7) * 0.7);
        // fades up out of the frame edge and back down into the other one: no pop
        dummy.scale.setScalar(l.sc * Math.sin(u * Math.PI));
        dummy.updateMatrix();
        leafRef.current.setMatrixAt(i, dummy.matrix);
      }
      leafRef.current.instanceMatrix.needsUpdate = true;
    }

    if (downRef.current) {
      const mat = downRef.current.material as THREE.PointsMaterial;
      // gl_PointSize is device pixels and ignores the model matrix, so the fit has to
      // be multiplied back in by hand or the down bloats to snowballs on a phone.
      mat.size = 0.07 * fit;
      const d = dn.current;
      const pa = downRef.current.geometry.attributes.position as THREE.BufferAttribute;
      const pc = downRef.current.geometry.attributes.color as THREE.BufferAttribute;
      let any = false;
      for (let i = 0; i < DOWN_N; i++) {
        const tau = e - d[i * 7 + 6];
        if (d[i * 7 + 6] < -50 || tau < 0 || tau > DOWN_LIFE) {
          pa.setXYZ(i, 0, -99, 0);
          pc.setXYZ(i, 0, 0, 0);
          continue;
        }
        // it never really falls — it hands its speed to the air in the first quarter
        // second and then wanders down at whatever the room is doing
        const drag = 1 - Math.exp(-tau * 2.4);
        pa.setXYZ(
          i,
          d[i * 7] + d[i * 7 + 3] * drag * 0.45 + Math.sin(tau * 2.3 + i) * 0.03 * tau,
          d[i * 7 + 1] + d[i * 7 + 4] * drag * 0.45 - 0.045 * tau * tau,
          d[i * 7 + 2] + d[i * 7 + 5] * drag * 0.45,
        );
        const k = clamp01(tau / 0.12) * clamp01((DOWN_LIFE - tau) / 1.1) * 0.9;
        pc.setXYZ(i, k, k * 0.95, k * 0.88);
        any = true;
      }
      pa.needsUpdate = true;
      pc.needsUpdate = true;
      downRef.current.visible = any;
    }

    if (moteRef.current) {
      const mat = moteRef.current.material as THREE.PointsMaterial;
      mat.size = 0.035 * fit;
      mat.opacity = 0.1 + 0.4 * dawn;
      // Dust hanging in a shaft of light does not swim about; the light moves through
      // it. So the field turns as one, very slowly, and costs nothing.
      moteRef.current.rotation.y = e * 0.035;
      moteRef.current.rotation.z = Math.sin(e * 0.11) * 0.06;
      moteRef.current.position.y = Math.sin(e * 0.17) * 0.06;
    }

    /* ---- the invitation ---- */
    // A ghost of the trip itself, flying the arc they would fly. The one gesture the
    // gift wants, shown rather than described — and gone the instant it is answered.
    if (hintRef.current && hintMatRef.current) {
      // …and it stops for the mercy too: once the pair is flying the trip themselves,
      // a ghost still asking for it would run over the whole unattended build.
      const live = opening && !c.touched && !c.auto;
      const hu = (e * 0.55) % 1.6;
      if (live) {
        arcAt(clamp01(hu), PERCH_X, PERCH_Y + branchY, PERCH_Z, 1.6, SWING, 0.7, 1);
        hintRef.current.position.set(ARC[0], ARC[1], ARC[2] + 0.1);
        hintRef.current.scale.setScalar(0.4 + 0.12 * Math.sin(e * 3));
      }
      const want = live ? (hu < 1 ? Math.sin(clamp01(hu) * Math.PI) * (0.3 + 0.16 * c.hov) : 0) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 8);
    }

    /* ---- the camera: a slow crane at the end, and never more than that ---- */
    const cam = camRef.current;
    if (cam) {
      const snap = phase === "opening" ? Math.min(1, dt * 3.2) : 1;
      const wantY = phase === "preview" ? 0.06 + 0.03 * Math.sin(e * 0.25) : lerp(lerp(-0.2, -0.06, built), 0.36, lift) + ring * 0.05;
      const wantZ = phase === "preview" ? 2.36 + 0.06 * Math.sin(e * 0.19) : lerp(lerp(2.24, 2.06, built), 2.42, lift);
      const wantX = state.pointer.x * 0.035 * (phase === "preview" ? 0 : 1) + (phase === "preview" ? 0.05 * Math.sin(e * 0.13) : 0);
      cam.position.x = lerp(cam.position.x, wantX, snap);
      cam.position.y = lerp(cam.position.y, wantY, snap);
      cam.position.z = lerp(cam.position.z, wantZ, snap);
      const lookY = phase === "preview" ? -0.06 : lerp(lerp(-0.55, -0.3, built), 0.02, lift);
      cam.lookAt(0, lookY, 0);
    }

    if (opening && post > REVEAL_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, 0.1, 2.35]} fov={42} />
      <ambientLight ref={ambRef} intensity={light.amb} color={light.low} />
      {/* the sun. Its colour is written every frame — the string here is only what the
          very first one would be, and never the module constant, which is shared. */}
      <directionalLight ref={keyRef} position={[-1.4, 0.4, 2.2]} intensity={0.6} color={light.top} />
      <directionalLight ref={fillRef} position={[1.8, -0.6, 1]} intensity={0.5} color={light.top} />

      {/* first light */}
      <mesh position={[0, 0, -3]}>
        <planeGeometry args={[16, 10]} />
        <meshBasicMaterial ref={skyMatRef} map={sky} depthWrite={false} />
      </mesh>
      {/* and the thing that is making it */}
      <mesh ref={sunRef} position={[-1.3, -1.5, -2.6]}>
        <planeGeometry args={[3, 3]} />
        <meshBasicMaterial
          ref={sunMatRef}
          map={GLOW_SPRITE}
          color={light.sun}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <group ref={fitRef}>
        {/* the bare branch it all sits on — a spring, with two birds on it */}
        <group ref={branchRef}>
          <mesh position={[0, BRANCH_Y, -0.1]} rotation={[0, 0, Math.PI / 2 - 0.05]}>
            <cylinderGeometry args={[0.028, 0.05, 3.4, 8]} />
            <meshStandardMaterial color={light.twig} roughness={0.95} />
          </mesh>
          <mesh position={[0.72, -0.78, -0.12]} rotation={[0, 0, -0.7]}>
            <cylinderGeometry args={[0.012, 0.02, 0.7, 6]} />
            <meshStandardMaterial color={light.twig} roughness={0.95} />
          </mesh>
          {/* the nest's shadow, lying on the branch, swinging with the sun */}
          <mesh ref={shadowRef} position={[0, BRANCH_Y + 0.005, -0.04]}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              ref={shadowMatRef}
              map={GLOW_SPRITE}
              color="#241a12"
              transparent
              opacity={0}
              depthWrite={false}
            />
          </mesh>
          {/* …and the lit edge above it */}
          <mesh ref={sheenRef} position={[0, BRANCH_Y + 0.032, -0.04]}>
            <planeGeometry args={[1.7, 0.05]} />
            <meshBasicMaterial
              ref={sheenMatRef}
              map={GLOW_SPRITE}
              color={light.sun}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>

        {/* the nest — which is the message, woven in branch */}
        <group ref={tiltRef} position={[0, -0.22, 0]} rotation={[1.16, 0, 0]}>
          <instancedMesh ref={twigRef} args={[undefined, undefined, TWIGS]} geometry={twigGeo} frustumCulled={false}>
            <meshStandardMaterial color={light.twig} roughness={0.95} />
          </instancedMesh>

          {/* The name is impressed on the egg, so it is the whole group that arrives
              and rocks — a name that holds still on an egg that does not is a decal. */}
          {[-1, 1].map((s, i) => (
            <group
              key={i}
              ref={(o) => {
                eggRefs.current[i] = o;
              }}
              position={[s * 0.1, -0.02, 0.05]}
              visible={false}
            >
              <mesh geometry={eggGeo}>
                <meshStandardMaterial color="#efe6d4" roughness={0.62} />
              </mesh>
              <mesh position={[0, 0, 0.064]}>
                <planeGeometry args={i === 0 ? names.bSize : names.aSize} />
                <meshBasicMaterial
                  ref={(m) => {
                    nameMats.current[i] = m;
                  }}
                  map={i === 0 ? names.b.texture : names.a.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            </group>
          ))}
        </group>

        <Bird ref={heRef} pal={bird} />
        <Bird ref={sheRef} pal={bird} />

        {/* what the morning is carrying about */}
        <instancedMesh ref={leafRef} args={[undefined, undefined, LEAF_N]} geometry={leafGeo} frustumCulled={false}>
          <meshStandardMaterial color="#7a7c46" roughness={0.9} side={THREE.DoubleSide} />
        </instancedMesh>
        <points ref={downRef} visible={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[down.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[down.col, 3]} />
          </bufferGeometry>
          <pointsMaterial
            map={HINT_SPRITE}
            size={0.07}
            sizeAttenuation
            vertexColors
            transparent
            depthWrite={false}
            toneMapped={false}
          />
        </points>
        <points ref={moteRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[motes, 3]} />
          </bufferGeometry>
          <pointsMaterial
            map={HINT_SPRITE}
            color={light.sun}
            size={0.035}
            sizeAttenuation
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </points>

        <mesh ref={hintRef} position={[0, 0.2, 0.4]}>
          <planeGeometry args={[1.1, 1.1]} />
          <meshBasicMaterial
            ref={hintMatRef}
            map={HINT_SPRITE}
            color={light.sun}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh
          position={[0, 0, 1]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={stop}
          onPointerCancel={stop}
          onPointerOver={enter}
          onPointerOut={leave}
        >
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
