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
  common: {
    // Announced by the loading screen's role="status"; never shown on screen.
    loading: "Loading",
    madeBy: "Made by",
  },
  home: {
    title: "Gift",
    subtitle: "Beautiful 3D gifts you send as a link. Free, no accounts.",
    all: "All",
    filterLabel: "Filter by occasion",
    sentHeading: "Gifts you've sent",
    sentClear: "Clear history",
    visitors: (n: number): string => (n === 1 ? "visitor" : "visitors"),
  },
  create: {
    back: "← All gifts",
    livePreview: "Live preview",
    sectionCore: "Your gift",
    sectionExtras: "Make it special",
    yourName: "Your name",
    theirName: "Their name",
    message: "Message",
    fromPlaceholder: "From…",
    toPlaceholder: "To…",
    messagePlaceholder: "Write something they'll remember…",
    attachment: "Add a link (optional)",
    attachmentPlaceholder: "https://…",
    photoLabel: "Add a photo (optional)",
    photoTooBig: "That photo is over 5 MB — choose a smaller one.",
    photoRemove: "Remove photo",
    notifyLabel: "Email me when it’s opened (optional)",
    notifyHint: "One email, nothing else.",
    voiceLabel: "Add a voice note (optional)",
    record: "Record",
    stop: "Stop",
    rerecord: "Delete & re-record",
    micDenied: "Microphone access was blocked.",
    creating: "Creating…",
    submit: "Create gift",
    scheduleLabel: "Schedule when it opens",
    recipientEmailLabel: "Their email (optional)",
    recipientEmailHint: "We'll email them the link when it unlocks. One email, nothing else.",
    burnLabel: "Fade away 24 hours after opening",
    error: "Something went wrong. Please try again.",
    unknownHeading: "We don't have that gift",
    unknownCopy: "Pick one from the gallery to start personalizing it.",
  },
  sent: {
    ready: "Your gift is ready",
    shareHint: "Share this link with them.",
    copied: "Copied ✓",
    copy: "Copy link",
    share: "Share",
    shareText: "I made you a gift 🎁",
    qrHint: "Or let them scan it — print it, tuck it in the box.",
    preview: "See it as they will →",
    opened: "Opened ✓",
    notOpened: "Not opened yet",
    replyHeading: "They wrote back",
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
    opensOn: (date: string) => `Opens ${date}`,
    openLink: "Open the link",
    photoAlt: "Shared photo",
    previewBadge: "Preview",
    replyLabel: "Send thanks back",
    replyPlaceholder: "Write a little thank-you…",
    replySend: "Send",
    replySent: "Your thanks were sent ✓",
    burnHint: "This gift fades 24 hours after it's opened",
    burnedHeading: "This gift has faded",
    burnedCopy: "It was made to disappear after opening — and it has. The moment was yours.",
  },
  notFound: {
    heading: "Nothing to unwrap here",
    copy: "This link doesn't lead to a gift — it may have been mistyped, or the gift was never created.",
    browse: "Browse gifts",
  },
  error: {
    heading: "This gift couldn't load",
    copy: "Something went wrong on our end. Browse the gallery to keep going.",
  },
  install: {
    title: "Install Gift",
    body: "Add Gift to your home screen for instant access — no app store.",
    action: "Install",
    dismiss: "Not now",
    iosTitle: "Install Gift",
    iosBody: 'Tap Share, then "Add to Home Screen".',
    iosDone: "Got it",
  },
};

type Strings = typeof en;

// Typed against `en`, so a missing or misnamed key fails the build.
const ar: Strings = {
  common: {
    loading: "جارٍ التحميل",
    madeBy: "صُنع بواسطة",
  },
  home: {
    title: "هدية",
    subtitle: "هدايا ثلاثية الأبعاد تُرسلها برابط. مجانًا، دون حسابات.",
    all: "الكل",
    filterLabel: "تصفية حسب المناسبة",
    sentHeading: "الهدايا التي أرسلتها",
    sentClear: "مسح السجلّ",
    visitors: () => "زائر",
  },
  create: {
    back: "→ كل الهدايا",
    livePreview: "معاينة مباشرة",
    sectionCore: "هديتك",
    sectionExtras: "اجعلها مميّزة",
    yourName: "اسمك",
    theirName: "اسم من تُهديه",
    message: "الرسالة",
    fromPlaceholder: "من…",
    toPlaceholder: "إلى…",
    messagePlaceholder: "اكتب شيئًا لا يُنسى…",
    attachment: "أضف رابطًا (اختياري)",
    attachmentPlaceholder: "https://…",
    photoLabel: "أضف صورة (اختياري)",
    photoTooBig: "هذه الصورة تتجاوز 5 ميغابايت — اختر واحدة أصغر.",
    photoRemove: "إزالة الصورة",
    notifyLabel: "أرسل لي بريدًا عند فتحها (اختياري)",
    notifyHint: "بريد واحد فقط، لا شيء آخر.",
    voiceLabel: "أضف رسالة صوتية (اختياري)",
    record: "تسجيل",
    stop: "إيقاف",
    rerecord: "حذف وإعادة التسجيل",
    micDenied: "تم حظر الوصول إلى الميكروفون.",
    creating: "جارٍ الإنشاء…",
    submit: "أنشئ الهدية",
    scheduleLabel: "حدّد موعد فتحها",
    recipientEmailLabel: "بريد من تُهديه (اختياري)",
    recipientEmailHint: "سنرسل لهم الرابط عند فتحها. بريد واحد فقط، لا شيء آخر.",
    burnLabel: "تتلاشى بعد 24 ساعة من فتحها",
    error: "حدث خطأ ما. حاول مرة أخرى.",
    unknownHeading: "لا نملك هذه الهدية",
    unknownCopy: "اختر واحدة من المعرض لتبدأ بتخصيصها.",
  },
  sent: {
    ready: "هديتك جاهزة",
    shareHint: "شارك هذا الرابط معهم.",
    copied: "تم النسخ ✓",
    copy: "انسخ الرابط",
    share: "مشاركة",
    shareText: "صنعت لك هدية 🎁",
    qrHint: "أو دعهم يمسحوه — اطبعه وضعه في العلبة.",
    preview: "شاهدها كما سيرونها ←",
    opened: "فُتحت ✓",
    notOpened: "لم تُفتح بعد",
    replyHeading: "ردّوا عليك",
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
    opensOn: (date: string) => `تُفتح ${date}`,
    openLink: "افتح الرابط",
    photoAlt: "صورة مُرفقة",
    previewBadge: "معاينة",
    replyLabel: "أرسل شكرك بالمقابل",
    replyPlaceholder: "اكتب كلمة شكر…",
    replySend: "إرسال",
    replySent: "تم إرسال شكرك ✓",
    burnHint: "تتلاشى هذه الهدية بعد 24 ساعة من فتحها",
    burnedHeading: "تلاشت هذه الهدية",
    burnedCopy: "صُنعت لتختفي بعد فتحها — وقد اختفت. كانت اللحظة لك.",
  },
  notFound: {
    heading: "لا شيء لفتحه هنا",
    copy: "هذا الرابط لا يؤدي إلى هدية — قد يكون مكتوبًا بشكل خاطئ، أو أن الهدية لم تُنشأ.",
    browse: "تصفّح الهدايا",
  },
  error: {
    heading: "تعذّر تحميل الهدية",
    copy: "حدث خطأ ما لدينا. تصفّح المعرض للمتابعة.",
  },
  install: {
    title: "ثبّت هدية",
    body: "أضف هدية إلى شاشتك الرئيسية للوصول الفوري — دون متجر تطبيقات.",
    action: "تثبيت",
    dismiss: "ليس الآن",
    iosTitle: "ثبّت هدية",
    iosBody: "اضغط زر المشاركة، ثم «أضف إلى الشاشة الرئيسية».",
    iosDone: "حسنًا",
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
