import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { resumeAudio, swell, tone } from "../audio";
import { pick } from "../catalog";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
const STADIUMS: Record<string, { sky: [string, string]; flood: string; amb: number; bands: string[]; deck: string }> = {
  floodlit: {
    sky: ["#070c18", "#101a30"],
    flood: "#eaf2ff",
    amb: 0.34,
    bands: ["#1d3f7a", "#24519c", "#c8d4e8", "#8fa4c4"],
    deck: "#14192a",
  },
  sunset: {
    sky: ["#2a1c3a", "#e2764a"],
    flood: "#ffd6a0",
    amb: 0.5,
    bands: ["#7a2f3a", "#a8434a", "#e8c088", "#c98a6a"],
    deck: "#2a1c22",
  },
  indoor: {
    sky: ["#0d0f14", "#181c24"],
    flood: "#fff4e0",
    amb: 0.44,
    bands: ["#38405c", "#4a5478", "#d8dce8", "#9aa2bc"],
    deck: "#1a1d26",
  },
};
type FrameKind = "hearts" | "confetti" | "fireworks";
const FRAMES: Record<string, FrameKind> = { hearts: "hearts", confetti: "confetti", fireworks: "fireworks" };

const TAU = Math.PI * 2;
const CROWD = 7800; // dark and out of focus, mostly — distance does the rest
const ACTION_W = 3.5;
const ACTION_H = 2.9;
const SCREEN_W = 2.55;
const SCREEN_H = 1.44;
const CONFETTI = 90;

const crowdGeo = new THREE.CapsuleGeometry(0.5, 0.7, 2, 5);
const HINT = makeRadialSprite(64);

/** The advert the screen runs before it has anything better to do. */
function buildAd(lang: Lang): THREE.CanvasTexture {
  const w = 512;
  const h = 288;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0f2a4a";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#1d4a7a";
  g.fillRect(0, h * 0.62, w, h * 0.38);
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "'Helvetica Neue', Arial, sans-serif";
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.fillStyle = "#dbe6f4";
  g.font = `700 44px ${fam}`;
  g.fillText(ar ? "تأمين موثوق" : "RELIABLE INSURANCE", w / 2, h * 0.34);
  g.font = `400 24px ${fam}`;
  g.fillStyle = "#8fb0d4";
  g.fillText(ar ? "منذ ١٩٧٤" : "since 1974", w / 2, h * 0.48);
  return new THREE.CanvasTexture(c);
}

/** The frame the names sit inside, per variant. Drawn, not modelled. */
function buildFrame(kind: FrameKind): THREE.CanvasTexture {
  const w = 512;
  const h = 288;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const rand = mulberry32(4242);
  const n = 34;
  const put = (x: number, y: number, s: number, a: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    if (kind === "hearts") {
      g.fillStyle = "#ff5f7e";
      g.beginPath();
      g.moveTo(0, s * 0.5);
      g.bezierCurveTo(s, -s * 0.2, s * 0.5, -s, 0, -s * 0.35);
      g.bezierCurveTo(-s * 0.5, -s, -s, -s * 0.2, 0, s * 0.5);
      g.fill();
    } else if (kind === "confetti") {
      g.fillStyle = ["#ffd23f", "#ff5f7e", "#3fd2ff", "#7bff9a"][Math.floor(rand() * 4)];
      g.fillRect(-s * 0.3, -s * 0.6, s * 0.6, s * 1.2);
    } else {
      g.strokeStyle = ["#ffd23f", "#ff9c3f", "#fff2c4"][Math.floor(rand() * 3)];
      g.lineWidth = 2.4;
      for (let k = 0; k < 8; k++) {
        const th = (k / 8) * TAU;
        g.beginPath();
        g.moveTo(Math.cos(th) * s * 0.25, Math.sin(th) * s * 0.25);
        g.lineTo(Math.cos(th) * s, Math.sin(th) * s);
        g.stroke();
      }
    }
    g.restore();
  };
  // ring the border only — the middle is where the names go
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const s = 11 + rand() * 9;
    if (t < 0.5) put(28 + (t / 0.5) * (w - 56), 26 + rand() * 8, s, rand() * TAU);
    else put(28 + ((t - 0.5) / 0.5) * (w - 56), h - 26 - rand() * 8, s, rand() * TAU);
  }
  for (let i = 0; i < 12; i++) {
    const y = 52 + (i / 12) * (h - 104);
    const s = 11 + rand() * 8;
    put(26 + rand() * 8, y, s, rand() * TAU);
    put(w - 26 - rand() * 8, y, s, rand() * TAU);
  }
  return new THREE.CanvasTexture(c);
}

function buildSky(a: string, b: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  return new THREE.CanvasTexture(c);
}

/* ---------- opening: the camera keeps almost finding you ---------- */
const SWEEPS = 3; // past you, past you, and then it locks on
const PAN_TRAVEL = 1.3; // world units of drag for one sweep
const LOCK_ZOOM = 1.1;
const NAMES_AT = 0.9;
const POST_END = 4.4;
/* Where you are sitting, in the roving camera's own coordinates. */
const YOU_X = 0.12;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function BigScreenScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const st = STADIUMS[variants.stadium] ?? STADIUMS.floodlit;
  const frameKind = FRAMES[variants.frame] ?? "hearts";

  const sky = useMemo(() => buildSky(st.sky[0], st.sky[1]), [st]);
  const ad = useMemo(() => buildAd(lang), [lang]);
  const frameTex = useMemo(() => buildFrame(frameKind), [frameKind]);
  useEffect(
    () => () => {
      sky.dispose();
      ad.dispose();
      frameTex.dispose();
    },
    [sky, ad, frameTex],
  );

  /* Both names in lights, and the message beneath them. */
  const text = useMemo(() => {
    const names = makeTextTexture(`${recipientName || "—"}  ♥  ${senderName || "—"}`, {
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      fontWeight: "700",
      fontSize: 84,
      color: "#fff6d8",
      glow: 26,
      glowColor: "#ffcf5a",
      maxWidthPx: 84 * 9,
      padding: 20,
      lang,
    });
    const body = makeTextTexture(message.trim() || forRecipient(lang, recipientName), {
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      fontWeight: "500",
      fontSize: 50,
      color: "#dfe9ff",
      maxWidthPx: 50 * 12,
      lineHeight: 1.28,
      padding: 16,
      lang,
    });
    return {
      names,
      body,
      nameSize: fitPlane(names.aspect, SCREEN_W * 0.78, SCREEN_H * 0.3),
      bodySize: fitPlane(body.aspect, SCREEN_W * 0.8, SCREEN_H * 0.34),
    };
  }, [senderName, recipientName, message, lang]);
  useEffect(
    () => () => {
      text.names.texture.dispose();
      text.body.texture.dispose();
    },
    [text],
  );

  const groan = useMemo(
    () =>
      makeTextTexture(pick(lang, "…someone else", "…شخصٌ آخر"), {
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        fontWeight: "500",
        fontSize: 44,
        color: "#cfd8ea",
        maxWidthPx: 44 * 12,
        padding: 12,
        lang,
      }),
    [lang],
  );
  useEffect(() => () => groan.texture.dispose(), [groan]);

  /* The stand: 7800 blobs in four colour bands, most of them dark. Built once. */
  const crowd = useMemo(() => {
    const rand = mulberry32(60000);
    const pos = new Float32Array(CROWD * 3);
    const col = new Float32Array(CROWD * 3);
    const sway = new Float32Array(CROWD);
    const c = new THREE.Color();
    const bands = st.bands.map((b) => new THREE.Color(b));
    for (let i = 0; i < CROWD; i++) {
      // rows banked away from us, wrapping round the bowl
      const row = Math.floor(rand() * 46);
      const t = row / 46;
      pos[i * 3] = (rand() - 0.5) * (13 + t * 9);
      pos[i * 3 + 1] = -1.5 + t * 3.6 + (rand() - 0.5) * 0.06;
      pos[i * 3 + 2] = -1.6 - t * 7.4 + (rand() - 0.5) * 0.12;
      // The far rows are darker and bluer: that is all the depth of field there is,
      // and at this distance it is all there needs to be.
      c.copy(bands[Math.floor(rand() * bands.length)]).multiplyScalar(0.32 + (1 - t) * 0.68);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      sway[i] = rand() * TAU;
    }
    return { pos, col, sway };
  }, [st]);

  const confetti = useMemo(() => {
    const rand = mulberry32(515);
    return Array.from({ length: CONFETTI }, () => ({
      x: (rand() - 0.5) * 4.4,
      z: 0.4 + rand() * 1.6,
      y: 1.6 + rand() * 1.4,
      spin: (rand() - 0.5) * 9,
      drift: (rand() - 0.5) * 0.7,
      fall: 0.4 + rand() * 0.5,
      hue: ["#ffd23f", "#ff5f7e", "#3fd2ff", "#7bff9a", "#ffffff"][Math.floor(rand() * 5)],
      scale: 0.02 + rand() * 0.026,
    }));
  }, []);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* `pan` is the roving camera's position; `sweeps` counts how many times it has
     gone past you without stopping. */
  const g = useRef({ pan: -1.4, sweeps: 0, dir: 1, lockAt: -1, down: false, px: 0, touched: false, roared: false });
  useEffect(() => {
    if (phase === "opening") g.current = { pan: -1.4, sweeps: 0, dir: 1, lockAt: -1, down: false, px: 0, touched: false, roared: false };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const crowdRef = useRef<THREE.InstancedMesh>(null);
  const screenMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const nameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bodyMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const frameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const groanMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const boxRef = useRef<THREE.Group>(null);
  const spotRef = useRef<THREE.Mesh>(null);
  const spotMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const confettiRefs = useRef<(THREE.Mesh | null)[]>([]);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tint = useMemo(() => new THREE.Color(), []);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.lockAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.current.down = true;
    g.current.touched = true;
    g.current.px = ev.point.x;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening" || c.lockAt >= 0) return;
    ev.stopPropagation();
    const was = c.pan;
    c.pan = Math.max(-1.9, Math.min(1.9, c.pan + (ev.point.x - c.px) * (PAN_TRAVEL / 1.3)));
    c.px = ev.point.x;
    // Crossing your row counts as a sweep — in either direction, because the second
    // pass is supposed to come back the other way.
    if ((was - YOU_X) * (c.pan - YOU_X) < 0) {
      c.sweeps += 1;
      if (c.sweeps < SWEEPS) {
        // It settles on someone else, who waves. The crowd is not impressed.
        tone(196, { type: "sawtooth", seconds: 0.55, gain: 0.13 });
      } else {
        c.lockAt = tRef.current;
        c.pan = YOU_X;
        tone(880, { shimmer: true, seconds: 1.4, gain: 0.26 });
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
    const c = g.current;

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.52, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    const post = phase === "revealed" ? POST_END : c.lockAt >= 0 ? tRef.current - c.lockAt : -1;
    const found = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / 1.1));

    // The roar goes up when it lands, once.
    if (post >= 0 && !c.roared && phase === "opening") {
      c.roared = true;
      swell({ source: "noise", cutoff: 620, q: 0.6, attack: 0.5, hold: 1.4, release: 2.4, gain: 0.26 });
    }

    /* ---- the crowd: a slow, uneven sway, and a lift when it lands ---- */
    if (crowdRef.current) {
      const surge = found;
      for (let i = 0; i < CROWD; i++) {
        const ph = crowd.sway[i];
        const s = Math.sin(e * 1.1 + ph);
        dummy.position.set(
          crowd.pos[i * 3] + s * 0.012,
          crowd.pos[i * 3 + 1] + Math.abs(s) * 0.02 + surge * (0.5 + 0.5 * Math.sin(e * 6 + ph)) * 0.07,
          crowd.pos[i * 3 + 2],
        );
        dummy.scale.setScalar(0.052);
        dummy.updateMatrix();
        crowdRef.current.setMatrixAt(i, dummy.matrix);
        if (crowdRef.current.instanceColor) {
          tint.setRGB(crowd.col[i * 3], crowd.col[i * 3 + 1], crowd.col[i * 3 + 2]);
          crowdRef.current.setColorAt(i, tint);
        }
      }
      crowdRef.current.instanceMatrix.needsUpdate = true;
      if (crowdRef.current.instanceColor) crowdRef.current.instanceColor.needsUpdate = true;
    }

    /* ---- the roving camera's spotlight, sliding across the stand ---- */
    let pan: number;
    if (phase === "opening") pan = c.pan;
    else if (phase === "sealed") pan = -1.4;
    else if (phase === "preview") pan = Math.sin(e * 0.5) * 1.3; // still looking
    else pan = YOU_X;
    if (spotRef.current && spotMatRef.current) {
      spotRef.current.position.x = pan;
      spotRef.current.scale.setScalar(lerp(1, LOCK_ZOOM, found));
      spotMatRef.current.opacity = phase === "sealed" ? 0.14 : 0.24 + found * 0.34;
    }
    /* your box in the stand — it only lights when the camera finally stops on it */
    if (boxRef.current) {
      const near = 1 - Math.min(1, Math.abs(pan - YOU_X) / 0.35);
      boxRef.current.scale.setScalar(lerp(1, 1.14, Math.max(near * 0.5, found)));
      boxRef.current.position.y = -0.28 + found * 0.05;
    }

    /* ---- the screen ---- */
    if (screenMatRef.current) {
      // the advert holds until it is replaced, and flickers the way they do
      screenMatRef.current.opacity = 1 - found;
      screenMatRef.current.color.setScalar(0.92 + 0.08 * Math.sin(e * 30));
    }
    if (nameMatRef.current) nameMatRef.current.opacity = phase === "preview" ? 0.25 : clamp01((post - 0) / 0.7);
    if (bodyMatRef.current) bodyMatRef.current.opacity = phase === "preview" ? 0.15 : clamp01((post - NAMES_AT) / 0.8);
    if (frameMatRef.current) {
      const k = phase === "preview" ? 0.2 : clamp01(post / 0.9);
      frameMatRef.current.opacity = k * (0.72 + 0.28 * Math.sin(e * 3.2));
    }
    if (groanMatRef.current) {
      // the near-miss caption, only while it is still landing on other people
      const miss = phase === "opening" && c.sweeps > 0 && c.sweeps < SWEEPS && c.lockAt < 0 ? 1 : 0;
      groanMatRef.current.opacity += (miss - groanMatRef.current.opacity) * Math.min(1, dt * 3);
    }

    /* ---- confetti from the tier above ---- */
    for (let i = 0; i < CONFETTI; i++) {
      const m = confettiRefs.current[i];
      if (!m) continue;
      const f = confetti[i];
      const k = post < 0 ? -1 : ((post - 0.6) * f.fall) % 2.6;
      if (k < 0) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(f.x + Math.sin(k * 2 + i) * f.drift, f.y - k * 1.1, f.z);
      m.rotation.set(k * f.spin, k * f.spin * 0.7, 0);
      m.scale.setScalar(f.scale);
    }

    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.3 + 0.2 * Math.sin(e * 2.7) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    // The camera holds a beat too long, the way it always does.
    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.35, 3.4]} fov={46} onUpdate={(c) => c.lookAt(0, 0.15, 0)} />
      <ambientLight intensity={st.amb} />
      <directionalLight position={[0, 4, 3]} intensity={1.5} color={st.flood} />
      <pointLight position={[-3, 2.4, 2]} intensity={0.6} color={st.flood} />

      {/* night, and the far side of the bowl */}
      <mesh position={[0, 1.2, -9]}>
        <planeGeometry args={[40, 18]} />
        <meshBasicMaterial map={sky} depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        {/* floodlight pylons */}
        {[-3.1, 3.1].map((x, i) => (
          <group key={i} position={[x, 1.5, -6]}>
            <mesh position={[0, -0.9, 0]}>
              <cylinderGeometry args={[0.03, 0.05, 2.4, 6]} />
              <meshStandardMaterial color={st.deck} roughness={0.9} />
            </mesh>
            <mesh>
              <planeGeometry args={[0.72, 0.4]} />
              <meshBasicMaterial color={st.flood} toneMapped={false} />
            </mesh>
          </group>
        ))}

        {/* the big screen, up on its gantry */}
        <group position={[0, 0.92, -1.1]}>
          <mesh position={[0, 0, -0.04]}>
            <boxGeometry args={[SCREEN_W + 0.12, SCREEN_H + 0.12, 0.08]} />
            <meshStandardMaterial color={st.deck} roughness={0.8} metalness={0.3} />
          </mesh>
          <mesh>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial color="#05070c" toneMapped={false} />
          </mesh>
          {/* the advert for something dull */}
          <mesh position={[0, 0, 0.004]}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial ref={screenMatRef} map={ad} transparent toneMapped={false} depthWrite={false} />
          </mesh>
          {/* the frame, then both names, then the message beneath */}
          <mesh position={[0, 0, 0.008]}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial ref={frameMatRef} map={frameTex} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, SCREEN_H * 0.19, 0.012]}>
            <planeGeometry args={text.nameSize} />
            <meshBasicMaterial ref={nameMatRef} map={text.names.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, -SCREEN_H * 0.17, 0.012]}>
            <planeGeometry args={text.bodySize} />
            <meshBasicMaterial ref={bodyMatRef} map={text.body.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh position={[0, -SCREEN_H * 0.36, 0.012]}>
            <planeGeometry args={fitPlane(groan.aspect, 0.6, 0.1)} />
            <meshBasicMaterial ref={groanMatRef} map={groan.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>

        {/* the stand */}
        <instancedMesh ref={crowdRef} args={[undefined, undefined, CROWD]} geometry={crowdGeo} frustumCulled={false}>
          <meshLambertMaterial vertexColors />
        </instancedMesh>

        {/* the roving camera's pool of light, sliding across the crowd */}
        <mesh ref={spotRef} position={[0, -0.24, 0.6]}>
          <circleGeometry args={[0.42, 32]} />
          <meshBasicMaterial ref={spotMatRef} map={HINT} color={st.flood} transparent opacity={0.24} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>

        {/* the two of you, in row whatever */}
        <group ref={boxRef} position={[YOU_X, -0.28, 0.62]}>
          {[-0.06, 0.06].map((x, i) => (
            <mesh key={i} position={[x, 0, 0]} geometry={crowdGeo} scale={0.075}>
              <meshStandardMaterial color={i ? "#e8d7c0" : "#d46a72"} roughness={0.8} />
            </mesh>
          ))}
        </group>

        {/* confetti from the tier above */}
        {confetti.map((f, i) => (
          <mesh
            key={i}
            ref={(m) => {
              confettiRefs.current[i] = m;
            }}
            visible={false}
          >
            <planeGeometry args={[1, 1.7]} />
            <meshBasicMaterial color={f.hue} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        ))}

        <mesh position={[0, -0.24, 1]}>
          <planeGeometry args={[1.4, 1.4]} />
          <meshBasicMaterial ref={hintMatRef} map={HINT} color={st.flood} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 1.6]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[12, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
