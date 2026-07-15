import * as THREE from "three";
import { lerp } from "./math";
import { makeRadialSprite } from "./sprites";

// A pointer-painted alpha mask for gift scenes: a plain 2D canvas behind a
// CanvasTexture, which scenes sample as an alphaMap / mix factor. `scratch-card`
// erases foil out of a filled mask; `foggy-mirror` breathes fog into an empty one
// and then writes the message back out of it — inverse uses of the same util.
//
// Deliberately a 2D canvas and not a render target: one pointer event is only a
// handful of soft stamps, nothing else ever needs to read the mask back on the
// GPU, and text3d.ts already proves canvas rasterization is fast enough here.

/** Firm core, soft falloff — a hard circle reads as a cursor, this reads as a fingertip. */
const brush: HTMLCanvasElement = makeRadialSprite(64, [
  [0, "rgba(255,255,255,1)"],
  [0.6, "rgba(255,255,255,0.85)"],
  [1, "rgba(255,255,255,0)"],
]).image;

/** Stamp spacing along a stroke, as a fraction of the brush radius — cores overlap, so the line reads solid. */
const STROKE_SPACING = 0.35;
/** coverage() samples every Nth pixel on both axes; scanning all of them per poll buys accuracy nobody spends. */
const COVERAGE_STEP = 8;

/** "erase" cuts the mask away (destination-out), "draw" lays it down. */
export type PaintMode = "erase" | "draw";

interface PaintMaskOptions {
  /** Square texture resolution in px (default 512). */
  size?: number;
  /** Start opaque and erase to reveal (default true), or start empty and draw to cover. */
  filled?: boolean;
}

export interface PaintMask {
  texture: THREE.CanvasTexture;
  /** One soft dab. u/v are three's texture coords (v up — pass a raycast's `e.uv` straight in); radius is in uv units. */
  paint(u: number, v: number, radius: number, mode: PaintMode): void;
  /** Dabs along a segment. pointermove is sparse on a fast drag, so a dab per event alone leaves a dotted trail. */
  stroke(u0: number, v0: number, u1: number, v1: number, radius: number, mode: PaintMode): void;
  /** Painted fraction 0..1, sampled on a coarse grid — an estimate, not an exact count. */
  coverage(): number;
  /**
   * Multiply the whole mask's alpha by (1 - alpha), for masks that let go of what was
   * painted into them: `koi-pond` paints a wake behind each fish and fades it, so the
   * pond is still water again a couple of seconds after one has passed. Frame-rate
   * independence is the caller's: pass `1 - Math.exp(-dt / tau)` for a decay in seconds.
   */
  fade(alpha: number): void;
  /** Back to the `filled` starting state. */
  reset(): void;
  dispose(): void;
}

/**
 * A mask the pointer paints into. Every mutation flags the texture for re-upload,
 * so scenes only ever have to hand `texture` to a material and drag.
 */
export function makePaintMask(opts: PaintMaskOptions = {}): PaintMask {
  const { size = 512, filled = true } = opts;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  // willReadFrequently keeps the buffer in software: coverage() would otherwise
  // stall on a GPU readback every poll, and the stamps are far too small to miss
  // the acceleration.
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const texture = new THREE.CanvasTexture(canvas);
  // A mask is data, not color, and it re-uploads on every stroke — rebuilding the
  // whole mip chain that often buys nothing.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;

  const stamp = (u: number, v: number, radius: number, mode: PaintMode) => {
    ctx.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
    const r = radius * size;
    // v counts up from the bottom, and CanvasTexture flips y on upload — so the row mirrors.
    ctx.drawImage(brush, u * size - r, (1 - v) * size - r, r * 2, r * 2);
  };

  const reset = () => {
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, size, size);
    if (filled) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size, size);
    }
    texture.needsUpdate = true;
  };
  reset();

  return {
    texture,
    paint(u, v, radius, mode) {
      stamp(u, v, radius, mode);
      texture.needsUpdate = true;
    },
    stroke(u0, v0, u1, v1, radius, mode) {
      const px = Math.hypot((u1 - u0) * size, (v1 - v0) * size);
      const steps = Math.max(1, Math.ceil(px / Math.max(1, radius * size * STROKE_SPACING)));
      for (let i = 0; i <= steps; i++) {
        const k = i / steps;
        stamp(lerp(u0, u1, k), lerp(v0, v1, k), radius, mode);
      }
      texture.needsUpdate = true;
    },
    fade(alpha) {
      // destination-out multiplies what is already there by (1 - src.alpha) and leaves
      // the colour alone — so the falloff the brush laid down thins evenly instead of
      // being eroded from its edge inward.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${alpha})`;
      ctx.fillRect(0, 0, size, size);
      texture.needsUpdate = true;
    },
    coverage() {
      const data = ctx.getImageData(0, 0, size, size).data;
      let hit = 0;
      let total = 0;
      for (let y = 0; y < size; y += COVERAGE_STEP) {
        for (let x = 0; x < size; x += COVERAGE_STEP) {
          if (data[(y * size + x) * 4 + 3] > 128) hit++;
          total++;
        }
      }
      return hit / total;
    },
    reset,
    dispose() {
      texture.dispose();
    },
  };
}
