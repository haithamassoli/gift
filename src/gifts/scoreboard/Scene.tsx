import { Fragment, useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, lerp, mulberry32, smooth } from "../math";
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
const HALF_H = CELL_H / 2;
const GLYPH_W = CELL_W * 0.94;
const GLYPH_H = CELL_H * 0.94;
const BOARD_W = COLS * (CELL_W + GAP);
const BOARD_H = (ROWS + 2.4) * (CELL_H + GAP);
const ACTION_W = BOARD_W + 0.9;
const ACTION_H = BOARD_H + 0.8;
const CAM_Z = 3.4;
const CLICK_Y = -BOARD_H / 2 - 0.02; // where the string is tied
const STRING_L = 0.36;

/* ---------- flap glyph textures, cached across every board on the page ---------- */
// One 96px canvas per distinct character. A board only ever shows a few dozen, and
// makeTextTexture is the same rasterizer the rest of the catalog engraves with.
// makeTextTexture centres its baseline, so the glyph's waist lands on v = 0.5 —
// which is what lets a single texture be cut into a top and a bottom half below.
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

/* ---------- the flap, as the mechanism actually works ---------- */
// A split-flap card is cut across its waist. The upper leaf is hinged on that cut
// and falls forward through 180°: its front carries the old character's top half,
// its back the new character's bottom half, and behind it the next card's top half
// is already waiting. Four half-quads per cell, and the whole illusion is that the
// two static ones only exist while something is in motion.
/** A half-cell quad hinged on the cell's mid-line. `up` puts it above the hinge;
 *  `mirror` pre-flips its UVs so a face reads right way up once the leaf has
 *  fallen through 180° (a rotation about x flips y, and nothing else). */
function halfQuad(up: boolean, mirror: boolean, z: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(GLYPH_W, GLYPH_H / 2);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const v = uv.getY(i);
    uv.setY(i, mirror ? 0.5 - v * 0.5 : up ? 0.5 + v * 0.5 : v * 0.5);
  }
  g.translate(0, (up ? 1 : -1) * (GLYPH_H / 4), z);
  return g;
}
// The stack, front to back: leaf glyph, leaf, shadow, card glyph, card — and all
// of it has to clear the dark well at z = -0.005 that the flaps sit in.
// The leaf rides proud of the card it is falling away from — and by more than the
// wind-up can lean it back, or the rock would sink the leaf through the waiting
// glyph behind it for the two frames before it lets go.
const CARD_Z = 0.026;
const GEO_LEAF_FRONT = halfQuad(true, false, 0.004);
const GEO_LEAF_BACK = halfQuad(true, true, -0.004);
const GEO_TOP = halfQuad(true, false, 0.008);
const GEO_BOT = halfQuad(false, false, 0.008);
const GEO_LEAF = new THREE.PlaneGeometry(CELL_W, HALF_H).translate(0, HALF_H / 2, 0);
const GEO_CARD = new THREE.PlaneGeometry(CELL_W, CELL_H).translate(0, 0, 0.004);
const GEO_SHADE = new THREE.PlaneGeometry(CELL_W, HALF_H).translate(0, -HALF_H / 2, 0.012);

/* the leaf's own shadow, thrown down the card below it as it comes over */
function buildShadeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, "rgba(0,0,0,0.7)");
  gr.addColorStop(0.3, "rgba(0,0,0,0.32)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(c);
}
const SHADE = buildShadeTexture();

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
const FLIP_DUR = 0.3; // one leaf, hinge to stop
const FLIP_WIND = 0.13; // the fraction of it spent rocking back before it lets go
const FLIP_END = 1.24; // …and past 1 it rattles against the stop
const CASCADE_STEP = 0.075; // the wave's step, per row and per fraction of a column
const POST_END = 2.9;
const START_SCORE = 47;
const AUTO_FROM = 5.0; // the board starts tapping itself if nobody will
const AUTO_GAP = 1.05;
const PREV_PERIOD = 5.6; // the gallery card refreshes itself on this loop
const HINT = makeRadialSprite(64);

/* Where every flap sits. Fixed by COLS/ROWS, so it is laid out once at module
   scope and the render just maps it — only the *state* below ever changes. */
const SLOTS: { row: number; col: number }[] = [];
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) SLOTS.push({ row, col });
}

// What a board reaches for while it is thinking. One shaped glyph per cell either
// way, so Arabic needs its own alphabet and nothing else.
const JUNK_EN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const JUNK_AR = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي٠١٢٣٤٥٦٧٨٩";

/* ---------- dust ---------- */
const AMB_N = 36; // motes that just live in the light
const BURST_N = 48; // and the ones the cascade shakes loose
const DUST_N = AMB_N + BURST_N;
const DUST_LIFE = 1.9;
function buildAmbient(): Float32Array {
  const rand = mulberry32(5309);
  const a = new Float32Array(AMB_N * 4);
  for (let i = 0; i < a.length; i++) a[i] = rand();
  return a;
}
const AMB = buildAmbient();

/** The leaf's angle at `f` — a wind-up, an accelerating fall, then a rattle.
 *  Positive, because a positive rotation about x carries the leaf's free edge
 *  toward the viewer: the leaf falls out over the board, not back through it. */
function leafAngle(f: number): number {
  if (f < 0) return 0;
  // It rocks back off the stop before it goes: nothing heavy starts from nothing.
  if (f < FLIP_WIND) return -Math.sin((f / FLIP_WIND) * Math.PI) * 0.14;
  if (f < 1) {
    const q = (f - FLIP_WIND) / (1 - FLIP_WIND);
    return Math.PI * Math.pow(q, 1.45); // gravity, not a linear ramp
  }
  const r = (f - 1) / (FLIP_END - 1);
  return Math.PI - Math.sin(r * Math.PI * 3) * 0.11 * (1 - r);
}

interface Cell {
  /** what the flap currently shows */
  ch: string;
  /** what it is on its way to */
  to: string;
  /** 0..FLIP_END through the flip; -1 = at rest */
  flip: number;
  /** seconds still to wait before the flip starts */
  delay: number;
  /** the incoming card has been dressed behind the leaf */
  armed: boolean;
  /** the stop has been hit, and heard */
  landed: boolean;
}
const restCell = (): Cell => ({ ch: " ", to: " ", flip: -1, delay: 0, armed: false, landed: false });

/** Point one half-quad at a character. A space is most of the board, and the
    cheapest pixel there is is the one that never enters the render list. */
function setHalf(mesh: THREE.Mesh | null, ch: string, ink: string, lang: Lang) {
  if (!mesh) return;
  const tex = glyph(ch, ink, lang);
  mesh.visible = tex !== null;
  if (!tex) return;
  const mat = mesh.material as THREE.MeshBasicMaterial;
  if (mat.map !== tex) {
    mat.map = tex;
    mat.needsUpdate = true;
  }
}
function hideHalf(mesh: THREE.Mesh | null) {
  if (mesh) mesh.visible = false;
}

const dummy = new THREE.Object3D();

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
      junk: lang === "ar" ? JUNK_AR : JUNK_EN,
    };
  }, [senderName, recipientName, message, lang]);

  /* One score row + ROWS message rows. RTL only reverses the column order — each
     cell still holds a single shaped glyph, so nothing about the flap changes.
     The mutable flap state lives in a ref (a useMemo may not be written to after
     render); the render only ever reads SLOTS and `pos`, which never change. */
  const rtl = lang === "ar";
  const cellsRef = useRef<Cell[]>(SLOTS.map(restCell));

  /** x and the mid-line y of every cell — the hinge every quad is built around. */
  const pos = useMemo(() => {
    const a = new Float32Array(SLOTS.length * 2);
    for (let i = 0; i < SLOTS.length; i++) {
      const { row, col } = SLOTS[i];
      a[i * 2] = (rtl ? COLS - 1 - col : col) * (CELL_W + GAP) - BOARD_W / 2 + CELL_W / 2 + GAP / 2;
      a[i * 2 + 1] = BOARD_H / 2 - (row + 1.9) * (CELL_H + GAP);
    }
    return a;
  }, [rtl]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const gRef = useRef({
    taps: 0,
    score: START_SCORE,
    gaveUpAt: -1,
    touched: false,
    lastTap: -99,
    /** how hard they are mashing, 0..1 — it drives the roll, the flip and the pitch */
    mash: 0,
    /** clicker pendulum: angle, angular velocity, and the button under the thumb */
    ca: 0,
    cv: 0,
    press: 0,
    hover: 0,
    /** the knock the board takes, and the throttle on the clatter */
    shake: 0,
    clatter: 0,
    /** preview's refresh loop / sealed's twitch timer */
    idle: 0,
    roll: 0,
    settled: false,
    /** the render clock, so a pointer handler can stamp a particle with it —
        event timestamps are a different epoch entirely and would never expire */
    now: 0,
  });

  /* ---------- score raster, redrawn only when the number actually changes ---------- */
  const scoreTex = useRef<THREE.CanvasTexture | null>(null);
  const scoreShown = useRef(START_SCORE);
  const scoreMatRef = useRef<THREE.MeshBasicMaterial>(null);
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

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const boardRef = useRef<THREE.Group>(null);
  const leafInstRef = useRef<THREE.InstancedMesh>(null);
  const cardInstRef = useRef<THREE.InstancedMesh>(null);
  const shadeInstRef = useRef<THREE.InstancedMesh>(null);
  const frontRefs = useRef<(THREE.Mesh | null)[]>([]);
  const backRefs = useRef<(THREE.Mesh | null)[]>([]);
  const topRefs = useRef<(THREE.Mesh | null)[]>([]);
  const botRefs = useRef<(THREE.Mesh | null)[]>([]);
  const clickerRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const capRef = useRef<THREE.Mesh>(null);
  const scoreRef = useRef<THREE.Mesh>(null);
  const finalRef = useRef<THREE.Mesh>(null);
  const finalMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lampRef = useRef<THREE.SpotLight>(null);
  const warmRef = useRef<THREE.PointLight>(null);
  const sweepRef = useRef<THREE.Mesh>(null);
  const sweepMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const dustRef = useRef<THREE.Points>(null);

  const dustBuf = useMemo(
    () => ({ pos: new Float32Array(DUST_N * 3), col: new Float32Array(DUST_N * 3) }),
    [],
  );
  const dust = useRef({
    t0: new Float32Array(BURST_N).fill(-99),
    o: new Float32Array(BURST_N * 3),
    v: new Float32Array(BURST_N * 3),
    cursor: 0,
  });

  /* The cards behind the leaves never move, so they are stamped once. */
  useEffect(() => {
    const inst = cardInstRef.current;
    if (!inst) return;
    for (let i = 0; i < SLOTS.length; i++) {
      dummy.position.set(pos[i * 2], pos[i * 2 + 1], 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  }, [pos]);

  useEffect(() => {
    if (phase !== "opening") return;
    const c = gRef.current;
    c.taps = 0;
    c.score = START_SCORE;
    c.gaveUpAt = -1;
    c.touched = false;
    c.lastTap = -99;
    c.mash = c.ca = c.cv = c.press = c.hover = c.shake = c.roll = c.idle = 0;
    c.settled = false;
    cellsRef.current = SLOTS.map(restCell);
    dust.current.t0.fill(-99);
    scoreShown.current = START_SCORE;
    drawScore(START_SCORE);
    for (let i = 0; i < SLOTS.length; i++) {
      hideHalf(frontRefs.current[i]);
      hideHalf(backRefs.current[i]);
      hideHalf(topRefs.current[i]);
      hideHalf(botRefs.current[i]);
    }
  }, [phase, drawScore]);

  /** Send the whole board somewhere, as a diagonal wave. `toMessage` false is the
      gallery card's refresh: it re-flips onto the text it is already showing. */
  const runAll = (toMessage: boolean) => {
    const rand = mulberry32(7717);
    const cells = cellsRef.current;
    for (let i = 0; i < SLOTS.length; i++) {
      const { row, col } = SLOTS[i];
      const cell = cells[i];
      cell.to = toMessage ? (copy.lines[row] ?? "")[col] ?? " " : cell.ch;
      cell.armed = false;
      cell.landed = false;
      // The column carries its own phase, so the clatter travels across the board
      // instead of ticking down it a row at a time. A cell already in the air keeps
      // its momentum and just retargets — restarting it would teleport the leaf.
      if (cell.flip < 0) {
        cell.flip = 0;
        cell.delay = (row + (rtl ? COLS - 1 - col : col) * 0.46) * CASCADE_STEP + rand() * 0.06;
      } else {
        cell.delay = 0;
      }
    }
  };

  /** A scatter of flaps reaching for something, which is all a tap really buys. */
  const scatter = (n: number, junk: boolean) => {
    const cells = cellsRef.current;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(Math.random() * SLOTS.length);
      const cell = cells[i];
      if (cell.flip >= 0) continue;
      cell.to = junk ? copy.junk[Math.floor(Math.random() * copy.junk.length)] : cell.ch;
      cell.flip = 0;
      cell.delay = Math.random() * 0.24;
      cell.armed = false;
      cell.landed = false;
    }
  };

  const emitDust = (e: number, n: number) => {
    const d = dust.current;
    for (let k = 0; k < n; k++) {
      const i = d.cursor;
      d.cursor = (i + 1) % BURST_N;
      d.t0[i] = e;
      d.o[i * 3] = (Math.random() - 0.5) * BOARD_W;
      d.o[i * 3 + 1] = (Math.random() - 0.5) * BOARD_H * 0.72;
      d.o[i * 3 + 2] = 0.05 + Math.random() * 0.06;
      d.v[i * 3] = (Math.random() - 0.5) * 0.16;
      d.v[i * 3 + 1] = -0.02 - Math.random() * 0.1;
      d.v[i * 3 + 2] = 0.08 + Math.random() * 0.24;
    }
  };

  /** One press of the clicker, whether a thumb or the board's own patience did it. */
  const bump = (t: number, byHand: boolean) => {
    const c = gRef.current;
    if (c.gaveUpAt >= 0) return;
    if (byHand) c.touched = true;
    c.taps += 1;
    c.lastTap = t;
    c.press = 1;
    c.mash = Math.min(1, c.mash + (byHand ? 0.36 : 0.12));
    c.cv -= 4.6 + c.mash * 2.6; // the string takes the whole shove
    c.shake = Math.min(1, c.shake + 0.35);
    // Theirs climbs. Then it climbs by tens, because the board is losing patience
    // with the exercise. His does not move. Ever.
    c.score += c.taps < 3 ? 1 : 10 * (c.taps - 1);
    clack({ freq: 1400 + c.mash * 420 + Math.random() * 180, decay: 0.07, gain: 0.3 });
    scatter(4 + c.taps * 6, true);
    if (c.taps >= TAPS) {
      c.gaveUpAt = t;
      runAll(true);
      emitDust(c.now, BURST_N);
      c.shake = 1;
      c.cv -= 3.4;
      tone(330, { type: "square", seconds: 0.3, gain: 0.16 });
    }
  };

  const onTap = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    resumeAudio();
    bump(tRef.current, true);
  };
  const onOver = () => {
    if (phase === "opening") gRef.current.hover = 1;
  };
  const onOut = () => {
    gRef.current.hover = 0;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const c = gRef.current;
    const cells = cellsRef.current;
    c.now = e;

    /* ---- the hallway, which has never once been maintained ---- */
    // Sines at frequencies that share no multiple, plus a rare hard stutter: a
    // tube on its way out drops out entirely for a frame or two and comes back.
    const lamp =
      (1 + 0.05 * Math.sin(e * 7.7) + 0.033 * Math.sin(e * 13.3 + 1.1) + 0.02 * Math.sin(e * 29.1 + 2.6)) *
      (1 - 0.5 * Math.pow(Math.max(0, Math.sin(e * 0.41 + 2.2)), 60));

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.52, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- the board gives up on its own if nobody will help it ---- */
    if (phase === "opening" && c.gaveUpAt < 0 && t > AUTO_FROM && t - c.lastTap > AUTO_GAP) bump(t, false);
    c.mash = Math.max(0, c.mash - dt * 0.5);
    c.shake = Math.max(0, c.shake - dt * 2.6);
    c.press = Math.max(0, c.press - dt * 5);

    /* ---- ambient life, one kind per phase ---- */
    if (phase === "preview") {
      // A departure board refreshes itself whether or not anyone is reading it.
      c.idle += dt;
      if (c.idle > PREV_PERIOD) {
        c.idle = 0;
        runAll(false);
      }
    } else if (phase === "sealed") {
      // Waiting, not resting: every few seconds one flap twitches on nothing.
      c.idle -= dt;
      if (c.idle <= 0) {
        c.idle = 1.4 + Math.random() * 1.9;
        scatter(1 + Math.floor(Math.random() * 2), false);
      }
    }

    /* ---- the score, rolling rather than jumping ---- */
    const gap = c.score - scoreShown.current;
    if (gap !== 0) {
      c.roll += dt * (7 + c.mash * 34);
      if (c.roll >= 1) {
        c.roll = 0;
        // A forty-point jump rolls in sevens, not in ones: every intermediate
        // number is a whole re-raster, and the row is handed over to FINAL a beat
        // after the last tap — the climb has to land inside that beat.
        scoreShown.current += Math.sign(gap) * Math.max(1, Math.ceil(Math.abs(gap) / 6));
        drawScore(scoreShown.current);
        if (phase === "opening" && e - c.clatter > 0.02) {
          c.clatter = e;
          clack({ freq: 2500 + Math.random() * 600, decay: 0.02, gain: 0.05 });
        }
      }
    }

    /* ---- the flaps ---- */
    const flipDur = FLIP_DUR / (1 + c.mash * 0.9); // mashing makes the board hurry
    const leaves = leafInstRef.current;
    const shades = shadeInstRef.current;
    for (let i = 0; i < SLOTS.length; i++) {
      const cell = cells[i];
      if (cell.flip >= 0) {
        if (cell.delay > 0) cell.delay -= dt;
        else {
          if (!cell.armed) {
            // The incoming card is dressed before the leaf clears it: its top half
            // sits waiting behind, its bottom half rides the leaf's back down.
            cell.armed = true;
            setHalf(topRefs.current[i], cell.to, fin.ink, lang);
            setHalf(backRefs.current[i], cell.to, fin.ink, lang);
          }
          cell.flip += dt / flipDur;
          if (!cell.landed && cell.flip >= 0.92) {
            cell.landed = true;
            // Pitch and gain jittered per flap, and throttled: sixty simultaneous
            // WebAudio graphs is not a clatter, it is a crackle, and a real board
            // never lets you hear each letter anyway.
            if (phase === "opening" && e - c.clatter > 0.026 && Math.random() < 0.6) {
              c.clatter = e;
              clack({
                freq: 1700 + Math.random() * 900,
                decay: 0.026 + Math.random() * 0.022,
                gain: 0.05 + Math.random() * 0.035,
              });
            }
          }
          if (cell.flip >= FLIP_END) {
            // The display already reads the new character, so the reset is invisible.
            cell.flip = -1;
            cell.armed = false;
            cell.landed = false;
            cell.ch = cell.to;
            setHalf(frontRefs.current[i], cell.ch, fin.ink, lang);
            setHalf(botRefs.current[i], cell.ch, fin.ink, lang);
            hideHalf(topRefs.current[i]);
            hideHalf(backRefs.current[i]);
          }
        }
      }
      const th = leafAngle(cell.flip);
      const fm = frontRefs.current[i];
      const bm = backRefs.current[i];
      if (fm) fm.rotation.x = th;
      if (bm) bm.rotation.x = th;
      if (leaves) {
        dummy.position.set(pos[i * 2], pos[i * 2 + 1], CARD_Z);
        dummy.rotation.set(th, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        leaves.setMatrixAt(i, dummy.matrix);
      }
      if (shades) {
        // The shadow line runs down the lower card exactly as far as the leaf has
        // come over it — and by the time it is full the leaf itself covers it.
        dummy.position.set(pos[i * 2], pos[i * 2 + 1], 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, Math.max(0.0001, clamp01(th / Math.PI)), 1);
        dummy.updateMatrix();
        shades.setMatrixAt(i, dummy.matrix);
      }
    }
    if (leaves) leaves.instanceMatrix.needsUpdate = true;
    if (shades) shades.instanceMatrix.needsUpdate = true;

    /* ---- the clicker, on its string ---- */
    const c0 = clickerRef.current;
    if (c0) {
      // A real pendulum: gravity pulls it back, the string eats the energy. The
      // idle sway rides on top rather than fighting the spring for the same angle.
      c.cv += (-26 * c.ca - 3.1 * c.cv) * dt;
      c.ca += c.cv * dt;
      const untouched = phase === "opening" && !c.touched;
      // Before the first press it leans toward whoever is thinking about it.
      const lean = untouched ? state.pointer.x * 0.1 + Math.sin(e * 1.1) * 0.05 : 0;
      const sway = Math.sin(e * 1.35) * 0.04 + Math.sin(e * 0.83 + 1.9) * 0.026;
      c0.rotation.z = c.ca + sway + lean;
      c0.rotation.x = Math.sin(e * 0.97 + 0.6) * 0.03 + c.press * 0.06;
      c0.visible = phase !== "revealed";
    }
    if (bodyRef.current) {
      const hov = c.hover * 0.045;
      bodyRef.current.scale.set(1 + hov + c.press * 0.05, 1 + hov - c.press * 0.07, 1 + hov + c.press * 0.05);
    }
    if (capRef.current) capRef.current.position.y = 0.028 - c.press * 0.016;

    /* ---- the reveal, in beats ---- */
    const post = phase === "revealed" ? POST_END : c.gaveUpAt >= 0 ? t - c.gaveUpAt : -1;
    // The score row stays lit until the board flips, then hands over to FINAL —
    // but never before the last digit has landed, because the number is the joke.
    if (scoreRef.current) scoreRef.current.visible = post < 0.25 || gap !== 0;
    if (finalMatRef.current) finalMatRef.current.opacity = phase === "preview" ? 0.85 : clamp01((post - 0.6) / 0.6);
    if (finalRef.current) {
      const a = phase === "preview" ? 1 : clamp01((post - 0.6) / 0.5);
      finalRef.current.scale.setScalar(a <= 0 ? 0.001 : easeOutBack(a));
    }
    if (post >= 1.45 && !c.settled && phase === "opening") {
      c.settled = true;
      c.shake = Math.min(1, c.shake + 0.3);
      tone(196, { type: "sine", seconds: 0.8, gain: 0.1, shimmer: true });
    }

    /* ---- the board itself: breathing, then knocked, then settling ---- */
    const b = boardRef.current;
    if (b) {
      // The knock from a press, and the whole-board rattle when the wave lands.
      const land = post >= 0 ? Math.exp(-Math.max(0, post - 1.15) * 4.2) * clamp01((post - 1.1) / 0.08) : 0;
      const jit = c.shake * 0.006 + land * 0.005;
      b.position.set(Math.sin(e * 47) * jit, Math.sin(e * 39 + 1.3) * jit, 0);
      b.rotation.z = Math.sin(e * 31 + 0.7) * jit * 0.6;
      // and, under all of it, a wall-mounted thing settling on its screws
      b.scale.setScalar(1 + Math.sin(e * 0.72) * 0.0016);
      b.rotation.y = Math.sin(e * 0.41 + 2.1) * 0.008;
    }

    /* ---- light: the hallway flickers, and the reveal earns a warmer one ---- */
    const push = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / 1.6));
    if (lampRef.current) lampRef.current.intensity = 22 * lamp * (1 + push * 0.34);
    if (warmRef.current) warmRef.current.intensity = push * 2.6 * lamp;
    if (sweepRef.current && sweepMatRef.current) {
      // The specular the flat lighting cannot give: one soft bar crossing the face,
      // and it brightens and dims with the tube rather than sliding on its own.
      sweepRef.current.position.x = (((e * 0.11) % 1) * 2.4 - 1.2) * BOARD_W;
      sweepMatRef.current.opacity = clamp01(0.055 + (lamp - 1) * 0.3) * (0.7 + push * 0.6);
    }

    /* ---- camera: a small push-in that the reveal pays for ---- */
    const cam = camRef.current;
    if (cam) {
      cam.position.set(
        Math.sin(e * 0.21) * 0.05 + Math.sin(e * 43) * c.shake * 0.012,
        Math.sin(e * 0.17 + 1.4) * 0.035 + Math.sin(e * 37 + 2.2) * c.shake * 0.01,
        CAM_Z - 0.32 * push,
      );
      cam.lookAt(0, lerp(0, 0.04, push), 0);
    }

    /* ---- the hint, which stops the instant they touch it ---- */
    if (hintMatRef.current) {
      const want =
        phase === "opening" && !c.touched ? 0.3 + 0.2 * Math.sin(e * 2.8) + c.hover * 0.25 : c.hover * 0.2;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- dust ---- */
    const dp = dustRef.current;
    if (dp) {
      const d = dust.current;
      const pa = dp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = dp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < AMB_N; i++) {
        // Motes that only ever hang in the light — no state, so a cold `revealed`
        // frame has them exactly where they belong.
        const sx = AMB[i * 4];
        const sy = AMB[i * 4 + 1];
        const sp = 0.008 + AMB[i * 4 + 2] * 0.02;
        const ph = AMB[i * 4 + 3] * 6.283;
        const fall = ((sy - e * sp) % 1 + 1) % 1;
        pa.setXYZ(
          i,
          (sx - 0.5) * BOARD_W * 1.5 + Math.sin(e * 0.31 + ph) * 0.06,
          (fall - 0.5) * BOARD_H * 1.5,
          0.16 + Math.sin(e * 0.24 + ph) * 0.1,
        );
        const k = (0.18 + 0.14 * Math.sin(e * 1.7 + ph)) * lamp;
        ca.setXYZ(i, k, k * 0.9, k * 0.7);
      }
      for (let i = 0; i < BURST_N; i++) {
        const j = AMB_N + i;
        const a = e - d.t0[i];
        if (a < 0 || a > DUST_LIFE) {
          ca.setXYZ(j, 0, 0, 0);
          continue;
        }
        pa.setXYZ(
          j,
          d.o[i * 3] + d.v[i * 3] * a,
          d.o[i * 3 + 1] + d.v[i * 3 + 1] * a - 0.09 * a * a,
          d.o[i * 3 + 2] + d.v[i * 3 + 2] * a,
        );
        const k = (1 - a / DUST_LIFE) * 0.6 * lamp;
        ca.setXYZ(j, k, k * 0.92, k * 0.74);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  /* Sealed and revealed both have to be correct with no tap ever made. */
  useEffect(() => {
    if (phase === "opening") return;
    // The gallery card should not sit still for a full period before it proves
    // it is a split-flap board, so the first refresh is nearly due on mount.
    gRef.current.idle = phase === "preview" ? PREV_PERIOD - 1.5 : 0;
    const show = phase === "sealed";
    const cells = cellsRef.current;
    for (let i = 0; i < SLOTS.length; i++) {
      const { row, col } = SLOTS[i];
      const cell = cells[i];
      cell.ch = show ? " " : (copy.lines[row] ?? "")[col] ?? " ";
      cell.to = cell.ch;
      cell.flip = -1;
      cell.delay = 0;
      cell.armed = false;
      cell.landed = false;
      setHalf(frontRefs.current[i], cell.ch, fin.ink, lang);
      setHalf(botRefs.current[i], cell.ch, fin.ink, lang);
      hideHalf(topRefs.current[i]);
      hideHalf(backRefs.current[i]);
    }
  }, [phase, copy, fin, lang]);

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, 0, CAM_Z]} fov={42} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.42} />
      {/* a dim hallway: one overhead throw and a cold bounce off the far wall */}
      <spotLight ref={lampRef} position={[0, 2.6, 2]} angle={0.8} penumbra={0.9} intensity={22} color="#ffeccd" distance={9} />
      <pointLight position={[-2.2, -0.8, 1.4]} intensity={0.4} color="#6d7f9c" />
      {/* and, once the board has said its piece, something warmer in front of it */}
      <pointLight ref={warmRef} position={[0, -0.2, 1.5]} intensity={0} color="#ffd39a" distance={6} />

      <mesh position={[0, 0, -0.6]}>
        <planeGeometry args={[16, 10]} />
        <meshStandardMaterial color={fin.wall} roughness={0.95} />
      </mesh>

      <group ref={fitRef}>
        <group ref={boardRef}>
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
          <mesh position={[0, BOARD_H / 2 - 0.16, 0.06]}>
            <planeGeometry args={[BOARD_W * 0.72, 0.16]} />
            <meshBasicMaterial map={printed.title} transparent depthWrite={false} toneMapped={false} />
          </mesh>

          {/* the score. Theirs climbs; his is 3. */}
          <mesh ref={scoreRef} position={[0, BOARD_H / 2 - 0.42, 0.06]}>
            <planeGeometry args={[BOARD_W * 0.88, 0.2]} />
            <meshBasicMaterial ref={scoreMatRef} transparent depthWrite={false} toneMapped={false} />
          </mesh>

          {/* Three instanced passes carry every card, leaf and shadow on the board —
              only the glyphs, which each need their own map, are drawn one by one. */}
          <instancedMesh ref={cardInstRef} args={[GEO_CARD, undefined, SLOTS.length]} frustumCulled={false}>
            <meshStandardMaterial color={fin.flap} roughness={fin.rough} metalness={fin.metal} />
          </instancedMesh>
          <instancedMesh ref={leafInstRef} args={[GEO_LEAF, undefined, SLOTS.length]} frustumCulled={false}>
            <meshStandardMaterial color={fin.flap} roughness={fin.rough} metalness={fin.metal} side={THREE.DoubleSide} />
          </instancedMesh>
          <instancedMesh ref={shadeInstRef} args={[GEO_SHADE, undefined, SLOTS.length]} frustumCulled={false}>
            <meshBasicMaterial map={SHADE} transparent depthWrite={false} />
          </instancedMesh>

          {/* the glyph halves: two on the leaf, two on the card behind it */}
          {/* A Fragment, not a group: 108 more Object3Ds is 108 more matrices to
              recompose every frame for a node that would never move. */}
          {SLOTS.map((_, i) => (
            <Fragment key={i}>
              <mesh
                ref={(el) => {
                  topRefs.current[i] = el;
                }}
                geometry={GEO_TOP}
                position={[pos[i * 2], pos[i * 2 + 1], 0]}
                visible={false}
              >
                <meshBasicMaterial transparent depthWrite={false} toneMapped={false} />
              </mesh>
              <mesh
                ref={(el) => {
                  botRefs.current[i] = el;
                }}
                geometry={GEO_BOT}
                position={[pos[i * 2], pos[i * 2 + 1], 0]}
                visible={false}
              >
                <meshBasicMaterial transparent depthWrite={false} toneMapped={false} />
              </mesh>
              <mesh
                ref={(el) => {
                  frontRefs.current[i] = el;
                }}
                geometry={GEO_LEAF_FRONT}
                position={[pos[i * 2], pos[i * 2 + 1], CARD_Z]}
                visible={false}
              >
                <meshBasicMaterial transparent depthWrite={false} toneMapped={false} />
              </mesh>
              {/* BackSide is the whole trick: this face only exists once the leaf
                  has turned past edge-on, and culling does the timing for free. */}
              <mesh
                ref={(el) => {
                  backRefs.current[i] = el;
                }}
                geometry={GEO_LEAF_BACK}
                position={[pos[i * 2], pos[i * 2 + 1], CARD_Z]}
                visible={false}
              >
                <meshBasicMaterial transparent depthWrite={false} toneMapped={false} side={THREE.BackSide} />
              </mesh>
            </Fragment>
          ))}

          {/* the highlight the hallway tube drags across the face */}
          <mesh ref={sweepRef} position={[0, 0, 0.08]} scale={[0.5, BOARD_H * 1.25, 1]}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              ref={sweepMatRef}
              map={HINT}
              color="#fff0d2"
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>

          {/* bottom row, small: his 3, FINAL */}
          <mesh ref={finalRef} position={[0, -BOARD_H / 2 + 0.09, 0.06]}>
            <planeGeometry args={[BOARD_W * 0.46, 0.1]} />
            <meshBasicMaterial ref={finalMatRef} map={printed.final} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>

          {/* the clicker, hanging on a string — pivoted where the string is tied,
              so a press swings the thing rather than spinning it about its middle */}
          <group ref={clickerRef} position={[0, CLICK_Y, 0.14]}>
            <mesh position={[0, -STRING_L / 2, 0]}>
              <cylinderGeometry args={[0.004, 0.004, STRING_L, 5]} />
              <meshStandardMaterial color="#6a5f52" roughness={0.9} />
            </mesh>
            <group ref={bodyRef} position={[0, -STRING_L, 0]}>
              <mesh onPointerDown={onTap} onPointerOver={onOver} onPointerOut={onOut}>
                <cylinderGeometry args={[0.075, 0.075, 0.05, 20]} />
                <meshStandardMaterial color="#b8362f" roughness={0.42} metalness={0.2} />
              </mesh>
              <mesh ref={capRef} position={[0, 0.028, 0]}>
                <cylinderGeometry args={[0.03, 0.03, 0.02, 14]} />
                <meshStandardMaterial color="#e8e3d8" roughness={0.5} />
              </mesh>
              <mesh position={[0, 0, 0.06]}>
                <planeGeometry args={[0.42, 0.42]} />
                <meshBasicMaterial ref={hintMatRef} map={HINT} color="#ffd9a0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
              </mesh>
            </group>
          </group>
        </group>

        {/* dust: a few motes that always hang in the throw, and the puff the
            cascade knocks off the face. One buffer, two populations. */}
        <points ref={dustRef} position={[0, 0, 0.1]} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[dustBuf.pos, 3]} />
            <bufferAttribute attach="attributes-color" args={[dustBuf.col, 3]} />
          </bufferGeometry>
          <pointsMaterial
            map={HINT}
            vertexColors
            size={0.026}
            sizeAttenuation
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </points>
      </group>
    </>
  );
}
