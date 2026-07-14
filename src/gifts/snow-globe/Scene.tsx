import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { forRecipient } from "../../i18n";
import { clamp01, easeOutCubic, mulberry32, smooth } from "../math";

const clampSym = (x: number, m: number) => Math.min(m, Math.max(-m, x));

/* ---------- layout constants ---------- */
const GLOBE_Y = -0.21; // world y of glass sphere center
const GLOBE_R = 0.92;
const GROUND_Y = -0.46; // local (globe-space) y of snow surface
const INNER_R = 0.86; // particles stay inside this radius
const INNER_R2 = INNER_R * INNER_R;
const OPEN_END = 4.0;
const ENERGY_DECAY = Math.LN2 / 1.5; // ~1.5s half-life

/* ---------- palettes keyed by variant value ---------- */
interface ScenePalette {
  primary: string;
  secondary: string;
  accent: string;
  emissive: string;
}
const SCENE_PALETTES: Record<string, ScenePalette> = {
  cabin: { primary: "#8a5a33", secondary: "#54341e", accent: "#ffb45e", emissive: "#160b04" },
  forest: { primary: "#2f7048", secondary: "#1e4d33", accent: "#bfe8c8", emissive: "#04120a" },
  heart: { primary: "#c01840", secondary: "#701026", accent: "#ff89a6", emissive: "#2a040d" },
};

const snowTex = makeRadialSprite(32, [
  [0, "rgba(255,255,255,1)"],
  [0.55, "rgba(255,255,255,0.9)"],
  [1, "rgba(255,255,255,0)"],
]);
const dustTex = makeRadialSprite();

interface ParticleConf {
  color: string;
  size: number;
  fallMul: number;
  twinkle: number;
  additive: boolean;
  orbitMul: number;
  tex: THREE.Texture;
}
const PARTICLE_CONFS: Record<string, ParticleConf> = {
  snow: { color: "#ffffff", size: 0.07, fallMul: 1, twinkle: 0.18, additive: false, orbitMul: 1, tex: snowTex },
  stardust: { color: "#ffd685", size: 0.085, fallMul: 0.42, twinkle: 0.85, additive: true, orbitMul: 0.85, tex: dustTex },
};

/* ---------- procedural geometry (module-level, shared) ---------- */
function buildRoofGeo(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.34, 0);
  shape.lineTo(0.34, 0);
  shape.lineTo(0, 0.28);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.48, bevelEnabled: false });
  geo.translate(0, 0, -0.24);
  return geo;
}
const roofGeo = buildRoofGeo();

function buildHeartGeo(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(25, 25);
  s.bezierCurveTo(25, 25, 20, 0, 0, 0);
  s.bezierCurveTo(-30, 0, -30, 35, -30, 35);
  s.bezierCurveTo(-30, 55, -10, 77, 25, 95);
  s.bezierCurveTo(60, 77, 80, 55, 80, 35);
  s.bezierCurveTo(80, 35, 80, 0, 55, 0);
  s.bezierCurveTo(35, 0, 25, 25, 25, 25);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 14,
    bevelEnabled: true,
    bevelThickness: 4,
    bevelSize: 4,
    bevelSegments: 2,
    steps: 1,
  });
  geo.center();
  geo.rotateZ(Math.PI);
  geo.scale(0.0068, 0.0068, 0.0068);
  return geo;
}
const heartGeo = buildHeartGeo();

const coneGeo = new THREE.ConeGeometry(0.5, 1, 9);

interface Tree {
  x: number;
  z: number;
  h: number;
  d: number;
  alt: boolean;
}
function buildTrees(): Tree[] {
  const rand = mulberry32(5150);
  const trees: Tree[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.8;
    const r = 0.16 + Math.sqrt(rand()) * 0.34;
    const h = 0.3 + rand() * 0.32;
    trees.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, h, d: h * 0.62, alt: i % 2 === 0 });
  }
  return trees;
}
const TREES = buildTrees();

/* ---------- particle field ---------- */
const PARTICLE_COUNT = 700;
interface ParticleData {
  pos: Float32Array;
  aSize: Float32Array;
  aPhase: Float32Array;
  u: Float32Array;
  theta: Float32Array;
  y: Float32Array;
  fall: Float32Array;
  spd: Float32Array;
  lift: Float32Array;
  wobF: Float32Array;
  wobP: Float32Array;
  respawnY: Float32Array;
}
function buildParticles(): ParticleData {
  const rand = mulberry32(90210);
  const n = PARTICLE_COUNT;
  const d: ParticleData = {
    pos: new Float32Array(n * 3),
    aSize: new Float32Array(n),
    aPhase: new Float32Array(n),
    u: new Float32Array(n),
    theta: new Float32Array(n),
    y: new Float32Array(n),
    fall: new Float32Array(n),
    spd: new Float32Array(n),
    lift: new Float32Array(n),
    wobF: new Float32Array(n),
    wobP: new Float32Array(n),
    respawnY: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    d.u[i] = Math.sqrt(rand());
    d.theta[i] = rand() * Math.PI * 2;
    d.y[i] = -0.44 + rand() * 1.26;
    d.fall[i] = 0.16 + rand() * 0.2;
    d.spd[i] = 0.7 + rand() * 0.6;
    d.lift[i] = (rand() - 0.25) * 0.6;
    d.wobF[i] = 0.6 + rand() * 1.4;
    d.wobP[i] = rand() * Math.PI * 2;
    d.aSize[i] = 0.7 + rand() * 0.7;
    d.aPhase[i] = rand();
    d.respawnY[i] = 0.45 + rand() * 0.36;
    const maxR = Math.sqrt(Math.max(0.012, INNER_R2 - d.y[i] * d.y[i]));
    const r = d.u[i] * maxR;
    d.pos[i * 3] = Math.cos(d.theta[i]) * r;
    d.pos[i * 3 + 1] = d.y[i];
    d.pos[i * 3 + 2] = Math.sin(d.theta[i]) * r;
  }
  return d;
}

const PARTICLE_VERT = `
  uniform float uTime;
  uniform float uSize;
  uniform float uScale;
  uniform float uTwinkle;
  attribute float aSize;
  attribute float aPhase;
  varying float vAlpha;
  void main() {
    float tw = 0.5 + 0.5 * sin(uTime * 2.7 + aPhase * 6.2831);
    vAlpha = 1.0 - uTwinkle * (1.0 - tw) * 0.85;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float size = uSize * aSize * mix(1.0, 0.55 + 0.7 * tw, uTwinkle);
    gl_PointSize = size * (uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const PARTICLE_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform sampler2D uMap;
  varying float vAlpha;
  void main() {
    float a = texture2D(uMap, gl_PointCoord).a;
    gl_FragColor = vec4(uColor, a * uOpacity * vAlpha);
  }
`;

/* ---------- variant materials (static per palette; never mutated per frame) ---------- */
interface SceneMats {
  matA: THREE.MeshStandardMaterial;
  matB: THREE.MeshStandardMaterial;
  matSnow: THREE.MeshStandardMaterial;
}
function buildMats(pal: ScenePalette): SceneMats {
  const matA = new THREE.MeshStandardMaterial({
    color: pal.primary,
    emissive: pal.emissive,
    emissiveIntensity: 0.3,
    roughness: 0.6,
    metalness: 0.05,
  });
  const matB = new THREE.MeshStandardMaterial({
    color: pal.secondary,
    emissive: pal.emissive,
    emissiveIntensity: 0.15,
    roughness: 0.7,
    metalness: 0.05,
  });
  const matSnow = new THREE.MeshStandardMaterial({
    color: "#eef4fc",
    roughness: 0.85,
    metalness: 0,
  });
  return { matA, matB, matSnow };
}

export default function SnowGlobeScene({ variants, phase, recipientName, message, lang, onOpenComplete }: SceneProps) {
  const sceneKind = variants.scene in SCENE_PALETTES ? variants.scene : "cabin";
  const pal = SCENE_PALETTES[sceneKind];
  const pconf = PARTICLE_CONFS[variants.particles] ?? PARTICLE_CONFS.snow;

  const mats = useMemo(() => buildMats(pal), [pal]);
  useEffect(() => {
    return () => {
      mats.matA.dispose();
      mats.matB.dispose();
      mats.matSnow.dispose();
    };
  }, [mats]);

  // Particle shader params: r3f rebuilds (and disposes) the material when args change.
  const shaderParams = useMemo(
    (): THREE.ShaderMaterialParameters => ({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: pconf.size },
        uScale: { value: 600 },
        uTwinkle: { value: pconf.twinkle },
        uColor: { value: new THREE.Color(pconf.color) },
        uOpacity: { value: 0 },
        uMap: { value: pconf.tex },
      },
      transparent: true,
      depthWrite: false,
      blending: pconf.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }),
    [pconf],
  );

  const pdata = useMemo(() => buildParticles(), []);

  const plaque = useMemo(() => {
    const text =
      message.trim() ||
      (recipientName.trim()
        ? forRecipient(lang, recipientName)
        : lang === "ar"
          ? "عالمٌ صغير، لك"
          : "A little world, for you");
    return makeTextTexture(text, {
      fontSize: 46,
      fontWeight: "600",
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: "#e9c98f",
      maxWidthPx: 680,
      lineHeight: 1.28,
      padding: 24,
      lang,
    });
  }, [message, recipientName, lang]);
  useEffect(() => {
    return () => {
      plaque.texture.dispose();
    };
  }, [plaque]);
  const plaqueW = Math.min(0.98, 0.3 / plaque.aspect);
  const plaqueH = plaqueW * plaque.aspect;

  const globeRef = useRef<THREE.Group>(null);
  const innerRef = useRef<THREE.Group>(null);
  const miniRef = useRef<THREE.Group>(null);
  const heartRef = useRef<THREE.Mesh>(null);
  const heartMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const glowMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const glassMatRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const shadeRef = useRef<THREE.Mesh>(null);
  const shadeMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const plaqueMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const innerLightRef = useRef<THREE.PointLight>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const pmatRef = useRef<THREE.ShaderMaterial>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // drag-to-shake state
  const energyRef = useRef(0);
  const dirRef = useRef(1);
  const dirCurRef = useRef(1);
  const rockAngRef = useRef(0);
  const rockVelRef = useRef(0);

  const gl = useThree((s) => s.gl);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lastX = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
    };
    const move = (e: PointerEvent) => {
      if (!dragging || phaseRef.current !== "revealed") return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      energyRef.current = Math.min(1.6, energyRef.current + Math.abs(dx) * 0.01);
      if (Math.abs(dx) > 2) dirRef.current = dx > 0 ? 1 : -1;
      rockVelRef.current = clampSym(rockVelRef.current + dx * 0.0025, 1.2);
    };
    const up = () => {
      dragging = false;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const elapsed = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const ot = tRef.current;

    // 0-1.5s of opening: glass + miniature fade/scale in.
    const revealP = phase === "sealed" ? 0 : phase === "opening" ? smooth(clamp01(ot / 1.5)) : 1;
    const dim = 0.1 + 0.9 * revealP;

    // Swirl energy: decays with ~1.5s half-life; opening injects a burst at 1.5s.
    let energy = energyRef.current * Math.exp(-dt * ENERGY_DECAY);
    if (phase === "opening" && ot > 1.5) {
      energy = Math.max(energy, 1.35 * Math.exp(-(ot - 1.5) * ENERGY_DECAY));
    }
    if (phase === "sealed") energy = 0;
    energyRef.current = Math.min(energy, 1.7);

    if (phase === "opening" && ot > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    if (glassMatRef.current) glassMatRef.current.opacity = 0.02 + 0.11 * revealP;

    // Dark shade sphere dims the whole miniature while sealed, fades away as it opens.
    const shadeO = 0.93 * (1 - dim);
    if (shadeMatRef.current) shadeMatRef.current.opacity = shadeO;
    if (shadeRef.current) shadeRef.current.visible = shadeO > 0.004;

    const flicker = 0.9 + 0.08 * Math.sin(elapsed * 6.3) + 0.04 * Math.sin(elapsed * 11.7);
    if (glowMatRef.current) glowMatRef.current.emissiveIntensity = (0.35 + 1.15 * revealP) * flicker;
    if (heartMatRef.current) {
      heartMatRef.current.emissiveIntensity = 0.5 + 0.22 * Math.sin(elapsed * 1.9);
    }

    if (miniRef.current) miniRef.current.scale.setScalar(0.55 + 0.45 * easeOutCubic(revealP));
    if (innerRef.current) {
      innerRef.current.rotation.y += dt * (phase === "preview" ? 0.3 : phase === "sealed" ? 0.05 : 0.12);
    }
    if (heartRef.current) {
      heartRef.current.rotation.y += dt * 0.7;
      heartRef.current.position.y = -0.06 + Math.sin(elapsed * 1.3) * 0.03;
    }

    // Rock spring: drag impulses + a jiggle proportional to swirl energy.
    rockVelRef.current +=
      (-rockAngRef.current * 55 - rockVelRef.current * 6.5) * dt +
      Math.sin(elapsed * 9.3) * energyRef.current * dt * (phase === "opening" ? 0.9 : 0.25);
    rockAngRef.current = clampSym(rockAngRef.current + rockVelRef.current * dt, 0.13);
    if (globeRef.current) globeRef.current.rotation.z = rockAngRef.current;

    dirCurRef.current += (dirRef.current - dirCurRef.current) * Math.min(1, dt * 2.5);

    if (innerLightRef.current) {
      innerLightRef.current.intensity =
        phase === "sealed" ? 0.22 + 0.14 * Math.sin(elapsed * 2.3) : 0.5 + energyRef.current * 0.5 + revealP * 0.25;
    }
    if (plaqueMatRef.current) plaqueMatRef.current.opacity = 0.1 + 0.9 * revealP;

    // Particles: fall + wobble, orbiting the globe axis with swirl energy.
    const uniforms = pmatRef.current?.uniforms;
    if (uniforms) {
      uniforms.uTime.value = elapsed;
      uniforms.uScale.value = state.size.height * state.viewport.dpr * 0.5;
      const targetO = phase === "sealed" ? 0.05 : phase === "preview" ? 0.7 : 0.92;
      uniforms.uOpacity.value += (targetO - uniforms.uOpacity.value) * Math.min(1, dt * 3);
    }

    if (pointsRef.current) {
      const attrs = pointsRef.current.geometry.attributes;
      const posAttr = attrs.position;
      const pos = posAttr.array as Float32Array;
      const theta = attrs.aTheta.array as Float32Array;
      const ys = attrs.aY.array as Float32Array;
      const fallFactor = phase === "sealed" ? 0.12 : phase === "preview" ? 0.6 : 1;
      const orbitSpeed = (0.1 + energyRef.current * 3.4) * pconf.orbitMul * dirCurRef.current;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        theta[i] += dt * orbitSpeed * pdata.spd[i];
        ys[i] += dt * (energyRef.current * pdata.lift[i] - pdata.fall[i] * pconf.fallMul * fallFactor);
        if (ys[i] > 0.84) ys[i] = 0.84;
        if (ys[i] < -0.48) ys[i] = pdata.respawnY[i];
        const maxR = Math.sqrt(Math.max(0.012, INNER_R2 - ys[i] * ys[i]));
        const r = pdata.u[i] * maxR;
        const wp = elapsed * pdata.wobF[i] + pdata.wobP[i];
        pos[i * 3] = Math.cos(theta[i]) * r + Math.sin(wp) * 0.035;
        pos[i * 3 + 1] = ys[i];
        pos[i * 3 + 2] = Math.sin(theta[i]) * r + Math.cos(wp * 0.83) * 0.035;
      }
      posAttr.needsUpdate = true;
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.3, 5.9]}
        fov={44}
        onUpdate={(c) => c.lookAt(0, -0.25, 0)}
      />
      <ambientLight intensity={0.42} />
      <directionalLight position={[3.2, 4.5, 2.6]} intensity={1.15} color="#ffe6cf" />
      <pointLight position={[-2.6, 1.4, -2.2]} intensity={0.45} color="#8fa8dd" />

      {/* dark floor grounding the pedestal */}
      <mesh position={[0, -1.56, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[6, 48]} />
        <meshStandardMaterial color="#0d0a13" roughness={1} />
      </mesh>

      {/* pedestal (static so the plaque always faces the camera) */}
      <group>
        <mesh position={[0, -1.5, 0]}>
          <cylinderGeometry args={[1.02, 1.08, 0.12, 48]} />
          <meshStandardMaterial color="#1c1210" roughness={0.6} metalness={0.15} />
        </mesh>
        <mesh position={[0, -1.2, 0]}>
          <cylinderGeometry args={[0.78, 0.92, 0.5, 48]} />
          <meshStandardMaterial color="#3a2318" roughness={0.55} metalness={0.1} />
        </mesh>
        <mesh position={[0, -0.945, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.78, 0.018, 8, 64]} />
          <meshStandardMaterial color="#c9a24b" roughness={0.3} metalness={0.9} />
        </mesh>
        <mesh position={[0, -0.9, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.62, 0.035, 10, 64]} />
          <meshStandardMaterial color="#c9a24b" roughness={0.35} metalness={0.85} />
        </mesh>

        {/* engraved plaque: gold trim, dark inset, warm text — mounted proud of the pedestal body */}
        <mesh position={[0, -1.2, 0.88]}>
          <boxGeometry args={[1.12, 0.42, 0.14]} />
          <meshStandardMaterial color="#8a6a34" roughness={0.4} metalness={0.7} />
        </mesh>
        <mesh position={[0, -1.2, 0.88]}>
          <boxGeometry args={[1.04, 0.34, 0.08]} />
          <meshStandardMaterial color="#241610" roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[0, -1.2, 0.96]}>
          <planeGeometry args={[plaqueW, plaqueH]} />
          <meshBasicMaterial
            ref={plaqueMatRef}
            map={plaque.texture}
            transparent
            opacity={1}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* globe: rocks around z when shaken */}
      <group ref={globeRef} position={[0, GLOBE_Y, 0]}>
        {/* turntable contents */}
        <group ref={innerRef}>
          {/* snowy ground mound */}
          <mesh position={[0, -0.6, 0]} scale={[1, 0.22, 1]} material={mats.matSnow}>
            <sphereGeometry args={[0.68, 32, 20]} />
          </mesh>

          <group ref={miniRef}>
            {sceneKind === "cabin" && (
              <group rotation={[0, 0.35, 0]}>
                <mesh position={[0, -0.28, 0]} material={mats.matA}>
                  <boxGeometry args={[0.5, 0.34, 0.4]} />
                </mesh>
                <mesh geometry={roofGeo} position={[0, -0.11, 0]} material={mats.matB} />
                {/* snow-capped roof */}
                <mesh position={[-0.183, 0.046, 0]} rotation={[0, 0, 0.689]} material={mats.matSnow}>
                  <boxGeometry args={[0.47, 0.026, 0.53]} />
                </mesh>
                <mesh position={[0.183, 0.046, 0]} rotation={[0, 0, -0.689]} material={mats.matSnow}>
                  <boxGeometry args={[0.47, 0.026, 0.53]} />
                </mesh>
                <mesh position={[0, 0.175, 0]} material={mats.matSnow}>
                  <boxGeometry args={[0.06, 0.03, 0.52]} />
                </mesh>
                {/* chimney */}
                <mesh position={[0.16, 0.02, 0.1]} material={mats.matB}>
                  <boxGeometry args={[0.08, 0.18, 0.08]} />
                </mesh>
                <mesh position={[0.16, 0.12, 0.1]} material={mats.matSnow}>
                  <boxGeometry args={[0.1, 0.03, 0.1]} />
                </mesh>
                {/* door + warm window */}
                <mesh position={[-0.12, -0.37, 0.201]} material={mats.matB}>
                  <boxGeometry args={[0.1, 0.16, 0.02]} />
                </mesh>
                <mesh position={[0.12, -0.3, 0.201]}>
                  <boxGeometry args={[0.12, 0.12, 0.02]} />
                  <meshStandardMaterial
                    ref={glowMatRef}
                    color="#2a1a08"
                    emissive={pal.accent}
                    emissiveIntensity={1.4}
                    roughness={0.5}
                  />
                </mesh>
              </group>
            )}

            {sceneKind === "forest" &&
              TREES.map((tr, i) => (
                <group key={i} position={[tr.x, 0, tr.z]}>
                  <mesh
                    geometry={coneGeo}
                    material={tr.alt ? mats.matA : mats.matB}
                    position={[0, GROUND_Y + tr.h / 2, 0]}
                    scale={[tr.d, tr.h, tr.d]}
                  />
                  <mesh
                    geometry={coneGeo}
                    material={mats.matSnow}
                    position={[0, GROUND_Y + tr.h * 0.85, 0]}
                    scale={[tr.d * 0.42, tr.h * 0.38, tr.d * 0.42]}
                  />
                </group>
              ))}

            {sceneKind === "heart" && (
              <mesh ref={heartRef} geometry={heartGeo} position={[0, -0.06, 0]}>
                <meshStandardMaterial
                  ref={heartMatRef}
                  color={pal.primary}
                  emissive={pal.emissive}
                  emissiveIntensity={0.5}
                  roughness={0.45}
                  metalness={0.15}
                />
              </mesh>
            )}
          </group>
        </group>

        {/* snow / stardust (aTheta / aY carry per-particle sim state) */}
        <points ref={pointsRef} renderOrder={5} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[pdata.pos, 3]} />
            <bufferAttribute attach="attributes-aSize" args={[pdata.aSize, 1]} />
            <bufferAttribute attach="attributes-aPhase" args={[pdata.aPhase, 1]} />
            <bufferAttribute attach="attributes-aTheta" args={[pdata.theta, 1]} />
            <bufferAttribute attach="attributes-aY" args={[pdata.y, 1]} />
          </bufferGeometry>
          <shaderMaterial ref={pmatRef} args={[shaderParams]} />
        </points>

        <pointLight ref={innerLightRef} position={[0, 0.1, 0.25]} intensity={0.4} distance={3.5} color="#ffd9a6" />

        {/* sealed-state shade: darkens everything inside the globe */}
        <mesh ref={shadeRef} renderOrder={8}>
          <sphereGeometry args={[0.9, 32, 24]} />
          <meshBasicMaterial ref={shadeMatRef} color="#0d0a13" transparent opacity={0.84} depthWrite={false} />
        </mesh>

        {/* glass */}
        <mesh renderOrder={10}>
          <sphereGeometry args={[GLOBE_R, 48, 32]} />
          <meshPhysicalMaterial
            ref={glassMatRef}
            color="#cfe4ef"
            transparent
            opacity={0.02}
            roughness={0.05}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.08}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      </group>
    </>
  );
}
