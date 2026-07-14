import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { clamp01, easeOutCubic, mulberry32, smooth } from "../math";

/* ---------- palettes (keyed by frosting value) ---------- */
const PALETTES: Record<string, { frosting: string; sponge: string; drip: string; plate: string }> = {
  chocolate: { frosting: "#5a3320", sponge: "#7a5230", drip: "#3d1f10", plate: "#e9e2d6" },
  strawberry: { frosting: "#e8879c", sponge: "#f2d3c2", drip: "#cf5f7a", plate: "#fff2f5" },
  vanilla: { frosting: "#f3e2b8", sponge: "#e6c684", drip: "#e3cf98", plate: "#fbf5e8" },
};

/* ---------- module-level constants / textures ---------- */
const FLAME_Y = 0.6;
const CANDLE_H = 0.6;
const CONFETTI_N = 400;
const dummy = new THREE.Object3D();
const dcol = new THREE.Color();
// Toggling raycast between the real mesh impl and a no-op enables/disables a
// hit sphere: three r185 raycasting ignores `visible`, so opacity/visibility
// alone can't stop an extinguished flame's sphere from swallowing taps.
const meshRaycast = THREE.Mesh.prototype.raycast;
const noRaycast: THREE.Mesh["raycast"] = () => {};

// warm radial flame sprite (tinted per-material).
const flameTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,1)"],
  [0.3, "rgba(255,222,150,0.9)"],
  [0.65, "rgba(255,140,40,0.35)"],
  [1, "rgba(255,80,0,0)"],
]);
// soft gray smoke puff.
const smokeTex = makeRadialSprite(48, [
  [0, "rgba(255,255,255,0.9)"],
  [0.5, "rgba(255,255,255,0.4)"],
  [1, "rgba(255,255,255,0)"],
]);

// candy-cane striped candle texture (canvas-generated).
function makeCandleTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fbf3ee";
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = "#e0566b";
  g.lineWidth = 9;
  for (let i = -64; i < 128; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 64, 64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}
const candleTex = makeCandleTexture();

// Shared across all 24 candles — per-candle inline materials/geometries would
// create ~120 duplicate GPU objects.
const candleBodyGeo = new THREE.CylinderGeometry(0.045, 0.05, CANDLE_H, 12);
const candleBodyMat = new THREE.MeshStandardMaterial({ map: candleTex, roughness: 0.5 });
const wickGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6);
const wickMat = new THREE.MeshStandardMaterial({ color: "#2a2320", roughness: 0.9 });
const hitGeo = new THREE.SphereGeometry(0.28, 8, 8);
const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

// confetti per-instance kinematics (deterministic).
function buildConfetti() {
  const rand = mulberry32(4242);
  const vel = new Float32Array(CONFETTI_N * 3);
  const spin = new Float32Array(CONFETTI_N * 3);
  const col = new Float32Array(CONFETTI_N * 3);
  const phase = new Float32Array(CONFETTI_N);
  const palette = [
    [1, 0.35, 0.42],
    [1, 0.82, 0.3],
    [0.42, 0.8, 1],
    [0.58, 1, 0.55],
    [0.82, 0.5, 1],
    [1, 0.6, 0.85],
  ];
  for (let i = 0; i < CONFETTI_N; i++) {
    const ang = rand() * Math.PI * 2;
    const out = 1.0 + rand() * 2.4;
    vel[i * 3] = Math.cos(ang) * out;
    vel[i * 3 + 1] = 3.2 + rand() * 3.0;
    vel[i * 3 + 2] = Math.sin(ang) * out;
    spin[i * 3] = (rand() - 0.5) * 12;
    spin[i * 3 + 1] = (rand() - 0.5) * 12;
    spin[i * 3 + 2] = (rand() - 0.5) * 12;
    const cc = palette[Math.floor(rand() * palette.length)];
    col[i * 3] = cc[0];
    col[i * 3 + 1] = cc[1];
    col[i * 3 + 2] = cc[2];
    phase[i] = rand() * 0.18;
  }
  return { vel, spin, col, phase };
}
const CONFETTI = buildConfetti();

/* ---------- candle layout: rings by count ---------- */
function candlePositions(n: number): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  const ring = (count: number, radius: number, ph: number) => {
    for (let i = 0; i < count; i++) {
      const a = ph + (i / count) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius });
    }
  };
  if (n <= 8) {
    ring(n, 0.4, 0);
  } else if (n <= 16) {
    const outer = Math.ceil(n * 0.6);
    ring(outer, 0.47, 0);
    ring(n - outer, 0.24, Math.PI / Math.max(1, n - outer));
  } else {
    const center = n >= 21 ? 4 : 3;
    const rem = n - center;
    const outer = Math.ceil(rem * 0.58);
    ring(outer, 0.49, 0);
    ring(rem - outer, 0.28, Math.PI / Math.max(1, rem - outer));
    ring(center, 0.1, 0.3);
  }
  return pts;
}

/* ---------- mutable per-frame simulation state (lives in a ref) ----------
   Scalar sim only; the smoke position/color buffers feed JSX and so live in a
   useMemo (mutated through the geometry-attribute ref, like the reference). */
interface Sim {
  n: number;
  cap: number;
  openEnd: number;
  life: Float32Array;
  target: Float32Array;
  flick: Float32Array;
  igniteAt: Float32Array;
  smokeVel: Float32Array;
  smokeLife: Float32Array;
}
function makeSim(n: number): Sim {
  const rand = mulberry32(97 + n * 13);
  const flick = new Float32Array(n);
  const igniteAt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    flick[i] = rand() * Math.PI * 2;
    igniteAt[i] = 0.9 + (n > 1 ? (i / (n - 1)) * 2.1 : 1.0);
  }
  const last = n > 1 ? 3.0 : 1.9;
  const cap = n * 6;
  return {
    n,
    cap,
    openEnd: Math.max(3.6, last + 1.15),
    life: new Float32Array(n),
    target: new Float32Array(n),
    flick,
    igniteAt,
    smokeVel: new Float32Array(cap * 3),
    smokeLife: new Float32Array(cap),
  };
}

export default function BirthdayCakeScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const palette = PALETTES[variants.frosting] ?? PALETTES.vanilla;
  const N = Math.max(1, Math.min(24, parseInt(variants.candles ?? "1", 10) || 1));

  /* ---- variant materials (rebuild on palette change, dispose on cleanup) ---- */
  const frostingMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: palette.frosting, roughness: 0.55, metalness: 0.02 }),
    [palette],
  );
  const spongeMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: palette.sponge, roughness: 0.8 }),
    [palette],
  );
  const dripMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: palette.drip, roughness: 0.35, metalness: 0.05 }),
    [palette],
  );
  const plateMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: palette.plate, roughness: 0.25, metalness: 0.35 }),
    [palette],
  );
  useEffect(() => {
    return () => {
      frostingMat.dispose();
      spongeMat.dispose();
      dripMat.dispose();
      plateMat.dispose();
    };
  }, [frostingMat, spongeMat, dripMat, plateMat]);

  /* ---- shared flame sprite materials (variant-independent, read-only in frame) ---- */
  const glowMat = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: flameTex,
        color: "#ff8a2a",
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  const coreMat = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: flameTex,
        color: "#fff3c0",
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useEffect(() => {
    return () => {
      glowMat.dispose();
      coreMat.dispose();
    };
  }, [glowMat, coreMat]);

  /* ---- in-scene text textures (materials created in JSX so refs can animate them) ---- */
  const text = useMemo(() => {
    const rn = recipientName?.trim();
    const happy = lang === "ar" ? "عيد ميلاد سعيد" : "Happy Birthday";
    const title = makeTextTexture(happy + (rn ? `\n${rn}` : "!"), {
      fontSize: 74,
      fontWeight: "800",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      color: "#ffe6a8",
      glow: 18,
      glowColor: "#ffb04d",
      maxWidthPx: 900,
      lineHeight: 1.12,
      lang,
    });
    const msgBody = message?.trim();
    const sn = senderName?.trim();
    const hasMsg = !!(msgBody || sn);
    let msgTex: THREE.CanvasTexture | null = null;
    let msgAspect = 1;
    if (hasMsg) {
      const msgText = (msgBody ?? "") + (msgBody && sn ? "\n\n" : "") + (sn ? `— ${sn}` : "");
      const m = makeTextTexture(msgText, {
        fontSize: 46,
        fontWeight: "500",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        color: "#ffd9b0",
        glow: 9,
        glowColor: "#ff9d55",
        maxWidthPx: 720,
        lineHeight: 1.32,
        lang,
      });
      msgTex = m.texture;
      msgAspect = m.aspect;
    }
    return { titleTex: title.texture, titleAspect: title.aspect, msgTex, msgAspect, hasMsg };
  }, [recipientName, message, senderName, lang]);
  useEffect(() => {
    return () => {
      text.titleTex.dispose();
      text.msgTex?.dispose();
    };
  }, [text]);

  const candles = useMemo(() => candlePositions(N), [N]);

  // Smoke position/color buffers feed <bufferAttribute>; mutated only through
  // the geometry-attribute ref in useFrame (never written directly here).
  const smokeBuf = useMemo(
    () => ({ pos: new Float32Array(N * 6 * 3), col: new Float32Array(N * 6 * 3) }),
    [N],
  );

  /* ---- refs ---- */
  const simRef = useRef<Sim>(makeSim(N));
  const spinRef = useRef<THREE.Group>(null);
  const warmRef = useRef<THREE.PointLight>(null);
  const coolRef = useRef<THREE.PointLight>(null);
  const flameRefs = useRef<(THREE.Group | null)[]>([]);
  const hitRefs = useRef<(THREE.Mesh | null)[]>([]);
  const smokeRef = useRef<THREE.Points>(null);
  const confettiRef = useRef<THREE.InstancedMesh>(null);
  const titleMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const msgMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const tRef = useRef(0);
  const doneRef = useRef(false);
  const ui = useRef({ allOutAt: -1, confettiActive: false, confettiT: 0, confettiDone: false });

  /* ---- imperative helpers (callbacks/effects only — never during render) ---- */
  const clearSmoke = () => {
    const s = simRef.current;
    for (let k = 0; k < s.cap; k++) s.smokeLife[k] = 0;
    const p = smokeRef.current;
    if (p) {
      const colA = p.geometry.attributes.color as THREE.BufferAttribute;
      for (let k = 0; k < s.cap; k++) colA.setXYZ(k, 0, 0, 0);
      colA.needsUpdate = true;
    }
  };
  const hideConfetti = () => {
    const inst = confettiRef.current;
    if (!inst) return;
    dummy.position.set(0, -50, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (let i = 0; i < CONFETTI_N; i++) inst.setMatrixAt(i, dummy.matrix);
    inst.instanceMatrix.needsUpdate = true;
  };
  const blowOut = (i: number) => {
    if (phase !== "revealed") return;
    const s = simRef.current;
    if (s.target[i] < 0.5) return;
    s.target[i] = 0;
    const c = candles[i];
    const p = smokeRef.current;
    const posA = p ? (p.geometry.attributes.position as THREE.BufferAttribute) : null;
    for (let k = 0; k < 6; k++) {
      const idx = i * 6 + k;
      posA?.setXYZ(
        idx,
        c.x + (Math.random() - 0.5) * 0.08,
        FLAME_Y + 0.04 + Math.random() * 0.05,
        c.z + (Math.random() - 0.5) * 0.08,
      );
      s.smokeVel[idx * 3] = (Math.random() - 0.5) * 0.15;
      s.smokeVel[idx * 3 + 1] = 0.35 + Math.random() * 0.25;
      s.smokeVel[idx * 3 + 2] = (Math.random() - 0.5) * 0.15;
      s.smokeLife[idx] = 0.7 + Math.random() * 0.3;
    }
    if (posA) posA.needsUpdate = true;
  };

  /* ---- rebuild-on-count + phase resets (mirror useOpeningClock, extended).
     Layout effect so the ref is fresh before the next useFrame runs. ---- */
  useLayoutEffect(() => {
    if (simRef.current.n !== N) simRef.current = makeSim(N);
    const s = simRef.current;
    const lit = phase === "preview" || phase === "revealed" ? 1 : 0;
    for (let i = 0; i < s.n; i++) {
      s.life[i] = lit;
      s.target[i] = lit;
    }
    tRef.current = 0;
    doneRef.current = false;
    ui.current.allOutAt = -1;
    ui.current.confettiActive = false;
    ui.current.confettiT = 0;
    ui.current.confettiDone = false;
    clearSmoke();
    hideConfetti();
  }, [phase, N]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const el = state.clock.elapsedTime;
    const s = simRef.current;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    // slow turntable
    if (spinRef.current) {
      const spd = phase === "preview" ? 0.25 : phase === "sealed" ? 0.04 : phase === "opening" ? 0.08 : 0.12;
      spinRef.current.rotation.y += dt * spd;
    }

    // drive flame life by phase
    if (phase === "opening") {
      for (let i = 0; i < s.n; i++) s.life[i] = easeOutCubic(clamp01((t - s.igniteAt[i]) / 0.55));
      if (t > s.openEnd && !doneRef.current) {
        doneRef.current = true;
        onOpenComplete?.();
      }
    } else if (phase === "preview") {
      for (let i = 0; i < s.n; i++) s.life[i] = 1;
    } else if (phase === "sealed") {
      for (let i = 0; i < s.n; i++) s.life[i] = 0;
    } else {
      for (let i = 0; i < s.n; i++) {
        const rate = s.target[i] < s.life[i] ? 11 : 3;
        s.life[i] += (s.target[i] - s.life[i]) * Math.min(1, dt * rate);
      }
    }

    // flame sprites: flicker + ignition pop
    let litSum = 0;
    for (let i = 0; i < s.n; i++) {
      litSum += s.life[i];
      const h = hitRefs.current[i];
      if (h) h.raycast = s.target[i] > 0.5 ? meshRaycast : noRaycast;
      const g = flameRefs.current[i];
      if (!g) continue;
      const fl =
        1 + Math.sin(el * (9 + (i % 5)) + s.flick[i]) * 0.12 + Math.sin(el * 17 + s.flick[i] * 2) * 0.05;
      let pop = 1;
      if (phase === "opening") {
        const since = t - s.igniteAt[i];
        if (since > 0 && since < 0.35) pop = 1 + Math.sin((since / 0.35) * Math.PI) * 0.4;
      }
      const sc = s.life[i] * fl * pop;
      g.visible = s.life[i] > 0.02;
      g.scale.setScalar(Math.max(0.0001, sc));
    }
    const litFrac = litSum / s.n;

    // one shared warm light tracks lit fraction
    if (warmRef.current) {
      warmRef.current.intensity = (phase === "sealed" ? 0 : 0.15) + litFrac * 2.3;
    }
    // cool rim: expectant pulse while sealed, faint otherwise
    if (coolRef.current) {
      const pulse = 0.5 + Math.sin(el * 2.0) * 0.5;
      coolRef.current.intensity =
        phase === "sealed" ? 0.28 + pulse * 0.35 : phase === "preview" ? 0.12 : 0.1 * (1 - litFrac);
    }

    // text opacity (mutated through element refs)
    if (titleMatRef.current) {
      const titleTarget =
        phase === "sealed"
          ? 0.22 + (0.5 + Math.sin(el * 2.0) * 0.5) * 0.12
          : phase === "opening"
            ? 0.3 + clamp01(t / s.openEnd) * 0.7
            : 0.95;
      titleMatRef.current.opacity += (titleTarget - titleMatRef.current.opacity) * Math.min(1, dt * 3);
    }
    if (msgMatRef.current) {
      const msgTarget =
        phase === "sealed"
          ? 0.12
          : phase === "preview"
            ? 0.55
            : phase === "opening"
              ? clamp01((t - 1) / 2) * 0.85
              : 0.9;
      msgMatRef.current.opacity += (msgTarget - msgMatRef.current.opacity) * Math.min(1, dt * 2.5);
    }

    // smoke puffs rise + fade (integrated on the geometry attributes directly)
    const p = smokeRef.current;
    if (p) {
      const posA = p.geometry.attributes.position as THREE.BufferAttribute;
      const colA = p.geometry.attributes.color as THREE.BufferAttribute;
      let changed = false;
      for (let k = 0; k < s.cap; k++) {
        if (s.smokeLife[k] > 0) {
          s.smokeLife[k] -= dt / 1.2;
          const l = Math.max(0, s.smokeLife[k]);
          posA.setXYZ(
            k,
            posA.getX(k) + s.smokeVel[k * 3] * dt,
            posA.getY(k) + s.smokeVel[k * 3 + 1] * dt,
            posA.getZ(k) + s.smokeVel[k * 3 + 2] * dt,
          );
          s.smokeVel[k * 3 + 1] *= 0.98;
          const c = 0.5 * smooth(l);
          colA.setXYZ(k, c, c, c);
          changed = true;
        }
      }
      if (changed) {
        posA.needsUpdate = true;
        colA.needsUpdate = true;
      }
    }

    // revealed interaction loop: all out -> confetti -> relight
    if (phase === "revealed") {
      let anyLit = false;
      let allTargetsOut = true;
      for (let i = 0; i < s.n; i++) {
        if (s.target[i] > 0.5) allTargetsOut = false;
        if (s.life[i] > 0.05) anyLit = true;
      }
      if (allTargetsOut && !anyLit && ui.current.allOutAt < 0) ui.current.allOutAt = el;
      if (ui.current.allOutAt >= 0) {
        const since = el - ui.current.allOutAt;
        if (since > 0.4 && !ui.current.confettiActive && !ui.current.confettiDone) {
          ui.current.confettiActive = true;
          ui.current.confettiT = 0;
        }
        if (since > 4.0) {
          for (let i = 0; i < s.n; i++) s.target[i] = 1;
          ui.current.allOutAt = -1;
          ui.current.confettiDone = false;
        }
      }
      if (ui.current.confettiActive) {
        ui.current.confettiT += dt;
        const ct = ui.current.confettiT;
        const inst = confettiRef.current;
        if (inst) {
          for (let i = 0; i < CONFETTI_N; i++) {
            const lt = ct - CONFETTI.phase[i];
            if (lt < 0) {
              dummy.scale.setScalar(0);
              dummy.updateMatrix();
              inst.setMatrixAt(i, dummy.matrix);
              continue;
            }
            const px = CONFETTI.vel[i * 3] * lt;
            const py = 1.5 + CONFETTI.vel[i * 3 + 1] * lt - 0.5 * 9 * lt * lt;
            const pz = CONFETTI.vel[i * 3 + 2] * lt;
            const a = lt > 1.5 ? clamp01(1 - (lt - 1.5) / 1.5) : 1;
            dummy.position.set(px, py, pz);
            dummy.rotation.set(
              CONFETTI.spin[i * 3] * lt,
              CONFETTI.spin[i * 3 + 1] * lt,
              CONFETTI.spin[i * 3 + 2] * lt,
            );
            const g2 = 0.5 + 0.5 * a;
            dummy.scale.set(0.055 * g2, 0.09 * g2, 0.055 * g2);
            dummy.updateMatrix();
            inst.setMatrixAt(i, dummy.matrix);
            dcol.setRGB(CONFETTI.col[i * 3] * a, CONFETTI.col[i * 3 + 1] * a, CONFETTI.col[i * 3 + 2] * a);
            inst.setColorAt(i, dcol);
          }
          inst.instanceMatrix.needsUpdate = true;
          if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        }
        if (ct > 3.4) {
          ui.current.confettiActive = false;
          ui.current.confettiDone = true;
          hideConfetti();
        }
      }
    }
  });

  /* ---- text plane layout ---- */
  const TW = 2.4;
  const titleH = TW * text.titleAspect;
  const titleY = 0.98 + titleH / 2;
  let MW = 2.2;
  if (text.hasMsg && MW * text.msgAspect > 1.5) MW = 1.5 / text.msgAspect;
  const msgH = MW * text.msgAspect;
  const msgY = -1.98 - msgH / 2;

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.6, 8.2]} fov={40} onUpdate={(c) => c.lookAt(0, -0.55, 0)} />
      <ambientLight intensity={0.24} color="#ffe9d0" />
      <directionalLight position={[2.5, 4, 3]} intensity={0.4} color="#fff0e0" />
      <pointLight ref={warmRef} position={[0, 1.3, 0.3]} intensity={0.15} color="#ffa94d" distance={9} decay={1.4} />
      <pointLight ref={coolRef} position={[-2.5, 1.6, -2]} intensity={0.3} color="#5a86c8" distance={12} decay={1.2} />

      {/* dark floor to catch warm light */}
      <mesh position={[0, -2.36, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[6, 48]} />
        <meshStandardMaterial color="#17121c" roughness={0.9} metalness={0.1} />
      </mesh>

      {/* title text (does not rotate with cake) */}
      <mesh position={[0, titleY, 0]}>
        <planeGeometry args={[TW, titleH]} />
        <meshBasicMaterial
          ref={titleMatRef}
          map={text.titleTex}
          transparent
          depthWrite={false}
          toneMapped={false}
          opacity={0}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {text.hasMsg && text.msgTex && (
        <mesh position={[0, msgY, 1.0]}>
          <planeGeometry args={[MW, msgH]} />
          <meshBasicMaterial
            ref={msgMatRef}
            map={text.msgTex}
            transparent
            depthWrite={false}
            toneMapped={false}
            opacity={0}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}

      <group ref={spinRef}>
        {/* stand */}
        <mesh position={[0, -2.13, 0]}>
          <cylinderGeometry args={[0.55, 0.66, 0.28, 40]} />
          <primitive object={plateMat} attach="material" />
        </mesh>
        <mesh position={[0, -1.86, 0]}>
          <cylinderGeometry args={[0.2, 0.24, 0.35, 32]} />
          <primitive object={plateMat} attach="material" />
        </mesh>
        {/* plate */}
        <mesh position={[0, -1.62, 0]}>
          <cylinderGeometry args={[1.05, 1.02, 0.09, 48]} />
          <primitive object={plateMat} attach="material" />
        </mesh>
        <mesh position={[0, -1.56, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.0, 0.03, 8, 56]} />
          <primitive object={plateMat} attach="material" />
        </mesh>

        {/* bottom tier */}
        <mesh position={[0, -1.13, 0]}>
          <cylinderGeometry args={[0.9, 0.92, 0.85, 48]} />
          <primitive object={frostingMat} attach="material" />
        </mesh>
        <mesh position={[0, -1.3, 0]}>
          <cylinderGeometry args={[0.905, 0.925, 0.3, 48]} />
          <primitive object={spongeMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.72, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.6]}>
          <torusGeometry args={[0.9, 0.07, 10, 56]} />
          <primitive object={dripMat} attach="material" />
        </mesh>

        {/* top tier */}
        <mesh position={[0, -0.38, 0]}>
          <cylinderGeometry args={[0.58, 0.6, 0.62, 40]} />
          <primitive object={frostingMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.5, 0]}>
          <cylinderGeometry args={[0.585, 0.605, 0.22, 40]} />
          <primitive object={spongeMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.09, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.6]}>
          <torusGeometry args={[0.58, 0.06, 10, 48]} />
          <primitive object={dripMat} attach="material" />
        </mesh>
        {/* frosting cap */}
        <mesh position={[0, -0.06, 0]}>
          <cylinderGeometry args={[0.6, 0.58, 0.05, 40]} />
          <primitive object={frostingMat} attach="material" />
        </mesh>

        {/* candles */}
        {candles.map((c, i) => (
          <group key={i} position={[c.x, 0, c.z]}>
            <mesh position={[0, 0.23, 0]} geometry={candleBodyGeo} material={candleBodyMat} />
            <mesh position={[0, 0.55, 0]} geometry={wickGeo} material={wickMat} />
            <group
              ref={(el) => {
                flameRefs.current[i] = el;
              }}
              position={[0, FLAME_Y, 0]}
            >
              <sprite material={glowMat} scale={0.34} position={[0, 0.02, 0]} />
              <sprite material={coreMat} scale={0.14} />
            </group>
            <mesh
              ref={(el) => {
                hitRefs.current[i] = el;
              }}
              position={[0, FLAME_Y, 0]}
              geometry={hitGeo}
              material={hitMat}
              onPointerDown={(e) => {
                e.stopPropagation();
                blowOut(i);
              }}
            />
          </group>
        ))}

        {/* smoke puffs */}
        <points ref={smokeRef}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[smokeBuf.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[smokeBuf.col, 3]} />
          </bufferGeometry>
          <pointsMaterial
            map={smokeTex}
            size={0.16}
            sizeAttenuation
            vertexColors
            transparent
            opacity={1}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>

        {/* confetti burst */}
        <instancedMesh ref={confettiRef} args={[undefined, undefined, CONFETTI_N]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            blending={THREE.AdditiveBlending}
          />
        </instancedMesh>
      </group>
    </>
  );
}
