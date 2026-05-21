import "../server/env";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { deriveAppearanceVectors } from "../server/appearanceSimilarity";
import { withSceneData } from "../server/intelligence";
import { embedTimelineSegments, getEmbeddingModelName } from "../server/localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../server/localVisualEmbeddingRuntime";
import { generateKeyframes } from "../server/keyframes";
import { getObjectPath } from "../server/localObjectStorage";
import { upsertAssetVectors } from "../server/localVectorStore";
import { upsertAssetAppearanceVectors } from "../server/localAppearanceVectorStore";
import { upsertAssetVisualVectors } from "../server/localVisualVectorStore";
import { listAssets, listIndexes, saveAsset, saveIndex } from "../server/store";
import { applyVisionDetections, applyVisionTracking, applyVisionTracks, detectTimelineObjects, detectTimelineTracks } from "../server/visionDetectionRuntime";
import { applyEventClassification } from "../server/eventClassifier";
import { isKnowledgeActionSpottingConfigured, runKnowledgeActionSpotting } from "../server/knowledgeAdapters";
import { assertCapabilityAvailable, isCapabilityEnabled, isCapabilityRequired, resolveCapabilityPolicy } from "../server/modelCapabilities";
import { buildRawMatchVideoProfile } from "../server/rawMatchProfile";
import { enrichDomainTimeline } from "../server/workflows/domainVlmWorkflow";
import { upsertAssetTracking } from "../server/trackingStore";
import { applyExtractiveVideoSummaries, EXTRACTIVE_SUMMARY_TRACE_PREFIX } from "../server/intelligenceCore/extractiveSummary";

const indexedAssets = (await listAssets()).filter((asset) => asset.status === "indexed" && asset.timeline.length > 0);
const indexes = await listIndexes();
let segments = 0;
let visualVectors = 0;
let appearanceVectors = 0;
let generatedKeyframes = 0;
const startedAt = Date.now();

console.error(`[rebuild] starting ${indexedAssets.length} indexed assets`);

for (const index of indexes) {
  if (index.models.embedding !== getEmbeddingModelName()) {
    await saveIndex({
      ...index,
      models: { ...index.models, embedding: getEmbeddingModelName() },
      updatedAt: new Date().toISOString()
    });
  }
}

for (const [assetIndex, asset] of indexedAssets.entries()) {
  const assetStartedAt = Date.now();
  console.error(`[rebuild] ${assetIndex + 1}/${indexedAssets.length} ${asset.id} ${asset.title}`);
  const index = indexes.find((item) => item.id === asset.indexId);
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
  generatedKeyframes += Math.max(0, keyframes.filter((keyframe) => keyframe.path).length - existingKeyframes.length);
  console.error(`[rebuild] ${asset.id} keyframes ready (${keyframes.length})`);
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
  const filePath = getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey);
  const capabilityPolicy = index ? resolveCapabilityPolicy(index) : null;
  const detections = !index || isCapabilityEnabled(index, "visionDetector")
    ? await detectTimelineObjects(thumbnailTimeline, keyframes)
    : { available: false, provider: "disabled", model: capabilityPolicy?.visionDetector ?? "disabled", frames: [], error: "Vision detector disabled by capability policy." };
  console.error(`[rebuild] ${asset.id} detections ${detections.available ? "ready" : "fallback"} (${detections.frames.length} frames)`);
  const detectorTrace = detections.available
    ? `vision-detector:${detections.provider}:${detections.model}:${detections.frames.length}`
    : `vision-detector-unavailable:${detections.error ?? "detector unavailable"}`;
  const trackedV0Timeline = applyVisionTracking(applyVisionDetections(thumbnailTimeline, detections));
  if (index) assertCapabilityAvailable(index, "visionDetector", detections.available, detections.error ?? "Detector returned unavailable.");
  const tracks = !index || isCapabilityEnabled(index, "visionTracker")
    ? await detectTimelineTracks(filePath, trackedV0Timeline, { assetId: asset.id, stage: "rebuild-embeddings" })
    : { available: false, provider: "disabled", model: detections.model, tracker: capabilityPolicy?.visionTracker ?? "disabled", segments: [], error: "Vision tracker disabled by capability policy." };
  console.error(`[rebuild] ${asset.id} tracking ${tracks.available ? "ready" : "fallback"} (${tracks.segments.length} segments)`);
  const trackerTrace = tracks.available
    ? `vision-tracker:${tracks.provider}:${tracks.tracker}:${tracks.segments.length}`
    : `vision-tracker-unavailable:${tracks.error ?? "tracker unavailable"}`;
  const detectedTimeline = applyEventClassification(applyVisionTracks(trackedV0Timeline, tracks));
  if (index) assertCapabilityAvailable(index, "visionTracker", tracks.available, tracks.error ?? "Tracker returned unavailable.");
  const knowledgeActionResult =
    index &&
    isCapabilityEnabled(index, "soccerNetActionSpotting") &&
    (isKnowledgeActionSpottingConfigured(index) || isCapabilityRequired(index, "soccerNetActionSpotting"))
      ? await runKnowledgeActionSpotting({
          filePath,
          timeline: detectedTimeline,
          duration: asset.duration,
          index,
          jobId: "rebuild-embeddings",
          assetId: asset.id
        })
      : null;
  if (index && knowledgeActionResult) {
    assertCapabilityAvailable(index, "soccerNetActionSpotting", knowledgeActionResult.available, knowledgeActionResult.error ?? "Knowledge action spotting unavailable.");
  }
  const actionTimeline = knowledgeActionResult ? knowledgeActionResult.timeline : detectedTimeline;
  const domainTimeline = index ? enrichDomainTimeline({ ...asset, timeline: actionTimeline }, index, actionTimeline) : actionTimeline;
  console.error(`[rebuild] ${asset.id} domain timeline ready (${domainTimeline.length} segments)`);
  const summarized = index ? applyExtractiveVideoSummaries({ ...asset, timeline: domainTimeline }, index, domainTimeline) : { summary: asset.summary, timeline: domainTimeline, trace: "", summarizedSegments: 0 };
  console.error(`[rebuild] ${asset.id} summaries ready (${summarized.summarizedSegments}/${summarized.timeline.length})`);
  const timeline = await embedTimelineSegments(summarized.timeline);
  console.error(`[rebuild] ${asset.id} text embeddings ready`);
  segments += timeline.length;
  const modelTrace = summarized.trace
    ? asset.intelligence.modelTrace.filter((trace) => !trace.startsWith(EXTRACTIVE_SUMMARY_TRACE_PREFIX))
    : [...asset.intelligence.modelTrace];
  modelTrace.push(detectorTrace, trackerTrace);
  if (summarized.trace) modelTrace.push(summarized.trace);
  if (!modelTrace.includes(`embedding:${getEmbeddingModelName()}`)) modelTrace.push(`embedding:${getEmbeddingModelName()}`);
  if (knowledgeActionResult) {
    modelTrace.push(knowledgeActionResult.trace);
  }
  let records: Awaited<ReturnType<typeof embedKeyframes>> = [];
  try {
    records = await embedKeyframes(asset.indexId, asset.id, timeline, keyframes);
    visualVectors += records.length;
    if (!modelTrace.includes(`visual-embedding:${getVisualEmbeddingModelName()}`)) {
      modelTrace.push(`visual-embedding:${getVisualEmbeddingModelName()}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Visual embedding unavailable";
    modelTrace.push(`visual-embedding-unavailable:${message}`);
    console.error(`[rebuild] ${asset.id} visual embeddings unavailable: ${message}`);
  }

  const nextAsset = {
    ...asset,
    timeline,
    keyframes,
    summary: summarized.summary,
    rawMatchProfile: buildRawMatchVideoProfile({ ...asset, summary: summarized.summary, timeline }, timeline),
    intelligence: {
      ...asset.intelligence,
      modelTrace
    },
    updatedAt: new Date().toISOString()
  };
  await saveAsset(nextAsset);
  await upsertAssetVectors(asset.indexId, asset.id, timeline);
  await upsertAssetVisualVectors(asset.indexId, asset.id, records);
  const appearanceRecords = deriveAppearanceVectors(nextAsset, records);
  appearanceVectors += appearanceRecords.length;
  await upsertAssetAppearanceVectors(asset.indexId, asset.id, appearanceRecords);
  await upsertAssetTracking(nextAsset);
  console.error(`[rebuild] ${asset.id} saved in ${Math.round((Date.now() - assetStartedAt) / 1000)}s`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      model: getEmbeddingModelName(),
      visualModel: getVisualEmbeddingModelName(),
      assets: indexedAssets.length,
      segments,
      visualVectors,
      appearanceVectors,
      generatedKeyframes,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000)
    },
    null,
    2
  )
);

if (isPostgresEnabled()) await closePostgresStore();
