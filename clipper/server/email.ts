import { alert } from "./alerts";

// Transactional email (password resets, email confirmation) through Resend's
// HTTP API. Without RESEND_API_KEY, messages are logged and kept in a small
// in-memory outbox (local development and tests) instead of being sent.

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const emailConfigured = () => !!process.env.RESEND_API_KEY;

/** Messages "sent" without a provider, newest last (development and tests). */
export const outbox: Email[] = [];

export async function sendEmail(m: Email): Promise<void> {
  if (!emailConfigured()) {
    outbox.push(m);
    if (outbox.length > 50) outbox.shift();
    // Links in these emails sign people in: only print them outside production.
    if (process.env.NODE_ENV === "production") console.warn(`[email] not sent (RESEND_API_KEY is not set): "${m.subject}"`);
    else if (!process.env.VITEST) console.log(`[email] (not sent: RESEND_API_KEY is not set) to ${m.to}: ${m.subject}\n${m.text}`);
    return;
  }
  const res = await fetch(`${process.env.RESEND_BASE_URL ?? "https://api.resend.com"}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM ?? "UGCMediaClips <onboarding@resend.dev>", to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = `Email provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
    alert("email failed", err);
    throw new Error(err);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain, single-button message in the product's style. */
export function buttonEmail(o: { to: string; subject: string; intro: string; button: string; url: string; outro: string }): Email {
  return {
    to: o.to,
    subject: o.subject,
    text: `${o.intro}\n\n${o.button}: ${o.url}\n\n${o.outro}\n\n— UGCMediaClips`,
    html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#19191a">
<p style="font-size:18px;font-weight:800;margin:0 0 20px">UGC Media <span style="color:#e5484d">Clips</span></p>
<p style="font-size:15px;line-height:1.5">${esc(o.intro)}</p>
<p style="margin:24px 0"><a href="${esc(o.url)}" style="background:#e5484d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(o.button)}</a></p>
<p style="font-size:13px;color:#6c6c66;line-height:1.5">${esc(o.outro)}</p>
<p style="font-size:12px;color:#9a9a93;word-break:break-all">${esc(o.url)}</p>
</div>`,
  };
}
