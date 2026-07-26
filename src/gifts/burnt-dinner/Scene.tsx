import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { resumeAudio, tone } from "../audio";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
const KITCHENS: Record<string, { wall: string; cloth: string; key: string; amb: number; fill: string }> = {
  cozy: { wall: "#2e211a", cloth: "#c9b394", key: "#ffd9a0", amb: 0.45, fill: "#8a5a3a" },
  marble: { wall: "#33353c", cloth: "#e6e4dd", key: "#f2f4ff", amb: 0.6, fill: "#6d7a92" },
  candlelit: { wall: "#1d1310", cloth: "#a88d6b", key: "#ff9f4a", amb: 0.28, fill: "#5a2f1c" },
};
/* What is under the dome — only ever a silhouette, since it is charcoal by the
   time anyone sees it: a squat roast, a tall cake, a wide flat tangle of pasta. */
const DISHES: Record<string, { r: number; h: number; seg: number }> = {
  roast: { r: 0.3, h: 0.16, seg: 14 },
  cake: { r: 0.26, h: 0.24, seg: 22 },
  pasta: { r: 0.34, h: 0.1, seg: 18 },
};

const TAU = Math.PI * 2;
const ACTION_W = 2.7;
const ACTION_H = 2.1;
const SMOKE_N = 130;
const PUFF_N = 46;

/* ---------- char: the burnt crust the message is legible in ---------- */
function buildChar(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1a1512";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(6421);
  // cracked crust: dark cells with hot cracks between them, like a thing left on
  for (let i = 0; i < 800; i++) {
    const v = 12 + rand() * 26;
    g.fillStyle = `rgb(${v + 8},${v},${v - 4})`;
    g.beginPath();
    g.arc(rand() * s, rand() * s, 6 + rand() * 22, 0, TAU);
    g.fill();
  }
  g.strokeStyle = "rgba(120,44,12,0.5)";
  for (let i = 0; i < 160; i++) {
    g.lineWidth = 1 + rand() * 2;
    const x = rand() * s;
    const y = rand() * s;
    const a = rand() * TAU;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * (10 + rand() * 40), y + Math.sin(a) * (10 + rand() * 40));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}
const CHAR = buildChar();
const SMOKE_TEX = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.85)"],
  [0.45, "rgba(255,255,255,0.32)"],
  [1, "rgba(255,255,255,0)"],
]);
const HINT = makeRadialSprite(64);

/** The takeout menu, with a number circled and the reservation in both names. */
function buildMenu(sender: string, recipient: string, lang: Lang): THREE.CanvasTexture {
  const w = 420;
  const h = 560;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f7f0e2";
  g.fillRect(0, 0, w, h);
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "Georgia, serif";
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.fillStyle = "#8c2f22";
  g.fillRect(0, 0, w, 74);
  g.fillStyle = "#fbf5e8";
  g.font = `700 34px ${fam}`;
  g.fillText(ar ? "توصيل" : "TAKEOUT", w / 2, 48);
  g.fillStyle = "#3a332a";
  g.font = `400 19px ${fam}`;
  const rand = mulberry32(311);
  for (let i = 0; i < 9; i++) {
    const y = 122 + i * 34;
    g.textAlign = ar ? "right" : "left";
    g.fillText("• • • • • • • •".slice(0, 8 + Math.floor(rand() * 8)), ar ? w - 44 : 44, y);
    g.textAlign = ar ? "left" : "right";
    g.fillText(`${8 + Math.floor(rand() * 40)}`, ar ? 44 : w - 44, y);
  }
  // the number, circled by hand and slightly wonky
  g.textAlign = "center";
  g.fillStyle = "#26221d";
  g.font = `700 30px ${fam}`;
  g.fillText("0800 · 1 1 1 · 900", w / 2, 462);
  g.strokeStyle = "#c0392b";
  g.lineWidth = 4;
  g.beginPath();
  g.ellipse(w / 2, 452, 156, 34, 0.04, 0, TAU);
  g.stroke();
  g.font = `italic 400 20px ${fam}`;
  g.fillStyle = "#6d5f4a";
  g.fillText(ar ? `الحجز باسم: ${recipient || "—"} و${sender || "—"}` : `reservation: ${recipient || "—"} & ${sender || "—"}`, w / 2, 520);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- opening ---------- */
const LIFT_TRAVEL = 0.75; // world units of drag that get the dome off
const POUR = 1.9; // the smoke, all of it, far more than the dish can account for
const CLEAR_END = 4.6;
const CHIRP_1 = 0.55;
const CHIRP_2 = 0.95;
const MENU_AT = 3.4;
const POST_END = 5.6;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function BurntDinnerScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const kit = KITCHENS[variants.kitchen] ?? KITCHENS.cozy;
  const dish = DISHES[variants.dish] ?? DISHES.roast;

  /* Written in the char. Legible, and apologetic. */
  const text = useMemo(() => {
    const body = message.trim() || forRecipient(lang, recipientName);
    const t = makeTextTexture(body, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "600",
      fontSize: 64,
      color: "#ffb877",
      glow: 22,
      glowColor: "#ff6a1e",
      maxWidthPx: 64 * 8,
      lineHeight: 1.3,
      padding: 24,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 1.02, 0.68) };
  }, [message, recipientName, lang]);
  useEffect(() => () => text.t.texture.dispose(), [text]);

  const menu = useMemo(() => buildMenu(senderName, recipientName, lang), [senderName, recipientName, lang]);
  useEffect(() => () => menu.dispose(), [menu]);

  /* Curl-noise smoke, the `magic-lamp` recipe — but on the CPU, because this one
     never has to condense into glyphs and 176 points do not need a shader. */
  const smoke = useMemo(() => {
    const rand = mulberry32(8123);
    const mk = (n: number) => {
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        seed[i * 3] = rand(); // birth offset along the life cycle
        seed[i * 3 + 1] = rand() * TAU; // swirl phase
        seed[i * 3 + 2] = 0.5 + rand(); // rise rate
      }
      return { pos, seed, n };
    };
    return { fine: mk(SMOKE_N), fat: mk(PUFF_N) };
  }, []);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const g = useRef({ lift: 0, offAt: -1, down: false, py: 0, touched: false, chirped: 0 });
  useEffect(() => {
    if (phase === "opening") g.current = { lift: 0, offAt: -1, down: false, py: 0, touched: false, chirped: 0 };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const clocheRef = useRef<THREE.Group>(null);
  const fineRef = useRef<THREE.Points>(null);
  const fatRef = useRef<THREE.Points>(null);
  const fineMatRef = useRef<THREE.PointsMaterial>(null);
  const fatMatRef = useRef<THREE.PointsMaterial>(null);
  const charMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const textMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const menuRef = useRef<THREE.Group>(null);
  const menuMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const flameRefs = useRef<(THREE.Mesh | null)[]>([]);
  const emberRef = useRef<THREE.PointLight>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.offAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.current.down = true;
    g.current.touched = true;
    g.current.py = ev.point.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening" || c.lift >= 1) return;
    ev.stopPropagation();
    c.lift = clamp01(c.lift + (ev.point.y - c.py) / LIFT_TRAVEL);
    c.py = ev.point.y;
  };
  const stop = () => {
    g.current.down = false;
  };

  /** One curl-ish step: divergence-free trig curl, evaluated per point per frame. */
  const stepSmoke = (
    set: { pos: Float32Array; seed: Float32Array; n: number },
    pts: THREE.Points | null,
    t: number,
    spread: number,
    height: number,
  ) => {
    if (!pts) return;
    const arr = pts.geometry.attributes.position;
    for (let i = 0; i < set.n; i++) {
      // Every position is a closed form of the clock, so a replay is identical.
      const age = ((t * 0.42 * set.seed[i * 3 + 2] + set.seed[i * 3]) % 1) * 3.2;
      const ph = set.seed[i * 3 + 1];
      const rise = height * (1 - Math.exp(-age / 1.5));
      const rad = spread * (0.1 + age * 0.42);
      const cx = Math.cos(ph + age * 1.1) * rad;
      const cz = Math.sin(ph + age * 1.1) * rad * 0.7;
      // curl of a trig potential — it folds instead of just thinning out
      const q = age * 0.9 + ph;
      arr.setXYZ(
        i,
        cx + Math.sin(q) * 0.06 * age - Math.cos(q * 2.3) * 0.03 * age,
        rise + Math.sin(q * 1.7) * 0.04 * age,
        cz + Math.cos(q) * 0.05 * age,
      );
    }
    arr.needsUpdate = true;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = g.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.6, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    if (phase === "opening" && c.lift >= 1 && c.offAt < 0) {
      c.offAt = tRef.current;
      tone(180, { type: "sine", seconds: 0.7, gain: 0.14 });
    }

    const post = phase === "revealed" ? POST_END : c.offAt >= 0 ? tRef.current - c.offAt : -1;
    // The alarm, off-screen, twice. It is worth more than any of the geometry.
    if (post >= 0 && phase === "opening") {
      if (c.chirped === 0 && post > CHIRP_1) {
        c.chirped = 1;
        tone(3150, { type: "square", seconds: 0.11, gain: 0.2 });
      } else if (c.chirped === 1 && post > CHIRP_2) {
        c.chirped = 2;
        tone(3150, { type: "square", seconds: 0.11, gain: 0.2 });
      }
    }

    /* ---- the dome ---- */
    const lift = phase === "sealed" ? 0 : phase === "opening" ? Math.max(c.lift, post > 0 ? 1 : 0) : 1;
    if (clocheRef.current) {
      const away = post < 0 ? 0 : easeOutCubic(clamp01(post / 1.5));
      clocheRef.current.position.y = 0.06 + lift * 0.42 + away * 0.5;
      clocheRef.current.position.x = away * 0.95;
      clocheRef.current.rotation.z = away * 0.5;
      clocheRef.current.visible = phase !== "revealed" && away < 0.99;
    }

    /* ---- the smoke: a thread while sealed, a great deal of it once lifted ---- */
    const pour = phase === "revealed" ? 0 : post < 0 ? 0.05 : Math.exp(-Math.max(0, post - POUR) / 1.5) * smooth(clamp01(post / 0.35));
    const heavy = post >= 0 && post < CLEAR_END;
    stepSmoke(smoke.fine, fineRef.current, e, heavy ? 0.55 : 0.1, heavy ? 1.5 : 0.7);
    stepSmoke(smoke.fat, fatRef.current, e * 0.7, heavy ? 0.75 : 0.12, heavy ? 1.25 : 0.6);
    if (fineMatRef.current) fineMatRef.current.opacity = phase === "preview" ? 0.1 : 0.5 * pour + (post < 0 ? 0.08 : 0);
    if (fatMatRef.current) fatMatRef.current.opacity = phase === "preview" ? 0.06 : 0.32 * pour;

    /* ---- what is left of dinner ---- */
    const cleared = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01((post - POUR) / (CLEAR_END - POUR)));
        // Embers in the cracks, not a hot coal: any real emissive here and the char
    // reads as a bright orange dome and the word "cremated" stops landing.
    if (charMatRef.current) charMatRef.current.emissiveIntensity = 0.05 + 0.03 * (1 + Math.sin(e * 1.3)) * cleared;
    if (textMatRef.current) textMatRef.current.opacity = phase === "preview" ? 0.9 : cleared;
    if (emberRef.current) emberRef.current.intensity = 0.18 + cleared * 0.22 + Math.sin(e * 2.2) * 0.06;

    /* ---- the menu, underneath the plate, where it was always going to be ---- */
    if (menuRef.current && menuMatRef.current) {
      const k = phase === "preview" ? 0 : post < 0 ? 0 : smooth(clamp01((post - MENU_AT) / 1.3));
      menuRef.current.visible = k > 0.01;
      menuRef.current.position.x = lerp(0.1, 0.74, easeOutCubic(k));
      menuRef.current.rotation.z = lerp(0.5, 0.16, k);
      menuMatRef.current.opacity = k;
    }

    /* ---- two candles. One of them has gone out. ---- */
    for (let i = 0; i < 2; i++) {
      const f = flameRefs.current[i];
      if (!f) continue;
      // The right one is put out by whatever came off the plate.
      const out = i === 1 && (phase === "revealed" || (post >= 0 && post > 1.2));
      f.visible = !out;
      const flick = 1 + Math.sin(e * (9 + i * 3)) * 0.18;
      f.scale.set(flick * 0.8, flick, flick * 0.8);
    }

    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.32 + 0.2 * Math.sin(e * 2.7) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const candle = (x: number, i: number) => (
    <group key={i} position={[x, -0.2, -0.24]}>
      <mesh>
        <cylinderGeometry args={[0.035, 0.04, 0.34, 12]} />
        <meshStandardMaterial color="#efe6d2" roughness={0.7} />
      </mesh>
      <mesh
        ref={(m) => {
          flameRefs.current[i] = m;
        }}
        position={[0, 0.22, 0]}
      >
        <coneGeometry args={[0.024, 0.08, 8]} />
        <meshBasicMaterial color="#ffcf72" toneMapped={false} />
      </mesh>
    </group>
  );

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.34, 2.05]} fov={44} onUpdate={(c) => c.lookAt(0, -0.16, 0)} />
      <ambientLight intensity={kit.amb} color={kit.fill} />
      <directionalLight position={[1.2, 2.2, 1.8]} intensity={1.15} color={kit.key} />
      <pointLight ref={emberRef} position={[0, -0.05, 0.5]} intensity={0.5} color="#ff7a30" distance={3.4} decay={1.6} />

      <mesh position={[0, 0.5, -1.6]}>
        <planeGeometry args={[14, 9]} />
        <meshStandardMaterial color={kit.wall} roughness={0.95} />
      </mesh>

      <group ref={fitRef}>
        {/* the table, set properly */}
        <mesh position={[0, -0.42, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[3.2, 2.0]} />
          <meshStandardMaterial color={kit.cloth} roughness={0.92} />
        </mesh>
        {/* folded napkins */}
        {[-0.78, 0.78].map((x, i) => (
          <mesh key={i} position={[x, -0.415, 0.32]} rotation={[-Math.PI / 2, 0, i ? 0.1 : -0.1]}>
            <planeGeometry args={[0.22, 0.3]} />
            <meshStandardMaterial color="#f2ece0" roughness={0.9} />
          </mesh>
        ))}
        {candle(-0.62, 0)}
        {candle(0.62, 1)}

        {/* the plate */}
        <mesh position={[0, -0.4, 0.02]}>
          <cylinderGeometry args={[0.46, 0.44, 0.03, 40]} />
          <meshStandardMaterial color="#f4efe6" roughness={0.32} />
        </mesh>

        {/* dinner. It is cremated. (The squash is on the mesh: `scale` on a
            geometry element would collide with BufferGeometry.scale(), the method.) */}
        <mesh position={[0, -0.34, 0.02]} scale={[1, dish.h / dish.r, 1]}>
          <sphereGeometry args={[dish.r, dish.seg, 12]} />
          <meshStandardMaterial
            ref={charMatRef}
            map={CHAR}
            color="#2b241f"
            emissive="#ff5a12"
            emissiveIntensity={0.05}
            roughness={0.95}
          />
        </mesh>
        {/* the message, written in the char */}
        <mesh position={[0, -0.16, 0.22]} rotation={[-0.55, 0, 0]}>
          <planeGeometry args={text.size} />
          <meshBasicMaterial ref={textMatRef} map={text.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>

        {/* the takeout menu, from under the plate */}
        <group ref={menuRef} position={[0.1, -0.405, 0.36]} rotation={[-Math.PI / 2, 0, 0.5]} visible={false}>
          <mesh>
            <planeGeometry args={[0.52, 0.7]} />
            <meshBasicMaterial ref={menuMatRef} map={menu} transparent opacity={0} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        </group>

        {/* the smoke, in two grades */}
        <group position={[0, -0.28, 0.02]}>
          <points ref={fatRef}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[smoke.fat.pos, 3]} />
            </bufferGeometry>
            <pointsMaterial ref={fatMatRef} map={SMOKE_TEX} color="#4a4038" size={0.66} sizeAttenuation transparent opacity={0} depthWrite={false} />
          </points>
          <points ref={fineRef}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[smoke.fine.pos, 3]} />
            </bufferGeometry>
            <pointsMaterial ref={fineMatRef} map={SMOKE_TEX} color="#6d6157" size={0.3} sizeAttenuation transparent opacity={0} depthWrite={false} />
          </points>
        </group>

        {/* the cloche */}
        <group ref={clocheRef} position={[0, 0.06, 0.02]}>
          <mesh>
            <sphereGeometry args={[0.5, 34, 20, 0, TAU, 0, Math.PI / 2]} />
            <meshStandardMaterial color="#c9ced6" roughness={0.14} metalness={0.96} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, 0.5, 0]}>
            <sphereGeometry args={[0.055, 14, 12]} />
            <meshStandardMaterial color="#dfe4ea" roughness={0.12} metalness={0.96} />
          </mesh>
          <mesh position={[0, 0.5, 0]}>
            <planeGeometry args={[0.6, 0.6]} />
            <meshBasicMaterial ref={hintMatRef} map={HINT} color="#ffe3b0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 1]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
