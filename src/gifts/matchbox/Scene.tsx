import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import type { SceneProps } from "../types";
import { makeRadialSprite } from "../sprites";
import { makeTextTexture } from "../text3d";
import { useOpeningClock } from "../useOpeningClock";
import { clamp01, lerp, mulberry32, smooth } from "../math";
import { forRecipient } from "../../i18n";

/* ---------- the paper worlds ---------- */
// Each layer draws itself into a canvas and, from the same rectangles, emits the
// windows that will light inside it — one source of truth, so a lit window can
// never miss its building.
type Emit = (px: number, py: number, r: number, warm: number) => void;
type Draw = (
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  emit: Emit,
  rand: () => number,
) => void;

interface World {
  box: string; // the sleeve's printed card — only ever seen in the flare
  trim: string;
  paper: string; // the stock the world is cut from
  sky: string;
  horizon: string; // the last of the dusk, along the sky panel's foot
  win: string;
  win2: string;
  ember: string; // the message
  draw: [Draw, Draw, Draw, Draw]; // back → front
}

/* city rooftops: teeth of differing height, then the near parapet you stand on */
const cityFar: Draw = (g, W, H, emit, rand) => {
  let x = -W * 0.04;
  while (x < W) {
    const w = W * (0.05 + rand() * 0.08);
    const h = H * (0.4 + rand() * 0.58);
    g.fillRect(x, H - h, w, h);
    // a mast or a tank, so the skyline is not just a row of teeth
    const r = rand();
    if (r < 0.26) g.fillRect(x + w * 0.45, H - h - H * 0.17, Math.max(1, W * 0.005), H * 0.17);
    else if (r < 0.42) g.fillRect(x + w * 0.2, H - h - H * 0.05, w * 0.6, H * 0.05);
    // Windows: a loose grid, and hardly any of it. The staggering is the charm
    // and a hundred panes coming up over two seconds is not a stagger, it is a
    // switch — so a tower keeps three or four lit and stays dark otherwise.
    const cols = Math.max(1, Math.floor(w / (W * 0.038)));
    const rows = Math.max(1, Math.floor(h / (H * 0.17)));
    for (let c = 0; c < cols; c++)
      for (let rw = 0; rw < rows; rw++)
        if (rand() < 0.13)
          emit(
            x + ((c + 0.5) * w) / cols,
            H - h + ((rw + 0.6) * h) / rows,
            W * 0.009,
            rand(),
          );
    x += w + W * 0.014;
  }
};
const cityMid: Draw = (g, W, H, emit, rand) => {
  let x = -W * 0.05;
  while (x < W) {
    const w = W * (0.11 + rand() * 0.11);
    const h = H * (0.42 + rand() * 0.34);
    g.fillRect(x, H - h, w, h);
    // the rooftop kit every block in the world carries
    const k = rand();
    if (k < 0.45) {
      // water tank on stilts
      const tx = x + w * (0.2 + rand() * 0.5);
      const tw = W * 0.038;
      g.fillRect(tx, H - h - H * 0.13, tw, H * 0.09);
      g.fillRect(tx + tw * 0.1, H - h - H * 0.04, tw * 0.08, H * 0.04);
      g.fillRect(tx + tw * 0.8, H - h - H * 0.04, tw * 0.08, H * 0.04);
    } else if (k < 0.75) {
      // stair bulkhead
      g.fillRect(x + w * 0.55, H - h - H * 0.08, w * 0.3, H * 0.08);
    }
    const cols = Math.max(2, Math.floor(w / (W * 0.05)));
    const rows = Math.max(2, Math.floor(h / (H * 0.22)));
    for (let c = 0; c < cols; c++)
      for (let rw = 0; rw < rows; rw++)
        if (rand() < 0.17)
          emit(
            x + ((c + 0.5) * w) / cols,
            H - h + ((rw + 0.55) * h) / rows,
            W * 0.013,
            rand(),
          );
    x += w + W * 0.02;
  }
};
const cityNear: Draw = (g, W, H, emit, rand) => {
  // two low roofs and the gap between them — and the fine detail lives here,
  // not on the parapet: a 0.34-tall panel gives an aerial 5cm to exist in.
  g.fillRect(-W * 0.02, H * 0.42, W * 0.46, H);
  g.fillRect(W * 0.56, H * 0.52, W * 0.5, H);
  g.fillRect(W * 0.08, H * 0.18, W * 0.07, H * 0.26); // chimney
  g.fillRect(W * 0.05, H * 0.12, W * 0.13, H * 0.08); // its cowl
  // a dish, angled off toward something worth watching
  g.beginPath();
  g.ellipse(W * 0.68, H * 0.4, W * 0.05, H * 0.085, -0.5, 0, Math.PI * 2);
  g.fill();
  g.fillRect(W * 0.675, H * 0.4, Math.max(1, W * 0.006), H * 0.14);
  const ax = W * 0.9; // the aerial, tall enough here to read as one
  g.fillRect(ax, H * 0.04, Math.max(1, W * 0.007), H * 0.5);
  for (let i = 0; i < 4; i++) {
    const s = W * (0.06 - i * 0.01);
    g.fillRect(ax - s, H * (0.09 + i * 0.07), s * 2, Math.max(1, H * 0.014));
  }
  // one pigeon, because a rooftop without one is a diagram
  g.beginPath();
  g.ellipse(W * 0.26, H * 0.34, W * 0.026, H * 0.05, 0.2, 0, Math.PI * 2);
  g.fill();
  g.fillRect(W * 0.272, H * 0.25, Math.max(1, W * 0.011), H * 0.07);
  g.fillRect(W * 0.243, H * 0.38, Math.max(1, W * 0.005), H * 0.05);
  for (let i = 0; i < 3; i++) emit(W * (0.06 + i * 0.14), H * (0.58 + rand() * 0.24), W * 0.013, rand());
  emit(W * 0.78, H * 0.7, W * 0.013, rand());
};
// nothing lights on the parapet you are standing behind, so it takes neither
const cityFront: Draw = (g, W, H) => {
  // one bold shape, and nothing precious
  g.fillRect(-W * 0.02, H * 0.48, W * 1.04, H);
  g.fillRect(-W * 0.02, H * 0.34, W * 1.04, H * 0.14);
  g.fillRect(W * 0.12, H * 0.04, W * 0.09, H * 0.3); // a vent stack
  g.fillRect(W * 0.09, H * 0.0, W * 0.15, H * 0.06);
};

/* desert night: dunes, a mesa, palms, and a caravan that has stopped for the night */
const dunesFar: Draw = (g, W, H, emit, rand) => {
  // a mesa with the sheer face every one of them has on the wind side
  g.beginPath();
  g.moveTo(W * 0.52, H);
  g.lineTo(W * 0.55, H * 0.28);
  g.lineTo(W * 0.62, H * 0.2);
  g.lineTo(W * 0.86, H * 0.22);
  g.lineTo(W * 0.92, H * 0.34);
  g.lineTo(W * 0.97, H);
  g.closePath();
  g.fill();
  // and a far ridge, low and soft, running the whole width
  g.beginPath();
  g.moveTo(-W * 0.05, H);
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const x = -W * 0.05 + u * W * 1.1;
    const y = H * (0.72 - 0.16 * Math.sin(u * 4.1 + 0.6) - 0.07 * Math.sin(u * 9.3));
    g.lineTo(x, y);
  }
  g.lineTo(W * 1.05, H);
  g.closePath();
  g.fill();
  // a village on the mesa's shoulder: the only lights for a day's ride
  for (let i = 0; i < 8; i++) emit(W * (0.6 + rand() * 0.28), H * (0.28 + rand() * 0.18), W * 0.01, rand() * 0.4);
};
const dunesPalms: Draw = (g, W, H, emit, rand) => {
  // a tent, guyed to the sand, mouth toward the fire
  g.beginPath();
  g.moveTo(W * 0.56, H);
  g.lineTo(W * 0.72, H * 0.26);
  g.lineTo(W * 0.94, H);
  g.closePath();
  g.fill();
  g.fillRect(W * 0.715, H * 0.2, Math.max(1, W * 0.008), H * 0.1);
  // three palms, each leaning off the prevailing wind
  for (let p = 0; p < 3; p++) {
    const bx = W * (0.1 + p * 0.13);
    const bh = H * (0.66 + rand() * 0.24);
    const lean = (rand() - 0.35) * W * 0.05;
    g.beginPath();
    g.moveTo(bx - W * 0.011, H);
    g.quadraticCurveTo(bx - W * 0.004 + lean * 0.5, H - bh * 0.5, bx + lean, H - bh);
    g.lineTo(bx + lean + W * 0.012, H - bh);
    g.quadraticCurveTo(bx + W * 0.012 + lean * 0.5, H - bh * 0.5, bx + W * 0.011, H);
    g.closePath();
    g.fill();
    for (let f = 0; f < 6; f++) {
      const a = -Math.PI * 0.5 + (f / 5 - 0.5) * 2.5;
      const fl = W * (0.07 + rand() * 0.05);
      g.beginPath();
      g.moveTo(bx + lean, H - bh);
      g.quadraticCurveTo(
        bx + lean + Math.cos(a) * fl * 0.6,
        H - bh + Math.sin(a) * fl * 0.6 - H * 0.05,
        bx + lean + Math.cos(a) * fl,
        H - bh + Math.sin(a) * fl + H * 0.04,
      );
      g.lineWidth = Math.max(1, H * 0.02);
      g.stroke();
    }
  }
  emit(W * 0.75, H * 0.72, W * 0.02, 0.95); // the lamp hung in the tent's mouth
  emit(W * 0.66, H * 0.86, W * 0.013, 0.85);
};
const dunesCaravan: Draw = (g, W, H, emit, rand) => {
  // the ridge they are walking along
  g.beginPath();
  g.moveTo(-W * 0.05, H);
  for (let i = 0; i <= 26; i++) {
    const u = i / 26;
    g.lineTo(-W * 0.05 + u * W * 1.1, H * (0.84 - 0.09 * Math.sin(u * 3.1 + 2.2)));
  }
  g.lineTo(W * 1.05, H);
  g.closePath();
  g.fill();
  // Two camels, and the gift rests on them reading as camels — so everything is
  // in units of shoulder height, on the panel that is tall enough to show them.
  const camel = (cx: number, s: number) => {
    const base = H * 0.82;
    const u = H * 0.42 * s; // shoulder height; a camel is mostly leg and neck
    g.beginPath(); // barrel — long, and it is the body that says quadruped
    g.ellipse(cx, base - u * 0.62, u * 0.56, u * 0.2, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath(); // the two humps, the tell
    g.ellipse(cx - u * 0.18, base - u * 0.88, u * 0.18, u * 0.15, 0, 0, Math.PI * 2);
    g.ellipse(cx + u * 0.2, base - u * 0.85, u * 0.15, u * 0.12, 0, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = Math.max(1, u * 0.07);
    for (const [dx, sw] of [[-0.34, 0.09], [-0.2, -0.07], [0.34, -0.09], [0.2, 0.07]] as const) {
      g.beginPath();
      g.moveTo(cx + u * dx, base - u * 0.55);
      g.lineTo(cx + u * (dx + sw), base);
      g.stroke();
    }
    // Neck up AND forward. Run it straight up and the silhouette is an ostrich —
    // the S and the muzzle out front are the whole difference.
    g.lineWidth = Math.max(1, u * 0.11);
    g.beginPath();
    g.moveTo(cx - u * 0.46, base - u * 0.7);
    g.quadraticCurveTo(cx - u * 0.78, base - u * 0.95, cx - u * 0.74, base - u * 1.22);
    g.stroke();
    g.beginPath(); // head, muzzle leading
    g.ellipse(cx - u * 0.8, base - u * 1.28, u * 0.16, u * 0.085, -0.25, 0, Math.PI * 2);
    g.fill();
    g.beginPath(); // tail
    g.moveTo(cx + u * 0.52, base - u * 0.68);
    g.quadraticCurveTo(cx + u * 0.66, base - u * 0.46, cx + u * 0.6, base - u * 0.22);
    g.lineWidth = Math.max(1, u * 0.045);
    g.stroke();
  };
  camel(W * 0.3, 1);
  camel(W * 0.62, 0.8);
  emit(W * 0.3, H * 0.44, W * 0.011, 1); // a lantern slung off the lead camel
  rand();
};
const dunesNear: Draw = (g, W, H, emit, rand) => {
  // The sand you are standing on. It is a lip, not a wall — raise it and it eats
  // the caravan behind it; kept low it hides their legs, which is exactly what a
  // ridge in front of a caravan is supposed to do. Dunes also march in ranks, so
  // several crests: one smooth hump reads as a hill.
  g.beginPath();
  g.moveTo(-W * 0.05, H);
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const y =
      H *
      (0.82 -
        0.2 * Math.pow(Math.abs(Math.sin(u * 3.9 + 0.5)), 0.7) -
        0.07 * Math.sin(u * 8.2 + 1.4));
    g.lineTo(-W * 0.05 + u * W * 1.1, y);
  }
  g.lineTo(W * 1.05, H);
  g.closePath();
  g.fill();
  emit(W * 0.86, H * 0.6, W * 0.009, 0.15); // one last ember out on the sand
  rand();
};

/* harbor: a light, the ships that need it, and the quay they tie up to */
const harborFar: Draw = (g, W, H, emit, rand) => {
  // the headland, and the light on the end of it
  g.beginPath();
  g.moveTo(-W * 0.05, H);
  for (let i = 0; i <= 34; i++) {
    const u = i / 34;
    g.lineTo(-W * 0.05 + u * W * 0.78, H * (0.84 - 0.2 * Math.sin(u * 2.6 + 0.4) - 0.05 * Math.sin(u * 7)));
  }
  g.lineTo(W * 0.75, H);
  g.closePath();
  g.fill();
  const lx = W * 0.16;
  g.beginPath(); // tower: battered, the way they are built to take weather
  g.moveTo(lx - W * 0.038, H * 0.72);
  g.lineTo(lx - W * 0.024, H * 0.2);
  g.lineTo(lx + W * 0.024, H * 0.2);
  g.lineTo(lx + W * 0.038, H * 0.72);
  g.closePath();
  g.fill();
  g.fillRect(lx - W * 0.032, H * 0.15, W * 0.064, H * 0.055); // gallery
  g.fillRect(lx - W * 0.022, H * 0.08, W * 0.044, H * 0.07); // lantern room
  g.beginPath();
  g.moveTo(lx - W * 0.026, H * 0.08);
  g.lineTo(lx, H * 0.02);
  g.lineTo(lx + W * 0.026, H * 0.08);
  g.closePath();
  g.fill();
  emit(lx, H * 0.115, W * 0.03, 1); // the light itself
  for (let i = 0; i < 5; i++) emit(W * (0.36 + rand() * 0.3), H * (0.66 + rand() * 0.14), W * 0.009, rand() * 0.5);
};
const harborShips: Draw = (g, W, H, emit, rand) => {
  const ship = (cx: number, s: number, masts: number) => {
    const wl = H * 0.86;
    g.beginPath(); // hull: sheer line up at the bow, transom cut square
    g.moveTo(cx - W * 0.13 * s, wl);
    g.quadraticCurveTo(cx - W * 0.15 * s, wl - H * 0.1 * s, cx - W * 0.145 * s, wl - H * 0.16 * s);
    g.lineTo(cx + W * 0.12 * s, wl - H * 0.12 * s);
    g.lineTo(cx + W * 0.125 * s, wl);
    g.closePath();
    g.fill();
    g.fillRect(cx - W * 0.06 * s, wl - H * 0.19 * s, W * 0.08 * s, H * 0.07 * s); // deckhouse
    for (let m = 0; m < masts; m++) {
      const mx = cx + W * (-0.08 + m * 0.09) * s;
      const mh = H * (0.5 + rand() * 0.22) * s;
      g.fillRect(mx, wl - H * 0.12 * s - mh, Math.max(1, W * 0.006 * s), mh);
      g.fillRect(mx - W * 0.045 * s, wl - H * 0.12 * s - mh * 0.72, W * 0.09 * s, Math.max(1, H * 0.012 * s)); // yard
      g.lineWidth = Math.max(1, H * 0.006);
      g.beginPath(); // standing rigging, down to the rail
      g.moveTo(mx, wl - H * 0.12 * s - mh);
      g.lineTo(mx - W * 0.05 * s, wl - H * 0.13 * s);
      g.moveTo(mx + Math.max(1, W * 0.006 * s), wl - H * 0.12 * s - mh);
      g.lineTo(mx + W * 0.05 * s, wl - H * 0.13 * s);
      g.stroke();
    }
    for (let p = 0; p < 3; p++) emit(cx + W * (-0.09 + p * 0.08) * s, wl - H * 0.07 * s, W * 0.01 * s, 0.7 + rand() * 0.3);
    emit(cx - W * 0.02 * s, wl - H * 0.16 * s, W * 0.012 * s, 0.9);
  };
  ship(W * 0.3, 1, 3);
  ship(W * 0.74, 0.78, 2);
};
const harborQuay: Draw = (g, W, H, emit, rand) => {
  // warehouses along the water, pitched roofs, one crane over them
  let x = -W * 0.04;
  while (x < W * 0.8) {
    const w = W * (0.16 + rand() * 0.12);
    const h = H * (0.44 + rand() * 0.2);
    g.fillRect(x, H - h, w, h);
    g.beginPath();
    g.moveTo(x - W * 0.012, H - h);
    g.lineTo(x + w * 0.5, H - h - H * 0.14);
    g.lineTo(x + w + W * 0.012, H - h);
    g.closePath();
    g.fill();
    const cols = Math.max(2, Math.floor(w / (W * 0.06)));
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < 2; r++)
        if (rand() < 0.3) emit(x + ((c + 0.5) * w) / cols, H - h + H * (0.16 + r * 0.22), W * 0.014, 0.6 + rand() * 0.4);
    x += w + W * 0.03;
  }
  const cx = W * 0.86;
  g.fillRect(cx, H * 0.18, Math.max(1, W * 0.012), H * 0.82); // crane mast
  g.beginPath();
  g.moveTo(cx - W * 0.16, H * 0.1);
  g.lineTo(cx + W * 0.04, H * 0.2);
  g.lineTo(cx + W * 0.04, H * 0.25);
  g.lineTo(cx - W * 0.15, H * 0.15);
  g.closePath();
  g.fill();
  g.fillRect(cx - W * 0.155, H * 0.12, Math.max(1, W * 0.005), H * 0.3); // the fall, hanging
};
const harborDock: Draw = (g, W, H, emit, rand) => {
  g.fillRect(-W * 0.02, H * 0.5, W * 1.04, H); // the quay edge
  for (let i = 0; i < 5; i++) {
    // bollards, and the piles under them
    const bx = W * (0.06 + i * 0.22);
    g.fillRect(bx, H * 0.28, W * 0.03, H * 0.22);
    g.beginPath();
    g.ellipse(bx + W * 0.015, H * 0.28, W * 0.022, H * 0.035, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.fillRect(W * 0.4, H * 0.2, W * 0.11, H * 0.3); // crates, stacked and left
  g.fillRect(W * 0.46, H * 0.06, W * 0.09, H * 0.15);
  const px = W * 0.72; // a lamp post over the water
  g.fillRect(px, H * 0.04, Math.max(1, W * 0.008), H * 0.46);
  g.fillRect(px - W * 0.03, H * 0.03, W * 0.06, Math.max(1, H * 0.02));
  emit(px + W * 0.004, H * 0.06, W * 0.022, 1);
  emit(W * 0.16, H * 0.44, W * 0.01, 0.5 + rand() * 0.4);
};

const WORLDS: Record<string, World> = {
  "city-rooftops": {
    box: "#7c1d24", trim: "#3d0f14", paper: "#d9c3a4", sky: "#161226",
    horizon: "#c9541f", win: "#ffc65e", win2: "#ff8a3c", ember: "#ff8b3a",
    draw: [cityFar, cityMid, cityNear, cityFront],
  },
  "desert-night": {
    box: "#1d3f5e", trim: "#0b1d2e", paper: "#e0cbaa", sky: "#101a30",
    horizon: "#b8471c", win: "#ffd07a", win2: "#ff7b2e", ember: "#ff9642",
    // distance → the mesa; mid → the camp that has the height for its palms;
    // near → the caravan, big enough to read; front → the sand you stand on
    draw: [dunesFar, dunesPalms, dunesCaravan, dunesNear],
  },
  harbor: {
    box: "#16443f", trim: "#07211f", paper: "#cfc6b2", sky: "#0d1826",
    horizon: "#a8481f", win: "#ffdda0", win2: "#ff9b4a", ember: "#ff8f3e",
    draw: [harborFar, harborShips, harborQuay, harborDock],
  },
};
const WORLD_KEYS = Object.keys(WORLDS);

/* ---------- stage layout (rig space; the box's base sits at y = 0) ---------- */
const FOV = 42;
const CAM_Y = 1.6;
const CAM_Z = 4.4;
const BOX_L = 2.3; // sleeve, along x
const BOX_W = 1.5; // and z
const BOX_H = 0.6;
const SLEEVE_WALL = 0.055;
const DRAWER_OUT = 1.5;
const CAV_HW = 1.07; // drawer cavity, half extents
const CAV_HD = 0.63;
const CAV_Y = 0.05; // its floor
const TRAY_WALL = 0.05;
const TRAY_L = (CAV_HW + TRAY_WALL) * 2;
const TRAY_D = (CAV_HD + TRAY_WALL) * 2;
const TRAY_H = 0.45;
const STAGE_X = 0.36; // the diorama, in drawer space — it rides out with the tray
const PANEL_W = 1.3;
const STRIP_X = 0.82; // the head's travel along the strike strip, ±
const STRIP_Y = 0.29;
const STRIP_Z = BOX_W / 2 + 0.005;
const MATCH_L = 1.15;
// Where it comes to rest: propped over the tray's front-right corner, leaning
// out of the box in BOTH axes. The forward lean is load-bearing — stand the
// match level with the stage and the flame rakes the front panels at N·L ≈ 0.2
// while the back one takes it square at 0.83, so the inverse-square and the
// baked depth-shade cancel and the paper stack goes flat. Out front it is ~3:1.
const PLANT_LEAN = 0.5; // toward +x, onto the end wall
const PLANT_TIP = 0.42; // and toward the camera, out over the front edge
const PLANT_X = 0.55; // drawer space
const PLANT_Z = 0.46;
const READY_Z = 0.83; // it hovers a hair proud of the strip
const BOX_SPAN = 2.5; // what must not crop while the box is shut…
// …once the drawer is withdrawn it is the sleeve AND the tray: the sleeve ends
// at -1.15 and the tray rides out to DRAWER_OUT + TRAY_L/2 = +2.62. That union
// is 3.77 wide and centred at +0.73, not at 0 — framing it as BOX_SPAN put the
// tray at ndc x = 3.1 on a 390px portrait (frame is [-1, 1]), so the drawer you
// had just dragged left the screen. The match's tail is deliberately not in it:
// it overhangs to -1.97 and reads as held.
const OPEN_SPAN = 3.9;
const OPEN_CX = 0.73;
const STAGE_SPAN = 2.0; // …and only the stage once the world is up
const FRAME_X_OPEN = -2.0;
const FIT_MIN = 0.34; // OPEN_SPAN at aspect 0.46 needs this much room

const LAYERS = [
  { z: -0.58, h: 1.1, shade: 0.34 }, // the sky panel: the message hangs on it
  { z: -0.34, h: 0.84, shade: 0.46 },
  { z: -0.08, h: 0.66, shade: 0.64 },
  { z: 0.1, h: 0.46, shade: 0.82 },
  { z: 0.26, h: 0.34, shade: 1.0 },
];

/* ---------- opening timeline (seconds) ---------- */
const T_DRAW_M0 = 3.0; // the drawer starts easing itself out here…
const T_DRAW_M1 = 5.0; // …and is open here, whether or not anyone pulled it
const READY_DUR = 0.7; // the match lifting out and settling at the strip
const T_STRIKE_WAIT = 4.2; // how long it waits at the strip before striking itself
const T_STRIKE_CAP = 8.2; // and the hard deadline: 8.2 + TAU_END = 11.6 < 12
const AUTO_DUR = 0.42; // the self-strike is a visible drag, not a timer firing
const TAU_END = 3.4;
const T_FLY0 = 0.1; // the burning match leaves the strip…
const T_FLY1 = 0.78; // …and is planted in the tray
const FLARE_RISE = 0.045;
const FLARE_FALL = 0.13;
const FLARE_GAIN = 8.5;
const FLAME_I = 2.6;
// The cold rake on the shut box. It has to clear ACES's toe: the tonemapper
// returns 0 for any linear radiance under ~0.0022, and the sleeve is a dark
// card (#7c1d24, albedo 0.20) seen at N·L≈0.6 — at 0.22 it resolved to a
// literal 0/255 and the box, the drawer and the strip were an empty canvas for
// the whole gesture. The flame still runs it over: ~180 irradiance at the
// splint against 4, and the flare's overshoot is 8.5x that again.
const MOON_I = 4.0;
const MOON_LIT = 1.4; // what survives of it once the flame owns the scene
const AMBIENT_I = 0.6;
const PREV_PERIOD = 12.0;

/* ---------- the gate ---------- */
const STRIKE_V = 4.5; // strip-lengths·s⁻¹ ≈ 2.7 — a flick, not a drag
const STRIKE_RUN = 0.45; // and it has to actually travel
const V_DECAY = 0.09; // peak-hold, so the gate reads the stroke and not one sample

/* ---------- shared sprites ---------- */
const glowTex = makeRadialSprite();
const sparkTex = makeRadialSprite(32, [
  [0, "rgba(255,255,255,1)"],
  [0.3, "rgba(255,236,190,0.85)"],
  [1, "rgba(255,120,20,0)"],
]);

/* the ember band along the sky panel's foot — the last of the dusk */
function buildHorizonTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 128, 0, 0);
  gr.addColorStop(0, "#ffffff");
  gr.addColorStop(0.12, "#8a8a8a");
  gr.addColorStop(0.34, "#1e1e1e");
  gr.addColorStop(1, "#000000");
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}
const horizonTex = buildHorizonTexture();

/* ground glass and red phosphorus: coarse, uneven, and it is the grit that lights */
function buildStripTexture(): THREE.CanvasTexture {
  const W = 160;
  const H = 40;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2b1f1d";
  g.fillRect(0, 0, W, H);
  const rand = mulberry32(4242);
  for (let i = 0; i < 1400; i++) {
    const v = rand();
    g.fillStyle = `rgba(${(24 + v * 74) | 0},${(10 + v * 26) | 0},${(9 + v * 18) | 0},${0.25 + rand() * 0.55})`;
    g.fillRect(rand() * W, rand() * H, 1 + rand() * 1.7, 1 + rand() * 1.7);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const stripTex = buildStripTexture();

/* the card the box is printed on — only the flare ever shows it off */
function buildCardTexture(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, S, S);
  const rand = mulberry32(9091);
  for (let i = 0; i < 2600; i++) {
    const v = 0.72 + rand() * 0.28;
    g.fillStyle = `rgba(${(v * 255) | 0},${(v * 250) | 0},${(v * 244) | 0},${0.35 + rand() * 0.4})`;
    g.fillRect(rand() * S, rand() * S, 1 + rand() * 2.4, 1 + rand() * 1.3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const cardTex = buildCardTexture();

/* ---------- geometry ---------- */
// A match flame is a teardrop with a fat, round base and a tip that tapers to
// nothing — a cone reads as a party hat, so lathe the real profile.
const FV = (x: number, y: number) => new THREE.Vector2(x, y);
const flameGeo = new THREE.LatheGeometry(
  [
    FV(0.0, -0.062), FV(0.03, -0.05), FV(0.046, -0.022), FV(0.05, 0.012),
    FV(0.045, 0.05), FV(0.033, 0.096), FV(0.017, 0.142), FV(0.0, 0.172),
  ],
  16,
);
const coreGeo = new THREE.LatheGeometry(
  [
    FV(0.0, -0.05), FV(0.019, -0.04), FV(0.026, -0.016), FV(0.027, 0.006),
    FV(0.022, 0.032), FV(0.012, 0.058), FV(0.0, 0.076),
  ],
  12,
);
const splintGeo = new THREE.BoxGeometry(0.024, MATCH_L, 0.024);
splintGeo.translate(0, MATCH_L / 2, 0); // hinge at the tail, so the base is the transform
const headGeo = new THREE.SphereGeometry(0.043, 14, 10);
headGeo.scale(1, 1.5, 1);
const winGeo = new THREE.PlaneGeometry(1, 1);
const SPARK_N = 110;
const SPARK_LIFE = 0.5;

const tmpV = new THREE.Vector3();
const dummy = new THREE.Object3D();
const dcol = new THREE.Color();
// Built from hex so three converts them into the linear working space for us —
// setRGB would take the digits at face value and hand back a pale, chalky head.
const HEAD_RAW = new THREE.Color("#6b1710");
const HEAD_SPENT = new THREE.Color("#241a16");

/* ---------- building a world ---------- */
interface Built {
  layers: { tex: THREE.CanvasTexture; z: number; h: number; shade: number }[];
  win: { x: number; y: number; layer: number; r: number; t0: number; col: THREE.Color; ph: number }[];
  dispose: () => void;
}

function buildWorld(key: string): Built {
  const world = WORLDS[key] ?? WORLDS[WORLD_KEYS[0]];
  const rand = mulberry32(3317);
  const layers: Built["layers"] = [];
  const win: Built["win"] = [];
  const winC = new THREE.Color(world.win);
  const win2C = new THREE.Color(world.win2);

  for (let i = 0; i < 4; i++) {
    const spec = LAYERS[i + 1];
    const W = 384;
    const H = Math.round((W * spec.h) / PANEL_W);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    // Paper has a shaded foot even in flat light: the card curls a little and
    // the cut edge catches. One gradient sells the whole stack as card stock.
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "#5e5e5e");
    g.fillStyle = grad;
    g.strokeStyle = grad;
    g.lineCap = "round";
    g.lineJoin = "round";
    const layer = i + 1;
    world.draw[i](g, W, H, (px, py, r, warm) => {
      win.push({
        x: (px / W - 0.5) * PANEL_W,
        y: (1 - py / H) * spec.h,
        layer,
        r: (r / W) * PANEL_W,
        t0: 0.9 + rand() * 1.5 + 0.34 * (px / W),
        col: new THREE.Color().lerpColors(win2C, winC, warm),
        ph: rand() * 6.283,
      });
    }, rand);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    layers.push({ tex, z: spec.z, h: spec.h, shade: spec.shade });
  }
  return { layers, win, dispose: () => layers.forEach((l) => l.tex.dispose()) };
}

export default function MatchboxScene({
  variants,
  phase,
  recipientName,
  message,
  lang,
  onOpenComplete,
}: SceneProps) {
  const world = WORLDS[variants.world] ?? WORLDS[WORLD_KEYS[0]];
  const worldKey = WORLDS[variants.world] ? variants.world : WORLD_KEYS[0];
  const { t: tRef, done: doneRef } = useOpeningClock(phase);
  const glCanvas = useThree((s) => s.gl.domElement);
  const invalidate = useThree((s) => s.invalidate);

  // Under reduced motion the canvas is frameloop="demand", and a phase flip is
  // a prop change that touches no three.js node — so it schedules no frame of
  // its own. Today `revealed` gets drawn only because GiftView mounts the
  // message block and the canvas happens to resize; ask for the frame rather
  // than bank on that.
  useEffect(() => {
    invalidate();
  }, [phase, invalidate]);

  // The canvas ships `touch-action: manipulation`, which still permits pan — so
  // on a finger the compositor claims the swipe for a scroll after the *first*
  // pointermove and fires pointercancel. Measured: 8 moves become 1, and a gate
  // that needs run > 0.45 in one stroke can never close. Borrowed only while the
  // gesture is live, and handed back after — at `revealed` the message block
  // below the canvas is what the page needs to scroll to.
  useEffect(() => {
    if (phase !== "opening") return;
    const prev = glCanvas.style.getPropertyValue("touch-action");
    glCanvas.style.setProperty("touch-action", "none");
    return () => {
      if (prev) glCanvas.style.setProperty("touch-action", prev);
      else glCanvas.style.removeProperty("touch-action");
    };
  }, [phase, glCanvas]);

  const built = useMemo(() => buildWorld(worldKey), [worldKey]);
  useEffect(() => () => built.dispose(), [built]);

  // `message` is "" on the gallery card, and live per-keystroke from /create —
  // so never require it, and never assume it is missing.
  const textSource = message.trim() || forRecipient(lang, recipientName);
  const msg = useMemo(() => {
    const { texture, aspect } = makeTextTexture(textSource, {
      fontSize: 58, fontWeight: "600", color: "#ffffff", maxWidthPx: 640, padding: 18, lang,
    });
    let w = PANEL_W * 0.88;
    if (aspect * w > 0.34) w = 0.34 / aspect; // a long note trades width for a band it fits
    return { texture, w, h: w * aspect };
  }, [textSource, lang]);
  useEffect(() => () => msg.texture.dispose(), [msg]);

  const paperMats = useMemo(
    () =>
      built.layers.map(
        (l) =>
          new THREE.MeshStandardMaterial({
            map: l.tex,
            // The flame's inverse-square already separates the stack; this is the
            // occlusion it cannot do — the front layers shading the back ones.
            color: new THREE.Color(world.paper).multiplyScalar(l.shade),
            roughness: 0.96,
            metalness: 0,
            alphaTest: 0.5, // paper is cut, not faded: keep depth honest and skip sorting
            side: THREE.DoubleSide,
          }),
      ),
    [built, world],
  );
  useEffect(() => () => paperMats.forEach((m) => m.dispose()), [paperMats]);

  const panelGeos = useMemo(
    () =>
      built.layers.map((l) => {
        const g = new THREE.PlaneGeometry(PANEL_W, l.h);
        g.translate(0, l.h / 2, 0); // hinge along the bottom edge
        return g;
      }),
    [built],
  );
  useEffect(() => () => panelGeos.forEach((g) => g.dispose()), [panelGeos]);

  const skyGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(PANEL_W, LAYERS[0].h);
    g.translate(0, LAYERS[0].h / 2, 0);
    return g;
  }, []);
  useEffect(() => () => skyGeo.dispose(), [skyGeo]);

  const sparkBuf = useMemo(
    () => ({ pos: new Float32Array(SPARK_N * 3), col: new Float32Array(SPARK_N * 3) }),
    [],
  );
  const sparks = useRef({
    t0: new Float32Array(SPARK_N).fill(-99),
    o: new Float32Array(SPARK_N * 3),
    v: new Float32Array(SPARK_N * 3),
    heat: new Float32Array(SPARK_N),
    cursor: 0,
  });

  const fitRef = useRef<THREE.Group>(null);
  const fitSeeded = useRef(false);
  const tiltRef = useRef<THREE.Group>(null);
  const frameRef = useRef<THREE.Group>(null);
  const drawerRef = useRef<THREE.Group>(null);
  const panelRefs = useRef<(THREE.Group | null)[]>([]);
  const skyRef = useRef<THREE.Group>(null);
  const skyMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const msgMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const winRef = useRef<THREE.InstancedMesh>(null);
  const matchRef = useRef<THREE.Group>(null);
  const charRef = useRef<THREE.Mesh>(null);
  const charMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const headMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const flameRef = useRef<THREE.Group>(null);
  const flameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bloomRef = useRef<THREE.Sprite>(null);
  const bloomMatRef = useRef<THREE.SpriteMaterial>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const scrapeRef = useRef<THREE.Sprite>(null);
  const scrapeMatRef = useRef<THREE.SpriteMaterial>(null);
  const hintRef = useRef<THREE.Sprite>(null);
  const hintMatRef = useRef<THREE.SpriteMaterial>(null);
  const poolRef = useRef<THREE.Mesh>(null);
  const poolMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const shadowMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const backRef = useRef<THREE.Mesh>(null);
  const sparkRef = useRef<THREE.Points>(null);

  const g = useRef({
    on: false,
    seeded: false,
    seedBeat: -1,
    beat: 0 as 0 | 1, // 0 = the drawer, 1 = the strike
    px: 0,
    open: 0, // what the finger has pulled out
    latched: false,
    grab: 0,
    hx: -STRIP_X, // the head, along the strip
    moved: 0, // distance dragged since the last frame
    v: 0, // peak-held stroke speed
    run: 0,
    scrape: 0,
    emit: 0,
    idle: 0,
    fizz: 0,
    drawerAt: -1,
    ign: -1,
    ignHX: STRIP_X,
    prevTau: -1,
  });

  // The clock resets on replay, so every accumulator has to as well — otherwise
  // run two would strike before anyone touched it.
  useLayoutEffect(() => {
    // useOpeningClock zeroes `t` in a *passive* effect, which lands after paint —
    // so a replay's first frame can still run on the finished run's clock (t≈11.7).
    // That frame stamps s.drawerAt in the future, and since drawerAt only ever
    // latches once, `ready` stays 0 until t climbs back past it: the drawer sits
    // dead ~11.7s and onOpenComplete lands at 15.8s, blowing the 12s bound.
    // Zeroing it here is pre-paint, so no frame can see the stale clock.
    if (phase === "opening") tRef.current = 0;
    const s = g.current;
    s.on = s.seeded = s.latched = false;
    s.beat = 0;
    s.seedBeat = -1;
    s.open = s.v = s.run = s.scrape = s.emit = s.fizz = s.moved = 0;
    s.idle = 0;
    s.hx = -STRIP_X;
    s.drawerAt = s.ign = -1;
    s.ignHX = STRIP_X;
    s.prevTau = -1;
    sparks.current.t0.fill(-99);
  }, [phase, tRef]);

  const emitSparks = (n: number, x: number, y: number, z: number, power: number, e: number) => {
    const sk = sparks.current;
    for (let k = 0; k < n; k++) {
      const i = sk.cursor;
      sk.cursor = (i + 1) % SPARK_N;
      // struck grit throws forward along the stroke and up off the strip
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random() * 1.5) * power;
      sk.t0[i] = e;
      sk.o[i * 3] = x;
      sk.o[i * 3 + 1] = y;
      sk.o[i * 3 + 2] = z;
      sk.v[i * 3] = Math.cos(a) * sp * 0.7 + power * 0.5;
      sk.v[i * 3 + 1] = 0.35 + Math.abs(Math.sin(a)) * sp;
      sk.v[i * 3 + 2] = (Math.random() - 0.5) * sp * 0.5 + 0.25;
      sk.heat[i] = 0.35 + Math.random() * 0.65;
    }
  };

  /* ---------- the two swipes ---------- */
  const stop = () => {
    const s = g.current;
    if (s.on && s.beat === 1 && s.run > STRIKE_RUN * 0.6 && s.v > STRIKE_V * 0.5 && s.ign < 0) {
      s.fizz = 1; // an almost: a scrape's worth of sparks, and no flame
    }
    s.on = false;
    s.seeded = false;
    s.run = 0;
  };
  const onDown = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    if (phase !== "opening") return;
    try {
      (ev.target as Element).setPointerCapture(ev.pointerId);
    } catch {
      /* a nicety — the pointer-out fallback covers its absence */
    }
    const s = g.current;
    s.on = true;
    s.seeded = false;
    s.run = 0;
    s.idle = 0;
  };
  const onMove = (ev: ThreeEvent<PointerEvent>) => {
    ev.stopPropagation();
    const hit = ev.object as THREE.Mesh;
    const s = g.current;
    if (!s.on || phase !== "opening" || s.ign >= 0) return;
    // Local units, so the gate is the same gesture on a phone and a desktop: the
    // strip is 1.64 units long wherever it is drawn, and crossing it is crossing it.
    hit.worldToLocal(tmpV.copy(ev.point));
    const x = tmpV.x;
    // The beat can flip under a held finger — the drawer latches open and the
    // match arrives at the strip mid-drag. Re-seed, or the stale grab teleports
    // the head, and a teleport is an infinite velocity: it would strike itself.
    if (!s.seeded || s.seedBeat !== s.beat) {
      s.seeded = true;
      s.seedBeat = s.beat;
      s.grab = x - s.hx;
      s.px = x;
      return; // the seeding jump is not a stroke
    }
    if (s.beat === 0) {
      s.open = clamp01(s.open + (x - s.px) / DRAWER_OUT); // the drawer rides the finger
      if (s.open > 0.55) s.latched = true;
    } else {
      const nx = Math.max(-STRIP_X, Math.min(STRIP_X, x - s.grab));
      const moved = Math.abs(nx - s.hx);
      s.hx = nx;
      // A jump this big is a capture artefact, never a stroke. The gate is the
      // whole gesture; nothing that is not a real hand may open it.
      if (moved < 0.6) {
        s.run += moved;
        s.moved += moved;
      }
    }
    s.px = x;
    s.idle = 0;
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const e = state.clock.elapsedTime;
    if (phase === "opening") tRef.current += dt;
    const t = tRef.current;
    const s = g.current;

    /* ---- how fast the hand is actually going ---- */
    // Measured over the frame clock, not event timestamps: pointer moves coalesce
    // and can share a timestamp, and dividing by that zero would hand a lazy drag
    // an infinite velocity. Peak-held for ~90ms so the gate reads the stroke
    // rather than whichever sample happened to land last.
    const movedF = s.moved;
    s.moved = 0;
    const instV = movedF / dt;
    s.v = Math.max(s.v * Math.exp(-dt / V_DECAY), instV);

    /* ---- the two clocks every phase resolves to ---- */
    let open: number;
    let ready: number;
    let tau: number; // < 0 until it lights
    let dim = 1; // preview only: the flame gutters out and the loop breathes
    let hint = 0;
    let auto = -1;

    if (phase === "opening") {
      if (s.latched) s.open = Math.min(1, s.open + dt * 2.4);
      const mercy = smooth(clamp01((t - T_DRAW_M0) / (T_DRAW_M1 - T_DRAW_M0)));
      open = Math.max(s.open, mercy);
      if (open >= 0.999 && s.drawerAt < 0) s.drawerAt = t;
      ready = s.drawerAt < 0 ? 0 : smooth(clamp01((t - s.drawerAt) / READY_DUR));
      s.beat = ready >= 1 ? 1 : 0;
      // The self-strike is the earlier of "it has waited long enough at the strip"
      // and the hard cap that keeps onOpenComplete inside 12s.
      const strikeAt =
        s.drawerAt < 0
          ? T_STRIKE_CAP
          : Math.min(s.drawerAt + READY_DUR + T_STRIKE_WAIT, T_STRIKE_CAP);
      if (s.beat === 1 && s.ign < 0) {
        auto = clamp01((t - (strikeAt - AUTO_DUR)) / AUTO_DUR);
        if (auto > 0 && !s.on) s.hx = lerp(-STRIP_X, STRIP_X, auto);
        // While a finger is on it the mercy waits — it is theirs to strike, and a
        // match that lights under a lazy drag says the gate was never real. It
        // fires the moment they let go, or give up mid-hold; the no-input path,
        // which is the only one the 12s bound covers, never sees this branch.
        if (auto >= 1 && (!s.on || s.idle > 1.5)) {
          s.ign = t;
          s.ignHX = s.hx;
        }
        // the gate: fast enough, and far enough to have actually been a stroke
        if (s.v > STRIKE_V && s.run > STRIKE_RUN) {
          s.ign = t;
          s.ignHX = s.hx;
        }
      }
      if (s.ign < 0) hint = clamp01((s.idle - 1.1) / 0.8) * (auto > 0 ? 0 : 1);
      tau = s.ign >= 0 ? t - s.ign : -1;
    } else if (phase === "revealed") {
      // A whole tableau from `phase` alone: reduced motion lands here cold and
      // every curve below is already saturated on the first frame.
      open = 1;
      ready = 1;
      tau = TAU_END;
    } else if (phase === "preview") {
      // the entire gift on a loop — it never waits for a gesture it will not get
      const cyc = e % PREV_PERIOD;
      tau = cyc - 3.65;
      open =
        smooth(clamp01((cyc - 1.6) / 1.2)) * (1 - smooth(clamp01((cyc - 9.7) / 1.1)));
      ready = smooth(clamp01((cyc - 2.9) / 0.7));
      // `dim` is the loop's master fade, and it has to come up as well as go
      // down: the drawer shuts around the planted match and the frame is still
      // whipped left when cyc wraps, so the reset only reads as a reset if it
      // happens in the dark. Out by 9.6, back in over the first 0.8s.
      dim =
        smooth(clamp01(cyc / 0.8)) * (1 - smooth(clamp01((cyc - 8.4) / 1.2)));
      s.hx = lerp(-STRIP_X, STRIP_X, clamp01((cyc - 3.35) / 0.3));
      s.ignHX = STRIP_X;
    } else {
      open = 0;
      ready = 0;
      tau = -1;
    }

    const lit = tau >= 0;
    if (!lit) {
      // The head slides home between attempts, so a fizzle is an invitation.
      // `auto` is -1 in beat 0 and >= 0 the moment the match reaches the strip,
      // so `auto < 0` only ever ran in the beat where the head is parked anyway;
      // <= 0 is the real condition — slide home until the mercy drag takes over.
      if (!s.on && phase === "opening" && auto <= 0) s.hx = lerp(s.hx, -STRIP_X, Math.min(1, dt * 3.5));
      // The shower is the readout of the gate: a timid stroke buys a few sad
      // sparks and no flame, and you can see exactly how short you fell.
      s.scrape = Math.max(s.scrape * Math.exp(-dt / 0.11), clamp01(s.v / STRIKE_V));
      s.emit += movedF * clamp01(instV / STRIKE_V) * 34;
      s.idle += dt;
    }

    /* ---- the flare ---- */
    // The head's chlorate flashes off in a twentieth of a second and is spent in
    // a tenth; the splint needs half a second to catch. Between the two the match
    // genuinely dips — that dip is what makes the flare read as a flare.
    const spike = lit
      ? tau < FLARE_RISE
        ? smooth(tau / FLARE_RISE)
        : Math.exp(-(tau - FLARE_RISE) / FLARE_FALL)
      : 0;
    const steady = lit ? smooth(clamp01((tau - 0.1) / 0.8)) : 0;
    // Layered sines at frequencies that share no common multiple: the sum never
    // repeats, which is the thing noise keeps failing to fake.
    const flick =
      1 +
      0.055 * Math.sin(e * 11.3) +
      0.038 * Math.sin(e * 19.7 + 1.7) +
      0.026 * Math.sin(e * 31.1 + 4.2) +
      0.017 * Math.sin(e * 47.3 + 2.4);
    const sway =
      0.06 * Math.sin(e * 2.3) + 0.04 * Math.sin(e * 3.7 + 1.1) + 0.022 * Math.sin(e * 6.1 + 2.9);
    const burn = (steady * flick + spike * FLARE_GAIN) * dim;

    /* ---- fit and frame: the camera stays put, the world comes to it ---- */
    // What must not crop changes as the show runs — the whole box while it is
    // shut, only the stage once the world is up. The frame holds on the box for
    // the strike and whips across on the flare, so `focus` is the shot.
    const focus = lit ? smooth(clamp01(tau / 0.9)) : 0;
    // viewport.width is measured at z = 0, but the action stands ~0.8 in front of
    // it and the push-in carries it forward again — and scaling the rig scales
    // that depth too, so the honest fit is the fixed point of both. It has a
    // closed form: fit·span ≤ m·(CAM_Z − fit·z)·K. (Horizontal extent only cares
    // about depth, and the camera's 15° tilt makes CAM_Z−z a ~3% pessimist here.)
    const K = Math.tan((FOV * Math.PI) / 360) * (state.size.width / state.size.height);
    // it changes twice, not once: shut box → box + withdrawn drawer → stage
    const halfSpan = lerp(lerp(BOX_SPAN, OPEN_SPAN, open), STAGE_SPAN, focus) / 2;
    const actZ = lerp(0.79, 0.62, focus);
    const want = Math.max(FIT_MIN, Math.min(1, (0.94 * CAM_Z * K) / (halfSpan + 0.94 * actZ * K)));
    // The canvas loses ~332px to the HTML message the instant onOpenComplete
    // fires, so the aspect jumps under us; ease into the new fit or the reveal
    // lands on a visible pop.
    const fit = fitSeeded.current ? lerp(fitRef.current?.scale.x ?? want, want, Math.min(1, dt * 4)) : want;
    fitSeeded.current = true;
    fitRef.current?.scale.setScalar(fit);
    // …but an ease needs frames, and reduced motion has none to spare: the
    // canvas is frameloop="demand" and GiftCanvas's 40 settle frames are all
    // spent in `sealed`, so Unwrap → `revealed` rendered exactly one frame and
    // the fit froze 5% of the way there (0.558 against 0.665). Ask for the
    // frames instead of assuming them. Only at `revealed`, where `want` is
    // constant so this terminates — in `preview` it would drive the loop
    // forever and animate a card that is meant to be still.
    if (phase === "revealed" && Math.abs(fit - want) > 0.001) state.invalidate();
    if (frameRef.current) {
      // it slides across to hold the tray as the drawer comes out, then whips
      // the rest of the way to the stage when the match catches
      frameRef.current.position.set(
        lerp(-OPEN_CX * open, FRAME_X_OPEN, focus),
        -0.34 * focus,
        0.5 * focus,
      );
      frameRef.current.rotation.x = lerp(-0.2, 0, focus); // and it cranes down as it goes
    }
    if (tiltRef.current) {
      const k = Math.min(1, dt * 3);
      tiltRef.current.rotation.x = lerp(tiltRef.current.rotation.x, state.pointer.y * 0.05, k);
      tiltRef.current.rotation.y = lerp(tiltRef.current.rotation.y, state.pointer.x * 0.07, k);
    }
    // Sized, not eyeballed: it has to cover a 2.53 aspect at reveal, and it moves
    // with the rig, so it carries the frame's whole travel as margin.
    if (backRef.current) {
      const d = CAM_Z + 10;
      const h = 2 * d * Math.tan((FOV * Math.PI) / 360);
      backRef.current.scale.set(h * (state.size.width / state.size.height) + 6, h + 6, 1);
    }

    const drawerX = DRAWER_OUT * open;
    drawerRef.current?.position.setX(drawerX);

    /* ---- the match: stowed → at the strip → struck → planted ---- */
    const fly = lit ? smooth(clamp01((tau - T_FLY0) / (T_FLY1 - T_FLY0))) : 0;
    const m = matchRef.current;
    if (m) {
      const rx = s.hx - MATCH_L; // ready: the tail is what you hold
      const ry = lerp(CAV_Y + 0.04, STRIP_Y, ready);
      const rz = lerp(drawerX + STAGE_X + 0.5, READY_Z, ready);
      const px = drawerX + PLANT_X;
      m.position.set(
        lerp(rx, px, fly),
        lerp(ry, CAV_Y, fly) + Math.sin(fly * Math.PI) * 0.16, // it is thrown, not slid
        lerp(rz, PLANT_Z, fly),
      );
      // z first, then x (three's XYZ euler): the splint tips out toward the
      // camera as it swings down, so the flame ends up in front of the stage
      m.rotation.set(lerp(0, PLANT_TIP, fly), 0, lerp(-Math.PI / 2, -PLANT_LEAN, fly));
      m.visible = ready > 0.01 || fly > 0;
      m.position.y += lit ? 0 : ready * 0.008 * Math.sin(e * 2.4);
    }
    if (charRef.current) {
      // the splint blackens back from the head as it burns
      const ch = lit ? clamp01((tau - 0.35) / 6) * 0.34 : 0;
      charRef.current.visible = ch > 0.002;
      charRef.current.scale.set(1, Math.max(0.001, ch), 1);
      charRef.current.position.y = MATCH_L * (1 - ch / 2);
    }
    // the last ember still alight on the char — the preview fade owns it as well
    if (charMatRef.current) charMatRef.current.emissiveIntensity = 0.25 * dim;
    if (headMatRef.current) {
      const hm = headMatRef.current;
      hm.emissiveIntensity = lit ? (0.6 + spike * 3) * dim : 0;
      // the head is spent within half a second of lighting — it is a fuse, not fuel
      hm.color.lerpColors(HEAD_RAW, HEAD_SPENT, clamp01(tau / 0.5));
    }

    /* ---- the flame ---- */
    const fl = flameRef.current;
    if (fl) {
      fl.visible = lit && burn > 0.002;
      const size = clamp01(steady * 1.1) * dim;
      // it whips: the tip leans on the slow set while the body pulses on the fast
      fl.scale.set(
        (0.55 + size * 0.55) * (1 + spike * 1.5),
        (0.4 + size * 0.72) * (1 + spike * 2.6) * (1 + 0.09 * Math.sin(e * 13.1 + 0.7)),
        (0.55 + size * 0.55) * (1 + spike * 1.5),
      );
      fl.rotation.z = sway * 1.4;
      fl.position.x = sway * 0.045;
    }
    if (flameMatRef.current) {
      // Colour is set in linear working space and deliberately runs past 1: ACES
      // is what turns the overshoot into a blown highlight instead of a clip.
      const k = burn;
      flameMatRef.current.color.setRGB(1.1 * k + spike * 4, 0.52 * k + spike * 3.4, 0.16 * k + spike * 2.6);
      flameMatRef.current.opacity = clamp01(steady * 1.6 + spike);
    }
    if (coreMatRef.current) {
      const k = burn;
      coreMatRef.current.color.setRGB(1.4 * k + spike * 5, 1.15 * k + spike * 4.6, 0.85 * k + spike * 4);
      coreMatRef.current.opacity = clamp01(steady * 1.4 + spike);
    }
    if (bloomRef.current && bloomMatRef.current) {
      bloomRef.current.scale.setScalar(0.3 + steady * 0.5 + spike * 2.6);
      bloomMatRef.current.opacity = clamp01((steady * 0.42 + spike * 0.85) * dim);
    }
    if (lightRef.current) {
      // decay 2 and no cutoff: the falloff alone shades the paper stack, and the
      // flare's overshoot reaches the sleeve for exactly as long as it lasts
      lightRef.current.intensity = burn * FLAME_I;
    }
    if (moonRef.current) {
      // the cold rake that showed the sealed box's edge loses to the flame — and
      // it is a channel of the look like any other, so the preview fade owns it
      // too. Leaving it out is what let the loop reset in plain sight.
      moonRef.current.intensity = lerp(MOON_I, MOON_LIT, clamp01(steady * dim)) * dim;
    }

    /* ---- the paper world standing up ---- */
    const skyRise = lit ? smooth(clamp01((tau - 0.2) / 0.75)) : 0;
    if (skyRef.current) {
      skyRef.current.rotation.x = lerp(Math.PI / 2, 0, skyRise * open);
      skyRef.current.visible = skyRise * open > 0.001;
    }
    if (skyMatRef.current) skyMatRef.current.emissiveIntensity = burn * 0.55;
    const rise: number[] = [];
    for (let i = 0; i < built.layers.length; i++) {
      // back to front: the depth blooms toward you instead of all at once
      const r = (lit ? smooth(clamp01((tau - 0.28 - i * 0.13) / 0.7)) : 0) * open;
      rise.push(r);
      const p = panelRefs.current[i];
      if (p) {
        p.rotation.x = lerp(Math.PI / 2, 0, r);
        p.visible = r > 0.001;
      }
    }
    if (msgMatRef.current) {
      msgMatRef.current.opacity = clamp01(smooth(clamp01((tau - 1.3) / 1.2)) * skyRise * dim) * 0.95;
    }

    /* ---- the windows, one by one ---- */
    const inst = winRef.current;
    if (inst && built.win.length) {
      for (let i = 0; i < built.win.length; i++) {
        const w = built.win[i];
        const spec = LAYERS[w.layer];
        const a = rise[w.layer - 1] ?? 0;
        const th = lerp(Math.PI / 2, 0, a);
        const c = Math.cos(th);
        const sn = Math.sin(th);
        dummy.position.set(
          STAGE_X + w.x,
          CAV_Y + w.y * c - 0.006 * sn,
          spec.z + w.y * sn + 0.006 * c,
        );
        dummy.rotation.set(th, 0, 0);
        dummy.scale.setScalar(w.r * 2);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        // each pane comes up on its own beat and then just breathes
        const on = clamp01((tau - w.t0) / 0.16) * a * dim;
        const k = on * (0.82 + 0.18 * Math.sin(e * 5.3 + w.ph));
        dcol.copy(w.col).multiplyScalar(k * 1.5);
        inst.setColorAt(i, dcol);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    }

    /* ---- scrape, hint, ground ---- */
    if (scrapeRef.current && scrapeMatRef.current) {
      const show = !lit && ready > 0.5 && phase !== "sealed";
      scrapeRef.current.visible = show && s.scrape > 0.01;
      if (show) {
        scrapeRef.current.position.set(s.hx, STRIP_Y, STRIP_Z + 0.02);
        scrapeRef.current.scale.setScalar(0.08 + s.scrape * 0.16);
        scrapeMatRef.current.opacity = s.scrape * 0.75;
      }
    }
    if (hintRef.current && hintMatRef.current) {
      const beat0 = ready < 0.5;
      hintRef.current.position.set(
        beat0 ? lerp(-0.3, 0.9, (Math.sin(t * 1.7) + 1) / 2) : lerp(-STRIP_X, STRIP_X, ((t * 0.9) % 1)),
        beat0 ? BOX_H + 0.03 : STRIP_Y,
        beat0 ? 0.2 : STRIP_Z + 0.03,
      );
      hintRef.current.scale.setScalar(beat0 ? 0.5 : 0.3);
      hintMatRef.current.opacity = hint * (beat0 ? 0.3 : 0.42);
    }
    if (poolRef.current && poolMatRef.current) {
      poolRef.current.position.x = drawerX + PLANT_X + 0.4;
      poolRef.current.scale.setScalar(1.1 + clamp01(burn) * 0.5);
      poolMatRef.current.opacity = clamp01(burn * 0.34);
    }
    if (shadowMatRef.current) {
      // the box's own shadow only exists once there is something to cast it
      shadowMatRef.current.opacity = 0.22 + clamp01(burn) * 0.42;
    }

    /* ---- sparks ---- */
    // The ignition burst is stamped off tau's zero-crossing, so it fires the same
    // whether a finger, the mercy timer or the preview loop lit the match. The
    // tau guard is what keeps a cold `revealed` — which mounts at tau = TAU_END —
    // from throwing a shower of sparks that are three seconds too late.
    if (lit && s.prevTau < 0 && tau < 0.25) {
      emitSparks(46, s.ignHX, STRIP_Y, STRIP_Z + 0.02, 2.6, e);
    }
    s.prevTau = tau;
    if (s.fizz > 0) {
      emitSparks(10, s.hx, STRIP_Y, STRIP_Z + 0.02, 0.85, e);
      s.fizz = 0;
    }
    if (s.emit >= 1) {
      const n = Math.min(6, Math.floor(s.emit));
      emitSparks(n, s.hx, STRIP_Y, STRIP_Z + 0.02, 0.5 + s.scrape * 1.4, e);
      s.emit -= n;
    }
    const sp = sparkRef.current;
    if (sp) {
      const sk = sparks.current;
      const pa = sp.geometry.attributes.position as THREE.BufferAttribute;
      const ca = sp.geometry.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < SPARK_N; i++) {
        const a = e - sk.t0[i];
        if (a < 0 || a > SPARK_LIFE) {
          ca.setXYZ(i, 0, 0, 0);
          continue;
        }
        pa.setXYZ(
          i,
          sk.o[i * 3] + sk.v[i * 3] * a,
          sk.o[i * 3 + 1] + sk.v[i * 3 + 1] * a - 3.2 * a * a,
          sk.o[i * 3 + 2] + sk.v[i * 3 + 2] * a,
        );
        // white-hot, then orange, then gone — grit does not have time to be red
        const k = (1 - a / SPARK_LIFE) * sk.heat[i] * dim;
        ca.setXYZ(i, k * 1.6, k * k * 0.95, k * k * k * 0.4);
      }
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }

    if (phase === "opening" && lit && tau >= TAU_END && !doneRef.current) {
      doneRef.current = true;
      onOpenComplete?.();
    }
  });

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, CAM_Y, CAM_Z]}
        fov={FOV}
        onUpdate={(c) => c.lookAt(0, 0.45, 0)}
      />
      {/* low, and cold: the flame has to be the only warm thing here */}
      <ambientLight intensity={AMBIENT_I} color="#3d3358" />
      <directionalLight ref={moonRef} position={[-2.6, 3.2, 3.4]} intensity={MOON_I} color="#7286bd" />

      <group ref={fitRef}>
        <group ref={tiltRef}>
          <group ref={frameRef}>
            <mesh ref={backRef} position={[0, 3, -10]}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial color="#0a0710" />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[44, 44]} />
              <meshStandardMaterial color="#1c1613" roughness={0.88} metalness={0} />
            </mesh>
            {/* no shadow maps: a soft dark plane, then the pool of light over it.
                Coplanar and both depth-write-free, so the order has to be said. */}
            <mesh position={[-0.35, 0.004, 0.15]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
              <planeGeometry args={[3.6, 2.4]} />
              <meshBasicMaterial
                ref={shadowMatRef} map={glowTex} color="#000000" transparent opacity={0.3} depthWrite={false}
              />
            </mesh>
            <mesh ref={poolRef} position={[0, 0.006, 0.3]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
              <planeGeometry args={[2.6, 2.6]} />
              <meshBasicMaterial
                ref={poolMatRef} map={glowTex} color={world.horizon} transparent opacity={0}
                depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </mesh>

            {/* the drawer, and everything that rides out with it */}
            <group ref={drawerRef}>
              <mesh position={[0, CAV_Y / 2, 0]}>
                <boxGeometry args={[TRAY_L, CAV_Y, TRAY_D]} />
                <meshStandardMaterial map={cardTex} color={world.paper} roughness={0.94} />
              </mesh>
              {([-1, 1] as const).map((sx, i) => (
                <mesh key={i} position={[sx * (CAV_HW + TRAY_WALL / 2), CAV_Y + TRAY_H / 2, 0]}>
                  <boxGeometry args={[TRAY_WALL, TRAY_H, TRAY_D]} />
                  <meshStandardMaterial map={cardTex} color={world.paper} roughness={0.94} />
                </mesh>
              ))}
              {([-1, 1] as const).map((sz, i) => (
                <mesh key={i} position={[0, CAV_Y + TRAY_H / 2, sz * (CAV_HD + TRAY_WALL / 2)]}>
                  <boxGeometry args={[TRAY_L, TRAY_H, TRAY_WALL]} />
                  <meshStandardMaterial map={cardTex} color={world.trim} roughness={0.94} />
                </mesh>
              ))}
              {/* the tray floor, receding under the stage — the occlusion the
                  missing shadow map owes the back of the set */}
              <mesh position={[STAGE_X, CAV_Y + 0.002, -0.35]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3}>
                <planeGeometry args={[1.5, 0.9]} />
                <meshBasicMaterial map={glowTex} color="#000000" transparent opacity={0.75} depthWrite={false} />
              </mesh>

              {/* the sky panel, and the message hanging on it */}
              <group ref={skyRef} position={[STAGE_X, CAV_Y, LAYERS[0].z]}>
                <mesh geometry={skyGeo}>
                  <meshStandardMaterial
                    ref={skyMatRef} color={world.sky} roughness={0.96} metalness={0}
                    emissive={world.horizon} emissiveMap={horizonTex} emissiveIntensity={0}
                    side={THREE.DoubleSide}
                  />
                </mesh>
                <mesh position={[0, 0.9, 0.006]}>
                  <planeGeometry args={[msg.w, msg.h]} />
                  <meshBasicMaterial
                    ref={msgMatRef} map={msg.texture} color={world.ember} transparent opacity={0}
                    depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending}
                  />
                </mesh>
              </group>

              {/* the cut layers, hinged along their feet */}
              {built.layers.map((l, i) => (
                <group
                  key={i}
                  ref={(n) => {
                    panelRefs.current[i] = n;
                  }}
                  position={[STAGE_X, CAV_Y, l.z]}
                >
                  <mesh geometry={panelGeos[i]} material={paperMats[i]} />
                </group>
              ))}

              {built.win.length > 0 && (
                <instancedMesh ref={winRef} args={[winGeo, undefined, built.win.length]} frustumCulled={false}>
                  {/* No `vertexColors` here on purpose. instanceColor alone is
                      what setColorAt feeds, and three's *fragment* prefix already
                      defines USE_COLOR from it. Asking for vertexColors as well
                      declares `attribute vec3 color`, which this geometry has not
                      got — an unbound attribute reads (0,0,0), color_vertex does
                      `vColor.rgb *= color`, and every window goes black. */}
                  <meshBasicMaterial
                    map={glowTex} transparent depthWrite={false}
                    blending={THREE.AdditiveBlending} toneMapped={false}
                  />
                </instancedMesh>
              )}
            </group>

            {/* the sleeve: three slabs, open at both ends, exactly like the real thing */}
            <mesh position={[0, BOX_H - SLEEVE_WALL / 2, 0]}>
              <boxGeometry args={[BOX_L, SLEEVE_WALL, BOX_W]} />
              <meshStandardMaterial map={cardTex} color={world.box} roughness={0.9} />
            </mesh>
            {([-1, 1] as const).map((sz, i) => (
              <mesh key={i} position={[0, BOX_H / 2, (sz * (BOX_W - SLEEVE_WALL)) / 2]}>
                <boxGeometry args={[BOX_L, BOX_H, SLEEVE_WALL]} />
                <meshStandardMaterial map={cardTex} color={i ? world.box : world.trim} roughness={0.9} />
              </mesh>
            ))}
            <mesh position={[0, STRIP_Y, STRIP_Z]}>
              <planeGeometry args={[BOX_L * 0.86, 0.34]} />
              <meshStandardMaterial map={stripTex} roughness={0.98} metalness={0} />
            </mesh>

            {/* the match */}
            <group ref={matchRef} visible={false}>
              <mesh geometry={splintGeo}>
                <meshStandardMaterial map={cardTex} color="#c9a978" roughness={0.85} />
              </mesh>
              <mesh ref={charRef} position={[0, MATCH_L, 0]} visible={false}>
                <boxGeometry args={[0.027, MATCH_L, 0.027]} />
                <meshStandardMaterial ref={charMatRef} color="#17120f" roughness={1} emissive="#ff5a12" emissiveIntensity={0.25} />
              </mesh>
              <mesh geometry={headGeo} position={[0, MATCH_L + 0.012, 0]}>
                <meshStandardMaterial ref={headMatRef} color="#6b1710" roughness={0.62} emissive="#ff6a1e" emissiveIntensity={0} />
              </mesh>
              <group ref={flameRef} position={[0, MATCH_L + 0.09, 0]} visible={false}>
                <mesh geometry={flameGeo}>
                  <meshBasicMaterial
                    ref={flameMatRef} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
                  />
                </mesh>
                <mesh geometry={coreGeo} position={[0, -0.012, 0]}>
                  <meshBasicMaterial
                    ref={coreMatRef} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending}
                  />
                </mesh>
                <sprite ref={bloomRef} scale={0.3}>
                  <spriteMaterial
                    ref={bloomMatRef} map={glowTex} color="#ff9838" transparent opacity={0}
                    depthWrite={false} blending={THREE.AdditiveBlending}
                  />
                </sprite>
              </group>
              {/* the one warm light in the scene, and it is inside the world it lights */}
              <pointLight ref={lightRef} position={[0, MATCH_L + 0.1, 0]} intensity={0} color="#ff9a3c" decay={2} />
            </group>

            {/* grit, thrown off the strip */}
            <points ref={sparkRef} frustumCulled={false}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[sparkBuf.pos, 3]} />
                <bufferAttribute attach="attributes-color" args={[sparkBuf.col, 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={sparkTex} vertexColors size={0.038} sizeAttenuation transparent
                depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false}
              />
            </points>
            <sprite ref={scrapeRef} scale={0.1} visible={false}>
              <spriteMaterial
                map={glowTex} ref={scrapeMatRef} color="#ffb85e" transparent opacity={0}
                depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </sprite>
            <sprite ref={hintRef} scale={0.4}>
              <spriteMaterial
                map={glowTex} ref={hintMatRef} color="#cfe0ff" transparent opacity={0}
                depthWrite={false} blending={THREE.AdditiveBlending}
              />
            </sprite>

            {/* three r185 raycasts straight through `visible={false}` — an invisible
                hit target has to be a transparent one, or the swipe is eaten. */}
            {phase === "opening" && (
              <mesh position={[0.1, 0.3, 1.0]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={stop} onPointerCancel={stop} onPointerOut={stop}>
                <planeGeometry args={[3.2, 1.5]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            )}
          </group>
        </group>
      </group>
    </>
  );
}
