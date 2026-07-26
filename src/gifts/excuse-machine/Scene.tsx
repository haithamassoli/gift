import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { pick } from "../catalog";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
// `claw-machine` already owns the neon arcade cabinet. This one is dim, chrome
// and lonely — one bulb, an empty room, nobody watching.
const CABINETS: Record<string, { body: string; trim: string; rough: number; metal: number; bulb: string; room: string }> = {
  chrome: { body: "#8e959c", trim: "#cfd6dd", rough: 0.26, metal: 0.94, bulb: "#ffe9b8", room: "#15181c" },
  cherry: { body: "#5c2320", trim: "#c9a15a", rough: 0.42, metal: 0.35, bulb: "#ffd7a0", room: "#1a1312" },
  brass: { body: "#9a7434", trim: "#e0c07a", rough: 0.34, metal: 0.88, bulb: "#fff0c4", room: "#191510" },
};
const SYMBOLS: Record<string, string[]> = {
  fruit: ["🍒", "🍋", "🍇"],
  hearts: ["♥", "♡", "♥"],
  question: ["?", "?!", "??"],
};

const TAU = Math.PI * 2;
const SEGMENTS = 6; // faces around each reel
const REEL_R = 0.34;
const REEL_W = 0.42;
const ACTION_W = 2.6;
const ACTION_H = 2.9;

/* ---------- the excuses ---------- */
// Three columns that are supposed to line up and never once do. The sender's real
// message is not in here: the joke has to survive a completely sincere one.
const EXCUSES: Record<Lang, [string[], string[], string[]]> = {
  en: [
    ["I WAS", "THERE WAS", "MY PHONE", "THE CAT", "I THOUGHT", "TIME ITSELF"],
    ["STUCK IN", "ACTUALLY", "EATEN BY", "PRETTY MUCH", "SOMEHOW", "DEFINITELY"],
    ["TRAFFIC", "ASLEEP", "THE CAT", "ON FIRE", "A TUESDAY", "NOT MY FAULT"],
  ],
  ar: [
    ["كنتُ", "كان هناك", "هاتفي", "القطة", "ظننتُ", "الوقت نفسه"],
    ["عالقًا في", "في الحقيقة", "أكلها", "تقريبًا", "بطريقةٍ ما", "بالتأكيد"],
    ["الزحمة", "نائمًا", "القطة", "يحترق", "يوم ثلاثاء", "ليس ذنبي"],
  ],
};

/**
 * One reel: SEGMENTS panels of text laid side by side around a cylinder. The strip
 * runs along u (the way round), which is the axis the reel actually turns on — a
 * vertical strip would scroll the wrong way and no amount of rotation fixes it.
 */
function buildReel(words: string[], symbol: string, ink: string, lang: Lang): THREE.CanvasTexture {
  const cw = 384;
  const ch = 200;
  const c = document.createElement("canvas");
  c.width = cw * SEGMENTS;
  c.height = ch;
  const g = c.getContext("2d")!;
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "'Helvetica Neue', Arial, sans-serif";
  for (let i = 0; i < SEGMENTS; i++) {
    const x0 = i * cw;
    g.fillStyle = i % 2 ? "#f4efe4" : "#fbf7ee";
    g.fillRect(x0, 0, cw, ch);
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x0, ch);
    g.stroke();
    // One fillText per panel, so shaping and bidi are the canvas's problem.
    if (ar) g.direction = "rtl";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = ink;
    const word = words[i % words.length];
    let size = 46;
    g.font = `700 ${size}px ${fam}`;
    while (g.measureText(word).width > cw * 0.84 && size > 18) {
      size -= 2;
      g.font = `700 ${size}px ${fam}`;
    }
    g.fillText(word, x0 + cw / 2, ch * 0.42);
    g.font = `400 40px ${fam}`;
    g.fillText(symbol, x0 + cw / 2, ch * 0.78);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const reelGeo = new THREE.CylinderGeometry(REEL_R, REEL_R, REEL_W, 44, 1, true);
const SEG = TAU / SEGMENTS;
const HINT = makeRadialSprite(64);

/* ---------- opening ---------- */
const PULLS = 3; // three, and then it stops trying
const SPIN_DUR = 1.5;
const SNAP_K = 9; // how hard the detent grabs, once the spin has died
const GIVE_UP = 0.9; // seconds of buzzing before the reels drop out of true
const SLIP_END = 1.7;
const SLIP_DUR = 1.4; // the reels falling away
const COIN_AT = 2.4;
const POST_END = 4.2;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function ExcuseMachineScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const cab = CABINETS[variants.cabinet] ?? CABINETS.chrome;
  const symbols = SYMBOLS[variants.reels] ?? SYMBOLS.fruit;

  const reels = useMemo(() => {
    const cols = EXCUSES[lang];
    return cols.map((words, i) => buildReel(words, symbols[i], "#231f1c", lang));
  }, [lang, symbols]);
  useEffect(() => () => reels.forEach((t) => t.dispose()), [reels]);

  /* The printed slip in the payout tray — the only honest thing in the cabinet. */
  const slip = useMemo(() => {
    const body = message.trim() || forRecipient(lang, recipientName);
    const t = makeTextTexture(body, {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: "700",
      fontSize: 54,
      color: "#26221d",
      maxWidthPx: 54 * 9,
      lineHeight: 1.32,
      padding: 22,
      lang,
    });
    const n = makeTextTexture(`${senderName || "—"}  ·  ${recipientName || "—"}`, {
      fontFamily: "'Courier New', Courier, monospace",
      fontWeight: "700",
      fontSize: 34,
      color: "#6a5f52",
      maxWidthPx: 34 * 16,
      padding: 10,
      lang,
    });
    return { t, n, size: fitPlane(t.aspect, 0.96, 0.42), nSize: fitPlane(n.aspect, 0.72, 0.07) };
  }, [message, senderName, recipientName, lang]);
  useEffect(
    () => () => {
      slip.t.texture.dispose();
      slip.n.texture.dispose();
    },
    [slip],
  );

  const header = useMemo(
    () =>
      makeTextTexture(pick(lang, "EXCUSES", "أعذار"), {
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
        fontWeight: "700",
        fontSize: 60,
        color: cab.trim,
        maxWidthPx: 60 * 10,
        padding: 12,
        lang,
      }),
    [lang, cab],
  );
  useEffect(() => () => header.texture.dispose(), [header]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* Each reel carries an angle and a spin speed; `stops` are the three offsets the
     rig lands on, which are chosen so no two ever agree. */
  const g = useRef({
    pulls: 0,
    lever: 0,
    down: false,
    py: 0,
    ang: [0, 0, 0],
    vel: [0, 0, 0],
    target: [0, 0, 0],
    spinning: false,
    spunAt: 0,
    gaveUpAt: -1,
    touched: false,
  });
  useEffect(() => {
    if (phase !== "opening") return;
    g.current = { pulls: 0, lever: 0, down: false, py: 0, ang: [0, 0, 0], vel: [0, 0, 0], target: [0, 0, 0], spinning: false, spunAt: 0, gaveUpAt: -1, touched: false };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const reelRefs = useRef<(THREE.Mesh | null)[]>([]);
  const reelGroupRefs = useRef<(THREE.Group | null)[]>([]);
  const leverRef = useRef<THREE.Group>(null);
  const slipRef = useRef<THREE.Group>(null);
  const slipMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const coinRef = useRef<THREE.Group>(null);
  const trayLightRef = useRef<THREE.PointLight>(null);
  const bulbRef = useRef<THREE.PointLight>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);

  /** Pull. Reels spin up, then snap to three offsets that were never going to match. */
  const pull = () => {
    const c = g.current;
    if (c.spinning || c.gaveUpAt >= 0) return;
    c.pulls += 1;
    c.spinning = true;
    c.spunAt = tRef.current;
    const rand = mulberry32(1301 + c.pulls * 97);
    for (let i = 0; i < 3; i++) {
      c.vel[i] = 16 + rand() * 8 + i * 2.5;
      // The rig: pull 1 and 2 land on deliberately different segments, and by pull
      // 3 they are not even trying to be a sentence.
      const seg = c.pulls >= 3 ? Math.floor(rand() * SEGMENTS) : (i * 2 + c.pulls) % SEGMENTS;
      c.target[i] = Math.ceil(c.ang[i] / TAU + 2 + i * 0.4) * TAU + seg * SEG;
    }
    clack({ freq: 420, decay: 0.16, gain: 0.34 });
  };

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.gaveUpAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.current.down = true;
    g.current.touched = true;
    g.current.py = ev.point.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening") return;
    ev.stopPropagation();
    c.lever = clamp01(c.lever + (c.py - ev.point.y) / 0.9);
    c.py = ev.point.y;
    if (c.lever >= 1 && !c.spinning) {
      pull();
      c.down = false;
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
      fitRef.current.scale.setScalar(Math.max(0.58, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- the reels ---- */
    if (phase === "opening") {
      let allStopped = true;
      for (let i = 0; i < 3; i++) {
        if (c.spinning) {
          const age = tRef.current - c.spunAt - i * 0.28;
          if (age < SPIN_DUR) {
            c.ang[i] += c.vel[i] * dt;
            allStopped = false;
          } else {
            // Rotation snap, the astrolabe way: ease onto the detent, do not teleport.
            const before = c.ang[i];
            c.ang[i] = lerp(c.ang[i], c.target[i], Math.min(1, dt * SNAP_K));
            if (Math.abs(c.ang[i] - c.target[i]) > 0.01) allStopped = false;
            else if (Math.abs(before - c.target[i]) > 0.01) clack({ freq: 1300, decay: 0.06, gain: 0.2 });
          }
        }
      }
      if (c.spinning && allStopped) {
        c.spinning = false;
        c.lever = 0;
        if (c.pulls >= PULLS) {
          c.gaveUpAt = tRef.current;
          // It buzzes. It is not a jackpot noise.
          tone(110, { type: "square", seconds: GIVE_UP, gain: 0.2 });
        }
      }
    } else if (phase === "sealed") {
      // idling, out of true, the way a machine nobody is playing sits
      for (let i = 0; i < 3; i++) c.ang[i] = i * 0.9 + Math.sin(e * 0.3 + i) * 0.05;
    } else {
      for (let i = 0; i < 3; i++) c.ang[i] = i * 1.7 + 0.4;
    }

    const post = phase === "revealed" ? POST_END : c.gaveUpAt >= 0 ? tRef.current - c.gaveUpAt : -1;
    // Once it has given up, the reels lose alignment entirely and then fall away.
    const slipOut = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01((post - GIVE_UP) / SLIP_DUR));

    for (let i = 0; i < 3; i++) {
      const m = reelRefs.current[i];
      const grp = reelGroupRefs.current[i];
      if (m) m.rotation.y = c.ang[i];
      if (grp) {
        // out of true first — each one tips a different way — then gone
        const drop = phase === "revealed" ? 1 : post < 0 ? 0 : clamp01((post - GIVE_UP * 0.4) / SLIP_END);
        grp.rotation.z = drop * (i - 1) * 0.34;
        grp.position.y = 0.22 - easeOutCubic(slipOut) * 1.9;
        grp.visible = slipOut < 0.995;
      }
    }

    /* ---- the lever ---- */
    if (leverRef.current) {
      const rest = phase === "opening" ? c.lever : phase === "sealed" ? 0 : 0.12;
      leverRef.current.rotation.x = lerp(leverRef.current.rotation.x, rest * 1.15, Math.min(1, dt * (c.down ? 22 : 7)));
    }

    /* ---- the payout tray ---- */
    if (slipRef.current) {
      const k = phase === "preview" ? 1 : post < 0 ? 0 : smooth(clamp01((post - GIVE_UP - 0.5) / 1.1));
      slipRef.current.visible = k > 0.01;
      slipRef.current.position.y = lerp(-0.86, -0.66, k);
      for (const m of slipMats.current) if (m) m.opacity = k;
    }
    if (trayLightRef.current) {
      const k = phase === "preview" ? 1 : post < 0 ? 0 : clamp01((post - GIVE_UP - 0.4) / 0.8);
      trayLightRef.current.intensity = k * 2.2;
    }
    /* ---- one sad coin, which rolls out and falls over ---- */
    if (coinRef.current) {
      const k = phase === "revealed" ? 1 : post < 0 ? 0 : clamp01((post - COIN_AT) / 1.2);
      coinRef.current.visible = k > 0.01;
      coinRef.current.position.x = lerp(-0.06, 0.34, easeOutCubic(k));
      coinRef.current.rotation.z = -easeOutCubic(k) * 5.2;
      // it makes it about two thirds of the way and then just lies down
      coinRef.current.rotation.x = clamp01((k - 0.62) / 0.38) * (Math.PI / 2);
    }

    /* ---- the one bulb that still works ---- */
    if (bulbRef.current) {
      const flick = 0.7 + 0.3 * (Math.sin(e * 11) > -0.7 ? 1 : 0.2);
      bulbRef.current.intensity = 7 * flick;
    }
    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.36 + 0.22 * Math.sin(e * 2.8) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.05, 3.0]} fov={44} onUpdate={(c) => c.lookAt(0, -0.05, 0)} />
      <ambientLight intensity={0.4} />
      <pointLight ref={bulbRef} position={[0.1, 1.5, 1.5]} intensity={7} color={cab.bulb} distance={9} decay={1.1} />
      <pointLight ref={trayLightRef} position={[0, -0.72, 0.5]} intensity={0} color="#ffe6a8" distance={2.4} decay={1.5} />

      {/* the empty room */}
      <mesh position={[0, 0, -1.4]}>
        <planeGeometry args={[16, 11]} />
        <meshStandardMaterial color={cab.room} roughness={0.95} />
      </mesh>
      <mesh position={[0, -1.35, 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[16, 6]} />
        <meshStandardMaterial color="#0e1013" roughness={0.9} />
      </mesh>

      <group ref={fitRef}>
        {/* the cabinet */}
        <mesh position={[0, -0.1, -0.24]}>
          <boxGeometry args={[1.42, 2.1, 0.5]} />
          <meshStandardMaterial color={cab.body} roughness={cab.rough} metalness={cab.metal} />
        </mesh>
        {/* the crown */}
        <mesh position={[0, 1.02, -0.18]}>
          <boxGeometry args={[1.5, 0.34, 0.4]} />
          <meshStandardMaterial color={cab.trim} roughness={cab.rough * 0.8} metalness={cab.metal} />
        </mesh>
        <mesh position={[0, 1.02, 0.03]}>
          <planeGeometry args={[0.86, 0.19]} />
          <meshBasicMaterial map={header.texture} transparent depthWrite={false} toneMapped={false} />
        </mesh>

        {/* the window the reels sit behind */}
        <mesh position={[0, 0.22, 0.015]}>
          <planeGeometry args={[1.18, 0.62]} />
          <meshBasicMaterial color="#08090b" />
        </mesh>

        {[-0.38, 0, 0.38].map((x, i) => (
          <group
            key={i}
            ref={(el) => {
              reelGroupRefs.current[i] = el;
            }}
            position={[x, 0.22, 0.05]}
          >
            {/* axis along x: the reel turns on its own local y inside a tipped group */}
            <group rotation={[0, 0, Math.PI / 2]}>
              <mesh
                ref={(m) => {
                  reelRefs.current[i] = m;
                }}
                geometry={reelGeo}
              >
                <meshStandardMaterial map={reels[i]} roughness={0.55} side={THREE.DoubleSide} />
              </mesh>
            </group>
          </group>
        ))}

        {/* the window's glass and its shadowed lip, over the reels */}
        <mesh position={[0, 0.22, 0.3]}>
          <planeGeometry args={[1.18, 0.62]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.05} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0.56, 0.31]}>
          <planeGeometry args={[1.2, 0.09]} />
          <meshBasicMaterial color="#000000" transparent opacity={0.5} depthWrite={false} />
        </mesh>

        {/* the payout tray */}
        <mesh position={[0, -0.86, 0.06]}>
          <boxGeometry args={[1.06, 0.4, 0.34]} />
          <meshStandardMaterial color="#141619" roughness={0.85} />
        </mesh>

        <group ref={slipRef} position={[0, -0.86, 0.26]} visible={false}>
          <mesh rotation={[-0.42, 0, 0.02]}>
            <planeGeometry args={[1.06, 0.66]} />
            <meshStandardMaterial color="#f6f1e4" roughness={0.85} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, 0.07, 0.012]} rotation={[-0.42, 0, 0.02]}>
            <planeGeometry args={slip.size} />
            <meshBasicMaterial
              ref={(m) => {
                slipMats.current[0] = m;
              }}
              map={slip.t.texture}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, -0.24, 0.014]} rotation={[-0.42, 0, 0.02]}>
            <planeGeometry args={slip.nSize} />
            <meshBasicMaterial
              ref={(m) => {
                slipMats.current[1] = m;
              }}
              map={slip.n.texture}
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>

        {/* the coin */}
        <group ref={coinRef} position={[-0.06, -1.02, 0.3]} visible={false}>
          <mesh rotation={[0, 0, 0]}>
            <cylinderGeometry args={[0.07, 0.07, 0.012, 22]} />
            <meshStandardMaterial color="#b9a05e" roughness={0.35} metalness={0.9} />
          </mesh>
        </group>

        {/* the lever, hinged at the cabinet's flank */}
        <group position={[0.86, 0.28, 0]}>
          <mesh>
            <sphereGeometry args={[0.075, 14, 12]} />
            <meshStandardMaterial color={cab.trim} roughness={0.3} metalness={0.8} />
          </mesh>
          <group ref={leverRef}>
            <mesh position={[0, 0.24, 0]}>
              <cylinderGeometry args={[0.028, 0.028, 0.48, 12]} />
              <meshStandardMaterial color={cab.trim} roughness={0.28} metalness={0.9} />
            </mesh>
            <mesh position={[0, 0.5, 0]}>
              <sphereGeometry args={[0.085, 18, 14]} />
              <meshStandardMaterial color="#b8362f" roughness={0.34} metalness={0.25} />
            </mesh>
            <mesh position={[0, 0.5, 0]}>
              <planeGeometry args={[0.52, 0.52]} />
              <meshBasicMaterial ref={hintMatRef} map={HINT} color="#ffcf8a" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
            </mesh>
          </group>
        </group>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 1.2]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
