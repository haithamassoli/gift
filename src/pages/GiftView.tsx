import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { GiftCanvas } from "../components/GiftCanvas";
import { usePrefersReducedMotion } from "../components/usePrefersReducedMotion";
import { registry } from "../gifts/registry";
import { useArabicFontReady } from "../gifts/useArabicFontReady";
import { strings } from "../i18n";
import Loading from "../components/Loading";
import NotFound from "./NotFound";

type Phase = "sealed" | "opening" | "revealed";

// Mounts hidden, then flips to visible on the next frame so the block fades in.
// Replaying unmounts this block, so the fade replays cleanly on the next reveal.
function RevealedMessage({
  message,
  senderName,
  replayLabel,
  sendBackLabel,
  onReplay,
}: {
  message: string;
  senderName: string;
  replayLabel: string;
  sendBackLabel: string;
  onReplay?: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={`mx-auto w-full max-w-md px-6 py-10 transition-all duration-700 ease-out ${
        shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <p className="whitespace-pre-wrap select-text text-lg leading-relaxed text-stone-200">
        {message}
      </p>
      <p className="mt-4 text-stone-400">— {senderName}</p>
      {onReplay && (
        <button
          type="button"
          onClick={onReplay}
          className="mt-8 min-h-[48px] rounded-full border border-white/15 px-6 text-sm text-stone-300 transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          {replayLabel}
        </button>
      )}
      <Link
        to="/"
        className="mt-6 block text-sm text-stone-500 underline-offset-4 transition hover:text-stone-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {sendBackLabel}
      </Link>
    </div>
  );
}

export default function GiftView() {
  const { slug } = useParams();
  const gift = useQuery(api.gifts.getGift, slug ? { slug } : "skip");
  const markOpened = useMutation(api.gifts.markOpened);
  const [phase, setPhase] = useState<Phase>("sealed");
  const reducedMotion = usePrefersReducedMotion();
  // The recipient always sees the gift in the language the sender chose, not
  // their own toggle. Default to "en" until the gift loads (keeps hook order stable).
  const lang = gift?.lang ?? "en";
  const fontReady = useArabicFontReady(lang === "ar");

  if (gift === undefined) {
    return <Loading />;
  }

  if (gift === null) {
    return <NotFound />;
  }

  const t = strings[lang];
  const rtl = lang === "ar";
  const def = registry[gift.giftType];

  if (!def) {
    return (
      <main
        dir={rtl ? "rtl" : "ltr"}
        lang={lang}
        className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 py-16 text-center"
      >
        <h1 className="font-serif text-3xl text-stone-100">
          {t.gift.forName(gift.recipientName)}
        </h1>
        <p className="whitespace-pre-wrap select-text text-lg leading-relaxed text-stone-200">
          {gift.message}
        </p>
        <p className="text-stone-400">— {gift.senderName}</p>
      </main>
    );
  }

  const unwrap = () => {
    // Reduced motion: skip the opening animation, go straight to the reveal.
    setPhase(reducedMotion ? "revealed" : "opening");
    if (slug) void markOpened({ slug });
  };

  return (
    <div dir={rtl ? "rtl" : "ltr"} lang={lang} className="flex min-h-dvh flex-col">
      <div className="relative min-h-[60vh] flex-1">
        {/* R3F's wrapper uses height:100%, which needs a definite height — inset-0 gives it one. */}
        <div className="absolute inset-0">
        <GiftCanvas>
          {(lang === "en" || fontReady) && (
            <def.Scene
              variants={gift.variants}
              phase={phase}
              senderName={gift.senderName}
              recipientName={gift.recipientName}
              message={gift.message}
              lang={lang}
              onOpenComplete={() => setPhase("revealed")}
            />
          )}
        </GiftCanvas>
        </div>

        {phase === "sealed" && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-transparent to-[#100b14]/80 p-6 text-center">
            <h1 className="font-serif text-4xl text-stone-100 drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]">
              {t.gift.forName(gift.recipientName)}
            </h1>
            <p className="text-stone-300 drop-shadow-[0_1px_8px_rgba(0,0,0,0.9)]">
              {t.gift.fromName(gift.senderName)}
            </p>
            <button
              type="button"
              onClick={unwrap}
              className="pointer-events-auto mt-6 min-h-[52px] rounded-full bg-rose-500 px-8 text-lg font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
            >
              {t.gift.unwrap}
            </button>
          </div>
        )}
      </div>

      {phase === "revealed" && (
        <RevealedMessage
          message={gift.message}
          senderName={gift.senderName}
          replayLabel={t.gift.replay}
          sendBackLabel={t.gift.sendBack}
          onReplay={reducedMotion ? undefined : () => setPhase("opening")}
        />
      )}
    </div>
  );
}
