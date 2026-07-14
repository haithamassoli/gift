import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { sampleTextPoints } from "../text3d";

/* ---------- deterministic pseudo-random (stable across renders) ---------- */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => x * x * (3 - 2 * x);
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ---------- palettes (keyed by the `glow` variant value) ---------- */
interface Palette {
  glow: string; // additive butterfly tint
  light: string; // interior + formation point light
}
const PALETTES: Record<string, Palette> = {
  aqua: { glow: "#3fe6d0", light: "#63f4e2" },
  violet: { glow: "#b57bff", light: "#c79bff" },
  amber: { glow: "#ffb24d", light: "#ffcf8a" },
};

/* ---------- butterfly sprite: two-lobed wings + thin body on a 64px canvas ---------- */
function buildButterflyTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  g.fillStyle = "#ffffff";
  g.shadowColor = "#ffffff";
  g.shadowBlur = 4;
  const wing = (dx: number, dy: number, rx: number, ry: number, rot: number, alpha: number) => {
    g.save();
    g.translate(cx + dx, cy + dy);
    g.rotate(rot);
    g.globalAlpha = alpha;
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, 0, TAU);
    g.fill();
    g.restore();
  };
  // upper wings
  wing(-11, -6, 13, 10, -0.5, 0.95);
  wing(11, -6, 13, 10, 0.5, 0.95);
  // lower wings
  wing(-9, 10, 9.5, 8, 0.5, 0.85);
  wing(9, 10, 9.5, 8, -0.5, 0.85);
  // thin body
  g.globalAlpha = 1;
  g.beginPath();
  g.ellipse(cx, cy, 2.2, 14, 0, 0, TAU);
  g.fill();
  return new THREE.CanvasTexture(c);
}
const butterflyTexture = buildButterflyTexture();

/* ---------- mason-jar silhouette (surface of revolution) ---------- */
const JAR_PROFILE = [
  new THREE.Vector2(0.0, -1.78),
  new THREE.Vector2(0.5, -1.78),
  new THREE.Vector2(0.82, -1.7),
  new THREE.Vector2(0.86, -1.55),
  new THREE.Vector2(0.85, -0.7),
  new THREE.Vector2(0.82, -0.5),
  new THREE.Vector2(0.66, -0.32),
  new THREE.Vector2(0.6, -0.18),
  new THREE.Vector2(0.6, -0.02),
  new THREE.Vector2(0.58, 0.04),
];
const jarGeo = new THREE.LatheGeometry(JAR_PROFILE, 48);

/* ---------- butterfly system ---------- */
const N = 220;
const FORMATION_Y = 1.4;
const OPEN_END = 5.2;
// gl_PointSize = aSize * wing * (uScale / -mvz); uScale ~ canvasHeight/2 => world-proportional.
const BASE_SIZE = 0.75;

interface Fly {
  swirlR: number;
  swirlA0: number;
  swirlSpeed: number;
  swirlH: number;
  swirlVAmp: number;
  swirlVFreq: number;
  seed: number;
  exitStart: number;
  exitDur: number;
  helixTurns: number;
  helixDir: number;
  releaseR: number;
  releaseY: number;
  lockDelay: number;
  lockDur: number;
  bobSeed: number;
  bobFreq: number;
  wanderSeed: number;
  isStray: boolean;
  strayR: number;
  strayA0: number;
  straySpeed: number;
  strayY: number;
}

function buildSystem() {
  const rand = mulberry32(424242);
  const positions = new Float32Array(N * 3);
  const aSeed = new Float32Array(N);
  const aFreq = new Float32Array(N);
  const aSize = new Float32Array(N);
  const flies: Fly[] = [];
  for (let i = 0; i < N; i++) {
    const swirlR = 0.15 + rand() * 0.5;
    const swirlA0 = rand() * TAU;
    const swirlSpeed = (0.5 + rand() * 0.9) * (rand() < 0.5 ? -1 : 1);
    const swirlH = -1.55 + rand() * 1.15;
    const swirlVAmp = 0.04 + rand() * 0.08;
    const swirlVFreq = 0.5 + rand() * 1.4;
    const seed = rand() * TAU;
    const freq = (6 + rand() * 3) * TAU; // wingbeat: 6-9 Hz -> angular
    const sizeBase = 0.6 + rand() * 0.4;
    const exitStart = 1.2 + rand() * 1.0;
    const exitDur = 0.8 + rand() * 0.3;
    const helixTurns = 1.5 + rand() * 1.5;
    const helixDir = rand() < 0.5 ? -1 : 1;
    const releaseR = 0.4 + rand() * 0.9;
    const releaseY = 0.4 + rand() * 0.7;
    const lockDelay = rand() * 0.7;
    const lockDur = 0.8 + rand() * 0.3;
    const bobSeed = rand() * TAU;
    const bobFreq = 0.5 + rand() * 0.8;
    const wanderSeed = rand() * TAU;
    const isStray = i % 15 === 0; // ~15 strays orbit the jar instead of joining the text
    const strayR = 1.05 + rand() * 0.5;
    const strayA0 = rand() * TAU;
    const straySpeed = (0.25 + rand() * 0.3) * (rand() < 0.5 ? -1 : 1);
    const strayY = -0.15 + rand() * 0.7;
    flies.push({
      swirlR, swirlA0, swirlSpeed, swirlH, swirlVAmp, swirlVFreq, seed,
      exitStart, exitDur, helixTurns, helixDir, releaseR, releaseY,
      lockDelay, lockDur, bobSeed, bobFreq, wanderSeed,
      isStray, strayR, strayA0, straySpeed, strayY,
    });
    aSeed[i] = seed;
    aFreq[i] = freq;
    aSize[i] = sizeBase * BASE_SIZE;
    positions[i * 3] = Math.cos(swirlA0) * swirlR;
    positions[i * 3 + 1] = swirlH;
    positions[i * 3 + 2] = Math.sin(swirlA0) * swirlR;
  }
  return { positions, aSeed, aFreq, aSize, flies };
}

const VERT = `
attribute float aSeed;
attribute float aFreq;
attribute float aSize;
uniform float uTime;
uniform float uScale;
uniform float uForm;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // damp the wingbeat as the swarm locks in so points hold the glyph shape
  float wing = mix(0.8 + 0.2 * sin(uTime * aFreq + aSeed), 0.95 + 0.05 * sin(uTime * aFreq + aSeed), uForm);
  // shrink toward ~32% as the swarm locks into the glyphs so points stay separable and the text reads
  gl_PointSize = aSize * wing * mix(1.0, 0.32, uForm) * (uScale / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
uniform sampler2D uTex;
uniform vec3 uColor;
uniform float uIntensity;
void main() {
  vec4 tex = texture2D(uTex, gl_PointCoord);
  gl_FragColor = vec4(uColor * uIntensity, 1.0) * tex.a;
}
`;

export default function ButterflyJarScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const palette = PALETTES[variants.glow] ?? PALETTES.aqua;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  const sys = useMemo(() => buildSystem(), []);

  // Text formation targets (particle text via sampleTextPoints).
  const textSource =
    message.trim() || recipientName.trim() || (lang === "ar" ? "إليك" : "For you");
  const targets = useMemo(() => {
    const tp = sampleTextPoints(textSource, { maxPoints: 300, fontSize: 90, seed: 5, lang });
    const count = Math.max(1, tp.count);
    const maxH = 1.7;
    let worldW = 2.6;
    if (tp.aspect * worldW > maxH) worldW = maxH / tp.aspect;
    const arr = new Float32Array(count * 3);
    const rand = mulberry32(9911);
    if (tp.count > 0) {
      for (let i = 0; i < tp.count; i++) {
        arr[i * 3] = tp.points[i * 2] * worldW;
        arr[i * 3 + 1] = FORMATION_Y + tp.points[i * 2 + 1] * worldW;
        arr[i * 3 + 2] = (rand() - 0.5) * 0.06;
      }
    } else {
      arr[1] = FORMATION_Y;
    }
    return { arr, count };
  }, [textSource, lang]);

  // Variant materials: built here, keyed on the palette object, disposed on change.
  const { flyMat, glowMat } = useMemo(() => {
    const fm = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 300 },
        uForm: { value: 0 },
        uTex: { value: butterflyTexture },
        uColor: { value: new THREE.Color(palette.glow) },
        uIntensity: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const gm = new THREE.MeshBasicMaterial({
      color: new THREE.Color(palette.light),
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return { flyMat: fm, glowMat: gm };
  }, [palette]);

  useEffect(() => {
    return () => {
      flyMat.dispose();
      glowMat.dispose();
    };
  }, [flyMat, glowMat]);

  const pointsRef = useRef<THREE.Points>(null);
  const glowMeshRef = useRef<THREE.Mesh>(null);
  const lidRef = useRef<THREE.Group>(null);
  const jarGlowRef = useRef<THREE.PointLight>(null);
  const formLightRef = useRef<THREE.PointLight>(null);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    const formProg =
      phase === "opening" ? clamp01((t - 2.6) / 2.4) : phase === "revealed" ? 1 : 0;

    // ---- butterflies: uniforms + positions via the points ref (never mutate memo values) ----
    const points = pointsRef.current;
    if (points) {
      const mat = points.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value = e;
      mat.uniforms.uScale.value = state.size.height * 0.5;
      mat.uniforms.uForm.value = formProg;
      const targetI =
        phase === "sealed" ? 0.55 : phase === "revealed" ? 1.3 : phase === "preview" ? 1.0 : 1.0 + formProg * 0.5;
      mat.uniforms.uIntensity.value += (targetI - mat.uniforms.uIntensity.value) * Math.min(1, dt * 4);

      const attr = points.geometry.attributes.position as THREE.BufferAttribute;
      const pos = attr.array as Float32Array;
      const flies = sys.flies;
      const tArr = targets.arr;
      const tc = targets.count;
      for (let i = 0; i < N; i++) {
        const f = flies[i];
        let x: number;
        let y: number;
        let z: number;

        if (phase === "preview" || phase === "sealed") {
          const sc = phase === "sealed" ? 0.4 : 1.0;
          const a = f.swirlA0 + e * f.swirlSpeed * sc;
          x = Math.cos(a) * f.swirlR;
          z = Math.sin(a) * f.swirlR;
          y = f.swirlH + Math.sin(e * f.swirlVFreq + f.seed) * f.swirlVAmp;
        } else if (phase === "revealed") {
          if (f.isStray) {
            const a = f.strayA0 + e * f.straySpeed;
            x = Math.cos(a) * f.strayR;
            z = Math.sin(a) * f.strayR;
            y = f.strayY + Math.sin(e * f.bobFreq + f.bobSeed) * 0.08;
          } else {
            const ti = (i % tc) * 3;
            x = tArr[ti] + Math.sin(e * f.bobFreq + f.wanderSeed) * 0.012;
            y = tArr[ti + 1] + Math.sin(e * f.bobFreq * 0.8 + f.bobSeed) * 0.012;
            z = tArr[ti + 2] + Math.cos(e * f.bobFreq + f.wanderSeed) * 0.012;
          }
        } else {
          // opening
          if (t < f.exitStart) {
            const a = f.swirlA0 + e * f.swirlSpeed;
            x = Math.cos(a) * f.swirlR;
            z = Math.sin(a) * f.swirlR;
            y = f.swirlH + Math.sin(e * f.swirlVFreq + f.seed) * f.swirlVAmp;
          } else {
            const exitEnd = f.exitStart + f.exitDur;
            const lockStart = exitEnd + f.lockDelay;
            const spin = easeOutCubic(clamp01((t - f.exitStart) / f.exitDur)) * f.helixTurns * TAU * f.helixDir;
            const ang = f.swirlA0 + e * f.swirlSpeed + spin;
            if (t < lockStart) {
              // spiral up & out of the mouth: funnel through r~0.28, then bloom outward
              const ex = clamp01((t - f.exitStart) / f.exitDur);
              const r = ex < 0.5 ? lerp(f.swirlR, 0.28, smooth(ex * 2)) : lerp(0.28, f.releaseR, smooth((ex - 0.5) * 2));
              const ry = lerp(f.swirlH, f.releaseY, easeOutCubic(ex));
              x = Math.cos(ang) * r;
              z = Math.sin(ang) * r;
              y = ry + Math.sin(e * f.bobFreq + f.bobSeed) * 0.05 * ex;
            } else {
              // lerp from the release point to the target (text glyph, or stray orbit)
              const l = easeInOut(clamp01((t - lockStart) / f.lockDur));
              const rAng = f.swirlA0 + e * f.swirlSpeed + f.helixTurns * TAU * f.helixDir;
              const rx = Math.cos(rAng) * f.releaseR;
              const rz = Math.sin(rAng) * f.releaseR;
              let dx: number;
              let dy: number;
              let dz: number;
              if (f.isStray) {
                const sa = f.strayA0 + e * f.straySpeed;
                dx = Math.cos(sa) * f.strayR;
                dy = f.strayY + Math.sin(e * f.bobFreq + f.bobSeed) * 0.08;
                dz = Math.sin(sa) * f.strayR;
              } else {
                const ti = (i % tc) * 3;
                dx = tArr[ti];
                dy = tArr[ti + 1];
                dz = tArr[ti + 2];
              }
              x = lerp(rx, dx, l);
              y = lerp(f.releaseY, dy, l);
              z = lerp(rz, dz, l);
            }
          }
        }

        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
      }
      attr.needsUpdate = true;
    }

    if (phase === "opening" && t > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    // ---- lid: unscrew (3 turns), lift, tip off onto the surface ----
    if (lidRef.current) {
      const p = phase === "opening" ? easeInOut(clamp01(t / 1.6)) : phase === "revealed" ? 1 : 0;
      const arc = Math.sin(clamp01(p) * Math.PI) * 0.8;
      lidRef.current.position.set(easeInOut(p) * 1.25, lerp(0.12, -1.6, p) + arc, easeInOut(p) * 0.35);
      lidRef.current.rotation.set(p * 0.3, p * 3 * TAU, p * 1.4);
    }

    // ---- interior glow disk (via mesh ref) ----
    const glowMesh = glowMeshRef.current;
    if (glowMesh) {
      const gmat = glowMesh.material as THREE.MeshBasicMaterial;
      const pulse = Math.sin(e * 2.0);
      const targetGlow =
        phase === "sealed"
          ? 0.2 + 0.06 * pulse
          : phase === "preview"
            ? 0.42 + 0.1 * pulse
            : phase === "revealed"
              ? 0.22
              : lerp(0.42, 0.2, formProg);
      gmat.opacity += (Math.max(0, targetGlow) - gmat.opacity) * Math.min(1, dt * 4);
    }

    // ---- lights ----
    if (jarGlowRef.current) {
      jarGlowRef.current.intensity =
        phase === "sealed"
          ? 0.5 + 0.18 * Math.sin(e * 2.0)
          : phase === "preview"
            ? 1.3 + 0.3 * Math.sin(e * 1.6)
            : phase === "revealed"
              ? 0.5
              : lerp(1.3, 0.45, formProg);
    }
    if (formLightRef.current) {
      formLightRef.current.intensity = formProg * 1.5;
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.25, 7.6]}
        fov={42}
        onUpdate={(c) => c.lookAt(0, 0.2, 0)}
      />
      <ambientLight intensity={0.35} color="#6a6a8a" />
      <directionalLight position={[2.5, 4, 3]} intensity={0.9} color="#eef0ff" />
      <pointLight ref={jarGlowRef} position={[0, -0.9, 0]} intensity={1.3} color={palette.light} distance={6} />
      <pointLight ref={formLightRef} position={[0, FORMATION_Y, 0.7]} intensity={0} color={palette.light} distance={7} />

      {/* dark surface the jar rests on */}
      <mesh position={[0, -1.86, 0]}>
        <cylinderGeometry args={[4, 4, 0.12, 48]} />
        <meshStandardMaterial color="#140d18" roughness={0.85} metalness={0.1} />
      </mesh>

      {/* pooled interior glow near the jar base */}
      <mesh ref={glowMeshRef} position={[0, -1.7, 0]} rotation={[-Math.PI / 2, 0, 0]} material={glowMat}>
        <circleGeometry args={[0.72, 32]} />
      </mesh>

      {/* butterflies (one points system) */}
      <points ref={pointsRef} material={flyMat} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[sys.positions, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[sys.aSeed, 1]} />
          <bufferAttribute attach="attributes-aFreq" args={[sys.aFreq, 1]} />
          <bufferAttribute attach="attributes-aSize" args={[sys.aSize, 1]} />
        </bufferGeometry>
      </points>

      {/* glass jar (reference dome material) */}
      <mesh geometry={jarGeo} renderOrder={10}>
        <meshPhysicalMaterial
          color="#cfe4ef"
          transparent
          opacity={0.14}
          roughness={0.08}
          metalness={0}
          clearcoat={1}
          clearcoatRoughness={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* threaded metal lid */}
      <group ref={lidRef} position={[0, 0.12, 0]}>
        <mesh>
          <cylinderGeometry args={[0.6, 0.6, 0.16, 32]} />
          <meshStandardMaterial color="#9aa0aa" roughness={0.35} metalness={0.85} />
        </mesh>
        <mesh position={[0, 0.1, 0]}>
          <cylinderGeometry args={[0.58, 0.6, 0.05, 32]} />
          <meshStandardMaterial color="#aab0ba" roughness={0.3} metalness={0.85} />
        </mesh>
        <mesh position={[0, -0.055, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.6, 0.02, 8, 32]} />
          <meshStandardMaterial color="#7f858f" roughness={0.4} metalness={0.9} />
        </mesh>
        <mesh position={[0, -0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.605, 0.012, 6, 32]} />
          <meshStandardMaterial color="#7f858f" roughness={0.4} metalness={0.9} />
        </mesh>
        <mesh position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.605, 0.012, 6, 32]} />
          <meshStandardMaterial color="#7f858f" roughness={0.4} metalness={0.9} />
        </mesh>
      </group>
    </>
  );
}
