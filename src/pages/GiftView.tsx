import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { GiftCanvas } from "../components/GiftCanvas";
import { usePrefersReducedMotion } from "../components/usePrefersReducedMotion";
import { registry } from "../gifts/registry";
import { useArabicFontReady } from "../gifts/useArabicFontReady";
import { strings, type Lang } from "../i18n";
import Loading from "../components/Loading";
import NotFound from "./NotFound";

type Phase = "sealed" | "opening" | "revealed";

// Extension-based image detection for the gated payload. ponytail: misses
// extensionless image CDN URLs; give the sender an explicit type picker if that
// case matters. Hoisted out of render (js-hoist-regexp).
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;

// Largest-unit relative countdown ("in 3 days" … "in 45 seconds"), fully localized.
function formatCountdown(ms: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always" });
  if (s < 60) return rtf.format(s, "second");
  if (s < 3600) return rtf.format(Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(Math.floor(s / 3600), "hour");
  return rtf.format(Math.floor(s / 86400), "day");
}

// Ticks once a second in isolation so the countdown re-renders without touching
// the canvas; calls onUnlock (idempotent) the moment the clock reaches openAfter.
function LockedSeal({
  openAfter,
  lang,
  opensOnLabel,
  onUnlock,
}: {
  openAfter: number;
  lang: Lang;
  opensOnLabel: (date: string) => string;
  onUnlock: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (Date.now() >= openAfter) {
      onUnlock();
      return;
    }
    const id = setInterval(() => {
      if (Date.now() >= openAfter) onUnlock();
      else setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [openAfter, onUnlock]);

  const dateLabel = useMemo(
    () =>
      new Date(openAfter).toLocaleString(lang, {
        dateStyle: "full",
        timeStyle: "short",
      }),
    [openAfter, lang],
  );

  return (
    <div className="mt-6 flex flex-col items-center gap-1">
      <p className="font-serif text-2xl tabular-nums text-stone-100 drop-shadow-[0_1px_8px_rgba(0,0,0,0.9)]">
        {formatCountdown(openAfter - now, lang)}
      </p>
      <p className="text-sm text-stone-400 drop-shadow-[0_1px_8px_rgba(0,0,0,0.9)]">
        {opensOnLabel(dateLabel)}
      </p>
    </div>
  );
}

// Mounts hidden, then flips to visible on the next frame so the block fades in.
// Replaying unmounts this block, so the fade replays cleanly on the next reveal.
function RevealedMessage({
  message,
  senderName,
  payload,
  openLinkLabel,
  photoAlt,
  replayLabel,
  sendBackLabel,
  onReplay,
}: {
  message: string;
  senderName: string;
  payload: string | null;
  openLinkLabel: string;
  photoAlt: string;
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
      {payload ? (
        IMAGE_RE.test(payload) ? (
          <img
            src={payload}
            alt={photoAlt}
            loading="lazy"
            className="mt-6 w-full rounded-2xl border border-white/10"
          />
        ) : (
          <a
            href={payload}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex min-h-[48px] items-center rounded-full bg-rose-500 px-6 text-sm font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            {openLinkLabel}
          </a>
        )
      ) : null}
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
  // Captured once at mount — deriving `locked` from a fresh Date.now() during
  // render is impure; the lock only ever flips locked→unlocked, so a mount
  // snapshot plus LockedSeal's own timer is enough.
  const [mountNow] = useState(() => Date.now());
  const [unlockedNow, setUnlockedNow] = useState(false);
  const unlock = useCallback(() => setUnlockedNow(true), []);
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

  // Presentational lock: sealed and un-unwrappable until the sender's chosen time.
  const locked =
    gift.openAfter != null && !unlockedNow && mountNow < gift.openAfter;

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
            {locked && gift.openAfter != null ? (
              <LockedSeal
                openAfter={gift.openAfter}
                lang={lang}
                opensOnLabel={t.gift.opensOn}
                onUnlock={unlock}
              />
            ) : (
              <button
                type="button"
                onClick={unwrap}
                className="pointer-events-auto mt-6 min-h-[52px] rounded-full bg-rose-500 px-8 text-lg font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              >
                {t.gift.unwrap}
              </button>
            )}
          </div>
        )}
      </div>

      {phase === "revealed" && (
        <RevealedMessage
          message={gift.message}
          senderName={gift.senderName}
          payload={gift.payload}
          openLinkLabel={t.gift.openLink}
          photoAlt={t.gift.photoAlt}
          replayLabel={t.gift.replay}
          sendBackLabel={t.gift.sendBack}
          onReplay={reducedMotion ? undefined : () => setPhase("opening")}
        />
      )}
    </div>
  );
}
