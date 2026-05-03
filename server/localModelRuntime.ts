import type { AssetRecord, CapabilityMode, LocalIntelligence } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";
import { extractAudioAndVad } from "./modelRuntime/audioRuntime";
import { toPublicMediaPath } from "./modelRuntime/mediaPath";
import { runPaddleOcr } from "./modelRuntime/ocrRuntime";
import { applyDiarizationToAsrSegments, runSpeechRuntime } from "./modelRuntime/speechRuntime";
import { inspectAudioPresence, inspectVisualFrames } from "./modelRuntime/visualSampler";
import { runRuntimeStage, type RuntimeStageReporter } from "./modelRuntime/stageReporter";
import { logJson, recordLatency, traceAsync } from "./observability";

export { applyDiarizationToAsrSegments, runWhisperXDiarizationForAsset } from "./modelRuntime/speechRuntime";

export type LocalRuntimePartial = Partial<Pick<LocalIntelligence, "audio" | "asr" | "diarization" | "ocr" | "visual">>;

type LocalModelRuntimeOptions = {
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
  const audio = await runRuntimeStage(
    reportStage,
    "audio",
    "Extracting audio and detecting speech regions",
    () => traceAsync("model.audio_extract_vad", { assetId: asset.id }, () => extractAudioAndVad(filePath, asset.id, asset.duration), "model.audio_extract_vad")
  );
  const audioIntelligence = buildAudioIntelligence(audio);
  await publishRuntimePartial(options, "audio", { audio: audioIntelligence });
  const asrInput = audio.speechFocusedPath || audio.extractedPath || filePath;
  const [visual, waveform, paddle, speech] = await Promise.all([
    runRuntimeStage(
      reportStage,
      "visual",
      "Sampling visual frames",
      () => traceAsync("model.visual_sampler", { assetId: asset.id }, () => inspectVisualFrames(filePath), "model.visual_sampler"),
      (result) => (result.available ? null : (result.error ?? "Visual sampler returned no usable frames"))
    ).then(async (result) => {
      await publishRuntimePartial(options, "visual", { visual: buildVisualIntelligence(result) });
      return result;
    }),
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
    ).then(async (result) => {
      await publishRuntimePartial(options, "ocr", { ocr: buildOcrIntelligence(result) });
      return result;
    }),
    runSpeechRuntime(asrInput, asset, languageHints.whisperLanguage, reportStage, { diarizationMode: options.whisperXDiarization }).then(async (result) => {
      const speechIntelligence = buildSpeechIntelligence(result.whisper, result.diarization);
      await publishRuntimePartial(options, "asr", speechIntelligence);
      return result;
    })
  ]);
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
