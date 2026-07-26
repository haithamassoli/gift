import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, lerp, mulberry32, smooth } from "../math";
import { resumeAudio, swell, tone } from "../audio";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- variants ---------- */
const ROCKS: Record<string, { base: string; fleck: string; rough: number; metal: number; lump: number }> = {
  granite: { base: "#7d7a78", fleck: "#c8c4bd", rough: 0.88, metal: 0.06, lump: 1 },
  sandstone: { base: "#b98f5f", fleck: "#e3c69a", rough: 0.95, metal: 0, lump: 0.7 },
  geode: { base: "#5b4f68", fleck: "#c9a7ff", rough: 0.45, metal: 0.22, lump: 1.2 },
};
type EyeKind = "googly" | "sleepy" | "heart";
const EYES: Record<string, EyeKind> = { googly: "googly", sleepy: "sleepy", heart: "heart" };

const TAU = Math.PI * 2;
const ACTION_W = 2.9;
const ACTION_H = 2.3;

/* ---------- the rock: a noise-displaced sphere, built once ---------- */
function buildRock(lump: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.5, 40, 28);
  const pos = geo.attributes.position;
  const rand = mulberry32(1618);
  // Four fixed lobes, so the same rock every time — this rock is somebody's pet
  // and it does not get to be a different shape on reload.
  const lobes = Array.from({ length: 5 }, () => ({
    x: rand() * 2 - 1,
    y: rand() * 2 - 1,
    z: rand() * 2 - 1,
    k: 0.06 + rand() * 0.1,
    f: 1.4 + rand() * 2.6,
  }));
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let d = 0;
    for (const l of lobes) d += Math.sin(v.x * l.f + l.x * 4) * Math.cos(v.y * l.f + l.y * 4) * Math.sin(v.z * l.f + l.z * 4) * l.k;
    v.multiplyScalar(1 + d * lump);
    v.y *= 0.86; // it sits, it does not roll away
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Speckled stone, so the rock is a rock and not a grey ball. */
function buildSpeckle(base: string, fleck: string): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(2357);
  for (let i = 0; i < 5200; i++) {
    g.globalAlpha = 0.1 + rand() * 0.5;
    g.fillStyle = rand() > 0.5 ? fleck : "#3a3632";
    const r = 1 + rand() * 3;
    g.beginPath();
    g.arc(rand() * s, rand() * s, r, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

/** Cardboard, with the breathing holes it does not need. */
function buildCardboard(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#b48a5c";
  g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(120,86,52,0.4)";
  g.lineWidth = 2;
  for (let y = 0; y < s; y += 7) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(s, y);
    g.stroke();
  }
  g.fillStyle = "#3a2a1a";
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.arc(s * (0.2 + i * 0.15), s * 0.32, s * 0.022, 0, TAU);
    g.fill();
  }
  return new THREE.CanvasTexture(c);
}
const CARDBOARD = buildCardboard();

/** Straw: short instanced-free strokes baked straight into a texture. */
function buildStraw(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#8a6a3c";
  g.fillRect(0, 0, s, s);
  const rand = mulberry32(97);
  for (let i = 0; i < 500; i++) {
    g.strokeStyle = `hsl(${38 + rand() * 14} ${45 + rand() * 25}% ${44 + rand() * 30}%)`;
    g.lineWidth = 1 + rand() * 1.6;
    const x = rand() * s;
    const y = rand() * s;
    const a = rand() * TAU;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * 26, y + Math.sin(a) * 26);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}
const STRAW = buildStraw();

const eyeGeo = new THREE.SphereGeometry(0.088, 18, 14);
const pupilGeo = new THREE.SphereGeometry(0.042, 14, 10);
const lidGeo = new THREE.CircleGeometry(0.096, 18);
/* A heart, for the variant that has them instead of pupils. */
const heartShape = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, -0.045);
  s.bezierCurveTo(0.06, 0.02, 0.055, 0.06, 0.022, 0.06);
  s.bezierCurveTo(0.008, 0.06, 0.002, 0.05, 0, 0.042);
  s.bezierCurveTo(-0.002, 0.05, -0.008, 0.06, -0.022, 0.06);
  s.bezierCurveTo(-0.055, 0.06, -0.06, 0.02, 0, -0.045);
  return new THREE.ShapeGeometry(s, 8);
})();

/* ---------- opening ---------- */
const PURR_STEP = 0.42; // seconds between purr bursts while a hand is on it
const MIN_PET = 1.6; // it will not roll over for anyone who has not put the time in
const ROLL_DUR = 1.1;
const PAPERS_AT = 0.75; // after the roll: the certificate slides in
const POST_END = 2.6;

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

/** Adoption papers. Notarised by nobody. Care instructions: three blank lines. */
function buildCertificate(sender: string, recipient: string, lang: Lang): THREE.CanvasTexture {
  const w = 560;
  const h = 400;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6efdd";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#9a7b46";
  g.lineWidth = 5;
  g.strokeRect(14, 14, w - 28, h - 28);
  g.lineWidth = 1.5;
  g.strokeRect(24, 24, w - 48, h - 48);
  const ar = lang === "ar";
  const fam = ar ? "'Thmanyah Sans', system-ui, sans-serif" : "Georgia, serif";
  if (ar) g.direction = "rtl";
  g.textAlign = "center";
  g.fillStyle = "#5b4526";
  g.font = `700 34px ${fam}`;
  g.fillText(ar ? "شهادة تبنٍّ" : "CERTIFICATE OF ADOPTION", w / 2, 84);
  g.font = `400 22px ${fam}`;
  g.fillText(ar ? "لصخرةٍ واحدة، تخصّ:" : "for one (1) rock, belonging to:", w / 2, 126);
  g.font = `600 30px ${fam}`;
  g.fillText(`${recipient || "—"}  ·  ${sender || "—"}`, w / 2, 176);
  g.font = `400 18px ${fam}`;
  g.fillText(ar ? "تعليمات العناية:" : "CARE INSTRUCTIONS:", w / 2, 224);
  // Three lines, all blank. It is the whole joke and it needs no caption.
  g.strokeStyle = "#b9a071";
  g.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    const y = 254 + i * 34;
    g.beginPath();
    g.moveTo(90, y);
    g.lineTo(w - 90, y);
    g.stroke();
  }
  g.font = `italic 400 15px ${fam}`;
  g.fillStyle = "#8a7350";
  g.fillText(ar ? "موثّقة من: لا أحد" : "notarised by: nobody", w / 2, h - 44);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export default function PetRockScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const rock = ROCKS[variants.rock] ?? ROCKS.granite;
  const eyeKind = EYES[variants.eyes] ?? "googly";

  const rockGeo = useMemo(() => buildRock(rock.lump), [rock]);
  useEffect(() => () => rockGeo.dispose(), [rockGeo]);

  const speckle = useMemo(() => buildSpeckle(rock.base, rock.fleck), [rock]);
  useEffect(() => () => speckle.dispose(), [speckle]);

  /* The message is in marker, on its belly. Nowhere else. */
  const belly = useMemo(() => {
    const body = message.trim() || forRecipient(lang, recipientName);
    const t = makeTextTexture(body, {
      fontFamily: "'Marker Felt', 'Comic Sans MS', 'Segoe Print', cursive",
      fontWeight: "600",
      fontSize: 60,
      color: "#f4f1e8",
      maxWidthPx: 60 * 8,
      lineHeight: 1.26,
      padding: 18,
      lang,
    });
    return { t, size: fitPlane(t.aspect, 0.72, 0.56) };
  }, [message, recipientName, lang]);
  useEffect(() => () => belly.t.texture.dispose(), [belly]);

  const cert = useMemo(() => buildCertificate(senderName, recipientName, lang), [senderName, recipientName, lang]);
  useEffect(() => () => cert.dispose(), [cert]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* `rub` is how much attention it has had; `pet` is total distance rubbed. */
  const g = useRef({ rub: 0, pet: 0, down: false, px: 0, purrAt: 0, semis: 0, rollAt: -1, touched: false, blink: 0, blinkAt: 1.4 });
  useEffect(() => {
    if (phase === "opening") g.current = { rub: 0, pet: 0, down: false, px: 0, purrAt: 0, semis: 0, rollAt: -1, touched: false, blink: 0, blinkAt: 1.4 };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const rollRef = useRef<THREE.Group>(null);
  const wobbleRef = useRef<THREE.Group>(null);
  const eyeRefs = useRef<(THREE.Group | null)[]>([]);
  const lidRefs = useRef<(THREE.Mesh | null)[]>([]);
  const bellyMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const certRef = useRef<THREE.Group>(null);
  const certMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lidTop = useRef<THREE.Group>(null);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening" || g.current.rollAt >= 0) return;
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
    if (!c.down || phase !== "opening" || c.rollAt >= 0) return;
    ev.stopPropagation();
    // Back and forth: distance is what counts, so a rub in either direction is a rub.
    c.pet += Math.abs(ev.point.x - c.px);
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
      fitRef.current.scale.setScalar(Math.max(0.62, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    /* ---- petting ---- */
    if (phase === "opening" && c.rollAt < 0) {
      // `pet` is *recent* travel, not total: it bleeds away, so a finger parked on
      // the rock without moving is not petting it and the purr knows.
      c.pet = Math.max(0, c.pet - dt * 0.7);
      const petting = c.down && c.pet > 0.015;
      c.rub = clamp01(c.rub + (petting ? dt * 0.42 : -dt * 0.5));
      if (petting) {
        c.purrAt -= dt;
        if (c.purrAt <= 0) {
          c.purrAt = PURR_STEP;
          // A semitone up each time, for as long as you keep going. It is delighted
          // and it is bad at hiding it.
          c.semis = Math.min(12, c.semis + 1);
          swell({
            source: "sawtooth",
            freq: 58 * Math.pow(2, c.semis / 12),
            cutoff: 340,
            attack: 0.09,
            hold: 0.16,
            release: 0.22,
            gain: 0.16,
            tremolo: 23,
            tremoloDepth: 0.75,
          });
        }
        if (c.rub >= 1 && tRef.current > MIN_PET) {
          c.rollAt = tRef.current;
          tone(659, { shimmer: true, seconds: 1.1, gain: 0.22 });
        }
      }
    }

    const post = phase === "revealed" ? POST_END : c.rollAt >= 0 ? tRef.current - c.rollAt : -1;
    const roll = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / ROLL_DUR));
    const alive = phase !== "sealed";

    /* ---- it rolls over, delighted, and the message is on its belly ---- */
    if (rollRef.current) {
      const r = rollRef.current;
      // A *negative* quarter-turn about X is what brings the underside round to the
      // camera (it maps -Y to +Z); the belly plane is then normal -Y so it ends up
      // facing us. Get either sign wrong and the rock lies down on its own message.
      r.rotation.x = -Math.PI * 0.5 * roll;
      r.position.y = roll * 0.16 + Math.sin(e * 1.4) * 0.006 * (1 - roll);
    }
    /* ---- wobble: toward the finger while petted, and one pointed wobble when you stop ---- */
    if (wobbleRef.current) {
      const w = wobbleRef.current;
      const lean = c.down ? Math.sin(e * 9) * 0.06 * c.rub : 0;
      // Stopping leaves it rocking on its own for a moment. Pointedly.
      const sulk = !c.down && c.rub > 0.05 && phase === "opening" ? Math.sin(e * 5.5) * 0.05 * c.rub : 0;
      w.rotation.z = lerp(w.rotation.z, lean + sulk, Math.min(1, dt * 8));
      w.scale.y = lerp(w.scale.y, 1 - c.rub * 0.03 * (c.down ? 1 : 0), Math.min(1, dt * 6));
    }

    /* ---- the blink. One eye slightly late, which is where the joke lives. ---- */
    c.blinkAt -= dt;
    if (c.blinkAt <= 0 && alive) {
      c.blinkAt = 2.2 + Math.random() * 2.6;
      c.blink = 1;
    }
    c.blink = Math.max(0, c.blink - dt * 5.2);
    for (let i = 0; i < 2; i++) {
      const lid = lidRefs.current[i];
      if (!lid) continue;
      // The right eye is 90ms behind the left. Always. It is not broken.
      const k = clamp01(i === 0 ? c.blink : c.blink - 0.45);
      const shut = eyeKind === "sleepy" ? 0.55 + 0.45 * Math.sin(Math.PI * k) : Math.sin(Math.PI * clamp01(k * 2));
      lid.scale.y = Math.max(0.001, shut);
      lid.position.y = 0.096 * (1 - shut);
      lid.visible = alive;
    }
    /* Googly eyes track the finger; sleepy ones do not care; heart ones pulse. */
    for (let i = 0; i < 2; i++) {
      const eye = eyeRefs.current[i];
      if (!eye) continue;
      if (eyeKind === "googly") {
        eye.rotation.y = lerp(eye.rotation.y, state.pointer.x * 0.5, Math.min(1, dt * 5));
        eye.rotation.x = lerp(eye.rotation.x, -state.pointer.y * 0.35, Math.min(1, dt * 5));
      } else if (eyeKind === "heart") {
        eye.scale.setScalar(1 + Math.sin(e * 3.4 + i) * 0.1 * (0.4 + c.rub));
      }
    }

    if (bellyMatRef.current) bellyMatRef.current.opacity = phase === "preview" ? 0 : clamp01((roll - 0.55) / 0.4);

    /* ---- the papers, arriving beside the box like they always do ---- */
    if (certRef.current && certMatRef.current) {
      const k = phase === "preview" ? 0 : post < 0 ? 0 : smooth(clamp01((post - PAPERS_AT) / 0.8));
      certRef.current.visible = k > 0.01;
      certRef.current.position.x = lerp(1.9, 0.98, easeOutBack(k));
      certRef.current.rotation.z = lerp(-0.6, -0.14, k);
      certMatRef.current.opacity = k;
    }

    /* ---- the lid, off in every phase but sealed ---- */
    if (lidTop.current) {
      const shut = phase === "sealed" ? 1 : 0;
      const l = lidTop.current;
      l.rotation.x = lerp(l.rotation.x, lerp(-2.1, 0, shut), Math.min(1, dt * 3));
      l.position.y = lerp(l.position.y, lerp(0.42, 0.3, shut), Math.min(1, dt * 3));
    }

    if (phase === "opening" && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const eyeAt: [number, number, number][] = [
    [-0.17, 0.16, 0.4],
    [0.17, 0.16, 0.4],
  ];

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.35, 2.5]} fov={42} onUpdate={(c) => c.lookAt(0, -0.06, 0)} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[1.6, 2.4, 2.2]} intensity={1.5} color="#fff4e2" />
      <pointLight position={[-1.6, 0.4, 1.4]} intensity={0.5} color="#cfe0ff" />

      <mesh position={[0, 0, -2]}>
        <planeGeometry args={[14, 10]} />
        <meshBasicMaterial color="#221b16" depthWrite={false} />
      </mesh>
      {/* the table */}
      <mesh position={[0, -0.62, 0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[9, 5]} />
        <meshStandardMaterial color="#4a382a" roughness={0.85} />
      </mesh>

      <group ref={fitRef}>
        {/* the box */}
        <group position={[0, -0.3, 0]}>
          {[
            [0, 0, -0.42, 0],
            [-0.62, 0, 0, Math.PI / 2],
            [0.62, 0, 0, Math.PI / 2],
          ].map(([x, y, z, ry], i) => (
            <mesh key={i} position={[x, y + 0.16, z]} rotation={[0, ry, 0]}>
              <planeGeometry args={[1.24, 0.62]} />
              <meshStandardMaterial map={CARDBOARD} roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
          ))}
          {/* the front wall, cut low so we can see in */}
          <mesh position={[0, -0.02, 0.42]}>
            <planeGeometry args={[1.24, 0.3]} />
            <meshStandardMaterial map={CARDBOARD} roughness={0.9} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, -0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.24, 0.84]} />
            <meshStandardMaterial map={STRAW} roughness={0.95} />
          </mesh>
          {/* the lid, hinged at the back */}
          <group ref={lidTop} position={[0, 0.3, -0.42]}>
            <mesh position={[0, 0, 0.42]}>
              <planeGeometry args={[1.24, 0.84]} />
              <meshStandardMaterial map={CARDBOARD} roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>

        {/* the rock. It is looking at you. */}
        <group ref={wobbleRef} position={[0, -0.14, 0.05]}>
          <group ref={rollRef}>
            <mesh geometry={rockGeo}>
              <meshStandardMaterial map={speckle} roughness={rock.rough} metalness={rock.metal} />
            </mesh>

            {/* eyes: glued on, slightly crooked, the way they always are */}
            {eyeAt.map((p, i) => (
              <group key={i} position={p}>
                <mesh geometry={eyeGeo}>
                  <meshStandardMaterial color="#fbfbf8" roughness={0.28} />
                </mesh>
                <group
                  ref={(el) => {
                    eyeRefs.current[i] = el;
                  }}
                >
                  {eyeKind === "heart" ? (
                    <mesh geometry={heartShape} position={[0, 0, 0.086]}>
                      <meshBasicMaterial color="#d63a5a" side={THREE.DoubleSide} />
                    </mesh>
                  ) : (
                    <mesh geometry={pupilGeo} position={[0, 0, 0.062]}>
                      <meshStandardMaterial color="#15161c" roughness={0.3} />
                    </mesh>
                  )}
                </group>
                {/* the lid, scaled down from the top */}
                <mesh
                  ref={(m) => {
                    lidRefs.current[i] = m;
                  }}
                  geometry={lidGeo}
                  position={[0, 0, 0.092]}
                >
                  <meshStandardMaterial color={rock.base} roughness={rock.rough} side={THREE.DoubleSide} />
                </mesh>
              </group>
            ))}

            {/* the belly. In marker. */}
            <mesh position={[0, -0.47, 0.01]} rotation={[Math.PI / 2, 0, 0]}>
              <planeGeometry args={belly.size} />
              <meshBasicMaterial ref={bellyMatRef} map={belly.t.texture} transparent opacity={0} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
            </mesh>
          </group>
        </group>

        {/* Certificate of Adoption, in both names */}
        <group ref={certRef} position={[1.9, -0.42, 0.5]} rotation={[-1.1, 0, -0.6]} visible={false}>
          <mesh>
            <planeGeometry args={[0.78, 0.56]} />
            <meshBasicMaterial ref={certMatRef} map={cert} transparent opacity={0} toneMapped={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 0.9]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
