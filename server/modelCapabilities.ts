import path from "node:path";
import type { CapabilityMode, CapabilityPolicy, IndexRecord } from "../shared/types";
import { defaultCapabilityPolicy, normalizeCapabilityPolicy } from "./domainConfig";
import { parsePythonJson, runPythonScriptOnExit } from "./modelRuntime/pythonProcess";
import { callPythonRuntimeService, getPythonRuntimeTopology, isPythonRuntimeServiceMode } from "./modelRuntime/pythonRuntimeService";
import { getVlmWorkerTopology } from "./vlmWorkerClient";

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
  const raw = isPythonRuntimeServiceMode("runtime")
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
  const whisperCppReady = Boolean(raw.whisper_cpp && raw.whisper_cpp_model);
  return {
    checkedAt: new Date().toISOString(),
    python: String(raw.python ?? "unknown"),
    runtimeTopology: {
      python: getPythonRuntimeTopology(),
      vlm: getVlmWorkerTopology()
    },
    tools: {
      ffmpeg: Boolean(raw.ffmpeg),
      ffprobe: Boolean(raw.ffprobe)
    },
    models: {
      whisper: Boolean(raw.whisper || raw.faster_whisper || whisperCppReady),
      whisperx: Boolean(raw.whisperx && raw.whisperx_diarize && raw.pyannote_audio),
      paddleocr: Boolean(raw.paddleocr && raw.paddle),
      scenedetect: Boolean(raw.scenedetect),
      ultralytics: Boolean(raw.ultralytics),
      rfdetr: Boolean(raw.rfdetr),
      soccernet: Boolean(raw.soccernet),
      openClip: Boolean(raw.open_clip),
      sentenceTransformers: Boolean(raw.sentence_transformers),
      qwenVlm: Boolean(raw.qwen_vl_utils && (raw.mlx_vlm || raw.transformers))
    },
    raw
  };
}
