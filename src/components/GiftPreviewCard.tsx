import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { GiftCanvas } from "./GiftCanvas";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import type { GiftDef, GiftPhase } from "../gifts/types";
import { pick, defaultVariants } from "../gifts/catalog";
import { useArabicFontReady } from "../gifts/useArabicFontReady";
import { SAMPLE } from "../gifts/sample";
import type { Lang } from "../i18n";

// Mounts a live scene only while the element is scrolled into view, so an
// offscreen card frees its WebGL context instead of burning a draw loop.
function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.15, rootMargin: "0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, inView] as const;
}

// lang here is a live toggle (not an immutable gift record), and
// useArabicFontReady seeds `ready` once at mount — so key this on lang to get a
// fresh gate that actually loads Thmanyah before the scene's one-time raster.
// Mirrors the dev harness FontGate.
function FontGate({ lang, children }: { lang: Lang; children: ReactNode }) {
  const fontReady = useArabicFontReady(lang === "ar");
  return lang === "en" || fontReady ? children : null;
}

// How long a card holds on the fully revealed pose before it replays.
const REVEAL_HOLD_MS = 2500;

export function GiftPreviewCard({ def, lang }: { def: GiftDef; lang: Lang }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<GiftPhase>("sealed");
  const hasOpened = useRef(false);

  // First option value for each variant key — a neutral default.
  const variants = defaultVariants(def);
  // Dummy copy so text-bearing scenes reveal something real (not empty).
  const content = SAMPLE[lang];

  // Kick off the reveal the first time the card scrolls into view.
  // Reduced motion skips straight to the settled revealed pose (no loop).
  // ponytail: fires per card on scroll-in, no stagger/cap — only in-view cards
  // hold a canvas (below) and DPR is capped, so a few concurrent opens are fine.
  useEffect(() => {
    if (!inView || hasOpened.current) return;
    hasOpened.current = true;
    setPhase(reduced ? "revealed" : "opening");
  }, [inView, reduced]);

  // Loop: hold on the revealed pose, then replay. revealed -> opening is the
  // harness replay path (it resets the scene's opening clock). Pauses when the
  // card scrolls out of view; reduced motion opts out entirely.
  useEffect(() => {
    if (reduced || phase !== "revealed" || !inView) return;
    const id = setTimeout(() => setPhase("opening"), REVEAL_HOLD_MS);
    return () => clearTimeout(id);
  }, [reduced, phase, inView]);

  return (
    <Link
      href={`/create/${def.id}`}
      className="group block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#100b14]"
    >
      <div
        ref={ref}
        className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent transition duration-300 group-hover:border-white/20 group-hover:brightness-110"
      >
        {inView && (
          <div className="absolute inset-0">
            <GiftCanvas>
              <FontGate key={lang} lang={lang}>
                <def.Scene
                  variants={variants}
                  phase={phase}
                  senderName={content.senderName}
                  recipientName={content.recipientName}
                  message={content.message}
                  lang={lang}
                  onOpenComplete={() => setPhase("revealed")}
                />
              </FontGate>
            </GiftCanvas>
          </div>
        )}
      </div>

      <h2 className="mt-4 font-serif text-xl text-stone-100">
        {pick(lang, def.name, def.nameAr)}
      </h2>
      <p className="mt-1 text-sm text-stone-400">
        {pick(lang, def.tagline, def.taglineAr)}
      </p>
    </Link>
  );
}
