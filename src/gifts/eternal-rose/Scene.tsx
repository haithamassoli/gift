import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, mulberry32, smooth } from "../math";

/* ---------- palettes ---------- */
const PALETTES: Record<
  string,
  { petal: string; deep: string; emissive: string; mote: string; metalness: number; roughness: number }
> = {
  red: { petal: "#b81f3f", deep: "#6e0d22", emissive: "#2a030c", mote: "#ffca9b", metalness: 0.05, roughness: 0.55 },
  white: { petal: "#f3ead9", deep: "#c9b696", emissive: "#181410", mote: "#fdf3c0", metalness: 0.02, roughness: 0.6 },
  "midnight-gold": { petal: "#343767", deep: "#181a38", emissive: "#7a5c10", mote: "#ffd76a", metalness: 0.5, roughness: 0.35 },
};

/* ---------- procedural petal geometry (shared by petals, sepals, leaves) ---------- */
function buildPetalGeometry(): THREE.BufferGeometry {
  const W = 10;
  const H = 14;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let iy = 0; iy <= H; iy++) {
    const v = iy / H;
    for (let ix = 0; ix <= W; ix++) {
      const u = ix / W;
      const su = u * 2 - 1;
      const width = 0.5 * Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * v)), 0.7) * (0.4 + 0.6 * Math.pow(v, 0.6));
      const cup = -0.4 * su * su * (1 - 0.5 * v);
      const curl = 0.45 * v * v;
      const ruffle = 0.035 * Math.sin(su * Math.PI * 2.3) * v;
      positions.push(su * width, v, cup + curl + ruffle);
    }
  }
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const a = iy * (W + 1) + ix;
      const b = a + 1;
      const c = a + W + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const petalGeo = buildPetalGeometry();
const stemCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, -1.52, 0),
  new THREE.Vector3(0.07, -1.15, 0.04),
  new THREE.Vector3(-0.05, -0.75, -0.03),
  new THREE.Vector3(0.02, -0.35, 0.02),
  new THREE.Vector3(0, -0.15, 0),
]);
const stemGeo = new THREE.TubeGeometry(stemCurve, 24, 0.035, 8);

/* ---------- petal layout ---------- */
const LAYERS = [
  { count: 3, scale: 0.42, open: 0.28, radial: 0.012 },
  { count: 5, scale: 0.58, open: 0.48, radial: 0.05 },
  { count: 7, scale: 0.74, open: 0.68, radial: 0.09 },
  { count: 8, scale: 0.88, open: 0.88, radial: 0.13 },
  { count: 9, scale: 1.0, open: 0.98, radial: 0.17 },
];

interface Petal {
  azimuth: number;
  layer: number;
  scale: number;
  closed: number;
  open: number;
  radial: number;
  y: number;
  start: number; // bloom start time (s into the opening timeline)
}

const BLOOM_DUR = 1.1; // seconds for one petal to bloom closed→open
function buildPetals(): { petals: Petal[]; end: number } {
  const rand = mulberry32(20260713);
  const petals: Petal[] = [];
  const outer = LAYERS.length - 1;
  for (let layer = 0; layer < LAYERS.length; layer++) {
    const spec = LAYERS[layer];
    for (let i = 0; i < spec.count; i++) {
      petals.push({
        azimuth: (i / spec.count) * Math.PI * 2 + layer * 0.9 + (rand() - 0.5) * 0.14,
        layer,
        scale: spec.scale * (0.97 + rand() * 0.06),
        closed: 0.05 + layer * 0.02 + (rand() - 0.5) * 0.02,
        open: spec.open + (rand() - 0.5) * 0.1,
        radial: spec.radial,
        y: -layer * 0.018,
        start: 1.1 + (outer - layer) * 0.5 + i * 0.05 + rand() * 0.05,
      });
    }
  }
  const end = Math.max(...petals.map((p) => p.start)) + BLOOM_DUR + 0.4;
  return { petals, end };
}

const { petals: PETALS, end: OPEN_END } = buildPetals();

/* ---------- light motes ---------- */
const MOTE_COUNT = 110;
function buildMotes() {
  const rand = mulberry32(777);
  const pos = new Float32Array(MOTE_COUNT * 3);
  const speed = new Float32Array(MOTE_COUNT);
  const wobble = new Float32Array(MOTE_COUNT);
  const maxY = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    const r = Math.sqrt(rand()) * 0.9;
    const a = rand() * Math.PI * 2;
    // Keep each mote under the dome glass: ellipsoid r=1.15, height 2.185, center y=-1.5.
    const top = -1.5 + 2.1 * Math.sqrt(Math.max(0.04, 1 - (r / 1.05) ** 2)) - 0.12;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = -1.35 + rand() * (top + 1.35);
    pos[i * 3 + 2] = Math.sin(a) * r;
    speed[i] = 0.06 + rand() * 0.14;
    wobble[i] = rand() * Math.PI * 2;
    maxY[i] = top;
  }
  return { pos, speed, wobble, maxY };
}

const DOME_BASE_Y = -1.5;

// Round sprite for the mote particles (PointsMaterial renders squares without a map).
const moteTexture = makeRadialSprite();

export default function EternalRoseScene({ variants, phase, onOpenComplete }: SceneProps) {
  const palette = PALETTES[variants.petal] ?? PALETTES.red;

  const petalMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: palette.petal,
        emissive: palette.emissive,
        emissiveIntensity: 0.5,
        roughness: palette.roughness,
        metalness: palette.metalness,
        side: THREE.DoubleSide,
      }),
    [palette],
  );
  const innerMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: palette.deep,
        emissive: palette.emissive,
        emissiveIntensity: 0.4,
        roughness: palette.roughness,
        metalness: palette.metalness,
        side: THREE.DoubleSide,
      }),
    [palette],
  );
  useEffect(() => {
    return () => {
      petalMat.dispose();
      innerMat.dispose();
    };
  }, [petalMat, innerMat]);

  const motes = useMemo(() => buildMotes(), []);

  const spinRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const domeRef = useRef<THREE.Mesh>(null);
  const domeMatRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const glowRef = useRef<THREE.PointLight>(null);
  const motesRef = useRef<THREE.Points>(null);
  const moteMatRef = useRef<THREE.PointsMaterial>(null);
  const petalRefs = useRef<(THREE.Group | null)[]>([]);

  const { t: tRef, done: completeRef } = useOpeningClock(phase);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const elapsed = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    // Dome: down in preview/sealed, lifts + fades during opening, gone when revealed.
    const domeP =
      phase === "opening" ? smooth(clamp01(t / 1.4)) : phase === "revealed" ? 1 : 0;
    if (domeRef.current && domeMatRef.current) {
      domeRef.current.position.y = DOME_BASE_Y + domeP * 3.4;
      domeMatRef.current.opacity = 0.11 * (1 - domeP);
      domeRef.current.visible = domeP < 0.999;
    }

    // Petals: closed in sealed, staggered outer→inner bloom during opening, open otherwise.
    const staticBloom = phase === "sealed" ? 0 : 1;
    for (let i = 0; i < PETALS.length; i++) {
      const p = PETALS[i];
      const g = petalRefs.current[i];
      if (!g) continue;
      const pp =
        phase === "opening"
          ? easeOutCubic(clamp01((t - p.start) / BLOOM_DUR))
          : staticBloom;
      g.rotation.x = p.closed + (p.open - p.closed) * pp;
      g.scale.setScalar(p.scale * (0.78 + 0.22 * pp));
    }

    if (phase === "opening" && t > OPEN_END && !completeRef.current) {
      completeRef.current = true;
      onOpenComplete?.();
    }

    // Whole-arrangement slow turn + gentle head sway.
    if (spinRef.current) {
      const speed = phase === "preview" ? 0.22 : phase === "sealed" ? 0.06 : 0.1;
      spinRef.current.rotation.y += dt * speed;
    }
    if (headRef.current) {
      headRef.current.rotation.z = Math.sin(elapsed * 0.7) * 0.02;
    }

    // Motes drift upward, wrap, and fade in/out by phase.
    if (motesRef.current && moteMatRef.current) {
      const arr = motesRef.current.geometry.attributes.position;
      const rising = phase === "opening" || phase === "revealed" ? 1.4 : 0.45;
      for (let i = 0; i < MOTE_COUNT; i++) {
        let y = arr.getY(i) + motes.speed[i] * dt * rising;
        // After the dome lifts, let motes escape upward; while it's down, wrap inside it.
        const ceiling = phase === "revealed" || phase === "opening" ? 1.6 : motes.maxY[i];
        if (y > ceiling) y = -1.35;
        arr.setY(i, y);
        arr.setX(i, arr.getX(i) + Math.sin(elapsed * 0.8 + motes.wobble[i]) * dt * 0.03);
      }
      arr.needsUpdate = true;
      const target = phase === "sealed" ? 0.12 : phase === "preview" ? 0.5 : 0.85;
      moteMatRef.current.opacity += (target - moteMatRef.current.opacity) * Math.min(1, dt * 3);
    }

    // Inviting pulse while sealed.
    if (glowRef.current) {
      glowRef.current.intensity =
        phase === "sealed" ? 0.55 + Math.sin(elapsed * 2.2) * 0.25 : 0.7;
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.3, 4.3]}
        fov={38}
        onUpdate={(c) => c.lookAt(0, -0.35, 0)}
      />
      <ambientLight intensity={0.45} />
      <directionalLight position={[3, 4, 2.5]} intensity={1.3} color="#ffe9d6" />
      <pointLight position={[-2.5, 1, -2]} intensity={0.5} color="#e08baa" />
      <pointLight ref={glowRef} position={[0.6, 0.2, 1.2]} intensity={0.7} color={palette.mote} />

      <group ref={spinRef}>
        {/* pedestal */}
        <mesh position={[0, -1.6, 0]}>
          <cylinderGeometry args={[1.45, 1.55, 0.16, 48]} />
          <meshStandardMaterial color="#221418" roughness={0.4} metalness={0.3} />
        </mesh>
        <mesh position={[0, -1.51, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.32, 0.014, 8, 64]} />
          <meshStandardMaterial color="#c9a24b" roughness={0.3} metalness={0.9} />
        </mesh>

        {/* rose */}
        <group ref={headRef}>
          <mesh geometry={stemGeo}>
            <meshStandardMaterial color="#2f6b3a" roughness={0.7} />
          </mesh>
          {/* leaves */}
          <group position={[-0.03, -0.75, 0]} rotation={[0.3, 0.4, -1.05]} scale={[0.4, 0.55, 0.4]}>
            <mesh geometry={petalGeo}>
              <meshStandardMaterial color="#2f6b3a" roughness={0.7} side={THREE.DoubleSide} />
            </mesh>
          </group>
          <group position={[0.05, -1.1, 0.02]} rotation={[-0.25, 2.4, 1.1]} scale={[0.35, 0.5, 0.35]}>
            <mesh geometry={petalGeo}>
              <meshStandardMaterial color="#28572f" roughness={0.7} side={THREE.DoubleSide} />
            </mesh>
          </group>

          {/* rose head */}
          <group position={[0, -0.15, 0]} scale={0.55}>
            {/* sepals */}
            {[0, 1, 2, 3, 4].map((i) => (
              <group key={`sepal-${i}`} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
                <group position={[0, -0.04, 0.05]} rotation={[1.25, 0, 0]} scale={[0.3, 0.42, 0.3]}>
                  <mesh geometry={petalGeo}>
                    <meshStandardMaterial color="#26502c" roughness={0.7} side={THREE.DoubleSide} />
                  </mesh>
                </group>
              </group>
            ))}
            {/* bud core */}
            <mesh position={[0, 0.14, 0]} scale={[1, 1.5, 1]}>
              <sphereGeometry args={[0.13, 16, 16]} />
              <primitive object={innerMat} attach="material" />
            </mesh>
            {/* petals */}
            {PETALS.map((p, i) => (
              <group key={i} rotation={[0, p.azimuth, 0]}>
                <group
                  ref={(el) => {
                    petalRefs.current[i] = el;
                  }}
                  position={[0, p.y, p.radial]}
                  rotation={[p.closed, 0, 0]}
                  scale={p.scale}
                >
                  <mesh geometry={petalGeo} material={p.layer < 2 ? innerMat : petalMat} />
                </group>
              </group>
            ))}
          </group>
        </group>

        {/* light motes */}
        <points ref={motesRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[motes.pos, 3]} />
          </bufferGeometry>
          <pointsMaterial
            ref={moteMatRef}
            map={moteTexture}
            color={palette.mote}
            size={0.07}
            sizeAttenuation
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>

        {/* glass cloche */}
        <mesh ref={domeRef} position={[0, DOME_BASE_Y, 0]} scale={[1, 1.9, 1]} renderOrder={10}>
          <sphereGeometry args={[1.15, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshPhysicalMaterial
            ref={domeMatRef}
            color="#cfe4ef"
            transparent
            opacity={0.11}
            roughness={0.06}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.1}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      </group>
    </>
  );
}
