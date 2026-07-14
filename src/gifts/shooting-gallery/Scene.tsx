import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32 } from "../math";

/* ---------- palettes ---------- */
const PALETTES: Record<
  string,
  { lamp: string; rim: string; glint: string; burst: string; heart: string; mote: string }
> = {
  noir: {
    lamp: "#d9e2f2", rim: "#5f7fae", glint: "#bcd2f0",
    burst: "#ece5d6", heart: "#ff3b57", mote: "#cfdcf0",
  },
  bloodmoon: {
    lamp: "#ffc2a8", rim: "#a83a44", glint: "#ff9d7e",
    burst: "#f2dcc8", heart: "#ff2440", mote: "#f2c8b4",
  },
  absinthe: {
    lamp: "#d8f2c6", rim: "#4f9668", glint: "#b8ecb4",
    burst: "#e9e6cf", heart: "#ffd166", mote: "#d4ecc2",
  },
};

/* ---------- stage layout (all in stage space, inside the spin group) ---------- */
const FLOOR_Y = -1.0; // top of the stage puck
const GUN_X = -1.25;
const GUN_Y = -0.14;
const MUZZLE_X = GUN_X + 0.53;
const BULLET_Y = GUN_Y + 0.02; // barrel sits slightly above the gun's pivot
const STOOL_X = 0.95;
const SEAT_Y = FLOOR_Y + 0.55;
const CHEST_X = STOOL_X - 0.05; // doll faces the gun; its chest leans toward -x
const ACTION_W = 3.1; // gun tail → doll edge; fit-to-viewport uses this, floor may crop

/* ---------- opening timeline (seconds) ---------- */
const T_AIM0 = 0.15;
const T_AIM1 = 0.75;
const T_COCK = 0.95;
const COCK_DUR = 0.14;
const T_FIRE = 1.3;
const FLASH_DUR = 0.16;
const T_HIT = 1.66; // stylized slow-mo flight
const SLUMP_DUR = 0.8;
const BURST_DUR = 1.3;
const T_HEART = 2.0;
const HEART_DUR = 1.1;
const OPEN_END = 3.5;

/* ---------- shared sprite texture (motes, smoke, streak, flash) ---------- */
const glowTex = makeRadialSprite();

/* ---------- heart: the thing the doll was hiding ---------- */
function buildHeartGeo(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.25, 0.25);
  s.bezierCurveTo(0.25, 0.25, 0.2, 0, 0, 0);
  s.bezierCurveTo(-0.3, 0, -0.3, 0.35, -0.3, 0.35);
  s.bezierCurveTo(-0.3, 0.55, -0.1, 0.77, 0.25, 0.95);
  s.bezierCurveTo(0.6, 0.77, 0.8, 0.55, 0.8, 0.35);
  s.bezierCurveTo(0.8, 0.35, 0.8, 0, 0.5, 0);
  s.bezierCurveTo(0.35, 0, 0.25, 0.25, 0.25, 0.25);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.18,
    bevelEnabled: true,
    bevelSize: 0.04,
    bevelThickness: 0.04,
    bevelSegments: 3,
    curveSegments: 24,
  });
  geo.center();
  geo.rotateZ(Math.PI); // the classic shape is drawn tip-up
  return geo;
}
const heartGeo = buildHeartGeo();

/* ---------- stuffing burst ---------- */
const BURST_COUNT = 70;
function buildBurst() {
  const rand = mulberry32(1928);
  const dir = new Float32Array(BURST_COUNT * 3);
  const speed = new Float32Array(BURST_COUNT);
  const v = new THREE.Vector3();
  for (let i = 0; i < BURST_COUNT; i++) {
    // Random sphere, biased along the bullet (+x) and upward.
    v.set(rand() * 2 - 1 + 0.9, rand() * 2 - 1 + 0.5, rand() * 2 - 1).normalize();
    dir[i * 3] = v.x;
    dir[i * 3 + 1] = v.y;
    dir[i * 3 + 2] = v.z;
    speed[i] = 0.7 + rand() * 1.5;
  }
  return { dir, speed, pos: new Float32Array(BURST_COUNT * 3) };
}
const BURST = buildBurst();

/* ---------- gun smoke ---------- */
const SMOKE_COUNT = 12;
const smokeDelay = Array.from({ length: SMOKE_COUNT }, (_, i) => i * 0.13);
const smokePos = new Float32Array(SMOKE_COUNT * 3);

/* ---------- dust motes in the lamp light ---------- */
const MOTE_COUNT = 60;
function buildMotes() {
  const rand = mulberry32(777);
  const pos = new Float32Array(MOTE_COUNT * 3);
  const speed = new Float32Array(MOTE_COUNT);
  const wobble = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    const r = Math.sqrt(rand()) * 1.4;
    const a = rand() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = -0.9 + rand() * 2.2;
    pos[i * 3 + 2] = Math.sin(a) * r;
    speed[i] = 0.02 + rand() * 0.05;
    wobble[i] = rand() * Math.PI * 2;
  }
  return { pos, speed, wobble };
}
const MOTES = buildMotes();

/* ---------- doll stitches ---------- */
const GUNMETAL = "#3a4150";
const WOOD = "#4a3527";
const BURLAP = "#bfa176";
const STITCH = "#33261e";
const THREAD_RED = "#a4293a";

function StitchX({
  position,
  size,
  color = STITCH,
}: {
  position: [number, number, number];
  size: number;
  color?: string;
}) {
  return (
    <group position={position}>
      <mesh rotation={[0, 0, Math.PI / 4]}>
        <boxGeometry args={[size, size * 0.16, 0.014]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh rotation={[0, 0, -Math.PI / 4]}>
        <boxGeometry args={[size, size * 0.16, 0.014]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
    </group>
  );
}

export default function ShootingGalleryScene({ variants, phase, onOpenComplete }: SceneProps) {
  const palette = PALETTES[variants.mood] ?? PALETTES.noir;

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const spinRef = useRef<THREE.Group>(null);
  const lampRef = useRef<THREE.Group>(null);
  const lampLightRef = useRef<THREE.PointLight>(null);
  const glintLightRef = useRef<THREE.PointLight>(null);
  const gunRef = useRef<THREE.Group>(null);
  const hammerRef = useRef<THREE.Group>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const flashLightRef = useRef<THREE.PointLight>(null);
  const bulletRef = useRef<THREE.Mesh>(null);
  const streakRef = useRef<THREE.Mesh>(null);
  const streakMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const dollSlumpRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const armLRef = useRef<THREE.Group>(null);
  const armRRef = useRef<THREE.Group>(null);
  const burstRef = useRef<THREE.Points>(null);
  const burstMatRef = useRef<THREE.PointsMaterial>(null);
  const smokeRef = useRef<THREE.Points>(null);
  const smokeMatRef = useRef<THREE.PointsMaterial>(null);
  const motesRef = useRef<THREE.Points>(null);
  const moteMatRef = useRef<THREE.PointsMaterial>(null);
  const heartRef = useRef<THREE.Group>(null);
  const heartLightRef = useRef<THREE.PointLight>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    // Static pose for the non-animating phases: intact before, aftermath after.
    const settled = phase === "revealed" ? 1 : 0;

    /* fit the action span into narrow (portrait) viewports */
    if (fitRef.current) {
      const s = Math.max(0.68, Math.min(1, state.viewport.width / ACTION_W));
      fitRef.current.scale.setScalar(s);
    }

    /* the swinging bare bulb — dampened while the shot plays out */
    const damp = opening ? lerp(1, 0.3, clamp01(t / 0.8)) : phase === "revealed" ? 0.45 : 1;
    if (lampRef.current) lampRef.current.rotation.z = 0.16 * damp * Math.sin(e * 1.15);
    if (lampLightRef.current) {
      // faint mains buzz in the filament
      lampLightRef.current.intensity = 8 + 0.25 * Math.sin(e * 13.7) + 0.15 * Math.sin(e * 31);
    }

    /* stage spin; opening squares the stage up to face the audience */
    if (spinRef.current) {
      if (opening) {
        if (t < 0.8) {
          const y = spinRef.current.rotation.y;
          const target = Math.round(y / (Math.PI * 2)) * Math.PI * 2;
          spinRef.current.rotation.y = lerp(y, target, Math.min(1, dt * 5));
        }
      } else {
        const speed = phase === "preview" ? 0.22 : phase === "sealed" ? 0.05 : 0.08;
        spinRef.current.rotation.y += dt * speed;
      }
    }

    /* whole diorama leans toward the pointer */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.08, k);
      tiltRef.current.rotation.z = lerp(tiltRef.current.rotation.z, -state.pointer.x * 0.08, k);
    }

    /* gun: droop → aim → cock → fire → recoil */
    const aim = opening
      ? easeOutCubic(clamp01((t - T_AIM0) / (T_AIM1 - T_AIM0)))
      : settled
        ? 0.6 // at rest after the deed, muzzle half-lowered
        : 0;
    const recoilT = opening ? t - T_FIRE : -1;
    const kick =
      recoilT < 0 ? 0 : recoilT < 0.07 ? recoilT / 0.07 : Math.exp(-(recoilT - 0.07) * 5.5);
    if (gunRef.current) {
      gunRef.current.rotation.z = lerp(-0.1, 0, aim) + kick * 0.3;
      gunRef.current.position.x = GUN_X - kick * 0.09;
    }
    const cock = opening
      ? easeOutCubic(clamp01((t - T_COCK) / COCK_DUR)) *
        (t < T_FIRE ? 1 : Math.max(0, 1 - (t - T_FIRE) / 0.05))
      : 0;
    if (hammerRef.current) hammerRef.current.rotation.z = cock * 0.7;

    /* muzzle flash */
    const flashT = opening ? clamp01((t - T_FIRE) / FLASH_DUR) : 1;
    const flashOn = opening && t >= T_FIRE && flashT < 1;
    if (flashRef.current) {
      flashRef.current.visible = flashOn;
      if (flashOn) {
        flashRef.current.scale.setScalar(0.25 + easeOutCubic(flashT) * 0.6);
        (flashRef.current.material as THREE.MeshBasicMaterial).opacity = 1 - flashT;
      }
    }
    if (flashLightRef.current) flashLightRef.current.intensity = flashOn ? 8 * (1 - flashT) : 0;

    /* the slow-motion bullet and its tracer */
    const flight = opening ? clamp01((t - T_FIRE + 0.02) / (T_HIT - T_FIRE)) : 1;
    const flying = opening && t >= T_FIRE && flight < 1;
    const bx = lerp(MUZZLE_X, CHEST_X, flight);
    if (bulletRef.current) {
      bulletRef.current.visible = flying;
      bulletRef.current.position.set(bx, BULLET_Y, 0);
    }
    if (streakRef.current && streakMatRef.current) {
      const fade = opening ? Math.max(0, 1 - Math.max(0, t - T_HIT) / 0.15) : 0;
      const show = (flying || fade > 0) && opening && t >= T_FIRE;
      streakRef.current.visible = show;
      if (show) {
        const len = Math.max(0.001, bx - MUZZLE_X);
        streakRef.current.scale.set(len, 0.045, 1);
        streakRef.current.position.set(MUZZLE_X + len / 2, BULLET_Y, 0);
        streakMatRef.current.opacity = 0.7 * (flying ? 1 : fade);
      }
    }

    /* the doll takes the hit */
    const slumpT = opening ? clamp01((t - T_HIT) / SLUMP_DUR) : settled;
    const sl = easeOutBack(slumpT) * (slumpT > 0 ? 1 : 0);
    if (dollSlumpRef.current) {
      dollSlumpRef.current.rotation.x = -0.5 * sl; // knocked back
      dollSlumpRef.current.rotation.z = 0.28 * sl; // sags sideways
      dollSlumpRef.current.position.y = -0.05 * sl;
    }
    if (headRef.current) {
      // strings-cut head flop; while intact, a slow tilt with a shiver every ~7s
      const twitch = e % 7 < 0.12 ? Math.sin(e * 90) * 0.05 : 0;
      headRef.current.rotation.x = 1.1 * sl;
      headRef.current.rotation.z = sl > 0.01 ? 0.3 * sl : 0.06 * Math.sin(e * 0.35) + twitch;
    }
    if (armLRef.current) armLRef.current.rotation.z = 0.3 + 0.7 * sl;
    if (armRRef.current) armRRef.current.rotation.z = -0.3 - 0.55 * sl;

    /* stuffing burst — positions are a pure function of τ, so replays are clean */
    const burstT = opening ? (t - T_HIT) / BURST_DUR : -1;
    const burstOn = burstT > 0 && burstT < 1;
    if (burstRef.current && burstMatRef.current) {
      burstRef.current.visible = burstOn;
      if (burstOn) {
        const tau = burstT * BURST_DUR;
        const arr = burstRef.current.geometry.attributes.position;
        for (let i = 0; i < BURST_COUNT; i++) {
          const s = BURST.speed[i] * tau;
          arr.setXYZ(
            i,
            CHEST_X + BURST.dir[i * 3] * s,
            BULLET_Y + BURST.dir[i * 3 + 1] * s - 1.4 * tau * tau,
            BURST.dir[i * 3 + 2] * s,
          );
        }
        arr.needsUpdate = true;
        burstMatRef.current.opacity = 0.95 * (1 - burstT);
      }
    }

    /* smoke curling off the muzzle */
    const smokeOn = opening && t > T_FIRE + 0.05 && t < T_FIRE + 2.4;
    if (smokeRef.current && smokeMatRef.current) {
      smokeRef.current.visible = smokeOn;
      if (smokeOn) {
        const arr = smokeRef.current.geometry.attributes.position;
        for (let i = 0; i < SMOKE_COUNT; i++) {
          const tau = Math.max(0, t - T_FIRE - 0.05 - smokeDelay[i]);
          arr.setXYZ(
            i,
            MUZZLE_X + 0.02 + tau * 0.1 + Math.sin(e * 2 + i) * 0.02,
            BULLET_Y + 0.04 + tau * 0.3,
            Math.cos(e * 1.6 + i * 2) * 0.02,
          );
        }
        arr.needsUpdate = true;
        smokeMatRef.current.opacity = 0.28 * (1 - clamp01((t - T_FIRE) / 2.4));
      }
    }

    /* the heart the doll was hiding */
    const hp = opening ? easeOutCubic(clamp01((t - T_HEART) / HEART_DUR)) : settled;
    if (heartRef.current) {
      heartRef.current.visible = hp > 0.001;
      heartRef.current.scale.setScalar(0.26 * easeOutBack(hp));
      heartRef.current.position.set(CHEST_X, lerp(BULLET_Y, 0.6, hp) + Math.sin(e * 1.8) * 0.04 * hp, 0);
      heartRef.current.rotation.y = Math.sin(e * 0.9) * 0.35;
    }
    if (heartLightRef.current) heartLightRef.current.intensity = 2.5 * hp;

    /* sealed: an ominous glint pulses along the gunmetal */
    if (glintLightRef.current) {
      glintLightRef.current.intensity =
        phase === "sealed" ? 1.1 + 0.8 * Math.sin(e * 2.4) : 0.7;
    }

    /* dust motes sinking through the light */
    if (motesRef.current && moteMatRef.current) {
      const arr = motesRef.current.geometry.attributes.position;
      for (let i = 0; i < MOTE_COUNT; i++) {
        let y = arr.getY(i) - MOTES.speed[i] * dt;
        if (y < -0.95) y = 1.3;
        arr.setY(i, y);
        arr.setX(i, arr.getX(i) + Math.sin(e * 0.6 + MOTES.wobble[i]) * dt * 0.02);
      }
      arr.needsUpdate = true;
      const target = phase === "sealed" ? 0.15 : phase === "preview" ? 0.4 : 0.55;
      moteMatRef.current.opacity += (target - moteMatRef.current.opacity) * Math.min(1, dt * 3);
    }

    if (opening && t > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0.1, 0.55, 4.5]}
        fov={38}
        onUpdate={(c) => c.lookAt(0, -0.05, 0)}
      />
      <ambientLight intensity={0.32} />
      <directionalLight position={[-3, 2, -2.5]} intensity={1.2} color={palette.rim} />
      <directionalLight position={[1.5, 1.5, 3.5]} intensity={0.6} color={palette.lamp} />
      <pointLight ref={glintLightRef} position={[-1.1, 0.4, 0.8]} intensity={0.7} color={palette.glint} />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          <group ref={spinRef} position={[0.1, 0, 0]}>
            {/* stage puck */}
            <mesh position={[0, FLOOR_Y - 0.05, 0]}>
              <cylinderGeometry args={[1.55, 1.7, 0.1, 48]} />
              <meshStandardMaterial color="#1a141f" roughness={0.9} />
            </mesh>
            {/* soft blob shadow under the stool (no shadow maps on this canvas) */}
            <mesh position={[STOOL_X, FLOOR_Y + 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1.1, 1.1]} />
              <meshBasicMaterial map={glowTex} color="#000000" transparent opacity={0.5} depthWrite={false} />
            </mesh>

            {/* the swinging bare bulb */}
            <group position={[0, 1.55, 0]}>
              <group ref={lampRef}>
                <mesh position={[0, -0.5, 0]}>
                  <cylinderGeometry args={[0.006, 0.006, 1.0, 6]} />
                  <meshStandardMaterial color="#1a1a1e" roughness={0.8} />
                </mesh>
                <mesh position={[0, -0.93, 0]}>
                  <coneGeometry args={[0.1, 0.09, 20, 1, true]} />
                  <meshStandardMaterial color="#23262d" roughness={0.5} metalness={0.2} side={THREE.DoubleSide} />
                </mesh>
                <mesh position={[0, -1.0, 0]}>
                  <sphereGeometry args={[0.055, 16, 12]} />
                  <meshStandardMaterial
                    color="#fff8ec"
                    emissive={palette.lamp}
                    emissiveIntensity={2.2}
                    roughness={0.3}
                  />
                </mesh>
                <sprite position={[0, -1.0, 0]} scale={0.55}>
                  <spriteMaterial
                    map={glowTex}
                    color={palette.lamp}
                    transparent
                    opacity={0.45}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </sprite>
                <pointLight ref={lampLightRef} position={[0, -1.04, 0]} intensity={8} color={palette.lamp} />
              </group>
            </group>

            {/* the gun — a floating sideshow prop, no hand in sight */}
            <group ref={gunRef} position={[GUN_X, GUN_Y, 0]}>
              <mesh position={[0.28, 0.02, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.042, 0.042, 0.5, 16]} />
                <meshStandardMaterial color={GUNMETAL} roughness={0.45} metalness={0.2} />
              </mesh>
              <mesh position={[0.51, 0.075, 0]}>
                <boxGeometry args={[0.02, 0.035, 0.012]} />
                <meshStandardMaterial color={GUNMETAL} roughness={0.4} metalness={0.2} />
              </mesh>
              <mesh position={[0.02, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.085, 0.085, 0.15, 20]} />
                <meshStandardMaterial color="#2e3440" roughness={0.5} metalness={0.2} />
              </mesh>
              <mesh position={[-0.16, -0.01, 0]}>
                <boxGeometry args={[0.22, 0.11, 0.06]} />
                <meshStandardMaterial color={GUNMETAL} roughness={0.4} metalness={0.2} />
              </mesh>
              <mesh position={[-0.26, -0.19, 0]} rotation={[0, 0, 0.35]}>
                <boxGeometry args={[0.09, 0.22, 0.055]} />
                <meshStandardMaterial color={WOOD} roughness={0.7} />
              </mesh>
              <group ref={hammerRef} position={[-0.27, 0.055, 0]}>
                <mesh position={[0, 0.05, 0]}>
                  <boxGeometry args={[0.028, 0.1, 0.024]} />
                  <meshStandardMaterial color={GUNMETAL} roughness={0.4} metalness={0.2} />
                </mesh>
              </group>
              <mesh position={[-0.12, -0.1, 0]}>
                <torusGeometry args={[0.045, 0.009, 8, 20]} />
                <meshStandardMaterial color={GUNMETAL} roughness={0.4} metalness={0.2} />
              </mesh>
              <mesh position={[-0.12, -0.08, 0]} rotation={[0, 0, 0.2]}>
                <boxGeometry args={[0.012, 0.05, 0.012]} />
                <meshStandardMaterial color={GUNMETAL} roughness={0.4} metalness={0.2} />
              </mesh>
            </group>

            {/* muzzle flash + bullet + tracer */}
            <mesh ref={flashRef} position={[MUZZLE_X + 0.08, BULLET_Y, 0.02]} visible={false}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial
                map={glowTex}
                color="#ffd9a0"
                transparent
                opacity={0}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
            <pointLight ref={flashLightRef} position={[MUZZLE_X + 0.1, BULLET_Y, 0.3]} intensity={0} color="#ffcf9c" />
            <mesh ref={bulletRef} rotation={[0, 0, Math.PI / 2]} visible={false}>
              <capsuleGeometry args={[0.018, 0.05, 4, 8]} />
              <meshStandardMaterial color="#d8b26a" roughness={0.3} metalness={0.35} emissive="#8a6a30" emissiveIntensity={0.5} />
            </mesh>
            <mesh ref={streakRef} visible={false}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial
                ref={streakMatRef}
                map={glowTex}
                color={palette.glint}
                transparent
                opacity={0}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/* stool */}
            <group position={[STOOL_X, 0, 0]}>
              <mesh position={[0, SEAT_Y - 0.03, 0]}>
                <cylinderGeometry args={[0.3, 0.3, 0.06, 24]} />
                <meshStandardMaterial color={WOOD} roughness={0.85} />
              </mesh>
              {[0, 1, 2, 3].map((i) => {
                const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
                return (
                  <mesh
                    key={i}
                    position={[Math.cos(a) * 0.22, FLOOR_Y + 0.26, Math.sin(a) * 0.22]}
                    rotation={[Math.sin(a) * 0.14, 0, -Math.cos(a) * 0.14]}
                  >
                    <cylinderGeometry args={[0.018, 0.022, 0.52, 10]} />
                    <meshStandardMaterial color="#3a2b20" roughness={0.85} />
                  </mesh>
                );
              })}
            </group>

            {/* the doll, facing the gun */}
            <group position={[STOOL_X, SEAT_Y, 0]} rotation={[0, -Math.PI / 2, 0]}>
              <group ref={dollSlumpRef}>
                {/* torso */}
                <mesh position={[0, 0.27, 0]}>
                  <capsuleGeometry args={[0.16, 0.22, 6, 16]} />
                  <meshStandardMaterial color={BURLAP} roughness={0.95} />
                </mesh>
                {/* the red X over its chest — X marks the spot */}
                <StitchX position={[0, 0.31, 0.16]} size={0.1} color={THREAD_RED} />
                {/* head */}
                <group ref={headRef} position={[0, 0.52, 0]}>
                  <mesh position={[0, 0.1, 0]} scale={[1, 1.05, 1]}>
                    <sphereGeometry args={[0.17, 24, 18]} />
                    <meshStandardMaterial color={BURLAP} roughness={0.95} />
                  </mesh>
                  <StitchX position={[-0.065, 0.13, 0.155]} size={0.065} />
                  <StitchX position={[0.065, 0.13, 0.155]} size={0.065} />
                  <mesh position={[0, 0.02, 0.16]}>
                    <boxGeometry args={[0.09, 0.01, 0.012]} />
                    <meshStandardMaterial color={STITCH} roughness={0.9} />
                  </mesh>
                </group>
                {/* arms hang from shoulder pivots */}
                <group ref={armLRef} position={[-0.16, 0.42, 0]}>
                  <mesh position={[0, -0.12, 0]}>
                    <capsuleGeometry args={[0.045, 0.18, 4, 10]} />
                    <meshStandardMaterial color={BURLAP} roughness={0.95} />
                  </mesh>
                </group>
                <group ref={armRRef} position={[0.16, 0.42, 0]}>
                  <mesh position={[0, -0.12, 0]}>
                    <capsuleGeometry args={[0.045, 0.18, 4, 10]} />
                    <meshStandardMaterial color={BURLAP} roughness={0.95} />
                  </mesh>
                </group>
                {/* legs dangle off the stool */}
                <mesh position={[-0.08, 0.02, 0.14]} rotation={[-1.25, 0, 0.08]}>
                  <capsuleGeometry args={[0.05, 0.2, 4, 10]} />
                  <meshStandardMaterial color={BURLAP} roughness={0.95} />
                </mesh>
                <mesh position={[0.08, 0.02, 0.14]} rotation={[-1.25, 0, -0.08]}>
                  <capsuleGeometry args={[0.05, 0.2, 4, 10]} />
                  <meshStandardMaterial color={BURLAP} roughness={0.95} />
                </mesh>
              </group>
            </group>

            {/* stuffing burst */}
            <points ref={burstRef} visible={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[BURST.pos, 3]} />
              </bufferGeometry>
              <pointsMaterial
                ref={burstMatRef}
                map={glowTex}
                color={palette.burst}
                size={0.09}
                sizeAttenuation
                transparent
                opacity={0}
                depthWrite={false}
              />
            </points>

            {/* gun smoke */}
            <points ref={smokeRef} visible={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[smokePos, 3]} />
              </bufferGeometry>
              <pointsMaterial
                ref={smokeMatRef}
                map={glowTex}
                color="#9aa0ab"
                size={0.14}
                sizeAttenuation
                transparent
                opacity={0}
                depthWrite={false}
              />
            </points>

            {/* the heart it was hiding */}
            <group ref={heartRef} visible={false}>
              <mesh geometry={heartGeo}>
                <meshStandardMaterial
                  color={palette.heart}
                  emissive={palette.heart}
                  emissiveIntensity={0.85}
                  roughness={0.35}
                />
              </mesh>
              <pointLight ref={heartLightRef} intensity={0} color={palette.heart} distance={2.5} />
            </group>

            {/* dust sinking through the lamplight */}
            <points ref={motesRef}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[MOTES.pos, 3]} />
              </bufferGeometry>
              <pointsMaterial
                ref={moteMatRef}
                map={glowTex}
                color={palette.mote}
                size={0.04}
                sizeAttenuation
                transparent
                opacity={0}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </points>
          </group>
        </group>
      </group>
    </>
  );
}
