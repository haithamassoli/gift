import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutBack, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { resumeAudio, tone, clack } from "../audio";
import { forRecipient, type Lang } from "../../i18n";

/* ---------- the wax ---------- */
// The variant changes the *material*, not just a swatch. Crimson and midnight are
// near-dielectric wax (a soft body sheen, no metal), antique gold is a bronze
// sealing wax that catches the candle like polished metal — so `metal` and `rough`
// ride the palette, not a constant. `deep` is the colour in the recess of the
// pressed monogram (light never reaches the bottom of a stamp), `rim` is the hot
// edge the fresnel paints where the wax turns away from the flame.
interface Wax {
  base: string;
  deep: string;
  rim: string;
  ribbon: string; // the satin tail under the seal — a foil, not the wax colour again
  metal: number;
  rough: number;
}
const WAXES: Record<string, Wax> = {
  crimson: {
    base: "#a5152b", deep: "#560a15", rim: "#ff7a86", ribbon: "#d8b25a",
    metal: 0.05, rough: 0.32,
  },
  gold: {
    // antique bronze wax: the one that reads as metal, so it is the one given metalness
    base: "#b9852b", deep: "#5f3f10", rim: "#ffe0a0", ribbon: "#f2ead2",
    metal: 0.5, rough: 0.26,
  },
  midnight: {
    base: "#26364f", deep: "#0d1626", rim: "#7fa2dc", ribbon: "#c6cfda",
    metal: 0.16, rough: 0.3,
  },
};

type StampKind = "initials" | "heart" | "star";

/* ---------- the desk, in world units ---------- */
// The letter lies flat on the desk (XZ plane, y up). The camera looks down and
// forward, so +Z is the near edge under the reader's hand and -Z runs away up the
// screen — text authored top-toward-far reads the right way up from the near seat.
const SHEET_HALF_X = 0.9;
const SHEET_HALF_Z = 0.7;
const SHEET_CZ = -0.35; // the sheet sits back from the near edge, so the seal has room in front
const HINGE_Z = SHEET_CZ - SHEET_HALF_Z; // the flap's far pivot, the top of the folded letter (-1.05)
const SEAL_Z = 0.33; // near the flap's free edge, where a seal actually holds it shut
const SEAL_Y = 0.035; // the pool sits on top of the closed flap, a hair above the desk
const FLAP_Y = 0.022; // the folded flap floats over the sheet to keep the two off one plane

// The whole tableau — candle, wax, letter, stamp — spans about this wide; a phone
// in portrait is narrower than that, so the root group shrinks to keep it all framed.
const ACTION_W = 3.0;

/* ---------- opening timeline (seconds) ---------- */
// The no-input path has to finish under 12s (the bound is on onOpenComplete). Walked
// through with nobody touching anything:
//   melt (mercy) 5.2 → stamp falls 6.5 → imprint 7.0 → lift clear 7.95 →
//   unfold starts 8.45 → unfolded 9.95 → settle 10.55.
// The ~1.5s of slack is deliberate: `dt` is clamped to 0.05, so on a phone dropping
// frames this clock runs *behind* the wall clock the bound is measured on.
const MELT_MERCY0 = 2.4; // the flame starts melting it for them if they only watch
const MELT_MERCY_RAMP = 2.8; // …easing in, so it reads as the candle working, not a timer
const MELT_HOLD_TIME = 1.9; // an engaged press-and-hold pools the wax this fast instead
const STAMP_MERCY = 1.3; // then, left alone, the stamp comes down on its own
const PRESS_DUR = 0.5; // the die drops onto the pool
const PRESS_HOLD = 0.35; // …and rests a beat, the squish settling under it
const LIFT_DUR = 0.6; // then lifts, peeling the monogram out of the cooling wax
const RETURN_DUR = 0.7; // and drifts back to its rest pose beside the letter
const UNFOLD_DELAY = 0.5; // a breath after the seal is set before the letter opens
const UNFOLD_DUR = 1.5; // the flap swings back and the message is revealed
const SETTLE = 0.6;

/* ---------- stamp poses (group-space y; die bottom sits 0.08 below the group) ---------- */
const DIE_DROP = 0.08;
const REST_X = 0.98; // upright to the right of the letter, waiting
const REST_Y = FLAP_Y + DIE_DROP + 0.02;
const REST_Z = 0.14;
const PRESS_Y = 0.15 + DIE_DROP; // die face reaches the pooled wax
const READY_Y = PRESS_Y + 0.78; // hovering above the seal, ready to fall

/* ---------- shared sprites (palette-independent, so module scope like the exemplars) ---------- */
const glowTex = makeRadialSprite();
const flameTex = makeRadialSprite(64, [
  [0, "rgba(255,244,214,1)"],
  [0.4, "rgba(255,180,70,0.7)"],
  [1, "rgba(255,120,20,0)"],
]);
const steamTex = makeRadialSprite(64, [
  [0, "rgba(255,255,255,0.6)"],
  [0.5, "rgba(255,255,255,0.22)"],
  [1, "rgba(255,255,255,0)"],
]);

/* ---------- the desk: quarter-sawn wood, procedural ---------- */
// A flat brown plane reads as cardboard; wood is grain plus a few darker rays.
// One tileable canvas, warmed by the candle at render time via the standard material.
function buildWoodTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2a1a10";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(7412);
  // long grain: many faint vertical strokes, jittered in tone
  for (let i = 0; i < 220; i++) {
    const x = rand() * S;
    const w = 0.6 + rand() * 2.2;
    const shade = 20 + rand() * 40;
    g.strokeStyle = `rgba(${shade + 30},${shade + 12},${shade},${0.05 + rand() * 0.12})`;
    g.lineWidth = w;
    g.beginPath();
    // a gentle sinuous grain rather than a ruler-straight line
    g.moveTo(x, 0);
    for (let y = 0; y <= S; y += 16) g.lineTo(x + Math.sin(y * 0.05 + i) * 3, y);
    g.stroke();
  }
  // a couple of darker medullary rays for depth
  for (let i = 0; i < 6; i++) {
    const x = rand() * S;
    g.strokeStyle = `rgba(10,6,3,${0.1 + rand() * 0.12})`;
    g.lineWidth = 6 + rand() * 10;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + (rand() - 0.5) * 40, S);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2.4, 2.4);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const woodTex = buildWoodTexture();

/* ---------- an environment for the brass stamp to reflect ---------- */
// Metal lit only by point lights renders as scattered specular dots; a tiny equirect
// gives the brass something to be — the warm room, the cold window, the candle.
function buildEnvTexture(): THREE.Texture {
  const W = 128, H = 64;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#3a2a1a");
  sky.addColorStop(0.5, "#140d0a");
  sky.addColorStop(1, "#080506");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, col: string) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(30, 30, 22, "#ffd39a"); // the candle's warm pool
  blob(96, 24, 20, "#3a4c66"); // cold daylight from a window
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const envTex = buildEnvTexture();

/* ---------- the turned brass handle ---------- */
// A lathed baluster — the classic seal handle. The die (the stamping face) is a
// separate short cylinder below it, sized to the seal the pool will take.
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
const STAMP_PROFILE = [
  V2(0.0, 0.0), V2(0.17, 0.0), V2(0.175, 0.028), // the collar above the die
  V2(0.12, 0.05), V2(0.098, 0.12),
  V2(0.15, 0.2), V2(0.185, 0.3), // the belly of the grip
  V2(0.14, 0.4), V2(0.086, 0.52),
  V2(0.11, 0.6), V2(0.13, 0.66), // the finial knob
  V2(0.095, 0.72), V2(0.0, 0.742),
];
const stampHandleGeo = new THREE.LatheGeometry(STAMP_PROFILE, 44);
const DIE_R = 0.22;
const BRASS = new THREE.MeshStandardMaterial({
  color: "#c79b3e",
  roughness: 0.34,
  metalness: 0.95,
  envMap: envTex,
  envMapIntensity: 1.1,
});

// The wax body is one unit sphere, scaled per frame from a risen pool to a squashed
// disc — cheaper and smoother than remorphing a LatheGeometry every frame.
const SPHERE = new THREE.SphereGeometry(1, 32, 24);

/* ---------- steam ---------- */
// One thin wisp off the cooling seal. Positions are a closed form of a steam clock,
// so a cold reveal shows the same idle curl a live run settles into.
const STEAM_N = 26;
function buildSteam() {
  const rand = mulberry32(3391);
  const seed = new Float32Array(STEAM_N * 3); // phase, radius, rise-speed
  for (let i = 0; i < STEAM_N; i++) {
    seed[i * 3] = rand() * Math.PI * 2;
    seed[i * 3 + 1] = 0.02 + rand() * 0.05;
    seed[i * 3 + 2] = 0.5 + rand() * 0.6;
  }
  return { seed, pos: new Float32Array(STEAM_N * 3), col: new Float32Array(STEAM_N * 3) };
}
const STEAM = buildSteam();

/* ---------- molten drips off the wax stick ---------- */
const DRIP_N = 5;

/* ---------- the monogram, drawn as a pressed relief ---------- */
// The stamp presses a recess into the wax: the interior sits in shadow (`deep`), and
// the wall of the recess catches the candle on its up-left edge and shades on its
// down-right — a two-offset emboss reads as pressed-in without a normal map. Drawn
// once to a canvas and used as the seal disc's `map`, so the standard material lights
// it like the rest of the wax.
function drawMonogram(
  g: CanvasRenderingContext2D,
  kind: StampKind,
  initials: string,
  lang: Lang,
  S: number,
  ox: number,
  oy: number,
  fill: string,
) {
  const cx = S / 2 + ox;
  const cy = S / 2 + oy;
  g.fillStyle = fill;
  if (kind === "heart") {
    const r = S * 0.2;
    g.beginPath();
    g.moveTo(cx, cy + r * 0.9);
    g.bezierCurveTo(cx - r * 1.5, cy - r * 0.2, cx - r * 0.6, cy - r * 1.1, cx, cy - r * 0.35);
    g.bezierCurveTo(cx + r * 0.6, cy - r * 1.1, cx + r * 1.5, cy - r * 0.2, cx, cy + r * 0.9);
    g.fill();
  } else if (kind === "star") {
    const rO = S * 0.24, rI = rO * 0.42;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? rO : rI;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.closePath();
    g.fill();
  } else {
    // the initials: first letter of each name, monogram-style, side by side
    const family = lang === "ar" ? "'Thmanyah Sans', system-ui, sans-serif" : "Georgia, 'Times New Roman', serif";
    g.font = `700 ${Math.round(S * (initials.length > 1 ? 0.34 : 0.46))}px ${family}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (lang === "ar") g.direction = "rtl";
    g.fillText(initials, cx, cy + S * 0.02);
  }
}

function buildSealTexture(wax: Wax, kind: StampKind, initials: string, lang: Lang): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const R = S * 0.46;

  // the wax disc: domed, lighter at the crown where the light lands, darker at the rim
  const dome = g.createRadialGradient(S * 0.42, S * 0.4, R * 0.1, S / 2, S / 2, R);
  const base = new THREE.Color(wax.base);
  const crown = base.clone().lerp(new THREE.Color("#ffffff"), 0.18);
  const edge = base.clone().lerp(new THREE.Color(wax.deep), 0.55);
  dome.addColorStop(0, `#${crown.getHexString()}`);
  dome.addColorStop(0.7, `#${base.getHexString()}`);
  dome.addColorStop(1, `#${edge.getHexString()}`);
  g.beginPath();
  g.arc(S / 2, S / 2, R, 0, Math.PI * 2);
  g.fillStyle = dome;
  g.fill();

  // the wax squeezed up into a raised lip just inside the rim
  g.lineWidth = S * 0.03;
  g.strokeStyle = `#${crown.getHexString()}`;
  g.globalAlpha = 0.35;
  g.beginPath();
  g.arc(S / 2, S / 2, R * 0.86, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;

  // the pressed monogram: highlight edge, shadow edge, then the recess floor
  const hi = base.clone().lerp(new THREE.Color(wax.rim), 0.5);
  const sh = new THREE.Color(wax.deep).lerp(new THREE.Color("#000000"), 0.25);
  drawMonogram(g, kind, initials, lang, S, -2.5, -2.5, `#${hi.getHexString()}`);
  drawMonogram(g, kind, initials, lang, S, 2.5, 2.5, `#${sh.getHexString()}`);
  drawMonogram(g, kind, initials, lang, S, 0, 0, `#${wax.deep}`);

  // clip anything the emboss offsets pushed past the disc back inside the rim
  g.globalCompositeOperation = "destination-in";
  g.beginPath();
  g.arc(S / 2, S / 2, R, 0, Math.PI * 2);
  g.fillStyle = "#fff";
  g.fill();
  g.globalCompositeOperation = "source-over";

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ---------- the wax body material, with a candle-catching fresnel ---------- */
// A soft rim of the wax's own hot colour on the turning edge — what makes molten wax
// read as translucent and glossy rather than as painted clay. Injected into the
// standard material's emissive so it still takes the candle's key light and shadow.
function makeWaxMaterial(wax: Wax) {
  const mat = new THREE.MeshStandardMaterial({
    color: wax.base,
    roughness: wax.rough,
    metalness: wax.metal,
    envMap: envTex,
    envMapIntensity: 0.5,
    emissive: new THREE.Color(wax.deep),
    emissiveIntensity: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFresCol = { value: new THREE.Color(wax.rim) };
    shader.uniforms.uFresStr = { value: 0.55 };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 uFresCol;
uniform float uFresStr;`,
      )
      // emissivemap_fragment runs after the shading normal and vViewPosition are set
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        float wFres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.6);
        totalEmissiveRadiance += uFresCol * wFres * uFresStr;`,
      );
  };
  return mat;
}

/** First user-perceived character of a name — the letter that goes on the monogram. */
function firstGrapheme(s: string): string {
  const arr = Array.from(s.trim());
  return arr[0] ?? "";
}

export default function WaxSealScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const wax = WAXES[variants.wax] ?? WAXES.crimson;
  const stampKind: StampKind =
    variants.stamp === "heart" || variants.stamp === "star" ? variants.stamp : "initials";

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // The monogram's letters: the sender's and the recipient's initials, in the
  // scene's language so Arabic names render in Thmanyah, not tofu boxes.
  const initials = useMemo(() => {
    const a = firstGrapheme(senderName);
    const b = firstGrapheme(recipientName);
    // recipient first under rtl, matching the reading order the eye expects
    const two = lang === "ar" ? [b, a] : [a, b];
    return two.filter(Boolean).join(lang === "ar" ? " " : "·");
  }, [senderName, recipientName, lang]);

  /* useMemo is load-bearing: it owns the GPU resources. Palette/name-dependent ones
     live here and are disposed on change; palette-independent textures are module scope. */
  const waxMat = useMemo(() => makeWaxMaterial(wax), [wax]);
  useEffect(() => () => waxMat.dispose(), [waxMat]);

  const sealTex = useMemo(
    () => buildSealTexture(wax, stampKind, initials, lang),
    [wax, stampKind, initials, lang],
  );
  useEffect(() => () => sealTex.dispose(), [sealTex]);

  // The addressee, printed on the folded letter — the gallery card and the sealed
  // letter both show "For {name}", since the message itself is still under the flap.
  const addressee = useMemo(
    () => makeTextTexture(forRecipient(lang, recipientName), {
      fontSize: 72, fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: "500",
      color: "#40301f", maxWidthPx: 900, lang,
    }),
    [recipientName, lang],
  );
  useEffect(() => () => addressee.texture.dispose(), [addressee]);

  // The message, revealed on the opened sheet. Empty in preview, so nothing is built.
  const messageTex = useMemo(() => {
    const m = message.trim();
    if (!m) return null;
    return makeTextTexture(m, {
      fontSize: 60, fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: "400",
      color: "#3a2c1c", maxWidthPx: 760, lineHeight: 1.4, lang,
    });
  }, [message, lang]);
  useEffect(() => () => messageTex?.texture.dispose(), [messageTex]);

  /* ---------- refs (all per-frame writes go through these) ---------- */
  const fitRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const blobRef = useRef<THREE.Mesh>(null);
  const sealDiscRef = useRef<THREE.Mesh>(null);
  const oozeRef = useRef<THREE.Mesh>(null);
  const stampRef = useRef<THREE.Group>(null);
  const stickRef = useRef<THREE.Group>(null);
  const stickTipRef = useRef<THREE.Mesh>(null);
  const flapRef = useRef<THREE.Group>(null);
  const addrRef = useRef<THREE.Mesh>(null);
  const msgRef = useRef<THREE.Mesh>(null);
  const ribbonRef = useRef<THREE.Group>(null);
  const flameRef = useRef<THREE.Sprite>(null);
  const candleLightRef = useRef<THREE.PointLight>(null);
  const sealGlowRef = useRef<THREE.PointLight>(null);
  const steamRef = useRef<THREE.Points>(null);
  const dripRef = useRef<THREE.Points>(null);
  const hintRef = useRef<THREE.Mesh>(null);

  const dripBuf = useMemo(() => new Float32Array(DRIP_N * 3), []);
  const dripSeed = useMemo(() => {
    const rand = mulberry32(618);
    return Array.from({ length: DRIP_N }, () => ({ phase: rand(), off: (rand() - 0.5) * 0.12 }));
  }, []);

  /* The gesture's state machine. It only ever *advances*; every visual is a closed
     form of these, so the reduced-motion `revealed` mount can bypass it entirely. */
  const meltRef = useRef(0); // 0..1 pooled fraction (accumulated hold, floored by mercy)
  const meltDoneRef = useRef(-1); // t at which the pool finished, -1 until then
  const pressRef = useRef(-1); // t at which the stamp began to fall, -1 until then
  const imprintRef = useRef(false); // has the die bottomed out and struck the wax
  const holdRef = useRef(false); // is the pointer currently pressed
  const gestureRef = useRef(false); // has the first pointer landed (unlocks audio)

  // Replay re-enters "opening": reset the machine or the second run seals instantly.
  useLayoutEffect(() => {
    if (phase === "opening") {
      meltRef.current = 0;
      meltDoneRef.current = -1;
      pressRef.current = -1;
      imprintRef.current = false;
      holdRef.current = false;
    }
  }, [phase]);

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    if (!gestureRef.current) {
      gestureRef.current = true;
      resumeAudio();
    }
    holdRef.current = true;
    // once the pool is full, a press is the go-ahead to bring the stamp down
    if (meltDoneRef.current >= 0 && pressRef.current < 0) {
      pressRef.current = tRef.current;
    }
  };
  const release = () => {
    holdRef.current = false;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;

    /* fit the tableau into a portrait viewport */
    const fit = Math.max(0.62, Math.min(1, state.viewport.width / ACTION_W));
    fitRef.current?.scale.setScalar(fit);

    /* the whole desk leans a little toward the pointer — a hand tilting the page */
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, -state.pointer.y * 0.05, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.06, k);
    }

    /* ---------- resolve the four progress scalars this frame ---------- */
    // Every element below is posed from these. `revealed` writes the finished values
    // straight in; `opening` grows them from the clock and the melt meter.
    let meltP: number; // pooled wax, 0..1
    let squishP: number; // how flat the stamp has pressed the pool, 0..1
    let discP: number; // seal disc / monogram opacity as the die peels away, 0..1
    let oozeK: number; // the ring of squeezed-out wax, 0 (unborn) .. 1 (full, fading)
    let unfoldP: number; // the letter opening, 0 closed .. 1 flat
    let steamP: number; // steam intensity
    let addrP: number; // the addressee's fade
    let stampT = 0; // downward press amount for the stamp pose, 0..1
    let stampApproach = 0; // rest→ready blend, 0 at rest, 1 hovering over the seal
    let stampReturn = 0; // ready→rest drift after the lift, 0..1
    let waxGlow: number; // molten heat in the pool (emissive), cools to 0
    let hintA = 0; // the affordance nudging a first touch

    if (phase === "opening") {
      /* melt: an engaged hold pools it fast; left alone, the candle does it slowly */
      if (holdRef.current && meltDoneRef.current < 0) meltRef.current += dt / MELT_HOLD_TIME;
      const mercy = smooth(clamp01((t - MELT_MERCY0) / MELT_MERCY_RAMP));
      meltP = clamp01(Math.max(meltRef.current, mercy));
      if (meltP >= 1 && meltDoneRef.current < 0) meltDoneRef.current = t;
      const meltDone = meltDoneRef.current >= 0;

      // the stamp's fall: their press starts it, or STAMP_MERCY after the pool sets
      if (meltDone && pressRef.current < 0 && t - meltDoneRef.current > STAMP_MERCY) {
        pressRef.current = t;
      }
      stampApproach = meltDone ? easeInOut(clamp01((t - meltDoneRef.current) / 0.5)) : 0;

      const press = pressRef.current;
      if (press >= 0) {
        const tau = t - press;
        const descend = easeInOut(clamp01(tau / PRESS_DUR));
        const liftTau = tau - PRESS_DUR - PRESS_HOLD;
        const lift = liftTau > 0 ? easeInOut(clamp01(liftTau / LIFT_DUR)) : 0;
        stampT = clamp01(descend - lift); // down then back up
        if (descend >= 0.98 && !imprintRef.current) {
          imprintRef.current = true;
          // the strike: a dry percussive tap plus a soft low body — the wax "thunk"
          clack({ freq: 900, decay: 0.05, gain: 0.3 });
          tone(150, { type: "sine", seconds: 0.22, gain: 0.28 });
        }
        squishP = imprintRef.current ? 1 : smooth(descend);
        discP = imprintRef.current ? clamp01(lift * 1.4) : 0;
        oozeK = imprintRef.current ? clamp01(liftTau < 0 ? 0.02 : liftTau / 0.9 + 0.02) : 0;
        stampReturn = easeInOut(clamp01((liftTau - LIFT_DUR) / RETURN_DUR));
      } else {
        stampT = 0;
        squishP = 0;
        discP = 0;
        oozeK = 0;
      }

      // the seal is set once the die has fully lifted; then the letter opens
      const sealT = press >= 0 ? press + PRESS_DUR + PRESS_HOLD + LIFT_DUR : Infinity;
      const unfoldStart = sealT + UNFOLD_DELAY;
      unfoldP = t > unfoldStart ? easeInOut(clamp01((t - unfoldStart) / UNFOLD_DUR)) : 0;

      // heat: the pool glows while molten and cools once struck
      waxGlow = imprintRef.current
        ? lerp(0.5, 0, smooth(clamp01((t - (sealT - LIFT_DUR)) / 2.2)))
        : meltP * 0.5;
      steamP = imprintRef.current ? clamp01((t - sealT + LIFT_DUR) / 0.5) * lerp(1, 0.35, unfoldP) : 0;
      addrP = clamp01(1 - unfoldP * 1.6) * (1 - smooth(clamp01(meltP - 0.3)) * 0.15);
      // nudge a first touch until the wax starts pooling on its own
      hintA = clamp01((t - 0.8) / 0.8) * (1 - clamp01(meltP * 4));

      if (t > (Number.isFinite(sealT) ? unfoldStart + UNFOLD_DUR + SETTLE : Infinity) && !doneRef.current) {
        doneRef.current = true;
        onOpenComplete?.();
      }
    } else if (phase === "revealed") {
      // the finished piece, drawn cold — reduced motion mounts straight here
      meltP = 1;
      squishP = 1;
      discP = 1;
      oozeK = 1;
      unfoldP = 1;
      steamP = 0.35;
      addrP = 0;
      stampReturn = 1;
      stampApproach = 1;
      waxGlow = 0;
    } else if (phase === "preview") {
      // a living tableau: the flame breathes, the stamp waits, the letter is addressed
      meltP = 0;
      squishP = 0;
      discP = 0;
      oozeK = 0;
      unfoldP = 0;
      steamP = 0;
      addrP = 1;
      waxGlow = 0;
      hintA = 0;
    } else {
      // sealed: at rest, a gentle glow on the wax stick inviting the first press
      meltP = 0;
      squishP = 0;
      discP = 0;
      oozeK = 0;
      unfoldP = 0;
      steamP = 0;
      addrP = 1;
      waxGlow = 0;
      hintA = 0.4 + 0.25 * Math.sin(e * 1.8);
    }

    /* ---------- candle: the light everything is lit by ---------- */
    // A candle never burns steady — a fast flutter under a slow sway. The flame sprite,
    // the point light and (below) the metal all ride the same flicker so they agree.
    const flick = 0.82 + 0.12 * Math.sin(e * 17 + Math.sin(e * 6.3)) + 0.06 * Math.sin(e * 41);
    if (flameRef.current) {
      flameRef.current.scale.set(0.16 * flick, 0.3 * flick, 0.16);
      flameRef.current.position.x = -1.05 + Math.sin(e * 9) * 0.006;
    }
    if (candleLightRef.current) candleLightRef.current.intensity = 2.3 * flick;

    /* ---------- the wax pool / seal body ---------- */
    // Grows out of nothing as it melts, then the stamp squashes it flat into a disc
    // with a touch of overshoot — the game-feel squish. Volume is loosely conserved:
    // as it flattens (sy down) it spreads (sxz up).
    const blob = blobRef.current;
    if (blob) {
      const grow = 0.16 + meltP * 0.14; // base radius of the risen pool
      const flat = lerp(1, 0.28, squishP); // vertical crush
      const spread = lerp(1, 1.5, easeOutBack(clamp01(squishP)) * (squishP > 0 ? 1 : 0));
      blob.visible = meltP > 0.02;
      blob.scale.set(grow * spread, grow * flat, grow * spread);
      const bm = blob.material as THREE.MeshStandardMaterial;
      bm.emissiveIntensity = waxGlow;
    }
    if (sealGlowRef.current) sealGlowRef.current.intensity = waxGlow * 2.2 + steamP * 0.05;

    /* the pressed monogram disc, peeled into view as the die lifts */
    const disc = sealDiscRef.current;
    if (disc) {
      disc.visible = discP > 0.01;
      const dm = disc.material as THREE.MeshStandardMaterial;
      dm.opacity = clamp01(discP);
      // rides exactly on the squished pool's crown (blob.scale.y is the pool's half-height)
      disc.position.y = SEAL_Y + (blob ? blob.scale.y : 0.084) + 0.004;
    }

    /* the ooze ring: wax squeezed from under the die, expanding and thinning */
    const ooze = oozeRef.current;
    if (ooze) {
      ooze.visible = oozeK > 0.01;
      const k = clamp01(oozeK);
      ooze.scale.setScalar(lerp(0.7, 1.5, easeOutCubic(k)));
      (ooze.material as THREE.MeshStandardMaterial).opacity = (1 - smooth(k)) * 0.9;
      ooze.position.y = SEAL_Y + 0.01;
    }

    /* ---------- the stamp ---------- */
    // Rest → hover over the seal → down → up → drift back to rest, all closed-form.
    const stamp = stampRef.current;
    if (stamp) {
      let x = lerp(REST_X, 0, stampApproach);
      let z = lerp(REST_Z, SEAL_Z, stampApproach);
      let y = lerp(REST_Y, READY_Y, stampApproach);
      // the fall
      y = lerp(y, PRESS_Y, stampT);
      // the drift home once it has lifted clear
      x = lerp(x, REST_X, stampReturn);
      z = lerp(z, REST_Z, stampReturn);
      y = lerp(y, REST_Y, stampReturn);
      stamp.position.set(x, y, z);
      // upright at rest, a small eager tilt while it hovers, dead-straight on the strike
      const tilt = 0.12 * stampApproach * (1 - stampT) * (1 - stampReturn);
      stamp.rotation.z = tilt * Math.sin(e * 4) * 0.3 - tilt;
      // a ready-to-press bob when hovering and waiting
      if (phase === "opening" && stampApproach > 0.9 && pressRef.current < 0) {
        stamp.position.y += Math.sin(e * 3.4) * 0.03;
      }
    }

    /* ---------- the wax stick, dipping over the flame while melting ---------- */
    const stick = stickRef.current;
    if (stick) {
      const melting = phase === "opening" && meltDoneRef.current < 0 && meltP > 0.001;
      const dip = melting ? 0.18 + 0.05 * Math.sin(e * 5) : 0;
      stick.rotation.z = -0.7 - dip; // tilts its tip down toward the flame and the pool
      stick.position.y = lerp(0.62, 0.5, meltP) + (melting ? Math.sin(e * 4) * 0.01 : 0);
      // once the pool is set the stick withdraws upward, out of the way
      if (phase === "opening" && meltDoneRef.current >= 0) {
        stick.position.y += clamp01((t - meltDoneRef.current) / 0.6) * 0.5;
      }
      stick.visible = phase !== "revealed";
    }
    if (stickTipRef.current) {
      const hot = phase === "opening" && meltDoneRef.current < 0 ? meltP : 0;
      (stickTipRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = hot * 0.9;
    }

    /* ---------- molten drips falling from the tip to the pool ---------- */
    const drips = dripRef.current;
    if (drips) {
      const active = phase === "opening" && meltDoneRef.current < 0 && meltP > 0.05;
      const pa = drips.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < DRIP_N; i++) {
        if (!active) {
          pa.setXYZ(i, 0, -99, 0);
          continue;
        }
        // each drip loops from the tip down to the pool, phased apart
        const f = (e * (0.6 + i * 0.05) + dripSeed[i].phase) % 1;
        const x = lerp(-0.4, 0.02, f) + dripSeed[i].off;
        const y = lerp(0.5, SEAL_Y + 0.08, easeOutCubic(f)); // accelerating fall
        const z = lerp(0.2, SEAL_Z, f);
        pa.setXYZ(i, x, y, z);
      }
      pa.needsUpdate = true;
      drips.visible = active;
    }

    /* ---------- the letter, unfolding ---------- */
    // The flap swings from closed (folded over the sheet, PI about the far hinge) to
    // open (flat, continuing away up the desk), revealing the message beneath it.
    if (flapRef.current) flapRef.current.rotation.x = lerp(Math.PI, 0, unfoldP);
    if (addrRef.current) {
      (addrRef.current.material as THREE.MeshBasicMaterial).opacity = addrP;
      addrRef.current.visible = addrP > 0.01;
    }
    if (msgRef.current && messageTex) {
      // fades in only after the flap is well clear of it
      (msgRef.current.material as THREE.MeshBasicMaterial).opacity = smooth(clamp01((unfoldP - 0.55) / 0.4));
      msgRef.current.visible = unfoldP > 0.55;
    }

    /* the ribbon appears with the seal and dangles toward the reader */
    if (ribbonRef.current) {
      ribbonRef.current.visible = discP > 0.05 || phase === "revealed";
      const sway = Math.sin(e * 1.4) * 0.03;
      ribbonRef.current.rotation.z = sway;
    }

    /* ---------- steam: one thin wisp off the cooling seal ---------- */
    const steam = steamRef.current;
    if (steam) {
      const pa = steam.geometry.attributes.position as THREE.BufferAttribute;
      const ca = steam.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < STEAM_N; i++) {
        const ph = STEAM.seed[i * 3];
        const rad = STEAM.seed[i * 3 + 1];
        const spd = STEAM.seed[i * 3 + 2];
        const age = (e * 0.28 * spd + ph / 6.28) % 1;
        const rise = age * 0.55;
        const curl = Math.sin(age * 6 + ph) * (0.02 + age * 0.05);
        pa.setXYZ(
          i,
          curl + Math.cos(ph) * rad * (1 - age),
          SEAL_Y + 0.14 + rise,
          SEAL_Z + Math.sin(ph) * rad * (1 - age),
        );
        const a = Math.sin(age * Math.PI) * steamP * 0.5;
        ca.setXYZ(i, a, a, a);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
      steam.visible = steamP > 0.01;
    }

    /* ---------- the affordance ---------- */
    if (hintRef.current) {
      const m = hintRef.current.material as THREE.MeshBasicMaterial;
      m.opacity += (hintA * 0.5 - m.opacity) * Math.min(1, dt * 4);
      hintRef.current.visible = m.opacity > 0.005;
      hintRef.current.scale.setScalar(1 + Math.sin(e * 2.4) * 0.12);
    }
  });

  /* message plane sizing: fit within the sheet, leaving the seal its room at the front */
  const msgW = messageTex ? Math.min(1.5, (2 * SHEET_HALF_X - 0.2)) : 0;
  const msgH = messageTex ? Math.min(1.05, msgW * messageTex.aspect) : 0;
  const addrW = Math.min(1.4, 2 * SHEET_HALF_X - 0.3);
  const addrH = addrW * addressee.aspect;

  return (
    <>
      {/* looking down and forward onto the desk, aimed between the seal and the message */}
      <PerspectiveCamera makeDefault position={[0, 2.9, 3.1]} fov={42} onUpdate={(c) => c.lookAt(0, 0.05, -0.32)} />

      {/* candle-lit: a warm ambient floor, a soft key for shape, and the flame's own point */}
      <ambientLight intensity={0.28} color="#ffdca8" />
      <directionalLight position={[-1.5, 3, 2]} intensity={0.5} color="#ffe6c0" />
      <directionalLight position={[2.5, 1.5, -1]} intensity={0.25} color="#4a5f80" />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          {/* the desk */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.1]}>
            <planeGeometry args={[9, 9]} />
            <meshStandardMaterial map={woodTex} color="#6a4426" roughness={0.85} metalness={0.05} />
          </mesh>

          {/* the letter's lower sheet — the message lives here, hidden until the flap opens */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, -0.35]}>
            <planeGeometry args={[2 * SHEET_HALF_X, 2 * SHEET_HALF_Z]} />
            <meshStandardMaterial color="#efe4cf" roughness={0.9} metalness={0} />
          </mesh>
          {messageTex && (
            <mesh ref={msgRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, -0.42]} visible={false}>
              <planeGeometry args={[msgW, msgH]} />
              <meshBasicMaterial map={messageTex.texture} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </mesh>
          )}

          {/* the flap, hinged at the far top edge; folded over the sheet when closed */}
          <group ref={flapRef} position={[0, FLAP_Y, HINGE_Z]} rotation={[Math.PI, 0, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -SHEET_HALF_Z]}>
              <planeGeometry args={[2 * SHEET_HALF_X, 2 * SHEET_HALF_Z]} />
              <meshStandardMaterial color="#f3e9d6" roughness={0.9} metalness={0} side={THREE.DoubleSide} />
            </mesh>
          </group>

          {/* the addressee, sitting on the closed flap; fades as the letter opens.
              Kept in world space (not parented to the flap) so its text stays upright
              and legible — the flap's own faces flip as it swings. */}
          <mesh ref={addrRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLAP_Y + 0.014, -0.35]}>
            <planeGeometry args={[addrW, addrH]} />
            <meshBasicMaterial map={addressee.texture} transparent opacity={1} depthWrite={false} toneMapped={false} />
          </mesh>

          {/* the wax pool → the pressed seal body */}
          <mesh ref={blobRef} geometry={SPHERE} material={waxMat} position={[0, SEAL_Y, SEAL_Z]} visible={false} />
          {/* the monogram, pressed into the cooling wax */}
          <mesh ref={sealDiscRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, SEAL_Y + 0.16, SEAL_Z]} visible={false}>
            <circleGeometry args={[0.3, 40]} />
            <meshStandardMaterial map={sealTex} transparent opacity={0} roughness={wax.rough} metalness={wax.metal} envMap={envTex} envMapIntensity={0.45} />
          </mesh>
          {/* the ring of wax squeezed out from under the die */}
          <mesh ref={oozeRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, SEAL_Y + 0.01, SEAL_Z]} visible={false}>
            <ringGeometry args={[0.26, 0.33, 40]} />
            <meshStandardMaterial color={wax.base} transparent opacity={0} roughness={wax.rough} metalness={wax.metal} />
          </mesh>
          <pointLight ref={sealGlowRef} position={[0, SEAL_Y + 0.2, SEAL_Z]} intensity={0} color={wax.rim} distance={2} decay={1.6} />

          {/* the ribbon, dangling from the seal toward the reader */}
          <group ref={ribbonRef} position={[0, SEAL_Y, SEAL_Z]} visible={false}>
            {[-1, 1].map((s) => (
              <mesh key={s} rotation={[-Math.PI / 2 + 0.12, 0, s * 0.18]} position={[s * 0.05, 0.005, 0.34]}>
                <planeGeometry args={[0.12, 0.72]} />
                <meshStandardMaterial color={wax.ribbon} roughness={0.5} metalness={0.25} side={THREE.DoubleSide} envMap={envTex} />
              </mesh>
            ))}
          </group>

          {/* steam wisp off the cooling seal */}
          <points ref={steamRef} frustumCulled={false} visible={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[STEAM.pos, 3]} />
              <bufferAttribute attach="attributes-color" args={[STEAM.col, 3]} />
            </bufferGeometry>
            <pointsMaterial map={steamTex} vertexColors size={0.12} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} />
          </points>

          {/* the candle */}
          <group position={[-1.05, 0, -0.15]}>
            <mesh position={[0, 0.28, 0]}>
              <cylinderGeometry args={[0.12, 0.13, 0.56, 24]} />
              <meshStandardMaterial color="#e8dcc2" roughness={0.7} metalness={0} />
            </mesh>
            {/* wick */}
            <mesh position={[0, 0.57, 0]}>
              <cylinderGeometry args={[0.008, 0.008, 0.05, 6]} />
              <meshStandardMaterial color="#2a2018" roughness={1} />
            </mesh>
            <sprite ref={flameRef} position={[0, 0.66, 0]} scale={[0.16, 0.3, 0.16]}>
              <spriteMaterial map={flameTex} color="#ffca70" transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
            </sprite>
            <pointLight ref={candleLightRef} position={[0, 0.62, 0.05]} intensity={2.3} color="#ffb454" distance={7} decay={1.4} />
          </group>

          {/* the stick of sealing wax, held over the flame — the thing you press-and-hold */}
          <group ref={stickRef} position={[-0.5, 0.6, 0.2]} rotation={[0, 0, -0.7]}>
            {/* the cylinder is rotated onto the group's X so the stick lies along its length */}
            <mesh position={[0.3, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.055, 0.055, 0.7, 16]} />
              <meshStandardMaterial color={wax.base} roughness={wax.rough + 0.15} metalness={wax.metal} envMap={envTex} envMapIntensity={0.35} />
            </mesh>
            {/* the molten tip, glowing while it melts */}
            <mesh ref={stickTipRef} position={[-0.06, 0, 0]}>
              <sphereGeometry args={[0.06, 16, 12]} />
              <meshStandardMaterial color={wax.base} roughness={wax.rough} metalness={wax.metal} emissive={new THREE.Color(wax.rim)} emissiveIntensity={0} />
            </mesh>
          </group>
          {/* molten drips */}
          <points ref={dripRef} frustumCulled={false} visible={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[dripBuf, 3]} />
            </bufferGeometry>
            <pointsMaterial map={glowTex} color={wax.rim} size={0.07} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} />
          </points>

          {/* the brass stamp: a lathed handle over a stamping die */}
          <group ref={stampRef} position={[REST_X, REST_Y, REST_Z]}>
            <mesh geometry={stampHandleGeo} material={BRASS} />
            <mesh position={[0, -DIE_DROP + 0.04, 0]} material={BRASS}>
              <cylinderGeometry args={[DIE_R, DIE_R * 0.96, 0.08, 40]} />
            </mesh>
          </group>

          {/* the affordance: a soft glow over the wax stick, nudging the first press */}
          <mesh ref={hintRef} position={[-0.2, 0.5, 0.25]} visible={false}>
            <circleGeometry args={[0.3, 24]} />
            <meshBasicMaterial map={glowTex} color="#ffdca0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
          </mesh>

          {/* the interaction surface: a flat, invisible catch over the desk. Press-and-hold
              anywhere to melt; once the pool sets, a press brings the stamp down. Only
              mounted while it is wanted. */}
          {phase === "opening" && (
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0.4, 0.2]}
              onPointerDown={onDown}
              onPointerUp={release}
              onPointerLeave={release}
              onPointerCancel={release}
            >
              <planeGeometry args={[4, 3]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          )}
        </group>
      </group>
    </>
  );
}
