import "../server/env";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { embedTimelineSegments, getEmbeddingModelName } from "../server/localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../server/localVisualEmbeddingRuntime";
import { generateKeyframes } from "../server/keyframes";
import { getObjectPath } from "../server/localObjectStorage";
import { upsertAssetVectors } from "../server/localVectorStore";
import { upsertAssetVisualVectors } from "../server/localVisualVectorStore";
import { listAssets, listIndexes, saveAsset, saveIndex } from "../server/store";

const indexedAssets = (await listAssets()).filter((asset) => asset.status === "indexed" && asset.timeline.length > 0);
let segments = 0;
let visualVectors = 0;
let generatedKeyframes = 0;

for (const index of await listIndexes()) {
  if (index.models.embedding !== getEmbeddingModelName()) {
    await saveIndex({
      ...index,
      models: { ...index.models, embedding: getEmbeddingModelName() },
      updatedAt: new Date().toISOString()
    });
  }
}

for (const asset of indexedAssets) {
  const timeline = await embedTimelineSegments(asset.timeline);
  segments += timeline.length;
  const existingKeyframes = asset.keyframes.filter((keyframe) => keyframe.path && keyframe.segmentId);
  const keyframes =
    existingKeyframes.length >= timeline.length
      ? asset.keyframes
      : await generateKeyframes(
          getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey),
          asset.id,
          timeline,
          asset.duration
        );
  generatedKeyframes += Math.max(0, keyframes.filter((keyframe) => keyframe.path).length - existingKeyframes.length);
  const modelTrace = [...asset.intelligence.modelTrace];
  if (!modelTrace.includes(`embedding:${getEmbeddingModelName()}`)) modelTrace.push(`embedding:${getEmbeddingModelName()}`);
  if (!modelTrace.includes(`visual-embedding:${getVisualEmbeddingModelName()}`)) {
    modelTrace.push(`visual-embedding:${getVisualEmbeddingModelName()}`);
  }

  await saveAsset({
    ...asset,
    timeline,
    keyframes,
    summary: asset.summary.replace(/using [^.]+\. Local ASR/, `using ${getEmbeddingModelName()}. Local ASR`),
    intelligence: {
      ...asset.intelligence,
      modelTrace
    },
    updatedAt: new Date().toISOString()
  });
  await upsertAssetVectors(asset.indexId, asset.id, timeline);
  const records = await embedKeyframes(asset.indexId, asset.id, timeline, keyframes);
  visualVectors += records.length;
  await upsertAssetVisualVectors(asset.indexId, asset.id, records);
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
      generatedKeyframes
    },
    null,
    2
  )
);

if (isPostgresEnabled()) await closePostgresStore();
