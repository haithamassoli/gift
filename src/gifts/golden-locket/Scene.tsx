import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { clamp01, easeOutBack, mulberry32 } from "../math";

/* ---------- metal palettes (keyed by variant "metal") ---------- */
const PALETTES: Record<
  string,
  { color: string; emissive: string; spark: string; roughness: number }
> = {
  gold: { color: "#d4af37", emissive: "#3a2600", spark: "#ffe6a2", roughness: 0.18 },
  silver: { color: "#c8c9d4", emissive: "#181c24", spark: "#eaf1ff", roughness: 0.16 },
  "rose-gold": { color: "#c47f86", emissive: "#331416", spark: "#ffd6da", roughness: 0.2 },
};

/* ---------- opening timeline (seconds) ---------- */
const SETTLE_END = 1.0; // swing settles to rest
const POP_AT = 1.0; // clasp pop
const POP_DUR = 0.32;
const HINGE_START = 1.05;
const HINGE_END = 2.7; // cover open (ease-out overshoot)
const TEXT_START = 2.6;
const TEXT_END = 3.4; // inscriptions faded in
const OPEN_END = 3.6; // onOpenComplete fires
const OPEN_ANGLE = THREE.MathUtils.degToRad(165);

/* ---------- heart shape (parametric, normalized, centered) ---------- */
function buildHeartShape(width: number): THREE.Shape {
  const N = 100;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    xs.push(16 * Math.pow(Math.sin(th), 3));
    ys.push(13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th));
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const s = width / (maxX - minX);
  const shape = new THREE.Shape();
  for (let i = 0; i < N; i++) {
    const px = (xs[i] - cx) * s;
    const py = (ys[i] - cy) * s;
    if (i === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  }
  shape.closePath();
  return shape;
}

const HEART_W = 0.76;
const heartGeo = new THREE.ExtrudeGeometry(buildHeartShape(HEART_W), {
  depth: 0.06,
  bevelEnabled: true,
  bevelThickness: 0.018,
  bevelSize: 0.018,
  bevelSegments: 2,
  steps: 1,
});
heartGeo.center();
heartGeo.computeBoundingBox();
const HB = heartGeo.boundingBox!;
const HW = HB.max.x; // heart half-width incl. bevel
const HALF_T = HB.max.z; // heart half-thickness incl. bevel
const HEART_TOP = HB.max.y; // top of the lobes

// Nesting: cover in front, body behind, small cavity between the inner faces.
const COVER_Z = HALF_T + 0.01;
const BODY_Z = -(HALF_T + 0.01);
const PLATE_PROUD = 0.006;
const TEXT_PROUD = 0.013;

// Where the opened cover's centre lands, so we can frame the open pair centred.
const coverCenterX = -HW + (HW * Math.cos(-OPEN_ANGLE) + COVER_Z * Math.sin(-OPEN_ANGLE));
const OPEN_CENTER_X = coverCenterX / 2;
const CAM_X = OPEN_CENTER_X;

/* ---------- inscription plate (rounded rect) ---------- */
function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
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
const plateGeo = new THREE.ShapeGeometry(roundedRectShape(0.56, 0.44, 0.08));
const plateMat = new THREE.MeshStandardMaterial({
  color: "#efe6d0",
  emissive: "#463726",
  emissiveIntensity: 0.35,
  roughness: 0.75,
  metalness: 0.08,
  side: THREE.DoubleSide,
});
const bailGeo = new THREE.TorusGeometry(0.05, 0.013, 8, 22);
const claspGeo = new THREE.SphereGeometry(0.032, 14, 12);
const spineGeo = new THREE.CylinderGeometry(0.02, 0.02, HEART_TOP * 1.7, 12);

/* ---------- chain (catenary tube) + top pivot ---------- */
function buildChain(): { geo: THREE.TubeGeometry; top: number } {
  const a = 0.224;
  const low = 0.45;
  const half = 0.66;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 44; i++) {
    const x = -half + (i / 44) * (2 * half);
    const y = low + a * (Math.cosh(x / a) - 1);
    pts.push(new THREE.Vector3(x, y, 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 96, 0.016, 6, false);
  return { geo, top: pts[pts.length - 1].y };
}
const { geo: chainGeo, top: PIVOT_Y } = buildChain();

/* ---------- environment reflection (canvas-generated, no HDRI) ---------- */
function buildEnvTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#23252f");
  grad.addColorStop(0.34, "#4c4858");
  grad.addColorStop(0.5, "#ede4cf");
  grad.addColorStop(0.63, "#39303a");
  grad.addColorStop(1, "#08060a");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const hot = g.createRadialGradient(w * 0.7, h * 0.42, 0, w * 0.7, h * 0.42, 90);
  hot.addColorStop(0, "rgba(255,246,222,0.95)");
  hot.addColorStop(1, "rgba(255,246,222,0)");
  g.fillStyle = hot;
  g.fillRect(0, 0, w, h);
  const hot2 = g.createRadialGradient(w * 0.24, h * 0.46, 0, w * 0.24, h * 0.46, 66);
  hot2.addColorStop(0, "rgba(255,255,255,0.75)");
  hot2.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = hot2;
  g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
const ENV_TEX = buildEnvTexture();

function buildBackdrop(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s * 0.44, 0, s / 2, s * 0.44, s * 0.62);
  grad.addColorStop(0, "#26202b");
  grad.addColorStop(0.6, "#150f18");
  grad.addColorStop(1, "#0c0910");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
const BACKDROP_TEX = buildBackdrop();
const sparkTex = makeRadialSprite();

/* ---------- sparkle glints ---------- */
const SPARK = 42;
function buildSparkles() {
  const rand = mulberry32(9137);
  const pos = new Float32Array(SPARK * 3);
  for (let i = 0; i < SPARK; i++) {
    pos[i * 3] = OPEN_CENTER_X + (rand() - 0.5) * 1.7;
    pos[i * 3 + 1] = 0.05 + (rand() - 0.5) * 1.05;
    pos[i * 3 + 2] = 0.12 + rand() * 0.28;
  }
  return pos;
}

/* ---------- text fit helper ---------- */
function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function GoldenLocketScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const pal = PALETTES[variants.metal] ?? PALETTES.gold;

  const metalMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: pal.color,
        emissive: pal.emissive,
        emissiveIntensity: 0.14,
        metalness: 1,
        roughness: pal.roughness,
        envMap: ENV_TEX,
        envMapIntensity: 1.15,
      }),
    [pal],
  );
  useEffect(() => () => metalMat.dispose(), [metalMat]);

  const engraving = useMemo(() => {
    const sender = senderName || (lang === "ar" ? "شخص ما" : "Someone");
    const recipient = recipientName || (lang === "ar" ? "أنت" : "You");
    const cover = makeTextTexture(`${sender}  ♥  ${recipient}`, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "600",
      fontSize: 62,
      color: "#5a3320",
      maxWidthPx: 62 * 6,
      lineHeight: 1.28,
      padding: 40,
      lang,
    });
    const body = makeTextTexture(message || "—", {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "500",
      fontSize: 46,
      color: "#5a3320",
      maxWidthPx: 46 * 8,
      lineHeight: 1.34,
      padding: 34,
      lang,
    });
    return {
      cover,
      body,
      coverSize: fitPlane(cover.aspect, 0.38, 0.24),
      bodySize: fitPlane(body.aspect, 0.48, 0.35),
    };
  }, [senderName, recipientName, message, lang]);
  useEffect(
    () => () => {
      engraving.cover.texture.dispose();
      engraving.body.texture.dispose();
    },
    [engraving],
  );

  const sparkPos = useMemo(() => buildSparkles(), []);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  const floatRef = useRef<THREE.Group>(null);
  const swayRef = useRef<THREE.Group>(null);
  const popRef = useRef<THREE.Group>(null);
  const hingeRef = useRef<THREE.Group>(null);
  const claspRef = useRef<THREE.Mesh>(null);
  const coverTextRef = useRef<THREE.MeshBasicMaterial>(null);
  const bodyTextRef = useRef<THREE.MeshBasicMaterial>(null);
  const sparkMatRef = useRef<THREE.PointsMaterial>(null);
  const rim1Ref = useRef<THREE.PointLight>(null);
  const rim2Ref = useRef<THREE.PointLight>(null);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    // Cover hinge: closed when sealed, staggered ease-out+overshoot while opening, open otherwise.
    let openF: number;
    if (phase === "opening") {
      openF = easeOutBack(clamp01((t - HINGE_START) / (HINGE_END - HINGE_START)));
    } else if (phase === "sealed") {
      openF = 0;
    } else {
      openF = 1;
    }
    if (hingeRef.current) hingeRef.current.rotation.y = -OPEN_ANGLE * openF;

    // Pendulum sway about the top pivot.
    let swayZ: number;
    if (phase === "sealed") {
      swayZ = 0.07 * Math.sin(e * 1.15);
    } else if (phase === "opening") {
      swayZ = 0.07 * Math.sin(e * 1.15) * (1 - clamp01(t / SETTLE_END));
    } else {
      swayZ = 0.028 * Math.sin(e * 0.7);
    }
    if (swayRef.current) swayRef.current.rotation.z = swayZ;

    // Gentle float in the finished states.
    if (floatRef.current) {
      const alive = phase === "preview" || phase === "revealed";
      floatRef.current.position.y = alive ? Math.sin(e * 0.9) * 0.04 : 0;
      floatRef.current.rotation.z = alive ? Math.sin(e * 0.5) * 0.014 : 0;
    }

    // Clasp pop blip.
    let popScale = 1;
    let claspScale = 1;
    if (phase === "opening") {
      const local = (t - POP_AT) / POP_DUR;
      if (local > 0 && local < 1) {
        const b = Math.sin(local * Math.PI);
        popScale = 1 + b * 0.045;
        claspScale = 1 + b * 0.5;
      }
    }
    if (popRef.current) popRef.current.scale.setScalar(popScale);
    if (claspRef.current) claspRef.current.scale.setScalar(claspScale);

    // Inscription fade-in.
    let ins: number;
    if (phase === "preview" || phase === "revealed") ins = 1;
    else if (phase === "opening") ins = clamp01((t - TEXT_START) / (TEXT_END - TEXT_START));
    else ins = 0;
    if (coverTextRef.current) coverTextRef.current.opacity = ins;
    if (bodyTextRef.current) bodyTextRef.current.opacity = ins;

    // Fire completion exactly once.
    if (phase === "opening" && t > OPEN_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    // Sparkle twinkle (only around the open, revealed locket).
    if (sparkMatRef.current) {
      let target: number;
      if (phase === "sealed") target = 0;
      else if (phase === "opening") target = clamp01((t - TEXT_START) / 0.7) * 0.85;
      else target = 0.85;
      const m = sparkMatRef.current;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 3);
      m.size = 0.05 + Math.sin(e * 3.1) * 0.014;
    }

    // Living highlights: one slow orbit + one sweep (glint pulse while sealed).
    if (rim1Ref.current) {
      rim1Ref.current.position.x = OPEN_CENTER_X + Math.sin(e * 0.35) * 1.9;
      rim1Ref.current.position.y = 0.7 + Math.cos(e * 0.27) * 0.55;
    }
    if (rim2Ref.current) {
      rim2Ref.current.position.x = OPEN_CENTER_X + Math.sin(e * 0.85) * 2.1;
      rim2Ref.current.intensity =
        phase === "sealed" ? 0.5 + 0.55 * (0.5 + 0.5 * Math.sin(e * 1.7)) : 0.7;
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[CAM_X, 0.3, 7.0]}
        fov={40}
        onUpdate={(c) => c.lookAt(CAM_X, 0.3, 0)}
      />
      <ambientLight intensity={0.4} />
      <directionalLight position={[2.6, 3.2, 4]} intensity={1.55} color="#fff2df" />
      <pointLight ref={rim1Ref} position={[1.6, 0.8, 2.6]} intensity={0.85} color="#ffffff" />
      <pointLight ref={rim2Ref} position={[-1.6, 0.9, 2.4]} intensity={0.7} color="#fff4e6" />

      {/* mood backdrop */}
      <mesh position={[OPEN_CENTER_X, 0.6, -2.4]}>
        <planeGeometry args={[10, 8]} />
        <meshBasicMaterial map={BACKDROP_TEX} depthWrite={false} />
      </mesh>

      <group ref={floatRef}>
        <group ref={swayRef} position={[0, PIVOT_Y, 0]}>
          <group position={[0, -PIVOT_Y, 0]}>
            {/* chain + bail (rigid pendulum rod) */}
            <mesh geometry={chainGeo} material={metalMat} />
            <mesh geometry={bailGeo} position={[0, 0.44, 0]} material={metalMat} />

            {/* locket (pop-scaled about heart centre) */}
            <group ref={popRef}>
              {/* back body */}
              <group position={[0, 0, BODY_Z]}>
                <mesh geometry={heartGeo} material={metalMat} />
                <mesh geometry={plateGeo} material={plateMat} position={[0, 0.02, HALF_T + PLATE_PROUD]} />
                <mesh position={[0, 0.02, HALF_T + TEXT_PROUD]}>
                  <planeGeometry args={engraving.bodySize} />
                  <meshBasicMaterial
                    ref={bodyTextRef}
                    map={engraving.body.texture}
                    transparent
                    opacity={0}
                    depthWrite={false}
                    toneMapped={false}
                  />
                </mesh>
              </group>

              {/* hinge spine */}
              <mesh geometry={spineGeo} position={[-HW, 0, 0]} material={metalMat} />

              {/* front cover — hinges open around the left edge */}
              <group ref={hingeRef} position={[-HW, 0, 0]}>
                <group position={[HW, 0, COVER_Z]}>
                  <mesh geometry={heartGeo} material={metalMat} />
                  {/* Inset plate shrunk + nudged toward the heart centre and raised
                      well proud of the face, so the ~15° tilt of the opened cover
                      never lets the extruded heart edge occlude the inscription. */}
                  <mesh
                    geometry={plateGeo}
                    material={plateMat}
                    position={[-0.06, 0.07, -(HALF_T + 0.06)]}
                    rotation={[0, OPEN_ANGLE, 0]}
                    scale={[0.75, 0.773, 1]}
                  />
                  <mesh position={[-0.06, 0.07, -(HALF_T + 0.067)]} rotation={[0, OPEN_ANGLE, 0]}>
                    <planeGeometry args={engraving.coverSize} />
                    <meshBasicMaterial
                      ref={coverTextRef}
                      map={engraving.cover.texture}
                      transparent
                      opacity={0}
                      depthWrite={false}
                      toneMapped={false}
                    />
                  </mesh>
                </group>
              </group>

              {/* clasp detail (pops on unlatch) */}
              <mesh ref={claspRef} geometry={claspGeo} position={[HW * 0.94, -0.04, COVER_Z]} material={metalMat} />

              {/* sparkle glints */}
              <points>
                <bufferGeometry>
                  <bufferAttribute attach="attributes-position" args={[sparkPos, 3]} />
                </bufferGeometry>
                <pointsMaterial
                  ref={sparkMatRef}
                  map={sparkTex}
                  color={pal.spark}
                  size={0.05}
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
      </group>
    </>
  );
}
