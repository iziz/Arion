import type { AssetRecord, IndexRecord, TimelineSegment } from "../../shared/types";

export function stageLabelsForIndex(index: IndexRecord) {
  return (index.domainIndexing?.stages ?? []).map((stage) => `stage.${stage}`);
}

export function collectSegmentText(asset: AssetRecord, index: IndexRecord, segment: TimelineSegment) {
  const sceneText = segment.sceneData?.text;
  return [
    asset.title,
    asset.description,
    asset.originalName,
    asset.tags.join(" "),
    segment.label,
    segment.transcript,
    sceneText?.speech,
    ...(sceneText?.subtitles ?? []),
    ...(sceneText?.screenText ?? []),
    ...(sceneText?.overlays ?? [])
  ]
    .filter(Boolean)
    .join(" ");
}
