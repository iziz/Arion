import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { buildLocalIndex, probeVideo, withSceneData } from "../intelligence";
import { enqueueLocalTask } from "../localQueue";
import { embedTimelineSegments, getEmbeddingModelName } from "../localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../localVisualEmbeddingRuntime";
import { generateKeyframes } from "../keyframes";
import { runLocalModelRuntime, type LocalRuntimePartial } from "../localModelRuntime";
import { extractAudioAndVad } from "../modelRuntime/audioRuntime";
import { toPublicMediaPath } from "../modelRuntime/mediaPath";
import { runRuntimeStage } from "../modelRuntime/stageReporter";
import { assertCapabilityAvailable, isCapabilityEnabled, isCapabilityRequired, resolveCapabilityPolicy } from "../modelCapabilities";
import { applyEventClassification } from "../eventClassifier";
import { getObjectPath, getPublicMediaRoot, putUploadedObject } from "../localObjectStorage";
import { upsertAssetVectors } from "../localVectorStore";
import { upsertAssetVisualVectors } from "../localVisualVectorStore";
import { applyVisionDetections, applyVisionTracking, applyVisionTracks, detectTimelineObjects, detectTimelineTracks } from "../visionDetectionRuntime";
import { detectSceneBoundaries } from "../sceneDetection";
import { applySoccerNetActionSpots, isSoccerNetActionSpottingConfigured, soccerNetActionModel, spotSoccerNetActions } from "../soccernet";
import { upsertAssetTracking } from "../trackingStore";
import { getVlmWorkerModelName, isVlmWorkerEnabled, refineSportsDomainTimelineWithVlm } from "../vlmWorkerClient";
import { logJson, traceAsync, traceJobAsync } from "../observability";
import { normalizeUploadedText } from "../textEncoding";
import { createDefaultIndex, getAsset, getIndex, getJob, saveAsset, saveIndex, saveVideo } from "../store";
import { createJob, updateAsset, updateJob } from "../services/jobState";
import { deliverEvent, recordBilling, recordEvent } from "../services/events";
import { enrichDomainTimeline } from "./domainVlmWorkflow";
import type { AssetRecord, LocalIntelligence, WebhookEventType } from "../../shared/types";

export { analyzeAndEmit } from "./analysisWorkflow";
export { enqueueDomainVlmRefinement, enrichDomainTimeline, runDomainVlmRefineJob } from "./domainVlmWorkflow";
export { runSpeakerDiarizationJob } from "./diarizationWorkflow";

export async function createAssetFromUpload(req: Request, res: Response, indexId: string) {
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

export async function runIndexingJob(jobId: string, assetId: string, filePath: string) {
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
    const runtimeIndex = (await getIndex(runtimeInput.indexId)) ?? createDefaultIndex();
    const runtimePolicy = resolveCapabilityPolicy(runtimeIndex);
    const intelligence = await traceAsync(
      "stage.local_model_runtime",
      { jobId, assetId },
      () =>
        runLocalModelRuntime(filePath, runtimeInput, (event) => updateRuntimeStage(jobId, event), {
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
    const capabilityPolicy = resolveCapabilityPolicy(embeddingIndex);
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
    const detections = isCapabilityEnabled(embeddingIndex, "visionDetector")
      ? await traceAsync(
          "stage.vision_detection",
          { jobId, assetId, segments: thumbnailTimeline.length },
          () => detectTimelineObjects(thumbnailTimeline, keyframes),
          "stage.vision_detection"
        )
      : { available: false, provider: "disabled", model: capabilityPolicy.visionDetector, frames: [], error: "Vision detector disabled by capability policy." };
    const detectorTrace = detections.available
      ? `vision-detector:${detections.provider}:${detections.model}:${detections.frames.length}`
      : `vision-detector-unavailable:${detections.error ?? "detector unavailable"}`;
    assertCapabilityAvailable(embeddingIndex, "visionDetector", detections.available, detections.error ?? "Detector returned unavailable.");
    const trackedV0Timeline = applyVisionTracking(applyVisionDetections(thumbnailTimeline, detections));
    await updateJob(jobId, { stage: "vision-tracking", progress: 80 }, "Tracking players and ball candidates over video");
    const tracks = isCapabilityEnabled(embeddingIndex, "visionTracker")
      ? await traceAsync(
          "stage.vision_tracking",
          { jobId, assetId, segments: trackedV0Timeline.length },
          () => detectTimelineTracks(filePath, trackedV0Timeline),
          "stage.vision_tracking"
        )
      : { available: false, provider: "disabled", model: detections.model, tracker: capabilityPolicy.visionTracker, segments: [], error: "Vision tracker disabled by capability policy." };
    const trackerTrace = tracks.available
      ? `vision-tracker:${tracks.provider}:${tracks.tracker}:${tracks.segments.length}`
      : `vision-tracker-unavailable:${tracks.error ?? "tracker unavailable"}`;
    assertCapabilityAvailable(embeddingIndex, "visionTracker", tracks.available, tracks.error ?? "Tracker returned unavailable.");
    const detectedTimeline = applyEventClassification(applyVisionTracks(trackedV0Timeline, tracks));
    let soccerNetTrace = "";
    let actionTimeline = detectedTimeline;
    const shouldRunSoccerNet =
      embeddingIndex.domainIndexing?.groups.includes("sports.football") &&
      isCapabilityEnabled(embeddingIndex, "soccerNetActionSpotting") &&
      (isSoccerNetActionSpottingConfigured() || isCapabilityRequired(embeddingIndex, "soccerNetActionSpotting"));
    if (shouldRunSoccerNet) {
      await updateJob(jobId, { stage: "soccernet-action", progress: 81 }, `Running SoccerNet action spotting with ${soccerNetActionModel}`);
      const soccerNetResult = await traceAsync(
        "model.soccernet.action_spotting",
        { jobId, assetId, model: soccerNetActionModel, segments: detectedTimeline.length },
        () => spotSoccerNetActions(filePath, detectedTimeline, refreshed.duration),
        "model.soccernet.action_spotting"
      );
      soccerNetTrace = soccerNetResult.available
        ? `soccernet-action:${soccerNetResult.model}:${soccerNetResult.spots.length}`
        : `soccernet-action-unavailable:${soccerNetResult.error ?? "not configured"}`;
      if (!soccerNetResult.available) {
        logJson("warn", "model.soccernet.action_spotting.unavailable", "SoccerNet action spotting unavailable", {
          jobId,
          assetId,
          error: soccerNetResult.error
        });
      }
      assertCapabilityAvailable(embeddingIndex, "soccerNetActionSpotting", soccerNetResult.available, soccerNetResult.error ?? "SoccerNet action spotting unavailable.");
      actionTimeline = applySoccerNetActionSpots(detectedTimeline, soccerNetResult);
    }
    let timelineForDomain = embeddingIndex.domainIndexing?.enabled
      ? enrichDomainTimeline({ ...refreshed, timeline: actionTimeline }, embeddingIndex, actionTimeline)
      : actionTimeline;
    if (embeddingIndex.domainIndexing?.enabled) {
      const domainEvents = timelineForDomain.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
      await updateJob(jobId, { stage: "domain-index", progress: 82 }, `Sports domain event layer ready with ${domainEvents} event candidates`);
      const shouldRunDomainVlm =
        isCapabilityEnabled(embeddingIndex, "domainVlmRefinement") &&
        (isVlmWorkerEnabled() || isCapabilityRequired(embeddingIndex, "domainVlmRefinement"));
      if (shouldRunDomainVlm) {
        assertCapabilityAvailable(embeddingIndex, "domainVlmRefinement", isVlmWorkerEnabled(), "VLM_WORKER_URL is not configured.");
        await updateJob(jobId, { stage: "domain-vlm", progress: 83 }, `Refining sports event metadata with ${getVlmWorkerModelName()}`);
        const vlmRefinement = await traceAsync(
          "model.vlm.sports_domain",
          { jobId, assetId, segments: timelineForDomain.length, model: getVlmWorkerModelName() },
          () =>
            refineSportsDomainTimelineWithVlm({ ...refreshed, timeline: timelineForDomain }, embeddingIndex, timelineForDomain, {
              onProgress: async (event) => {
                await updateJob(
                  jobId,
                  { stage: "domain-vlm", progress: 82 + Math.round(event.progress * 0.01) },
                  `[domain-vlm:${event.status}] ${event.message}`
                );
              }
            }),
          "model.vlm.sports_domain"
        );
        timelineForDomain = vlmRefinement.timeline;
        await updateJob(
          jobId,
          { stage: "domain-vlm", progress: 83 },
          `Sports event VLM refinement completed for ${vlmRefinement.refinedSegments}/${vlmRefinement.attemptedSegments} attempted segments (${vlmRefinement.invalidSegments} invalid, ${vlmRefinement.failedSegments} failed)`
        );
        if (vlmRefinement.errors.length > 0) {
          logJson("warn", "model.vlm.sports_domain.partial", "Sports event VLM refinement had partial failures", {
            jobId,
            assetId,
            errors: vlmRefinement.errors
          });
        }
      }
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
    let visualEmbeddingTrace = `visual-embedding:${getVisualEmbeddingModelName()}`;
    let visualVectors: Awaited<ReturnType<typeof embedKeyframes>> = [];
    try {
      visualVectors = await traceAsync(
        "model.embedding.visual",
        { jobId, assetId, keyframes: keyframes.length },
        () => embedKeyframes(embeddingIndex.id, refreshed.id, timeline, keyframes),
        "model.embedding.visual"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Visual embedding unavailable";
      visualEmbeddingTrace = `visual-embedding-unavailable:${message}`;
      logJson("warn", "model.embedding.visual.unavailable", "Visual embedding unavailable", { jobId, assetId, error: message });
      await updateJob(jobId, { stage: "visual-embedding-unavailable", progress: 92 }, `Visual embeddings unavailable: ${message}`, "warn");
    }
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
          detectorTrace,
          trackerTrace,
          isVlmWorkerEnabled() ? `domain-vlm:${getVlmWorkerModelName()}` : "",
          soccerNetTrace,
          `embedding:${getEmbeddingModelName()}`,
          visualEmbeddingTrace
        ].filter(Boolean)
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

export async function runAudioExtractionJob(jobId: string, assetId: string, filePath: string) {
  try {
    const asset = await getAsset(assetId);
    if (!asset) return;
    await updateJob(jobId, { status: "running", stage: "runtime-audio", progress: 40 }, "Running audio extraction retry");
    await updateAsset(assetId, { status: "scanning", progress: 40, error: null });
    const audio = await runRuntimeStage(
      (event) => updateRuntimeStage(jobId, event),
      "audio",
      "Extracting audio and detecting speech regions",
      () => traceAsync("model.audio_extract_vad", { assetId }, () => extractAudioAndVad(filePath, asset.id, asset.duration), "model.audio_extract_vad")
    );
    await mergeLocalRuntimePartial(assetId, { audio: buildAudioRuntimePartial(audio) });
    const refreshed = await getAsset(assetId);
    const hasSearchArtifacts = Boolean(refreshed?.timeline.length);
    await updateAsset(assetId, {
      status: hasSearchArtifacts ? "indexed" : "failed",
      progress: hasSearchArtifacts ? 100 : Math.max(refreshed?.progress ?? 42, 42),
      error: hasSearchArtifacts ? null : "Audio extraction retry completed; run full reindex to rebuild downstream search artifacts."
    });
    await updateJob(
      jobId,
      { status: "succeeded", stage: "complete", progress: 100, completedAt: new Date().toISOString() },
      "Audio extraction retry complete"
    );
    await emitForAsset("asset.indexing.progress", "Audio extraction retry complete", assetId, jobId, { progress: 42 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Audio extraction retry failed";
    logJson("error", "job.audio_retry.failed", message, { jobId, assetId });
    await updateAsset(assetId, { status: "failed", error: message });
    await updateJob(
      jobId,
      { status: "failed", stage: "failed", error: message, completedAt: new Date().toISOString() },
      message,
      "error"
    );
    await emitForAsset("asset.indexing.failed", "Audio extraction retry failed", assetId, jobId, { error: message });
  }
}

export function normalizeWorkflowStage(value: unknown) {
  const stage = typeof value === "string" ? value.trim().toLowerCase() : "";
  const allowed = new Set(["input", "probe", "audio", "vad", "asr", "speakers", "ocr", "visual", "timeline", "domain", "vector", "ready"]);
  return allowed.has(stage) ? stage : null;
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
  const currentJob = await getJob(jobId);
  const previousStage = currentJob?.runtimeStages?.[event.stage];
  const now = new Date().toISOString();
  const runtimeStages = {
    ...(currentJob?.runtimeStages ?? {}),
    [event.stage]: {
      stage: event.stage,
      status: event.status,
      message,
      progress,
      error: event.error ?? null,
      startedAt: previousStage?.startedAt ?? now,
      updatedAt: now,
      completedAt: event.status === "running" ? previousStage?.completedAt ?? null : now
    }
  };
  const updated = await updateJob(jobId, { stage, progress, runtimeStages }, `[runtime:${event.stage}:${event.status}] ${message}`, level);
  if (updated?.assetId) {
    await updateAsset(updated.assetId, {
      status: event.stage === "asr" || event.stage === "diarization" ? "transcribing" : "scanning",
      progress
    });
  }
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

function buildAudioRuntimePartial(audio: Awaited<ReturnType<typeof extractAudioAndVad>>): LocalIntelligence["audio"] {
  return {
    extractedPath: toPublicMediaPath(audio.extractedPath, getPublicMediaRoot()),
    vad: audio.vad,
    speechSegments: audio.speechSegments,
    musicSegments: audio.musicSegments,
    hasSpeech: audio.vad.available && audio.speechSegments.length > 0,
    hasMusic: audio.vad.available && audio.musicSegments.length > 0
  };
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
