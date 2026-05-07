import path from "node:path";
import type { CapabilityMode, CapabilityPolicy, IndexRecord } from "../shared/types";
import { defaultCapabilityPolicy, normalizeCapabilityPolicy } from "./domainConfig";
import { getEmbeddingModelName, getExpectedEmbeddingDimensions } from "./localEmbeddingRuntime";
import { getExpectedVisualEmbeddingDimensions, getVisualEmbeddingModelName } from "./localVisualEmbeddingRuntime";
import { parsePythonJson, runPythonScriptOnExit } from "./modelRuntime/pythonProcess";
import { callPythonRuntimeService, getPythonRuntimeTopology, isPythonRuntimeServiceMode } from "./modelRuntime/pythonRuntimeService";
import { getVlmWorkerTopology } from "./vlmWorkerClient";
import { detectorBackend, detectorConfidence, detectorModel, rfDetrModel, trackerName } from "./vision/runtimeConfig";

export type CapabilityName = keyof CapabilityPolicy;

export class RequiredCapabilityUnavailableError extends Error {
  capability: CapabilityName;

  constructor(capability: CapabilityName, message: string) {
    super(message);
    this.name = "RequiredCapabilityUnavailableError";
    this.capability = capability;
  }
}

export function resolveCapabilityPolicy(index: IndexRecord): CapabilityPolicy {
  return normalizeCapabilityPolicy(index.capabilityPolicy ?? defaultCapabilityPolicy(index.domainIndexing), index.domainIndexing);
}

export function capabilityMode(index: IndexRecord, capability: CapabilityName): CapabilityMode {
  return resolveCapabilityPolicy(index)[capability];
}

export function isCapabilityEnabled(index: IndexRecord, capability: CapabilityName) {
  return capabilityMode(index, capability) !== "disabled";
}

export function isCapabilityRequired(index: IndexRecord, capability: CapabilityName) {
  return capabilityMode(index, capability) === "required";
}

export function assertCapabilityAvailable(index: IndexRecord, capability: CapabilityName, available: boolean, detail: string) {
  if (available || !isCapabilityRequired(index, capability)) return;
  throw new RequiredCapabilityUnavailableError(capability, `Required capability unavailable: ${capability}. ${detail}`);
}

export async function getRuntimeCapabilities() {
  const doctorScript = path.resolve("scripts", "model_doctor.py");
  const vlmTopology = getVlmWorkerTopology();
  let raw: Record<string, unknown> = {};
  let checkError: string | null = null;
  try {
    raw = isPythonRuntimeServiceMode("runtime")
      ? await callPythonRuntimeService<Record<string, unknown>>(
          "runtime",
          "/v1/model-doctor",
          {},
          { metricKey: "model.doctor.service" }
        )
      : parsePythonJson<Record<string, unknown>>(
          (
            await runPythonScriptOnExit([doctorScript], {
              maxBuffer: 1024 * 1024
            })
          ).stdout
        );
  } catch (error) {
    checkError = error instanceof Error ? error.message : "Model capability check failed";
  }
  const whisperCppReady = Boolean(raw.whisper_cpp && raw.whisper_cpp_model);
  const checked = !checkError;
  return {
    available: checked,
    error: checkError,
    checkedAt: new Date().toISOString(),
    python: String(raw.python ?? "unknown"),
    runtimeTopology: {
      python: getPythonRuntimeTopology(),
      vlm: vlmTopology
    },
    tools: checked
      ? {
          ffmpeg: Boolean(raw.ffmpeg),
          ffprobe: Boolean(raw.ffprobe)
        }
      : {},
    configuredModels: {
      asr: {
        provider: "Whisper",
        model: process.env.WHISPER_MODEL || "large-v3",
        backend: process.env.WHISPER_BACKEND || "auto",
        language: process.env.WHISPER_LANGUAGE || "auto"
      },
      diarization: {
        provider: "WhisperX",
        model: process.env.WHISPERX_MODEL || process.env.WHISPER_MODEL || "large-v3",
        language: process.env.WHISPER_LANGUAGE || "auto",
        tokenConfigured: Boolean(process.env.WHISPERX_HF_TOKEN || process.env.HF_TOKEN)
      },
      ocr: {
        provider: "PaddleOCR",
        language: process.env.PADDLEOCR_LANG || "auto",
        workers: parsePositiveInteger(process.env.PADDLEOCR_WORKERS, 2)
      },
      textEmbedding: {
        provider: "SentenceTransformers",
        model: getEmbeddingModelName(),
        dimensions: getExpectedEmbeddingDimensions()
      },
      visualEmbedding: {
        provider: "OpenCLIP",
        model: getVisualEmbeddingModelName(),
        dimensions: getExpectedVisualEmbeddingDimensions()
      },
      visionDetector: {
        provider: detectorBackend === "rfdetr" ? "RF-DETR" : detectorBackend === "ultralytics" ? "Ultralytics YOLO" : "Ultralytics YOLO / RF-DETR",
        backend: detectorBackend,
        model: detectorBackend === "rfdetr" ? rfDetrModel : detectorModel,
        fallbackModel: detectorBackend === "auto" ? rfDetrModel : null,
        confidence: detectorConfidence
      },
      visionTracker: {
        provider: "Ultralytics MOT",
        tracker: trackerName,
        confidence: process.env.VISION_TRACKER_CONF || "0.2",
        vidStride: process.env.VISION_TRACKER_VID_STRIDE || "3"
      },
      videoVlm: {
        provider: "Qwen2.5-VL worker",
        model: vlmTopology.model,
        enabled: vlmTopology.enabled
      },
      queryPlanner: {
        provider: "OpenAI",
        model: process.env.OPENAI_QUERY_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
        enabled: process.env.OPENAI_QUERY_PLANNER !== "off" && process.env.OPENAI_QUERY_PLANNER !== "false"
      }
    },
    models: checked
      ? {
          whisper: Boolean(raw.whisper || raw.faster_whisper || whisperCppReady),
          whisperx: Boolean(raw.whisperx && raw.whisperx_diarize && raw.pyannote_audio),
          paddleocr: Boolean(raw.paddleocr && raw.paddle),
          scenedetect: Boolean(raw.scenedetect),
          ultralytics: Boolean(raw.ultralytics),
          rfdetr: Boolean(raw.rfdetr),
          soccernet: Boolean(raw.soccernet),
          americanFootballActionSpotting: Boolean(raw.american_football_action_spotting),
          openClip: Boolean(raw.open_clip),
          sentenceTransformers: Boolean(raw.sentence_transformers),
          qwenVlm: Boolean(raw.qwen_vl_utils && (raw.mlx_vlm || raw.transformers))
        }
      : {},
    raw
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
