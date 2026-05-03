import type { VisionBoundingBox, VisionEvidence } from "../../shared/types";
import type { DetectorFrame } from "./types";

export function inferTrackingFieldCalibration(
  vision: VisionEvidence,
  movement: NonNullable<VisionEvidence["tracking"]>["ballMovement"]
): NonNullable<VisionEvidence["fieldCalibration"]> | undefined {
  const base = vision.fieldCalibration;
  if (!base) return undefined;
  const direction = movement.direction === "right" ? "left_to_right" : movement.direction === "left" ? "right_to_left" : base.attackingDirection;
  const directionConfidence =
    movement.direction === "right" || movement.direction === "left"
      ? Number(Math.min(0.56, 0.26 + Math.min(0.3, (movement.speedPerSecond ?? 0) * 1.8)).toFixed(2))
      : base.attackingDirectionConfidence;
  return {
    ...base,
    attackingDirection: direction,
    attackingDirectionConfidence: direction === "unknown" ? 0 : directionConfidence,
    evidence: [
      ...base.evidence,
      direction !== "unknown" ? `Attacking direction estimated from ball movement: ${direction}.` : "Attacking direction unavailable from ball movement."
    ].slice(0, 6),
    limitations: Array.from(new Set([...base.limitations, "Direction v1 uses short-window ball movement, not team possession."]))
  };
}

export function estimateZoneFromDetections(
  players: VisionBoundingBox[],
  balls: VisionBoundingBox[],
  fallback: VisionEvidence["fieldZone"]["zone"]
): Pick<VisionEvidence["fieldZone"], "zone" | "confidence" | "method"> {
  const target = balls[0] ?? players.sort((a, b) => b.confidence - a.confidence)[0];
  if (!target) {
    return { zone: fallback, confidence: fallback === "unknown" ? 0 : 0.38, method: fallback === "unknown" ? "none" : "color_motion_heuristic" };
  }
  const centerX = target.x + target.width / 2;
  const zone = centerX >= 0.64 ? "final_third" : centerX <= 0.36 ? "defensive_third" : "middle_third";
  return {
    zone,
    confidence: Number(Math.min(0.68, 0.42 + target.confidence * 0.32).toFixed(2)),
    method: "detector_x_position"
  };
}

export function buildDetectedFieldCalibration(
  detectedZone: Pick<VisionEvidence["fieldZone"], "zone" | "confidence" | "method">,
  frame: DetectorFrame,
  previous: VisionEvidence
): NonNullable<VisionEvidence["fieldCalibration"]> {
  const hasDetection = detectedZone.method === "detector_x_position";
  const ball = frame.boxes.find((box) => box.label === "sports_ball");
  const playerCount = frame.boxes.filter((box) => box.label === "person").length;
  const status = hasDetection ? "estimated" : detectedZone.zone === "unknown" ? "not_configured" : "estimated";
  return {
    status,
    method: hasDetection ? "detector_x_position" : detectedZone.method === "color_motion_heuristic" ? "color_motion_heuristic" : "none",
    zone: detectedZone.zone,
    zoneConfidence: detectedZone.confidence,
    attackingDirection: previous.fieldCalibration?.attackingDirection ?? "unknown",
    attackingDirectionConfidence: previous.fieldCalibration?.attackingDirectionConfidence ?? 0,
    evidence: [
      hasDetection ? `Zone estimated from normalized detector x-position using ${ball ? "ball" : "top player"} candidate.` : "No detector candidate was available for zone estimation.",
      `${playerCount} player boxes detected.`,
      ball ? `Ball box confidence ${Math.round(ball.confidence * 100)}%.` : "No ball box detected."
    ],
    limitations: [
      "Detector x-position is not pitch homography.",
      "Broadcast camera direction and attacking direction are not calibrated."
    ]
  };
}

export function mergeEventCandidates(candidates: VisionEvidence["eventCandidates"], frame: DetectorFrame, zone: VisionEvidence["fieldZone"]["zone"]) {
  const next = [...candidates];
  const hasPlayers = frame.boxes.some((box) => box.label === "person");
  const hasBall = frame.boxes.some((box) => box.label === "sports_ball");
  if (hasPlayers && hasBall) {
    next.push({
      type: "pass_receive",
      confidence: Number(Math.min(0.78, 0.46 + (frame.proximity?.confidence ?? 0) * 0.32).toFixed(2)),
      reason: frame.proximity?.ballNearPlayer
        ? `Detector found ball near player in ${zone}.`
        : `Detector found player and ball candidates in ${zone}.`
    });
  }
  return next.sort((a, b) => b.confidence - a.confidence).slice(0, 4);
}

export function mergeTrackingCandidates(
  candidates: VisionEvidence["eventCandidates"],
  trackingStatus: NonNullable<VisionEvidence["tracking"]>["status"],
  movement: NonNullable<VisionEvidence["tracking"]>["ballMovement"],
  proximity: VisionEvidence["proximity"],
  zone: VisionEvidence["fieldZone"]["zone"]
) {
  const next = [...candidates];
  if (trackingStatus === "tracked" && movement.speedPerSecond !== null && movement.speedPerSecond >= 0.02) {
    next.push({
      type: proximity?.ballNearPlayer ? "pass_receive" : "carry",
      confidence: Number(Math.min(0.82, 0.45 + Math.min(0.2, movement.speedPerSecond * 1.8) + (proximity?.confidence ?? 0) * 0.18).toFixed(2)),
      reason: proximity?.ballNearPlayer
        ? `Tracking linked moving ball near player in ${zone}.`
        : `Tracking linked moving ball trajectory in ${zone}.`
    });
  }
  return next.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}
