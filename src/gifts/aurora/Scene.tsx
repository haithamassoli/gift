import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { forRecipient } from "../../i18n";

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

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => x * x * (3 - 2 * x);

/* ---------- palettes (keyed by the "palette" variant) ---------- */
const PALETTES: Record<
  string,
  { a: string; b: string; text: string; glow: string; light: string; spark: string }
> = {
  emerald: { a: "#2bff9e", b: "#0e7f9e", text: "#eafff5", glow: "#66ffc0", light: "#3fe89e", spark: "#bfffe4" },
  magenta: { a: "#ff5fae", b: "#7a3bff", text: "#fff0fa", glow: "#ff8ecb", light: "#f065c8", spark: "#ffd2ec" },
  ice: { a: "#69f0ff", b: "#b9d4ff", text: "#f2fcff", glow: "#a5ecff", light: "#8fd8f5", spark: "#e0f6ff" },
};

/* ---------- JS value noise for the static snow-dune displacement ---------- */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const GROUND_Y = -1.5;
const GROUND_Z = -2;
function duneHeight(x: number, z: number): number {
  return vnoise2(x * 0.22 + 5, z * 0.22 + 9) * 0.55 + vnoise2(x * 0.55 + 2, z * 0.55 + 4) * 0.18;
}

function buildGroundGeo(): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(46, 26, 64, 40);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const worldZ = GROUND_Z - pos.getY(i); // mesh is rotated -PI/2 about x
    pos.setZ(i, duneHeight(x, worldZ));
  }
  geo.computeVertexNormals();
  return geo;
}
const groundGeo = buildGroundGeo();

/* ---------- aurora ribbons ---------- */
const RIBBONS = [
  { w: 13, h: 4.6, y: 2.5, z: -4.5, tilt: -0.26, speed: 1.0, scale: 1.0, seed: 2.7, gain: 1.0, swap: false },
  { w: 17, h: 5.4, y: 3.1, z: -7.5, tilt: -0.3, speed: 0.62, scale: 1.55, seed: 7.1, gain: 0.8, swap: true },
  { w: 10, h: 4.0, y: 2.1, z: -3.0, tilt: -0.2, speed: 1.35, scale: 0.72, seed: 12.9, gain: 0.9, swap: false },
];
const ribbonGeos = RIBBONS.map((r) => new THREE.PlaneGeometry(r.w, r.h, 96, 24));

const AURORA_VERT = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uSeed;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  float t = uTime * uSpeed * 0.35 + uSeed;
  float sway = sin(uv.x * 2.4 + t) * 0.8 + sin(uv.x * 5.1 - t * 1.4) * 0.35;
  p.z += sway * (0.25 + 0.75 * uv.y);
  p.x += sin(uv.y * 2.0 + t * 0.8) * 0.3 * uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const AURORA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uBand;
uniform float uSpeed;
uniform float uScale;
uniform float uSeed;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
void main() {
  float t = uTime * uSpeed;
  float x = vUv.x * uScale;
  // 3 octaves of value noise scrolling at different speeds = curtain rays
  float n = vnoise(vec2(x * 6.0 + t * 0.22 + uSeed, t * 0.11)) * 0.55
          + vnoise(vec2(x * 13.0 - t * 0.16 + uSeed * 2.0, 3.7 + t * 0.15)) * 0.30
          + vnoise(vec2(x * 26.0 + t * 0.40 + uSeed * 3.0, 9.1 + t * 0.08)) * 0.15;
  float y = vUv.y;
  float bottom = smoothstep(0.0, 0.07, y);        // soft lower edge
  float fall = pow(1.0 - y, 1.6);                 // fades upward
  float reach = (0.30 + 0.85 * n) * uBand;        // per-column ray height
  float cap = 1.0 - smoothstep(reach - 0.28, reach + 0.06, y);
  float xfade = smoothstep(0.0, 0.10, vUv.x) * (1.0 - smoothstep(0.90, 1.0, vUv.x));
  float band = bottom * fall * cap * xfade;
  vec3 col = mix(uColorA, uColorB, clamp(y * 1.4 + n * 0.5 - 0.3, 0.0, 1.0));
  col += uColorA * pow(1.0 - y, 6.0) * bottom * 0.8;
  float alpha = band * (0.30 + 0.70 * n) * uIntensity;
  gl_FragColor = vec4(col * (0.4 + 0.8 * uIntensity), alpha);
}
`;

function makeAuroraMaterial(
  colorA: THREE.Color,
  colorB: THREE.Color,
  speed: number,
  scale: number,
  seed: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uBand: { value: 0.5 },
      uSpeed: { value: speed },
      uScale: { value: scale },
      uSeed: { value: seed },
      uColorA: { value: colorA },
      uColorB: { value: colorB },
    },
    vertexShader: AURORA_VERT,
    fragmentShader: AURORA_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/* ---------- twinkling points (stars + ground snow sparkle) ---------- */
const TWINKLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uTwinkle;
attribute float aSize;
attribute float aPhase;
attribute float aSpeed;
varying float vA;
void main() {
  float s = 0.5 + 0.5 * sin(uTime * aSpeed + aPhase);
  vA = mix(0.65 + 0.35 * s, 0.06 + pow(s, 8.0), uTwinkle);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const TWINKLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float m = 1.0 - smoothstep(0.1, 0.5, length(d));
  gl_FragColor = vec4(uColor, m * vA * uOpacity);
}
`;

function makeTwinkleMaterial(color: string, twinkle: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uTwinkle: { value: twinkle },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: TWINKLE_VERT,
    fragmentShader: TWINKLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const STAR_COUNT = 320;
function buildStars() {
  const rand = mulberry32(90210);
  const pos = new Float32Array(STAR_COUNT * 3);
  const size = new Float32Array(STAR_COUNT);
  const phase = new Float32Array(STAR_COUNT);
  const speed = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    pos[i * 3] = (rand() * 2 - 1) * 20;
    pos[i * 3 + 1] = 0.8 + Math.pow(rand(), 0.8) * 11.5;
    pos[i * 3 + 2] = -12 - rand() * 5;
    size[i] = 0.1 + rand() * 0.3;
    phase[i] = rand() * Math.PI * 2;
    speed[i] = 0.4 + rand() * 1.2;
  }
  return { pos, size, phase, speed };
}
const STARS = buildStars();

const SPARKLE_COUNT = 250;
function buildSparkles() {
  const rand = mulberry32(31337);
  const pos = new Float32Array(SPARKLE_COUNT * 3);
  const size = new Float32Array(SPARKLE_COUNT);
  const phase = new Float32Array(SPARKLE_COUNT);
  const speed = new Float32Array(SPARKLE_COUNT);
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const x = (rand() * 2 - 1) * 7;
    const z = 4 - rand() * 11;
    pos[i * 3] = x;
    pos[i * 3 + 1] = GROUND_Y + duneHeight(x, z) + 0.03;
    pos[i * 3 + 2] = z;
    size[i] = 0.05 + rand() * 0.08;
    phase[i] = rand() * Math.PI * 2;
    speed[i] = 1.2 + rand() * 2.8;
  }
  return { pos, size, phase, speed };
}
const SPARKLES = buildSparkles();

/* ---------- faint moon ---------- */
const moonTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.9)"],
  [0.25, "rgba(230,240,255,0.45)"],
  [1, "rgba(200,220,255,0)"],
]);

const OPEN_END = 5.1;

export default function AuroraScene({ variants, phase, message, recipientName, lang, onOpenComplete }: SceneProps) {
  const palette = PALETTES[variants.palette] ?? PALETTES.emerald;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // Pause-safe aurora clock: accumulated from frame deltas, never clock.elapsedTime.
  const timeRef = useRef(0);
  const smoothRef = useRef({ intensity: 0.4, band: 0.5, msg: 0, ambient: 0.24 });
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const tintRef = useRef<THREE.PointLight>(null);
  // Per-frame uniform writes go through refs (populated by callback refs below).
  const ribbonMatRefs = useRef<(THREE.ShaderMaterial | null)[]>([]);
  const starMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const sparkMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const textMatRef = useRef<THREE.MeshBasicMaterial | null>(null);

  const ribbonMats = useMemo(() => {
    const a = new THREE.Color(palette.a);
    const b = new THREE.Color(palette.b);
    return RIBBONS.map((r) =>
      makeAuroraMaterial(r.swap ? b.clone() : a.clone(), r.swap ? a.clone() : b.clone(), r.speed, r.scale, r.seed),
    );
  }, [palette]);
  useEffect(() => {
    return () => {
      for (const m of ribbonMats) m.dispose();
    };
  }, [ribbonMats]);

  const starMat = useMemo(() => makeTwinkleMaterial("#cfe0ff", 0.25), []);
  const sparkMat = useMemo(() => makeTwinkleMaterial(palette.spark, 1.0), [palette]);
  useEffect(() => {
    return () => {
      starMat.dispose();
      sparkMat.dispose();
    };
  }, [starMat, sparkMat]);

  const msg = message.trim() || (recipientName.trim() ? forRecipient(lang, recipientName) : "");
  const textPack = useMemo(() => {
    if (!msg) return null;
    const fontSize = 72;
    const { texture, aspect } = makeTextTexture(msg, {
      fontSize,
      fontWeight: "500",
      color: palette.text,
      glow: 16,
      glowColor: palette.glow,
      maxWidthPx: fontSize * (msg.length > 80 ? 16 : 9),
      lang,
    });
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    let w = Math.min(3.0, Math.max(1.4, msg.length * 0.11));
    let h = w * aspect;
    if (h > 2.4) {
      const k = 2.4 / h;
      w *= k;
      h *= k;
    }
    return { material, w, h };
  }, [msg, palette, lang]);
  useEffect(() => {
    if (!textPack) return;
    return () => {
      textPack.material.map?.dispose();
      textPack.material.dispose();
    };
  }, [textPack]);

  useFrame((_state, delta) => {
    const dt = Math.min(delta, 0.05);
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    // Aurora clock speed: preview/sealed drift slowly, opening/revealed dance.
    const clockSpeed = phase === "preview" ? 0.45 : phase === "sealed" ? 0.35 : phase === "opening" ? 0.9 : 0.7;
    timeRef.current += dt * clockSpeed;
    const at = timeRef.current;

    let intensityT: number;
    let bandT: number;
    let msgT: number;
    let ambientT: number;
    if (phase === "preview") {
      intensityT = 0.92 + 0.08 * Math.sin(at * 0.6);
      bandT = 1;
      msgT = 1;
      ambientT = 0.24;
    } else if (phase === "sealed") {
      // Faintest horizon-glow pulse where the aurora will be.
      intensityT = 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(at * 4.5));
      bandT = 0.2;
      msgT = 0;
      ambientT = 0.2;
    } else if (phase === "opening") {
      // 0-1s the sky deepens, 1-4.5s ribbons sweep in and bloom, 4-5s message fades up.
      const ramp = smooth(clamp01((t - 1) / 3.5));
      intensityT = 0.05 + 0.95 * ramp;
      bandT = 0.2 + 0.8 * ramp;
      msgT = smooth(clamp01((t - 4) / 1));
      ambientT = 0.24 - 0.12 * smooth(clamp01(t));
    } else {
      intensityT = 0.88 + 0.12 * Math.sin(at * 0.5);
      bandT = 1;
      msgT = 1;
      ambientT = 0.14;
    }

    const s = smoothRef.current;
    const k = Math.min(1, dt * 3.5);
    s.intensity += (intensityT - s.intensity) * k;
    s.band += (bandT - s.band) * k;
    s.msg += (msgT - s.msg) * k;
    s.ambient += (ambientT - s.ambient) * k;

    for (let i = 0; i < RIBBONS.length; i++) {
      const m = ribbonMatRefs.current[i];
      if (!m) continue;
      m.uniforms.uTime.value = at;
      m.uniforms.uIntensity.value = s.intensity * RIBBONS[i].gain;
      m.uniforms.uBand.value = s.band;
    }

    // Stars shine in the dark, recede as the aurora blooms; sparkles ride the aurora light.
    const sm = starMatRef.current;
    if (sm) {
      sm.uniforms.uTime.value = at;
      sm.uniforms.uOpacity.value = 0.95 - 0.5 * s.intensity;
    }
    const pm = sparkMatRef.current;
    if (pm) {
      pm.uniforms.uTime.value = at;
      pm.uniforms.uOpacity.value = 0.15 + 0.85 * s.intensity;
    }

    const tm = textMatRef.current;
    if (tm) {
      // Message literally glows with the lights: master intensity x slow shimmer (0.75-1).
      const shimmer = 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(at * 1.7) * Math.sin(at * 2.9 + 1.3));
      tm.opacity = s.msg * Math.min(1, s.intensity * 1.15) * shimmer;
    }

    if (ambientRef.current) ambientRef.current.intensity = s.ambient;
    if (tintRef.current) tintRef.current.intensity = s.intensity * 1.5;

    if (phase === "opening" && t > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 1.0, 6.8]}
        fov={52}
        onUpdate={(c) => c.lookAt(0, 1.35, -2)}
      />
      <ambientLight ref={ambientRef} intensity={0.24} color="#5872a8" />
      <directionalLight position={[-3, 6, 3]} intensity={0.5} color="#a9c3ea" />
      {/* Aurora tint spilling onto the snow, follows master intensity. */}
      <pointLight ref={tintRef} position={[0, 2.2, -3.5]} intensity={0} distance={14} color={palette.light} />

      {/* snowfield: near-white dunes kept dark blue by the dim night lighting */}
      <mesh geometry={groundGeo} position={[0, GROUND_Y, GROUND_Z]} rotation={[-Math.PI / 2, 0, 0]}>
        <meshStandardMaterial color="#dbe6f2" roughness={0.96} metalness={0} />
      </mesh>

      {/* starfield */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[STARS.pos, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[STARS.size, 1]} />
          <bufferAttribute attach="attributes-aPhase" args={[STARS.phase, 1]} />
          <bufferAttribute attach="attributes-aSpeed" args={[STARS.speed, 1]} />
        </bufferGeometry>
        <primitive
          object={starMat}
          attach="material"
          ref={(m: THREE.ShaderMaterial | null) => {
            starMatRef.current = m;
          }}
        />
      </points>

      {/* ground-level snow sparkle */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[SPARKLES.pos, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[SPARKLES.size, 1]} />
          <bufferAttribute attach="attributes-aPhase" args={[SPARKLES.phase, 1]} />
          <bufferAttribute attach="attributes-aSpeed" args={[SPARKLES.speed, 1]} />
        </bufferGeometry>
        <primitive
          object={sparkMat}
          attach="material"
          ref={(m: THREE.ShaderMaterial | null) => {
            sparkMatRef.current = m;
          }}
        />
      </points>

      {/* faint moon */}
      <mesh position={[-3.0, 6.6, -13]}>
        <planeGeometry args={[2.6, 2.6]} />
        <meshBasicMaterial
          map={moonTex}
          color="#dfe9ff"
          transparent
          opacity={0.45}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* aurora ribbons: layered curtains tilted back, each with its own drift */}
      {RIBBONS.map((r, i) => (
        <mesh key={i} geometry={ribbonGeos[i]} position={[0, r.y, r.z]} rotation={[r.tilt, 0, 0]}>
          <primitive
            object={ribbonMats[i]}
            attach="material"
            ref={(m: THREE.ShaderMaterial | null) => {
              ribbonMatRefs.current[i] = m;
            }}
          />
        </mesh>
      ))}

      {/* message glowing inside the ribbon band */}
      {textPack && (
        <mesh position={[0, 0.9, -3.6]}>
          <planeGeometry args={[textPack.w, textPack.h]} />
          <primitive
            object={textPack.material}
            attach="material"
            ref={(m: THREE.MeshBasicMaterial | null) => {
              textMatRef.current = m;
            }}
          />
        </mesh>
      )}
    </>
  );
}
