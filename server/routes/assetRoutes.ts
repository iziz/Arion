import type { Express, RequestHandler } from "express";
import { analyzeAssetGroup, buildClipDetail, listAssetClips } from "../intelligence";
import { sendNotFound } from "../http/middleware";
import { logJson } from "../observability";
import { planDomainQueryWithOpenAi } from "../openaiQueryPlanner";
import { parseDomainFilters } from "../queryPlanner";
import { deliverEvent, recordBilling, recordEvent } from "../services/events";
import { createQueuedAssetJob, getActiveAssetJob, updateAsset, updateJob } from "../services/jobState";
import { deleteAssetMedia } from "../services/mediaLifecycle";
import { publishQueueOutbox } from "../services/queueOutboxPublisher";
import { getTrackingSummary, listTrackingRecords } from "../trackingStore";
import { isVlmWorkerEnabled } from "../vlmWorkerClient";
import { createAssetFromUpload, normalizeWorkflowStage } from "../workflows/indexingWorkflow";
import { deleteAssetCascade, getAsset, getIndex, listAssets, listIndexes } from "../store";
import { summarizeAssetRecords } from "../../shared/assetSummary";
import type { JobRecord } from "../../shared/types";

type UploadMiddleware = { single(fieldName: string): RequestHandler };

export function registerAssetRoutes(app: Express, upload: UploadMiddleware) {
  app.get("/api/assets", async (req, res) => {
    const assets = await listAssets(req.query.indexId ? String(req.query.indexId) : undefined);
    res.json(shouldReturnAssetSummary(req.query) ? summarizeAssetRecords(assets) : assets);
  });

  app.get("/api/assets/summary", async (req, res) => {
    res.json(summarizeAssetRecords(await listAssets(req.query.indexId ? String(req.query.indexId) : undefined)));
  });

  app.get("/api/assets/:id", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    res.json(asset);
  });

  app.delete("/api/assets/:id", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    const activeJob = await getActiveAssetJob(asset.id);
    if (activeJob) {
      res.status(409).json({
        error: "Asset cannot be deleted while an indexing job is queued or running.",
        activeJobId: activeJob.id,
        activeJobStatus: activeJob.status
      });
      return;
    }
    const deletion = await deleteAssetCascade(asset.id);
    if (!deletion) return sendNotFound(res, "Asset not found");
    const media = await deleteAssetMedia(asset);
    await recordEvent("system.info", "Asset deleted", {
      indexId: asset.indexId,
      payload: { assetId: asset.id, title: asset.title, deleted: deletion.deleted, media }
    });
    res.json({ assetId: asset.id, indexId: asset.indexId, deleted: deletion.deleted, media });
  });

  app.get("/api/assets/:id/clips", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    const queryPlan = await planDomainQueryWithOpenAi(String(req.query.q ?? ""), parseDomainFilters(req.query));
    const clips = listAssetClips(asset, queryPlan.domainFilters, queryPlan);
    res.json(clips);
  });

  app.get("/api/assets/:id/clips/:segmentId", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    const queryPlan = await planDomainQueryWithOpenAi(String(req.query.q ?? ""), parseDomainFilters(req.query));
    const detail = await buildClipDetail(asset, String(req.params.segmentId), queryPlan.domainFilters, queryPlan);
    if (!detail) return sendNotFound(res, "Clip segment not found");
    res.json(detail);
  });

  app.get("/api/assets/:id/tracking", async (req, res) => {
    const assetId = String(req.params.id);
    const asset = await getAsset(assetId);
    if (!asset) return sendNotFound(res, "Asset not found");
    res.json({
      summary: await getTrackingSummary(assetId),
      records: await listTrackingRecords({
        assetId,
        segmentId: req.query.segmentId ? String(req.query.segmentId) : undefined,
        trackId: req.query.trackId ? String(req.query.trackId) : undefined
      })
    });
  });

  app.get("/api/tracking", async (req, res) => {
    const assetId = req.query.assetId ? String(req.query.assetId) : undefined;
    res.json({
      summary: await getTrackingSummary(assetId),
      records: await listTrackingRecords({
        assetId,
        segmentId: req.query.segmentId ? String(req.query.segmentId) : undefined,
        trackId: req.query.trackId ? String(req.query.trackId) : undefined
      })
    });
  });

  app.post("/api/assets", upload.single("video"), async (req, res) => {
    const result = await createAssetFromUpload(req, res, String(req.body.indexId || ""));
    if (result?.job) await publishQueueOutbox("asset-job", 10);
    if (result) res.status(202).json(result);
  });

  app.post("/api/indexes/:id/assets", upload.single("video"), async (req, res) => {
    const result = await createAssetFromUpload(req, res, String(req.params.id));
    if (result?.job) await publishQueueOutbox("asset-job", 10);
    if (result) res.status(202).json(result);
  });

  app.post("/api/indexes/:id/analyze", async (req, res) => {
    const index = await getIndex(String(req.params.id));
    if (!index) return sendNotFound(res, "Index not found");
    const assets = await listAssets(index.id);
    const indexes = await listIndexes();
    const result = await analyzeAssetGroup(assets, indexes, index, String(req.body.question ?? ""));
    const event = await recordEvent("analysis.completed", "Asset group analysis completed", {
      indexId: index.id,
      payload: { question: String(req.body.question ?? ""), scope: result.scope, signals: result.signals }
    });
    await deliverEvent("analysis.completed", event);
    await recordBilling(null, null, Math.max(1, result.clips.length), "local asset group analysis request");
    res.json(result);
  });

  app.post("/api/assets/:id/reindex", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    const activeJob = await getActiveAssetJob(asset.id);
    if (activeJob) {
      logJson("info", "job.reindex.duplicate", "Reindex request ignored because an active asset job already exists", {
        assetId: asset.id,
        activeJobId: activeJob.id,
        activeStage: activeJob.stage,
        activeStatus: activeJob.status
      });
      res.setHeader("x-existing-job", "true");
      res.status(202).json(activeJob);
      return;
    }
    const requestedStage = normalizeWorkflowStage(req.body?.stage);
    const job = await createQueuedAssetJob("asset.reindex", asset.indexId, asset.id, requestedStage ? { retryStage: requestedStage } : undefined);
    const queuedJob = requestedStage
      ? (await updateJob(job.id, {}, `Retry requested from workflow card: ${requestedStage}`)) ?? job
      : job;
    await updateAsset(asset.id, { status: "queued", progress: 3, error: null });
    await publishQueueOutbox("asset-job", 10);
    res.status(202).json(queuedJob);
  });

  app.post("/api/assets/:id/domain-vlm/refine", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    const index = await getIndex(asset.indexId);
    if (!index) return sendNotFound(res, "Index not found");
    if (!index.domainIndexing?.enabled || index.domainIndexing.groups.length === 0) {
      res.status(409).json({ error: "Related knowledge VLM refinement requires related knowledge indexing for this asset group." });
      return;
    }
    if (!isVlmWorkerEnabled()) {
      res.status(409).json({ error: "VLM_WORKER_URL is not configured." });
      return;
    }
    const activeJob = await getActiveAssetJob(asset.id);
    if (activeJob) {
      logJson("info", "job.domain_vlm.duplicate", "Related knowledge VLM refinement ignored because an active asset job already exists", {
        assetId: asset.id,
        activeJobId: activeJob.id,
        activeStage: activeJob.stage,
        activeStatus: activeJob.status
      });
      res.setHeader("x-existing-job", "true");
      res.status(202).json(activeJob);
      return;
    }
    const job = await createQueuedAssetJob("asset.domain-vlm.refine", asset.indexId, asset.id);
    await publishQueueOutbox("asset-job", 10);
    res.status(202).json(job);
  });

  app.post("/api/indexes/:id/domain-vlm/refine", async (req, res) => {
    const index = await getIndex(String(req.params.id));
    if (!index) return sendNotFound(res, "Index not found");
    if (!index.domainIndexing?.enabled || index.domainIndexing.groups.length === 0) {
      res.status(409).json({ error: "Related knowledge VLM refinement requires related knowledge indexing for this asset group." });
      return;
    }
    if (!isVlmWorkerEnabled()) {
      res.status(409).json({ error: "VLM_WORKER_URL is not configured." });
      return;
    }
    const assets = (await listAssets(index.id)).filter((asset) => asset.status === "indexed" && asset.timeline.length > 0);
    const jobs: JobRecord[] = [];
    const skipped: Array<{ assetId: string; reason: string }> = [];
    for (const asset of assets) {
      const activeJob = await getActiveAssetJob(asset.id);
      if (activeJob) {
        skipped.push({ assetId: asset.id, reason: `active job ${activeJob.id}` });
        continue;
      }
      const job = await createQueuedAssetJob("asset.domain-vlm.refine", asset.indexId, asset.id);
      jobs.push(job);
    }
    await publishQueueOutbox("asset-job", Math.max(10, jobs.length));
    res.status(202).json({
      indexId: index.id,
      queued: jobs.length,
      skipped: skipped.length,
      jobs,
      skippedAssets: skipped
    });
  });
}

function shouldReturnAssetSummary(query: Record<string, unknown>) {
  return query.view === "summary" || query.summary === "true";
}
