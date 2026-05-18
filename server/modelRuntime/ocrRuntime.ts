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
const paddleOcrVlScript = path.resolve("scripts", "paddleocr_vl_extract.py");

export type PaddleResult = {
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
    const selected = selectBestPaddleOcrResult(available, languages);
    if (!isPaddleOcrVlEnabled()) return selected;
    const layout = await runPaddleOcrVlLanguage(framesDir, selected.language ?? languages[0] ?? "en", mediaRoot, fullFrameIntervalSeconds, reportStage);
    if (layout.available) return mergePaddleResults(selected, layout);
    if (isPaddleOcrVlRequired()) return layout;
    return selected;
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
    return postprocessPaddleResult({
      available: Boolean(parsed.available),
      provider: parsed.provider || "paddleocr",
      language,
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      confidence: parsed.confidence ?? 0,
      frames: normalizeOcrFrames(parsed.frameResults, mediaRoot, subtitleIntervalSeconds),
      error: parsed.error
    });
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

async function runPaddleOcrVlLanguage(
  framesDir: string,
  language: string,
  mediaRoot: string,
  sampleIntervalSeconds: number,
  reportStage?: RuntimeStageReporter
): Promise<PaddleResult> {
  await reportStage?.({ stage: "ocr", status: "running", message: "Running PaddleOCR-VL layout OCR pass", progress: 13, log: false });
  try {
    const parsed = isPythonRuntimeServiceMode("ocr")
      ? await callPythonRuntimeService<PaddleResult>(
          "ocr",
          "/v1/paddleocr-vl",
          {
            framesDir,
            language,
            model: process.env.PADDLEOCR_VL_MODEL || "PaddleOCR-VL-0.9B",
            maxFrames: positiveInteger(process.env.PADDLEOCR_VL_MAX_FRAMES, 24)
          },
          {
            metricKey: "model.ocr.paddle_vl.service",
            onProgress: (event) => reportPythonProgressEvent("ocr", reportStage, event)
          }
        )
      : await runPaddleOcrVlLanguageDirect(framesDir, language);
    return postprocessPaddleResult({
      available: Boolean(parsed.available),
      provider: parsed.provider || "paddleocr-vl",
      language,
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      confidence: parsed.confidence ?? 0,
      frames: normalizeOcrFrames(parsed.frameResults, mediaRoot, sampleIntervalSeconds),
      error: parsed.error
    });
  } catch (error) {
    return {
      available: false,
      provider: "paddleocr-vl",
      language,
      tokens: [],
      confidence: 0,
      frames: [],
      error: error instanceof Error ? error.message : "PaddleOCR-VL execution failed"
    };
  }
}

async function runPaddleOcrVlLanguageDirect(framesDir: string, language: string) {
  const { stdout } = await runPythonScriptOnExit(
    [
      paddleOcrVlScript,
      framesDir,
      "--lang",
      language,
      "--model",
      process.env.PADDLEOCR_VL_MODEL || "PaddleOCR-VL-0.9B",
      "--max-frames",
      String(positiveInteger(process.env.PADDLEOCR_VL_MAX_FRAMES, 24))
    ],
    {
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK || "True" }
    }
  );
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

export function selectBestPaddleOcrResult(results: PaddleResult[], languages: string[]): PaddleResult {
  const koreanCandidate = results.find((result) => result.language === "korean");
  if (languages.includes("korean") && koreanCandidate && ocrScriptStats(koreanCandidate).hangulChars >= 4) {
    return koreanCandidate;
  }
  return [...results].sort((a, b) => scoreOcrResult(b, languages) - scoreOcrResult(a, languages))[0] ?? unavailablePaddleResult("PaddleOCR returned no result");
}

function scoreOcrResult(result: PaddleResult, languages: string[]) {
  const stats = ocrScriptStats(result);
  const preferredIndex = result.language ? languages.indexOf(result.language) : -1;
  const preferenceBonus = preferredIndex >= 0 ? Math.max(0, languages.length - preferredIndex) * 0.15 : 0;
  const usefulFrameCount = result.frames.filter((frame) => frame.tokens.length > 0).length;
  const base = result.confidence * 1.5 + result.tokens.length * 0.08 + usefulFrameCount * 0.18 + preferenceBonus;
  if (result.language === "korean") {
    return base + stats.hangulChars * 0.12 + stats.hangulTokens * 0.8 - stats.asciiJunkTokens * 0.12;
  }
  if (languages.includes("korean") && result.language === "en") {
    return base + stats.validLatinTokens * 0.08 - stats.asciiJunkTokens * 0.35;
  }
  return base + stats.validLatinTokens * 0.08 - stats.asciiJunkTokens * 0.04;
}

function postprocessPaddleResult(result: PaddleResult): PaddleResult {
  const frames = result.frames.map((frame) => {
    const boxes = (frame.boxes ?? []).filter((box) => isUsefulOcrBox(box, result.language));
    const tokens = uniqueStrings(boxes.map((box) => box.text));
    return {
      ...frame,
      boxes,
      tokens,
      confidence: boxes.length > 0 ? Number((boxes.reduce((sum, box) => sum + box.confidence, 0) / boxes.length).toFixed(3)) : 0
    };
  });
  const boxTokens = frames.flatMap((frame) => frame.boxes.map((box) => box.text));
  const fallbackTokens = result.tokens.filter((token) => isUsefulOcrText(token, result.language));
  const tokens = uniqueStrings(boxTokens.length > 0 ? boxTokens : fallbackTokens).slice(0, 80);
  return {
    ...result,
    frames,
    tokens,
    confidence: tokens.length > 0 ? confidenceFromFrames(frames, result.confidence) : 0
  };
}

function mergePaddleResults(base: PaddleResult, layout: PaddleResult): PaddleResult {
  return postprocessPaddleResult({
    ...base,
    provider: `${base.provider}+${layout.provider}`,
    tokens: uniqueStrings([...base.tokens, ...layout.tokens]),
    confidence: Math.max(base.confidence, layout.confidence),
    frames: [...base.frames, ...layout.frames]
  });
}

function confidenceFromFrames(frames: OcrFrameResult[], fallback: number) {
  const values = frames.flatMap((frame) => (frame.boxes ?? []).map((box) => box.confidence)).filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : fallback;
}

function isUsefulOcrBox(box: OcrBox, language: string | undefined) {
  const text = box.text.trim();
  if (!isUsefulOcrText(text, language)) return false;
  if (language === "korean") {
    if (/[가-힣]/.test(text)) return box.confidence >= 0.28;
    return box.confidence >= 0.72 && isUsefulNonKoreanOverlay(text);
  }
  return box.confidence >= 0.25;
}

function isUsefulOcrText(value: string, language: string | undefined) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) return false;
  if (!/[A-Za-z0-9가-힣\u3040-\u30ff\u3400-\u9fff]/.test(text)) return false;
  if (language === "korean") {
    if (/[가-힣]/.test(text)) return true;
    return isUsefulNonKoreanOverlay(text);
  }
  return true;
}

function isUsefulNonKoreanOverlay(value: string) {
  const text = value.trim();
  if (/^(?:MBC|KBS|SBS|JTBC|TVN|TVING|ENA|MNET|OCN|NETFLIX)$/i.test(text)) return true;
  if (/^\d{1,2}:\d{2}$/.test(text)) return true;
  if (/^[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){0,3}$/.test(text)) return true;
  return false;
}

function ocrScriptStats(result: PaddleResult) {
  const texts = result.frames.length > 0 ? result.frames.flatMap((frame) => (frame.boxes ?? []).map((box) => box.text)) : result.tokens;
  let hangulChars = 0;
  let hangulTokens = 0;
  let validLatinTokens = 0;
  let asciiJunkTokens = 0;
  for (const text of texts) {
    const hangul = text.match(/[가-힣]/g)?.length ?? 0;
    hangulChars += hangul;
    if (hangul > 0) hangulTokens += 1;
    if (isUsefulNonKoreanOverlay(text)) validLatinTokens += 1;
    if (isAsciiJunkToken(text)) asciiJunkTokens += 1;
  }
  return { hangulChars, hangulTokens, validLatinTokens, asciiJunkTokens };
}

function isAsciiJunkToken(value: string) {
  const text = value.trim();
  if (/[가-힣\u3040-\u30ff\u3400-\u9fff]/.test(text)) return false;
  const compact = text.replace(/[^A-Za-z0-9]/g, "");
  if (compact.length === 0) return true;
  if (/[|$?{}\[\]~]/.test(text)) return true;
  if (/^[A-Z0-9]{2,}$/.test(compact) && !/[AEIOUY]/i.test(compact) && compact.length > 3) return true;
  if (/[A-Za-z]/.test(compact) && /\d/.test(compact) && compact.length <= 8) return true;
  if (/^[A-Z]{4,}$/.test(compact) && vowelRatio(compact) < 0.28) return true;
  return false;
}

function vowelRatio(value: string) {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (!letters) return 0;
  const vowels = letters.match(/[AEIOUY]/gi)?.length ?? 0;
  return vowels / letters.length;
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
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

function isPaddleOcrVlEnabled() {
  return ["1", "true", "yes", "on"].includes((process.env.PADDLEOCR_VL_ENABLED || "").trim().toLowerCase());
}

function isPaddleOcrVlRequired() {
  return ["1", "true", "yes", "on"].includes((process.env.PADDLEOCR_VL_REQUIRED || "").trim().toLowerCase());
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
