import { applyEventClassification } from "../eventClassifier";
import { withSceneData } from "../intelligence";
import { generateKeyframes } from "../keyframes";
import { embedTimelineSegments, getEmbeddingModelName } from "../localEmbeddingRuntime";
import { embedKeyframes, getVisualEmbeddingModelName } from "../localVisualEmbeddingRuntime";
import { getObjectPath } from "../localObjectStorage";
import { rebuildVectorStore } from "../localVectorStore";
import { rebuildVisualVectorStore } from "../localVisualVectorStore";
import { assertCapabilityAvailable, isCapabilityEnabled, isCapabilityRequired, resolveCapabilityPolicy } from "../modelCapabilities";
import { applySoccerNetActionSpots, isSoccerNetActionSpottingConfigured, spotSoccerNetActions } from "../soccernet";
import { listAssets, listIndexes, saveAsset, saveIndex } from "../store";
import { rebuildTrackingStore, upsertAssetTracking } from "../trackingStore";
import { applyVisionDetections, applyVisionTracking, applyVisionTracks, detectTimelineObjects, detectTimelineTracks } from "../visionDetectionRuntime";
import { enrichDomainTimeline } from "../workflows/indexingWorkflow";
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
    const filePath = getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey);
    const capabilityPolicy = resolveCapabilityPolicy(index);
    const detections = isCapabilityEnabled(index, "visionDetector")
      ? await detectTimelineObjects(thumbnailTimeline, keyframes)
      : { available: false, provider: "disabled", model: capabilityPolicy.visionDetector, frames: [], error: "Vision detector disabled by capability policy." };
    const detectorTrace = detections.available
      ? `vision-detector:${detections.provider}:${detections.model}:${detections.frames.length}`
      : `vision-detector-unavailable:${detections.error ?? "detector unavailable"}`;
    assertCapabilityAvailable(index, "visionDetector", detections.available, detections.error ?? "Detector returned unavailable.");
    const trackedV0Timeline = applyVisionTracking(applyVisionDetections(thumbnailTimeline, detections));
    const tracks = isCapabilityEnabled(index, "visionTracker")
      ? await detectTimelineTracks(filePath, trackedV0Timeline)
      : { available: false, provider: "disabled", model: detections.model, tracker: capabilityPolicy.visionTracker, segments: [], error: "Vision tracker disabled by capability policy." };
    const trackerTrace = tracks.available
      ? `vision-tracker:${tracks.provider}:${tracks.tracker}:${tracks.segments.length}`
      : `vision-tracker-unavailable:${tracks.error ?? "tracker unavailable"}`;
    assertCapabilityAvailable(index, "visionTracker", tracks.available, tracks.error ?? "Tracker returned unavailable.");
    const trackedTimeline = applyEventClassification(applyVisionTracks(trackedV0Timeline, tracks));
    const soccerNetResult =
      index.domainIndexing?.groups.includes("sports.football") &&
      isCapabilityEnabled(index, "soccerNetActionSpotting") &&
      (isSoccerNetActionSpottingConfigured() || isCapabilityRequired(index, "soccerNetActionSpotting"))
        ? await spotSoccerNetActions(filePath, trackedTimeline, asset.duration)
        : null;
    if (soccerNetResult) {
      assertCapabilityAvailable(index, "soccerNetActionSpotting", soccerNetResult.available, soccerNetResult.error ?? "SoccerNet action spotting unavailable.");
    }
    const actionTimeline = soccerNetResult ? applySoccerNetActionSpots(trackedTimeline, soccerNetResult) : trackedTimeline;
    const timeline = await embedTimelineSegments(enrichDomainTimeline({ ...asset, timeline: actionTimeline }, index, actionTimeline));
    const modelTrace = asset.intelligence.modelTrace.includes(`embedding:${getEmbeddingModelName()}`)
      ? asset.intelligence.modelTrace
      : [...asset.intelligence.modelTrace, `embedding:${getEmbeddingModelName()}`];
    let records: Awaited<ReturnType<typeof embedKeyframes>> = [];
    const baseTrace = [
      ...modelTrace,
      detectorTrace,
      trackerTrace,
      ...(soccerNetResult
        ? [
            soccerNetResult.available
              ? `soccernet-action:${soccerNetResult.model}:${soccerNetResult.spots.length}`
              : `soccernet-action-unavailable:${soccerNetResult.error ?? "not configured"}`
          ]
        : [])
    ];
    let nextTrace = baseTrace;
    try {
      records = await embedKeyframes(asset.indexId, asset.id, timeline, keyframes);
      nextTrace = baseTrace.includes(`visual-embedding:${getVisualEmbeddingModelName()}`)
        ? baseTrace
        : [...baseTrace, `visual-embedding:${getVisualEmbeddingModelName()}`];
    } catch (error) {
      const message = error instanceof Error ? error.message : "Visual embedding unavailable";
      nextTrace = [...baseTrace, `visual-embedding-unavailable:${message}`];
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
    await upsertAssetTracking(next);
    refreshed.push(next);
    visualRecords.push(...records);
  }
  await rebuildVectorStore(refreshed);
  await rebuildVisualVectorStore(visualRecords);
  await rebuildTrackingStore(refreshed);
  await recordEvent("system.info", "Vector store rebuilt", {
    payload: { assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName() }
  });
  return { ok: true, assets: refreshed.length, model: getEmbeddingModelName(), visualModel: getVisualEmbeddingModelName() };
}
