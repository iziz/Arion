import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { callPythonRuntimeService, isPythonRuntimeServiceMode } from "./modelRuntime/pythonRuntimeService";
import { logJson } from "./observability";

const execFileAsync = promisify(execFile);
const pythonBin = process.env.LOCAL_AI_PYTHON || process.env.PYTHON_BIN || path.resolve(".venv-ai", "bin", "python");
const sceneScript = path.resolve("scripts", "detect_scenes.py");

export type SceneBoundary = {
  at: number;
  score: number | null;
  source?: "pyscenedetect" | "ffmpeg";
  detector?: string;
};

export type ShotWindow = {
  start: number;
  end: number;
  boundaryScore: number | null;
  boundarySource: SceneBoundary["source"] | null;
  boundaryDetector: string | null;
};

export async function detectSceneBoundaries(filePath: string, duration: number | null): Promise<SceneBoundary[]> {
  const pySceneDetect = await detectSceneBoundariesWithPySceneDetect(filePath, duration);
  if (pySceneDetect.length > 0) return pySceneDetect;
  return detectSceneBoundariesWithFfmpeg(filePath, duration);
}

async function detectSceneBoundariesWithPySceneDetect(filePath: string, duration: number | null): Promise<SceneBoundary[]> {
  try {
    const parsed = isPythonRuntimeServiceMode("vision")
      ? await callPythonRuntimeService<{
          available?: boolean;
          detector?: string;
          boundaries?: Array<{ at?: unknown; score?: unknown; source?: unknown; detector?: unknown }>;
        }>(
          "vision",
          "/v1/detect-scenes",
          {
            mediaPath: filePath,
            detector: process.env.SCENE_DETECTOR || "adaptive",
            threshold: process.env.SCENE_CONTENT_THRESHOLD || "27.0",
            adaptiveThreshold: process.env.SCENE_ADAPTIVE_THRESHOLD || "3.0",
            minSceneLen: process.env.SCENE_MIN_LEN_FRAMES || "15",
            timeoutMs: Number(process.env.SCENE_TIMEOUT_MS || 0) || undefined
          },
          {
            timeoutMs: Number(process.env.SCENE_TIMEOUT_MS || 0) || undefined,
            metricKey: "model.vision.scene_detection.service"
          }
        )
      : await detectSceneBoundariesWithPySceneDetectDirect(filePath);
    if (!parsed.available || !Array.isArray(parsed.boundaries)) {
      logJson("warn", "scene_detection.pyscenedetect.unavailable", "PySceneDetect returned no usable scene boundaries", {
        filePath,
        detector: parsed.detector ?? process.env.SCENE_DETECTOR ?? "adaptive",
        available: parsed.available ?? null
      });
      return [];
    }
    return normalizeBoundaries(
      parsed.boundaries.map((boundary) => ({
        at: Number(boundary.at),
        score: typeof boundary.score === "number" ? boundary.score : null,
        source: "pyscenedetect",
        detector: typeof boundary.detector === "string" ? boundary.detector : parsed.detector || "adaptive"
      })),
      duration
    );
  } catch (error) {
    logJson("warn", "scene_detection.pyscenedetect.failed", "PySceneDetect scene boundary detection failed", {
      filePath,
      detector: process.env.SCENE_DETECTOR || "adaptive",
      error: error instanceof Error ? error.message : "Unknown PySceneDetect failure"
    });
    return [];
  }
}

async function detectSceneBoundariesWithPySceneDetectDirect(filePath: string) {
  const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        pythonBin,
        [
          sceneScript,
          filePath,
          "--detector",
          process.env.SCENE_DETECTOR || "adaptive",
          "--threshold",
          process.env.SCENE_CONTENT_THRESHOLD || "27.0",
          "--adaptive-threshold",
          process.env.SCENE_ADAPTIVE_THRESHOLD || "3.0",
          "--min-scene-len",
          process.env.SCENE_MIN_LEN_FRAMES || "15"
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const timeoutMs = Number(process.env.SCENE_TIMEOUT_MS || 0);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error(`PySceneDetect exceeded safety limit after ${timeoutMs}ms`));
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
        else reject(new Error(Buffer.concat(stderrChunks).toString("utf8") || `PySceneDetect exited with code ${code}`));
      });
    });
  return JSON.parse(stdout) as {
    available?: boolean;
    detector?: string;
    boundaries?: Array<{ at?: unknown; score?: unknown; source?: unknown; detector?: unknown }>;
  };
}

async function detectSceneBoundariesWithFfmpeg(filePath: string, duration: number | null): Promise<SceneBoundary[]> {
  const threshold = process.env.SCENE_THRESHOLD || "0.3";
  try {
    const timeoutMs = Number(process.env.SCENE_TIMEOUT_MS || 0);
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-i", filePath, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"],
      {
        maxBuffer: 1024 * 1024 * 8,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {})
      }
    );
    return normalizeBoundaries(parseShowInfo(stderr), duration);
  } catch (error) {
    logJson("warn", "scene_detection.ffmpeg.failed", "FFmpeg scene boundary detection failed", {
      filePath,
      threshold,
      error: error instanceof Error ? error.message : "Unknown FFmpeg scene detection failure"
    });
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
      const boundary = boundaries.find((item) => Math.abs(item.at - start) < 0.12);
      return {
        start,
        end,
        boundaryScore: boundary?.score ?? null,
        boundarySource: boundary?.source ?? null,
        boundaryDetector: boundary?.detector ?? null
      };
    })
    .filter((window) => window.end - window.start >= 0.75)
    .slice(0, 80);
}

function parseShowInfo(stderr: string): SceneBoundary[] {
  const matches = [...stderr.matchAll(/pts_time:([0-9.]+)/g)];
  return matches.map((match) => ({
    at: Number(match[1]),
    score: null,
    source: "ffmpeg",
    detector: "scene"
  }));
}

function normalizeBoundaries(boundaries: SceneBoundary[], duration: number | null) {
  const safeDuration = duration ?? Number.POSITIVE_INFINITY;
  const unique = new Map<string, SceneBoundary>();
  for (const boundary of boundaries) {
    if (!Number.isFinite(boundary.at) || boundary.at <= 0.2 || boundary.at >= safeDuration - 0.2) continue;
    unique.set(boundary.at.toFixed(2), {
      at: Number(boundary.at.toFixed(2)),
      score: boundary.score,
      source: boundary.source,
      detector: boundary.detector
    });
  }
  return [...unique.values()].sort((a, b) => a.at - b.at);
}
