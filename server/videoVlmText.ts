import type { TimelineSegment, VideoVlmEvidence } from "../shared/types";

export function videoVlmSearchText(segment: TimelineSegment) {
  return videoVlmEvidenceText(segment.sceneData?.vlm);
}

export function videoVlmEvidenceText(vlm: VideoVlmEvidence | null | undefined) {
  if (vlm?.status !== "described") return "";
  return [
    vlm.caption,
    vlm.description,
    vlm.sceneType ? `scene type ${vlm.sceneType}` : "",
    vlm.labels.length > 0 ? `labels ${vlm.labels.join(", ")}` : "",
    vlm.objects.length > 0 ? `objects ${vlm.objects.join(", ")}` : "",
    vlm.actions.length > 0 ? `actions ${vlm.actions.join(", ")}` : "",
    vlm.visibleText.length > 0 ? `visible text ${vlm.visibleText.join(" ")}` : "",
    vlm.evidence.length > 0 ? `evidence ${vlm.evidence.join(" ")}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}
