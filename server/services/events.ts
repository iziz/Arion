import { randomUUID } from "node:crypto";
import { listWebhooks, saveBilling, saveEvent, saveWebhook } from "../store";
import type { EventRecord, WebhookEventType, WebhookRecord } from "../../shared/types";

export async function recordBilling(assetId: string | null, jobId: string | null, units: number, reason: string) {
  await saveBilling({
    id: randomUUID(),
    userId: "local-user",
    assetId,
    jobId,
    units,
    reason,
    createdAt: new Date().toISOString()
  });
}

export async function recordEvent(
  type: EventRecord["type"],
  message: string,
  options: {
    indexId?: string | null;
    assetId?: string | null;
    jobId?: string | null;
    payload?: Record<string, unknown>;
  } = {}
) {
  const event: EventRecord = {
    id: randomUUID(),
    type,
    message,
    indexId: options.indexId ?? null,
    assetId: options.assetId ?? null,
    jobId: options.jobId ?? null,
    payload: options.payload ?? {},
    createdAt: new Date().toISOString()
  };
  return saveEvent(event);
}

export async function deliverEvent(type: WebhookEventType, event: EventRecord) {
  const webhooks = (await listWebhooks()).filter((webhook) => webhook.active && webhook.events.includes(type));
  await Promise.all(webhooks.map((webhook) => deliverWebhook(webhook, type, event, 1)));
}

export async function deliverWebhook(webhook: WebhookRecord, type: WebhookEventType, event: EventRecord, attempts = 1) {
  const now = new Date().toISOString();
  const delivery = {
    id: randomUUID(),
    eventId: event.id,
    event: type,
    status: "skipped" as const,
    statusCode: null,
    error: null,
    attempts,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now
  };

  if (webhook.url.startsWith("log://")) {
    webhook.deliveries.unshift({ ...delivery, status: "delivered" });
  } else {
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(2500)
      });
      webhook.deliveries.unshift({
        ...delivery,
        status: response.ok ? "delivered" : "failed",
        statusCode: response.status,
        error: response.ok ? null : response.statusText,
        nextRetryAt: response.ok ? null : new Date(Date.now() + retryDelay(attempts)).toISOString()
      });
    } catch (error) {
      webhook.deliveries.unshift({
        ...delivery,
        status: "failed",
        error: error instanceof Error ? error.message : "Webhook delivery failed",
        nextRetryAt: new Date(Date.now() + retryDelay(attempts)).toISOString()
      });
    }
  }

  webhook.deliveries = webhook.deliveries.slice(0, 30);
  webhook.updatedAt = new Date().toISOString();
  await saveWebhook(webhook);
}

function retryDelay(attempts: number) {
  return Math.min(60_000, 2 ** Math.max(0, attempts - 1) * 5_000);
}
