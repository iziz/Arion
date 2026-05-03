import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { sendNotFound } from "../http/middleware";
import { deliverWebhook, recordEvent } from "../services/events";
import { getWebhook, listEvents, listWebhooks, saveWebhook } from "../store";
import type { WebhookRecord } from "../../shared/types";

export function registerWebhookRoutes(app: Express) {
  app.get("/api/webhooks", async (_req, res) => {
    res.json(await listWebhooks());
  });

  app.post("/api/webhooks", async (req, res) => {
    const now = new Date().toISOString();
    const webhook: WebhookRecord = {
      id: randomUUID(),
      name: String(req.body.name || "Webhook"),
      url: String(req.body.url || "log://local"),
      events: Array.isArray(req.body.events) && req.body.events.length > 0 ? req.body.events : ["asset.indexing.succeeded"],
      active: Boolean(req.body.active ?? true),
      deliveries: [],
      createdAt: now,
      updatedAt: now
    };
    await saveWebhook(webhook);
    await recordEvent("system.info", "Webhook registered", { payload: { name: webhook.name, url: webhook.url } });
    res.status(201).json(webhook);
  });

  app.post("/api/webhooks/:id/test", async (req, res) => {
    const webhook = await getWebhook(String(req.params.id));
    if (!webhook) return sendNotFound(res, "Webhook not found");
    const event = await recordEvent("system.info", "Webhook test event", { payload: { webhookId: webhook.id } });
    await deliverWebhook(webhook, "asset.indexing.succeeded", event, 1);
    res.json(await getWebhook(webhook.id));
  });

  app.post("/api/webhooks/:id/retry", async (req, res) => {
    const webhook = await getWebhook(String(req.params.id));
    if (!webhook) return sendNotFound(res, "Webhook not found");
    const events = await listEvents(500);
    for (const delivery of webhook.deliveries.filter((item) => item.status === "failed")) {
      const event = events.find((item) => item.id === delivery.eventId);
      if (event) {
        await deliverWebhook(webhook, delivery.event, event, delivery.attempts + 1);
      }
    }
    res.json(await getWebhook(webhook.id));
  });
}
