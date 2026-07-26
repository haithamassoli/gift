import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture, orderWritePath } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, tone } from "../audio";
import { forRecipient } from "../../i18n";

/* ---------- variants ---------- */
const BIRDS: Record<string, { body: string; wing: string; cap: string; call: number }> = {
  bulbul: { body: "#4b3a2e", wing: "#2e241c", cap: "#151011", call: 1174 },
  swallow: { body: "#22304a", wing: "#151d2e", cap: "#8b3a2a", call: 1568 },
  sparrow: { body: "#7a6242", wing: "#4e3d28", cap: "#8f6a3a", call: 1046 },
};
const LIGHTS: Record<string, { top: string; low: string; sun: string; amb: number; twig: string }> = {
  dawn: { top: "#9fb6cf", low: "#f2d3b0", sun: "#ffe2bd", amb: 0.62, twig: "#6b543a" },
  golden: { top: "#7fa0c4", low: "#ffc477", sun: "#ffb254", amb: 0.7, twig: "#7d6038" },
  dusk: { top: "#2f3a5c", low: "#c07a6a", sun: "#ff9a72", amb: 0.42, twig: "#4a3a2a" },
};

const TWIGS = 900;
const TRIPS = 8; // swipes to build the whole nest
const PER_TRIP = TWIGS / TRIPS;
const TRIP_DUR = 1.05; // out and back
const ACTION_W = 3.0;
const ACTION_H = 2.5;
const REVEAL_HOLD = 1.6;

/* A twig is a short cylinder. Instanced, because 150 of them is the aesthetic and
   150 draw calls is not. */
const twigGeo = new THREE.CylinderGeometry(0.0045, 0.003, 1, 4);
const eggGeo = new THREE.SphereGeometry(0.062, 16, 12);
eggGeo.scale(1, 1.28, 1);

/* ---------- the bird: two-triangle wings, two-frame flap ---------- */
const bodyGeo = new THREE.SphereGeometry(0.05, 12, 9);
bodyGeo.scale(1.5, 1, 1);
const headGeo = new THREE.SphereGeometry(0.032, 10, 8);
const beakGeo = new THREE.ConeGeometry(0.011, 0.045, 6);
const tailGeo = new THREE.PlaneGeometry(0.07, 0.028);
const wingGeo = (() => {
  // one triangle, hinged at the shoulder
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 0.13, 0.015, -0.03, 0.03, -0.004, -0.075], 3),
  );
  g.computeVertexNormals();
  return g;
})();

export interface BirdHandle {
  /** `k` runs 0→1 across one round trip, or < 0 for perched. `home` is the perch,
   *  `away` the side it forages on, `e` the wall clock the flap rides. */
  fly(k: number, home: [number, number, number], away: number, e: number, carrying: boolean): void;
}

/** The pair are driven from the parent's useFrame through this handle, so nothing
 *  outside the bird ever touches the bird's own refs. */
const Bird = forwardRef<BirdHandle, { pal: (typeof BIRDS)[string] }>(function Bird({ pal }, handle) {
  const rootRef = useRef<THREE.Group>(null);
  const wingLRef = useRef<THREE.Group>(null);
  const wingRRef = useRef<THREE.Group>(null);
  const twigRef = useRef<THREE.Mesh>(null);

  useImperativeHandle(handle, () => ({
    fly(k, home, away, e, carrying) {
      const root = rootRef.current;
      if (!root) return;
      // out on the first half, home on the second — one arc, mirrored
      const leg = k < 0 ? 0 : k < 0.5 ? k * 2 : (1 - k) * 2;
      const p = easeOutCubic(leg);
      root.position.set(
        lerp(home[0], away, p),
        home[1] + p * 0.42 + Math.sin(e * 7 + away) * 0.012 * p,
        home[2] + p * 0.2,
      );
      // Turn to face the way it is going — a rotation, not a negative scale, which
      // would reverse the winding and let us see the inside of the bird.
      root.rotation.set(0, away > 0 ? 0 : Math.PI, (away > 0 ? -1 : 1) * p * 0.3);
      // A two-frame flap: up or down, nothing between. Small birds do not ease.
      const flap = k < 0 ? 0.1 : 1;
      const beat = Math.sin(e * 22) > 0 ? 1 : -1;
      if (wingLRef.current) wingLRef.current.rotation.x = beat * 0.9 * flap;
      if (wingRRef.current) wingRRef.current.rotation.x = -beat * 0.9 * flap;
      if (twigRef.current) twigRef.current.visible = carrying && k > 0.5;
    },
  }));

  return (
    <group ref={rootRef}>
      <mesh geometry={bodyGeo}>
        <meshStandardMaterial color={pal.body} roughness={0.85} />
      </mesh>
      <mesh geometry={headGeo} position={[0.062, 0.028, 0]}>
        <meshStandardMaterial color={pal.cap} roughness={0.85} />
      </mesh>
      <mesh geometry={beakGeo} position={[0.098, 0.024, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <meshStandardMaterial color="#2a2018" roughness={0.7} />
      </mesh>
      <mesh geometry={tailGeo} position={[-0.09, 0.006, 0]}>
        <meshStandardMaterial color={pal.wing} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
      <group ref={wingLRef} position={[0, 0.02, 0.018]}>
        <mesh geometry={wingGeo}>
          <meshStandardMaterial color={pal.wing} roughness={0.85} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <group ref={wingRRef} position={[0, 0.02, -0.018]} scale={[1, 1, -1]}>
        <mesh geometry={wingGeo}>
          <meshStandardMaterial color={pal.wing} roughness={0.85} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {/* the twig in the beak, only on the way home */}
      <mesh ref={twigRef} geometry={twigGeo} position={[0.13, 0.02, 0]} rotation={[0, 0, Math.PI / 2]} scale={[1, 0.1, 1]} visible={false}>
        <meshStandardMaterial color="#6b543a" roughness={0.9} />
      </mesh>
    </group>
  );
});

/** A dawn sky, painted once. */
function buildSky(top: string, low: string, sun: string): THREE.CanvasTexture {
  const w = 8;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, top);
  grad.addColorStop(0.62, low);
  grad.addColorStop(1, sun);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return new THREE.CanvasTexture(c);
}

const HINT_SPRITE = makeRadialSprite(64);

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

export default function NestScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const bird = BIRDS[variants.bird] ?? BIRDS.bulbul;
  const light = LIGHTS[variants.light] ?? LIGHTS.dawn;

  const sky = useMemo(() => buildSky(light.top, light.low, light.sun), [light]);
  useEffect(() => () => sky.dispose(), [sky]);

  /* The twigs ARE the strokes. orderWritePath gives the order a hand would lay
     them in; the jitter in angle and length is the entire look, so it is generous. */
  const nest = useMemo(() => {
    const text = (message.trim() || forRecipient(lang, recipientName)).replace(/\s*\n\s*\n+/g, "\n");
    const w = orderWritePath(text, {
      step: 3,
      fontSize: 88,
      fontWeight: "700",
      maxWidthPx: 88 * 8,
      lineHeight: 1.3,
      lang,
    });
    const rand = mulberry32(31337);
    const span = Math.min(2.5, 2.5 / Math.max(0.42, w.aspect * 1.4)); // world width of the block
    const out = new Float32Array(TWIGS * 5); // x, y, angle, length, tilt
    for (let i = 0; i < TWIGS; i++) {
      // Walk the path in order so the words assemble the way they are written.
      const k = w.count > 1 ? Math.floor((i / (TWIGS - 1)) * (w.count - 1)) : 0;
      out[i * 5] = w.path[k * 2] * span + (rand() - 0.5) * 0.01;
      out[i * 5 + 1] = w.path[k * 2 + 1] * span + (rand() - 0.5) * 0.01;
      // A twig laid along the local stroke direction, give or take a real bird.
      const next = Math.min(w.count - 1, k + 6);
      const dx = w.path[next * 2] - w.path[k * 2];
      const dy = w.path[next * 2 + 1] - w.path[k * 2 + 1];
      const along = Math.abs(dx) + Math.abs(dy) > 1e-6 ? Math.atan2(dy, dx) : 0;
      out[i * 5 + 2] = along + (rand() - 0.5) * 0.9;
      out[i * 5 + 3] = 0.022 + rand() * 0.026;
      out[i * 5 + 4] = (rand() - 0.5) * 0.5;
    }
    return { twigs: out, span };
  }, [message, recipientName, lang]);

  const names = useMemo(() => {
    const mk = (n: string) =>
      makeTextTexture(n || "—", {
        fontFamily: "Georgia, serif",
        fontWeight: "600",
        fontSize: 40,
        color: "#6b5a44",
        maxWidthPx: 40 * 8,
        padding: 8,
        lang,
      });
    const a = mk(recipientName);
    const b = mk(senderName);
    return { a, b, aSize: fitPlane(a.aspect, 0.11, 0.036), bSize: fitPlane(b.aspect, 0.11, 0.036) };
  }, [senderName, recipientName, lang]);
  useEffect(
    () => () => {
      names.a.texture.dispose();
      names.b.texture.dispose();
    },
    [names],
  );

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* trip counts finished round trips; `flying` is where inside the current one we are. */
  const g = useRef({ trip: 0, flying: -1, doneAt: -1, touched: false, px: 0, py: 0, down: false });
  useEffect(() => {
    if (phase === "opening") g.current = { trip: 0, flying: -1, doneAt: -1, touched: false, px: 0, py: 0, down: false };
  }, [phase]);

  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const twigRef = useRef<THREE.InstancedMesh>(null);
  const heRef = useRef<BirdHandle>(null);
  const sheRef = useRef<BirdHandle>(null);
  const eggRefs = useRef<(THREE.Mesh | null)[]>([]);
  const nameMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    const c = g.current;
    c.down = true;
    c.px = ev.point.x;
    c.py = ev.point.y;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening" || c.flying >= 0 || c.trip >= TRIPS) return;
    ev.stopPropagation();
    // One swipe, one round trip. A long drag is still one trip: the birds are not
    // a scroll bar, and the labour is supposed to take as many gestures as it takes.
    if (Math.hypot(ev.point.x - c.px, ev.point.y - c.py) < 0.32) return;
    c.down = false;
    c.touched = true;
    c.flying = 0;
    tone(bird.call, { type: "sine", seconds: 0.16, gain: 0.13 });
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

    /* ---- the trip clock ---- */
    if (phase === "opening" && c.flying >= 0) {
      c.flying += dt / TRIP_DUR;
      if (c.flying >= 1) {
        c.flying = -1;
        c.trip += 1;
        clack({ freq: 900, decay: 0.05, gain: 0.16 }); // a twig set down
        if (c.trip >= TRIPS) {
          c.doneAt = tRef.current;
          tone(784, { shimmer: true, seconds: 1.6, gain: 0.22 });
        }
      }
    }

    /* ---- how much nest exists ---- */
    let built: number;
    if (phase === "opening") {
      // Each trip lands its share, and the share eases in rather than popping.
      built = clamp01((c.trip + (c.flying >= 0 ? smooth(clamp01(c.flying)) : 0)) / TRIPS);
    } else if (phase === "sealed") {
      built = 0;
    } else {
      built = 1;
    }

    const post = phase === "revealed" ? REVEAL_HOLD : c.doneAt >= 0 ? tRef.current - c.doneAt : -1;
    const lift = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / REVEAL_HOLD));

    /* ---- the trick: while it is being built the nest is nearly edge-on, so it
            reads as a pile. The camera lifting is what turns the pile into words. ---- */
    if (tiltRef.current) {
      const t = tiltRef.current;
      const want = phase === "preview" ? 0.24 : lerp(1.16, 0, lift);
      t.rotation.x = lerp(t.rotation.x, want, Math.min(1, dt * 3.4));
      t.position.y = lerp(t.position.y, lerp(-0.5, 0.05, lift), Math.min(1, dt * 3.4));
    }

    /* ---- the twigs ---- */
    if (twigRef.current) {
      const n = Math.floor(built * TWIGS);
      for (let i = 0; i < TWIGS; i++) {
        const x = nest.twigs[i * 5];
        const y = nest.twigs[i * 5 + 1];
        const ang = nest.twigs[i * 5 + 2];
        const len = nest.twigs[i * 5 + 3];
        const tilt = nest.twigs[i * 5 + 4];
        // The newest of a trip's batch are still dropping into place; the rest are set.
        const s = i < n ? clamp01(0.2 + ((n - i) / PER_TRIP) * 2.4) : 0;
        dummy.position.set(x, y + (1 - s) * 0.22, tilt * 0.06);
        dummy.rotation.set(0, tilt, ang + Math.PI / 2 + (1 - s) * 1.2);
        dummy.scale.set(1, len * s, 1);
        dummy.updateMatrix();
        twigRef.current.setMatrixAt(i, dummy.matrix);
      }
      twigRef.current.instanceMatrix.needsUpdate = true;
    }

    /* ---- the pair ---- */
    const perched = phase === "sealed" || phase === "preview" || (phase === "opening" && c.flying < 0);
    const home: [number, number, number] = [-0.28, -0.78, 0.16];
    const home2: [number, number, number] = [0.28, -0.78, 0.16];
    if (phase === "revealed") {
      // They settle in, on the rim of what they built.
      heRef.current?.fly(-1, [-0.34, 0.1 + Math.sin(e * 0.7) * 0.005, 0.14], -1, e, false);
      sheRef.current?.fly(-1, [0.34, 0.1 + Math.sin(e * 0.7 + 1) * 0.005, 0.14], 1, e, false);
    } else {
      const k = perched ? -1 : c.flying;
      heRef.current?.fly(k, home, -1.5, e, true);
      sheRef.current?.fly(k, home2, 1.5, e, true);
    }

    /* ---- two pale eggs, and both names on them ---- */
    for (let i = 0; i < 2; i++) {
      const m = eggRefs.current[i];
      if (!m) continue;
      const show = phase === "preview" ? 1 : lift;
      m.visible = show > 0.01;
      m.scale.setScalar(smooth(show));
    }
    for (const m of nameMats.current) if (m) m.opacity = phase === "preview" ? 1 : lift;

    if (hintMatRef.current) {
      const want = phase === "opening" && !c.touched ? 0.34 + 0.2 * Math.sin(e * 2.6) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    if (phase === "opening" && post > REVEAL_HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 0.1, 2.35]} fov={42} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={light.amb} color={light.low} />
      <directionalLight position={[-1.4, 1.2, 2.2]} intensity={1.25} color={light.sun} />
      <directionalLight position={[1.8, -0.6, 1]} intensity={0.35} color={light.top} />

      {/* first light */}
      <mesh position={[0, 0, -3]}>
        <planeGeometry args={[16, 10]} />
        <meshBasicMaterial map={sky} depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        {/* the bare branch it all sits on */}
        <mesh position={[0, -0.95, -0.1]} rotation={[0, 0, Math.PI / 2 - 0.05]}>
          <cylinderGeometry args={[0.028, 0.05, 3.4, 8]} />
          <meshStandardMaterial color={light.twig} roughness={0.95} />
        </mesh>
        <mesh position={[0.72, -0.78, -0.12]} rotation={[0, 0, -0.7]}>
          <cylinderGeometry args={[0.012, 0.02, 0.7, 6]} />
          <meshStandardMaterial color={light.twig} roughness={0.95} />
        </mesh>

        {/* the nest — which is the message, woven in branch */}
        <group ref={tiltRef} position={[0, -0.22, 0]} rotation={[1.16, 0, 0]}>
          <instancedMesh ref={twigRef} args={[undefined, undefined, TWIGS]} geometry={twigGeo} frustumCulled={false}>
            <meshStandardMaterial color={light.twig} roughness={0.95} />
          </instancedMesh>

          {[-1, 1].map((s, i) => (
            <group key={i} position={[s * 0.1, -0.02, 0.05]}>
              <mesh
                ref={(m) => {
                  eggRefs.current[i] = m;
                }}
                geometry={eggGeo}
                visible={false}
              >
                <meshStandardMaterial color="#efe6d4" roughness={0.62} />
              </mesh>
              <mesh position={[0, 0, 0.064]}>
                <planeGeometry args={i === 0 ? names.bSize : names.aSize} />
                <meshBasicMaterial
                  ref={(m) => {
                    nameMats.current[i] = m;
                  }}
                  map={i === 0 ? names.b.texture : names.a.texture}
                  transparent
                  opacity={0}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            </group>
          ))}
        </group>

        <Bird ref={heRef} pal={bird} />
        <Bird ref={sheRef} pal={bird} />

        <mesh position={[0, 0.52, 0.4]}>
          <planeGeometry args={[1.1, 1.1]} />
          <meshBasicMaterial ref={hintMatRef} map={HINT_SPRITE} color={light.sun} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh position={[0, 0, 1]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
          <planeGeometry args={[9, 7]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
