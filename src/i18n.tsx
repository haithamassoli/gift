import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

// Whole-app i18n: a plain dictionary + one context. Two languages, ~40 strings —
// no i18n library. Interpolated strings are functions; everything else is a
// literal. RTL arrow glyphs are baked per-language (verify visually under rtl).
export type Lang = "en" | "ar";

const en = {
  home: {
    title: "Gift",
    subtitle: "Beautiful 3D gifts you send as a link. Free, no accounts.",
  },
  create: {
    back: "← All gifts",
    livePreview: "Live preview",
    yourName: "Your name",
    theirName: "Their name",
    message: "Message",
    fromPlaceholder: "From…",
    toPlaceholder: "To…",
    messagePlaceholder: "Write something they'll remember…",
    creating: "Creating…",
    submit: "Create gift",
    error: "Something went wrong. Please try again.",
    unknownHeading: "We don't have that gift",
    unknownCopy: "Pick one from the gallery to start personalizing it.",
  },
  sent: {
    ready: "Your gift is ready",
    shareHint: "Share this link with them.",
    copied: "Copied ✓",
    copy: "Copy link",
    preview: "See it as they will →",
    opened: "Opened ✓",
    notOpened: "Not opened yet",
    another: "Make another gift",
    notFoundHeading: "This status page doesn't exist",
    notFoundCopy: "The link may have been mistyped, or the gift was never created.",
  },
  gift: {
    forName: (n: string) => `A gift for ${n}`,
    fromName: (n: string) => `from ${n}`,
    unwrap: "Tap to unwrap",
    replay: "Replay",
    sendBack: "Send one back →",
  },
  notFound: {
    heading: "This link doesn't lead to a gift",
    copy: "It may have been mistyped, or the gift never existed.",
    browse: "Browse gifts",
  },
};

type Strings = typeof en;

// Typed against `en`, so a missing or misnamed key fails the build.
const ar: Strings = {
  home: {
    title: "هدية",
    subtitle: "هدايا ثلاثية الأبعاد تُرسلها برابط. مجانًا، دون حسابات.",
  },
  create: {
    back: "→ كل الهدايا",
    livePreview: "معاينة مباشرة",
    yourName: "اسمك",
    theirName: "اسم من تُهديه",
    message: "الرسالة",
    fromPlaceholder: "من…",
    toPlaceholder: "إلى…",
    messagePlaceholder: "اكتب شيئًا لا يُنسى…",
    creating: "جارٍ الإنشاء…",
    submit: "أنشئ الهدية",
    error: "حدث خطأ ما. حاول مرة أخرى.",
    unknownHeading: "لا نملك هذه الهدية",
    unknownCopy: "اختر واحدة من المعرض لتبدأ بتخصيصها.",
  },
  sent: {
    ready: "هديتك جاهزة",
    shareHint: "شارك هذا الرابط معهم.",
    copied: "تم النسخ ✓",
    copy: "انسخ الرابط",
    preview: "شاهدها كما سيرونها ←",
    opened: "فُتحت ✓",
    notOpened: "لم تُفتح بعد",
    another: "أنشئ هدية أخرى",
    notFoundHeading: "صفحة الحالة هذه غير موجودة",
    notFoundCopy: "قد يكون الرابط مكتوبًا بشكل خاطئ، أو أن الهدية لم تُنشأ.",
  },
  gift: {
    forName: (n: string) => `هدية لـ ${n}`,
    fromName: (n: string) => `من ${n}`,
    unwrap: "اضغط لفتحها",
    replay: "إعادة",
    sendBack: "أرسل واحدة بالمقابل ←",
  },
  notFound: {
    heading: "هذا الرابط لا يؤدي إلى هدية",
    copy: "قد يكون مكتوبًا بشكل خاطئ، أو أن الهدية لم تكن موجودة.",
    browse: "تصفّح الهدايا",
  },
};

export const strings: Record<Lang, Strings> = { en, ar };

/** Common gift fallback copy ("For {name}" / "For you") in both languages. */
export function forRecipient(lang: Lang, name: string): string {
  const n = name.trim();
  if (lang === "ar") return n ? `إلى ${n}` : "إليك";
  return n ? `For ${n}` : "For you";
}

const STORAGE_KEY = "gift.lang";

function initialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "ar") return saved;
  return navigator.language?.toLowerCase().startsWith("ar") ? "ar" : "en";
}

const LangContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
} | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initialLang);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang);
    // Warm the Arabic webfont so gallery previews rasterize in Thmanyah.
    if (lang === "ar") void document.fonts?.load?.('1em "Thmanyah Sans"');
  }, [lang]);

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within LangProvider");
  return { lang: ctx.lang, setLang: ctx.setLang, t: strings[ctx.lang] };
}

export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-white/15 text-xs">
      {(["en", "ar"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`min-w-[2.5rem] px-3 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 ${
            lang === l ? "bg-rose-500 text-white" : "text-stone-300 hover:text-white"
          }`}
        >
          {l === "en" ? "EN" : "ع"}
        </button>
      ))}
    </div>
  );
}
