// Pure data — imported by both the client and Convex functions (no React here).

interface VariantDef {
  key: string;
  label: string;
  labelAr?: string;
  options: { value: string; label: string; labelAr?: string }[];
}

export interface GiftCatalogEntry {
  id: string;
  name: string;
  nameAr?: string;
  tagline: string;
  taglineAr?: string;
  variants: VariantDef[];
}

export const NAME_MAX = 40;
export const MESSAGE_MAX = 280;

// Local "en" | "ar" instead of importing Lang from i18n — keeps this module free
// of any React/DOM coupling so the Convex bundle stays clean.
export const pick = (lang: "en" | "ar", en: string, ar?: string) =>
  lang === "ar" && ar ? ar : en;

const opts = (...triples: [string, string, string?][]) =>
  triples.map(([value, label, labelAr]) => ({ value, label, labelAr }));

/** First option value for each variant key — the neutral default selection. */
export const defaultVariants = (def: GiftCatalogEntry): Record<string, string> =>
  Object.fromEntries(def.variants.map((v) => [v.key, v.options[0].value]));

export const catalog: Record<string, GiftCatalogEntry> = {
  "eternal-rose": {
    id: "eternal-rose",
    name: "Eternal Rose",
    nameAr: "وردة أبدية",
    tagline: "A glass-domed rose that blooms just for them",
    taglineAr: "وردة تحت قبة زجاجية تتفتّح من أجلهم",
    variants: [
      {
        key: "petal",
        label: "Petal color",
        labelAr: "لون البتلات",
        options: opts(
          ["red", "Crimson", "قرمزي"],
          ["white", "Ivory", "عاجي"],
          ["midnight-gold", "Midnight Gold", "ذهبي ليلي"],
        ),
      },
    ],
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks",
    nameAr: "ألعاب نارية",
    tagline: "Bursts that spell your words across the night",
    taglineAr: "انفجارات تكتب كلماتك عبر الليل",
    variants: [
      {
        key: "palette",
        label: "Palette",
        labelAr: "لوحة الألوان",
        options: opts(
          ["festival", "Festival", "احتفال"],
          ["rose-gold", "Rose Gold", "ذهبي وردي"],
          ["neon", "Neon", "نيون"],
        ),
      },
    ],
  },
  "snow-globe": {
    id: "snow-globe",
    name: "Snow Globe",
    nameAr: "كرة الثلج",
    tagline: "A tiny world that swirls when they shake it",
    taglineAr: "عالم صغير يتماوج حين يهزّونه",
    variants: [
      {
        key: "scene",
        label: "Scene",
        labelAr: "المشهد",
        options: opts(
          ["cabin", "Cabin", "كوخ"],
          ["forest", "Pine Forest", "غابة صنوبر"],
          ["heart", "Heart", "قلب"],
        ),
      },
      {
        key: "particles",
        label: "Particles",
        labelAr: "الجُسيمات",
        options: opts(["snow", "Snow", "ثلج"], ["stardust", "Stardust", "غبار النجوم"]),
      },
    ],
  },
  "birthday-cake": {
    id: "birthday-cake",
    name: "Birthday Cake",
    nameAr: "كعكة عيد ميلاد",
    tagline: "Light the candles, then blow them all out",
    taglineAr: "أشعل الشموع ثم أطفئها جميعًا",
    variants: [
      {
        key: "frosting",
        label: "Frosting",
        labelAr: "الكريمة",
        options: opts(
          ["chocolate", "Chocolate", "شوكولاتة"],
          ["strawberry", "Strawberry", "فراولة"],
          ["vanilla", "Vanilla", "فانيلا"],
        ),
      },
      {
        key: "candles",
        label: "Candles",
        labelAr: "الشموع",
        options: opts(
          ...Array.from({ length: 24 }, (_, i): [string, string] => [String(i + 1), String(i + 1)]),
        ),
      },
    ],
  },
  constellation: {
    id: "constellation",
    name: "Constellation",
    nameAr: "كوكبة",
    tagline: "A sky that draws itself, just for them",
    taglineAr: "سماء ترسم نفسها، من أجلهم",
    variants: [
      {
        key: "shape",
        label: "Shape",
        labelAr: "الشكل",
        options: opts(
          ["heart", "Heart", "قلب"],
          ["star", "Star", "نجمة"],
          ["infinity", "Infinity", "لانهاية"],
        ),
      },
    ],
  },
  "butterfly-jar": {
    id: "butterfly-jar",
    name: "Butterfly Jar",
    nameAr: "جرة الفراشات",
    tagline: "Unscrew the lid, set the glow free",
    taglineAr: "افتح الغطاء وأطلق الوهج",
    variants: [
      {
        key: "glow",
        label: "Glow",
        labelAr: "الوهج",
        options: opts(
          ["aqua", "Aqua", "سماوي"],
          ["violet", "Violet", "بنفسجي"],
          ["amber", "Amber", "كهرماني"],
        ),
      },
    ],
  },
  "lantern-sky": {
    id: "lantern-sky",
    name: "Lantern Sky",
    nameAr: "سماء الفوانيس",
    tagline: "Lanterns rise, carrying your words",
    taglineAr: "فوانيس ترتفع حاملةً كلماتك",
    variants: [
      {
        key: "color",
        label: "Lantern color",
        labelAr: "لون الفانوس",
        options: opts(
          ["amber", "Amber", "كهرماني"],
          ["crimson", "Crimson", "قرمزي"],
          ["jade", "Jade", "يشمي"],
        ),
      },
    ],
  },
  "balloon-bunch": {
    id: "balloon-bunch",
    name: "Balloon Bunch",
    nameAr: "باقة بالونات",
    tagline: "A bouquet of balloons lifts your note",
    taglineAr: "باقة بالونات ترفع رسالتك",
    variants: [
      {
        key: "palette",
        label: "Palette",
        labelAr: "لوحة الألوان",
        options: opts(
          ["warm", "Warm", "دافئ"],
          ["pastel", "Pastel", "باستيل"],
          ["gold", "Gold", "ذهبي"],
        ),
      },
      {
        key: "count",
        label: "Balloons",
        labelAr: "البالونات",
        options: opts(["7", "7"], ["12", "12"], ["20", "20"]),
      },
    ],
  },
  "message-bottle": {
    id: "message-bottle",
    name: "Message in a Bottle",
    nameAr: "رسالة في زجاجة",
    tagline: "Washed ashore, corked, and meant for them",
    taglineAr: "جرفها الموج إلى الشاطئ، مسدودة، ومُوجَّهة إليهم",
    variants: [
      {
        key: "time",
        label: "Time of day",
        labelAr: "وقت اليوم",
        options: opts(
          ["sunset", "Sunset", "غروب"],
          ["night", "Night", "ليل"],
          ["dawn", "Dawn", "فجر"],
        ),
      },
    ],
  },
  "music-box": {
    id: "music-box",
    name: "Music Box",
    nameAr: "صندوق موسيقى",
    tagline: "Wind it open for a tiny, twinkling waltz",
    taglineAr: "أدره ليعزف لحن فالس صغيرًا متلألئًا",
    variants: [
      {
        key: "figurine",
        label: "Figurine",
        labelAr: "التمثال",
        options: opts(
          ["ballerina", "Ballerina", "راقصة باليه"],
          ["heart", "Heart", "قلب"],
          ["moon", "Moon", "قمر"],
        ),
      },
    ],
  },
  "golden-locket": {
    id: "golden-locket",
    name: "Golden Locket",
    nameAr: "قلادة ذهبية",
    tagline: "Two names, kept close",
    taglineAr: "اسمان، قريبان دائمًا",
    variants: [
      {
        key: "metal",
        label: "Metal",
        labelAr: "المعدن",
        options: opts(
          ["gold", "Gold", "ذهب"],
          ["silver", "Silver", "فضة"],
          ["rose-gold", "Rose Gold", "ذهبي وردي"],
        ),
      },
    ],
  },
  aurora: {
    id: "aurora",
    name: "Aurora",
    nameAr: "شفق قطبي",
    tagline: "Northern lights with your words woven in",
    taglineAr: "أضواء شمالية تتخلّلها كلماتك",
    variants: [
      {
        key: "palette",
        label: "Palette",
        labelAr: "لوحة الألوان",
        options: opts(
          ["emerald", "Emerald", "زمردي"],
          ["magenta", "Magenta", "أرجواني"],
          ["ice", "Ice", "جليدي"],
        ),
      },
    ],
  },
};
