import type { IndexRecord, KnowledgeSourceId, TimelineSegment } from "../shared/types";
import { formatKnowledgeSourceLabel, sourceSupportsKnowledgeActionSpotting } from "../shared/knowledgeSources";
import {
  type KnowledgeActionSpottingAdapter,
  runKnowledgeActionSpottingAdapter
} from "./knowledge/actionSpottingAdapter";
import {
  americanFootballActionModel,
  applyAmericanFootballActionSpots,
  isAmericanFootballActionSpottingConfigured,
  spotAmericanFootballActions
} from "./knowledge/adapters/sports/americanFootball/actionSpotting";
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

const knowledgeActionSpottingAdapters: Partial<Record<KnowledgeSourceId, KnowledgeActionSpottingAdapter<any>>> = {
  "sports.football": {
    sourceId: "sports.football",
    modelLabel: soccerNetActionModel,
    isConfigured: isSoccerNetActionSpottingConfigured,
    spot: spotSoccerNetActions,
    apply: applySoccerNetActionSpots
  },
  "sports.american_football": {
    sourceId: "sports.american_football",
    modelLabel: americanFootballActionModel,
    isConfigured: isAmericanFootballActionSpottingConfigured,
    spot: spotAmericanFootballActions,
    apply: applyAmericanFootballActionSpots
  }
};

export function resolveKnowledgeActionSpottingSource(index: IndexRecord): KnowledgeSourceId | null {
  return index.domainIndexing?.groups.find(sourceSupportsKnowledgeActionSpotting) ?? null;
}

export function getKnowledgeActionSpottingModelLabel(index: IndexRecord) {
  const sourceId = resolveKnowledgeActionSpottingSource(index);
  if (!sourceId) return "no configured knowledge action adapter";
  const adapter = knowledgeActionSpottingAdapters[sourceId];
  return adapter ? `${formatKnowledgeSourceLabel(sourceId)} · ${adapter.modelLabel}` : formatKnowledgeSourceLabel(sourceId);
}

export function isKnowledgeActionSpottingConfigured(index: IndexRecord) {
  const sourceId = resolveKnowledgeActionSpottingSource(index);
  return sourceId ? Boolean(knowledgeActionSpottingAdapters[sourceId]?.isConfigured()) : false;
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
  const adapter = sourceId ? knowledgeActionSpottingAdapters[sourceId] : null;
  if (adapter) return runKnowledgeActionSpottingAdapter(adapter, params);

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
