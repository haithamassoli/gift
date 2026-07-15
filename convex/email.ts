import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Module-scoped so process.env typechecks under both the Convex (node) build and
// the frontend app build, which pulls this file in via the generated api types.
declare const process: { env: Record<string, string | undefined> };

// ponytail: read the key from process.env directly; the guidelines' typed-env
// (defineApp({ env }) in convex.config.ts + `env` from ./_generated/server) is
// the upgrade path if we ever want compile-time env validation.
export const sendOpened = internalAction({
  args: {
    email: v.string(),
    recipientName: v.string(),
    statusKey: v.string(),
    lang: v.string(),
  },
  handler: async (_ctx, args) => {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error("sendOpened: RESEND_API_KEY is not set; skipping email");
      return null;
    }

    const link = "https://gift.assoli.site/sent/" + args.statusKey;
    let subject: string;
    let text: string;
    if (args.lang === "ar") {
      subject = args.recipientName + " فتح هديتك 🎁";
      text = args.recipientName + " فتح هديتك 🎁\n\n" + link;
    } else {
      subject = args.recipientName + " opened your gift 🎁";
      text = args.recipientName + " opened your gift 🎁\n\n" + link;
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Gift <gift@mail.assoli.site>",
          to: args.email,
          subject,
          text,
        }),
      });
      if (!res.ok) {
        console.error(
          "sendOpened: Resend returned " + res.status,
          await res.text(),
        );
      }
    } catch (err) {
      console.error("sendOpened: failed to send email", err);
    }
    return null;
  },
});
