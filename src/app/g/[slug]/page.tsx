"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { GiftCanvas } from "@/components/GiftCanvas";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { MESSAGE_MAX } from "@/gifts/catalog";
import { registry } from "@/gifts/registry";
import { useArabicFontReady } from "@/gifts/useArabicFontReady";
import { strings, type Lang } from "@/i18n";
import Loading from "@/components/Loading";
import NotFound from "@/components/NotFound";

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
// the canvas.
function LockedSeal({
  openAfter,
  lang,
  opensOnLabel,
}: {
  openAfter: number;
  lang: Lang;
  opensOnLabel: (date: string) => string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const dateLabel = new Date(openAfter).toLocaleString(lang, {
    dateStyle: "full",
    timeStyle: "short",
  });

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
  slug,
  message,
  senderName,
  voiceUrl,
  payload,
  photoUrl,
  reply,
  canReply,
  openLinkLabel,
  photoAlt,
  replyLabel,
  replyPlaceholder,
  replySendLabel,
  replySentLabel,
  replyErrorLabel,
  replayLabel,
  sendBackLabel,
  onReplay,
}: {
  slug: string;
  message: string;
  senderName: string;
  voiceUrl: string | null;
  payload: string | null;
  photoUrl: string | null;
  reply: string | null;
  canReply: boolean;
  openLinkLabel: string;
  photoAlt: string;
  replyLabel: string;
  replyPlaceholder: string;
  replySendLabel: string;
  replySentLabel: string;
  replyErrorLabel: string;
  replayLabel: string;
  sendBackLabel: string;
  onReplay?: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const sendReply = useMutation(api.gifts.sendReply);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // No local "sent" flag: on success Convex reactivity re-runs getGift and the
  // reply arrives back through props, swapping the form for the read-only state.
  const submitReply = async () => {
    setSubmitting(true);
    setSendFailed(false);
    try {
      await sendReply({ slug, reply: draft });
    } catch {
      setSendFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

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
      {voiceUrl ? (
        <audio controls src={voiceUrl} className="mt-6 w-full" />
      ) : null}
      {photoUrl ? (
        <img
          src={photoUrl}
          alt={photoAlt}
          loading="lazy"
          className="mt-6 w-full rounded-2xl border border-white/10"
        />
      ) : null}
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
      {canReply ? (
        reply ? (
          <div className="mt-8">
            <p className="text-sm text-stone-400">{replySentLabel}</p>
            <blockquote className="mt-2 whitespace-pre-wrap border-s-2 border-white/15 ps-4 text-stone-300">
              {reply}
            </blockquote>
          </div>
        ) : (
          <div className="mt-8">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-stone-300">
                {replyLabel}
              </span>
              <textarea
                value={draft}
                maxLength={MESSAGE_MAX}
                rows={3}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={replyPlaceholder}
                className="w-full resize-none rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-stone-100 placeholder:text-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              />
            </label>
            <button
              type="button"
              disabled={submitting || !draft.trim()}
              onClick={() => void submitReply()}
              className="mt-3 min-h-[48px] rounded-full border border-white/15 px-6 text-sm text-stone-300 transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {replySendLabel}
            </button>
            {sendFailed && (
              <p className="mt-2 text-sm text-rose-400">{replyErrorLabel}</p>
            )}
          </div>
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
        href="/"
        className="mt-6 block text-sm text-stone-500 underline-offset-4 transition hover:text-stone-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {sendBackLabel}
      </Link>
    </div>
  );
}

export default function GiftView() {
  const { slug } = useParams<{ slug?: string }>();
  const gift = useQuery(api.gifts.getGift, slug ? { slug } : "skip");
  const markOpened = useMutation(api.gifts.markOpened);
  const [phase, setPhase] = useState<Phase>("sealed");
  // Sender preview (?preview) must never trip the open receipt. Read once with a
  // lazy initializer — the preview link is always a full-page load, so this dodges
  // the useSearchParams Suspense requirement.
  const [isPreview] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("preview"),
  );
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

  // t comes from the gift's language (not the visitor's toggle) — the burned
  // state below must already speak it.
  const t = strings[lang];

  if (gift.burned) {
    return <NotFound heading={t.gift.burnedHeading} copy={t.gift.burnedCopy} />;
  }

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
          {gift.message ?? ""}
        </p>
        <p className="text-stone-400">— {gift.senderName}</p>
      </main>
    );
  }

  const unwrap = () => {
    // Reduced motion: skip the opening animation, go straight to the reveal.
    setPhase(reducedMotion ? "revealed" : "opening");
    // Preview still plays the animation but never marks the gift opened.
    if (slug && !isPreview) void markOpened({ slug });
  };

  // Presentational lock derived from server truth: sealed hides the message.
  const locked = gift.openAfter != null && gift.message === null;

  return (
    <div dir={rtl ? "rtl" : "ltr"} lang={lang} className="flex min-h-dvh flex-col">
      {/* Visible in every phase so the sender knows the receipt stays untripped. */}
      {isPreview && (
        <div className="pointer-events-none fixed top-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-black/40 px-4 py-1.5 text-xs text-stone-300 backdrop-blur">
          {t.gift.previewBadge}
        </div>
      )}
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
              message={gift.message ?? ""}
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
            {gift.burnsAfterOpen && (
              <p className="text-xs text-stone-400 drop-shadow-[0_1px_8px_rgba(0,0,0,0.9)]">
                {t.gift.burnHint}
              </p>
            )}
          </div>
        )}
      </div>

      {phase === "revealed" && (
        <RevealedMessage
          slug={slug ?? ""}
          message={gift.message ?? ""}
          senderName={gift.senderName}
          voiceUrl={gift.voiceUrl}
          payload={gift.payload}
          photoUrl={gift.photoUrl}
          reply={gift.reply}
          canReply={!isPreview}
          openLinkLabel={t.gift.openLink}
          photoAlt={t.gift.photoAlt}
          replyLabel={t.gift.replyLabel}
          replyPlaceholder={t.gift.replyPlaceholder}
          replySendLabel={t.gift.replySend}
          replySentLabel={t.gift.replySent}
          replyErrorLabel={t.create.error}
          replayLabel={t.gift.replay}
          sendBackLabel={t.gift.sendBack}
          onReplay={reducedMotion ? undefined : () => setPhase("opening")}
        />
      )}
    </div>
  );
}
