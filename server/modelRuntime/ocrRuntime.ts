import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OcrBox, OcrFrameResult } from "../../shared/types";
import { getPublicMediaRoot } from "../localObjectStorage";
import { parsePythonJson, runPythonScriptOnExit } from "./pythonProcess";
import { createPythonProgressReporter, reportPythonProgressEvent } from "./pythonProgress";
import { callPythonRuntimeService, isPythonRuntimeServiceMode } from "./pythonRuntimeService";
import type { RuntimeStageReporter } from "./stageReporter";
import { toPublicMediaPath } from "./mediaPath";

const execFileAsync = promisify(execFile);
const paddleOcrScript = path.resolve("scripts", "paddle_ocr_extract.py");

type PaddleResult = {
  available: boolean;
  provider: string;
  language?: string;
  tokens: string[];
  confidence: number;
  frames: OcrFrameResult[];
  frameResults?: OcrFrameResult[];
  error?: string;
};

export async function runPaddleOcr(
  filePath: string,
  assetId: string,
  languages: string[],
  duration: number | null,
  reportStage?: RuntimeStageReporter
): Promise<PaddleResult> {
  const mediaRoot = getPublicMediaRoot();
  const relativeDir = path.join("generated", "assets", assetId, "ocr-frames");
  const framesDir = path.join(mediaRoot, relativeDir);
  const fullFrameMaxFrames = Number(process.env.PADDLEOCR_FULL_MAX_FRAMES || process.env.PADDLEOCR_MAX_FRAMES || 24);
  const fullFrameIntervalSeconds = getOcrSampleInterval(duration, fullFrameMaxFrames);
  const subtitleIntervalSeconds = Number(process.env.PADDLEOCR_SUBTITLE_INTERVAL_SECONDS || 0.5);
  const subtitleMaxFrames = Number(process.env.PADDLEOCR_SUBTITLE_MAX_FRAMES || 1800);
  const frameScaleWidth = Number(process.env.PADDLEOCR_FRAME_WIDTH || 960);
  const workers = positiveInteger(process.env.PADDLEOCR_WORKERS, 2);
  try {
    await mkdir(framesDir, { recursive: true });
    await clearGeneratedFrames(framesDir);
    await reportStage?.({ stage: "ocr", status: "running", message: "Extracting subtitle OCR snapshots", progress: 3, log: false });
    await extractOcrFrames(filePath, framesDir, "subtitle-bottom-frame-%05d.png", `fps=1/${subtitleIntervalSeconds},crop=iw:ih*0.28:0:ih*0.70,scale=${frameScaleWidth}:-2`, subtitleMaxFrames);
    await reportStage?.({ stage: "ocr", status: "running", message: "Extracting top overlay OCR snapshots", progress: 6, log: false });
    await extractOcrFrames(filePath, framesDir, "subtitle-top-frame-%05d.png", `fps=1/${subtitleIntervalSeconds},crop=iw:ih*0.22:0:0,scale=${frameScaleWidth}:-2`, subtitleMaxFrames);
    await reportStage?.({ stage: "ocr", status: "running", message: "Extracting full-frame OCR snapshots", progress: 9, log: false });
    await extractOcrFrames(filePath, framesDir, "full-frame-%04d.png", `fps=1/${fullFrameIntervalSeconds},scale=${frameScaleWidth}:-2`, fullFrameMaxFrames);
    const frameCount = await countOcrFrames(framesDir);
    await reportStage?.({
      stage: "ocr",
      status: "running",
      message: `Prepared ${frameCount} OCR snapshots for ${languages.join(", ")}`,
      progress: 12,
      log: false
    });
    const results = await mapWithConcurrency(
      languages,
      getLanguageConcurrency(languages.length),
      (language) => runPaddleOcrLanguage(framesDir, language, mediaRoot, subtitleIntervalSeconds, fullFrameIntervalSeconds, workers, reportStage)
    );
    const available = results.filter((result) => result.available);
    if (available.length === 0) return results[0] ?? unavailablePaddleResult("PaddleOCR returned no result");
    return available.sort((a, b) => scoreOcrResult(b) - scoreOcrResult(a))[0];
  } catch (error) {
    return {
      available: false,
      provider: "none",
      tokens: [],
      confidence: 0,
      frames: [],
      error: error instanceof Error ? error.message : "PaddleOCR execution failed"
    };
  }
}

async function extractOcrFrames(filePath: string, framesDir: string, filenamePattern: string, videoFilter: string, maxFrames: number) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      filePath,
      "-vf",
      videoFilter,
      "-frames:v",
      String(maxFrames),
      path.join(framesDir, filenamePattern)
    ],
    {}
  );
}

async function clearGeneratedFrames(framesDir: string) {
  const entries = await readdir(framesDir).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => /^(?:frame|full-frame|subtitle-(?:top|bottom)-frame)-\d+\.(png|jpe?g|webp)$/i.test(entry))
      .map((entry) => rm(path.join(framesDir, entry), { force: true }))
  );
}

async function countOcrFrames(framesDir: string) {
  const entries = await readdir(framesDir).catch(() => []);
  return entries.filter((entry) => /^(?:frame|full-frame|subtitle-(?:top|bottom)-frame)-\d+\.(png|jpe?g|webp)$/i.test(entry)).length;
}

function getOcrSampleInterval(duration: number | null, maxFrames: number) {
  const configured = Number(process.env.PADDLEOCR_SAMPLE_INTERVAL_SECONDS || 0);
  const mediaDuration = duration ?? 0;
  const adaptive = mediaDuration > 0 && maxFrames > 0 ? Math.ceil(mediaDuration / maxFrames) : 15;
  return Math.max(10, configured || adaptive);
}

async function runPaddleOcrLanguage(
  framesDir: string,
  language: string,
  mediaRoot: string,
  subtitleIntervalSeconds: number,
  fullFrameIntervalSeconds: number,
  workers: number,
  reportStage?: RuntimeStageReporter
): Promise<PaddleResult> {
  const progressReporter = createPythonProgressReporter("ocr", reportStage);
  try {
    const parsed = isPythonRuntimeServiceMode("ocr")
      ? await callPythonRuntimeService<PaddleResult>(
          "ocr",
          "/v1/paddleocr",
          {
            framesDir,
            language,
            subtitleIntervalSeconds,
            fullIntervalSeconds: fullFrameIntervalSeconds,
            workers
          },
          {
            metricKey: "model.ocr.paddle.service",
            onProgress: (event) => reportPythonProgressEvent("ocr", reportStage, event)
          }
        )
      : await runPaddleOcrLanguageDirect(framesDir, language, subtitleIntervalSeconds, fullFrameIntervalSeconds, workers, progressReporter);
    return {
      available: Boolean(parsed.available),
      provider: parsed.provider || "paddleocr",
      language,
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      confidence: parsed.confidence ?? 0,
      frames: normalizeOcrFrames(parsed.frameResults, mediaRoot, subtitleIntervalSeconds),
      error: parsed.error
    };
  } catch (error) {
    await progressReporter.flush();
    return unavailablePaddleResult(error instanceof Error ? error.message : "PaddleOCR execution failed", language);
  }
}

async function runPaddleOcrLanguageDirect(
  framesDir: string,
  language: string,
  subtitleIntervalSeconds: number,
  fullFrameIntervalSeconds: number,
  workers: number,
  progressReporter: ReturnType<typeof createPythonProgressReporter>
) {
  const { stdout } = await runPythonScriptOnExit(
    [
      paddleOcrScript,
      framesDir,
      "--lang",
      language,
      "--subtitle-interval",
      String(subtitleIntervalSeconds),
      "--full-interval",
      String(fullFrameIntervalSeconds),
      "--workers",
      String(workers)
    ],
    {
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK || "True" },
      onStderr: progressReporter.handleChunk
    }
  );
  await progressReporter.flush();
  return parsePythonJson<PaddleResult>(stdout);
}

function unavailablePaddleResult(error: string, language = "unknown"): PaddleResult {
  return {
    available: false,
    provider: "none",
    language,
    tokens: [],
    confidence: 0,
    frames: [],
    error
  };
}

function scoreOcrResult(result: PaddleResult) {
  return result.tokens.length * 0.2 + result.frames.filter((frame) => frame.tokens.length > 0).length * 0.3 + result.confidence;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await task(items[currentIndex]);
      }
    })
  );
  return results;
}

function getLanguageConcurrency(languageCount: number) {
  return Math.max(1, Math.min(positiveInteger(process.env.PADDLEOCR_LANGUAGE_CONCURRENCY, languageCount), languageCount));
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function normalizeOcrFrames(value: unknown, mediaRoot: string, sampleIntervalSeconds = 10): OcrFrameResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item as Partial<OcrFrameResult>;
    const framePath = String(record.framePath ?? "");
    return {
      framePath: toPublicMediaPath(framePath, mediaRoot),
      at: typeof record.at === "number" ? record.at : inferOcrFrameTime(framePath, sampleIntervalSeconds),
      tokens: Array.isArray(record.tokens) ? record.tokens.map(String) : [],
      boxes: normalizeOcrBoxes(record.boxes),
      confidence: Number(record.confidence ?? 0)
    };
  });
}

function inferOcrFrameTime(framePath: string, sampleIntervalSeconds: number) {
  const match = framePath.match(/frame-(\d+)\.(?:png|jpg|jpeg)$/i);
  if (!match) return null;
  const frameNumber = Number(match[1]);
  if (!Number.isFinite(frameNumber) || frameNumber <= 0) return null;
  return Number(((frameNumber - 1) * sampleIntervalSeconds).toFixed(2));
}

function normalizeOcrBoxes(value: unknown): OcrBox[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<OcrBox>;
      return {
        text: String(record.text ?? "").trim(),
        confidence: Number(record.confidence ?? 0),
        bbox: normalizeOcrBbox(record.bbox),
        region: normalizeOcrRegion(record.region),
        role: normalizeOcrRole(record.role)
      };
    })
    .filter((box) => box.text.length > 0);
}

function normalizeOcrBbox(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => {
      if (!Array.isArray(point)) return null;
      return [Number(point[0] ?? 0), Number(point[1] ?? 0)] as [number, number];
    })
    .filter((point): point is [number, number] => Array.isArray(point) && point.every(Number.isFinite))
    .slice(0, 4);
}

function normalizeOcrRegion(value: unknown): OcrBox["region"] {
  return value === "top" || value === "middle" || value === "bottom" || value === "left" || value === "right" ? value : "middle";
}

function normalizeOcrRole(value: unknown): OcrBox["role"] {
  return value === "subtitle" || value === "overlay" || value === "watermark" || value === "screen_text" ? value : "screen_text";
}
