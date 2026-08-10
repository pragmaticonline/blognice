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

import { sendMailNice } from "./mailnice.ts";

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
const PLATFORM_TERMS = "https://www.blognice.com/terms";
const PLATFORM_SECURITY = "https://www.blognice.com/security";
const PLATFORM_POSTAL = "Pragmatic Online Co., Ltd., Prego Mall, 229/14 Moo 8, Tonpao, San Kamphaeng, Chiang Mai 50130, Thailand";
function htmlEscape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }
function safeSubjectText(value: string, fallback: string): string {
  const cleaned = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return cleaned || fallback;
}
function safeHeaderUrl(value: string): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, "").slice(0, 2000);
}

export function registrationWelcomeEmail(input: { signInUrl: string; greeting?: string }) {
  const greeting = input.greeting?.trim() || "Hi there,";
  const url = htmlEscape(input.signInUrl);
  return {
    subject: "Welcome to blognice",
    plainText: `${greeting}\n\nWelcome to blognice!\n\nYour account is ready. Sign in to create and publish your first blog.\n\nThanks for signing up. blognice is a calmer, simpler way to write and publish online — no hosting to choose, no plugins to maintain, no control panel to learn. Just an editor and a page.\n\nSign in and start writing: ${input.signInUrl}\n\nYour first three steps\n1. Choose your address — your blog starts at a free blognice.com address; you can connect a domain you own later.\n2. Write your first post — draft in plain Markdown, check the Preview tab, then publish whenever you’re ready.\n3. Connect your domain, if you’d like — when you’re ready, add a domain you own from your dashboard.\n\nYour first blog is free to try.\n\nNeed a hand? Reply to this email or contact ${PLATFORM_SUPPORT}`,
    html: `<h2 style="font-family:Arial,sans-serif;text-align:center;margin:0 0 6px;color:#181a12">Welcome to blognice!</h2><p style="text-align:center;color:#5c6455;font-size:14px;margin:0 0 28px">Your account is ready. Sign in to create and publish your first blog.</p><p>${htmlEscape(greeting)}</p><p>Thanks for signing up. blognice is a calmer, simpler way to write and publish online — no hosting to choose, no plugins to maintain, no control panel to learn. Just an editor and a page.</p><p style="text-align:center;margin:28px 0"><a href="${url}" style="display:inline-block;background:#1a8917;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:9px">Sign in and start writing</a></p><hr><p><strong>Your first three steps</strong></p><p><strong>1. Choose your address</strong><br><span style="color:#5c6455">Your blog starts at a free blognice.com address — you can connect a domain you own later.</span></p><p><strong>2. Write your first post</strong><br><span style="color:#5c6455">Draft in plain Markdown, check the Preview tab, then publish whenever you’re ready.</span></p><p><strong>3. Connect your domain, if you’d like</strong><br><span style="color:#5c6455">When you’re ready, add a domain you own from your dashboard.</span></p><hr><p><strong>Need a hand?</strong><br>Reply to this email or contact ${PLATFORM_SUPPORT}.</p>`,
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
    html: `<div style="text-align:center"><div style="display:inline-block;width:64px;height:64px;margin:4px auto 18px;border-radius:50%;background:#1a8917;color:#fff;box-shadow:0 0 0 6px #eef5ec;font-size:34px;font-weight:700;line-height:64px">✓</div><h2 style="font-family:Arial,sans-serif;margin:0 0 14px;color:#181a12">Your blognice pro subscription is active.</h2><p style="margin:0 auto;max-width:540px">You can now use AI features, collaborators, custom domains, favicons, and up to five blogs.</p><p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#1a8917;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:9px">Manage billing</a></p></div><p style="background:#f7f8f5;border:1px solid #e7e7e2;border-radius:10px;padding:16px;text-align:center;color:#5c6455">Stripe will send your payment receipt separately.</p><hr><p><strong>Need a hand?</strong><br>Reply to this email or contact ${PLATFORM_SUPPORT}.</p>`,
  };
}

export function subscriberConfirmationEmail(input: { blogTitle: string; confirmUrl: string }) {
  const title = htmlEscape(input.blogTitle);
  const subjectTitle = input.blogTitle.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const url = htmlEscape(input.confirmUrl);
  return {
    subject: `Confirm your subscription to ${safeSubjectText(subjectTitle, "this blog")}`,
    plainText: `Please confirm your subscription to ${input.blogTitle}.\n\nConfirm your subscription: ${input.confirmUrl}\n\nThis link expires in 24 hours. If you did not request this, you can ignore this email — you won't be subscribed unless you confirm.`,
    html: `<div style="text-align:center"><h2 style="font-family:Arial,sans-serif;margin:0 0 14px;color:#181a12">Confirm your subscription</h2><p>You're subscribing to <strong>${title}</strong> — confirm below to start getting new posts by email.</p><p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#1a8917;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:9px">Confirm subscription</a></p><p style="color:#9098a0;font-size:12.5px;margin:0 0 8px">Or copy and paste this link into your browser:</p><p style="font-family:monospace;font-size:11.5px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word;margin:0 0 24px;background:#f7f8f5;border:1px solid #e7e7e2;border-radius:8px;padding:10px 14px;text-align:left"><a href="${url}" style="color:#5c6455;overflow-wrap:anywhere;word-break:break-word">${url}</a></p></div><p style="background:#f7f8f5;border:1px solid #e7e7e2;border-radius:10px;padding:16px 18px;color:#5c6455">This link expires in 24 hours. If you did not request this, you can ignore this email — you won't be subscribed unless you confirm.</p>`,
  };
}

export function passwordResetEmail(input: { resetUrl: string }) {
  const url = htmlEscape(input.resetUrl);
  return {
    subject: "Reset your blognice password",
    plainText: `We received a request to reset your blognice password.\n\nReset your password: ${input.resetUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email — your password will stay the same.\n\nNeed a hand? Reply to this email or contact ${PLATFORM_SUPPORT}`,
    html: `<h2 style="font-family:Arial,sans-serif;text-align:center;margin:0 0 14px;color:#181a12">Reset password</h2><p>We received a request to reset your blognice password.</p><p style="text-align:center;margin:28px 0"><a href="${url}" style="display:inline-block;background:#1a8917;color:#fff;text-decoration:none;padding:13px 30px;border-radius:9px;font-weight:700">Reset your password</a></p><p style="color:#9098a0;font-size:12.5px;text-align:center">Or copy and paste this link into your browser:</p><p style="font-family:monospace;font-size:11.5px;line-height:1.6;overflow-wrap:anywhere;word-break:break-all;text-align:center"><a href="${url}" style="color:#5c6455">${url}</a></p><p style="background:#fbf6e9;border:1px solid #f0e3b8;border-radius:10px;padding:16px 18px;color:#7a5c12">This link expires in one hour. If you did not request this, you can ignore this email — your password will stay the same.</p><hr><p><strong>Need a hand?</strong><br>Reply to this email or contact ${PLATFORM_SUPPORT}.</p>`,
  };
}

export function subscriberWelcomeEmail(input: { blogTitle: string; unsubscribeUrl: string; manageUrl: string }) {
  const title = htmlEscape(input.blogTitle);
  const unsub = htmlEscape(input.unsubscribeUrl);
  const manage = htmlEscape(input.manageUrl);
  return {
    subject: `You're subscribed to ${safeSubjectText(input.blogTitle, "this blog")}`,
    plainText: `Thanks for subscribing to ${input.blogTitle}. You'll get new posts by email.\n\nUnsubscribe: ${input.unsubscribeUrl}\nManage subscriptions: ${input.manageUrl}`,
    headers: { "List-Unsubscribe": `<${safeHeaderUrl(input.unsubscribeUrl)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    html: `<div style="text-align:center"><h2 style="font-family:Arial,sans-serif;margin:0 0 14px;color:#181a12">You're subscribed</h2><p>Thanks for subscribing to <strong>${title}</strong>. You'll get new posts by email.</p></div><hr><p style="text-align:center;color:#9098a0;font-size:12px"><a href="${unsub}" style="color:#9098a0">Unsubscribe</a> anytime · <a href="${manage}" style="color:#9098a0">Manage subscriptions</a></p>`,
  };
}

export function postNotificationEmail(input: { blogTitle: string; postTitle: string; postUrl: string; imageUrl?: string; authorLabel?: string; publishedLabel: string; readingMinutes: number; excerpt: string; unsubscribeUrl: string; manageUrl: string }) {
  const blogTitle = htmlEscape(input.blogTitle);
  const title = htmlEscape(input.postTitle);
  const postUrl = htmlEscape(input.postUrl);
  const image = input.imageUrl ? `<p style="margin:0 0 24px"><a href="${postUrl}"><img src="${htmlEscape(input.imageUrl)}" alt="${title}" width="520" style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px;border:0"></a></p>` : "";
  const author = input.authorLabel ? `${htmlEscape(input.authorLabel)} · ` : "";
  const unsub = htmlEscape(input.unsubscribeUrl);
  const manage = htmlEscape(input.manageUrl);
  return {
    subject: safeSubjectText(input.postTitle, "A new post on blognice"),
    plainText: `New post on ${input.blogTitle}:\n\n${input.postTitle}\n${input.authorLabel || ""}${input.publishedLabel} · ${input.readingMinutes} min read\n\n${input.excerpt}\n\nRead it: ${input.postUrl}\n\nUnsubscribe: ${input.unsubscribeUrl}\nManage subscriptions: ${input.manageUrl}`,
    headers: { "List-Unsubscribe": `<${safeHeaderUrl(input.unsubscribeUrl)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    html: `<p style="text-align:center;color:#0e5a0c;font-size:12.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin:0 0 18px">New post on ${blogTitle}</p>${image}<h2 style="font-family:Arial,sans-serif;margin:0 0 8px;line-height:1.3"><a href="${postUrl}" style="color:#181a12;text-decoration:none">${title}</a></h2><p style="color:#9098a0;font-size:13px;margin:0 0 8px">${author}${htmlEscape(input.publishedLabel)} · ${input.readingMinutes} min read</p><p style="color:#5c6455">${htmlEscape(input.excerpt)}</p><p style="text-align:center;margin:26px 0 8px"><a href="${postUrl}" style="display:inline-block;background:#1a8917;color:#fff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700">Read it →</a></p><hr><p style="color:#9098a0;font-size:12px;text-align:center">You're subscribed to ${blogTitle}. <a href="${unsub}" style="color:#9098a0">Unsubscribe</a> · <a href="${manage}" style="color:#9098a0">Manage subscriptions</a>.</p>`,
  };
}
function withIdentityFooter(msg: EmailMessage): EmailMessage {
  const sender = msg.senderName?.trim() || "blognice";
  const senderHtml = htmlEscape(sender);
  const bulk = msg.emailKind === "post-notification" || msg.emailKind === "subscription-welcome" || msg.emailKind === "subscriber-confirmation";
  const plainFooter = `\n\n${bulk ? `Sent by ${sender} via blognice.\n` : ""}Support: ${PLATFORM_SUPPORT}\nPrivacy: ${PLATFORM_PRIVACY}\nTerms: ${PLATFORM_TERMS}\nSecurity: ${PLATFORM_SECURITY}${bulk ? `\n\n${PLATFORM_POSTAL}` : ""}`;
  const htmlFooter = `<div style="background:#f7f8f5;padding:22px 32px;text-align:center;color:#9098a0;font-size:12px;line-height:1.7">${bulk ? `Sent by ${senderHtml} via blognice.<br>` : ""}<span>Support: ${PLATFORM_SUPPORT}</span> · <a href="${PLATFORM_PRIVACY}" style="color:#9098a0">Privacy</a> · <a href="${PLATFORM_TERMS}" style="color:#9098a0">Terms</a> · <a href="${PLATFORM_SECURITY}" style="color:#9098a0">Security</a>${bulk ? `<br><br>${PLATFORM_POSTAL}` : ""}</div>`;
  const html = `<div style="margin:0;background:#edeee9;padding:48px 16px;font-family:Arial,sans-serif;color:#181a12;line-height:1.55"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fff;border-radius:14px;overflow:hidden"><tr><td style="padding:40px 40px 26px;text-align:center;font-size:22px;font-weight:800;letter-spacing:-.02em">blognice</td></tr><tr><td style="padding:0 40px 32px">${msg.html}</td></tr><tr><td>${htmlFooter}</td></tr></table></td></tr></table></div>`;
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
