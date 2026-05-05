import type { IndexRecord, KnowledgeSourceId, TimelineSegment } from "../shared/types";
import { formatKnowledgeSourceLabel, sourceSupportsKnowledgeActionSpotting } from "../shared/knowledgeSources";
import { logJson, traceAsync } from "./observability";
import { applySoccerNetActionSpots, isSoccerNetActionSpottingConfigured, soccerNetActionModel, spotSoccerNetActions } from "./knowledge/adapters/sports/football/soccernet";

export type KnowledgeActionSpottingResult = {
  available: boolean;
  sourceId: KnowledgeSourceId | null;
  provider: string;
  model: string;
  trace: string;
  timeline: TimelineSegment[];
  error: string | null;
};

export function resolveKnowledgeActionSpottingSource(index: IndexRecord): KnowledgeSourceId | null {
  return index.domainIndexing?.groups.find(sourceSupportsKnowledgeActionSpotting) ?? null;
}

export function getKnowledgeActionSpottingModelLabel(index: IndexRecord) {
  const sourceId = resolveKnowledgeActionSpottingSource(index);
  if (!sourceId) return "no configured knowledge action adapter";
  if (sourceId === "sports.football") return `${formatKnowledgeSourceLabel(sourceId)} · ${soccerNetActionModel}`;
  return formatKnowledgeSourceLabel(sourceId);
}

export function isKnowledgeActionSpottingConfigured(index: IndexRecord) {
  const sourceId = resolveKnowledgeActionSpottingSource(index);
  if (sourceId === "sports.football") return isSoccerNetActionSpottingConfigured();
  return false;
}

export async function runKnowledgeActionSpotting(params: {
  filePath: string;
  timeline: TimelineSegment[];
  duration: number | null;
  index: IndexRecord;
  jobId: string;
  assetId: string;
}): Promise<KnowledgeActionSpottingResult> {
  const sourceId = resolveKnowledgeActionSpottingSource(params.index);
  if (sourceId === "sports.football") {
    const result = await traceAsync(
      "model.knowledge_action_spotting",
      { jobId: params.jobId, assetId: params.assetId, sourceId, model: soccerNetActionModel, segments: params.timeline.length },
      () => spotSoccerNetActions(params.filePath, params.timeline, params.duration),
      "model.knowledge_action_spotting"
    );
    const trace = result.available
      ? `knowledge-action:${sourceId}:${result.provider}:${result.model}:${result.spots.length}`
      : `knowledge-action-unavailable:${sourceId}:${result.error ?? "not configured"}`;
    if (!result.available) {
      logJson("warn", "model.knowledge_action_spotting.unavailable", "Knowledge action spotting unavailable", {
        jobId: params.jobId,
        assetId: params.assetId,
        sourceId,
        error: result.error
      });
    }
    return {
      available: result.available,
      sourceId,
      provider: result.provider,
      model: result.model,
      trace,
      timeline: applySoccerNetActionSpots(params.timeline, result),
      error: result.error ?? null
    };
  }

  return {
    available: false,
    sourceId,
    provider: "knowledge-action-adapter",
    model: "unavailable",
    trace: `knowledge-action-unavailable:${sourceId ?? "none"}:no adapter configured`,
    timeline: params.timeline,
    error: sourceId ? `No knowledge action spotting adapter is configured for ${sourceId}.` : "No knowledge source supports action spotting."
  };
}
