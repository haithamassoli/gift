import { useEffect, useRef } from "react";
import type { GiftPhase } from "./types";

/**
 * Shared opening-timeline plumbing for gift scenes: a clock that resets when
 * the phase flips to "opening", plus a once-only completion latch.
 *
 * In useFrame:
 *   if (phase === "opening") t.current += Math.min(delta, 0.05);
 *   ...
 *   if (phase === "opening" && t.current > END && !done.current) {
 *     done.current = true; onOpenComplete?.();
 *   }
 */
export function useOpeningClock(phase: GiftPhase) {
  const t = useRef(0);
  const done = useRef(false);
  useEffect(() => {
    if (phase === "opening") {
      t.current = 0;
      done.current = false;
    }
  }, [phase]);
  return { t, done };
}
