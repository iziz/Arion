import path from "node:path";
import type { AssetRecord, CapabilityMode, LocalIntelligence } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";
import { extractAudioAndVad, type AudioRuntimeResult } from "./modelRuntime/audioRuntime";
import { toPublicMediaPath } from "./modelRuntime/mediaPath";
import { runPaddleOcr } from "./modelRuntime/ocrRuntime";
import { applyDiarizationToAsrSegments, runSpeechRuntime } from "./modelRuntime/speechRuntime";
import { inspectAudioPresence, inspectVisualFrames } from "./modelRuntime/visualSampler";
import { runRuntimeStage, type RuntimeStageReporter } from "./modelRuntime/stageReporter";
import { logJson, recordLatency, traceAsync } from "./observability";

export { applyDiarizationToAsrSegments, runWhisperXDiarizationForAsset } from "./modelRuntime/speechRuntime";

export type LocalRuntimePartial = Partial<Pick<LocalIntelligence, "audio" | "asr" | "diarization" | "ocr" | "visual">>;

type LocalModelRuntimeOptions = {
  forceStages?: string[];
  whisperXDiarization?: CapabilityMode;
  onPartial?: (stage: string, partial: LocalRuntimePartial) => Promise<void> | void;
};

export async function runLocalModelRuntime(
  filePath: string,
  asset: AssetRecord,
  reportStage?: RuntimeStageReporter,
  options: LocalModelRuntimeOptions = {}
): Promise<LocalIntelligence> {
  const languageHints = inferLanguageHints(asset);
  const forceStages = new Set(options.forceStages ?? []);
  const audio = await getAudioRuntimeResult(filePath, asset, reportStage, forceStages);
  const audioIntelligence = buildAudioIntelligence(audio);
  await publishRuntimePartial(options, "audio", { audio: audioIntelligence });
  const asrInput = audio.speechFocusedPath || audio.extractedPath || filePath;
  const [visual, waveform] = await Promise.all([
    getVisualRuntimeResult(filePath, asset, reportStage, forceStages).then(async (result) => {
      await publishRuntimePartial(options, "visual", { visual: buildVisualIntelligence(result) });
      return result;
    }),
    getAudioProbeRuntimeResult(filePath, audio, asset, reportStage, forceStages)
  ]);
  const runOcrTask = async () => {
    if (hasCachedOcr(asset) && !forceStages.has("ocr")) {
      await reportStage?.({
        stage: "ocr",
        status: "succeeded",
        message: `Using cached PaddleOCR result (${asset.intelligence.ocr.frames.length} frames, ${asset.intelligence.ocr.tokens.length} tokens)`,
        progress: 100,
        log: false
      });
      return cachedPaddleResult(asset);
    }
    const result = await runRuntimeStage(
      reportStage,
      "ocr",
      "Running PaddleOCR",
      () =>
        traceAsync(
          "model.ocr.paddle",
          { assetId: asset.id, langs: languageHints.paddleOcrLanguages.join(",") },
          () => runPaddleOcr(filePath, asset.id, languageHints.paddleOcrLanguages, asset.duration, reportStage),
          "model.ocr.paddle"
        ),
      (paddleResult) => (paddleResult.available ? null : (paddleResult.error ?? "PaddleOCR returned no OCR result"))
    );
    await publishRuntimePartial(options, "ocr", { ocr: buildOcrIntelligence(result) });
    return result;
  };
  const runSpeechTask = async () => {
    if (hasCachedAsr(asset) && !forceStages.has("asr") && !forceStages.has("diarization")) {
      await reportStage?.({
        stage: "asr",
        status: "succeeded",
        message: `Using cached Whisper ASR result (${asset.intelligence.asr.segments.length} segments)`,
        progress: 100,
        log: false
      });
      if (hasCachedDiarization(asset)) {
        await reportStage?.({
          stage: "diarization",
          status: "succeeded",
          message: `Using cached WhisperX diarization result (${asset.intelligence.diarization.speakers.length} speakers)`,
          progress: 100,
          log: false
        });
      }
      const speechIntelligence = {
        asr: asset.intelligence.asr,
        diarization: asset.intelligence.diarization
      };
      await publishRuntimePartial(options, "asr", speechIntelligence);
      return cachedSpeechResult(asset);
    }
    const result = await runSpeechRuntime(asrInput, asset, languageHints.whisperLanguage, reportStage, { diarizationMode: options.whisperXDiarization });
    const speechIntelligence = buildSpeechIntelligence(result.whisper, result.diarization);
    await publishRuntimePartial(options, "asr", speechIntelligence);
    return result;
  };
  let paddle: Awaited<ReturnType<typeof runOcrTask>>;
  let speech: Awaited<ReturnType<typeof runSpeechTask>>;
  if (getLocalModelHeavyConcurrency() >= 2) {
    [paddle, speech] = await Promise.all([
      runRecoverableRuntimeTask("ocr", "PaddleOCR", runOcrTask, unavailablePaddleResult),
      runRecoverableRuntimeTask("asr", "Whisper ASR", runSpeechTask, unavailableSpeechResult)
    ]);
  } else {
    speech = await runRecoverableRuntimeTask("asr", "Whisper ASR", runSpeechTask, unavailableSpeechResult);
    paddle = await runRecoverableRuntimeTask("ocr", "PaddleOCR", runOcrTask, unavailablePaddleResult);
  }
  const { whisper, diarization } = speech;
  if (!whisper.available) {
    recordLatency("model.asr.whisper.unavailable", 0, "error", whisper.error ?? "Whisper unavailable");
    logJson("warn", "model.asr.whisper.unavailable", "Whisper unavailable", { assetId: asset.id, error: whisper.error });
  }
  if (!paddle.available) {
    recordLatency("model.ocr.paddle.unavailable", 0, "error", paddle.error ?? "PaddleOCR unavailable");
    logJson("warn", "model.ocr.paddle.unavailable", "PaddleOCR unavailable", { assetId: asset.id, error: paddle.error });
  }
  if (!visual.available) {
    recordLatency("model.visual_sampler.unavailable", 0, "error", visual.error ?? "Visual sampler unavailable");
    logJson("warn", "model.visual_sampler.unavailable", "Visual sampler unavailable", { assetId: asset.id, error: visual.error });
  }
  if (!diarization.available) {
    recordLatency("model.diarization.whisperx.unavailable", 0, "error", diarization.error ?? "WhisperX diarization unavailable");
    logJson("warn", "model.diarization.whisperx.unavailable", "WhisperX diarization unavailable", { assetId: asset.id, error: diarization.error });
  }
  const terms = extractTerms(`${asset.title} ${asset.description} ${asset.originalName}`);
  const metadataTerms = unique([...terms.filter((term) => /[a-z0-9가-힣]/i.test(term)), asset.originalName.replace(/\.[^.]+$/, "")]).slice(0, 12);
  const speechIntelligence = buildSpeechIntelligence(whisper, diarization);
  const transcript = speechIntelligence.asr?.transcript ?? "";
  const asrSegments = speechIntelligence.asr?.segments ?? [];
  const ocrIntelligence = buildOcrIntelligence(paddle);
  const ocrTokens = ocrIntelligence.tokens;
  const trace = [
    whisper.available ? `${whisper.provider}:${whisper.model ?? "default"}` : `whisper-unavailable:${whisper.error ?? "missing dependency"}`,
    whisper.language ? `asr-language:${whisper.language}` : "asr-language:unknown",
    audio.extractedPath ? "audio-extract:ffmpeg-wav" : "audio-extract:unavailable",
    audio.speechFocusedPath ? "asr-input:vad-speech-focused" : "asr-input:raw-audio",
    audio.vad.available ? `vad:speech:${audio.speechSegments.length}` : `vad-unavailable:${audio.vad.error ?? "silencedetect failed"}`,
    audio.musicSegments.length > 0 ? `music-detect:${audio.musicSegments.length}` : "music-detect:empty",
    diarization.available ? `whisperx:speakers:${diarization.speakers.length}` : `whisperx-unavailable:${diarization.error ?? "not configured"}`,
    paddle.available ? `paddleocr:${paddle.language ?? "unknown"}` : `paddleocr-unavailable:${paddle.error ?? "missing dependency"}`,
    paddle.language ? `ocr-language:${paddle.language}` : "ocr-language:unknown",
    visual.available ? "visual-source:ffmpeg-sampled" : `visual-unavailable:${visual.error ?? "sampling failed"}`,
    transcript ? "asr-source:whisper" : waveform.hasAudio ? "asr-empty:audio-present" : "asr-empty:no-audio",
    ocrTokens.length > 0 ? "ocr-source:paddleocr" : "ocr-empty",
    metadataTerms.length > 0 ? "metadata-context:available" : "metadata-context:empty",
    "ffmpeg-visual-sampler:v1",
    "local-vlm-router:v1"
  ];

  return {
    audio: audioIntelligence,
    asr: speechIntelligence.asr,
    diarization: speechIntelligence.diarization,
    ocr: ocrIntelligence,
    visual: buildVisualIntelligence(visual),
    modelTrace: trace
  };
}

async function getAudioRuntimeResult(
  filePath: string,
  asset: AssetRecord,
  reportStage: RuntimeStageReporter | undefined,
  forceStages: Set<string>
): Promise<AudioRuntimeResult> {
  if (hasCachedAudio(asset) && !forceStages.has("audio")) {
    await reportStage?.({
      stage: "audio",
      status: "succeeded",
      message: `Using cached extracted audio (${asset.intelligence.audio.speechSegments.length} speech regions)`,
      progress: 100,
      log: false
    });
    return cachedAudioResult(asset);
  }
  return runRuntimeStage(
    reportStage,
    "audio",
    "Extracting audio and detecting speech regions",
    () => traceAsync("model.audio_extract_vad", { assetId: asset.id }, () => extractAudioAndVad(filePath, asset.id, asset.duration), "model.audio_extract_vad")
  );
}

async function getVisualRuntimeResult(
  filePath: string,
  asset: AssetRecord,
  reportStage: RuntimeStageReporter | undefined,
  forceStages: Set<string>
): Promise<Awaited<ReturnType<typeof inspectVisualFrames>>> {
  if (hasCachedVisual(asset) && !forceStages.has("visual")) {
    await reportStage?.({
      stage: "visual",
      status: "succeeded",
      message: `Using cached visual sampler result (${asset.intelligence.visual.labels.length} labels)`,
      progress: 100,
      log: false
    });
    return cachedVisualResult(asset);
  }
  return runRuntimeStage(
    reportStage,
    "visual",
    "Sampling visual frames",
    () => traceAsync("model.visual_sampler", { assetId: asset.id }, () => inspectVisualFrames(filePath), "model.visual_sampler"),
    (result) => (result.available ? null : (result.error ?? "Visual sampler returned no usable frames"))
  );
}

async function getAudioProbeRuntimeResult(
  filePath: string,
  audio: AudioRuntimeResult,
  asset: AssetRecord,
  reportStage: RuntimeStageReporter | undefined,
  forceStages: Set<string>
) {
  if (audio.extractedPath && !forceStages.has("audio-probe")) {
    await reportStage?.({
      stage: "audio-probe",
      status: "succeeded",
      message: "Using cached audio waveform check",
      progress: 100,
      log: false
    });
    return { hasAudio: true };
  }
  return runRuntimeStage(
    reportStage,
    "audio-probe",
    "Checking audio waveform",
    () => traceAsync("model.audio_probe", { assetId: asset.id }, () => inspectAudioPresence(filePath), "model.audio_probe")
  );
}

async function runRecoverableRuntimeTask<T>(
  stage: string,
  label: string,
  task: () => Promise<T>,
  fallback: (error: string) => T
) {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label} failed`;
    logJson("error", `model.runtime.${stage}.failed`, message, { stage });
    return fallback(message);
  }
}

function hasCachedAudio(asset: AssetRecord) {
  return Boolean(resolveCachedMediaPath(asset.intelligence.audio.extractedPath));
}

function cachedAudioResult(asset: AssetRecord): AudioRuntimeResult {
  const extractedPath = resolveCachedMediaPath(asset.intelligence.audio.extractedPath) ?? "";
  return {
    extractedPath,
    speechFocusedPath: "",
    vad: asset.intelligence.audio.vad ?? { available: false, provider: "none", error: null },
    speechSegments: asset.intelligence.audio.speechSegments,
    musicSegments: asset.intelligence.audio.musicSegments
  };
}

function hasCachedVisual(asset: AssetRecord) {
  const visual = asset.intelligence.visual;
  return Boolean(visual.available || visual.labels.length > 0 || visual.dominantColor !== "#000000");
}

function cachedVisualResult(asset: AssetRecord): Awaited<ReturnType<typeof inspectVisualFrames>> {
  return {
    available: Boolean(asset.intelligence.visual.available ?? true),
    labels: asset.intelligence.visual.labels,
    dominantColor: asset.intelligence.visual.dominantColor,
    brightness: asset.intelligence.visual.brightness,
    motionScore: asset.intelligence.visual.motionScore,
    error: asset.intelligence.visual.error ?? null
  } as Awaited<ReturnType<typeof inspectVisualFrames>>;
}

function hasCachedAsr(asset: AssetRecord) {
  const asr = asset.intelligence.asr;
  return Boolean(
    asr.transcript.trim() ||
      asr.segments.length > 0 ||
      asset.intelligence.modelTrace.some((trace) => trace === "asr-source:whisper" || trace.startsWith("asr-empty:"))
  );
}

function hasCachedDiarization(asset: AssetRecord) {
  const diarization = asset.intelligence.diarization;
  return diarization.provider !== "none" && diarization.segments.length > 0;
}

function cachedSpeechResult(asset: AssetRecord): Awaited<ReturnType<typeof runSpeechRuntime>> {
  return {
    whisper: {
      available: true,
      provider: "cached-whisper",
      transcript: asset.intelligence.asr.transcript,
      language: asset.intelligence.asr.language,
      confidence: asset.intelligence.asr.confidence,
      segments: asset.intelligence.asr.segments
    },
    diarization: {
      available: hasCachedDiarization(asset),
      provider: asset.intelligence.diarization.provider,
      speakers: asset.intelligence.diarization.speakers,
      segments: asset.intelligence.diarization.segments,
      error: asset.intelligence.diarization.error
    }
  };
}

function hasCachedOcr(asset: AssetRecord) {
  const ocr = asset.intelligence.ocr;
  return Boolean(
    ocr.tokens.length > 0 ||
      ocr.frames.length > 0 ||
      asset.intelligence.modelTrace.some((trace) => trace.startsWith("paddleocr:") || trace === "ocr-empty")
  );
}

function cachedPaddleResult(asset: AssetRecord): Awaited<ReturnType<typeof runPaddleOcr>> {
  return {
    available: true,
    provider: "cached-paddleocr",
    language: findTraceValue(asset.intelligence.modelTrace, "ocr-language:") ?? "unknown",
    tokens: asset.intelligence.ocr.tokens,
    confidence: asset.intelligence.ocr.confidence,
    frames: asset.intelligence.ocr.frames
  };
}

function unavailablePaddleResult(error: string): Awaited<ReturnType<typeof runPaddleOcr>> {
  return {
    available: false,
    provider: "none",
    tokens: [],
    confidence: 0,
    frames: [],
    error
  };
}

function unavailableSpeechResult(error: string): Awaited<ReturnType<typeof runSpeechRuntime>> {
  return {
    whisper: {
      available: false,
      provider: "none",
      transcript: "",
      language: "unknown",
      confidence: 0,
      segments: [],
      error
    },
    diarization: {
      available: false,
      provider: "none",
      speakers: [],
      segments: [],
      error
    }
  };
}

function resolveCachedMediaPath(value: string | null | undefined) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.join(getPublicMediaRoot(), value);
}

function buildAudioIntelligence(audio: Awaited<ReturnType<typeof extractAudioAndVad>>): LocalIntelligence["audio"] {
  return {
    extractedPath: toPublicMediaPath(audio.extractedPath, getPublicMediaRoot()),
    vad: audio.vad,
    speechSegments: audio.speechSegments,
    musicSegments: audio.musicSegments,
    hasSpeech: audio.vad.available && audio.speechSegments.length > 0,
    hasMusic: audio.vad.available && audio.musicSegments.length > 0
  };
}

function buildOcrIntelligence(paddle: Awaited<ReturnType<typeof runPaddleOcr>>): LocalIntelligence["ocr"] {
  const tokens = paddle.available && paddle.tokens.length > 0 ? paddle.tokens : [];
  return {
    tokens,
    confidence: tokens.length > 0 ? paddle.confidence : 0,
    frames: paddle.frames
  };
}

function buildSpeechIntelligence(
  whisper: Awaited<ReturnType<typeof runSpeechRuntime>>["whisper"],
  diarization: Awaited<ReturnType<typeof runSpeechRuntime>>["diarization"]
): Pick<LocalIntelligence, "asr" | "diarization"> {
  const transcript = whisper.available && whisper.transcript.trim() ? whisper.transcript.trim() : "";
  return {
    asr: {
      transcript,
      language: whisper.language || (/[가-힣]/.test(transcript) ? "ko" : "en"),
      confidence: transcript ? whisper.confidence : 0,
      segments: applyDiarizationToAsrSegments(whisper.segments, diarization.segments)
    },
    diarization: {
      provider: diarization.available ? diarization.provider : "none",
      speakers: diarization.speakers,
      segments: diarization.segments,
      error: diarization.error ?? null
    }
  };
}

function buildVisualIntelligence(visual: Awaited<ReturnType<typeof inspectVisualFrames>>): LocalIntelligence["visual"] {
  return {
    available: visual.available,
    labels: visual.labels,
    dominantColor: visual.dominantColor,
    brightness: visual.brightness,
    motionScore: visual.motionScore,
    error: visual.error
  };
}

async function publishRuntimePartial(options: LocalModelRuntimeOptions, stage: string, partial: LocalRuntimePartial) {
  await options.onPartial?.(stage, partial);
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

function getLocalModelHeavyConcurrency() {
  const configured = Number(process.env.LOCAL_MODEL_RUNTIME_HEAVY_CONCURRENCY || 2);
  if (!Number.isFinite(configured)) return 1;
  return Math.max(1, Math.min(2, Math.floor(configured)));
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

function findTraceValue(traces: string[], prefix: string) {
  return traces.find((trace) => trace.startsWith(prefix))?.slice(prefix.length);
}
