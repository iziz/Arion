import { spawn } from "node:child_process";
import path from "node:path";
import type { KeyframeRecord, TimelineSegment, VisionBoundingBox, VisionEvidence } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";

const pythonBin = process.env.LOCAL_AI_PYTHON || process.env.PYTHON_BIN || path.resolve(".venv-ai", "bin", "python");
const detectorScript = path.resolve("scripts", "detect_objects.py");
const detectorModel = process.env.VISION_DETECTOR_MODEL || "yolo11n.pt";

type DetectorFrame = {
  segmentId: string;
  path: string;
  frameAt: number | null;
  width: number;
  height: number;
  provider: string;
  available: boolean;
  error: string | null;
  boxes: VisionBoundingBox[];
  proximity: NonNullable<VisionEvidence["proximity"]>;
};

type DetectorResult = {
  available: boolean;
  provider: string;
  model: string;
  warning?: string;
  error?: string;
  frames: DetectorFrame[];
};

export async function detectTimelineObjects(timeline: TimelineSegment[], keyframes: KeyframeRecord[]) {
  const mediaRoot = getPublicMediaRoot();
  const items = timeline
    .map((segment) => {
      const keyframe = keyframes.find((item) => item.segmentId === segment.id);
      const relativePath = keyframe?.path || segment.thumbnailPath || segment.sceneData?.image.thumbnailPath;
      if (!relativePath) return null;
      return {
        segmentId: segment.id,
        path: path.join(mediaRoot, relativePath),
        frameAt: keyframe?.at ?? segment.sceneData?.image.keyframeAt ?? Number(((segment.start + segment.end) / 2).toFixed(2))
      };
    })
    .filter((item): item is { segmentId: string; path: string; frameAt: number } => Boolean(item));

  if (items.length === 0) {
    return { available: false, provider: "none", model: detectorModel, frames: [], error: "No keyframes available for object detection" } satisfies DetectorResult;
  }

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(pythonBin, [detectorScript, "--model", detectorModel], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      const timeoutMs = Number(process.env.VISION_DETECTOR_TIMEOUT_MS || 0);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error(`Vision detector exceeded safety limit after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const output = Buffer.concat(stdoutChunks).toString("utf8");
        if (code === 0) resolve(output);
        else reject(new Error(Buffer.concat(stderrChunks).toString("utf8") || `Vision detector exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify({ images: items }));
    });
    return JSON.parse(stdout) as DetectorResult;
  } catch (error) {
    return {
      available: false,
      provider: "vision-detector",
      model: detectorModel,
      frames: [],
      error: error instanceof Error ? error.message : "Vision detector failed"
    } satisfies DetectorResult;
  }
}

export function applyVisionDetections(timeline: TimelineSegment[], result: DetectorResult): TimelineSegment[] {
  const frames = new Map(result.frames.map((frame) => [frame.segmentId, frame]));
  return timeline.map((segment) => {
    const frame = frames.get(segment.id);
    if (!frame) return segment;
    const sceneData = segment.sceneData;
    if (!sceneData?.vision) return segment;
    const playerBoxes = frame.boxes.filter((box) => box.label === "person").sort((a, b) => b.confidence - a.confidence).slice(0, 22);
    const ballBoxes = frame.boxes.filter((box) => box.label === "sports_ball").sort((a, b) => b.confidence - a.confidence).slice(0, 4);
    const detectedZone = estimateZoneFromDetections(playerBoxes, ballBoxes, sceneData.vision.fieldZone.zone);
    const playerConfidence = maxConfidence(playerBoxes);
    const ballConfidence = maxConfidence(ballBoxes);
    const nextVision: VisionEvidence = {
      ...sceneData.vision,
      generatedBy: `${sceneData.vision.generatedBy}+${frame.provider}`,
      frameAt: frame.frameAt ?? sceneData.vision.frameAt,
      objects: {
        players: {
          ...sceneData.vision.objects.players,
          countEstimate: playerBoxes.length > 0 ? playerBoxes.length : sceneData.vision.objects.players.countEstimate,
          confidence: playerBoxes.length > 0 ? playerConfidence : sceneData.vision.objects.players.confidence,
          status: playerBoxes.length > 0 ? "detected" : sceneData.vision.objects.players.status,
          boxes: playerBoxes
        },
        ball: {
          ...sceneData.vision.objects.ball,
          present: ballBoxes.length > 0 || sceneData.vision.objects.ball.present,
          confidence: ballBoxes.length > 0 ? ballConfidence : sceneData.vision.objects.ball.confidence,
          status: ballBoxes.length > 0 ? "detected" : sceneData.vision.objects.ball.status,
          boxes: ballBoxes
        }
      },
      proximity: frame.proximity,
      fieldZone: {
        zone: detectedZone.zone,
        confidence: detectedZone.confidence,
        method: detectedZone.method
      },
      eventCandidates: mergeEventCandidates(sceneData.vision.eventCandidates, frame, detectedZone.zone),
      limitations: [
        frame.provider.startsWith("ultralytics") ? "Object boxes come from YOLO detector output." : "Object boxes come from OpenCV fallback and may miss broadcast-scale players or balls.",
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

export function applyVisionTracking(timeline: TimelineSegment[]): TimelineSegment[] {
  let nextBallTrack = 1;
  let activeBallTrack: { id: string; center: Point; at: number; continuity: number } | null = null;
  let nextPlayerTrack = 1;
  let activePlayers: Array<{ id: string; center: Point; at: number }> = [];

  return timeline.map((segment) => {
    const vision = segment.sceneData?.vision;
    if (!vision) return segment;
    const frameAt = vision.frameAt ?? (segment.start + segment.end) / 2;
    const ball = primaryBox(vision.objects.ball.boxes ?? []);
    const players = (vision.objects.players.boxes ?? []).slice(0, 12);
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
    const trackedVision: VisionEvidence = {
      ...vision,
      proximity,
      tracking: {
        status: trackingStatus,
        ballTrackId,
        nearestPlayerTrackId: nearestPlayer?.id ?? null,
        continuity: Number((activeBallTrack?.continuity ?? 0).toFixed(2)),
        ballMovement
      },
      eventCandidates: mergeTrackingCandidates(vision.eventCandidates, trackingStatus, ballMovement, proximity, vision.fieldZone.zone),
      limitations: [
        ...vision.limitations.filter((item) => !item.includes("tracker/re-id")),
        "Tracking v0 links boxes by nearest centers only; player identity and team assignment are not stable IDs."
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

function estimateZoneFromDetections(
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
    method: "detector"
  };
}

function mergeEventCandidates(candidates: VisionEvidence["eventCandidates"], frame: DetectorFrame, zone: VisionEvidence["fieldZone"]["zone"]) {
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

function maxConfidence(boxes: VisionBoundingBox[]) {
  return Number(Math.max(0, ...boxes.map((box) => box.confidence)).toFixed(2));
}

type Point = { x: number; y: number };
type TrackedPlayerBox = { id: string; box: VisionBoundingBox; center: Point; distance?: number };

function primaryBox(boxes: VisionBoundingBox[]) {
  return [...boxes].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

function center(box: VisionBoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function distance(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function movementDirection(previous: Point, next: Point): NonNullable<VisionEvidence["tracking"]>["ballMovement"]["direction"] {
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  if (Math.abs(dx) < 0.025 && Math.abs(dy) < 0.025) return "stationary";
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return "vertical";
}

function assignPlayerTracks(
  players: VisionBoundingBox[],
  previous: Array<{ id: string; center: Point; at: number }>,
  nextTrack: number,
  frameAt: number
): { boxes: TrackedPlayerBox[]; active: Array<{ id: string; center: Point; at: number }>; nextTrack: number } {
  const used = new Set<string>();
  const boxes: TrackedPlayerBox[] = [];
  for (const box of players) {
    const boxCenter = center(box);
    const match = previous
      .filter((item) => !used.has(item.id))
      .map((item) => ({ ...item, distance: distance(boxCenter, item.center) }))
      .filter((item) => item.distance <= 0.18)
      .sort((a, b) => a.distance - b.distance)[0];
    const id = match?.id ?? `player-${nextTrack++}`;
    used.add(id);
    boxes.push({ id, box, center: boxCenter, distance: match?.distance });
  }
  return {
    boxes,
    active: boxes.map((item) => ({ id: item.id, center: item.center, at: frameAt })),
    nextTrack
  };
}

function nearestTrackedPlayer(ballCenter: Point, players: TrackedPlayerBox[]) {
  return players
    .map((item) => ({ ...item, distance: distance(ballCenter, item.center) }))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

function mergeTrackingCandidates(
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
        ? `Tracking v0 linked moving ball near player in ${zone}.`
        : `Tracking v0 linked moving ball trajectory in ${zone}.`
    });
  }
  return next.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}
