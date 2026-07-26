import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, smooth } from "../math";
import { resumeAudio, tone } from "../audio";
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

/* ---------- opening timeline, measured from the kiss ---------- */
const HEAL_END = 0.95;
const RISE_START = 0.6;
const RISE_END = 2.5;
const POST_END = 3.0;

const MAGNET = 0.46; // past here the halves finish the job themselves
const TRAVEL = 1.5; // world units of drag that close the gap
const GAP_NEAR = 0.62; // your half's rest offset while sealed
const ACTION_W = 3.1;
const ACTION_H = 2.9;

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
  const gest = useRef({ close: 0, kissAt: -1, down: false, px: 0, touched: false });
  useEffect(() => {
    if (phase === "opening") gest.current = { close: 0, kissAt: -1, down: false, px: 0, touched: false };
  }, [phase]);

  // One material per half, reached by ref: the tarnish lifts every frame, and a
  // useMemo'd material may not be mutated after render (react-hooks/immutability).
  const metalMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const fitRef = useRef<THREE.Group>(null);
  const floatRef = useRef<THREE.Group>(null);
  const spinRef = useRef<THREE.Group>(null);
  const leftRef = useRef<THREE.Group>(null);
  const rightRef = useRef<THREE.Group>(null);
  const seamRef = useRef<THREE.Mesh>(null);
  const seamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const seamLightRef = useRef<THREE.PointLight>(null);
  const faceMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const hintRef = useRef<THREE.Mesh>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || gest.current.kissAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety — onPointerOut below covers its absence */
    }
    gest.current.down = true;
    gest.current.touched = true;
    gest.current.px = ev.point.x;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const g = gest.current;
    if (!g.down || phase !== "opening" || g.close >= 1) return;
    ev.stopPropagation();
    // Toward the centre closes it. Physical, not textual — identical in both langs.
    g.close = clamp01(g.close + (g.px - ev.point.x) / TRAVEL);
    g.px = ev.point.x;
  };
  const stop = () => {
    gest.current.down = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const g = gest.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.62, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- how closed the pair is, per phase ---- */
    let close: number;
    if (phase === "opening") {
      // Past the magnet point they pull each other shut, and harder the closer they get.
      if (g.close > MAGNET && g.close < 1) g.close = Math.min(1, g.close + dt * (0.55 + 2.6 * g.close));
      if (g.close >= 1 && g.kissAt < 0) {
        g.kissAt = tRef.current;
        tone(1046, { shimmer: true, seconds: 1.3, gain: 0.3 });
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
    const heal = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / HEAL_END));

    /* ---- the halves ---- */
    const gap = 1 - close;
    const tilt = gap * 0.42; // the sawn edge turned toward camera while apart
    if (rightRef.current) {
      rightRef.current.position.x = GAP_NEAR * gap;
      rightRef.current.rotation.y = tilt;
    }
    if (leftRef.current) {
      // Theirs comes in from off-frame, and accelerates: gap eased, not linear.
      // "Off-frame" is measured against the live viewport, not a constant — on a
      // wide desktop canvas a fixed 4.6 units is still very much on screen, and the
      // whole sealed state is that you cannot see their half.
      const off = state.viewport.width / 2 / Math.max(0.2, fitRef.current?.scale.x ?? 1) + R * 1.4;
      leftRef.current.position.x = -off * easeOutCubic(gap);
      leftRef.current.rotation.y = -tilt;
    }

    /* ---- the seam heals as a line of gold running down the cut ---- */
    if (seamRef.current && seamMatRef.current) {
      seamRef.current.visible = heal > 0.002;
      seamRef.current.scale.y = heal;
      seamRef.current.position.y = R * (1 - heal);
      // Bright while it is running, then just a line of gold sitting in the cut —
      // it heals the coin, it does not become a lamp in the middle of the message.
      seamMatRef.current.opacity = heal < 1 ? 0.9 : 0.3 + 0.1 * Math.sin(e * 1.6);
    }
    // Bright only *while* the gold is running; once healed it must not sit there as
    // a hotspot on the face, which is exactly where the words are.
    if (seamLightRef.current) seamLightRef.current.intensity = heal < 1 ? heal * 1.8 : 0.35;

    // Tarnish lifts with the heal, and the whole coin picks up a little emissive.
    for (const m of metalMats.current) {
      if (!m) continue;
      m.color.lerpColors(shades.dull, shades.bright, heal);
      m.emissiveIntensity = 0.06 * heal;
    }

    /* ---- rise, one turn, and the inscription ---- */
    const rise = post < 0 ? 0 : smooth(clamp01((post - RISE_START) / (RISE_END - RISE_START)));
    if (floatRef.current) {
      const idle = phase === "preview" || phase === "revealed" ? Math.sin(e * 0.85) * 0.045 : 0;
      floatRef.current.position.y = rise * 0.34 + idle;
    }
    if (spinRef.current) {
      const turn = rise * TAU;
      spinRef.current.rotation.y =
        phase === "preview" ? Math.sin(e * 0.35) * 0.34 : turn + (phase === "revealed" ? Math.sin(e * 0.3) * 0.16 : 0);
    }

    // The engraving is never faded in: it is *there* while sealed, cut in half and
    // illegible, which is the whole gift. What the heal changes is the contrast —
    // a tarnished coin's inscription is muddy and a polished one's is not.
    const ink = phase === "preview" ? 0.9 : lerp(0.55, 1, heal);
    for (const m of faceMats.current) if (m) m.opacity = ink;

    // A cold glint on your half until a finger arrives.
    if (hintRef.current && hintMatRef.current) {
      const want = phase === "opening" && !g.touched ? 0.28 + 0.2 * Math.sin(e * 2.6) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
      hintRef.current.visible = hintMatRef.current.opacity > 0.01;
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

  /* Each half carries its own side of every layer: solid, border, inscription, names. */
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
      </>
    );
  };

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.1, 4.5]} fov={40} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.22} />
      {/* one hard key, the way a single spotlight falls on velvet */}
      <directionalLight position={[1.4, 3.2, 2.6]} intensity={2.1} color="#fff3dc" />
      <pointLight position={[-2.4, -0.6, 1.8]} intensity={0.35} color="#7a4a63" />
      <pointLight ref={seamLightRef} position={[0, 0, 0.7]} intensity={0} color={metal.seam} distance={4} decay={1.7} />

      {/* velvet, with the spotlight's pool painted into it */}
      <mesh position={[0, -0.1, -2.2]}>
        <planeGeometry args={[12, 9]} />
        <meshBasicMaterial map={VELVET} depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        <group ref={floatRef}>
          <group ref={spinRef}>
            <group ref={leftRef}>
              <mesh geometry={LEFT_GEO}>{half(0)}</mesh>
              {faceLayers(0)}
            </group>
            <group ref={rightRef}>
              <mesh geometry={RIGHT_GEO}>{half(1)}</mesh>
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

            {/* the healed cut: a line of gold that runs top to bottom. Sits below
                the inscription's z so it never washes out the words it just made
                readable. */}
            <mesh ref={seamRef} position={[0, R, FACE_Z - 0.006]} visible={false}>
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
          </group>
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
