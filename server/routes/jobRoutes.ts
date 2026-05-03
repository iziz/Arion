import type { Express } from "express";
import { sendNotFound } from "../http/middleware";
import { enqueueLocalTask } from "../localQueue";
import { getObjectPath } from "../localObjectStorage";
import { logJson, traceJobAsync } from "../observability";
import { createJob, getActiveAssetJob, updateAsset } from "../services/jobState";
import { getAsset, getJob, listJobs } from "../store";
import { enqueueDomainVlmRefinement, runIndexingJob } from "../workflows/indexingWorkflow";

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
    const retry = await createJob(job.type === "asset.index" ? "asset.reindex" : job.type, asset.indexId, asset.id);
    if (retry.type === "asset.domain-vlm.refine") {
      enqueueDomainVlmRefinement(retry, asset.id);
    } else {
      await updateAsset(asset.id, { status: "queued", progress: 3, error: null });
      enqueueLocalTask(retry.id, () =>
        traceJobAsync("job.indexing", { jobId: retry.id, assetId: asset.id }, { type: retry.type }, () =>
          runIndexingJob(
            retry.id,
            asset.id,
            getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey)
          )
        )
      );
    }
    res.status(202).json(retry);
  });
}
