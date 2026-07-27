import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
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
const CONFETTI = 150;

const crowdGeo = new THREE.CapsuleGeometry(0.5, 0.7, 2, 5);
const confettiGeo = new THREE.PlaneGeometry(1, 1.7);
const HINT = makeRadialSprite(64);
// A floodlight's core is a hard white dot with a long soft skirt — a plain radial
// sprite is all skirt and reads as fog, so the flare gets its own falloff.
const FLARE = makeRadialSprite(128, [
  [0, "rgba(255,255,255,1)"],
  [0.14, "rgba(255,255,255,0.62)"],
  [0.42, "rgba(255,255,255,0.16)"],
  [1, "rgba(255,255,255,0)"],
]);

/** The horizontal smear a lamp leaves across a lens. Additive, and the only reason
    the pylons read as *lights* rather than as bright rectangles. */
function buildStreakTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 32;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  for (let x = 0; x < W; x++) {
    const a = Math.pow(1 - Math.abs((x / (W - 1)) * 2 - 1), 2.4);
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.5, `rgba(255,255,255,${a})`);
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(x, 0, 1, H);
  }
  return new THREE.CanvasTexture(c);
}
const STREAK = buildStreakTexture();

/** The LED grid, tiled over the whole panel. A stadium screen is a lattice of lamps
    with black between them, and that lattice is what stops the quad reading as paper. */
function buildScanTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 4;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(0,0,0,0.5)";
  g.fillRect(0, 3, 4, 1);
  g.fillStyle = "rgba(0,0,0,0.26)";
  g.fillRect(3, 0, 1, 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.repeat.set(108, 61);
  return t;
}
const SCAN = buildScanTexture();

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
const PAN_GAIN = 1.0; // world units of pan per world unit of drag
const PAN_LIMIT = 1.9; // where the stand runs out and the pan pushes back
const LOCK_ZOOM = 0.66; // it tightens on you — a broadcast zoom is a smaller frame
const NAMES_AT = 0.98;
const POST_END = 4.4;
/* Where you are sitting, in the roving camera's own coordinates. */
const YOU_X = 0.12;
/* A miss has to *land* on somebody, so the pan is taken over for a beat. */
const MISS_HOLD = 1.0;
const MISS_SHOW = 1.7;
const REARM = 0.55; // travel away from your row before the next pass can count
/* If nobody ever works the wheel, the gantry takes the shot itself — a gift may never
   sit there unfinished, and 6.6 + POST_END keeps the whole thing under twelve seconds. */
const MERCY0 = 5.3;
const MERCY1 = 6.6;
/* The Mexican wave: a bump of standing people crossing the stand. */
const WAVE_SPEED = 9.2;
const WAVE_DUR = 3.0;
const INV_WAVE = 1 / 2.2;
const INV_ATT = 1 / 0.62; // how wide the roving camera's attention reaches

/* ---------- the camera on the gantry ---------- */
const CAM_Y = 0.35;
const CAM_Z = 3.4;
const CAM_PUNCH = 0.56; // how far the push-in travels, in world units

function fitPlane(aspect: number, maxW: number, maxH: number): [number, number] {
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) {
    h = maxH;
    w = h / aspect;
  }
  return [w, h];
}

/* ---------- confetti from the tier above ---------- */
// Nothing here depends on a prop, so it is a module constant and the render never
// reads a ref to find it. Every piece falls at its own rate, spins on its own axes
// and takes the breeze differently — falling *together* is what reads as fake.
const CONF_HUES = ["#ffd23f", "#ff5f7e", "#3fd2ff", "#7bff9a", "#ffffff", "#ffa8d8"];
function buildConfetti() {
  const rand = mulberry32(515);
  const x = new Float32Array(CONFETTI);
  const y = new Float32Array(CONFETTI);
  const z = new Float32Array(CONFETTI);
  const spin = new Float32Array(CONFETTI);
  const tilt = new Float32Array(CONFETTI);
  const drift = new Float32Array(CONFETTI);
  const fall = new Float32Array(CONFETTI);
  const delay = new Float32Array(CONFETTI);
  const ph = new Float32Array(CONFETTI);
  const scale = new Float32Array(CONFETTI);
  const col: THREE.Color[] = [];
  for (let i = 0; i < CONFETTI; i++) {
    x[i] = (rand() - 0.5) * 4.8;
    z[i] = 0.3 + rand() * 1.8;
    y[i] = 1.7 + rand() * 1.5;
    spin[i] = (rand() - 0.5) * 11;
    tilt[i] = 2.5 + rand() * 5;
    drift[i] = (rand() - 0.5) * 0.85;
    fall[i] = 0.34 + rand() * 0.62;
    delay[i] = rand() * 1.5;
    ph[i] = rand() * TAU;
    scale[i] = 0.02 + rand() * 0.028;
    col.push(new THREE.Color(CONF_HUES[Math.floor(rand() * CONF_HUES.length)]));
  }
  return { x, y, z, spin, tilt, drift, fall, delay, ph, scale, col };
}
const CONF = buildConfetti();

/* ---------- scratch ---------- */
// Hoisted: a frame that touches 7800 instances cannot afford a single allocation.
const _obj = new THREE.Object3D();
const _col = new THREE.Color();
const _cam = new THREE.Vector3();

/** The mains hum in a floodlight bank — it never quite settles, and that unrest is
    the difference between a lamp and a white rectangle. */
const hum = (e: number, ph: number) =>
  1 + 0.055 * Math.sin(e * 12.7 + ph) + 0.028 * Math.sin(e * 29.3 + ph * 2) + 0.014 * Math.sin(e * 51 + ph);

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

  /* The stand: 7800 blobs in four colour bands, most of them dark. Built once.
     `amp` and `spd` are what stop 7800 people breathing in unison. */
  const crowd = useMemo(() => {
    const rand = mulberry32(60000);
    const pos = new Float32Array(CROWD * 3);
    const col = new Float32Array(CROWD * 3);
    const sway = new Float32Array(CROWD);
    const amp = new Float32Array(CROWD);
    const spd = new Float32Array(CROWD);
    const row = new Float32Array(CROWD);
    const c = new THREE.Color();
    const bands = st.bands.map((b) => new THREE.Color(b));
    for (let i = 0; i < CROWD; i++) {
      // rows banked away from us, wrapping round the bowl
      const r = Math.floor(rand() * 46);
      const t = r / 46;
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
      amp[i] = 0.5 + rand() * 1.1;
      spd[i] = 0.8 + rand() * 0.7;
      row[i] = t;
    }
    return { pos, col, sway, amp, spd, row };
  }, [st]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  /* `pan` is the roving camera's position; `sweeps` counts how many times it has
     gone past you without stopping. It carries momentum, so the crossing is detected
     in the frame and not in the pointer handler — a flick can coast past you. */
  const g = useRef({
    pan: -1.4,
    prev: -1.4,
    vel: 0,
    drag: 0,
    armed: true,
    sweeps: 0,
    dir: 1,
    lockAt: -1,
    lockKick: 0,
    missAt: -1,
    missX: 0,
    waveAt: -1,
    waveFrom: 0,
    waveDir: 1,
    down: false,
    hover: false,
    idle: 0,
    px: 0,
    touched: false,
    roared: false,
    popped: false,
  });
  useEffect(() => {
    if (phase === "opening") {
      const c = g.current;
      c.pan = c.prev = -1.4;
      c.vel = c.drag = 0;
      c.armed = true;
      c.sweeps = 0;
      c.dir = 1;
      c.lockAt = c.missAt = c.waveAt = -1;
      c.lockKick = c.idle = 0;
      c.down = c.hover = c.touched = c.roared = c.popped = false;
    }
  }, [phase]);

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fitRef = useRef<THREE.Group>(null);
  const crowdRef = useRef<THREE.InstancedMesh>(null);
  const confRef = useRef<THREE.InstancedMesh>(null);
  const adRef = useRef<THREE.Mesh>(null);
  const adMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const cutRef = useRef<THREE.Mesh>(null);
  const cutMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const rollRef = useRef<THREE.Mesh>(null);
  const rollMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bloomMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const nameRef = useRef<THREE.Mesh>(null);
  const nameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bodyMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const frameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const groanMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const boxRef = useRef<THREE.Group>(null);
  const spotRef = useRef<THREE.Mesh>(null);
  const spotMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const hintMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const pickedRef = useRef<THREE.Group>(null);
  const waveArmRef = useRef<THREE.Group>(null);
  const restArmRef = useRef<THREE.Group>(null);
  /* two pylons, three additive quads each: core, halo, streak */
  const flareRefs = useRef<(THREE.Mesh | null)[]>([]);

  // instanceColor does not exist until something writes one, and the confetti's
  // colours never change — so they are laid once rather than re-uploaded per frame.
  useLayoutEffect(() => {
    const im = confRef.current;
    if (!im) return;
    for (let i = 0; i < CONFETTI; i++) im.setColorAt(i, CONF.col[i]);
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }, []);

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
    g.current.vel = 0;
    g.current.px = ev.point.x;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    const c = g.current;
    if (!c.down || phase !== "opening" || c.lockAt >= 0) return;
    ev.stopPropagation();
    // The handler only banks the travel; the frame turns it into position and
    // velocity, because only the frame knows how long the travel took.
    c.drag += (ev.point.x - c.px) * PAN_GAIN;
    c.px = ev.point.x;
  };
  const stop = () => {
    // Let go and it coasts — the momentum is the whole feel of a gantry camera.
    g.current.down = false;
    g.current.hover = false;
  };
  const onOver = () => {
    g.current.hover = true;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const c = g.current;
    const opening = phase === "opening";

    if (fitRef.current) {
      fitRef.current.scale.setScalar(Math.max(0.52, Math.min(1, state.viewport.width / ACTION_W, state.viewport.height / ACTION_H)));
    }

    const post = phase === "revealed" ? POST_END : opening && c.lockAt >= 0 ? t - c.lockAt : -1;
    const found = phase === "revealed" ? 1 : post < 0 ? 0 : smooth(clamp01(post / 1.1));

    /* ---- the pan: a mass with momentum, walls that push back, and a lock ---- */
    if (opening) {
      const missing = c.missAt >= 0 && t - c.missAt < MISS_HOLD;
      // A finger resting on the glass is not a hand on the wheel. The mercy path
      // watches idle time rather than contact, or a pointer pressed and forgotten
      // suppresses it forever and the gift never finishes.
      c.idle = c.drag !== 0 ? 0 : c.idle + dt;
      if (c.lockAt >= 0) {
        // Anticipation is over; this is the settle. A decaying sine sized by how hard
        // you were dragging, so a flick overshoots further than a nudge.
        const u = t - c.lockAt;
        c.pan = YOU_X + c.lockKick * Math.exp(-6.5 * u) * Math.cos(11 * u);
        c.vel = 0;
      } else {
        if (c.drag !== 0) {
          // resistance: the last third of the travel each way fights you, and a hand
          // on the wheel during a near-miss barely moves it at all
          const edge = 1 - 0.55 * clamp01((Math.abs(c.pan) - PAN_LIMIT * 0.66) / (PAN_LIMIT * 0.34));
          const k = c.drag * edge * (missing ? 0.16 : 1);
          c.pan += k;
          c.vel = lerp(c.vel, Math.max(-7, Math.min(7, k / dt)), 0.65);
          c.drag = 0;
        } else {
          c.vel *= Math.exp(-(c.down ? 7 : 1.9) * dt);
          c.pan += c.vel * dt;
        }
        if (missing) {
          // it has settled on somebody else, and it is not letting go yet
          c.vel += (c.missX - c.pan) * 52 * dt;
          c.vel *= Math.exp(-7 * dt);
        }
        // the ends of the stand: a spring, not a clamp, so it overshoots and comes back
        if (c.pan > PAN_LIMIT || c.pan < -PAN_LIMIT) {
          const over = c.pan - Math.sign(c.pan) * PAN_LIMIT;
          c.vel -= over * 26 * dt;
          c.vel *= Math.exp(-5 * dt);
        }
        // …and the machine losing patience: eased in from 5.3s of being left alone,
        // all the way over by 6.6, and only while no hand is on the wheel.
        if (!c.down || c.idle > 1.2) {
          const m = smooth(clamp01((t - MERCY0) / (MERCY1 - MERCY0)));
          if (m > 0) {
            c.vel += (YOU_X - c.pan) * 22 * m * dt;
            c.vel *= Math.exp(-5 * m * dt);
          }
          if (t >= MERCY1) {
            c.sweeps = SWEEPS;
            c.lockAt = t;
            c.lockKick = Math.max(-0.34, Math.min(0.34, c.vel * 0.05));
            tone(880, { shimmer: true, seconds: 1.4, gain: 0.26 });
          }
        }
        c.pan = Math.max(-2.4, Math.min(2.4, c.pan));
      }

      /* crossing your row — in either direction, because the second pass is supposed
         to come back the other way */
      if (c.touched && c.lockAt < 0 && c.armed && (c.prev - YOU_X) * (c.pan - YOU_X) < 0) {
        c.armed = false;
        c.dir = Math.sign(c.pan - c.prev) || 1;
        c.sweeps += 1;
        c.waveAt = e;
        c.waveFrom = YOU_X;
        c.waveDir = c.dir;
        if (c.sweeps < SWEEPS) {
          c.missAt = t;
          c.missX = YOU_X + c.dir * 0.46;
          // sixty thousand people watching it land on the wrong row
          swell({ source: "sawtooth", freq: 86, cutoff: 330, q: 1.3, attack: 0.2, hold: 0.34, release: 1.0, gain: 0.11 });
        } else {
          c.lockAt = t;
          c.lockKick = Math.max(-0.34, Math.min(0.34, c.vel * 0.05));
          tone(880, { shimmer: true, seconds: 1.4, gain: 0.26 });
        }
      }
      if (!c.armed && Math.abs(c.pan - YOU_X) > REARM) c.armed = true;
      c.prev = c.pan;
    }

    // The roar goes up when it lands, once — and the cannon fires under it.
    if (post >= 0 && opening) {
      if (!c.roared) {
        c.roared = true;
        swell({ source: "noise", cutoff: 620, q: 0.6, attack: 0.5, hold: 1.4, release: 2.4, gain: 0.26 });
      }
      if (!c.popped && post > 0.5) {
        c.popped = true;
        clack({ freq: 300, decay: 0.2, gain: 0.22 });
      }
    }

    /* ---- where the roving camera is pointed ---- */
    let pan: number;
    if (opening) {
      pan = c.pan;
      // before the first touch it leans toward the pointer — the invitation
      if (!c.touched) pan += state.pointer.x * 0.28;
    } else if (phase === "sealed") {
      pan = -1.4 + Math.sin(e * 0.32) * 0.16 + state.pointer.x * 0.2; // idling, and curious
    } else if (phase === "preview") {
      pan = Math.sin(e * 0.45) * 1.35 + Math.sin(e * 0.17) * 0.24; // still looking
    } else {
      pan = YOU_X;
    }

    /* ---- the Mexican wave ---- */
    // Deterministic outside `opening` so every idle phase has one rolling through and
    // `revealed` stays alive as a frozen frame; state-driven on the near-misses.
    let waveX = 0;
    let waveAmp = 0;
    if (opening) {
      if (c.waveAt >= 0) {
        const u = e - c.waveAt;
        if (u < WAVE_DUR) {
          waveX = c.waveFrom + c.waveDir * u * WAVE_SPEED;
          waveAmp = Math.sin((u / WAVE_DUR) * Math.PI);
        }
      }
    } else {
      const period = phase === "preview" ? 7.5 : phase === "revealed" ? 5.0 : 12.0;
      const u = e % period;
      if (u < WAVE_DUR) {
        waveX = -13 + u * WAVE_SPEED;
        waveAmp = Math.sin((u / WAVE_DUR) * Math.PI);
      }
    }
    waveAmp *= phase === "sealed" ? 0.55 : 1;

    /* ---- the stand ---- */
    // The roar dies down without ever going quiet — a stadium after a goal is not a
    // library, and `revealed` sits at the tail of this curve rather than at its peak.
    const party = found * (1 - 0.45 * clamp01((post - 2.4) / 2.0));
    const cm = crowdRef.current;
    if (cm) {
      for (let i = 0; i < CROWD; i++) {
        const bx = crowd.pos[i * 3];
        const ph = crowd.sway[i];
        const am = crowd.amp[i];
        const s = Math.sin(e * crowd.spd[i] + ph);

        // attention: how much of this person is watching the roving camera
        let att = 0;
        const ax = (bx - pan) * INV_ATT;
        if (ax * ax < 1) {
          const q = 1 - ax * ax;
          att = q * q;
        }

        // the wave, skewed by row so it sweeps up the bank rather than arriving flat
        let w = 0;
        if (waveAmp > 0) {
          const wx = (bx + crowd.row[i] * 1.4 - waveX) * INV_WAVE;
          if (wx * wx < 1) {
            const q = 1 - wx * wx;
            w = q * q * q * waveAmp;
          }
        }

        // and when it lands, the whole stand turns — from your row outward, because
        // the people beside you find out first
        const dxy = bx - YOU_X;
        const turn = clamp01(found * 2.2 - Math.abs(dxy) * 0.12);

        // one celebration sine per person, spent twice — 7800 of them is not free
        const cheer = Math.sin(e * 6 + ph);
        const bounce = party * (0.5 + 0.5 * cheer) * 0.075 * am;
        _obj.position.set(
          bx + s * 0.012 * am + (YOU_X - bx) * 0.014 * turn,
          crowd.pos[i * 3 + 1] + Math.abs(s) * 0.02 * am + w * 0.08 + att * 0.016 + bounce,
          crowd.pos[i * 3 + 2],
        );
        const sc = 0.052;
        _obj.scale.set(sc, sc * (1 + w * 0.55 + party * 0.06), sc);
        _obj.rotation.set(-w * 0.16, 0, s * 0.05 * am - Math.sign(dxy) * 0.26 * turn);
        _obj.updateMatrix();
        cm.setMatrixAt(i, _obj.matrix);

        const k = 0.72 + att * 0.55 + w * 0.5 + party * 0.3 * (0.6 + 0.4 * cheer);
        _col.setRGB(crowd.col[i * 3] * k, crowd.col[i * 3 + 1] * k, crowd.col[i * 3 + 2] * k);
        cm.setColorAt(i, _col);
      }
      cm.instanceMatrix.needsUpdate = true;
      if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
    }

    /* ---- the roving camera's pool of light ---- */
    if (spotRef.current && spotMatRef.current) {
      // it tightens on you with an overshoot, the way a broadcast zoom lands
      const z = lerp(1, LOCK_ZOOM, post < 0 ? 0 : easeOutBack(clamp01(post / 0.75)));
      spotRef.current.position.x = pan;
      spotRef.current.position.y = -0.24 + Math.sin(e * 1.7) * 0.006;
      spotRef.current.scale.set(z, z * (1 + 0.03 * Math.sin(e * 2.3)), 1);
      spotMatRef.current.opacity =
        (phase === "sealed" ? 0.13 + 0.03 * Math.sin(e * 1.1) : 0.24 + found * 0.42) * hum(e, 0.7);
    }

    /* ---- the two of you, in row whatever ---- */
    if (boxRef.current) {
      const near = 1 - Math.min(1, Math.abs(pan - YOU_X) / 0.35);
      // anticipation on the near pass, then the punch when it stops
      const up = Math.max(near * 0.45, post < 0 ? 0 : easeOutBack(clamp01(post / 0.6)));
      boxRef.current.scale.setScalar(lerp(1, 1.2, up));
      boxRef.current.position.y = -0.28 + up * 0.05 + party * Math.abs(Math.sin(e * 5.4)) * 0.024;
      boxRef.current.rotation.z = Math.sin(e * 1.3) * 0.03 + party * Math.sin(e * 5.4) * 0.05;
    }

    /* ---- the person who does get picked ---- */
    const miss = opening && c.missAt >= 0 ? t - c.missAt : -1;
    if (pickedRef.current && waveArmRef.current && restArmRef.current) {
      const rise = miss >= 0 ? easeOutBack(clamp01(miss / 0.3)) * (1 - clamp01((miss - (MISS_SHOW - 0.45)) / 0.45)) : 0;
      pickedRef.current.visible = rise > 0.01;
      pickedRef.current.position.set(c.missX, -0.3 + rise * 0.035, 0.55);
      pickedRef.current.scale.setScalar(Math.max(0, rise));
      // the arm goes up first and *then* waves — a wave that starts mid-air is a flag
      const raise = clamp01((miss - 0.12) / 0.3);
      waveArmRef.current.rotation.z = lerp(0.2, 2.7, easeOutCubic(raise)) + Math.sin(e * 11) * 0.42 * raise;
      restArmRef.current.rotation.z = -0.25 + Math.sin(e * 3.1) * 0.12;
      pickedRef.current.rotation.z = Math.sin(e * 5) * 0.05 * raise;
    }

    /* ---- the screen ---- */
    // The advert does not fade — it collapses to a line and blinks out, the way a
    // feed cutting over does. That cut IS the reveal's first beat.
    const cut = post < 0 ? 0 : clamp01(post / 0.16);
    if (adRef.current && adMatRef.current) {
      adRef.current.visible = cut < 1;
      adRef.current.scale.y = Math.max(0.012, 1 - easeOutCubic(cut));
      adMatRef.current.color.setScalar(lerp(0.92 + 0.08 * Math.sin(e * 30), 2.4, cut));
    }
    if (cutRef.current && cutMatRef.current) {
      // the white line the tube leaves behind
      const f = post < 0 ? 0 : Math.exp(-Math.max(0, post - 0.14) * 13) * clamp01(post / 0.1);
      cutMatRef.current.opacity = f * 0.95;
      cutRef.current.visible = f > 0.01;
      cutRef.current.scale.set(1, lerp(0.02, 1, clamp01(1 - cut)), 1);
    }
    if (rollRef.current && rollMatRef.current) {
      // a stadium screen never quite syncs; the bar rolls down it forever
      rollRef.current.position.y = SCREEN_H * 0.5 - ((e * 0.34) % 1) * SCREEN_H;
      rollMatRef.current.opacity = 0.05 + 0.05 * Math.sin(e * 0.8) + (post >= 0 && post < 0.5 ? 0.3 : 0);
    }
    if (nameRef.current && nameMatRef.current) {
      const k = phase === "preview" ? 0.1 + 0.14 * (0.5 + 0.5 * Math.sin(e * 0.8)) : clamp01((post - 0.34) / 0.5);
      nameMatRef.current.opacity = k;
      // they arrive with a punch and settle, and then they never sit quite still
      const pop = phase === "preview" ? 1 : lerp(0.82, 1, easeOutBack(clamp01((post - 0.34) / 0.55)));
      nameRef.current.scale.setScalar(pop * (1 + 0.008 * Math.sin(e * 1.6)));
      nameMatRef.current.color.setScalar(1 + 0.06 * Math.sin(e * 2.4) + party * 0.12);
    }
    if (bodyMatRef.current) bodyMatRef.current.opacity = phase === "preview" ? 0.15 : clamp01((post - NAMES_AT) / 0.8);
    if (frameMatRef.current) {
      const k = phase === "preview" ? 0.2 : clamp01((post - 0.24) / 0.7);
      frameMatRef.current.opacity = k * (0.72 + 0.28 * Math.sin(e * 3.2));
    }
    if (bloomMatRef.current) {
      // bloom by geometry: the panel spilling over its own bezel, no post-processing
      const lit = phase === "preview" ? 0.22 : lerp(0.2, 0.62, found);
      bloomMatRef.current.opacity = lit * hum(e, 1.9) * (1 + (post >= 0 && post < 0.3 ? 1.4 : 0));
    }
    if (groanMatRef.current) {
      // the near-miss caption, only while it is still landing on other people
      const want = miss >= 0 && miss < MISS_SHOW && c.lockAt < 0 ? 1 : 0;
      groanMatRef.current.opacity += (want - groanMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- the floodlights ---- */
    for (let i = 0; i < flareRefs.current.length; i++) {
      const m = flareRefs.current[i];
      if (!m) continue;
      const ph = (i / 3) | 0 ? 2.1 : 0;
      const h = hum(e, ph);
      // they come up hard on the lock and hold — the light change is what sells it
      const burst = 1 + found * 0.55 + (post >= 0 && post < 0.4 ? 1.6 * (1 - post / 0.4) : 0);
      const mat = m.material as THREE.MeshBasicMaterial;
      const kind = i % 3;
      mat.opacity = (kind === 0 ? 0.9 : kind === 1 ? 0.3 : 0.42) * h * burst;
      const s = h * (1 + (burst - 1) * 0.22);
      if (kind === 0) m.scale.set(s, s, 1);
      else if (kind === 1) m.scale.set(s * 1.04, s * 1.04, 1);
      else m.scale.set(s * 1.1, s, 1);
    }

    /* ---- confetti from the tier above ---- */
    // In `revealed` the clock is `post`, which is frozen — so the pieces ride wall time
    // there instead, and a stopped render still catches them mid-air.
    const confT = phase === "revealed" ? e + POST_END : post;
    const im = confRef.current;
    if (im) {
      const breeze = Math.sin(e * 0.37) * 0.6 + Math.sin(e * 0.13) * 0.3;
      for (let i = 0; i < CONFETTI; i++) {
        const u = confT < 0 ? -1 : (confT - 0.45 - CONF.delay[i]) * CONF.fall[i];
        if (u < 0) {
          _obj.scale.setScalar(0);
          _obj.position.set(0, 3, 0);
          _obj.rotation.set(0, 0, 0);
        } else {
          const k = u % 2.9; // recycled, so the tier above never runs out
          const ph = CONF.ph[i];
          _obj.position.set(
            CONF.x[i] + Math.sin(k * 1.7 + ph) * CONF.drift[i] + breeze * k * 0.11,
            CONF.y[i] - k * 1.15,
            CONF.z[i] + Math.sin(k * 1.1 + ph) * 0.1,
          );
          // three axes at three rates: a falling scrap never spins about one
          _obj.rotation.set(k * CONF.tilt[i], k * CONF.spin[i] * 0.62 + ph, Math.sin(k * 3.1 + ph) * 0.6);
          // Pieces start between y 1.7 and 3.2 and the cycle only drops them 3.3, so
          // over half of them would wrap while still inside the frame — a scrap
          // teleporting back to the tier above. Taper both ends of the cycle instead.
          const sc = CONF.scale[i] * clamp01(k * 4) * clamp01((2.9 - k) * 2.2);
          _obj.scale.set(sc, sc, sc);
        }
        _obj.updateMatrix();
        im.setMatrixAt(i, _obj.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }

    /* ---- the invitation, which stops the instant you touch it ---- */
    if (hintMatRef.current) {
      const inviting = phase === "sealed" || (opening && !c.touched && c.lockAt < 0);
      const want = inviting ? (0.26 + 0.2 * Math.sin(e * 2.7)) * (c.hover ? 1.5 : 1) : 0;
      hintMatRef.current.opacity += (want - hintMatRef.current.opacity) * Math.min(1, dt * 4);
    }

    /* ---- the camera: a push-in on the lock, and then it holds too long ---- */
    const cam = camRef.current;
    if (cam) {
      const punch = post < 0 ? 0 : easeOutBack(clamp01(post / 0.9));
      let cx: number;
      let cy = CAM_Y;
      let cz = CAM_Z;
      if (phase === "preview") {
        cx = Math.sin(e * 0.16) * 0.13;
        cy += Math.sin(e * 0.23) * 0.02;
        cz += 0.06 * Math.sin(e * 0.11);
      } else if (phase === "sealed") {
        cx = state.pointer.x * 0.06;
        cy += Math.sin(e * 0.5) * 0.012;
      } else {
        cx = pan * 0.08 * (1 - punch);
      }
      cz -= CAM_PUNCH * punch;
      cy += 0.06 * punch;
      if (found > 0.5) {
        // handheld: an operator holding a shot he knows is the shot
        const hold = (found - 0.5) * 2;
        cx += (Math.sin(e * 0.71) * 0.012 + Math.sin(e * 1.93) * 0.005) * hold;
        cy += (Math.sin(e * 0.53) * 0.009 + Math.sin(e * 2.31) * 0.004) * hold;
      }
      // `opening` is the only phase that earns a lerp; every other one must be right
      // on the frame it is asked for, because reduced motion may only render forty.
      if (opening) cam.position.lerp(_cam.set(cx, cy, cz), Math.min(1, dt * 5));
      else cam.position.set(cx, cy, cz);
      cam.lookAt(0, 0.15 + 0.12 * punch, 0);
    }

    // The camera holds a beat too long, the way it always does.
    if (opening && post > POST_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={[0, CAM_Y, CAM_Z]} fov={46} />
      <ambientLight intensity={st.amb} />
      <directionalLight position={[0, 4, 3]} intensity={1.5} color={st.flood} />
      <pointLight position={[-3, 2.4, 2]} intensity={0.6} color={st.flood} />

      {/* night, and the far side of the bowl */}
      <mesh position={[0, 1.2, -9]}>
        <planeGeometry args={[40, 18]} />
        <meshBasicMaterial map={sky} depthWrite={false} />
      </mesh>

      <group ref={fitRef}>
        {/* floodlight pylons — a lamp is its flare, not its rectangle */}
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
            <mesh
              ref={(m) => {
                flareRefs.current[i * 3] = m;
              }}
              position={[0, 0, 0.02]}
            >
              <planeGeometry args={[1.5, 1.5]} />
              <meshBasicMaterial map={FLARE} color={st.flood} transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
            </mesh>
            <mesh
              ref={(m) => {
                flareRefs.current[i * 3 + 1] = m;
              }}
              position={[0, 0, 0.03]}
            >
              <planeGeometry args={[4.2, 4.2]} />
              <meshBasicMaterial map={FLARE} color={st.flood} transparent opacity={0.3} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
            </mesh>
            <mesh
              ref={(m) => {
                flareRefs.current[i * 3 + 2] = m;
              }}
              position={[0, 0, 0.04]}
            >
              <planeGeometry args={[4.6, 0.44]} />
              <meshBasicMaterial map={STREAK} color={st.flood} transparent opacity={0.42} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
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
          <mesh ref={adRef} position={[0, 0, 0.004]}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial ref={adMatRef} map={ad} transparent toneMapped={false} depthWrite={false} />
          </mesh>
          {/* the line the feed leaves behind when it cuts */}
          <mesh ref={cutRef} position={[0, 0, 0.006]} visible={false}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial ref={cutMatRef} color="#eaf4ff" transparent opacity={0} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
          </mesh>
          {/* the frame, then both names, then the message beneath */}
          <mesh position={[0, 0, 0.008]}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial ref={frameMatRef} map={frameTex} transparent opacity={0} depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh ref={nameRef} position={[0, SCREEN_H * 0.19, 0.012]}>
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
          {/* the bar that rolls down a screen that never quite syncs */}
          <mesh ref={rollRef} position={[0, 0, 0.016]}>
            <planeGeometry args={[SCREEN_W, 0.1]} />
            <meshBasicMaterial ref={rollMatRef} color="#cfe4ff" transparent opacity={0.06} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
          </mesh>
          {/* the LED lattice, over everything the panel is showing */}
          <mesh position={[0, 0, 0.018]}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial map={SCAN} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          {/* and the panel spilling over its own bezel */}
          <mesh position={[0, 0, 0.03]}>
            <planeGeometry args={[SCREEN_W * 1.75, SCREEN_H * 2.1]} />
            <meshBasicMaterial ref={bloomMatRef} map={FLARE} color={st.flood} transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
          </mesh>
        </group>

        {/* the stand — one draw call, and instanceColor is what carries the bands */}
        <instancedMesh ref={crowdRef} args={[undefined, undefined, CROWD]} geometry={crowdGeo} frustumCulled={false}>
          <meshLambertMaterial />
        </instancedMesh>

        {/* the roving camera's pool of light, sliding across the crowd */}
        <mesh ref={spotRef} position={[0, -0.24, 0.6]}>
          <circleGeometry args={[0.42, 32]} />
          <meshBasicMaterial ref={spotMatRef} map={HINT} color={st.flood} transparent opacity={0.24} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>

        {/* whoever it settles on instead — and they wave, because of course they do */}
        <group ref={pickedRef} position={[0, -0.3, 0.55]} visible={false}>
          <mesh geometry={crowdGeo} scale={0.075}>
            <meshStandardMaterial color="#e0b07a" roughness={0.85} />
          </mesh>
          {/* one hinge at the shoulder, the arm hanging below it — so a rotation about
              z is the whole difference between an arm down and an arm up */}
          <group ref={waveArmRef} position={[0.032, 0.03, 0.012]}>
            <mesh geometry={crowdGeo} position={[0, -0.045, 0]} scale={[0.022, 0.05, 0.022]}>
              <meshStandardMaterial color="#e8c9a4" roughness={0.85} />
            </mesh>
          </group>
          <group ref={restArmRef} position={[-0.032, 0.03, 0.012]}>
            <mesh geometry={crowdGeo} position={[0, -0.045, 0]} scale={[0.022, 0.05, 0.022]}>
              <meshStandardMaterial color="#e8c9a4" roughness={0.85} />
            </mesh>
          </group>
        </group>

        {/* the two of you, in row whatever */}
        <group ref={boxRef} position={[YOU_X, -0.28, 0.62]}>
          {[-0.06, 0.06].map((x, i) => (
            <mesh key={i} position={[x, 0, 0]} geometry={crowdGeo} scale={0.075}>
              <meshStandardMaterial color={i ? "#e8d7c0" : "#d46a72"} roughness={0.8} />
            </mesh>
          ))}
        </group>

        {/* confetti from the tier above — one draw call, 150 pieces, no two alike */}
        <instancedMesh ref={confRef} args={[undefined, undefined, CONFETTI]} geometry={confettiGeo} frustumCulled={false}>
          <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} />
        </instancedMesh>

        <mesh position={[YOU_X, -0.24, 1]}>
          <planeGeometry args={[1.4, 1.4]} />
          <meshBasicMaterial ref={hintMatRef} map={HINT} color={st.flood} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {phase === "opening" && (
        <mesh
          position={[0, 0, 1.6]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={stop}
          onPointerCancel={stop}
          onPointerOver={onOver}
          onPointerOut={stop}
        >
          <planeGeometry args={[12, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
