import type { IndexRecord, KnowledgeSourceId, TimelineSegment } from "../../shared/types";
import { logJson, traceAsync } from "../observability";

export type ActionSpottingRuntimeResult = {
  available: boolean;
  provider: string;
  model: string;
  spots: unknown[];
  error?: string | null;
};

export type KnowledgeActionSpottingRunParams = {
  filePath: string;
  timeline: TimelineSegment[];
  duration: number | null;
  index: IndexRecord;
  jobId: string;
  assetId: string;
};

export type KnowledgeActionSpottingAdapter<Result extends ActionSpottingRuntimeResult> = {
  sourceId: KnowledgeSourceId;
  modelLabel: string;
  isConfigured: () => boolean;
  spot: (filePath: string, timeline: TimelineSegment[], duration: number | null) => Promise<Result>;
  apply: (timeline: TimelineSegment[], result: Result) => TimelineSegment[];
};

export type KnowledgeActionSpottingRunResult = {
  available: boolean;
  sourceId: KnowledgeSourceId;
  provider: string;
  model: string;
  trace: string;
  timeline: TimelineSegment[];
  error: string | null;
};

export async function runKnowledgeActionSpottingAdapter<Result extends ActionSpottingRuntimeResult>(
  adapter: KnowledgeActionSpottingAdapter<Result>,
  params: KnowledgeActionSpottingRunParams
): Promise<KnowledgeActionSpottingRunResult> {
  const result = await traceAsync(
    "model.knowledge_action_spotting",
    { jobId: params.jobId, assetId: params.assetId, sourceId: adapter.sourceId, model: adapter.modelLabel, segments: params.timeline.length },
    () => adapter.spot(params.filePath, params.timeline, params.duration),
    "model.knowledge_action_spotting"
  );
  const trace = result.available
    ? `knowledge-action:${adapter.sourceId}:${result.provider}:${result.model}:${result.spots.length}`
    : `knowledge-action-unavailable:${adapter.sourceId}:${result.error ?? "not configured"}`;
  if (!result.available) {
    logJson("warn", "model.knowledge_action_spotting.unavailable", "Knowledge action spotting unavailable", {
      jobId: params.jobId,
      assetId: params.assetId,
      sourceId: adapter.sourceId,
      error: result.error
    });
  }
  return {
    available: result.available,
    sourceId: adapter.sourceId,
    provider: result.provider,
    model: result.model,
    trace,
    timeline: adapter.apply(params.timeline, result),
    error: result.error ?? null
  };
}
