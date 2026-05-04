import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssetRecord, CapabilityMode, LocalIntelligence, WhisperSegment } from "../../shared/types";
import { getObjectPath, getPublicMediaRoot } from "../localObjectStorage";
import { traceAsync } from "../observability";
import { parsePythonJson, runPythonScriptOnExit } from "./pythonProcess";
import { createPythonProgressReporter, reportPythonProgressEvent } from "./pythonProgress";
import { callPythonRuntimeService, isPythonRuntimeServiceMode } from "./pythonRuntimeService";
import { runRuntimeStage, type RuntimeStageReporter } from "./stageReporter";

const whisperScript = path.resolve("scripts", "whisper_transcribe.py");
const whisperXScript = path.resolve("scripts", "whisperx_diarize.py");

export async function runSpeechRuntime(
  audioPath: string,
  asset: AssetRecord,
  language: string | null,
  reportStage?: RuntimeStageReporter,
  options: { diarizationMode?: CapabilityMode } = {}
) {
  const whisper = await runRuntimeStage(
    reportStage,
    "asr",
    "Running Whisper ASR",
    () =>
      traceAsync(
        "model.asr.whisper",
        { assetId: asset.id, model: process.env.WHISPER_MODEL || "large-v3", backend: process.env.WHISPER_BACKEND || "auto", language: language ?? "auto" },
        () => runWhisper(audioPath, language, asset.duration, reportStage),
        "model.asr.whisper"
      ),
    (result) => (result.available ? null : (result.error ?? "Whisper returned no transcript result"))
  );
  const diarization =
    options.diarizationMode === "disabled"
      ? disabledDiarizationResult()
      : await runWhisperXStage(audioPath, asset, language, whisper.segments, reportStage);
  return { whisper, diarization };
}

type WhisperResult = {
  available: boolean;
  provider: string;
  model?: string;
  transcript: string;
  language: string;
  confidence: number;
  segments: WhisperSegment[];
  error?: string;
};

type DiarizationResult = {
  available: boolean;
  provider: string;
  model?: string;
  language?: string;
  speakers: string[];
  segments: Array<{ start: number; end: number; speaker: string; text: string }>;
  error?: string | null;
};

async function runWhisperXStage(audioPath: string, asset: AssetRecord, language: string | null, segments: WhisperSegment[], reportStage?: RuntimeStageReporter) {
  const segmentsJsonPath = await writeWhisperSegmentsForDiarizationResult(asset.id, segments);
  return runRuntimeStage(
    reportStage,
    "diarization",
    "Running WhisperX diarization",
    () =>
      traceAsync(
        "model.diarization.whisperx",
        { assetId: asset.id, model: process.env.WHISPERX_MODEL || process.env.WHISPER_MODEL || "large-v3" },
        () => runWhisperXDiarization(audioPath, language, segmentsJsonPath ?? undefined),
        "model.diarization.whisperx"
      ),
    (result) => (result.available ? null : (result.error ?? "WhisperX returned no speaker result"))
  );
}

function disabledDiarizationResult(): DiarizationResult {
  return {
    available: false,
    provider: "whisperx",
    speakers: [],
    segments: [],
    error: "WhisperX diarization disabled by capability policy."
  };
}

async function runWhisper(filePath: string, language: string | null, duration: number | null, reportStage?: RuntimeStageReporter): Promise<WhisperResult> {
  const progressReporter = createPythonProgressReporter("asr", reportStage);
  try {
    const timeout = getWhisperTimeoutMs(duration);
    const parsed = isPythonRuntimeServiceMode("asr")
      ? await callPythonRuntimeService<WhisperResult>(
          "asr",
          "/v1/whisper",
          {
            mediaPath: filePath,
            model: process.env.WHISPER_MODEL || "large-v3",
            backend: process.env.WHISPER_BACKEND || "auto",
            language,
            timeoutMs: timeout
          },
          {
            timeoutMs: timeout,
            metricKey: "model.asr.whisper.service",
            onProgress: (event) => reportPythonProgressEvent("asr", reportStage, event)
          }
        )
      : await runWhisperDirect(filePath, language, timeout, progressReporter);
    return {
      available: Boolean(parsed.available),
      provider: parsed.provider || "whisper",
      model: parsed.model,
      transcript: parsed.transcript || "",
      language: parsed.language || "unknown",
      confidence: parsed.confidence ?? 0,
      segments: normalizeWhisperSegments(parsed.segments),
      error: parsed.error
    };
  } catch (error) {
    await progressReporter.flush();
    return {
      available: false,
      provider: "none",
      transcript: "",
      language: "unknown",
      confidence: 0,
      segments: [],
      error: error instanceof Error ? error.message : "Whisper execution failed"
    };
  }
}

async function runWhisperDirect(
  filePath: string,
  language: string | null,
  timeout: number | undefined,
  progressReporter: ReturnType<typeof createPythonProgressReporter>
) {
  const args = [whisperScript, filePath, "--model", process.env.WHISPER_MODEL || "large-v3"];
  if (language) args.push("--language", language);
  const { stdout } = await runPythonScriptOnExit(args, {
    maxBuffer: 1024 * 1024 * 4,
    timeout,
    onStderr: progressReporter.handleChunk
  });
  await progressReporter.flush();
  return parsePythonJson<WhisperResult>(stdout);
}

function getWhisperTimeoutMs(duration: number | null) {
  const configured = Number(process.env.WHISPER_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return undefined;
}

async function runWhisperXDiarization(audioPath: string, language: string | null, segmentsJsonPath?: string): Promise<DiarizationResult> {
  try {
    const timeout = Number(process.env.WHISPERX_TIMEOUT_MS || 0) || undefined;
    const parsed = isPythonRuntimeServiceMode("asr")
      ? await callPythonRuntimeService<DiarizationResult>(
          "asr",
          "/v1/whisperx",
          {
            audioPath,
            model: process.env.WHISPERX_MODEL || process.env.WHISPER_MODEL || "large-v3",
            language,
            segmentsJsonPath,
            timeoutMs: timeout
          },
          { timeoutMs: timeout, metricKey: "model.diarization.whisperx.service" }
        )
      : await runWhisperXDiarizationDirect(audioPath, language, segmentsJsonPath, timeout);
    return {
      available: Boolean(parsed.available),
      provider: parsed.provider || "whisperx",
      model: parsed.model,
      language: parsed.language,
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers.map(String) : [],
      segments: normalizeDiarizationSegments(parsed.segments),
      error: parsed.error
    };
  } catch (error) {
    return {
      available: false,
      provider: "whisperx",
      speakers: [],
      segments: [],
      error: error instanceof Error ? error.message : "WhisperX execution failed"
    };
  }
}

async function runWhisperXDiarizationDirect(audioPath: string, language: string | null, segmentsJsonPath: string | undefined, timeout: number | undefined) {
  const args = [whisperXScript, audioPath, "--model", process.env.WHISPERX_MODEL || process.env.WHISPER_MODEL || "large-v3"];
  if (language) args.push("--language", language);
  if (segmentsJsonPath) args.push("--segments-json", segmentsJsonPath);
  const hfToken = process.env.WHISPERX_HF_TOKEN || process.env.HF_TOKEN;
  const { stdout } = await runPythonScriptOnExit(args, {
    maxBuffer: 1024 * 1024 * 4,
    timeout,
    env: hfToken ? { ...process.env, WHISPERX_HF_TOKEN: hfToken, HF_TOKEN: process.env.HF_TOKEN ?? hfToken } : process.env
  });
  return parsePythonJson<DiarizationResult>(stdout);
}

export async function runWhisperXDiarizationForAsset(asset: AssetRecord): Promise<LocalIntelligence["diarization"]> {
  const audioPath = resolveExtractedAudioPath(asset) ?? getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey);
  const language = asset.intelligence.asr.language && asset.intelligence.asr.language !== "unknown" ? asset.intelligence.asr.language : null;
  const segmentsJsonPath = await writeWhisperSegmentsForDiarization(asset);
  const result = await runWhisperXDiarization(audioPath, language, segmentsJsonPath ?? undefined);
  return {
    provider: result.available ? result.provider : "none",
    speakers: result.speakers,
    segments: result.segments,
    error: result.error ?? null
  };
}

export function applyDiarizationToAsrSegments(segments: WhisperSegment[], diarization: LocalIntelligence["diarization"]["segments"]) {
  return applySpeakerLabels(segments, diarization);
}

function resolveExtractedAudioPath(asset: AssetRecord) {
  const extractedPath = asset.intelligence.audio?.extractedPath;
  if (!extractedPath) return null;
  if (path.isAbsolute(extractedPath)) return extractedPath;
  return path.join(getPublicMediaRoot(), extractedPath);
}

async function writeWhisperSegmentsForDiarization(asset: AssetRecord) {
  return writeWhisperSegmentsForDiarizationResult(asset.id, asset.intelligence.asr.segments);
}

async function writeWhisperSegmentsForDiarizationResult(assetId: string, sourceSegments: WhisperSegment[]) {
  const segments = sourceSegments
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: segment.text
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.text.trim().length > 0);
  if (segments.length === 0) return null;
  const dir = path.resolve(".data", "tmp-whisperx");
  await mkdir(dir, { recursive: true });
  const filepath = path.join(dir, `${assetId}-segments.json`);
  await writeFile(filepath, JSON.stringify(segments), "utf8");
  return filepath;
}

function normalizeWhisperSegments(value: unknown): WhisperSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<WhisperSegment>;
      return {
        start: Number(record.start ?? 0),
        end: Number(record.end ?? record.start ?? 0),
        text: String(record.text ?? "").trim(),
        speaker: typeof record.speaker === "string" ? record.speaker : null
      };
    })
    .filter((item) => item.text.length > 0 && item.end >= item.start);
}

function normalizeDiarizationSegments(value: unknown): DiarizationResult["segments"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<DiarizationResult["segments"][number]>;
      return {
        start: Number(record.start ?? 0),
        end: Number(record.end ?? record.start ?? 0),
        speaker: String(record.speaker ?? "speaker_unknown"),
        text: String(record.text ?? "").trim()
      };
    })
    .filter((item) => item.text.length > 0 && item.end >= item.start);
}

function applySpeakerLabels(segments: WhisperSegment[], diarization: DiarizationResult["segments"]): WhisperSegment[] {
  if (segments.length === 0 || diarization.length === 0) return segments;
  return segments.map((segment) => {
    const best = diarization
      .map((speakerSegment) => ({
        speaker: speakerSegment.speaker,
        overlap: overlapDuration(segment.start, segment.end, speakerSegment.start, speakerSegment.end)
      }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    return {
      ...segment,
      speaker: best && best.overlap > 0 ? best.speaker : segment.speaker ?? null
    };
  });
}

function overlapDuration(startA: number, endA: number, startB: number, endB: number) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}
