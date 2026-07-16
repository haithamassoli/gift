import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

/** HTML-escape user-supplied values before interpolating into markup. */
function escape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const http = httpRouter();

http.route({
  pathPrefix: "/g/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const pathname = new URL(req.url).pathname;
    const segments = pathname.split("/").filter((s) => s.length > 0);
    const slug = segments[segments.length - 1] ?? "";

    const gift = await ctx.runQuery(api.gifts.getGift, { slug });

    const canonical = "https://gift.assoli.site/g/" + slug;
    // Per-gift card rendered by src/app/g/[slug]/opengraph-image.tsx; the
    // two-segment path doesn't match the /g/:slug crawler rewrite, so Next
    // serves it even to crawler user-agents.
    const image = canonical + "/opengraph-image";

    let title: string;
    if (gift) {
      const sender = escape(gift.senderName);
      const recipient = escape(gift.recipientName);
      title =
        gift.lang === "ar"
          ? "هدية من " + sender + " إلى " + recipient + " 🎁"
          : sender + " made " + recipient + " a gift 🎁";
    } else {
      title = "Someone made you a gift 🎁";
    }

    const description = "Tap to unwrap it.";

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${canonical}">
</head>
<body>
<p><a href="${canonical}">Open your gift</a></p>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  }),
});

export default http;
