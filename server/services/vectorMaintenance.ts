import { withSceneData } from "../intelligence";
import { generateKeyframes } from "../keyframes";
import { embedTimelineSegments, getEmbeddingModelName } from "../localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../localVisualEmbeddingRuntime";
import { getObjectPath } from "../localObjectStorage";
import { rebuildVectorStore } from "../localVectorStore";
import { rebuildVisualVectorStore } from "../localVisualVectorStore";
import { listAssets, listIndexes, saveAsset, saveIndex } from "../store";
import { recordEvent } from "./events";

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
    const timeline = await embedTimelineSegments(thumbnailTimeline);
    const modelTrace = asset.intelligence.modelTrace.includes(`embedding:${getEmbeddingModelName()}`)
      ? asset.intelligence.modelTrace
      : [...asset.intelligence.modelTrace, `embedding:${getEmbeddingModelName()}`];
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
      summary: asset.summary.replace(/using [^.]+\. Local ASR/, `using ${getEmbeddingModelName()}. Local ASR`),
      intelligence: {
        ...asset.intelligence,
        modelTrace: nextTrace
      },
      updatedAt: new Date().toISOString()
    };
    await saveAsset(next);
    refreshed.push(next);
    visualRecords.push(...records);
  }
  await rebuildVectorStore(refreshed);
  await rebuildVisualVectorStore(visualRecords);
  await recordEvent("system.info", "Vector store rebuilt", {
    payload: { assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName() }
  });
  return { ok: true, assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName() };
}
