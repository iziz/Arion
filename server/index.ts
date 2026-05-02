import "./env";
import cors from "cors";
import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { analyzeAsset, analyzeAssetGroup, buildClipDetail, buildLocalIndex, listAssetClips, probeVideo, searchAssets, withSceneData } from "./intelligence";
import { buildDomainSegmentIndex, expandDomainQuery } from "./domainIndex";
import { buildOrchestrationPlan } from "./orchestrator";
import { parseDomainFilters, planDomainQuery } from "./queryPlanner";
import { enqueueLocalTask, getQueueDepth } from "./localQueue";
import { embedQueryText, embedTimelineSegments, getEmbeddingModelName } from "./localEmbeddingRuntime";
import { embedKeyframes, embedVisualQuery, getVisualEmbeddingModelName } from "./localVisualEmbeddingRuntime";
import { generateKeyframes } from "./keyframes";
import { applyDiarizationToAsrSegments, runLocalModelRuntime, runWhisperXDiarizationForAsset } from "./localModelRuntime";
import { applyEventClassification } from "./eventClassifier";
import { getObjectPath, getPublicMediaRoot, putUploadedObject } from "./localObjectStorage";
import { rebuildVectorStore, searchVectors, upsertAssetVectors } from "./localVectorStore";
import { rebuildVisualVectorStore, searchVisualVectors, upsertAssetVisualVectors } from "./localVisualVectorStore";
import { applyVisionDetections, applyVisionTracking, detectTimelineObjects } from "./visionDetectionRuntime";
import { detectSceneBoundaries } from "./sceneDetection";
import { getPostgresStatus, isPostgresEnabled } from "./postgresStore";
import { getSportsKnowledgeSnapshot, upsertSportsKnowledgePlayer } from "./sportsKnowledge";
import { getTrackingSummary, listTrackingRecords, rebuildTrackingStore, upsertAssetTracking } from "./trackingStore";
import { getObservabilitySnapshot, logJson, observabilityMiddleware, traceAsync, traceJobAsync } from "./observability";
import { normalizeUploadedText } from "./textEncoding";
import {
  createDefaultIndex,
  getAsset,
  getIndex,
  getJob,
  getMetrics,
  getVideo,
  getWebhook,
  getUserByApiKey,
  listBilling,
  listAssets,
  listEvents,
  listIndexes,
  listJobs,
  listUsers,
  listVideos,
  listWebhooks,
  saveBilling,
  saveAsset,
  saveEvent,
  saveIndex,
  saveJob,
  saveVideo,
  saveWebhook
} from "./store";
import type { AssetRecord, EventRecord, IndexRecord, JobRecord, LocalIntelligence, TimelineSegment, WebhookEventType, WebhookRecord } from "../shared/types";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const uploadDir = path.resolve(".data", "tmp-uploads");
const legacyUploadDir = path.resolve("uploads");
const requestBuckets = new Map<string, { count: number; resetAt: number }>();
const rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600);
const rateLimitExemptGetPaths = new Set([
  "/api/health",
  "/api/indexes",
  "/api/assets",
  "/api/jobs",
  "/api/events",
  "/api/webhooks",
  "/api/metrics",
  "/api/db/status",
  "/api/observability"
]);

await mkdir(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, callback) => {
      const extension = path.extname(normalizeUploadedText(file.originalname));
      callback(null, `${randomUUID()}${extension}`);
    }
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024
  }
});

app.use(cors());
app.use("/media", express.static(getPublicMediaRoot(), { maxAge: "1h" }));
app.use("/media", express.static(legacyUploadDir, { maxAge: "1h" }));
app.use(express.json({ limit: "2mb" }));
app.use(observabilityMiddleware);
app.use(rateLimit);
app.use(optionalApiKeyAuth);

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

app.get("/api/users", async (_req, res) => {
  res.json(await listUsers());
});

app.get("/api/billing", async (_req, res) => {
  res.json(await listBilling());
});

app.get("/api/events", async (req, res) => {
  res.json(await listEvents(Number(req.query.limit ?? 80)));
});

app.get("/api/indexes", async (_req, res) => {
  res.json(await listIndexes());
});

app.post("/api/indexes", async (req, res) => {
  const now = new Date().toISOString();
  const index: IndexRecord = {
    ...createDefaultIndex(now),
    id: randomUUID(),
    name: String(req.body.name || "Untitled index"),
    description: String(req.body.description || ""),
    models: {
      search: String(req.body.models?.search || "local-marengo-simulator"),
      analysis: String(req.body.models?.analysis || "local-pegasus-simulator"),
      embedding: String(req.body.models?.embedding || getEmbeddingModelName())
    },
    modalities: Array.isArray(req.body.modalities) && req.body.modalities.length > 0 ? req.body.modalities : ["visual", "audio", "transcription", "metadata"],
    domainIndexing: normalizeDomainIndexing(req.body.domainIndexing),
    assetIds: [],
    status: "empty",
    createdAt: now,
    updatedAt: now
  };
  await saveIndex(index);
  await recordEvent("system.info", "Index created", { indexId: index.id, payload: { name: index.name } });
  res.status(201).json(index);
});

app.get("/api/indexes/:id", async (req, res) => {
  const index = await getIndex(String(req.params.id));
  if (!index) return sendNotFound(res, "Index not found");
  res.json(index);
});

app.patch("/api/indexes/:id", async (req, res) => {
  const index = await getIndex(String(req.params.id));
  if (!index) return sendNotFound(res, "Index not found");
  const now = new Date().toISOString();
  const next: IndexRecord = {
    ...index,
    name: typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : index.name,
    description: typeof req.body.description === "string" ? req.body.description : index.description,
    domainIndexing: req.body.domainIndexing === undefined ? index.domainIndexing : normalizeDomainIndexing(req.body.domainIndexing),
    updatedAt: now
  };
  await saveIndex(next);
  await recordEvent("system.info", "Index updated", { indexId: next.id, payload: { name: next.name } });
  res.json(next);
});

app.get("/api/assets", async (req, res) => {
  res.json(await listAssets(req.query.indexId ? String(req.query.indexId) : undefined));
});

app.get("/api/assets/:id", async (req, res) => {
  const asset = await getAsset(String(req.params.id));
  if (!asset) return sendNotFound(res, "Asset not found");
  res.json(asset);
});

app.get("/api/assets/:id/clips", async (req, res) => {
  const asset = await getAsset(String(req.params.id));
  if (!asset) return sendNotFound(res, "Asset not found");
  const queryPlan = planDomainQuery(String(req.query.q ?? ""), parseDomainFilters(req.query));
  const clips = listAssetClips(asset, queryPlan.domainFilters, queryPlan);
  res.json(clips);
});

app.get("/api/assets/:id/clips/:segmentId", async (req, res) => {
  const asset = await getAsset(String(req.params.id));
  if (!asset) return sendNotFound(res, "Asset not found");
  const queryPlan = planDomainQuery(String(req.query.q ?? ""), parseDomainFilters(req.query));
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
  const result = await createAssetFromUpload(req, res, String(req.body.indexId || "default-index"));
  if (result) res.status(202).json(result);
});

app.post("/api/indexes/:id/assets", upload.single("video"), async (req, res) => {
  const result = await createAssetFromUpload(req, res, String(req.params.id));
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
  const job = await createJob("asset.reindex", asset.indexId, asset.id);
  const queuedJob = requestedStage
    ? (await updateJob(job.id, {}, `Retry requested from workflow card: ${requestedStage}`)) ?? job
    : job;
  if (requestedStage === "speakers") {
    enqueueLocalTask(job.id, () =>
      traceJobAsync("job.diarization", { jobId: job.id, assetId: asset.id }, { type: "asset.reindex", stage: "speakers" }, () =>
        runSpeakerDiarizationJob(job.id, asset.id)
      )
    );
  } else {
    await updateAsset(asset.id, { status: "queued", progress: 3, error: null });
    enqueueLocalTask(
      job.id,
      () =>
        traceJobAsync("job.indexing", { jobId: job.id, assetId: asset.id }, { type: "asset.reindex" }, () =>
          runIndexingJob(
            job.id,
            asset.id,
            getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey)
          )
        )
    );
  }
  res.status(202).json(queuedJob);
});

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
  res.status(202).json(retry);
});

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q ?? "");
  const explicitFilters = parseDomainFilters(req.query);
  const queryPlan = planDomainQuery(query, explicitFilters);
  const expandedQuery = expandDomainQuery(queryPlan.semanticQuery).expandedText;
  const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
  const options = {
    indexId: req.query.indexId ? String(req.query.indexId) : undefined,
    tag: req.query.tag ? String(req.query.tag) : undefined,
    modality: req.query.modality ? String(req.query.modality) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    domainFilters: queryPlan.domainFilters,
    queryPlan
  };
  const queryVector = await traceAsync("search.embed_text_query", { indexId: options.indexId ?? "all" }, () => embedQueryText(expandedQuery), "search.embed_text_query");
  const visualQueryVector = await traceAsync(
    "search.embed_visual_query",
    { indexId: options.indexId ?? "all" },
    () => embedVisualQuery(query),
    "search.embed_visual_query"
  );
  const [vectorHits, visualHits] = await Promise.all([
    traceAsync("search.vector_text", { indexId: options.indexId ?? "all" }, () => searchVectors(options.indexId, queryVector, Number(req.query.limit ?? 25)), "search.vector_text"),
    visualQueryVector.length
      ? traceAsync(
          "search.vector_visual",
          { indexId: options.indexId ?? "all" },
          () => searchVisualVectors(options.indexId, visualQueryVector, Number(req.query.limit ?? 25)),
          "search.vector_visual"
        )
      : Promise.resolve([])
  ]);
  const vectorSegmentsByAsset = new Map<string, number>();
  const vectorHitsBySegment = new Map<string, number>();
  const visualHitsBySegment = new Map<string, number>();
  for (const hit of vectorHits) {
    vectorSegmentsByAsset.set(hit.assetId, (vectorSegmentsByAsset.get(hit.assetId) ?? 0) + 1);
    vectorHitsBySegment.set(hit.segmentId, Math.max(vectorHitsBySegment.get(hit.segmentId) ?? 0, hit.score));
  }
  for (const hit of visualHits) {
    vectorSegmentsByAsset.set(hit.assetId, (vectorSegmentsByAsset.get(hit.assetId) ?? 0) + 1);
    visualHitsBySegment.set(hit.segmentId, Math.max(visualHitsBySegment.get(hit.segmentId) ?? 0, hit.score));
  }
  const results = searchAssets(assets, indexes, query, { ...options, queryVector, vectorHitsBySegment, visualHitsBySegment }).map((result) => ({
    ...result,
    explain: [...result.explain, `${vectorSegmentsByAsset.get(result.asset.id) ?? 0} local vector DB hits`]
  }));
  res.json(results);
});

app.get("/api/search/plan", async (req, res) => {
  res.json(planDomainQuery(String(req.query.q ?? ""), parseDomainFilters(req.query)));
});

app.get("/api/knowledge/sports", async (_req, res) => {
  res.json(getSportsKnowledgeSnapshot());
});

app.post("/api/knowledge/sports/players", async (req, res) => {
  const canonical = String(req.body.canonical ?? "").trim();
  if (!canonical) {
    res.status(400).json({ error: "Player canonical name is required" });
    return;
  }
  const aliases = String(req.body.aliases ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const activeSeasons = String(req.body.activeSeasons ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const team = String(req.body.team ?? "").trim();
  const league = String(req.body.league ?? "");
  const teamsBySeason = Object.fromEntries(activeSeasons.map((season) => [season, team]));
  res.status(201).json(
    upsertSportsKnowledgePlayer({
      canonical,
      aliases,
      activeSeasons,
      teamsBySeason,
      sport: req.body.sport === "american_football" ? "american_football" : "football",
      league: league === "NFL" || league === "Champions League" || league === "Bundesliga" || league === "Premier League" ? league : undefined
    })
  );
});

app.get("/api/orchestrate/plan", async (req, res) => {
  const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
  const scopedAssets = assets
    .filter((asset) => !req.query.indexId || asset.indexId === String(req.query.indexId))
    .filter((asset) => !req.query.tag || asset.tags.includes(String(req.query.tag)))
    .map((asset) =>
      req.query.modality
        ? {
            ...asset,
            timeline: asset.timeline.filter((segment) => segment.modalities.includes(String(req.query.modality) as TimelineSegment["modalities"][number]))
          }
        : asset
    );
  const queryPlan = planDomainQuery(String(req.query.q ?? ""), parseDomainFilters(req.query));
  res.json(buildOrchestrationPlan(queryPlan, scopedAssets, indexes));
});

app.get("/api/vector-search", async (req, res) => {
  const query = String(req.query.q ?? "");
  const queryVector = await traceAsync("search.embed_text_query", {}, () => embedQueryText(expandDomainQuery(query).expandedText), "search.embed_text_query");
  res.json(await searchVectors(req.query.indexId ? String(req.query.indexId) : undefined, queryVector, Number(req.query.limit ?? 25)));
});

app.get("/api/visual-search", async (req, res) => {
  const query = String(req.query.q ?? "");
  const queryVector = await traceAsync("search.embed_visual_query", {}, () => embedVisualQuery(query), "search.embed_visual_query");
  res.json(
    queryVector.length
      ? await searchVisualVectors(req.query.indexId ? String(req.query.indexId) : undefined, queryVector, Number(req.query.limit ?? 25))
      : []
  );
});

app.post("/api/vector-store/rebuild", async (_req, res) => {
  const assets = await listAssets();
  const indexes = await listIndexes();
  for (const index of indexes) {
    if (index.models.embedding !== getEmbeddingModelName()) {
      await saveIndex({
        ...index,
        models: { ...index.models, embedding: getEmbeddingModelName() },
        updatedAt: new Date().toISOString()
      });
    }
  }
  const indexed = assets.filter((asset) => asset.status === "indexed");
  const refreshed = [];
  const visualRecords = [];
  for (const asset of indexed) {
    const index = indexes.find((item) => item.id === asset.indexId) ?? createDefaultIndex();
    const sceneTimeline = asset.timeline.map((segment) => withSceneData(asset, segment));
    const existingKeyframes = asset.keyframes.filter((keyframe) => keyframe.path && keyframe.segmentId);
    const keyframes =
      existingKeyframes.length >= sceneTimeline.length
        ? asset.keyframes
        : await generateKeyframes(
            getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey),
            asset.id,
            sceneTimeline,
            asset.duration
          );
    const thumbnailTimeline = sceneTimeline.map((segment) => {
      const keyframe = keyframes.find((item) => item.segmentId === segment.id);
      if (!keyframe?.path) return segment;
      return {
        ...segment,
        thumbnailPath: keyframe.path,
        sceneData: segment.sceneData
          ? {
              ...segment.sceneData,
              image: {
                ...segment.sceneData.image,
                thumbnailPath: keyframe.path,
                keyframeAt: keyframe.at
              }
            }
          : segment.sceneData
      };
    });
    const detections = await detectTimelineObjects(thumbnailTimeline, keyframes);
    const trackedTimeline = applyEventClassification(applyVisionTracking(applyVisionDetections(thumbnailTimeline, detections)));
    const timeline = await embedTimelineSegments(enrichDomainTimeline({ ...asset, timeline: trackedTimeline }, index, trackedTimeline));
    const modelTrace = asset.intelligence.modelTrace.includes(`embedding:${getEmbeddingModelName()}`)
      ? asset.intelligence.modelTrace
      : [...asset.intelligence.modelTrace, `embedding:${getEmbeddingModelName()}`];
    const nextTrace = modelTrace.includes(`visual-embedding:${getVisualEmbeddingModelName()}`)
      ? modelTrace
      : [...modelTrace, `visual-embedding:${getVisualEmbeddingModelName()}`];
    const next = {
      ...asset,
      timeline,
      keyframes,
      summary: asset.summary.replace(/using [^.]+\. Local ASR/, `using ${getEmbeddingModelName()}. Local ASR`),
      intelligence: {
        ...asset.intelligence,
        modelTrace: nextTrace
      },
      updatedAt: new Date().toISOString()
    };
    await saveAsset(next);
    await upsertAssetTracking(next);
    refreshed.push(next);
    visualRecords.push(...(await embedKeyframes(asset.indexId, asset.id, timeline, keyframes)));
  }
  await rebuildVectorStore(refreshed);
  await rebuildVisualVectorStore(visualRecords);
  await rebuildTrackingStore(refreshed);
  await recordEvent("system.info", "Vector store rebuilt", {
    payload: { assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName() }
  });
  res.json({ ok: true, assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName() });
});

app.post("/api/analyze", async (req, res) => {
  const asset = await getAsset(String(req.body.assetId || ""));
  if (!asset) return sendNotFound(res, "Asset not found");
  const result = await analyzeAndEmit(asset, String(req.body.question ?? ""));
  res.json(result);
});

app.post("/api/assets/:id/analyze", async (req, res) => {
  const asset = await getAsset(String(req.params.id));
  if (!asset) return sendNotFound(res, "Asset not found");
  const result = await analyzeAndEmit(asset, String(req.body.question ?? ""));
  res.json(result);
});

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

app.get("/api/videos", async (_req, res) => {
  res.json(await listVideos());
});

app.get("/api/videos/:id", async (req, res) => {
  const video = await getVideo(String(req.params.id));
  if (!video) return sendNotFound(res, "Video not found");
  res.json(video);
});

app.post("/api/videos", upload.single("video"), async (req, res) => {
  const result = await createAssetFromUpload(req, res, String(req.body.indexId || "default-index"));
  if (result) res.status(202).json(result);
});

app.post("/api/videos/:id/analyze", async (req, res) => {
  const video = await getVideo(String(req.params.id));
  if (!video) return sendNotFound(res, "Video not found");
  const result = await analyzeAndEmit(video, String(req.body.question ?? ""));
  res.json(result);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  res.status(statusCode).json({
    error: error instanceof Error ? error.message : "Unexpected server error"
  });
});

await recoverDetachedLocalJobs();

app.listen(port, () => {
  console.log(`Video intelligence API listening on http://localhost:${port}`);
});

async function recoverDetachedLocalJobs() {
  const jobs = await listJobs();
  const detachedJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  for (const job of detachedJobs) {
    const asset = job.assetId ? await getAsset(job.assetId) : null;
    const hasPreviousIndex = Boolean(asset?.timeline.length);
    const message = hasPreviousIndex
      ? "Detached local job recovered after server restart; previous indexed data was preserved."
      : "Detached local job recovered after server restart; retry is required.";
    await updateJob(
      job.id,
      {
        status: "failed",
        stage: "stale",
        error: message,
        completedAt: new Date().toISOString()
      },
      message,
      "warn"
    );
    if (asset) {
      await updateAsset(asset.id, {
        status: hasPreviousIndex ? "indexed" : "failed",
        progress: hasPreviousIndex ? 100 : asset.progress,
        error: hasPreviousIndex ? null : message
      });
    }
  }
  if (detachedJobs.length > 0) {
    logJson("warn", "jobs.detached.recovered", "Recovered detached local jobs after server restart", { count: detachedJobs.length });
  }
}

function enrichDomainTimeline(asset: AssetRecord, index: IndexRecord, timeline: TimelineSegment[]) {
  const assetWithTimeline = { ...asset, timeline };
  return timeline.map((segment) => {
    const domain = buildDomainSegmentIndex(assetWithTimeline, index, segment);
    if (!domain) return segment;
    return {
      ...segment,
      domain,
      sources: Array.from(new Set([...segment.sources, "domain" as const]))
    };
  });
}

async function createAssetFromUpload(req: express.Request, res: express.Response, indexId: string) {
  if (!req.file) {
    res.status(400).json({ error: "Video file is required" });
    return null;
  }
  let index = await getIndex(indexId);
  if (!index && indexId === "default-index") {
    index = createDefaultIndex();
    await saveIndex(index);
  }
  if (!index) {
    res.status(404).json({ error: "Index not found" });
    return null;
  }

  const now = new Date().toISOString();
  const originalName = normalizeUploadedText(req.file.originalname);
  const title = normalizeUploadedText(req.body.title || originalName.replace(/\.[^.]+$/, ""));
  const description = normalizeUploadedText(req.body.description || "");
  const stored = await putUploadedObject(req.file.path, originalName, randomUUID());
  const assetId = stored.objectKey.split("/")[1] ?? randomUUID();
  const asset: AssetRecord = {
    id: assetId,
    indexId: index.id,
    title,
    description,
    originalName,
    storedName: `${stored.provider}/${stored.bucket}/${stored.objectKey}`,
    mimeType: req.file.mimetype,
    size: stored.size,
    duration: null,
    width: null,
    height: null,
    status: "queued",
    progress: 5,
    tags: [],
    summary: "",
    timeline: [],
    keyframes: [],
    technicalMetadata: {
      storageProvider: stored.provider,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      checksum: stored.checksum,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    },
    intelligence: emptyIntelligence(),
    error: null,
    createdAt: now,
    updatedAt: now
  };

  await saveVideo(asset);
  const job = await createJob("asset.index", index.id, asset.id);
  await recordEvent("asset.uploaded", "Asset uploaded", { indexId: index.id, assetId: asset.id, jobId: job.id });
  enqueueLocalTask(job.id, () =>
    traceJobAsync("job.indexing", { jobId: job.id, assetId: asset.id }, { type: "asset.index" }, () => runIndexingJob(job.id, asset.id, stored.absolutePath))
  );
  return { asset, job };
}

async function runIndexingJob(jobId: string, assetId: string, filePath: string) {
  try {
    await updateJob(jobId, { status: "running", stage: "probe", progress: 12 }, "Started media probing");
    await updateAsset(assetId, { status: "probing", progress: 12 });
    await emitForAsset("asset.indexing.started", "Indexing started", assetId, jobId);
    await sleep(300);

    const metadata = await traceAsync("stage.probe", { jobId, assetId }, () => probeVideo(filePath), "stage.probe");
    const current = await getAsset(assetId);
    if (!current) return;
    await saveAsset({
      ...current,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      technicalMetadata: {
        ...current.technicalMetadata,
        frameRate: metadata.frameRate,
        audioCodec: metadata.audioCodec,
        videoCodec: metadata.videoCodec
      },
      status: "sampling",
      progress: 38,
      updatedAt: new Date().toISOString()
    });
    await updateJob(jobId, { stage: "sample", progress: 38 }, "Generated local frame/audio sampling plan");
    await emitForAsset("asset.indexing.progress", "Sampling complete", assetId, jobId, { progress: 38 });
    await sleep(250);

    await updateAsset(assetId, { status: "transcribing", progress: 40 });
    await updateJob(jobId, { stage: "local-model-runtime", progress: 40 }, "Running local ASR/OCR/visual model runtime");
    const runtimeInput = await getAsset(assetId);
    if (!runtimeInput) return;
    const intelligence = await traceAsync(
      "stage.local_model_runtime",
      { jobId, assetId },
      () => runLocalModelRuntime(filePath, runtimeInput, (event) => updateRuntimeStage(jobId, event)),
      "stage.local_model_runtime"
    );
    await updateAsset(assetId, { status: "scanning", progress: 60, intelligence });
    await updateJob(jobId, { stage: "scan", progress: 60 }, "Local ASR, OCR, and visual scan complete");
    await emitForAsset("asset.indexing.progress", "Local model runtime complete", assetId, jobId, { progress: 60 });
    await sleep(250);

    await updateAsset(assetId, { status: "embedding", progress: 68 });
    await updateJob(jobId, { stage: "timeline", progress: 68 }, "Building searchable timeline and scene windows");
    await emitForAsset("asset.indexing.progress", "Timeline indexing started", assetId, jobId, { progress: 68 });

    const refreshed = await getAsset(assetId);
    if (!refreshed) return;
    const index = (await getIndex(refreshed.indexId)) ?? createDefaultIndex();
    const embeddingIndex =
      index.models.embedding === getEmbeddingModelName()
        ? index
        : {
            ...index,
            models: { ...index.models, embedding: getEmbeddingModelName() },
            updatedAt: new Date().toISOString()
          };
    if (embeddingIndex !== index) await saveIndex(embeddingIndex);
    const sceneBoundaries = await traceAsync(
      "stage.scene_detection",
      { jobId, assetId },
      () => detectSceneBoundaries(filePath, refreshed.duration),
      "stage.scene_detection"
    );
    await updateJob(jobId, { stage: "scene-detection", progress: 72 }, `Detected ${sceneBoundaries.length} scene boundaries`);
    const output = await traceAsync(
      "stage.timeline_build",
      { jobId, assetId, sceneBoundaries: sceneBoundaries.length },
      async () => buildLocalIndex(refreshed, embeddingIndex, sceneBoundaries),
      "stage.timeline_build"
    );
    await updateJob(jobId, { stage: "keyframes", progress: 74 }, "Generating timeline keyframes");
    await updateAsset(assetId, { status: "embedding", progress: 74 });
    const keyframes = await traceAsync(
      "stage.keyframes",
      { jobId, assetId, segments: output.timeline.length },
      () => generateKeyframes(filePath, refreshed.id, output.timeline, refreshed.duration),
      "stage.keyframes"
    );
    const thumbnailTimeline = output.timeline.map((segment) => {
      const keyframe = keyframes.find((item) => item.segmentId === segment.id);
      const thumbnailPath = keyframe?.path || null;
      return {
        ...segment,
        thumbnailPath,
        sceneData: segment.sceneData
          ? {
              ...segment.sceneData,
              image: {
                ...segment.sceneData.image,
                thumbnailPath,
                keyframeAt: keyframe?.at ?? segment.sceneData.image.keyframeAt
              }
            }
          : undefined
      };
    });
    await updateJob(jobId, { stage: "vision-detection", progress: 78 }, "Detecting players and ball candidates in keyframes");
    await updateAsset(assetId, { status: "embedding", progress: 78 });
    const detections = await traceAsync(
      "stage.vision_detection",
      { jobId, assetId, segments: thumbnailTimeline.length },
      () => detectTimelineObjects(thumbnailTimeline, keyframes),
      "stage.vision_detection"
    );
    const detectedTimeline = applyEventClassification(applyVisionTracking(applyVisionDetections(thumbnailTimeline, detections)));
    const timelineForDomain = embeddingIndex.domainIndexing?.enabled
      ? enrichDomainTimeline({ ...refreshed, timeline: detectedTimeline }, embeddingIndex, detectedTimeline)
      : detectedTimeline;
    if (embeddingIndex.domainIndexing?.enabled) {
      const domainEvents = timelineForDomain.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
      await updateJob(jobId, { stage: "domain-index", progress: 82 }, `Sports domain event layer ready with ${domainEvents} event candidates`);
    }
    await updateJob(jobId, { stage: "embed", progress: 84 }, `Computing semantic text embeddings with ${getEmbeddingModelName()}`);
    await emitForAsset("asset.indexing.progress", "Embedding started", assetId, jobId, { progress: 84, model: getEmbeddingModelName() });
    const timeline = await traceAsync(
      "model.embedding.text",
      { jobId, assetId, segments: timelineForDomain.length },
      () => embedTimelineSegments(timelineForDomain),
      "model.embedding.text"
    );
    await updateJob(jobId, { stage: "embed", progress: 86 }, `Semantic text embeddings ready via ${getEmbeddingModelName()}`);
    await updateAsset(assetId, { status: "embedding", progress: 86 });
    await emitForAsset("asset.indexing.progress", "Embedding complete", assetId, jobId, { progress: 86, model: getEmbeddingModelName() });
    await sleep(250);
    await updateJob(jobId, { stage: "vector-upsert-text", progress: 88 }, "Writing text timeline vectors");
    await updateAsset(assetId, { status: "embedding", progress: 88 });
    await traceAsync("stage.vector_upsert.text", { jobId, assetId, segments: timeline.length }, () => upsertAssetVectors(embeddingIndex.id, refreshed.id, timeline), "stage.vector_upsert.text");
    await updateJob(jobId, { stage: "visual-embedding", progress: 92 }, `Computing visual embeddings with ${getVisualEmbeddingModelName()}`);
    await updateAsset(assetId, { status: "embedding", progress: 92 });
    const visualVectors = await traceAsync(
      "model.embedding.visual",
      { jobId, assetId, keyframes: keyframes.length },
      () => embedKeyframes(embeddingIndex.id, refreshed.id, timeline, keyframes),
      "model.embedding.visual"
    );
    await updateJob(jobId, { stage: "vector-upsert-visual", progress: 96 }, "Writing visual vectors");
    await updateAsset(assetId, { status: "embedding", progress: 96 });
    await traceAsync(
      "stage.vector_upsert.visual",
      { jobId, assetId, vectors: visualVectors.length },
      () => upsertAssetVisualVectors(embeddingIndex.id, refreshed.id, visualVectors),
      "stage.vector_upsert.visual"
    );
    await updateJob(jobId, { stage: "finalize", progress: 98 }, "Saving indexed asset record");
    await updateAsset(assetId, { status: "embedding", progress: 98 });
    const indexedAsset: AssetRecord = {
      ...refreshed,
      intelligence: {
        ...refreshed.intelligence,
        modelTrace: [
          ...refreshed.intelligence.modelTrace,
          `embedding:${getEmbeddingModelName()}`,
          `visual-embedding:${getVisualEmbeddingModelName()}`
        ]
      },
      ...output,
      timeline,
      keyframes,
      status: "indexed",
      progress: 100,
      error: null,
      updatedAt: new Date().toISOString()
    };
    await saveAsset(indexedAsset);
    await traceAsync("stage.tracking_upsert", { jobId, assetId, segments: timeline.length }, () => upsertAssetTracking(indexedAsset), "stage.tracking_upsert");
    await updateJob(
      jobId,
      { status: "succeeded", stage: "complete", progress: 100, completedAt: new Date().toISOString() },
      `Indexed ${output.timeline.length} timeline segments`
    );
    await emitForAsset("asset.indexing.succeeded", "Indexing succeeded", assetId, jobId, {
      segments: output.timeline.length
    });
    await recordBilling(assetId, jobId, Math.max(1, Math.ceil((refreshed.duration ?? 0) / 60)), "local indexing compute");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown indexing error";
    logJson("error", "job.indexing.failed", message, { jobId, assetId });
    await updateAsset(assetId, { status: "failed", error: message });
    await updateJob(
      jobId,
      { status: "failed", stage: "failed", error: message, completedAt: new Date().toISOString() },
      message,
      "error"
    );
    await emitForAsset("asset.indexing.failed", "Indexing failed", assetId, jobId, { error: message });
  }
}

async function runSpeakerDiarizationJob(jobId: string, assetId: string) {
  let stopProgress = () => {};
  try {
    await updateJob(jobId, { status: "running", stage: "diarization", progress: 5 }, "Running WhisperX speaker diarization only");
    const asset = await getAsset(assetId);
    if (!asset) throw new Error("Asset not found");
    stopProgress = startDiarizationProgress(jobId);
    const diarization = await traceAsync(
      "model.diarization.whisperx.retry",
      { jobId, assetId },
      () => runWhisperXDiarizationForAsset(asset),
      "model.diarization.whisperx.retry"
    );
    stopProgress();
    const modelTrace = [
      ...asset.intelligence.modelTrace.filter((trace) => !trace.startsWith("whisperx-unavailable:") && !trace.startsWith("whisperx:speakers:")),
      diarization.segments.length > 0 ? `whisperx:speakers:${diarization.speakers.length}` : `whisperx-unavailable:${diarization.error ?? "no speaker segments"}`
    ];
    await saveAsset({
      ...asset,
      intelligence: {
        ...asset.intelligence,
        asr: {
          ...asset.intelligence.asr,
          segments: applyDiarizationToAsrSegments(asset.intelligence.asr.segments, diarization.segments)
        },
        diarization,
        modelTrace
      },
      status: asset.timeline.length > 0 ? "indexed" : asset.status,
      progress: asset.timeline.length > 0 ? 100 : asset.progress,
      error: null,
      updatedAt: new Date().toISOString()
    });
    if (diarization.segments.length === 0) {
      throw new Error(diarization.error ?? "WhisperX did not return speaker segments");
    }
    await updateJob(
      jobId,
      { status: "succeeded", stage: "complete", progress: 100, completedAt: new Date().toISOString() },
      `WhisperX diarization completed with ${diarization.speakers.length} speakers`
    );
  } catch (error) {
    stopProgress();
    const message = error instanceof Error ? error.message : "WhisperX diarization failed";
    logJson("error", "job.diarization.failed", message, { jobId, assetId });
    await updateJob(
      jobId,
      { status: "failed", stage: "failed", progress: 100, error: message, completedAt: new Date().toISOString() },
      message,
      "error"
    );
  }
}

function startDiarizationProgress(jobId: string) {
  let progress = 5;
  const timer = setInterval(() => {
    progress = Math.min(95, progress + 1);
    void updateJob(jobId, { progress }, "WhisperX diarization is still running");
  }, 60000);
  return () => clearInterval(timer);
}

async function analyzeAndEmit(asset: AssetRecord, question: string) {
  if (asset.status !== "indexed") {
    throw Object.assign(new Error("Asset is not indexed yet"), { statusCode: 409 });
  }
  const result = await analyzeAsset(asset, question);
  const event = await recordEvent("analysis.completed", "Analysis completed", {
    indexId: asset.indexId,
    assetId: asset.id,
    payload: { question, signals: result.signals }
  });
  await deliverEvent("analysis.completed", event);
  await recordBilling(asset.id, null, 1, "local analysis request");
  return result;
}

async function createJob(type: JobRecord["type"], indexId: string | null, assetId: string | null) {
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: randomUUID(),
    type,
    status: "queued",
    stage: "queued",
    progress: 0,
    indexId,
    assetId,
    logs: [{ at: now, level: "info", message: "Job queued" }],
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  return saveJob(job);
}

async function getActiveAssetJob(assetId: string) {
  const jobs = await listJobs();
  return jobs.find((job) => job.assetId === assetId && (job.status === "queued" || job.status === "running")) ?? null;
}

async function updateRuntimeStage(
  jobId: string,
  event: { stage: string; status: "running" | "succeeded" | "failed"; message: string; error?: string }
) {
  const progressByStage: Record<string, number> = {
    audio: 42,
    "audio-probe": 44,
    visual: 46,
    asr: 50,
    diarization: 52,
    ocr: 54
  };
  const progress = progressByStage[event.stage] ?? 50;
  const stage = event.status === "running" ? `runtime-${event.stage}` : `runtime-${event.stage}-${event.status}`;
  const level = event.status === "failed" ? "warn" : "info";
  const message = event.error ? `${event.message}: ${event.error}` : event.message;
  const updated = await updateJob(jobId, { stage, progress }, `[runtime:${event.stage}:${event.status}] ${message}`, level);
  if (updated?.assetId) {
    await updateAsset(updated.assetId, {
      status: event.stage === "asr" || event.stage === "diarization" ? "transcribing" : "scanning",
      progress
    });
  }
}

function normalizeWorkflowStage(value: unknown) {
  const stage = typeof value === "string" ? value.trim().toLowerCase() : "";
  const allowed = new Set(["input", "probe", "audio", "vad", "asr", "speakers", "ocr", "visual", "timeline", "domain", "vector", "ready"]);
  return allowed.has(stage) ? stage : null;
}

function normalizeDomainIndexing(value: unknown): IndexRecord["domainIndexing"] {
  if (!value || typeof value !== "object") {
    return { enabled: false, groups: [], stages: [] };
  }
  const record = value as Record<string, unknown>;
  const groups = Array.isArray(record.groups) ? record.groups.filter((group): group is "sports.football" => group === "sports.football") : [];
  const allowedStages = new Set(["domain_caption", "event_label", "structured_event"]);
  const stages = Array.isArray(record.stages)
    ? record.stages.filter((stage): stage is "domain_caption" | "event_label" | "structured_event" => typeof stage === "string" && allowedStages.has(stage))
    : [];
  return {
    enabled: Boolean(record.enabled) && groups.length > 0 && stages.length > 0,
    groups,
    stages
  };
}

async function updateJob(
  id: string,
  patch: Partial<JobRecord>,
  logMessage?: string,
  level: JobRecord["logs"][number]["level"] = "info"
) {
  const current = await getJob(id);
  if (!current) return null;
  const next: JobRecord = {
    ...current,
    ...patch,
    logs: logMessage ? [...current.logs, { at: new Date().toISOString(), level, message: logMessage }] : current.logs,
    updatedAt: new Date().toISOString()
  };
  return saveJob(next);
}

async function updateAsset(id: string, patch: Partial<AssetRecord>) {
  const current = await getAsset(id);
  if (!current) return null;
  return saveAsset({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

async function emitForAsset(
  type: WebhookEventType,
  message: string,
  assetId: string,
  jobId: string,
  payload: Record<string, unknown> = {}
) {
  const asset = await getAsset(assetId);
  const event = await recordEvent(type, message, {
    indexId: asset?.indexId ?? null,
    assetId,
    jobId,
    payload
  });
  await deliverEvent(type, event);
}

async function recordEvent(
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

async function deliverEvent(type: WebhookEventType, event: EventRecord) {
  const webhooks = (await listWebhooks()).filter((webhook) => webhook.active && webhook.events.includes(type));
  await Promise.all(webhooks.map((webhook) => deliverWebhook(webhook, type, event, 1)));
}

async function deliverWebhook(webhook: WebhookRecord, type: WebhookEventType, event: EventRecord, attempts = 1) {
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

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.method === "GET" && rateLimitExemptGetPaths.has(req.path)) {
    next();
    return;
  }
  const key = req.ip ?? "local";
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || current.resetAt < now) {
    requestBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    next();
    return;
  }
  current.count += 1;
  if (current.count > rateLimitPerMinute) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }
  next();
}

function optionalApiKeyAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const configured = process.env.API_KEYS?.split(",").map((key) => key.trim()).filter(Boolean) ?? [];
  if (configured.length === 0) {
    next();
    return;
  }
  const key = String(req.header("x-api-key") || "");
  void getUserByApiKey(key).then((user) => {
    if (!configured.includes(key) && !user) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    next();
  });
}

function sendNotFound(res: express.Response, message: string) {
  res.status(404).json({ error: message });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyIntelligence(): LocalIntelligence {
  return {
    audio: { extractedPath: null, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
    asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
    diarization: { provider: "none", speakers: [], segments: [], error: null },
    ocr: { tokens: [], confidence: 0, frames: [] },
    visual: { labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0 },
    modelTrace: []
  };
}

async function recordBilling(assetId: string | null, jobId: string | null, units: number, reason: string) {
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
