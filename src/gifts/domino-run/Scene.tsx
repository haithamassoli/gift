import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { rasterTextGrid, makeTextTexture, type TextGrid } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, smooth, mulberry32 } from "../math";
import { clack, tone, resumeAudio } from "../audio";
import { pick } from "../catalog";
import { forRecipient } from "../../i18n";

/* ============================================================================
   DOMINO RUN — "everything falls into place", made literal.

   The trick, and it costs no physics engine: `rasterTextGrid` gives the message
   as a low-res boolean grid, and every LIT cell is where a fallen tile comes to
   rest. So the fallen tiles ARE the letters. A tile stands upright a half-cell
   upstream of its own cell and topples FORWARD into it — a rigid box pivoting on
   its front-bottom edge, angle 0→90°. No collisions, no forces: the "chain
   reaction" is pure scheduling. Each cell has a place in a boustrophedon sweep
   (row 0 left→right, row 1 right→left, …), and a tile falls when a wavefront
   advancing along that order reaches it. Clack per landing, throttled to a
   patter; a bell on the last tile; the camera tracks the toppling front and then
   pulls back overhead so the whole message reads at once.

   Why the reveal is a SECRET until it is over: the standing coil is filmed from a
   low ¾ angle where the tall thin tiles occlude one another into a hush of
   dominoes — you cannot read the pattern until the camera lifts straight over it.
   That lift IS the reveal. From above, the fallen field spells the words.
============================================================================ */

/* ---------- the tiles ---------- */
// A domino is placed thin-edge-forward so it topples the way it faces. These are
// stubbier than a real domino on purpose: a rigid box's fallen LENGTH equals its
// standing HEIGHT, and the fallen length has to be about one cell so a tile fills
// its own letter-cell rather than sprawling across two. So height ≈ one cell.
const CELL = 0.2; // world size of one grid cell — the whole layout scales off this
const TILE_H = 1.16 * CELL; // standing height, and the fallen length; slight overhang densifies letters
const TILE_W = 0.82 * CELL; // broad-face width, across the run — leaves a hairline gap between tiles
const TILE_T = 0.16 * CELL; // thickness, the thin edge that faces the fall
const HALF_PI = Math.PI / 2;

/* ---------- palettes ---------- */
// tiles: the domino face and the pip glow that answers it. Jet is lacquer, so it
// is the one that reads by its highlights rather than its colour; ivory is matte
// bone; rosewood is an oiled red-brown wood. Pip glow is additive, so it is a
// light and does not have to relate to the face's diffuse colour.
interface TilePalette {
  face: string;
  rough: number;
  metal: number;
  pip: string; // additive glow tint of the pips
  edge: string; // instanceColor floor — a hair of shading variation, see below
}
const TILES: Record<string, TilePalette> = {
  ivory: { face: "#efe6d2", rough: 0.62, metal: 0.04, pip: "#ffdf9e", edge: "#d8cbb0" },
  jet: { face: "#191b21", rough: 0.28, metal: 0.22, pip: "#bcd2f4", edge: "#0c0d12" },
  rosewood: { face: "#6e3a2b", rough: 0.44, metal: 0.06, pip: "#ffb877", edge: "#4c261b" },
};

// table: the surface the run lives on, and the border of dark it fades into. Felt
// is authored bright — Color.set takes sRGB down to linear, so a hex picked to
// *look* like green baize is already near-black before a light touches it.
interface TablePalette {
  top: string;
  rough: number;
  metal: number;
  amb: string; // ambient tint, the room the table sits in
}
const TABLES: Record<string, TablePalette> = {
  "green-felt": { top: "#2f6b44", rough: 0.96, metal: 0, amb: "#20321f" },
  walnut: { top: "#5a3a22", rough: 0.55, metal: 0.05, amb: "#2a2018" },
  slate: { top: "#3c424c", rough: 0.7, metal: 0.12, amb: "#22262c" },
};

/* ---------- opening timeline (seconds, measured from the flick) ---------- */
// The bound is on onOpenComplete and it is 12s, so the whole show is the budget,
// not the grant. Worst case nobody flicks: the run auto-starts at T_MERCY and the
// clock reads T_MERCY + MSG_DUR + GAP + NAMES_DUR + TOPPLE + SETTLE
//   = 3.0 + 4.5 + 0.35 + 1.7 + 0.26 + 0.85 = 10.66s, with slack for a slow first
// frame (dt is clamped to 0.05, so a phone that drops frames runs this clock
// BEHIND the wall clock the bound is actually taken on). A flick only shortens it.
const T_MERCY = 3.0; // the first tile tips on its own if no thumb ever arrives
const MSG_DUR = 4.5; // the wave crosses the whole message in this
const GAP = 0.35; // a beat between the message settling and the names' flourish
const NAMES_DUR = 1.7; // the shorter branch that spells the two names
const TOPPLE = 0.26; // one tile's fall, upright→flat
const SETTLE = 0.85; // the overhead framing holds before onOpenComplete
const CLACK_MIN = 0.042; // never two clacks closer than this — a patter, not a roar

/* ---------- camera ---------- */
const CAM_FOV = 42;
const TAN_HALF = Math.tan(((CAM_FOV * Math.PI) / 180) / 2);
// how far above/behind the toppling front the tracking camera rides, in cells so
// it holds whatever CELL becomes. Low and close: the letters must NOT be readable
// yet, which is the whole reason the reveal lands.
const OPEN_H = 9 * CELL;
const OPEN_BACK = 11.5 * CELL;
// The two framed poses are fitted to the viewport every frame (portrait phone to
// landscape desktop), so these are only directions + how much air to leave.
const REVEAL_DIR = new THREE.Vector3(0, 1, 0.42).normalize(); // nearly overhead, a touch tilted so it is a photograph and not a blueprint
const SEALED_DIR = new THREE.Vector3(0.32, 0.6, 1).normalize(); // a low ¾, where the standing tiles occlude the secret
const REVEAL_MARGIN = 1.16;
const SEALED_MARGIN = 1.34;

/* ---------- grid sizing ---------- */
// rasterTextGrid's `cols` is the letter resolution. Higher = finer letters but
// more tiles, and every tile is an instance + a matrix recomputed each opening
// frame, so it is capped. The message coarsens until it fits; the names get a
// smaller grid of their own.
const MSG_COLS = 46;
const MSG_COLS_MIN = 24;
const NAME_COLS = 30;
const TILE_CAP = 470; // message tiles; comfortably 60fps on a mid phone as plain boxes
const ROW_GAP = 2.2; // blank cells between the message block and the names branch
const PIP_MAX = 3; // pips per fallen tile — a faint domino face, not a real count

/* ---------- shared textures (module scope: the gallery mounts a wall of these) ---------- */
const glowTex = makeRadialSprite();
const pipTex = makeRadialSprite(24, [
  [0, "rgba(255,255,255,1)"],
  [0.45, "rgba(255,255,255,0.7)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- build-time scratch (not per-frame; still, allocate nothing in loops) ---------- */
const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _basis = new THREE.Matrix4();
const _bq = new THREE.Quaternion();

/** One toppling tile, everything it needs precomputed so a frame only spins a
 *  quaternion. `t0` is the second (after the run starts) it begins to fall. */
interface Tile {
  P: [number, number, number]; // pivot: the front-bottom edge it rotates on
  off: [number, number, number]; // tile centre relative to the pivot, upright
  axis: [number, number, number]; // world topple axis (the across direction)
  q: [number, number, number, number]; // upright orientation
  flat: [number, number, number]; // fallen top-face centre — where the pips live
  d: [number, number, number]; // run direction, for laying pips along the face
  t0: number;
}

interface Field {
  tiles: Tile[]; // in global fall order: message first, then the names branch
  n: number;
  litMsg: number;
  pipPos: Float32Array;
  pipCol: Float32Array; // per-vertex, driven each frame by its tile's fall
  pipTile: Int32Array; // which tile each pip rides
  pipCount: number;
  orderedX: Float32Array; // flat-centre x/z in fall order, for tracking the front
  orderedZ: Float32Array;
  centerZ: number;
  sizeX: number;
  sizeZ: number;
  firstCell: [number, number]; // where the spotlight pools, over tile 0
  showEnd: number; // when the last tile lands (the bell)
}

/** Lay one grid's lit cells into tiles, appended to `out`, on a boustrophedon
 *  sweep. `zTop` is the world z of the grid's top row; `tSpan` maps the sweep
 *  into [tBase, tBase+tSpan] seconds. Returns the count appended. */
function layGrid(
  out: Tile[],
  grid: TextGrid,
  zTop: number,
  tBase: number,
  tSpan: number,
  seed: number,
): number {
  const { cols, rows, cells } = grid;
  // Order the lit cells first so timing is proportional to place-in-order — the
  // wavefront "advancing along the serpentine order", tile i at time ∝ i.
  const order: number[] = [];
  for (let r = 0; r < rows; r++) {
    const forward = r % 2 === 0; // even rows sweep +x, odd rows −x: the snake
    for (let k = 0; k < cols; k++) {
      const c = forward ? k : cols - 1 - k;
      if (cells[r * cols + c]) order.push(r * cols + c);
    }
  }
  const rand = mulberry32(seed);
  const start = out.length;
  const lit = order.length;
  for (let i = 0; i < lit; i++) {
    const cell = order[i];
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    const forward = r % 2 === 0;
    // run direction for this cell: the way its row sweeps
    let dx = forward ? 1 : -1;
    let dz = 0;
    // a whisper of yaw so the coil is a hand's work and not a printout (±1.7°)
    const yaw = (rand() - 0.5) * 0.06;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const ndx = dx * cs - dz * sn;
    const ndz = dx * sn + dz * cs;
    dx = ndx;
    dz = ndz;

    const cx = (c - (cols - 1) / 2) * CELL;
    const cz = zTop + (r + 0.5) * CELL;

    // pivot: cell centre pulled back a half-length along the run, so the tile
    // topples FORWARD and lands centred on its cell (see the header math).
    const Px = cx - dx * (TILE_H / 2);
    const Pz = cz - dz * (TILE_H / 2);
    // upright centre relative to the pivot: up by half a height, back by half a thickness
    const ox = -dx * (TILE_T / 2);
    const oy = TILE_H / 2;
    const oz = -dz * (TILE_T / 2);
    // topple axis = the across direction, chosen so R(90°)·up = run: a = (dz,0,−dx)
    const ax = dz;
    const az = -dx;

    _a.set(ax, 0, az);
    _d.set(dx, 0, dz);
    _basis.makeBasis(_a, _up, _d); // local X→across, Y→height, Z→thickness(run)
    _bq.setFromRotationMatrix(_basis);

    out.push({
      P: [Px, 0, Pz],
      off: [ox, oy, oz],
      axis: [ax, 0, az],
      q: [_bq.x, _bq.y, _bq.z, _bq.w],
      flat: [cx, TILE_T / 2, cz], // fallen centre; top face at y = TILE_T
      d: [dx, dz, 0],
      t0: tBase + (lit > 1 ? i / lit : 0) * tSpan,
    });
  }
  return out.length - start;
}

/** Assemble the whole field: message grid on top, names branch below. Pure in its
 *  text/lang, so it is stable across viewport and palette — the camera does the
 *  fitting, the mask never re-rasterizes (same discipline as koi-pond). */
function buildField(msgText: string, namesText: string, lang: "en" | "ar"): Field {
  // Coarsen the message until it fits the instance budget. wrapping to a squarish
  // block keeps the reveal legible from straight above.
  let cols = MSG_COLS;
  let grid = rasterTextGrid(msgText, { cols, lang, fontWeight: "700" });
  while (grid.lit > TILE_CAP && cols > MSG_COLS_MIN) {
    cols -= 6;
    grid = rasterTextGrid(msgText, { cols, lang, fontWeight: "700" });
  }
  const names = rasterTextGrid(namesText, { cols: NAME_COLS, lang, fontWeight: "700" });

  const tiles: Tile[] = [];
  const msgZTop = 0; // message top row at z=0; block runs to +z (toward camera)
  const litMsg = layGrid(tiles, grid, msgZTop, 0, MSG_DUR, 1337);
  const namesZTop = grid.rows * CELL + ROW_GAP * CELL;
  layGrid(tiles, names, namesZTop, MSG_DUR + GAP, NAMES_DUR, 9001);

  const n = tiles.length;

  // bounds over every fallen tile, for framing the poses
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const orderedX = new Float32Array(n);
  const orderedZ = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = tiles[i].flat;
    orderedX[i] = f[0];
    orderedZ[i] = f[2];
    if (f[0] < minX) minX = f[0];
    if (f[0] > maxX) maxX = f[0];
    if (f[2] < minZ) minZ = f[2];
    if (f[2] > maxZ) maxZ = f[2];
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = 0;
    minZ = maxZ = 0;
  }

  // pips: a handful of glowing dots on each fallen tile's up-face. Positions are
  // static (baked at the flat pose); a frame only fades their glow up as the tile
  // lands, so nothing floats over a cell that has not fallen yet.
  const pipPos: number[] = [];
  const pipTileArr: number[] = [];
  const prand = mulberry32(4242);
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    const count = 1 + Math.floor(prand() * PIP_MAX);
    for (let p = 0; p < count; p++) {
      const along = (prand() - 0.5) * 0.6 * CELL; // along the run
      const across = (prand() - 0.5) * 0.6 * CELL; // across it
      pipPos.push(
        t.flat[0] + t.d[0] * along + t.axis[0] * across,
        TILE_T + 0.012, // a hair proud of the top face
        t.flat[2] + t.d[1] * along + t.axis[2] * across,
      );
      pipTileArr.push(i);
    }
  }

  return {
    tiles,
    n,
    litMsg,
    pipPos: new Float32Array(pipPos),
    pipCol: new Float32Array(pipPos.length),
    pipTile: new Int32Array(pipTileArr),
    pipCount: pipTileArr.length,
    orderedX,
    orderedZ,
    centerZ: (minZ + maxZ) / 2,
    sizeX: Math.max(CELL, maxX - minX),
    sizeZ: Math.max(CELL, maxZ - minZ),
    firstCell: [orderedX[0] ?? 0, orderedZ[0] ?? 0],
    showEnd: MSG_DUR + GAP + NAMES_DUR + TOPPLE,
  };
}

/* ---------- per-frame scratch ---------- */
const _pos = new THREE.Vector3();
const _off = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _qT = new THREE.Quaternion();
const _qBase = new THREE.Quaternion();
const _qFinal = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();
const _pc = new THREE.Color();
const _camPos = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _openPos = new THREE.Vector3();
const _revPos = new THREE.Vector3();
const _center = new THREE.Vector3();

/** A domino's fall is slow to tip then quick to thud, so angle grows as fall^1.6;
 *  clamped flat at 1. */
function toppleAngle(fall: number): number {
  if (fall >= 1) return HALF_PI;
  if (fall <= 0) return 0;
  return HALF_PI * Math.pow(fall, 1.6);
}

export default function DominoRunScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const tile = TILES[variants.tiles] ?? TILES.ivory;
  const table = TABLES[variants.table] ?? TABLES["green-felt"];

  // `message` is "" on the gallery card and, on /create, the sender's real message
  // one keystroke at a time. Either way the run spells SOMETHING: a gift whose
  // whole reveal is falling letters cannot sit dark, and a live preview that
  // ignores the typing is a preview of nothing. The names branch always spells the
  // two names (placeholders on the card — the coil is unreadable there anyway).
  const msgText = message.trim() || forRecipient(lang, recipientName);
  const you = recipientName.trim() || pick(lang, "you", "لك");
  const me = senderName.trim() || pick(lang, "me", "مني");
  // a mid-dot joins the pair cleanly in pixel letters where an arrow would smear
  const namesText = pick(lang, `${me} · ${you}`, `${you} · ${me}`);

  /* useMemo is load-bearing: it owns the whole tile layout and the pip buffers.
     Rebuilds only when the words change — never on a resize. */
  const field = useMemo(() => buildField(msgText, namesText, lang), [msgText, namesText, lang]);

  // The readable caption, engraved on the felt below the names branch. Both names,
  // crisp — the domino letters are chunky, so this is where the gift is signed.
  const caption = useMemo(
    () =>
      makeTextTexture(pick(lang, `${me}  →  ${you}`, `${you}  ←  ${me}`), {
        fontSize: 64,
        fontWeight: "600",
        color: tile.face === "#191b21" ? "#e8eefc" : "#fff4dc",
        glow: 14,
        glowColor: tile.pip,
        lang,
      }),
    [me, you, lang, tile],
  );
  useEffect(() => () => caption.texture.dispose(), [caption]);

  // Materials owned here, disposed on unmount. Standard so the tabletop reads as a
  // lit surface; the pips are additive glow that answers no light.
  const tileMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: tile.face,
        roughness: tile.rough,
        metalness: tile.metal,
      }),
    [tile],
  );
  const tableMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: table.top, roughness: table.rough, metalness: table.metal }),
    [table],
  );
  const tileGeo = useMemo(() => new THREE.BoxGeometry(TILE_W, TILE_H, TILE_T), []);
  useEffect(
    () => () => {
      tileMat.dispose();
      tableMat.dispose();
      tileGeo.dispose();
    },
    [tileMat, tableMat, tileGeo],
  );

  const tilesRef = useRef<THREE.InstancedMesh>(null);
  const pipsRef = useRef<THREE.Points>(null);
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const spotRef = useRef<THREE.Mesh>(null);
  const spotCoreRef = useRef<THREE.Mesh>(null);
  const captionRef = useRef<THREE.Mesh>(null);
  const keyLightRef = useRef<THREE.DirectionalLight>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // Run state. The layout accumulates nothing, but the SHOW does — reset from
  // `phase` alone so a replay re-topples from upright and reduced motion lands on
  // `revealed` having never run an opening.
  const runStartRef = useRef(-1); // seconds into opening when the flick landed (or mercy fired)
  const nextTileRef = useRef(0); // pointer over tiles-in-fall-order, for clacks + bell
  const lastClackRef = useRef(0);
  const bellRef = useRef(false);
  const dirtyRef = useRef(true);
  const snapRef = useRef(true); // snap the camera on the next static-phase frame
  const runTPrevRef = useRef(0);

  useLayoutEffect(() => {
    dirtyRef.current = true;
    snapRef.current = true;
    runStartRef.current = -1;
    nextTileRef.current = 0;
    bellRef.current = false;
    runTPrevRef.current = 0;
  }, [phase, field]);

  const pipBase = useMemo(() => new THREE.Color(tile.pip), [tile]);

  /** Write one tile's matrix at fall∈[0,1]. */
  const setTile = (inst: THREE.InstancedMesh, i: number, fall: number) => {
    const t = field.tiles[i];
    _axis.set(t.axis[0], t.axis[1], t.axis[2]);
    _qT.setFromAxisAngle(_axis, toppleAngle(fall));
    _qBase.set(t.q[0], t.q[1], t.q[2], t.q[3]);
    _qFinal.multiplyQuaternions(_qT, _qBase);
    _off.set(t.off[0], t.off[1], t.off[2]).applyQuaternion(_qT);
    _pos.set(t.P[0] + _off.x, t.P[1] + _off.y, t.P[2] + _off.z);
    _mat.compose(_pos, _qFinal, _one);
    inst.setMatrixAt(i, _mat);
  };

  /** fall of tile i for the current run time (opening) — or the phase's cold pose. */
  const fallOf = (i: number, runT: number): number => {
    if (phase === "revealed") return 1;
    if (phase !== "opening" || runStartRef.current < 0) return 0;
    return clamp01((runT - field.tiles[i].t0) / TOPPLE);
  };

  // Instance colour: a little per-tile brightness so a lacquer field is not a
  // sheet of one value. Set once (does not change per frame), refreshed on rebuild.
  const paintInstanceColors = (inst: THREE.InstancedMesh) => {
    // setColorAt lazily creates instanceColor on the first call; three then
    // MULTIPLIES it into the material colour, so this is a neutral brightness
    // jitter (not the face again, which would square the shading).
    const rand = mulberry32(77);
    for (let i = 0; i < field.n; i++) inst.setColorAt(i, _pc.setScalar(0.86 + rand() * 0.22));
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  };

  const writePips = (runT: number) => {
    const pts = pipsRef.current;
    if (!pts) return;
    // Write through the geometry attribute (the ref), never the memoized field
    // buffer directly — same discipline as koi-pond mutating its position array.
    const attr = pts.geometry.attributes.color as THREE.BufferAttribute;
    const col = attr.array as Float32Array;
    for (let p = 0; p < field.pipCount; p++) {
      const fall = fallOf(field.pipTile[p], runT);
      // faint even at rest, and only really lit once the tile is down (fall^2)
      const g = phase === "revealed" ? 0.72 : fall * fall * 0.72;
      col[p * 3] = pipBase.r * g;
      col[p * 3 + 1] = pipBase.g * g;
      col[p * 3 + 2] = pipBase.b * g;
    }
    attr.needsUpdate = true;
  };

  /** Where the toppling front is, in world x/z, at run time runT. */
  const frontAt = (runT: number, out: THREE.Vector3) => {
    const { orderedX, orderedZ, litMsg, n } = field;
    let u: number;
    if (runT <= MSG_DUR) u = litMsg > 0 ? (runT / MSG_DUR) * litMsg : 0;
    else if (runT <= MSG_DUR + GAP) u = litMsg;
    else u = litMsg + ((runT - MSG_DUR - GAP) / NAMES_DUR) * (n - litMsg);
    u = Math.max(0, Math.min(n - 1.001, u));
    const i = Math.floor(u);
    const f = u - i;
    out.set(lerp(orderedX[i], orderedX[i + 1] ?? orderedX[i], f), 0, lerp(orderedZ[i], orderedZ[i + 1] ?? orderedZ[i], f));
  };

  /** Fit a pose: put the camera along `dir` far enough that the field's footprint
   *  fits the viewport with `margin` to spare, in either orientation. */
  const fitPose = (dir: THREE.Vector3, margin: number, aspect: number, out: THREE.Vector3, extraZ = 0) => {
    // extraZ inflates the framed depth so the overhead reveal also holds the
    // engraved caption that sits just past the names branch.
    const halfH = Math.max((field.sizeZ + extraZ) * 0.55, (field.sizeX * 0.55) / Math.max(0.4, aspect));
    const dist = (halfH * margin) / TAN_HALF;
    out.copy(_center).addScaledVector(dir, dist);
  };

  const flick = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || runStartRef.current >= 0) return;
    // audio must begin inside a gesture; this IS the gesture
    resumeAudio();
    runStartRef.current = tRef.current;
    runTPrevRef.current = 0;
    clack({ freq: 1700, gain: 0.32 }); // the first tile, under the thumb
    lastClackRef.current = 0;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const inst = tilesRef.current;
    const cam = camRef.current;
    if (!inst || !cam) return;

    _center.set(0, 0.05, field.centerZ);

    // Untouched, the first tile tips on its own — company, not a timer.
    if (opening && runStartRef.current < 0 && t >= T_MERCY) {
      runStartRef.current = t;
      runTPrevRef.current = 0;
    }
    const runT = opening && runStartRef.current >= 0 ? t - runStartRef.current : 0;

    /* ---------- the tiles ---------- */
    if (opening) {
      // the live topple: every tile each frame (a few hundred boxes — nothing)
      for (let i = 0; i < field.n; i++) setTile(inst, i, fallOf(i, runT));
      inst.instanceMatrix.needsUpdate = true;
      writePips(runT);
    } else if (dirtyRef.current) {
      // the cold pose, laid once: upright for preview/sealed, flat for revealed.
      // A lerp needs a second and the reveal has ~40 settle frames, so this is set,
      // not eased.
      for (let i = 0; i < field.n; i++) setTile(inst, i, phase === "revealed" ? 1 : 0);
      inst.instanceMatrix.needsUpdate = true;
      paintInstanceColors(inst);
      writePips(0);
    }

    /* ---------- the sound of it ---------- */
    if (opening && runStartRef.current >= 0) {
      // advance the landing pointer; clack (throttled) as tiles thud, bell at the end
      while (nextTileRef.current < field.n && field.tiles[nextTileRef.current].t0 + TOPPLE <= runT) {
        nextTileRef.current++;
        if (e - lastClackRef.current >= CLACK_MIN) {
          lastClackRef.current = e;
          // pitch + level jitter so a patter of identical taps does not read as a machine
          const isName = nextTileRef.current > field.litMsg;
          clack({ freq: 1500 + Math.random() * 700, gain: (isName ? 0.2 : 0.26) });
        }
      }
      if (!bellRef.current && runT >= field.showEnd - 0.02) {
        bellRef.current = true;
        tone(880, { seconds: 1.1, gain: 0.3, shimmer: true }); // the last tile taps a tiny bell
      }
      runTPrevRef.current = runT;
    }

    /* ---------- the camera ---------- */
    const aspect = state.size.height > 0 ? state.size.width / state.size.height : 1;
    if (opening) {
      // track the front, then rise to overhead as the message settles so the whole
      // thing reads at once — the branch spelling the names finishes under the lift.
      frontAt(runT, _camLook);
      _openPos.set(_camLook.x, OPEN_H, _camLook.z + OPEN_BACK);
      fitPose(REVEAL_DIR, REVEAL_MARGIN, aspect, _revPos, CELL * 12);
      const rev = smooth(clamp01((runT - (MSG_DUR - 0.3)) / (GAP + NAMES_DUR + 0.6)));
      _camPos.copy(_openPos).lerp(_revPos, rev);
      _camLook.lerp(_center, rev);
      // damp: front hops a cell at a letter gap; the camera should glide, not twitch
      cam.position.lerp(_camPos, Math.min(1, dt * 5));
      cam.lookAt(_camLook);
      snapRef.current = true; // so leaving opening does not re-snap through a jump
    } else {
      // static poses. Revealed sits overhead; sealed/preview watch the coil from a
      // low ¾, gently living, where the standing tiles keep their secret.
      if (phase === "revealed") {
        fitPose(REVEAL_DIR, REVEAL_MARGIN, aspect, _revPos, CELL * 12);
        _camPos.copy(_revPos);
        _camLook.copy(_center);
      } else {
        fitPose(SEALED_DIR, SEALED_MARGIN, aspect, _camPos);
        // a slow drift around the table + a breath of bob, so the tableau is alive
        const sway = 0.06 * Math.sin(e * 0.24);
        const cs = Math.cos(sway);
        const sn = Math.sin(sway);
        const rx = _camPos.x - _center.x;
        const rz = _camPos.z - _center.z;
        _camPos.set(_center.x + rx * cs - rz * sn, _camPos.y + 0.04 * Math.sin(e * 0.5), _center.z + rx * sn + rz * cs);
        _camLook.copy(_center);
      }
      if (snapRef.current) {
        cam.position.copy(_camPos);
        snapRef.current = false;
      } else {
        cam.position.lerp(_camPos, Math.min(1, dt * 6));
      }
      cam.lookAt(_camLook);
    }

    // the key light rides above the framed centre so the felt is lit wherever we look
    if (keyLightRef.current) keyLightRef.current.position.set(_center.x - 1.5, 4.5, field.centerZ - 1.0);

    /* ---------- the spotlight on the first tile ---------- */
    // A pool of warm light over tile 0 — the affordance that says "flick here". It
    // pulses while it waits and fades the instant the run takes off.
    if (spotRef.current && spotCoreRef.current) {
      const waiting = (phase === "sealed" || (opening && runStartRef.current < 0)) ? 1 : 0;
      const smat = spotRef.current.material as THREE.MeshBasicMaterial;
      const cmat = spotCoreRef.current.material as THREE.MeshBasicMaterial;
      const pulse = 0.5 + 0.5 * Math.sin(e * 2.2);
      const wantPool = phase === "preview" ? 0.5 : waiting ? 0.55 + 0.25 * pulse : 0;
      const wantCore = phase === "preview" ? 0.7 : waiting ? 0.7 + 0.3 * pulse : 0;
      smat.opacity += (wantPool - smat.opacity) * Math.min(1, dt * 4);
      cmat.opacity += (wantCore - cmat.opacity) * Math.min(1, dt * 4);
      spotRef.current.position.set(field.firstCell[0], 0.01, field.firstCell[1]);
      spotCoreRef.current.position.set(field.firstCell[0], TILE_H * 0.5, field.firstCell[1]);
      spotRef.current.visible = smat.opacity > 0.004;
      spotCoreRef.current.visible = cmat.opacity > 0.004;
    }

    /* ---------- the signature caption ---------- */
    if (captionRef.current) {
      const cmat = captionRef.current.material as THREE.MeshBasicMaterial;
      // only in the finished tableau, fading in as the names land
      const want =
        phase === "revealed" ? 0.95 : opening ? smooth(clamp01((runT - (MSG_DUR + GAP)) / (NAMES_DUR + 0.4))) * 0.95 : 0;
      cmat.opacity += (want - cmat.opacity) * Math.min(1, dt * 4);
      captionRef.current.visible = cmat.opacity > 0.004;
    }

    dirtyRef.current = false;

    if (opening && runStartRef.current >= 0 && runT > field.showEnd + SETTLE && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  // caption plane below the names branch, lying on the felt
  const capW = field.sizeX * 0.62;
  const capZ = field.centerZ + field.sizeZ / 2 + CELL * 2.5;

  return (
    <>
      <PerspectiveCamera makeDefault ref={camRef} fov={CAM_FOV} position={[2, 2.5, 4]} />

      {/* a dim room: low ambient tinted to the table, one warm key raking the felt */}
      <ambientLight intensity={0.55} color={table.amb} />
      <hemisphereLight intensity={0.35} color="#fff2d8" groundColor={table.amb} />
      <directionalLight ref={keyLightRef} intensity={1.15} color="#ffe9c4" />

      {/* the table. Finite, ~1.5× the field, so it fades into a dark border — the
          natural frame that low-angle sealed and overhead reveal both want. */}
      <mesh rotation={[-HALF_PI, 0, 0]} position={[0, -0.003, field.centerZ]} receiveShadow>
        <planeGeometry args={[field.sizeX * 1.5 + CELL * 3, field.sizeZ * 1.5 + CELL * 3]} />
        <primitive object={tableMat} attach="material" />
      </mesh>

      {/* the tiles — one instanced draw for the whole run */}
      <instancedMesh
        ref={tilesRef}
        key={`tiles-${field.n}`}
        args={[tileGeo, tileMat, field.n]}
      />

      {/* the pips — one Points draw, glow fading up as each tile lands */}
      <points ref={pipsRef} key={`pips-${field.pipCount}`}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[field.pipPos, 3]} />
          <bufferAttribute attach="attributes-color" args={[field.pipCol, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={CELL * 0.5}
          sizeAttenuation
          map={pipTex}
          vertexColors
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* the pool of light waiting for a flick, and its bright core over the tile */}
      <mesh ref={spotRef} rotation={[-HALF_PI, 0, 0]} renderOrder={2}>
        <planeGeometry args={[CELL * 5, CELL * 5]} />
        <meshBasicMaterial
          map={glowTex}
          color={tile.pip}
          opacity={0}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={spotCoreRef} renderOrder={3}>
        <planeGeometry args={[CELL * 2, CELL * 2]} />
        <meshBasicMaterial
          map={glowTex}
          color={tile.pip}
          opacity={0}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* the signature, engraved on the felt below the names */}
      <mesh ref={captionRef} rotation={[-HALF_PI, 0, 0]} position={[0, 0.006, capZ]} renderOrder={2}>
        <planeGeometry args={[capW, capW * caption.aspect]} />
        <meshBasicMaterial map={caption.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>

      {/* the flick target: the whole table, live only while the run waits */}
      <mesh
        rotation={[-HALF_PI, 0, 0]}
        position={[0, 0.02, field.centerZ]}
        onPointerDown={flick}
      >
        <planeGeometry args={[field.sizeX * 1.6 + CELL * 4, field.sizeZ * 1.6 + CELL * 4]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
}
