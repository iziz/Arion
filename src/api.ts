import type { AssetRecord, JobRecord, MetricsSummary, SportsKnowledgeSnapshot } from "../shared/types";

export type DatabaseStatus = {
  enabled: boolean;
  storage?: string;
  postgres?: string;
  pgvector?: string | null;
  embeddingColumn?: string | null;
  expectedEmbeddingDimensions?: number;
  visualEmbeddingColumn?: string | null;
  expectedVisualEmbeddingDimensions?: number;
  migrations?: Array<{ version: string; description: string; applied_at: string }>;
  metrics: MetricsSummary;
};

export type ObservabilitySnapshot = {
  traceExporter: string;
  logFormat: string;
  logPath: string;
  latencyMetrics: Array<{
    key: string;
    count: number;
    errorCount: number;
    avgMs: number;
    p95Ms: number;
    lastMs: number;
    lastStatus: "ok" | "error";
    lastError: string | null;
  }>;
  modelRuntimeMetrics: ObservabilitySnapshot["latencyMetrics"];
  stageMetrics: ObservabilitySnapshot["latencyMetrics"];
  requestMetrics: ObservabilitySnapshot["latencyMetrics"];
  recentSpans: Array<{ traceId: string; spanId: string; name: string; durationMs: number; status: string }>;
  recentLogs: Array<{ timestamp: string; level: string; event: string; message: string; requestId: string | null; traceId: string | null }>;
};

export type FootballDataImportResult = {
  competitionCode: string;
  season: number;
  teams: number;
  players: number;
  matchActivities: number;
  facts: number;
  warnings: string[];
  snapshot: SportsKnowledgeSnapshot;
};

export type StatbunkerImportResult = {
  source: "kaggle" | "statbunker";
  path: string;
  files: number;
  players: number;
  matchActivities: number;
  facts: number;
  warnings: string[];
  snapshot: SportsKnowledgeSnapshot;
};

export type NflverseImportResult = {
  source: "nflverse";
  seasons: number[];
  teams: number;
  players: number;
  matchActivities: number;
  facts: number;
  warnings: string[];
  snapshot: SportsKnowledgeSnapshot;
};

export type DomainVlmBulkRefineResult = {
  indexId: string;
  queued: number;
  skipped: number;
  jobs: JobRecord[];
  skippedAssets: Array<{ assetId: string; reason: string }>;
};

export const emptyMetrics: MetricsSummary = {
  indexes: 0,
  assets: 0,
  indexedAssets: 0,
  runningJobs: 0,
  failedJobs: 0,
  totalDuration: 0,
  segments: 0,
  vectors: 0,
  webhooks: 0,
  billingUnits: 0
};

export const api = {
  async get<T>(url: string) {
    return readJson<T>(await fetch(url));
  },
  async post<T>(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson<T>(response);
  },
  async patch<T>(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson<T>(response);
  },
  async put<T>(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson<T>(response);
  },
  async delete<T>(url: string) {
    const response = await fetch(url, { method: "DELETE" });
    return readJson<T>(response);
  }
};

export function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  const payload = body ? parseJson(body) : null;
  if (!response.ok) {
    throw new Error(getErrorMessage(payload) ?? `Request failed with ${response.status}`);
  }
  if (payload === null) {
    throw new Error("Request returned an empty response");
  }
  return payload as T;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Request returned invalid JSON");
  }
}

function getErrorMessage(payload: unknown) {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
}

export function getArrayResult<T>(result: PromiseSettledResult<T[]>, label: string, failures: string[]) {
  if (result.status === "rejected") {
    failures.push(`${label}: ${getFailureMessage(result.reason)}`);
    return null;
  }
  if (!Array.isArray(result.value)) {
    failures.push(`${label}: invalid payload`);
    return null;
  }
  return result.value;
}

export function getGuardedResult<T>(result: PromiseSettledResult<T>, label: string, guard: (value: unknown) => value is T, failures: string[]) {
  if (result.status === "rejected") {
    failures.push(`${label}: ${getFailureMessage(result.reason)}`);
    return null;
  }
  if (!guard(result.value)) {
    failures.push(`${label}: invalid payload`);
    return null;
  }
  return result.value;
}

export function getFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isMetricsSummary(value: unknown): value is MetricsSummary {
  return (
    isRecord(value) &&
    ["indexes", "assets", "indexedAssets", "runningJobs", "failedJobs", "totalDuration", "segments", "vectors", "webhooks", "billingUnits"].every(
      (key) => typeof value[key] === "number"
    )
  );
}

export function isDatabaseStatus(value: unknown): value is DatabaseStatus {
  return isRecord(value) && typeof value.enabled === "boolean" && isMetricsSummary(value.metrics);
}

export function isObservabilitySnapshot(value: unknown): value is ObservabilitySnapshot {
  return (
    isRecord(value) &&
    typeof value.traceExporter === "string" &&
    typeof value.logFormat === "string" &&
    typeof value.logPath === "string" &&
    Array.isArray(value.latencyMetrics) &&
    Array.isArray(value.modelRuntimeMetrics) &&
    Array.isArray(value.stageMetrics) &&
    Array.isArray(value.requestMetrics) &&
    Array.isArray(value.recentSpans) &&
    Array.isArray(value.recentLogs)
  );
}

export function isSportsKnowledgeSnapshot(value: unknown): value is SportsKnowledgeSnapshot {
  return isRecord(value) && Array.isArray(value.competitions) && Array.isArray(value.teams) && Array.isArray(value.players);
}

export function isAssetUploadPayload(value: unknown): value is { asset: AssetRecord } {
  return isRecord(value) && isRecord(value.asset) && typeof value.asset.id === "string";
}

export function indexFormPayload(form: HTMLFormElement) {
  const data = new FormData(form);
  const domainEnabled = data.get("domainIndexingEnabled") === "on";
  const domainGroup = String(data.get("domainGroup") || "");
  const domainStages = data.getAll("domainStage").map(String);
  return {
    name: data.get("name"),
    description: data.get("description"),
    domainIndexing: {
      enabled: domainEnabled,
      groups: domainEnabled && (domainGroup === "sports.football" || domainGroup === "sports.american_football") ? [domainGroup] : [],
      stages: domainEnabled ? domainStages : []
    },
    capabilityPolicy: {
      whisperXDiarization: modeValue(data.get("capabilityWhisperX")),
      visionDetector: modeValue(data.get("capabilityVisionDetector")),
      visionTracker: modeValue(data.get("capabilityVisionTracker")),
      soccerNetActionSpotting: modeValue(data.get("capabilitySoccerNetAction")),
      domainVlmRefinement: modeValue(data.get("capabilityDomainVlm"))
    }
  };
}

function modeValue(value: FormDataEntryValue | null) {
  return value === "disabled" || value === "optional" || value === "required" ? value : "optional";
}
