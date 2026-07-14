import type { CSSProperties } from "react";
import { Logo } from "./Logo";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useLang } from "../i18n";

// Every gift in the catalog is a small light in the dark — aurora, constellation,
// lantern-sky, fireworks. So waiting is those lights gathering: motes drift in and
// the mark absorbs them. Hand-placed on a loose ring rather than randomized, so the
// inflow stays balanced from every side; the delays stagger into one steady stream.
const MOTES = [
  { x: -124, y: -78, size: 4 },
  { x: 108, y: -98, size: 3 },
  { x: 142, y: 49, size: 4 },
  { x: -100, y: 93, size: 3 },
  { x: 10, y: -134, size: 3 },
  { x: -152, y: 8, size: 3 },
  { x: 59, y: 124, size: 4 },
  { x: -44, y: -118, size: 3 },
];

export default function Loading() {
  const reducedMotion = usePrefersReducedMotion();
  const { t } = useLang();

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="relative" role="status">
        {/* A radial gradient, not a blurred disc: a blurred disc keeps a flat plateau
            at its centre and reads as fog. This falls off smoothly, so the mark looks lit. */}
        <div
          className={`absolute top-1/2 left-1/2 -mt-32 -ml-32 h-64 w-64 rounded-full ${
            reducedMotion ? "animate-pulse" : "animate-halo-breathe"
          }`}
          style={{
            background:
              "radial-gradient(circle, rgba(251,113,133,0.40), rgba(225,29,72,0.10) 42%, transparent 68%)",
          }}
        />
        {/* Reduced motion keeps the halo's opacity breathe (still reads as "working")
            and drops everything that travels. */}
        {!reducedMotion &&
          MOTES.map((mote, i) => (
            <span
              key={i}
              className="animate-mote-gather absolute top-1/2 left-1/2 rounded-full bg-[#ffdfa3] shadow-[0_0_10px_3px_rgba(255,223,163,0.6)]"
              style={
                {
                  width: mote.size,
                  height: mote.size,
                  marginLeft: -mote.size / 2,
                  marginTop: -mote.size / 2,
                  "--mx": `${mote.x}px`,
                  "--my": `${mote.y}px`,
                  animationDelay: `${i * 0.65}s`,
                } as CSSProperties
              }
            />
          ))}
        <Logo
          className={`relative h-24 w-24 ${reducedMotion ? "" : "animate-mark-float"}`}
        />
        <span className="sr-only">{t.common.loading}</span>
      </div>
    </main>
  );
}
