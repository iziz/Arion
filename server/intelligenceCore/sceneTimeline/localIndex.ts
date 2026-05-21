import type { AssetRecord, IndexRecord, TimelineSegment } from "../../../shared/types";
import { externalMetadataSearchText, externalMetadataTags } from "../../../shared/externalMetadata";
import { withDomainSegment } from "../../domainIndex";
import { createShotWindows, type SceneBoundary } from "../../sceneDetection";
import { extractKeywords, unique, vectorize } from "../textUtils";
import { buildSceneData, ocrTextForTimelineSegment } from "./sceneData";
import { fuseTimelineBasis, normalizeWhisperTimeline, overlappingWhisperText } from "./timelineBasis";

export function buildLocalIndex(asset: AssetRecord, index: IndexRecord, sceneBoundaries: SceneBoundary[] = []) {
  const visualLabels = trustedVisualLabels(asset);
  const metadataText = externalMetadataSearchText(asset);
  const metadataTags = externalMetadataTags(asset.externalMetadata?.rurugrab);
  const keywords = extractKeywords(
    `${asset.title} ${asset.description} ${asset.originalName.replace(/\.[^.]+$/, "")} ${index.name} ${
      asset.intelligence.asr.transcript
    } ${asset.intelligence.ocr.tokens.join(" ")} ${visualLabels.join(" ")} ${metadataText}`
  );
  const tags = unique([...metadataTags, ...keywords, ...visualLabels, ...asset.intelligence.ocr.tokens]).slice(0, 48);
  const safeTags = tags.length > 0 ? tags : ["general", "uploaded", "media"];
  const duration = Math.max(asset.duration ?? 180, 1);
  const whisperSegments = normalizeWhisperTimeline(asset);
  const shotWindows = createShotWindows(sceneBoundaries, asset.duration);
  const timelineBasis = fuseTimelineBasis(asset, whisperSegments, shotWindows, duration);
  const segmentCount = timelineBasis.length > 0 ? timelineBasis.length : Math.min(12, Math.max(3, Math.ceil(duration / 35)));
  const segmentLength = duration / segmentCount;

  const timeline = Array.from({ length: segmentCount }, (_, item) => {
    const basis = timelineBasis[item];
    const start = basis ? basis.start : Math.round(item * segmentLength);
    const end = basis ? basis.end : Math.round(item === segmentCount - 1 ? duration : (item + 1) * segmentLength);
    const hasWhisperSource = Boolean(overlappingWhisperText(asset, start, end));
    const hasShotSource = Boolean(basis?.boundarySource || shotWindows.length > 0);
    const primary = safeTags[item % safeTags.length];
    const secondary = safeTags[(item + 1) % safeTags.length] ?? primary;
    const tertiary = safeTags[(item + 2) % safeTags.length] ?? "context";
    const sceneData = buildSceneData(asset, item, start, end);
    const ocrText = ocrTextForTimelineSegment(sceneData);
    const speechText = sceneData.text.speech || basis?.text || "";
    const transcript = [speechText, ocrText].filter(Boolean).join(" ");
    const hasVisualSource = isVisualSamplingAvailable(asset);
    const sources: TimelineSegment["sources"] = [
      ...(hasWhisperSource ? (["whisper"] as const) : []),
      ...(ocrText ? (["paddleocr"] as const) : []),
      ...(hasShotSource ? (["shot"] as const) : []),
      ...(hasVisualSource ? (["visual"] as const) : []),
      "metadata"
    ];
    return {
      id: `${asset.id}-segment-${item + 1}`,
      start,
      end,
      label: labelForTimelineSegment(sceneData, basis?.text, item),
      transcript,
      sceneData,
      tags: unique([primary, secondary, tertiary, ...metadataTags.slice(0, 4), ...visualLabels.slice(0, 2)]),
      modalities: chooseModalities(index.modalities, item),
      confidence: confidenceFromSources(sources),
      embedding: vectorize(`${primary} ${secondary} ${tertiary} ${metadataTags.slice(0, 8).join(" ")} ${transcript}`),
      thumbnailPath: null,
      sources: unique(sources),
      scene: {
        shotIndex: basis?.shotIndex ?? item + 1,
        boundaryScore: basis?.boundaryScore ?? null,
        boundarySource: basis?.boundarySource ?? null,
        boundaryDetector: basis?.boundaryDetector ?? null
      }
    };
  });

  const domainTimeline = timeline.map((segment) => withDomainSegment(asset, index, segment));

  return {
    tags: safeTags,
    timeline: domainTimeline,
    summary: `This asset was indexed into ${domainTimeline.length} timeline segments using ${index.models.embedding}. Evidence sources: ${summarizeSources(
      domainTimeline
    )}. Metadata terms: ${safeTags.slice(0, 5).join(", ")}.`
  };
}

function isVisualSamplingAvailable(asset: AssetRecord) {
  return trustedVisualLabels(asset).length > 0 || visualMetricsAvailable(asset);
}

function trustedVisualLabels(asset: AssetRecord) {
  const visual = asset.intelligence.visual;
  if (visual.available === false) return [];
  if (visual.labels.includes("metadata-derived") || visual.labels.includes("visual-fallback")) return [];
  return visual.labels;
}

function visualMetricsAvailable(asset: AssetRecord) {
  const visual = asset.intelligence.visual;
  if (visual.available === false) return false;
  if (visual.labels.includes("metadata-derived") || visual.labels.includes("visual-fallback")) return false;
  return visual.dominantColor !== "#000000" || visual.motionScore > 0 || visual.brightness > 0;
}

function confidenceFromSources(sources: TimelineSegment["sources"]) {
  let confidence = 0.18;
  if (sources.includes("metadata")) confidence += 0.08;
  if (sources.includes("shot")) confidence += 0.14;
  if (sources.includes("visual")) confidence += 0.04;
  if (sources.includes("paddleocr")) confidence += 0.18;
  if (sources.includes("whisper")) confidence += 0.28;
  if (sources.includes("domain")) confidence += 0.08;
  return Number(Math.min(0.86, confidence).toFixed(2));
}

function summarizeSources(timeline: TimelineSegment[]) {
  const counts = new Map<TimelineSegment["sources"][number], number>();
  for (const segment of timeline) {
    for (const source of segment.sources) counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}=${count}`)
    .join(", ");
}

function chooseModalities(modalities: IndexRecord["modalities"], index: number) {
  const fallback: IndexRecord["modalities"] = ["metadata"];
  const source = modalities.length > 0 ? modalities : fallback;
  return unique([source[index % source.length], source[(index + 1) % source.length] ?? "metadata"]);
}

function labelForTimelineSegment(
  sceneData: NonNullable<TimelineSegment["sceneData"]>,
  basisText: string | undefined,
  index: number
) {
  const candidates = [
    sceneData.text.speech,
    ...sceneData.text.subtitles,
    ...sceneData.text.screenText,
    sceneData.vlm?.caption,
    sceneData.vlm?.description,
    basisText
  ];
  for (const candidate of candidates) {
    const label = labelFromCandidate(candidate);
    if (label) return label;
  }
  return `Moment ${index + 1}`;
}

function labelFromCandidate(candidate: string | null | undefined) {
  const cleaned = cleanTimelineLabelCandidate(candidate ?? "");
  if (!cleaned) return null;
  const clauses = cleaned
    .split(/(?:\s+-\s+|[.!?。！？…]+|[|/]| {2,})/g)
    .map(cleanTimelineLabelCandidate)
    .filter(isMeaningfulTimelineLabel)
    .sort((a, b) => labelScore(b) - labelScore(a));
  const selected = clauses[0] ?? (isMeaningfulTimelineLabel(cleaned) ? cleaned : null);
  return selected ? truncateTimelineLabel(selected) : null;
}

function cleanTimelineLabelCandidate(candidate: string) {
  return candidate
    .normalize("NFKC")
    .replace(/\b(?:subtitle|screen|overlay|watermark)\s*[·:]\s*/gi, " ")
    .replace(/[“”"']/g, "")
    .replace(/^\s*[-–—•·:]+/g, "")
    .replace(/\s*[-–—•·:]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulTimelineLabel(label: string) {
  const searchable = label.replace(/[^0-9A-Za-z가-힣]/g, "");
  if (searchable.length < 4) return false;
  if (/^[0-9]+$/.test(searchable)) return false;
  if (/^(scene|moment|unknown|metadata)$/i.test(searchable)) return false;
  return true;
}

function labelScore(label: string) {
  const searchableLength = label.replace(/[^0-9A-Za-z가-힣]/g, "").length;
  const targetLengthScore = Math.max(0, 32 - Math.abs(searchableLength - 18));
  const wordScore = label.includes(" ") ? 8 : 0;
  return targetLengthScore + wordScore;
}

function truncateTimelineLabel(label: string) {
  const maxLength = 48;
  const characters = Array.from(label);
  if (characters.length <= maxLength) return label;
  return `${characters.slice(0, maxLength - 3).join("").trimEnd()}...`;
}
