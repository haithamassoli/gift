import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { useOpeningClock } from "../useOpeningClock";
import { makeRadialSprite } from "../sprites";
import { sampleTextPoints, type TextPoints } from "../text3d";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- palettes ---------- */
interface Palette {
  burst: string[];
  text: string;
  trail: string;
}
const PALETTES: Record<string, Palette> = {
  festival: {
    burst: ["#ff5a5a", "#ffd166", "#5ad1ff", "#9dff70", "#ff8ff0"],
    text: "#ffe9a8",
    trail: "#ffd9a8",
  },
  "rose-gold": {
    burst: ["#ffb6a8", "#ffd9c2", "#e8968a", "#ffe0b0", "#f4c2ae"],
    text: "#ffe3c8",
    trail: "#ffc9b0",
  },
  neon: {
    burst: ["#00ffd5", "#ff00e0", "#7dff00", "#00b3ff", "#ff3d81"],
    text: "#c8ffee",
    trail: "#9ffcff",
  },
};

const WATER_Y = -1.5;
const POOL = 2200;

/* ---------- particle modes ---------- */
const DEAD = 0;
const BALLISTIC = 1; // gravity + drag + fade
const SEEK = 2; // fly from spawn point to glyph target
const HOLD = 3; // twinkle at glyph target
const ROCKET = 4; // rise, spawn trail, explode at apex

interface Rocket {
  slot: number;
  targetY: number;
  payload: { kind: "sphere" } | { kind: "text"; word: string; lang: Lang };
}

class Pool {
  px = new Float32Array(POOL);
  py = new Float32Array(POOL);
  pz = new Float32Array(POOL);
  vx = new Float32Array(POOL);
  vy = new Float32Array(POOL);
  vz = new Float32Array(POOL);
  sx = new Float32Array(POOL); // seek start
  sy = new Float32Array(POOL);
  sz = new Float32Array(POOL);
  tx = new Float32Array(POOL); // seek target
  ty = new Float32Array(POOL);
  tz = new Float32Array(POOL);
  age = new Float32Array(POOL);
  ttl = new Float32Array(POOL);
  hold = new Float32Array(POOL); // hold duration at glyph target
  seed = new Float32Array(POOL);
  r = new Float32Array(POOL);
  g = new Float32Array(POOL);
  b = new Float32Array(POOL);
  mode = new Uint8Array(POOL);
  cursor = 0;

  spawn(): number {
    for (let k = 0; k < POOL; k++) {
      const i = (this.cursor + k) % POOL;
      if (this.mode[i] === DEAD) {
        this.cursor = (i + 1) % POOL;
        this.age[i] = 0;
        return i;
      }
    }
    return -1; // pool exhausted — drop the particle
  }
}

interface Sim {
  pool: Pool;
  rockets: Rocket[];
  eventCursor: number;
  ambientNext: number;
  worldT: number;
  maxTextWidth: number;
}

const tmpColor = new THREE.Color();
function setColor(pool: Pool, i: number, hex: string, intensity = 1) {
  tmpColor.set(hex);
  pool.r[i] = tmpColor.r * intensity;
  pool.g[i] = tmpColor.g * intensity;
  pool.b[i] = tmpColor.b * intensity;
}

/* ---------- message chunking ---------- */
// ponytail: legibility cap — long messages spell their first 6 chunks, then the
// finale; the full text is always shown as HTML after the reveal.
function chunkMessage(message: string, recipientName: string, lang: Lang): string[] {
  const source = message.trim() || forRecipient(lang, recipientName);
  const words = source.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cur && cand.length > 12) {
      chunks.push(cur);
      cur = w;
    } else {
      cur = cand;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, 6);
}

const textCache = new Map<string, TextPoints>();
function textPoints(word: string, lang: Lang): TextPoints {
  const key = `${lang}:${word}`;
  let pts = textCache.get(key);
  if (!pts) {
    pts = sampleTextPoints(word, {
      maxPoints: Math.min(320, Math.max(90, word.length * 26)),
      fontSize: 110,
      fontWeight: "800",
      seed: 7,
      lang,
    });
    textCache.set(key, pts);
  }
  return pts;
}

/* ---------- spawners (module-level: they mutate the Sim imperatively) ---------- */
function launchRocket(sim: Sim, palette: Palette, x: number, payload: Rocket["payload"], targetY?: number) {
  const { pool } = sim;
  const i = pool.spawn();
  if (i < 0) return;
  pool.mode[i] = ROCKET;
  pool.px[i] = x + (Math.random() - 0.5) * 0.2;
  pool.py[i] = WATER_Y + 0.05;
  pool.pz[i] = (Math.random() - 0.5) * 0.4;
  pool.vx[i] = (Math.random() - 0.5) * 0.25;
  pool.vy[i] = 3.4 + Math.random() * 0.5;
  pool.vz[i] = 0;
  pool.ttl[i] = 4;
  pool.seed[i] = Math.random() * 100;
  setColor(pool, i, palette.trail, 1.4);
  sim.rockets.push({ slot: i, targetY: targetY ?? 0.9 + Math.random() * 0.7, payload });
}

function burstSphere(sim: Sim, palette: Palette, x: number, y: number, big = false) {
  const { pool } = sim;
  const n = big ? 170 : 120;
  const hex = palette.burst[Math.floor(Math.random() * palette.burst.length)];
  for (let k = 0; k < n; k++) {
    const i = pool.spawn();
    if (i < 0) return;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const sp = (big ? 2.4 : 1.9) * (0.55 + Math.random() * 0.45);
    pool.mode[i] = BALLISTIC;
    pool.px[i] = x;
    pool.py[i] = y;
    pool.pz[i] = 0;
    pool.vx[i] = Math.sin(ph) * Math.cos(th) * sp;
    pool.vy[i] = Math.cos(ph) * sp;
    pool.vz[i] = Math.sin(ph) * Math.sin(th) * sp * 0.4;
    pool.ttl[i] = 1.3 + Math.random() * 0.6;
    pool.seed[i] = Math.random() * 100;
    setColor(pool, i, Math.random() < 0.85 ? hex : "#ffffff", 1.2);
  }
}

function burstText(sim: Sim, palette: Palette, word: string, x: number, y: number, lang: Lang) {
  const { pool } = sim;
  const pts = textPoints(word, lang);
  const width = Math.min(sim.maxTextWidth, Math.max(1.1, word.length * 0.24));
  for (let k = 0; k < pts.count; k++) {
    const i = pool.spawn();
    if (i < 0) return;
    const th = Math.random() * Math.PI * 2;
    pool.mode[i] = SEEK;
    pool.px[i] = pool.sx[i] = x + Math.cos(th) * 0.12;
    pool.py[i] = pool.sy[i] = y + Math.sin(th) * 0.12;
    pool.pz[i] = pool.sz[i] = 0;
    pool.tx[i] = x + pts.points[k * 2] * width;
    pool.ty[i] = y + pts.points[k * 2 + 1] * width;
    pool.tz[i] = (Math.random() - 0.5) * 0.06;
    pool.ttl[i] = 0.7 + Math.random() * 0.25; // seek duration
    pool.hold[i] = 1.5 + Math.random() * 0.3;
    pool.seed[i] = Math.random() * 100;
    setColor(pool, i, palette.text, 1.5);
  }
}

/* ---------- sound: soft procedural boom, created only after a user gesture ---------- */
interface Boom {
  ctx: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
}

function createBoom(): Boom {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.07;
  master.connect(ctx.destination);
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return { ctx, master, noise };
}

function playBoom({ ctx, master, noise }: Boom, big: boolean) {
  if (ctx.state === "suspended") void ctx.resume();
  const t = ctx.currentTime;
  const dur = big ? 1.1 : 0.7;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(big ? 1 : 0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(big ? 800 : 1300, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + dur);
  src.connect(lp);
  lp.connect(gain);
  gain.connect(master);
  src.start(t);
  src.stop(t + dur + 0.1);
}

function stepRockets(sim: Sim, palette: Palette, boom?: (big: boolean) => void) {
  const { pool } = sim;
  const alive: Rocket[] = [];
  for (const rk of sim.rockets) {
    const i = rk.slot;
    if (pool.mode[i] !== ROCKET) continue;
    for (let s = 0; s < 2; s++) {
      const j = pool.spawn();
      if (j >= 0) {
        pool.mode[j] = BALLISTIC;
        pool.px[j] = pool.px[i] + (Math.random() - 0.5) * 0.03;
        pool.py[j] = pool.py[i] + (Math.random() - 0.5) * 0.03;
        pool.pz[j] = pool.pz[i];
        pool.vx[j] = (Math.random() - 0.5) * 0.15;
        pool.vy[j] = -0.3 - Math.random() * 0.3;
        pool.vz[j] = 0;
        pool.ttl[j] = 0.35 + Math.random() * 0.2;
        pool.seed[j] = Math.random() * 100;
        setColor(pool, j, palette.trail, 0.7);
      }
    }
    if (pool.py[i] >= rk.targetY) {
      pool.mode[i] = DEAD;
      if (rk.payload.kind === "sphere") {
        burstSphere(sim, palette, pool.px[i], pool.py[i], true);
        boom?.(true);
      } else {
        burstText(sim, palette, rk.payload.word, pool.px[i], pool.py[i], rk.payload.lang);
        boom?.(false);
      }
    } else {
      alive.push(rk);
    }
  }
  sim.rockets = alive;
}

function integrate(sim: Sim, dt: number, positions: Float32Array, colors: Float32Array) {
  const { pool } = sim;
  const drag = Math.exp(-dt * 1.1);
  for (let i = 0; i < POOL; i++) {
    const m = pool.mode[i];
    if (m === DEAD) {
      positions[i * 3 + 1] = -100; // park offscreen
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0;
      continue;
    }
    pool.age[i] += dt;
    let fade = 1;
    if (m === BALLISTIC) {
      pool.vy[i] -= 1.7 * dt;
      pool.vx[i] *= drag;
      pool.vy[i] *= drag;
      pool.vz[i] *= drag;
      pool.px[i] += pool.vx[i] * dt;
      pool.py[i] += pool.vy[i] * dt;
      pool.pz[i] += pool.vz[i] * dt;
      const u = pool.age[i] / pool.ttl[i];
      if (u >= 1 || pool.py[i] < WATER_Y - 0.1) pool.mode[i] = DEAD;
      fade = Math.max(0, 1 - u) * (0.75 + 0.25 * Math.sin(pool.seed[i] + pool.age[i] * 18));
    } else if (m === SEEK) {
      const u = Math.min(1, pool.age[i] / pool.ttl[i]);
      const e = 1 - Math.pow(1 - u, 3);
      pool.px[i] = pool.sx[i] + (pool.tx[i] - pool.sx[i]) * e;
      pool.py[i] = pool.sy[i] + (pool.ty[i] - pool.sy[i]) * e;
      pool.pz[i] = pool.sz[i] + (pool.tz[i] - pool.sz[i]) * e;
      if (u >= 1) {
        pool.mode[i] = HOLD;
        pool.age[i] = 0;
      }
      fade = 0.6 + 0.4 * u;
    } else if (m === HOLD) {
      fade = 0.8 + 0.2 * Math.sin(pool.seed[i] * 7 + pool.age[i] * 14);
      if (pool.age[i] > pool.hold[i]) {
        pool.mode[i] = BALLISTIC;
        pool.age[i] = 0;
        pool.ttl[i] = 0.7 + Math.random() * 0.3;
        pool.vx[i] = (Math.random() - 0.5) * 0.3;
        pool.vy[i] = -0.2 - Math.random() * 0.3;
        pool.vz[i] = 0;
      }
    } else if (m === ROCKET) {
      pool.py[i] += pool.vy[i] * dt;
      pool.px[i] += pool.vx[i] * dt;
      fade = 1.2;
      if (pool.age[i] > pool.ttl[i]) pool.mode[i] = DEAD;
    }
    positions[i * 3] = pool.px[i];
    positions[i * 3 + 1] = pool.py[i];
    positions[i * 3 + 2] = pool.pz[i];
    colors[i * 3] = pool.r[i] * fade;
    colors[i * 3 + 1] = pool.g[i] * fade;
    colors[i * 3 + 2] = pool.b[i] * fade;
  }
}

/* ---------- static scenery ---------- */
function buildStars(count: number, seedN: number) {
  const arr = new Float32Array(count * 3);
  let s = seedN;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < count; i++) {
    arr[i * 3] = (rand() - 0.5) * 16;
    arr[i * 3 + 1] = WATER_Y + 0.4 + rand() * 5.5;
    arr[i * 3 + 2] = -4 - rand() * 3;
  }
  return arr;
}
const STARS_A = buildStars(150, 1234567);
const STARS_B = buildStars(120, 7654321);

function buildWaterTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, "#16233d");
  grad.addColorStop(0.35, "#0c1526");
  grad.addColorStop(1, "#05080f");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}
const waterTexture = buildWaterTexture();
const spriteTexture = makeRadialSprite();

export default function FireworksScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const palette = PALETTES[variants.palette] ?? PALETTES.festival;
  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  const simRef = useRef<Sim | null>(null);
  const soundRef = useRef<Boom | null>(null);
  const mainPts = useRef<THREE.Points>(null);
  const mirrorPts = useRef<THREE.Points>(null);
  const starMatA = useRef<THREE.PointsMaterial>(null);
  const starMatB = useRef<THREE.PointsMaterial>(null);

  // Stable buffers for the declarative attributes; mutated only via the points
  // ref inside useFrame (imperative particle sim).
  const buffers = useMemo(
    () => ({ positions: new Float32Array(POOL * 3), colors: new Float32Array(POOL * 3) }),
    [],
  );

  // Opening show timeline: intro rocket, then one text burst per chunk, then finale.
  const show = useMemo(() => {
    const chunks = chunkMessage(message, recipientName, lang);
    const events: { t: number; x: number; word?: string }[] = [{ t: 0.05, x: 0.3 }];
    chunks.forEach((word, i) => {
      events.push({ t: 1.7 + i * 2.1, x: (i % 2 === 0 ? -1 : 1) * 0.35, word });
    });
    const lastBurst = 1.7 + (chunks.length - 1) * 2.1 + 1.05;
    const finaleT = lastBurst + 2.2;
    events.push({ t: finaleT, x: -0.9 }, { t: finaleT + 0.25, x: 0.9 }, { t: finaleT + 0.5, x: 0 });
    return { events, end: finaleT + 1.6 };
  }, [message, recipientName, lang]);

  useEffect(() => {
    if (phase === "opening" && simRef.current) {
      simRef.current.pool.mode.fill(DEAD);
      simRef.current.rockets = [];
      simRef.current.eventCursor = 0;
    }
  }, [phase]);

  useEffect(
    () => () => {
      void soundRef.current?.ctx.close();
      soundRef.current = null;
    },
    [],
  );

  useFrame((state, delta) => {
    const sim = (simRef.current ??= {
      pool: new Pool(),
      rockets: [],
      eventCursor: 0,
      ambientNext: 0,
      worldT: 0,
      maxTextWidth: 2.4,
    });
    const dt = Math.min(delta, 0.05);
    sim.worldT += dt;
    sim.maxTextWidth = Math.min(3.4, Math.max(1.9, state.viewport.width * 0.8));
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    // opening show events
    if (phase === "opening") {
      const { events, end } = show;
      while (sim.eventCursor < events.length && events[sim.eventCursor].t <= t) {
        const ev = events[sim.eventCursor++];
        if (ev.word) {
          launchRocket(sim, palette, ev.x * (sim.maxTextWidth / 2.4), { kind: "text", word: ev.word, lang }, 1.0);
        } else {
          launchRocket(sim, palette, ev.x * 1.4, { kind: "sphere" });
        }
      }
      if (t > end && !doneRef.current) {
        doneRef.current = true;
        onOpenComplete?.();
      }
    }

    // ambient bursts in preview/revealed
    if ((phase === "preview" || phase === "revealed") && sim.worldT > sim.ambientNext) {
      sim.ambientNext = sim.worldT + 2.2 + Math.random() * 1.4;
      if (phase === "preview" && Math.random() < 0.3) {
        const chunk = chunkMessage(message, recipientName, lang)[0];
        launchRocket(sim, palette, (Math.random() - 0.5) * 1.2, { kind: "text", word: chunk, lang });
      } else {
        launchRocket(sim, palette, (Math.random() - 0.5) * 2.4, { kind: "sphere" });
      }
    }

    // Sound only after the unwrap tap (sticky activation) — previews stay silent.
    const canSound = phase === "opening" || phase === "revealed";
    stepRockets(
      sim,
      palette,
      canSound
        ? (big) => {
            soundRef.current ??= createBoom();
            playBoom(soundRef.current, big);
          }
        : undefined,
    );

    const geo = mainPts.current?.geometry;
    if (geo) {
      const pos = geo.attributes.position;
      const col = geo.attributes.color;
      integrate(sim, dt, pos.array as Float32Array, col.array as Float32Array);
      pos.needsUpdate = true;
      col.needsUpdate = true;
      // The mirrored points share the same geometry (single CPU sim, two draws).
      if (mirrorPts.current && mirrorPts.current.geometry !== geo) {
        mirrorPts.current.geometry = geo;
      }
    }

    // star twinkle
    const e = state.clock.elapsedTime;
    if (starMatA.current) starMatA.current.opacity = 0.55 + Math.sin(e * 0.9) * 0.2;
    if (starMatB.current) starMatB.current.opacity = 0.5 + Math.sin(e * 1.3 + 2) * 0.25;
  });

  const tapLaunch = (e: { point: THREE.Vector3 }) => {
    const sim = simRef.current;
    if (!sim || (phase !== "revealed" && phase !== "opening")) return;
    launchRocket(
      sim,
      palette,
      THREE.MathUtils.clamp(e.point.x, -2.5, 2.5),
      { kind: "sphere" },
      THREE.MathUtils.clamp(e.point.y, 0.3, 2),
    );
  };

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 0.55, 7]}
        fov={45}
        onUpdate={(c) => c.lookAt(0, 0.45, 0)}
      />
      <ambientLight intensity={0.25} />

      {/* night water backdrop */}
      <mesh position={[0, WATER_Y - 1.5, -1]}>
        <planeGeometry args={[24, 3]} />
        <meshBasicMaterial map={waterTexture} />
      </mesh>

      {/* stars */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[STARS_A, 3]} />
        </bufferGeometry>
        <pointsMaterial ref={starMatA} map={spriteTexture} color="#cfd8ea" size={0.035} transparent opacity={0.6} depthWrite={false} />
      </points>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[STARS_B, 3]} />
        </bufferGeometry>
        <pointsMaterial ref={starMatB} map={spriteTexture} color="#e8d8c0" size={0.028} transparent opacity={0.55} depthWrite={false} />
      </points>

      {/* firework particles + water reflection (same buffer, mirrored) */}
      <points ref={mainPts} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[buffers.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[buffers.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={spriteTexture}
          vertexColors
          size={0.075}
          sizeAttenuation
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <group position={[0, WATER_Y * 2, 0]} scale={[1, -1, 1]}>
        <points ref={mirrorPts} frustumCulled={false}>
          <pointsMaterial
            map={spriteTexture}
            vertexColors
            size={0.06}
            sizeAttenuation
            transparent
            opacity={0.22}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      </group>

      {/* invisible sky plane: tap to launch extras */}
      {(phase === "revealed" || phase === "opening") && (
        <mesh position={[0, 0.6, 0]} onPointerDown={tapLaunch}>
          <planeGeometry args={[20, 10]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
