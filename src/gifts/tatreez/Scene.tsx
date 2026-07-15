import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { rasterTextGrid, makeTextTexture, type TextGrid } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";
import { pick } from "../catalog";

/* ---------- the silks and the cloth ---------- */
// A cross-stitch is one strand of floss caught twice, so it is never one flat
// colour: `hi` is the twist catching the light, `lo` is the shaded side of the
// same thread, and every stitch is dealt a value between them (see the shade
// jitter below). That variance is the whole reason a stitched field reads as silk
// and not as printed pixels.
const THREADS: Record<string, { hi: string; mid: string; lo: string }> = {
  crimson: { hi: "#e46073", mid: "#b8283b", lo: "#7c1622" },
  gold: { hi: "#f2d484", mid: "#c99a36", lo: "#8a641d" },
  olive: { hi: "#a6b566", mid: "#6f7d37", lo: "#454e1e" },
};

// Authored bright on purpose: Color parses hex as sRGB and the pipeline converts to
// linear before a light touches it, so a hex picked to *look* like night indigo lands
// near-black. `weave` is the colour that sits in the valleys between the warp and the
// weft — a hair off the base, which is all a woven surface ever is up close.
const CLOTHS: Record<string, { base: string; weave: string }> = {
  indigo: { base: "#2b4066", weave: "#1a2b49" },
  black: { base: "#232732", weave: "#14161d" },
  // Linen is the one light ground, so the silks read as themselves on it rather than as
  // glow against the dark — the same three threads, a completely different piece.
  linen: { base: "#d8cbac", weave: "#bcab86" },
};

/* ---------- the hoop, a fixed object fit to the frame ---------- */
// THE RULE THIS SCENE BUYS ITSELF OUT OF (same trade koi-pond makes): the hoop is an
// OBJECT, not the viewport. It is a fixed circle of world, scaled bodily to whatever
// canvas it lands in, so every radius below is a world length once and for all and
// nothing here is ever re-measured against the aspect ratio. What the canvas decides is
// only how much dark table surrounds the hoop — which is the tableau, not the gift.
const R_OUTER = 2.4; // the wooden ring's centreline
const RING_TUBE = 0.16;
const CLOTH_R = R_OUTER + 0.02; // the cloth runs under the ring, which caps its circular edge
const FIELD_R = R_OUTER * 0.9; // the stitchable ground inside the ring
const MSG_R = FIELD_R * 0.72; // the message keeps to the centre…
const MOTIF_R = FIELD_R * 0.9; // …and the border motifs ring it, clear of the writing (koi's INK_R idea)
const HOOP_FIT = R_OUTER * 2 * 1.12; // fit the whole hoop to the canvas's short side, every phase, every frame
const STITCH_Z = 0.05; // silk sits proud of the cloth it is worked into

const MSG_COLS_MIN = 36; // brief: the message grid runs 36–52 columns…
const MSG_COLS_MAX = 52;
const MAX_STITCH = 2600; // one instanced X per lit cell; long messages are downsampled to this
const MAX_MOTIF = 360;

const STITCH_MAX = FIELD_R * 0.115; // a stitch never bigger than this, so a short message stays fine cross-stitch and not a banner
const STITCH_FILL = 1.08; // the X slightly overfills its cell, so a run of them reads as continuous floss
const MOTIF_CELL = FIELD_R * 0.05; // border motifs are worked at a fixed fine gauge, whatever the message length

/* ---------- opening timeline (seconds) ---------- */
// The bound is on onOpenComplete (12s) and it is measured on the wall clock, so the
// whole show is the budget, not the grant. The no-input path is the one that has to
// fit: border blooms by T_BORDER, the auto-stitch begins at T_AUTO and fills the
// message over AUTO_DUR, then SETTLE lets the monogram catch and the cloth relax:
//   T_AUTO + AUTO_DUR + SETTLE = 2.1 + 6.6 + 1.1 = 9.8s, with two seconds of slack for
// a slow first frame — and `dt` is clamped to 0.05, so on a phone dropping frames this
// clock runs *behind* the wall clock the bound is checked on. Swiping only ever gets
// there sooner; nobody is ever on a timer.
const T_BORDER = 1.3; // the motifs bloom outward around the ring
const MOTIF_POP = 0.5; // how long one motif takes to come up
const T_AUTO = 2.1; // untouched, the needle starts stitching on its own a beat after the border
const AUTO_DUR = 6.6;
const SETTLE = 1.1;
const POP_SPAN = 0.13; // fraction of the message a stitch takes to pull taut — sets the animating window's width
const SWIPE_FULL = 11; // world units of drag to stitch the whole message (≈ two and a half swipes across the hoop)
const MONO_FROM = 0.86; // the monogram is worked in over the last stretch of the message

/* ---------- textures (shared singletons, like koi's glowTex) ---------- */
const glowTex = makeRadialSprite();

/** One cross-stitch X: two strands of floss caught over each other, with a lighter
 *  core so the twist catches the light. White on transparent — instanceColor tints it,
 *  so the same texture serves crimson, gold and olive alike. */
const stitchTex = (() => {
  const S = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  const pad = 9; // the floss stops short of the cell edge, so neighbours read as separate stitches
  const a = pad;
  const b = S - pad;
  g.lineCap = "round";
  const stroke = (x0: number, y0: number, x1: number, y1: number) => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  // the body of each strand
  g.strokeStyle = "rgba(255,255,255,0.82)";
  g.lineWidth = 12;
  stroke(a, b, b, a);
  stroke(a, a, b, b);
  // the lit core running down the twist
  g.strokeStyle = "rgba(255,255,255,1)";
  g.lineWidth = 4.5;
  stroke(a, b, b, a);
  stroke(a, a, b, b);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
})();

/* ---------- border motifs ---------- */
// A few of the geometric figures a tatreez border is built from — a cypress (سرو),
// an eight-point amulet against the evil eye, and a crescent moon — each drawn as a
// tiny boolean bitmap. Kept upright and grid-aligned, because a sampler's motifs are.
type Bitmap = { w: number; h: number; cells: [number, number][] };
function parseMotif(rows: string[]): Bitmap {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const cells: [number, number][] = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (rows[r][c] === "X") {
        // centred, y-up: the motif hangs off its own middle so it can be dropped at a point
        cells.push([c - (w - 1) / 2, (h - 1) / 2 - r]);
      }
    }
  }
  return { w, h, cells };
}
const CYPRESS = parseMotif([
  "..X..",
  ".XXX.",
  "XXXXX",
  ".XXX.",
  "XXXXX",
  ".XXX.",
  "..X..",
  "..X..",
]);
const AMULET = parseMotif([
  "...X...",
  ".X.X.X.",
  "..XXX..",
  "XXX.XXX",
  "..XXX..",
  ".X.X.X.",
  "...X...",
]);
const MOON = parseMotif([
  ".XXX.",
  "XX...",
  "X....",
  "X....",
  "XX...",
  ".XXX.",
]);
const MOTIF_RING = [CYPRESS, MOON, AMULET, MOON, CYPRESS, MOON, AMULET, MOON]; // eight around the ring

/* ---------- the cloth: a woven disc with a slack that relaxes on reveal ---------- */
// Patch MeshStandardMaterial rather than hand-roll a ShaderMaterial, so three's colour
// management and its lighting come for free — the warm side light is what makes the
// weave read. The vertex shader gives the cloth a shallow woven sag (and the normal to
// light it); the fragment discards the plane's corners to a disc and darkens the valleys
// between warp and weft. `uSlack` swells the sag when the tension is let off at the end.
const CLOTH_COMMON_VERT = `#include <common>
uniform float uTime;
uniform float uSlack;`;
const CLOTH_NORMAL = `#include <beginnormal_vertex>
{
  float cA = 0.55 + 0.55 * uSlack;
  float ph = uTime * 0.5;
  float rx = sin(position.x * 2.3 + ph);
  float ry = sin(position.y * 1.9 - ph * 0.8);
  // the analytic slope of the sag below, so the side light shimmers along the weave
  float ddx = (cos(position.x * 2.3 + ph) * 2.3 * ry * 0.026 - 2.0 * position.x * 0.014) * cA;
  float ddy = (rx * cos(position.y * 1.9 - ph * 0.8) * 1.9 * 0.026 - 2.0 * position.y * 0.014) * cA;
  objectNormal = normalize(vec3(-ddx, -ddy, 1.0));
}`;
const CLOTH_DISP = `#include <begin_vertex>
{
  float cA = 0.55 + 0.55 * uSlack;
  float ph = uTime * 0.5;
  float rx = sin(position.x * 2.3 + ph);
  float ry = sin(position.y * 1.9 - ph * 0.8);
  // a hair of woven ripple, and a shallow bowl because the hoop pulls the cloth in at the rim
  transformed.z += (rx * ry * 0.026 - dot(position.xy, position.xy) * 0.014) * cA;
}`;
const CLOTH_FRAG_CLIP = `#include <clipping_planes_fragment>
if (length(vUv - 0.5) > 0.5) discard;`;
const CLOTH_FRAG_WEAVE = `#include <color_fragment>
{
  // warp and weft: two dense stripe fields crossed into a plaid, darkening the valleys
  float warp = 0.5 + 0.5 * sin(vUv.x * 300.0);
  float weft = 0.5 + 0.5 * sin(vUv.y * 300.0);
  float weave = warp * 0.5 + weft * 0.5;
  diffuseColor.rgb *= 0.84 + 0.2 * weave;
  diffuseColor.rgb = mix(diffuseColor.rgb, uWeaveCol, 0.14 * (1.0 - weave));
}`;

interface ClothUniforms {
  uTime: { value: number };
  uSlack: { value: number };
  uWeaveCol: { value: THREE.Color };
}
function makeClothMat(base: string, weave: string) {
  const uniforms: ClothUniforms = {
    uTime: { value: 0 },
    uSlack: { value: 0 },
    uWeaveCol: { value: new THREE.Color(weave) },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: base,
    roughness: 0.92, // floss and linen are matte; the sheen is all in the weave's normal
    metalness: 0,
  });
  mat.defines = { USE_UV: "" }; // make three declare + fill vUv for the fragment
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", CLOTH_COMMON_VERT)
      .replace("#include <beginnormal_vertex>", CLOTH_NORMAL)
      .replace("#include <begin_vertex>", CLOTH_DISP);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uWeaveCol;",
      )
      .replace("#include <clipping_planes_fragment>", CLOTH_FRAG_CLIP)
      .replace("#include <color_fragment>", CLOTH_FRAG_WEAVE);
  };
  return { mat, uniforms };
}

/* ---------- building the stitched field ---------- */
interface Stitches {
  count: number;
  x: Float32Array;
  y: Float32Array;
  rot: Float32Array;
  scale: Float32Array;
  shade: Float32Array; // 0..1 across lo→hi, the value this strand was dealt
}

/** Lit cells of a text grid, laid out centred and fitted to `radius`, in stitching order
 *  (top line down, and along the reading direction within a line — the grid already came
 *  out bidi-correct, so row-major *is* the order a hand would work it). */
function buildGrid(grid: TextGrid, radius: number, seed: number): Stitches {
  const { cols, rows, cells } = grid;
  // collect lit cells with their centred cell coordinates, and how far the ink reaches
  const cx: number[] = [];
  const cy: number[] = [];
  let reach = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r * cols + c]) continue;
      const gx = c - (cols - 1) / 2;
      const gy = (rows - 1) / 2 - r;
      cx.push(gx);
      cy.push(gy);
      const rr = Math.hypot(gx, gy);
      if (rr > reach) reach = rr;
    }
  }
  const lit = cx.length;
  // downsample only if a very long message overruns the instance budget — every Nth lit
  // cell, which thins the whole field evenly rather than truncating the last lines
  const stride = lit > MAX_STITCH ? Math.ceil(lit / MAX_STITCH) : 1;
  const count = Math.floor((lit + stride - 1) / stride);

  // Fit the ink's real reach to the radius (koi's `reach` fit), then cap the cell size so
  // a short message is not stitched in giant X's. Only a *cap*, never a floor: a floor
  // would let a long message overrun `radius` and spill into the border ring, and honest
  // dense embroidery — small stitches, downsampled — is the right answer for a paragraph.
  const cell = Math.min(STITCH_MAX, radius / Math.max(0.5, reach + 0.6));

  const rand = mulberry32(seed);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const rot = new Float32Array(count);
  const scale = new Float32Array(count);
  const shade = new Float32Array(count);
  for (let i = 0, w = 0; i < lit && w < count; i += stride, w++) {
    // a worked stitch is never dead-on the grid; a little jitter is the hand in it
    x[w] = cx[i] * cell + (rand() - 0.5) * cell * 0.12;
    y[w] = cy[i] * cell + (rand() - 0.5) * cell * 0.12;
    rot[w] = (rand() - 0.5) * 0.16;
    scale[w] = cell * STITCH_FILL * (0.94 + rand() * 0.12);
    shade[w] = rand();
  }
  return { count, x, y, rot, scale, shade };
}

interface Motifs {
  count: number;
  x: Float32Array;
  y: Float32Array;
  rot: Float32Array;
  scale: Float32Array;
  shade: Float32Array;
  place: Uint8Array; // which of the eight ring positions each stitch belongs to (drives the bloom order)
}

/** The eight border motifs, laid once around the ring. */
function buildMotifs(seed: number): Motifs {
  const rand = mulberry32(seed);
  const x: number[] = [];
  const y: number[] = [];
  const rot: number[] = [];
  const scale: number[] = [];
  const shade: number[] = [];
  const place: number[] = [];
  const N = MOTIF_RING.length;
  for (let k = 0; k < N && x.length < MAX_MOTIF; k++) {
    // start at the top and go round, so the bloom reads as a wreath being worked
    const ang = Math.PI / 2 - (k / N) * Math.PI * 2;
    const bx = Math.cos(ang) * MOTIF_R;
    const by = Math.sin(ang) * MOTIF_R;
    for (const [dx, dy] of MOTIF_RING[k].cells) {
      if (x.length >= MAX_MOTIF) break;
      x.push(bx + dx * MOTIF_CELL);
      y.push(by + dy * MOTIF_CELL);
      rot.push((rand() - 0.5) * 0.16);
      scale.push(MOTIF_CELL * STITCH_FILL * (0.94 + rand() * 0.12));
      shade.push(rand());
      place.push(k);
    }
  }
  return {
    count: x.length,
    x: Float32Array.from(x),
    y: Float32Array.from(y),
    rot: Float32Array.from(rot),
    scale: Float32Array.from(scale),
    shade: Float32Array.from(shade),
    place: Uint8Array.from(place),
  };
}

/* per-frame scratch — a hoop allocates nothing */
const mO = new THREE.Object3D();
const mC = new THREE.Color();

export default function TatreezScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const thread = THREADS[variants.thread] ?? THREADS.crimson;
  const cloth = CLOTHS[variants.cloth] ?? CLOTHS.indigo;

  // The message is "" on the gallery card, and on /create it is the sender's real message
  // arriving a keystroke at a time. The stitched field is only ever worked in `opening`
  // and `revealed`, so on the card and in the sealed hoop this is never shown — but it is
  // still built (from a fallback) so a reveal has something the instant it is asked for.
  const source = message.trim() || forRecipient(lang, recipientName);

  /* useMemo is load-bearing: it owns the cloth material, the two text textures and every
     typed array the instances are driven from. The hoop is a fixed world object and the
     grid is fitted to it, not to the canvas, so none of this rebuilds on a resize. */
  const grid = useMemo(() => {
    // Wrap the message to a comfortable line and pick a column count from its length: a
    // short line gets fewer, fatter cells; a long paragraph more, finer ones — both land
    // inside the hoop once fitted. The grid comes back bidi-correct for Arabic already.
    const text = source.replace(/\s*\n\s*\n+/g, "\n"); // a blank line is not something cloth holds
    const cpl = Math.round(clamp01((text.length - 6) / 190) * 11) + 7; // 7…18 chars a line
    const cols = Math.min(MSG_COLS_MAX, Math.max(MSG_COLS_MIN, Math.round(cpl * 2.9)));
    return rasterTextGrid(text, {
      cols,
      // a blocky, wide face reads as a sampler alphabet where a hairline serif would lose
      // its stems the moment it is sampled down to a handful of cells
      fontFamily: "'Arial Black', 'Helvetica Neue', system-ui, sans-serif",
      fontWeight: "800",
      lineHeight: 1.32, // cross-stitch letters want a clear gap between rows to stay legible
      maxWidthPx: cpl * 44,
      lang,
    });
  }, [source, lang]);

  const stitches = useMemo(() => buildGrid(grid, MSG_R, 9137), [grid]);
  const motifs = useMemo(() => buildMotifs(4021), []);

  const clothMat = useMemo(() => makeClothMat(cloth.base, cloth.weave), [cloth]);
  useEffect(() => () => clothMat.mat.dispose(), [clothMat]);

  // A crisp readable message plane is the wrong tool for the body of a *stitched* gift —
  // that is what the grid is for. But the names are a monogram, and a monogram is worked
  // small and read as a signature, so a texture is exactly right. Both names, in reading
  // order, in the thread's own lit colour.
  const mono = useMemo(() => {
    const s = senderName.trim();
    const r = recipientName.trim();
    const label = pick(
      lang,
      `${s ? s + "  ✦  " : ""}${r}`,
      `${r}${s ? "  ✦  " + s : ""}`,
    );
    return makeTextTexture(label || " ", {
      fontSize: 60,
      fontFamily: "'Courier New', monospace", // a monospace reads as counted, like the stitches
      fontWeight: "700",
      color: thread.hi,
      glow: 6,
      glowColor: thread.mid,
      lang,
    });
  }, [senderName, recipientName, lang, thread]);
  useEffect(() => () => mono.texture.dispose(), [mono]);

  // The gift tag: a small paper label tied to the hoop while it waits, so the gallery
  // card and the sealed piece both say who it is for. Gone the moment it is opened.
  const tag = useMemo(
    () => makeTextTexture(forRecipient(lang, recipientName), {
      fontSize: 48,
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: "#4a3b28",
      lang,
    }),
    [lang, recipientName],
  );
  useEffect(() => () => tag.texture.dispose(), [tag]);

  const threadCols = useMemo(
    () => ({ hi: new THREE.Color(thread.hi), mid: new THREE.Color(thread.mid), lo: new THREE.Color(thread.lo) }),
    [thread],
  );

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const clothRef = useRef<THREE.Mesh>(null);
  const stitchRef = useRef<THREE.InstancedMesh>(null);
  const motifRef = useRef<THREE.InstancedMesh>(null);
  const needleRef = useRef<THREE.Group>(null);
  const glintRef = useRef<THREE.Mesh>(null);
  const threadLineRef = useRef<THREE.Mesh>(null);
  const monoRef = useRef<THREE.Mesh>(null);
  const tagRef = useRef<THREE.Group>(null);
  const guideRef = useRef<THREE.Mesh>(null);
  const hitRef = useRef<THREE.Mesh>(null);

  // Per-frame uniform writes go through a ref: the memo owns the material and its
  // disposal, but the lint only accepts mutation through a *Ref (same shape as koi-pond).
  const clothUniRef = useRef<ClothUniforms | null>(null);
  useLayoutEffect(() => {
    clothUniRef.current = clothMat.uniforms;
  }, [clothMat]);

  const sRef = useRef(1); // the live fit scale, so the swipe handler can work in hoop-local units
  const dirtyRef = useRef(true);
  const drawnRef = useRef(0); // how many stitches have been given their final matrix (the settled frontier)
  const swipeRef = useRef({ down: false, px: 0, py: 0, travel: 0 });
  const reachedRef = useRef(-1); // the opening-clock time the message finished stitching

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  /* The instanced fields are the only things here that accumulate, so they are rebuilt
     from `phase` alone: a replay re-stitches from an empty hoop, and reduced motion lands
     on `revealed` having never run an opening. */
  useLayoutEffect(() => {
    dirtyRef.current = true;
  }, [phase, stitches, motifs]);

  /** Colour a stitch: its dealt value slid between the thread's shaded and lit sides,
   *  with a touch of extra light while it is being pulled taut. */
  const stitchColor = (shade: number, sheen: number) => {
    mC.copy(threadCols.lo).lerp(threadCols.hi, 0.35 + shade * 0.55);
    if (sheen > 0) mC.lerp(threadCols.hi, sheen * 0.5);
    return mC;
  };

  // hoop-local pointer coords, undoing the live fit (the tiny tilt is not worth undoing)
  const localXY = (e: ThreeEvent<PointerEvent>) => {
    const s = sRef.current || 1;
    return { x: e.point.x / s, y: e.point.y / s };
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const uni = clothUniRef.current;
    if (!uni) return; // the cloth is the ground everything sits on; there is nothing to pose without it

    /* The hoop is an object, not the canvas: fit its diameter to the short side and let
       the table have the rest. Holds from a 0.46 phone to a 2.53 desktop with no special
       case, and is the whole reason every radius above is a world length. */
    const s = Math.min(state.viewport.width, state.viewport.height) / HOOP_FIT;
    sRef.current = s;
    if (fitRef.current) fitRef.current.scale.setScalar(s);

    uni.uTime.value = e;
    // the cloth is taut on the hoop until the work is done, then the tension eases
    const slackWant = phase === "revealed" ? 1 : phase === "preview" ? 0.5 : opening ? clamp01((t - T_AUTO - AUTO_DUR) / SETTLE) * 0.7 : 0.15;
    uni.uSlack.value = lerp(uni.uSlack.value, slackWant, Math.min(1, dt * 2.5));

    /* ---------- how much of the message is worked ---------- */
    // Untouched, the needle stitches on its own after the border (the mercy path). Swiping
    // accumulates drag and gets there sooner; the two are combined by max, and both only
    // ever rise, so the frontier never walks backwards.
    const autoP = opening ? clamp01((t - T_AUTO) / AUTO_DUR) : 0;
    const manualP = clamp01(swipeRef.current.travel / SWIPE_FULL);
    const p = phase === "revealed" ? 1 : opening ? Math.max(autoP, manualP) : 0;

    /* ---------- the dirty rebuild ---------- */
    if (dirtyRef.current) {
      dirtyRef.current = false;
      drawnRef.current = 0;
      swipeRef.current.travel = 0;
      swipeRef.current.down = false;
      reachedRef.current = -1;

      const sm = stitchRef.current;
      if (sm) {
        sm.count = stitches.count;
        const full = phase === "revealed"; // the cold target; preview/sealed show a bare hoop, opening starts empty
        for (let i = 0; i < stitches.count; i++) {
          mO.position.set(stitches.x[i], stitches.y[i], STITCH_Z);
          mO.rotation.set(0, 0, stitches.rot[i]);
          mO.scale.setScalar(full ? stitches.scale[i] : 0);
          mO.updateMatrix();
          sm.setMatrixAt(i, mO.matrix);
          sm.setColorAt(i, stitchColor(stitches.shade[i], 0));
        }
        sm.instanceMatrix.needsUpdate = true;
        if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
        if (full) drawnRef.current = stitches.count;
      }

      const mm = motifRef.current;
      if (mm) {
        mm.count = motifs.count;
        // the border is present in `revealed`, blooms in `opening`, and is absent while
        // the hoop merely waits — so it starts hidden in every phase but revealed
        const full = phase === "revealed";
        for (let i = 0; i < motifs.count; i++) {
          mO.position.set(motifs.x[i], motifs.y[i], STITCH_Z);
          mO.rotation.set(0, 0, motifs.rot[i]);
          mO.scale.setScalar(full ? motifs.scale[i] : 0);
          mO.updateMatrix();
          mm.setMatrixAt(i, mO.matrix);
          mm.setColorAt(i, stitchColor(motifs.shade[i], 0));
        }
        mm.instanceMatrix.needsUpdate = true;
        if (mm.instanceColor) mm.instanceColor.needsUpdate = true;
      }
    }

    /* ---------- the border blooms ---------- */
    if (opening && motifRef.current) {
      const mm = motifRef.current;
      const N = MOTIF_RING.length;
      for (let i = 0; i < motifs.count; i++) {
        const k = motifs.place[i];
        const born = (k / N) * (T_BORDER - MOTIF_POP);
        const pop = easeOutBack(clamp01((t - born) / MOTIF_POP));
        mO.position.set(motifs.x[i], motifs.y[i], STITCH_Z);
        mO.rotation.set(0, 0, motifs.rot[i]);
        mO.scale.setScalar(motifs.scale[i] * pop);
        mO.updateMatrix();
        mm.setMatrixAt(i, mO.matrix);
      }
      mm.instanceMatrix.needsUpdate = true;
    }

    /* ---------- the message stitches, along the frontier ---------- */
    // Only the live band of stitches is touched each frame. Everything below `drawn` is
    // already at its final matrix; everything past `hi` is still at zero scale from the
    // rebuild. `drawn` is a monotonic frontier that starts wherever the last settled stitch
    // is and runs up to the head — so even a hard swipe that jumps `p` a long way in one
    // frame stitches every cell it crossed, never leaving a hole (koi's pen-pointer idea,
    // widened to a pop window). A steady 900-stitch message costs a few dozen writes a frame.
    if (opening && stitchRef.current && stitches.count > 0) {
      const sm = stitchRef.current;
      const denom = Math.max(1, stitches.count - 1);
      const hi = Math.min(stitches.count, Math.ceil(p * denom) + 1);
      let touched = false;
      for (let i = drawnRef.current; i < hi; i++) {
        const pop = easeOutBack(clamp01((p - i / denom) / POP_SPAN));
        mO.position.set(stitches.x[i], stitches.y[i], STITCH_Z);
        mO.rotation.set(0, 0, stitches.rot[i]);
        mO.scale.setScalar(stitches.scale[i] * pop);
        mO.updateMatrix();
        sm.setMatrixAt(i, mO.matrix);
        // the pull-taut overshoot flashes the twist toward the light, fading as it settles
        sm.setColorAt(i, stitchColor(stitches.shade[i], (1 - clamp01((p - i / denom) / POP_SPAN)) * 0.8));
        touched = true;
      }
      if (touched) {
        sm.instanceMatrix.needsUpdate = true;
        if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
      }
      // advance the frontier past every stitch that has fully pulled taut, so it is not retouched
      while (drawnRef.current < stitches.count && p - drawnRef.current / denom >= POP_SPAN) {
        drawnRef.current++;
      }
    }

    /* ---------- the needle ---------- */
    // In the opening it rides the frontier — the stitch being worked this instant. Elsewhere
    // it is set aside on the cloth, glinting, waiting (preview/sealed) or laid down at rest
    // with its work done (revealed).
    if (needleRef.current) {
      const n = needleRef.current;
      if (opening && p < 0.999 && stitches.count > 0) {
        const idx = Math.min(stitches.count - 1, Math.max(0, Math.floor(p * (stitches.count - 1))));
        // a stitch or two ahead, where the point is going next, and lifted off the cloth
        const nx = stitches.x[idx];
        const ny = stitches.y[idx];
        n.position.set(nx + 0.18, ny + 0.16, STITCH_Z + 0.12 + 0.04 * Math.sin(e * 9));
        n.rotation.set(0, 0, -0.7 + 0.12 * Math.sin(e * 9));
        n.visible = true;
      } else {
        // parked on the lower-left of the cloth, angled as if just set down
        n.position.set(-FIELD_R * 0.52, -FIELD_R * 0.66, STITCH_Z + 0.1);
        n.rotation.set(0, 0, 0.5 + (phase === "sealed" ? 0.05 * Math.sin(e * 1.4) : 0));
        n.visible = true;
      }
    }
    // the eye's glint travels the shank — a needle never sits perfectly still in the light
    if (glintRef.current) {
      const m = glintRef.current.material as THREE.MeshBasicMaterial;
      m.opacity = 0.4 + 0.5 * Math.pow(Math.max(0, Math.sin(e * 2.1)), 3);
    }
    // the working thread runs from the eye down to the spool; it sags a little as it relaxes
    if (threadLineRef.current && needleRef.current) {
      const n = needleRef.current;
      const sx = -FIELD_R * 0.78;
      const sy = -FIELD_R * 0.9; // the spool's crown, down in the corner
      const midx = (n.position.x + sx) / 2;
      const midy = (n.position.y + sy) / 2 - 0.12;
      const dx = sx - n.position.x;
      const dy = sy - n.position.y;
      const len = Math.hypot(dx, dy) || 1;
      threadLineRef.current.position.set(midx, midy, STITCH_Z + 0.06);
      threadLineRef.current.rotation.set(0, 0, Math.atan2(dy, dx));
      threadLineRef.current.scale.set(len, 1, 1);
    }

    /* ---------- the monogram ---------- */
    if (monoRef.current) {
      const m = monoRef.current.material as THREE.MeshBasicMaterial;
      // worked in over the last stretch of the message; snapped (not eased) outside the
      // opening so `revealed` — the reduced-motion target — draws it cold in one frame
      const want = phase === "revealed" ? 1 : opening ? smooth(clamp01((p - MONO_FROM) / (1 - MONO_FROM))) : 0;
      m.opacity = opening ? lerp(m.opacity, want, Math.min(1, dt * 4)) : want;
      monoRef.current.visible = m.opacity > 0.01;
    }

    /* ---------- the gift tag, only while it waits ---------- */
    if (tagRef.current) {
      const want = phase === "preview" || phase === "sealed" ? 1 : 0;
      const g = tagRef.current;
      const cur = (g.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshBasicMaterial | undefined;
      // fades in gently while it waits; snapped away the instant the hoop is opened or done
      const o = cur ? (opening || phase === "revealed" ? want : lerp(cur.opacity, want, Math.min(1, dt * 4))) : 0;
      g.visible = o > 0.01;
      g.traverse((c) => {
        const mat = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (mat && "opacity" in mat) mat.opacity = o;
      });
      g.position.y = -R_OUTER - 0.34 + 0.03 * Math.sin(e * 1.1); // it sways a touch on its thread
      g.rotation.z = 0.08 * Math.sin(e * 0.9);
    }

    /* ---------- the swipe affordance ---------- */
    if (guideRef.current) {
      const m = guideRef.current.material as THREE.MeshBasicMaterial;
      // a bright band that sweeps across the hoop, saying which way to drag — sealed only,
      // and it fades the instant the first stitches begin
      const want = phase === "sealed" || (opening && p < 0.02 && swipeRef.current.travel < 0.1) ? 0.28 : 0;
      m.opacity = lerp(m.opacity, want, Math.min(1, dt * 3));
      guideRef.current.visible = m.opacity > 0.01;
      guideRef.current.position.x = Math.sin(e * 0.9) * FIELD_R * 0.7;
    }

    /* ---------- preview: a gently-living tableau ---------- */
    // The card shows the sealed piece breathing — the whole hoop leans and settles as if
    // held in the hand, so a small tile reads as an object and not a still.
    if (tiltRef.current) {
      const k = Math.min(1, dt * 2.4);
      const px = phase === "preview" ? Math.sin(e * 0.5) * 0.08 : state.pointer.x * 0.12;
      const py = phase === "preview" ? Math.cos(e * 0.42) * 0.05 : state.pointer.y * 0.12;
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, px, k);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, -py, k);
    }

    /* ---------- done, exactly once ---------- */
    if (opening && p >= 0.999) {
      if (reachedRef.current < 0) reachedRef.current = t;
      if (t > reachedRef.current + SETTLE && !doneRef.current) {
        doneRef.current = true;
        onOpenComplete?.();
      }
    }
  });

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (phase !== "opening") return;
    const { x, y } = localXY(e);
    const sw = swipeRef.current;
    sw.down = true;
    sw.px = x;
    sw.py = y;
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const sw = swipeRef.current;
    if (!sw.down) return;
    e.stopPropagation();
    const { x, y } = localXY(e);
    // accumulate the drag — every hand's-breadth of swipe stitches a little more of the row
    sw.travel += Math.hypot(x - sw.px, y - sw.py);
    sw.px = x;
    sw.py = y;
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    swipeRef.current.down = false;
  };

  return (
    <>
      {/* Face-on, with a hair of lift so the wooden ring has a top edge to catch the light. */}
      <PerspectiveCamera makeDefault position={[0, 0.15, 6.3]} fov={42} />

      {/* Warm side light — the whole point of the sealed tableau, and what makes the weave
          and the twist of the floss read at all. A low cool fill keeps the shadowed side
          from going dead black. */}
      <ambientLight intensity={0.5} color="#5a4632" />
      <directionalLight position={[-4.5, 2.2, 4]} intensity={1.35} color="#ffd7a0" />
      <directionalLight position={[3.5, -1.5, 2.5]} intensity={0.35} color="#8fa6c8" />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the cloth, held taut in the hoop */}
          <mesh ref={clothRef} position={[0, 0, 0]}>
            <planeGeometry args={[CLOTH_R * 2, CLOTH_R * 2, 40, 40]} />
            <primitive object={clothMat.mat} attach="material" />
          </mesh>

          {/* the border motifs and the message: one instanced X apiece, tinted per stitch */}
          <instancedMesh ref={motifRef} args={[undefined, undefined, MAX_MOTIF]} frustumCulled={false}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial map={stitchTex} transparent alphaTest={0.35} depthWrite={false} />
          </instancedMesh>
          <instancedMesh ref={stitchRef} args={[undefined, undefined, MAX_STITCH]} frustumCulled={false}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial map={stitchTex} transparent alphaTest={0.35} depthWrite={false} />
          </instancedMesh>

          {/* the monogram, worked small into the lower corner */}
          <mesh
            ref={monoRef}
            position={[FIELD_R * 0.46, -FIELD_R * 0.6, STITCH_Z + 0.01]}
            rotation={[0, 0, -0.09]}
            visible={false}
          >
            <planeGeometry args={[FIELD_R * 0.62, (FIELD_R * 0.62) * mono.aspect]} />
            <meshBasicMaterial map={mono.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>

          {/* the swipe affordance: a soft band that sweeps the direction to drag */}
          <mesh ref={guideRef} position={[0, 0, STITCH_Z + 0.02]} visible={false}>
            <planeGeometry args={[FIELD_R * 0.5, FIELD_R * 1.7]} />
            <meshBasicMaterial
              map={glowTex}
              color={thread.hi}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* the working thread, running from the needle's eye to the spool */}
          <mesh ref={threadLineRef} position={[0, 0, STITCH_Z + 0.06]}>
            <planeGeometry args={[1, 0.02]} />
            <meshBasicMaterial color={thread.mid} transparent opacity={0.85} depthWrite={false} />
          </mesh>

          {/* the needle — a bright shank, a dark eye, and a glint that never sits still */}
          <group ref={needleRef} position={[-FIELD_R * 0.52, -FIELD_R * 0.66, STITCH_Z + 0.1]} rotation={[0, 0, 0.5]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.012, 0.03, 0.66, 8]} />
              <meshStandardMaterial color="#e8ecf2" metalness={0.9} roughness={0.25} />
            </mesh>
            {/* the eye */}
            <mesh position={[0, 0.3, 0]}>
              <torusGeometry args={[0.026, 0.008, 6, 12]} />
              <meshStandardMaterial color="#c9ccd2" metalness={0.9} roughness={0.3} />
            </mesh>
            <mesh ref={glintRef} position={[0.02, 0.08, 0.05]}>
              <planeGeometry args={[0.34, 0.34]} />
              <meshBasicMaterial
                map={glowTex}
                color="#fffdf5"
                transparent
                opacity={0.5}
                depthWrite={false}
                toneMapped={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>

          {/* two spools of floss beside the work — the thread colour, wound on wood */}
          {[
            [-FIELD_R * 0.78, -FIELD_R * 0.9, thread.mid],
            [-FIELD_R * 0.94, -FIELD_R * 0.72, thread.lo],
          ].map(([sx, sy, col], i) => (
            <group key={i} position={[sx as number, sy as number, STITCH_Z + 0.05]} rotation={[Math.PI / 2, 0, 0.3]}>
              <mesh>
                <cylinderGeometry args={[0.14, 0.14, 0.22, 16]} />
                <meshStandardMaterial color={col as string} roughness={0.85} />
              </mesh>
              {/* the wooden end-caps */}
              <mesh position={[0, 0.12, 0]}>
                <cylinderGeometry args={[0.17, 0.17, 0.03, 16]} />
                <meshStandardMaterial color="#8a5a34" roughness={0.7} />
              </mesh>
              <mesh position={[0, -0.12, 0]}>
                <cylinderGeometry args={[0.17, 0.17, 0.03, 16]} />
                <meshStandardMaterial color="#8a5a34" roughness={0.7} />
              </mesh>
            </group>
          ))}

          {/* the wooden hoop: the outer ring, a thin brass tightening band flush inside it,
              and the tension screw at the top */}
          <mesh position={[0, 0, 0]}>
            <torusGeometry args={[R_OUTER, RING_TUBE, 16, 80]} />
            <meshStandardMaterial color="#a9713d" roughness={0.62} metalness={0.05} />
          </mesh>
          <mesh position={[0, 0, 0.04]}>
            <torusGeometry args={[R_OUTER - 0.02, 0.05, 12, 80]} />
            <meshStandardMaterial color="#c9a15c" roughness={0.4} metalness={0.55} />
          </mesh>
          {/* the tightening screw and its two lugs, at the crown of the hoop */}
          <group position={[0, R_OUTER + RING_TUBE * 0.6, 0]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.05, 0.05, 0.26, 6]} />
              <meshStandardMaterial color="#cdb264" roughness={0.35} metalness={0.7} />
            </mesh>
            <mesh position={[-0.09, -0.06, 0]}>
              <boxGeometry args={[0.08, 0.16, 0.14]} />
              <meshStandardMaterial color="#96632f" roughness={0.6} />
            </mesh>
            <mesh position={[0.09, -0.06, 0]}>
              <boxGeometry args={[0.08, 0.16, 0.14]} />
              <meshStandardMaterial color="#96632f" roughness={0.6} />
            </mesh>
          </group>

          {/* the gift tag, tied on while the hoop waits */}
          <group ref={tagRef} position={[0, -R_OUTER - 0.34, 0.05]}>
            {/* the thread it hangs by */}
            <mesh position={[0, 0.26, 0]}>
              <planeGeometry args={[0.012, 0.5]} />
              <meshBasicMaterial color={thread.mid} transparent opacity={0} depthWrite={false} />
            </mesh>
            <mesh>
              <planeGeometry args={[0.95, 0.95 * tag.aspect]} />
              <meshBasicMaterial color="#efe4cc" transparent opacity={0} depthWrite={false} />
            </mesh>
            <mesh position={[0, 0, 0.001]}>
              <planeGeometry args={[0.95, 0.95 * tag.aspect]} />
              <meshBasicMaterial map={tag.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>

          {/* the hit target — a transparent disc over the cloth. Raycasting ignores
              visible={false}, so it is opacity-0, not hidden. */}
          <mesh
            ref={hitRef}
            position={[0, 0, STITCH_Z + 0.2]}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
          >
            <circleGeometry args={[R_OUTER, 48]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
      </group>
    </>
  );
}
