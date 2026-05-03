import type { VisionBoundingBox, VisionEvidence } from "../../shared/types";
import type { Point, TrackedPlayerBox, TrackSummary } from "./types";

export function maxConfidence(boxes: VisionBoundingBox[]) {
  return Number(Math.max(0, ...boxes.map((box) => box.confidence)).toFixed(2));
}

export function averageTrackConfidence(tracks: TrackSummary[]) {
  if (tracks.length === 0) return 0;
  return Number((tracks.reduce((sum, track) => sum + track.confidence, 0) / tracks.length).toFixed(2));
}

export function primaryBox(boxes: VisionBoundingBox[]) {
  return [...boxes].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

export function center(box: VisionBoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function distance(a: Point, b: Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function movementDirection(previous: Point, next: Point): NonNullable<VisionEvidence["tracking"]>["ballMovement"]["direction"] {
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  if (Math.abs(dx) < 0.025 && Math.abs(dy) < 0.025) return "stationary";
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return "vertical";
}

export function assignPlayerTracks(
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

export function nearestTrackedPlayer(ballCenter: Point, players: TrackedPlayerBox[]) {
  return players
    .map((item) => ({ ...item, distance: distance(ballCenter, item.center) }))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
}
