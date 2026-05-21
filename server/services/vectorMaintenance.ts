import { withSceneData } from "../intelligence";
import { deriveAppearanceVectors } from "../appearanceSimilarity";
import { generateKeyframes } from "../keyframes";
import { embedTimelineSegments, getEmbeddingModelName } from "../localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../localVisualEmbeddingRuntime";
import { getObjectPath } from "../localObjectStorage";
import { rebuildVectorStore } from "../localVectorStore";
import { rebuildAppearanceVectorStore } from "../localAppearanceVectorStore";
import { rebuildVisualVectorStore } from "../localVisualVectorStore";
import { listAssets, listIndexes, saveAsset, saveIndex } from "../store";
import { recordEvent } from "./events";
import { applyExtractiveVideoSummaries, EXTRACTIVE_SUMMARY_TRACE_PREFIX } from "../intelligenceCore/extractiveSummary";

export async function rebuildVectorStores() {
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
  const appearanceRecords = [];
  for (const asset of indexed) {
    const index = indexes.find((item) => item.id === asset.indexId);
    if (!index) continue;
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
    const summarized = applyExtractiveVideoSummaries({ ...asset, timeline: thumbnailTimeline }, index, thumbnailTimeline);
    const timeline = await embedTimelineSegments(summarized.timeline);
    const summaryTrace = [...asset.intelligence.modelTrace.filter((trace) => !trace.startsWith(EXTRACTIVE_SUMMARY_TRACE_PREFIX)), summarized.trace];
    const modelTrace = summaryTrace.includes(`embedding:${getEmbeddingModelName()}`)
      ? summaryTrace
      : [...summaryTrace, `embedding:${getEmbeddingModelName()}`];
    let records: Awaited<ReturnType<typeof embedKeyframes>> = [];
    let nextTrace = modelTrace;
    try {
      records = await embedKeyframes(asset.indexId, asset.id, timeline, keyframes);
      nextTrace = modelTrace.includes(`visual-embedding:${getVisualEmbeddingModelName()}`)
        ? modelTrace
        : [...modelTrace, `visual-embedding:${getVisualEmbeddingModelName()}`];
    } catch (error) {
      const message = error instanceof Error ? error.message : "Visual embedding unavailable";
      nextTrace = [...modelTrace, `visual-embedding-unavailable:${message}`];
    }
    const next = {
      ...asset,
      timeline,
      keyframes,
      summary: summarized.summary,
      intelligence: {
        ...asset.intelligence,
        modelTrace: nextTrace
      },
      updatedAt: new Date().toISOString()
    };
    await saveAsset(next);
    refreshed.push(next);
    visualRecords.push(...records);
    appearanceRecords.push(...deriveAppearanceVectors(next, records));
  }
  await rebuildVectorStore(refreshed);
  await rebuildVisualVectorStore(visualRecords);
  await rebuildAppearanceVectorStore(appearanceRecords);
  await recordEvent("system.info", "Vector store rebuilt", {
    payload: { assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName(), appearanceVectors: appearanceRecords.length }
  });
  return { ok: true, assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName(), appearanceVectors: appearanceRecords.length };
}
