import type { IndexRecord } from "../shared/types";

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
