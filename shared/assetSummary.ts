import type { AssetRecord, AssetSummaryRecord } from "./types";

export function summarizeAssetRecord(asset: AssetRecord): AssetSummaryRecord {
  const domainVlm = asset.timeline.reduce(
    (summary, segment) => {
      const status = segment.domain?.vlm?.status;
      if (status) {
        summary[status] += 1;
        if (status !== "skipped") summary.attempted += 1;
      }
      return summary;
    },
    { refined: 0, invalid: 0, failed: 0, skipped: 0, attempted: 0 }
  );
  return {
    id: asset.id,
    indexId: asset.indexId,
    title: asset.title,
    description: asset.description,
    originalName: asset.originalName,
    storedName: asset.storedName,
    mimeType: asset.mimeType,
    size: asset.size,
    duration: asset.duration,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    progress: asset.progress,
    tags: asset.tags,
    summary: asset.summary,
    error: asset.error,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    timelineCount: asset.timeline.length,
    keyframeCount: asset.keyframes.length,
    domainEventCount: asset.timeline.reduce((count, segment) => count + (segment.domain?.events.length ?? 0), 0),
    domainVlm
  };
}

export function summarizeAssetRecords(assets: AssetRecord[]): AssetSummaryRecord[] {
  return assets.map(summarizeAssetRecord);
}
