// Optional transactional email via MailNice's server API.
//
// Everything else in Blog Nice works without this. Email turns on only when
// both secrets/configuration values are set:
//   MAILNICE_API_KEY  server API key (wrangler secret put MAILNICE_API_KEY)
//   EMAIL_FROM        verified sender address, e.g. "The Blog <hello@blognice.com>"

export type EmailEnv = {
  MAILNICE_API_KEY?: string;
  EMAIL_FROM?: string;
  MAILNICE_API_URL?: string;
};

const DEFAULT_MAILNICE_API_URL = "https://api.mailnice.net/api/v1/send/message";

export function emailEnabled(env: EmailEnv): boolean {
  return !!(env.MAILNICE_API_KEY?.trim() && env.EMAIL_FROM?.trim());
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendEmail(
  env: EmailEnv,
  msg: {
    to: string;
    subject: string;
    html: string;
    headers?: Record<string, string>;
  }
): Promise<boolean> {
  if (!emailEnabled(env)) return false;
  try {
    const res = await fetch(env.MAILNICE_API_URL?.trim() || DEFAULT_MAILNICE_API_URL, {
      method: "POST",
      headers: {
        "X-Server-API-Key": env.MAILNICE_API_KEY!.trim(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: [msg.to],
        from: env.EMAIL_FROM!.trim(),
        subject: msg.subject,
        plain_body: htmlToPlainText(msg.html),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
