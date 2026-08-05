// Optional transactional email via Resend (https://resend.com).
//
// Everything else in Blog Nice works without this. Email turns on only when
// both secrets are set:
//   RESEND_API_KEY   your Resend API key (wrangler secret put RESEND_API_KEY)
//   EMAIL_FROM       a verified from-address, e.g. "The Blog <hello@blognice.com>"
//
// Sending from your own domain requires verifying it in Resend (SPF/DKIM), or
// deliverability will suffer. See the README.

export type EmailEnv = {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

export function emailEnabled(env: EmailEnv): boolean {
  return !!(env.RESEND_API_KEY && env.EMAIL_FROM);
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
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        headers: msg.headers,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
