import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import Loading from "../components/Loading";
import { useLang } from "../i18n";
import NotFound from "./NotFound";

export default function Sent() {
  const { statusKey } = useParams();
  const status = useQuery(
    api.gifts.getStatus,
    statusKey ? { statusKey } : "skip",
  );
  const { lang, t } = useLang();
  const [copied, setCopied] = useState(false);

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

        <button
          type="button"
          onClick={copy}
          className="min-h-[48px] rounded-full bg-rose-500 px-6 font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
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
          <p className="text-sm text-stone-500">{t.sent.notOpened}</p>
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
