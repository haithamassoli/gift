import type { FC } from "react";
import type { GiftCatalogEntry } from "./catalog";
import type { Lang } from "../i18n";

export type GiftPhase = "preview" | "sealed" | "opening" | "revealed";

export interface SceneProps {
  variants: Record<string, string>;
  phase: GiftPhase;
  senderName: string;
  recipientName: string;
  message: string;
  lang: Lang;
  onOpenComplete?: () => void;
}

export interface GiftDef extends GiftCatalogEntry {
  Scene: FC<SceneProps>;
}
