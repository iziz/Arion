import { getContext, logJson, recordLatency } from "../observability";
import type { PythonProgressEvent } from "./pythonProgress";

type RuntimeServiceKind = "asr" | "ocr" | "vision" | "embedding" | "runtime";

type PythonRuntimeEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: string;
  detail?: unknown;
  progressEvents?: PythonProgressEvent[];
  stderr?: string;
  durationMs?: number;
};

type PythonRuntimeServiceOptions = {
  timeoutMs?: number;
  metricKey?: string;
  onProgress?: (event: PythonProgressEvent) => void | Promise<void>;
};

export class PythonRuntimeServiceError extends Error {
  endpoint: string;

  constructor(endpoint: string, message: string) {
    super(message);
    this.name = "PythonRuntimeServiceError";
    this.endpoint = endpoint;
  }
}

export function getPythonRuntimeMode() {
  const mode = String(process.env.PYTHON_RUNTIME_MODE || "service").trim().toLowerCase();
  return mode === "direct" ? "direct" : "service";
}

export function isPythonRuntimeServiceMode(kind: RuntimeServiceKind = "runtime") {
  const specificMode = getSpecificRuntimeMode(kind);
  if (specificMode) return specificMode === "service";
  if (getSpecificRuntimeServiceUrl(kind)) return true;
  return getPythonRuntimeMode() === "service";
}

export function getPythonRuntimeServiceUrl(kind: RuntimeServiceKind = "runtime") {
  return String(getSpecificRuntimeServiceUrl(kind) || process.env.PYTHON_RUNTIME_SERVICE_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
}

export function getPythonRuntimeTopology() {
  const categories: RuntimeServiceKind[] = ["asr", "ocr", "vision", "embedding"];
  const defaultMode = getPythonRuntimeMode();
  const categoryTopology = categories.map((kind) => {
    const explicitUrl = getSpecificRuntimeServiceUrl(kind);
    const mode = isPythonRuntimeServiceMode(kind) ? "service" : "direct";
    return {
      kind,
      mode,
      serviceUrl: mode === "service" ? getPythonRuntimeServiceUrl(kind) : null,
      splitByCategory: Boolean(explicitUrl)
    };
  });
  return {
    defaultMode,
    defaultServiceUrl: getPythonRuntimeServiceUrl("runtime"),
    boundary:
      categoryTopology.some((item) => item.splitByCategory)
        ? "category-services"
        : defaultMode === "service" ? "combined-service" : "direct-scripts",
    categories: categoryTopology
  };
}

export async function callPythonRuntimeService<T>(
  kind: RuntimeServiceKind,
  endpoint: string,
  payload: Record<string, unknown>,
  options: PythonRuntimeServiceOptions = {}
): Promise<T> {
  const url = `${getPythonRuntimeServiceUrl(kind)}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const timeoutMs = options.timeoutMs ?? parsePositiveInteger(process.env.PYTHON_RUNTIME_SERVICE_TIMEOUT_MS, 0);
  const attempts = Math.max(1, parsePositiveInteger(process.env.PYTHON_RUNTIME_SERVICE_ATTEMPTS, 1));
  const metricKey = options.metricKey ?? `python_runtime.service.${endpoint.replace(/^\/+/, "").replace(/[^a-z0-9_.-]+/gi, "_")}`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callPythonRuntimeServiceOnce<T>(kind, endpoint, url, payload, timeoutMs, metricKey, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const message = error instanceof Error ? error.message : "Python runtime service call failed";
      logJson("warn", `${metricKey}.retry`, "Retrying Python runtime service call", {
        kind,
        endpoint,
        serviceUrl: getPythonRuntimeServiceUrl(kind),
        attempt,
        attempts,
        error: message
      });
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new PythonRuntimeServiceError(endpoint, "Python runtime service call failed");
}

async function callPythonRuntimeServiceOnce<T>(
  kind: RuntimeServiceKind,
  endpoint: string,
  url: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  metricKey: string,
  options: PythonRuntimeServiceOptions
) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = performance.now();
  const current = getContext();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(current.requestId ? { "x-request-id": current.requestId } : {}),
        ...(current.jobId ? { "x-arion-job-id": current.jobId } : {}),
        ...(current.assetId ? { "x-arion-asset-id": current.assetId } : {})
      },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });
    const text = await response.text();
    const envelope = parseEnvelope<T>(endpoint, text);
    if (!response.ok || envelope.ok === false) {
      throw new PythonRuntimeServiceError(endpoint, envelope.error ?? formatDetail(envelope.detail) ?? `Python runtime service returned HTTP ${response.status}`);
    }
    for (const event of envelope.progressEvents ?? []) await options.onProgress?.(event);
    if (typeof envelope.result === "undefined") throw new PythonRuntimeServiceError(endpoint, "Python runtime service response did not include a result.");
    const durationMs = performance.now() - startedAt;
    recordLatency(metricKey, durationMs, "ok");
    logJson("info", metricKey, "Python runtime service call completed", {
      kind,
      endpoint,
      serviceUrl: getPythonRuntimeServiceUrl(kind),
      durationMs: Number(durationMs.toFixed(2)),
      serviceDurationMs: envelope.durationMs ?? null,
      stderr: envelope.stderr ? envelope.stderr.slice(-600) : null
    });
    return envelope.result;
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    const message = error instanceof Error ? error.message : "Python runtime service call failed";
    recordLatency(metricKey, durationMs, "error", message);
    logJson("error", metricKey, message, {
      kind,
      endpoint,
      serviceUrl: getPythonRuntimeServiceUrl(kind),
      durationMs: Number(durationMs.toFixed(2))
    });
    throw error instanceof PythonRuntimeServiceError ? error : new PythonRuntimeServiceError(endpoint, message);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseEnvelope<T>(endpoint: string, text: string): PythonRuntimeEnvelope<T> {
  try {
    return JSON.parse(text) as PythonRuntimeEnvelope<T>;
  } catch (error) {
    throw new PythonRuntimeServiceError(endpoint, `Python runtime service returned non-JSON response: ${text.slice(0, 240)}`);
  }
}

function formatDetail(detail: unknown) {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") return JSON.stringify(detail).slice(0, 1000);
  return null;
}

function getSpecificRuntimeMode(kind: RuntimeServiceKind) {
  const envKey = {
    asr: "ASR_RUNTIME_MODE",
    ocr: "OCR_RUNTIME_MODE",
    vision: "VISION_RUNTIME_MODE",
    embedding: "EMBEDDING_RUNTIME_MODE",
    runtime: "PYTHON_RUNTIME_MODE"
  }[kind];
  const mode = process.env[envKey]?.trim().toLowerCase();
  return mode === "service" || mode === "direct" ? mode : null;
}

function getSpecificRuntimeServiceUrl(kind: RuntimeServiceKind) {
  const envKey = {
    asr: "ASR_RUNTIME_SERVICE_URL",
    ocr: "OCR_RUNTIME_SERVICE_URL",
    vision: "VISION_RUNTIME_SERVICE_URL",
    embedding: "EMBEDDING_RUNTIME_SERVICE_URL",
    runtime: "PYTHON_RUNTIME_SERVICE_URL"
  }[kind];
  return process.env[envKey]?.trim() || "";
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function backoffMs(attempt: number) {
  return Math.min(5000, 250 * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
