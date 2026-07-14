import { useEffect, useState } from "react";

// 3D scenes rasterize text to a canvas exactly once (in useMemo). If Thmanyah
// hasn't loaded yet, that one-time raster falls back to system-ui and never
// re-runs — so the branded font would be lost. Gate the scene mount on this
// until the font is ready. The scene weights (400–900) are all loaded so the
// bold titles get the right face too.
const WEIGHTS = ["400", "500", "700", "900"];

export function useArabicFontReady(active: boolean): boolean {
  const [ready, setReady] = useState(
    () => !active || (typeof document !== "undefined" && document.fonts.check('700 1em "Thmanyah Sans"')),
  );

  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    void Promise.all(WEIGHTS.map((w) => document.fonts.load(`${w} 1em "Thmanyah Sans"`))).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [active, ready]);

  return ready;
}
