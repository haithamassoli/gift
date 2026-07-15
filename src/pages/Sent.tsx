import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import Loading from "../components/Loading";
import { useLang } from "../i18n";
import NotFound from "./NotFound";

const canShare = "share" in navigator;

export default function Sent() {
  const { statusKey } = useParams();
  const status = useQuery(
    api.gifts.getStatus,
    statusKey ? { statusKey } : "skip",
  );
  const { lang, t } = useLang();
  const [copied, setCopied] = useState(false);
  const [now] = useState(() => Date.now());

  if (status === undefined) {
    return <Loading />;
  }

  if (status === null) {
    return (
      <NotFound heading={t.sent.notFoundHeading} copy={t.sent.notFoundCopy} />
    );
  }

  const shareUrl = `${window.location.origin}/g/${status.slug}`;

  const copy = () => {
    void navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main
      dir={lang === "ar" ? "rtl" : "ltr"}
      lang={lang}
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16"
    >
      <header className="text-center">
        <h1 className="font-serif text-4xl text-stone-100">{t.sent.ready}</h1>
        <p className="mt-3 text-stone-400">{t.sent.shareHint}</p>
      </header>

      <div className="flex flex-col gap-4">
        <div
          dir="ltr"
          className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-stone-200"
        >
          {shareUrl}
        </div>

        {canShare ? (
          <button
            type="button"
            onClick={() =>
              void navigator
                .share({ url: shareUrl, text: t.sent.shareText })
                .catch(() => {})
            }
            className="min-h-[48px] rounded-full bg-rose-500 px-6 font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            {t.sent.share}
          </button>
        ) : null}

        <button
          type="button"
          onClick={copy}
          className={
            canShare
              ? "min-h-[48px] rounded-full border border-white/15 px-6 font-medium text-stone-300 transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              : "min-h-[48px] rounded-full bg-rose-500 px-6 font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          }
        >
          {copied ? t.sent.copied : t.sent.copy}
        </button>

        <a
          href={shareUrl}
          target="_blank"
          rel="noreferrer"
          className="text-center text-sm text-stone-400 underline-offset-4 transition hover:text-stone-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          {t.sent.preview}
        </a>
      </div>

      <div className="text-center">
        {status.openedAt ? (
          <p>
            <span className="text-emerald-400">{t.sent.opened}</span>
            <span className="mt-1 block text-xs text-stone-500">
              {new Date(status.openedAt).toLocaleString()}
            </span>
          </p>
        ) : (
          <>
            <p className="text-sm text-stone-500">{t.sent.notOpened}</p>
            {status.openAfter != null && status.openAfter > now ? (
              <p className="mt-1 text-xs text-stone-500">
                {t.gift.opensOn(
                  new Date(status.openAfter).toLocaleString(lang, {
                    dateStyle: "full",
                    timeStyle: "short",
                  }),
                )}
              </p>
            ) : null}
          </>
        )}
      </div>

      <Link
        to="/"
        className="text-center text-sm text-stone-400 underline-offset-4 transition hover:text-stone-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {t.sent.another}
      </Link>
    </main>
  );
}
