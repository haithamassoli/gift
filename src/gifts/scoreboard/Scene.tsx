import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, mulberry32 } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { pick } from "../catalog";
import type { Lang } from "../../i18n";

/* ---------- variants ---------- */
const FINISHES: Record<string, { case: string; flap: string; ink: string; rough: number; metal: number; wall: string }> = {
  cream: { case: "#d8cbb2", flap: "#efe6d2", ink: "#2b2419", rough: 0.62, metal: 0.05, wall: "#2b2620" },
  navy: { case: "#1b2740", flap: "#2a3a5c", ink: "#e8eefc", rough: 0.5, metal: 0.1, wall: "#12151f" },
  chrome: { case: "#9aa2ab", flap: "#c3cad2", ink: "#1a1d22", rough: 0.24, metal: 0.9, wall: "#1c1f24" },
};

/* ---------- board layout ---------- */
const COLS = 18;
const ROWS = 6;
const CELL_W = 0.128;
const CELL_H = 0.178;
const GAP = 0.008;
const BOARD_W = COLS * (CELL_W + GAP);
const BOARD_H = (ROWS + 2.4) * (CELL_H + GAP);
const ACTION_W = BOARD_W + 0.9;
const ACTION_H = BOARD_H + 0.8;

/* ---------- flap glyph textures, cached across every board on the page ---------- */
// One 96px canvas per distinct character. A board only ever shows a few dozen, and
// makeTextTexture is the same rasterizer the rest of the catalog engraves with.
const glyphCache = new Map<string, THREE.CanvasTexture>();
function glyph(ch: string, ink: string, lang: Lang): THREE.CanvasTexture | null {
  if (ch === " ") return null;
  const key = `${ch}|${ink}|${lang}`;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const { texture } = makeTextTexture(ch, {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    fontWeight: "700",
    fontSize: 96,
    color: ink,
    maxWidthPx: 400,
    padding: 22,
    lang,
  });
  glyphCache.set(key, texture);
  return texture;
}

/** Wrap `text` into ROWS lines of at most COLS characters, in whole words. */
function layout(text: string): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= COLS) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    // A word longer than the board gets cut, because the board is the board.
    line = word.length > COLS ? word.slice(0, COLS) : word;
  }
  if (line) lines.push(line);
  // A split-flap board has never once scrolled, so a message longer than the grid
  // gets cut — but it says so, rather than stopping mid-sentence as if that were
  // the whole thought.
  if (lines.length > ROWS) {
    const kept = lines.slice(0, ROWS);
    kept[ROWS - 1] = `${kept[ROWS - 1].slice(0, COLS - 1)}…`;
    return kept;
  }
  return lines;
}

/** Centre a line in its row, so the board reads as a board and not as a paragraph. */
function padded(line: string): string {
  const pad = Math.max(0, COLS - line.length);
  return " ".repeat(Math.floor(pad / 2)) + line + " ".repeat(Math.ceil(pad / 2));
}

/* ---------- opening ---------- */
const TAPS = 5; // taps before the board stops pretending it is a contest
const FLIP_DUR = 0.26; // one flap, edge to edge
const CASCADE_STEP = 0.022; // stagger down the grid on the final run
const POST_END = 2.7;
const START_SCORE = 47;
const HINT = makeRadialSprite(64);

/* Where every flap sits. Fixed by COLS/ROWS, so it is laid out once at module
   scope and the render just maps it — only the *state* below ever changes. */
const SLOTS: { row: number; col: number }[] = [];
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) SLOTS.push({ row, col });
}

interface Cell {
  /** what the flap currently shows */
  ch: string;
  /** what it is on its way to */
  to: string;
  /** 0..1 through the flip; -1 = at rest */
  flip: number;
  /** seconds still to wait before the flip starts */
  delay: number;
  swapped: boolean;
}
const restCell = (): Cell => ({ ch: " ", to: " ", flip: -1, delay: 0, swapped: true });

export default function ScoreboardScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const fin = FINISHES[variants.finish] ?? FINISHES.cream;

  /* Both the score row and the message the board eventually gives up and shows. */
  const copy = useMemo(() => {
    const them = (recipientName || (lang === "ar" ? "هي" : "YOU")).toUpperCase().slice(0, 5);
    const me = (senderName || (lang === "ar" ? "أنا" : "ME")).toUpperCase().slice(0, 5);
    const body = (message.trim() || pick(lang, "YOU WERE RIGHT", "الحقّ معك")).toUpperCase();
    return {
      them,
      me,
      title: pick(lang, "WHO'S RIGHT", "مَن على حق"),
      lines: layout(body).map(padded),
      final: pick(lang, "FINAL", "نهائي"),
    };
  }, [senderName, recipientName, message, lang]);

  /* One score row + ROWS message rows. RTL only reverses the column order — each
     cell still holds a single shaped glyph, so nothing about the flap changes.
     The mutable flap state lives in a ref (a useMemo may not be written to after
     render); the render only ever reads SLOTS, which never changes. */
  const rtl = lang === "ar";
  const cellsRef = useRef<Cell[]>(SLOTS.map(restCell));

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const gRef = useRef({ taps: 0, score: START_SCORE, gaveUpAt: -1, touched: false, clicker: 0 });
  useEffect(() => {
    if (phase !== "opening") return;
    gRef.current = { taps: 0, score: START_SCORE, gaveUpAt: -1, touched: false, clicker: 0 };
    cellsRef.current = SLOTS.map(restCell);
  }, [phase]);

  /** Send the whole board to the message, staggered — the glorious cascade. */
  const runAll = () => {
    const rand = mulberry32(7717);
    const cells = cellsRef.current;
    for (let i = 0; i < SLOTS.length; i++) {
      const { row, col } = SLOTS[i];
      const c = cells[i];
      c.to = (copy.lines[row] ?? "")[col] ?? " ";
      c.flip = 0;
      c.swapped = false;
      // Down and across, with a little jitter so it clatters rather than pulses.
      c.delay = i * CASCADE_STEP + rand() * 0.05;
    }
  };

  /* The two screen-printed lines: the header that never changes, and the footer
     that says how this was always going to end. */
  const printed = useMemo(() => {
    const mk = (t: string, size: number) =>
      makeTextTexture(t, {
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        fontWeight: "700",
        fontSize: size,
        color: fin.ink,
        maxWidthPx: size * 18,
        padding: 10,
        lang,
      }).texture;
    return { title: mk(copy.title, 64), final: mk(`${copy.me}  3  ·  ${copy.final}`, 48) };
  }, [copy, fin, lang]);
  useEffect(
    () => () => {
      printed.title.dispose();
      printed.final.dispose();
    },
    [printed],
  );

  const fitRef = useRef<THREE.Group>(null);
  const flapRefs = useRef<(THREE.Group | null)[]>([]);
  const flapMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const clickerRef = useRef<THREE.Group>(null);
  const scoreRef = useRef<THREE.Mesh>(null);
  const scoreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const finalMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  /* The score line is one raster, redrawn only when the number actually changes. */
  const scoreTex = useRef<THREE.CanvasTexture | null>(null);
  const scoreShown = useRef(-1);
  const drawScore = useMemo(
    () => (n: number) => {
      scoreTex.current?.dispose();
      const { texture } = makeTextTexture(`${copy.them}  ${n}   —   ${copy.me}  3`, {
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        fontWeight: "700",
        fontSize: 72,
        color: fin.ink,
        maxWidthPx: 72 * 22,
        padding: 16,
        lang,
      });
      scoreTex.current = texture;
      if (scoreMatRef.current) scoreMatRef.current.map = texture;
    },
    [copy, fin, lang],
  );
  useEffect(() => {
    drawScore(START_SCORE);
    scoreShown.current = START_SCORE;
    return () => {
      scoreTex.current?.dispose();
      scoreTex.current = null;
    };
  }, [drawScore]);

  const onTap = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    const c = gRef.current;
    if (c.gaveUpAt >= 0) return;
    resumeAudio();
    c.touched = true;
    c.taps += 1;
    c.clicker = 1;
    // Theirs climbs. Then it climbs by tens, because the board is losing patience
    // with the exercise. His does not move. Ever.
    c.score += c.taps < 3 ? 1 : 10 * (c.taps - 1);
    clack({ freq: 1500, decay: 0.07, gain: 0.34 });
    if (c.taps >= TAPS) {
      c.gaveUpAt = tRef.current;
      runAll();
      tone(330, { type: "square", seconds: 0.3, gain: 0.16 });
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const c = gRef.current;
    const cells = cellsRef.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.52, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    if (c.score !== scoreShown.current) {
      scoreShown.current = c.score;
      drawScore(c.score);
    }

    /* ---- the flaps ---- */
    for (let i = 0; i < SLOTS.length; i++) {
      const cell = cells[i];
      const grp = flapRefs.current[i];
      const mat = flapMats.current[i];
      if (!grp || !mat) continue;
      if (cell.flip >= 0) {
        if (cell.delay > 0) cell.delay -= dt;
        else {
          cell.flip += dt / FLIP_DUR;
          if (!cell.swapped && cell.flip >= 0.5) {
            // Swap at the halfway point, where the flap is edge-on and nothing shows.
            cell.swapped = true;
            cell.ch = cell.to;
            mat.map = glyph(cell.ch, fin.ink, lang);
            mat.opacity = cell.ch === " " ? 0 : 1;
            mat.needsUpdate = true;
            // Every third flap only: sixty simultaneous WebAudio graphs is not a
            // clatter, it is a crackle, and a real board doesn't clack per letter
            // loudly enough to hear each one anyway.
            if (i % 3 === 0) clack({ freq: 2100 + ((i * 37) % 700), decay: 0.035, gain: 0.07 });
          }
          if (cell.flip >= 1) cell.flip = -1;
        }
      }
      const f = cell.flip;
      // -PI/2 out, then back from +PI/2 — the jump between them happens edge-on.
      grp.rotation.x = f < 0 ? 0 : f < 0.5 ? -f * Math.PI : (1 - f) * Math.PI;
    }

    /* ---- the clicker on its string ---- */
    if (clickerRef.current) {
      c.clicker = Math.max(0, c.clicker - dt * 4);
      clickerRef.current.rotation.z = Math.sin(e * 1.4) * 0.05 + c.clicker * 0.4;
      clickerRef.current.position.y = -BOARD_H / 2 - 0.34 + c.clicker * 0.03;
      clickerRef.current.visible = phase === "opening" || phase === "sealed";
    }

    const post = phase === "revealed" ? POST_END : c.gaveUpAt >= 0 ? tRef.current - c.gaveUpAt : -1;
    // The score row stays lit until the board flips, then hands over to FINAL.
    if (scoreRef.current) scoreRef.current.visible = post < 0.25;
    if (finalMatRef.current) finalMatRef.current.opacity = phase === "preview" ? 0.85 : clamp01((post - 0.6) / 0.6);

    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.34 + 0.2 * Math.sin(e * 2.8) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  /* Sealed and revealed both have to be correct with no tap ever made. */
  useEffect(() => {
    if (phase === "opening") return;
    const show = phase === "sealed";
    const cells = cellsRef.current;
    for (let i = 0; i < SLOTS.length; i++) {
      const { row, col } = SLOTS[i];
      const cell = cells[i];
      cell.ch = show ? " " : (copy.lines[row] ?? "")[col] ?? " ";
      cell.to = cell.ch;
      cell.flip = -1;
      cell.delay = 0;
      cell.swapped = true;
      const mat = flapMats.current[i];
      if (!mat) continue;
      mat.map = glyph(cell.ch, fin.ink, lang);
      mat.opacity = cell.ch === " " ? 0 : 1;
      mat.needsUpdate = true;
    }
  }, [phase, copy, fin, lang]);

  const cellX = (col: number) => (rtl ? COLS - 1 - col : col) * (CELL_W + GAP) - BOARD_W / 2 + CELL_W / 2 + GAP / 2;
  const cellY = (row: number) => BOARD_H / 2 - (row + 1.9) * (CELL_H + GAP);

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0, 3.4]} fov={42} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.42} />
      {/* a dim hallway: one overhead throw and a cold bounce off the far wall */}
      <spotLight position={[0, 2.6, 2]} angle={0.8} penumbra={0.9} intensity={22} color="#ffeccd" distance={9} />
      <pointLight position={[-2.2, -0.8, 1.4]} intensity={0.4} color="#6d7f9c" />

      <mesh position={[0, 0, -0.6]}>
        <planeGeometry args={[16, 10]} />
        <meshStandardMaterial color={fin.wall} roughness={0.95} />
      </mesh>

      <group ref={fitRef}>
        {/* the case */}
        <mesh position={[0, 0, -0.06]}>
          <boxGeometry args={[BOARD_W + 0.14, BOARD_H + 0.14, 0.1]} />
          <meshStandardMaterial color={fin.case} roughness={fin.rough} metalness={fin.metal} />
        </mesh>
        {/* the dark well the flaps sit in */}
        <mesh position={[0, 0, -0.005]}>
          <planeGeometry args={[BOARD_W + 0.02, BOARD_H + 0.02]} />
          <meshStandardMaterial color="#0e0d0c" roughness={0.9} />
        </mesh>

        {/* WHO'S RIGHT, screen-printed across the top and not going anywhere */}
        <mesh position={[0, BOARD_H / 2 - 0.16, 0.03]}>
          <planeGeometry args={[BOARD_W * 0.72, 0.16]} />
          <meshBasicMaterial map={printed.title} transparent depthWrite={false} toneMapped={false} />
        </mesh>

        {/* the score. Theirs climbs; his is 3. */}
        <mesh ref={scoreRef} position={[0, BOARD_H / 2 - 0.42, 0.03]}>
          <planeGeometry args={[BOARD_W * 0.88, 0.2]} />
          <meshBasicMaterial ref={scoreMatRef} transparent depthWrite={false} toneMapped={false} />
        </mesh>

        {/* the flaps */}
        {SLOTS.map((slot, i) => (
          <group key={i} position={[cellX(slot.col), cellY(slot.row) + CELL_H / 2, 0.02]}>
            <group
              ref={(el) => {
                flapRefs.current[i] = el;
              }}
            >
              <mesh position={[0, -CELL_H / 2, 0]}>
                <planeGeometry args={[CELL_W, CELL_H]} />
                <meshStandardMaterial color={fin.flap} roughness={fin.rough} metalness={fin.metal} side={THREE.DoubleSide} />
              </mesh>
              <mesh position={[0, -CELL_H / 2, 0.004]}>
                <planeGeometry args={[CELL_W * 0.94, CELL_H * 0.94]} />
                <meshBasicMaterial
                  ref={(m) => {
                    flapMats.current[i] = m;
                  }}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            </group>
          </group>
        ))}

        {/* bottom row, small: his 3, FINAL */}
        <mesh position={[0, -BOARD_H / 2 + 0.09, 0.03]}>
          <planeGeometry args={[BOARD_W * 0.46, 0.1]} />
          <meshBasicMaterial ref={finalMatRef} map={printed.final} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>

        {/* the clicker, hanging on a string */}
        <group ref={clickerRef} position={[0, -BOARD_H / 2 - 0.34, 0.14]}>
          <mesh position={[0, 0.19, 0]}>
            <cylinderGeometry args={[0.004, 0.004, 0.38, 5]} />
            <meshStandardMaterial color="#6a5f52" roughness={0.9} />
          </mesh>
          <mesh onPointerDown={onTap}>
            <cylinderGeometry args={[0.075, 0.075, 0.05, 20]} />
            <meshStandardMaterial color="#b8362f" roughness={0.42} metalness={0.2} />
          </mesh>
          <mesh position={[0, 0.028, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.02, 14]} />
            <meshStandardMaterial color="#e8e3d8" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.06]}>
            <planeGeometry args={[0.42, 0.42]} />
            <meshBasicMaterial ref={hintMatRef} map={HINT} color="#ffd9a0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      </group>
    </>
  );
}
