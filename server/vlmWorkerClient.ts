import path from "node:path";
import type { AssetRecord, DomainEvent, DomainVlmQuality, IndexRecord, PlayerIdentity, TimelineSegment } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_SEGMENTS = 80;

type VlmSportsEventResponse = {
  model?: string;
  provider?: string;
  caption?: string;
  eventType?: string;
  confidence?: number;
  labels?: string[];
  evidence?: string[];
  football?: {
    phase?: string;
    fieldZone?: string;
    passType?: string;
    receivingPlayer?: VlmPlayerRole;
    passingPlayer?: VlmPlayerRole;
    ballState?: string;
    attackingDirection?: string;
  };
  rawResponse?: string;
};

type VlmPlayerRole = {
  present?: boolean;
  name?: string | null;
  confidence?: number;
  trackId?: string | null;
};

export type VlmRefinementResult = {
  timeline: TimelineSegment[];
  refinedSegments: number;
  attemptedSegments: number;
  invalidSegments: number;
  failedSegments: number;
  skippedSegments: number;
  totalSegments: number;
  model: string;
  skipped: boolean;
  errors: string[];
};

export type VlmRefinementProgressEvent = {
  totalSegments: number;
  attemptedSegments: number;
  refinedSegments: number;
  invalidSegments: number;
  failedSegments: number;
  skippedSegments: number;
  segmentId: string | null;
  status: DomainVlmQuality["status"];
  message: string;
  progress: number;
};

export type VlmRefinementOptions = {
  maxSegments?: number;
  timeoutMs?: number;
  onProgress?: (event: VlmRefinementProgressEvent) => void | Promise<void>;
};

export function isVlmWorkerEnabled() {
  return Boolean(getVlmWorkerUrl());
}

export function getVlmWorkerModelName() {
  return process.env.VLM_WORKER_MODEL?.trim() || "qwen2.5-vl-local-worker";
}

export async function checkVlmWorkerHealth() {
  const url = getVlmWorkerUrl();
  if (!url) return { enabled: false, ok: false, model: getVlmWorkerModelName(), error: "VLM_WORKER_URL is not configured." };
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { enabled: true, ok: false, model: getVlmWorkerModelName(), error: `HTTP ${response.status}` };
    const body = (await response.json()) as { model?: string; backend?: string };
    return { enabled: true, ok: true, model: body.model ?? getVlmWorkerModelName(), backend: body.backend ?? "unknown" };
  } catch (error) {
    return { enabled: true, ok: false, model: getVlmWorkerModelName(), error: error instanceof Error ? error.message : "VLM worker health check failed." };
  }
}

export async function refineSportsDomainTimelineWithVlm(
  asset: AssetRecord,
  index: IndexRecord,
  timeline: TimelineSegment[],
  options: VlmRefinementOptions = {}
): Promise<VlmRefinementResult> {
  const url = getVlmWorkerUrl();
  const model = getVlmWorkerModelName();
  const domainEnabled = Boolean(index.domainIndexing?.enabled && index.domainIndexing.groups.includes("sports.football"));
  if (!url || !domainEnabled) {
    return {
      timeline,
      refinedSegments: 0,
      attemptedSegments: 0,
      invalidSegments: 0,
      failedSegments: 0,
      skippedSegments: timeline.length,
      totalSegments: 0,
      model,
      skipped: true,
      errors: []
    };
  }

  const maxSegments = Math.max(1, Number(options.maxSegments ?? process.env.VLM_MAX_SEGMENTS_PER_ASSET ?? DEFAULT_MAX_SEGMENTS));
  const timeoutMs = Math.max(5000, Number(options.timeoutMs ?? process.env.VLM_WORKER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
  const totalSegments = Math.min(maxSegments, timeline.filter(shouldRefineSegment).length);
  const errors: string[] = [];
  let refinedSegments = 0;
  let attemptedSegments = 0;
  let invalidSegments = 0;
  let failedSegments = 0;
  let skippedSegments = 0;
  const refined: TimelineSegment[] = [];

  for (const segment of timeline) {
    if (attemptedSegments >= maxSegments || !shouldRefineSegment(segment)) {
      skippedSegments += 1;
      refined.push(segment);
      continue;
    }
    attemptedSegments += 1;
    try {
      const response = await callVlmStructureEndpoint(url, asset, index, segment, timeoutMs);
      const next = mergeVlmResponse(asset, segment, response);
      if (next !== segment) {
        refinedSegments += 1;
        refined.push(next);
        await emitProgress(options, {
          totalSegments,
          attemptedSegments,
          refinedSegments,
          invalidSegments,
          failedSegments,
          skippedSegments,
          segmentId: segment.id,
          status: "refined",
          message: `VLM refined segment ${attemptedSegments}/${totalSegments}`,
          progress: getProgress(attemptedSegments, totalSegments)
        });
      } else {
        invalidSegments += 1;
        refined.push(markVlmQuality(segment, response, "invalid", "VLM response did not contain a usable caption and confidence.", null));
        await emitProgress(options, {
          totalSegments,
          attemptedSegments,
          refinedSegments,
          invalidSegments,
          failedSegments,
          skippedSegments,
          segmentId: segment.id,
          status: "invalid",
          message: `VLM returned invalid structure for segment ${attemptedSegments}/${totalSegments}`,
          progress: getProgress(attemptedSegments, totalSegments)
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "VLM refinement failed";
      failedSegments += 1;
      errors.push(`${segment.id}: ${message}`);
      refined.push(markVlmQuality(segment, null, "failed", "VLM refinement failed.", message));
      await emitProgress(options, {
        totalSegments,
        attemptedSegments,
        refinedSegments,
        invalidSegments,
        failedSegments,
        skippedSegments,
        segmentId: segment.id,
        status: "failed",
        message: `VLM failed for segment ${attemptedSegments}/${totalSegments}: ${message}`,
        progress: getProgress(attemptedSegments, totalSegments)
      });
    }
  }

  return {
    timeline: refined,
    refinedSegments,
    attemptedSegments,
    invalidSegments,
    failedSegments,
    skippedSegments,
    totalSegments,
    model,
    skipped: false,
    errors: errors.slice(0, 8)
  };
}

function getVlmWorkerUrl() {
  const value = process.env.VLM_WORKER_URL?.trim();
  return value ? value.replace(/\/+$/, "") : "";
}

function shouldRefineSegment(segment: TimelineSegment) {
  return Boolean(segment.domain || segment.thumbnailPath || segment.sceneData?.image.framePath || segment.sceneData?.image.thumbnailPath);
}

async function callVlmStructureEndpoint(url: string, asset: AssetRecord, index: IndexRecord, segment: TimelineSegment, timeoutMs: number) {
  const response = await fetch(`${url}/structure/sports-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      domain: "sports.football",
      ontologyVersion: "sports-domain-v1",
      model: getVlmWorkerModelName(),
      imagePath: resolveMediaPath(segment.thumbnailPath ?? segment.sceneData?.image.framePath ?? segment.sceneData?.image.thumbnailPath ?? null),
      asset: {
        id: asset.id,
        title: asset.title,
        description: asset.description,
        tags: asset.tags,
        indexId: asset.indexId
      },
      index: {
        id: index.id,
        name: index.name,
        domainIndexing: index.domainIndexing
      },
      segment: {
        id: segment.id,
        start: segment.start,
        end: segment.end,
        label: segment.label,
        transcript: segment.transcript,
        tags: segment.tags,
        sceneData: segment.sceneData,
        existingDomain: segment.domain
      }
    })
  });
  if (!response.ok) throw new Error(`VLM worker HTTP ${response.status}`);
  return (await response.json()) as VlmSportsEventResponse;
}

function resolveMediaPath(value: string | null) {
  if (!value || value.startsWith("http://") || value.startsWith("https://") || path.isAbsolute(value)) return value;
  return path.join(getPublicMediaRoot(), value);
}

async function emitProgress(options: VlmRefinementOptions, event: VlmRefinementProgressEvent) {
  if (!options.onProgress) return;
  await options.onProgress(event);
}

function getProgress(attemptedSegments: number, totalSegments: number) {
  if (totalSegments <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((attemptedSegments / totalSegments) * 100)));
}

function mergeVlmResponse(asset: AssetRecord, segment: TimelineSegment, response: VlmSportsEventResponse): TimelineSegment {
  const event = buildVlmDomainEvent(segment, response);
  if (!event) return segment;
  const base = segment.domain;
  const captions = unique([response.caption, ...(base?.captions ?? [])].filter(isNonEmpty));
  const labels = unique(["sports.football", ...event.labels, ...(response.labels ?? []), ...(base?.labels ?? [])].filter(isNonEmpty));
  const events = [event, ...(base?.events ?? [])].sort((a, b) => b.confidence - a.confidence).slice(0, 4);
  const searchText = [
    base?.searchText,
    `VLM caption: ${event.caption}.`,
    `VLM event: ${event.eventType}.`,
    event.football ? `VLM football: ${event.football.fieldZone} ${event.football.passType} receiver=${event.football.receivingPlayer.present}.` : "",
    response.evidence?.join(" ")
  ]
    .filter(isNonEmpty)
    .join(" ");

  return {
    ...segment,
    domain: {
      groups: unique(["sports.football", ...(base?.groups ?? [])]),
      captions,
      labels,
      events,
      scope: base?.scope,
      searchText,
      confidence: Number(Math.max(base?.confidence ?? 0, event.confidence).toFixed(2)),
      generatedBy: base?.generatedBy ? `${base.generatedBy}+vlm:${response.model ?? getVlmWorkerModelName()}` : `vlm:${response.model ?? getVlmWorkerModelName()}`,
      vlm: buildVlmQuality(response, "refined", "VLM event structure accepted.", null)
    },
    tags: unique([...segment.tags, ...labels]).slice(0, 32),
    sources: unique([...segment.sources, "domain" as const])
  };
}

function markVlmQuality(
  segment: TimelineSegment,
  response: VlmSportsEventResponse | null,
  status: DomainVlmQuality["status"],
  message: string,
  error: string | null
): TimelineSegment {
  if (!segment.domain) return segment;
  return {
    ...segment,
    domain: {
      ...segment.domain,
      vlm: buildVlmQuality(response, status, message, error)
    }
  };
}

function buildVlmQuality(
  response: VlmSportsEventResponse | null,
  status: DomainVlmQuality["status"],
  message: string,
  error: string | null
): DomainVlmQuality {
  return {
    provider: response?.provider ?? "qwen2.5-vl",
    model: response?.model ?? getVlmWorkerModelName(),
    status,
    attemptedAt: new Date().toISOString(),
    confidence: clampConfidence(response?.confidence ?? 0),
    message,
    rawResponse: truncateRaw(response?.rawResponse ?? null),
    error
  };
}

function buildVlmDomainEvent(segment: TimelineSegment, response: VlmSportsEventResponse): DomainEvent | null {
  const caption = response.caption?.trim();
  const confidence = clampConfidence(response.confidence ?? 0);
  if (!caption || confidence <= 0) return null;
  const football = response.football ?? {};
  const eventType = normalizeEventType(response.eventType);
  const passType = normalizePassType(football.passType);
  const fieldZone = normalizeFieldZone(football.fieldZone);
  const receiverPresent = Boolean(football.receivingPlayer?.present);
  const passerPresent = Boolean(football.passingPlayer?.present);
  const receiverIdentity = buildPlayerIdentity(football.receivingPlayer);
  const passerIdentity = buildPlayerIdentity(football.passingPlayer);
  const labels = unique([
    "sports.football",
    eventType !== "scene" ? `event.${eventType}` : "",
    passType !== "unknown" ? `pass.${passType}` : "",
    fieldZone !== "unknown" ? `zone.${fieldZone}` : "",
    receiverPresent ? "role.receiver" : "",
    passerPresent ? "role.passer" : "",
    receiverIdentity ? `player.${normalizeLabel(receiverIdentity.name)}` : "",
    passerIdentity ? `player.${normalizeLabel(passerIdentity.name)}` : "",
    ...(response.labels ?? [])
  ].filter(isNonEmpty));

  return {
    id: `${segment.id}-domain-vlm-1`,
    domain: "sports.football",
    ontologyVersion: "sports-domain-v1",
    caption,
    eventType,
    labels,
    confidence,
    evidence: {
      asr: snippets(segment.transcript),
      ocr: [
        ...(segment.sceneData?.text.subtitles ?? []),
        ...(segment.sceneData?.text.screenText ?? []),
        ...(segment.sceneData?.text.overlays ?? [])
      ].slice(0, 4),
      visual: [`VLM caption: ${caption}`, ...(response.evidence ?? [])].slice(0, 8),
      metadata: [response.provider ?? "vlm-worker", response.model ?? getVlmWorkerModelName()],
      heuristics: ["Structured by optional local VLM worker.", "Use verification checks before treating VLM output as ground truth."]
    },
    football: {
      phase: normalizePhase(football.phase),
      fieldZone,
      passType,
      receivingPlayer: {
        present: receiverPresent,
        confidence: receiverPresent ? clampConfidence(football.receivingPlayer?.confidence ?? confidence) : 0,
        trackId: football.receivingPlayer?.trackId ?? segment.sceneData?.vision?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: receiverPresent ? "estimated" : "not_configured",
        identity: receiverIdentity
      },
      passingPlayer: {
        present: passerPresent,
        confidence: passerPresent ? clampConfidence(football.passingPlayer?.confidence ?? confidence) : 0,
        trackId: football.passingPlayer?.trackId ?? null,
        trackingStatus: passerPresent ? "estimated" : "not_configured",
        identity: passerIdentity
      },
      ball: {
        state: normalizeBallState(football.ballState, passType, eventType),
        confidence: passType !== "unknown" || eventType === "shot" ? confidence : 0,
        trackingStatus: "estimated"
      },
      field: {
        calibrationStatus: fieldZone === "unknown" ? "not_configured" : "estimated",
        attackingDirection: normalizeDirection(football.attackingDirection),
        zoneConfidence: fieldZone === "unknown" ? 0 : confidence
      },
      limitations: [
        "This event was generated by a local VLM worker from sampled frames and indexed text.",
        "It is not calibrated player tracking, jersey recognition, or pitch homography."
      ]
    }
  };
}

function buildPlayerIdentity(role?: VlmPlayerRole): PlayerIdentity | null {
  const name = role?.name?.trim();
  if (!name) return null;
  return {
    name,
    confidence: clampConfidence(role?.confidence ?? 0.45),
    source: "vlm",
    evidence: ["Local VLM worker reported this player name."]
  };
}

function normalizeEventType(value?: string) {
  const normalized = normalize(value);
  if (/through.*receive|pass.*receive|receive/.test(normalized)) return "pass_receive";
  if (/shot|shoot|finish|goal/.test(normalized)) return "shot";
  if (/dribble|carry|take_on/.test(normalized)) return "dribble";
  if (/pressure|press/.test(normalized)) return "pressure";
  if (/save/.test(normalized)) return "save";
  if (/progressive/.test(normalized)) return "progressive_pass";
  return normalized || "scene";
}

function normalizePassType(value?: string): NonNullable<DomainEvent["football"]>["passType"] {
  const normalized = normalize(value);
  if (/through|in_behind|behind/.test(normalized)) return "through_ball";
  if (/cross/.test(normalized)) return "cross";
  if (/cutback|cut_back/.test(normalized)) return "cutback";
  if (/long/.test(normalized)) return "long_ball";
  if (/short|pass/.test(normalized)) return "short_pass";
  return "unknown";
}

function normalizeFieldZone(value?: string): NonNullable<DomainEvent["football"]>["fieldZone"] {
  const normalized = normalize(value);
  if (/penalty|box|area/.test(normalized)) return "penalty_area";
  if (/final|attacking/.test(normalized)) return "final_third";
  if (/middle|midfield/.test(normalized)) return "middle_third";
  if (/defensive|own/.test(normalized)) return "defensive_third";
  return "unknown";
}

function normalizePhase(value?: string): NonNullable<DomainEvent["football"]>["phase"] {
  const normalized = normalize(value);
  if (/set/.test(normalized)) return "set_piece";
  if (/transition|counter/.test(normalized)) return "transition";
  if (/attack/.test(normalized)) return "attack";
  return "unknown";
}

function normalizeBallState(value: string | undefined, passType: NonNullable<DomainEvent["football"]>["passType"], eventType: string): NonNullable<DomainEvent["football"]>["ball"]["state"] {
  const normalized = normalize(value);
  if (/shot/.test(normalized) || eventType === "shot") return "shot";
  if (/pass|travel/.test(normalized) || passType !== "unknown") return "pass_travel";
  if (/play/.test(normalized)) return "in_play";
  return "unknown";
}

function normalizeDirection(value?: string): NonNullable<DomainEvent["football"]>["field"]["attackingDirection"] {
  const normalized = normalize(value);
  if (/left.*right|ltr/.test(normalized)) return "left_to_right";
  if (/right.*left|rtl/.test(normalized)) return "right_to_left";
  return "unknown";
}

function normalize(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeLabel(value: string) {
  return normalize(value).replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
}

function truncateRaw(value: string | null) {
  if (!value) return null;
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

function snippets(text: string) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
