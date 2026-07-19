import type { Lang } from "../i18n";

// Dummy gift copy for non-recipient previews (gallery auto-reveal, dev harness).
// Real copy, not lorem: the Arabic has to push actual shaping and rtl bidi
// through the same raster path a real gift takes.
export const SAMPLE: Record<
  Lang,
  { senderName: string; recipientName: string; message: string }
> = {
  en: {
    senderName: "Haitham",
    recipientName: "Layla",
    message:
      "Every year I go looking for words big enough for you, and every year I come back empty-handed. So here — take the whole sky instead.",
  },
  ar: {
    senderName: "هيثم",
    recipientName: "ليلى",
    message:
      "كل عام أبحث عن كلمات تليق بك، وكل عام أعود بلا شيء. فخذي هذه السماء كلها بدلًا منها.",
  },
};
