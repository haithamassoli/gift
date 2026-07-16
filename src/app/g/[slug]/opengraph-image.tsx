import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImageResponse } from "next/og";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";

export const alt = "A gift for you";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Fonts are read lazily on the first image request and cached — NEVER at module
// scope. Next imports this file to resolve the /g/[slug] page's og:image metadata,
// so a top-level read that throws crashes the *page* render (React #441 "Server
// Components render"), not just the image. Keeping the module import side-effect-free
// decouples the page from the OG card entirely. fileURLToPath keeps the path
// module-relative (Vercel traces fonts/ next to this file, not at cwd) while handing
// node:fs a string — some runtimes reject a Web URL instance here.
// The two readFile paths are spelled out as separate STRING LITERALS on
// purpose — Turbopack/webpack only emit the asset behind `new URL(x,
// import.meta.url)` when x is statically analyzable. Collapsing these into a
// `${file}` template makes the bundler emit a directory context and resolve to
// the wrong variant at runtime (satori: "Unsupported OpenType signature wOF2").
// Keep them literal. See [[og-image-fonts-import-meta-url]].
let fontsPromise: Promise<[Buffer, Buffer]> | null = null;
function loadFonts() {
  fontsPromise ??= Promise.all([
    readFile(
      fileURLToPath(
        new URL("../../../../fonts/thmanyahsans-Bold.otf", import.meta.url),
      ),
    ),
    readFile(
      fileURLToPath(
        new URL("../../../../fonts/thmanyahsans-Regular.otf", import.meta.url),
      ),
    ),
  ]);
  return fontsPromise;
}

// The logo's bow-star (Logo.tsx). Rendered as inline SVG — the card's wax seal.
const SPARK =
  "M0 -8.5 C.6 -3.4 3.4 -.6 8.5 0 C3.4 .6 .6 3.4 0 8.5 C-.6 3.4 -3.4 .6 -8.5 0 C-3.4 -.6 -.6 -3.4 0 -8.5 Z";

function Spark({ s, id }: { s: number; id: string }) {
  return (
    <svg width={s} height={s} viewBox="-10 -10 20 20">
      <defs>
        <linearGradient
          id={id}
          x1="0"
          y1="-10"
          x2="0"
          y2="10"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffe9c4" />
          <stop offset="0.55" stopColor="#fb7185" />
          <stop offset="1" stopColor="#e11d48" />
        </linearGradient>
      </defs>
      <path d={SPARK} fill={`url(#${id})`} />
    </svg>
  );
}

// Satori renders the space between two Arabic words ~1.2em wide (each RTL run
// gets padded at its shaping boundary), so pure-Arabic strings are split into
// per-word flex children with a controlled gap. CAUTION: Satori bidi-reorders
// those chunk rows correctly in the exact row structures used below (verified
// by screenshot for the name row, from row, and CTA pill) but NOT in every flex
// shape — a structurally new Arabic chunk row must be re-verified visually, and
// so must these on any next/og upgrade. Single-word labels (إلى / من) and
// mixed/Latin strings stay single nodes: single-node bidi is always ordered
// correctly, its spaces are just wide. Never NBSP-join instead — that crashes
// Satori's Arabic shaper, see [[og-image-arabic-rtl]].
const pureAr = (s: string) => /^[؀-ۿ\s]+$/.test(s);
const words = (s: string): string[] =>
  pureAr(s) ? s.trim().split(/\s+/) : [s];

// Deterministic mote scatter (x, y, size, gold?, opacity) — kept symmetric enough
// that the same coordinates read fine mirrored under RTL.
const MOTES: [number, number, number, boolean, number][] = [
  [150, 92, 5, true, 0.5],
  [315, 158, 3, false, 0.4],
  [556, 96, 4, false, 0.35],
  [700, 210, 3, true, 0.4],
  [1064, 122, 5, true, 0.55],
  [1132, 342, 3, false, 0.4],
  [962, 524, 4, true, 0.3],
  [242, 472, 3, false, 0.35],
  [92, 302, 3, true, 0.3],
];

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  let gift = null;
  try {
    gift = await convex.query(api.gifts.getGift, { slug });
  } catch {
    // Convex unreachable — fall through to the generic card, short cache below.
  }

  const ar = (gift?.lang ?? "en") === "ar";
  const sealed = gift?.openAfter != null && gift.openAfter > Date.now();
  // The card is the outside of the parcel: address only, never the contents.
  // No catalog import — the gift type must not leak into the preview.
  const recipient = gift?.recipientName ?? "You";
  // Ar labels are single words on purpose: Satori reorders chunked Arabic rows
  // inconsistently (see `words`), and one-word labels have nothing to reorder.
  // "إلى / من" also reads exactly like an Arabic parcel address.
  const eyebrow = ar ? "إلى" : "A GIFT FOR";
  const fromLabel = ar ? "من" : "from";
  const sender = gift?.senderName ?? "someone who knows you";
  const cta = sealed
    ? (ar ? "تُفتح " : "Opens ") +
      new Intl.DateTimeFormat(ar ? "ar" : "en", { dateStyle: "long" }).format(
        new Date(gift!.openAfter!),
      )
    : ar
      ? "اضغط لفتحها"
      : "Tap to unwrap";
  const wordmark = ar ? "هدية" : "Gift";

  const nameSize =
    recipient.length <= 10
      ? 112
      : recipient.length <= 16
        ? 92
        : recipient.length <= 24
          ? 74
          : 58;

  // Ribbon crossing = seal position. Mirrored by hand for RTL: yoga flips flex
  // order under `direction`, but absolute left/top offsets stay physical.
  const cx = ar ? 336 : 864;
  const cy = 316;

  const [bold, regular] = await loadFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          // RTL for Arabic word order. Do NOT hand-roll bidi by NBSP-joining
          // words: Satori's Arabic shaper crashes (codePointAt of undefined) on
          // some NBSP-joined runs. `direction` lets it shape + order correctly.
          direction: ar ? "rtl" : "ltr",
          backgroundColor: "#100b14",
          fontFamily: "Thmanyah Sans",
          color: "#e7e5e4",
        }}
      >
        {/* Ambient light: candle-warm corner + rose floor glow. Satori has no
            `inset` shorthand — every overlay spells out all four sides. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundImage: `radial-gradient(circle at ${ar ? "82%" : "18%"} 10%, rgba(255,233,196,0.08), rgba(255,233,196,0) 55%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundImage:
              "radial-gradient(circle at 50% 120%, rgba(244,63,94,0.10), rgba(244,63,94,0) 60%)",
          }}
        />

        {/* Vignette pulls the eye inward — painted UNDER the ribbons and motes so
            the wrap stays luminous at the edges */}
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundImage:
              "radial-gradient(circle at 50% 42%, rgba(7,4,10,0) 45%, rgba(7,4,10,0.7) 100%)",
          }}
        />

        {/* Ribbon bands wrapping the parcel; a satin hairline runs down each center */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: cx - 58,
            width: 116,
            display: "flex",
            justifyContent: "center",
            backgroundImage:
              "linear-gradient(90deg, rgba(251,113,133,0) 0%, rgba(251,113,133,0.13) 30%, rgba(251,113,133,0.22) 50%, rgba(251,113,133,0.13) 70%, rgba(251,113,133,0) 100%)",
          }}
        >
          <div style={{ width: 2, height: "100%", backgroundColor: "rgba(253,164,175,0.42)" }} />
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: cy - 58,
            height: 116,
            display: "flex",
            alignItems: "center",
            backgroundImage:
              "linear-gradient(180deg, rgba(251,113,133,0) 0%, rgba(251,113,133,0.13) 30%, rgba(251,113,133,0.22) 50%, rgba(251,113,133,0.13) 70%, rgba(251,113,133,0) 100%)",
          }}
        >
          <div style={{ width: "100%", height: 2, backgroundColor: "rgba(253,164,175,0.42)" }} />
        </div>

        {/* Motes drifting toward the seal */}
        {MOTES.map(([x, y, s, gold, o], i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: s,
              height: s,
              borderRadius: s,
              backgroundColor: gold
                ? `rgba(255,223,163,${o})`
                : `rgba(253,164,175,${o})`,
            }}
          />
        ))}

        {/* The seal: halo, bow-star, satellite spark */}
        <div
          style={{
            position: "absolute",
            left: cx - 320,
            top: cy - 320,
            width: 640,
            height: 640,
            backgroundImage:
              "radial-gradient(circle at 50% 50%, rgba(244,63,94,0.10), rgba(244,63,94,0) 62%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: cx - 180,
            top: cy - 180,
            width: 360,
            height: 360,
            backgroundImage:
              "radial-gradient(circle at 50% 50%, rgba(255,223,163,0.30) 0%, rgba(244,63,94,0.12) 40%, rgba(244,63,94,0) 66%)",
          }}
        />
        <div style={{ position: "absolute", left: cx - 64, top: cy - 64, display: "flex" }}>
          <Spark s={128} id="seal" />
        </div>
        <div
          style={{
            position: "absolute",
            left: cx + (ar ? -98 : 68),
            top: cy - 92,
            display: "flex",
          }}
        >
          <Spark s={30} id="sat" />
        </div>

        {/* Hairline frame — the edge of the parcel label */}
        <div
          style={{
            position: "absolute",
            top: 26,
            right: 26,
            bottom: 26,
            left: 26,
            border: "1px solid rgba(255,233,196,0.13)",
            borderRadius: 26,
          }}
        />

        {/* Address block: TO / name / FROM. Satori's `direction: rtl` bidi-reorders
            rows of pure text children but does NOT mirror yoga layout, so the
            block is pinned to the reading side by hand. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: ar ? "flex-end" : "flex-start",
            padding: "0 88px",
            gap: 22,
          }}
        >
          {/* Structure mirrors the CTA pill exactly (display flex + gap, no
              flexDirection, no letterSpacing in ar) — the one shape Satori
              reliably bidi-reorders chunked Arabic words in. letterSpacing
              (even 0) forces a per-glyph path that skips reordering. */}
          <div
            style={{
              display: "flex",
              gap: 0,
              fontSize: ar ? 34 : 26,
              color: "rgba(255,233,196,0.62)",
              ...(ar ? {} : { letterSpacing: 7 }),
            }}
          >
            {words(eyebrow).map((w, i) => (
              <div key={i} style={{ display: "flex" }}>
                {w}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: ar ? "flex-end" : "flex-start",
              maxWidth: 660,
              // Chunked ar words carry ~0.3em phantom advance from the shaper;
              // a small gap on top of that lands at a natural word space.
              gap: ar ? Math.round(nameSize * 0.06) : 0,
              fontSize: nameSize,
              fontWeight: 700,
              lineHeight: 1.08,
              wordBreak: "break-word",
            }}
          >
            {words(recipient).map((w, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  backgroundImage:
                    "linear-gradient(180deg, #fff6e8 10%, #ffd9a8 46%, #fb7d95 100%)",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                {w}
              </div>
            ))}
          </div>
          {/* Satori only bidi-reorders the two-node row when every child is
              Arabic; an ar card with a Latin sender ("من Suleiman") must be a
              single node or من lands on the wrong side. */}
          {ar && !pureAr(sender) ? (
            <div style={{ display: "flex", maxWidth: 660, fontSize: 33, color: "#fda4af" }}>
              {`${fromLabel} ${sender}`}
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                flexWrap: "wrap",
                justifyContent: ar ? "flex-end" : "flex-start",
                maxWidth: 660,
                gap: ar ? 10 : 12,
                fontSize: 33,
              }}
            >
              <div style={{ display: "flex", color: "#a8a29e" }}>{fromLabel}</div>
              {words(sender).map((w, i) => (
                <div key={i} style={{ display: "flex", color: "#fda4af" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bottom rail: wordmark ↔ unwrap pill. Rows with non-text children don't
            auto-flip under rtl, so the mirror is hand-rolled via row-reverse. */}
        <div
          style={{
            position: "absolute",
            left: 88,
            right: 88,
            bottom: 54,
            display: "flex",
            flexDirection: ar ? "row-reverse" : "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: ar ? "row-reverse" : "row",
              alignItems: "center",
              gap: 13,
            }}
          >
            <Spark s={38} id="mark" />
            <div style={{ display: "flex", fontSize: 31, fontWeight: 700, color: "rgba(231,229,228,0.92)" }}>
              {wordmark}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: 62,
              padding: "0 34px",
              borderRadius: 31,
              fontSize: 27,
              fontWeight: 700,
              gap: ar ? 0 : 9,
              ...(sealed
                ? {
                    border: "2px solid rgba(253,164,175,0.5)",
                    backgroundColor: "rgba(244,63,94,0.08)",
                    color: "#fda4af",
                  }
                : {
                    backgroundColor: "#f43f5e",
                    color: "#ffffff",
                    boxShadow: "0 4px 28px rgba(244,63,94,0.5)",
                  }),
            }}
          >
            {words(cta).map((w, i) => (
              <div key={i} style={{ display: "flex" }}>
                {w}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Thmanyah Sans", data: bold, weight: 700, style: "normal" },
        { name: "Thmanyah Sans", data: regular, weight: 400, style: "normal" },
      ],
      // Success keeps ImageResponse's immutable year-long default (gift fields
      // never change) — except while time-locked: expire at openAfter so the
      // card flips from "Opens …" to the unwrap CTA once the lock passes.
      // A missing/failed gift must not be pinned for a year either.
      ...(gift
        ? sealed
          ? {
              headers: {
                "cache-control": `public, max-age=${Math.min(
                  Math.max(Math.ceil((gift.openAfter! - Date.now()) / 1000), 60),
                  31536000,
                )}`,
              },
            }
          : {}
        : { headers: { "cache-control": "public, max-age=300" } }),
    },
  );
}
