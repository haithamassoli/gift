import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";

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
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ---------- world layout constants ---------- */
const SEA_W = 22;
const SEA_D = 13;
const SEA_SEG = 40;
const SEA_Y = -1.15; // waterline (bottle floats here)
const SEA_Z = -3.5; // sea plane center in depth
const SAND_TOP = -1.4; // bottle base rests here ashore
const ANCHOR_Y = 0.02; // scroll bottom emerges at the neck top
const ANCHOR_Z = 0.06;
const CORK_Y = 1.47; // cork local y when seated on the neck
const CORK_REST: [number, number, number] = [0.86, 0.08, 0.72];
const NECK_LOCAL: [number, number, number] = [0, 1.42, 0];
const GLINT_COUNT = 130;
const DROPLETS = 8;
const OPEN_DONE = 5.0;

/* seasurface wave — evaluated on sea-local (xl,yl); world y = SEA_Y + wave */
function waveHeight(xl: number, yl: number, t: number): number {
  return (
    0.09 * Math.sin(xl * 1.1 + t * 1.2) +
    0.06 * Math.sin(yl * 1.5 - t * 0.9 + xl * 0.4) +
    0.035 * Math.sin((xl + yl) * 2.2 + t * 1.9)
  );
}

/* ---------- shared round sprite for glints + droplets ---------- */
const sprite = makeRadialSprite();

/* ---------- palettes keyed on the `time` variant ---------- */
interface SkySun {
  y: number;
  rFrac: number;
  color: string;
}
interface Palette {
  ambient: string;
  ambientI: number;
  key: string;
  keyI: number;
  keyPos: [number, number, number];
  fill: string;
  fillI: number;
  fillPos: [number, number, number];
  warm: string;
  warmI: number;
  warmPos: [number, number, number];
  sea: string;
  seaEmissive: string;
  seaEmissiveI: number;
  sand: string;
  glint: string;
  glass: string;
  skyStops: [number, string][];
  sun: SkySun;
}

const PALETTES: Record<string, Palette> = {
  sunset: {
    ambient: "#4a3a6a",
    ambientI: 0.5,
    key: "#ff8a4a",
    keyI: 1.55,
    keyPos: [-3, 2.2, -3.5],
    fill: "#7a4fae",
    fillI: 0.5,
    fillPos: [3, 1, -2],
    warm: "#ffb070",
    warmI: 0.85,
    warmPos: [1.2, 0.4, 2],
    sea: "#3a2b3f",
    seaEmissive: "#4a2c1a",
    seaEmissiveI: 0.25,
    sand: "#c8a26a",
    glint: "#ffd9a0",
    glass: "#bfe0e0",
    skyStops: [
      [0, "#20143a"],
      [0.4, "#5a2f5e"],
      [0.6, "#b8532f"],
      [0.68, "#e8863c"],
      [0.8, "#f6b268"],
      [1, "#7a3f2a"],
    ],
    sun: { y: 0.66, rFrac: 0.55, color: "#ffd08a" },
  },
  night: {
    ambient: "#20304f",
    ambientI: 0.4,
    key: "#acc4ff",
    keyI: 0.95,
    keyPos: [2, 4, -2],
    fill: "#3a5a9a",
    fillI: 0.45,
    fillPos: [-3, 1.5, -3],
    warm: "#8fb0ff",
    warmI: 0.4,
    warmPos: [1, 0.4, 2],
    sea: "#0c1a30",
    seaEmissive: "#12305a",
    seaEmissiveI: 0.2,
    sand: "#5a5f70",
    glint: "#dfeaff",
    glass: "#cfe6f0",
    skyStops: [
      [0, "#04081a"],
      [0.4, "#0a1430"],
      [0.62, "#1a2c52"],
      [0.72, "#2c477a"],
      [0.85, "#20365c"],
      [1, "#0e1b34"],
    ],
    sun: { y: 0.24, rFrac: 0.12, color: "#eef3ff" },
  },
  dawn: {
    ambient: "#7a6a8a",
    ambientI: 0.55,
    key: "#ffd28a",
    keyI: 1.3,
    keyPos: [-2.5, 2, -3.5],
    fill: "#e89ab0",
    fillI: 0.5,
    fillPos: [3, 1.5, -2],
    warm: "#ffd9a8",
    warmI: 0.7,
    warmPos: [1.2, 0.5, 2],
    sea: "#2a4048",
    seaEmissive: "#c98a5a",
    seaEmissiveI: 0.2,
    sand: "#e0c69a",
    glint: "#ffe6c0",
    glass: "#d6ecec",
    skyStops: [
      [0, "#3a4a7e"],
      [0.4, "#9a6f9e"],
      [0.58, "#e79a86"],
      [0.68, "#f6c07a"],
      [0.8, "#ffe3b4"],
      [1, "#e8b98a"],
    ],
    sun: { y: 0.66, rFrac: 0.5, color: "#fff0c8" },
  },
};

/* soft vertical sky gradient with a sun/moon glow, per variant */
function makeSkyTexture(stops: [number, string][], sun: SkySun): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const sx = w * 0.5;
  const sy = h * sun.y;
  const r = w * sun.rFrac;
  const rg = g.createRadialGradient(sx, sy, 0, sx, sy, r);
  rg.addColorStop(0, sun.color);
  rg.addColorStop(0.35, sun.color);
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.globalCompositeOperation = "lighter";
  g.fillStyle = rg;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export default function MessageBottleScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const P = PALETTES[variants.time] ?? PALETTES.sunset;

  /* ----- variant-keyed materials + sky texture (rebuilt on `time` change) ----- */
  const mats = useMemo(() => {
    const sky = makeSkyTexture(P.skyStops, P.sun);
    return {
      sky,
      skyMat: new THREE.MeshBasicMaterial({
        map: sky,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      seaMat: new THREE.MeshStandardMaterial({
        color: P.sea,
        roughness: 0.35,
        metalness: 0.15,
        emissive: P.seaEmissive,
        emissiveIntensity: P.seaEmissiveI,
      }),
      sandMat: new THREE.MeshStandardMaterial({ color: P.sand, roughness: 0.95, metalness: 0 }),
      glassMat: new THREE.MeshPhysicalMaterial({
        color: P.glass,
        transparent: true,
        opacity: 0.26,
        roughness: 0.08,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      glintMat: new THREE.PointsMaterial({
        map: sprite,
        color: P.glint,
        size: 0.13,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
  }, [P]);

  useEffect(() => {
    return () => {
      mats.sky.dispose();
      mats.skyMat.dispose();
      mats.seaMat.dispose();
      mats.sandMat.dispose();
      mats.glassMat.dispose();
      mats.glintMat.dispose();
    };
  }, [mats]);

  /* ----- parchment: text texture + rollable plane geometry ----- */
  const parch = useMemo(() => {
    const lines: string[] = [];
    const rn = recipientName.trim();
    const sn = senderName.trim();
    const msg =
      message.trim() || (lang === "ar" ? "أفكّر فيك دائمًا." : "Thinking of you, always.");
    if (rn) lines.push(lang === "ar" ? `عزيزي ${rn}،` : `Dear ${rn},`);
    lines.push(msg);
    if (sn) lines.push(`— ${sn}`);
    const { texture, aspect } = makeTextTexture(lines.join("\n\n"), {
      fontSize: 54,
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "400",
      color: "#4a3212",
      maxWidthPx: 860,
      lineHeight: 1.4,
      padding: 60,
      lang,
    });
    const W = 1.7;
    const H = W * aspect;
    const geo = new THREE.PlaneGeometry(W, H, 2, 48);
    const posAttr = geo.attributes.position;
    const n = posAttr.count;
    const xBase = new Float32Array(n);
    const vBase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xBase[i] = posAttr.getX(i);
      vBase[i] = (posAttr.getY(i) + H / 2) / H; // 0 at bottom edge, 1 at top edge
    }
    return { texture, geo, xBase, vBase, L: H, R: 0.11, fitScale: Math.min(1, 2.35 / H) };
  }, [message, senderName, recipientName, lang]);

  useEffect(() => {
    return () => {
      parch.texture.dispose();
      parch.geo.dispose();
    };
  }, [parch]);

  const parchMats = useMemo(
    () => ({
      sheet: new THREE.MeshBasicMaterial({
        color: "#efdcae",
        side: THREE.DoubleSide,
      }),
      ink: new THREE.MeshBasicMaterial({
        map: parch.texture,
        transparent: true,
        side: THREE.FrontSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        toneMapped: false,
      }),
    }),
    [parch],
  );

  useEffect(() => {
    return () => {
      parchMats.sheet.dispose();
      parchMats.ink.dispose();
    };
  }, [parchMats]);

  /* ----- sea glints ----- */
  const glints = useMemo(() => {
    const rand = mulberry32(9137);
    const pos = new Float32Array(GLINT_COUNT * 3);
    const bx = new Float32Array(GLINT_COUNT);
    const bz = new Float32Array(GLINT_COUNT);
    for (let i = 0; i < GLINT_COUNT; i++) {
      const gx = (rand() * 2 - 1) * 9;
      const gz = SEA_Z + (rand() * 2 - 1) * 5;
      bx[i] = gx;
      bz[i] = gz;
      pos[i * 3] = gx;
      pos[i * 3 + 1] = SEA_Y;
      pos[i * 3 + 2] = gz;
    }
    return { pos, bx, bz };
  }, []);

  /* ----- cork-pop droplet spray ----- */
  const dvel = useMemo(() => {
    const rand = mulberry32(4242);
    const out: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < DROPLETS; i++) {
      const a = (i / DROPLETS) * Math.PI * 2 + rand() * 0.5;
      const spd = 0.6 + rand() * 0.5;
      out.push({ x: Math.cos(a) * spd, y: 1.8 + rand() * 1.3, z: Math.sin(a) * spd });
    }
    return out;
  }, []);
  const dropPos = useMemo(() => {
    const arr = new Float32Array(DROPLETS * 3);
    for (let i = 0; i < DROPLETS; i++) {
      arr[i * 3] = NECK_LOCAL[0];
      arr[i * 3 + 1] = NECK_LOCAL[1];
      arr[i * 3 + 2] = NECK_LOCAL[2];
    }
    return arr;
  }, []);

  /* ----- refs ----- */
  const seaRef = useRef<THREE.Mesh>(null);
  const bottleRef = useRef<THREE.Group>(null);
  const corkRef = useRef<THREE.Group>(null);
  const insideRef = useRef<THREE.Mesh>(null);
  const parchSheetRef = useRef<THREE.Mesh>(null);
  const dropletsRef = useRef<THREE.Points>(null);
  const dropletMatRef = useRef<THREE.PointsMaterial>(null);
  const glintsRef = useRef<THREE.Points>(null);
  const parchGroupRef = useRef<THREE.Group>(null);
  const glintSpriteMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const warmRef = useRef<THREE.PointLight>(null);
  const frameRef = useRef(0);
  const lastRollRef = useRef(-1);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const el = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    /* --- sea surface waves --- */
    // ponytail: vertex + normal updates throttled (waves 30Hz, normals 15Hz) —
    // computeVertexNormals over 1.7k verts is the priciest per-frame op here.
    const sea = seaRef.current;
    if (sea) {
      frameRef.current++;
      if (frameRef.current % 2 === 0) {
        const sp = sea.geometry.attributes.position;
        for (let i = 0; i < sp.count; i++) {
          sp.setZ(i, waveHeight(sp.getX(i), sp.getY(i), el));
        }
        sp.needsUpdate = true;
        if (frameRef.current % 4 === 0) sea.geometry.computeVertexNormals();
      }
    }

    /* --- glints ride the swell + twinkle --- */
    if (glintsRef.current) {
      const ga = glintsRef.current.geometry.attributes.position;
      for (let i = 0; i < GLINT_COUNT; i++) {
        ga.setY(i, SEA_Y + waveHeight(glints.bx[i], SEA_Z - glints.bz[i], el) + 0.015);
      }
      ga.needsUpdate = true;
      (glintsRef.current.material as THREE.PointsMaterial).opacity =
        0.22 + Math.sin(el * 1.5) * 0.1;
    }

    /* --- bottle pose --- */
    const b = bottleRef.current;
    if (b) {
      if (phase === "sealed") {
        const bob = Math.sin(el * 0.9) * 0.05;
        const drift = Math.sin(el * 0.25) * 0.25;
        b.position.set(-0.4 + drift, SEA_Y + 0.02 + bob, -2.6);
        b.rotation.set(0.1 + Math.sin(el * 0.7) * 0.04, 0.5, 0.85 + Math.sin(el * 0.8) * 0.05);
      } else if (phase === "opening" && t < 2.0) {
        const a = smooth(clamp01(t / 2.0));
        const hump = Math.sin(a * Math.PI) * 0.22;
        b.position.set(lerp(-0.4, 0, a), lerp(SEA_Y + 0.02, SAND_TOP, a) + hump, lerp(-2.6, 0, a));
        b.rotation.set(lerp(0.1, 0, a), lerp(0.5, 0.22, a), lerp(0.85, 0.04, a));
      } else {
        b.position.set(0, SAND_TOP + Math.sin(el * 0.8) * 0.004, 0);
        b.rotation.set(0, 0.22, 0.04);
      }
    }

    /* --- cork: seated, popping, or resting on the sand --- */
    const c = corkRef.current;
    if (c) {
      const seated = phase === "sealed" || (phase === "opening" && t < 2.0);
      if (seated) {
        c.position.set(0, CORK_Y, 0);
        c.rotation.set(0, 0, 0);
      } else if (phase === "opening" && t < 2.6) {
        const raw = clamp01((t - 2.0) / 0.6);
        const tc = smooth(raw);
        const hump = Math.sin(raw * Math.PI) * 0.9;
        c.position.set(
          lerp(0, CORK_REST[0], tc),
          lerp(CORK_Y, CORK_REST[1], tc) + hump,
          lerp(0, CORK_REST[2], tc),
        );
        c.rotation.set(tc * 8, tc * 3, tc * 5);
      } else {
        c.position.set(CORK_REST[0], CORK_REST[1], CORK_REST[2]);
        c.rotation.set(1.4, 0.5, 0.3);
      }
    }

    /* --- droplet spray on the pop --- */
    const d = dropletsRef.current;
    if (d && dropletMatRef.current) {
      const active = phase === "opening" && t >= 2.0 && t < 2.9;
      d.visible = active;
      if (active) {
        const ts = t - 2.0;
        const da = d.geometry.attributes.position;
        for (let i = 0; i < DROPLETS; i++) {
          da.setXYZ(
            i,
            NECK_LOCAL[0] + dvel[i].x * ts,
            NECK_LOCAL[1] + dvel[i].y * ts - 4.9 * ts * ts,
            NECK_LOCAL[2] + dvel[i].z * ts,
          );
        }
        da.needsUpdate = true;
        dropletMatRef.current.opacity = clamp01(1 - ts / 0.9);
      }
    }

    /* --- rolled parchment inside the bottle (only while still inside) --- */
    if (insideRef.current) {
      insideRef.current.visible = phase === "sealed" || (phase === "opening" && t < 2.6);
    }

    /* --- emerged scroll: rise + unroll, then float --- */
    let p = 1;
    let show = true;
    let riseY = 0;
    let pscale = parch.fitScale;
    let floatY = 0;
    let tiltZ = 0;
    if (phase === "sealed") {
      show = false;
    } else if (phase === "opening") {
      if (t < 2.6) {
        show = false;
      } else {
        const rise = smooth(clamp01((t - 2.6) / 0.7));
        p = smooth(clamp01((t - 3.0) / 1.6));
        pscale = parch.fitScale * (0.2 + 0.8 * rise);
        riseY = -(1 - rise) * 0.4;
      }
    } else {
      floatY = Math.sin(el * 0.7) * 0.03;
      tiltZ = Math.sin(el * 0.5) * 0.02;
    }
    const pg = parchGroupRef.current;
    if (pg) {
      pg.visible = show;
      pg.position.set(0, ANCHOR_Y + riseY + floatY, ANCHOR_Z);
      pg.scale.setScalar(pscale);
      pg.rotation.z = tiltZ;
    }
    const pgeo = parchSheetRef.current?.geometry;
    // Only reshape while the roll progress actually changes; the sheet is
    // unlit (MeshBasicMaterial) so normals never need recomputing.
    if (show && pgeo && p !== lastRollRef.current) {
      lastRollRef.current = p;
      const pa = pgeo.attributes.position;
      const L = parch.L;
      const R = parch.R;
      for (let i = 0; i < parch.xBase.length; i++) {
        const x = parch.xBase[i];
        const v = parch.vBase[i];
        if (v <= p) {
          pa.setXYZ(i, x, v * L, 0);
        } else {
          const th = ((v - p) * L) / R;
          pa.setXYZ(i, x, p * L + R * Math.sin(th), R * (Math.cos(th) - 1));
        }
      }
      pa.needsUpdate = true;
    }

    /* --- warm light pulse + glass glint pulse --- */
    if (warmRef.current) {
      warmRef.current.intensity =
        phase === "sealed" ? P.warmI * (0.7 + 0.3 * Math.sin(el * 2.0)) : P.warmI;
    }
    if (glintSpriteMatRef.current) {
      const base = phase === "sealed" ? 0.5 : phase === "preview" ? 0.32 : 0.24;
      const pulse =
        phase === "sealed"
          ? 0.5 + 0.5 * Math.sin(el * 2.2)
          : 0.6 + 0.4 * Math.sin(el * 1.3);
      glintSpriteMatRef.current.opacity = base * pulse;
    }

    /* --- fire completion once --- */
    if (phase === "opening" && t > OPEN_DONE && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.6, 6.8]}
        fov={40}
        onUpdate={(c) => c.lookAt(0, 0.25, -0.3)}
      />
      <ambientLight color={P.ambient} intensity={P.ambientI} />
      <directionalLight color={P.key} intensity={P.keyI} position={P.keyPos} />
      <pointLight color={P.fill} intensity={P.fillI} position={P.fillPos} />
      <pointLight ref={warmRef} color={P.warm} intensity={P.warmI} position={P.warmPos} />

      {/* sky gradient backdrop */}
      <mesh position={[0, 2, -9.6]} material={mats.skyMat} renderOrder={-10}>
        <planeGeometry args={[40, 26]} />
      </mesh>

      {/* sea */}
      <mesh
        ref={seaRef}
        material={mats.seaMat}
        position={[0, SEA_Y, SEA_Z]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[SEA_W, SEA_D, SEA_SEG, SEA_SEG]} />
      </mesh>

      {/* sea glints */}
      <points ref={glintsRef} material={mats.glintMat}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[glints.pos, 3]} />
        </bufferGeometry>
      </points>

      {/* sand strip (slight slope toward the water) */}
      <mesh position={[0, SAND_TOP, 2]} rotation={[-Math.PI / 2 + 0.05, 0, 0]} material={mats.sandMat}>
        <planeGeometry args={[20, 7, 1, 1]} />
      </mesh>

      {/* emerged, unrolling scroll — floats above the bottle facing camera */}
      <group ref={parchGroupRef}>
        <mesh ref={parchSheetRef} geometry={parch.geo} material={parchMats.sheet} />
        <mesh geometry={parch.geo} material={parchMats.ink} renderOrder={2} />
      </group>

      {/* bottle (origin at its base) */}
      <group ref={bottleRef}>
        {/* rolled parchment sealed inside the glass */}
        <mesh ref={insideRef} position={[0, 0.42, 0]} rotation={[0, 0, 0.16]}>
          <cylinderGeometry args={[0.16, 0.16, 0.55, 14]} />
          <meshStandardMaterial color="#e6d3a0" roughness={0.9} metalness={0} />
        </mesh>

        {/* glass body */}
        <mesh position={[0, 0.45, 0]} material={mats.glassMat} renderOrder={5}>
          <cylinderGeometry args={[0.27, 0.3, 0.9, 24]} />
        </mesh>
        {/* shoulder */}
        <mesh position={[0, 1.01, 0]} material={mats.glassMat} renderOrder={5}>
          <cylinderGeometry args={[0.1, 0.27, 0.22, 24]} />
        </mesh>
        {/* neck */}
        <mesh position={[0, 1.26, 0]} material={mats.glassMat} renderOrder={5}>
          <cylinderGeometry args={[0.1, 0.1, 0.28, 20]} />
        </mesh>
        {/* lip */}
        <mesh position={[0, 1.41, 0]} material={mats.glassMat} renderOrder={5}>
          <cylinderGeometry args={[0.115, 0.1, 0.05, 20]} />
        </mesh>

        {/* cork */}
        <group ref={corkRef}>
          <mesh>
            <cylinderGeometry args={[0.088, 0.095, 0.14, 16]} />
            <meshStandardMaterial color="#a9702f" roughness={0.9} metalness={0} />
          </mesh>
        </group>

        {/* cork-pop droplet spray */}
        <points ref={dropletsRef} visible={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[dropPos, 3]} />
          </bufferGeometry>
          <pointsMaterial
            ref={dropletMatRef}
            map={sprite}
            color={P.glint}
            size={0.09}
            sizeAttenuation
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>

        {/* glass glint (inviting pulse) */}
        <mesh position={[0.11, 0.55, 0.27]} renderOrder={6}>
          <planeGeometry args={[0.34, 0.5]} />
          <meshBasicMaterial
            ref={glintSpriteMatRef}
            map={sprite}
            color="#ffffff"
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      </group>
    </>
  );
}
