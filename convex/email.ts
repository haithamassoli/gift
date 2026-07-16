import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Module-scoped so process.env typechecks under both the Convex (node) build and
// the frontend app build, which pulls this file in via the generated api types.
declare const process: { env: Record<string, string | undefined> };

// Escape user-supplied text before interpolating it into HTML (trust
// boundary). The regex only matches these 4 chars; `?? c` keeps it type-safe.
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
const wrap = (dir: string, inner: string) =>
  `<div dir="${dir}" style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">${inner}</div>`;
const button = (link: string, label: string) =>
  `<p style="margin:24px 0"><a href="${link}" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-size:15px">${label}</a></p>`;

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
    const name = esc(args.recipientName);

    let subject: string;
    let text: string;
    let html: string;
    if (args.lang === "ar") {
      subject = args.recipientName + " فتح هديتك 🎁";
      text = args.recipientName + " فتح هديتك 🎁\n\n" + link;
      html = wrap(
        "rtl",
        `<p style="font-size:16px;line-height:1.5"><strong>${name}</strong> فتح الهدية التي أرسلتها 🎁</p>` +
          `<p style="font-size:16px;line-height:1.5">يمكنك العودة إلى ما صنعته ومتابعة حالته في أي وقت:</p>` +
          button(link, "عرض هديتك") +
          `<p style="font-size:13px;color:#666;line-height:1.5">وصلتك هذه الرسالة لأنك طلبت إشعارك عند فتح هذه الهدية.</p>`,
      );
    } else {
      subject = args.recipientName + " opened your gift 🎁";
      text = args.recipientName + " opened your gift 🎁\n\n" + link;
      html = wrap(
        "ltr",
        `<p style="font-size:16px;line-height:1.5"><strong>${name}</strong> just opened the gift you sent them 🎁</p>` +
          `<p style="font-size:16px;line-height:1.5">Revisit what you made and see its status any time:</p>` +
          button(link, "View your gift") +
          `<p style="font-size:13px;color:#666;line-height:1.5">You're getting this because you asked to be notified when this gift was opened.</p>`,
      );
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
          html,
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

// Sent to the recipient at the scheduled unlock, on the sender's behalf.
export const sendGiftLink = internalAction({
  args: {
    email: v.string(),
    recipientName: v.string(),
    senderName: v.string(),
    slug: v.string(),
    lang: v.string(),
  },
  handler: async (_ctx, args) => {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error("sendGiftLink: RESEND_API_KEY is not set; skipping email");
      return null;
    }

    const link = "https://gift.assoli.site/g/" + args.slug;
    const recipient = esc(args.recipientName);
    const sender = esc(args.senderName);

    let subject: string;
    let text: string;
    let html: string;
    if (args.lang === "ar") {
      subject = args.senderName + " صنع لك هدية 🎁";
      text = args.senderName + " صنع لك هدية 🎁\n\n" + link;
      html = wrap(
        "rtl",
        `<p style="font-size:16px;line-height:1.5">مرحبًا <strong>${recipient}</strong>،</p>` +
          `<p style="font-size:16px;line-height:1.5"><strong>${sender}</strong> صنع لك هدية، وقد حان وقت فتحها 🎁</p>` +
          button(link, "افتح هديتك") +
          `<p style="font-size:13px;color:#666;line-height:1.5">وصلتك هذه الرسالة لأن ${sender} حدّد هذا الموعد لتصلك هديته.</p>`,
      );
    } else {
      subject = args.senderName + " made you a gift 🎁";
      text = args.senderName + " made you a gift 🎁\n\n" + link;
      html = wrap(
        "ltr",
        `<p style="font-size:16px;line-height:1.5">Hi <strong>${recipient}</strong>,</p>` +
          `<p style="font-size:16px;line-height:1.5"><strong>${sender}</strong> made you a gift, and it's ready to open 🎁</p>` +
          button(link, "Open your gift") +
          `<p style="font-size:13px;color:#666;line-height:1.5">You're getting this because ${sender} scheduled this gift to reach you now.</p>`,
      );
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
          html,
        }),
      });
      if (!res.ok) {
        console.error(
          "sendGiftLink: Resend returned " + res.status,
          await res.text(),
        );
      }
    } catch (err) {
      console.error("sendGiftLink: failed to send email", err);
    }
    return null;
  },
});

// Sent to the sender's notify email when the recipient writes a thank-you.
export const sendReplied = internalAction({
  args: {
    email: v.string(),
    recipientName: v.string(),
    reply: v.string(),
    statusKey: v.string(),
    lang: v.string(),
  },
  handler: async (_ctx, args) => {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.error("sendReplied: RESEND_API_KEY is not set; skipping email");
      return null;
    }

    const link = "https://gift.assoli.site/sent/" + args.statusKey;
    const name = esc(args.recipientName);
    // pre-wrap keeps the recipient's line breaks without injecting <br> tags.
    const quote =
      `<blockquote style="margin:16px 0;padding:12px 16px;background:#f6f6f6;border-radius:8px;font-size:15px;line-height:1.5;white-space:pre-wrap">` +
      esc(args.reply) +
      `</blockquote>`;

    let subject: string;
    let text: string;
    let html: string;
    if (args.lang === "ar") {
      subject = args.recipientName + " أرسل لك رسالة شكر 💌";
      text =
        args.recipientName +
        " أرسل لك رسالة شكر 💌\n\n" +
        args.reply +
        "\n\n" +
        link;
      html = wrap(
        "rtl",
        `<p style="font-size:16px;line-height:1.5"><strong>${name}</strong> ردّ على الهدية التي أرسلتها 💌</p>` +
          quote +
          button(link, "شاهدها") +
          `<p style="font-size:13px;color:#666;line-height:1.5">وصلتك هذه الرسالة لأنك طلبت إشعارك بشأن هذه الهدية.</p>`,
      );
    } else {
      subject = args.recipientName + " sent a thank-you 💌";
      text =
        args.recipientName +
        " sent a thank-you 💌\n\n" +
        args.reply +
        "\n\n" +
        link;
      html = wrap(
        "ltr",
        `<p style="font-size:16px;line-height:1.5"><strong>${name}</strong> wrote back about the gift you sent them 💌</p>` +
          quote +
          button(link, "See it") +
          `<p style="font-size:13px;color:#666;line-height:1.5">You're getting this because you asked to be notified about this gift.</p>`,
      );
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
          html,
        }),
      });
      if (!res.ok) {
        console.error(
          "sendReplied: Resend returned " + res.status,
          await res.text(),
        );
      }
    } catch (err) {
      console.error("sendReplied: failed to send email", err);
    }
    return null;
  },
});
