import * as THREE from "three";
import type { Lang } from "../i18n";
import { mulberry32 } from "./math";

// Arabic rasterizes in Thmanyah with rtl bidi; everything else keeps its Latin
// font. Centralized here so scenes only pass `lang`.
const AR_FONT = "'Thmanyah Sans', system-ui, sans-serif";

// Shared text helpers for gift scenes. Fully procedural: rasterize text on an
// offscreen 2D canvas, then either sample opaque pixels as particle targets
// (fireworks, butterflies, lanterns…) or hand back a crisp CanvasTexture
// (locket engraving, plaques, in-scene glowing messages).

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidthPx: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidthPx) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

interface TextPointsOptions {
  /** Max sampled points (default 600). */
  maxPoints?: number;
  /** Font size in canvas px (default 90) — bigger = smoother outlines. */
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  /** Wrap width in canvas px (default 10x fontSize). */
  maxWidthPx?: number;
  lineHeight?: number;
  /** Sampling grid step in px (default 3). Smaller = denser candidates. */
  step?: number;
  seed?: number;
  /** "ar" overrides fontFamily to Thmanyah and sets rtl bidi. */
  lang?: Lang;
}

export interface TextPoints {
  /** xy pairs, centered at origin, y-up, height of one text line ≈ (fontSize/width)*aspect… scaled so full width = 1. */
  points: Float32Array;
  count: number;
  /** aspect = height / width of the rasterized text block. */
  aspect: number;
  /** Lines the text wrapped to. */
  lineCount: number;
  /** Line-to-line spacing in the same units as `points`; the block is centered, so line i sits at ((lineCount-1)/2 - i) * lineSpacing. */
  lineSpacing: number;
}

/**
 * Rasterize `text` and return up to maxPoints sample positions of its glyphs.
 * Points are xy pairs in a centered, y-up space with total width 1 (multiply
 * x by your desired world width, y by width*aspect).
 */
export function sampleTextPoints(text: string, opts: TextPointsOptions = {}): TextPoints {
  const {
    maxPoints = 600,
    fontSize = 90,
    fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontWeight = "700",
    maxWidthPx = fontSize * 10,
    lineHeight = 1.25,
    step = 3,
    seed = 1,
    lang,
  } = opts;
  const family = lang === "ar" ? AR_FONT : fontFamily;
  const rtl = lang === "ar";

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  if (rtl) ctx.direction = "rtl";
  const lines = wrapLines(ctx, text, maxWidthPx);

  const lineHeightPx = fontSize * lineHeight;
  const pad = Math.ceil(fontSize * 0.25);
  const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width), 1)) + pad * 2;
  const height = Math.ceil(lines.length * lineHeightPx) + pad * 2;
  canvas.width = width;
  canvas.height = height;

  // Canvas state resets on resize — set the font/direction again.
  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  if (rtl) ctx.direction = "rtl";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, pad + (i + 0.5) * lineHeightPx);
  });

  const data = ctx.getImageData(0, 0, width, height).data;
  const candidates: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (data[(y * width + x) * 4 + 3] > 128) candidates.push(x, y);
    }
  }

  const total = candidates.length / 2;
  const count = Math.min(maxPoints, total);
  const points = new Float32Array(count * 2);
  const rand = mulberry32(seed);
  // Partial Fisher-Yates: uniform sample without replacement.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rand() * (total - i));
    const xi = candidates[i * 2];
    const yi = candidates[i * 2 + 1];
    candidates[i * 2] = candidates[j * 2];
    candidates[i * 2 + 1] = candidates[j * 2 + 1];
    candidates[j * 2] = xi;
    candidates[j * 2 + 1] = yi;
    // normalize: center, y-up, width -> 1
    points[i * 2] = (candidates[i * 2] - width / 2) / width;
    points[i * 2 + 1] = (height / 2 - candidates[i * 2 + 1]) / width;
  }
  return {
    points,
    count,
    aspect: height / width,
    lineCount: lines.length,
    lineSpacing: lineHeightPx / width,
  };
}

/**
 * Same knobs as `sampleTextPoints`, minus two that only do harm here: `maxPoints`
 * drops a *random* subset, which shreds the pixel grid the ordering rides on, and
 * `seed` only ever fed that subsampling. Density is `step`'s job.
 */
type WritePathOptions = Omit<TextPointsOptions, "maxPoints" | "seed">;

export interface WritePath {
  /** xy pairs in `sampleTextPoints` space (centered, y-up, full width 1), in writing order. */
  path: Float32Array;
  count: number;
  /** aspect = height / width of the rasterized text block. */
  aspect: number;
  /** Index (in points, not floats) where each line begins; line k spans [lineStarts[k], lineStarts[k+1] ?? count). */
  lineStarts: number[];
}

/**
 * Order the glyph pixels of `text` into the sequence a hand would write them in:
 * lines from the top down, and within a line along the reading direction — left
 * to right, or right to left when `lang === "ar"`.
 *
 * Not glyph-outline extraction. `sampleTextPoints` rasterizes through a 2D canvas,
 * which has already done the bidi and the ligature shaping, so the pixels land
 * correctly laid out and all that is missing is their order. What comes back is a
 * dense sweep *through* the ink, not a centerline — animate it and the letters
 * write themselves on; it is not a sparse curve to hang a spline off.
 *
 * `step` alone sets the density, and 3 (~130 points per character) is the floor:
 * at 4 there are too few columns per stem and the sweep decays into a sawtooth.
 * Do not thin the result either — the fine structure *is* the per-column runs, so
 * dropping every Nth point destroys it just as badly. Raise `fontSize` with `step`.
 *
 * Feed `path` to a fingertip, a swim spline or a ribbon — but lift the pen at each
 * `lineStarts` boundary, where the hand travels back across the whole block.
 */
export function orderWritePath(text: string, opts: WritePathOptions = {}): WritePath {
  const { step = 3, lang, ...rest } = opts;
  // Uncapped on purpose — see WritePathOptions.
  const { points, count, aspect, lineCount, lineSpacing } = sampleTextPoints(text, {
    step,
    maxPoints: Infinity,
    lang,
    ...rest,
  });

  const top = ((lineCount - 1) / 2) * lineSpacing;
  const line = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = Math.round((top - points[i * 2 + 1]) / lineSpacing);
    line[i] = Math.min(lineCount - 1, Math.max(0, k)); // ascenders and descenders overhang their band
  }

  // The one place the Arabic-first promise lands: a left-to-right sweep across
  // Arabic would look wrong to a native reader before they read a single letter.
  const dir = lang === "ar" ? -1 : 1;
  const order = Array.from({ length: count }, (_, i) => i);
  order.sort(
    (a, b) =>
      line[a] - line[b] ||
      dir * (points[a * 2] - points[b * 2]) ||
      points[b * 2 + 1] - points[a * 2 + 1],
  );

  const path = new Float32Array(count * 2);
  const lineStarts: number[] = [];
  let prevLine = -1;
  let col = 0;
  let w = 0;
  for (let i = 0; i < count; ) {
    // one column of the raster grid: same line, same x, already sorted top-down
    const li = line[order[i]];
    const x = points[order[i] * 2];
    let j = i;
    while (j < count && line[order[j]] === li && points[order[j] * 2] === x) j++;
    if (li !== prevLine) {
      lineStarts.push(w);
      prevLine = li;
      col = 0;
    }
    // every other column runs bottom-up, so the pen snakes down and back up the
    // stroke instead of flying to the top of each column — a ribbon or a koi
    // following the straight sort reads as a sawtooth.
    for (let k = i; k < j; k++) {
      const id = order[col % 2 === 0 ? k : j - 1 - (k - i)];
      path[w * 2] = points[id * 2];
      path[w * 2 + 1] = points[id * 2 + 1];
      w++;
    }
    col++;
    i = j;
  }
  return { path, count, aspect, lineStarts };
}

interface TextGridOptions {
  /** Target grid width in cells; the message is rasterized to this many columns. */
  cols: number;
  fontFamily?: string;
  fontWeight?: string;
  maxWidthPx?: number;
  lineHeight?: number;
  /** Alpha cutoff for "a cell holds ink" (0..255, default 110). */
  threshold?: number;
  /** "ar" overrides fontFamily to Thmanyah and sets rtl bidi. */
  lang?: Lang;
}

export interface TextGrid {
  cols: number;
  rows: number;
  /** Row-major, 1 = lit (ink), length cols*rows. Row 0 is the top line. */
  cells: Uint8Array;
  /** Number of lit cells. */
  lit: number;
  /** rows / cols — cells are square, so this is also the block's height/width. */
  aspect: number;
}

/**
 * Rasterize `text` to a low-res boolean grid — one aesthetic, two users:
 * `tatreez` stitches an X per lit cell, `domino-run` topples a tile per lit cell.
 *
 * Like `sampleTextPoints`, it rasterizes through a 2D canvas, so bidi and Arabic
 * ligature shaping are already done — the grid comes out reading correctly with no
 * shaping work here. Cells are kept square (rows derived from the canvas aspect) so
 * the stitched/toppled letters are not stretched. A cell lights if *any* pixel in its
 * block clears `threshold`, not the block average: at ~48 columns a hairline stem is a
 * single pixel wide, and averaging erases it — max-alpha keeps thin strokes legible.
 */
export function rasterTextGrid(text: string, opts: TextGridOptions): TextGrid {
  const {
    cols,
    fontFamily = "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontWeight = "700",
    lineHeight = 1.15,
    threshold = 110,
    lang,
  } = opts;
  const family = lang === "ar" ? AR_FONT : fontFamily;
  const rtl = lang === "ar";
  const fontSize = 64;
  const maxWidthPx = opts.maxWidthPx ?? fontSize * 9;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  if (rtl) ctx.direction = "rtl";
  const lines = wrapLines(ctx, text, maxWidthPx);

  const lineHeightPx = fontSize * lineHeight;
  const pad = Math.ceil(fontSize * 0.2);
  const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width), 1)) + pad * 2;
  const height = Math.ceil(lines.length * lineHeightPx) + pad * 2;
  canvas.width = width;
  canvas.height = height;

  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  if (rtl) ctx.direction = "rtl";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, pad + (i + 0.5) * lineHeightPx);
  });

  const data = ctx.getImageData(0, 0, width, height).data;
  const cellPx = width / cols; // square cells: derive rows from the same pixel size
  const rows = Math.max(1, Math.round(height / cellPx));
  const cells = new Uint8Array(cols * rows);
  let lit = 0;
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));
      let on = 0;
      for (let y = y0; y < y1 && !on; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * width + x) * 4 + 3] > threshold) {
            on = 1;
            break;
          }
        }
      }
      cells[r * cols + c] = on;
      lit += on;
    }
  }
  return { cols, rows, cells, lit, aspect: rows / cols };
}

interface TextTextureOptions {
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  color?: string;
  /** Glow blur radius in px (0 = none). */
  glow?: number;
  glowColor?: string;
  maxWidthPx?: number;
  lineHeight?: number;
  padding?: number;
  /** "ar" overrides fontFamily to Thmanyah and sets rtl bidi. */
  lang?: Lang;
}

export interface TextTexture {
  texture: THREE.CanvasTexture;
  /** aspect = height / width — size your plane as [w, w*aspect]. */
  aspect: number;
}

/** Crisp canvas texture of (wrapped) text on a transparent background. */
export function makeTextTexture(text: string, opts: TextTextureOptions = {}): TextTexture {
  const {
    fontSize = 96,
    fontFamily = "Georgia, 'Times New Roman', serif",
    fontWeight = "400",
    color = "#fff6e0",
    glow = 0,
    glowColor = color,
    maxWidthPx = fontSize * 12,
    lineHeight = 1.3,
    padding = fontSize * 0.5,
    lang,
  } = opts;
  const family = lang === "ar" ? AR_FONT : fontFamily;
  const rtl = lang === "ar";

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  if (rtl) ctx.direction = "rtl";
  const lines = wrapLines(ctx, text, maxWidthPx);

  const lineHeightPx = fontSize * lineHeight;
  const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width), 1) + padding * 2);
  const height = Math.ceil(lines.length * lineHeightPx + padding * 2);
  canvas.width = width;
  canvas.height = height;

  ctx.font = `${fontWeight} ${fontSize}px ${family}`;
  if (rtl) ctx.direction = "rtl";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  if (glow > 0) {
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glow;
  }
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, padding + (i + 0.5) * lineHeightPx);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return { texture, aspect: height / width };
}
