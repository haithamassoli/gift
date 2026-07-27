"use client";

import { useEffect, useMemo } from "react";
import { useMutation, useQueries } from "convex/react";
import { api } from "@convex/_generated/api";
import { useLang } from "@/i18n";

const VISITED_KEY = "gift.visited";
const HOUR = 60 * 60 * 1000;

// Live "people are here" counter for the Home header. The pulse dot signals the
// number is live — Convex is reactive, so others' visits update it in place.
export function VisitorCounter({ className = "" }: { className?: string }) {
  const { lang, t } = useLang();
  // useQueries, not useQuery: it hands back a backend error as a *value* instead
  // of throwing. A vanity counter must never take the whole Home page down with
  // it — an undeployed function or a blip should just hide the number.
  // The useMemo is load-bearing (React Compiler notwithstanding): useQueries
  // keys its subscription on this object's identity, so a fresh literal each
  // render would resubscribe on every render. useQuery memoizes it internally.
  const { count } = useQueries(
    useMemo(() => ({ count: { query: api.gifts.getVisitors, args: {} } }), []),
  );
  const bump = useMutation(api.gifts.bumpVisitors);

  // Count a visitor at most once an hour — refreshing within the window is free.
  // ponytail: localStorage dedup is client-trusted (clear it / open incognito to
  // recount). Fine for a vanity counter; gate server-side by IP/day if it ever
  // needs to be honest.
  useEffect(() => {
    const last = Number(localStorage.getItem(VISITED_KEY)) || 0;
    if (Date.now() - last < HOUR) return;
    void bump()
      .then(() => localStorage.setItem(VISITED_KEY, String(Date.now())))
      .catch(() => {});
  }, [bump]);

  // Wait for the count so we never flash a 0 or shift layout on load. Non-number
  // covers both states we render nothing for: undefined (loading) and Error.
  if (typeof count !== "number") return null;

  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      <span aria-hidden className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-rose-400/70 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
      </span>
      <span className="font-serif text-lg leading-none text-stone-200 tabular-nums">
        {count.toLocaleString(lang)}
      </span>
      <span className="text-[0.7rem] uppercase tracking-[0.15em] text-stone-500">
        {t.home.visitors(count)}
      </span>
    </div>
  );
}
