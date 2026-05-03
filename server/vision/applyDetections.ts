import type { TimelineSegment, VisionEvidence } from "../../shared/types";
import { buildDetectedFieldCalibration, estimateZoneFromDetections, mergeEventCandidates } from "./evidenceMerge";
import { maxConfidence } from "./geometry";
import type { DetectorResult } from "./types";

export function applyVisionDetections(timeline: TimelineSegment[], result: DetectorResult): TimelineSegment[] {
  const frames = new Map(result.frames.map((frame) => [frame.segmentId, frame]));
  return timeline.map((segment) => {
    const frame = frames.get(segment.id);
    if (!frame) return segment;
    const sceneData = segment.sceneData;
    if (!sceneData?.vision) return segment;
    const detectorBacked = isDetectorBacked(frame.provider, result.provider, result.available, frame.available);
    if (!detectorBacked) return segment;
    const playerBoxes = frame.boxes.filter((box) => box.label === "person").sort((a, b) => b.confidence - a.confidence).slice(0, 22);
    const ballBoxes = frame.boxes.filter((box) => box.label === "sports_ball").sort((a, b) => b.confidence - a.confidence).slice(0, 4);
    if (playerBoxes.length === 0 && ballBoxes.length === 0) return segment;
    const zoneEstimate = estimateZoneFromDetections(playerBoxes, ballBoxes, sceneData.vision.fieldZone.zone);
    const detectedZone = zoneEstimate;
    const playerConfidence = maxConfidence(playerBoxes);
    const ballConfidence = maxConfidence(ballBoxes);
    const fieldCalibration = buildDetectedFieldCalibration(detectedZone, frame, sceneData.vision);
    const playerStatus = playerBoxes.length > 0 ? (detectorBacked ? "detected" : "estimated") : sceneData.vision.objects.players.status;
    const ballStatus = ballBoxes.length > 0 ? (detectorBacked ? "detected" : "estimated") : sceneData.vision.objects.ball.status;
    const nextVision: VisionEvidence = {
      ...sceneData.vision,
      trust: "detected",
      generatedBy: `${sceneData.vision.generatedBy}+${frame.provider}`,
      frameAt: frame.frameAt ?? sceneData.vision.frameAt,
      objects: {
        players: {
          ...sceneData.vision.objects.players,
          countEstimate: playerBoxes.length > 0 ? playerBoxes.length : sceneData.vision.objects.players.countEstimate,
          confidence: playerBoxes.length > 0 ? adjustedBoxConfidence(playerConfidence, detectorBacked) : sceneData.vision.objects.players.confidence,
          status: playerStatus,
          boxes: playerBoxes
        },
        ball: {
          ...sceneData.vision.objects.ball,
          present: ballBoxes.length > 0 || sceneData.vision.objects.ball.present,
          confidence: ballBoxes.length > 0 ? adjustedBoxConfidence(ballConfidence, detectorBacked) : sceneData.vision.objects.ball.confidence,
          status: ballStatus,
          boxes: ballBoxes
        }
      },
      proximity: frame.proximity,
      fieldZone: {
        zone: detectedZone.zone,
        confidence: detectedZone.confidence,
        method: detectedZone.method
      },
      fieldCalibration,
      eventCandidates: mergeEventCandidates(sceneData.vision.eventCandidates, frame, detectedZone.zone),
        limitations: [
          "Object boxes come from YOLO detector output.",
          "Player identity, team assignment, and calibrated pitch coordinates still require tracker/re-id/homography stages."
        ]
      };
    return {
      ...segment,
      sceneData: {
        ...sceneData,
        vision: nextVision
      }
    };
  });
}

function isDetectorBacked(frameProvider: string, resultProvider: string, resultAvailable: boolean, frameAvailable: boolean) {
  return resultAvailable && frameAvailable && (frameProvider.startsWith("ultralytics") || resultProvider.startsWith("ultralytics"));
}

function adjustedBoxConfidence(confidence: number, detectorBacked: boolean) {
  return detectorBacked ? confidence : Number(Math.min(0.42, confidence).toFixed(2));
}
