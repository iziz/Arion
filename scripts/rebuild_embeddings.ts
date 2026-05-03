import "../server/env";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { buildDomainSegmentIndex } from "../server/domainIndex";
import { withSceneData } from "../server/intelligence";
import { embedTimelineSegments, getEmbeddingModelName } from "../server/localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../server/localVisualEmbeddingRuntime";
import { generateKeyframes } from "../server/keyframes";
import { getObjectPath } from "../server/localObjectStorage";
import { upsertAssetVectors } from "../server/localVectorStore";
import { upsertAssetVisualVectors } from "../server/localVisualVectorStore";
import { listAssets, listIndexes, saveAsset, saveIndex } from "../server/store";
import { applyVisionDetections, applyVisionTracking, applyVisionTracks, detectTimelineObjects, detectTimelineTracks } from "../server/visionDetectionRuntime";
import { applyEventClassification } from "../server/eventClassifier";
import { rebuildTrackingStore } from "../server/trackingStore";
import { isTrustedDomainSegment } from "../server/evidenceTrust";

const indexedAssets = (await listAssets()).filter((asset) => asset.status === "indexed" && asset.timeline.length > 0);
const indexes = await listIndexes();
let segments = 0;
let visualVectors = 0;
let generatedKeyframes = 0;
const refreshedAssets = [];
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
  const detections = await detectTimelineObjects(thumbnailTimeline, keyframes);
  console.error(`[rebuild] ${asset.id} detections ${detections.available ? "ready" : "fallback"} (${detections.frames.length} frames)`);
  const trackedV0Timeline = applyVisionTracking(applyVisionDetections(thumbnailTimeline, detections));
  const tracks = await detectTimelineTracks(filePath, trackedV0Timeline);
  console.error(`[rebuild] ${asset.id} tracking ${tracks.available ? "ready" : "fallback"} (${tracks.segments.length} segments)`);
  const detectedTimeline = applyEventClassification(applyVisionTracks(trackedV0Timeline, tracks));
  const sceneAsset = { ...asset, timeline: detectedTimeline };
  const domainTimeline = index
    ? detectedTimeline.map((segment) => {
        const domain = buildDomainSegmentIndex(sceneAsset, index, segment);
        if (!domain) return segment;
        return {
          ...segment,
          domain,
          sources: Array.from(new Set([...segment.sources, ...(isTrustedDomainSegment(domain) ? (["domain"] as const) : [])]))
        };
      })
    : detectedTimeline;
  console.error(`[rebuild] ${asset.id} domain timeline ready (${domainTimeline.length} segments)`);
  const timeline = await embedTimelineSegments(domainTimeline);
  console.error(`[rebuild] ${asset.id} text embeddings ready`);
  segments += timeline.length;
  const modelTrace = [...asset.intelligence.modelTrace];
  if (!modelTrace.includes(`embedding:${getEmbeddingModelName()}`)) modelTrace.push(`embedding:${getEmbeddingModelName()}`);
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
    summary: asset.summary.replace(/using [^.]+\. Local ASR/, `using ${getEmbeddingModelName()}. Local ASR`),
    intelligence: {
      ...asset.intelligence,
      modelTrace
    },
    updatedAt: new Date().toISOString()
  };
  await saveAsset(nextAsset);
  refreshedAssets.push(nextAsset);
  await upsertAssetVectors(asset.indexId, asset.id, timeline);
  await upsertAssetVisualVectors(asset.indexId, asset.id, records);
  console.error(`[rebuild] ${asset.id} saved in ${Math.round((Date.now() - assetStartedAt) / 1000)}s`);
}

await rebuildTrackingStore(refreshedAssets);

console.log(
  JSON.stringify(
    {
      ok: true,
      model: getEmbeddingModelName(),
      visualModel: getVisualEmbeddingModelName(),
      assets: indexedAssets.length,
      segments,
      visualVectors,
      generatedKeyframes,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000)
    },
    null,
    2
  )
);

if (isPostgresEnabled()) await closePostgresStore();
