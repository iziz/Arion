import { withDomainSegment } from "../domainIndex";
import { enqueueLocalTask } from "../localQueue";
import { embedTimelineSegments } from "../localEmbeddingRuntime";
import { upsertAssetVectors } from "../localVectorStore";
import { logJson, traceAsync, traceJobAsync } from "../observability";
import { createJob, updateJob } from "../services/jobState";
import { getAsset, getIndex, saveAsset } from "../store";
import { upsertAssetTracking } from "../trackingStore";
import { getVlmWorkerModelName, isVlmWorkerEnabled, refineSportsDomainTimelineWithVlm } from "../vlmWorkerClient";
import type { AssetRecord, IndexRecord, JobRecord, TimelineSegment } from "../../shared/types";

export function enrichDomainTimeline(asset: AssetRecord, index: IndexRecord, timeline: TimelineSegment[]) {
  const assetWithTimeline = { ...asset, timeline };
  return timeline.map((segment) => withDomainSegment(assetWithTimeline, index, segment));
}

export async function runDomainVlmRefineJob(jobId: string, assetId: string) {
  try {
    await updateJob(jobId, { status: "running", stage: "domain-vlm", progress: 5 }, `Starting sports event VLM refinement with ${getVlmWorkerModelName()}`);
    const asset = await getAsset(assetId);
    if (!asset) throw new Error("Asset not found");
    const index = await getIndex(asset.indexId);
    if (!index) throw new Error("Index not found");
    if (!index.domainIndexing?.enabled || index.domainIndexing.groups.length === 0) {
      throw new Error("Sports event VLM refinement requires Sports domain indexing for this asset group.");
    }
    if (!isVlmWorkerEnabled()) {
      throw new Error("VLM_WORKER_URL is not configured.");
    }
    if (asset.timeline.length === 0) {
      throw new Error("Asset has no timeline segments. Run indexing first.");
    }

    const timelineWithDomain = ensureDomainTimeline(asset, index, asset.timeline);
    await updateJob(jobId, { stage: "domain-vlm", progress: 10 }, `Prepared ${timelineWithDomain.length} timeline segments for sports event VLM refinement`);
    const result = await traceAsync(
      "model.vlm.sports_domain.retry",
      { jobId, assetId, segments: timelineWithDomain.length, model: getVlmWorkerModelName() },
      () =>
        refineSportsDomainTimelineWithVlm({ ...asset, timeline: timelineWithDomain }, index, timelineWithDomain, {
          onProgress: async (event) => {
            await updateJob(
              jobId,
              { stage: "domain-vlm", progress: 10 + Math.round(event.progress * 0.7) },
              `[domain-vlm:${event.status}] ${event.message}`,
              event.status === "failed" || event.status === "invalid" ? "warn" : "info"
            );
          }
        }),
      "model.vlm.sports_domain.retry"
    );

    await updateJob(jobId, { stage: "embed", progress: 84 }, "Rebuilding text embeddings after VLM domain refinement");
    const timeline = await traceAsync(
      "model.embedding.text.domain_vlm",
      { jobId, assetId, segments: result.timeline.length },
      () => embedTimelineSegments(result.timeline),
      "model.embedding.text.domain_vlm"
    );
    await updateJob(jobId, { stage: "vector-upsert-text", progress: 92 }, "Writing refined domain timeline vectors");
    await traceAsync(
      "stage.vector_upsert.text.domain_vlm",
      { jobId, assetId, segments: timeline.length },
      () => upsertAssetVectors(index.id, asset.id, timeline),
      "stage.vector_upsert.text.domain_vlm"
    );

    const modelTrace = [
      ...asset.intelligence.modelTrace.filter((trace) => !trace.startsWith("domain-vlm-refine:")),
      `domain-vlm-refine:${result.model}:${result.refinedSegments}/${result.attemptedSegments}:invalid=${result.invalidSegments}:failed=${result.failedSegments}`
    ];
    const refinedAsset: AssetRecord = {
      ...asset,
      timeline,
      intelligence: {
        ...asset.intelligence,
        modelTrace
      },
      status: "indexed",
      progress: 100,
      error: null,
      updatedAt: new Date().toISOString()
    };
    await saveAsset(refinedAsset);
    await traceAsync("stage.tracking_upsert.domain_vlm", { jobId, assetId, segments: timeline.length }, () => upsertAssetTracking(refinedAsset), "stage.tracking_upsert.domain_vlm");
    await updateJob(
      jobId,
      { status: "succeeded", stage: "complete", progress: 100, completedAt: new Date().toISOString() },
      `Sports event VLM refinement complete: ${result.refinedSegments}/${result.attemptedSegments} refined, ${result.invalidSegments} invalid, ${result.failedSegments} failed`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sports event VLM refinement failed";
    logJson("error", "job.domain_vlm.failed", message, { jobId, assetId });
    await updateJob(
      jobId,
      { status: "failed", stage: "failed", progress: 100, error: message, completedAt: new Date().toISOString() },
      message,
      "error"
    );
  }
}

export function enqueueDomainVlmRefinement(job: JobRecord, assetId: string) {
  enqueueLocalTask(job.id, () =>
    traceJobAsync("job.domain_vlm.refine", { jobId: job.id, assetId }, { type: job.type }, () => runDomainVlmRefineJob(job.id, assetId))
  );
}

function ensureDomainTimeline(asset: AssetRecord, index: IndexRecord, timeline: TimelineSegment[]) {
  const generated = enrichDomainTimeline(asset, index, timeline);
  return timeline.map((segment, segmentIndex) => (segment.domain ? segment : generated[segmentIndex] ?? segment));
}
