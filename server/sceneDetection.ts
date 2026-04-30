import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SceneBoundary = {
  at: number;
  score: number | null;
};

export async function detectSceneBoundaries(filePath: string, duration: number | null): Promise<SceneBoundary[]> {
  const threshold = process.env.SCENE_THRESHOLD || "0.3";
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-i", filePath, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"],
      {
        maxBuffer: 1024 * 1024 * 8,
        timeout: Number(process.env.SCENE_TIMEOUT_MS || 90000)
      }
    );
    return normalizeBoundaries(parseShowInfo(stderr), duration);
  } catch {
    return [];
  }
}

export function createShotWindows(boundaries: SceneBoundary[], duration: number | null) {
  const safeDuration = Math.max(0, duration ?? 0);
  if (safeDuration <= 0) return [];
  const points = [0, ...boundaries.map((boundary) => boundary.at).filter((at) => at > 0.2 && at < safeDuration - 0.2), safeDuration];
  const uniquePoints = Array.from(new Set(points.map((point) => Number(point.toFixed(2))))).sort((a, b) => a - b);
  return uniquePoints
    .slice(0, -1)
    .map((start, index) => {
      const end = uniquePoints[index + 1];
      return {
        start,
        end,
        boundaryScore: boundaries.find((boundary) => Math.abs(boundary.at - start) < 0.12)?.score ?? null
      };
    })
    .filter((window) => window.end - window.start >= 0.75)
    .slice(0, 80);
}

function parseShowInfo(stderr: string): SceneBoundary[] {
  const matches = [...stderr.matchAll(/pts_time:([0-9.]+)/g)];
  return matches.map((match) => ({
    at: Number(match[1]),
    score: null
  }));
}

function normalizeBoundaries(boundaries: SceneBoundary[], duration: number | null) {
  const safeDuration = duration ?? Number.POSITIVE_INFINITY;
  const unique = new Map<string, SceneBoundary>();
  for (const boundary of boundaries) {
    if (!Number.isFinite(boundary.at) || boundary.at <= 0.2 || boundary.at >= safeDuration - 0.2) continue;
    unique.set(boundary.at.toFixed(2), {
      at: Number(boundary.at.toFixed(2)),
      score: boundary.score
    });
  }
  return [...unique.values()].sort((a, b) => a.at - b.at);
}
