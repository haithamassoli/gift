import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { SceneProps } from "../types";
import { makeRadialSprite, radialBlob } from "../sprites";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, easeInOut, easeOutCubic, lerp, mulberry32, smooth } from "../math";
import { clack, resumeAudio, swell, tone } from "../audio";
import type { Lang } from "../../i18n";

/* ============================================================================
 * RECEIPT OF THANKS — gratitude told as a debt joke.
 *
 * A chunky little thermal printer on a café counter. Tap it and it chatters out
 * an itemised bill for everything they have done for you, one line per clack:
 * the line items are ours (so it is funny before the sender types a word), the
 * TOTAL is PRICELESS, and the sender's message is printed underneath it, where a
 * sincere thing lands hardest.
 *
 * The whole receipt is ONE tall canvas, drawn once. Printing never redraws it:
 * the paper simply advances out of the slot, so a line "appears" exactly where a
 * print head would put it. The strip is a subdivided ribbon laid along a single
 * precomputed road (one arc-length table): up out of the slot, over a hook onto
 * the lid and down the back while it prints — and, read the other way, over the
 * front lip and down onto the counter. Printing slides the paper out along the
 * back half; the tear slides the very same paper along the front half, tail
 * first, so it lands face up, reading the right way, with no morph at all.
 * ========================================================================== */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ---------- variants ---------- */
const PAPERS: Record<string, { tint: string; back: string }> = {
  white: { tint: "#f7f5ef", back: "#efece4" },
  pink: { tint: "#f9e0e3", back: "#f1d5d9" },
  canary: { tint: "#f8eca8", back: "#efe19a" },
};
interface PrinterSkin {
  body: string;
  top: string; // lid + front ledge
  base: string; // the rubber plinth
  button: string;
  label: string; // printed legend on the front
  rough: number;
}
const PRINTERS: Record<string, PrinterSkin> = {
  charcoal: { body: "#3b3d43", top: "#2c2e33", base: "#1d1e21", button: "#f3cf95", label: "#d9d2c4", rough: 0.46 },
  cream: { body: "#efe4cf", top: "#e1d3b8", base: "#8f7f69", button: "#e2654a", label: "#6a5a45", rough: 0.42 },
  mint: { body: "#a9dcc7", top: "#92cbb4", base: "#4f7f6d", button: "#f27f69", label: "#2c5a4a", rough: 0.42 },
};

/* ---------- copy ---------- */
interface LineItem {
  qty: string;
  name: string;
  price: string;
}
interface Copy {
  shop: string;
  est: string;
  hours: string;
  no: string;
  date: string;
  cols: [string, string, string];
  items: LineItem[];
  total: [string, string];
  paid: [string, string];
  balance: [string, string];
  note: string;
  cashier: string;
  customer: string;
  thanks: string;
  fallback: string;
  ready: string;
  feed: string;
  model: string;
}
// The line items are the joke, and they are ours — the sender never has to be
// funny. Every price is absurd except the one that is honest: compliments were free.
const COPY: Record<Lang, Copy> = {
  en: {
    shop: "GRATITUDE & CO.",
    est: "EST. THE DAY WE MET",
    hours: "OPEN 24/7 · NO REFUNDS",
    no: "No. 000001",
    date: "DATE: EVERY DAY",
    cols: ["QTY", "ITEM", "PRICE"],
    items: [
      { qty: "×∞", name: "Listening to my rants", price: "∞" },
      { qty: "×37", name: "2 a.m. rides", price: "999.99" },
      { qty: "×212", name: "Compliments I didn't deserve", price: "FREE" },
      { qty: "×1", name: "Pretending my cooking is good", price: "5,000.00" },
      { qty: "×1", name: "Patience (family size)", price: "∞+1" },
    ],
    total: ["TOTAL:", "PRICELESS"],
    paid: ["AMOUNT PAID:", "0.00"],
    balance: ["BALANCE:", "FOREVER"],
    note: "A NOTE FROM THE CASHIER",
    cashier: "CASHIER:",
    customer: "CUSTOMER:",
    thanks: "THANK YOU — COME AGAIN",
    fallback: "Thank you. For everything.",
    ready: "READY",
    feed: "FEED",
    model: "THERMAL · 80mm",
  },
  ar: {
    shop: "الجميل وشركاه",
    est: "منذ يوم التقينا",
    hours: "مفتوح ٢٤/٧ · لا استرجاع",
    no: "رقم ٠٠٠٠٠١",
    date: "التاريخ: كل يوم",
    cols: ["الكمية", "الصنف", "السعر"],
    items: [
      { qty: "×∞", name: "الاستماع لفضفضتي", price: "∞" },
      { qty: "×٣٧", name: "توصيلات الساعة ٢ فجرًا", price: "٩٩٩٫٩٩" },
      { qty: "×٢١٢", name: "مجاملات لم أستحقها", price: "مجانًا" },
      { qty: "×١", name: "التظاهر بأن طبخي لذيذ", price: "٥٬٠٠٠٫٠٠" },
      { qty: "×١", name: "صبر (حجم عائلي)", price: "∞ + ١" },
    ],
    total: ["الإجمالي:", "لا يُقدَّر بثمن"],
    paid: ["المدفوع:", "٠٫٠٠"],
    balance: ["المتبقي:", "للأبد"],
    note: "ملاحظة من الكاشير",
    cashier: "الكاشير:",
    customer: "العميل:",
    thanks: "شكرًا… ننتظرك دائمًا",
    fallback: "شكرًا لك… على كل شيء.",
    ready: "جاهز",
    feed: "تلقيم",
    model: "حراري · ٨٠ مم",
  },
};

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace`;
const AR_FONT = "'Thmanyah Sans', system-ui, sans-serif";

/* ---------- the receipt: one tall canvas ---------- */
const PAPER_W = 0.56; // world width of the paper (80mm roll on a ~145mm printer)
const CW = 640; // canvas px across
const WPP = PAPER_W / CW; // world per canvas px
const PAD = 40;
const LEAD_PX = 100; // blank lead at the head: the stub the last customer left behind
const TAIL_PX = 78;
const TOOTH_H = 9;
const TOOTH_W = 16;
const INK = "#27262c"; // thermal black is never quite black
const INK_SOFT = "rgba(39,38,44,0.72)";

interface Receipt {
  texture: THREE.CanvasTexture;
  /** World length out of the slot after each printed row; stops[0] is the lead stub. */
  stops: number[];
  len: number;
  /** World distance from the head to where the last line starts: that tail curls over the counter edge. */
  edge: number;
  /** Middle and half-length of the note block (heading → customer), world units from the head. */
  msgMid: number;
  msgHalf: number;
  previewFed: number;
}

/** Word wrap by measured width; a word wider than the line is hard-broken. */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      let word = raw;
      while (g.measureText(word).width > maxW && word.length > 1) {
        let k = word.length - 1;
        while (k > 1 && g.measureText(word.slice(0, k)).width > maxW) k--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, k));
        word = word.slice(k);
      }
      const next = line ? `${line} ${word}` : word;
      if (line && g.measureText(next).width > maxW) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out.filter((l, i, a) => l || (i > 0 && i < a.length - 1));
}

function heartPath(g: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  g.beginPath();
  g.moveTo(cx, cy + s * 0.46);
  g.bezierCurveTo(cx - s * 0.7, cy + s * 0.02, cx - s * 0.52, cy - s * 0.6, cx, cy - s * 0.26);
  g.bezierCurveTo(cx + s * 0.52, cy - s * 0.6, cx + s * 0.7, cy + s * 0.02, cx, cy + s * 0.46);
  g.closePath();
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function buildReceipt(lang: Lang, tint: string, sender: string, recipient: string, message: string): Receipt {
  const ar = lang === "ar";
  const c = COPY[lang];
  const fam = ar ? AR_FONT : MONO;
  // Thmanyah ships 400/500/700/900; the mono stack takes whatever the OS has.
  const REG = 500;
  const BOLD = 700;
  const HEAVY = ar ? 900 : 800;
  const font = (px: number, w: number) => `${w} ${px}px ${fam}`;

  const mc = document.createElement("canvas").getContext("2d")!;
  if (ar) mc.direction = "rtl";
  const measure = (s: string, f: string) => {
    mc.font = f;
    return mc.measureText(s).width;
  };
  /** Largest size in [min, base] that fits one line; 0 if even `min` does not. */
  const fit = (s: string, maxW: number, base: number, min: number, w: number) => {
    for (let px = base; px >= min; px -= 1) if (measure(s, font(px, w)) <= maxW) return px;
    return 0;
  };

  // Layout pass first (it needs the final height before a canvas can exist), as a
  // list of draw ops; every printed row also records where the paper stops.
  const ops: ((g: CanvasRenderingContext2D) => void)[] = [];
  const stops: number[] = [LEAD_PX];
  let y = LEAD_PX;
  const X0 = PAD;
  const X1 = CW - PAD;
  const INNER = X1 - X0;
  const sx = ar ? X1 : X0; // reading start
  const ex = ar ? X0 : X1; // reading end
  const sa: CanvasTextAlign = ar ? "right" : "left";
  const ea: CanvasTextAlign = ar ? "left" : "right";
  const put = (s: string, x: number, cy: number, align: CanvasTextAlign, f: string, color = INK) => {
    ops.push((g) => {
      g.font = f;
      g.textAlign = align;
      g.fillStyle = color;
      g.fillText(s, x, cy);
    });
  };
  const row = (h: number) => {
    y += h;
    stops.push(y);
  };
  const dashes = (h: number, double = false) => {
    const cy = y + h / 2;
    ops.push((g) => {
      g.fillStyle = INK;
      for (let k = 0; k < (double ? 2 : 1); k++) {
        const yy = double ? cy + (k === 0 ? -4 : 4) : cy;
        for (let x = X0; x < X1; x += 14) g.fillRect(x, yy - 1.5, 8, 3);
      }
    });
    row(h);
  };
  /** A label at the reading start and a value at the reading end, value shrunk (or wrapped) to fit. */
  const pair = (label: string, value: string, px: number, lw: number, vw: number, h: number) => {
    const lf = font(px, lw);
    const room = INNER - measure(label, lf) - 18;
    const vpx = fit(value, room, px, px - 4, vw);
    if (vpx) {
      put(label, sx, y + h / 2, sa, lf);
      put(value, ex, y + h / 2, ea, font(vpx, vw));
      row(h);
      return;
    }
    // A 40-character name will not share a line with its label: the label gets its
    // own line and the name wraps under it, still flush to the reading end.
    put(label, sx, y + h / 2, sa, lf);
    row(h * 0.85);
    mc.font = font(px, vw);
    for (const l of wrap(mc, value, INNER)) {
      put(l, ex, y + h * 0.4, ea, font(px, vw));
      row(h * 0.85);
    }
  };

  /* -- the shop -- */
  {
    const h = 112;
    const cx = CW / 2;
    const cy = y + h / 2 + 4;
    ops.push((g) => {
      g.strokeStyle = INK;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(cx, cy, 41, 0, TAU);
      g.stroke();
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(cx, cy, 34, 0, TAU);
      g.stroke();
      g.fillStyle = INK;
      heartPath(g, cx, cy + 1, 36);
      g.fill();
      // two little sparkles either side, because the shop is proud of itself
      for (const sgn of [-1, 1]) {
        const px = cx + sgn * 70;
        g.beginPath();
        g.moveTo(px, cy - 11);
        g.lineTo(px + 3, cy - 3);
        g.lineTo(px + 11, cy);
        g.lineTo(px + 3, cy + 3);
        g.lineTo(px, cy + 11);
        g.lineTo(px - 3, cy + 3);
        g.lineTo(px - 11, cy);
        g.lineTo(px - 3, cy - 3);
        g.closePath();
        g.fill();
      }
    });
    row(h);
  }
  {
    const px = fit(c.shop, INNER, ar ? 58 : 48, 30, HEAVY) || 30;
    put(c.shop, CW / 2, y + 36, "center", font(px, HEAVY));
    row(74);
  }
  put(c.est, CW / 2, y + 18, "center", font(ar ? 25 : 21, REG), INK_SOFT);
  row(36);
  put(c.hours, CW / 2, y + 18, "center", font(ar ? 25 : 21, REG), INK_SOFT);
  row(40);
  dashes(30);
  {
    const f = font(ar ? 24 : 21, REG);
    put(c.no, sx, y + 19, sa, f);
    put(c.date, ex, y + 19, ea, f);
    row(38);
  }
  dashes(30);

  /* -- the line items -- */
  const itemPx = ar ? 29 : 25;
  const itemF = font(itemPx, ar ? REG : 600);
  const qtyW = Math.max(...c.items.map((it) => measure(it.qty, itemF))) + 16;
  const priceW = Math.max(...c.items.map((it) => measure(it.price, itemF))) + 20;
  const nameX = ar ? X1 - qtyW : X0 + qtyW;
  const nameMax = INNER - qtyW - priceW;
  {
    const f = font(ar ? 20 : 18, BOLD);
    put(c.cols[0], sx, y + 17, sa, f, INK_SOFT);
    put(c.cols[1], nameX, y + 17, sa, f, INK_SOFT);
    put(c.cols[2], ex, y + 17, ea, f, INK_SOFT);
    row(38);
  }
  const itemH = itemPx * (ar ? 1.6 : 1.5);
  mc.font = itemF;
  for (const it of c.items) {
    const lines = wrap(mc, it.name, nameMax);
    lines.forEach((l, li) => {
      const cy = y + itemH / 2;
      if (li === 0) {
        put(it.qty, sx, cy, sa, itemF);
        put(it.price, ex, cy, ea, itemF);
      }
      put(l, nameX, cy, sa, itemF);
      row(itemH + (li === lines.length - 1 ? 8 : 0));
    });
  }
  dashes(34);

  /* -- the damage -- */
  pair(c.total[0], c.total[1], ar ? 40 : 36, HEAVY, HEAVY, 62);
  pair(c.paid[0], c.paid[1], ar ? 28 : 25, BOLD, BOLD, 44);
  pair(c.balance[0], c.balance[1], ar ? 28 : 25, BOLD, BOLD, 44);
  dashes(36, true);

  /* -- the note: the part that matters, so it is the biggest thing on the paper -- */
  const msgTop = y;
  {
    const h = 52;
    const f = font(ar ? 22 : 18, BOLD);
    const cy = y + h / 2 + 4;
    const half = measure(c.note, f) / 2 + 26;
    put(c.note, CW / 2, cy, "center", f, INK_SOFT);
    ops.push((g) => {
      g.fillStyle = INK_SOFT;
      heartPath(g, CW / 2 - half, cy, 16);
      g.fill();
      heartPath(g, CW / 2 + half, cy, 16);
      g.fill();
    });
    row(h);
  }
  {
    const body = message.trim() || c.fallback;
    const sizes = ar ? [48, 44, 41, 38, 35, 32] : [42, 39, 36, 33, 31, 29];
    const lh = ar ? 1.55 : 1.36;
    let px = sizes[sizes.length - 1];
    let lines: string[] = [];
    for (const s of sizes) {
      mc.font = font(s, ar ? REG : 600);
      lines = wrap(mc, body, INNER - 10);
      px = s;
      if (lines.length * s * lh <= 660) break;
    }
    const f = font(px, ar ? REG : 600);
    const h = px * lh;
    y += 6;
    lines.forEach((l) => {
      put(l, CW / 2, y + h / 2, "center", f);
      row(h);
    });
    y += 12;
  }
  dashes(36);
  pair(c.cashier, sender.trim() || "—", ar ? 26 : 23, BOLD, ar ? REG : 600, 42);
  pair(c.customer, recipient.trim() || "—", ar ? 26 : 23, BOLD, ar ? REG : 600, 42);
  const msgBottom = y;

  /* -- barcode: deterministic from the gift, so the same gift always scans the same -- */
  const seed = hashStr(`${sender}|${recipient}|${message}|${lang}`);
  {
    const rand = mulberry32(seed);
    const top = y + 22;
    const bh = 112;
    const bars: number[] = []; // x, w pairs
    let x = CW / 2 - 212;
    const end = CW / 2 + 212;
    bars.push(x, 3, x + 6, 3);
    x += 14;
    while (x < end - 16) {
      const w = 2 + Math.floor(rand() * 3) * 2;
      bars.push(x, w);
      x += w + 2 + Math.floor(rand() * 3) * 2;
    }
    bars.push(end - 9, 3, end - 3, 3);
    ops.push((g) => {
      g.fillStyle = INK;
      for (let i = 0; i < bars.length; i += 2) g.fillRect(bars[i], top, bars[i + 1], bh);
    });
    const third = (22 + bh) / 3;
    row(third);
    row(third);
    row(third);
    let digits = "";
    for (let i = 0; i < 13; i++) digits += String(Math.floor(rand() * 10)) + (i === 0 || i === 6 ? "  " : " ");
    // Barcode numerals stay Latin in both languages, the way every till prints them.
    put(digits.trim(), CW / 2, y + 18, "center", `500 18px ${MONO}`, INK_SOFT);
    row(40);
  }
  const edge = y;
  {
    const px = fit(c.thanks, INNER, ar ? 32 : 27, 18, HEAVY) || 18;
    put(c.thanks, CW / 2, y + 28, "center", font(px, HEAVY));
    row(58);
  }
  row(TAIL_PX);
  const H = Math.ceil(y);

  /* -- paint -- */
  const cv = document.createElement("canvas");
  cv.width = CW;
  cv.height = H;
  const g = cv.getContext("2d")!;
  g.fillStyle = tint;
  g.fillRect(0, 0, CW, H);
  const rand = mulberry32(seed ^ 0x5eed);
  // paper grain: faint fibres and flecks, so it reads as paper under the lamp
  const grain = Math.floor((CW * H) / 260);
  for (let i = 0; i < grain; i++) {
    g.fillStyle = rand() < 0.55 ? "rgba(96,78,58,0.05)" : "rgba(255,255,255,0.1)";
    g.fillRect(rand() * CW, rand() * H, 1 + rand() * 1.6, 1 + rand() * 2.4);
  }
  if (ar) g.direction = "rtl";
  g.textBaseline = "middle";
  for (const op of ops) op(g);
  // Thermal print is never solid: the head drops dots. Paper-coloured specks over
  // everything only show up where they land on ink.
  g.fillStyle = tint;
  const drops = Math.floor((CW * H) / 70);
  for (let i = 0; i < drops; i++) {
    g.globalAlpha = 0.25 + rand() * 0.45;
    g.fillRect(rand() * CW, rand() * H, 1.3, 1.3);
  }
  // …and the density drifts across the width as the head warms — one faint band.
  g.globalAlpha = 0.14;
  const band = g.createLinearGradient(0, 0, CW, 0);
  band.addColorStop(0, tint);
  band.addColorStop(0.3, "rgba(0,0,0,0)");
  band.addColorStop(0.8, "rgba(0,0,0,0)");
  band.addColorStop(1, tint);
  g.fillStyle = band;
  g.fillRect(0, 0, CW, H);
  g.globalAlpha = 1;
  // torn edges, top and bottom: triangles bitten out of the paper
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  for (let x = 0; x < CW; x += TOOTH_W) {
    g.moveTo(x, -1);
    g.lineTo(x + TOOTH_W / 2, TOOTH_H * (0.6 + rand() * 0.6));
    g.lineTo(x + TOOTH_W, -1);
    g.moveTo(x, H + 1);
    g.lineTo(x + TOOTH_W / 2, H - TOOTH_H * (0.6 + rand() * 0.6));
    g.lineTo(x + TOOTH_W, H + 1);
  }
  g.fill();
  g.globalCompositeOperation = "source-over";

  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;

  const w = stops.map((v) => v * WPP);
  const len = H * WPP;
  w[w.length - 1] = len;
  const previewAt = (LEAD_PX + 330) * WPP;
  return {
    texture,
    stops: w,
    len,
    edge: edge * WPP,
    msgMid: ((msgTop + msgBottom) / 2) * WPP,
    msgHalf: ((msgBottom - msgTop) / 2) * WPP,
    previewFed: w.find((v) => v >= previewAt) ?? w[Math.min(8, w.length - 1)],
  };
}

/* ---------- printer geometry (world units; the counter top is y = 0) ---------- */
const BODY_W = 1.0;
const BODY_H = 0.46;
const BODY_D = 0.9;
const BASE_H = 0.05;
const FRONT_Z = BODY_D / 2;
const SLOT_Z = 0.208; // the gap between lid and front ledge
const SLOT_Y = 0.56; // the mouth: paper appears exactly here
const LID_Y = 0.577; // paper resting on the lid
const LID_BACK = -0.39;
const LEDGE_Y = 0.538; // paper lying over the front ledge
const LEDGE_OUT = 0.465; // where it tips over the front
const FLOOR_Y = 0.005; // paper lying on the counter
const BTN = { x: 0.3, y: 0.335 };
const LED = { x: 0.13, y: 0.335 };

const bodyGeo = new RoundedBoxGeometry(BODY_W, BODY_H, BODY_D, 6, 0.09);
const baseGeo = new RoundedBoxGeometry(BODY_W + 0.03, BASE_H + 0.02, BODY_D + 0.03, 4, 0.03);
const lidGeo = new RoundedBoxGeometry(0.9, 0.1, 0.6, 5, 0.045);
const ledgeGeo = new RoundedBoxGeometry(0.9, 0.08, 0.2, 5, 0.035);
const btnGeo = new THREE.CylinderGeometry(0.052, 0.056, 0.05, 32);
const btnRimGeo = new THREE.TorusGeometry(0.062, 0.008, 10, 36);
const ledGeo = new THREE.SphereGeometry(0.017, 16, 12);
const ledRimGeo = new THREE.TorusGeometry(0.024, 0.005, 8, 24);

/* ---------- the road the paper travels ---------- */
// One arc-length table, s = 0 at the slot mouth. s > 0 is where printed paper goes:
// up, a hook back over the top, onto the lid, down the back and along the counter.
// s < 0 is the way out the front: over the lip, down the face, along the counter
// and over its edge. Both halves leave the mouth vertically, so the table is smooth
// through s = 0 and one sliding offset can carry paper from one half to the other.
const DS = 0.004;
const RISE = 0.36; // how tall it stands before it starts to flop
const R_HOOK = 0.13;
const R_ONTO = 0.06;
const R_OVER = 0.09;
const R_FLOOR = 0.08;
const R_LIP = 0.022;
const R_DRAPE = 0.06;
const R_LAND = 0.1;
const R_EDGE = 0.036;
const HEAD_GAP = 0.06; // how far past the landing the head comes to rest

interface PaperPath {
  n: number;
  s0: number;
  z: Float32Array;
  y: Float32Array;
  tz: Float32Array; // unit tangent toward +s
  ty: Float32Array;
  /** Slide that carries the whole torn strip to its resting place. */
  pull: number;
  headZ: number;
  edgeZ: number;
}

function buildPath(len: number, edge: number): PaperPath {
  /* back half: parameterised by the heading phi (radians, in the z–y plane) */
  const nb = Math.ceil((len + 0.3) / DS) + 1;
  const bz = new Float32Array(nb);
  const by = new Float32Array(nb);
  const bp = new Float32Array(nb);
  {
    let z = SLOT_Z;
    let y = SLOT_Y;
    let phi = 91 * DEG;
    let mode = 0;
    for (let i = 0; i < nb; i++) {
      const s = i * DS;
      switch (mode) {
        case 0: // stands up, leaning back a touch more the taller it gets
          phi = lerp(91, 97, clamp01(s / RISE)) * DEG;
          if (s >= RISE) mode = 1;
          break;
        case 1: // the hook: thermal paper remembers the roll and curls back over
          phi += DS / R_HOOK;
          if (phi >= 245 * DEG) {
            phi = 245 * DEG;
            mode = 2;
          }
          break;
        case 2: // falling back toward the lid; start turning so it lands tangent
          if (y <= LID_Y + 0.577 * R_ONTO) mode = 3;
          break;
        case 3:
          phi -= DS / R_ONTO;
          if (phi <= Math.PI) {
            phi = Math.PI;
            mode = 4;
          }
          break;
        case 4: // along the lid
          if (z <= LID_BACK) mode = 5;
          break;
        case 5: // over the back edge
          phi += DS / R_OVER;
          if (phi >= 266 * DEG) {
            phi = 266 * DEG;
            mode = 6;
          }
          break;
        case 6:
          if (y <= FLOOR_Y + 0.965 * R_FLOOR) mode = 7;
          break;
        case 7:
          phi -= DS / R_FLOOR;
          if (phi <= Math.PI) {
            phi = Math.PI;
            mode = 8;
          }
          break;
      }
      bz[i] = z;
      by[i] = y;
      bp[i] = phi;
      z += Math.cos(phi) * DS;
      y += Math.sin(phi) * DS;
    }
  }

  /* front half: travelling away from the mouth, heading th */
  const nf = Math.ceil((len + 2.2) / DS) + 1;
  const fz = new Float32Array(nf);
  const fy = new Float32Array(nf);
  const ft = new Float32Array(nf);
  let headU = 1;
  let headZ = 1;
  let edgeZ = 3;
  {
    let z = SLOT_Z;
    let y = SLOT_Y;
    let th = -89 * DEG;
    let mode = 0;
    for (let j = 0; j < nf; j++) {
      const u = j * DS;
      switch (mode) {
        case 0: // folds forward over the lip of the slot
          th += DS / R_LIP;
          if (th >= 0) {
            th = 0;
            y = LEDGE_Y;
            mode = 1;
          }
          break;
        case 1:
          if (z >= LEDGE_OUT) mode = 2;
          break;
        case 2: // tips over the front
          th -= DS / R_DRAPE;
          if (th <= -72 * DEG) {
            th = -72 * DEG;
            mode = 3;
          }
          break;
        case 3:
          if (y <= FLOOR_Y + 0.691 * R_LAND) mode = 4;
          break;
        case 4: // and lands
          th += DS / R_LAND;
          if (th >= 0) {
            th = 0;
            y = FLOOR_Y;
            mode = 5;
            headU = u + HEAD_GAP;
            headZ = z + HEAD_GAP;
            edgeZ = headZ + edge;
          }
          break;
        case 5:
          if (z >= edgeZ) mode = 6;
          break;
        case 6: // over the counter's edge
          th -= DS / R_EDGE;
          if (th <= -84 * DEG) {
            th = -84 * DEG;
            mode = 7;
          }
          break;
      }
      fz[j] = z;
      fy[j] = y;
      ft[j] = th;
      z += Math.cos(th) * DS;
      y += Math.sin(th) * DS;
    }
  }

  const n = nf + nb - 1;
  const z = new Float32Array(n);
  const y = new Float32Array(n);
  const tz = new Float32Array(n);
  const ty = new Float32Array(n);
  for (let j = 0; j < nf; j++) {
    const i = nf - 1 - j;
    z[i] = fz[j];
    y[i] = fy[j];
    tz[i] = -Math.cos(ft[j]); // +s runs back toward the mouth
    ty[i] = -Math.sin(ft[j]);
  }
  for (let k = 1; k < nb; k++) {
    const i = nf - 1 + k;
    z[i] = bz[k];
    y[i] = by[k];
    tz[i] = Math.cos(bp[k]);
    ty[i] = Math.sin(bp[k]);
  }
  return { n, s0: -(nf - 1) * DS, z, y, tz, ty, pull: len + headU, headZ, edgeZ };
}

/** Scratch for samplePath — one frame, one caller at a time. */
const P = { z: 0, y: 0, tz: 0, ty: 1 };
function samplePath(p: PaperPath, s: number) {
  let f = (s - p.s0) / DS;
  if (f < 0) f = 0;
  else if (f > p.n - 1.001) f = p.n - 1.001;
  const i = Math.floor(f);
  const k = f - i;
  P.z = p.z[i] + (p.z[i + 1] - p.z[i]) * k;
  P.y = p.y[i] + (p.y[i + 1] - p.y[i]) * k;
  const tz = p.tz[i] + (p.tz[i + 1] - p.tz[i]) * k;
  const ty = p.ty[i] + (p.ty[i + 1] - p.ty[i]) * k;
  const l = Math.hypot(tz, ty) || 1;
  P.tz = tz / l;
  P.ty = ty / l;
}

/* ---------- the strip ---------- */
const SEG = 280; // rows along the paper
const COLS = 4; // columns across (enough for a gentle cup)
const CUP = 0.004; // thermal paper never lies quite flat across its width
const CURL_LEN = 0.11; // the free head curls up once it is lying down
const R_CURL = 0.1;

function makeStripGeometry(rows: number): THREE.BufferGeometry {
  const vc = (rows + 1) * (COLS + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vc * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(vc * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(vc * 2), 2).setUsage(THREE.DynamicDrawUsage));
  const idx: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < COLS; j++) {
      const a = i * (COLS + 1) + j;
      const b = a + 1;
      const c = a + COLS + 1;
      const d = c + 1;
      // rows run head → tail (away from +s), so (a, c, b) winds the printed face toward X × T
      idx.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(idx);
  return geo;
}

interface LayArgs {
  rows: number;
  fed: number; // how much paper exists (head at y = 0, tail at y = fed)
  pull: number; // slide along the road, toward the front half
  settle: number; // 0..1 — the head's curl once it has come to rest
  len: number;
  sway: number;
  chat: number;
  e: number;
}

/** Lay the paper along the road. Writes the attributes in place — no allocations. */
function layStrip(geo: THREE.BufferGeometry, path: PaperPath, a: LayArgs) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const pa = pos.array as Float32Array;
  const na = nor.array as Float32Array;
  const ua = uv.array as Float32Array;
  const rc = a.settle > 0.001 ? R_CURL / a.settle : 0;
  for (let i = 0; i <= a.rows; i++) {
    const yr = (i / a.rows) * a.fed;
    const s = a.fed - yr - a.pull;
    samplePath(path, s);
    let pz = P.z;
    let py = P.y;
    const tz = P.tz;
    const ty = P.ty;
    // N = X × T: faces the camera on the way up, the ceiling once it lies down
    let ny = -tz;
    let nz = ty;
    if (rc > 0 && yr < CURL_LEN) {
      const ang = (CURL_LEN - yr) / rc;
      const sa = Math.sin(ang);
      const ca = Math.cos(ang);
      const along = rc * sa - (CURL_LEN - yr);
      const up = rc * (1 - ca);
      pz += tz * along + nz * up;
      py += ty * along + ny * up;
      const nny = ny * ca - ty * sa;
      const nnz = nz * ca - tz * sa;
      ny = nny;
      nz = nnz;
    }
    // A breath of air on the standing paper, and the chatter of each printed line.
    const free = s > 0.02 ? clamp01((s - 0.02) / 0.45) : 0;
    const wob = free * (a.sway * Math.sin(a.e * 1.3 + s * 4.2) + a.chat * 0.0035 * Math.sin(a.e * 83 + s * 31));
    const v = 1 - yr / a.len;
    for (let j = 0; j <= COLS; j++) {
      const xn = (j / COLS) * 2 - 1;
      const off = CUP * xn * xn + wob;
      const k = i * (COLS + 1) + j;
      pa[k * 3] = xn * PAPER_W * 0.5;
      pa[k * 3 + 1] = py + ny * off;
      pa[k * 3 + 2] = pz + nz * off;
      na[k * 3] = (-4 * CUP * xn) / PAPER_W;
      na[k * 3 + 1] = ny;
      na[k * 3 + 2] = nz;
      ua[k * 2] = j / COLS;
      ua[k * 2 + 1] = v;
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  uv.needsUpdate = true;
}

/** Printed on the front, blank on the back — thermal paper only has one side. */
function makePaperMaterial(map: THREE.Texture, back: string): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    roughness: 0.72,
    metalness: 0,
  });
  const backCol = new THREE.Color(back);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBack = { value: backCol };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uBack;")
      // A lick of self-light that scales with the albedo: the paper stays paper-white
      // under a warm café lamp while the ink stays black, which is what keeps it legible.
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.16;")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor *= gl_FrontFacing ? sampledDiffuseColor : vec4( uBack, sampledDiffuseColor.a );
#endif`,
      );
  };
  return mat;
}

/* ---------- the printer's printed legend ---------- */
function buildLabel(lang: Lang, ink: string): THREE.CanvasTexture {
  const w = 640;
  const h = 208;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  const ar = lang === "ar";
  const c = COPY[lang];
  const fam = ar ? AR_FONT : `"Helvetica Neue", Arial, sans-serif`;
  if (ar) g.direction = "rtl";
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.textBaseline = "middle";
  // brand, top-left of the face
  heartPath(g, 52, 70, 30);
  g.fill();
  g.textAlign = "left";
  g.font = `${ar ? 700 : 800} ${ar ? 32 : 26}px ${fam}`;
  g.fillText(c.shop, 80, 70);
  g.globalAlpha = 0.7;
  g.font = `500 ${ar ? 20 : 17}px ${fam}`;
  g.fillText(c.model, 80, 108);
  g.globalAlpha = 1;
  // the two legends, centred under the LED and the button
  g.textAlign = "center";
  g.font = `700 ${ar ? 20 : 16}px ${fam}`;
  // (low enough to clear the button's lip, which the camera sees from above)
  g.fillText(c.ready, (LED.x + 0.4) * 800, (0.41 - LED.y) * 800 + 50);
  g.fillText(c.feed, (BTN.x + 0.4) * 800, (0.41 - BTN.y) * 800 + 82);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------- the café, shared by every instance ---------- */
/** A room for the plastic, chrome and china to reflect: warm lamp above, dark café around. */
function buildEnv(): THREE.CanvasTexture {
  const W = 128;
  const H = 64;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, "#6a4a30");
  gr.addColorStop(0.42, "#24170f");
  gr.addColorStop(0.55, "#4a2f1e");
  gr.addColorStop(1, "#140c08");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  radialBlob(g, 40, 10, 22, "#ffe0ae");
  radialBlob(g, 96, 22, 12, "#ffcc88");
  radialBlob(g, 12, 26, 9, "#9fc4b8");
  const t = new THREE.CanvasTexture(cv);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ENV = buildEnv();

/** Walnut boards running along the counter. */
function buildWood(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  const rand = mulberry32(8080);
  const boards = 6;
  const bh = H / boards;
  for (let b = 0; b < boards; b++) {
    const y0 = b * bh;
    const l = 27 + rand() * 7;
    g.fillStyle = `hsl(${26 + rand() * 6} ${26 + rand() * 8}% ${l}%)`;
    g.fillRect(0, y0, W, bh);
    for (let k = 0; k < 46; k++) {
      const yy = y0 + rand() * bh;
      const amp = 1 + rand() * 4;
      const fr = 0.004 + rand() * 0.01;
      const ph = rand() * TAU;
      g.strokeStyle = rand() < 0.6 ? `rgba(40,22,12,${0.08 + rand() * 0.16})` : `rgba(255,214,170,${0.04 + rand() * 0.06})`;
      g.lineWidth = 0.6 + rand() * 1.8;
      g.beginPath();
      for (let x = 0; x <= W; x += 16) {
        const yv = yy + Math.sin(x * fr + ph) * amp;
        if (x === 0) g.moveTo(x, yv);
        else g.lineTo(x, yv);
      }
      g.stroke();
    }
    // the seam between boards, and one butt joint somewhere along each
    g.fillStyle = "rgba(18,10,6,0.55)";
    g.fillRect(0, y0, W, 2);
    g.fillRect(rand() * W, y0, 2, bh);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const WOOD = buildWood();
const COUNTER_W = 16;
const BACK_Z = -5.5; // the café wall
const WOOD_TILE = [3.2, 1.7]; // world size of one texture tile

/** The café behind, out of focus: dark wall, a shelf's worth of warm bokeh. */
function buildBackdrop(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, "#0c0706");
  gr.addColorStop(0.45, "#20140e");
  gr.addColorStop(0.85, "#150d09");
  gr.addColorStop(1, "#120b08");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  radialBlob(g, W * 0.28, H * 0.42, 260, "rgba(120,70,36,0.35)");
  radialBlob(g, W * 0.78, H * 0.5, 220, "rgba(90,52,30,0.3)");
  const rand = mulberry32(2718);
  for (let i = 0; i < 40; i++) {
    const x = rand() * W;
    const y = H * (0.22 + rand() * 0.5);
    const r = 5 + rand() * rand() * 30;
    const teal = rand() < 0.14;
    const a = 0.06 + rand() * 0.2;
    const col = teal ? `rgba(130,205,185,${a})` : `rgba(255,${176 + Math.floor(rand() * 50)},${100 + Math.floor(rand() * 50)},${a})`;
    // out-of-focus lights: flat discs with a soft edge, the café's shelves and windows
    const d = g.createRadialGradient(x, y, 0, x, y, r);
    d.addColorStop(0, col);
    d.addColorStop(0.7, col);
    d.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = d;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const BACKDROP = buildBackdrop();

/** Soft rounded-rectangle shadow, stretched to whatever sits on it. */
function buildShadow(): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  g.filter = "blur(14px)";
  g.fillStyle = "#000";
  g.beginPath();
  g.roundRect(26, 26, S - 52, S - 52, 16);
  g.fill();
  return new THREE.CanvasTexture(cv);
}
const SHADOW = buildShadow();

/** Latte art: the café has standards. */
function buildLatte(): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  gr.addColorStop(0, "#c08a5a");
  gr.addColorStop(0.75, "#8a5530");
  gr.addColorStop(1, "#4a2a14");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#f4e6d0";
  heartPath(g, 64, 66, 70);
  g.fill();
  g.fillStyle = "#b07a4c";
  heartPath(g, 64, 64, 40);
  g.fill();
  g.fillStyle = "#f4e6d0";
  heartPath(g, 64, 63, 22);
  g.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const LATTE = buildLatte();

const GLOW = makeRadialSprite(64);
/** A ring for the sonar ping around FEED. */
function buildRing(): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,0)");
  gr.addColorStop(0.62, "rgba(255,255,255,0)");
  gr.addColorStop(0.78, "rgba(255,255,255,1)");
  gr.addColorStop(0.92, "rgba(255,255,255,0.25)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}
const RING = buildRing();

/* ---------- props: a cup of coffee and a service bell ---------- */
const cupGeo = new THREE.LatheGeometry(
  [
    [0, 0.004],
    [0.07, 0.004],
    [0.086, 0.014],
    [0.1, 0.05],
    [0.112, 0.12],
    [0.118, 0.168],
    [0.112, 0.172],
    [0.106, 0.166],
    [0.1, 0.12],
    [0.088, 0.05],
    [0, 0.03],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  36,
);
const saucerGeo = new THREE.LatheGeometry(
  [
    [0, 0],
    [0.16, 0],
    [0.2, 0.012],
    [0.215, 0.026],
    [0.205, 0.028],
    [0.17, 0.016],
    [0, 0.012],
  ].map(([x, y]) => new THREE.Vector2(x, y)),
  36,
);
const handleGeo = new THREE.TorusGeometry(0.042, 0.011, 8, 18, Math.PI * 1.25);
const coffeeGeo = new THREE.CircleGeometry(0.104, 32);
const bellGeo = new THREE.LatheGeometry(
  Array.from({ length: 14 }, (_, i) => {
    const a = (i / 13) * (Math.PI / 2);
    return new THREE.Vector2(Math.cos(a) * 0.11 + 0.002, Math.sin(a) * 0.1);
  }),
  36,
);
const bellBaseGeo = new THREE.CylinderGeometry(0.13, 0.135, 0.022, 36);
const bellStemGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8);
const bellKnobGeo = new THREE.SphereGeometry(0.016, 12, 10);
const CUP_X = 0.94;
const CUP_Z = 0.5;

/* ---------- timing ---------- */
const LINE_DT = 0.082; // one printed line per clack — a quick thermal chatter
const FIRST_LINE = 0.06; // press → first line
const TEAR_WAIT = 0.45; // last line out → the snap
const SNAP = 0.26; // the jolt of the tear before the strip lets go
const SLIDE = 1.85; // the strip travelling out and down onto the counter
const HOLD = 0.9; // lying there before we call it opened
const HOP_AT = 2.6; // an impatient little hop if nobody has touched it yet

/* ---------- the invisible finger ---------- */
// A gift may never lock waiting for input, and every gallery card plays this with
// no hands at all. Untouched, the printer presses its own button at MERCY_FIRST;
// once someone has tapped and wandered off, it carries on after MERCY_AGAIN. Each
// auto press is a real press — same click, same burst — so it also teaches the tap.
const MERCY_FIRST = 6;
const MERCY_AGAIN = 3.6;
const AUTO_GAP = 0.4;

/* ---------- camera shots ---------- */
const FOV = 34; // a longer lens: less keystone on the paper, more product shot
interface Shot {
  x: number;
  y: number;
  z: number;
  pitch: number;
  hw: number; // half-extent that must fit across
  hh: number; // …and up
}
const SEALED_SHOT: Shot = { x: 0.02, y: 0.3, z: 0.12, pitch: 0.36, hw: 0.9, hh: 0.72 };
const OPEN_SHOT: Shot = { x: 0, y: 0.56, z: 0.12, pitch: 0.26, hw: 0.64, hh: 0.8 };
const SPIT_SHOT: Shot = { x: 0, y: 0.26, z: 0.6, pitch: 0.52, hw: 0.86, hh: 0.74 };
const REVEAL_PITCH = 0.94;

function freshRun() {
  return {
    fed: -1, // world length out of the slot (seeded from the receipt on the first frame)
    rows: 0,
    queue: 0,
    lineT: 0,
    touched: false,
    auto: false,
    lastTouch: 0,
    burstEnd: -9,
    press: 0,
    chat: 0,
    shake: 0,
    hopped: false,
    doneAt: -1,
    tearAt: -1,
    landed: false,
  };
}

export default function ReceiptScene({
  variants,
  phase,
  senderName,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const paper = PAPERS[variants.paper] ?? PAPERS.white;
  const skin = PRINTERS[variants.printer] ?? PRINTERS.charcoal;

  const receipt = useMemo(
    () => buildReceipt(lang, paper.tint, senderName, recipientName, message),
    [lang, paper, senderName, recipientName, message],
  );
  useEffect(() => () => receipt.texture.dispose(), [receipt]);

  const path = useMemo(() => buildPath(receipt.len, receipt.edge), [receipt]);

  const paperMat = useMemo(() => makePaperMaterial(receipt.texture, paper.back), [receipt, paper]);
  useEffect(() => () => paperMat.dispose(), [paperMat]);

  const stripGeo = useMemo(() => makeStripGeometry(SEG), []);
  useEffect(() => () => stripGeo.dispose(), [stripGeo]);

  // The next customer's stub, left standing in the slot after the tear.
  const stubGeo = useMemo(() => {
    const geo = makeStripGeometry(8);
    layStrip(geo, path, { rows: 8, fed: receipt.stops[0], pull: 0, settle: 0, len: receipt.len, sway: 0, chat: 0, e: 0 });
    return geo;
  }, [path, receipt]);
  useEffect(() => () => stubGeo.dispose(), [stubGeo]);

  // The counter runs from the café wall to wherever this receipt's tail needs an
  // edge to curl over, so its grain is tiled per instance (a clone shares the canvas).
  const counterLen = path.edgeZ - BACK_Z;
  const wood = useMemo(() => {
    const t = WOOD.clone();
    t.repeat.set(COUNTER_W / WOOD_TILE[0], counterLen / WOOD_TILE[1]);
    return t;
  }, [counterLen]);
  useEffect(() => () => wood.dispose(), [wood]);

  const label = useMemo(() => buildLabel(lang, skin.label), [lang, skin]);
  useEffect(() => () => label.dispose(), [label]);

  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const runRef = useRef(freshRun());
  useEffect(() => {
    if (phase === "opening") runRef.current = freshRun();
  }, [phase]);
  const viewRef = useRef({ ...SEALED_SHOT, init: false, last: phase as string });

  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const fogRef = useRef<THREE.Fog>(null);
  const stripRef = useRef<THREE.Mesh>(null);
  const stubRef = useRef<THREE.Mesh>(null);
  const printerRef = useRef<THREE.Group>(null);
  const btnRef = useRef<THREE.Mesh>(null);
  const btnMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const ledMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const ledGlowRef = useRef<THREE.SpriteMaterial>(null);
  const ringRef = useRef<THREE.Sprite>(null);
  const ringMatRef = useRef<THREE.SpriteMaterial>(null);
  const paperShadowRef = useRef<THREE.MeshBasicMaterial>(null);
  const steamRefs = useRef<(THREE.Sprite | null)[]>([]);
  const bellRef = useRef<THREE.Group>(null);
  const lampRef = useRef<THREE.PointLight>(null);

  /** One press of FEED: queue a burst of lines. The same for a finger and for mercy. */
  const feed = () => {
    const r = runRef.current;
    const n = receipt.stops.length - 1;
    const add = Math.min(n - r.rows - r.queue, Math.ceil(n / 3));
    if (add <= 0) return;
    if (r.queue === 0) r.lineT = FIRST_LINE;
    r.queue += add;
    r.press = 1;
    clack({ freq: 760, decay: 0.04, gain: 0.2 });
    // the feed motor under the chatter: a short, dry brrrt for the length of the burst
    swell({ source: "noise", filter: "bandpass", cutoff: 1150, q: 1.4, attack: 0.03, hold: add * LINE_DT, release: 0.08, gain: 0.045 });
  };

  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const r = runRef.current;
    if (phase !== "opening" || r.tearAt >= 0) return;
    resumeAudio();
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety */
    }
    // A real finger always wins: the invisible one stands down and starts its wait over.
    r.touched = true;
    r.auto = false;
    r.lastTouch = tRef.current;
    feed();
  };
  const onUp = (ev: ThreeEvent<PointerEvent>) => {
    try {
      (ev.target as Element).releasePointerCapture(ev.pointerId);
    } catch {
      /* nothing captured */
    }
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    const opening = phase === "opening";
    if (opening) tRef.current += dt;
    const t = tRef.current;
    const r = runRef.current;
    const stops = receipt.stops;
    const N = stops.length - 1;
    if (r.fed < 0) r.fed = stops[0];
    r.rows = Math.min(r.rows, N);

    /* ---- printing ---- */
    if (opening && r.tearAt < 0) {
      if (r.rows + r.queue < N && r.queue === 0) {
        const wait = r.touched ? MERCY_AGAIN : MERCY_FIRST;
        const due = r.auto ? t - r.burstEnd >= AUTO_GAP : t - r.lastTouch >= wait && t - r.burstEnd >= 0.3;
        if (due) {
          r.auto = true;
          feed();
        }
      }
      if (r.queue > 0) {
        r.lineT -= dt;
        if (r.lineT <= 0) {
          r.lineT += LINE_DT;
          r.queue -= 1;
          r.rows = Math.min(N, r.rows + 1);
          r.chat = 1;
          clack({ freq: 2500 + Math.random() * 900, decay: 0.022, gain: 0.1 });
          if (r.queue === 0) r.burstEnd = t;
        }
      }
      // the paper steps out a line at a time: a quick advance, then a hold
      r.fed += (stops[r.rows] - r.fed) * Math.min(1, dt * 26);
      if (r.rows >= N && r.queue === 0 && r.doneAt < 0 && receipt.len - r.fed < 0.002) r.doneAt = t;
      if (r.doneAt >= 0 && t >= r.doneAt + TEAR_WAIT) {
        r.tearAt = t;
        r.fed = receipt.len;
        r.shake = 1;
        // the snap: a bright tick off the tear bar and a short rip of paper
        clack({ freq: 4800, decay: 0.09, gain: 0.3 });
        swell({ source: "noise", filter: "highpass", cutoff: 2600, attack: 0.004, hold: 0.05, release: 0.12, gain: 0.16 });
      }
    }

    /* ---- the paper's pose, from the phase (plus the run, while opening) ---- */
    let fed = stops[0];
    let pull = 0;
    let settle = 0;
    let torn = false;
    let land = 0; // 0..1 as the torn strip arrives on the counter
    if (phase === "revealed") {
      fed = receipt.len;
      pull = path.pull;
      settle = 1;
      torn = true;
      land = 1;
    } else if (opening) {
      fed = r.fed;
      if (r.tearAt >= 0) {
        torn = true;
        const a = t - r.tearAt;
        const k = clamp01((a - SNAP) / SLIDE);
        // a hop back up on the snap, then out and down along the road
        pull = path.pull * easeInOut(k) - (a < SNAP ? Math.sin((a / SNAP) * Math.PI) * 0.014 : 0);
        settle = smooth(clamp01((a - SNAP - SLIDE + 0.2) / 0.7));
        land = smooth(clamp01((k - 0.75) / 0.25));
        if (!r.landed && k >= 1) {
          r.landed = true;
          clack({ freq: 420, decay: 0.12, gain: 0.12 });
          // "order up": the service bell, the café's own ka-ching
          tone(2093, { seconds: 1.5, gain: 0.14, shimmer: true, when: 0.12 });
          tone(2637, { seconds: 1.1, gain: 0.06, when: 0.13 });
        }
      }
    } else if (phase === "preview") {
      fed = receipt.previewFed;
    }

    const strip = stripRef.current;
    if (strip) {
      const still = phase === "revealed" || torn;
      layStrip(strip.geometry, path, {
        rows: SEG,
        fed,
        pull,
        settle,
        len: receipt.len,
        sway: still ? 0 : phase === "preview" || phase === "sealed" ? 0.006 : 0.0035,
        chat: r.chat,
        e,
      });
    }
    if (stubRef.current) stubRef.current.visible = torn;
    if (paperShadowRef.current) paperShadowRef.current.opacity = 0.42 * land;

    /* ---- the printer: a jolt per line, a jump on the tear, one impatient hop ---- */
    r.chat = Math.max(0, r.chat - dt * 7);
    r.shake = Math.max(0, r.shake - dt * 4);
    r.press = Math.max(0, r.press - dt * 5);
    let hop = 0;
    if (opening && !r.touched && !r.auto && r.tearAt < 0) {
      const hk = (t - HOP_AT) / 0.36;
      if (hk > 0 && hk < 1) hop = Math.sin(hk * Math.PI) * 0.035;
      if (hk >= 0 && !r.hopped) {
        r.hopped = true;
        clack({ freq: 380, decay: 0.08, gain: 0.08, when: 0.34 });
      }
    }
    if (printerRef.current) {
      const pr = printerRef.current;
      pr.position.y = hop + r.chat * 0.0022 * Math.sin(e * 97) + r.shake * 0.006 * Math.sin(e * 61);
      pr.rotation.z = r.shake * 0.012 * Math.sin(e * 47) + (hop > 0 ? Math.sin(t * 30) * hop * 0.25 : 0);
    }

    /* ---- FEED: the ghost of a press while it waits, the real press when it happens ---- */
    const inviting = (opening && r.tearAt < 0 && r.rows + r.queue < N && !r.touched && !r.auto) || phase === "sealed";
    const ghost = inviting ? Math.max(0, Math.sin(e * 3.4)) ** 8 * 0.35 : 0;
    const pk = Math.max(easeOutCubic(r.press), ghost);
    if (btnRef.current) btnRef.current.position.z = FRONT_Z + 0.022 - pk * 0.016;
    if (btnMatRef.current) {
      const want = inviting ? 0.28 + 0.22 * Math.sin(e * 3.4) : r.press * 0.5;
      btnMatRef.current.emissiveIntensity = Math.max(0, want);
    }
    if (ringRef.current && ringMatRef.current) {
      // a sonar ping out of the button, until somebody (or mercy) answers it
      const ping = (e * 0.75) % 1;
      const strength = opening ? (inviting ? clamp01(t / 0.6) : 0) : phase === "sealed" ? 0.55 : phase === "preview" ? 0.35 : 0;
      ringRef.current.scale.setScalar(0.15 + ping * 0.2);
      ringMatRef.current.opacity = strength * (1 - ping) * 0.85;
      ringRef.current.visible = strength > 0.01;
    }

    /* ---- READY: blinks while it waits, flickers while it prints, steady once it is done ---- */
    let led: number;
    if (phase === "revealed" || torn) led = 0.85 + 0.15 * Math.sin(e * 1.6);
    else if (r.queue > 0 || r.chat > 0.2) led = 0.55 + 0.45 * Math.sin(e * 41) * Math.sin(e * 17);
    else led = smooth(clamp01(Math.sin(e * TAU * 0.8) * 3 + 0.5));
    if (ledMatRef.current) ledMatRef.current.emissiveIntensity = 0.15 + led * 1.35;
    if (ledGlowRef.current) ledGlowRef.current.opacity = led * 0.55;

    /* ---- the café keeps going ---- */
    for (let i = 0; i < steamRefs.current.length; i++) {
      const sp = steamRefs.current[i];
      if (!sp) continue;
      const k = (e * 0.16 + i / 3) % 1;
      sp.position.set(CUP_X + Math.sin(e * 0.9 + i * 2.1) * 0.03 * k, 0.24 + k * 0.42, CUP_Z + Math.cos(e * 0.7 + i) * 0.02);
      sp.scale.setScalar(0.09 + k * 0.16);
      (sp.material as THREE.SpriteMaterial).opacity = Math.sin(Math.PI * k) * 0.075;
    }
    if (bellRef.current) {
      // it rings when the receipt lands; it wobbles for as long as it rings
      const since = opening && r.tearAt >= 0 ? t - r.tearAt - SNAP - SLIDE - 0.12 : -1;
      const ring = since > 0 ? Math.exp(-since * 3.2) : 0;
      bellRef.current.rotation.z = ring * 0.06 * Math.sin(since * 38);
      bellRef.current.scale.y = 1 - ring * 0.04 * Math.abs(Math.sin(since * 38));
    }
    if (lampRef.current) lampRef.current.intensity = lerp(lampRef.current.intensity, torn ? 7.2 : 6.2, Math.min(1, dt * 3));

    /* ---- camera: frame the printer, follow the paper up, then tilt down to read it ---- */
    const v = viewRef.current;
    // Hold wide while the printer spits the strip over its lip — that is the show —
    // and only then tilt down to read it.
    const spitting = opening && r.tearAt >= 0 && t - r.tearAt < SNAP + SLIDE * 0.5;
    const want: Shot = spitting ? SPIT_SHOT : opening ? OPEN_SHOT : SEALED_SHOT;
    let wx = want.x;
    let wy = want.y;
    let wz = want.z;
    let wp = want.pitch;
    let whw = want.hw;
    let whh = want.hh;
    if (phase === "revealed" || (torn && !spitting)) {
      // Frame the stretch that matters, TOTAL down to the curl over the counter's
      // edge; the width only ever has to hold the paper, so a phone reads it big.
      // A long note would shrink that stretch past reading on a laptop, so then the
      // frame closes in on the note alone.
      const a0 = receipt.msgMid - receipt.msgHalf - 0.22;
      const a1 = receipt.edge + 0.2;
      const sp = Math.sin(REVEAL_PITCH);
      let mid = (a0 + a1) / 2;
      let half = (a1 - a0) / 2;
      if (half * sp > 0.46) {
        mid = receipt.msgMid;
        half = receipt.msgHalf + 0.05;
      }
      wx = 0;
      wy = 0;
      wz = path.headZ + mid;
      wp = REVEAL_PITCH;
      whw = PAPER_W * 0.5 + 0.07;
      whh = Math.min(0.56, half * sp + 0.06);
    }
    const jumped = v.last !== phase && phase !== "opening" && !(phase === "revealed" && v.last === "opening");
    const rate = !v.init || jumped ? 1 : Math.min(1, dt * (torn && opening ? 1.9 : 2.6));
    v.x = lerp(v.x, wx, rate);
    v.y = lerp(v.y, wy, rate);
    v.z = lerp(v.z, wz, rate);
    v.pitch = lerp(v.pitch, wp, rate);
    v.hw = lerp(v.hw, whw, rate);
    v.hh = lerp(v.hh, whh, rate);
    v.init = true;
    v.last = phase;
    const aspect = state.size.width / Math.max(1, state.size.height);
    const tanH = Math.tan((FOV / 2) * DEG);
    const dist = Math.max(v.hh / tanH, v.hw / (tanH * aspect));
    const drift = phase === "revealed" ? 0.35 : 1;
    const cam = camRef.current;
    if (cam) {
      cam.position.set(
        v.x + Math.sin(e * 0.21) * 0.035 * drift,
        v.y + Math.sin(v.pitch) * dist + Math.sin(e * 0.29) * 0.012 * drift,
        v.z + Math.cos(v.pitch) * dist,
      );
      cam.lookAt(v.x, v.y, v.z);
    }
    if (fogRef.current) {
      fogRef.current.near = dist + 1;
      fogRef.current.far = dist + 6;
    }

    if (opening && r.tearAt >= 0 && t - r.tearAt > SNAP + SLIDE + HOLD && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  const counterZ = (path.edgeZ + BACK_Z) / 2;
  const flatLen = path.edgeZ - path.headZ;

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault fov={FOV} near={0.05} far={60} position={[0, 1.2, 3]} />
      <fog ref={fogRef} attach="fog" args={["#140c09", 4, 10]} />

      {/* café light: a warm pendant over the counter, a soft key, a cool rim from the room */}
      <hemisphereLight args={["#ffe3c2", "#2a1810", 0.55]} />
      <ambientLight intensity={0.18} color="#ffd9b0" />
      <directionalLight position={[-1.8, 3.2, 2.6]} intensity={1.35} color="#ffe6c4" />
      <directionalLight position={[2.4, 1.6, -2.6]} intensity={0.55} color="#9db8ff" />
      <pointLight ref={lampRef} position={[0.25, 2.1, 1.1]} intensity={6.2} color="#ffc98c" distance={8} decay={1.5} />

      {/* the room behind, out of focus */}
      <mesh position={[0, 2.4, BACK_Z]}>
        <planeGeometry args={[30, 13]} />
        <meshBasicMaterial map={BACKDROP} fog={false} toneMapped={false} />
      </mesh>

      {/* the counter: walnut top, a rounded front edge, the face dropping away */}
      <mesh position={[0, 0, counterZ]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[COUNTER_W, counterLen]} />
        <meshStandardMaterial
          map={wood}
          color="#e6d3c2"
          roughness={0.62}
          metalness={0}
          envMap={ENV}
          envMapIntensity={0.22}
        />
      </mesh>
      <mesh position={[0, -0.03, path.edgeZ]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.03, 0.03, 16, 16, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color="#6e4a33" roughness={0.45} envMap={ENV} envMapIntensity={0.4} />
      </mesh>
      <mesh position={[0, -1.53, path.edgeZ + 0.03]}>
        <planeGeometry args={[16, 3]} />
        <meshStandardMaterial color="#3a261a" roughness={0.7} />
      </mesh>

      {/* soft contact shadows, since the canvas renders none */}
      <mesh position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.5, 1.35]} />
        <meshBasicMaterial map={SHADOW} transparent opacity={0.7} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.0025, path.headZ + flatLen / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[PAPER_W + 0.14, flatLen + 0.12]} />
        <meshBasicMaterial ref={paperShadowRef} map={SHADOW} transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* ---------------- the printer ---------------- */}
      <group ref={printerRef}>
        <mesh geometry={baseGeo} position={[0, (BASE_H + 0.02) / 2, 0]}>
          <meshStandardMaterial color={skin.base} roughness={0.8} envMap={ENV} envMapIntensity={0.3} />
        </mesh>
        <mesh geometry={bodyGeo} position={[0, BASE_H + BODY_H / 2, 0]}>
          <meshStandardMaterial color={skin.body} roughness={skin.rough} envMap={ENV} envMapIntensity={0.7} />
        </mesh>
        <mesh geometry={lidGeo} position={[0, 0.52, -0.11]}>
          <meshStandardMaterial color={skin.top} roughness={skin.rough * 0.9} envMap={ENV} envMapIntensity={0.8} />
        </mesh>
        <mesh geometry={ledgeGeo} position={[0, 0.49, 0.326]}>
          <meshStandardMaterial color={skin.top} roughness={skin.rough * 0.9} envMap={ENV} envMapIntensity={0.8} />
        </mesh>
        {/* the slot: a dark mouth between the lid and the ledge */}
        <mesh position={[0, 0.51, SLOT_Z]}>
          <boxGeometry args={[0.84, 0.07, 0.034]} />
          <meshStandardMaterial color="#0c0c0e" roughness={0.9} />
        </mesh>
        {/* the tear bar on the lip */}
        <mesh position={[0, 0.527, 0.233]}>
          <boxGeometry args={[0.86, 0.012, 0.012]} />
          <meshStandardMaterial color="#d5d8dc" roughness={0.22} metalness={0.9} envMap={ENV} envMapIntensity={1.3} />
        </mesh>
        {/* printed legend on the face */}
        <mesh position={[0, 0.28, FRONT_Z + 0.001]}>
          <planeGeometry args={[0.8, 0.26]} />
          <meshStandardMaterial map={label} transparent roughness={0.6} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
        {/* READY */}
        <mesh geometry={ledRimGeo} position={[LED.x, LED.y, FRONT_Z + 0.002]}>
          <meshStandardMaterial color="#9aa0a6" roughness={0.3} metalness={0.8} envMap={ENV} />
        </mesh>
        <mesh geometry={ledGeo} position={[LED.x, LED.y, FRONT_Z]}>
          <meshStandardMaterial ref={ledMatRef} color="#1fb857" emissive="#1ee063" emissiveIntensity={1.2} roughness={0.2} toneMapped={false} />
        </mesh>
        <sprite position={[LED.x, LED.y, FRONT_Z + 0.03]} scale={0.13}>
          <spriteMaterial ref={ledGlowRef} map={GLOW} color="#3cff7f" transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </sprite>
        {/* FEED */}
        <mesh geometry={btnRimGeo} position={[BTN.x, BTN.y, FRONT_Z + 0.002]}>
          <meshStandardMaterial color={skin.base} roughness={0.6} />
        </mesh>
        <mesh ref={btnRef} geometry={btnGeo} position={[BTN.x, BTN.y, FRONT_Z + 0.022]} rotation={[Math.PI / 2, 0, 0]}>
          <meshStandardMaterial ref={btnMatRef} color={skin.button} emissive={skin.button} emissiveIntensity={0} roughness={0.35} envMap={ENV} envMapIntensity={0.6} />
        </mesh>
        <sprite ref={ringRef} position={[BTN.x, BTN.y, FRONT_Z + 0.06]} scale={0.2}>
          <spriteMaterial ref={ringMatRef} map={RING} color="#ffe2b0" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </sprite>
      </group>

      {/* ---------------- the paper ---------------- */}
      <mesh ref={stripRef} geometry={stripGeo} material={paperMat} frustumCulled={false} />
      <mesh ref={stubRef} geometry={stubGeo} material={paperMat} visible={false} />

      {/* ---------------- a cup of coffee ---------------- */}
      <group position={[CUP_X, 0, CUP_Z]} rotation={[0, -0.5, 0]}>
        <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.6, 0.6]} />
          <meshBasicMaterial map={SHADOW} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        <mesh geometry={saucerGeo}>
          <meshStandardMaterial color="#f2ede4" roughness={0.22} envMap={ENV} envMapIntensity={0.9} side={THREE.DoubleSide} />
        </mesh>
        <group position={[0, 0.022, 0]}>
          <mesh geometry={cupGeo}>
            <meshStandardMaterial color="#f4efe6" roughness={0.2} envMap={ENV} envMapIntensity={0.9} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={coffeeGeo} position={[0, 0.148, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <meshStandardMaterial map={LATTE} roughness={0.35} />
          </mesh>
          <mesh geometry={handleGeo} position={[0.118, 0.092, 0]} rotation={[0, 0, -Math.PI * 0.62]}>
            <meshStandardMaterial color="#f4efe6" roughness={0.2} envMap={ENV} envMapIntensity={0.9} />
          </mesh>
        </group>
      </group>
      {[0, 1, 2].map((i) => (
        <sprite
          key={i}
          ref={(el) => {
            steamRefs.current[i] = el;
          }}
          position={[CUP_X, 0.3, CUP_Z]}
          scale={0.2}
        >
          <spriteMaterial map={GLOW} color="#fff4e6" transparent opacity={0} depthWrite={false} />
        </sprite>
      ))}

      {/* ---------------- the service bell ---------------- */}
      <group position={[-0.94, 0, 0.4]}>
        <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.46, 0.46]} />
          <meshBasicMaterial map={SHADOW} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        <mesh geometry={bellBaseGeo} position={[0, 0.011, 0]}>
          <meshStandardMaterial color="#2a1c14" roughness={0.45} envMap={ENV} envMapIntensity={0.5} />
        </mesh>
        <group ref={bellRef} position={[0, 0.022, 0]}>
          <mesh geometry={bellGeo}>
            <meshStandardMaterial color="#e2b865" roughness={0.2} metalness={0.95} envMap={ENV} envMapIntensity={1.5} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={bellStemGeo} position={[0, 0.118, 0]}>
            <meshStandardMaterial color="#c9ccd1" roughness={0.25} metalness={0.9} envMap={ENV} />
          </mesh>
          <mesh geometry={bellKnobGeo} position={[0, 0.146, 0]}>
            <meshStandardMaterial color="#e2b865" roughness={0.2} metalness={0.95} envMap={ENV} envMapIntensity={1.5} />
          </mesh>
        </group>
      </group>

      {/* The whole scene is the button while it is opening: any tap feeds the printer.
          Transparent rather than invisible — R3F skips raycasts on invisible meshes. */}
      {phase === "opening" && (
        <mesh position={[0, 0.6, 0.7]} onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp}>
          <planeGeometry args={[12, 9]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}
