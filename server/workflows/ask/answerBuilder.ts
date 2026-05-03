import type { DomainQueryPlan, OrchestrationPlan, SearchResult } from "../../../shared/types";
import type { AskRequest } from "./types";

export function formatSearchScope({ indexId, tag, modality }: Pick<AskRequest, "indexId" | "tag" | "modality">) {
  return [indexId ? `index=${indexId}` : "all indexes", tag ? `tag=${tag}` : "", modality ? `modality=${modality}` : ""].filter(Boolean).join(" · ");
}

export function buildAskVideoAnswer(results: SearchResult[], queryPlan: DomainQueryPlan) {
  if (results.length === 0) {
    return "No indexed video moment matched this query. Try adding an event, player, season, or lowering the trust filters.";
  }
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  const player = queryPlan.intent.player ? ` for ${queryPlan.intent.player}` : "";
  const event = queryPlan.intent.eventType ? ` matching ${queryPlan.intent.eventType.replace(/_/g, " ")}` : "";
  return `Found ${segmentCount} indexed moments across ${results.length} assets${player}${event}.`;
}

export function buildAskAnalysisAnswer(results: SearchResult[], queryPlan: DomainQueryPlan, orchestrationPlan: OrchestrationPlan) {
  if (results.length === 0) return buildAskVideoAnswer(results, queryPlan);
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  const top = results[0];
  const topMoments = top.segments.slice(0, 3).map((segment) => `${formatClock(segment.start)}-${formatClock(segment.end)}`).join(", ");
  const sourceProfile = summarizeResultSources(results);
  const focus = [
    queryPlan.intent.player ? `player=${queryPlan.intent.player}` : "",
    queryPlan.intent.eventType ? `event=${queryPlan.intent.eventType}` : "",
    queryPlan.intent.fieldZone ? `zone=${queryPlan.intent.fieldZone}` : ""
  ].filter(Boolean).join(" · ");
  return [
    `I found ${segmentCount} indexed moments across ${results.length} assets${focus ? ` (${focus})` : ""}.`,
    `The strongest source asset is "${top.asset.title}" with key moments around ${topMoments || "the retrieved timeline"}.`,
    sourceProfile ? `Sources: ${sourceProfile}.` : "",
    orchestrationPlan.analysis.required ? "The analysis is grounded only in retrieved indexed moments, not an external generator." : ""
  ].filter(Boolean).join(" ");
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function summarizeResultSources(results: SearchResult[]) {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const segment of result.segments) {
      for (const source of segment.sources) counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}=${count}`)
    .join(", ");
}
