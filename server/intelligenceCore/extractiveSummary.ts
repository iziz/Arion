import type { AssetRecord, IndexRecord, TimelineSegment } from "../../shared/types";
import { isTrustedDomainSegment, trustedDomainEvents } from "../evidenceTrust";
import { videoVlmSearchText } from "../videoVlmText";

export const EXTRACTIVE_SUMMARY_TRACE_PREFIX = "summary:extractive-v1";

export type ExtractiveVideoSummary = {
  summary: string;
  timeline: TimelineSegment[];
  trace: string;
  summarizedSegments: number;
};

type SummaryCandidate = {
  text: string;
  priority: number;
};

export function applyExtractiveVideoSummaries(asset: AssetRecord, index: IndexRecord, timeline: TimelineSegment[]): ExtractiveVideoSummary {
  const summarizedTimeline = timeline.map((segment) => ({
    ...segment,
    summary: buildExtractiveSegmentSummary(segment)
  }));
  const summary = buildExtractiveAssetSummary({ ...asset, tags: asset.tags.length > 0 ? asset.tags : collectTimelineTags(summarizedTimeline) }, index, summarizedTimeline);
  const summarizedSegments = summarizedTimeline.filter((segment) => Boolean(segment.summary?.trim())).length;
  return {
    summary,
    timeline: summarizedTimeline,
    trace: `${EXTRACTIVE_SUMMARY_TRACE_PREFIX}:${summarizedSegments}/${summarizedTimeline.length}`,
    summarizedSegments
  };
}

export function buildExtractiveSegmentSummary(segment: TimelineSegment) {
  const sceneText = segment.sceneData?.text;
  const vlm = segment.sceneData?.vlm?.status === "described" ? segment.sceneData.vlm : null;
  const vision = segment.sceneData?.vision;
  const domain = isTrustedDomainSegment(segment.domain) ? segment.domain : null;
  const candidates: SummaryCandidate[] = [
    ...summaryCandidates(domain?.captions ?? [], 100),
    ...summaryCandidates(trustedDomainEvents(segment).map((event) => event.caption), 98),
    candidate(segment.label, 86),
    candidate(sceneText?.speech || segment.transcript, 84),
    ...summaryCandidates(sceneText?.subtitles ?? [], 82),
    ...summaryCandidates(sceneText?.screenText ?? [], 80),
    ...summaryCandidates(sceneText?.overlays ?? [], 76),
    candidate(vlm?.caption, 74),
    candidate(vlm?.description, 70),
    ...summaryCandidates(vlm?.visibleText ?? [], 68),
    ...summaryCandidates(vlm?.evidence ?? [], 66),
    listCandidate("Actions", vlm?.actions, 58),
    listCandidate("Objects", vlm?.objects, 56),
    listCandidate("Labels", [...(domain?.labels ?? []), ...(vlm?.labels ?? [])], 52),
    candidate(visionEventSummary(segment), 48),
    candidate(videoVlmSearchText(segment), 44)
  ].filter((item): item is SummaryCandidate => Boolean(item?.text));

  return selectDistinctSummaryText(candidates, 4, 420);
}

export function buildExtractiveAssetSummary(asset: AssetRecord, _index: IndexRecord, timeline: TimelineSegment[]) {
  const segmentSummaries = selectRepresentativeSegments(timeline)
    .map((segment) => segment.summary || buildExtractiveSegmentSummary(segment))
    .filter(Boolean);
  const content = selectDistinctSummaryText(
    [
      candidate(asset.description, 98),
      ...summaryCandidates(segmentSummaries, 90),
      ...summaryCandidates(asset.tags, 50)
    ].filter((item): item is SummaryCandidate => Boolean(item?.text)),
    8,
    900,
    "; "
  );
  const coverage = buildEvidenceCoverageSummary(timeline);
  const metadata = asset.tags.length > 0 ? `Metadata terms: ${asset.tags.slice(0, 10).join(", ")}.` : "";
  return [content ? `Content summary: ${content}` : "", coverage, metadata].filter(Boolean).join(" ");
}

function selectRepresentativeSegments(timeline: TimelineSegment[]) {
  if (timeline.length <= 8) return timeline;
  const selected = new Map<string, TimelineSegment>();
  for (const segment of timeline.slice(0, 2)) selected.set(segment.id, segment);
  for (const segment of timeline.slice(-2)) selected.set(segment.id, segment);
  const scored = timeline
    .map((segment) => ({ segment, score: segmentSummaryScore(segment) }))
    .sort((a, b) => b.score - a.score || a.segment.start - b.segment.start);
  for (const item of scored) {
    if (selected.size >= 8) break;
    selected.set(item.segment.id, item.segment);
  }
  return Array.from(selected.values()).sort((a, b) => a.start - b.start);
}

function segmentSummaryScore(segment: TimelineSegment) {
  return (
    (isTrustedDomainSegment(segment.domain) ? 12 : 0) +
    trustedDomainEvents(segment).length * 4 +
    (segment.sceneData?.vlm?.status === "described" ? 8 : 0) +
    (segment.sceneData?.vision?.eventClassification?.label && segment.sceneData.vision.eventClassification.label !== "unknown" ? 4 : 0) +
    (segment.transcript.trim() ? 3 : 0) +
    segment.sources.length
  );
}

function buildEvidenceCoverageSummary(timeline: TimelineSegment[]) {
  const sourceCounts = new Map<TimelineSegment["sources"][number], number>();
  let vlmSegments = 0;
  let domainEvents = 0;
  let summarizedSegments = 0;
  for (const segment of timeline) {
    if (segment.summary?.trim()) summarizedSegments += 1;
    if (segment.sceneData?.vlm?.status === "described") vlmSegments += 1;
    domainEvents += trustedDomainEvents(segment).length;
    for (const source of segment.sources) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  const sourceText = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source, count]) => `${source}=${count}`)
    .join(", ");
  return [
    `Evidence coverage: ${timeline.length} timeline segments`,
    summarizedSegments ? `${summarizedSegments} moment summaries` : "",
    sourceText ? `sources ${sourceText}` : "",
    vlmSegments ? `VLM descriptions ${vlmSegments}` : "",
    domainEvents ? `related knowledge events ${domainEvents}` : ""
  ]
    .filter(Boolean)
    .join("; ") + ".";
}

function collectTimelineTags(timeline: TimelineSegment[]) {
  return Array.from(new Set(timeline.flatMap((segment) => segment.tags))).slice(0, 24);
}

function visionEventSummary(segment: TimelineSegment) {
  const vision = segment.sceneData?.vision;
  const event = vision?.eventClassification;
  if (!vision) return "";
  const parts = [
    event && event.label !== "unknown" ? event.label : "",
    vision.fieldZone.zone !== "unknown" ? vision.fieldZone.zone : "",
    vision.objects.players.status === "detected" ? `${vision.objects.players.countEstimate} detected players` : "",
    vision.objects.ball.status === "detected" || vision.objects.ball.present ? "ball detected" : ""
  ].filter(Boolean);
  return parts.length > 0 ? `Vision evidence: ${parts.join(", ")}` : "";
}

function listCandidate(label: string, values: string[] | undefined, priority: number) {
  const uniqueValues = uniqueText(values ?? []).slice(0, 8);
  if (uniqueValues.length === 0) return null;
  return candidate(`${label}: ${uniqueValues.join(", ")}`, priority);
}

function summaryCandidates(values: string[], priority: number) {
  return values.map((value, index) => candidate(value, priority - index * 0.1)).filter((item): item is SummaryCandidate => Boolean(item));
}

function candidate(value: string | null | undefined, priority: number): SummaryCandidate | null {
  const text = cleanSummaryText(value ?? "");
  if (!text || isWeakSummaryText(text)) return null;
  return { text, priority };
}

function selectDistinctSummaryText(candidates: SummaryCandidate[], limit: number, maxLength: number, separator = " ") {
  const selected: string[] = [];
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority || b.text.length - a.text.length);
  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    if (selected.some((text) => overlapsSummaryText(text, candidate.text))) continue;
    const next = [...selected, candidate.text].join(separator);
    if (next.length > maxLength && selected.length > 0) continue;
    selected.push(candidate.text);
  }
  return selected.join(separator);
}

function cleanSummaryText(value: string) {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  return truncateSummaryText(cleaned, 260);
}

function truncateSummaryText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const boundary = value
    .slice(0, maxLength)
    .replace(/\s+\S*$/, "")
    .replace(/[,\s;:]+$/, "")
    .trim();
  return `${boundary || value.slice(0, maxLength).trim()}...`;
}

function isWeakSummaryText(value: string) {
  const normalized = normalizeForComparison(value);
  return normalized.length < 3 || normalized === "scene" || normalized === "moment" || /^\d+$/.test(normalized);
}

function overlapsSummaryText(a: string, b: string) {
  const first = normalizeForComparison(a);
  const second = normalizeForComparison(b);
  if (!first || !second) return false;
  return first.includes(second) || second.includes(first);
}

function uniqueText(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanSummaryText(value);
    const key = normalizeForComparison(cleaned);
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function normalizeForComparison(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
