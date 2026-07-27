import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeTextTexture } from "../text3d";
import { makeRadialSprite } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- metals ---------- */
// `tarnish` is where the metal sits while it is still half a coin, `body` is what
// it becomes once healed — the polish arriving with the seam is most of the reveal.
interface Metal {
  body: string;
  tarnish: string;
  seam: string;
  engrave: string;
  rough: number;
}
const METALS: Record<string, Metal> = {
  gold: { body: "#d8b036", tarnish: "#6d5a22", seam: "#ffdf87", engrave: "#4a3608", rough: 0.24 },
  silver: { body: "#c4c9d6", tarnish: "#5d626c", seam: "#eaf2ff", engrave: "#2c313a", rough: 0.2 },
  copper: { body: "#c07543", tarnish: "#5c3a24", seam: "#ffc08a", engrave: "#3d1f10", rough: 0.34 },
};

/* ---------- engraving styles ---------- */
// Each style is a font *and* a border motif: the words alone read the same in any
// of the three, and a coin is mostly its border.
const STYLES: Record<string, { family: string; weight: string; motif: "block" | "pearl" | "leaf" }> = {
  kufic: { family: "'Times New Roman', Georgia, serif", weight: "700", motif: "block" },
  diwani: { family: "'Snell Roundhand', 'Segoe Script', 'Bradley Hand', cursive", weight: "500", motif: "pearl" },
  laurel: { family: "Georgia, 'Times New Roman', serif", weight: "500", motif: "leaf" },
};

/* ---------- geometry ---------- */
const R = 1.15; // coin radius
const THICK = 0.11;
const TAU = Math.PI * 2;

/** One sawn half of a coin: a half-disc extruded, bevelled all round — including
 *  along the cut, so the two halves meet in a groove the gold can run down. */
function buildHalf(side: -1 | 1): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  // side -1 keeps x<0: the arc from +90° round to +270°. side 1 is its mirror.
  const a0 = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  shape.moveTo(0, side === -1 ? R : -R);
  shape.absarc(0, 0, R, a0, a0 + Math.PI, false);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: THICK,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.022,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 44,
  });
  geo.translate(0, 0, -THICK / 2);
  return geo;
}
const LEFT_GEO = buildHalf(-1);
const RIGHT_GEO = buildHalf(1);
const FACE_Z = THICK / 2 + 0.024; // clear of the bevel

/** A unit plane whose UVs cover only one half of its texture — so both halves of
 *  the coin can share ONE raster of the inscription and each show its own side of
 *  the cut. The split lands mid-glyph, which is the entire point. */
function halfUvPlane(side: 0 | 1): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + side * 0.5);
  return g;
}
const LEFT_UV = halfUvPlane(0);
const RIGHT_UV = halfUvPlane(1);

/* ---------- border motif (no text — so no bidi to get wrong) ---------- */
function buildMotif(motif: "block" | "pearl" | "leaf"): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const cx = s / 2;
  const rr = s * 0.455;
  g.strokeStyle = "#fff";
  g.fillStyle = "#fff";
  g.lineWidth = s * 0.007;
  g.beginPath();
  g.arc(cx, cx, rr, 0, TAU);
  g.stroke();
  g.lineWidth = s * 0.0035;
  g.beginPath();
  g.arc(cx, cx, rr * 0.9, 0, TAU);
  g.stroke();
  const n = motif === "block" ? 32 : motif === "pearl" ? 52 : 26;
  const ring = rr * 0.955;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const x = cx + Math.cos(a) * ring;
    const y = cx + Math.sin(a) * ring;
    if (motif === "block") {
      const w = s * 0.019;
      g.fillRect(x - w / 2, y - w / 2, w, w);
    } else if (motif === "pearl") {
      g.beginPath();
      g.arc(x, y, s * 0.0085, 0, TAU);
      g.fill();
    } else {
      g.beginPath();
      g.ellipse(x, y, s * 0.026, s * 0.009, a + Math.PI / 2, 0, TAU);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- velvet + the one hard spotlight, painted (no shadow maps here) ---------- */
function buildVelvet(): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0a0509";
  g.fillRect(0, 0, s, s);
  const pool = g.createRadialGradient(s * 0.5, s * 0.44, 0, s * 0.5, s * 0.44, s * 0.42);
  pool.addColorStop(0, "#3b1b26");
  pool.addColorStop(0.55, "#1d0d15");
  pool.addColorStop(1, "#080407");
  g.fillStyle = pool;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
const VELVET = buildVelvet();
const GLOW = makeRadialSprite();
const SPARK_TEX = makeRadialSprite(32, [
  [0, "rgba(255,255,255,1)"],
  [0.3, "rgba(255,235,175,0.85)"],
  [1, "rgba(255,150,40,0)"],
]);

/** The polish front: transparent behind it, a bright lip at the leading edge, and
 *  a vertical bell so a rectangle sweeping a round coin never shows a corner. */
function buildWipe(): THREE.CanvasTexture {
  const W = 128;
  const H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const h = g.createLinearGradient(0, 0, W, 0);
  h.addColorStop(0, "rgba(255,255,255,0)");
  h.addColorStop(0.5, "rgba(255,255,255,0.22)");
  h.addColorStop(0.86, "rgba(255,255,255,1)");
  h.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = h;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = "destination-in";
  const v = g.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(255,255,255,0)");
  v.addColorStop(0.5, "rgba(255,255,255,1)");
  v.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  return new THREE.CanvasTexture(c);
}
const WIPE = buildWipe();

/* ---------- the gold that runs, and what it leaves behind ---------- */
// Beads that leave the running head, slide a little way down the cut and freeze
// where they cool. Everything is a function of `heal`, so the frozen end state is
// what a single static frame at heal = 1 draws.
const DRIP_N = 7;
const DRIPS = (() => {
  const rand = mulberry32(4409);
  const out: { at: number; x: number; run: number; len: number; w: number; dur: number }[] = [];
  for (let i = 0; i < DRIP_N; i++) {
    out.push({
      at: 0.09 + (i / DRIP_N) * 0.78 + rand() * 0.04,
      x: (rand() - 0.5) * 0.03,
      run: 0.07 + rand() * 0.18,
      len: 0.05 + rand() * 0.05,
      w: 0.024 + rand() * 0.018,
      dur: 0.1 + rand() * 0.15,
    });
  }
  return out;
})();
const DRIP_GEO = new THREE.PlaneGeometry(1, 1);
const RING_GEO = new THREE.RingGeometry(0.84, 1, 56);

/* ---------- dust in the spotlight, alive in every phase ---------- */
const MOTE_N = 46;
const MOTE_SPAN = 3.6;
const MOTES = (() => {
  const rand = mulberry32(1789);
  const out: { x: number; y: number; z: number; sp: number; w: number; ph: number; k: number }[] = [];
  for (let i = 0; i < MOTE_N; i++) {
    out.push({
      x: (rand() - 0.5) * 4.6,
      y: rand() * MOTE_SPAN,
      z: -1.9 + rand() * 2.4,
      sp: 0.04 + rand() * 0.08,
      w: 0.35 + rand() * 0.9,
      ph: rand() * TAU,
      k: 0.25 + rand() * 0.75,
    });
  }
  return out;
})();

const SPARK_N = 64;
const SPARK_LIFE = 0.9;

const dummy = new THREE.Object3D();
const dcol = new THREE.Color();

/* ---------- opening timeline, measured from the kiss ---------- */
const HEAL_LAG = 0.09; // the gold gathers before it runs
const HEAL_END = 0.95;
const WIPE_START = 0.24;
const WIPE_END = 1.5;
const RISE_START = 0.6;
const RISE_END = 2.5;
const POST_END = 3.0;

const MAGNET = 0.46; // past here the halves finish the job themselves
const TRAVEL = 1.5; // world units of drag that close the gap
const GAP_NEAR = 0.62; // your half's rest offset while sealed
const RESIST = 0.55; // how much the last stretch before the magnet fights back
const SPRING_BACK = 0.22; // …and how slowly it gives the ground up again
const FLICK_DECAY = 0.3;
// A gift may never lock waiting for a gesture — and this one is also the gallery
// card's whole loop, which has no hands at all. Left to itself for this long the
// pair starts finding its own way in, and reaches the magnet by MERCY1.
const MERCY0 = 2.4;
const MERCY1 = 5.4;
const ACTION_W = 3.1;
const ACTION_H = 2.9;
const CAM_Z = 4.5;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function TwoHalvesScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const metal = METALS[variants.metal] ?? METALS.gold;
  const style = STYLES[variants.engraving] ?? STYLES.kufic;

  const motif = useMemo(() => buildMotif(style.motif), [style]);
  useEffect(() => () => motif.dispose(), [motif]);

  // The tarnish→polish lerp runs every frame; its two endpoints must not be
  // allocated there.
  const shades = useMemo(
    () => ({ dull: new THREE.Color(metal.tarnish), bright: new THREE.Color(metal.body) }),
    [metal],
  );

  /* One raster per text block, split across the two halves by UV. */
  const text = useMemo(() => {
    const body = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    const face = makeTextTexture(body, {
      fontFamily: style.family,
      fontWeight: style.weight,
      fontSize: 74,
      color: metal.engrave,
      maxWidthPx: 74 * 8,
      lineHeight: 1.32,
      padding: 26,
      lang,
    });
    // No date, no year — just the pair. One fillText node, so shaping and bidi
    // are the canvas's problem and it gets them right.
    const rim = makeTextTexture(`${senderName || "—"}   ·   ${recipientName || "—"}`, {
      fontFamily: style.family,
      fontWeight: "600",
      fontSize: 46,
      color: metal.engrave,
      maxWidthPx: 46 * 12,
      padding: 18,
      lang,
    });
    return {
      face,
      rim,
      faceSize: fitPlane(face.aspect, R * 1.42, R * 0.78),
      rimSize: fitPlane(rim.aspect, R * 1.06, R * 0.15),
    };
  }, [message, senderName, recipientName, lang, style, metal]);
  useEffect(
    () => () => {
      text.face.texture.dispose();
      text.rim.texture.dispose();
    },
    [text],
  );

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  // close 0..1 is the gap; kissAt latches the moment it shut, so everything after
  // the meeting is timed off the meeting and not off the phase.
  const gest = useRef({
    close: 0,
    kissAt: -1,
    magnetAt: -1,
    sang: false,
    down: false,
    px: 0,
    moved: 0,
    vel: 0,
    alone: 0,
    touched: false,
    hover: false,
    hoverK: 0,
  });
  // One material per half, reached by ref: the tarnish lifts every frame, and a
  // useMemo'd material may not be mutated after render (react-hooks/immutability).
  const metalMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const floatRef = useRef<THREE.Group>(null);
  const spinRef = useRef<THREE.Group>(null);
  const leftRef = useRef<THREE.Group>(null);
  const rightRef = useRef<THREE.Group>(null);
  const seamRef = useRef<THREE.Mesh>(null);
  const seamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const headRef = useRef<THREE.Mesh>(null);
  const headMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const dripRef = useRef<THREE.InstancedMesh>(null);
  const seamLightRef = useRef<THREE.PointLight>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const sparkRef = useRef<THREE.Points>(null);
  const moteRef = useRef<THREE.Points>(null);
  const poolRef = useRef<THREE.Mesh>(null);
  const poolMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const faceMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const wipeRefs = useRef<(THREE.Mesh | null)[]>([]);
  const wipeMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const glintRefs = useRef<(THREE.Mesh | null)[]>([]);
  const glintMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const hintRef = useRef<THREE.Mesh>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const sparkBuf = useMemo(
    () => ({ pos: new Float32Array(SPARK_N * 3), col: new Float32Array(SPARK_N * 3) }),
    [],
  );
  const moteBuf = useMemo(
    () => ({ pos: new Float32Array(MOTE_N * 3), col: new Float32Array(MOTE_N * 3) }),
    [],
  );
  const sparks = useRef({
    t0: new Float32Array(SPARK_N).fill(-99),
    o: new Float32Array(SPARK_N * 3),
    v: new Float32Array(SPARK_N * 3),
    heat: new Float32Array(SPARK_N),
  });

  // A replay has to clear every accumulator, or run two would open before anyone
  // touched it and the old burst would still be in the air.
  useEffect(() => {
    if (phase !== "opening") return;
    const g = gest.current;
    g.close = g.px = g.moved = g.vel = g.alone = g.hoverK = 0;
    g.kissAt = g.magnetAt = -1;
    g.sang = g.down = g.touched = g.hover = false;
    sparks.current.t0.fill(-99);
  }, [phase]);

  /** Struck metal, thrown off the whole length of the cut at once. */
  const burst = (e: number) => {
    const sk = sparks.current;
    for (let i = 0; i < SPARK_N; i++) {
      const a = Math.random() * TAU;
      const sp = 0.7 + Math.random() * 2.1;
      sk.t0[i] = e;
      sk.o[i * 3] = 0;
      sk.o[i * 3 + 1] = (Math.random() * 2 - 1) * R * 0.92;
      sk.o[i * 3 + 2] = FACE_Z;
      sk.v[i * 3] = Math.cos(a) * sp;
      sk.v[i * 3 + 1] = Math.sin(a) * sp * 0.55 + 0.45;
      sk.v[i * 3 + 2] = (Math.random() - 0.5) * sp * 0.7 + 0.4;
      sk.heat[i] = 0.4 + Math.random() * 0.6;
    }
  };

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || gest.current.kissAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — onPointerOut below covers its absence */
    }
    const g = gest.current;
    g.down = true;
    g.touched = true;
    g.px = ev.point.x;
    g.vel = 0;
    g.alone = 0;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const g = gest.current;
    if (!g.down || phase !== "opening" || g.close >= 1) return;
    ev.stopPropagation();
    // Toward the centre closes it. Physical, not textual — identical in both langs.
    const raw = (g.px - ev.point.x) / TRAVEL;
    // A coin that snaps home the instant you touch it never felt like it was
    // resisting: the last stretch before the magnet takes over eats more than
    // half of what you give it, and only in the closing direction.
    const d = raw > 0 ? raw * (1 - RESIST * Math.exp(-Math.pow((g.close - MAGNET) / 0.13, 2))) : raw;
    g.close = clamp01(g.close + d);
    g.moved += d;
    g.px = ev.point.x;
    // a hand that is working it owns the pace; a hand that has gone still does not
    g.alone = 0;
  };
  const stop = () => {
    gest.current.down = false;
  };
  const hoverOn = () => {
    gest.current.hover = true;
  };
  const hoverOff = () => {
    gest.current.hover = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const g = gest.current;

    const fit = Math.max(
      0.62,
      Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H),
    );
    fitRef.current?.scale.setScalar(fit);

    // Velocity is read off the frame clock, never off event timestamps: pointer
    // moves coalesce and can share one, and dividing by that zero hands a lazy
    // drag an infinite flick.
    const movedF = g.moved;
    g.moved = 0;
    if (g.down) g.vel = lerp(g.vel, movedF / dt, 0.5);

    /* ---- how closed the pair is, per phase ---- */
    let close: number;
    if (phase === "opening") {
      if (!g.down) {
        // a quick swipe carries after the finger has gone…
        g.close = clamp01(g.close + g.vel * dt);
        g.vel *= Math.exp(-dt / FLICK_DECAY);
        // …and short of the magnet the halves ease back apart again, so the
        // catch is something you have to reach rather than fall into.
        if (g.close < MAGNET && Math.abs(g.vel) < 0.06) {
          g.close = Math.max(0, g.close - dt * SPRING_BACK);
        }
      }
      // Left alone, they close the distance themselves — a floor under `close` that
      // only ever rises, so the spring-back above cannot argue with it. It is eased,
      // so it reads as the two being drawn together and not as a timer giving up.
      g.alone += dt;
      g.close = Math.max(
        g.close,
        smooth(clamp01((g.alone - MERCY0) / (MERCY1 - MERCY0))) * (MAGNET + 0.02),
      );
      // Past the magnet point they pull each other shut, and harder the closer they get.
      if (g.close > MAGNET && g.close < 1) g.close = Math.min(1, g.close + dt * (0.55 + 2.6 * g.close));
      if (g.close > MAGNET && g.magnetAt < 0) {
        g.magnetAt = tRef.current;
        clack({ freq: 620, decay: 0.09, gain: 0.16 });
      }
      if (g.close >= 1 && g.kissAt < 0) {
        g.kissAt = tRef.current;
        tone(1046, { shimmer: true, seconds: 1.3, gain: 0.3 });
        clack({ freq: 2600, decay: 0.05, gain: 0.18 });
        burst(e);
      }
      close = g.close;
    } else if (phase === "sealed") {
      close = 0;
    } else if (phase === "preview") {
      // Near-miss breathing: both halves in frame, the inscription split and unreadable.
      close = 0.78 + Math.sin(e * 0.8) * 0.06;
    } else {
      close = 1;
    }

    const post = phase === "revealed" ? POST_END : g.kissAt >= 0 ? tRef.current - g.kissAt : -1;
    const heal =
      phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01((post - HEAL_LAG) / (HEAL_END - HEAL_LAG)));
    const wipe =
      phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01((post - WIPE_START) / (WIPE_END - WIPE_START)));
    // A short-lived bloom on everything the meeting touched — the light change
    // that sells the kiss. Long dead by POST_END, so a cold `revealed` is clean.
    const flash = post < 0 ? 0 : Math.exp(-post * 4.5);
    if (phase === "opening" && heal >= 1 && !g.sang) {
      g.sang = true;
      tone(1568, { shimmer: true, seconds: 1.1, gain: 0.13 });
    }

    /* ---- the halves ---- */
    const gap = 1 - close;
    const tilt = gap * 0.42; // the sawn edge turned toward camera while apart
    // The magnet is not a switch: the closer it gets the harder the two buzz
    // against each other, and the kiss is what stops the buzzing.
    const mag = clamp01((close - MAGNET) / (1 - MAGNET));
    const buzz = post < 0 ? mag : 0;
    const shiver = buzz * 0.013 * (Math.sin(e * 57) + 0.6 * Math.sin(e * 89 + 1.3));
    // and the meeting itself rings: they bounce off each other once and settle
    const kick = post < 0 ? 0 : Math.exp(-post * 9) * Math.sin(post * 44) * 0.022;

    const wantHover = g.hover && (phase === "sealed" || phase === "opening") && g.kissAt < 0 ? 1 : 0;
    g.hoverK += (wantHover - g.hoverK) * Math.min(1, dt * 7);
    // Before the first touch your half leans toward the pointer. It stops the
    // instant a finger lands, because by then the invitation has been taken.
    const leanK = phase === "opening" ? (g.touched ? 0 : 1) : phase === "sealed" ? 0.6 : 0;
    const restless = phase === "sealed" ? 1 : 0;

    if (rightRef.current) {
      const r = rightRef.current;
      r.position.x = GAP_NEAR * gap + shiver + kick;
      r.position.y = shiver * 0.4 + restless * Math.sin(e * 0.95) * 0.014;
      r.position.z = g.hoverK * 0.03;
      r.rotation.y = tilt + g.hoverK * 0.1 + state.pointer.x * 0.07 * leanK;
      // a fast drag skids it: the faster it comes in, the more it trails
      r.rotation.z =
        Math.max(-0.5, Math.min(0.5, g.vel)) * -0.09 + restless * Math.sin(e * 0.62) * 0.035;
    }
    if (leftRef.current) {
      // Theirs comes in from off-frame, and accelerates: gap eased, not linear.
      // "Off-frame" is measured against the live viewport, not a constant — on a
      // wide desktop canvas a fixed 4.6 units is still very much on screen, and the
      // whole sealed state is that you cannot see their half.
      const off = state.viewport.width / 2 / Math.max(0.2, fit) + R * 1.4;
      const l = leftRef.current;
      l.position.x = -off * easeOutCubic(gap) - shiver - kick;
      l.position.y = -shiver * 0.4;
      l.rotation.y = -tilt;
      l.rotation.z = -shiver * 0.9;
    }

    /* ---- the seam heals as a head of gold running down the cut ---- */
    const headY = R * (1 - 2 * heal);
    if (seamRef.current && seamMatRef.current) {
      seamRef.current.visible = heal > 0.002;
      seamRef.current.scale.y = heal;
      seamRef.current.position.y = R * (1 - heal);
      // Bright while it is running, then just a line of gold sitting in the cut —
      // it heals the coin, it does not become a lamp in the middle of the message.
      seamMatRef.current.opacity = heal < 1 ? 0.9 : 0.3 + 0.1 * Math.sin(e * 1.6);
    }
    if (headRef.current && headMatRef.current) {
      // The tip: hot, a little wider than the trail it lays, and gone once it
      // reaches the bottom of the cut.
      const on = heal > 0.001 && heal < 0.999;
      headRef.current.visible = on;
      headRef.current.position.y = headY;
      const pulse = 1 + 0.22 * Math.sin(e * 26);
      headRef.current.scale.set(0.12 * pulse, 0.16 * pulse, 1);
      headMatRef.current.opacity = on ? 0.95 : 0;
    }
    const drips = dripRef.current;
    if (drips) {
      for (let i = 0; i < DRIP_N; i++) {
        const d = DRIPS[i];
        const k = clamp01((heal - d.at) / d.dur);
        const slide = easeOutCubic(k) * d.run;
        dummy.position.set(d.x, R * (1 - 2 * d.at) - slide - d.len * 0.5, 0.002);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(d.w, d.len + slide * 0.55, 1);
        dummy.updateMatrix();
        drips.setMatrixAt(i, dummy.matrix);
        // hot while it runs, and it keeps a little of the shine once it stops
        const lit = heal > d.at ? 0.4 + 0.6 * (1 - k) : 0;
        dcol.setScalar(lit);
        drips.setColorAt(i, dcol);
      }
      drips.instanceMatrix.needsUpdate = true;
      if (drips.instanceColor) drips.instanceColor.needsUpdate = true;
    }

    /* ---- rise, tumble, and the polish travelling out from the seam ---- */
    const riseK = post < 0 ? 0 : clamp01((post - RISE_START) / (RISE_END - RISE_START));
    const riseY = easeOutBack(riseK); // arrives past its mark and comes back down
    const turn = TAU * smooth(riseK);
    // it gathers itself a beat before it lifts
    const dip = post < 0 ? 0 : Math.max(0, 1 - Math.abs(post - (RISE_START - 0.1)) / 0.14);
    if (floatRef.current) {
      const idle = phase === "preview" || phase === "revealed" ? Math.sin(e * 0.85) * 0.045 : 0;
      floatRef.current.position.y = riseY * 0.34 - dip * 0.03 + idle;
    }
    let spinY = 0;
    if (spinRef.current) {
      const s = spinRef.current;
      // the one turn is a tumble: it wobbles off the axis and the wobble damps out
      const tw = Math.max(0, post - RISE_START);
      const damp = post < 0 ? 0 : Math.exp(-tw * 1.5);
      spinY =
        phase === "preview"
          ? Math.sin(e * 0.35) * 0.34
          : turn + (phase === "revealed" ? Math.sin(e * 0.3) * 0.16 : 0);
      s.rotation.y = spinY;
      s.rotation.x = damp * 0.2 * Math.sin(tw * 7.5) + (phase === "revealed" ? Math.sin(e * 0.45) * 0.03 : 0);
      s.rotation.z = damp * 0.13 * Math.sin(tw * 5.3 + 0.7);
    }

    // Tarnish does not lift everywhere at once: a bright front runs out from the
    // healed cut and the metal behind it is the polished colour.
    for (const m of metalMats.current) {
      if (!m) continue;
      m.color.lerpColors(shades.dull, shades.bright, wipe);
      m.emissiveIntensity = 0.06 * heal + 0.1 * flash;
    }
    for (let side = 0; side < 2; side++) {
      const w = wipeRefs.current[side];
      const wm = wipeMats.current[side];
      if (!w || !wm) continue;
      const on = wipe > 0.004 && wipe < 0.998;
      w.visible = on;
      if (on) {
        const dir = side === 0 ? -1 : 1;
        const span = R * wipe;
        w.position.x = dir * span * 0.5;
        // negative x scale mirrors the UVs, so both bands lead away from the cut
        w.scale.set(dir * span, 2 * R * (1 - 0.3 * wipe), 1);
        wm.opacity = Math.sin(Math.PI * wipe) * 0.55;
      }
    }

    /* ---- a specular band sweeping the metal as it turns ---- */
    const ga = spinY * 1.6 + e * 0.7;
    const gx = Math.sin(ga) * R * 0.95;
    const gOn = Math.pow(Math.max(0, Math.cos(ga)), 4);
    const gh = 2 * Math.sqrt(Math.max(0.0004, R * R - gx * gx));
    for (let side = 0; side < 2; side++) {
      const gl = glintRefs.current[side];
      const gm = glintMats.current[side];
      if (!gl || !gm) continue;
      // whichever half the band is over owns it, so it reads as one sweep
      gl.visible = side === 0 ? gx < 0 : gx >= 0;
      gl.position.x = gx;
      gl.scale.set(0.26, gh, 1);
      gm.opacity = gOn * (0.14 + 0.3 * wipe + (side === 1 ? g.hoverK * 0.22 : 0));
    }

    /* ---- the ring of light thrown off the meeting ---- */
    if (ringRef.current && ringMatRef.current) {
      const k = post < 0 ? 1 : clamp01(post / 0.55);
      ringRef.current.visible = k < 0.999;
      const rr = 0.24 + easeOutCubic(k) * 2.1;
      ringRef.current.scale.set(rr, rr, 1);
      ringMatRef.current.opacity = (1 - k) * (1 - k) * 0.85;
    }

    // Bright only *while* the gold is running; once healed it must not sit there as
    // a hotspot on the face, which is exactly where the words are.
    if (seamLightRef.current) {
      seamLightRef.current.intensity = (heal < 1 ? heal * 1.8 : 0.35) + flash * 1.6;
      // it rides down the cut with the head, and up with the coin
      seamLightRef.current.position.y = ((heal < 1 ? headY : 0) + riseY * 0.34) * fit;
    }
    if (keyRef.current) {
      // one spotlight on velvet, and a real one is never perfectly steady
      keyRef.current.intensity =
        2.1 * (1 + 0.022 * Math.sin(e * 3.1) + 0.015 * Math.sin(e * 7.9 + 2)) + 0.5 * riseK + 1.4 * flash;
    }
    // The pool answers the coin: it tightens and brightens as the thing it is
    // there to light comes up off the cloth.
    if (poolRef.current && poolMatRef.current) {
      const flick = 1 + 0.03 * Math.sin(e * 2.7) + 0.02 * Math.sin(e * 6.3 + 1.1);
      poolRef.current.scale.setScalar((3.9 - 1.0 * riseK) * flick);
      poolMatRef.current.opacity = (0.15 + 0.28 * riseK + 0.3 * flash) * flick;
    }
    if (shadowRef.current && shadowMatRef.current) {
      shadowRef.current.position.y = -0.86 - riseK * 0.24;
      shadowRef.current.scale.set(2.2 + riseK * 0.6, 0.55 + riseK * 0.16, 1);
      shadowMatRef.current.opacity = 0.5 - 0.22 * riseK;
    }

    // The engraving is never faded in: it is *there* while sealed, cut in half and
    // illegible, which is the whole gift. What the heal changes is the contrast —
    // a tarnished coin's inscription is muddy and a polished one's is not.
    const ink = phase === "preview" ? 0.9 : lerp(0.55, 1, wipe);
    for (const m of faceMats.current) if (m) m.opacity = ink;

    // A cold glint on your half until a finger arrives; a hovering pointer wakes it.
    if (hintRef.current && hintMatRef.current) {
      // …and it goes out when they meet, whether a finger brought them or not.
      const want =
        phase === "opening" && !g.touched && g.kissAt < 0
          ? 0.28 + 0.2 * Math.sin(e * 2.6) + g.hoverK * 0.3
          : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
      hintRef.current.visible = hintMatRef.current.opacity > 0.01;
    }

    /* ---- sparks off the kiss ---- */
    const sp = sparkRef.current;
    if (sp) {
      const sk = sparks.current;
      const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < SPARK_N; i++) {
        const a = e - sk.t0[i];
        if (a < 0 || a > SPARK_LIFE) {
          ca.setXYZ(i, 0, 0, 0);
          continue;
        }
        pa.setXYZ(
          i,
          sk.o[i * 3] + sk.v[i * 3] * a,
          sk.o[i * 3 + 1] + sk.v[i * 3 + 1] * a - 2.4 * a * a,
          sk.o[i * 3 + 2] + sk.v[i * 3 + 2] * a,
        );
        const k = (1 - a / SPARK_LIFE) * sk.heat[i];
        ca.setXYZ(i, k * 1.5, k * k * 1.0, k * k * k * 0.5);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- dust in the beam, in every phase ---- */
    const mp = moteRef.current;
    if (mp) {
      const pa = mp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = mp.geometry.attributes.color as THREE.BufferAttribute;
      const gain = 0.45 + 0.4 * riseK + flash * 0.6;
      for (let i = 0; i < MOTE_N; i++) {
        const m = MOTES[i];
        pa.setXYZ(
          i,
          m.x + Math.sin(e * m.w + m.ph) * 0.14,
          ((m.y + e * m.sp) % MOTE_SPAN) - MOTE_SPAN / 2,
          m.z,
        );
        const k = (0.25 + 0.75 * Math.abs(Math.sin(e * m.w * 1.7 + m.ph))) * m.k * gain;
        ca.setXYZ(i, k, k * 0.86, k * 0.64);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    /* ---- camera: a push-in on the reveal, and it never sits perfectly still ---- */
    const cam = camRef.current;
    if (cam) {
      const push = post < 0 ? 0 : smooth(clamp01(post / 1.5));
      // the meeting knocks it; 0.5s later there is nothing left of the knock
      const shake = post >= 0 && post < 0.5 ? Math.exp(-post * 12) * Math.sin(post * 58) : 0;
      cam.position.set(
        Math.sin(e * 0.21) * 0.05 + shake * 0.05,
        0.1 + push * 0.07 + Math.sin(e * 0.27 + 1.4) * 0.02,
        CAM_Z - push * 0.44,
      );
      cam.lookAt(0, riseY * 0.16, 0);
    }
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, -state.pointer.y * 0.05, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.07, k);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const half = (side: 0 | 1) => (
    <meshStandardMaterial
      ref={(m) => {
        metalMats.current[side] = m;
      }}
      color={metal.tarnish}
      metalness={1}
      roughness={metal.rough}
      emissive={metal.seam}
      emissiveIntensity={0}
    />
  );

  /* Each half carries its own side of every layer: solid, border, inscription,
     names, the polish front and its share of the sweeping glint. */
  const faceLayers = (side: 0 | 1) => {
    const uv = side === 0 ? LEFT_UV : RIGHT_UV;
    const dir = side === 0 ? -1 : 1;
    return (
      <>
        <mesh geometry={uv} position={[dir * (R * 1.02) * 0.5, 0, FACE_Z]} scale={[R * 1.02, R * 2.04, 1]}>
          <meshBasicMaterial
            ref={(m) => {
              faceMats.current[side] = m;
            }}
            map={motif}
            color={metal.engrave}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh
          geometry={uv}
          position={[dir * text.faceSize[0] * 0.25, R * 0.08, FACE_Z + 0.004]}
          scale={[text.faceSize[0] / 2, text.faceSize[1], 1]}
        >
          <meshBasicMaterial
            ref={(m) => {
              faceMats.current[2 + side] = m;
            }}
            map={text.face.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh
          geometry={uv}
          position={[dir * text.rimSize[0] * 0.25, -R * 0.66, FACE_Z + 0.004]}
          scale={[text.rimSize[0] / 2, text.rimSize[1], 1]}
        >
          <meshBasicMaterial
            ref={(m) => {
              faceMats.current[4 + side] = m;
            }}
            map={text.rim.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        {/* the polish front, mirrored by a negative scale — hence DoubleSide */}
        <mesh
          ref={(m) => {
            wipeRefs.current[side] = m;
          }}
          position={[0, 0, FACE_Z + 0.008]}
          visible={false}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={(m) => {
              wipeMats.current[side] = m;
            }}
            map={WIPE}
            color={metal.seam}
            transparent
            opacity={0}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
        <mesh
          ref={(m) => {
            glintRefs.current[side] = m;
          }}
          position={[0, 0, FACE_Z + 0.012]}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={(m) => {
              glintMats.current[side] = m;
            }}
            map={GLOW}
            color={metal.seam}
            transparent
            opacity={0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      </>
    );
  };

  return (
    <>
      <PerspectiveCamera
        ref={camRef}
        makeDefault
        position={[0, 0.1, CAM_Z]}
        fov={40}
        onUpdate={(c) => c.lookAt(0, 0, 0)}
      />
      <ambientLight intensity={0.22} />
      {/* one hard key, the way a single spotlight falls on velvet */}
      <directionalLight ref={keyRef} position={[1.4, 3.2, 2.6]} intensity={2.1} color="#fff3dc" />
      <pointLight position={[-2.4, -0.6, 1.8]} intensity={0.35} color="#7a4a63" />
      <pointLight ref={seamLightRef} position={[0, 0, 0.7]} intensity={0} color={metal.seam} distance={4} decay={1.7} />

      {/* velvet, with the spotlight's pool painted into it */}
      <mesh position={[0, -0.1, -2.2]}>
        <planeGeometry args={[12, 9]} />
        <meshBasicMaterial map={VELVET} depthWrite={false} />
      </mesh>
      {/* the pool that answers the coin, and the coin's own shadow on the cloth */}
      <mesh ref={shadowRef} position={[0.16, -0.86, -2.16]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={shadowMatRef} map={GLOW} color="#000000" transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh ref={poolRef} position={[0, -0.05, -2.14]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          ref={poolMatRef}
          map={GLOW}
          color="#c0708a"
          transparent
          opacity={0.15}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* dust drifting through the beam — the one thing that is never still */}
      <points ref={moteRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[moteBuf.pos, 3]} />
          <bufferAttribute attach="attributes-color" args={[moteBuf.col, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={GLOW}
          vertexColors
          size={0.05}
          sizeAttenuation
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      <group ref={fitRef}>
        <group ref={tiltRef}>
          <group ref={floatRef}>
            <group ref={spinRef}>
              <group ref={leftRef}>
                <mesh geometry={LEFT_GEO} onPointerOver={hoverOn} onPointerOut={hoverOff}>
                  {half(0)}
                </mesh>
                {faceLayers(0)}
              </group>
              <group ref={rightRef}>
                <mesh geometry={RIGHT_GEO} onPointerOver={hoverOn} onPointerOut={hoverOff}>
                  {half(1)}
                </mesh>
                {faceLayers(1)}
                <mesh ref={hintRef} position={[0.06, 0, FACE_Z + 0.02]} visible={false}>
                  <planeGeometry args={[0.2, R * 1.7]} />
                  <meshBasicMaterial
                    ref={hintMatRef}
                    color={metal.seam}
                    transparent
                    opacity={0}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </mesh>
              </group>

              {/* the healed cut: a head of gold that runs top to bottom, the trail
                  it lays behind it, and the beads that slide off it and cool. All
                  below the inscription's z so none of it washes out the words it
                  just made readable. */}
              <group position={[0, 0, FACE_Z - 0.006]}>
                <mesh ref={seamRef} position={[0, R, 0]} visible={false}>
                  <planeGeometry args={[0.03, R * 2]} />
                  <meshBasicMaterial
                    ref={seamMatRef}
                    color={metal.seam}
                    transparent
                    opacity={0}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                  />
                </mesh>
                <instancedMesh ref={dripRef} args={[DRIP_GEO, undefined, DRIP_N]} frustumCulled={false}>
                  <meshBasicMaterial
                    map={GLOW}
                    color={metal.seam}
                    transparent
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                  />
                </instancedMesh>
                <mesh ref={headRef} position={[0, R, 0.004]} visible={false}>
                  <planeGeometry args={[1, 1]} />
                  <meshBasicMaterial
                    ref={headMatRef}
                    map={GLOW}
                    color="#fffbe8"
                    transparent
                    opacity={0}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                  />
                </mesh>
              </group>
            </group>
          </group>

          {/* the ring thrown off the meeting, and the metal struck out of the cut */}
          <mesh ref={ringRef} geometry={RING_GEO} position={[0, 0, FACE_Z + 0.05]} visible={false}>
            <meshBasicMaterial
              ref={ringMatRef}
              color={metal.seam}
              transparent
              opacity={0}
              side={THREE.DoubleSide}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
          <points ref={sparkRef} frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[sparkBuf.pos, 3]} />
              <bufferAttribute attach="attributes-color" args={[sparkBuf.col, 3]} />
            </bufferGeometry>
            <pointsMaterial
              map={SPARK_TEX}
              vertexColors
              size={0.055}
              sizeAttenuation
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </points>
        </group>
      </group>

      {/* r185 raycasts straight through visible={false}, so the drag target is a
          transparent mesh instead. Wide enough that a careless swipe still lands. */}
      {phase === "opening" && (
        <mesh position={[0, 0, 1.1]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
