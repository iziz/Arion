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
  clusterId: string;
  clusterSize: number;
  clusterRank: number;
  subjectLabel: string;
  source: "keyframe_person_context";
  metadataTags: string[];
  vector: number[];
  model: string;
};

export function deriveAppearanceVectors(asset: AssetRecord, visualRecords: VisualVectorRecord[]) {
  const segments = new Map(asset.timeline.map((segment) => [segment.id, segment]));
  const catalogTags = externalMetadataTags(asset.externalMetadata?.rurugrab);
  const records = visualRecords
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
        clusterId: `${record.assetId}:appearance:${record.keyframeId}`,
        clusterSize: 1,
        clusterRank: 1,
        subjectLabel: subjectLabelForAppearance(asset, metadataTags),
        source: "keyframe_person_context",
        metadataTags,
        vector: record.vector,
        model: record.model
      };
    })
    .filter((record): record is AppearanceVectorRecord => Boolean(record));
  return assignAppearanceClusters(records);
}

export function assignAppearanceClusters(records: AppearanceVectorRecord[], threshold = appearanceClusterThreshold()) {
  const clusters: Array<{ centroid: number[]; members: AppearanceVectorRecord[] }> = [];
  for (const record of records.slice().sort(compareAppearanceRecords)) {
    const match = clusters
      .map((cluster) => ({ cluster, similarity: cosineSimilarity(record.vector, cluster.centroid) }))
      .filter((item) => item.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)[0]?.cluster;
    if (!match) {
      clusters.push({ centroid: normalizeVector(record.vector), members: [record] });
      continue;
    }
    match.members.push(record);
    match.centroid = centroidVector(match.members.map((item) => item.vector));
  }

  return clusters
    .sort((a, b) => a.members[0]!.start - b.members[0]!.start || b.members.length - a.members.length)
    .flatMap((cluster, clusterIndex) => {
      const centroid = centroidVector(cluster.members.map((item) => item.vector));
      const clusterId = `${cluster.members[0]!.assetId}:appearance-cluster-${String(clusterIndex + 1).padStart(3, "0")}`;
      return cluster.members
        .slice()
        .sort((a, b) => cosineSimilarity(b.vector, centroid) - cosineSimilarity(a.vector, centroid) || compareAppearanceRecords(a, b))
        .map((record, memberIndex) => ({
          ...record,
          clusterId,
          clusterSize: cluster.members.length,
          clusterRank: memberIndex + 1
        }));
    })
    .sort(compareAppearanceRecords);
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

function appearanceClusterThreshold() {
  const configured = Number(process.env.APPEARANCE_CLUSTER_MIN_SIMILARITY ?? 0.86);
  if (!Number.isFinite(configured)) return 0.86;
  return Math.max(0.5, Math.min(0.98, configured));
}

function compareAppearanceRecords(left: AppearanceVectorRecord, right: AppearanceVectorRecord) {
  return left.assetId.localeCompare(right.assetId) || left.start - right.start || left.keyframeId.localeCompare(right.keyframeId) || left.id.localeCompare(right.id);
}

function centroidVector(vectors: number[][]) {
  if (vectors.length === 0) return [];
  const length = vectors[0]?.length ?? 0;
  const centroid = new Array(length).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < length; index += 1) centroid[index] += Number(vector[index] ?? 0);
  }
  return normalizeVector(centroid.map((value) => value / vectors.length));
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  const leftNorm = normalizeVector(left);
  const rightNorm = normalizeVector(right);
  return leftNorm.reduce((sum, value, index) => sum + value * rightNorm[index]!, 0);
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
