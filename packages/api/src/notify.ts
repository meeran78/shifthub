/**
 * Lightweight notifier with no required deps.
 *
 * - Always logs the event to the server console (concise summary in dev/prod).
 * - If `SHIFTHUB_NOTIFY_WEBHOOK` is set, POSTs the full event as JSON to that URL
 *   (Slack/Discord/Make/Zapier compatible). Failures are swallowed so request flows
 *   never break because the webhook is down.
 * - Email/SMS providers (Resend, Twilio, etc.) can be added later by extending
 *   `sendNotification` — the call sites in workflow procedures don't need to change.
 */

export type NotificationEvent =
  | "PICKUP_REQUESTED"
  | "PICKUP_APPROVED"
  | "PICKUP_DENIED"
  | "SWAP_REQUESTED"
  | "SWAP_COUNTERPARTY_ACCEPTED"
  | "SWAP_APPROVED"
  | "SWAP_DENIED"
  | "GIVE_UP_REQUESTED"
  | "GIVE_UP_APPROVED"
  | "SHIFT_COMMENT_POSTED";

export type NotificationPayload = {
  event: NotificationEvent;
  summary: string;
  /** Optional admin contact email recorded on org settings, when known. */
  adminEmail?: string | null;
  /** Recipients hint — one or more email addresses to notify when integrated. */
  recipients?: string[];
  /** Free-form structured details (shiftId, requesterName, times, notes, etc.) */
  details?: Record<string, unknown>;
};

const WEBHOOK_ENV = "SHIFTHUB_NOTIFY_WEBHOOK";

function getWebhookUrl(): string | null {
  const v = process.env[WEBHOOK_ENV];
  return v && v.trim().length > 0 ? v.trim() : null;
}

export async function sendNotification(payload: NotificationPayload): Promise<void> {
  const body = {
    ...payload,
    timestamp: new Date().toISOString(),
    source: "shifthub",
  };

  // Always log so ops have a paper trail even without a webhook configured.
  // eslint-disable-next-line no-console
  console.log(`[notify] ${payload.event}: ${payload.summary}`, {
    recipients: payload.recipients,
    adminEmail: payload.adminEmail,
  });

  const url = getWebhookUrl();
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[notify] webhook delivery failed for ${payload.event}`, err);
  }
}
