import type { AssetRecord } from "../../../shared/types";
import type { ShotWindow } from "../../sceneDetection";
import type { TimelineBasis } from "./types";

export function fuseTimelineBasis(
  asset: AssetRecord,
  whisperSegments: Array<{ start: number; end: number; text: string }>,
  shotWindows: ShotWindow[],
  duration: number
): TimelineBasis[] {
  const safeDuration = Math.max(duration, 1);
  if (shotWindows.length === 0 && whisperSegments.length === 0) return [];
  if (shotWindows.length === 0) {
    return whisperSegments.map((segment, index) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      shotIndex: index + 1,
      boundaryScore: null,
      boundarySource: null,
      boundaryDetector: null
    }));
  }

  const minWindow = Number(process.env.TIMELINE_MIN_WINDOW_SECONDS || 1.2);
  const maxWindow = Number(process.env.TIMELINE_MAX_WINDOW_SECONDS || 22);
  const maxSegments = Number(process.env.TIMELINE_MAX_SEGMENTS || 120);
  const points = sortedUniquePoints([
    0,
    safeDuration,
    ...shotWindows.flatMap((window) => [window.start, window.end]),
    ...whisperSegments.flatMap((segment) => [segment.start, segment.end])
  ], safeDuration);
  const windows = mergeShortWindows(
    points
      .slice(0, -1)
      .map((start, index) => ({ start, end: points[index + 1] }))
      .filter((window) => window.end - window.start >= 0.35),
    minWindow
  );
  const splitWindows = windows.flatMap((window) => splitLongWindow(window, maxWindow)).slice(0, maxSegments);
  return splitWindows.map((window, index) => {
    const shot = bestOverlappingShotWindow(shotWindows, window.start, window.end);
    return {
      start: Number(window.start.toFixed(2)),
      end: Number(window.end.toFixed(2)),
      text: overlappingWhisperText(asset, window.start, window.end),
      shotIndex: index + 1,
      boundaryScore: shot?.boundaryScore ?? null,
      boundarySource: shot?.boundarySource ?? null,
      boundaryDetector: shot?.boundaryDetector ?? null
    };
  });
}

export function normalizeWhisperTimeline(asset: AssetRecord) {
  const duration = asset.duration ?? Number.POSITIVE_INFINITY;
  return asset.intelligence.asr.segments
    .map((segment) => ({
      start: Math.max(0, Number(segment.start || 0)),
      end: Math.min(duration, Math.max(Number(segment.end || 0), Number(segment.start || 0) + 1)),
      text: segment.text.trim()
    }))
    .filter((segment) => segment.text.length > 0)
    .slice(0, 80);
}

export function overlappingWhisperText(asset: AssetRecord, start: number, end: number) {
  return asset.intelligence.asr.segments
    .filter((segment) => segment.end > start && segment.start < end)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function sortedUniquePoints(points: number[], duration: number) {
  const safeDuration = Math.max(duration, 1);
  const minGap = Number(process.env.TIMELINE_BOUNDARY_MIN_GAP_SECONDS || 0.75);
  const sorted = Array.from(
    new Set(points.filter((point) => Number.isFinite(point)).map((point) => Number(Math.max(0, Math.min(point, safeDuration)).toFixed(2))))
  ).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const point of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || point === 0 || point === safeDuration || point - previous >= minGap) {
      merged.push(point);
    } else if (safeDuration - point < minGap) {
      merged[merged.length - 1] = safeDuration;
    }
  }
  if (merged[0] !== 0) merged.unshift(0);
  if (merged.at(-1) !== safeDuration) merged.push(safeDuration);
  return Array.from(new Set(merged)).sort((a, b) => a - b);
}

function mergeShortWindows(windows: Array<{ start: number; end: number }>, minWindow: number) {
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.end - window.start < minWindow) {
      previous.end = window.end;
    } else {
      merged.push({ ...window });
    }
  }
  return merged.filter((window) => window.end - window.start >= 0.5);
}

function splitLongWindow(window: { start: number; end: number }, maxWindow: number) {
  const length = window.end - window.start;
  if (length <= maxWindow) return [window];
  const count = Math.ceil(length / maxWindow);
  const size = length / count;
  return Array.from({ length: count }, (_item, index) => ({
    start: window.start + size * index,
    end: index === count - 1 ? window.end : window.start + size * (index + 1)
  }));
}

function bestOverlappingShotWindow(shotWindows: ShotWindow[], start: number, end: number) {
  return shotWindows
    .map((shot) => ({ shot, overlap: Math.max(0, Math.min(end, shot.end) - Math.max(start, shot.start)) }))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)[0]?.shot ?? null;
}
