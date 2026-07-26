import { mulberry32 } from "./math";

// Post-gesture WebAudio for the gift scenes that answer a touch with a sound:
// `oud` plucks a string, `typewriter` clacks a key, `domino-run` topples a tile.
// One shared AudioContext, created lazily and only ever resumed inside a pointer
// handler — browsers refuse to start audio without a gesture, and the scenes are
// the gesture. Everything here is synthesis: no sample files to load, so a gift is
// still a single lazy chunk with nothing to fetch.
//
// The one piece the doc flags as risk is the pluck. `karplusStrong` is kept a pure
// Float32Array generator (deterministic noise via mulberry32, no AudioContext) so it
// can be reasoned about and checked off the audio thread; the WebAudio wrappers just
// pour it into a buffer.

/**
 * Karplus-Strong plucked-string synthesis: a burst of noise fed through a short
 * delay line that low-pass-averages itself on every pass. The delay length sets the
 * pitch; the averaging is what makes it decay from a bright pluck into a warm tone,
 * which is why it sounds shockingly like a plucked string (and, with a body filter
 * on top, like an oud) for ~20 lines. Pure and deterministic — same seed, same wave.
 *
 * `damping` (0..1) is the per-sample feedback: lower = shorter, duller note. 0.996
 * gives an oud-ish ~1.5s sustain; the 0.5 averaging already removes the high end fast,
 * so even damping 1 decays.
 */
function karplusStrong(
  sampleRate: number,
  freq: number,
  seconds: number,
  damping = 0.996,
  seed = 1,
): Float32Array {
  const n = Math.max(2, Math.round(sampleRate / freq)); // delay length = one period
  const ring = new Float32Array(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) ring[i] = rand() * 2 - 1;

  const total = Math.max(1, Math.floor(sampleRate * seconds));
  const out = new Float32Array(total);
  let pos = 0;
  for (let i = 0; i < total; i++) {
    out[i] = ring[pos];
    const next = (pos + 1) % n;
    ring[pos] = damping * 0.5 * (ring[pos] + ring[next]);
    pos = next;
  }
  // A short raised-cosine fade out so a note cut before it dies does not click.
  const fade = Math.min(total, Math.floor(sampleRate * 0.02));
  for (let i = 0; i < fade; i++) {
    out[total - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
  }
  return out;
}

type Win = typeof window & { webkitAudioContext?: typeof AudioContext };
let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

/**
 * A fresh AudioContext (with the webkit-prefixed fallback), or null if the browser
 * has no WebAudio. Scenes that own a dedicated context and lifecycle — `mixtape`,
 * `music-box` — use this; the shared one-shot SFX below reuse a single context via
 * getAudioCtx.
 */
export function createAudioContext(): AudioContext | null {
  const Ctor = window.AudioContext ?? (window as Win).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

/** The one shared context, created on first ask. null if the browser has no WebAudio. */
function getAudioCtx(): AudioContext | null {
  return (ctx ??= createAudioContext());
}

/** Call inside a pointer handler — a context created before a gesture starts suspended. */
export function resumeAudio(): void {
  getAudioCtx()
    ?.resume()
    .catch(() => {});
}

function whiteNoise(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 0.4);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  const rand = mulberry32(90210);
  for (let i = 0; i < len; i++) data[i] = rand() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

interface PluckOptions {
  seconds?: number;
  damping?: number;
  /** 0..1 peak level (default 0.5). */
  gain?: number;
  /** Body low-pass cutoff in Hz (default 2600) — the oud's resonant box. */
  body?: number;
  /** Seconds from now (default 0). */
  when?: number;
  seed?: number;
}

/** Play a plucked-string note. Returns the scheduled start time, or null if muted/unsupported. */
export function pluck(freq: number, opts: PluckOptions = {}): number | null {
  const c = getAudioCtx();
  if (!c) return null;
  const { seconds = 1.6, damping = 0.996, gain = 0.5, body = 2600, when = 0, seed = 1 } = opts;
  const wave = karplusStrong(c.sampleRate, freq, seconds, damping, seed);
  const buf = c.createBuffer(1, wave.length, c.sampleRate);
  // .set (not copyToChannel) sidesteps TS's Float32Array<ArrayBuffer> generic: getChannelData
  // hands back a plain Float32Array and .set takes any ArrayLike<number>.
  buf.getChannelData(0).set(wave);

  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = body;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(lp);
  lp.connect(g);
  g.connect(c.destination);
  const t = c.currentTime + when;
  src.start(t);
  return t;
}

interface ClackOptions {
  /** Band-pass centre in Hz — higher reads as a lighter, brighter tap (default 1800). */
  freq?: number;
  /** Decay time in seconds (default 0.06). */
  decay?: number;
  gain?: number;
  when?: number;
}

/** A dry percussive tap — a filtered noise burst. Typewriter keys, domino tiles. */
export function clack(opts: ClackOptions = {}): void {
  const c = getAudioCtx();
  if (!c) return;
  const { freq = 1800, decay = 0.06, gain = 0.4, when = 0 } = opts;
  const src = c.createBufferSource();
  src.buffer = whiteNoise(c);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 1.1;
  const g = c.createGain();
  const t = c.currentTime + when;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(bp);
  bp.connect(g);
  g.connect(c.destination);
  src.start(t);
  src.stop(t + decay + 0.02);
}

interface SwellOptions {
  /** "noise" for a crowd or a hiss, or an oscillator type for a pitched drone. */
  source?: "noise" | OscillatorType;
  /** Pitch in Hz. Oscillator sources only — ignored for noise. */
  freq?: number;
  filter?: BiquadFilterType;
  /** Filter cutoff (lowpass) or centre (bandpass) in Hz. */
  cutoff?: number;
  q?: number;
  /** Envelope in seconds; total length is their sum. */
  attack?: number;
  hold?: number;
  release?: number;
  gain?: number;
  /** Amplitude wobble in Hz — a purr is a slow one, ~22Hz. 0 = steady. */
  tremolo?: number;
  /** How much of the level the wobble takes away at its trough, 0..1. */
  tremoloDepth?: number;
  when?: number;
}

/**
 * A *sustained* filtered voice with a rise-hold-fall envelope — the shape neither
 * `clack` (one dry burst) nor `tone` (a decaying blip) can make. Two users, one
 * helper: `big-screen` swells looped noise through a bandpass into a crowd roar,
 * and `pet-rock` purrs a tremolo'd sawtooth through a lowpass. Fire-and-forget
 * like the rest of this module: a purr that has to keep going is a burst re-fired
 * per beat (which is also what a real purr is), not a handle to hold onto.
 */
export function swell(opts: SwellOptions = {}): void {
  const c = getAudioCtx();
  if (!c) return;
  const {
    source = "noise",
    freq = 90,
    filter = source === "noise" ? "bandpass" : "lowpass",
    cutoff = source === "noise" ? 700 : 420,
    q = 0.9,
    attack = 0.4,
    hold = 0.6,
    release = 1.2,
    gain = 0.3,
    tremolo = 0,
    tremoloDepth = 0.7,
    when = 0,
  } = opts;

  const t = c.currentTime + when;
  const end = t + attack + hold + release;

  let src: AudioBufferSourceNode | OscillatorNode;
  if (source === "noise") {
    const buf = c.createBufferSource();
    buf.buffer = whiteNoise(c);
    // whiteNoise is a 0.4s buffer and a roar runs for seconds — loop it. The
    // bandpass and the envelope both smear the seam past hearing.
    buf.loop = true;
    src = buf;
  } else {
    const osc = c.createOscillator();
    osc.type = source;
    osc.frequency.setValueAtTime(freq, t);
    src = osc;
  }

  const bq = c.createBiquadFilter();
  bq.type = filter;
  bq.frequency.value = cutoff;
  bq.Q.value = q;

  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + attack);
  env.gain.setValueAtTime(gain, t + attack + hold);
  env.gain.exponentialRampToValueAtTime(0.0001, end);

  src.connect(bq);
  let tail: AudioNode = bq;
  if (tremolo > 0) {
    // The wobble multiplies the signal: a gain parked at (1 - depth) with an LFO
    // swinging `depth` on top of it, so the trough is (1-depth) and the peak is 1.
    const trem = c.createGain();
    trem.gain.value = 1 - tremoloDepth;
    const lfo = c.createOscillator();
    lfo.frequency.value = tremolo;
    const depth = c.createGain();
    depth.gain.value = tremoloDepth;
    lfo.connect(depth);
    depth.connect(trem.gain);
    lfo.start(t);
    lfo.stop(end + 0.02);
    bq.connect(trem);
    tail = trem;
  }
  tail.connect(env);
  env.connect(c.destination);
  src.start(t);
  src.stop(end + 0.02);
}

interface ToneOptions {
  type?: OscillatorType;
  seconds?: number;
  gain?: number;
  when?: number;
  /** Add a quiet octave-up partial for a bell-like shimmer (default false). */
  shimmer?: boolean;
}

/** A short pitched blip with an exponential tail — margin bells, the final domino's chime. */
export function tone(freq: number, opts: ToneOptions = {}): void {
  const c = getAudioCtx();
  if (!c) return;
  const { type = "sine", seconds = 0.5, gain = 0.35, when = 0, shimmer = false } = opts;
  const t = c.currentTime + when;
  const voice = (f: number, level: number, dur: number) => {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  };
  voice(freq, gain, seconds);
  if (shimmer) voice(freq * 2, gain * 0.3, seconds * 0.7);
}
