import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeTextTexture } from "../text3d";
import { forRecipient } from "../../i18n";
import { makeRadialSprite } from "../sprites";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";

/* ---------- box + stage layout (a vertical column around the origin) ---------- */
const BOX_W = 1.28;
const BOX_H = 0.52;
const BOX_D = 0.92;
const BOX_CY = -0.54;
const RIM_Y = BOX_CY + BOX_H / 2; //  -0.28
const HALF_D = BOX_D / 2; //  0.46
const HINGE_Z = -HALF_D; //  back-top hinge line
const OPEN_ANGLE = 1.98; //  ~113° lid opening
const STAGE_Y = RIM_Y + 0.02; //  velvet stage top
const MIRROR_Y = STAGE_Y + 0.012;
const FIG_UP = MIRROR_Y + 0.004; //  figurine base when risen
const FIG_DOWN = FIG_UP - 0.08; //  figurine base when tucked

/* ---------- opening timeline (seconds) ---------- */
const CLASP_DUR = 0.3;
const LID_START = 0.25;
const LID_DUR = 1.15;
const FIG_START = 0.7;
const FIG_DUR = 1.35;
const SPARK_START = 0.9;
const SPARK_DUR = 1.4;
const OPEN_DONE = 3.4;

/* ---------- figurine palettes keyed by the `figurine` variant value ---------- */
interface FigPalette {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
}
const FIG_PALETTES: Record<string, FigPalette> = {
  ballerina: { color: "#f4ece0", emissive: "#2a2118", emissiveIntensity: 0.15, roughness: 0.32, metalness: 0.05 },
  heart: { color: "#d21742", emissive: "#3a0410", emissiveIntensity: 0.28, roughness: 0.14, metalness: 0.16 },
  moon: { color: "#eef0f6", emissive: "#232833", emissiveIntensity: 0.22, roughness: 0.2, metalness: 0.22 },
};

/* ---------- procedural figurine geometry (module level, shared) ---------- */
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
    depth: 12,
    bevelEnabled: true,
    bevelThickness: 5,
    bevelSize: 5,
    bevelSegments: 2,
    steps: 1,
  });
  geo.center();
  geo.rotateZ(Math.PI); // the classic heart shape is drawn upside-down
  geo.scale(0.0052, 0.0052, 0.0052); // ~0.5 tall
  return geo;
}
const heartGeo = buildHeartGeo();

// Crescent moon = a lune between an outer circle (left rim) and an offset inner
// circle (concave right edge), extruded with a soft bevel.
function buildMoonGeo(scaleMul: number): THREE.ExtrudeGeometry {
  const R = 0.3;
  const r = 0.26;
  const cx = 0.15;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, R, Math.PI / 3, (Math.PI * 5) / 3, false); // outer left rim: top -> bottom via left
  shape.absarc(cx, 0, r, (Math.PI * 3) / 2, Math.PI / 2, true); // concave inner edge: bottom -> top via left
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 2,
    steps: 1,
  });
  geo.center();
  geo.scale(scaleMul, scaleMul, 1);
  return geo;
}
const moonGeo = buildMoonGeo(1);
const moonRimGeo = buildMoonGeo(1.13);

/* ---------- sparkle ring that orbits the figurine ---------- */
const SPARKLE_COUNT = 80;
function buildSparkles(): Float32Array {
  const rand = mulberry32(90210);
  const pos = new Float32Array(SPARKLE_COUNT * 3);
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const a = rand() * Math.PI * 2;
    const rr = 0.24 + rand() * 0.13;
    pos[i * 3] = Math.cos(a) * rr;
    pos[i * 3 + 1] = 0.03 + rand() * 0.44;
    pos[i * 3 + 2] = Math.sin(a) * rr;
  }
  return pos;
}
const sparklePos = buildSparkles();
const sparkleTex = makeRadialSprite(48, [
  [0, "rgba(255,246,214,1)"],
  [0.4, "rgba(255,224,150,0.7)"],
  [1, "rgba(255,214,120,0)"],
]);

/* ---------- WebAudio music-box loop (gentle 3/4 pentatonic waltz) ---------- */
const SECONDS_PER_BEAT = 60 / 90; // ~90 BPM
const LOOKAHEAD = 0.4; // schedule this far ahead (s)
// E minor pentatonic (E5 G5 A5 B5 D6), a 12-note waltz phrase.
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;
const B5 = 987.77;
const D6 = 1174.66;
const MELODY = [E5, G5, B5, A5, G5, D6, B5, A5, G5, E5, A5, B5];

interface AudioState {
  ctx: AudioContext;
  master: GainNode;
  intervalId: number;
  nextNoteTime: number;
  startTime: number;
  noteIndex: number;
}

function createAudioContext(): AudioContext | null {
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

function scheduleNote(ctx: AudioContext, master: GainNode, freq: number, time: number, accent: boolean) {
  const peak = accent ? 1 : 0.72;
  // fundamental: 5ms attack, ~0.9s exponential decay
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, time);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0008, time + 0.9);
  osc.connect(g);
  g.connect(master);
  osc.start(time);
  osc.stop(time + 1.0);
  // quieter octave-up shimmer
  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(freq * 2, time);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, time);
  g2.gain.exponentialRampToValueAtTime(peak * 0.32, time + 0.005);
  g2.gain.exponentialRampToValueAtTime(0.0005, time + 0.7);
  osc2.connect(g2);
  g2.connect(master);
  osc2.start(time);
  osc2.stop(time + 0.75);
}

function runScheduler(a: AudioState) {
  while (a.nextNoteTime < a.ctx.currentTime + LOOKAHEAD) {
    const idx = a.noteIndex % MELODY.length;
    scheduleNote(a.ctx, a.master, MELODY[idx], a.nextNoteTime, idx % 3 === 0);
    a.nextNoteTime += SECONDS_PER_BEAT;
    a.noteIndex += 1;
  }
}

const TRIM = "#d9a441";

export default function MusicBoxScene({ variants, phase, recipientName, message, lang, onOpenComplete }: SceneProps) {
  const figPalette = FIG_PALETTES[variants.figurine] ?? FIG_PALETTES.ballerina;

  /* variant material: rebuilds live on variant change, disposed on cleanup */
  const figMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: figPalette.color,
        emissive: figPalette.emissive,
        emissiveIntensity: figPalette.emissiveIntensity,
        roughness: figPalette.roughness,
        metalness: figPalette.metalness,
      }),
    [figPalette],
  );
  useEffect(() => () => figMat.dispose(), [figMat]);

  /* engraved message on the inside of the lid */
  const lidText = message.trim() || forRecipient(lang, recipientName);
  const lidData = useMemo(() => {
    const t = makeTextTexture(lidText, {
      fontSize: 62,
      fontWeight: "600",
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: "#f6d989",
      glow: 10,
      glowColor: "#caa03a",
      maxWidthPx: 62 * 8,
      lineHeight: 1.32,
      lang,
    });
    const baseW = 1.0;
    let w = baseW;
    let h = baseW * t.aspect;
    const maxH = 0.78;
    if (h > maxH) {
      const s = maxH / h;
      w *= s;
      h = maxH;
    }
    return { tex: t.texture, w, h };
  }, [lidText, lang]);
  useEffect(() => {
    const d = lidData;
    return () => d.tex.dispose();
  }, [lidData]);

  /* recipient name plaque on the front of the box */
  const nameData = useMemo(() => {
    const s = recipientName.trim();
    if (!s) return null;
    const t = makeTextTexture(s, {
      fontSize: 54,
      fontWeight: "600",
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: "#f0d089",
      glow: 6,
      glowColor: "#b8862e",
      lang,
    });
    const baseW = 0.6;
    let w = baseW;
    let h = baseW * t.aspect;
    const maxH = 0.15;
    if (h > maxH) {
      const sc = maxH / h;
      w *= sc;
      h = maxH;
    }
    return { tex: t.texture, w, h };
  }, [recipientName, lang]);
  useEffect(() => {
    const d = nameData;
    return () => d?.tex.dispose();
  }, [nameData]);

  /* refs mutated in useFrame */
  const rootRef = useRef<THREE.Group>(null);
  const lidRef = useRef<THREE.Group>(null);
  const figRiseRef = useRef<THREE.Group>(null);
  const figSpinRef = useRef<THREE.Group>(null);
  const sparkleRef = useRef<THREE.Points>(null);
  const sparkleMatRef = useRef<THREE.PointsMaterial>(null);
  const claspRef = useRef<THREE.Group>(null);
  const claspMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const glowRef = useRef<THREE.PointLight>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  /* audio: starts on first "opening", plays through "revealed", suspends otherwise */
  const audioRef = useRef<AudioState | null>(null);
  useEffect(() => {
    const shouldPlay = phase === "opening" || phase === "revealed";
    if (!shouldPlay) {
      const a = audioRef.current;
      if (a) {
        if (a.intervalId) {
          clearInterval(a.intervalId);
          a.intervalId = 0;
        }
        if (a.ctx.state === "running") a.ctx.suspend().catch(() => {});
      }
      return;
    }
    let a = audioRef.current;
    if (!a) {
      const ctx = createAudioContext();
      if (!ctx) return;
      const master = ctx.createGain();
      master.gain.value = 0.12;
      master.connect(ctx.destination);
      a = { ctx, master, intervalId: 0, nextNoteTime: 0, startTime: 0, noteIndex: 0 };
      audioRef.current = a;
    }
    const aa = a;
    aa.ctx.resume().catch(() => {});
    if (!aa.intervalId) {
      aa.nextNoteTime = aa.ctx.currentTime + 0.12;
      aa.startTime = aa.nextNoteTime;
      aa.noteIndex = 0;
      aa.intervalId = window.setInterval(() => runScheduler(aa), 200);
    }
  }, [phase]);
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        if (a.intervalId) clearInterval(a.intervalId);
        a.ctx.close().catch(() => {});
        audioRef.current = null;
      }
    };
  }, []);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const el = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    // Beat envelope (1 at each note onset, decaying) — synced to the audio clock.
    let beat: number;
    const a = audioRef.current;
    if (a && (phase === "opening" || phase === "revealed") && a.ctx.state === "running") {
      const since = a.ctx.currentTime - a.startTime;
      const ph = ((since % SECONDS_PER_BEAT) + SECONDS_PER_BEAT) % SECONDS_PER_BEAT;
      beat = since >= -0.05 ? Math.exp(-ph * 5.5) : 0;
    } else {
      beat = 0;
    }

    // Lid hinges open with an ease-out overshoot bounce.
    let lidP: number;
    if (phase === "sealed") lidP = 0;
    else if (phase === "opening") lidP = easeOutBack(clamp01((t - LID_START) / LID_DUR));
    else lidP = 1;
    if (lidRef.current) lidRef.current.rotation.x = -OPEN_ANGLE * lidP;

    // Figurine rises + grows out of the mirror, then keeps spinning.
    let figP: number;
    if (phase === "sealed") figP = 0;
    else if (phase === "opening") figP = easeOutCubic(clamp01((t - FIG_START) / FIG_DUR));
    else figP = 1;
    if (figRiseRef.current) {
      figRiseRef.current.position.y = FIG_DOWN + (FIG_UP - FIG_DOWN) * figP;
      figRiseRef.current.scale.setScalar(Math.max(figP, 0.0001));
      figRiseRef.current.visible = figP > 0.002;
    }
    if (figSpinRef.current) {
      figSpinRef.current.rotation.y += dt * (phase === "sealed" ? 0 : 0.6);
    }

    // Sparkle ring blooms during opening, orbits, and pulses to the beat.
    let sparkP: number;
    if (phase === "sealed") sparkP = 0;
    else if (phase === "opening") sparkP = smooth(clamp01((t - SPARK_START) / SPARK_DUR));
    else sparkP = 1;
    if (sparkleRef.current) {
      sparkleRef.current.rotation.y += dt * 0.5;
      sparkleRef.current.scale.setScalar(Math.max(sparkP, 0.0001));
      sparkleRef.current.visible = sparkP > 0.002;
    }
    if (sparkleMatRef.current) {
      const idle = 0.35 + Math.sin(el * 1.8) * 0.12;
      const pulse = phase === "opening" || phase === "revealed" ? beat : idle;
      sparkleMatRef.current.size = 0.05 + pulse * 0.05;
      sparkleMatRef.current.opacity = sparkP * (0.4 + pulse * 0.5);
    }

    // Clasp flicks open at the very start of the reveal; glints while sealed.
    let claspOpen: number;
    if (phase === "sealed") claspOpen = 0;
    else if (phase === "opening") claspOpen = easeOutCubic(clamp01(t / CLASP_DUR));
    else claspOpen = 1;
    if (claspRef.current) claspRef.current.rotation.x = claspOpen * 0.55;
    if (claspMatRef.current) {
      claspMatRef.current.emissiveIntensity =
        phase === "sealed" ? 0.35 + Math.max(0, Math.sin(el * 2.4)) * 0.5 : 0.35;
    }

    // Once-only completion latch.
    if (phase === "opening" && t > OPEN_DONE && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }

    // Gentle idle sway (never during the unwrap).
    if (rootRef.current) {
      const amp = phase === "preview" ? 0.12 : phase === "revealed" ? 0.09 : phase === "sealed" ? 0.03 : 0;
      rootRef.current.rotation.y = Math.sin(el * 0.4) * amp;
    }

    // Lighting: dim + inviting while sealed, warm and open otherwise.
    const dim = phase === "sealed";
    if (ambientRef.current)
      ambientRef.current.intensity = lerp(ambientRef.current.intensity, dim ? 0.16 : 0.42, Math.min(1, dt * 3));
    if (keyRef.current)
      keyRef.current.intensity = lerp(keyRef.current.intensity, dim ? 0.32 : 0.95, Math.min(1, dt * 3));
    if (glowRef.current) {
      const base = dim ? 0.22 : phase === "preview" ? 0.55 : 0.62;
      const pulse = dim ? Math.sin(el * 2.2) * 0.12 : beat * 0.5;
      glowRef.current.intensity = base + pulse;
    }
  });

  const isHeart = variants.figurine === "heart";
  const isMoon = variants.figurine === "moon";

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.35, 4.9]} fov={40} onUpdate={(c) => c.lookAt(0, -0.08, 0)} />
      <ambientLight ref={ambientRef} intensity={0.42} color="#4a3742" />
      <directionalLight ref={keyRef} position={[2.6, 4, 3.2]} intensity={0.95} color="#ffe7cf" />
      <pointLight ref={glowRef} position={[0, 0.35, 0.5]} intensity={0.6} color="#ffcf8a" distance={5} />
      <pointLight position={[-2.6, 1.4, -2.2]} intensity={0.4} color="#7f93c8" distance={9} />

      {/* dark mood floor + backdrop (never scene.background) */}
      <mesh position={[0, -0.83, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.4, 48]} />
        <meshStandardMaterial color="#160d13" roughness={0.65} metalness={0.25} />
      </mesh>
      <mesh position={[0, 0.4, -3]}>
        <planeGeometry args={[16, 11]} />
        <meshStandardMaterial color="#0d0810" roughness={1} metalness={0} />
      </mesh>

      <group ref={rootRef}>
        {/* ---- ornate box body (stacked boxes give a beveled silhouette) ---- */}
        <mesh position={[0, BOX_CY - BOX_H / 2 + 0.03, 0]}>
          <boxGeometry args={[BOX_W + 0.08, 0.1, BOX_D + 0.08]} />
          <meshStandardMaterial color="#3a1410" roughness={0.5} metalness={0.28} />
        </mesh>
        <mesh position={[0, BOX_CY, 0]}>
          <boxGeometry args={[BOX_W, BOX_H, BOX_D]} />
          <meshStandardMaterial color="#5a1a14" roughness={0.28} metalness={0.35} />
        </mesh>
        <mesh position={[0, RIM_Y - 0.02, 0]}>
          <boxGeometry args={[BOX_W + 0.03, 0.06, BOX_D + 0.03]} />
          <meshStandardMaterial color="#6b241a" roughness={0.22} metalness={0.4} />
        </mesh>

        {/* gold rim frame */}
        <mesh position={[0, RIM_Y + 0.01, HALF_D - 0.02]}>
          <boxGeometry args={[BOX_W, 0.04, 0.045]} />
          <meshStandardMaterial color={TRIM} roughness={0.25} metalness={0.9} />
        </mesh>
        <mesh position={[0, RIM_Y + 0.01, -HALF_D + 0.02]}>
          <boxGeometry args={[BOX_W, 0.04, 0.045]} />
          <meshStandardMaterial color={TRIM} roughness={0.25} metalness={0.9} />
        </mesh>
        <mesh position={[BOX_W / 2 - 0.02, RIM_Y + 0.01, 0]}>
          <boxGeometry args={[0.045, 0.04, BOX_D]} />
          <meshStandardMaterial color={TRIM} roughness={0.25} metalness={0.9} />
        </mesh>
        <mesh position={[-BOX_W / 2 + 0.02, RIM_Y + 0.01, 0]}>
          <boxGeometry args={[0.045, 0.04, BOX_D]} />
          <meshStandardMaterial color={TRIM} roughness={0.25} metalness={0.9} />
        </mesh>

        {/* gold feet */}
        {[
          [BOX_W / 2 - 0.05, BOX_D / 2 - 0.05],
          [-BOX_W / 2 + 0.05, BOX_D / 2 - 0.05],
          [BOX_W / 2 - 0.05, -BOX_D / 2 + 0.05],
          [-BOX_W / 2 + 0.05, -BOX_D / 2 + 0.05],
        ].map(([fx, fz], i) => (
          <mesh key={`foot-${i}`} position={[fx, BOX_CY - BOX_H / 2 - 0.02, fz]}>
            <cylinderGeometry args={[0.05, 0.06, 0.06, 12]} />
            <meshStandardMaterial color={TRIM} roughness={0.3} metalness={0.85} />
          </mesh>
        ))}

        {/* name plaque on the front */}
        {nameData && (
          <mesh position={[0, BOX_CY - 0.01, HALF_D + 0.006]}>
            <planeGeometry args={[nameData.w, nameData.h]} />
            <meshBasicMaterial map={nameData.tex} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        )}

        {/* front clasp (glints + flicks) */}
        <group ref={claspRef} position={[0, RIM_Y - 0.01, HALF_D + 0.015]}>
          <mesh position={[0, 0.01, 0]}>
            <boxGeometry args={[0.13, 0.1, 0.03]} />
            <meshStandardMaterial
              ref={claspMatRef}
              color="#f0c96b"
              metalness={0.95}
              roughness={0.2}
              emissive="#ffcf6b"
              emissiveIntensity={0.35}
            />
          </mesh>
        </group>

        {/* ---- velvet stage + mirror ---- */}
        <mesh position={[0, STAGE_Y, 0]}>
          <boxGeometry args={[BOX_W - 0.13, 0.03, BOX_D - 0.13]} />
          <meshStandardMaterial color="#3a0812" roughness={0.92} metalness={0} />
        </mesh>
        <mesh position={[0, MIRROR_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.3, 0.3, 0.012, 40]} />
          <meshStandardMaterial color="#dfe7ef" roughness={0.05} metalness={1} />
        </mesh>

        {/* ---- figurine + orbiting sparkle ring ---- */}
        <group ref={figRiseRef} position={[0, FIG_UP, 0]}>
          <group ref={figSpinRef}>
            {isHeart ? (
              <mesh geometry={heartGeo} material={figMat} position={[0, 0.235, 0]} />
            ) : isMoon ? (
              <group position={[0, 0.26, 0]} rotation={[0, 0, 0.15]}>
                <mesh geometry={moonRimGeo} position={[0, 0, -0.012]}>
                  <meshStandardMaterial color="#e8c266" metalness={0.9} roughness={0.28} />
                </mesh>
                <mesh geometry={moonGeo} material={figMat} />
              </group>
            ) : (
              <group>
                {/* column / legs */}
                <mesh material={figMat} position={[0, 0.12, 0]}>
                  <cylinderGeometry args={[0.03, 0.05, 0.24, 12]} />
                </mesh>
                {/* tutu (flared cone, wide base down) */}
                <mesh material={figMat} position={[0, 0.25, 0]}>
                  <coneGeometry args={[0.17, 0.11, 18]} />
                </mesh>
                {/* torso */}
                <mesh material={figMat} position={[0, 0.35, 0]}>
                  <cylinderGeometry args={[0.032, 0.052, 0.15, 12]} />
                </mesh>
                {/* head */}
                <mesh material={figMat} position={[0, 0.455, 0]}>
                  <sphereGeometry args={[0.052, 16, 16]} />
                </mesh>
                {/* hair bun */}
                <mesh material={figMat} position={[0, 0.5, -0.025]}>
                  <sphereGeometry args={[0.024, 10, 10]} />
                </mesh>
                {/* arms: torus-segment arcs raised overhead */}
                <mesh material={figMat} position={[0, 0.41, 0]} rotation={[0.2, 0, 0.35]}>
                  <torusGeometry args={[0.085, 0.011, 8, 20, Math.PI * 0.85]} />
                </mesh>
                <mesh material={figMat} position={[0, 0.41, 0]} rotation={[0.2, Math.PI, 0.35]}>
                  <torusGeometry args={[0.085, 0.011, 8, 20, Math.PI * 0.85]} />
                </mesh>
              </group>
            )}
          </group>

          {/* sparkle ring (sibling of the spinner so it orbits on its own) */}
          <points ref={sparkleRef}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[sparklePos, 3]} />
            </bufferGeometry>
            <pointsMaterial
              ref={sparkleMatRef}
              map={sparkleTex}
              color="#ffe6a8"
              size={0.06}
              sizeAttenuation
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </points>
        </group>

        {/* ---- hinged lid (pivots at the back rim) ---- */}
        <group ref={lidRef} position={[0, RIM_Y, HINGE_Z]}>
          {/* lid body */}
          <mesh position={[0, 0.06, HALF_D]}>
            <boxGeometry args={[BOX_W, 0.1, BOX_D]} />
            <meshStandardMaterial color="#5a1a14" roughness={0.26} metalness={0.36} />
          </mesh>
          {/* lid gold edge trim */}
          <mesh position={[0, 0.02, BOX_D - 0.02]}>
            <boxGeometry args={[BOX_W, 0.03, 0.04]} />
            <meshStandardMaterial color={TRIM} roughness={0.25} metalness={0.9} />
          </mesh>
          {/* engraved message on the inside face */}
          <mesh position={[0, 0.002, HALF_D + 0.02]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[lidData.w, lidData.h]} />
            <meshBasicMaterial map={lidData.tex} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      </group>
    </>
  );
}
