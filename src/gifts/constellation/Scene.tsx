import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
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
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);

/* ---------- opening timeline (seconds) ---------- */
const IGNITE_START = 0.6; // first anchor lights
const IGNITE_SPAN = 3.4; // total time to light all anchors + close loop
const IGNITE_RAMP = 0.3; // per-anchor brighten duration
const MESSAGE_START = IGNITE_START + IGNITE_SPAN + 0.15; // 4.15s
const MESSAGE_DUR = 0.7;
const OPEN_END = MESSAGE_START + MESSAGE_DUR + 0.25; // ~5.1s

/* ---------- star color (bright white-blue) ---------- */
const STAR_R = 0.72;
const STAR_G = 0.84;
const STAR_B = 1.0;

const BG_COUNT = 350;
const SHOOT_DUR = 0.85;

/* ---------- parametric shape paths ---------- */
type Pt = [number, number];

function heartPoint(t: number): Pt {
  const x = 16 * Math.pow(Math.sin(t), 3);
  const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return [x, y];
}

function lemniscatePoint(t: number): Pt {
  const d = 1 + Math.sin(t) * Math.sin(t);
  return [Math.cos(t) / d, (Math.sin(t) * Math.cos(t)) / d];
}

function starVertices(): Pt[] {
  const pts: Pt[] = [];
  const outer = 1;
  const inner = 0.42;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = Math.PI / 2 + (i * Math.PI) / 5; // point-up, CCW
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

interface ShapeData {
  N: number;
  anchors: Pt[]; // normalized world-space anchor xy (read in useFrame for line lerp)
  anchorPos: Float32Array; // N*3 static point positions
  anchorColor: Float32Array; // N*3 dynamic vertex colors
  linePos: Float32Array; // N*6 (N segments, 2 verts each) dynamic
  twPhase: Float32Array;
  twSpeed: Float32Array;
  msgTop: number; // world y just below the constellation for message placement
}

function buildShape(shape: string): ShapeData {
  let raw: Pt[];
  if (shape === "star") {
    raw = starVertices();
  } else if (shape === "infinity") {
    raw = [];
    const N = 16;
    for (let i = 0; i < N; i++) raw.push(lemniscatePoint((i / N) * Math.PI * 2));
  } else {
    raw = [];
    const N = 16;
    for (let i = 0; i < N; i++) raw.push(heartPoint((i / N) * Math.PI * 2));
  }

  // normalize width -> 2.4, center, then lift so the shape centers at y = 0.6
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of raw) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const scale = 2.4 / (maxX - minX);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const rand = mulberry32(shape === "star" ? 5150 : shape === "infinity" ? 8080 : 1616);
  const N = raw.length;
  const anchors: Pt[] = [];
  let shapeMinY = Infinity;
  for (let i = 0; i < N; i++) {
    const jx = (rand() - 0.5) * 0.03;
    const jy = (rand() - 0.5) * 0.03;
    const x = (raw[i][0] - cx) * scale + jx;
    const y = (raw[i][1] - cy) * scale + 0.6 + jy;
    anchors.push([x, y]);
    if (y < shapeMinY) shapeMinY = y;
  }

  const anchorPos = new Float32Array(N * 3);
  const anchorColor = new Float32Array(N * 3);
  const linePos = new Float32Array(N * 6);
  const twPhase = new Float32Array(N);
  const twSpeed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    anchorPos[i * 3] = anchors[i][0];
    anchorPos[i * 3 + 1] = anchors[i][1];
    anchorPos[i * 3 + 2] = 0;
    // init to lit (preview is the default gallery state)
    anchorColor[i * 3] = STAR_R * 0.9;
    anchorColor[i * 3 + 1] = STAR_G * 0.9;
    anchorColor[i * 3 + 2] = STAR_B * 0.9;
    twPhase[i] = rand() * Math.PI * 2;
    twSpeed[i] = 1.1 + rand() * 1.7;
    // init segments fully drawn (preview default)
    const a = anchors[i];
    const b = anchors[(i + 1) % N];
    const base = i * 6;
    linePos[base] = a[0];
    linePos[base + 1] = a[1];
    linePos[base + 2] = 0;
    linePos[base + 3] = b[0];
    linePos[base + 4] = b[1];
    linePos[base + 5] = 0;
  }

  const msgTop = Math.min(shapeMinY - 0.3, -0.6);
  return { N, anchors, anchorPos, anchorColor, linePos, twPhase, twSpeed, msgTop };
}

/* ---------- background starfield ---------- */
interface BgData {
  pos: Float32Array;
  col: Float32Array; // live (mutated each frame)
  base: Float32Array; // constant base color * brightness
  phase: Float32Array;
  speed: Float32Array;
}

function buildBackground(): BgData {
  const rand = mulberry32(424242);
  const pos = new Float32Array(BG_COUNT * 3);
  const col = new Float32Array(BG_COUNT * 3);
  const base = new Float32Array(BG_COUNT * 3);
  const phase = new Float32Array(BG_COUNT);
  const speed = new Float32Array(BG_COUNT);
  for (let i = 0; i < BG_COUNT; i++) {
    pos[i * 3] = (rand() - 0.5) * 20; // x [-10,10]
    pos[i * 3 + 1] = (rand() - 0.5) * 12; // y [-6,6]
    pos[i * 3 + 2] = -0.6 - rand() * 3.6; // z [-0.6,-4.2]
    // mostly white, some cool, some faintly warm
    const warm = rand();
    const r = warm > 0.7 ? 1.0 : 0.78 + rand() * 0.18;
    const g = 0.82 + rand() * 0.16;
    const b = warm < 0.35 ? 1.0 : 0.86 + rand() * 0.14;
    const bright = 0.28 + rand() * 0.62;
    base[i * 3] = r * bright;
    base[i * 3 + 1] = g * bright;
    base[i * 3 + 2] = b * bright;
    col[i * 3] = base[i * 3];
    col[i * 3 + 1] = base[i * 3 + 1];
    col[i * 3 + 2] = base[i * 3 + 2];
    phase[i] = rand() * Math.PI * 2;
    speed[i] = 0.6 + rand() * 2.2;
  }
  return { pos, col, base, phase, speed };
}

/* ---------- canvas textures ---------- */
function makeStreakTexture(): THREE.CanvasTexture {
  const w = 160;
  const h = 16;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.72, "rgba(200,225,255,0.14)");
  grad.addColorStop(0.94, "rgba(230,242,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,1)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // soften top/bottom edges into a thin streak
  const vg = g.createLinearGradient(0, 0, 0, h);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(0.5, "rgba(0,0,0,1)");
  vg.addColorStop(1, "rgba(0,0,0,0)");
  g.globalCompositeOperation = "destination-in";
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);
  return new THREE.CanvasTexture(c);
}

function makeNebulaTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, "rgba(78,66,140,0.55)");
  grad.addColorStop(0.4, "rgba(44,38,86,0.26)");
  grad.addColorStop(1, "rgba(10,8,24,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

export default function ConstellationScene({
  variants,
  phase,
  message,
  recipientName,
  lang,
  onOpenComplete,
}: SceneProps) {
  const shape = variants.shape ?? "heart";

  const shapeData = useMemo(() => buildShape(shape), [shape]);
  const bg = useMemo(() => buildBackground(), []);

  /* message texture (rebuilt on message change, disposed in cleanup) */
  const msg = useMemo(() => {
    const text = (message ?? "").trim() || forRecipient(lang, recipientName ?? "");
    const built = makeTextTexture(text, {
      fontSize: 84,
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "500",
      color: "#fff2d6",
      glow: 12,
      glowColor: "#ffcf8f",
      maxWidthPx: 1100,
      lineHeight: 1.34,
      lang,
    });
    let mw = 2.4; // <= 2.6 requirement
    let mh = mw * built.aspect;
    const MAXH = 1.7;
    if (mh > MAXH) {
      mw *= MAXH / mh;
      mh = MAXH;
    }
    return { texture: built.texture, mw, mh };
  }, [message, recipientName, lang]);

  /* shared canvas textures */
  const spriteTex = useMemo(
    () =>
      makeRadialSprite(64, [
        [0, "rgba(255,255,255,1)"],
        [0.25, "rgba(222,236,255,0.85)"],
        [0.6, "rgba(150,190,255,0.32)"],
        [1, "rgba(120,160,255,0)"],
      ]),
    [],
  );
  const streakTex = useMemo(() => makeStreakTexture(), []);
  const nebulaTex = useMemo(() => makeNebulaTexture(), []);

  useEffect(() => {
    return () => {
      spriteTex.dispose();
      streakTex.dispose();
      nebulaTex.dispose();
    };
  }, [spriteTex, streakTex, nebulaTex]);
  useEffect(() => {
    return () => {
      msg.texture.dispose();
    };
  }, [msg]);

  /* refs */
  const anchorsRef = useRef<THREE.Points>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const lineMatRef = useRef<THREE.LineBasicMaterial>(null);
  const bgRef = useRef<THREE.Points>(null);
  const bgGroupRef = useRef<THREE.Group>(null);
  const constGroupRef = useRef<THREE.Group>(null);
  const messageRef = useRef<THREE.Mesh>(null);
  const messageMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const nebulaMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shootRef = useRef<THREE.Mesh>(null);
  const shootMatRef = useRef<THREE.MeshBasicMaterial>(null);

  /* shooting-star runtime state (Math.random ok — not module/useMemo level) */
  const shootActive = useRef(false);
  const shootProg = useRef(0);
  const shootTimer = useRef(4);
  const shootSX = useRef(0);
  const shootSY = useRef(0);
  const shootDX = useRef(1);
  const shootDY = useRef(0);
  const shootLen = useRef(5);
  const shootAng = useRef(0);

  /* opening clock (local refs so lint allows mutation; reset when opening starts) */
  const tRef = useRef(0);
  const doneRef = useRef(false);
  useEffect(() => {
    if (phase === "opening") {
      tRef.current = 0;
      doneRef.current = false;
    }
  }, [phase]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const time = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const tc = tRef.current;

    const { N, anchors, twPhase, twSpeed, msgTop } = shapeData;
    const STEP = IGNITE_SPAN / N;

    /* ---- anchor stars (write colors through the geometry attribute) ---- */
    if (anchorsRef.current) {
      const ca = anchorsRef.current.geometry.getAttribute("color");
      for (let i = 0; i < N; i++) {
        let b: number;
        if (phase === "sealed") {
          b = i === 0 ? 0.5 + 0.4 * Math.sin(time * 2.2) : 0;
        } else if (phase === "opening") {
          const ig = IGNITE_START + i * STEP;
          const lit = clamp01((tc - ig) / IGNITE_RAMP);
          const pop = tc >= ig ? 0.9 * Math.exp(-Math.pow((tc - ig) / 0.13, 2)) : 0;
          b = easeOutCubic(lit) + pop * lit;
          if (lit > 0.9) b += 0.12 * Math.sin(time * twSpeed[i] + twPhase[i]);
        } else {
          b = 0.9 + 0.22 * Math.sin(time * twSpeed[i] + twPhase[i]);
        }
        if (b < 0) b = 0;
        ca.setXYZ(i, STAR_R * b, STAR_G * b, STAR_B * b);
      }
      ca.needsUpdate = true;
    }

    /* ---- connecting lines (lerp each segment's end vertex) ---- */
    if (linesRef.current) {
      const pa = linesRef.current.geometry.getAttribute("position");
      for (let i = 0; i < N; i++) {
        const a = anchors[i];
        const nx = anchors[(i + 1) % N];
        let p: number;
        if (phase === "sealed") p = 0;
        else if (phase === "opening")
          p = easeOutCubic(clamp01((tc - (IGNITE_START + i * STEP)) / STEP));
        else p = 1;
        pa.setXYZ(i * 2, a[0], a[1], 0);
        pa.setXYZ(i * 2 + 1, a[0] + (nx[0] - a[0]) * p, a[1] + (nx[1] - a[1]) * p, 0);
      }
      pa.needsUpdate = true;
    }
    if (lineMatRef.current) {
      const targ = phase === "sealed" ? 0 : 0.5;
      lineMatRef.current.opacity += (targ - lineMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- once-only completion ---- */
    if (phase === "opening" && tc > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    /* ---- message ---- */
    if (messageMatRef.current && messageRef.current) {
      const centerY = msgTop - msg.mh / 2;
      let op: number;
      let yoff = 0;
      if (phase === "sealed") {
        op = 0;
      } else if (phase === "opening") {
        const mp = easeOutCubic(clamp01((tc - MESSAGE_START) / MESSAGE_DUR));
        op = mp * 0.92 * (0.9 + 0.1 * Math.sin(time * 3));
        yoff = (1 - mp) * -0.3;
      } else {
        op = 0.9 + 0.06 * Math.sin(time * 1.3);
      }
      messageMatRef.current.opacity = op;
      messageRef.current.position.y = centerY + yoff;
    }

    /* ---- background twinkle + parallax drift ---- */
    if (bgRef.current) {
      const bc = bgRef.current.geometry.getAttribute("color");
      const bas = bg.base;
      for (let i = 0; i < BG_COUNT; i++) {
        const tw = 0.55 + 0.45 * Math.sin(time * bg.speed[i] + bg.phase[i]);
        bc.setXYZ(i, bas[i * 3] * tw, bas[i * 3 + 1] * tw, bas[i * 3 + 2] * tw);
      }
      bc.needsUpdate = true;
    }
    if (bgGroupRef.current) {
      bgGroupRef.current.position.x = Math.sin(time * 0.05) * 0.25;
      bgGroupRef.current.position.y = Math.cos(time * 0.04) * 0.12;
      bgGroupRef.current.rotation.z = Math.sin(time * 0.03) * 0.02;
    }

    /* ---- gentle constellation idle bob ---- */
    if (constGroupRef.current) {
      const idle = phase === "preview" || phase === "revealed" ? 1 : 0.3;
      constGroupRef.current.position.y = Math.sin(time * 0.4) * 0.03 * idle;
    }

    /* ---- nebula glow (subtle sealed pulse) ---- */
    if (nebulaMatRef.current) {
      const targ = phase === "sealed" ? 0.55 + 0.12 * Math.sin(time * 1.6) : 0.7;
      nebulaMatRef.current.opacity += (targ - nebulaMatRef.current.opacity) * Math.min(1, dt * 2);
    }

    /* ---- occasional shooting star (revealed + preview) ---- */
    if (phase === "revealed" || phase === "preview") {
      if (shootActive.current) {
        shootProg.current += dt / SHOOT_DUR;
        const p = shootProg.current;
        if (p >= 1) {
          shootActive.current = false;
          if (shootRef.current) shootRef.current.visible = false;
          shootTimer.current = 4 + Math.random() * 3;
        } else if (shootRef.current && shootMatRef.current) {
          shootRef.current.position.set(
            shootSX.current + shootDX.current * shootLen.current * p,
            shootSY.current + shootDY.current * shootLen.current * p,
            0.1,
          );
          shootRef.current.rotation.z = shootAng.current;
          shootMatRef.current.opacity = Math.min(1, p * 5) * (1 - p) * 0.95;
        }
      } else {
        shootTimer.current -= dt;
        if (shootTimer.current <= 0) {
          shootActive.current = true;
          shootProg.current = 0;
          const side = Math.random() < 0.5 ? -1 : 1;
          shootSX.current = side * (3.0 + Math.random() * 1.0);
          shootSY.current = 2.2 + Math.random() * 1.3;
          const dirx = -side;
          const diry = -(0.5 + Math.random() * 0.5);
          const l = Math.hypot(dirx, diry);
          shootDX.current = dirx / l;
          shootDY.current = diry / l;
          shootLen.current = 4.5 + Math.random() * 2.5;
          shootAng.current = Math.atan2(shootDY.current, shootDX.current);
          if (shootRef.current) shootRef.current.visible = true;
        }
      }
    } else {
      if (shootActive.current) {
        shootActive.current = false;
        if (shootRef.current) shootRef.current.visible = false;
      }
      shootTimer.current = 3 + Math.random() * 2;
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.2, 8]}
        fov={50}
        onUpdate={(c) => c.lookAt(0, 0.1, 0)}
      />
      <ambientLight intensity={0.4} />
      <pointLight position={[0, 0.6, 3]} intensity={0.6} color="#9fc6ff" />

      {/* soft nebula glow behind the constellation (large dark mesh for mood) */}
      <mesh position={[0, 0.35, -3.5]}>
        <planeGeometry args={[9, 7]} />
        <meshBasicMaterial
          ref={nebulaMatRef}
          map={nebulaTex}
          transparent
          opacity={0.7}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* background starfield (parallax drift) */}
      <group ref={bgGroupRef}>
        <points ref={bgRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[bg.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[bg.col, 3]} />
          </bufferGeometry>
          <pointsMaterial
            vertexColors
            map={spriteTex}
            size={0.05}
            sizeAttenuation
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      </group>

      {/* main constellation (remount cleanly on shape change) */}
      <group key={shape} ref={constGroupRef}>
        <lineSegments ref={linesRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[shapeData.linePos, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            ref={lineMatRef}
            color="#8fb4ff"
            transparent
            opacity={0.5}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </lineSegments>
        <points ref={anchorsRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[shapeData.anchorPos, 3]} />
            <bufferAttribute attach="attributes-color" args={[shapeData.anchorColor, 3]} />
          </bufferGeometry>
          <pointsMaterial
            vertexColors
            map={spriteTex}
            size={0.12}
            sizeAttenuation
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      </group>

      {/* message below the constellation */}
      <mesh ref={messageRef} position={[0, shapeData.msgTop - msg.mh / 2, 0.05]}>
        <planeGeometry args={[msg.mw, msg.mh]} />
        <meshBasicMaterial
          ref={messageMatRef}
          map={msg.texture}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* reusable shooting-star streak */}
      <mesh ref={shootRef} visible={false}>
        <planeGeometry args={[0.9, 0.09]} />
        <meshBasicMaterial
          ref={shootMatRef}
          map={streakTex}
          color="#dbe8ff"
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </>
  );
}
