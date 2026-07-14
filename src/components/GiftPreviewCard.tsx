import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { GiftCanvas } from "./GiftCanvas";
import type { GiftDef } from "../gifts/types";
import { pick, defaultVariants } from "../gifts/catalog";
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

export function GiftPreviewCard({ def, lang }: { def: GiftDef; lang: Lang }) {
  const [ref, inView] = useInView<HTMLDivElement>();

  // First option value for each variant key — a neutral default preview.
  const variants = defaultVariants(def);

  return (
    <Link
      to={`/create/${def.id}`}
      className="group block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#100b14]"
    >
      <div
        ref={ref}
        className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent transition duration-300 group-hover:border-white/20 group-hover:brightness-110"
      >
        {inView && (
          <div className="absolute inset-0">
            <GiftCanvas>
              <def.Scene
                variants={variants}
                phase="preview"
                senderName={pick(lang, "You", "أنت")}
                recipientName={pick(lang, "Someone", "شخص ما")}
                message=""
                lang={lang}
              />
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
