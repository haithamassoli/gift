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
// Module also evaluates during Next.js SSR — the app tree itself only renders client-side.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () =>
    visSubscribers.forEach((fn) => fn()),
  );
}
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
//
// The budget has to be spent per *phase*, not once per mount. The recipient
// always arrives on `sealed` and taps unwrap, which under reduced motion jumps
// straight to `revealed` — so a mount-only burst is entirely used up by the
// sealed pose, and the reveal gets the single frame React's commit invalidates.
// Scenes converge on a pose (`lerp(x, target, dt * k)`) rather than assigning
// it, so one frame lands them a few percent in: pet-rock stopped with the lid
// shut, the camera un-pulled and the message still face-down on the rock.
// So the burst re-arms off `children`: its identity changes exactly when the
// tree above re-rendered, which is what a phase flip is. It has to arrive as a
// *prop* — React Compiler caches the `<SettleAndStop />` element, so a bare
// re-render never reaches the component and an effect with no dep array never
// fires again (measured: 120 frames on mount, 1 on the phase change).
//
// 120 frames ≈ 2s of wall clock, which is what the slowest lerp in the catalog
// (`dt * 3`) needs to land inside a percent of its target; 40 left it at 86%.
const SETTLE_FRAMES = 120;

function SettleAndStop({ trigger }: { trigger: ReactNode }) {
  const invalidate = useThree((s) => s.invalidate);
  const count = useRef(0);
  useEffect(() => {
    count.current = 0;
    invalidate(); // the re-arm needs one frame to start the chain off
  }, [trigger, invalidate]);
  useFrame(() => {
    if (count.current < SETTLE_FRAMES) {
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
        {reduced && <SettleAndStop trigger={children} />}
      </Canvas>
    </div>
  );
}
