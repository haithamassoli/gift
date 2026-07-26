import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
// We sit on the audience side of a lit sheet, so the lamp is only ever its glow
// through the linen: colour, how wide the hotspot spreads, and how badly it gutters.
const LAMPS: Record<string, { warm: string; core: string; spread: number; gutter: number; rate: number }> = {
  oil: { warm: "#ffb765", core: "#fff0cf", spread: 0.62, gutter: 0.16, rate: 2.1 },
  candle: { warm: "#ff9a45", core: "#ffe0ae", spread: 0.48, gutter: 0.26, rate: 5.4 },
  gas: { warm: "#dfe9c9", core: "#ffffff", spread: 0.74, gutter: 0.05, rate: 1.2 },
};
const SCREENS: Record<string, { tint: string; weave: number; grain: number }> = {
  linen: { tint: "#e8d6b2", weave: 12, grain: 0.16 },
  silk: { tint: "#f2e2cd", weave: 26, grain: 0.06 },
  paper: { tint: "#efe6d2", weave: 0, grain: 0.24 },
};

const SCREEN_W = 3.05;
const SCREEN_H = 1.95;
const ACTION_W = 3.35;
const ACTION_H = 2.45;

/** The lit sheet: weave, grain, and the lamp's hotspot burnt into the middle. */
function buildScreen(tint: string, weave: number, grain: number, warm: string, spread: number): THREE.CanvasTexture {
  const w = 512;
  const h = 340;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = tint;
  g.fillRect(0, 0, w, h);
  // the lamp behind, seen through the cloth
  const hot = g.createRadialGradient(w / 2, h * 0.56, 0, w / 2, h * 0.56, w * spread);
  hot.addColorStop(0, "rgba(255,255,255,0.95)");
  hot.addColorStop(0.45, "rgba(255,236,196,0.4)");
  hot.addColorStop(1, "rgba(60,34,18,0.5)");
  g.fillStyle = hot;
  g.fillRect(0, 0, w, h);
  if (weave > 0) {
    g.strokeStyle = "rgba(90,62,32,0.13)";
    g.lineWidth = 1;
    for (let x = 0; x < w; x += weave) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y < h; y += weave) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
  }
  const rand = mulberry32(6131);
  g.fillStyle = warm;
  for (let i = 0; i < 2600; i++) {
    g.globalAlpha = rand() * grain * 0.5;
    g.fillRect(rand() * w, rand() * h, 2, 2);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- the puppets: flat cut-outs, three hinges each ---------- */
// خيال الظل puppets are jointed leather, and from the audience they are pure
// silhouette — so these are plain dark shapes and there is not a shadow map in
// sight. Alpha-tested cutouts fringe under one; flat quads never can.
const headGeo = new THREE.CircleGeometry(0.088, 20);
const torsoGeo = new THREE.PlaneGeometry(0.14, 0.34);
const limbGeo = new THREE.PlaneGeometry(0.048, 0.24);
const hatGeo = new THREE.CircleGeometry(0.062, 3);
const rodGeo = new THREE.PlaneGeometry(0.012, 1.1);

/** The handle a posed puppet exposes: the parent's useFrame drives it through this
 *  and never reaches into the puppet's own refs, which is both tidier and the only
 *  way the hooks lint will let a child's refs be touched from outside. */
export interface PuppetHandle {
  /** `x` where it stands, `met` 0 apart → 1 overlapped, `ph` the walk cycle's phase,
   *  `flip` mirrors the second one so the pair face each other. */
  pose(x: number, met: number, ph: number, flip: 1 | -1): void;
}

/** One jointed silhouette. The hinge pairs swing out of phase, which is the whole walk. */
const Puppet = forwardRef<PuppetHandle, { hat: boolean; ink: THREE.Material }>(function Puppet(
  { hat, ink },
  handle,
) {
  const rootRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const armRef = useRef<THREE.Group>(null);
  const arm2Ref = useRef<THREE.Group>(null);
  const legRef = useRef<THREE.Group>(null);
  const leg2Ref = useRef<THREE.Group>(null);

  useImperativeHandle(handle, () => ({
    pose(x, met, ph, flip) {
      if (rootRef.current) {
        rootRef.current.position.x = x;
        // Nearer the lamp's centre is bigger — the sheet is the lamp's plane. And
        // as the two overlap they shrink into the words that replace them.
        const near = 1 - Math.abs(x) / (SCREEN_W * 0.6);
        // They do not fade — nothing here can, the ink is one shared material — they
        // shrink away to nothing as the words take the place they were standing in.
        const s = lerp(0.92, 1.1, clamp01(near)) * lerp(1, 0.04, met);
        rootRef.current.scale.set(s * flip, s, s); // x only: a uniform -1 inverts it
      }
      const swing = Math.sin(ph) * (1 - met) * 0.7;
      if (armRef.current) armRef.current.rotation.z = swing * 0.9 + met * 0.9;
      if (arm2Ref.current) arm2Ref.current.rotation.z = -swing * 0.9;
      if (legRef.current) legRef.current.rotation.z = -swing;
      if (leg2Ref.current) leg2Ref.current.rotation.z = swing;
      if (bodyRef.current) bodyRef.current.rotation.z = Math.sin(ph * 2) * (1 - met) * 0.05;
    },
  }));

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        <mesh geometry={headGeo} position={[0, 0.29, 0]} material={ink} />
        {hat ? <mesh geometry={hatGeo} position={[0, 0.4, 0]} material={ink} /> : null}
        <mesh geometry={torsoGeo} position={[0, 0.05, 0]} material={ink} />
        <group ref={armRef} position={[-0.05, 0.19, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
        <group ref={arm2Ref} position={[0.05, 0.19, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
        <group ref={legRef} position={[-0.04, -0.11, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
        <group ref={leg2Ref} position={[0.04, -0.11, 0]}>
          <mesh geometry={limbGeo} position={[0, -0.12, 0]} material={ink} />
        </group>
      </group>
      {/* the rod the puppeteer holds — its shadow is where the names land */}
      <mesh geometry={rodGeo} position={[0, -0.78, 0]} material={ink} />
    </group>
  );
});

const DUST_TEX = makeRadialSprite(32);
const DUST = 70;

/* ---------- opening ---------- */
const MEET_TRAVEL = 1.9; // world units of drag that walk your puppet to the middle
const RESOLVE = 0.9; // seconds from the meeting to the words
const POST_END = 2.4;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function ShadowPlayScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const lamp = LAMPS[variants.lamp] ?? LAMPS.oil;
  const screen = SCREENS[variants.screen] ?? SCREENS.linen;

  const screenTex = useMemo(
    () => buildScreen(screen.tint, screen.weave, screen.grain, lamp.warm, lamp.spread),
    [screen, lamp],
  );
  useEffect(() => () => screenTex.dispose(), [screenTex]);

  // DoubleSide is load-bearing: the second puppet is a mirrored (negative-x) copy,
  // and a negative scale reverses the winding — on FrontSide it would disappear.
  const ink = useMemo(
    () => new THREE.MeshBasicMaterial({ color: "#1a0f08", transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    [],
  );
  useEffect(() => () => ink.dispose(), [ink]);

  /* The words are written with absence: dark where the two outlines overlap. */
  const text = useMemo(() => {
    const body = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    const msg = makeTextTexture(body, {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: "700",
      fontSize: 82,
      color: "#150c06",
      maxWidthPx: 82 * 9,
      lineHeight: 1.3,
      padding: 24,
      lang,
    });
    const mk = (n: string) =>
      makeTextTexture(n || "—", {
        fontFamily: "Georgia, serif",
        fontWeight: "600",
        fontSize: 40,
        color: "#150c06",
        maxWidthPx: 40 * 9,
        padding: 10,
        lang,
      });
    const a = mk(recipientName);
    const b = mk(senderName);
    return {
      msg,
      a,
      b,
      msgSize: fitPlane(msg.aspect, SCREEN_W * 0.72, SCREEN_H * 0.5),
      aSize: fitPlane(a.aspect, 0.5, 0.1),
      bSize: fitPlane(b.aspect, 0.5, 0.1),
    };
  }, [message, senderName, recipientName, lang]);
  useEffect(
    () => () => {
      text.msg.texture.dispose();
      text.a.texture.dispose();
      text.b.texture.dispose();
    },
    [text],
  );

  const dust = useMemo(() => {
    const rand = mulberry32(1729);
    const pos = new Float32Array(DUST * 3);
    const spd = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      pos[i * 3] = (rand() - 0.5) * SCREEN_W;
      pos[i * 3 + 1] = (rand() - 0.5) * SCREEN_H;
      pos[i * 3 + 2] = 0.1 + rand() * 0.5;
      spd[i] = 0.02 + rand() * 0.06;
    }
    return { pos, spd };
  }, []);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const g = useRef({ walk: 0, metAt: -1, down: false, px: 0, touched: false });
  useEffect(() => {
    if (phase === "opening") g.current = { walk: 0, metAt: -1, down: false, px: 0, touched: false };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const yoursRef = useRef<PuppetHandle>(null);
  const theirsRef = useRef<PuppetHandle>(null);
  const screenMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const glowRef = useRef<THREE.PointLight>(null);
  const msgMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const nameMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const dustRef = useRef<THREE.Points>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.metAt >= 0) return;
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
    if (!c.down || phase !== "opening" || c.walk >= 1) return;
    ev.stopPropagation();
    // Toward the middle walks it on; away lets it back off, so the walk is a walk
    // and not a ratchet.
    c.walk = clamp01(c.walk + (c.px - ev.point.x) / MEET_TRAVEL);
    c.px = ev.point.x;
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
      fitRef.current.scale.setScalar(Math.max(0.6, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- how far the pair has closed ---- */
    let walk: number;
    if (phase === "opening") {
      if (c.walk >= 1 && c.metAt < 0) {
        c.metAt = tRef.current;
        tone(392, { type: "triangle", seconds: 1.1, gain: 0.2, shimmer: true });
      }
      walk = c.walk;
    } else if (phase === "sealed") {
      walk = 0;
    } else if (phase === "preview") {
      walk = 0.62 + Math.sin(e * 0.7) * 0.14; // one still waiting, one nearly there
    } else {
      walk = 1;
    }

    const post = phase === "revealed" ? POST_END : c.metAt >= 0 ? tRef.current - c.metAt : -1;
    const resolve = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / RESOLVE));

    /* ---- the two walk toward each other; theirs starts off-frame ---- */
    // Distance walked drives the cycle, so the legs and the drag never disagree.
    // The overlap does not darken: as the two meet they shrink away into the shape
    // the words take, which is the same ink and the same place on the sheet.
    const ax = lerp(SCREEN_W * 0.36, 0.1, walk) * (1 - resolve * 0.9);
    const bx = lerp(-SCREEN_W * 0.78, -0.1, smooth(walk)) * (1 - resolve * 0.9);
    yoursRef.current?.pose(ax, resolve, walk * 16, 1);
    theirsRef.current?.pose(bx, resolve, walk * 16 + Math.PI, -1);

    if (msgMatRef.current) msgMatRef.current.opacity = phase === "preview" ? 0 : resolve * 0.94;
    for (const m of nameMats.current) if (m) m.opacity = resolve * 0.9;

    /* ---- the lamp gutters until the story lands, then steadies ---- */
    const flick = 1 - lamp.gutter * (0.5 + 0.5 * Math.sin(e * lamp.rate) * Math.sin(e * lamp.rate * 2.7)) * (1 - resolve);
    if (screenMatRef.current) {
      const m = screenMatRef.current;
      m.color.setScalar(flick);
      m.opacity = 1;
    }
    if (glowRef.current) glowRef.current.intensity = 0.9 * flick + 0.3 * resolve;

    /* ---- dust drifting through the beam ---- */
    if (dustRef.current) {
      const arr = dustRef.current.geometry.attributes.position;
      for (let i = 0; i < DUST; i++) {
        let y = arr.getY(i) + dust.spd[i] * dt;
        if (y > SCREEN_H / 2) y = -SCREEN_H / 2;
        arr.setY(i, y);
        arr.setX(i, arr.getX(i) + Math.sin(e * 0.6 + i) * dt * 0.02);
      }
      arr.needsUpdate = true;
    }

    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.3 + 0.2 * Math.sin(e * 2.8) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0, 2.55]} fov={44} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.9} />
      <pointLight ref={glowRef} position={[0, 0, -1.4]} intensity={0.9} color={lamp.core} distance={7} decay={1.3} />

      {/* the dark theatre around the sheet */}
      <mesh position={[0, 0, -0.5]}>
        <planeGeometry args={[14, 10]} />
        <meshBasicMaterial color="#0b0705" depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        {/* the screen — one quad, lit from behind, and everything else is a silhouette on it */}
        <mesh>
          <planeGeometry args={[SCREEN_W, SCREEN_H]} />
          <meshBasicMaterial ref={screenMatRef} map={screenTex} toneMapped={false} />
        </mesh>
        {/* batten and frame */}
        <mesh position={[0, SCREEN_H / 2 + 0.045, 0.02]}>
          <planeGeometry args={[SCREEN_W + 0.16, 0.09]} />
          <meshBasicMaterial color="#2a1a10" />
        </mesh>
        <mesh position={[0, -SCREEN_H / 2 - 0.045, 0.02]}>
          <planeGeometry args={[SCREEN_W + 0.16, 0.09]} />
          <meshBasicMaterial color="#2a1a10" />
        </mesh>

        {/* the words, in shadow, where the overlap was */}
        <mesh position={[0, 0.04, 0.08]}>
          <planeGeometry args={text.msgSize} />
          <meshBasicMaterial ref={msgMatRef} map={text.msg.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>

        {/* both names, down in the rods' shadows */}
        <mesh position={[-0.62, -SCREEN_H * 0.38, 0.08]}>
          <planeGeometry args={text.bSize} />
          <meshBasicMaterial
            ref={(m) => {
              nameMats.current[0] = m;
            }}
            map={text.b.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[0.62, -SCREEN_H * 0.38, 0.08]}>
          <planeGeometry args={text.aSize} />
          <meshBasicMaterial
            ref={(m) => {
              nameMats.current[1] = m;
            }}
            map={text.a.texture}
            transparent
            opacity={0}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        {/* the puppets, a hair in front of the sheet */}
        <group position={[0, 0.06, 0.05]}>
          <Puppet ref={yoursRef} hat ink={ink} />
          <Puppet ref={theirsRef} hat={false} ink={ink} />
        </group>

        {/* dust in the beam */}
        <points ref={dustRef} position={[0, 0, 0.12]}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[dust.pos, 3]} />
          </bufferGeometry>
          <pointsMaterial map={DUST_TEX} color={lamp.core} size={0.035} sizeAttenuation transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
        </points>

        <mesh position={[SCREEN_W * 0.34, 0.06, 0.14]}>
          <planeGeometry args={[0.6, 0.9]} />
          <meshBasicMaterial ref={hintMatRef} map={DUST_TEX} color={lamp.core} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 0.6]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
