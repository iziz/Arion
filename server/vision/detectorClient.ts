import { spawn } from "node:child_process";
import path from "node:path";
import type { KeyframeRecord, TimelineSegment } from "../../shared/types";
import { getPublicMediaRoot } from "../localObjectStorage";
import { parsePythonJson } from "../modelRuntime/pythonProcess";
import { allowHeuristicDetectorFallback, detectorBackend, detectorConfidence, detectorModel, detectorScript, pythonBin, rfDetrModel } from "./runtimeConfig";
import type { DetectorResult } from "./types";

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
      const args = [
        detectorScript,
        "--backend",
        detectorBackend,
        "--model",
        detectorModel,
        "--rfdetr-model",
        rfDetrModel,
        "--conf",
        detectorConfidence
      ];
      if (allowHeuristicDetectorFallback) args.push("--allow-heuristic-fallback");
      const child = spawn(pythonBin, args, {
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
    return parsePythonJson<DetectorResult>(stdout);
  } catch (error) {
    return {
      available: false,
      provider: detectorBackend === "rfdetr" ? "rfdetr" : detectorBackend === "ultralytics" ? "ultralytics" : "vision-detector",
      model: detectorBackend === "rfdetr" ? rfDetrModel : detectorModel,
      frames: [],
      error: error instanceof Error ? error.message : "Vision detector failed"
    } satisfies DetectorResult;
  }
}
