import type { TimelineSegment } from "../../shared/types";
import { isTrustedDomainSegment } from "../evidenceTrust";
import { videoVlmSearchText } from "../videoVlmText";

export type VectorRow = {
  id: string;
  index_id: string;
  asset_id: string;
  segment_id: string;
  start_seconds: number;
  end_seconds: number;
  thumbnail_path: string | null;
  modalities: string[];
  tags: string[];
  text: string;
  embedding_json: number[];
  score?: number;
  lexical_score?: number;
};

export type VisualVectorRow = {
  id: string;
  index_id: string;
  asset_id: string;
  segment_id: string;
  keyframe_id: string;
  keyframe_path: string;
  start_seconds: number;
  end_seconds: number;
  model: string;
  embedding_json: number[];
  score?: number;
};

export type AppearanceVectorRow = {
  id: string;
  index_id: string;
  asset_id: string;
  segment_id: string;
  keyframe_id: string;
  keyframe_path: string;
  start_seconds: number;
  end_seconds: number;
  subject_label: string;
  source: string;
  metadata_tags: string[];
  model: string;
  embedding_json: number[];
  score?: number;
};

export function vectorRowToResult(row: VectorRow) {
  return {
    id: row.id,
    indexId: row.index_id,
    assetId: row.asset_id,
    segmentId: row.segment_id,
    start: Number(row.start_seconds),
    end: Number(row.end_seconds),
    thumbnailPath: row.thumbnail_path,
    modalities: row.modalities ?? [],
    vector: row.embedding_json ?? [],
    text: row.text,
    tags: row.tags ?? [],
    score: Number(row.score ?? 0)
  };
}

export function visualVectorRowToResult(row: VisualVectorRow) {
  return {
    id: row.id,
    indexId: row.index_id,
    assetId: row.asset_id,
    segmentId: row.segment_id,
    keyframeId: row.keyframe_id,
    keyframePath: row.keyframe_path,
    start: Number(row.start_seconds),
    end: Number(row.end_seconds),
    model: row.model,
    vector: row.embedding_json ?? [],
    score: Number(row.score ?? 0)
  };
}

export function appearanceVectorRowToResult(row: AppearanceVectorRow) {
  return {
    id: row.id,
    indexId: row.index_id,
    assetId: row.asset_id,
    segmentId: row.segment_id,
    keyframeId: row.keyframe_id,
    keyframePath: row.keyframe_path,
    start: Number(row.start_seconds),
    end: Number(row.end_seconds),
    subjectLabel: row.subject_label,
    source: row.source,
    metadataTags: row.metadata_tags ?? [],
    model: row.model,
    vector: row.embedding_json ?? [],
    score: Number(row.score ?? 0)
  };
}

export function vectorLiteral(vector: number[]) {
  return `[${vector.map((value) => Number(value || 0)).join(",")}]`;
}

export function vectorRecordText(segment: TimelineSegment) {
  const domainSearchText = segment.domain && isTrustedDomainSegment(segment.domain) ? segment.domain.searchText : "";
  const domainCaptions = segment.domain && isTrustedDomainSegment(segment.domain) ? segment.domain.captions : [];
  const domainLabels = segment.domain && isTrustedDomainSegment(segment.domain) ? segment.domain.labels : [];
  return [
    segment.label,
    segment.summary,
    segment.transcript,
    segment.tags.join(" "),
    domainSearchText,
    ...domainCaptions,
    ...domainLabels,
    videoVlmSearchText(segment)
  ]
    .filter(Boolean)
    .join(" ");
}

export function isPgVectorCompatible(vector: number[]) {
  return vector.length === getExpectedEmbeddingDimensions() && vector.some((value) => Number.isFinite(value) && value !== 0);
}

export function isVisualPgVectorCompatible(vector: number[]) {
  return vector.length === getExpectedVisualEmbeddingDimensions() && vector.some((value) => Number.isFinite(value) && value !== 0);
}

export function getExpectedEmbeddingDimensions() {
  return parsePositiveInteger(process.env.EMBEDDING_DIMENSIONS, defaultTextEmbeddingDimensions());
}

export function getExpectedVisualEmbeddingDimensions() {
  return parsePositiveInteger(process.env.VISUAL_EMBEDDING_DIMENSIONS, 768);
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  const length = a.length;
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += a[index] * b[index];
  return Math.max(0, Number(dot.toFixed(3)));
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function defaultTextEmbeddingDimensions() {
  const profile = process.env.EMBEDDING_PROFILE?.trim().toLowerCase();
  const model = process.env.EMBEDDING_MODEL?.trim().toLowerCase() ?? "";
  if (profile === "bge-m3" || model.includes("bge-m3")) return 1024;
  return 768;
}
