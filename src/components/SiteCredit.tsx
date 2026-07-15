import { useLang } from "../i18n";

const AUTHOR = "Haitham Assoli";
const AUTHOR_URL = "https://assoli.site";

// Owner attribution, shown in the Home header and the site-wide footer.
// Reads useLang() for the localized prefix and its own dir (the footer has no
// dir ancestor). The name/URL are proper nouns — not localized.
export function SiteCredit({ className = "" }: { className?: string }) {
  const { lang, t } = useLang();
  return (
    <p
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`text-sm text-stone-500 ${className}`}
    >
      {t.common.madeBy}{" "}
      <a
        href={AUTHOR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-stone-400 underline-offset-4 transition hover:text-stone-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {AUTHOR}
      </a>
    </p>
  );
}
