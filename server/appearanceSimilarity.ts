import { externalMetadataTags } from "../shared/externalMetadata";
import type { AssetRecord } from "../shared/types";
import type { VisualVectorRecord } from "./localVisualEmbeddingRuntime";

export type AppearanceVectorRecord = {
  id: string;
  indexId: string;
  assetId: string;
  segmentId: string;
  keyframeId: string;
  keyframePath: string;
  start: number;
  end: number;
  subjectLabel: string;
  source: "keyframe_person_context";
  metadataTags: string[];
  vector: number[];
  model: string;
};

export function deriveAppearanceVectors(asset: AssetRecord, visualRecords: VisualVectorRecord[]) {
  const segments = new Map(asset.timeline.map((segment) => [segment.id, segment]));
  const catalogTags = externalMetadataTags(asset.externalMetadata?.rurugrab);
  return visualRecords
    .map((record): AppearanceVectorRecord | null => {
      const segment = segments.get(record.segmentId);
      if (!segment || !isAppearanceCandidateSegment(asset, segment)) return null;
      const metadataTags = uniqueClean([
        ...catalogTags,
        ...asset.tags,
        ...segment.tags,
        ...(asset.externalMetadata?.rurugrab?.performers ?? []),
        ...(asset.externalMetadata?.rurugrab?.genres ?? [])
      ]).slice(0, 48);
      return {
        id: `${record.id}:appearance`,
        indexId: record.indexId,
        assetId: record.assetId,
        segmentId: record.segmentId,
        keyframeId: record.keyframeId,
        keyframePath: record.keyframePath,
        start: record.start,
        end: record.end,
        subjectLabel: subjectLabelForAppearance(asset, metadataTags),
        source: "keyframe_person_context",
        metadataTags,
        vector: record.vector,
        model: record.model
      };
    })
    .filter((record): record is AppearanceVectorRecord => Boolean(record));
}

function isAppearanceCandidateSegment(asset: AssetRecord, segment: AssetRecord["timeline"][number]) {
  if (asset.externalMetadata?.rurugrab?.performers.length) return true;
  if (segment.tags.some((tag) => /performer|actor|actress|person|metadata:rurugrab/i.test(tag))) return true;
  const vision = segment.sceneData?.vision;
  if (vision?.objects.players.status === "detected" && vision.objects.players.countEstimate > 0) return true;
  if (vision?.tracking?.playerTracks?.length) return true;
  const labels = segment.sceneData?.image.labels ?? [];
  return labels.some((label) => /person|face|human|portrait/i.test(label));
}

function subjectLabelForAppearance(asset: AssetRecord, metadataTags: string[]) {
  const performers = asset.externalMetadata?.rurugrab?.performers ?? [];
  if (performers.length > 0) return performers.slice(0, 3).join(", ");
  return metadataTags.find((tag) => !tag.includes(":")) ?? "appearance candidate";
}

function uniqueClean(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}
