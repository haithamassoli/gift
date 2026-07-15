import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, orderWritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32 } from "../math";
import { forRecipient } from "../../i18n";
import { pick } from "../catalog";

/* ============================================================================
   Calligrapher's Qalam — the batch flagship. A reed pen writing itself.

   The whole spectacle is the ink appearing. So the ink is a real swept ribbon:
   orderWritePath gives the dense sweep *through* the glyphs (not a centreline),
   we split it at every pen-lift, tube each stroke, and merge the lot into ONE
   indexed BufferGeometry whose triangles are in writing order. Revealing the
   piece is then a single geometry.setDrawRange(0, k) — cheap, monotonic, and it
   grows the ink stroke-by-stroke exactly as a hand would lay it down. The finger
   never has to be accurate: dragging only *powers* the pen; an unseen hand steers
   it along the true path. Dip → write a run → ink dries → re-dip. Three times.
   ========================================================================== */

/* ---------- ink, keyed by variants.ink ----------
   body = the wet-ink colour on pale paper; darkBody + metal = the gold-leaf look
   a real illuminator switches to on indigo paper, where a dark ink would vanish. */
const INKS: Record<string, { body: string; sheen: string; darkBody: string }> = {
  midnight: { body: "#16233f", sheen: "#c3d6ff", darkBody: "#9fb6e0" },
  oxblood: { body: "#4a141c", sheen: "#ffb695", darkBody: "#cf8869" },
  lapis: { body: "#1b3f8c", sheen: "#96bcff", darkBody: "#82aef4" },
};

/* ---------- paper, keyed by variants.paper ----------
   `dark` flips the ink to its metallic gold-leaf variant so the writing still
   reads; `aged` sprinkles foxing into the sheet. */
const PAPERS: Record<string, { tint: string; dark: boolean; aged: boolean }> = {
  cream: { tint: "#efe3c6", dark: false, aged: false },
  aged: { tint: "#ddc79a", dark: false, aged: true },
  indigo: { tint: "#1b2947", dark: true, aged: false },
};

const GOLD = "#d4af37";
const GOLD_SHEEN = "#ffe8ad";
const NIB_DRY = new THREE.Color("#3a2c1c"); // the bare reed before it takes ink

/* ---------- the ink ribbon ----------
   RAD_K: the tube's radius as a small multiple of the raster's column spacing.
   orderWritePath is a sweep, so a tube a touch wider than one column fuses the
   per-column runs into a solid, filled glyph — the same trick foggy-mirror sizes
   its dab by. Wider and the counters ("o", "ه") close up.
   JUMP_K: a leap longer than this many column steps is the sweep flying between
   letters or across a counter, not the pen moving — lift there. */
const RAD_K = 1.2;
const JUMP_K = 2.6;
const RADIAL = 5; // near-round quill cross-section; 6 verts per ring
const INK_Z = 0.007; // ink sits just proud of the page
const SCRIPT = "'Snell Roundhand', 'Zapfino', 'Segoe Script', 'Bradley Hand', cursive";
const FONT_PX = 90;
const LINE_H = 1.3;
const STEP = 3; // orderWritePath's density floor
const SRC_CAP = 140; // nobody writes a paragraph in gold leaf; keep the geometry bounded

/* ---------- the ritual: three dips, three runs ----------
   Each dip fills the nib (wet=1); writing drains it; a run of the piece is exactly
   one nib of ink. Dry before the last run → the calligrapher re-dips. */
const DIPS = 3;
const RUN_ENDS = [0.34, 0.67, 1] as const; // write-progress a full nib reaches, per run

/* ---------- the tazhib (illumination) ----------
   FPAD: gap between the writing's box and the gold frame around it.
   The frame is a squircle so it reads as a rounded rectangle; a p=4 super-ellipse
   is x = sign(cosθ)·|cosθ|^0.5·halfW. LOBE_* wave a vine along its outward normal. */
const FPAD = 0.15;
const FRAME_Z = 0.012;
const FRAME_R = 0.011; // gold border tube radius (normalized units)
const SQUIRCLE = 0.5; // super-ellipse exponent → rounded-rect corners
const LOBE_AMP = 0.022;
const LOBE_FREQ = 15;
const FRAME_SEG = 260;
const ROUNDEL_R = 0.17; // the names' medallion, below the frame
const ROUNDEL_GAP = 0.1;

/* ---------- opening timeline (seconds) ----------
   The 12s no-input bound is a hard rule, so the untouched path is the one tuned to
   it: first auto-dip at T_IDLE_DIP, the unseen hand writing from T_ASSIST onward,
   auto-re-dipping the moment a nib runs dry. That completes the writing near 6s and
   the tazhib by ~8s — well under 12, with clamped dt buying the rest back on a slow
   phone. A hand that is actually writing keeps control until T_FORCE, past which the
   piece finishes itself so nothing can outlast the show. */
const WRITE_GAIN = 1.7; // wet drained per unit of finger travel (uv units) — forgiving
const AUTO_RATE = 0.74; // wet drained per second once the unseen hand takes over
const T_IDLE_DIP = 1.8; // untouched this long → the hand dips the pen for them
const T_REDIP = 0.5; // dry at a gate this long → the hand re-dips
const T_ASSIST = 1.5; // idle this long → the hand steadies the pen and writes
const T_TAZHIB = 1.9; // the gold frame unfurls over this
const T_FORCE = 9.0; // last resort: force the writing complete
const ROUNDEL_IN = 0.55; // fraction of the tazhib after which the names fade up

/* ---------- shared, immutable module resources (see foggy-mirror's grainTex) ---------- */
const glowTex = makeRadialSprite();
const goldGlintTex = makeRadialSprite(48, [
  [0, "rgba(255,240,200,1)"],
  [0.35, "rgba(255,225,150,0.7)"],
  [1, "rgba(255,225,150,0)"],
]);

/** A warm equirect strip so the gold and the wet ink catch a moving highlight —
    no HDRI, no loader (same approach as golden-locket). */
function makeEnvTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#1a140c");
  grad.addColorStop(0.44, "#5a4526");
  grad.addColorStop(0.52, "#ffe6b0"); // the lamp's band
  grad.addColorStop(0.6, "#3a2a14");
  grad.addColorStop(1, "#08060a");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const hot = g.createRadialGradient(w * 0.32, h * 0.5, 0, w * 0.32, h * 0.5, 46);
  hot.addColorStop(0, "rgba(255,244,210,0.9)");
  hot.addColorStop(1, "rgba(255,244,210,0)");
  g.fillStyle = hot;
  g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
const ENV_TEX = makeEnvTexture();

/** The night room the desk sits in — a warm pool fading to black at the edges. */
function makeBackdrop(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s * 0.5, s * 0.42, 0, s * 0.5, s * 0.42, s * 0.62);
  grad.addColorStop(0, "#2a1f12");
  grad.addColorStop(0.55, "#140d08");
  grad.addColorStop(1, "#070505");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
const BACKDROP_TEX = makeBackdrop();

/* ---------- the sheet ----------
   Guide lines are printed straight into the paper so they scale with it and read as
   ruled, not modelled. Fibre grain + (aged) foxing keep a large sheet from reading
   as a flat swatch. Deterministic — every tile of a given variant is identical. */
function makePaperTexture(tint: string, dark: boolean, aged: boolean, seed: number): THREE.CanvasTexture {
  const W = 512;
  const H = 660; // a portrait sheet
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = tint;
  g.fillRect(0, 0, W, H);

  // fibre grain: a fine speckle, lighter on pale paper and cooler on indigo
  const rand = mulberry32(seed);
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const amp = dark ? 10 : 16;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amp;
    d[i] = clamp01((d[i] + n) / 255) * 255;
    d[i + 1] = clamp01((d[i + 1] + n) / 255) * 255;
    d[i + 2] = clamp01((d[i + 2] + n) / 255) * 255;
  }
  g.putImageData(img, 0, 0);

  // foxing: soft sepia blooms an old sheet gathers
  if (aged) {
    for (let k = 0; k < 26; k++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = 6 + rand() * 26;
      const fox = g.createRadialGradient(x, y, 0, x, y, r);
      fox.addColorStop(0, `rgba(120,86,40,${0.05 + rand() * 0.06})`);
      fox.addColorStop(1, "rgba(120,86,40,0)");
      g.fillStyle = fox;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  // ruled guide lines across the writing band (upper two-thirds)
  g.strokeStyle = dark ? "rgba(180,196,235,0.16)" : "rgba(90,70,40,0.16)";
  g.lineWidth = 1;
  for (let i = 1; i <= 7; i++) {
    const y = H * 0.14 + (i / 8) * H * 0.5;
    g.beginPath();
    g.moveTo(W * 0.1, y);
    g.lineTo(W * 0.9, y);
    g.stroke();
  }

  // a soft vignette so the sheet's edges settle into the dark desk
  const vg = g.createRadialGradient(W * 0.5, H * 0.5, W * 0.3, W * 0.5, H * 0.5, W * 0.72);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, dark ? "rgba(0,0,0,0.34)" : "rgba(60,40,16,0.22)");
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- build the ink ribbon from the write path ---------- */
interface Ink {
  geo: THREE.BufferGeometry;
  spine: Float32Array; // the swept centreline, in writing order (x,y,z), normalized
  spineCount: number;
  totalIndex: number; // draw-range grows 0 → this
  aspect: number; // height / width of the writing block
}

function buildInk(source: string, lang: "en" | "ar"): Ink | null {
  const text = source.replace(/\s*\n\s*\n+/g, "\n").slice(0, SRC_CAP);
  if (!text.trim()) return null;

  // Regular weight, not bold: the heavy script faces close their own counters at
  // this size, and the tube's radius already gives the strokes their body.
  const wp = orderWritePath(text, {
    step: STEP,
    fontSize: FONT_PX,
    fontWeight: "400",
    fontFamily: SCRIPT,
    maxWidthPx: FONT_PX * 8,
    lineHeight: LINE_H,
    lang,
  });
  if (!wp.count) return null;

  const lineCount = Math.max(1, wp.lineStarts.length);
  // Reconstruct the raster width from aspect + line count (foggy-mirror's gridFrac):
  // normalized width is 1, so one column spacing in normalized units is STEP/rasterW.
  const rasterHpx = lineCount * FONT_PX * LINE_H + Math.ceil(FONT_PX * 0.25) * 2;
  const gridFrac = (STEP * wp.aspect) / rasterHpx;
  const radius = Math.max(0.0035, gridFrac * RAD_K);
  const jump2 = (gridFrac * JUMP_K) ** 2;
  const lineSet = new Set(wp.lineStarts);

  // Split the sweep into strokes at every pen-lift: a line boundary, or any leap
  // longer than a couple of column steps (a letter gap, or across a counter hole).
  const strokes: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < wp.count; i++) {
    const x = wp.path[i * 2];
    const y = wp.path[i * 2 + 1];
    let lift = false;
    if (i > 0) {
      if (lineSet.has(i)) lift = true;
      else {
        const du = x - wp.path[(i - 1) * 2];
        const dv = y - wp.path[(i - 1) * 2 + 1];
        if (du * du + dv * dv > jump2) lift = true;
      }
    }
    if (lift) {
      if (cur.length >= 4) strokes.push(cur); // >= 2 points
      cur = [];
    }
    cur.push(x, y);
  }
  if (cur.length >= 4) strokes.push(cur);
  if (!strokes.length) return null;

  // Tube each stroke and concatenate into one indexed geometry, keeping writing
  // order so a single monotone draw-range grows the whole piece in the right order.
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const spine: number[] = [];
  let vBase = 0;
  for (const s of strokes) {
    const n = s.length / 2;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < n; k++) {
      pts.push(new THREE.Vector3(s[k * 2], s[k * 2 + 1], 0));
      spine.push(s[k * 2], s[k * 2 + 1], 0);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, Math.max(1, n - 1), radius, RADIAL, false);
    const p = tube.attributes.position.array;
    const nr = tube.attributes.normal.array;
    const idx = tube.index!.array;
    for (let i = 0; i < p.length; i++) {
      positions.push(p[i]);
      normals.push(nr[i]);
    }
    for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vBase);
    vBase += tube.attributes.position.count;
    tube.dispose(); // the merged geometry owns the data now
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices); // three picks Uint16/Uint32 from the max index for us
  geo.computeBoundingSphere();

  return { geo, spine: new Float32Array(spine), spineCount: spine.length / 3, totalIndex: indices.length, aspect: wp.aspect };
}

/* ---------- build the tazhib frame ---------- */
interface Frame {
  geo: THREE.BufferGeometry; // gold border tube, unfurled by draw-range
  totalIndex: number;
  glint: Float32Array; // additive gold flecks along the vine (x,y,z)
  glintCount: number;
}

function buildFrame(halfW: number, halfH: number): Frame {
  const pts: THREE.Vector3[] = [];
  const glint: number[] = [];
  const rW = Math.max(0.06, halfW * 0.22);
  const rH = Math.max(0.06, halfH * 0.22);
  for (let i = 0; i < FRAME_SEG; i++) {
    // start at top-centre, sweep clockwise, so the border unfurls from the top
    const th = Math.PI / 2 - (i / FRAME_SEG) * Math.PI * 2;
    const cx = Math.cos(th);
    const sy = Math.sin(th);
    const x = Math.sign(cx) * Math.pow(Math.abs(cx), SQUIRCLE) * halfW;
    const y = Math.sign(sy) * Math.pow(Math.abs(sy), SQUIRCLE) * halfH;
    // outward normal of the super-ellipse, so the arabesque vine waves in/out cleanly
    let nx = x / (rW * rW);
    let ny = y / (rH * rH);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const lobe = Math.sin((i / FRAME_SEG) * Math.PI * 2 * LOBE_FREQ) * LOBE_AMP;
    pts.push(new THREE.Vector3(x + nx * lobe, y + ny * lobe, 0));
    if (i % 4 === 0) glint.push(x + nx * (lobe + LOBE_AMP * 0.6), y + ny * (lobe + LOBE_AMP * 0.6), FRAME_Z + 0.002);
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  const tube = new THREE.TubeGeometry(curve, FRAME_SEG, FRAME_R, 6, true);
  return { geo: tube, totalIndex: tube.index!.array.length, glint: new Float32Array(glint), glintCount: glint.length / 3 };
}

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

const WET_TRAIL = 20; // sprites trailing the nib, the wet sheen before it dries

interface OpenState {
  interacted: boolean;
  dragging: boolean;
  dips: number;
  wet: number; // ink in the nib, 1 → 0
  progress: number; // write progress 0 → 1
  pendingMove: number; // finger travel banked between frames, in uv units
  pu: number;
  pv: number;
  lastActivity: number; // t of the last real touch (auto actions never touch this)
  ripple: number; // inkwell ripple age, or -1 for none
  tazhibAt: number; // t the writing finished and the gold began (-1 before)
}

export default function QalamScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const inkPal = INKS[variants.ink] ?? INKS.midnight;
  const paperPal = PAPERS[variants.paper] ?? PAPERS.cream;

  // Preview writes the recipient's name (the card carries no message); everywhere
  // else the piece is the sender's message, name as the graceful fallback.
  const written = message.trim();
  const source = phase === "preview" || !written ? forRecipient(lang, recipientName) : written;

  /* useMemo is load-bearing: it owns the merged tube geometries, the textures and
     the materials — real GPU resources, disposed on unmount. */
  const ink = useMemo(() => buildInk(source, lang), [source, lang]);
  useEffect(() => () => ink?.geo.dispose(), [ink]);

  const aspect = ink ? ink.aspect : 0.42;

  const frame = useMemo(() => buildFrame(0.5 + FPAD, aspect / 2 + FPAD), [aspect]);
  useEffect(() => () => frame.geo.dispose(), [frame]);

  const paperTex = useMemo(
    () => makePaperTexture(paperPal.tint, paperPal.dark, paperPal.aged, 7000 + source.length * 13),
    [paperPal, source],
  );
  useEffect(() => () => paperTex.dispose(), [paperTex]);

  const inkMat = useMemo(() => {
    const body = paperPal.dark ? inkPal.darkBody : inkPal.body;
    return new THREE.MeshStandardMaterial({
      color: body,
      // A gold-leaf ink on indigo is metallic; a wet ink on pale paper is not.
      metalness: paperPal.dark ? 0.85 : 0.15,
      roughness: paperPal.dark ? 0.34 : 0.32, // low enough to catch the lamp as a wet sheen
      envMap: ENV_TEX,
      envMapIntensity: paperPal.dark ? 1.25 : 0.7,
      // a whisper of emissive so a dark ink still reads in the corners of the sheet
      emissive: new THREE.Color(paperPal.dark ? inkPal.sheen : inkPal.body),
      emissiveIntensity: paperPal.dark ? 0.12 : 0.16,
    });
  }, [inkPal, paperPal]);
  useEffect(() => () => inkMat.dispose(), [inkMat]);

  const goldMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: GOLD,
        metalness: 1,
        roughness: 0.28,
        envMap: ENV_TEX,
        envMapIntensity: 1.3,
        emissive: new THREE.Color("#2a1c00"),
        emissiveIntensity: 0.4,
      }),
    [],
  );
  useEffect(() => () => goldMat.dispose(), [goldMat]);

  // The recipient's name in gold script — the card's nameplate, the sealed sheet's
  // promise. Its own texture so preview reads even when the ink is hidden.
  const nameplate = useMemo(() => {
    const t = makeTextTexture(forRecipient(lang, recipientName), {
      fontFamily: SCRIPT,
      fontWeight: "400",
      fontSize: 84,
      color: GOLD_SHEEN,
      glow: 18,
      glowColor: "#8a5a10",
      maxWidthPx: 84 * 8,
      lineHeight: 1.2,
      lang,
    });
    return { ...t, size: fitPlane(t.aspect, 0.72, 0.3) as [number, number] };
  }, [recipientName, lang]);
  useEffect(() => () => nameplate.texture.dispose(), [nameplate]);

  // Both names, for the roundel beneath the finished piece.
  const roundel = useMemo(() => {
    const sender = senderName.trim() || pick(lang, "Someone", "مُهدٍ");
    const recip = recipientName.trim() || pick(lang, "you", "إليك");
    const label = `${recip}\n${pick(lang, `from ${sender}`, `من ${sender}`)}`;
    const t = makeTextTexture(label, {
      fontFamily: SCRIPT,
      fontWeight: "400",
      fontSize: 60,
      color: GOLD_SHEEN,
      maxWidthPx: 60 * 8,
      lineHeight: 1.35,
      lang,
    });
    return { ...t, size: fitPlane(t.aspect, ROUNDEL_R * 1.5, ROUNDEL_R * 1.2) as [number, number] };
  }, [senderName, recipientName, lang]);
  useEffect(() => () => roundel.texture.dispose(), [roundel]);

  const wetTrailPos = useMemo(() => new Float32Array(WET_TRAIL * 3), []);
  // the charged-nib colour, hoisted out of useFrame (no per-frame Color allocation)
  const nibWet = useMemo(
    () => new THREE.Color(paperPal.dark ? inkPal.darkBody : inkPal.body),
    [paperPal, inkPal],
  );

  /* ---------- normalized layout (width of the writing block = 1) ---------- */
  const layout = useMemo(() => {
    const halfH = aspect / 2 + FPAD; // frame half-height
    const roundelCY = -(halfH + ROUNDEL_GAP + ROUNDEL_R);
    const top = halfH;
    const bottom = roundelCY - ROUNDEL_R;
    return {
      halfH,
      roundelCY,
      artW: 1 + 2 * FPAD,
      artH: top - bottom,
      centerY: (top + bottom) / 2, // to slide the whole composition onto the page centre
    };
  }, [aspect]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  const deskRef = useRef<THREE.Group>(null);
  const artRef = useRef<THREE.Group>(null);
  const paperRef = useRef<THREE.Mesh>(null);
  const inkMeshRef = useRef<THREE.Mesh>(null);
  const ghostRef = useRef<THREE.Points>(null);
  const ghostMatRef = useRef<THREE.PointsMaterial>(null);
  const frameMeshRef = useRef<THREE.Mesh>(null);
  const glintRef = useRef<THREE.Points>(null);
  const glintMatRef = useRef<THREE.PointsMaterial>(null);
  const roundelRef = useRef<THREE.Group>(null);
  const roundelMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const roundelRingRef = useRef<THREE.Mesh>(null);
  const nameplateRef = useRef<THREE.Mesh>(null);
  const nameplateMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const wellRef = useRef<THREE.Group>(null);
  const wellGlowRef = useRef<THREE.Sprite>(null);
  const rippleRef = useRef<THREE.Mesh>(null);
  const nibRef = useRef<THREE.MeshStandardMaterial>(null);
  const penRef = useRef<THREE.Group>(null);
  const lampRef = useRef<THREE.PointLight>(null);
  const lampGlowRef = useRef<THREE.Sprite>(null);
  const headGlowRef = useRef<THREE.Sprite>(null);
  const trailRef = useRef<THREE.Points>(null);
  const trailMatRef = useRef<THREE.PointsMaterial>(null);

  const st = useRef<OpenState>({
    interacted: false,
    dragging: false,
    dips: 0,
    wet: 0,
    progress: 0,
    pendingMove: 0,
    pu: 0,
    pv: 0,
    lastActivity: 0,
    ripple: -1,
    tazhibAt: -1,
  });

  // Opening is the one accumulating state here, so reset it from `phase` alone: a
  // replay must re-run the ritual from a dry nib, and reduced motion mounts straight
  // to revealed having never opened.
  useLayoutEffect(() => {
    const s = st.current;
    s.interacted = false;
    s.dragging = false;
    s.dips = 0;
    s.wet = 0;
    s.progress = 0;
    s.pendingMove = 0;
    s.lastActivity = 0;
    s.ripple = -1;
    s.tazhibAt = -1;
  }, [phase, ink]);

  const doDip = (auto: boolean, t: number) => {
    const s = st.current;
    if (s.dips >= DIPS || s.wet > 0.05) return; // already inked
    s.dips++;
    s.wet = 1;
    s.ripple = 0.0001; // start the inkwell ring
    if (!auto) {
      s.interacted = true;
      s.lastActivity = t;
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const s = st.current;

    /* ---------- fit the composition to the viewport ---------- */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    // The whole art scales as one; the geometry stays in normalized units so a
    // resize never rebuilds it (only the group's scale changes).
    const S = Math.min((vw * 0.92) / layout.artW, (vh * 0.86) / layout.artH);
    if (artRef.current) {
      artRef.current.scale.setScalar(S);
      artRef.current.position.set(0, -layout.centerY * S, 0);
    }
    // paper sized to wrap the art with a margin
    const paperHalfW = (layout.artW / 2 + 0.14) * S;
    const paperHalfH = (layout.artH / 2 + 0.16) * S;
    if (paperRef.current) paperRef.current.scale.set(paperHalfW * 2, paperHalfH * 2, 1);

    /* ---------- the ritual (opening only) ---------- */
    if (opening) {
      const idle = t - s.lastActivity;

      // Manual writing: banked finger travel drains the nib while it has ink and a
      // run is unlocked. The finger only powers it — the ink fills the true path.
      if (s.dips >= 1 && s.wet > 0 && s.pendingMove > 0) {
        s.wet = Math.max(0, s.wet - s.pendingMove * WRITE_GAIN);
      }
      s.pendingMove = 0;

      // Company, never a lock (foggy-mirror's mercy): if they stall, the unseen hand
      // dips and writes; if they never touch it at all, it does the whole thing.
      if (s.dips === 0 && (idle > T_IDLE_DIP || (s.interacted && idle > T_REDIP))) doDip(true, t);
      if (s.wet <= 0.02 && s.dips >= 1 && s.dips < DIPS && idle > T_REDIP) doDip(true, t);
      if (idle > T_ASSIST && s.wet > 0 && s.dips >= 1) s.wet = Math.max(0, s.wet - AUTO_RATE * dt);

      // Last resort so nothing outlasts the show, even a hand that keeps writing.
      if (t > T_FORCE) {
        s.dips = DIPS;
        s.wet = 0;
      }

      // progress is a pure function of (dips, wet): a nib empties across exactly one run
      const runStart = s.dips >= 2 ? RUN_ENDS[s.dips - 2] : 0;
      const runEnd = s.dips >= 1 ? RUN_ENDS[s.dips - 1] : 0;
      s.progress = clamp01(runStart + (1 - s.wet) * (runEnd - runStart));

      if (s.progress >= 0.999 && s.tazhibAt < 0) s.tazhibAt = t;
    }

    // ripple ages out regardless of phase (so a forced/auto dip still settles)
    if (s.ripple >= 0) {
      s.ripple += dt;
      if (s.ripple > 0.7) s.ripple = -1;
    }

    /* ---------- resolve the display factors from phase ---------- */
    const writeShown = phase === "revealed" ? 1 : opening ? s.progress : 0;
    const tazhib =
      phase === "revealed" ? 1 : opening && s.tazhibAt >= 0 ? clamp01((t - s.tazhibAt) / T_TAZHIB) : 0;
    const writing = opening && s.wet > 0.02 && s.progress < 0.999 && s.dips >= 1;
    const needDip = opening && s.wet <= 0.02 && s.dips < DIPS;

    /* ---------- the ink, grown by draw-range ---------- */
    if (ink && inkMeshRef.current) {
      const k = Math.floor((writeShown * ink.totalIndex) / 3) * 3;
      ink.geo.setDrawRange(0, k);
      inkMeshRef.current.visible = k > 0;
    }
    // ghost guide: only while opening, fading out as the ink covers it
    if (ghostMatRef.current) {
      const want = opening ? 0.16 * (1 - clamp01(writeShown * 1.15)) : 0;
      ghostMatRef.current.opacity += (want - ghostMatRef.current.opacity) * Math.min(1, dt * 6);
    }
    if (ghostRef.current) ghostRef.current.visible = !!ink && (ghostMatRef.current?.opacity ?? 0) > 0.004;

    /* ---------- the wet sheen chasing the nib ---------- */
    if (headGlowRef.current) {
      const on = ink && (writing || (phase === "revealed" ? false : opening && s.progress > 0 && s.progress < 0.999));
      let a = 0;
      if (ink && on) {
        const hi = Math.min(ink.spineCount - 1, Math.floor(s.progress * (ink.spineCount - 1)));
        headGlowRef.current.position.set(ink.spine[hi * 3], ink.spine[hi * 3 + 1], INK_Z + 0.01);
        a = 0.75 * (0.7 + 0.3 * Math.sin(e * 22));
      }
      const m = headGlowRef.current.material as THREE.SpriteMaterial;
      m.opacity += (a - m.opacity) * Math.min(1, dt * 8);
      headGlowRef.current.visible = m.opacity > 0.01;
    }
    if (ink && trailRef.current && trailMatRef.current) {
      // Mutate the geometry's own attribute (foggy-mirror's bead pattern), never the
      // memoized array in the closure — the lint recognizes the ref path as safe.
      const posA = trailRef.current.geometry.attributes.position as THREE.BufferAttribute;
      const hi = Math.floor(s.progress * (ink.spineCount - 1));
      let any = false;
      for (let j = 0; j < WET_TRAIL; j++) {
        const gi = hi - j * 3; // a short wake of freshly-laid, still-glistening ink
        if (writing && gi >= 0) {
          posA.setXYZ(j, ink.spine[gi * 3], ink.spine[gi * 3 + 1], INK_Z + 0.006);
          any = true;
        } else {
          posA.setXYZ(j, posA.getX(j), -999, posA.getZ(j));
        }
      }
      posA.needsUpdate = true;
      trailMatRef.current.opacity = writing ? 0.5 : Math.max(0, trailMatRef.current.opacity - dt * 2);
      trailRef.current.visible = any || trailMatRef.current.opacity > 0.01;
    }

    /* ---------- the tazhib frame, unfurling ---------- */
    if (frameMeshRef.current) {
      const k = Math.floor((easeOutCubic(tazhib) * frame.totalIndex) / 3) * 3;
      frame.geo.setDrawRange(0, k);
      frameMeshRef.current.visible = k > 0;
    }
    if (glintMatRef.current) {
      const on = tazhib > 0.2;
      glintMatRef.current.opacity = on ? clamp01((tazhib - 0.2) / 0.5) * (0.6 + 0.4 * Math.sin(e * 3)) : 0;
      glintMatRef.current.size = 0.05 + 0.014 * Math.sin(e * 4.2);
      if (glintRef.current) glintRef.current.visible = glintMatRef.current.opacity > 0.01;
    }

    /* ---------- the names' roundel, faded up late in the tazhib ---------- */
    const roundelA = clamp01((tazhib - ROUNDEL_IN) / (1 - ROUNDEL_IN));
    if (roundelMatRef.current) roundelMatRef.current.opacity = roundelA;
    if (roundelRingRef.current) {
      (roundelRingRef.current.material as THREE.MeshStandardMaterial).opacity = roundelA;
      roundelRingRef.current.scale.setScalar(lerp(0.82, 1, easeOutCubic(roundelA)));
    }
    if (roundelRef.current) roundelRef.current.visible = roundelA > 0.01;

    /* ---------- the recipient nameplate (preview / gentle on the card) ---------- */
    if (nameplateMatRef.current) {
      const want = phase === "preview" ? 0.9 + 0.1 * Math.sin(e * 0.8) : 0;
      nameplateMatRef.current.opacity += (want - nameplateMatRef.current.opacity) * Math.min(1, dt * 3);
      if (nameplateRef.current) nameplateRef.current.visible = nameplateMatRef.current.opacity > 0.01;
    }

    /* ---------- the inkwell: where the ink sits, and where a thumb is invited ---------- */
    if (wellRef.current) {
      wellRef.current.position.set(paperHalfW + 0.26 * S + 0.12, paperHalfH * 0.1, 0.02);
      const wk = Math.max(0.55, S * 1.15);
      wellRef.current.scale.setScalar(wk);
    }
    if (wellGlowRef.current) {
      // pulses when it wants a tap: sealed, and at each dry gate mid-opening
      const invite = phase === "sealed" || needDip;
      const want = invite ? 0.5 + 0.35 * Math.sin(e * 2.4) : phase === "preview" ? 0.22 : 0.12;
      const m = wellGlowRef.current.material as THREE.SpriteMaterial;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 3.5);
    }
    if (rippleRef.current) {
      const m = rippleRef.current.material as THREE.MeshBasicMaterial;
      if (s.ripple >= 0) {
        const r = s.ripple / 0.7;
        rippleRef.current.scale.setScalar(lerp(0.3, 1.3, r));
        m.opacity = (1 - r) * 0.6;
      } else {
        m.opacity = 0;
      }
      rippleRef.current.visible = m.opacity > 0.01;
    }
    // nib darkness follows the ink: wet + dark when charged, pale reed when dry
    if (nibRef.current) {
      const wet = opening ? s.wet : phase === "revealed" ? 0 : phase === "sealed" ? 0 : 0.15;
      nibRef.current.color.lerpColors(NIB_DRY, nibWet, clamp01(wet));
      nibRef.current.roughness = lerp(0.7, 0.25, clamp01(wet)); // wet ink is glossy
    }

    /* ---------- the pen, carried by the unseen hand ---------- */
    if (penRef.current) {
      // Rest pose: laid across the lower-left of the desk. Dipping: nib over the well.
      // Writing: nib riding the current head of the ink.
      let tx: number;
      let ty: number;
      let tz: number;
      let hop = 0;
      if (writing && ink) {
        const hi = Math.min(ink.spineCount - 1, Math.floor(s.progress * (ink.spineCount - 1)));
        // spine is in the art's normalized space; convert to desk space via the art group
        tx = ink.spine[hi * 3] * S;
        ty = ink.spine[hi * 3 + 1] * S - layout.centerY * S;
        tz = INK_Z + 0.02;
      } else if (needDip && wellRef.current) {
        tx = wellRef.current.position.x;
        ty = wellRef.current.position.y + 0.12;
        tz = 0.14;
        hop = 0.05 * Math.abs(Math.sin(e * 6));
      } else {
        // resting on its rest, lower-left of the sheet
        tx = -paperHalfW - 0.02;
        ty = -paperHalfH + 0.1;
        tz = 0.06;
        hop = (phase === "preview" || phase === "revealed") ? 0.012 * Math.sin(e * 1.1) : 0;
      }
      const k = Math.min(1, dt * (writing ? 9 : 5));
      penRef.current.position.x = lerp(penRef.current.position.x, tx, k);
      penRef.current.position.y = lerp(penRef.current.position.y, ty, k);
      penRef.current.position.z = lerp(penRef.current.position.z, tz + hop, k);
    }

    /* ---------- the one warm lamp ---------- */
    if (lampRef.current) {
      lampRef.current.intensity = 5.5 + 0.5 * Math.sin(e * 2.3) + 0.3 * Math.sin(e * 7.1);
    }
    if (lampGlowRef.current) {
      const m = lampGlowRef.current.material as THREE.SpriteMaterial;
      m.opacity = 0.5 + 0.06 * Math.sin(e * 2.3);
    }

    /* ---------- the desk leans a little toward the pointer ---------- */
    if (deskRef.current) {
      const k = Math.min(1, dt * 2.5);
      deskRef.current.rotation.x = lerp(deskRef.current.rotation.x, -0.3 + state.pointer.y * 0.05, k);
      deskRef.current.rotation.y = lerp(deskRef.current.rotation.y, state.pointer.x * 0.06, k);
    }

    /* ---------- the show ends exactly once ---------- */
    if (opening && s.tazhibAt >= 0 && t > s.tazhibAt + T_TAZHIB && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    } else if (opening && !ink && t > 1.2 && !doneRef.current) {
      // nothing to write (empty source) — settle and finish
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const onPaperDown = (ev: { stopPropagation: () => void; uv?: THREE.Vector2 }) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    const s = st.current;
    s.dragging = true;
    s.interacted = true;
    s.lastActivity = tRef.current;
    if (ev.uv) {
      s.pu = ev.uv.x;
      s.pv = ev.uv.y;
    }
  };
  const onPaperMove = (ev: { stopPropagation: () => void; uv?: THREE.Vector2 }) => {
    const s = st.current;
    if (!s.dragging || !ev.uv) return;
    ev.stopPropagation();
    const du = ev.uv.x - s.pu;
    const dv = ev.uv.y - s.pv;
    s.pendingMove += Math.hypot(du, dv); // any drag advances the writing — forgiving
    s.pu = ev.uv.x;
    s.pv = ev.uv.y;
    s.lastActivity = tRef.current;
  };
  const endDrag = () => {
    st.current.dragging = false;
  };

  return (
    <>
      {/* Camera looks straight down -Z so viewport sizing stays exact; the DESK tilts
          back, which is what gives the whole thing its over-the-shoulder depth. */}
      <PerspectiveCamera makeDefault position={[0, 0, 5.4]} fov={42} />

      {/* the night room */}
      <mesh position={[0, 0, -4]}>
        <planeGeometry args={[26, 26]} />
        <meshBasicMaterial map={BACKDROP_TEX} depthWrite={false} toneMapped={false} />
      </mesh>

      <ambientLight intensity={0.35} color="#ffdca8" />
      {/* fill so the ink's shaded side never goes fully black on pale paper */}
      <directionalLight position={[-1.5, 1, 3]} intensity={0.5} color="#8fa6c8" />

      <group ref={deskRef} rotation={[-0.3, 0, 0]}>
        {/* the one warm lamp, up and to the left */}
        <pointLight ref={lampRef} position={[-1.7, 1.9, 1.6]} intensity={5.5} color="#ffcf8f" distance={9} decay={1.4} />
        <sprite ref={lampGlowRef} position={[-1.85, 2.0, 0.4]} scale={[2.6, 2.6, 1]}>
          <spriteMaterial
            map={glowTex}
            color="#ffca82"
            transparent
            opacity={0.5}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>

        {/* the sheet — also the drag surface (planeGeometry carries uv for e.uv) */}
        <mesh
          ref={paperRef}
          onPointerDown={onPaperDown}
          onPointerMove={onPaperMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial map={paperTex} roughness={0.95} metalness={0} />
        </mesh>

        {/* the recipient's name in gold — the card's nameplate, above the sheet */}
        {nameplate && (
          <mesh ref={nameplateRef} position={[0, 0.02, 0.02]} visible={false}>
            <planeGeometry args={nameplate.size} />
            <meshBasicMaterial
              ref={nameplateMatRef}
              map={nameplate.texture}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        )}

        {/* everything that scales as one composition on the sheet */}
        <group ref={artRef}>
          {/* ghost guide the pen follows (opening only) */}
          {ink && (
            <points ref={ghostRef} position={[0, 0, INK_Z - 0.001]} visible={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[ink.spine, 3]} />
              </bufferGeometry>
              <pointsMaterial
                ref={ghostMatRef}
                color={paperPal.dark ? "#9fb2d8" : "#5a4a34"}
                size={0.01}
                sizeAttenuation
                transparent
                opacity={0}
                depthWrite={false}
              />
            </points>
          )}

          {/* the ink itself, grown by draw-range */}
          {ink && (
            <mesh ref={inkMeshRef} geometry={ink.geo} material={inkMat} position={[0, 0, INK_Z]} visible={false} />
          )}

          {/* the wet sheen: a bright head + a short glistening wake */}
          <sprite ref={headGlowRef} scale={[0.09, 0.09, 1]} visible={false}>
            <spriteMaterial
              map={glowTex}
              color={inkPal.sheen}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </sprite>
          <points ref={trailRef} visible={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[wetTrailPos, 3]} />
            </bufferGeometry>
            <pointsMaterial
              ref={trailMatRef}
              map={glowTex}
              color={inkPal.sheen}
              size={0.05}
              sizeAttenuation
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </points>

          {/* the tazhib gold frame, unfurled by draw-range */}
          <mesh ref={frameMeshRef} geometry={frame.geo} material={goldMat} position={[0, 0, FRAME_Z]} visible={false} />
          <points ref={glintRef} visible={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[frame.glint, 3]} />
            </bufferGeometry>
            <pointsMaterial
              ref={glintMatRef}
              map={goldGlintTex}
              color={GOLD_SHEEN}
              size={0.05}
              sizeAttenuation
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </points>

          {/* the names' roundel, beneath the piece */}
          <group ref={roundelRef} position={[0, layout.roundelCY, FRAME_Z]} visible={false}>
            <mesh ref={roundelRingRef}>
              <torusGeometry args={[ROUNDEL_R, FRAME_R * 0.9, 8, 60]} />
              <meshStandardMaterial
                color={GOLD}
                metalness={1}
                roughness={0.3}
                envMap={ENV_TEX}
                envMapIntensity={1.3}
                emissive={new THREE.Color("#2a1c00")}
                emissiveIntensity={0.4}
                transparent
                opacity={0}
              />
            </mesh>
            <mesh position={[0, 0, 0.006]}>
              <planeGeometry args={roundel.size} />
              <meshBasicMaterial
                ref={roundelMatRef}
                map={roundel.texture}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        </group>

        {/* the inkwell — the dip target */}
        <group ref={wellRef} position={[1.4, 0, 0.02]}>
          {/* generous invisible hit sphere so a fingertip finds it easily */}
          <mesh
            onPointerDown={(ev) => {
              ev.stopPropagation();
              doDip(false, tRef.current);
            }}
          >
            <sphereGeometry args={[0.2, 12, 10]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          {/* the pot */}
          <mesh position={[0, -0.05, 0]}>
            <cylinderGeometry args={[0.15, 0.17, 0.16, 24]} />
            <meshStandardMaterial color="#2a2018" roughness={0.6} metalness={0.2} envMap={ENV_TEX} />
          </mesh>
          {/* the ink surface */}
          <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.12, 24]} />
            <meshStandardMaterial
              color={paperPal.dark ? inkPal.darkBody : inkPal.body}
              roughness={0.12}
              metalness={paperPal.dark ? 0.7 : 0.3}
              envMap={ENV_TEX}
              envMapIntensity={1.2}
            />
          </mesh>
          {/* the ring a dip sends across the ink */}
          <mesh ref={rippleRef} position={[0, 0.037, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
            <ringGeometry args={[0.055, 0.075, 24]} />
            <meshBasicMaterial color={inkPal.sheen} transparent opacity={0} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
          </mesh>
          {/* a soft glow inviting the tap */}
          <sprite ref={wellGlowRef} position={[0, 0.05, 0]} scale={[0.7, 0.7, 1]}>
            <spriteMaterial map={glowTex} color={GOLD_SHEEN} transparent opacity={0.2} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
          </sprite>
        </group>

        {/* the qalam — a cut reed, carried by the unseen hand */}
        <group ref={penRef} position={[-1.4, -1, 0.06]} rotation={[0, 0, -0.85]}>
          {/* the reed shaft: origin sits at the nib tip, shaft rises up the +y slant */}
          <mesh position={[0, 0.34, 0]}>
            <cylinderGeometry args={[0.018, 0.032, 0.62, 12]} />
            <meshStandardMaterial color="#a9743a" roughness={0.55} metalness={0.1} envMap={ENV_TEX} />
          </mesh>
          {/* a bound collar */}
          <mesh position={[0, 0.1, 0]}>
            <cylinderGeometry args={[0.028, 0.028, 0.03, 12]} />
            <meshStandardMaterial color="#5a3a1e" roughness={0.7} />
          </mesh>
          {/* the carved nib — darkens and glosses when charged with ink */}
          <mesh position={[0, 0.03, 0]}>
            <coneGeometry args={[0.03, 0.09, 10]} />
            <meshStandardMaterial ref={nibRef} color="#3a2c1c" roughness={0.4} metalness={0.25} envMap={ENV_TEX} />
          </mesh>
        </group>
      </group>
    </>
  );
}
