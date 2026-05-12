import { spawn } from "node:child_process";
import type { TimelineSegment } from "../../shared/types";
import { parsePythonJson } from "../modelRuntime/pythonProcess";
import { callPythonRuntimeService, isPythonRuntimeServiceMode } from "../modelRuntime/pythonRuntimeService";
import { detectorModel, pythonBin, trackerName, trackerScript } from "./runtimeConfig";
import type { TrackerResult } from "./types";

export async function detectTimelineTracks(filePath: string, timeline: TimelineSegment[]) {
  const items = timeline.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end
  }));
  if (items.length === 0) {
    return {
      available: false,
      provider: "none",
      model: detectorModel,
      tracker: trackerName,
      segments: [],
      error: "No timeline segments available for tracking"
    } satisfies TrackerResult;
  }

  try {
    if (isPythonRuntimeServiceMode("vision")) {
      return await callPythonRuntimeService<TrackerResult>(
        "vision",
        "/v1/track-objects",
        {
          mediaPath: filePath,
          segments: items,
          model: detectorModel,
          tracker: trackerName,
          confidence: process.env.VISION_TRACKER_CONF || "0.2",
          vidStride: process.env.VISION_TRACKER_VID_STRIDE || "3",
          jerseyOcr: process.env.JERSEY_OCR_ENABLED || "1",
          jerseyOcrLang: process.env.JERSEY_OCR_LANG || "en",
          jerseyOcrMinConfidence: process.env.JERSEY_OCR_MIN_CONFIDENCE || "0.6",
          jerseyOcrMaxSamplesPerTrack: process.env.JERSEY_OCR_MAX_SAMPLES_PER_TRACK || "3",
          jerseyOcrMaxTotalSamples: process.env.JERSEY_OCR_MAX_TOTAL_SAMPLES || "48",
          jerseyOcrMinBoxHeight: process.env.JERSEY_OCR_MIN_BOX_HEIGHT || "0.12"
        },
        {
          metricKey: "model.vision.tracker.service"
        }
      );
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        pythonBin,
        [
          trackerScript,
          filePath,
          "--model",
          detectorModel,
          "--tracker",
          trackerName,
          "--conf",
          process.env.VISION_TRACKER_CONF || "0.2",
          "--vid-stride",
          process.env.VISION_TRACKER_VID_STRIDE || "3",
          "--jersey-ocr",
          process.env.JERSEY_OCR_ENABLED || "1",
          "--jersey-ocr-lang",
          process.env.JERSEY_OCR_LANG || "en",
          "--jersey-ocr-min-confidence",
          process.env.JERSEY_OCR_MIN_CONFIDENCE || "0.6",
          "--jersey-ocr-max-samples-per-track",
          process.env.JERSEY_OCR_MAX_SAMPLES_PER_TRACK || "3",
          "--jersey-ocr-max-total-samples",
          process.env.JERSEY_OCR_MAX_TOTAL_SAMPLES || "48",
          "--jersey-ocr-min-box-height",
          process.env.JERSEY_OCR_MIN_BOX_HEIGHT || "0.12"
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (code) => {
        const output = Buffer.concat(stdoutChunks).toString("utf8");
        if (code === 0) resolve(output);
        else reject(new Error(Buffer.concat(stderrChunks).toString("utf8") || `Vision tracker exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify({ segments: items }));
    });
    return parsePythonJson<TrackerResult>(stdout);
  } catch (error) {
    return {
      available: false,
      provider: "ultralytics-track",
      model: detectorModel,
      tracker: trackerName,
      segments: [],
      error: error instanceof Error ? error.message : "Vision tracker failed"
    } satisfies TrackerResult;
  }
}
