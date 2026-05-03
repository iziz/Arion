import path from "node:path";
import type { AssetRecord, DomainVlmQuality, IndexRecord, TimelineSegment } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";
import { markVlmQuality, mergeVlmResponse, type VlmSportsEventResponse } from "./vlm/domainMapper";

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_SEGMENTS = 80;

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
  const domainEnabled = Boolean(index.domainIndexing?.enabled && index.domainIndexing.groups.length > 0);
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
      const domain = getVlmDomain(index, segment);
      const response = await callVlmStructureEndpoint(url, asset, index, segment, timeoutMs, domain);
      const next = mergeVlmResponse(asset, segment, response, domain, model);
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
        refined.push(markVlmQuality(segment, response, "invalid", "VLM response did not contain a usable caption and confidence.", null, model));
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
      refined.push(markVlmQuality(segment, null, "failed", "VLM refinement failed.", message, model));
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

function getVlmDomain(index: IndexRecord, segment?: TimelineSegment) {
  const segmentGroups = segment?.domain?.groups ?? [];
  if (segmentGroups.includes("sports.american_football") || index.domainIndexing?.groups.includes("sports.american_football")) return "sports.american_football";
  return "sports.football";
}

async function callVlmStructureEndpoint(url: string, asset: AssetRecord, index: IndexRecord, segment: TimelineSegment, timeoutMs: number, domain: string) {
  const response = await fetch(`${url}/structure/sports-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      domain,
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
