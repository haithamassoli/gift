import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { GiftCanvas } from "../components/GiftCanvas";
import { VoiceRecorder } from "../components/VoiceRecorder";
import { registry } from "../gifts/registry";
import { MESSAGE_MAX, NAME_MAX, PAYLOAD_MAX, pick, defaultVariants } from "../gifts/catalog";
import { useArabicFontReady } from "../gifts/useArabicFontReady";
import { useLang, LangToggle } from "../i18n";
import NotFound from "./NotFound";

const inputClass =
  "w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-stone-100 placeholder:text-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400";

// Format a Date as a `datetime-local` value ("YYYY-MM-DDTHH:mm") in local time.
const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Create() {
  const { giftType } = useParams();
  const def = giftType ? registry[giftType] : undefined;
  const createGift = useMutation(api.gifts.createGift);
  const generateVoiceUploadUrl = useMutation(api.gifts.generateVoiceUploadUrl);
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
  const [payload, setPayload] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [openAfterLocal, setOpenAfterLocal] = useState("");
  const [minLocal] = useState(() => toLocalInput(new Date(Date.now() + 60_000)));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!def) {
    return <NotFound heading={t.create.unknownHeading} copy={t.create.unknownCopy} />;
  }

  const canSubmit =
    !submitting &&
    senderName.trim().length > 0 &&
    recipientName.trim().length > 0 &&
    (!scheduled || openAfterLocal !== "");

  const handleCreate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const openAfterMs =
        scheduled && openAfterLocal ? new Date(openAfterLocal).getTime() : NaN;
      let voiceId: Id<"_storage"> | undefined;
      if (voiceBlob) {
        const url = await generateVoiceUploadUrl();
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": voiceBlob.type },
          body: voiceBlob,
        });
        if (!res.ok) throw new Error("Voice upload failed");
        const { storageId } = await res.json();
        voiceId = storageId;
      }
      const { statusKey } = await createGift({
        giftType: def.id,
        senderName: senderName.trim(),
        recipientName: recipientName.trim(),
        message: message.trim(),
        variants,
        lang,
        openAfter: Number.isNaN(openAfterMs) ? undefined : openAfterMs,
        payload: payload.trim() || undefined,
        notifyEmail: notifyEmail.trim() || undefined,
        voiceId,
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

      <section aria-labelledby="sec-core" className="flex flex-col gap-6">
        <h2 id="sec-core" className="font-serif text-xl text-stone-100">
          {t.create.sectionCore}
        </h2>

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
      </section>

      {/* ponytail: native <details> disclosure — no useState, no aria-expanded, keyboard/SR-accessible free */}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden">
          <span className="font-serif text-xl text-stone-100">{t.create.sectionExtras}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="size-5 text-stone-400 transition-transform group-open:rotate-180"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="mt-6 flex flex-col gap-6">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-stone-300">
              {t.create.attachment}
            </span>
            <input
              type="url"
              inputMode="url"
              value={payload}
              maxLength={PAYLOAD_MAX}
              onChange={(e) => setPayload(e.target.value)}
              placeholder={t.create.attachmentPlaceholder}
              className={inputClass}
            />
          </label>

          <VoiceRecorder onChange={setVoiceBlob} />

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-3 text-sm font-medium text-stone-300">
              <input
                type="checkbox"
                checked={scheduled}
                onChange={(e) => setScheduled(e.target.checked)}
                className="size-4 accent-rose-500"
              />
              {t.create.scheduleLabel}
            </label>
            {scheduled ? (
              <>
                <input
                  type="datetime-local"
                  value={openAfterLocal}
                  min={minLocal}
                  onChange={(e) => setOpenAfterLocal(e.target.value)}
                  className={`${inputClass} [color-scheme:dark]`}
                />
                {openAfterLocal ? (
                  <p className="text-xs text-stone-500">
                    {t.gift.opensOn(
                      new Date(openAfterLocal).toLocaleString(lang, {
                        dateStyle: "full",
                        timeStyle: "short",
                      }),
                    )}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-stone-300">
              {t.create.notifyLabel}
            </span>
            <input
              type="email"
              inputMode="email"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              className={inputClass}
            />
            <p className="mt-2 text-xs text-stone-500">{t.create.notifyHint}</p>
          </label>
        </div>
      </details>

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
