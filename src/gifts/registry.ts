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
  aurora: lazy(() => import("./aurora/Scene")),
} as const;

export const registry: Record<string, GiftDef> = Object.fromEntries(
  Object.entries(scenes).map(([id, Scene]) => [id, { ...catalog[id], Scene }]),
);
