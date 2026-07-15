import { lazy } from "react";
import { catalog } from "./catalog";
import type { GiftDef } from "./types";

// One lazy() entry per gift keeps each scene in its own code-split chunk.
const scenes = {
  "eternal-rose": lazy(() => import("./eternal-rose/Scene")),
  moonflower: lazy(() => import("./moonflower/Scene")),
  fireworks: lazy(() => import("./fireworks/Scene")),
  "snow-globe": lazy(() => import("./snow-globe/Scene")),
  "birthday-cake": lazy(() => import("./birthday-cake/Scene")),
  constellation: lazy(() => import("./constellation/Scene")),
  "butterfly-jar": lazy(() => import("./butterfly-jar/Scene")),
  "lantern-sky": lazy(() => import("./lantern-sky/Scene")),
  "balloon-bunch": lazy(() => import("./balloon-bunch/Scene")),
  "message-bottle": lazy(() => import("./message-bottle/Scene")),
  "music-box": lazy(() => import("./music-box/Scene")),
  "golden-locket": lazy(() => import("./golden-locket/Scene")),
  "shooting-gallery": lazy(() => import("./shooting-gallery/Scene")),
  "magic-lamp": lazy(() => import("./magic-lamp/Scene")),
  "foggy-mirror": lazy(() => import("./foggy-mirror/Scene")),
  astrolabe: lazy(() => import("./astrolabe/Scene")),
  "scratch-card": lazy(() => import("./scratch-card/Scene")),
  "claw-machine": lazy(() => import("./claw-machine/Scene")),
  pinata: lazy(() => import("./pinata/Scene")),
  mixtape: lazy(() => import("./mixtape/Scene")),
  matchbox: lazy(() => import("./matchbox/Scene")),
  "koi-pond": lazy(() => import("./koi-pond/Scene")),
  "cup-reading": lazy(() => import("./cup-reading/Scene")),
  aurora: lazy(() => import("./aurora/Scene")),
} as const;

export const registry: Record<string, GiftDef> = Object.fromEntries(
  Object.entries(scenes).map(([id, Scene]) => [id, { ...catalog[id], Scene }]),
);
