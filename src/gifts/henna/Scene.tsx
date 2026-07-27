import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makePaintMask, paintWritePath } from "../mask";
import { makeRadialSprite } from "../sprites";
import { orderWritePath, makeTextTexture, type WritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
// `wet` is the paste going on, `set` is how far the whole cone-load darkens on its
// own, and `dry` is the colour the drying *front* leaves behind it; `stain` is what
// is left underneath, which is the only colour that matters.
const STAINS: Record<string, { stain: string; bleed: string; glow: string }> = {
  henna: { stain: "#7d3312", bleed: "#a8552a", glow: "#ff9c52" },
  umber: { stain: "#4b2a15", bleed: "#6f452a", glow: "#c98a55" },
  "black-cherry": { stain: "#4a1226", bleed: "#71263f", glow: "#d4607f" },
};
const WET = "#6b7a30";
const SET_COLOR = "#555c26";
const DRY_COLOR = "#2c2814";
const FLAKE_COLOR = "#3d3720";
/* Hoisted: the paste colour is lerped every frame and its endpoints are constant. */
const shadeWet = new THREE.Color(WET);
const shadeSet = new THREE.Color(SET_COLOR);

/* Old henna, already faded into the hand — the palm is decorated before we start,
   which is what makes the new pattern read as new. One motif per variant. */
type Motif = "khaleeji" | "moroccan" | "floral";
const MOTIFS: Record<string, Motif> = { khaleeji: "khaleeji", moroccan: "moroccan", floral: "floral" };

const TAU = Math.PI * 2;
const MASK_SIZE = 512;
const W_FRAC_MAX = 0.8;
// orderWritePath is a dense sweep *through* the ink, not a centreline, so any
// brush radius dilates the glyph outward: at 0.016 uv (~8px on a 512 mask) the
// letters close into blobs. A hair over one pixel is what keeps them legible, and
// the soft falloff still reads as a bead of paste.
const PASTE_R_SLOW = 0.0072; // real paste pools where the cone dawdles…
const PASTE_R_FAST = 0.0034; // …and draws out to a thread when it is pulled
const STAIN_R_SLOW = 0.0072; // the skin takes a shade wider than the bead sitting on it
const STAIN_R_FAST = 0.0052;
// The drying front can never be wider than the thinnest bead, or it would darken
// bare skin either side of a thread of paste.
const DRY_R = PASTE_R_FAST;
const FAT_V = 1.0; // uv·s⁻¹ at which the bead is at its thinnest
const GAP2 = 0.0022; // squared uv gap that lifts the cone instead of dragging a line
const V_OFF = 0.02; // the block sits a touch above the palm's centre

/* ---------- opening timeline ---------- */
const DRY_HOLD = 2.4; // the enforced pause: the front sweeping the pattern
const DRY_SWEEP = 3.4; // seconds a full-length sweep takes while paste is still going on
const DRY_LEAD = 0.5; // …and it may never dry more than half of what has been laid
const RUB_TARGET = 0.22; // paste coverage the thumb has to get below
const RELEASE = 0.55; // what is left lets go, over this, rather than all at once
const BLOOM = 1.5; // the stain coming up to full under the bare skin
const LATE_FLAKE = 1.35; // the one that drops after everything else has stopped
const REVEAL_END = 1.95; // and only then is the gift open
const APPLY_RATE = 2.1; // path advanced per uv unit of drag
const ACTION_W = 2.5;
const ACTION_H = 3.1;

/* ---------- the mercy path ---------- */
// A gift may never lock waiting for input, and the bound is 12s on `onOpenComplete`,
// not on the moment the scene gives up — so the budget is the whole three-act show:
//   2.4 grace + ~2.3 trace + 1.3 drying + ~1.7 rubbing + 1.95 reveal ≈ 9.7s.
// It drives both pointer acts, because both of them are the gesture: the cone runs
// the same ghost path in the same stroke order, then the thumb comes back over it.
const MERCY0 = 2.4; // …long enough that a hand which is *about to* start is never overridden
const MERCY_RAMP = 0.5; // and it eases in over this, so the cone starts moving rather than jumps
const MERCY_TRACE = 2.0; // seconds the whole pattern takes to lay itself down
const MERCY_RUB = 2.0; // …and to come back off
// The drying beat is kept — it is the middle act, not a gap — but it is the one thing
// here with no gesture behind it, so it is where the headroom comes from.
const MERCY_DRY = 1.3;
// A path sweep travels far more uv per second than a thumb does, and the flake shed is
// distance-gated: without this the auto-rub sheds a hundred flakes a second.
const MERCY_BITE = 0.085; // uv per flake, per uv·s⁻¹ of thumb speed — a steady ~12/s

/* ---------- the shot ---------- */
const FOV = 40;
const CAM_Z = 3.1;
const CAM_Z_IN = 2.74;

/** Faded prior henna: a mandala at the palm and a band across the wrist. */
function buildMotif(kind: Motif): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const cx = s / 2;
  const cy = s * 0.56;
  g.strokeStyle = "#fff";
  g.fillStyle = "#fff";
  g.lineWidth = s * 0.005;

  const petals = kind === "khaleeji" ? 8 : kind === "moroccan" ? 12 : 6;
  for (const ring of [0.1, 0.17, 0.245]) {
    g.beginPath();
    g.arc(cx, cy, s * ring, 0, TAU);
    g.stroke();
  }
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU;
    const x = cx + Math.cos(a) * s * 0.205;
    const y = cy + Math.sin(a) * s * 0.205;
    g.beginPath();
    if (kind === "moroccan") {
      // interlaced diamonds
      const r = s * 0.036;
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.stroke();
    } else if (kind === "floral") {
      g.ellipse(x, y, s * 0.05, s * 0.02, a, 0, TAU);
      g.stroke();
    } else {
      // khaleeji: a fine teardrop on a stem
      g.ellipse(x, y, s * 0.028, s * 0.016, a, 0, TAU);
      g.stroke();
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * s * 0.245, cy + Math.sin(a) * s * 0.245);
      g.lineTo(cx + Math.cos(a) * s * 0.3, cy + Math.sin(a) * s * 0.3);
      g.stroke();
    }
  }
  // fingertip caps and a wrist band — where real henna always goes
  const rand = mulberry32(4181);
  for (let i = 0; i < 4; i++) {
    const x = s * (0.29 + i * 0.14);
    g.beginPath();
    g.arc(x, s * 0.1, s * 0.03, 0, TAU);
    g.stroke();
  }
  for (let i = 0; i < 26; i++) {
    const x = (i / 26) * s;
    g.beginPath();
    g.moveTo(x, s * 0.9);
    g.lineTo(x + s * 0.012, s * 0.96 - rand() * s * 0.02);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** Craquelure: short random splinters. Gated by the drying mask, so cracks only
 *  ever appear where the front has already been — the pattern crazes in the order
 *  it was drawn, without a second texture per beat. */
function buildCracks(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const rand = mulberry32(9091);
  g.strokeStyle = "rgba(20,16,6,0.95)";
  for (let i = 0; i < 220; i++) {
    const x = rand() * s;
    const y = rand() * s;
    const a = rand() * TAU;
    const len = s * (0.012 + rand() * 0.03);
    g.lineWidth = 1 + rand() * 1.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}
const CRACKS = buildCracks();
const HINT_SPRITE = makeRadialSprite(64);

/** Patterned silk under the whole scene. */
function buildSilk(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#37131f";
  g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(196,138,74,0.5)";
  g.lineWidth = 1.4;
  for (let i = -s; i < s * 2; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + s, s);
    g.stroke();
    g.beginPath();
    g.moveTo(i + s, 0);
    g.lineTo(i, s);
    g.stroke();
  }
  const glow = g.createRadialGradient(s / 2, s * 0.4, 0, s / 2, s * 0.4, s * 0.7);
  glow.addColorStop(0, "rgba(255,196,120,0.32)");
  glow.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}
const SILK = buildSilk();

/* ---------- the hand: palm up, four fingers and a thumb ---------- */
const palmGeo = new THREE.SphereGeometry(0.5, 30, 22);
palmGeo.scale(1.05, 1.34, 0.4);
const fingerGeo = new THREE.CapsuleGeometry(0.082, 0.42, 5, 12);
const thumbGeo = new THREE.CapsuleGeometry(0.095, 0.3, 5, 12);
const wristGeo = new THREE.CapsuleGeometry(0.28, 0.34, 5, 16);
// Splayed a little, and each finger a different length — an even fan reads as a glove.
const FINGERS: [number, number, number, number][] = [
  [-0.3, 0.62, -0.16, 0.94],
  [-0.1, 0.7, -0.05, 1.06],
  [0.11, 0.68, 0.05, 1.0],
  [0.3, 0.58, 0.17, 0.86],
];
// Shared and never mutated per-instance, so one of each for every scene on the page.
const skinMat = new THREE.MeshStandardMaterial({ color: "#d69a6d", roughness: 0.7 });
const wristMat = new THREE.MeshStandardMaterial({ color: "#c98f63", roughness: 0.72 });

/* ---------- flakes ---------- */
const FLAKES = 44;
const FLAKE_FADE = 0.5;
// Where they come to rest, in the painted quad's frame: the heel of the palm, not
// the table — the table edge is below the frame once the reveal has pushed in, and
// flakes off a palm-up hand collect in the heel anyway.
const FLAKE_FLOOR = -0.74;
const flakeGeo = new THREE.PlaneGeometry(1, 1);
const flakeMat = new THREE.MeshStandardMaterial({
  color: FLAKE_COLOR,
  roughness: 0.94,
  side: THREE.DoubleSide, // they tumble, so both faces get seen
});
const dummy = new THREE.Object3D();

/* ---------- motes ---------- */
// The dust the lamps pick out. Pure functions of one accumulator, so nothing here
// has to be integrated or reset between phases.
const MOTES = 46;
const MOTE_SPAN = 2.6;

/* The painted quads' size. Every mask uv maps onto exactly this rectangle, and so
   must the hit target, or a thumb lands somewhere the brush does not. */
const HAND_W = 1.05;
const HAND_H = 1.34;
/* Where that rectangle sits inside the hand, so the cone and the thumb can be
   aimed at a uv without going through a matrix. */
const PAINT_Y = -0.06;
const PAINT_Z = 0.215;
const pathX = (w: WritePath, wFrac: number, i: number) => w.path[i * 2] * wFrac * HAND_W;
const pathY = (w: WritePath, wFrac: number, i: number) => (w.path[i * 2 + 1] * wFrac + V_OFF) * HAND_H;

/* ---------- the cone and the thumb, at rest ---------- */
const CONE_REST: [number, number, number] = [-0.95, -0.36, 0.16];
const THUMB_REST: [number, number, number] = [-0.5, -0.24, 0.02];
const THUMB_ROT = 0.85;
// Underdamped on purpose: a held cone lags the hand, then overshoots and comes back.
const SPRING_K = 190;
const SPRING_D = 17;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

/* act: 0 applying, 1 drying, 2 rubbing, 3 done. `peak` is the paste coverage the
   moment the pattern closed, so the rub target is a fraction of what was actually
   laid down and not of the whole mask (which thin strokes barely touch). */
function newRun() {
  return {
    act: 0,
    idx: 0, // head of the path, fractional
    painted: -1, // …and the last index actually stamped, which must be whole
    dryIdx: 0,
    dryPainted: -1,
    dryFrom: 0,
    dryAt: 0,
    doneAt: 0,
    down: false,
    hover: false,
    touched: false,
    // the mercy path's own clock, and what it is currently driving
    alone: 0,
    auto: false, // the scene is laying the paste down itself
    autoRub: false, // …and taking it off itself
    rubIdx: 0,
    hold: DRY_HOLD, // the drying beat, shortened only when nobody ever touched it
    u: 0.5,
    v: 0.5,
    pu: 0.5,
    pv: 0.5,
    moved: 0, // uv travelled since the last frame
    speed: 0,
    rubbed: 0, // …and since the last flake was shaken loose
    clackT: 0,
    peak: 1,
    poll: 0,
    shake: 0,
    glint: 0,
    moteT: 0,
    push: 0,
    late: false,
    seeded: false,
    cvx: 0,
    cvy: 0,
    cvz: 0,
    tvx: 0,
    tvy: 0,
    tvz: 0,
  };
}

export default function HennaScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const stainPal = STAINS[variants.stain] ?? STAINS.henna;
  const motifKind = MOTIFS[variants.pattern] ?? "khaleeji";

  const motif = useMemo(() => buildMotif(motifKind), [motifKind]);
  useEffect(() => () => motif.dispose(), [motif]);

  /* Four uses of one util, two of them inverse: the paste is drawn into `paste`
     and then rubbed back out of it, `dry` is the front chasing it in the same
     order, `stain` only ever grows (the skin keeps the record of where paste sat
     long after the paste is gone), and `ghost` is the whole pattern painted once
     at build so there is something to trace. */
  const masks = useMemo(
    () => ({
      paste: makePaintMask({ size: MASK_SIZE, filled: false }),
      dry: makePaintMask({ size: MASK_SIZE, filled: false }),
      stain: makePaintMask({ size: MASK_SIZE, filled: false }),
      ghost: makePaintMask({ size: MASK_SIZE, filled: false }),
    }),
    [],
  );
  useEffect(
    () => () => {
      masks.paste.dispose();
      masks.dry.dispose();
      masks.stain.dispose();
      masks.ghost.dispose();
    },
    [masks],
  );

  /* The pattern the cone traces IS the message — nothing is drawn that is not the
     words, so the stain underneath needs no second raster. */
  const write = useMemo(() => {
    const text = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    const w = orderWritePath(text, {
      step: 3,
      fontSize: 90,
      // Henna is drawn freehand and Arabic is natively cursive, so a script face
      // in both languages: `lang: "ar"` routes to Thmanyah on its own.
      fontWeight: "500",
      fontFamily: "'Snell Roundhand', 'Segoe Script', 'Bradley Hand', cursive",
      maxWidthPx: 90 * 7,
      lineHeight: 1.4,
      lang,
    });
    // The block has to fit the palm in both axes, so a tall paragraph narrows.
    const wFrac = Math.min(W_FRAC_MAX, 0.78 / Math.max(0.4, w.aspect));
    return { w, wFrac, lineStart: new Set(w.lineStarts) };
  }, [message, recipientName, lang]);

  const names = useMemo(() => {
    const t = makeTextTexture(`${senderName || "—"} · ${recipientName || "—"}`, {
      fontFamily: "'Snell Roundhand', 'Segoe Script', cursive",
      fontWeight: "600",
      fontSize: 44,
      color: stainPal.stain,
      maxWidthPx: 44 * 14,
      padding: 14,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 0.62, 0.1) };
  }, [senderName, recipientName, lang, stainPal]);
  useEffect(() => () => names.t.texture.dispose(), [names]);

  // Where each mote hangs and how fast it climbs. Read-only after this, so the
  // per-frame position is arithmetic on it and nothing has to be integrated.
  const motes = useMemo(() => {
    const rand = mulberry32(5309);
    const pos = new Float32Array(MOTES * 3);
    const base = new Float32Array(MOTES * 3); // x, y0, phase
    const spd = new Float32Array(MOTES);
    for (let i = 0; i < MOTES; i++) {
      base[i * 3] = (rand() - 0.5) * 2.6;
      base[i * 3 + 1] = rand() * MOTE_SPAN;
      base[i * 3 + 2] = rand() * TAU;
      pos[i * 3 + 2] = (rand() - 0.5) * 1.1;
      spd[i] = 0.5 + rand() * 0.9;
    }
    return { pos, base, spd };
  }, []);

  // The ghost is the finished pattern, painted once — it is what the cone follows.
  useEffect(() => {
    masks.ghost.reset();
    paintWritePath(masks.ghost, write.w, write.lineStart, -1, write.w.count - 1, DRY_R, write.wFrac, GAP2, V_OFF, "draw");
  }, [masks, write]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const g = useRef(newRun());
  const flakes = useRef({
    x: new Float32Array(FLAKES),
    y: new Float32Array(FLAKES),
    z: new Float32Array(FLAKES),
    vx: new Float32Array(FLAKES),
    vy: new Float32Array(FLAKES),
    vz: new Float32Array(FLAKES),
    spin: new Float32Array(FLAKES),
    spinV: new Float32Array(FLAKES),
    tip: new Float32Array(FLAKES),
    tipV: new Float32Array(FLAKES),
    age: new Float32Array(FLAKES).fill(-1),
    ttl: new Float32Array(FLAKES),
    size: new Float32Array(FLAKES),
    cursor: 0,
  });

  useEffect(() => {
    if (phase !== "opening") {
      // Every other phase is one of this machine's two endpoints, and lands on it
      // with no easing to spend: a cold `revealed` gets one frame under reduced
      // motion, so the next frame has to snap rather than start a lerp.
      g.current.seeded = false;
      return;
    }
    masks.paste.reset();
    masks.dry.reset();
    masks.stain.reset();
    flakes.current.age.fill(-1);
    // The dust in the lamplight belongs to the room, not to the run — restart its
    // clock and every mote in the air teleports on the frame the gift is unwrapped.
    const dust = g.current.moteT;
    g.current = newRun();
    g.current.moteT = dust;
  }, [phase, masks]);

  /* Sealed and revealed are two different shots of the same table: the second one
     is in on the palm, because that is where the words are. */
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const stageRef = useRef<THREE.Group>(null);
  const handRef = useRef<THREE.Group>(null);
  const fingerRefs = useRef<(THREE.Mesh | null)[]>([]);
  const thumbRef = useRef<THREE.Group>(null);
  const pasteMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const glossRef = useRef<THREE.Mesh>(null);
  const glossMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const crackMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const stainRef = useRef<THREE.Mesh>(null);
  const stainMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bleedRef = useRef<THREE.Mesh>(null);
  const bleedMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ghostMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const namesRef = useRef<THREE.Mesh>(null);
  const namesMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coneRef = useRef<THREE.Group>(null);
  const beadRef = useRef<THREE.Mesh>(null);
  const smudgeRef = useRef<THREE.Mesh>(null);
  const smudgeMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const glintRef = useRef<THREE.Mesh>(null);
  const glintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const flakeRef = useRef<THREE.InstancedMesh>(null);
  const moteRef = useRef<THREE.Points>(null);
  const moteMatRef = useRef<THREE.PointsMaterial>(null);
  const lampRef = useRef<THREE.PointLight>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const silkMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const sheenRef = useRef<THREE.Mesh>(null);
  const sheenMatRef = useRef<THREE.MeshBasicMaterial>(null);

  /** One flake let go, with whatever push the thumb was giving it. */
  const shed = (x: number, y: number, vx: number, vy: number, size: number) => {
    const f = flakes.current;
    const i = f.cursor;
    f.cursor = (i + 1) % FLAKES;
    f.x[i] = x;
    f.y[i] = y;
    f.z[i] = 0.022 + Math.random() * 0.012;
    f.vx[i] = vx + (Math.random() - 0.5) * 0.18;
    f.vy[i] = vy + Math.random() * 0.16;
    f.vz[i] = (Math.random() - 0.5) * 0.12;
    f.spin[i] = Math.random() * TAU;
    f.spinV[i] = (Math.random() - 0.5) * 7;
    f.tip[i] = Math.random() * TAU;
    f.tipV[i] = (Math.random() - 0.5) * 9;
    f.age[i] = 0;
    f.ttl[i] = 1.5 + Math.random() * 1.6;
    f.size[i] = size;
  };

  /* Paint from the ghost path, not from where the finger actually is: the cone is
     guided along a drawn pattern in real life too, and demanding pixel accuracy on
     a phone would make the gift unfinishable. Drag distance is the only input, and
     drag *speed* is the bead — dawdle and the paste pools, pull and it draws out. */
  /** Lay down everything the head has passed since the last stamp. Shared by the drag
   *  and by the mercy path, so both leave exactly the same paste behind them. */
  const stamp = () => {
    const cur = g.current;
    const wp = write.w;
    // Whole indices only: path is a Float32Array, and a fractional subscript reads
    // back undefined — which stamps the brush at NaN, i.e. nowhere at all.
    const to = Math.floor(cur.idx);
    if (to <= cur.painted) return;
    const fat = clamp01(cur.speed / FAT_V);
    paintWritePath(masks.stain, wp, write.lineStart, cur.painted, to, lerp(STAIN_R_SLOW, STAIN_R_FAST, fat), write.wFrac, GAP2, V_OFF, "draw");
    paintWritePath(masks.paste, wp, write.lineStart, cur.painted, to, lerp(PASTE_R_SLOW, PASTE_R_FAST, fat), write.wFrac, GAP2, V_OFF, "draw");
    cur.painted = to;
  };

  const advance = (du: number, dv: number) => {
    const cur = g.current;
    const wp = write.w;
    cur.idx = Math.min(wp.count - 1, cur.idx + Math.hypot(du, dv) * APPLY_RATE * wp.count);
    stamp();
  };

  /** One step of the thumb, from (pu,pv) to (u,v) already in `cur`. The thumb takes the
   *  paste off — same util as the cone, opposite direction — and the dried skin has to
   *  go with it or the crazing would outlive the paste. `bite` is the uv travelled per
   *  flake shaken loose, so a sweep that covers ground fast does not shed a blizzard. */
  const rubStep = (du: number, dv: number, bite: number) => {
    const cur = g.current;
    const r = lerp(0.042, 0.078, clamp01(cur.speed / 1.2));
    masks.paste.stroke(cur.pu, cur.pv, cur.u, cur.v, r, "erase");
    masks.dry.stroke(cur.pu, cur.pv, cur.u, cur.v, r, "erase");
    cur.rubbed += Math.hypot(du, dv);
    if (cur.rubbed > bite) {
      cur.rubbed = 0;
      shed((cur.u - 0.5) * HAND_W, (cur.v - 0.5) * HAND_H, du * 9, dv * 9 + 0.1, 0.016 + Math.random() * 0.022);
      if (cur.clackT <= 0) {
        cur.clackT = 0.085;
        clack({ freq: 2900 + Math.random() * 900, decay: 0.035, gain: 0.075 });
      }
    }
  };

  const uvOf = (ev: ThreeEvent<PointerEvent>) => ev.uv ?? null;

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    const uv = uvOf(ev);
    if (!uv) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — onPointerOut covers its absence */
    }
    const cur = g.current;
    cur.down = true;
    cur.touched = true; // and the invitation stops here, not a beat later
    // A real hand always wins: the mercy clock goes back to zero and the scene hands
    // whatever it was driving straight back.
    cur.alone = 0;
    cur.auto = cur.autoRub = false;
    cur.u = cur.pu = uv.x;
    cur.v = cur.pv = uv.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const cur = g.current;
    if (phase !== "opening") return;
    const uv = uvOf(ev);
    if (!uv) return;
    cur.alone = 0;
    cur.auto = cur.autoRub = false;
    if (!cur.down) {
      // A desktop pointer resting on the palm still aims the cone.
      cur.u = uv.x;
      cur.v = uv.y;
      return;
    }
    ev.stopPropagation();
    cur.pu = cur.u;
    cur.pv = cur.v;
    cur.u = uv.x;
    cur.v = uv.y;
    const du = cur.u - cur.pu;
    const dv = cur.v - cur.pv;
    cur.moved += Math.hypot(du, dv);
    if (cur.act === 0) advance(du, dv);
    else if (cur.act === 2) rubStep(du, dv, 0.045);
  };
  const stop = () => {
    g.current.down = false;
  };
  const onLeave = () => {
    g.current.down = false;
    g.current.hover = false;
  };
  const onEnter = () => {
    g.current.hover = true;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const cur = g.current;
    const wp = write.w;
    const last = wp.count - 1;
    // Nothing eases into a phase the loop may only render once — but `opening` is
    // the one phase that is always given its frames, and snapping its shot into
    // place would turn the unwrap into a jump cut.
    const snap = !cur.seeded && phase !== "opening";
    cur.seeded = true;
    const k3 = snap ? 1 : Math.min(1, dt * 3);

    /* ---- how fast the hand is actually going ---- */
    // Measured on the frame clock, not on event timestamps: pointer moves coalesce
    // and can share a timestamp, and dividing by that zero would hand a slow drag
    // an infinite speed. Smoothed, because the bead is a physical thing with mass.
    const moved = cur.moved;
    cur.moved = 0;
    cur.speed += ((dt > 0 ? moved / dt : 0) - cur.speed) * Math.min(1, dt * 9);
    cur.clackT = Math.max(0, cur.clackT - dt);
    cur.shake *= Math.exp(-dt / 0.19);

    // Lamps: layered sines at frequencies sharing no common multiple, so the
    // flicker never repeats and never reads as a loop.
    const flick =
      1 + 0.07 * Math.sin(e * 8.4) + 0.045 * Math.sin(e * 13.7 + 1.3) + 0.028 * Math.sin(e * 21.3 + 2.9);

    /* ---- act machine (opening only; the other phases are its two endpoints) ---- */
    if (phase === "opening") {
      // The mercy clock. Nothing has to happen for a gift to open: after MERCY0 of
      // being left alone the scene starts doing the gesture itself, easing in over
      // MERCY_RAMP rather than snapping. Any pointer event puts this back to zero.
      cur.alone += dt;
      const merc = smooth(clamp01((cur.alone - MERCY0) / MERCY_RAMP));

      if (cur.act === 0) {
        if (merc > 0) {
          // It has picked the cone up. `touched` is the honest word for that — it is
          // what ends the invitation glint and takes the cone off its hover, and both
          // of those have to stop the moment the pattern starts drawing itself.
          cur.touched = true;
          cur.auto = true;
          // Purely additive, and `idx` has no spring-back to fight: the head only ever
          // moves forward, so a hand that took over is never pulled back down the path.
          const step = (last * dt * merc) / MERCY_TRACE;
          // Fed through `moved` as well, so the bead thins out on the run exactly the
          // way it does under a thumb — the speed is measured, never assumed.
          cur.moved += step / (APPLY_RATE * wp.count);
          cur.idx = Math.min(last, cur.idx + step);
          stamp();
        }
        // Paste begins drying the instant it leaves the cone, so the front is
        // already crawling while the end of the pattern is still being laid — it
        // just may never catch more than half of it.
        cur.dryIdx = Math.min(cur.dryIdx + (last * dt) / DRY_SWEEP, cur.idx * DRY_LEAD);
        if (cur.idx >= last) {
          cur.act = 1;
          cur.dryAt = t;
          cur.dryFrom = cur.dryIdx;
          cur.hold = cur.auto ? MERCY_DRY : DRY_HOLD;
          cur.peak = Math.max(0.004, masks.paste.coverage());
          cur.shake = 0.8;
          tone(196, { type: "triangle", seconds: 0.9, gain: 0.16 });
        }
      } else if (cur.act === 1) {
        // The held beat. It is not a timer with nothing behind it: the front eases
        // the rest of the way down the pattern and the crazing follows it.
        const p = clamp01((t - cur.dryAt) / cur.hold);
        cur.dryIdx = lerp(cur.dryFrom, last, smooth(p));
        if (p >= 1) {
          cur.act = 2;
          // A hand that traced the pattern itself gets a fresh grace for the rub: the
          // drying beat is a beat with nothing to do in it, and it must not be counted
          // against someone who was only waiting it out.
          if (!cur.auto) cur.alone = 0;
          cur.shake = 0.9; // it sets with a snap, and shakes its own dust loose
          clack({ freq: 820, decay: 0.16, gain: 0.1 });
          for (let i = 0; i < 5; i++) {
            const j = Math.floor(Math.random() * last);
            shed(pathX(wp, write.wFrac, j), pathY(wp, write.wFrac, j), 0, 0.05, 0.012 + Math.random() * 0.014);
          }
        }
      } else if (cur.act === 2) {
        if (merc > 0) {
          // The thumb comes back over the pattern in the order it went on. It rides the
          // path rather than scrubbing at random, which is what makes it read as the
          // same hand finishing the same job.
          if (!cur.autoRub) {
            cur.autoRub = true;
            cur.auto = true;
            // Start it *on* the path, or the first segment would erase a swathe from
            // wherever a pointer happened to be resting.
            cur.u = cur.pu = 0.5 + wp.path[0] * write.wFrac;
            cur.v = cur.pv = 0.5 + wp.path[1] * write.wFrac + V_OFF;
          }
          cur.rubIdx = Math.min(last, cur.rubIdx + (last * dt * merc) / MERCY_RUB);
          const i = Math.floor(cur.rubIdx);
          cur.pu = cur.u;
          cur.pv = cur.v;
          cur.u = 0.5 + wp.path[i * 2] * write.wFrac;
          cur.v = 0.5 + wp.path[i * 2 + 1] * write.wFrac + V_OFF;
          const du = cur.u - cur.pu;
          const dv = cur.v - cur.pv;
          cur.moved += Math.hypot(du, dv);
          rubStep(du, dv, Math.max(0.045, cur.speed * MERCY_BITE));
        }
        // coverage() reads the mask back, so poll it a few times a second, not 60.
        cur.poll += dt;
        if (cur.poll > 0.18) {
          cur.poll = 0;
          if (masks.paste.coverage() < cur.peak * RUB_TARGET) {
            cur.act = 3;
            cur.doneAt = t;
            cur.shake = 1;
            tone(523, { shimmer: true, seconds: 1.4, gain: 0.22 });
            for (let i = 0; i < 16; i++) {
              const j = Math.floor(Math.random() * last);
              shed(pathX(wp, write.wFrac, j), pathY(wp, write.wFrac, j), (Math.random() - 0.5) * 0.5, 0.2, 0.014 + Math.random() * 0.02);
            }
          }
        }
      } else {
        const a = t - cur.doneAt;
        // Whatever is still on lets go over half a second rather than in one frame,
        // so the stain comes up through a thinning veil instead of behind a switch.
        if (a < RELEASE) {
          const k = 1 - Math.exp(-dt / 0.16);
          masks.paste.fade(k);
          masks.dry.fade(k);
        }
        if (!cur.late && a > LATE_FLAKE) {
          cur.late = true;
          shed(pathX(wp, write.wFrac, last >> 1), pathY(wp, write.wFrac, last >> 1) + 0.1, 0, 0, 0.02);
          clack({ freq: 2400, decay: 0.05, gain: 0.05 });
        }
      }
      // The drying mask only ever grows forward, in the order the paste was laid.
      const dryTo = Math.floor(Math.min(cur.dryIdx, last));
      if (dryTo > cur.dryPainted) {
        paintWritePath(masks.dry, wp, write.lineStart, cur.dryPainted, dryTo, DRY_R, write.wFrac, GAP2, V_OFF, "draw");
        cur.dryPainted = dryTo;
      }
    }

    const applying = phase === "opening" && cur.act === 0;
    const rubbing = phase === "opening" && cur.act === 2;
    const still = phase === "sealed" || phase === "preview";
    // How far the whole cone-load has darkened on its own. The two terms are
    // maxed rather than switched: the front is already a third of the way through
    // its work when the pattern closes, and a switch there would re-wet the paste.
    const dry =
      phase === "opening"
        ? Math.max(clamp01(cur.dryIdx / last) * 0.35, cur.act >= 1 ? clamp01((t - cur.dryAt) / cur.hold) : 0)
        : still
          ? 0
          : 1;
    // …against where the front has actually reached, which is what the eye reads.
    const front = phase === "opening" ? clamp01(cur.dryIdx / last) : still ? 0 : 1;
    const bloom =
      phase === "revealed" || phase === "preview"
        ? 1
        : phase === "opening" && cur.act === 3
          ? clamp01((t - cur.doneAt) / BLOOM)
          : 0;

    /* ---- shot: sealed sits back at the table, the reveal is in on the palm ---- */
    if (stageRef.current) {
      const close = still ? 0 : 1;
      const s = stageRef.current;
      s.scale.setScalar(lerp(s.scale.x, lerp(0.92, 1.24, close), k3));
      s.position.y = lerp(s.position.y, lerp(0, -0.2, close), k3);
    }
    if (fitRef.current) {
      // Measured off the camera's *rest* distance, not the live viewport: the push-in
      // shrinks viewport.width, and fitting to that would scale the object back up
      // by exactly as much as the camera came forward — a push-in that never moves.
      const vh = 2 * Math.tan((FOV * Math.PI) / 360) * CAM_Z;
      const vw = vh * (state.size.width / state.size.height);
      fitRef.current.scale.setScalar(Math.max(0.6, Math.min(1, vw / ACTION_W, vh / ACTION_H)));
    }

    /* ---- the camera: back at the table, then in on the palm, then settling ---- */
    if (camRef.current) {
      const c = camRef.current;
      const want =
        phase === "revealed" ? 1 : phase === "opening" ? (cur.act === 0 ? 0.2 : cur.act === 1 ? 0.45 : cur.act === 2 ? 0.7 : 1) : 0;
      cur.push += (want - cur.push) * (snap ? 1 : Math.min(1, dt * 1.7));
      // it arrives with a little weight on it, and rocks that off
      const settle =
        phase === "opening" && cur.act === 3 ? Math.exp(-(t - cur.doneAt) / 0.45) * Math.sin((t - cur.doneAt) * 11) * 0.022 : 0;
      // A held pointer is the gesture during `opening`; leaning the shot on it too
      // would fight the hand. Everywhere else it is the only parallax there is.
      const lean = phase === "opening" ? 0 : 1;
      const bx = state.pointer.x * 0.05 * lean + Math.sin(e * 0.31) * 0.014;
      const by = 0.05 - cur.push * 0.07 + state.pointer.y * 0.03 * lean + Math.sin(e * 0.23 + 1.1) * 0.01;
      const bz = lerp(CAM_Z, CAM_Z_IN, cur.push) + settle;
      if (snap) c.position.set(bx, by, bz);
      else {
        const k = Math.min(1, dt * 2.6);
        c.position.x += (bx - c.position.x) * k;
        c.position.y += (by - c.position.y) * k;
        c.position.z += (bz - c.position.z) * k;
      }
      c.lookAt(0, -0.06 * cur.push, 0);
    }

    /* ---- the hand: never still, and slower once it has something to protect ---- */
    if (handRef.current) {
      const h = handRef.current;
      const rate = still ? 0.9 : phase === "opening" && cur.act === 1 ? 0.5 : 0.68;
      const br = Math.sin(e * rate);
      h.position.y = br * 0.012;
      h.rotation.z = Math.sin(e * 0.43 + 0.7) * 0.013 + cur.shake * Math.sin(e * 34) * 0.022;
      h.rotation.x = Math.sin(e * 0.37 + 2.1) * 0.011 + cur.shake * Math.sin(e * 27 + 1) * 0.012;
      h.scale.setScalar(1 + br * 0.004);
    }
    for (let i = 0; i < 4; i++) {
      const f = fingerRefs.current[i];
      if (!f) continue;
      // Each on its own phase — four fingers moving together read as one board.
      f.rotation.z = FINGERS[i][2] + Math.sin(e * 0.8 + i * 0.9) * 0.024 + cur.shake * Math.sin(e * 30 + i) * 0.02;
    }

    /* ---- paste: wet green while it goes on, dark and cracked behind the front ---- */
    if (pasteMatRef.current) {
      const m = pasteMatRef.current;
      m.color.lerpColors(shadeWet, shadeSet, dry);
      m.roughness = lerp(0.22, 0.9, dry);
    }
    if (glossRef.current && glossMatRef.current) {
      // The wet highlight. It is a hair off the body of the bead, and the lamp
      // walks it around as the flame moves — which is the whole tell for "wet".
      const wet = 1 - front;
      glossRef.current.position.set(-0.006 + Math.sin(e * 1.7) * 0.0016, 0.008 + Math.cos(e * 2.3) * 0.0014, 0.009);
      glossMatRef.current.opacity = wet * (0.34 + 0.08 * Math.sin(e * 4.1)) * flick;
    }
    if (crackMatRef.current) {
      // Progressive twice over: the mask only holds what the front has passed, and
      // what it has passed keeps crazing for a while after.
      crackMatRef.current.opacity = smooth(clamp01((dry - 0.15) / 0.7)) * 0.85;
    }

    /* ---- the stain beneath: it darkens *while* the paste dries, which is the
            reason the pause exists at all, then blooms out as it is uncovered ---- */
    const bl = easeOutBack(bloom);
    if (stainMatRef.current && stainRef.current) {
      const base = phase === "preview" ? 0.88 : lerp(0.1, 0.72, dry) + 0.28 * bloom;
      // settled and content: a slow breath in the colour, nothing that moves
      stainMatRef.current.opacity = base * (phase === "revealed" || phase === "preview" ? 0.97 + 0.03 * Math.sin(e * 0.5) : 1);
      stainRef.current.scale.setScalar(0.985 + 0.015 * bloom);
    }
    if (bleedMatRef.current && bleedRef.current) {
      bleedMatRef.current.opacity = phase === "preview" ? 0.3 : lerp(0.03, 0.26, dry) + 0.12 * bloom;
      // real henna keeps creeping a hair past its own edge for a minute afterward
      bleedRef.current.scale.setScalar(1 + 0.055 * bl);
    }
    if (namesMatRef.current && namesRef.current) {
      const want = phase === "preview" ? 0.85 : smooth(clamp01((bloom - 0.25) / 0.6));
      namesMatRef.current.opacity += (want - namesMatRef.current.opacity) * (snap ? 1 : Math.min(1, dt * 2.6));
      namesRef.current.scale.setScalar(0.94 + 0.06 * (phase === "preview" ? 1 : bl));
    }
    // The ghost only exists to be traced over — brighter under a pointer that is
    // hovering it, so a desktop knows the palm is the thing to touch.
    if (ghostMatRef.current) {
      ghostMatRef.current.opacity = applying ? (0.15 + (cur.hover ? 0.1 : 0)) * (0.85 + 0.15 * Math.sin(e * 2.6)) : 0;
    }

    /* ---- the glint: the invitation before the first touch, and afterwards just
            the lamp finding the pattern ---- */
    if (glintRef.current && glintMatRef.current) {
      const trace = applying && !cur.touched;
      const sheen = phase === "preview" || phase === "revealed";
      cur.glint = (cur.glint + dt * (trace ? 0.4 : 0.12)) % 1;
      const i = Math.min(last, Math.floor(cur.glint * wp.count));
      glintRef.current.position.set(pathX(wp, write.wFrac, i), pathY(wp, write.wFrac, i), 0.018);
      glintRef.current.scale.setScalar(trace ? 0.14 : 0.1);
      // it swells out of nothing at the start of the sweep and dies at the end
      const ends = smooth(clamp01(Math.min(cur.glint, 1 - cur.glint) / 0.12));
      glintMatRef.current.opacity = (trace ? 0.55 : sheen ? 0.16 : 0) * ends * flick;
    }

    /* ---- the cone: in the bowl, then lagging the head of the path, then away ---- */
    if (coneRef.current) {
      const c = coneRef.current;
      let tx = CONE_REST[0];
      let ty: number;
      let tz = CONE_REST[2];
      if (applying) {
        if (cur.touched) {
          const i = Math.min(last, Math.floor(cur.idx));
          tx = pathX(wp, write.wFrac, i);
          ty = pathY(wp, write.wFrac, i) + PAINT_Y;
          tz = PAINT_Z + 0.05;
        } else {
          // before it is picked up it hovers over the head of the pattern and
          // leans toward whoever is about to take it
          tx = pathX(wp, write.wFrac, 0) + state.pointer.x * 0.06;
          ty = pathY(wp, write.wFrac, 0) + PAINT_Y + 0.11 + state.pointer.y * 0.05 + Math.sin(e * 1.6) * 0.014;
          tz = PAINT_Z + 0.14;
        }
      } else if (phase === "opening") {
        ty = CONE_REST[1] + 0.55; // set down out of shot the moment the pattern closes
      } else {
        ty = CONE_REST[1] + Math.sin(e * 1.1) * 0.008; // resting against the bowl
      }
      if (snap) {
        c.position.set(tx, ty, tz);
        cur.cvx = cur.cvy = cur.cvz = 0;
      } else {
        // A spring, not a lerp: a held cone trails the hand, then overruns the
        // stop and comes back — which is most of what makes it read as held.
        cur.cvx += ((tx - c.position.x) * SPRING_K - cur.cvx * SPRING_D) * dt;
        cur.cvy += ((ty - c.position.y) * SPRING_K - cur.cvy * SPRING_D) * dt;
        cur.cvz += ((tz - c.position.z) * SPRING_K - cur.cvz * SPRING_D) * dt;
        c.position.x += cur.cvx * dt;
        c.position.y += cur.cvy * dt;
        c.position.z += cur.cvz * dt;
      }
      // the tip leads, so the body tilts away from wherever it is being dragged
      c.rotation.z = -0.5 - Math.max(-0.55, Math.min(0.55, cur.cvx * 0.32)) + Math.sin(e * 6) * 0.035;
      c.rotation.x = Math.max(-0.4, Math.min(0.4, -cur.cvy * 0.16));
      c.visible = still || applying || (phase === "opening" && t - cur.dryAt < 1.1);
    }
    if (beadRef.current) {
      // the bead at the tip is the width of the line about to come out of it
      beadRef.current.scale.setScalar(lerp(1.6, 0.75, clamp01(cur.speed / FAT_V)));
    }

    /* ---- the thumb: it goes where the rubbing is, and springs back after ---- */
    if (thumbRef.current) {
      const th = thumbRef.current;
      // `autoRub` counts as a hand on the palm: on the mercy path the thumb is the
      // thing doing the rubbing, so it has to come down for it.
      const on = rubbing && (cur.down || cur.autoRub);
      const tx = on ? (cur.u - 0.5) * HAND_W : THUMB_REST[0];
      const ty = on ? (cur.v - 0.5) * HAND_H + PAINT_Y : THUMB_REST[1];
      const tz = on ? PAINT_Z + 0.03 : THUMB_REST[2];
      if (snap) {
        th.position.set(tx, ty, tz);
        cur.tvx = cur.tvy = cur.tvz = 0;
      } else {
        cur.tvx += ((tx - th.position.x) * SPRING_K - cur.tvx * SPRING_D) * dt;
        cur.tvy += ((ty - th.position.y) * SPRING_K - cur.tvy * SPRING_D) * dt;
        cur.tvz += ((tz - th.position.z) * SPRING_K - cur.tvz * SPRING_D) * dt;
        th.position.x += cur.tvx * dt;
        th.position.y += cur.tvy * dt;
        th.position.z += cur.tvz * dt;
      }
      th.rotation.z = THUMB_ROT - (on ? 0.55 : 0) - Math.max(-0.5, Math.min(0.5, cur.tvx * 0.12));
      // it presses in as it works, and a hard rub presses harder
      th.scale.setScalar(on ? 1 - 0.06 * clamp01(cur.speed / 1.2) : 1);
    }

    /* ---- the smudge the thumb drags off its own trailing edge ---- */
    if (smudgeRef.current && smudgeMatRef.current) {
      const on = rubbing && (cur.down || cur.autoRub);
      const sm = smudgeRef.current;
      const k = Math.min(1, dt * 9);
      sm.position.x += ((cur.u - 0.5) * HAND_W - sm.position.x) * k;
      sm.position.y += ((cur.v - 0.5) * HAND_H - sm.position.y) * k;
      const heat = on ? clamp01(cur.speed / 0.9) : 0;
      const o = smudgeMatRef.current;
      o.opacity += ((on ? 0.1 + 0.3 * heat : 0) - o.opacity) * Math.min(1, dt * 6);
      sm.scale.setScalar(0.22 + 0.2 * heat);
    }

    /* ---- flakes: they tumble, land, bounce once and lie down ---- */
    const inst = flakeRef.current;
    if (inst) {
      const f = flakes.current;
      // A last flake drops long after everything else has stopped — the revealed
      // frame is settled, not embalmed.
      if (phase === "revealed" && e % 7 < dt) {
        shed((Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 0.3, 0, 0, 0.018);
      }
      for (let i = 0; i < FLAKES; i++) {
        const a = f.age[i];
        if (a < 0) {
          dummy.scale.setScalar(0);
          dummy.position.set(0, -9, 0);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
          continue;
        }
        const na = a + dt;
        const fade = 1 - clamp01((na - f.ttl[i]) / FLAKE_FADE);
        if (fade <= 0) {
          f.age[i] = -1;
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
          continue;
        }
        f.age[i] = na;
        f.vy[i] -= 2.4 * dt;
        f.vx[i] -= f.vx[i] * dt * 1.4; // paper-thin: the air takes the sideways speed first
        f.x[i] += f.vx[i] * dt;
        f.y[i] += f.vy[i] * dt;
        f.z[i] += f.vz[i] * dt;
        f.spin[i] += f.spinV[i] * dt;
        f.tip[i] += f.tipV[i] * dt;
        f.spinV[i] -= f.spinV[i] * dt * 0.9;
        f.tipV[i] -= f.tipV[i] * dt * 0.9;
        if (f.y[i] < FLAKE_FLOOR) {
          f.y[i] = FLAKE_FLOOR;
          f.vy[i] = -f.vy[i] * 0.28;
          f.vx[i] *= 0.45;
          f.vz[i] *= 0.45;
          f.spinV[i] *= 0.4;
          if (Math.abs(f.vy[i]) < 0.14) {
            f.vy[i] = 0;
            f.tipV[i] = 0;
            f.tip[i] += (0 - f.tip[i]) * Math.min(1, dt * 6); // and it lies flat
          }
        }
        dummy.position.set(f.x[i], f.y[i], f.z[i]);
        dummy.rotation.set(f.tip[i], 0, f.spin[i]);
        dummy.scale.setScalar(f.size[i] * fade);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
    }

    /* ---- dust in the lamplight, and a good deal more of it while it dries ---- */
    cur.moteT += dt * (phase === "opening" && cur.act === 1 ? 2.2 : 1);
    const mp = moteRef.current;
    if (mp) {
      const pa = mp.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < MOTES; i++) {
        // z was seeded once and never moves, so only two of the three are written.
        pa.setX(i, motes.base[i * 3] + Math.sin(cur.moteT * 0.6 + motes.base[i * 3 + 2]) * 0.1);
        pa.setY(i, ((motes.base[i * 3 + 1] + cur.moteT * motes.spd[i]) % MOTE_SPAN) - 1.15);
      }
      pa.needsUpdate = true;
    }
    if (moteMatRef.current) {
      moteMatRef.current.opacity = (phase === "opening" && cur.act === 1 ? 0.5 : 0.26) * flick;
    }

    /* ---- lamps and silk ---- */
    if (lampRef.current) lampRef.current.intensity = (0.8 + 0.55 * bloom) * flick;
    if (keyRef.current) keyRef.current.intensity = 1.5 * (0.96 + 0.04 * flick) + 0.25 * bloom;
    if (silkMatRef.current) silkMatRef.current.color.setScalar(0.86 + 0.12 * flick);
    if (sheenRef.current && sheenMatRef.current) {
      // the silk catching it: one soft highlight walking the cloth
      sheenRef.current.position.x = Math.sin(e * 0.19) * 1.5;
      sheenRef.current.position.y = -0.1 + Math.cos(e * 0.13) * 0.3;
      sheenMatRef.current.opacity = (0.14 + 0.05 * bloom) * flick;
    }

    if (hintMatRef.current) {
      // One nudge, and only where the next gesture has to happen — and not once the
      // scene has given up waiting and started making that gesture itself.
      const want = rubbing && !cur.autoRub ? 0.2 + 0.14 * Math.sin(e * 3) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && cur.act === 3 && t - cur.doneAt > REVEAL_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  // Revealed and sealed have to look right with no gesture ever made, so the masks
  // get their finished state up front and `opening` resets them.
  useEffect(() => {
    if (phase === "opening") return;
    masks.paste.reset();
    masks.dry.reset();
    masks.stain.reset();
    if (phase === "sealed") return;
    // preview + revealed: the stain is already set, and no paste is left.
    paintWritePath(masks.stain, write.w, write.lineStart, -1, write.w.count - 1, STAIN_R_SLOW, write.wFrac, GAP2, V_OFF, "draw");
  }, [phase, masks, write]);

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, 0.05, CAM_Z]} fov={FOV} />
      <ambientLight intensity={0.5} color="#ffd9b0" />
      {/* warm lamps, low and to both sides — a henna night is lit from the table */}
      <directionalLight ref={keyRef} position={[1.6, 1.4, 2.4]} intensity={1.5} color="#ffcf94" />
      <pointLight ref={lampRef} position={[-1.8, 0.4, 1.4]} intensity={0.8} color="#ff9c5c" distance={6} decay={1.4} />

      {/* silk */}
      <mesh position={[0, -0.15, -1.2]} rotation={[-0.35, 0, 0]}>
        <planeGeometry args={[9, 7]} />
        <meshBasicMaterial ref={silkMatRef} map={SILK} depthWrite={false} />
      </mesh>
      <mesh ref={sheenRef} position={[0, -0.1, -1.15]} rotation={[-0.35, 0, 0]}>
        <planeGeometry args={[4.5, 3.2]} />
        <meshBasicMaterial
          ref={sheenMatRef}
          map={HINT_SPRITE}
          color="#ffc386"
          transparent
          opacity={0.14}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <group ref={fitRef}>
        <group ref={stageRef}>
          {/* the dust the lamps pick out over the table */}
          <points ref={moteRef} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[motes.pos, 3]} />
            </bufferGeometry>
            <pointsMaterial
              ref={moteMatRef}
              map={HINT_SPRITE}
              color="#ffc48a"
              size={0.05}
              sizeAttenuation
              transparent
              opacity={0.26}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </points>

          {/* bowl of paste, the cone resting against it until it is wanted */}
          <group position={[-0.95, -0.5, 0.1]}>
            <mesh rotation={[Math.PI, 0, 0]}>
              <sphereGeometry args={[0.19, 20, 12, 0, TAU, 0, Math.PI / 2]} />
              <meshStandardMaterial color="#3c2b20" roughness={0.55} side={THREE.DoubleSide} />
            </mesh>
            <mesh position={[0, -0.02, 0]}>
              <sphereGeometry args={[0.155, 18, 10, 0, TAU, 0, Math.PI / 2]} />
              <meshStandardMaterial color={WET} roughness={0.3} />
            </mesh>
          </group>

          {/* the hand */}
          <group ref={handRef}>
            <mesh geometry={wristGeo} material={wristMat} position={[0, -0.92, 0]} scale={[1, 1, 0.42]} />
            <mesh geometry={palmGeo} material={skinMat} position={[0, -0.1, 0]} />
            {FINGERS.map(([x, y, rot, len], i) => (
              <mesh
                key={i}
                ref={(m) => {
                  fingerRefs.current[i] = m;
                }}
                geometry={fingerGeo}
                material={skinMat}
                position={[x, y, 0]}
                rotation={[0, 0, rot]}
                scale={[1, len, 0.55]}
              />
            ))}
            <group ref={thumbRef} position={THUMB_REST} rotation={[0, 0, THUMB_ROT]}>
              <mesh geometry={thumbGeo} material={skinMat} scale={[1, 1, 0.6]} />
            </group>

            {/* Everything painted lives on flat quads over the palm — the mask's uv IS
                the quad's, so a raycast hands the brush its coordinates directly. */}
            <group position={[0, PAINT_Y, PAINT_Z]}>
              {/* faded prior henna: always there, in every phase */}
              <mesh>
                <planeGeometry args={[HAND_W * 1.5, HAND_H * 1.5]} />
                <meshBasicMaterial map={motif} color={stainPal.stain} transparent opacity={0.14} depthWrite={false} toneMapped={false} />
              </mesh>
              {/* the bleed halo, then the stain itself */}
              <mesh ref={bleedRef} position={[0, 0, 0.002]}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial
                  ref={bleedMatRef}
                  color={stainPal.bleed}
                  alphaMap={masks.stain.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
              <mesh ref={stainRef} position={[0, 0, 0.004]} scale={0.985}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial
                  ref={stainMatRef}
                  color={stainPal.stain}
                  alphaMap={masks.stain.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
              {/* the ghost pattern, there to be traced and nothing else */}
              <mesh position={[0, 0, 0.006]}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial
                  ref={ghostMatRef}
                  color={stainPal.glow}
                  alphaMap={masks.ghost.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
              {/* paste: a highlight offset a hair off a body, which is as close to a
                  raised wet bead as a flat quad gets, and closer than it has any
                  right to be. The drying front covers it as it goes past. */}
              <mesh ref={glossRef} position={[-0.006, 0.008, 0.009]}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial
                  ref={glossMatRef}
                  color="#e8f0b4"
                  alphaMap={masks.paste.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
              <mesh position={[0, 0, 0.011]}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshStandardMaterial
                  ref={pasteMatRef}
                  color={WET}
                  alphaMap={masks.paste.texture}
                  roughness={0.22}
                  transparent
                  opacity={1}
                  depthWrite={false}
                />
              </mesh>
              {/* what the front has already passed over */}
              <mesh position={[0, 0, 0.013]}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial
                  color={DRY_COLOR}
                  alphaMap={masks.dry.texture}
                  transparent
                  opacity={0.94}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
              <mesh position={[0, 0, 0.015]}>
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial
                  ref={crackMatRef}
                  map={CRACKS}
                  alphaMap={masks.dry.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
              {/* the dust the thumb pushes ahead of itself */}
              <mesh ref={smudgeRef} position={[0, 0, 0.016]}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                  ref={smudgeMatRef}
                  map={HINT_SPRITE}
                  color={DRY_COLOR}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
              {/* both names, small, up where the fingers start */}
              <mesh ref={namesRef} position={[0, HAND_H * 0.4, 0.017]}>
                <planeGeometry args={names.size} />
                <meshBasicMaterial ref={namesMatRef} map={names.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
              </mesh>
              {/* the lamp finding the pattern — and, before the first touch, the
                  invitation: it runs the path in the order it wants tracing */}
              <mesh ref={glintRef} position={[0, 0, 0.018]}>
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial
                  ref={glintMatRef}
                  map={HINT_SPRITE}
                  color={stainPal.glow}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>
              <mesh position={[0, 0, 0.02]}>
                <planeGeometry args={[HAND_W * 0.9, HAND_W * 0.9]} />
                <meshBasicMaterial
                  ref={hintMatRef}
                  map={HINT_SPRITE}
                  color={stainPal.glow}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                />
              </mesh>

              {/* flakes of dried paste on their way to the silk */}
              <instancedMesh ref={flakeRef} args={[flakeGeo, flakeMat, FLAKES]} frustumCulled={false} />

              {/* The palm is the hit target, and it is exactly the painted rectangle so
                  the mask's uv and the raycast's are the same number. r185 raycasts
                  straight through visible={false}, so it is transparent instead. */}
              {phase === "opening" && (
                <mesh
                  position={[0, 0, 0.03]}
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={stop}
                  onPointerCancel={stop}
                  onPointerOver={onEnter}
                  onPointerOut={onLeave}
                >
                  <planeGeometry args={[HAND_W, HAND_H]} />
                  <meshBasicMaterial transparent opacity={0} depthWrite={false} />
                </mesh>
              )}
            </group>
          </group>

          {/* the cone, in the bowl until it is picked up */}
          <group ref={coneRef} position={CONE_REST}>
            <mesh rotation={[0, 0, Math.PI]} position={[0.07, 0.11, 0]}>
              <coneGeometry args={[0.055, 0.3, 14]} />
              <meshStandardMaterial color="#4a3a28" roughness={0.6} />
            </mesh>
            <mesh ref={beadRef}>
              <sphereGeometry args={[0.017, 10, 8]} />
              <meshStandardMaterial color={WET} roughness={0.25} />
            </mesh>
          </group>
        </group>
      </group>
    </>
  );
}
