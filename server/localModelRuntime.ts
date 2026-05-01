import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AssetRecord, LocalIntelligence, OcrBox, OcrFrameResult, WhisperSegment } from "../shared/types";
import { getObjectPath, getPublicMediaRoot } from "./localObjectStorage";
import { logJson, recordLatency, traceAsync } from "./observability";

const execFileAsync = promisify(execFile);
const pythonBin = process.env.LOCAL_AI_PYTHON || "python3";
const whisperScript = path.resolve("scripts", "whisper_transcribe.py");
const whisperXScript = path.resolve("scripts", "whisperx_diarize.py");
const paddleOcrScript = path.resolve("scripts", "paddle_ocr_extract.py");

type PythonScriptResult = {
  stdout: string;
  stderr: string;
};

export type RuntimeStageReporter = (event: { stage: string; status: "running" | "succeeded" | "failed"; message: string; error?: string }) => void | Promise<void>;

export async function runLocalModelRuntime(filePath: string, asset: AssetRecord, reportStage?: RuntimeStageReporter): Promise<LocalIntelligence> {
  const languageHints = inferLanguageHints(asset);
  const audio = await runRuntimeStage(
    reportStage,
    "audio",
    "Extracting audio and detecting speech regions",
    () => traceAsync("model.audio_extract_vad", { assetId: asset.id }, () => extractAudioAndVad(filePath, asset.id, asset.duration), "model.audio_extract_vad")
  );
  const asrInput = audio.speechFocusedPath || audio.extractedPath || filePath;
  const [visual, waveform, paddle, speech] = await Promise.all([
    runRuntimeStage(
      reportStage,
      "visual",
      "Sampling visual frames",
      () => traceAsync("model.visual_sampler", { assetId: asset.id }, () => inspectVisualFrames(filePath), "model.visual_sampler")
    ),
    runRuntimeStage(
      reportStage,
      "audio-probe",
      "Checking audio waveform",
      () => traceAsync("model.audio_probe", { assetId: asset.id }, () => inspectAudioPresence(filePath), "model.audio_probe")
    ),
    runRuntimeStage(
      reportStage,
      "ocr",
      "Running PaddleOCR",
      () =>
        traceAsync(
          "model.ocr.paddle",
          { assetId: asset.id, langs: languageHints.paddleOcrLanguages.join(",") },
          () => runPaddleOcr(filePath, asset.id, languageHints.paddleOcrLanguages, asset.duration),
          "model.ocr.paddle"
        ),
      (result) => (result.available ? null : (result.error ?? "PaddleOCR returned no OCR result"))
    ),
    runSpeechRuntime(asrInput, asset, languageHints.whisperLanguage, reportStage)
  ]);
  const { whisper, diarization } = speech;
  if (!whisper.available) {
    recordLatency("model.asr.whisper.unavailable", 0, "error", whisper.error ?? "Whisper unavailable");
    logJson("warn", "model.asr.whisper.unavailable", "Whisper fallback activated", { assetId: asset.id, error: whisper.error });
  }
  if (!paddle.available) {
    recordLatency("model.ocr.paddle.unavailable", 0, "error", paddle.error ?? "PaddleOCR unavailable");
    logJson("warn", "model.ocr.paddle.unavailable", "PaddleOCR fallback activated", { assetId: asset.id, error: paddle.error });
  }
  if (!diarization.available) {
    recordLatency("model.diarization.whisperx.unavailable", 0, "error", diarization.error ?? "WhisperX diarization unavailable");
    logJson("warn", "model.diarization.whisperx.unavailable", "WhisperX diarization unavailable", { assetId: asset.id, error: diarization.error });
  }
  const terms = extractTerms(`${asset.title} ${asset.description} ${asset.originalName}`);
  const metadataTerms = unique([...terms.filter((term) => /[a-z0-9가-힣]/i.test(term)), asset.originalName.replace(/\.[^.]+$/, "")]).slice(0, 12);
  const transcript = whisper.available && whisper.transcript.trim() ? whisper.transcript.trim() : "";
  const asrSegments = applySpeakerLabels(whisper.segments, diarization.segments);
  const ocrTokens = paddle.available && paddle.tokens.length > 0 ? paddle.tokens : [];
  const trace = [
    whisper.available ? `${whisper.provider}:${whisper.model ?? "default"}` : `whisper-unavailable:${whisper.error ?? "missing dependency"}`,
    whisper.language ? `asr-language:${whisper.language}` : "asr-language:unknown",
    audio.extractedPath ? "audio-extract:ffmpeg-wav" : "audio-extract:unavailable",
    audio.speechFocusedPath ? "asr-input:vad-speech-focused" : "asr-input:raw-audio",
    audio.speechSegments.length > 0 ? `vad:speech:${audio.speechSegments.length}` : "vad:speech:empty",
    audio.musicSegments.length > 0 ? `music-detect:${audio.musicSegments.length}` : "music-detect:empty",
    diarization.available ? `whisperx:speakers:${diarization.speakers.length}` : `whisperx-unavailable:${diarization.error ?? "not configured"}`,
    paddle.available ? `paddleocr:${paddle.language ?? "unknown"}` : `paddleocr-unavailable:${paddle.error ?? "missing dependency"}`,
    paddle.language ? `ocr-language:${paddle.language}` : "ocr-language:unknown",
    transcript ? "asr-source:whisper" : waveform.hasAudio ? "asr-empty:audio-present" : "asr-empty:no-audio",
    ocrTokens.length > 0 ? "ocr-source:paddleocr" : "ocr-empty",
    metadataTerms.length > 0 ? "metadata-context:available" : "metadata-context:empty",
    "ffmpeg-visual-sampler:v1",
    "local-vlm-router:v1"
  ];

  return {
    audio: {
      extractedPath: toPublicMediaPath(audio.extractedPath, getPublicMediaRoot()),
      speechSegments: audio.speechSegments,
      musicSegments: audio.musicSegments,
      hasSpeech: audio.speechSegments.length > 0,
      hasMusic: audio.musicSegments.length > 0
    },
    asr: {
      transcript,
      language: whisper.language || (/[가-힣]/.test(transcript) ? "ko" : "en"),
      confidence: transcript ? whisper.confidence : 0,
      segments: asrSegments
    },
    diarization: {
      provider: diarization.available ? diarization.provider : "none",
      speakers: diarization.speakers,
      segments: diarization.segments,
      error: diarization.error ?? null
    },
    ocr: {
      tokens: ocrTokens,
      confidence: ocrTokens.length > 0 ? paddle.confidence : 0,
      frames: paddle.frames
    },
    visual: {
      labels: visual.labels,
      dominantColor: visual.dominantColor,
      brightness: visual.brightness,
      motionScore: visual.motionScore
    },
    modelTrace: trace
  };
}

async function runSpeechRuntime(audioPath: string, asset: AssetRecord, language: string | null, reportStage?: RuntimeStageReporter) {
  const whisper = await runRuntimeStage(
    reportStage,
    "asr",
    "Running Whisper ASR",
    () =>
      traceAsync(
        "model.asr.whisper",
        { assetId: asset.id, model: process.env.WHISPER_MODEL || "large-v3", language: language ?? "auto" },
        () => runWhisper(audioPath, language, asset.duration),
        "model.asr.whisper"
      ),
    (result) => (result.available ? null : (result.error ?? "Whisper returned no transcript result"))
  );
  const segmentsJsonPath = await writeWhisperSegmentsForDiarizationResult(asset.id, whisper.segments);
  const diarization = await runRuntimeStage(
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
  return { whisper, diarization };
}

async function runRuntimeStage<T>(
  reportStage: RuntimeStageReporter | undefined,
  stage: string,
  message: string,
  run: () => Promise<T>,
  getSoftError?: (result: T) => string | null
) {
  await reportStage?.({ stage, status: "running", message });
  const heartbeat =
    reportStage &&
    setInterval(() => {
      void reportStage({ stage, status: "running", message: `${message} is still running` });
    }, 60000);
  try {
    const result = await run();
    const softError = getSoftError?.(result) ?? null;
    if (softError) {
      await reportStage?.({ stage, status: "failed", message: `${message} failed`, error: softError });
    } else {
      await reportStage?.({ stage, status: "succeeded", message: `${message} complete` });
    }
    return result;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Runtime stage failed";
    await reportStage?.({ stage, status: "failed", message: `${message} failed`, error: messageText });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
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

type AudioRuntimeResult = {
  extractedPath: string;
  speechFocusedPath: string;
  speechSegments: Array<{ start: number; end: number; confidence: number }>;
  musicSegments: Array<{ start: number; end: number; confidence: number }>;
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

async function runWhisper(filePath: string, language: string | null, duration: number | null): Promise<WhisperResult> {
  try {
    const args = [whisperScript, filePath, "--model", process.env.WHISPER_MODEL || "large-v3"];
    if (language) args.push("--language", language);
    const timeout = getWhisperTimeoutMs(duration);
    const { stdout } = await runPythonScriptOnExit(args, {
      maxBuffer: 1024 * 1024 * 4,
      timeout
    });
    const parsed = parsePythonJson<WhisperResult>(stdout);
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

function getWhisperTimeoutMs(duration: number | null) {
  const configured = Number(process.env.WHISPER_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return undefined;
}

function runPythonScriptOnExit(
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number }
): Promise<PythonScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 4;
    let timer: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      if (kind === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`Python script output exceeded ${maxBuffer} bytes: ${pythonBin} ${args.join(" ")}`)));
      }
    };

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`Python script exceeded safety limit after ${options.timeout}ms: ${pythonBin} ${args.join(" ")}`)));
      }, options.timeout);
    }

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`Command failed: ${pythonBin} ${args.join(" ")}${signal ? ` (${signal})` : ""}\n${stderr}`));
      });
    });
  });
}

async function runWhisperXDiarization(audioPath: string, language: string | null, segmentsJsonPath?: string): Promise<DiarizationResult> {
  try {
    const args = [whisperXScript, audioPath, "--model", process.env.WHISPERX_MODEL || process.env.WHISPER_MODEL || "large-v3"];
    if (language) args.push("--language", language);
    if (segmentsJsonPath) args.push("--segments-json", segmentsJsonPath);
    const hfToken = process.env.WHISPERX_HF_TOKEN || process.env.HF_TOKEN;
    const { stdout } = await runPythonScriptOnExit(args, {
      maxBuffer: 1024 * 1024 * 4,
      timeout: Number(process.env.WHISPERX_TIMEOUT_MS || 0) || undefined,
      env: hfToken ? { ...process.env, WHISPERX_HF_TOKEN: hfToken, HF_TOKEN: process.env.HF_TOKEN ?? hfToken } : process.env
    });
    const parsed = parsePythonJson<DiarizationResult>(stdout);
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

async function extractAudioAndVad(filePath: string, assetId: string, duration: number | null): Promise<AudioRuntimeResult> {
  const mediaRoot = getPublicMediaRoot();
  const relativeDir = path.join("generated", "assets", assetId, "audio");
  const audioDir = path.join(mediaRoot, relativeDir);
  const audioPath = path.join(audioDir, "speech.wav");
  await mkdir(audioDir, { recursive: true });
  try {
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath]);
    await stat(audioPath);
  } catch (error) {
    logJson("warn", "model.audio_extract.unavailable", "Audio extraction returned no usable audio", {
      assetId,
      error: error instanceof Error ? error.message : "Audio extraction failed"
    });
    return {
      extractedPath: "",
      speechFocusedPath: "",
      speechSegments: [],
      musicSegments: []
    };
  }
  const speechSegments = await detectSpeechSegments(audioPath, duration);
  const musicSegments = inferMusicSegments(duration, speechSegments);
  const speechFocusedPath = await createSpeechFocusedAudio(audioPath, path.join(audioDir, "speech-focused.wav"), speechSegments, duration, assetId);
  return {
    extractedPath: audioPath,
    speechFocusedPath,
    speechSegments,
    musicSegments
  };
}

async function createSpeechFocusedAudio(
  audioPath: string,
  outputPath: string,
  speechSegments: Array<{ start: number; end: number; confidence: number }>,
  duration: number | null,
  assetId: string
) {
  if (speechSegments.length === 0) return "";
  const merged = mergeSpeechSegments(speechSegments, duration, 0.15);
  if (merged.length === 0) return "";
  const speechExpression = merged.map((segment) => `between(t\\,${segment.start}\\,${segment.end})`).join("+");
  const filter = `volume=enable='not(${speechExpression})':volume=0`;
  try {
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", audioPath, "-af", filter, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath]);
    await stat(outputPath);
    return outputPath;
  } catch (error) {
    logJson("warn", "model.audio_focus.unavailable", "Speech-focused audio generation failed; falling back to extracted audio", {
      assetId,
      error: error instanceof Error ? error.message : "Speech-focused audio generation failed"
    });
    return "";
  }
}

function mergeSpeechSegments(segments: Array<{ start: number; end: number }>, duration: number | null, padding: number) {
  const normalized = segments
    .map((segment) => ({
      start: Math.max(0, segment.start - padding),
      end: duration && duration > 0 ? Math.min(duration, segment.end + padding) : segment.end + padding
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const segment of normalized) {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 0.05) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged.map((segment) => ({ start: roundTime(segment.start), end: roundTime(segment.end) }));
}

async function detectSpeechSegments(audioPath: string, duration: number | null) {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", audioPath, "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"],
      {}
    );
    return speechFromSilenceLog(stderr, duration);
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const parsed = speechFromSilenceLog(stderr, duration);
    if (parsed.length > 0) return parsed;
    return duration && duration > 0 ? [{ start: 0, end: duration, confidence: 0.35 }] : [];
  }
}

function speechFromSilenceLog(log: string, duration: number | null) {
  const events = [...log.matchAll(/silence_(start|end):\s*([0-9.]+)/g)].map((match) => ({
    type: match[1],
    at: Number(match[2])
  }));
  if (!duration || duration <= 0) {
    const last = events.at(-1)?.at ?? 0;
    duration = Math.max(last, 0);
  }
  if (duration <= 0) return [];
  const speech: Array<{ start: number; end: number; confidence: number }> = [];
  let cursor = 0;
  for (const event of events) {
    if (event.type === "start") {
      if (event.at > cursor) speech.push({ start: roundTime(cursor), end: roundTime(event.at), confidence: 0.72 });
    } else {
      cursor = Math.max(cursor, event.at);
    }
  }
  if (cursor < duration) speech.push({ start: roundTime(cursor), end: roundTime(duration), confidence: 0.72 });
  return speech.filter((segment) => segment.end - segment.start >= 0.25);
}

function inferMusicSegments(duration: number | null, speechSegments: Array<{ start: number; end: number }>) {
  if (!duration || duration <= 0) return [];
  if (speechSegments.length === 0) return [{ start: 0, end: roundTime(duration), confidence: 0.6 }];
  const speechDuration = speechSegments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  const musicConfidence = Math.max(0, Math.min(1, 1 - speechDuration / duration));
  return musicConfidence > 0.2 ? [{ start: 0, end: roundTime(duration), confidence: Number(musicConfidence.toFixed(3)) }] : [];
}

async function runPaddleOcr(filePath: string, assetId: string, languages: string[], duration: number | null): Promise<PaddleResult> {
  const mediaRoot = getPublicMediaRoot();
  const relativeDir = path.join("generated", "assets", assetId, "ocr-frames");
  const framesDir = path.join(mediaRoot, relativeDir);
  const fullFrameMaxFrames = Number(process.env.PADDLEOCR_FULL_MAX_FRAMES || process.env.PADDLEOCR_MAX_FRAMES || 24);
  const fullFrameIntervalSeconds = getOcrSampleInterval(duration, fullFrameMaxFrames);
  const subtitleIntervalSeconds = Number(process.env.PADDLEOCR_SUBTITLE_INTERVAL_SECONDS || 0.5);
  const subtitleMaxFrames = Number(process.env.PADDLEOCR_SUBTITLE_MAX_FRAMES || 1800);
  const frameScaleWidth = Number(process.env.PADDLEOCR_FRAME_WIDTH || 960);
  const workers = Number(process.env.PADDLEOCR_WORKERS || 2);
  try {
    await mkdir(framesDir, { recursive: true });
    await clearGeneratedFrames(framesDir);
    await extractOcrFrames(filePath, framesDir, "subtitle-bottom-frame-%05d.png", `fps=1/${subtitleIntervalSeconds},crop=iw:ih*0.28:0:ih*0.70,scale=${frameScaleWidth}:-2`, subtitleMaxFrames);
    await extractOcrFrames(filePath, framesDir, "subtitle-top-frame-%05d.png", `fps=1/${subtitleIntervalSeconds},crop=iw:ih*0.22:0:0,scale=${frameScaleWidth}:-2`, subtitleMaxFrames);
    await extractOcrFrames(filePath, framesDir, "full-frame-%04d.png", `fps=1/${fullFrameIntervalSeconds},scale=${frameScaleWidth}:-2`, fullFrameMaxFrames);
    const results = await Promise.all(
      languages.map((language) => runPaddleOcrLanguage(framesDir, language, mediaRoot, subtitleIntervalSeconds, fullFrameIntervalSeconds, workers))
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
  workers: number
): Promise<PaddleResult> {
  try {
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
      timeout: Number(process.env.PADDLEOCR_TIMEOUT_MS || 0) || undefined,
      env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK || "True" }
      }
    );
    const parsed = parsePythonJson<PaddleResult>(stdout);
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
    return unavailablePaddleResult(error instanceof Error ? error.message : "PaddleOCR execution failed", language);
  }
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

function parsePythonJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of [...lines].reverse()) {
      if (!line.startsWith("{") || !line.endsWith("}")) continue;
      try {
        return JSON.parse(line) as T;
      } catch {
        continue;
      }
    }
    throw new Error(`Python script did not return parseable JSON. Last output: ${lines.at(-1)?.slice(0, 240) ?? "empty"}`);
  }
}

function scoreOcrResult(result: PaddleResult) {
  return result.tokens.length * 0.2 + result.frames.filter((frame) => frame.tokens.length > 0).length * 0.3 + result.confidence;
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

function inferLanguageHints(asset: AssetRecord) {
  const text = `${asset.title} ${asset.description} ${asset.originalName}`;
  const whisperLanguage = normalizeAuto(process.env.WHISPER_LANGUAGE);
  const configuredOcr = normalizeAuto(process.env.PADDLEOCR_LANG);
  if (configuredOcr) return { whisperLanguage, paddleOcrLanguages: [configuredOcr] };
  if (/[가-힣]/.test(text)) return { whisperLanguage, paddleOcrLanguages: ["korean", "en"] };
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return { whisperLanguage, paddleOcrLanguages: ["japan", "ch", "en"] };
  return { whisperLanguage, paddleOcrLanguages: ["en"] };
}

function normalizeAuto(value?: string) {
  if (!value || value === "auto") return null;
  return value;
}

function roundTime(value: number) {
  return Number(value.toFixed(3));
}

function toPublicMediaPath(framePath: string, mediaRoot: string) {
  if (!framePath) return "";
  const relative = path.relative(mediaRoot, framePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return framePath;
}

async function inspectAudioPresence(filePath: string) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      filePath
    ]);
    return { hasAudio: stdout.trim().length > 0 };
  } catch {
    return { hasAudio: false };
  }
}

async function inspectVisualFrames(filePath: string) {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-vf", "fps=1,scale=24:16", "-frames:v", "3", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { encoding: "buffer", maxBuffer: 24 * 16 * 3 * 3 + 4096 }
    );
    const bytes = Buffer.from(stdout);
    if (bytes.length === 0) throw new Error("No frame bytes");
    const frames = Math.max(1, Math.floor(bytes.length / (24 * 16 * 3)));
    let red = 0;
    let green = 0;
    let blue = 0;
    let diff = 0;
    let previous = 0;
    const pixels = bytes.length / 3;
    for (let index = 0; index < bytes.length; index += 3) {
      red += bytes[index];
      green += bytes[index + 1];
      blue += bytes[index + 2];
      const luminance = (bytes[index] + bytes[index + 1] + bytes[index + 2]) / 3;
      if (index > 0) diff += Math.abs(luminance - previous);
      previous = luminance;
    }
    const avgRed = Math.round(red / pixels);
    const avgGreen = Math.round(green / pixels);
    const avgBlue = Math.round(blue / pixels);
    const brightness = Number(((avgRed + avgGreen + avgBlue) / 765).toFixed(3));
    const motionScore = Number(Math.min(1, diff / (pixels * frames * 255)).toFixed(3));
    return {
      dominantColor: rgbToHex(avgRed, avgGreen, avgBlue),
      brightness,
      motionScore,
      labels: labelsFor(brightness, motionScore, avgRed, avgGreen, avgBlue)
    };
  } catch {
    const hash = createHash("md5").update(filePath).digest();
    return {
      dominantColor: rgbToHex(hash[0], hash[1], hash[2]),
      brightness: Number(((hash[0] + hash[1] + hash[2]) / 765).toFixed(3)),
      motionScore: Number((hash[3] / 255).toFixed(3)),
      labels: ["metadata-derived", "visual-fallback"]
    };
  }
}

function labelsFor(brightness: number, motion: number, red: number, green: number, blue: number) {
  const labels = [brightness > 0.58 ? "bright-scene" : "dim-scene", motion > 0.12 ? "active-motion" : "stable-shot"];
  if (red > green && red > blue) labels.push("warm-palette");
  if (blue > red && blue > green) labels.push("cool-palette");
  if (green > red && green > blue) labels.push("green-dominant");
  return labels;
}

function extractTerms(input: string) {
  return unique(
    input
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 2)
  );
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
