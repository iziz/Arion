import type { Express } from "express";
import { getQueueDepth } from "../localQueue";
import { getRuntimeCapabilities } from "../modelCapabilities";
import { getObservabilitySnapshot } from "../observability";
import { getPostgresStatus, isPostgresEnabled } from "../postgresStore";
import { getMetrics, listBilling, listEvents, listUsers } from "../store";

export function registerSystemRoutes(app: Express) {
  app.get("/api/health", async (_req, res) => {
    res.json({ status: "ok", service: "arion", metrics: await getMetrics() });
  });

  app.get("/api/metrics", async (_req, res) => {
    res.json({ ...(await getMetrics()), queueDepth: getQueueDepth() });
  });

  app.get("/api/db/status", async (_req, res) => {
    if (!isPostgresEnabled()) {
      res.json({ enabled: false, storage: "file", metrics: await getMetrics() });
      return;
    }
    res.json(await getPostgresStatus());
  });

  app.get("/api/observability", async (_req, res) => {
    res.json(getObservabilitySnapshot());
  });

  app.get("/api/model-capabilities", async (_req, res) => {
    try {
      res.json(await getRuntimeCapabilities());
    } catch (error) {
      res.status(503).json({ available: false, error: error instanceof Error ? error.message : "Model capability check failed" });
    }
  });

  app.get("/api/users", async (_req, res) => {
    res.json(await listUsers());
  });

  app.get("/api/billing", async (_req, res) => {
    res.json(await listBilling());
  });

  app.get("/api/events", async (req, res) => {
    res.json(await listEvents(Number(req.query.limit ?? 80)));
  });
}
