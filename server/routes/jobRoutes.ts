import type { Express } from "express";
import { sendNotFound } from "../http/middleware";
import { logJson } from "../observability";
import { createQueuedAssetJob, getActiveAssetJob, updateAsset } from "../services/jobState";
import { publishQueueOutbox } from "../services/queueOutboxPublisher";
import { getAsset, getJob, listJobs } from "../store";

export function registerJobRoutes(app: Express) {
  app.get("/api/jobs", async (_req, res) => {
    res.json(await listJobs());
  });

  app.get("/api/jobs/:id", async (req, res) => {
    const job = await getJob(String(req.params.id));
    if (!job) return sendNotFound(res, "Job not found");
    res.json(job);
  });

  app.post("/api/jobs/:id/retry", async (req, res) => {
    const job = await getJob(String(req.params.id));
    if (!job || !job.assetId) return sendNotFound(res, "Retryable job not found");
    const asset = await getAsset(job.assetId);
    if (!asset) return sendNotFound(res, "Asset not found");
    const activeJob = await getActiveAssetJob(asset.id);
    if (activeJob) {
      logJson("info", "job.retry.duplicate", "Retry request ignored because an active asset job already exists", {
        assetId: asset.id,
        requestedJobId: job.id,
        activeJobId: activeJob.id,
        activeStage: activeJob.stage,
        activeStatus: activeJob.status
      });
      res.setHeader("x-existing-job", "true");
      res.status(202).json(activeJob);
      return;
    }
    const retry = await createQueuedAssetJob(job.type === "asset.index" ? "asset.reindex" : job.type, asset.indexId, asset.id, job.parameters);
    if (retry.type !== "asset.domain-vlm.refine") {
      await updateAsset(asset.id, { status: "queued", progress: 3, error: null });
    }
    await publishQueueOutbox("asset-job", 10);
    res.status(202).json(retry);
  });
}
