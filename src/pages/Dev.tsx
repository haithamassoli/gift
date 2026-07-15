// Dev-only scene harness. The gallery and /create only ever render
// phase="preview", so without this route the opening animations are
// unobservable in a browser. Drives phase / lang / variants by hand, with no
// Convex record behind it. main.tsx registers the route behind
// import.meta.env.DEV, so this module never reaches a production build.
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { GiftCanvas } from "../components/GiftCanvas";
import { defaultVariants, pick } from "../gifts/catalog";
import { registry } from "../gifts/registry";
import type { GiftDef, GiftPhase } from "../gifts/types";
import { useArabicFontReady } from "../gifts/useArabicFontReady";
import type { Lang } from "../i18n";

const PHASES: GiftPhase[] = ["preview", "sealed", "opening", "revealed"];
const LANGS: Lang[] = ["en", "ar"];

// Real copy, not lorem: the Arabic has to push actual shaping and rtl bidi
// through the same raster path a real gift takes.
const SAMPLE: Record<Lang, { senderName: string; recipientName: string; message: string }> = {
  en: {
    senderName: "Haitham",
    recipientName: "Layla",
    message:
      "Every year I go looking for words big enough for you, and every year I come back empty-handed. So here — take the whole sky instead.",
  },
  ar: {
    senderName: "هيثم",
    recipientName: "ليلى",
    message:
      "كل عام أبحث عن كلمات تليق بك، وكل عام أعود بلا شيء. فخذي هذه السماء كلها بدلًا منها.",
  },
};

const btn = (on: boolean) =>
  `min-h-[32px] rounded border px-2.5 text-xs transition disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
    on
      ? "border-rose-400 bg-rose-500 text-white"
      : "border-white/20 text-stone-300 hover:border-white/50"
  }`;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-stone-500">{label}</span>
      {children}
    </div>
  );
}

// GiftView reads lang off an immutable gift record; here it is a live control,
// and useArabicFontReady seeds `ready` once at mount — so flipping to ar under a
// live gate reports ready with no font loaded, and the scene's one-time raster
// lands in system-ui. The caller keys this on lang, so each lang gets a fresh
// gate that actually checks (and loads) Thmanyah before the scene mounts.
function FontGate({ lang, children }: { lang: Lang; children: ReactNode }) {
  const fontReady = useArabicFontReady(lang === "ar");
  return lang === "en" || fontReady ? children : null;
}

function Harness({ def }: { def: GiftDef }) {
  const [phase, setPhase] = useState<GiftPhase>("sealed");
  const [lang, setLang] = useState<Lang>("en");
  const [variants, setVariants] = useState(() => defaultVariants(def));

  // Mirror the two real call sites: the gallery card previews with placeholder
  // names and an empty message, GiftView carries the real gift from sealed on.
  const content =
    phase === "preview"
      ? {
          senderName: pick(lang, "You", "أنت"),
          recipientName: pick(lang, "Someone", "شخص ما"),
          message: "",
        }
      : SAMPLE[lang];

  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} className="flex min-h-dvh flex-col">
      <div className="relative min-h-[60vh] flex-1">
        {/* R3F's wrapper uses height:100%, which needs a definite height — inset-0 gives it one. */}
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
      </div>

      {/* The rig itself stays ltr so the controls don't mirror out from under you. */}
      <div dir="ltr" className="flex flex-col gap-2 border-t border-white/10 px-4 py-3">
        <Row label="phase">
          {PHASES.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={phase === p}
              onClick={() => setPhase(p)}
              className={btn(phase === p)}
            >
              {p}
            </button>
          ))}
          {/* The real replay path — revealed -> opening is what resets useOpeningClock. */}
          <button
            type="button"
            disabled={phase !== "revealed"}
            onClick={() => setPhase("opening")}
            className={btn(false)}
          >
            replay
          </button>
        </Row>

        <Row label="lang">
          {LANGS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={lang === l}
              onClick={() => setLang(l)}
              className={btn(lang === l)}
            >
              {l}
            </button>
          ))}
        </Row>

        {def.variants.map((v) => (
          <Row key={v.key} label={v.key}>
            {v.options.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={variants[v.key] === o.value}
                onClick={() => setVariants((prev) => ({ ...prev, [v.key]: o.value }))}
                className={btn(variants[v.key] === o.value)}
              >
                {o.value}
              </button>
            ))}
          </Row>
        ))}

        <p className="font-mono text-[10px] text-stone-600">
          {def.id} · preview mirrors the gallery card: placeholder names, empty message
        </p>
      </div>
    </div>
  );
}

export default function Dev() {
  const { giftType } = useParams();
  const def = giftType ? registry[giftType] : undefined;

  if (!def) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3 px-6 py-16">
        <h1 className="font-mono text-sm text-stone-400">
          {giftType ? `no scene registered for "${giftType}"` : "scene harness"}
        </h1>
        <ul className="flex flex-col gap-1">
          {Object.keys(registry).map((id) => (
            <li key={id}>
              <Link
                to={`/dev/${id}`}
                className="font-mono text-sm text-rose-400 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              >
                {id}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  // Remount per gift so variant/phase state never leaks across scenes.
  return <Harness key={def.id} def={def} />;
}
