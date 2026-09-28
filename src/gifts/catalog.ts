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
export const PAYLOAD_MAX = 2048;
export const VOICE_MAX_BYTES = 2_000_000;
export const VOICE_MAX_SECONDS = 60;
export const PHOTO_MAX_BYTES = 5_000_000;

// A payload is a single http(s) URL (photo / link / voucher) shown to the
// recipient after they open the gift. Only http(s) may be stored — javascript:
// and data: URLs are XSS vectors once rendered as an href. Used by the create
// mutation (server-side security check) and the create form.
export const isSafePayloadUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// Local "en" | "ar" instead of importing Lang from i18n — keeps this module free
// of any React/DOM coupling so the Convex bundle stays clean.
export const pick = (lang: "en" | "ar", en: string, ar?: string) =>
  lang === "ar" && ar ? ar : en;

const opts = (...triples: [string, string, string?][]) =>
  triples.map(([value, label, labelAr]) => ({ value, label, labelAr }));

/** First option value for each variant key — the neutral default selection. */
export const defaultVariants = (def: GiftCatalogEntry): Record<string, string> =>
  Object.fromEntries(def.variants.map((v) => [v.key, v.options[0].value]));

// What you're sending someone *for* — the browse-by-intent layer over the same
// scenes. A scene can suit several. Ordered for the gallery filter; the UI
// prepends an implicit "All".
export type Occasion =
  | "love"
  | "anniversary"
  | "birthday"
  | "celebration"
  | "congrats"
  | "graduation"
  | "thanks"
  | "apology"
  | "funny"
  | "get-well"
  | "thinking-of-you";

export const occasions: { key: Occasion; label: string; labelAr: string }[] = [
  { key: "love", label: "Love", labelAr: "حب" },
  { key: "anniversary", label: "Anniversary", labelAr: "ذكرى سنوية" },
  { key: "birthday", label: "Birthday", labelAr: "عيد ميلاد" },
  { key: "celebration", label: "Eid & celebration", labelAr: "عيد ومناسبة" },
  { key: "congrats", label: "Congrats", labelAr: "تهنئة" },
  { key: "graduation", label: "Graduation", labelAr: "تخرّج" },
  { key: "thanks", label: "Thank you", labelAr: "شكرًا" },
  { key: "apology", label: "Sorry", labelAr: "اعتذار" },
  { key: "funny", label: "For a laugh", labelAr: "على الضحك" },
  { key: "get-well", label: "Get well", labelAr: "سلامتك" },
  { key: "thinking-of-you", label: "Thinking of you", labelAr: "أفكّر بك" },
];

export const catalog: Record<string, GiftCatalogEntry> = {
  // ---- Batch 3: the recipient is the maker (dip, stitch, light, pluck, stamp) ----
  qalam: {
    id: "qalam",
    name: "Calligrapher's Qalam",
    nameAr: "قلم الخطّاط",
    tagline: "Dip the reed; a master's hand writes the rest",
    taglineAr: "اغمس القلم، ويد الخطّاط تُتمّ الباقي",
    variants: [
      {
        key: "ink",
        label: "Ink",
        labelAr: "الحبر",
        options: opts(
          ["midnight", "Midnight", "ليلي"],
          ["oxblood", "Oxblood", "عنّابي"],
          ["lapis", "Lapis", "لازوردي"],
        ),
      },
      {
        key: "paper",
        label: "Paper",
        labelAr: "الورق",
        options: opts(
          ["cream", "Cream", "كريمي"],
          ["aged", "Aged", "معتّق"],
          ["indigo", "Indigo", "نيلي"],
        ),
      },
    ],
  },
  tatreez: {
    id: "tatreez",
    name: "Tatreez Hoop",
    nameAr: "طارة التطريز",
    tagline: "Stitch by stitch, the words find home",
    taglineAr: "غرزة غرزة، تعود الكلمات إلى البيت",
    variants: [
      {
        key: "thread",
        label: "Thread",
        labelAr: "الخيط",
        options: opts(
          ["crimson", "Crimson", "قرمزي"],
          ["gold", "Gold", "ذهبي"],
          ["olive", "Olive", "زيتوني"],
        ),
      },
      {
        key: "cloth",
        label: "Cloth",
        labelAr: "القماش",
        options: opts(
          ["indigo", "Indigo", "نيلي"],
          ["black", "Black", "أسود"],
          ["linen", "Linen", "كتّاني"],
        ),
      },
    ],
  },
  fanous: {
    id: "fanous",
    name: "Fanous",
    nameAr: "الفانوس",
    tagline: "Light the wick; the walls learn your words",
    taglineAr: "أشعل الفتيل، فتحفظ الجدران كلماتك",
    variants: [
      {
        key: "glass",
        label: "Glass",
        labelAr: "الزجاج",
        options: opts(
          ["amber", "Amber", "كهرماني"],
          ["emerald", "Emerald", "زمردي"],
          ["ruby", "Ruby", "ياقوتي"],
        ),
      },
      {
        key: "pattern",
        label: "Pattern",
        labelAr: "النقش",
        options: opts(
          ["stars", "Stars", "نجوم"],
          ["arabesque", "Arabesque", "أرابيسك"],
          ["crescents", "Crescents", "أهلّة"],
        ),
      },
    ],
  },
  falcon: {
    id: "falcon",
    name: "The Falconer",
    nameAr: "الصقّار",
    tagline: "Cast her to the wind; she returns with your words",
    taglineAr: "أطلقه للريح، فيعود بكلماتك",
    variants: [
      {
        key: "falcon",
        label: "Falcon",
        labelAr: "الصقر",
        options: opts(
          ["shaheen", "Shaheen", "شاهين"],
          ["saker", "Saker", "حُر"],
          ["white-gyr", "White Gyr", "جير أبيض"],
        ),
      },
      {
        key: "hour",
        label: "Hour",
        labelAr: "الوقت",
        options: opts(
          ["dusk", "Dusk", "غسق"],
          ["dawn", "Dawn", "فجر"],
          ["moonlit", "Moonlit", "مقمر"],
        ),
      },
    ],
  },
  typewriter: {
    id: "typewriter",
    name: "Typewriter",
    nameAr: "الآلة الكاتبة",
    tagline: "Whatever you press, it types the truth",
    taglineAr: "مهما ضغطت، تكتب الحقيقة",
    variants: [
      {
        key: "machine",
        label: "Machine",
        labelAr: "الآلة",
        options: opts(
          ["mint", "Mint", "نعناعي"],
          ["coral", "Coral", "مرجاني"],
          ["charcoal", "Charcoal", "فحمي"],
        ),
      },
      {
        key: "ink",
        label: "Ink",
        labelAr: "الحبر",
        options: opts(["black", "Black", "أسود"], ["red-black", "Red & Black", "أحمر وأسود"]),
      },
    ],
  },
  "domino-run": {
    id: "domino-run",
    name: "Domino Run",
    nameAr: "صف الدومينو",
    tagline: "One touch, and every piece falls into place",
    taglineAr: "لمسة واحدة، فيقع كل حجر في مكانه",
    variants: [
      {
        key: "tiles",
        label: "Tiles",
        labelAr: "الأحجار",
        options: opts(
          ["ivory", "Ivory", "عاجي"],
          ["jet", "Jet", "فاحم"],
          ["rosewood", "Rosewood", "خشب الورد"],
        ),
      },
      {
        key: "table",
        label: "Table",
        labelAr: "الطاولة",
        options: opts(
          ["green-felt", "Green Felt", "جوخ أخضر"],
          ["walnut", "Walnut", "جوز"],
          ["slate", "Slate", "إردواز"],
        ),
      },
    ],
  },
  "neon-sign": {
    id: "neon-sign",
    name: "Neon Workshop",
    nameAr: "ورشة النيون",
    tagline: "Trace the glass until the night says it out loud",
    taglineAr: "تتبّع الزجاج حتى يقولها الليل",
    variants: [
      {
        key: "gas",
        label: "Gas",
        labelAr: "الغاز",
        options: opts(
          ["rose", "Rose", "وردي"],
          ["cyan", "Cyan", "سماوي"],
          ["amber", "Amber", "كهرماني"],
        ),
      },
      {
        key: "night",
        label: "Night",
        labelAr: "الليل",
        options: opts(
          ["rain", "Rain", "مطر"],
          ["clear", "Clear", "صحو"],
          ["fog", "Fog", "ضباب"],
        ),
      },
    ],
  },
  oud: {
    id: "oud",
    name: "The Oud",
    nameAr: "العود",
    tagline: "Pluck the strings; the melody remembers",
    taglineAr: "داعب الأوتار، فاللحن يتذكّر",
    variants: [
      {
        key: "wood",
        label: "Wood",
        labelAr: "الخشب",
        options: opts(
          ["honey", "Honey", "عسلي"],
          ["walnut", "Walnut", "جوز"],
          ["ebony", "Ebony", "أبنوس"],
        ),
      },
      {
        key: "maqam",
        label: "Maqam",
        labelAr: "المقام",
        options: opts(
          ["hijaz", "Hijaz", "حجاز"],
          ["nahawand", "Nahawand", "نهاوند"],
          ["rast", "Rast", "راست"],
        ),
      },
    ],
  },
  "wax-seal": {
    id: "wax-seal",
    name: "Wax & Seal",
    nameAr: "الشمع والختم",
    tagline: "Some words deserve to be sealed",
    taglineAr: "بعض الكلمات تستحق أن تُختَم",
    variants: [
      {
        key: "wax",
        label: "Wax",
        labelAr: "الشمع",
        options: opts(
          ["crimson", "Crimson", "قرمزي"],
          ["gold", "Gold", "ذهبي"],
          ["midnight", "Midnight", "ليلي"],
        ),
      },
      {
        key: "stamp",
        label: "Stamp",
        labelAr: "الختم",
        options: opts(
          ["initials", "Initials", "أحرف"],
          ["heart", "Heart", "قلب"],
          ["star", "Star", "نجمة"],
        ),
      },
    ],
  },
  hourglass: {
    id: "hourglass",
    name: "Hourglass",
    nameAr: "الساعة الرملية",
    tagline: "Turn it over; every grain knows where to land",
    taglineAr: "اقلبها، فكل حبّة رمل تعرف مكانها",
    variants: [
      {
        key: "sand",
        label: "Sand",
        labelAr: "الرمل",
        options: opts(
          ["gold", "Gold", "ذهبي"],
          ["rose", "Rose", "وردي"],
          ["silver", "Silver", "فضي"],
        ),
      },
      {
        key: "frame",
        label: "Frame",
        labelAr: "الإطار",
        options: opts(
          ["brass", "Brass", "نحاس"],
          ["ebony", "Ebony", "أبنوس"],
          ["steel", "Steel", "فولاذ"],
        ),
      },
    ],
  },
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
  moonflower: {
    id: "moonflower",
    name: "Moonflower",
    nameAr: "زهرة القمر",
    tagline: "A night-blooming flower that opens only for them",
    taglineAr: "زهرة ليلية تتفتّح من أجلهم وحدهم",
    variants: [
      {
        key: "petal",
        label: "Petal color",
        labelAr: "لون البتلات",
        options: opts(
          ["moonlight", "Moonlight", "ضوء القمر"],
          ["blush", "Blush", "وردي"],
          ["violet", "Violet", "بنفسجي"],
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
  "shooting-gallery": {
    id: "shooting-gallery",
    name: "Shooting Gallery",
    nameAr: "كشك الرماية",
    tagline: "One shot, and the doll gives up its secret",
    taglineAr: "طلقة واحدة، وتبوح الدمية بسرّها",
    variants: [
      {
        key: "mood",
        label: "Mood",
        labelAr: "الأجواء",
        options: opts(
          ["noir", "Noir", "نوار"],
          ["bloodmoon", "Blood Moon", "قمر الدم"],
          ["absinthe", "Absinthe", "أفسنتين"],
        ),
      },
    ],
  },
  "magic-lamp": {
    id: "magic-lamp",
    name: "Magic Lamp",
    nameAr: "المصباح السحري",
    tagline: "Rub the brass, and the smoke writes your words",
    taglineAr: "افرك النحاس، فيكتب الدخان كلماتك",
    variants: [
      {
        key: "metal",
        label: "Metal",
        labelAr: "المعدن",
        options: opts(
          ["brass", "Brass", "نحاس"],
          ["aged-silver", "Aged Silver", "فضة عتيقة"],
          ["obsidian", "Obsidian", "سبج"],
        ),
      },
      {
        key: "smoke",
        label: "Smoke",
        labelAr: "الدخان",
        options: opts(
          ["turquoise", "Turquoise", "فيروزي"],
          ["rose", "Rose", "وردي"],
          ["gold-dust", "Gold Dust", "غبار ذهبي"],
        ),
      },
    ],
  },
  "foggy-mirror": {
    id: "foggy-mirror",
    name: "Foggy Mirror",
    nameAr: "مرآة الضباب",
    tagline: "Breathe on the glass; a finger writes back",
    taglineAr: "انفخ على الزجاج، فيكتب لك إصبع خفي",
    variants: [
      {
        key: "setting",
        label: "Setting",
        labelAr: "المشهد",
        options: opts(
          ["rain-window", "Rain Window", "نافذة مطر"],
          ["candlelight", "Candlelight", "ضوء الشموع"],
          ["night-train", "Night Train", "قطار ليلي"],
        ),
      },
    ],
  },
  astrolabe: {
    id: "astrolabe",
    name: "Astrolabe",
    nameAr: "الأسطرلاب",
    tagline: "Turn the rings until the stars agree",
    taglineAr: "أدِر الحلقات حتى تتفق النجوم",
    variants: [
      {
        key: "metal",
        label: "Metal",
        labelAr: "المعدن",
        options: opts(
          ["brass", "Brass", "نحاس"],
          ["silver", "Silver", "فضة"],
          ["night-steel", "Night Steel", "فولاذ ليلي"],
        ),
      },
      {
        key: "sky",
        label: "Sky",
        labelAr: "السماء",
        options: opts(
          ["dawn", "Dawn", "فجر"],
          ["dusk", "Dusk", "غسق"],
          ["night", "Night", "ليل"],
        ),
      },
    ],
  },
  "scratch-card": {
    id: "scratch-card",
    name: "Scratch Card",
    nameAr: "بطاقة الحظ",
    tagline: "Scratch the gold — every card wins",
    taglineAr: "اكشط الذهب، كل البطاقات رابحة",
    variants: [
      {
        key: "foil",
        label: "Foil",
        labelAr: "القشرة",
        options: opts(
          ["gold", "Gold", "ذهبي"],
          ["silver", "Silver", "فضي"],
          ["rose", "Rose", "وردي"],
        ),
      },
      {
        key: "motif",
        label: "Motif",
        labelAr: "الزخرفة",
        options: opts(
          ["hearts", "Hearts", "قلوب"],
          ["stars", "Stars", "نجوم"],
          ["clovers", "Clovers", "نفل"],
        ),
      },
    ],
  },
  "claw-machine": {
    id: "claw-machine",
    name: "Claw Machine",
    nameAr: "لعبة المخلب",
    tagline: "Rigged, for once, in their favor",
    taglineAr: "مضبوطة، لمرة واحدة، لصالحهم",
    variants: [
      {
        key: "plush",
        label: "Plush",
        labelAr: "الدمية",
        options: opts(
          ["bear", "Bear", "دب"],
          ["bunny", "Bunny", "أرنب"],
          ["star", "Star", "نجمة"],
        ),
      },
      {
        key: "cabinet",
        label: "Cabinet",
        labelAr: "الكشك",
        options: opts(
          ["bubblegum", "Bubblegum", "وردي فقاعي"],
          ["midnight", "Midnight", "منتصف الليل"],
          ["mint", "Mint", "نعناعي"],
        ),
      },
    ],
  },
  pinata: {
    id: "pinata",
    name: "Piñata",
    nameAr: "بينياتا",
    tagline: "Tap until it rains sweets and secrets",
    taglineAr: "انقرها حتى تمطر حلوى وأسرارًا",
    variants: [
      {
        key: "shape",
        label: "Shape",
        labelAr: "الشكل",
        options: opts(
          ["star", "Star", "نجمة"],
          ["heart", "Heart", "قلب"],
          ["burro", "Little Burro", "مهر صغير"],
        ),
      },
      {
        key: "palette",
        label: "Palette",
        labelAr: "الألوان",
        options: opts(
          ["fiesta", "Fiesta", "مهرجان"],
          ["pastel", "Pastel", "باستيل"],
          ["sunset", "Sunset", "غروب"],
        ),
      },
    ],
  },
  mixtape: {
    id: "mixtape",
    name: "Mixtape",
    nameAr: "شريط الذكريات",
    tagline: "Press play — the ribbon writes the rest",
    taglineAr: "اضغط التشغيل، فيكتب الشريط الباقي",
    variants: [
      {
        key: "shell",
        label: "Shell",
        labelAr: "الهيكل",
        options: opts(
          ["smoke", "Smoke", "دخاني"],
          ["cherry", "Cherry", "كرزي"],
          ["seafoam", "Seafoam", "زبد البحر"],
        ),
      },
      {
        key: "label",
        label: "Label",
        labelAr: "الملصق",
        options: opts(
          ["handwritten", "Handwritten", "بخط اليد"],
          ["typed", "Typed", "مطبوع"],
        ),
      },
    ],
  },
  matchbox: {
    id: "matchbox",
    name: "Matchbox World",
    nameAr: "عالم في علبة كبريت",
    tagline: "One match, and a tiny world wakes",
    taglineAr: "عود واحد، فيستيقظ عالم صغير",
    variants: [
      {
        key: "world",
        label: "World",
        labelAr: "العالم",
        options: opts(
          ["city-rooftops", "City Rooftops", "سطوح المدينة"],
          ["desert-night", "Desert Night", "ليل الصحراء"],
          ["harbor", "Harbor", "المرفأ"],
        ),
      },
    ],
  },
  "koi-pond": {
    id: "koi-pond",
    name: "Koi Pond",
    nameAr: "بركة الكوي",
    tagline: "Feed the koi; they write it on the water",
    taglineAr: "أطعم الأسماك، فتكتبها على الماء",
    variants: [
      {
        key: "koi",
        label: "Koi",
        labelAr: "الكوي",
        options: opts(
          ["white-gold", "White Gold", "أبيض ذهبي"],
          ["crimson", "Crimson", "قرمزي"],
          ["black-pearl", "Black Pearl", "لؤلؤ أسود"],
        ),
      },
      {
        key: "time",
        label: "Time",
        labelAr: "الوقت",
        options: opts(
          ["dusk", "Dusk", "غسق"],
          ["night", "Night", "ليل"],
          ["dawn", "Dawn", "فجر"],
        ),
      },
    ],
  },
  "cup-reading": {
    id: "cup-reading",
    name: "The Cup Reading",
    nameAr: "قراءة الفنجان",
    tagline: "Flip the cup; the grounds spell their fortune",
    taglineAr: "اقلب الفنجان، فيكتب البُنّ بختهم",
    variants: [
      {
        key: "pattern",
        label: "Pattern",
        labelAr: "النقش",
        options: opts(
          ["gilded", "Gilded", "مذهّب"],
          ["cobalt", "Cobalt", "كوبالت"],
          ["blossom", "Blossom", "مزهر"],
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

  // ---- Batch 4: the pair is the subject — both names on the object, and the
  // object means nothing with only one of them in it ----
  henna: {
    id: "henna",
    name: "Henna Night",
    nameAr: "ليلة الحنّة",
    tagline: "Trace the paste, then wait — the stain remembers",
    taglineAr: "انقش الحنّاء ثم انتظر، فالأثر يتذكّر",
    variants: [
      {
        key: "pattern",
        label: "Pattern",
        labelAr: "النقش",
        options: opts(
          ["khaleeji", "Khaleeji", "خليجي"],
          ["moroccan", "Moroccan", "مغربي"],
          ["floral", "Floral", "زهري"],
        ),
      },
      {
        key: "stain",
        label: "Stain",
        labelAr: "الأثر",
        options: opts(
          ["henna", "Henna", "حنّائي"],
          ["umber", "Umber", "بنّي داكن"],
          ["black-cherry", "Black cherry", "كرزي"],
        ),
      },
    ],
  },
  "two-halves": {
    id: "two-halves",
    name: "Two Halves",
    nameAr: "نصفان",
    tagline: "Half a coin says nothing alone",
    taglineAr: "نصف القطعة لا يقول شيئًا وحده",
    variants: [
      {
        key: "metal",
        label: "Metal",
        labelAr: "المعدن",
        options: opts(
          ["gold", "Gold", "ذهب"],
          ["silver", "Silver", "فضة"],
          ["copper", "Copper", "نحاس"],
        ),
      },
      {
        key: "engraving",
        label: "Engraving",
        labelAr: "النقش",
        options: opts(
          ["kufic", "Kufic", "كوفي"],
          ["diwani", "Diwani", "ديواني"],
          ["laurel", "Laurel", "غار"],
        ),
      },
    ],
  },
  "shadow-play": {
    id: "shadow-play",
    name: "Shadow Play",
    nameAr: "خيال الظلّ",
    tagline: "Two shadows, one story",
    taglineAr: "ظلّان، وحكاية واحدة",
    variants: [
      {
        key: "lamp",
        label: "Lamp",
        labelAr: "المصباح",
        options: opts(
          ["oil", "Oil", "زيتي"],
          ["candle", "Candle", "شمعة"],
          ["gas", "Gas", "غازي"],
        ),
      },
      {
        key: "screen",
        label: "Screen",
        labelAr: "الستارة",
        options: opts(
          ["linen", "Linen", "كتّان"],
          ["silk", "Silk", "حرير"],
          ["paper", "Paper", "ورق"],
        ),
      },
    ],
  },
  fingerprint: {
    id: "fingerprint",
    name: "Two Prints",
    nameAr: "بصمتان",
    tagline: "Press once — the lines already match",
    taglineAr: "اضغط مرّة، فالخطوط متطابقة من البداية",
    variants: [
      {
        key: "medium",
        label: "Medium",
        labelAr: "الوسيط",
        options: opts(
          ["clay", "Clay", "طين"],
          ["ink", "Ink", "حبر"],
          ["plaster", "Plaster", "جبس"],
        ),
      },
      {
        key: "ridges",
        label: "Ridges",
        labelAr: "الخطوط",
        options: opts(
          ["gold", "Gold", "ذهبي"],
          ["ember", "Ember", "جمري"],
          ["indigo", "Indigo", "نيلي"],
        ),
      },
    ],
  },
  nest: {
    id: "nest",
    name: "The Nest",
    nameAr: "العُشّ",
    tagline: "Twig by twig, a home",
    taglineAr: "غصنًا بعد غصن، يصير بيتًا",
    variants: [
      {
        key: "bird",
        label: "Bird",
        labelAr: "الطائر",
        options: opts(
          ["bulbul", "Bulbul", "بلبل"],
          ["swallow", "Swallow", "سنونو"],
          ["sparrow", "Sparrow", "دوري"],
        ),
      },
      {
        key: "light",
        label: "Light",
        labelAr: "الضوء",
        options: opts(
          ["dawn", "Dawn", "فجر"],
          ["golden", "Golden", "أصيل"],
          ["dusk", "Dusk", "غسق"],
        ),
      },
    ],
  },
  "pet-rock": {
    id: "pet-rock",
    name: "Pet Rock",
    nameAr: "الصخرة الأليفة",
    tagline: "It does nothing. It's yours forever.",
    taglineAr: "لا تفعل شيئًا، وهي لك للأبد",
    variants: [
      {
        key: "rock",
        label: "Rock",
        labelAr: "الصخرة",
        options: opts(
          ["granite", "Granite", "جرانيت"],
          ["sandstone", "Sandstone", "حجر رملي"],
          ["geode", "Geode", "جيود"],
        ),
      },
      {
        key: "eyes",
        label: "Eyes",
        labelAr: "العيون",
        options: opts(
          ["googly", "Googly", "متحرّكة"],
          ["sleepy", "Sleepy", "نعسانة"],
          ["heart", "Heart", "قلبية"],
        ),
      },
    ],
  },
  scoreboard: {
    id: "scoreboard",
    name: "Scoreboard",
    nameAr: "لوحة النتائج",
    tagline: "Final score: you were right. Again.",
    taglineAr: "النتيجة النهائية: الحقّ معك… مرّة أخرى",
    variants: [
      {
        key: "finish",
        label: "Finish",
        labelAr: "الطلاء",
        options: opts(
          ["cream", "Cream", "كريمي"],
          ["navy", "Navy", "كحلي"],
          ["chrome", "Chrome", "كروم"],
        ),
      },
    ],
  },
  "excuse-machine": {
    id: "excuse-machine",
    name: "The Excuse Machine",
    nameAr: "آلة الأعذار",
    tagline: "Pull the lever until it runs out of excuses",
    taglineAr: "اسحب الذراع حتى تنفد الأعذار",
    variants: [
      {
        key: "cabinet",
        label: "Cabinet",
        labelAr: "الآلة",
        options: opts(
          ["chrome", "Chrome", "كروم"],
          ["cherry", "Cherry", "كرزي"],
          ["brass", "Brass", "نحاسي"],
        ),
      },
      {
        key: "reels",
        label: "Reels",
        labelAr: "البكرات",
        options: opts(
          ["fruit", "Fruit", "فواكه"],
          ["hearts", "Hearts", "قلوب"],
          ["question", "Question marks", "علامات استفهام"],
        ),
      },
    ],
  },
  "burnt-dinner": {
    id: "burnt-dinner",
    name: "Dinner Is Served",
    nameAr: "العشاء جاهز",
    tagline: "I cooked. I'm sorry. Let's order in.",
    taglineAr: "طبختُ لك… أعتذر، لنطلب من الخارج",
    variants: [
      {
        key: "dish",
        label: "Dish",
        labelAr: "الطبق",
        options: opts(
          ["roast", "Roast", "مشوي"],
          ["cake", "Cake", "كعكة"],
          ["pasta", "Pasta", "معكرونة"],
        ),
      },
      {
        key: "kitchen",
        label: "Kitchen",
        labelAr: "المطبخ",
        options: opts(
          ["cozy", "Cozy", "دافئ"],
          ["marble", "Marble", "رخامي"],
          ["candlelit", "Candlelit", "على ضوء الشموع"],
        ),
      },
    ],
  },
  "big-screen": {
    id: "big-screen",
    name: "Big Screen",
    nameAr: "الشاشة الكبيرة",
    tagline: "Sixty thousand people, and the camera found you",
    taglineAr: "ستون ألفًا، والكاميرا وجدتكما أنتما",
    variants: [
      {
        key: "stadium",
        label: "Stadium",
        labelAr: "الملعب",
        options: opts(
          ["floodlit", "Floodlit", "أضواء ليلية"],
          ["sunset", "Sunset", "غروب"],
          ["indoor", "Indoor", "صالة مغلقة"],
        ),
      },
      {
        key: "frame",
        label: "Frame",
        labelAr: "الإطار",
        options: opts(
          ["hearts", "Hearts", "قلوب"],
          ["confetti", "Confetti", "قصاصات"],
          ["fireworks", "Fireworks", "ألعاب نارية"],
        ),
      },
    ],
  },
  // ---- Batch 5: occasions the gallery couldn't answer (thanks, get well, graduation, Eid) ----
  receipt: {
    id: "receipt",
    name: "Receipt of Thanks",
    nameAr: "فاتورة الجميل",
    tagline: "Itemised. Unpayable.",
    taglineAr: "مفصّلة… ولا تُسدَّد",
    variants: [
      {
        key: "paper",
        label: "Paper",
        labelAr: "الورق",
        options: opts(
          ["white", "White", "أبيض"],
          ["pink", "Pink", "وردي"],
          ["canary", "Canary", "أصفر"],
        ),
      },
      {
        key: "printer",
        label: "Printer",
        labelAr: "الطابعة",
        options: opts(
          ["charcoal", "Charcoal", "فحمي"],
          ["cream", "Cream", "كريمي"],
          ["mint", "Mint", "نعناعي"],
        ),
      },
    ],
  },
  bakhoor: {
    id: "bakhoor",
    name: "Mabkhara",
    nameAr: "المبخرة",
    tagline: "Your words, in the smoke that welcomes guests",
    taglineAr: "كلماتك في الدخان الذي يستقبل الضيوف",
    variants: [
      {
        key: "burner",
        label: "Burner",
        labelAr: "المبخرة",
        options: opts(
          ["wood", "Carved wood", "خشب منقوش"],
          ["silver", "Silver", "فضة"],
          ["ceramic", "Ceramic", "خزف"],
        ),
      },
      {
        key: "scent",
        label: "Scent",
        labelAr: "العطر",
        options: opts(
          ["oud", "Oud", "عود"],
          ["rose", "Rose", "ورد"],
          ["musk", "Musk", "مسك"],
        ),
      },
    ],
  },
  plaster: {
    id: "plaster",
    name: "Get-Well Plaster",
    nameAr: "لزقة الشفاء",
    tagline: "Peel slowly. It's healed.",
    taglineAr: "انزعها بهدوء… لقد طاب",
    variants: [
      {
        key: "plaster",
        label: "Plaster",
        labelAr: "اللزقة",
        options: opts(
          ["classic", "Classic", "كلاسيكية"],
          ["stars", "Stars", "نجوم"],
          ["clear", "Clear", "شفافة"],
        ),
      },
      {
        key: "heart",
        label: "Heart",
        labelAr: "القلب",
        options: opts(
          ["red", "Red", "أحمر"],
          ["pink", "Pink", "وردي"],
          ["blue", "Blue", "أزرق"],
        ),
      },
    ],
  },
  mortarboard: {
    id: "mortarboard",
    name: "Cap Toss",
    nameAr: "رمية التخرّج",
    tagline: "Throw it high. You earned the sky.",
    taglineAr: "ارمِها عاليًا… السماء لك",
    variants: [
      {
        key: "cap",
        label: "Cap",
        labelAr: "القبعة",
        options: opts(
          ["black", "Black", "أسود"],
          ["navy", "Navy", "كحلي"],
          ["maroon", "Maroon", "عنّابي"],
        ),
      },
      {
        key: "tassel",
        label: "Tassel",
        labelAr: "الشرّابة",
        options: opts(
          ["gold", "Gold", "ذهبي"],
          ["silver", "Silver", "فضي"],
          ["crimson", "Crimson", "قرمزي"],
        ),
      },
    ],
  },
  "paper-plane": {
    id: "paper-plane",
    name: "Paper Plane",
    nameAr: "طيّارة ورق",
    tagline: "Thrown from far away, landed right here",
    taglineAr: "رُميت من بعيد… وهبطت هنا تمامًا",
    variants: [
      {
        key: "paper",
        label: "Paper",
        labelAr: "الورق",
        options: opts(
          ["notebook", "Notebook", "دفتر"],
          ["airmail", "Airmail", "بريد جوي"],
          ["kraft", "Kraft", "ورق بنّي"],
        ),
      },
      {
        key: "sky",
        label: "Sky",
        labelAr: "السماء",
        options: opts(
          ["morning", "Morning", "صباح"],
          ["sunset", "Sunset", "غروب"],
          ["night", "Night", "ليل"],
        ),
      },
    ],
  },
  maamoul: {
    id: "maamoul",
    name: "Ma'amoul Mold",
    nameAr: "قالب المعمول",
    tagline: "Knock it out, the pattern is yours",
    taglineAr: "اطرقه… والنقش لك",
    variants: [
      {
        key: "mold",
        label: "Mold",
        labelAr: "القالب",
        options: opts(
          ["date", "Date (round)", "تمر (مدوّر)"],
          ["pistachio", "Pistachio (oval)", "فستق (بيضاوي)"],
          ["walnut", "Walnut (cone)", "جوز (مخروطي)"],
        ),
      },
      {
        key: "board",
        label: "Board",
        labelAr: "اللوح",
        options: opts(
          ["walnut", "Walnut wood", "خشب الجوز"],
          ["olive", "Olive wood", "خشب الزيتون"],
          ["marble", "Marble", "رخام"],
        ),
      },
    ],
  },
};

// Occasion tags per scene — one editable block instead of a field scattered
// across 34 entries. Every catalog id must appear with ≥1 occasion, or the
// scene shows only under "All" (registry.ts warns in dev if one is missed).
export const occasionsById: Record<string, Occasion[]> = {
  qalam: ["thanks", "love"],
  tatreez: ["thanks", "love"],
  fanous: ["celebration"],
  "neon-sign": ["love", "thinking-of-you"],
  typewriter: ["apology", "thinking-of-you"],
  "domino-run": ["congrats"],
  oud: ["love", "thanks", "celebration"],
  "wax-seal": ["apology", "love"],
  hourglass: ["apology", "thinking-of-you"],
  falcon: ["congrats", "thinking-of-you"],
  "eternal-rose": ["love"],
  moonflower: ["love"],
  fireworks: ["celebration", "congrats", "birthday"],
  "snow-globe": ["thinking-of-you"],
  "birthday-cake": ["birthday"],
  constellation: ["love", "thinking-of-you"],
  "butterfly-jar": ["thinking-of-you"],
  "lantern-sky": ["celebration", "love"],
  "balloon-bunch": ["birthday", "congrats"],
  "message-bottle": ["love", "apology"],
  "music-box": ["love"],
  "golden-locket": ["love"],
  "shooting-gallery": ["birthday", "thinking-of-you"],
  "magic-lamp": ["thinking-of-you", "birthday"],
  "foggy-mirror": ["love", "apology"],
  astrolabe: ["thinking-of-you", "congrats"],
  "scratch-card": ["congrats", "birthday"],
  "claw-machine": ["birthday", "love"],
  pinata: ["birthday", "celebration"],
  mixtape: ["love", "thinking-of-you"],
  matchbox: ["thinking-of-you"],
  "koi-pond": ["love", "thinking-of-you"],
  "cup-reading": ["thinking-of-you", "love"],
  aurora: ["love", "thinking-of-you"],
  henna: ["anniversary", "celebration"],
  "two-halves": ["love", "anniversary"],
  "shadow-play": ["love"],
  fingerprint: ["love", "anniversary"],
  nest: ["love", "congrats"],
  "pet-rock": ["funny", "thinking-of-you"],
  scoreboard: ["funny", "anniversary"],
  "excuse-machine": ["funny", "apology"],
  "burnt-dinner": ["funny", "apology"],
  "big-screen": ["funny", "love"],
  receipt: ["thanks", "funny"],
  bakhoor: ["celebration", "thanks"],
  plaster: ["get-well", "apology"],
  mortarboard: ["graduation", "congrats"],
  "paper-plane": ["thinking-of-you", "love"],
  maamoul: ["celebration", "thanks"],
};
