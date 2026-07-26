import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makePaintMask, paintWritePath } from "../mask";
import { makeRadialSprite } from "../sprites";
import { orderWritePath, makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
// `wet` is the paste going on, `dry` is where it darkens before it flakes; `stain`
// is what is left underneath, which is the only colour that matters.
const STAINS: Record<string, { stain: string; bleed: string; glow: string }> = {
  henna: { stain: "#7d3312", bleed: "#a8552a", glow: "#ff9c52" },
  umber: { stain: "#4b2a15", bleed: "#6f452a", glow: "#c98a55" },
  "black-cherry": { stain: "#4a1226", bleed: "#71263f", glow: "#d4607f" },
};
const WET = "#5c6b2a";
const DRY_COLOR = "#3a3f1c";
/* Hoisted: the paste colour is lerped every frame and its endpoints are constant. */
const shadeWet = new THREE.Color(WET);
const shadeDry = new THREE.Color(DRY_COLOR);

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
const PASTE_R = 0.0045;
const STAIN_R = 0.006; // a shade wider: real henna bleeds past its own edge
const GAP2 = 0.0022; // squared uv gap that lifts the cone instead of dragging a line

/* ---------- opening timeline ---------- */
const DRY_HOLD = 2.3; // the enforced pause: paste darkening and cracking
const RUB_TARGET = 0.22; // paste coverage the thumb has to get below
const APPLY_RATE = 2.1; // path advanced per uv unit of drag
const ACTION_W = 2.5;
const ACTION_H = 3.1;

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

/** Craquelure: short random splinters. Gated by the paste mask, so cracks only
 *  ever appear inside paste — the same noise threshold trick, drawn once. */
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

const FLAKES = 26;
/* The painted quads' size. Every mask uv maps onto exactly this rectangle, and so
   must the hit target, or a thumb lands somewhere the brush does not. */
const HAND_W = 1.05;
const HAND_H = 1.34;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
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

  /* Three uses of one util, two of them inverse: the paste is drawn into `paste`
     and then rubbed back out of it, `stain` only ever grows (the skin keeps the
     record of where paste sat long after the paste is gone), and `ghost` is the
     whole pattern painted once at build so there is something to trace. */
  const masks = useMemo(
    () => ({
      paste: makePaintMask({ size: MASK_SIZE, filled: false }),
      stain: makePaintMask({ size: MASK_SIZE, filled: false }),
      ghost: makePaintMask({ size: MASK_SIZE, filled: false }),
    }),
    [],
  );
  useEffect(
    () => () => {
      masks.paste.dispose();
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

  const flakes = useMemo(() => {
    const rand = mulberry32(2718);
    return Array.from({ length: FLAKES }, () => ({
      spin: (rand() - 0.5) * 6,
      drift: (rand() - 0.5) * 0.4,
      scale: 0.016 + rand() * 0.022,
      fall: 0.5 + rand() * 0.5,
    }));
  }, []);

  // The ghost is the finished pattern, painted once — it is what the cone follows.
  useEffect(() => {
    masks.ghost.reset();
    paintWritePath(masks.ghost, write.w, write.lineStart, -1, write.w.count - 1, PASTE_R, write.wFrac, GAP2, 0.02, "draw");
  }, [masks, write]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* act: 0 applying, 1 drying, 2 rubbing, 3 done. `peak` is the paste coverage the
     moment the pattern closed, so the rub target is a fraction of what was actually
     laid down and not of the whole mask (which thin strokes barely touch). */
  const g = useRef({
    act: 0,
    idx: 0,
    dryAt: 0,
    down: false,
    u: 0.5,
    v: 0.5,
    pu: 0.5,
    pv: 0.5,
    touched: false,
    peak: 1,
    poll: 0,
    live: [] as { x: number; y: number; t: number }[],
  });
  useEffect(() => {
    if (phase !== "opening") return;
    masks.paste.reset();
    masks.stain.reset();
    g.current = { act: 0, idx: 0, dryAt: 0, down: false, u: 0.5, v: 0.5, pu: 0.5, pv: 0.5, touched: false, peak: 1, poll: 0, live: [] };
  }, [phase, masks]);

  /* Sealed and revealed are two different shots of the same table: the second one
     is in on the palm, because that is where the words are. */
  const fitRef = useRef<THREE.Group>(null);
  const stageRef = useRef<THREE.Group>(null);
  const pasteMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const bevelMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const crackMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const stainMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bleedMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const ghostMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const namesMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coneRef = useRef<THREE.Group>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const flakeRefs = useRef<(THREE.Mesh | null)[]>([]);

  /* Paint from the ghost path, not from where the finger actually is: the cone is
     guided along a drawn pattern in real life too, and demanding pixel accuracy on
     a phone would make the gift unfinishable. Drag distance is the only input. */
  const advance = (du: number, dv: number) => {
    const cur = g.current;
    const step = Math.hypot(du, dv) * APPLY_RATE * write.w.count;
    const to = Math.min(write.w.count - 1, cur.idx + step);
    if (to <= cur.idx) return;
    paintWritePath(masks.stain, write.w, write.lineStart, cur.idx, to, STAIN_R, write.wFrac, GAP2, 0.02, "draw");
    paintWritePath(masks.paste, write.w, write.lineStart, cur.idx, to, PASTE_R, write.wFrac, GAP2, 0.02, "draw");
    cur.idx = to;
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
    cur.touched = true;
    cur.u = cur.pu = uv.x;
    cur.v = cur.pv = uv.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const cur = g.current;
    if (!cur.down || phase !== "opening") return;
    ev.stopPropagation();
    const uv = uvOf(ev);
    if (!uv) return;
    cur.pu = cur.u;
    cur.pv = cur.v;
    cur.u = uv.x;
    cur.v = uv.y;
    const du = cur.u - cur.pu;
    const dv = cur.v - cur.pv;
    if (cur.act === 0) advance(du, dv);
    else if (cur.act === 2) {
      // The thumb takes the paste off. Same util, opposite direction.
      masks.paste.stroke(cur.pu, cur.pv, cur.u, cur.v, 0.055, "erase");
      if (cur.live.length < FLAKES) {
        cur.live.push({ x: (cur.u - 0.5) * HAND_W, y: (cur.v - 0.5) * HAND_H, t: 0 });
        clack({ freq: 3400, decay: 0.035, gain: 0.09 });
      }
    }
  };
  const stop = () => {
    g.current.down = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const cur = g.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.6, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- act machine (opening only; the other phases are its two endpoints) ---- */
    if (phase === "opening") {
      if (cur.act === 0 && cur.idx >= write.w.count - 1) {
        cur.act = 1;
        cur.dryAt = tRef.current;
        cur.peak = Math.max(0.004, masks.paste.coverage());
        tone(196, { type: "triangle", seconds: 0.9, gain: 0.16 });
      } else if (cur.act === 1 && tRef.current - cur.dryAt > DRY_HOLD) {
        cur.act = 2;
      } else if (cur.act === 2) {
        // coverage() reads the mask back, so poll it a few times a second, not 60.
        cur.poll += dt;
        if (cur.poll > 0.18) {
          cur.poll = 0;
          if (masks.paste.coverage() < cur.peak * RUB_TARGET) {
            cur.act = 3;
            masks.paste.fade(1); // whatever is left lets go at once
            tone(523, { shimmer: true, seconds: 1.4, gain: 0.22 });
          }
        }
      }
    }

    const applying = phase === "opening" && cur.act === 0;
    const dry = phase === "opening" && cur.act >= 1 ? clamp01((tRef.current - cur.dryAt) / DRY_HOLD) : phase === "sealed" || phase === "preview" ? 0 : 1;
    const rubbed = phase === "revealed" || (phase === "opening" && cur.act === 3);

    /* ---- shot: sealed sits back at the table, the reveal is in on the palm ---- */
    if (stageRef.current) {
      const close = phase === "sealed" || phase === "preview" ? 0 : 1;
      const s = stageRef.current;
      s.scale.setScalar(lerp(s.scale.x, lerp(0.92, 1.24, close), Math.min(1, dt * 3)));
      s.position.y = lerp(s.position.y, lerp(0, -0.2, close), Math.min(1, dt * 3));
    }

    /* ---- paste: wet green while it goes on, dark and cracked as it dries ---- */
    if (pasteMatRef.current) {
      const m = pasteMatRef.current;
      m.color.lerpColors(shadeWet, shadeDry, dry);
      m.roughness = lerp(0.28, 0.92, dry);
      m.opacity = rubbed ? 0 : 1;
    }
    if (bevelMatRef.current) bevelMatRef.current.opacity = rubbed ? 0 : 0.5 * (1 - dry * 0.7);
    if (crackMatRef.current) crackMatRef.current.opacity = rubbed ? 0 : smooth(clamp01((dry - 0.35) / 0.6)) * 0.85;

    /* ---- the stain beneath: it darkens *while* the paste dries, which is the
            reason the pause exists at all ---- */
    if (stainMatRef.current) stainMatRef.current.opacity = phase === "preview" ? 0.9 : lerp(0.12, 1, dry);
    if (bleedMatRef.current) bleedMatRef.current.opacity = phase === "preview" ? 0.3 : lerp(0.04, 0.34, dry);
    if (namesMatRef.current) {
      const want = phase === "preview" ? 0.85 : rubbed ? 1 : 0;
      namesMatRef.current.opacity += (want - namesMatRef.current.opacity) * Math.min(1, dt * 2.6);
    }
    // The ghost only exists to be traced over.
    if (ghostMatRef.current) ghostMatRef.current.opacity = applying ? 0.16 : 0;

    /* ---- the cone rides the head of the path while paste is going on ---- */
    if (coneRef.current) {
      const on = applying && cur.touched;
      coneRef.current.visible = on;
      if (on) {
        const i = Math.floor(cur.idx);
        const x = write.w.path[i * 2] * write.wFrac * 1.05;
        const y = (write.w.path[i * 2 + 1] * write.wFrac + 0.02) * 1.34;
        coneRef.current.position.set(x, y, 0.2);
        coneRef.current.rotation.z = -0.5 + Math.sin(e * 6) * 0.05;
      }
    }

    /* ---- flakes fall from wherever the thumb passed ---- */
    for (let i = 0; i < FLAKES; i++) {
      const mesh = flakeRefs.current[i];
      if (!mesh) continue;
      const born = cur.live[i];
      // A last flake drops on the reveal, so the still frame is not quite still.
      const idle = phase === "revealed" && i === 0 ? ((e * 0.35) % 1) : -1;
      const k = born ? born.t : idle;
      if (k < 0 || k > 1) {
        mesh.visible = false;
        continue;
      }
      if (born) born.t += dt * flakes[i].fall;
      const f = flakes[i];
      mesh.visible = true;
      mesh.position.set((born ? born.x : 0.05) + f.drift * k, (born ? born.y : 0.3) - k * k * 1.6, 0.016);
      mesh.rotation.z = k * f.spin;
      mesh.scale.setScalar(f.scale * (1 - 0.3 * k));
    }

    if (hintMatRef.current) {
      // One nudge, and only where the next gesture has to happen.
      const want = phase === "opening" && ((cur.act === 0 && !cur.touched) || cur.act === 2) ? 0.2 + 0.14 * Math.sin(e * 3) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && cur.act === 3 && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  // Revealed and sealed have to look right with no gesture ever made, so the masks
  // get their finished state up front and `opening` resets them.
  useEffect(() => {
    if (phase === "opening") return;
    masks.paste.reset();
    masks.stain.reset();
    if (phase === "sealed") return;
    // preview + revealed: the stain is already set, and no paste is left.
    paintWritePath(masks.stain, write.w, write.lineStart, -1, write.w.count - 1, STAIN_R, write.wFrac, GAP2, 0.02, "draw");
  }, [phase, masks, write]);

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.05, 3.1]} fov={40} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.5} color="#ffd9b0" />
      {/* warm lamps, low and to both sides — a henna night is lit from the table */}
      <directionalLight position={[1.6, 1.4, 2.4]} intensity={1.5} color="#ffcf94" />
      <pointLight position={[-1.8, 0.4, 1.4]} intensity={0.8} color="#ff9c5c" distance={6} decay={1.4} />

      {/* silk */}
      <mesh position={[0, -0.15, -1.2]} rotation={[-0.35, 0, 0]}>
        <planeGeometry args={[9, 7]} />
        <meshBasicMaterial map={SILK} depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        <group ref={stageRef}>
          {/* bowl of paste and the rolled cone, resting until they are wanted */}
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
          <mesh geometry={wristGeo} position={[0, -0.92, 0]} scale={[1, 1, 0.42]}>
            <meshStandardMaterial color="#c98f63" roughness={0.72} />
          </mesh>
          <mesh geometry={palmGeo} position={[0, -0.1, 0]}>
            <meshStandardMaterial color="#d69a6d" roughness={0.7} />
          </mesh>
          {FINGERS.map(([x, y, rot, len], i) => (
            <mesh
              key={i}
              geometry={fingerGeo}
              position={[x, y, 0]}
              rotation={[0, 0, rot]}
              scale={[1, len, 0.55]}
            >
              <meshStandardMaterial color="#d69a6d" roughness={0.7} />
            </mesh>
          ))}
          <mesh geometry={thumbGeo} position={[-0.5, -0.24, 0.02]} rotation={[0, 0, 0.85]} scale={[1, 1, 0.6]}>
            <meshStandardMaterial color="#d69a6d" roughness={0.7} />
          </mesh>

          {/* Everything painted lives on flat quads over the palm — the mask's uv IS
              the quad's, so a raycast hands the brush its coordinates directly. */}
          <group position={[0, -0.06, 0.215]}>
            {/* faded prior henna: always there, in every phase */}
            <mesh>
              <planeGeometry args={[HAND_W * 1.5, HAND_H * 1.5]} />
              <meshBasicMaterial map={motif} color={stainPal.stain} transparent opacity={0.14} depthWrite={false} toneMapped={false} />
            </mesh>
            {/* the bleed halo, then the stain itself */}
            <mesh position={[0, 0, 0.002]}>
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
            <mesh position={[0, 0, 0.004]} scale={0.985}>
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
                raised bead as a flat quad gets, and closer than it has any right to be */}
            <mesh position={[-0.006, 0.007, 0.009]}>
              <planeGeometry args={[HAND_W, HAND_H]} />
              <meshBasicMaterial
                ref={bevelMatRef}
                color="#98a860"
                alphaMap={masks.paste.texture}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <mesh position={[0, 0, 0.011]}>
              <planeGeometry args={[HAND_W, HAND_H]} />
              <meshStandardMaterial
                ref={pasteMatRef}
                color={WET}
                alphaMap={masks.paste.texture}
                roughness={0.3}
                transparent
                opacity={0}
                depthWrite={false}
              />
            </mesh>
            <mesh position={[0, 0, 0.013]}>
              <planeGeometry args={[HAND_W, HAND_H]} />
              <meshBasicMaterial
                ref={crackMatRef}
                map={CRACKS}
                alphaMap={masks.paste.texture}
                transparent
                opacity={0}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            {/* both names, small, up where the fingers start */}
            <mesh position={[0, HAND_H * 0.4, 0.015]}>
              <planeGeometry args={names.size} />
              <meshBasicMaterial ref={namesMatRef} map={names.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
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
            {flakes.map((_, i) => (
              <mesh
                key={i}
                ref={(m) => {
                  flakeRefs.current[i] = m;
                }}
                visible={false}
              >
                <planeGeometry args={[1, 1]} />
                <meshBasicMaterial color={DRY_COLOR} transparent opacity={0.9} depthWrite={false} />
              </mesh>
            ))}

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
                onPointerOut={stop}
              >
                <planeGeometry args={[HAND_W, HAND_H]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            )}
          </group>

          {/* the cone, held at the head of the pattern */}
          <group ref={coneRef} visible={false}>
            <mesh rotation={[0, 0, Math.PI]} position={[0.07, 0.11, 0]}>
              <coneGeometry args={[0.055, 0.3, 14]} />
              <meshStandardMaterial color="#4a3a28" roughness={0.6} />
            </mesh>
            <mesh position={[0, 0, 0]}>
              <sphereGeometry args={[0.017, 10, 8]} />
              <meshStandardMaterial color={WET} roughness={0.25} />
            </mesh>
          </group>
        </group>
      </group>

    </>
  );
}
