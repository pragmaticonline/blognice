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

export function registrationWelcomeEmail(input: { signInUrl: string; greeting?: string }) {
  const greeting = input.greeting?.trim() || "Hi there,";
  const url = htmlEscape(input.signInUrl);
  return {
    subject: "Welcome to blognice",
    plainText: `${greeting}\n\nWelcome to blognice!\n\nYour account is ready. Sign in to create and publish your first blog.\n\nThanks for signing up. blognice is a calmer, simpler way to write and publish online — no hosting to choose, no plugins to maintain, no control panel to learn. Just an editor and a page.\n\nSign in and start writing: ${input.signInUrl}\n\nYour first three steps\n1. Choose your address — your blog starts at a free blognice.com address; you can connect a domain you own later.\n2. Write your first post — draft in plain Markdown, check the Preview tab, then publish whenever you’re ready.\n3. Connect your domain, if you’d like — when you’re ready, add a domain you own from your dashboard.\n\nYour first blog is free to try. Up to five blogs, unlimited posts, and custom domains are available on the Pro plan when you’re ready — see pricing: https://www.blognice.com/#pricing\n\nNeed a hand? Reply to this email or contact ${PLATFORM_SUPPORT}`,
    html: `<h2 style="font-family:Arial,sans-serif;text-align:center">Welcome to blognice!</h2><p style="text-align:center;color:#687064;font-size:13px">Your account is ready. Sign in to create and publish your first blog.</p><p>${htmlEscape(greeting)}</p><p>Thanks for signing up. blognice is a calmer, simpler way to write and publish online — no hosting to choose, no plugins to maintain, no control panel to learn. Just an editor and a page.</p><p style="text-align:center;margin:24px 0"><a href="${url}" style="display:inline-block;background:#168b16;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:7px">Sign in and start writing</a></p><hr><p><strong>Your first three steps</strong></p><p><strong>1. Choose your address</strong><br><span style="color:#687064">Your blog starts at a free blognice.com address — you can connect a domain you own later.</span></p><p><strong>2. Write your first post</strong><br><span style="color:#687064">Draft in plain Markdown, check the Preview tab, then publish whenever you’re ready.</span></p><p><strong>3. Connect your domain, if you’d like</strong><br><span style="color:#687064">When you’re ready, add a domain you own from your dashboard.</span></p><p style="background:#f7f8f3;border:1px solid #e3e7dd;padding:14px;color:#5c6455">Your first blog is free to try. Up to five blogs, unlimited posts, and custom domains are available on the Pro plan when you’re ready — <a href="https://www.blognice.com/#pricing" style="color:#168b16;font-weight:700">see pricing</a>.</p><hr><p><strong>Need a hand?</strong><br>Reply to this email or contact <a href="mailto:${PLATFORM_SUPPORT}">${PLATFORM_SUPPORT}</a>.</p>`,
  };
}

export function invitationWelcomeEmail(input: { signInUrl: string; blogTitle: string; role: string }) {
  const title = htmlEscape(input.blogTitle);
  const url = htmlEscape(input.signInUrl);
  return {
    subject: `You're invited to ${input.blogTitle} on blognice`,
    plainText: `You’ve been invited to collaborate on ${input.blogTitle} on blognice.\n\nYour role: ${input.role}\n\nSign in to open the blog: ${input.signInUrl}\n\nYou can write and contribute according to the permissions set by the blog owner. If you did not expect this invitation, you can ignore this email.`,
    html: `<h2 style="font-family:Arial,sans-serif;text-align:center">You’re invited to collaborate</h2><p style="text-align:center;color:#687064;font-size:13px">${title} on blognice</p><p>Your role on <strong>${title}</strong> is <strong>${htmlEscape(input.role)}</strong>.</p><p style="text-align:center;margin:24px 0"><a href="${url}" style="display:inline-block;background:#168b16;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:7px">Open the blog</a></p><p>You can write and contribute according to the permissions set by the blog owner. If you did not expect this invitation, you can ignore this email.</p>`,
  };
}
export function subscriptionActiveEmail(input: { billingUrl: string; plan?: "monthly" | "yearly" }) {
  const url = htmlEscape(input.billingUrl);
  const plan = input.plan ? ` (${input.plan})` : "";
  return {
    subject: "Your blognice pro subscription is active",
    plainText: `Your blognice pro subscription is active${plan}.\n\nYou can now use AI features, collaborators, custom domains, favicons, and up to five blogs.\n\nManage billing: ${input.billingUrl}\n\nStripe will send your payment receipt separately.\n\nNeed a hand? Reply to this email or reach us at ${PLATFORM_SUPPORT}`,
    html: `<div style="text-align:center"><div style="display:inline-grid;place-items:center;width:64px;height:64px;margin:4px auto 18px;border-radius:50%;background:#168b16;color:#fff;box-shadow:0 5px 0 #dcebd8;font-size:34px;font-weight:700;line-height:64px">✓</div><h2 style="font-family:Arial,sans-serif;margin:0 0 14px">Your blognice pro subscription is active.</h2><p style="margin:0 auto;max-width:540px">You can now use AI features, collaborators, custom domains, favicons, and up to five blogs.</p><p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#168b16;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:7px">Manage billing</a></p></div><p style="background:#f7f8f3;border:1px solid #e3e7dd;padding:16px;text-align:center;color:#5c6455">Stripe will send your payment receipt separately.</p><hr><p><strong>Need a hand?</strong><br>Reply to this email or reach us at <a href="mailto:${PLATFORM_SUPPORT}">${PLATFORM_SUPPORT}</a>.</p>`,
  };
}

export function subscriberConfirmationEmail(input: { blogTitle: string; confirmUrl: string }) {
  const title = htmlEscape(input.blogTitle);
  const subjectTitle = input.blogTitle.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const url = htmlEscape(input.confirmUrl);
  return {
    subject: `Confirm your subscription to ${subjectTitle}`,
    plainText: `Please confirm your subscription to ${input.blogTitle}.\n\nConfirm your subscription: ${input.confirmUrl}\n\nThis link expires in 24 hours. If you did not request this, you can ignore this email — you won't be subscribed unless you confirm.`,
    html: `<div style="text-align:center"><h2 style="font-family:Arial,sans-serif;margin:0 0 24px">Confirm your subscription</h2><p>Please confirm your subscription to <strong>${title}</strong>.</p><p style="margin:26px 0"><a href="${url}" style="display:inline-block;background:#168b16;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:7px">Confirm subscription</a></p><p style="color:#687064;font-size:13px;margin:0 0 8px">Or copy and paste this link into your browser:</p><p style="font-family:monospace;font-size:12px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word;margin:0 0 24px"><a href="${url}" style="color:#168b16;overflow-wrap:anywhere;word-break:break-word">${url}</a></p></div><p style="background:#f7f8f3;border:1px solid #e3e7dd;padding:16px;color:#5c6455">This link expires in 24 hours. If you did not request this, you can ignore this email — you won't be subscribed unless you confirm.</p>`,
  };
}
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
