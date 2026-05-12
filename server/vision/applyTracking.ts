import type { TimelineSegment, VisionEvidence } from "../../shared/types";
import { estimateZoneFromDetections, inferTrackingFieldCalibration, mergeTrackingCandidates } from "./evidenceMerge";
import { assignPlayerTracks, averageTrackConfidence, center, distance, maxConfidence, movementDirection, nearestTrackedPlayer, primaryBox } from "./geometry";
import type { Point, TrackerResult } from "./types";

export function applyVisionTracking(timeline: TimelineSegment[]): TimelineSegment[] {
  let nextBallTrack = 1;
  let activeBallTrack: { id: string; center: Point; at: number; continuity: number } | null = null;
  let nextPlayerTrack = 1;
  let activePlayers: Array<{ id: string; center: Point; at: number }> = [];

  return timeline.map((segment) => {
    const vision = segment.sceneData?.vision;
    if (!vision) return segment;
    const frameAt = vision.frameAt ?? (segment.start + segment.end) / 2;
    const ball = primaryBox((vision.objects.ball.boxes ?? []).filter(isDetectorBackedBox));
    const players = (vision.objects.players.boxes ?? []).filter(isDetectorBackedBox).slice(0, 12);
    let ballTrackId: string | null = null;
    let ballMovement: NonNullable<VisionEvidence["tracking"]>["ballMovement"] = {
      fromPrevious: null,
      speedPerSecond: null,
      direction: "unknown"
    };

    if (ball) {
      const ballCenter = center(ball);
      const previousBallTrack = activeBallTrack;
      const distanceFromPrevious = previousBallTrack ? distance(ballCenter, previousBallTrack.center) : null;
      const sameTrack = Boolean(previousBallTrack && distanceFromPrevious !== null && distanceFromPrevious <= 0.28);
      ballTrackId = sameTrack && previousBallTrack ? previousBallTrack.id : `ball-${nextBallTrack++}`;
      const seconds = previousBallTrack ? Math.max(0.001, frameAt - previousBallTrack.at) : null;
      ballMovement = {
        fromPrevious: distanceFromPrevious === null ? null : Number(distanceFromPrevious.toFixed(4)),
        speedPerSecond: distanceFromPrevious === null || seconds === null ? null : Number((distanceFromPrevious / seconds).toFixed(4)),
        direction: previousBallTrack ? movementDirection(previousBallTrack.center, ballCenter) : "unknown"
      };
      activeBallTrack = {
        id: ballTrackId,
        center: ballCenter,
        at: frameAt,
        continuity: sameTrack && previousBallTrack ? Math.min(1, previousBallTrack.continuity + 0.12) : 0.25
      };
    }

    const trackedPlayers = assignPlayerTracks(players, activePlayers, nextPlayerTrack, frameAt);
    nextPlayerTrack = trackedPlayers.nextTrack;
    activePlayers = trackedPlayers.active;
    const nearestPlayer = ball ? nearestTrackedPlayer(center(ball), trackedPlayers.boxes) : null;
    const proximity = nearestPlayer
      ? {
          ballNearPlayer: nearestPlayer.distance <= 0.22,
          confidence: Number(Math.max(0, Math.min(0.82, 0.78 - nearestPlayer.distance)).toFixed(2)),
          normalizedDistance: Number(nearestPlayer.distance.toFixed(4))
        }
      : vision.proximity;
    const trackingStatus = ballTrackId || nearestPlayer ? "tracked" : vision.objects.ball.status === "detected" || vision.objects.players.status === "detected" ? "estimated" : "not_configured";
    const fieldCalibration = inferTrackingFieldCalibration(vision, ballMovement);
    const trackedVision: VisionEvidence = {
      ...vision,
      trust: trackingStatus === "tracked" ? "detected" : vision.trust,
      proximity,
      fieldCalibration,
      tracking: {
        status: trackingStatus,
        ballTrackId,
        nearestPlayerTrackId: nearestPlayer?.id ?? null,
        continuity: Number((activeBallTrack?.continuity ?? 0).toFixed(2)),
        version: "tracking_v0",
        ballMovement
      },
      eventCandidates: mergeTrackingCandidates(vision.eventCandidates, trackingStatus, ballMovement, proximity, vision.fieldZone.zone),
      limitations: [
        ...vision.limitations.filter((item) => !item.includes("tracker/re-id")),
        "Tracking v0 links boxes by nearest centers only; player identity and team-kit clustering are not stable IDs."
      ]
    };

    return {
      ...segment,
      sceneData: {
        ...segment.sceneData!,
        vision: trackedVision
      }
    };
  });
}

function isDetectorBackedBox(box: { source: string }) {
  return box.source.startsWith("ultralytics") || box.source.startsWith("rfdetr");
}

export function applyVisionTracks(timeline: TimelineSegment[], result: TrackerResult): TimelineSegment[] {
  if (!result.available || result.segments.length === 0) return timeline;
  const segments = new Map(result.segments.map((segment) => [segment.segmentId, segment]));
  return timeline.map((segment) => {
    const summary = segments.get(segment.id);
    const vision = segment.sceneData?.vision;
    if (!summary || !vision) return segment;

    const playerBoxes = summary.boxes.filter((box) => box.label === "person").sort((a, b) => b.confidence - a.confidence).slice(0, 22);
    const ballBoxes = summary.boxes.filter((box) => box.label === "sports_ball").sort((a, b) => b.confidence - a.confidence).slice(0, 4);
    const detectedZone = estimateZoneFromDetections(playerBoxes, ballBoxes, vision.fieldZone.zone);
    const trackerCalibration = summary.fieldCalibration?.status === "calibrated" ? summary.fieldCalibration : null;
    const fieldCalibration = trackerCalibration ?? inferTrackingFieldCalibration(
      {
        ...vision,
        fieldZone: {
          zone: detectedZone.zone,
          confidence: Math.max(vision.fieldZone.confidence, detectedZone.confidence),
          method: detectedZone.method
        }
      },
      summary.ballMovement
    );
    const fieldZone = trackerCalibration
      ? { zone: trackerCalibration.zone, confidence: trackerCalibration.zoneConfidence, method: "homography" as const }
      : { zone: detectedZone.zone, confidence: Math.max(vision.fieldZone.confidence, detectedZone.confidence), method: detectedZone.method };
    const nextVision: VisionEvidence = {
      ...vision,
      trust: "detected",
      generatedBy: `${vision.generatedBy}+${summary.provider}:${summary.tracker}`,
      objects: {
        players: {
          ...vision.objects.players,
          countEstimate: playerBoxes.length > 0 ? playerBoxes.length : Math.max(vision.objects.players.countEstimate, summary.playerTracks.length),
          confidence: playerBoxes.length > 0 ? maxConfidence(playerBoxes) : Math.max(vision.objects.players.confidence, averageTrackConfidence(summary.playerTracks)),
          status: playerBoxes.length > 0 || summary.playerTracks.length > 0 ? "detected" : vision.objects.players.status,
          boxes: playerBoxes.length > 0 ? playerBoxes : vision.objects.players.boxes
        },
        ball: {
          ...vision.objects.ball,
          present: ballBoxes.length > 0 || Boolean(summary.ballTrackId) || vision.objects.ball.present,
          confidence: ballBoxes.length > 0 ? maxConfidence(ballBoxes) : Math.max(vision.objects.ball.confidence, averageTrackConfidence(summary.ballTracks)),
          status: ballBoxes.length > 0 || summary.ballTrackId ? "detected" : vision.objects.ball.status,
          boxes: ballBoxes.length > 0 ? ballBoxes : vision.objects.ball.boxes
        }
      },
      proximity: summary.proximity,
      fieldZone,
      fieldCalibration,
      tracking: {
        status: summary.trackedFrameCount > 0 ? "tracked" : vision.tracking?.status ?? "estimated",
        ballTrackId: summary.ballTrackId,
        nearestPlayerTrackId: summary.nearestPlayerTrackId,
        continuity: Number(Math.max(vision.tracking?.continuity ?? 0, summary.trackCoverage).toFixed(2)),
        version: "tracking_v2",
        provider: summary.provider,
        model: summary.model,
        tracker: summary.tracker,
        frameCount: summary.frameCount,
        trackedFrameCount: summary.trackedFrameCount,
        trackCoverage: summary.trackCoverage,
        idSwitches: summary.idSwitches,
        playerTracks: summary.playerTracks,
        ballTracks: summary.ballTracks,
        ballMovement: summary.ballMovement
      },
      eventCandidates: mergeTrackingCandidates(vision.eventCandidates, "tracked", summary.ballMovement, summary.proximity, detectedZone.zone),
      limitations: [
        ...vision.limitations.filter((item) => !item.includes("Tracking v0") && !item.includes("tracker/re-id")),
        `Tracking v2 uses ${summary.provider} with ${summary.tracker}; IDs are aggregated from sampled video frames.`,
        "Team clusters are kit-color heuristics from tracked upper-body crops; they are not mapped to home/away without roster, scoreboard, or manual evidence.",
        "Crop-based jersey OCR is candidate-level evidence only; identity still requires match context, roster, and track agreement."
      ]
    };

    return {
      ...segment,
      sceneData: {
        ...segment.sceneData!,
        vision: nextVision
      }
    };
  });
}
