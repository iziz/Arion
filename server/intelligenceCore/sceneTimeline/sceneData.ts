import type { AssetRecord, TimelineSegment } from "../../../shared/types";
import { buildTextComparisons, formatOcrEvidence, isLikelyWatermark, nearbyOcrFrame, ocrEvidenceFromFrame } from "./ocrEvidence";
import { overlappingWhisperText } from "./timelineBasis";
import { buildVisionEvidence } from "./visionEvidence";

export function buildSceneData(asset: AssetRecord, index: number, start: number, end: number): NonNullable<TimelineSegment["sceneData"]> {
  const ocrFrame = nearbyOcrFrame(asset, index, start, end);
  const ocrEvidence = ocrFrame ? ocrEvidenceFromFrame(ocrFrame) : { subtitle: [], screenText: [], overlay: [] };
  const speech = overlappingWhisperText(asset, start, end);
  const subtitles = ocrEvidence.subtitle;
  const screenText = ocrEvidence.screenText;
  const overlays = ocrEvidence.overlay.filter((value) => !isLikelyWatermark(value));
  const watermarks = ocrEvidence.overlay.filter(isLikelyWatermark);
  const visual = asset.intelligence.visual;
  const labels = visual.available === false || visual.labels.includes("metadata-derived") || visual.labels.includes("visual-fallback") ? [] : visual.labels.slice(0, 6);
  return {
    image: {
      thumbnailPath: null,
      framePath: ocrFrame?.framePath || null,
      labels,
      dominantColor: asset.intelligence.visual.dominantColor,
      brightness: asset.intelligence.visual.brightness,
      motionScore: asset.intelligence.visual.motionScore,
      keyframeAt: Number(((start + end) / 2).toFixed(2))
    },
    text: {
      speech,
      subtitles,
      screenText,
      overlays,
      watermarks,
      comparisons: buildTextComparisons(speech, subtitles, screenText)
    },
    vision: buildVisionEvidence(asset, start, end)
  };
}

export function withSceneData(asset: AssetRecord, segment: TimelineSegment): TimelineSegment {
  const sceneData = segment.sceneData ?? buildSceneData(asset, Math.max(0, (segment.scene?.shotIndex ?? 1) - 1), segment.start, segment.end);
  return {
    ...segment,
    sceneData: {
      ...sceneData,
      image: {
        ...sceneData.image,
        thumbnailPath: segment.thumbnailPath ?? sceneData.image.thumbnailPath
      },
      vision: sceneData.vision ?? buildVisionEvidence(asset, segment.start, segment.end)
    }
  };
}

export function ocrTextForTimelineSegment(sceneData: NonNullable<TimelineSegment["sceneData"]>) {
  return formatOcrEvidence({
    subtitle: sceneData.text.subtitles,
    screenText: sceneData.text.screenText,
    overlay: [...sceneData.text.overlays, ...sceneData.text.watermarks]
  });
}
