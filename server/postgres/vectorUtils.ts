import type { TimelineSegment } from "../../shared/types";
import { isTrustedDomainSegment, isTrustedVisionEvidence, isTrustedVisionFieldZone } from "../evidenceTrust";

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

export function vectorLiteral(vector: number[]) {
  return `[${vector.map((value) => Number(value || 0)).join(",")}]`;
}

export function vectorRecordText(segment: TimelineSegment) {
  const vision = segment.sceneData?.vision;
  const trustedVision = isTrustedVisionEvidence(vision);
  const domainSearchText = segment.domain && isTrustedDomainSegment(segment.domain) ? segment.domain.searchText : "";
  const domainCaptions = segment.domain && isTrustedDomainSegment(segment.domain) ? segment.domain.captions : [];
  const domainLabels = segment.domain && isTrustedDomainSegment(segment.domain) ? segment.domain.labels : [];
  return [
    segment.label,
    segment.transcript,
    domainSearchText,
    ...domainCaptions,
    ...domainLabels,
    trustedVision && vision?.pitch.present ? `pitch ${Math.round(vision.pitch.confidence * 100)}%` : "",
    trustedVision && vision?.objects.players.status === "detected" ? `players ${vision.objects.players.status} ${vision.objects.players.countEstimate}` : "",
    trustedVision && vision?.objects.ball.status === "detected" ? `ball ${vision.objects.ball.status}` : "",
    isTrustedVisionFieldZone(vision) ? `zone ${vision?.fieldZone.zone}` : "",
    isTrustedVisionFieldZone(vision) && vision?.fieldCalibration ? `field calibration ${vision.fieldCalibration.status} ${vision.fieldCalibration.method}` : "",
    trustedVision && vision?.fieldCalibration && vision.fieldCalibration.attackingDirection !== "unknown" ? `attacking direction ${vision.fieldCalibration.attackingDirection}` : "",
    trustedVision && vision?.tracking?.ballTrackId ? `ball track ${vision.tracking.ballTrackId}` : "",
    trustedVision && vision?.tracking?.nearestPlayerTrackId ? `nearest player ${vision.tracking.nearestPlayerTrackId}` : "",
    trustedVision && vision?.eventClassification && vision.eventClassification.label !== "unknown" ? `event classifier ${vision.eventClassification.label}` : ""
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
  return Number(process.env.EMBEDDING_DIMENSIONS || 768);
}

export function getExpectedVisualEmbeddingDimensions() {
  return Number(process.env.VISUAL_EMBEDDING_DIMENSIONS || 512);
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  const length = a.length;
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += a[index] * b[index];
  return Math.max(0, Number(dot.toFixed(3)));
}
