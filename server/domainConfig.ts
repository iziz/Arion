import type { CapabilityMode, CapabilityPolicy, IndexRecord } from "../shared/types";
import { isKnownKnowledgeSourceId, sourceListSupportsKnowledgeActionSpotting } from "../shared/knowledgeSources";

export function normalizeDomainIndexing(value: unknown): IndexRecord["domainIndexing"] {
  if (!value || typeof value !== "object") {
    return { enabled: false, groups: [], stages: [] };
  }
  const record = value as Record<string, unknown>;
  const groups = Array.isArray(record.groups)
    ? record.groups.filter(isKnownKnowledgeSourceId)
    : [];
  const allowedStages = new Set(["domain_caption", "event_label", "structured_event"]);
  const stages = Array.isArray(record.stages)
    ? record.stages.filter((stage): stage is "domain_caption" | "event_label" | "structured_event" => typeof stage === "string" && allowedStages.has(stage))
    : [];
  return {
    enabled: Boolean(record.enabled) && groups.length > 0 && stages.length > 0,
    groups,
    stages
  };
}

export function normalizeCapabilityPolicy(value: unknown, domainIndexing?: IndexRecord["domainIndexing"]): CapabilityPolicy {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const defaults = defaultCapabilityPolicy(domainIndexing);
  const relatedKnowledgeEnabled = Boolean(domainIndexing?.enabled && domainIndexing.groups.length > 0);
  const knowledgeActionSpottingEnabled = Boolean(relatedKnowledgeEnabled && sourceListSupportsKnowledgeActionSpotting(domainIndexing?.groups));
  const knowledgeActionSpottingValue = record.knowledgeActionSpotting ?? record.soccerNetActionSpotting;
  return {
    whisperXDiarization: normalizeMode(record.whisperXDiarization, defaults.whisperXDiarization),
    videoVlmAnalysis: normalizeMode(record.videoVlmAnalysis, defaults.videoVlmAnalysis),
    visionDetector: relatedKnowledgeEnabled ? normalizeMode(record.visionDetector, defaults.visionDetector) : "disabled",
    visionTracker: relatedKnowledgeEnabled ? normalizeMode(record.visionTracker, defaults.visionTracker) : "disabled",
    knowledgeActionSpotting: knowledgeActionSpottingEnabled ? normalizeMode(knowledgeActionSpottingValue, defaults.knowledgeActionSpotting) : "disabled",
    domainVlmRefinement: relatedKnowledgeEnabled ? normalizeMode(record.domainVlmRefinement, defaults.domainVlmRefinement) : "disabled"
  };
}

export function defaultCapabilityPolicy(domainIndexing?: IndexRecord["domainIndexing"]): CapabilityPolicy {
  const relatedKnowledgeEnabled = Boolean(domainIndexing?.enabled && domainIndexing.groups.length > 0);
  const knowledgeActionSpottingEnabled = Boolean(relatedKnowledgeEnabled && sourceListSupportsKnowledgeActionSpotting(domainIndexing?.groups));
  return {
    whisperXDiarization: envMode("CAPABILITY_WHISPERX_DIARIZATION", "optional"),
    videoVlmAnalysis: envMode("CAPABILITY_VIDEO_VLM_ANALYSIS", "optional"),
    visionDetector: relatedKnowledgeEnabled ? envMode("CAPABILITY_VISION_DETECTOR", "optional") : "disabled",
    visionTracker: relatedKnowledgeEnabled ? envMode("CAPABILITY_VISION_TRACKER", "optional") : "disabled",
    knowledgeActionSpotting: knowledgeActionSpottingEnabled ? envMode("CAPABILITY_KNOWLEDGE_ACTION_SPOTTING", envMode("CAPABILITY_SOCCERNET_ACTION_SPOTTING", "optional")) : "disabled",
    domainVlmRefinement: relatedKnowledgeEnabled ? envMode("CAPABILITY_DOMAIN_VLM_REFINEMENT", "optional") : "disabled"
  };
}

function envMode(name: string, fallback: CapabilityMode) {
  return normalizeMode(process.env[name], fallback);
}

function normalizeMode(value: unknown, fallback: CapabilityMode): CapabilityMode {
  return value === "disabled" || value === "optional" || value === "required" ? value : fallback;
}
