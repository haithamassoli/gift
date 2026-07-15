import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { pluck, resumeAudio } from "../audio";
import { makeRadialSprite } from "../sprites";
import { sampleTextPoints, makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeOutCubic, lerp, mulberry32 } from "../math";
import { pick } from "../catalog";
import { forRecipient } from "../../i18n";

/* ============================================================================
 * THE OUD — the region's heart-instrument, and unlike the music-box it does not
 * play itself: it answers your fingers. You PLUCK a string (tap) or STRUM across
 * (drag); each true note releases a breath of light-motes from the rosette that
 * fly up and, over the plucks, assemble the message hanging in the lamplight.
 * After the last note the phrase plays itself back — a short taqsim flourish —
 * and the message settles, with the names inlaid in mother-of-pearl below.
 *
 * The pluck feel is the whole gift, so the audio is the validated Karplus-Strong
 * `pluck` from ../audio and nothing more; this file only decides *which* note,
 * *when*, and what the light does in answer.
 * ==========================================================================*/

/* ---------- wood: body colour + the pluck's resonant box ---------------------
 * variants.wood tints the bowl/neck and, more quietly, the pluck's low-pass
 * cutoff (`body`): a honey oud is a bright, open box; ebony is darker and woodier.
 * The soundboard (face) is a paler spruce so the variant reads even on the near-
 * black ebony, where a body-coloured face would vanish into the backdrop. */
interface Wood {
  face: string; // spruce soundboard
  body: string; // the bowl of staves + neck
  rim: string; // the darker edge binding, and the shadowed underside of the bowl
  bodyHz: number; // pluck() low-pass cutoff — the timbre of the box
}
const WOODS: Record<string, Wood> = {
  honey: { face: "#dcab68", body: "#a56e2d", rim: "#6d451b", bodyHz: 3100 },
  walnut: { face: "#c1905a", body: "#5f3c22", rim: "#3a2413", bodyHz: 2550 },
  // A pale spruce face over a near-black bowl — the most dramatic of the three,
  // and the reason the face is not tinted by `body`.
  ebony: { face: "#cbb083", body: "#231b16", rim: "#0f0b08", bodyHz: 2050 },
};

/* ---------- maqam: the actual scale the strings are tuned to -----------------
 * variants.maqam is not decoration — it is what the instrument plays. Seven
 * strings, string i tuned to the i-th degree of the maqam, so a tap sounds one
 * note and a strum arpeggiates up the scale. Frequencies are equal-tempered
 * approximations from a low tonic (D3); Arabic maqamat use neutral (three-quarter)
 * steps, which the fractional semitone offsets below stand in for — enough of the
 * flavour to be recognisably hijaz / nahawand / rast without a microtonal engine. */
const TONIC = 146.83; // D3 — the oud sits low; Karplus-Strong is warmest here
const st = (semitones: number) => TONIC * Math.pow(2, semitones / 12);
const MAQAMS: Record<string, number[]> = {
  // b2 then a leap to the major 3rd — the augmented-2nd gap (1 -> 4) is the whole
  // signature of hijaz, the "Andalusian" colour.
  hijaz: [0, 1, 4, 5, 7, 8, 11].map(st),
  // natural minor — the pensive, familiar one.
  nahawand: [0, 2, 3, 5, 7, 8, 10].map(st),
  // neutral 3rd and 7th (the .5s) give rast its warm, not-quite-major cast.
  rast: [0, 2, 3.5, 5, 7, 9, 10.5].map(st),
};
const N_STRINGS = 7;

/* ---------- the instrument's local geometry (before the group is fit) --------
 * The face lies in the z=0 plane facing the camera; the bowl bulges behind it.
 * Strings run in +y from the bridge (low on the belly) up over the soundhole to
 * the nut (top of the neck). Everything is authored here in local units and the
 * whole group is uniformly scaled to the viewport at the top of every frame. */
const FACE_Z = 0;
const STR_Z = 0.07; // strings float a hair off the soundboard
const HIT_Z = 0.22; // the invisible playing surface, in front of the strings
const ROSE = new THREE.Vector3(0, 0.15, 0.11); // soundhole/rosette centre — motes are born here
const ROSE_R = 0.42; // soundhole radius
const BRIDGE_Y = -0.72; // strings anchor here
const NUT_Y = 2.0; // …and terminate here, at the top of the neck
const STR_HALF_W = 0.22; // strings span x ∈ [-0.22, 0.22]
const NECK_TOP = 2.55;

/* the message, hanging in front of the upper body in the lamplight */
const MSG_W = 1.5; // world width the assembled phrase is scaled to
const MSG_CY = 0.62; // its centre, up over the soundhole/neck
const MSG_Z = 0.6; // floated well in front, so it reads over the dark wood

/* ---------- opening timeline (seconds) ---------------------------------------
 * The whole show must finish inside the 12s onOpenComplete bound even if the
 * recipient never touches a string, so the mercy path is the budget:
 *   T_MERCY_MAX + DONE_AFTER = 5.5 + 3.7 = 9.2s, with slack for a phone dropping
 * frames (dt is clamped, so this clock runs behind the wall clock the bound is on). */
const FLIGHT = 1.3; // a released mote's flight from rosette to its place
const T_MERCY_MAX = 5.5; // if they never play, the oud starts its own taqsim here
const TAQSIM_FILL = 1.8; // the flourish sweeps the remaining motes up over this long
const DONE_AFTER = 3.7; // TAQSIM_FILL + FLIGHT + a beat to settle
const VIB_HZ = 13; // a plucked string's visible shimmer (kept under 60Hz Nyquist)
const VIB_DECAY = 0.5; // how fast a pluck's vibration dies back to stillness
const VIB_AMP0 = 0.05; // peak sideways swing of a freshly plucked string (local units)
const VIB_IDLE = 0.006; // faint sympathetic shiver, always present

// The taqsim: a fixed melodic run over the seven strings — up the maqam, a turn
// at the top, and back down — as note {string index, seconds-from-start}. Audio
// and the visible string-shimmer are both keyed to these offsets.
const TAQSIM: { idx: number; off: number }[] = [0, 2, 4, 6, 5, 3, 4, 2, 0, 1, 3, 5, 6].map(
  (idx, i) => ({ idx, off: i * 0.15 }),
);

/* ---------- the mother-of-pearl rosette --------------------------------------
 * A geometric nacre lattice over the soundhole: concentric rings, radial spokes
 * and a ring of small circles — a mandala, drawn once to a transparent canvas and
 * laid over the dark hole. Iridescence is faked by shifting each ring's tint a
 * touch through pearl-blue / pearl-rose / warm gold. It is where every letter of
 * light is born, so it wants to look worth being born from. */
function makeRosetteTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const g = canvas.getContext("2d")!;
  const cx = S / 2;
  const cy = S / 2;
  const R = S / 2 - 4;
  const tints = ["#eef2ff", "#f6e9f4", "#fff2d8", "#e8f4f0"]; // the nacre sheen, cycled per ring
  g.lineWidth = 2.2;
  // concentric rings
  for (let k = 1; k <= 7; k++) {
    g.strokeStyle = tints[k % tints.length];
    g.globalAlpha = 0.85 - k * 0.05;
    g.beginPath();
    g.arc(cx, cy, (R * k) / 7, 0, Math.PI * 2);
    g.stroke();
  }
  // radial spokes
  const spokes = 16;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    g.strokeStyle = tints[k % tints.length];
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.stroke();
  }
  // a ring of little pearls two-thirds out, the classic oud rosette detail
  g.globalAlpha = 0.95;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2 + Math.PI / spokes;
    const rr = R * 0.68;
    g.fillStyle = tints[(k + 2) % tints.length];
    g.beginPath();
    g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 4.5, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

/* The pear silhouette of the soundboard, drawn once as a THREE.Shape. Widest at
 * the belly, narrowing to the neck join at the top — the oud's whole profile. */
function buildFaceShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0, 1.0); // neck join, top-centre
  s.bezierCurveTo(0.55, 0.95, 0.9, 0.2, 0.86, -0.35); // right shoulder down to the belly
  s.bezierCurveTo(0.82, -0.9, 0.5, -1.18, 0, -1.18); // right belly to the rounded bottom
  s.bezierCurveTo(-0.5, -1.18, -0.82, -0.9, -0.86, -0.35);
  s.bezierCurveTo(-0.9, 0.2, -0.55, 0.95, 0, 1.0);
  return s;
}

const STR_SEG = 26; // vertices along each vibrating string

export default function OudScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const wood = WOODS[variants.wood] ?? WOODS.honey;
  const scale = MAQAMS[variants.maqam] ?? MAQAMS.hijaz;

  /* The phrase that assembles. On the gallery card `message` is "", so the
   * recipient dedication stands in — writing in light is this gift's signature and
   * the preview should hint at it even before the reveal owns it. */
  const written = message.trim();
  const messageSource = written || forRecipient(lang, recipientName);

  /* ---------- the message, as ordered motes of light -------------------------
   * sampleTextPoints rasterizes through a 2D canvas, so the bidi and Arabic
   * ligature shaping are already correct — all that is missing is the *order* the
   * motes should arrive in. We sort them into reading order (top line first, then
   * along the reading direction) so the phrase writes itself letter-by-letter as
   * plucks release successive chunks — and, crucially, that ordering is correct
   * for Arabic too, where a left-to-right sweep would read wrong. Capped at 900
   * points: bounded per-frame work, still a dense, legible cloud. */
  const msg = useMemo(() => {
    const tp = sampleTextPoints(messageSource, {
      maxPoints: 900,
      fontSize: 66,
      fontWeight: "600",
      fontFamily: "Georgia, 'Times New Roman', serif",
      maxWidthPx: 66 * 9,
      lineHeight: 1.3,
      lang,
    });
    const P = tp.count;
    // reading-order sort (mirrors orderWritePath's key, but over the sampled cloud)
    const top = ((tp.lineCount - 1) / 2) * tp.lineSpacing;
    const lineOf = (i: number) =>
      Math.min(tp.lineCount - 1, Math.max(0, Math.round((top - tp.points[i * 2 + 1]) / tp.lineSpacing)));
    const dir = lang === "ar" ? -1 : 1;
    const order = Array.from({ length: P }, (_, i) => i).sort(
      (a, b) =>
        lineOf(a) - lineOf(b) ||
        dir * (tp.points[a * 2] - tp.points[b * 2]) ||
        tp.points[b * 2 + 1] - tp.points[a * 2 + 1],
    );

    const target = new Float32Array(P * 3); // where each mote settles, in local units
    const start = new Float32Array(P * 3); // where it is born, scattered inside the rosette
    const rand = mulberry32(4488);
    for (let i = 0; i < P; i++) {
      const id = order[i];
      target[i * 3] = tp.points[id * 2] * MSG_W;
      target[i * 3 + 1] = tp.points[id * 2 + 1] * MSG_W + MSG_CY;
      target[i * 3 + 2] = MSG_Z;
      const a = rand() * Math.PI * 2;
      const rr = rand() * ROSE_R * 0.45;
      start[i * 3] = ROSE.x + Math.cos(a) * rr;
      start[i * 3 + 1] = ROSE.y + Math.sin(a) * rr;
      start[i * 3 + 2] = ROSE.z + (rand() - 0.5) * 0.05;
    }
    // The render buffer, parked off-screen until motes are released. Only ever
    // mutated in useFrame through the geometry attribute's `.array` (never by this
    // name), so it stays a read-only memo value as far as the hooks lint is concerned.
    const pos = new Float32Array(P * 3).fill(-999);
    return { P, target, start, pos };
  }, [messageSource, lang]);

  /* ---------- the seven strings ---------------------------------------------
   * Each string is a THREE.Line of STR_SEG+1 vertices we bend per frame. Lines
   * render hairline-thin, which is exactly what an oud string is; a bright pale
   * material reads it against the dark wood. The memo owns the objects (read in
   * render for the <primitive>s); the per-frame bend goes through a group ref, so
   * the geometry is only ever mutated via a ref — never the memo return. */
  const strings = useMemo(() => {
    const lines: THREE.Line[] = [];
    const xs: number[] = [];
    const mat = new THREE.LineBasicMaterial({ color: "#f4ead2", transparent: true, opacity: 0.9, toneMapped: false });
    for (let i = 0; i < N_STRINGS; i++) {
      const x = lerp(-STR_HALF_W, STR_HALF_W, i / (N_STRINGS - 1));
      xs.push(x);
      const arr = new Float32Array((STR_SEG + 1) * 3);
      for (let s = 0; s <= STR_SEG; s++) {
        arr[s * 3] = x;
        arr[s * 3 + 1] = lerp(BRIDGE_Y, NUT_Y, s / STR_SEG);
        arr[s * 3 + 2] = STR_Z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      lines.push(new THREE.Line(geo, mat));
    }
    return { lines, xs, mat };
  }, []);
  useEffect(
    () => () => {
      strings.mat.dispose();
      for (const l of strings.lines) l.geometry.dispose();
    },
    [strings],
  );

  const roseTex = useMemo(() => makeRosetteTexture(), []);
  useEffect(() => () => roseTex.dispose(), [roseTex]);
  const moteSprite = useMemo(
    () =>
      makeRadialSprite(48, [
        [0, "rgba(255,246,214,1)"],
        [0.4, "rgba(255,220,150,0.7)"],
        [1, "rgba(255,196,110,0)"],
      ]),
    [],
  );
  useEffect(() => () => moteSprite.dispose(), [moteSprite]);
  const glowSprite = useMemo(() => makeRadialSprite(64), []);
  useEffect(() => () => glowSprite.dispose(), [glowSprite]);

  // The pear silhouette, built once — a THREE.Shape is curve data, not a GPU
  // resource, but it has no business being re-allocated in the render body.
  const faceShape = useMemo(() => buildFaceShape(), []);

  /* the names, inlaid in mother-of-pearl below the strings. Preview/sealed/opening
   * show the dedication; only the reveal earns both names. */
  const nameData = useMemo(() => {
    const r = recipientName.trim();
    const s = senderName.trim();
    let text: string;
    if (phase === "revealed" && (r || s)) {
      const from = s ? pick(lang, `from ${s}`, `من ${s}`) : "";
      text = [r, from].filter(Boolean).join("\n");
    } else {
      text = forRecipient(lang, recipientName);
    }
    const t = makeTextTexture(text, {
      fontSize: 52,
      fontWeight: "600",
      fontFamily: "Georgia, 'Times New Roman', serif",
      color: "#f3f0ff", // nacre
      glow: 8,
      glowColor: "#b9c6e0",
      maxWidthPx: 52 * 9,
      lineHeight: 1.28,
      lang,
    });
    let w = 0.95;
    let h = w * t.aspect;
    const maxH = 0.4;
    if (h > maxH) {
      const k = maxH / h;
      w *= k;
      h = maxH;
    }
    return { tex: t.texture, w, h };
  }, [recipientName, senderName, lang, phase]);
  useEffect(() => {
    const d = nameData;
    return () => d.tex.dispose();
  }, [nameData]);

  /* ---------- refs mutated per frame ---------------------------------------- */
  const rootRef = useRef<THREE.Group>(null);
  const fitRef = useRef<THREE.Group>(null);
  const stringsGroupRef = useRef<THREE.Group>(null);
  const motesRef = useRef<THREE.Points>(null);
  const roseGlintRef = useRef<THREE.Mesh>(null);
  const hintRef = useRef<THREE.Mesh>(null);
  const msgGlowRef = useRef<THREE.Mesh>(null); // the warm halo the assembled message hangs in
  const lampRef = useRef<THREE.PointLight>(null);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);

  // per-run opening state, all reset on the dirty pass below
  const vibTRef = useRef(new Float32Array(N_STRINGS).fill(-1)); // last-pluck time per string
  const releaseTRef = useRef(new Float32Array(0)); // per-mote release time (-1 = unborn); sized to msg.P in the dirty pass
  const releasedRef = useRef(0); // how many motes have been released so far
  const taqsimAtRef = useRef(-1); // when the auto-flourish began (-1 = not yet)
  const scheduledRef = useRef(false); // guard: taqsim audio scheduled exactly once
  const cursorRef = useRef(0); // next taqsim note to fire visibly
  const lastStrumRef = useRef(-1); // last string a drag crossed (so a strum doesn't re-pluck it)
  const dirtyRef = useRef(true);

  /* The motes and per-run counters accumulate, so — like foggy-mirror's mask —
   * they are rebuilt from `phase` alone: a replay re-scatters them, and reduced
   * motion lands on `revealed` having never run `opening`. */
  useLayoutEffect(() => {
    dirtyRef.current = true;
  }, [phase, msg, strings]);

  const CHUNK = Math.max(1, Math.ceil(msg.P / N_STRINGS)); // one strum up the scale ≈ the whole phrase

  /** Release motes up to index `n` (exclusive), staggering their births slightly. */
  const releaseUpTo = (n: number, tt: number) => {
    const from = releasedRef.current;
    if (n <= from) return;
    const releaseT = releaseTRef.current;
    for (let i = from; i < n; i++) releaseT[i] = tt + (i - from) * 0.01;
    releasedRef.current = n;
  };

  /** A true note: sound it, shiver the string, and let the next breath of light go. */
  const pluckString = (idx: number) => {
    resumeAudio(); // browsers only start audio inside a gesture — this is the gesture
    pluck(scale[idx], { body: wood.bodyHz, gain: 0.5, damping: 0.995, seed: idx * 7 + 1 });
    vibTRef.current[idx] = tRef.current;
    releaseUpTo(Math.min(msg.P, releasedRef.current + CHUNK), tRef.current);
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const el = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const opening = phase === "opening";
    const revealed = phase === "revealed";

    /* ---------- fit the whole instrument to the viewport --------------------
     * The oud is narrow and tall; scale it to the visible height, capped by width
     * so an extreme portrait phone never clips its shoulders. The content centre
     * (~y 0.6, between the belly bottom and the pegbox) is parked at world 0. */
    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const DESIGN_H = 3.9; // belly bottom (-1.25) to pegbox top (2.6), plus the nameplate
    const DESIGN_W = 1.9;
    const fit = Math.min((vh * 0.9) / DESIGN_H, (vw * 0.92) / DESIGN_W);
    if (fitRef.current) {
      fitRef.current.scale.setScalar(fit);
      fitRef.current.position.y = -0.6 * fit;
    }

    /* ---------- the dirty pass: rebuild per-run state from phase ------------- */
    if (dirtyRef.current) {
      dirtyRef.current = false;
      vibTRef.current.fill(-1);
      releasedRef.current = 0;
      taqsimAtRef.current = -1;
      scheduledRef.current = false;
      cursorRef.current = 0;
      lastStrumRef.current = -1;
      if (releaseTRef.current.length !== msg.P) releaseTRef.current = new Float32Array(msg.P);
      releaseTRef.current.fill(-1);
      if (revealed) releasedRef.current = msg.P; // cold: the phrase is already whole
    }

    /* ---------- opening logic: plucking, mercy, and the taqsim -------------- */
    if (opening) {
      // If they never touch a string — or once they have released the whole phrase
      // themselves — the oud takes over and plays the closing flourish.
      if (
        taqsimAtRef.current < 0 &&
        ((releasedRef.current >= msg.P && msg.P > 0 && t > 1.0) || t >= T_MERCY_MAX)
      ) {
        taqsimAtRef.current = t;
        // schedule the whole flourish's audio in one pass, ahead of the clock.
        if (!scheduledRef.current) {
          scheduledRef.current = true;
          resumeAudio();
          for (const n of TAQSIM) {
            pluck(scale[n.idx], { body: wood.bodyHz, gain: 0.42, damping: 0.995, when: n.off, seed: n.idx * 7 + 3 });
          }
        }
      }
      if (taqsimAtRef.current >= 0) {
        const since = t - taqsimAtRef.current;
        // sweep any motes the player left unreleased up into the phrase
        releaseUpTo(Math.min(msg.P, Math.ceil(msg.P * clamp01(since / TAQSIM_FILL))), t);
        // fire the visible string-shimmer for each note as the clock reaches it
        while (cursorRef.current < TAQSIM.length && since >= TAQSIM[cursorRef.current].off) {
          vibTRef.current[TAQSIM[cursorRef.current].idx] = t;
          cursorRef.current++;
        }
        if (t > taqsimAtRef.current + DONE_AFTER && !doneRef.current) {
          doneRef.current = true;
          onOpenComplete?.();
        }
      }
    }

    /* ---------- the strings, vibrating -------------------------------------- */
    // A plucked string swings in its first mode: a half-sine pinned at both ends,
    // ringing at VIB_HZ and dying over VIB_DECAY. Every string also carries a faint
    // idle shiver — the sympathetic shimmer the brief asks for, and the sealed
    // instrument's sign of life. During the sealed phase that shiver swells a touch,
    // an affordance that the strings are the thing to touch.
    const idleGain = phase === "sealed" ? 1.9 + Math.sin(el * 3) * 0.6 : phase === "preview" ? 1.2 : 0.8;
    const sGroup = stringsGroupRef.current;
    for (let i = 0; sGroup && i < N_STRINGS; i++) {
      const line = sGroup.children[i] as THREE.Line;
      const posA = line.geometry.attributes.position as THREE.BufferAttribute;
      const arr = posA.array as Float32Array; // reached via the group ref — safe to mutate
      const x0 = strings.xs[i];
      const age = vibTRef.current[i] >= 0 ? t - vibTRef.current[i] : Infinity;
      const plucked = Number.isFinite(age); // a real, aging pluck vs. a never-touched string
      const pluckAmp = plucked ? VIB_AMP0 * Math.exp(-age / VIB_DECAY) : 0;
      const idle = VIB_IDLE * idleGain;
      // phase of the two components; lower strings swing a hair wider and slower
      const w = VIB_HZ * (0.85 + 0.05 * i);
      // A never-plucked string carries age=Infinity, and Math.sin(Infinity) is NaN;
      // `0 * NaN` is still NaN, so the old `pluckAmp * sin(...)` poisoned every vertex
      // of all seven unplucked strings (the 7 computeBoundingSphere NaN warnings at
      // mount, and again cold in `revealed`). Gate the swing on an actual pluck.
      const pluckSwing = plucked ? pluckAmp * Math.sin(age * w * Math.PI * 2) : 0;
      for (let s = 0; s <= STR_SEG; s++) {
        const u = s / STR_SEG;
        const shape = Math.sin(Math.PI * u); // pinned at bridge and nut
        const dx = pluckSwing * shape + idle * Math.sin(el * 6 + i + u * 4) * shape;
        arr[s * 3] = x0 + dx;
        arr[s * 3 + 2] = STR_Z + pluckSwing * shape * 0.35; // a little toward the camera, too
      }
      posA.needsUpdate = true;
    }

    /* ---------- the motes of light ----------------------------------------- */
    const showMotes = opening || revealed;
    if (motesRef.current) {
      motesRef.current.visible = showMotes;
      if (showMotes) {
        const posA = motesRef.current.geometry.attributes.position as THREE.BufferAttribute;
        const arr = posA.array as Float32Array; // the render buffer, mutated only here
        const releaseT = releaseTRef.current;
        for (let i = 0; i < msg.P; i++) {
          // revealed draws every mote home at once (the cold / reduced-motion target);
          // opening flies only the released ones and hides the rest off-screen.
          let e: number;
          if (revealed) e = 1;
          else {
            const rt = releaseT[i];
            if (rt < 0) {
              arr[i * 3 + 1] = -999;
              continue;
            }
            e = easeOutCubic(clamp01((t - rt) / FLIGHT));
          }
          const settle = 0.008 * Math.sin(el * 1.6 + i * 0.5) * e; // a gentle hover once home
          arr[i * 3] = lerp(msg.start[i * 3], msg.target[i * 3], e) + settle;
          arr[i * 3 + 1] = lerp(msg.start[i * 3 + 1], msg.target[i * 3 + 1], e) + settle * 0.6;
          arr[i * 3 + 2] = lerp(msg.start[i * 3 + 2], msg.target[i * 3 + 2], e);
        }
        posA.needsUpdate = true;
      }
    }

    /* ---------- the message's backing halo ---------------------------------- */
    if (msgGlowRef.current) {
      const m = msgGlowRef.current.material as THREE.MeshBasicMaterial;
      msgGlowRef.current.visible = showMotes;
      if (showMotes) {
        // swells as the phrase gathers; full and steady once revealed (the cold path)
        const frac = msg.P > 0 ? releasedRef.current / msg.P : 0;
        m.opacity = (revealed ? 0.42 : 0.42 * frac) * (0.85 + 0.15 * Math.sin(el * 1.6));
      }
    }

    /* ---------- rosette glint, the hint band, and the lamp ------------------ */
    if (roseGlintRef.current) {
      const m = roseGlintRef.current.material as THREE.MeshBasicMaterial;
      // it glints in the lamplight; brighter as motes are actively pouring out of it
      const pouring = opening && releasedRef.current < msg.P ? 0.25 : 0;
      m.opacity = 0.28 + 0.14 * Math.sin(el * 1.7) + pouring;
    }
    if (hintRef.current) {
      // sealed only: a soft highlight sweeps across the strings — "play me"
      const m = hintRef.current.material as THREE.MeshBasicMaterial;
      const on = phase === "sealed";
      hintRef.current.visible = on;
      if (on) {
        hintRef.current.position.x = Math.sin(el * 1.1) * STR_HALF_W;
        hintRef.current.position.y = lerp(BRIDGE_Y, NUT_Y, 0.5);
        m.opacity = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(el * 2.2));
      }
    }
    if (lampRef.current) {
      // the lamp breathes; a touch brighter while the piece is open
      const base = phase === "sealed" ? 2.0 : revealed || opening ? 2.8 : 2.4;
      lampRef.current.intensity = base + Math.sin(el * 0.8) * 0.25;
    }

    /* ---------- idle sway (never during the performance) -------------------- */
    if (rootRef.current) {
      const amp = phase === "preview" ? 0.1 : revealed ? 0.06 : phase === "sealed" ? 0.04 : 0;
      rootRef.current.rotation.y = Math.sin(el * 0.4) * amp;
      rootRef.current.rotation.z = Math.sin(el * 0.33) * amp * 0.3;
    }
  });

  return (
    <>
      {/* Slightly high and angled, the way an oud rests across a lap under a lamp. */}
      <PerspectiveCamera makeDefault position={[0, 0.15, 5]} fov={44} />
      {/* lamplight. The old rig read as a near-black silhouette under the app's ACES
       * tone mapping: a near-black ambient (#3a2c22 @0.28 ≈ 0.05 white-equivalent, the
       * darkest of any scene) plus a single inverse-square pointLight as the only key,
       * which lands ~0.2 at the subject. The fix matches the visible siblings: a warm
       * near-white ambient at their level, and a warm directionalLight KEY (no distance
       * falloff) from the upper right. The breathing lamp stays as a warm near-source on
       * top (softer decay so it's felt), with a cool fill behind. */}
      <ambientLight intensity={0.5} color="#ffddb4" />
      <directionalLight position={[2.4, 2.5, 3]} intensity={1.45} color="#ffd7a0" />
      <pointLight ref={lampRef} position={[2.4, 2.2, 3]} intensity={2.2} color="#ffce8a" distance={12} decay={1.5} />
      <directionalLight position={[-2, 1, 2]} intensity={0.5} color="#8ea6c8" />

      {/* the cushion + the dark room behind it (never scene.background) */}
      <mesh position={[0, -1.7, -0.6]} rotation={[-Math.PI / 2.3, 0, 0]}>
        <circleGeometry args={[3.2, 40]} />
        <meshStandardMaterial color="#2a1522" roughness={0.95} metalness={0} />
      </mesh>
      <mesh position={[0, 0.4, -3]}>
        <planeGeometry args={[18, 14]} />
        <meshStandardMaterial color="#0c0710" roughness={1} metalness={0} />
      </mesh>

      <group ref={rootRef}>
        <group ref={fitRef}>
          {/* ---- the bowl, bulging behind the soundboard for roundness ---- */}
          <mesh position={[0, -0.2, -0.42]} scale={[0.92, 1.02, 0.62]}>
            <sphereGeometry args={[0.98, 40, 32]} />
            {/* a touch of self-glow tinted to the wood keeps the bowl reading as lamplit
             * wood rather than a black silhouette, and lifts the near-black ebony bowl off
             * the void without flattening the honey/walnut variants. */}
            <meshStandardMaterial color={wood.body} emissive={wood.body} emissiveIntensity={0.16} roughness={0.5} metalness={0.15} />
          </mesh>
          {/* a darker binding just behind the face rim, so the edge reads as a lip */}
          <mesh position={[0, 0, -0.03]} scale={1.04}>
            <shapeGeometry args={[faceShape]} />
            <meshStandardMaterial color={wood.rim} roughness={0.6} metalness={0.1} />
          </mesh>

          {/* ---- the soundboard (spruce face) ---- */}
          <mesh position={[0, 0, FACE_Z]}>
            <shapeGeometry args={[faceShape]} />
            <meshStandardMaterial color={wood.face} roughness={0.45} metalness={0.05} />
          </mesh>

          {/* ---- soundhole: the dark cavity, then the nacre rosette, then a glint ---- */}
          <mesh position={[ROSE.x, ROSE.y, FACE_Z + 0.005]}>
            <circleGeometry args={[ROSE_R, 48]} />
            <meshStandardMaterial color="#0a0705" roughness={0.9} metalness={0} />
          </mesh>
          <mesh position={[ROSE.x, ROSE.y, FACE_Z + 0.012]}>
            <planeGeometry args={[ROSE_R * 2, ROSE_R * 2]} />
            <meshBasicMaterial map={roseTex} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          <mesh ref={roseGlintRef} position={[ROSE.x, ROSE.y, FACE_Z + 0.02]}>
            <planeGeometry args={[ROSE_R * 2.6, ROSE_R * 2.6]} />
            <meshBasicMaterial
              map={glowSprite}
              color="#ffe6b0"
              transparent
              opacity={0.3}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* ---- bridge (strings anchor here) + nut (top terminus) ---- */}
          <mesh position={[0, BRIDGE_Y, FACE_Z + 0.03]}>
            <boxGeometry args={[STR_HALF_W * 2.4, 0.08, 0.05]} />
            <meshStandardMaterial color={wood.rim} roughness={0.4} metalness={0.2} />
          </mesh>
          <mesh position={[0, NUT_Y + 0.02, FACE_Z + 0.04]}>
            <boxGeometry args={[STR_HALF_W * 2.3, 0.05, 0.06]} />
            <meshStandardMaterial color="#e8dcc0" roughness={0.5} metalness={0.1} />
          </mesh>

          {/* ---- the neck, and the sharply back-angled pegbox with its pegs ---- */}
          <mesh position={[0, (1.0 + NUT_Y) / 2, -0.06]}>
            <boxGeometry args={[STR_HALF_W * 2.3, NUT_Y - 1.0 + 0.2, 0.22]} />
            {/* same faint self-glow as the bowl, so the neck reads as lamplit wood too */}
            <meshStandardMaterial color={wood.body} emissive={wood.body} emissiveIntensity={0.16} roughness={0.45} metalness={0.15} />
          </mesh>
          <group position={[0, NUT_Y + 0.05, -0.08]} rotation={[-0.5, 0, 0]}>
            <mesh position={[0, (NECK_TOP - NUT_Y) / 2, 0]}>
              <boxGeometry args={[STR_HALF_W * 2.1, NECK_TOP - NUT_Y, 0.2]} />
              <meshStandardMaterial color={wood.rim} roughness={0.4} metalness={0.2} />
            </mesh>
            {/* pegs poking out both cheeks */}
            {Array.from({ length: 6 }).map((_, k) => {
              const side = k < 3 ? -1 : 1;
              const yy = 0.12 + (k % 3) * 0.14;
              return (
                <mesh
                  key={k}
                  position={[side * (STR_HALF_W * 1.15), yy, 0]}
                  rotation={[0, 0, Math.PI / 2]}
                >
                  <cylinderGeometry args={[0.032, 0.045, 0.16, 10]} />
                  <meshStandardMaterial color="#1c130d" roughness={0.5} metalness={0.25} />
                </mesh>
              );
            })}
          </group>

          {/* ---- the strings (bent per frame via stringsGroupRef) ---- */}
          <group ref={stringsGroupRef}>
            {strings.lines.map((line, i) => (
              <primitive key={i} object={line} />
            ))}
          </group>

          {/* ---- the playing surface: invisible, but it catches every tap/drag ----
               uv.x across it maps straight to the string field, so which string was
               struck is independent of the group's live fit-scale. */}
          <mesh
            position={[0, (BRIDGE_Y + NUT_Y) / 2, HIT_Z]}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              if (phase !== "opening") return; // sealed→opening is the host's tap, not ours
              const localX = (ev.uv!.x - 0.5) * (STR_HALF_W * 2.8);
              let idx = 0;
              let best = Infinity;
              for (let i = 0; i < N_STRINGS; i++) {
                const d = Math.abs(localX - strings.xs[i]);
                if (d < best) {
                  best = d;
                  idx = i;
                }
              }
              lastStrumRef.current = idx;
              pluckString(idx);
            }}
            onPointerMove={(ev) => {
              if (phase !== "opening" || (ev.buttons ?? 0) === 0) return;
              ev.stopPropagation();
              // a drag across the strings strums: pluck each newly-crossed string once
              const localX = (ev.uv!.x - 0.5) * (STR_HALF_W * 2.8);
              let idx = 0;
              let best = Infinity;
              for (let i = 0; i < N_STRINGS; i++) {
                const d = Math.abs(localX - strings.xs[i]);
                if (d < best) {
                  best = d;
                  idx = i;
                }
              }
              if (idx !== lastStrumRef.current) {
                lastStrumRef.current = idx;
                pluckString(idx);
              }
            }}
            onPointerUp={(ev) => {
              ev.stopPropagation();
              lastStrumRef.current = -1;
            }}
          >
            <planeGeometry args={[STR_HALF_W * 2.8, NUT_Y - BRIDGE_Y]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>

          {/* the sealed affordance: a soft highlight sweeping the strings */}
          <mesh ref={hintRef} position={[0, 0.5, STR_Z + 0.03]} visible={false}>
            <planeGeometry args={[0.3, NUT_Y - BRIDGE_Y]} />
            <meshBasicMaterial
              map={glowSprite}
              color="#ffe8b8"
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* ---- the names, inlaid in mother-of-pearl below the strings ---- */}
          <mesh position={[0, BRIDGE_Y - 0.32, FACE_Z + 0.02]}>
            <planeGeometry args={[nameData.w, nameData.h]} />
            <meshBasicMaterial map={nameData.tex} transparent depthWrite={false} toneMapped={false} />
          </mesh>

          {/* a warm halo the assembled message hangs in — the dedicated backing glow
               every sibling gives its light-text (a short-range light or an additive
               plane), which the oud lacked, so the glyphs read as light in the lamplight
               and not faint specks. Driven in useFrame; on only while the message shows. */}
          <mesh ref={msgGlowRef} position={[0, MSG_CY, MSG_Z - 0.05]} visible={false}>
            <planeGeometry args={[MSG_W * 1.4, MSG_W * 0.8]} />
            <meshBasicMaterial
              map={glowSprite}
              color="#ffd58a"
              transparent
              opacity={0}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* ---- the message, as motes of light rising from the rosette ---- */}
          <points ref={motesRef} visible={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[msg.pos, 3]} />
            </bufferGeometry>
            <pointsMaterial
              map={moteSprite}
              color="#ffe4a8"
              size={0.072}
              sizeAttenuation
              transparent
              opacity={1}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </points>
        </group>
      </group>
    </>
  );
}
