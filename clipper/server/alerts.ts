// Operator alerts: server errors, crashes and failed jobs, posted to a chat
// webhook (ALERT_WEBHOOK_URL: Slack or Discord incoming webhooks both work).
// The same problem alerts at most once per 15 minutes, and at most 30 alerts
// go out per hour, so an outage can't flood the channel.

const DEDUPE_MS = 15 * 60_000;
const PER_HOUR = 30;
const lastSent = new Map<string, number>();
let hour = { start: 0, n: 0, dropped: 0 };

export const alertsConfigured = () => !!process.env.ALERT_WEBHOOK_URL;

/** Sent alerts, newest last (tests and local development). */
export const sentAlerts: string[] = [];

export function alert(kind: string, message: string, detail?: string) {
  const t = Date.now();
  const key = `${kind}:${message.replace(/\d+/g, "#").slice(0, 120)}`;
  if (t - (lastSent.get(key) ?? 0) < DEDUPE_MS) return;
  if (t - hour.start > 3600_000) hour = { start: t, n: 0, dropped: 0 };
  if (hour.n >= PER_HOUR) return void hour.dropped++;
  lastSent.set(key, t);
  hour.n++;
  if (lastSent.size > 2000) for (const [k, v] of lastSent) if (t - v > DEDUPE_MS) lastSent.delete(k);

  const where = process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "local";
  const text = `🚨 UGCMediaClips (${where}) · ${kind}: ${message.slice(0, 400)}${detail ? `\n${detail.slice(0, 1200)}` : ""}`;
  sentAlerts.push(text);
  if (sentAlerts.length > 50) sentAlerts.shift();
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  // Slack reads `text`, Discord reads `content`.
  void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text.slice(0, 1900) }), signal: AbortSignal.timeout(10_000) }).catch((e) =>
    console.error("[alerts] couldn't send:", (e as Error).message),
  );
}

/** Errors a user can fix themselves (a blocked Drive file, a bad link): not worth paging anyone. */
export const isUserError = (msg: string) =>
  /download limit|isn't public|returned a web page|over the .* MB limit|Couldn't find|can't be fetched|no audio|Upload|upload it|Daily AI limit|AI budget|Too many attempts/i.test(msg);
