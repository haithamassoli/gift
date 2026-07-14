import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { GiftCanvas } from "../components/GiftCanvas";
import { registry } from "../gifts/registry";
import { MESSAGE_MAX, NAME_MAX, pick, defaultVariants } from "../gifts/catalog";
import { useArabicFontReady } from "../gifts/useArabicFontReady";
import { useLang, LangToggle } from "../i18n";
import NotFound from "./NotFound";

const inputClass =
  "w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-stone-100 placeholder:text-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400";

export default function Create() {
  const { giftType } = useParams();
  const def = giftType ? registry[giftType] : undefined;
  const createGift = useMutation(api.gifts.createGift);
  const navigate = useNavigate();
  const { lang, t } = useLang();
  const rtl = lang === "ar";
  // Gate the Arabic preview until Thmanyah loads so the one-time raster is branded.
  const fontReady = useArabicFontReady(lang === "ar");

  const [variants, setVariants] = useState<Record<string, string>>(() =>
    def ? defaultVariants(def) : {},
  );
  const [senderName, setSenderName] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!def) {
    return <NotFound heading={t.create.unknownHeading} copy={t.create.unknownCopy} />;
  }

  const canSubmit =
    !submitting && senderName.trim().length > 0 && recipientName.trim().length > 0;

  const handleCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { statusKey } = await createGift({
        giftType: def.id,
        senderName: senderName.trim(),
        recipientName: recipientName.trim(),
        message: message.trim(),
        variants,
        lang,
      });
      navigate(`/sent/${statusKey}`);
    } catch {
      setError(t.create.error);
      setSubmitting(false);
    }
  };

  return (
    <main
      dir={rtl ? "rtl" : "ltr"}
      lang={lang}
      className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 px-6 py-8"
    >
      <div className="flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex w-fit items-center text-sm text-stone-400 underline-offset-4 transition hover:text-stone-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          {t.create.back}
        </Link>
        <LangToggle />
      </div>

      <div className="relative h-[55vh] overflow-hidden rounded-3xl border border-white/10">
        <span className="pointer-events-none absolute start-4 top-4 z-10 text-xs uppercase tracking-wide text-stone-500">
          {t.create.livePreview}
        </span>
        <GiftCanvas>
          {(lang === "en" || fontReady) && (
            <def.Scene
              variants={variants}
              phase="preview"
              senderName={senderName}
              recipientName={recipientName}
              message={message}
              lang={lang}
            />
          )}
        </GiftCanvas>
      </div>

      <div>
        <h1 className="font-serif text-3xl text-stone-100">
          {pick(lang, def.name, def.nameAr)}
        </h1>
        <p className="mt-1 text-sm text-stone-400">
          {pick(lang, def.tagline, def.taglineAr)}
        </p>
      </div>

      {def.variants.map((variant) => (
        <div key={variant.key}>
          <p className="mb-2 text-sm font-medium text-stone-300">
            {pick(lang, variant.label, variant.labelAr)}
          </p>
          {variant.options.length > 6 ? (
            <select
              value={variants[variant.key]}
              onChange={(e) =>
                setVariants((prev) => ({ ...prev, [variant.key]: e.target.value }))
              }
              className={`${inputClass} appearance-none`}
            >
              {variant.options.map((option) => (
                <option key={option.value} value={option.value} className="bg-[#100b14]">
                  {pick(lang, option.label, option.labelAr)}
                </option>
              ))}
            </select>
          ) : (
          <div className="flex flex-wrap gap-2">
            {variant.options.map((option) => {
              const selected = variants[variant.key] === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setVariants((prev) => ({ ...prev, [variant.key]: option.value }))
                  }
                  className={`rounded-full px-4 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
                    selected
                      ? "bg-rose-500 text-white"
                      : "border border-white/15 text-stone-300 hover:border-white/30"
                  }`}
                >
                  {pick(lang, option.label, option.labelAr)}
                </button>
              );
            })}
          </div>
          )}
        </div>
      ))}

      <label className="block">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-stone-300">{t.create.yourName}</span>
          <span className="text-xs text-stone-500">
            {senderName.length}/{NAME_MAX}
          </span>
        </div>
        <input
          type="text"
          value={senderName}
          maxLength={NAME_MAX}
          onChange={(e) => setSenderName(e.target.value)}
          placeholder={t.create.fromPlaceholder}
          className={inputClass}
        />
      </label>

      <label className="block">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-stone-300">{t.create.theirName}</span>
          <span className="text-xs text-stone-500">
            {recipientName.length}/{NAME_MAX}
          </span>
        </div>
        <input
          type="text"
          value={recipientName}
          maxLength={NAME_MAX}
          onChange={(e) => setRecipientName(e.target.value)}
          placeholder={t.create.toPlaceholder}
          className={inputClass}
        />
      </label>

      <label className="block">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-stone-300">{t.create.message}</span>
          <span className="text-xs text-stone-500">
            {message.length}/{MESSAGE_MAX}
          </span>
        </div>
        <textarea
          value={message}
          maxLength={MESSAGE_MAX}
          rows={4}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t.create.messagePlaceholder}
          className={`${inputClass} resize-none`}
        />
      </label>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void handleCreate()}
        className="min-h-[52px] w-full rounded-full bg-rose-500 text-lg font-medium text-white transition hover:bg-rose-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? t.create.creating : t.create.submit}
      </button>
    </main>
  );
}
