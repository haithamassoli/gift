import { Link } from "react-router";
import { Logo } from "../components/Logo";
import { useLang } from "../i18n";

export default function NotFound({
  heading,
  copy,
}: {
  heading?: string;
  copy?: string;
}) {
  const { lang, t } = useLang();
  return (
    <main
      dir={lang === "ar" ? "rtl" : "ltr"}
      lang={lang}
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <Logo className="h-24 w-24" />
      <h1 className="font-serif text-3xl text-stone-100">
        {heading ?? t.notFound.heading}
      </h1>
      <p className="text-stone-400">{copy ?? t.notFound.copy}</p>
      <Link
        to="/"
        className="inline-flex min-h-[48px] items-center rounded-full bg-rose-500 px-6 font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
      >
        {t.notFound.browse}
      </Link>
    </main>
  );
}
