"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { GiftPreviewCard } from "@/components/GiftPreviewCard";
import { Logo } from "@/components/Logo";
import { SiteCredit } from "@/components/SiteCredit";
import { registry } from "@/gifts/registry";
import { occasions, occasionsById, pick, type Occasion } from "@/gifts/catalog";
import { clearSent, loadSent, type SentEntry } from "@/lib/sentHistory";
import { useLang, LangToggle } from "@/i18n";

export default function Home() {
  const { lang, t } = useLang();
  const [occasion, setOccasion] = useState<Occasion | null>(null);
  const [entries, setEntries] = useState<SentEntry[]>([]);

  // localStorage is client-only and the page is prerendered — read after mount,
  // not in a lazy initializer, so SSR/hydration render sees an empty list.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time external-store read on mount; runs once ([] deps), no cascading loop
    setEntries(loadSent());
  }, []);

  // One batch receipt query for the whole history → O(1) per-row status lookup.
  const statuses = useQuery(
    api.gifts.getStatuses,
    entries.length ? { statusKeys: entries.map((e) => e.statusKey) } : "skip",
  );
  const openedByKey = new Map<string, number | null>(
    (statuses ?? []).map((s) => [s.statusKey, s.openedAt]),
  );

  // Derived during render — no effect, no memo (React Compiler handles it).
  const gifts = Object.values(registry).filter(
    (def) => !occasion || occasionsById[def.id]?.includes(occasion),
  );
  const chips = [
    { key: null as Occasion | null, label: t.home.all },
    ...occasions.map((o) => ({ key: o.key as Occasion | null, label: pick(lang, o.label, o.labelAr) })),
  ];

  return (
    <main
      dir={lang === "ar" ? "rtl" : "ltr"}
      lang={lang}
      className="mx-auto max-w-4xl px-6 py-16"
    >
      <div className="flex justify-end">
        <LangToggle />
      </div>
      <header className="mb-8 text-center">
        <Logo className="mx-auto h-16 w-16" />
        <h1 className="mt-4 font-serif text-6xl tracking-tight text-stone-100 sm:text-7xl">
          {t.home.title}
        </h1>
        <p className="mt-4 text-stone-400">{t.home.subtitle}</p>
        <SiteCredit className="mt-3" />
      </header>

      <div
        role="group"
        aria-label={t.home.filterLabel}
        className="mb-10 flex flex-wrap justify-center gap-2"
      >
        {chips.map((chip) => {
          const selected = occasion === chip.key;
          return (
            <button
              key={chip.key ?? "all"}
              type="button"
              aria-pressed={selected}
              onClick={() => setOccasion(chip.key)}
              className={`rounded-full px-4 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
                selected
                  ? "bg-rose-500 text-white"
                  : "border border-white/15 text-stone-300 hover:border-white/30"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 pb-16 sm:grid-cols-2">
        {gifts.map((def) => (
          <GiftPreviewCard key={def.id} def={def} lang={lang} />
        ))}
      </div>

      {entries.length ? (
        <section>
          <h2 className="mb-4 font-serif text-2xl text-stone-100">
            {t.home.sentHeading}
          </h2>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => {
              const def = registry[entry.giftType];
              const name = def
                ? pick(lang, def.name, def.nameAr)
                : entry.giftType;
              const openedAt = openedByKey.get(entry.statusKey);
              return (
                <Link
                  key={entry.statusKey}
                  href={`/sent/${entry.statusKey}`}
                  className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-stone-200">{name}</span>
                    <span className="mt-0.5 block truncate text-xs text-stone-500">
                      {/* bdi: a Latin name inside the RTL line otherwise captures
                          the date's leading digits and garbles the row. */}
                      <bdi>{entry.recipientName}</bdi> ·{" "}
                      {new Date(entry.createdAt).toLocaleDateString(lang, {
                        dateStyle: "medium",
                      })}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-sm ${
                      openedAt ? "text-emerald-400" : "text-stone-500"
                    }`}
                  >
                    {openedAt ? t.sent.opened : t.sent.notOpened}
                  </span>
                </Link>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              clearSent();
              setEntries([]);
            }}
            className="mt-4 text-xs text-stone-500 underline-offset-4 transition hover:text-stone-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            {t.home.sentClear}
          </button>
        </section>
      ) : null}
    </main>
  );
}
