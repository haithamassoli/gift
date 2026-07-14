import { GiftPreviewCard } from "../components/GiftPreviewCard";
import { Logo } from "../components/Logo";
import { registry } from "../gifts/registry";
import { useLang, LangToggle } from "../i18n";

export default function Home() {
  const { lang, t } = useLang();
  return (
    <main
      dir={lang === "ar" ? "rtl" : "ltr"}
      lang={lang}
      className="mx-auto max-w-4xl px-6 py-16"
    >
      <div className="flex justify-end">
        <LangToggle />
      </div>
      <header className="mb-12 text-center">
        <Logo className="mx-auto h-16 w-16" />
        <h1 className="mt-4 font-serif text-6xl tracking-tight text-stone-100 sm:text-7xl">
          {t.home.title}
        </h1>
        <p className="mt-4 text-stone-400">{t.home.subtitle}</p>
      </header>

      <div className="grid grid-cols-1 gap-6 pb-16 sm:grid-cols-2">
        {Object.values(registry).map((def) => (
          <GiftPreviewCard key={def.id} def={def} lang={lang} />
        ))}
      </div>
    </main>
  );
}
