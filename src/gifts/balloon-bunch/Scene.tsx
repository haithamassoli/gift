import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, mulberry32, smooth } from "../math";

/* ---------- palettes (keyed by the `palette` variant value) ---------- */
interface Palette {
  colors: string[];
  metalness: number;
  roughness: number;
  tag: string;
  tagText: string;
  string: string;
  key: string; // accent light color
}
const PALETTES: Record<string, Palette> = {
  warm: {
    colors: ["#e23b4e", "#f0637a", "#ff8fa3", "#c81d4a", "#ff6b5c"],
    metalness: 0.0,
    roughness: 0.25,
    tag: "#f6ead2",
    tagText: "#7a2438",
    string: "#e9c9b0",
    key: "#ffd6c2",
  },
  pastel: {
    colors: ["#9be7c4", "#c8b6f0", "#a9d3f0", "#f6ecd2", "#f7c6d9"],
    metalness: 0.0,
    roughness: 0.28,
    tag: "#fff6e8",
    tagText: "#5a5470",
    string: "#dfe6f0",
    key: "#e2ecff",
  },
  gold: {
    colors: ["#e8c98a", "#d9a441", "#f2e2b8", "#c8912f", "#ffe0a0"],
    metalness: 0.7,
    roughness: 0.22,
    tag: "#f4e6c4",
    tagText: "#6b4a1a",
    string: "#e8d29a",
    key: "#ffe8b0",
  },
};

/* ---------- reusable scratch (module level, never a hook value) ---------- */
const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

/* ---------- layout / timeline constants ---------- */
const MAX = 20; // instanced capacity (largest `count` option)
const GATHER_Y = -0.25; // where all strings converge (bunch-local)
const TAG_TOP_Y = -0.4; // top edge of the hanging tag
const SEG = 12; // segments per string
const SPRING_DUR = 0.6; // per-balloon inflate time
const STAGGER = 0.12; // stagger between balloons inflating
const RISE_DUR = 3.6; // whole-bunch lift duration
const RISE_START_Y = -1.7; // sealed / opening-start vertical offset
const OPEN_END = 4.5; // reveal-complete moment
const BALLOON_HALF = 0.46; // half-height of a full-size balloon (0.4 * 1.15)
const NST = 14; // nudge spring stiffness
const NDA = 4.5; // nudge spring damping

interface Balloon {
  hx: number; hy: number; hz: number; // home (assembled) position
  dx: number; dy: number; dz: number; // deflated (sealed) position
  size: number;
  bobPhase: number; swayPhase: number; bobSpeed: number; bobAmp: number;
  tilt: number; start: number;
}

function buildBalloons(count: number): Balloon[] {
  const rand = mulberry32(1700 + count * 13);
  const arr: Balloon[] = [];
  const golden = 2.399963;
  for (let i = 0; i < count; i++) {
    const ang = i * golden + rand() * 0.6;
    const rNorm = Math.sqrt((i + 0.6) / count); // 0..~1
    const rr = 0.68 * rNorm;
    arr.push({
      hx: Math.cos(ang) * rr + (rand() - 0.5) * 0.08,
      hy: 1.65 - rNorm * 1.0 + (rand() - 0.5) * 0.22, // dome: center-top higher
      hz: Math.sin(ang) * rr * 0.7 + (rand() - 0.5) * 0.08,
      dx: Math.cos(rand() * Math.PI * 2) * rand() * 0.22,
      dy: GATHER_Y + 0.14 + rand() * 0.12,
      dz: Math.sin(rand() * Math.PI * 2) * rand() * 0.16,
      size: 0.85 + rand() * 0.3,
      bobPhase: rand() * Math.PI * 2,
      swayPhase: rand() * Math.PI * 2,
      bobSpeed: 0.6 + rand() * 0.5,
      bobAmp: 0.05 + rand() * 0.06,
      tilt: (rand() - 0.5) * 0.18,
      start: i * STAGGER,
    });
  }
  return arr;
}

/* ---------- rounded-rect tag outline ---------- */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export default function BalloonBunchScene({ variants, phase, message, lang, onOpenComplete }: SceneProps) {
  const palette = PALETTES[variants.palette] ?? PALETTES.warm;
  const count = useMemo(() => {
    const n = parseInt(variants.count ?? "12", 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX) : 12;
  }, [variants.count]);

  const balloons = useMemo(() => buildBalloons(count), [count]);
  const stringPositions = useMemo(() => new Float32Array(MAX * SEG * 2 * 3), []);

  // Hanging paper tag carrying the message.
  const tagAssets = useMemo(() => {
    const msg = message.trim();
    const hasText = msg.length > 0;
    const { texture, aspect } = makeTextTexture(hasText ? msg : " ", {
      fontSize: 62,
      fontWeight: "600",
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: palette.tagText,
      maxWidthPx: 62 * 15,
      lineHeight: 1.32,
      lang,
    });
    const TW = 1.3;
    const textH = Math.min(1.8, Math.max(0.3, TW * aspect));
    const tagCenterY = TAG_TOP_Y - (textH + 0.28) / 2;
    const tagGeo = new THREE.ShapeGeometry(roundedRect(TW + 0.26, textH + 0.28, 0.09));
    return { texture, hasText, TW, textH, tagCenterY, tagGeo };
  }, [message, palette, lang]);
  useEffect(() => {
    return () => {
      tagAssets.texture.dispose();
      tagAssets.tagGeo.dispose();
    };
  }, [tagAssets]);

  const balloonRef = useRef<THREE.InstancedMesh>(null);
  const knotRef = useRef<THREE.InstancedMesh>(null);
  const stringsRef = useRef<THREE.LineSegments>(null);
  const bunchRef = useRef<THREE.Group>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const accentRef = useRef<THREE.PointLight>(null);
  const pulseRef = useRef<THREE.PointLight>(null);
  const textMatRef = useRef<THREE.MeshBasicMaterial>(null);

  // Per-instance colours + home matrices; hides unused instances (count < MAX).
  useEffect(() => {
    const bm = balloonRef.current;
    const km = knotRef.current;
    if (!bm || !km) return;
    for (let i = 0; i < MAX; i++) {
      if (i < count) {
        const b = balloons[i];
        tmpColor.set(palette.colors[i % palette.colors.length]);
        bm.setColorAt(i, tmpColor);
        km.setColorAt(i, tmpColor);
        dummy.position.set(b.hx, b.hy, b.hz);
        dummy.rotation.set(0, 0, b.tilt);
        dummy.scale.set(b.size, b.size * 1.15, b.size);
        dummy.updateMatrix();
        bm.setMatrixAt(i, dummy.matrix);
        dummy.position.set(b.hx, b.hy - BALLOON_HALF * b.size, b.hz);
        dummy.rotation.set(Math.PI, 0, 0);
        dummy.scale.setScalar(b.size);
        dummy.updateMatrix();
        km.setMatrixAt(i, dummy.matrix);
      } else {
        dummy.position.set(0, 0, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        bm.setMatrixAt(i, dummy.matrix);
        km.setMatrixAt(i, dummy.matrix);
      }
    }
    if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    if (km.instanceColor) km.instanceColor.needsUpdate = true;
    bm.instanceMatrix.needsUpdate = true;
    km.instanceMatrix.needsUpdate = true;
    const sg = stringsRef.current;
    if (sg) {
      const arr = sg.geometry.attributes.position.array as Float32Array;
      arr.fill(0, count * SEG * 2 * 3);
      sg.geometry.attributes.position.needsUpdate = true;
    }
  }, [count, palette, balloons]);

  // Revealed-phase nudge springs (mutable scratch behind a ref).
  const nudgeRef = useRef<{
    x: Float32Array; z: Float32Array; vx: Float32Array; vz: Float32Array;
  } | null>(null);
  const nudgeRng = useMemo(() => mulberry32(4242), []);
  const nudgeTimer = useRef(0);
  useEffect(() => {
    nudgeRef.current = {
      x: new Float32Array(count),
      z: new Float32Array(count),
      vx: new Float32Array(count),
      vz: new Float32Array(count),
    };
    nudgeTimer.current = 0;
  }, [count]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const et = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const tt = tRef.current;

    /* whole-bunch vertical position + gentle sway */
    const bunch = bunchRef.current;
    if (bunch) {
      if (phase === "opening") {
        bunch.position.y = RISE_START_Y * (1 - easeOutCubic(clamp01(tt / RISE_DUR)));
        bunch.rotation.z *= 0.9;
      } else {
        const base = phase === "sealed" ? RISE_START_Y : 0;
        const idle = phase === "sealed" ? Math.sin(et * 0.9) * 0.012 : Math.sin(et * 0.5) * 0.06;
        bunch.position.y += (base + idle - bunch.position.y) * Math.min(1, dt * 4);
        const swayTarget =
          phase === "sealed" ? Math.sin(et * 0.9) * 0.01 : Math.sin(et * 0.35) * 0.025;
        bunch.rotation.z += (swayTarget - bunch.rotation.z) * Math.min(1, dt * 3);
      }
    }

    /* revealed: occasional balloon-balloon nudge impulse */
    const n = nudgeRef.current;
    if (phase === "revealed" && n) {
      nudgeTimer.current += dt;
      if (nudgeTimer.current > 3) {
        nudgeTimer.current = 0;
        const i = Math.floor(nudgeRng() * count);
        const j = (i + 1) % count;
        const ang = nudgeRng() * Math.PI * 2;
        const mag = 0.5;
        n.vx[i] += Math.cos(ang) * mag;
        n.vz[i] += Math.sin(ang) * mag;
        n.vx[j] -= Math.cos(ang) * mag * 0.5;
        n.vz[j] -= Math.sin(ang) * mag * 0.5;
      }
    } else {
      nudgeTimer.current = 0;
    }

    const bm = balloonRef.current;
    const km = knotRef.current;
    const sg = stringsRef.current;
    if (bm && km && sg) {
      const sealedBreathe = phase === "sealed" ? 1 + 0.05 * Math.sin(et * 2.0) : 1;
      const sp = sg.geometry.attributes.position.array as Float32Array;

      for (let i = 0; i < balloons.length; i++) {
        const b = balloons[i];
        let inflate: number;
        let posT: number;
        let bobAmt: number;
        if (phase === "opening") {
          inflate = easeOutBack(clamp01((tt - b.start) / SPRING_DUR));
          posT = smooth(clamp01((tt - b.start - 0.02) / (SPRING_DUR * 1.05)));
          bobAmt = posT;
        } else if (phase === "sealed") {
          inflate = 0;
          posT = 0;
          bobAmt = 0;
        } else {
          inflate = 1;
          posT = 1;
          bobAmt = 1;
        }
        const s = (0.12 + 0.88 * inflate) * b.size * sealedBreathe;

        let nx = 0;
        let nz = 0;
        if (n) {
          n.vx[i] += (-n.x[i] * NST - n.vx[i] * NDA) * dt;
          n.x[i] += n.vx[i] * dt;
          n.vz[i] += (-n.z[i] * NST - n.vz[i] * NDA) * dt;
          n.z[i] += n.vz[i] * dt;
          nx = n.x[i];
          nz = n.z[i];
        }

        const baseX = b.dx + (b.hx - b.dx) * posT;
        const baseY = b.dy + (b.hy - b.dy) * posT;
        const baseZ = b.dz + (b.hz - b.dz) * posT;
        const bx = baseX + Math.sin(et * b.bobSpeed + b.bobPhase) * b.bobAmp * 0.35 * bobAmt + nx;
        const by = baseY + Math.sin(et * b.bobSpeed * 0.9 + b.bobPhase) * b.bobAmp * bobAmt;
        const bz = baseZ + Math.cos(et * b.bobSpeed * 0.8 + b.swayPhase) * b.bobAmp * 0.3 * bobAmt + nz;
        const rotz = b.tilt * bobAmt + Math.sin(et * b.bobSpeed + b.swayPhase) * 0.05 * bobAmt;

        dummy.position.set(bx, by, bz);
        dummy.rotation.set(0, 0, rotz);
        dummy.scale.set(s, s * 1.15, s);
        dummy.updateMatrix();
        bm.setMatrixAt(i, dummy.matrix);

        dummy.position.set(bx, by - BALLOON_HALF * s - 0.02, bz);
        dummy.rotation.set(Math.PI, 0, rotz);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        km.setMatrixAt(i, dummy.matrix);

        // string: quadratic bezier from knot tip down to the shared gather point
        const topx = bx;
        const topy = by - BALLOON_HALF * s - 0.05 * s;
        const topz = bz;
        const cx = topx * 0.3 + Math.sin(et * 0.7 + b.swayPhase) * 0.03 * bobAmt;
        const cy = (topy + GATHER_Y) * 0.5 - 0.14;
        const cz = topz * 0.3;
        let px = topx;
        let py = topy;
        let pz = topz;
        for (let k = 0; k < SEG; k++) {
          const u = (k + 1) / SEG;
          const iu = 1 - u;
          const qx = iu * iu * topx + 2 * iu * u * cx;
          const qy = iu * iu * topy + 2 * iu * u * cy + u * u * GATHER_Y;
          const qz = iu * iu * topz + 2 * iu * u * cz;
          const base = (i * SEG + k) * 6;
          sp[base] = px;
          sp[base + 1] = py;
          sp[base + 2] = pz;
          sp[base + 3] = qx;
          sp[base + 4] = qy;
          sp[base + 5] = qz;
          px = qx;
          py = qy;
          pz = qz;
        }
      }
      bm.instanceMatrix.needsUpdate = true;
      km.instanceMatrix.needsUpdate = true;
      sg.geometry.attributes.position.needsUpdate = true;
    }

    if (phase === "opening" && tt > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    /* lighting: dim + inviting pulse while sealed */
    const dim = phase === "sealed";
    if (ambientRef.current)
      ambientRef.current.intensity +=
        ((dim ? 0.16 : 0.5) - ambientRef.current.intensity) * Math.min(1, dt * 4);
    if (keyRef.current)
      keyRef.current.intensity +=
        ((dim ? 0.4 : 1.15) - keyRef.current.intensity) * Math.min(1, dt * 4);
    if (accentRef.current)
      accentRef.current.intensity +=
        ((dim ? 0.25 : 0.85) - accentRef.current.intensity) * Math.min(1, dt * 4);
    if (pulseRef.current) {
      const target = dim ? 0.5 + Math.sin(et * 2.0) * 0.3 : 0.55;
      pulseRef.current.intensity += (target - pulseRef.current.intensity) * Math.min(1, dt * 4);
    }

    /* tag text fades up as the gift opens */
    if (textMatRef.current) {
      const target =
        phase === "sealed" ? 0.4 : phase === "opening" ? 0.4 + 0.6 * smooth(clamp01(tt / 2.4)) : 1;
      textMatRef.current.opacity += (target - textMatRef.current.opacity) * Math.min(1, dt * 3);
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.4, 8]}
        fov={44}
        onUpdate={(c) => c.lookAt(0, 0.2, 0)}
      />
      <ambientLight ref={ambientRef} intensity={0.5} />
      <directionalLight ref={keyRef} position={[2.5, 5, 3]} intensity={1.15} color="#fff2e2" />
      <pointLight ref={accentRef} position={[-2.6, 2.6, 1.6]} intensity={0.85} color={palette.key} />
      <pointLight ref={pulseRef} position={[0, -0.4, 2.2]} intensity={0.55} color={palette.key} />

      {/* large dark backdrop for mood/depth */}
      <mesh position={[0, 0.2, -4]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#160e20" roughness={1} metalness={0} />
      </mesh>

      <group ref={bunchRef}>
        <lineSegments ref={stringsRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[stringPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={palette.string} transparent opacity={0.5} depthWrite={false} />
        </lineSegments>

        <instancedMesh ref={balloonRef} args={[undefined, undefined, MAX]}>
          <sphereGeometry args={[0.4, 24, 18]} />
          <meshPhysicalMaterial
            color="#ffffff"
            roughness={palette.roughness}
            metalness={palette.metalness}
            clearcoat={1}
            clearcoatRoughness={0.18}
          />
        </instancedMesh>

        <instancedMesh ref={knotRef} args={[undefined, undefined, MAX]}>
          <coneGeometry args={[0.05, 0.12, 8]} />
          <meshStandardMaterial color="#ffffff" roughness={0.5} metalness={palette.metalness} />
        </instancedMesh>

        {/* short string from the gather point down to the tag */}
        <mesh position={[0, (GATHER_Y + TAG_TOP_Y) / 2, 0]}>
          <cylinderGeometry args={[0.006, 0.006, GATHER_Y - TAG_TOP_Y, 6]} />
          <meshBasicMaterial color={palette.string} transparent opacity={0.55} depthWrite={false} />
        </mesh>

        {/* hanging paper tag with the message */}
        <group position={[0, tagAssets.tagCenterY, 0]}>
          <mesh geometry={tagAssets.tagGeo}>
            <meshStandardMaterial
              color={palette.tag}
              emissive={palette.tag}
              emissiveIntensity={0.06}
              roughness={0.9}
              metalness={0}
              side={THREE.DoubleSide}
            />
          </mesh>
          {tagAssets.hasText && (
            <mesh position={[0, 0, 0.012]}>
              <planeGeometry args={[tagAssets.TW, tagAssets.textH]} />
              <meshBasicMaterial
                ref={textMatRef}
                map={tagAssets.texture}
                transparent
                depthWrite={false}
                opacity={1}
              />
            </mesh>
          )}
        </group>
      </group>
    </>
  );
}
