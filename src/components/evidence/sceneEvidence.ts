import type { AssetRecord } from "../../../shared/types";
import { splitSearchEvidence } from "../../displayUtils";

export function getSearchSceneData(segment: AssetRecord["timeline"][number], query: string) {
  if (segment.sceneData) {
    return {
      ...segment.sceneData,
      text: {
        ...segment.sceneData.text,
        comparisons: segment.sceneData.text.comparisons ?? []
      }
    };
  }
  const evidence = splitSearchEvidence(segment.transcript, segment.label, query);
  return {
    image: {
      thumbnailPath: segment.thumbnailPath,
      framePath: null,
      labels: segment.tags.slice(0, 4),
      dominantColor: "",
      brightness: 0,
      motionScore: 0,
      keyframeAt: (segment.start + segment.end) / 2
    },
    text: {
      speech: evidence.asr,
      subtitles: [],
      screenText: evidence.ocr ? [evidence.ocr] : [],
      overlays: [],
      watermarks: [],
      comparisons: []
    },
    vlm: undefined,
    vision: undefined
  };
}
export function getDomainSummary(segment: AssetRecord["timeline"][number]) {
  const event = segment.domain?.events[0];
  if (!event) return "";
  const football = event.football;
  const scope = segment.domain?.scope;
  const parts = [
    scope?.competition ? `competition ${scope.competition.value}` : "",
    scope?.season ? `season ${scope.season.value}` : "",
    event.caption,
    football?.fieldZone && football.fieldZone !== "unknown" ? `zone ${football.fieldZone.replace(/_/g, " ")}` : "",
    football?.passType && football.passType !== "unknown" ? `pass ${football.passType.replace(/_/g, " ")}` : "",
    football?.receivingPlayer.identity ? `receiver ${football.receivingPlayer.identity.name}` : "",
    football?.receivingPlayer.present ? "receiver inferred" : "",
    football?.ball.trackingStatus === "not_configured" ? "tracking pending" : ""
  ].filter(Boolean);
  return parts.join(" · ");
}
