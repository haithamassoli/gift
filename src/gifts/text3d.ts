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
  return { points, count, aspect: height / width };
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
