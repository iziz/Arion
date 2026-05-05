import type { Express } from "express";
import { mediaServingMode } from "../http/config";
import { getObjectStorageStatus } from "../localObjectStorage";
import { getRuntimeCapabilities } from "../modelCapabilities";
import { getObservabilitySnapshot } from "../observability";
import { getPostgresStatus, isPostgresEnabled } from "../postgresStore";
import { getMetrics, listBilling, listEvents, listUsers } from "../store";
import { registerRealtimeSubscriber, writeSseComment, writeSseHeaders, writeSseRealtimeEvent } from "../services/realtimeEvents";
import { getAskOperationResponse } from "../workflows/askWorkflow";

export function registerSystemRoutes(app: Express) {
  app.get("/api/health", async (_req, res) => {
    res.json({ status: "ok", service: "arion", metrics: await getMetrics() });
  });

  app.get("/api/metrics", async (_req, res) => {
    const metrics = await getMetrics();
    res.json({ ...metrics, queueDepth: metrics.runningJobs });
  });

  app.get("/api/db/status", async (_req, res) => {
    if (!isPostgresEnabled()) {
      res.status(503).json({ enabled: false, storage: "postgres", error: "DATABASE_URL is required." });
      return;
    }
    res.json(await getPostgresStatus());
  });

  app.get("/api/storage/status", async (_req, res) => {
    res.json({
      applicationPersistence: {
        storage: "postgres",
        durableForProduction: true
      },
      mediaStorage: {
        ...getObjectStorageStatus(),
        servingMode: mediaServingMode,
        servedByApiProcess: mediaServingMode === "local-static"
      },
      note: "Application state and binary media are separate storage boundaries."
    });
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

  app.get("/api/events/stream", async (req, res) => {
    writeSseHeaders(res);
    const operationId = req.query.operationId ? String(req.query.operationId) : null;
    const writeCurrentAskOperation = async () => {
      if (!operationId || res.writableEnded) return;
      const response = await getAskOperationResponse(operationId);
      if (response && !res.writableEnded) writeSseRealtimeEvent(res, "ask.operation.updated", { operationId, operation: response.operation, response });
    };
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      writeSseComment(res, "heartbeat");
      void writeCurrentAskOperation().catch(() => undefined);
    }, 15000);
    const unsubscribe = registerRealtimeSubscriber(res, {
      jobId: req.query.jobId ? String(req.query.jobId) : null,
      assetId: req.query.assetId ? String(req.query.assetId) : null,
      operationId
    });
    await writeCurrentAskOperation();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
