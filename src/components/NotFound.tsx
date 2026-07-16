"use client";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Logo } from "./Logo";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { useLang } from "../i18n";

// The loading screen gathers motes into the mark; here — where there is no gift to
// unwrap — that gather runs in reverse: the light leaves the mark and disperses.
// Hand-placed on a loose ring (balanced from every side) so the outflow stays even;
// the delays stagger it into one slow, continuous drift.
const MOTES = [
  { x: 0, y: -134, size: 4 },
  { x: 120, y: -66, size: 3 },
  { x: 132, y: 60, size: 4 },
  { x: -20, y: 138, size: 3 },
  { x: -130, y: 52, size: 4 },
  { x: -116, y: -74, size: 3 },
];

export default function NotFound({
  heading,
  copy,
}: {
  heading?: string;
  copy?: string;
}) {
  const { lang, t } = useLang();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <main
      dir={lang === "ar" ? "rtl" : "ltr"}
      lang={lang}
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <div className="relative">
        {/* Colorless, dim glow — the loading screen's warm rose halo, drained. A radial
            gradient (not a blurred disc) so it falls off smoothly and reads as light. */}
        <div
          className={`absolute top-1/2 left-1/2 -mt-28 -ml-28 h-56 w-56 rounded-full ${
            reducedMotion ? "animate-pulse" : "animate-halo-breathe"
          }`}
          style={{
            background:
              "radial-gradient(circle, rgba(231,229,228,0.18), rgba(231,229,228,0.04) 48%, transparent 72%)",
          }}
        />
        {/* The motes travel, so reduced motion drops them entirely (matching Loading). */}
        {!reducedMotion &&
          MOTES.map((mote, i) => (
            <span
              key={i}
              className="animate-mote-drift absolute top-1/2 left-1/2 rounded-full bg-stone-300 shadow-[0_0_8px_2px_rgba(214,211,209,0.3)]"
              style={
                {
                  width: mote.size,
                  height: mote.size,
                  marginLeft: -mote.size / 2,
                  marginTop: -mote.size / 2,
                  "--mx": `${mote.x}px`,
                  "--my": `${mote.y}px`,
                  animationDelay: `${i * 0.9}s`,
                } as CSSProperties
              }
            />
          ))}
        {/* The mark, still and drained of its warmth — the empty box. */}
        <Logo className="relative h-24 w-24 opacity-75 grayscale-[.45] brightness-90" />
      </div>

      <h1 className="font-serif text-3xl text-stone-100">
        {heading ?? t.notFound.heading}
      </h1>
      <p className="max-w-sm text-balance text-stone-400">
        {copy ?? t.notFound.copy}
      </p>
      <Link
        href="/"
        className="inline-flex min-h-[48px] items-center rounded-full bg-rose-500 px-6 font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {t.notFound.browse}
      </Link>
    </main>
  );
}
