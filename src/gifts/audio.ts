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
export function karplusStrong(
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

/** The one shared context, created on first ask. null if the browser has no WebAudio. */
export function getAudioCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as Win).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
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
