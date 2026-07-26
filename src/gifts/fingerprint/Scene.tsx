import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
const MEDIA: Record<string, { slab: string; rough: number; ridge: string; deep: string; metal: number }> = {
  clay: { slab: "#8d8175", rough: 0.86, ridge: "#5d5347", deep: "#3a332a", metal: 0.02 },
  ink: { slab: "#efe9dd", rough: 0.72, ridge: "#1d1b22", deep: "#0d0c10", metal: 0 },
  plaster: { slab: "#e6e1d6", rough: 0.9, ridge: "#a79e8d", deep: "#6f685c", metal: 0 },
};
const RIDGE_GLOW: Record<string, string> = {
  gold: "#ffcc63",
  ember: "#ff7a3c",
  indigo: "#7f9cff",
};

const TAU = Math.PI * 2;
const TEX = 1024; // the ridges are hairlines; 512 turns them to mush
const SLAB_W = 2.3;
const SLAB_H = 1.28;
const ACTION_W = 2.6;
const ACTION_H = 1.9;

/* Print centres in uv. Theirs is already in the clay; yours goes on the right. */
const P1 = { x: 0.29, y: 0.54 };
const P2 = { x: 0.71, y: 0.54 };
const PRINT_R = 0.155; // full print radius in uv
const RIDGE_GAP = 0.0125; // uv spacing between ridges — a real thumb is about this

/**
 * One print: concentric offset loops round a core, each one wobbled by a couple of
 * low harmonics so it reads as a whorl and not as a target. `grow` 0..1 rolls the
 * ridges out from the contact point, which is exactly what pressing a thumb into
 * clay looks like from above.
 */
function drawPrint(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  grow: number,
  seed: number,
  lw: number,
) {
  if (grow <= 0.001) return;
  const rand = mulberry32(seed);
  const ph1 = rand() * TAU;
  const ph2 = rand() * TAU;
  const squash = 0.86 + rand() * 0.12;
  g.lineWidth = lw;
  const rings = Math.floor(r / (RIDGE_GAP * TEX)) + 1;
  for (let i = 1; i <= rings; i++) {
    const rad = i * RIDGE_GAP * TEX;
    if (rad > r * grow) break;
    // Each loop opens at a different angle, so the whorl has a delta the way a
    // real one does instead of closing into rings.
    const open = 0.5 + 0.35 * Math.sin(i * 0.7 + ph1);
    g.beginPath();
    for (let k = 0; k <= 52; k++) {
      const a = open + (k / 52) * (TAU - 0.9);
      const wob =
        1 +
        0.11 * Math.sin(a * 2 + ph1 + i * 0.22) +
        0.06 * Math.sin(a * 3 - ph2 - i * 0.13);
      const x = cx + Math.cos(a) * rad * wob;
      const y = cy + Math.sin(a) * rad * wob * squash;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // the core itself
  g.beginPath();
  g.arc(cx, cy, RIDGE_GAP * TEX * 0.5, 0, TAU);
  g.stroke();
}

/**
 * The words, stamped into the clay between the two prints.
 *
 * This is the fallback the plan named, and the spike is why. Warping the ridge
 * field into letterforms *and* stroking `orderWritePath` as a ridge-like polyline
 * both fail the same way: that path is a dense column sweep through the ink, not a
 * centreline, so drawing it as a line gives a zigzag scribble — the exact smear the
 * plan warned about, and it is illegible at the size a phone shows the slab at.
 * A crisp raster blitted into both canvases keeps the words readable, and the ridge
 * fields reaching toward each other on either side still carry the idea.
 */
function drawWords(g: CanvasRenderingContext2D, raster: HTMLCanvasElement, span: number) {
  const w = span;
  const h = (span * raster.height) / raster.width;
  g.drawImage(raster, TEX / 2 - w / 2, TEX * 0.54 - h / 2, w, h);
}

/** Grain in the medium, so the slab is not a flat grey rectangle. */
function buildGrain(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#d8d8d8";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(5041);
  for (let i = 0; i < 9000; i++) {
    const v = 196 + rand() * 56;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rand() * s, rand() * s, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1.2);
  // Near-white, not mid-grey: `map` multiplies the albedo, and a 50% grain map
  // simply halves the slab before a single light touches it.
  return tex;
}
const GRAIN = buildGrain();
const HINT_SPRITE = makeRadialSprite(64);

/* ---------- opening ---------- */
const HOLD_DUR = 1.5; // press-and-hold to a full print
const MERGE_START = 0.35;
const MERGE_END = 1.7; // the two fields reach and join
const WORDS_START = 1.3;
const POST_END = 3.0;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function FingerprintScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const med = MEDIA[variants.medium] ?? MEDIA.clay;
  const glow = RIDGE_GLOW[variants.ridges] ?? RIDGE_GLOW.gold;

  const write = useMemo(() => {
    const text = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    // White on transparent: both canvases want it as pure coverage — the relief
    // reads it as height and the emissive as where to light up.
    const t = makeTextTexture(text, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "700",
      fontSize: 84,
      color: "#ffffff",
      maxWidthPx: 84 * 8,
      lineHeight: 1.3,
      padding: 18,
      lang,
    });
    // The words live between the prints: the middle third, fitted on both axes.
    const span = Math.min(TEX * 0.46, (TEX * 0.32) / Math.max(0.2, t.aspect));
    return { raster: t.texture.image as HTMLCanvasElement, tex: t.texture, span };
  }, [message, recipientName, lang]);
  useEffect(() => () => write.tex.dispose(), [write]);

  /**
   * Two canvases, one geometry: `relief` is the bump map the light reads (both
   * prints plus the words as ridges), `lines` is the emissive that only ever holds
   * the shared lines. Both are redrawn on a step counter, not per frame — pressing
   * a thumb is a dozen states, not sixty a second.
   */
  // Held in a ref, not a memo: the canvases are drawn into long after render, and
  // a memoized value may not be written to once render is over. The two textures
  // reach the material through `paint` below rather than through JSX, for the same
  // reason — nothing here may be read during render.
  const artRef = useRef<{
    relief: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
    lines: { c: HTMLCanvasElement; g: CanvasRenderingContext2D };
    reliefTex: THREE.CanvasTexture;
    linesTex: THREE.CanvasTexture;
  } | null>(null);
  useEffect(
    () => () => {
      artRef.current?.reliefTex.dispose();
      artRef.current?.linesTex.dispose();
      artRef.current = null;
    },
    [],
  );

  /** Redraw both canvases for a given (yours, merge, words) state. Deliberately a
   *  plain function and not a useMemo: anything a hook captures becomes read-only
   *  afterwards, and this has to write to the canvases and to the slab's material. */
  const paint = (mine: number, merge: number, words: number) => {
    {
      if (!artRef.current) {
        const mk = () => {
          const c = document.createElement("canvas");
          c.width = c.height = TEX;
          return { c, g: c.getContext("2d")! };
        };
        const relief = mk();
        const lines = mk();
        const reliefTex = new THREE.CanvasTexture(relief.c);
        const linesTex = new THREE.CanvasTexture(lines.c);
        reliefTex.anisotropy = linesTex.anisotropy = 4;
        artRef.current = { relief, lines, reliefTex, linesTex };
      }
      const art = artRef.current;
      const slab = slabMatRef.current;
      if (slab && slab.bumpMap !== art.reliefTex) {
        slab.bumpMap = art.reliefTex;
        slab.emissiveMap = art.linesTex;
        slab.needsUpdate = true;
      }
      const { g: rg } = art.relief;
      const { g: lg } = art.lines;
      rg.clearRect(0, 0, TEX, TEX);
      lg.clearRect(0, 0, TEX, TEX);
      // The bump map is read as height: mid grey is the flat slab, white is a ridge.
      rg.fillStyle = "#6a6a6a";
      rg.fillRect(0, 0, TEX, TEX);
      rg.strokeStyle = "#f2f2f2";
      rg.lineCap = "round";
      // Theirs is already in the clay, and it reaches first — it has had longer.
      const reach = 1 + merge * 0.42;
      drawPrint(rg, P1.x * TEX, (1 - P1.y) * TEX, PRINT_R * TEX * reach, 1, 8821, 4.6);
      drawPrint(rg, P2.x * TEX, (1 - P2.y) * TEX, PRINT_R * TEX * reach, mine, 4409, 4.6);
      if (words > 0) {
        rg.globalAlpha = words;
        drawWords(rg, write.raster, write.span);
        rg.globalAlpha = 1;
        // Only the shared lines light: the emissive canvas has nothing else on it.
        lg.globalAlpha = words;
        drawWords(lg, write.raster, write.span);
        lg.globalAlpha = 1;
      }
      art.reliefTex.needsUpdate = true;
      art.linesTex.needsUpdate = true;
    }
  };

  const names = useMemo(() => {
    const t = makeTextTexture(`${senderName || "—"}   ·   ${recipientName || "—"}`, {
      fontFamily: "Georgia, serif",
      fontWeight: "600",
      fontSize: 42,
      color: med.ridge,
      maxWidthPx: 42 * 14,
      padding: 12,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 0.9, 0.12) };
  }, [senderName, recipientName, lang, med]);
  useEffect(() => () => names.t.texture.dispose(), [names]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* `hold` is the press; `lifted` latches the release that finishes the print. */
  const g = useRef({ hold: 0, down: false, lifted: false, liftAt: 0, step: -1, touched: false });
  useEffect(() => {
    if (phase === "opening") g.current = { hold: 0, down: false, lifted: false, liftAt: 0, step: -1, touched: false };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const slabMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const pressRef = useRef<THREE.Mesh>(null);
  const thumbRef = useRef<THREE.Group>(null);
  const namesMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lampRef = useRef<THREE.PointLight>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.lifted) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.current.down = true;
    g.current.touched = true;
  };
  const release = () => {
    const c = g.current;
    if (!c.down) return;
    c.down = false;
    // A print you lifted too early is still a print — a real thumb never gets a
    // second go at the same clay, and refusing the gesture would be worse.
    if (c.hold > 0.18 && !c.lifted) {
      c.lifted = true;
      c.liftAt = tRef.current;
      tone(330, { type: "sine", seconds: 0.5, gain: 0.18 });
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = g.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.62, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- the press ---- */
    if (phase === "opening" && c.down && !c.lifted) {
      c.hold = Math.min(1, c.hold + dt / HOLD_DUR);
      if (c.hold >= 1) release();
    }

    const post = phase === "revealed" ? POST_END : c.lifted ? tRef.current - c.liftAt : -1;
    const mine = phase === "sealed" ? 0 : phase === "opening" ? c.hold : 1;
    const merge =
      phase === "revealed" ? 1 : phase === "preview" ? 1 : post < 0 ? 0 : smooth(clamp01((post - MERGE_START) / (MERGE_END - MERGE_START)));
    const words = phase === "revealed" || phase === "preview" ? 1 : post < 0 ? 0 : smooth(clamp01((post - WORDS_START) / (MERGE_END - WORDS_START)));

    /* ---- redraw only when the state has actually moved a step ---- */
    const step = Math.round(mine * 14) * 10000 + Math.round(merge * 14) * 100 + Math.round(words * 14);
    if (step !== c.step) {
      c.step = step;
      paint(mine, merge, words);
    }

    /* ---- the clay yields under the touch, and the shared lines light up ---- */
    if (slabMatRef.current) {
      const m = slabMatRef.current;
      m.bumpScale = lerp(0.42, 0.62, merge);
      m.emissiveIntensity = words * (0.75 + 0.25 * Math.sin(e * 1.5));
    }
    if (pressRef.current) {
      // a soft squash under the fingertip while it is held
      const s = c.down && !c.lifted ? 1 : 0;
      pressRef.current.visible = s > 0;
      pressRef.current.scale.setScalar(lerp(0.4, 1.15, c.hold));
    }
    if (thumbRef.current) {
      const on = phase === "opening" && c.down && !c.lifted;
      thumbRef.current.visible = on;
      if (on) thumbRef.current.position.z = lerp(0.5, 0.16, c.hold);
    }
    if (namesMatRef.current) {
      const want = phase === "preview" ? 1 : words;
      namesMatRef.current.opacity += (want - namesMatRef.current.opacity) * Math.min(1, dt * 3);
    }
    if (lampRef.current) {
      // The work lamp swings a little, which is the only way flat ridges read as deep.
      lampRef.current.position.x = Math.sin(e * 0.5) * 1.5;
      lampRef.current.position.y = 1.1 + Math.cos(e * 0.4) * 0.3;
    }
    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.3 + 0.2 * Math.sin(e * 2.7) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  // No "set the static pose" effect: `step` starts at -1 and every phase computes
  // a real step, so the first frame after mount (or after a phase change) always
  // repaints — including the single settling burst reduced motion runs.

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, -0.12, 2.35]} fov={42} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.6} />
      {/* a work lamp, low and raking — ridges are only ridges under a raking light */}
      <pointLight ref={lampRef} position={[0, 1.1, 1.5]} intensity={7} color="#fff2dc" distance={9} decay={1.1} />
      <directionalLight position={[-1.8, -0.6, 1.4]} intensity={0.3} color="#9fb4d6" />

      <mesh position={[0, 0, -1.4]}>
        <planeGeometry args={[14, 10]} />
        <meshBasicMaterial color="#14110f" depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        {/* the slab. One plane, and every mark on it is a bump map — no displacement,
            no second geometry, and it survives a mid-phone at 60fps. */}
        <mesh rotation={[-0.22, 0, 0]}>
          <planeGeometry args={[SLAB_W, SLAB_H]} />
          <meshStandardMaterial
            ref={slabMatRef}
            color={med.slab}
            roughness={med.rough}
            metalness={med.metal}
            map={GRAIN}
            bumpScale={0.55}
            emissive={glow}
            emissiveIntensity={0}
          />
        </mesh>

        {/* the rim of the slab, so it is a slab and not a photograph of one */}
        <mesh position={[0, -SLAB_H / 2 - 0.03, -0.03]} rotation={[-0.22, 0, 0]}>
          <boxGeometry args={[SLAB_W, 0.07, 0.16]} />
          <meshStandardMaterial color={med.deep} roughness={0.9} />
        </mesh>

        {/* both names, impressed small beneath */}
        <mesh position={[0, -SLAB_H * 0.36, 0.03]} rotation={[-0.22, 0, 0]}>
          <planeGeometry args={names.size} />
          <meshBasicMaterial ref={namesMatRef} map={names.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>

        {/* the yield under the fingertip while it is held */}
        <mesh ref={pressRef} position={[(P2.x - 0.5) * SLAB_W, (P2.y - 0.5) * SLAB_H, 0.02]} rotation={[-0.22, 0, 0]} visible={false}>
          <circleGeometry args={[PRINT_R * SLAB_W * 1.2, 28]} />
          <meshBasicMaterial color="#000000" transparent opacity={0.16} depthWrite={false} />
        </mesh>

        {/* your thumb coming down — it is the only thing in the scene with a body */}
        <group ref={thumbRef} position={[(P2.x - 0.5) * SLAB_W, (P2.y - 0.5) * SLAB_H + 0.18, 0.5]} visible={false}>
          <mesh rotation={[0.5, 0, 0]}>
            <capsuleGeometry args={[0.14, 0.5, 6, 16]} />
            <meshStandardMaterial color="#d19a72" roughness={0.68} />
          </mesh>
        </group>

        <mesh position={[(P2.x - 0.5) * SLAB_W, (P2.y - 0.5) * SLAB_H, 0.06]}>
          <planeGeometry args={[0.75, 0.75]} />
          <meshBasicMaterial ref={hintMatRef} map={HINT_SPRITE} color={glow} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 0.8]} onPointerDown={onDown} onPointerUp={release} onPointerCancel={release} onPointerOut={release}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
