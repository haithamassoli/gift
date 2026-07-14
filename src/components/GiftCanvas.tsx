import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

// Shared visibility store: one "visibilitychange" listener fans out to every
// canvas, instead of each gallery canvas registering its own.
const visSubscribers = new Set<() => void>();
document.addEventListener("visibilitychange", () =>
  visSubscribers.forEach((fn) => fn()),
);
function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      visSubscribers.add(onChange);
      return () => {
        visSubscribers.delete(onChange);
      };
    },
    () => document.hidden,
  );
}

// Reduced motion: run a short burst of frames so the scene settles into its
// static pose (scenes apply phase transforms in useFrame), then stop the loop.
function SettleAndStop() {
  const invalidate = useThree((s) => s.invalidate);
  const count = useRef(0);
  useFrame(() => {
    if (count.current < 40) {
      count.current += 1;
      invalidate();
    }
  });
  return null;
}

// Shared canvas: DPR capped at 2, transparent background, sane mobile defaults.
// Rendering pauses when the tab is hidden or the canvas is scrolled offscreen,
// and freezes to a static frame under prefers-reduced-motion.
// Each gift scene sets its own camera via drei's <PerspectiveCamera makeDefault>.
export function GiftCanvas({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);
  const hidden = useDocumentHidden();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: "50px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const frameloop = hidden || !inView ? "never" : reduced ? "demand" : "always";

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%" }}>
      <Canvas
        dpr={[1, 2]}
        frameloop={frameloop}
        // At DPR 2 the density already smooths edges — skip MSAA there (mobile fill-rate).
        gl={{
          antialias: window.devicePixelRatio < 2,
          alpha: true,
          powerPreference: "high-performance",
        }}
        style={{ touchAction: "manipulation" }}
      >
        <Suspense fallback={null}>{children}</Suspense>
        {reduced && <SettleAndStop />}
      </Canvas>
    </div>
  );
}
