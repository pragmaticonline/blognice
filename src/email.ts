// Optional transactional email via MailNice, with Resend kept as a fallback.
//
// Everything else in Blog Nice works without this. Email turns on only when
// both secrets are set:
//   MAILNICE_API_KEY your MailNice server key (wrangler secret put MAILNICE_API_KEY)
//   RESEND_API_KEY   legacy Resend key (fallback)
//   EMAIL_FROM       a verified from-address, e.g. "The Blog <hello@blognice.com>"
//
// Sending from your own domain requires verifying it in Resend (SPF/DKIM), or
// deliverability will suffer. See the README.

import { sendMailNice } from "./mailnice";

export type EmailEnv = {
  MAILNICE_API_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

export function emailEnabled(env: EmailEnv): boolean {
  return !!(env.EMAIL_FROM && (env.MAILNICE_API_KEY || env.RESEND_API_KEY));
}

type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  plainText?: string;
  headers?: Record<string, string>;
  emailKind?: string;
  senderName?: string;
};

const PLATFORM_SUPPORT = "support@blognice.com";
const PLATFORM_PRIVACY = "https://www.blognice.com/privacy";
const PLATFORM_POSTAL = "Pragmatic Online Co., Ltd., Prego Mall, 229/14 Moo 8, Tonpao, San Kamphaeng, Chiang Mai 50130, Thailand";
function htmlEscape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }

function withIdentityFooter(msg: EmailMessage): EmailMessage {
  const sender = msg.senderName?.trim() || "blognice";
  const senderHtml = htmlEscape(sender);
  const bulk = msg.emailKind === "post-notification" || msg.emailKind === "subscription-welcome" || msg.emailKind === "subscriber-confirmation";
  const plainFooter = `\n\nSent by ${sender} via blognice.\nSupport: ${PLATFORM_SUPPORT}\nPrivacy: ${PLATFORM_PRIVACY}${bulk ? `\n\n${PLATFORM_POSTAL}` : ""}`;
  const htmlFooter = `<hr><p style="color:#687064;font-size:12px">Sent by ${senderHtml} via blognice · <a href="mailto:${PLATFORM_SUPPORT}">Support</a> · <a href="${PLATFORM_PRIVACY}">Privacy</a>${bulk ? `<br>${PLATFORM_POSTAL}` : ""}</p>`;
  const html = `<div style="margin:0;background:#f1f2ed;padding:32px 16px;font-family:Arial,sans-serif;color:#171914;line-height:1.55"><div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e3e7dd;border-radius:10px;overflow:hidden"><div style="padding:28px 32px 12px;text-align:center;font-size:20px;font-weight:700">blognice</div><div style="padding:0 32px 28px">${msg.html}${htmlFooter}</div></div></div>`;
  return { ...msg, plainText: `${msg.plainText || msg.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}${plainFooter}`, html };
}

export type EmailDeliveryResult = {
  ok: boolean;
  provider: "mailnice" | "resend" | "none";
  detail?: string;
};

export async function sendEmailDetailed(
  env: EmailEnv,
  msg: EmailMessage,
): Promise<EmailDeliveryResult> {
  if (!emailEnabled(env)) return { ok: false, provider: "none", detail: "Email integration is not configured." };
  const outgoing = withIdentityFooter(msg);
  if (env.MAILNICE_API_KEY) {
    const result = await sendMailNice(env, {
      to: outgoing.to,
      subject: outgoing.subject,
      plainBody: outgoing.plainText || "",
      html: outgoing.html,
      headers: outgoing.headers,
    });
    return { ...result, provider: "mailnice" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: outgoing.to,
        subject: outgoing.subject,
        html: outgoing.html,
        text: outgoing.plainText,
        headers: outgoing.headers,
      }),
    });
    return res.ok
      ? { ok: true, provider: "resend" }
      : { ok: false, provider: "resend", detail: `Resend returned HTTP ${res.status}.` };
  } catch (error) {
    return { ok: false, provider: "resend", detail: error instanceof Error ? error.message : "Resend request failed." };
  }
}

export async function sendEmail(env: EmailEnv, msg: EmailMessage): Promise<boolean> {
  return (await sendEmailDetailed(env, msg)).ok;
}
