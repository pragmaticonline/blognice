export type MailNiceEnv = {
  MAILNICE_API_KEY?: string;
  EMAIL_FROM?: string;
};

export function mailNiceEnabled(env: MailNiceEnv): boolean {
  return Boolean(env.MAILNICE_API_KEY && env.EMAIL_FROM);
}

export async function sendMailNice(
  env: MailNiceEnv,
  message: { to: string; subject: string; plainBody: string; html?: string; headers?: Record<string, string>; tag?: string },
): Promise<{ ok: boolean; detail?: string }> {
  if (!mailNiceEnabled(env)) return { ok: false, detail: "Email integration is not configured on the staff Worker." };
  try {
    const response = await fetch("https://api.mailnice.net/api/v1/send/message", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Server-API-Key": env.MAILNICE_API_KEY!,
      },
      body: JSON.stringify({
        to: [message.to],
        from: env.EMAIL_FROM,
        subject: message.subject,
        plain_body: message.plainBody,
        ...(message.html ? { html_body: message.html } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.tag ? { tag: message.tag } : {}),
      }),
    });
    const payload = await response.json().catch(() => null) as { status?: string; error?: string; message?: string } | null;
    if (!response.ok || payload?.status === "error") {
      return { ok: false, detail: payload?.error || payload?.message || `MailNice returned HTTP ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "MailNice request failed." };
  }
}
