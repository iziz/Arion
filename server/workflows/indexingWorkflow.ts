import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { buildLocalIndex, probeVideo, withSceneData } from "../intelligence";
import { embedTimelineSegments, getEmbeddingModelName } from "../localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../localVisualEmbeddingRuntime";
import { generateKeyframes } from "../keyframes";
import { runLocalModelRuntime, type LocalRuntimePartial } from "../localModelRuntime";
import { assertCapabilityAvailable, isCapabilityEnabled, isCapabilityRequired, resolveCapabilityPolicy } from "../modelCapabilities";
import { applyEventClassification } from "../eventClassifier";
import { putUploadedObject } from "../localObjectStorage";
import { upsertAssetVectors } from "../localVectorStore";
import { upsertAssetVisualVectors } from "../localVisualVectorStore";
import { applyVisionDetections, applyVisionTracking, applyVisionTracks, detectTimelineObjects, detectTimelineTracks } from "../visionDetectionRuntime";
import { detectSceneBoundaries } from "../sceneDetection";
import { getKnowledgeActionSpottingModelLabel, isKnowledgeActionSpottingConfigured, runKnowledgeActionSpotting } from "../knowledgeAdapters";
import { upsertAssetTracking } from "../trackingStore";
import { analyzeTimelineWithVlm, getVlmWorkerModelName, isVlmWorkerEnabled, refineRelatedKnowledgeTimelineWithVlm } from "../vlmWorkerClient";
import { logJson, traceAsync } from "../observability";
import { normalizeUploadedText } from "../textEncoding";
import { getAsset, getIndex, getJob, saveAsset, saveIndex, saveVideo } from "../store";
import { createQueuedAssetJob, updateAsset, updateJob } from "../services/jobState";
import {
  completeJobStageCheckpoint,
  failActiveJobStageCheckpoint,
  normalizeCheckpointStage,
  shouldRunJobStage,
  startJobStageCheckpoint,
  type JobStageOrder
} from "../services/jobStageCheckpoint";
import { deliverEvent, recordBilling, recordEvent } from "../services/events";
import { discardUploadTempFile, pruneGeneratedAssetMedia } from "../services/mediaLifecycle";
import { enrichDomainTimeline } from "./domainVlmWorkflow";
import { resolveTimelineMatchIdentity } from "../domainIndex/matchIdentityResolver";
import { buildRuntimeStageJobUpdate, type RuntimeStageEvent } from "./runtimeStageState";
import { getWorkflowRetryImpactedEvidence, type WorkflowEvidence } from "../../shared/workflowNodes";
import type { AssetRecord, IndexRecord, JobRecord, LocalIntelligence, WebhookEventType } from "../../shared/types";
import { applyExtractiveVideoSummaries, EXTRACTIVE_SUMMARY_TRACE_PREFIX } from "../intelligenceCore/extractiveSummary";

export { analyzeAndEmit } from "./analysisWorkflow";
export { enrichDomainTimeline, runDomainVlmRefineJob } from "./domainVlmWorkflow";

export async function createAssetFromUpload(req: Request, res: Response, indexId: string) {
  if (!req.file) {
    res.status(400).json({ error: "Video file is required" });
    return null;
  }
  let index = await getIndex(indexId);
  if (!index) {
    await discardUploadTempFile(req.file);
    res.status(404).json({ error: "Index not found" });
    return null;
  }

  const now = new Date().toISOString();
  const originalName = normalizeUploadedText(req.file.originalname);
  const title = normalizeUploadedText(req.body.title || originalName.replace(/\.[^.]+$/, ""));
  const description = normalizeUploadedText(req.body.description || "");
  let stored: Awaited<ReturnType<typeof putUploadedObject>>;
  try {
    stored = await putUploadedObject(req.file.path, originalName, randomUUID());
  } catch (error) {
    await discardUploadTempFile(req.file);
    throw error;
  }
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
  const job = await createQueuedAssetJob("asset.index", index.id, asset.id);
  await recordEvent("asset.uploaded", "Asset uploaded", { indexId: index.id, assetId: asset.id, jobId: job.id });
  return { asset, job };
}

type RunIndexingJobOptions = {
  retryStage?: string | null;
};

const runtimeStageUpdateQueues = new Map<string, Promise<void>>();
const indexingCheckpointOrder = [
  "probe",
  "local-model-runtime",
  "timeline",
  "video-vlm",
  "vision-detection",
  "vision-tracking",
  "domain-index",
  "summary",
  "embed",
  "vector-upsert-text",
  "visual-embedding",
  "vector-upsert-visual",
  "finalize"
] as const satisfies JobStageOrder;

export async function runIndexingJob(jobId: string, assetId: string, filePath: string, options: RunIndexingJobOptions = {}) {
  try {
    await ensureRetryRebuildScope(jobId, options.retryStage);
    await invalidateRetryStageOutputs(jobId, assetId, options.retryStage);
    await runCheckpointedIndexingStage(jobId, "probe", 38, "Probe and sampling complete", options.retryStage, () => assetHasProbeMetadata(assetId), async () => {
      await updateJob(jobId, { status: "running", stage: "probe", progress: 12 }, "Started media probing");
      await updateAsset(assetId, { status: "probing", progress: 12 });
      await emitForAsset("asset.indexing.started", "Indexing started", assetId, jobId);
      await sleep(300);

      const metadata = await traceAsync("stage.probe", { jobId, assetId }, () => probeVideo(filePath), "stage.probe");
      const current = await getAsset(assetId);
      if (!current) throw new Error("Asset not found during media probing.");
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
    });

    await runCheckpointedIndexingStage(jobId, "local-model-runtime", 60, "Local ASR, OCR, and visual runtime complete", options.retryStage, () => assetHasRuntimeIntelligence(assetId), async () => {
      await updateAsset(assetId, { status: "transcribing", progress: 40 });
      await updateJob(jobId, { stage: "local-model-runtime", progress: 40 }, "Running local ASR/OCR/visual model runtime");
      const runtimeInput = await getAsset(assetId);
      if (!runtimeInput) throw new Error("Asset not found before local model runtime.");
      const runtimeIndex = await requireIndex(runtimeInput.indexId);
      const runtimePolicy = resolveCapabilityPolicy(runtimeIndex);
      const runtimeJob = await getJob(jobId);
      const runtimeRetryStage = getEffectiveRetryStage(runtimeJob, options.retryStage);
      const intelligence = await traceAsync(
        "stage.local_model_runtime",
        { jobId, assetId },
        () =>
          runLocalModelRuntime(filePath, runtimeInput, (event) => updateRuntimeStage(jobId, event, { keepJobStage: true }), {
            forceStages: getForcedRuntimeStages(runtimeRetryStage, runtimeJob, runtimeInput),
            whisperXDiarization: runtimePolicy.whisperXDiarization,
            onPartial: (_stage, partial) => mergeLocalRuntimePartial(assetId, partial)
          }),
        "stage.local_model_runtime"
      );
      assertCapabilityAvailable(
        runtimeIndex,
        "whisperXDiarization",
        intelligence.diarization.provider !== "none" && intelligence.diarization.segments.length > 0,
        intelligence.diarization.error ?? "WhisperX did not return speaker segments."
      );
      await updateAsset(assetId, { status: "scanning", progress: 60, intelligence });
      await updateJob(jobId, { stage: "scan", progress: 60 }, "Local ASR, OCR, and visual scan complete");
      await emitForAsset("asset.indexing.progress", "Local model runtime complete", assetId, jobId, { progress: 60 });
      await sleep(250);
    });

    const timelineStage = await runCheckpointedIndexingStage(jobId, "timeline", 76, "Timeline, scene windows, and keyframes ready", options.retryStage, () => assetHasTimelineSnapshot(assetId), async () => {
      await updateAsset(assetId, { status: "embedding", progress: 68 });
      await updateJob(jobId, { stage: "timeline", progress: 68 }, "Building searchable timeline and scene windows");
      await emitForAsset("asset.indexing.progress", "Timeline indexing started", assetId, jobId, { progress: 68 });

      const refreshed = await getAsset(assetId);
      if (!refreshed) throw new Error("Asset not found before timeline build.");
      const index = await requireIndex(refreshed.indexId);
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
      const thumbnailTimeline = attachKeyframesToTimeline(output.timeline, keyframes);
      await persistIndexingSnapshot(assetId, {
        status: "embedding",
        progress: 76,
        tags: output.tags,
        summary: output.summary,
        timeline: thumbnailTimeline,
        keyframes
      });
      return { refreshed, embeddingIndex, capabilityPolicy: resolveCapabilityPolicy(embeddingIndex), output, keyframes, thumbnailTimeline };
    }, async () => {
      const asset = await requireAsset(assetId);
      const index = await requireIndex(asset.indexId);
      return {
        refreshed: asset,
        embeddingIndex: index,
        capabilityPolicy: resolveCapabilityPolicy(index),
        output: { tags: asset.tags, summary: asset.summary, timeline: asset.timeline },
        keyframes: asset.keyframes,
        thumbnailTimeline: asset.timeline
      };
    });

    let videoVlmTrace = traceFromAsset(timelineStage.refreshed, "video-vlm") ?? "";
    let videoVlmTimeline: AssetRecord["timeline"] = timelineStage.thumbnailTimeline;
    const shouldRunVideoVlm =
      isCapabilityEnabled(timelineStage.embeddingIndex, "videoVlmAnalysis") &&
      (isVlmWorkerEnabled() || isCapabilityRequired(timelineStage.embeddingIndex, "videoVlmAnalysis"));
    if (shouldRunVideoVlm) {
      const videoVlmStage = await runCheckpointedIndexingStage(jobId, "video-vlm", 78, "Video VLM analysis complete", options.retryStage, () => assetHasModelTrace(assetId, "video-vlm"), async () => {
        assertCapabilityAvailable(timelineStage.embeddingIndex, "videoVlmAnalysis", isVlmWorkerEnabled(), "VLM_WORKER_URL is not configured.");
        await updateJob(jobId, { stage: "video-vlm", progress: 76 }, `Analyzing timeline keyframes with ${getVlmWorkerModelName()}`);
        const videoVlm = await traceAsync(
          "model.vlm.video_segment",
          { jobId, assetId, segments: timelineStage.thumbnailTimeline.length, model: getVlmWorkerModelName() },
          () =>
            analyzeTimelineWithVlm({ ...timelineStage.refreshed, timeline: timelineStage.thumbnailTimeline }, timelineStage.thumbnailTimeline, {
              onProgress: async (event) => {
                await updateJob(
                  jobId,
                  { stage: "video-vlm", progress: Number((76 + event.progress * 0.02).toFixed(2)) },
                  `[video-vlm:${event.status}] ${event.message}`
                );
              }
            }),
          "model.vlm.video_segment"
        );
        const trace = videoVlm.attemptedSegments > 0
          ? `video-vlm:${videoVlm.model}:${videoVlm.describedSegments}/${videoVlm.attemptedSegments}:invalid=${videoVlm.invalidSegments}:failed=${videoVlm.failedSegments}`
          : "video-vlm-unavailable:No timeline keyframes were available for video VLM analysis.";
        await updateJob(
          jobId,
          { stage: "video-vlm", progress: 78 },
          `Video VLM analysis completed for ${videoVlm.describedSegments}/${videoVlm.attemptedSegments} attempted segments (${videoVlm.invalidSegments} invalid, ${videoVlm.failedSegments} failed)`
        );
        await persistIndexingSnapshot(assetId, {
          status: "embedding",
          progress: 78,
          tags: timelineStage.output.tags,
          summary: timelineStage.output.summary,
          timeline: videoVlm.timeline,
          keyframes: timelineStage.keyframes,
          modelTrace: [trace]
        });
        if (videoVlm.errors.length > 0) {
          logJson("warn", "model.vlm.video_segment.partial", "Video VLM analysis had partial failures", { jobId, assetId, errors: videoVlm.errors });
        }
        return { trace, timeline: videoVlm.timeline };
      }, async () => {
        const asset = await requireAsset(assetId);
        return { trace: traceFromAsset(asset, "video-vlm") ?? "", timeline: asset.timeline };
      });
      videoVlmTrace = videoVlmStage.trace;
      videoVlmTimeline = videoVlmStage.timeline;
    } else {
      videoVlmTrace = isCapabilityEnabled(timelineStage.embeddingIndex, "videoVlmAnalysis")
        ? "video-vlm-unavailable:VLM_WORKER_URL is not configured."
        : "video-vlm-unavailable:Video VLM analysis disabled by capability policy.";
      assertCapabilityAvailable(timelineStage.embeddingIndex, "videoVlmAnalysis", isVlmWorkerEnabled(), "VLM_WORKER_URL is not configured.");
      await completeJobStageCheckpoint(jobId, "video-vlm", 78, videoVlmTrace, "skipped");
    }

    const detectionStage = await runCheckpointedIndexingStage(jobId, "vision-detection", 79, "Vision detection complete", options.retryStage, () => assetHasModelTrace(assetId, "vision-detector"), async () => {
      await updateJob(jobId, { stage: "vision-detection", progress: 78 }, "Detecting configured domain object candidates in keyframes");
      await updateAsset(assetId, { status: "embedding", progress: 78 });
      const detections = isCapabilityEnabled(timelineStage.embeddingIndex, "visionDetector")
        ? await traceAsync(
            "stage.vision_detection",
            { jobId, assetId, segments: videoVlmTimeline.length },
            () => detectTimelineObjects(videoVlmTimeline, timelineStage.keyframes),
            "stage.vision_detection"
          )
        : { available: false, provider: "disabled", model: timelineStage.capabilityPolicy.visionDetector, frames: [], error: "Vision detector disabled by capability policy." };
      const detectorTrace = detections.available
        ? `vision-detector:${detections.provider}:${detections.model}:${detections.frames.length}`
        : `vision-detector-unavailable:${detections.error ?? "detector unavailable"}`;
      assertCapabilityAvailable(timelineStage.embeddingIndex, "visionDetector", detections.available, detections.error ?? "Detector returned unavailable.");
      const trackedV0Timeline = applyVisionTracking(applyVisionDetections(videoVlmTimeline, detections));
      await persistIndexingSnapshot(assetId, {
        status: "embedding",
        progress: 79,
        tags: timelineStage.output.tags,
        summary: timelineStage.output.summary,
        timeline: trackedV0Timeline,
        keyframes: timelineStage.keyframes,
        modelTrace: [videoVlmTrace, detectorTrace]
      });
      return { detectorTrace, trackedV0Timeline };
    }, async () => {
      const asset = await requireAsset(assetId);
      return { detectorTrace: traceFromAsset(asset, "vision-detector") ?? "", trackedV0Timeline: asset.timeline };
    });

    const trackingStage = await runCheckpointedIndexingStage(jobId, "vision-tracking", 80, "Vision tracking complete", options.retryStage, () => assetHasModelTrace(assetId, "vision-tracker"), async () => {
      await updateJob(jobId, { stage: "vision-tracking", progress: 80 }, "Tracking configured domain object candidates over video");
      const tracks = isCapabilityEnabled(timelineStage.embeddingIndex, "visionTracker")
        ? await traceAsync(
            "stage.vision_tracking",
            { jobId, assetId, segments: detectionStage.trackedV0Timeline.length },
            () => detectTimelineTracks(filePath, detectionStage.trackedV0Timeline),
            "stage.vision_tracking"
          )
        : { available: false, provider: "disabled", model: timelineStage.capabilityPolicy.visionDetector, tracker: timelineStage.capabilityPolicy.visionTracker, segments: [], error: "Vision tracker disabled by capability policy." };
      const trackerTrace = tracks.available
        ? `vision-tracker:${tracks.provider}:${tracks.tracker}:${tracks.segments.length}`
        : `vision-tracker-unavailable:${tracks.error ?? "tracker unavailable"}`;
      assertCapabilityAvailable(timelineStage.embeddingIndex, "visionTracker", tracks.available, tracks.error ?? "Tracker returned unavailable.");
      const detectedTimeline = applyEventClassification(applyVisionTracks(detectionStage.trackedV0Timeline, tracks));
      await persistIndexingSnapshot(assetId, {
        status: "embedding",
        progress: 80,
        tags: timelineStage.output.tags,
        summary: timelineStage.output.summary,
        timeline: detectedTimeline,
        keyframes: timelineStage.keyframes,
        modelTrace: [videoVlmTrace, detectionStage.detectorTrace, trackerTrace]
      });
      return { trackerTrace, detectedTimeline };
    }, async () => {
      const asset = await requireAsset(assetId);
      return { trackerTrace: traceFromAsset(asset, "vision-tracker") ?? "", detectedTimeline: asset.timeline };
    });

    const domainStage = await runCheckpointedIndexingStage(jobId, "domain-index", 83, "Domain event layer complete", options.retryStage, () => assetHasDomainSnapshot(assetId, timelineStage.embeddingIndex), async () => {
      let knowledgeActionTrace = "";
      let domainVlmTrace = "";
      let matchIdentityTrace = "";
      let assetIdentity: AssetRecord["identity"] | undefined;
      let actionTimeline = trackingStage.detectedTimeline;
      const shouldRunKnowledgeActionSpotting =
        isCapabilityEnabled(timelineStage.embeddingIndex, "knowledgeActionSpotting") &&
        (isKnowledgeActionSpottingConfigured(timelineStage.embeddingIndex) || isCapabilityRequired(timelineStage.embeddingIndex, "knowledgeActionSpotting"));
      if (shouldRunKnowledgeActionSpotting) {
        await updateJob(jobId, { stage: "knowledge-action", progress: 81 }, `Running knowledge action spotting with ${getKnowledgeActionSpottingModelLabel(timelineStage.embeddingIndex)}`);
        const knowledgeActionResult = await runKnowledgeActionSpotting({
          filePath,
          timeline: trackingStage.detectedTimeline,
          duration: timelineStage.refreshed.duration,
          index: timelineStage.embeddingIndex,
          jobId,
          assetId
        });
        knowledgeActionTrace = knowledgeActionResult.trace;
        assertCapabilityAvailable(timelineStage.embeddingIndex, "knowledgeActionSpotting", knowledgeActionResult.available, knowledgeActionResult.error ?? "Knowledge action spotting unavailable.");
        actionTimeline = knowledgeActionResult.timeline;
      }
      let timelineForDomain = timelineStage.embeddingIndex.domainIndexing?.enabled
        ? enrichDomainTimeline({ ...timelineStage.refreshed, timeline: actionTimeline }, timelineStage.embeddingIndex, actionTimeline)
        : actionTimeline;
      if (timelineStage.embeddingIndex.domainIndexing?.enabled) {
        const domainEvents = timelineForDomain.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
        await updateJob(jobId, { stage: "domain-index", progress: 82 }, `Related knowledge event layer ready with ${domainEvents} event candidates`);
        const shouldRunDomainVlm =
          isCapabilityEnabled(timelineStage.embeddingIndex, "domainVlmRefinement") &&
          (isVlmWorkerEnabled() || isCapabilityRequired(timelineStage.embeddingIndex, "domainVlmRefinement"));
        if (shouldRunDomainVlm) {
          assertCapabilityAvailable(timelineStage.embeddingIndex, "domainVlmRefinement", isVlmWorkerEnabled(), "VLM_WORKER_URL is not configured.");
          await updateJob(jobId, { stage: "domain-vlm", progress: 83 }, `Refining related knowledge event metadata with ${getVlmWorkerModelName()}`);
          const vlmRefinement = await traceAsync(
            "model.vlm.related_knowledge_domain",
            { jobId, assetId, segments: timelineForDomain.length, model: getVlmWorkerModelName() },
            () =>
              refineRelatedKnowledgeTimelineWithVlm({ ...timelineStage.refreshed, timeline: timelineForDomain }, timelineStage.embeddingIndex, timelineForDomain, {
                onProgress: async (event) => {
                  await updateJob(jobId, { stage: "domain-vlm", progress: 82 + Math.round(event.progress * 0.01) }, `[domain-vlm:${event.status}] ${event.message}`);
                }
              }),
            "model.vlm.related_knowledge_domain"
          );
          timelineForDomain = vlmRefinement.timeline;
          domainVlmTrace = `domain-vlm:${vlmRefinement.model}:${vlmRefinement.refinedSegments}/${vlmRefinement.attemptedSegments}:invalid=${vlmRefinement.invalidSegments}:failed=${vlmRefinement.failedSegments}`;
          await updateJob(
            jobId,
            { stage: "domain-vlm", progress: 83 },
            `Related knowledge VLM refinement completed for ${vlmRefinement.refinedSegments}/${vlmRefinement.attemptedSegments} attempted segments (${vlmRefinement.invalidSegments} invalid, ${vlmRefinement.failedSegments} failed)`
          );
          if (vlmRefinement.errors.length > 0) {
            logJson("warn", "model.vlm.related_knowledge_domain.partial", "Related knowledge VLM refinement had partial failures", { jobId, assetId, errors: vlmRefinement.errors });
          }
        }
        const matchIdentity = await traceAsync(
          "stage.match_identity.resolve",
          { jobId, assetId, segments: timelineForDomain.length },
          async () => resolveTimelineMatchIdentity({ ...timelineStage.refreshed, timeline: timelineForDomain }, timelineStage.embeddingIndex, timelineForDomain),
          "stage.match_identity.resolve"
        );
        timelineForDomain = matchIdentity.timeline;
        assetIdentity = matchIdentity.identity;
        matchIdentityTrace = matchIdentity.trace;
        await updateJob(
          jobId,
          { stage: "domain-index", progress: 83 },
          `Sports identity resolver found ${matchIdentity.identity.matchContexts.length} match contexts and ${matchIdentity.identity.trackIdentityAssignments.length} track assignments`
        );
      }
      await persistIndexingSnapshot(assetId, {
        status: "embedding",
        progress: 83,
        tags: timelineStage.output.tags,
        summary: timelineStage.output.summary,
        timeline: timelineForDomain,
        keyframes: timelineStage.keyframes,
        identity: assetIdentity,
        modelTrace: [knowledgeActionTrace, domainVlmTrace, matchIdentityTrace]
      });
      return { knowledgeActionTrace, domainVlmTrace, matchIdentityTrace, timelineForDomain };
    }, async () => {
      const asset = await requireAsset(assetId);
      return {
        knowledgeActionTrace: traceFromAsset(asset, "knowledge-action") ?? traceFromAsset(asset, "soccernet-action") ?? "",
        domainVlmTrace: traceFromAsset(asset, "domain-vlm") ?? "",
        matchIdentityTrace: traceFromAsset(asset, "match-identity") ?? "",
        timelineForDomain: asset.timeline
      };
    });

    const summaryStage = await runCheckpointedIndexingStage(jobId, "summary", 84, "Extractive summaries ready", options.retryStage, () => assetHasExtractiveSummaries(assetId), async () => {
      await updateJob(jobId, { stage: "summary", progress: 83 }, "Building deterministic asset and moment summaries");
      const result = applyExtractiveVideoSummaries(
        { ...timelineStage.refreshed, tags: timelineStage.output.tags, timeline: domainStage.timelineForDomain },
        timelineStage.embeddingIndex,
        domainStage.timelineForDomain
      );
      await persistIndexingSnapshot(assetId, {
        status: "embedding",
        progress: 84,
        tags: timelineStage.output.tags,
        summary: result.summary,
        timeline: result.timeline,
        keyframes: timelineStage.keyframes,
        modelTrace: [result.trace]
      });
      await updateJob(jobId, { stage: "summary", progress: 84 }, `Extractive summaries ready for ${result.summarizedSegments}/${result.timeline.length} timeline segments`);
      return result;
    }, async () => {
      const asset = await requireAsset(assetId);
      return {
        summary: asset.summary,
        timeline: asset.timeline,
        trace: traceFromAsset(asset, EXTRACTIVE_SUMMARY_TRACE_PREFIX) ?? `${EXTRACTIVE_SUMMARY_TRACE_PREFIX}:0/${asset.timeline.length}`,
        summarizedSegments: asset.timeline.filter((segment) => Boolean(segment.summary?.trim())).length
      };
    });

    const timeline = await runCheckpointedIndexingStage(jobId, "embed", 86, "Semantic text embeddings complete", options.retryStage, () => assetHasEmbeddedTimeline(assetId), async () => {
      await updateJob(jobId, { stage: "embed", progress: 84 }, `Computing semantic text embeddings with ${getEmbeddingModelName()}`);
      await emitForAsset("asset.indexing.progress", "Embedding started", assetId, jobId, { progress: 84, model: getEmbeddingModelName() });
      const embeddedTimeline = await traceAsync(
        "model.embedding.text",
        { jobId, assetId, segments: summaryStage.timeline.length },
        () => embedTimelineSegments(summaryStage.timeline),
        "model.embedding.text"
      );
      await persistIndexingSnapshot(assetId, {
        status: "embedding",
        progress: 86,
        tags: timelineStage.output.tags,
        summary: summaryStage.summary,
        timeline: embeddedTimeline,
        keyframes: timelineStage.keyframes,
        modelTrace: [`embedding:${getEmbeddingModelName()}`]
      });
      await updateJob(jobId, { stage: "embed", progress: 86 }, `Semantic text embeddings ready via ${getEmbeddingModelName()}`);
      await updateAsset(assetId, { status: "embedding", progress: 86 });
      await emitForAsset("asset.indexing.progress", "Embedding complete", assetId, jobId, { progress: 86, model: getEmbeddingModelName() });
      await sleep(250);
      return embeddedTimeline;
    }, async () => (await requireAsset(assetId)).timeline);

    await runCheckpointedIndexingStage(jobId, "vector-upsert-text", 88, "Text timeline vectors persisted", options.retryStage, () => assetHasCompletedCheckpoint(jobId, "vector-upsert-text"), async () => {
      await updateJob(jobId, { stage: "vector-upsert-text", progress: 88 }, "Writing text timeline vectors");
      await updateAsset(assetId, { status: "embedding", progress: 88 });
      await traceAsync("stage.vector_upsert.text", { jobId, assetId, segments: timeline.length }, () => upsertAssetVectors(timelineStage.embeddingIndex.id, timelineStage.refreshed.id, timeline), "stage.vector_upsert.text");
    });

    const visualStage = await runCheckpointedIndexingStage(jobId, "visual-embedding", 92, "Visual embedding stage complete", options.retryStage, () => visualEmbeddingCheckpointCanBeReused(jobId), async () => {
      await updateJob(jobId, { stage: "visual-embedding", progress: 92 }, `Computing visual embeddings with ${getVisualEmbeddingModelName()}`);
      await updateAsset(assetId, { status: "embedding", progress: 92 });
      let visualEmbeddingTrace = `visual-embedding:${getVisualEmbeddingModelName()}`;
      let visualVectors: Awaited<ReturnType<typeof embedKeyframes>> = [];
      try {
        visualVectors = await traceAsync(
          "model.embedding.visual",
          { jobId, assetId, keyframes: timelineStage.keyframes.length },
          () => embedKeyframes(timelineStage.embeddingIndex.id, timelineStage.refreshed.id, timeline, timelineStage.keyframes),
          "model.embedding.visual"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Visual embedding unavailable";
        visualEmbeddingTrace = `visual-embedding-unavailable:${message}`;
        logJson("warn", "model.embedding.visual.unavailable", "Visual embedding unavailable", { jobId, assetId, error: message });
        await updateJob(jobId, { stage: "visual-embedding-unavailable", progress: 92 }, `Visual embeddings unavailable: ${message}`, "warn");
      }
      return { visualEmbeddingTrace, visualVectors };
    }, async () => ({ visualEmbeddingTrace: traceFromAsset(await requireAsset(assetId), "visual-embedding") ?? `visual-embedding:${getVisualEmbeddingModelName()}`, visualVectors: [] }));

    await runCheckpointedIndexingStage(jobId, "vector-upsert-visual", 96, "Visual vectors persisted", options.retryStage, () => assetHasCompletedCheckpoint(jobId, "vector-upsert-visual"), async () => {
      await updateJob(jobId, { stage: "vector-upsert-visual", progress: 96 }, "Writing visual vectors");
      await updateAsset(assetId, { status: "embedding", progress: 96 });
      await traceAsync(
        "stage.vector_upsert.visual",
        { jobId, assetId, vectors: visualStage.visualVectors.length },
        () => upsertAssetVisualVectors(timelineStage.embeddingIndex.id, timelineStage.refreshed.id, visualStage.visualVectors),
        "stage.vector_upsert.visual"
      );
    });

    const indexedAsset = await runCheckpointedIndexingStage(jobId, "finalize", 100, "Indexed asset committed", options.retryStage, () => assetIsIndexed(assetId), async () => {
      await updateJob(jobId, { stage: "finalize", progress: 98 }, "Saving indexed asset record");
      await updateAsset(assetId, { status: "embedding", progress: 98 });
      const latest = (await getAsset(assetId)) ?? timelineStage.refreshed;
      const nextAsset: AssetRecord = {
        ...latest,
        intelligence: {
          ...latest.intelligence,
          modelTrace: mergeModelTrace(latest.intelligence.modelTrace, [
            videoVlmTrace,
            detectionStage.detectorTrace,
            trackingStage.trackerTrace,
            domainStage.domainVlmTrace,
            domainStage.knowledgeActionTrace,
            summaryStage.trace,
            `embedding:${getEmbeddingModelName()}`,
            visualStage.visualEmbeddingTrace
          ])
        },
        tags: timelineStage.output.tags,
        summary: summaryStage.summary,
        timeline,
        keyframes: timelineStage.keyframes,
        status: "indexed",
        progress: 100,
        error: null,
        updatedAt: new Date().toISOString()
      };
      await saveAsset(nextAsset);
      await pruneGeneratedAssetMedia(nextAsset);
      await traceAsync("stage.tracking_upsert", { jobId, assetId, segments: timeline.length }, () => upsertAssetTracking(nextAsset), "stage.tracking_upsert");
      return nextAsset;
    }, async () => requireAsset(assetId));
    await updateJob(
      jobId,
      {
        status: "succeeded",
        stage: "complete",
        progress: 100,
        parameters: { ...(await getJob(jobId))?.parameters, retryStage: null, resumeFromStage: null, rebuildFromStage: null, invalidatedRetryStage: null },
        completedAt: new Date().toISOString()
      },
      `Indexed ${indexedAsset.timeline.length} timeline segments`
    );
    await emitForAsset("asset.indexing.succeeded", "Indexing succeeded", assetId, jobId, {
      segments: indexedAsset.timeline.length
    });
    await recordBilling(assetId, jobId, Math.max(1, Math.ceil((indexedAsset.duration ?? 0) / 60)), "local indexing compute");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown indexing error";
    logJson("error", "job.indexing.failed", message, { jobId, assetId });
    await failActiveJobStageCheckpoint(jobId, message);
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

export function normalizeWorkflowStage(value: unknown) {
  const stage = typeof value === "string" ? value.trim().toLowerCase() : "";
  const aliases: Record<string, string> = {
    input: "input",
    probe: "probe",
    audio: "audio",
    vad: "vad",
    asr: "asr",
    speakers: "speakers",
    ocr: "ocr",
    visual: "visual",
    scene: "scene",
    timeline: "timeline",
    keyframes: "keyframes",
    videovlm: "videoVlm",
    "video-vlm": "videoVlm",
    detector: "detector",
    "vision-detection": "detector",
    tracker: "tracker",
    "vision-tracking": "tracker",
    knowledgeaction: "knowledgeAction",
    "knowledge-action": "knowledgeAction",
    "soccernet-action": "knowledgeAction",
    domain: "domain",
    domainvlm: "domainVlm",
    "domain-vlm": "domainVlm",
    summary: "summary",
    extractivesummary: "summary",
    "extractive-summary": "summary",
    textembedding: "textEmbedding",
    "text-embedding": "textEmbedding",
    embed: "textEmbedding",
    visualembedding: "visualEmbedding",
    "visual-embedding": "visualEmbedding",
    vector: "vector",
    ready: "ready",
    finalize: "ready"
  };
  return aliases[stage] ?? null;
}

async function updateRuntimeStage(
  jobId: string,
  event: RuntimeStageEvent,
  options: { keepJobStage?: boolean } = {}
) {
  const previous = runtimeStageUpdateQueues.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => updateRuntimeStageNow(jobId, event, options));
  const settled = next.then(() => undefined, () => undefined);
  runtimeStageUpdateQueues.set(jobId, settled);
  try {
    return await next;
  } finally {
    if (runtimeStageUpdateQueues.get(jobId) === settled) runtimeStageUpdateQueues.delete(jobId);
  }
}

async function updateRuntimeStageNow(
  jobId: string,
  event: RuntimeStageEvent,
  options: { keepJobStage?: boolean } = {}
) {
  const currentJob = await getJob(jobId);
  const { patch, logMessage, level } = buildRuntimeStageJobUpdate(currentJob, event, new Date().toISOString(), options);
  const updated = await updateJob(jobId, patch, logMessage, level);
  if (updated?.assetId) {
    await updateAsset(updated.assetId, {
      status: event.stage === "asr" || event.stage === "diarization" ? "transcribing" : "scanning",
      progress: patch.progress ?? updated.progress
    });
  }
}

export function getForcedRuntimeStages(retryStage: string | null | undefined, job?: JobRecord | null, asset?: AssetRecord | null) {
  if (!retryStage) return [];
  const requested =
    retryStage === "asr"
      ? ["asr", "diarization"]
      : retryStage === "speakers"
        ? ["diarization"]
        : retryStage === "ocr"
          ? ["ocr"]
          : retryStage === "visual"
            ? ["visual"]
            : retryStage === "audio" || retryStage === "vad"
              ? ["audio", "audio-probe", "asr", "diarization"]
              : [];
  return requested.filter((stage) => {
    if (job?.runtimeStages?.[stage]?.status === "succeeded") return false;
    return true;
  });
}

async function mergeLocalRuntimePartial(assetId: string, partial: LocalRuntimePartial) {
  const current = await getAsset(assetId);
  if (!current) return;
  await saveAsset({
    ...current,
    intelligence: {
      ...current.intelligence,
      ...partial
    },
    updatedAt: new Date().toISOString()
  });
}

type IndexingSnapshotPatch = {
  status?: AssetRecord["status"];
  progress?: number;
  tags?: string[];
  summary?: string;
  timeline?: AssetRecord["timeline"];
  keyframes?: AssetRecord["keyframes"];
  identity?: AssetRecord["identity"];
  modelTrace?: string[];
};

async function persistIndexingSnapshot(assetId: string, patch: IndexingSnapshotPatch) {
  const current = await getAsset(assetId);
  if (!current) return null;
  return saveAsset({
    ...current,
    tags: patch.tags ?? current.tags,
    summary: patch.summary ?? current.summary,
    timeline: patch.timeline ?? current.timeline,
    keyframes: patch.keyframes ?? current.keyframes,
    identity: patch.identity ?? current.identity,
    status: patch.status ?? current.status,
    progress: patch.progress ?? current.progress,
    intelligence: {
      ...current.intelligence,
      modelTrace: mergeModelTrace(current.intelligence.modelTrace, patch.modelTrace ?? [])
    },
    updatedAt: new Date().toISOString()
  });
}

async function invalidateRetryStageOutputs(jobId: string, assetId: string, fallbackRetryStage: string | null | undefined) {
  const job = await getJob(jobId);
  const retryStage = getEffectiveRetryStage(job, fallbackRetryStage);
  if (!retryStage) return;
  const parameters = { ...(job?.parameters ?? {}) };
  if (parameters.invalidatedRetryStage === retryStage) return;
  const asset = await getAsset(assetId);
  if (!asset) return;

  const invalidated = invalidateAssetForRetryStage(asset, retryStage);
  await saveAsset(invalidated);
  const vectors = getRetryVectorInvalidation(retryStage);
  if (vectors.text) await upsertAssetVectors(asset.indexId, asset.id, []);
  if (vectors.visual) await upsertAssetVisualVectors(asset.indexId, asset.id, []);
  await updateJob(
    jobId,
    {
      parameters: {
        ...parameters,
        invalidatedRetryStage: retryStage
      }
    },
    `Invalidated stale outputs for retry stage: ${retryStage}`
  );
}

export function invalidateAssetForRetryStage(asset: AssetRecord, retryStage: string | null | undefined): AssetRecord {
  const evidence = getWorkflowRetryImpactedEvidence(retryStage);
  if (evidence.size === 0) return asset;
  const empty = emptyIntelligence();
  let duration = asset.duration;
  let width = asset.width;
  let height = asset.height;
  let technicalMetadata = asset.technicalMetadata;
  let tags = asset.tags;
  let summary = asset.summary;
  let timeline = asset.timeline;
  let keyframes = asset.keyframes;
  let identity = asset.identity;
  const intelligence: LocalIntelligence = {
    ...asset.intelligence,
    audio: asset.intelligence.audio,
    asr: asset.intelligence.asr,
    diarization: asset.intelligence.diarization,
    ocr: asset.intelligence.ocr,
    visual: asset.intelligence.visual,
    modelTrace: filterModelTraceForRetryEvidence(asset.intelligence.modelTrace, evidence)
  };

  if (evidence.has("probe")) {
    duration = null;
    width = null;
    height = null;
    technicalMetadata = {
      ...technicalMetadata,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    };
  }
  if (evidence.has("audio") || evidence.has("vad")) intelligence.audio = empty.audio;
  if (evidence.has("asr")) {
    intelligence.asr = empty.asr;
  } else if (evidence.has("diarization")) {
    intelligence.asr = {
      ...intelligence.asr,
      segments: intelligence.asr.segments.map((segment) => ({ ...segment, speaker: null }))
    };
  }
  if (evidence.has("diarization")) intelligence.diarization = empty.diarization;
  if (evidence.has("ocr")) intelligence.ocr = empty.ocr;
  if (evidence.has("visual-profile")) intelligence.visual = empty.visual;
  if (evidence.has("timeline")) {
    tags = [];
    summary = "";
    timeline = [];
  }
  if (evidence.has("keyframes")) keyframes = [];
  if (timeline.length > 0) {
    timeline = invalidateTimelineEvidence(timeline, evidence);
  }
  if (evidence.has("knowledge-action") || evidence.has("domain") || evidence.has("domain-vlm")) identity = undefined;
  if (evidence.has("summary")) {
    summary = "";
    timeline = timeline.map(stripTimelineSummary);
  }

  return {
    ...asset,
    duration,
    width,
    height,
    technicalMetadata,
    tags,
    summary,
    timeline,
    keyframes,
    identity,
    intelligence,
    updatedAt: new Date().toISOString()
  };
}

function getRetryVectorInvalidation(retryStage: string | null | undefined) {
  const evidence = getWorkflowRetryImpactedEvidence(retryStage);
  return {
    text: evidence.has("text-embedding") || evidence.has("vector") || evidence.has("ready"),
    visual: evidence.has("visual-embedding") || evidence.has("vector") || evidence.has("ready")
  };
}

function invalidateTimelineEvidence(timeline: AssetRecord["timeline"], evidence: Set<WorkflowEvidence>): AssetRecord["timeline"] {
  const clearVideoVlm = evidence.has("video-vlm");
  const clearVision = evidence.has("vision-detector") || evidence.has("vision-tracker");
  const clearDomain = evidence.has("knowledge-action") || evidence.has("domain") || evidence.has("domain-vlm");
  const clearSummary = evidence.has("summary");
  const clearTextEmbedding = evidence.has("text-embedding") || evidence.has("vector") || evidence.has("ready");
  if (!clearVideoVlm && !clearVision && !clearDomain && !clearSummary && !clearTextEmbedding) return timeline;
  return timeline.map((segment) => {
    const sceneData = segment.sceneData
      ? {
          ...segment.sceneData,
          ...(clearVideoVlm ? { vlm: undefined } : {}),
          ...(clearVision ? { vision: undefined } : {})
        }
      : segment.sceneData;
    const withoutDomain = clearDomain ? stripTimelineDomain(segment) : segment;
    const withoutSummary = clearSummary ? stripTimelineSummary(withoutDomain) : withoutDomain;
    return {
      ...withoutSummary,
      sceneData,
      embedding: clearTextEmbedding ? [] : withoutSummary.embedding
    };
  });
}

function stripTimelineDomain(segment: AssetRecord["timeline"][number]): AssetRecord["timeline"][number] {
  const { domain: _domain, identity: _identity, ...rest } = segment;
  return rest;
}

function stripTimelineSummary(segment: AssetRecord["timeline"][number]): AssetRecord["timeline"][number] {
  const { summary: _summary, ...rest } = segment;
  return rest;
}

function filterModelTraceForRetryEvidence(traces: string[], evidence: Set<WorkflowEvidence>) {
  return traces.filter((trace) => !traceMatchesRetryEvidence(trace, evidence));
}

function traceMatchesRetryEvidence(trace: string, evidence: Set<WorkflowEvidence>) {
  if ((evidence.has("audio") || evidence.has("vad")) && traceHasPrefix(trace, ["audio-extract:", "asr-input:", "vad:", "vad-unavailable:", "music-detect:"])) return true;
  if (evidence.has("asr") && traceHasPrefix(trace, ["faster-whisper:", "whisper-unavailable:", "asr-language:", "asr-source:", "asr-empty:"])) return true;
  if (evidence.has("diarization") && traceHasPrefix(trace, ["whisperx:", "whisperx-unavailable:"])) return true;
  if (evidence.has("ocr") && traceHasPrefix(trace, ["paddleocr:", "paddleocr-unavailable:", "ocr-language:", "ocr-source:", "ocr-empty"])) return true;
  if (evidence.has("visual-profile") && traceHasPrefix(trace, ["visual-source:", "visual-unavailable:", "ffmpeg-visual-sampler:"])) return true;
  if (evidence.has("video-vlm") && traceHasPrefix(trace, ["video-vlm", "video-vlm-unavailable:"])) return true;
  if (evidence.has("vision-detector") && traceHasPrefix(trace, ["vision-detector", "vision-detector-unavailable:"])) return true;
  if (evidence.has("vision-tracker") && traceHasPrefix(trace, ["vision-tracker", "vision-tracker-unavailable:"])) return true;
  if (evidence.has("knowledge-action") && traceHasPrefix(trace, ["knowledge-action", "knowledge-action-unavailable:", "soccernet-action", "soccernet-action-unavailable:"])) return true;
  if ((evidence.has("knowledge-action") || evidence.has("domain") || evidence.has("domain-vlm")) && trace.startsWith("match-identity:")) return true;
  if (evidence.has("domain-vlm") && traceHasPrefix(trace, ["domain-vlm", "domain-vlm-refine:"])) return true;
  if (evidence.has("summary") && trace.startsWith(EXTRACTIVE_SUMMARY_TRACE_PREFIX)) return true;
  if (evidence.has("text-embedding") && trace.startsWith("embedding:")) return true;
  if (evidence.has("visual-embedding") && traceHasPrefix(trace, ["visual-embedding", "visual-embedding-unavailable:"])) return true;
  return false;
}

function traceHasPrefix(trace: string, prefixes: string[]) {
  return prefixes.some((prefix) => trace.startsWith(prefix));
}

async function runCheckpointedIndexingStage<T>(
  jobId: string,
  stage: (typeof indexingCheckpointOrder)[number],
  progress: number,
  message: string,
  retryStage: string | null | undefined,
  canReuse: () => Promise<boolean>,
  action: () => Promise<T>,
  reuse?: () => Promise<T>
) {
  const job = await getJob(jobId);
  const effectiveRetryStage = getEffectiveRetryStage(job, retryStage);
  const mappedRetryStage = mapRetryStageToCheckpoint(effectiveRetryStage);
  const shouldRun = shouldRunJobStage(job, stage, indexingCheckpointOrder, mappedRetryStage);
  if (!shouldRun && (await canReuse())) {
    await updateJob(jobId, { stage, progress }, `Resuming after completed checkpoint: ${stage}`);
    if (reuse) return reuse();
    return undefined as T;
  }
  await startJobStageCheckpoint(jobId, stage, progress, message);
  const result = await action();
  await completeJobStageCheckpoint(jobId, stage, progress, message);
  await clearCompletedCheckpointParameters(jobId, stage, mappedRetryStage);
  return result;
}

async function ensureRetryRebuildScope(jobId: string, fallbackRetryStage: string | null | undefined) {
  const job = await getJob(jobId);
  if (!job) return;
  const retryStage = getEffectiveRetryStage(job, fallbackRetryStage);
  const rebuildFromStage = mapRetryStageToCheckpoint(retryStage);
  if (!retryStage || !rebuildFromStage) return;
  const parameters = { ...(job.parameters ?? {}) };
  let changed = false;
  if (!Object.prototype.hasOwnProperty.call(parameters, "retryStage")) {
    parameters.retryStage = retryStage;
    changed = true;
  }
  if (!normalizeCheckpointStage(parameters.rebuildFromStage)) {
    parameters.rebuildFromStage = rebuildFromStage;
    changed = true;
  }
  if (changed) await updateJob(jobId, { parameters });
}

function getEffectiveRetryStage(job: JobRecord | null | undefined, fallbackRetryStage: string | null | undefined) {
  if (Object.prototype.hasOwnProperty.call(job?.parameters ?? {}, "retryStage")) {
    return normalizeWorkflowStage(job?.parameters?.retryStage);
  }
  return normalizeWorkflowStage(fallbackRetryStage);
}

async function clearCompletedCheckpointParameters(jobId: string, stage: string, mappedRetryStage: string | null) {
  const job = await getJob(jobId);
  if (!job?.parameters) return;
  const nextParameters = { ...job.parameters };
  let changed = false;
  if (mappedRetryStage === stage && typeof nextParameters.retryStage !== "undefined" && nextParameters.retryStage !== null) {
    nextParameters.retryStage = null;
    changed = true;
  }
  if (stage === "finalize") {
    if (
      nextParameters.resumeFromStage !== null ||
      nextParameters.rebuildFromStage !== null ||
      nextParameters.retryStage !== null ||
      nextParameters.invalidatedRetryStage !== null
    ) {
      nextParameters.resumeFromStage = null;
      nextParameters.rebuildFromStage = null;
      nextParameters.retryStage = null;
      nextParameters.invalidatedRetryStage = null;
      changed = true;
    }
  }
  if (changed) await updateJob(jobId, { parameters: nextParameters });
}

async function requireAsset(assetId: string) {
  const asset = await getAsset(assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);
  return asset;
}

async function requireIndex(indexId: string) {
  const index = await getIndex(indexId);
  if (!index) throw new Error(`Index not found: ${indexId}`);
  return index;
}

async function assetHasProbeMetadata(assetId: string) {
  const asset = await getAsset(assetId);
  return Boolean(asset && asset.duration !== null && asset.width !== null && asset.height !== null);
}

async function assetHasRuntimeIntelligence(assetId: string) {
  const asset = await getAsset(assetId);
  if (!asset) return false;
  return (
    asset.intelligence.modelTrace.length > 0 ||
    asset.intelligence.asr.segments.length > 0 ||
    asset.intelligence.ocr.frames.length > 0 ||
    asset.intelligence.visual.labels.length > 0 ||
    Boolean(asset.intelligence.audio.extractedPath)
  );
}

async function assetHasTimelineSnapshot(assetId: string) {
  const asset = await getAsset(assetId);
  return Boolean(asset && asset.timeline.length > 0 && asset.keyframes.length > 0 && asset.summary);
}

async function assetHasModelTrace(assetId: string, prefix: string) {
  const asset = await getAsset(assetId);
  return Boolean(asset && traceFromAsset(asset, prefix));
}

async function assetHasDomainSnapshot(assetId: string, index: IndexRecord) {
  if (!index.domainIndexing?.enabled) return true;
  const asset = await getAsset(assetId);
  if (!asset?.timeline.some((segment) => segment.domain)) return false;
  if (index.domainIndexing.groups.some((group) => group === "sports.football" || group === "sports.american_football")) {
    return Boolean(asset.identity?.generatedBy === "sports-identity-resolver-v1" || asset.identity?.generatedBy === "match-context-identity-resolver-v1" || traceFromAsset(asset, "match-identity"));
  }
  return true;
}

async function assetHasExtractiveSummaries(assetId: string) {
  const asset = await getAsset(assetId);
  return Boolean(asset?.summary.trim() && asset.timeline.length > 0 && asset.timeline.every((segment) => Boolean(segment.summary?.trim())));
}

async function assetHasEmbeddedTimeline(assetId: string) {
  const asset = await getAsset(assetId);
  return Boolean(asset?.timeline.length && asset.timeline.every((segment) => Array.isArray(segment.embedding) && segment.embedding.length > 0));
}

async function assetIsIndexed(assetId: string) {
  const asset = await getAsset(assetId);
  return asset?.status === "indexed" && asset.progress === 100;
}

async function assetHasCompletedCheckpoint(jobId: string, stage: string) {
  const job = await getJob(jobId);
  const checkpoint = job?.stageCheckpoints?.[stage];
  return checkpoint?.status === "succeeded" || checkpoint?.status === "skipped";
}

async function visualEmbeddingCheckpointCanBeReused(jobId: string) {
  const job = await getJob(jobId);
  return canReuseVisualEmbeddingCheckpoint(job?.stageCheckpoints);
}

export function canReuseVisualEmbeddingCheckpoint(stageCheckpoints: JobRecord["stageCheckpoints"] | undefined) {
  // Visual vector records are transient until the downstream pgvector upsert completes.
  return isReusableCheckpoint(stageCheckpoints?.["visual-embedding"]) && isReusableCheckpoint(stageCheckpoints?.["vector-upsert-visual"]);
}

function isReusableCheckpoint(checkpoint: NonNullable<JobRecord["stageCheckpoints"]>[string] | undefined) {
  return checkpoint?.status === "succeeded" || checkpoint?.status === "skipped";
}

function attachKeyframesToTimeline(timeline: AssetRecord["timeline"], keyframes: AssetRecord["keyframes"]) {
  return timeline.map((segment) => {
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
}

function traceFromAsset(asset: AssetRecord, prefix: string) {
  return asset.intelligence.modelTrace.find((trace) => trace.startsWith(prefix)) ?? null;
}

export function mapRetryStageToCheckpoint(retryStage: string | null | undefined) {
  if (!retryStage) return null;
  const normalized = normalizeWorkflowStage(retryStage);
  if (normalized === "probe" || normalized === "input") return "probe";
  if (normalized === "audio" || normalized === "vad" || normalized === "asr" || normalized === "speakers" || normalized === "ocr" || normalized === "visual") {
    return "local-model-runtime";
  }
  if (normalized === "scene" || normalized === "timeline" || normalized === "keyframes") return "timeline";
  if (normalized === "videoVlm") return "video-vlm";
  if (normalized === "detector") return "vision-detection";
  if (normalized === "tracker") return "vision-tracking";
  if (normalized === "knowledgeAction" || normalized === "domain" || normalized === "domainVlm") return "domain-index";
  if (normalized === "summary") return "summary";
  if (normalized === "textEmbedding") return "embed";
  if (normalized === "visualEmbedding") return "visual-embedding";
  if (normalized === "vector") return "vector-upsert-text";
  if (normalized === "ready") return "finalize";
  return null;
}

function mergeModelTrace(existing: string[], additions: string[]) {
  const next = [...existing];
  for (const trace of additions.filter(Boolean)) {
    const group = modelTraceGroup(trace);
    const previousIndex = group ? next.findIndex((item) => modelTraceGroup(item) === group) : -1;
    if (previousIndex >= 0) {
      next[previousIndex] = trace;
    } else if (!next.includes(trace)) {
      next.push(trace);
    }
  }
  return next;
}

function modelTraceGroup(trace: string) {
  if (trace.startsWith("video-vlm")) return "video-vlm";
  if (trace.startsWith("vision-detector")) return "vision-detector";
  if (trace.startsWith("vision-tracker")) return "vision-tracker";
  if (trace.startsWith("knowledge-action")) return "knowledge-action";
  if (trace.startsWith("soccernet-action")) return "knowledge-action";
  if (trace.startsWith("domain-vlm")) return "domain-vlm";
  if (trace.startsWith(EXTRACTIVE_SUMMARY_TRACE_PREFIX)) return "summary";
  if (trace.startsWith("embedding:")) return "embedding";
  if (trace.startsWith("visual-embedding")) return "visual-embedding";
  return null;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyIntelligence(): LocalIntelligence {
  return {
    audio: { extractedPath: null, vad: { available: false, provider: "none", error: null }, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
    asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
    diarization: { provider: "none", speakers: [], segments: [], error: null },
    ocr: { tokens: [], confidence: 0, frames: [] },
    visual: { available: false, labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0, error: null },
    modelTrace: []
  };
}
