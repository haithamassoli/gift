import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeTextTexture, type TextTexture } from "../text3d";
import { makeRadialSprite } from "../sprites";
import { clamp01, easeInOut, mulberry32, smooth } from "../math";

/* ---------- palettes (keyed on the `color` variant value) ---------- */
interface Palette {
  paper: string;
  emissive: string;
  glow: string;
  light: string;
  star: string;
  horizon: string; // "r,g,b" for the horizon glow gradient
}
const PALETTES: Record<string, Palette> = {
  amber: { paper: "#7a3f12", emissive: "#ff9a2e", glow: "#ffb454", light: "#ffcaa0", star: "#fff2d6", horizon: "255,150,60" },
  crimson: { paper: "#6e1826", emissive: "#ff3b52", glow: "#ff6b78", light: "#ff9aa2", star: "#ffe0e0", horizon: "255,70,90" },
  jade: { paper: "#0f5a3e", emissive: "#25d98c", glow: "#5ff0b4", light: "#a8ffdc", star: "#d8fff0", horizon: "60,220,150" },
};

/* ---------- shared geometry (module level, never per-render) ---------- */
// Low-poly paper lantern: hexagonal, slightly barrel-shaped lathe.
function buildLanternGeo(): THREE.BufferGeometry {
  const profile = [
    new THREE.Vector2(0.03, -0.52),
    new THREE.Vector2(0.17, -0.46),
    new THREE.Vector2(0.24, -0.24),
    new THREE.Vector2(0.26, 0.0),
    new THREE.Vector2(0.23, 0.24),
    new THREE.Vector2(0.15, 0.46),
    new THREE.Vector2(0.05, 0.52),
  ];
  const geo = new THREE.LatheGeometry(profile, 6);
  geo.computeVertexNormals();
  return geo;
}
const lanternGeo = buildLanternGeo();
const capGeo = new THREE.CylinderGeometry(0.05, 0.075, 0.05, 6);
const stringGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.13, 4);
const hillGeo = new THREE.SphereGeometry(1, 18, 12);
const glowSprite = makeRadialSprite(64);

const LANTERN_SCALE = 0.34;
const BODY_TOP = 0.52 * LANTERN_SCALE; //  0.177
const STRING_Y = -0.24;
const CAP_Y = BODY_TOP + 0.02;
const GLOW_SCALE = 0.74;
const BASE_EMISSIVE = 1.6;
const IGNITE_RAMP = 0.55;

/* ---------- opening timeline ---------- */
const RISE_START = 1.0;
const RISE_STAGGER = 0.13;
const RISE_DUR = 2.3;
const IGNITE_STAGGER = 0.15;

/* ---------- formation layout ---------- */
const SPACING = 0.55;
const ROW_GAP = 0.74;
const CENTER_Y = 0.72;
const GROUND_Y = -2.9;

interface Slot {
  x: number;
  y: number;
  z: number;
}
interface Plan {
  slots: Slot[];
  starts: Slot[];
  phase: number[];
  igniteAt: number[];
  riseAt: number[];
  end: number;
}

function planFormation(n: number, wordStart: boolean[]): Plan {
  // Group units into whole-word runs so rows never break mid-word, and leave a
  // small extra gap between words. Falls back to an even split for giant words.
  const wordLens: number[] = [];
  let len = 0;
  for (let i = 0; i < n; i++) {
    if (wordStart[i] && len > 0) {
      wordLens.push(len);
      len = 0;
    }
    len++;
  }
  if (len > 0) wordLens.push(len);

  const target = Math.max(6, Math.ceil(n / 3));
  let rowsWords: number[][] = [[]];
  let cur = 0;
  for (const wl of wordLens) {
    if (cur > 0 && cur + wl > target) {
      rowsWords.push([]);
      cur = 0;
    }
    rowsWords[rowsWords.length - 1].push(wl);
    cur += wl;
  }
  if (rowsWords.length > 3 || wordLens.some((wl) => wl > 9)) {
    // ponytail: fallback to the plain even split when word-aware packing can't fit
    const rows = Math.min(3, Math.max(1, Math.ceil(n / 6)));
    const base = Math.floor(n / rows);
    let extra = n % rows;
    rowsWords = [];
    for (let r = 0; r < rows; r++) {
      rowsWords.push([base + (extra > 0 ? 1 : 0)]);
      if (extra > 0) extra--;
    }
  }

  const rand = mulberry32(48271);
  const slots: Slot[] = [];
  const rows = rowsWords.length;
  const WORD_GAP = SPACING * 0.45;
  for (let r = 0; r < rows; r++) {
    const lens = rowsWords[r];
    const count = lens.reduce((a, b) => a + b, 0);
    const width = (count - 1) * SPACING + (lens.length - 1) * WORD_GAP;
    const y = CENTER_Y + ((rows - 1) / 2 - r) * ROW_GAP;
    let x = -width / 2;
    for (let wi = 0; wi < lens.length; wi++) {
      if (wi > 0) x += WORD_GAP;
      for (let j = 0; j < lens[wi]; j++) {
        slots.push({ x, y, z: (rand() - 0.5) * 0.4 });
        x += SPACING;
      }
    }
  }
  const starts: Slot[] = slots.map((s) => ({
    x: s.x * 0.25 + (rand() - 0.5) * 0.5,
    y: GROUND_Y + (rand() - 0.5) * 0.28,
    z: s.z * 0.5 + (rand() - 0.5) * 0.3 - 0.2,
  }));
  const phase = slots.map(() => rand() * Math.PI * 2);
  const igniteAt = slots.map((_, i) => 0.15 + i * IGNITE_STAGGER);
  const riseAt = slots.map((_, i) => RISE_START + i * RISE_STAGGER);
  const end = RISE_START + Math.max(0, n - 1) * RISE_STAGGER + RISE_DUR + 0.35;
  return { slots, starts, phase, igniteAt, riseAt, end };
}

/* ---------- message → tag units ---------- */
function splitUnits(
  message: string,
  recipientName: string,
): { units: string[]; wordStart: boolean[] } {
  const msg = message.trim();
  let raw: string[];
  let wordStart: boolean[];
  let joiner: string;
  if (!msg) {
    raw = Array.from(recipientName.replace(/\s+/g, ""));
    if (raw.length === 0) raw = ["♥"];
    wordStart = raw.map((_, i) => i === 0);
    joiner = "";
  } else {
    const nonSpace = msg.replace(/\s/g, "").length;
    if (nonSpace <= 22) {
      raw = [];
      wordStart = [];
      for (const word of msg.split(/\s+/).filter(Boolean)) {
        Array.from(word).forEach((ch, i) => {
          raw.push(ch);
          wordStart.push(i === 0);
        });
      }
      joiner = "";
    } else {
      raw = msg.split(/\s+/).filter(Boolean);
      wordStart = raw.map(() => true);
      joiner = " ";
    }
  }
  if (raw.length > 18) {
    const head = raw.slice(0, 17);
    const tail = raw.slice(17).join(joiner);
    raw = [...head, tail];
    wordStart = wordStart.slice(0, 17);
    wordStart.push(true);
  }
  return { units: raw, wordStart };
}

/* ---------- background lanterns (recycled, drift up far away) ---------- */
const BG_COUNT = 5;
const BG_CYCLE = 12;
const BG_Y0 = -3.4;
const BG_SPAN = 10;
interface BgDatum {
  x: number;
  z: number;
  offset: number;
  phase: number;
  scale: number;
}
function buildBgData(): BgDatum[] {
  const rand = mulberry32(77003);
  return Array.from({ length: BG_COUNT }, () => ({
    x: (rand() - 0.5) * 6.5,
    z: -3.2 - rand() * 2.8,
    offset: rand() * BG_CYCLE,
    phase: rand() * Math.PI * 2,
    scale: 0.2 + rand() * 0.09,
  }));
}

/* ---------- starfield ---------- */
const STAR_COUNT = 460;
function buildStars(): Float32Array {
  const rand = mulberry32(13331);
  const pos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    pos[i * 3] = (rand() - 0.5) * 26;
    pos[i * 3 + 1] = -1.5 + rand() * 11.5;
    pos[i * 3 + 2] = -7 + rand() * 5;
  }
  return pos;
}

/* ---------- night-sky backdrop gradient (variant-tinted horizon glow) ---------- */
function buildSkyTexture(horizonRgb: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d")!;
  const lin = g.createLinearGradient(0, 0, 0, 256);
  lin.addColorStop(0, "#050409");
  lin.addColorStop(0.45, "#0a0814");
  lin.addColorStop(0.8, "#0d0a18");
  lin.addColorStop(1, "#110c17");
  g.fillStyle = lin;
  g.fillRect(0, 0, 64, 256);
  const rad = g.createRadialGradient(32, 158, 0, 32, 158, 120);
  rad.addColorStop(0, `rgba(${horizonRgb},0.32)`);
  rad.addColorStop(0.5, `rgba(${horizonRgb},0.11)`);
  rad.addColorStop(1, `rgba(${horizonRgb},0)`);
  g.fillStyle = rad;
  g.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

interface TagInfo {
  texture: THREE.CanvasTexture;
  w: number;
  h: number;
}

export default function LanternSkyScene({ variants, phase, recipientName, message, lang, onOpenComplete }: SceneProps) {
  const palette = PALETTES[variants.color] ?? PALETTES.amber;

  const { units, wordStart } = useMemo(
    () => splitUnits(message, recipientName),
    [message, recipientName],
  );
  const plan = useMemo(() => planFormation(units.length, wordStart), [units, wordStart]);
  const bgData = useMemo(() => buildBgData(), []);
  const starPos = useMemo(() => buildStars(), []);

  /* per-unit tag textures, cached by string (repeated letters share one) */
  const tagData = useMemo(() => {
    const cache = new Map<string, TextTexture>();
    const list: TagInfo[] = units.map((u) => {
      let t = cache.get(u);
      if (!t) {
        t = makeTextTexture(u, {
          fontSize: 128,
          fontWeight: "800",
          color: "#fff3da",
          glow: 10,
          glowColor: "#ffdca6",
          lineHeight: 1.0,
          padding: 16,
          lang,
        });
        cache.set(u, t);
      }
      const tagH0 = 0.26;
      let w = tagH0 / t.aspect;
      let h = tagH0;
      if (w > 0.66) {
        h = (0.66 / w) * tagH0;
        w = 0.66;
      }
      return { texture: t.texture, w, h };
    });
    return { list, textures: [...cache.values()] };
  }, [units, lang]);
  useEffect(() => {
    const captured = tagData.textures;
    return () => captured.forEach((t) => t.texture.dispose());
  }, [tagData]);

  // The variant backdrop is a useMemo material (never mutated per-frame) so it
  // rebuilds on palette change and is disposed on cleanup. Per-lantern materials
  // are declared in JSX (see below): their palette-derived props update live and
  // R3F disposes them on unmount — they're mutated per-frame only through refs.
  const skyMat = useMemo(() => {
    const tex = buildSkyTexture(palette.horizon);
    return new THREE.MeshBasicMaterial({ map: tex, depthWrite: false, toneMapped: false });
  }, [palette]);
  useEffect(() => {
    return () => {
      skyMat.map?.dispose();
      skyMat.dispose();
    };
  }, [skyMat]);

  /* refs mutated in useFrame */
  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const bgRefs = useRef<(THREE.Group | null)[]>([]);
  const bodyMatRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const glowMatRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const bgBodyMatRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const bgGlowMatRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const starMatRef = useRef<THREE.PointsMaterial>(null);
  const starPointsRef = useRef<THREE.Points>(null);
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const elapsed = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const tt = tRef.current;
    const n = units.length;
    const restCount = Math.min(4, n);

    for (let i = 0; i < n; i++) {
      const g = groupRefs.current[i];
      const bodyMat = bodyMatRefs.current[i];
      const glowMat = glowMatRefs.current[i];
      if (!g || !bodyMat || !glowMat) continue;

      // vertical progress from ground start → formation slot
      let p: number;
      if (phase === "sealed") p = 0;
      else if (phase === "opening") p = easeInOut(clamp01((tt - plan.riseAt[i]) / RISE_DUR));
      else p = 1;

      g.visible = phase === "sealed" ? i < restCount : true;

      const s = plan.starts[i];
      const sl = plan.slots[i];
      const ph = plan.phase[i];
      const settled = p;
      const flight = phase === "opening" ? Math.sin(Math.PI * p) : 0;
      const swayIdle = Math.sin(elapsed * 0.65 + ph) * 0.05 * settled;
      const flightSway = Math.sin(tt * 2.5 + ph) * 0.16 * flight;
      g.position.x = s.x + (sl.x - s.x) * p + swayIdle + flightSway;
      g.position.y = s.y + (sl.y - s.y) * p + Math.sin(elapsed * 1.1 + ph) * 0.05 * settled;
      g.position.z = s.z + (sl.z - s.z) * p;
      g.rotation.z = Math.sin(elapsed * 0.9 + ph) * 0.05 * settled + flight * Math.sin(tt * 3 + ph) * 0.08;
      g.rotation.y = Math.sin(elapsed * 0.4 + ph) * 0.14 * settled;

      // ignition + flicker → fake inner light
      let ignite: number;
      if (phase === "sealed") ignite = i === 0 ? 0.16 + Math.sin(elapsed * 2) * 0.1 : 0;
      else if (phase === "opening") ignite = clamp01((tt - plan.igniteAt[i]) / IGNITE_RAMP);
      else ignite = 1;
      const flick = 1 + Math.sin(elapsed * 7 + ph) * 0.1 + Math.sin(elapsed * 13 + ph * 1.7) * 0.05;
      if (phase === "sealed") {
        bodyMat.emissiveIntensity = ignite;
        glowMat.opacity = Math.max(0, ignite * 0.5);
      } else {
        bodyMat.emissiveIntensity = ignite * BASE_EMISSIVE * flick;
        glowMat.opacity = clamp01(ignite * flick * 0.55);
      }
    }

    if (phase === "opening" && tt > plan.end && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    // background lanterns — drift up and recycle in preview + revealed only
    const bgVisible = phase === "preview" || phase === "revealed";
    for (let i = 0; i < BG_COUNT; i++) {
      const bg = bgRefs.current[i];
      const bgBody = bgBodyMatRefs.current[i];
      const bgGlow = bgGlowMatRefs.current[i];
      if (!bg || !bgBody || !bgGlow) continue;
      bg.visible = bgVisible;
      if (!bgVisible) continue;
      const d = bgData[i];
      const lt = ((elapsed + d.offset) % BG_CYCLE) / BG_CYCLE;
      bg.position.set(d.x + Math.sin(elapsed * 0.3 + d.phase) * 0.2, BG_Y0 + lt * BG_SPAN, d.z);
      bg.rotation.z = Math.sin(elapsed * 0.5 + d.phase) * 0.08;
      const fade = smooth(clamp01(lt / 0.15)) * (1 - smooth(clamp01((lt - 0.72) / 0.28)));
      const bgFlick = 1 + Math.sin(elapsed * 6 + d.phase) * 0.12;
      bgBody.emissiveIntensity = fade * bgFlick;
      bgGlow.opacity = fade * 0.4;
    }

    // starfield gentle twinkle + slow drift
    if (starMatRef.current) starMatRef.current.opacity = 0.55 + Math.sin(elapsed * 0.8) * 0.12;
    if (starPointsRef.current) starPointsRef.current.rotation.z += dt * 0.003;
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.72, 11]} fov={46} onUpdate={(c) => c.lookAt(0, 0.72, 0)} />
      <ambientLight intensity={0.22} color="#5a6a8a" />
      <directionalLight position={[-4, 6, 3]} intensity={0.5} color="#9fb4e0" />
      <pointLight position={[0, 0.7, 2.4]} intensity={0.6} color={palette.light} distance={12} />
      <pointLight position={[0, -3, 1]} intensity={0.4} color={palette.light} distance={8} />

      {/* night-sky backdrop */}
      <mesh position={[0, 0, -8]} renderOrder={-1}>
        <planeGeometry args={[32, 24]} />
        <primitive object={skyMat} attach="material" />
      </mesh>

      {/* starfield */}
      <points ref={starPointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starPos, 3]} />
        </bufferGeometry>
        <pointsMaterial
          ref={starMatRef}
          map={glowSprite}
          color={palette.star}
          size={0.07}
          sizeAttenuation
          transparent
          opacity={0.6}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* dark ground silhouette */}
      <group>
        <mesh geometry={hillGeo} position={[-2, -4.4, -1.5]} scale={[6, 1.4, 1.5]}>
          <meshStandardMaterial color="#0a0812" roughness={1} metalness={0} />
        </mesh>
        <mesh geometry={hillGeo} position={[2.6, -4.6, -2]} scale={[7, 1.6, 1.5]}>
          <meshStandardMaterial color="#080610" roughness={1} metalness={0} />
        </mesh>
        <mesh geometry={hillGeo} position={[0, -4.9, -0.8]} scale={[8.5, 1.55, 1.6]}>
          <meshStandardMaterial color="#0b0914" roughness={1} metalness={0} />
        </mesh>
      </group>

      {/* background lanterns */}
      {bgData.map((_, i) => (
        <group
          key={`bg-${i}`}
          ref={(el) => {
            bgRefs.current[i] = el;
          }}
          scale={bgData[i].scale}
        >
          <mesh geometry={lanternGeo}>
            <meshStandardMaterial
              ref={(m) => {
                bgBodyMatRefs.current[i] = m;
              }}
              color={palette.paper}
              emissive={palette.emissive}
              emissiveIntensity={0}
              roughness={0.85}
              metalness={0}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh position={[0, 0, -0.05]} scale={2.2}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              ref={(m) => {
                bgGlowMatRefs.current[i] = m;
              }}
              map={glowSprite}
              color={palette.glow}
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

      {/* tag lanterns carrying the message */}
      {units.map((_, i) => {
        const tag = tagData.list[i];
        return (
          <group
            key={`lantern-${i}`}
            ref={(el) => {
              groupRefs.current[i] = el;
            }}
          >
            <mesh geometry={lanternGeo} scale={LANTERN_SCALE}>
              <meshStandardMaterial
                ref={(m) => {
                  bodyMatRefs.current[i] = m;
                }}
                color={palette.paper}
                emissive={palette.emissive}
                emissiveIntensity={0}
                roughness={0.85}
                metalness={0}
                side={THREE.DoubleSide}
              />
            </mesh>
            {/* dark top cap */}
            <mesh geometry={capGeo} position={[0, CAP_Y, 0]}>
              <meshStandardMaterial color="#160f14" roughness={0.7} metalness={0.2} />
            </mesh>
            {/* additive inner-glow halo */}
            <mesh position={[0, 0, -0.04]} scale={GLOW_SCALE}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial
                ref={(m) => {
                  glowMatRefs.current[i] = m;
                }}
                map={glowSprite}
                color={palette.glow}
                transparent
                opacity={0}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                toneMapped={false}
              />
            </mesh>
            {/* hanging string */}
            <mesh geometry={stringGeo} position={[0, STRING_Y, 0]}>
              <meshStandardMaterial color="#221820" roughness={0.9} />
            </mesh>
            {/* message tag */}
            <mesh position={[0, -0.3 - tag.h / 2, 0.02]}>
              <planeGeometry args={[tag.w, tag.h]} />
              <meshBasicMaterial map={tag.texture} transparent depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}
