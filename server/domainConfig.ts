import type { CapabilityMode, CapabilityPolicy, IndexRecord } from "../shared/types";

export function normalizeDomainIndexing(value: unknown): IndexRecord["domainIndexing"] {
  if (!value || typeof value !== "object") {
    return { enabled: false, groups: [], stages: [] };
  }
  const record = value as Record<string, unknown>;
  const allowedGroups = new Set(["sports.football", "sports.american_football"]);
  const groups = Array.isArray(record.groups)
    ? record.groups.filter((group): group is NonNullable<IndexRecord["domainIndexing"]>["groups"][number] => typeof group === "string" && allowedGroups.has(group))
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
  return {
    whisperXDiarization: normalizeMode(record.whisperXDiarization, defaults.whisperXDiarization),
    visionDetector: normalizeMode(record.visionDetector, defaults.visionDetector),
    visionTracker: normalizeMode(record.visionTracker, defaults.visionTracker),
    soccerNetActionSpotting: normalizeMode(record.soccerNetActionSpotting, defaults.soccerNetActionSpotting),
    domainVlmRefinement: normalizeMode(record.domainVlmRefinement, defaults.domainVlmRefinement)
  };
}

export function defaultCapabilityPolicy(domainIndexing?: IndexRecord["domainIndexing"]): CapabilityPolicy {
  const sportsEnabled = Boolean(domainIndexing?.enabled && domainIndexing.groups.length > 0);
  return {
    whisperXDiarization: envMode("CAPABILITY_WHISPERX_DIARIZATION", "optional"),
    visionDetector: envMode("CAPABILITY_VISION_DETECTOR", sportsEnabled ? "optional" : "optional"),
    visionTracker: envMode("CAPABILITY_VISION_TRACKER", sportsEnabled ? "optional" : "optional"),
    soccerNetActionSpotting: envMode("CAPABILITY_SOCCERNET_ACTION_SPOTTING", "optional"),
    domainVlmRefinement: envMode("CAPABILITY_DOMAIN_VLM_REFINEMENT", "optional")
  };
}

function envMode(name: string, fallback: CapabilityMode) {
  return normalizeMode(process.env[name], fallback);
}

function normalizeMode(value: unknown, fallback: CapabilityMode): CapabilityMode {
  return value === "disabled" || value === "optional" || value === "required" ? value : fallback;
}
