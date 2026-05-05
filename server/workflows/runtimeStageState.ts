import type { JobRecord } from "../../shared/types";

export type RuntimeStageEvent = {
  stage: string;
  status: "running" | "succeeded" | "failed";
  message: string;
  error?: string;
  progress?: number;
  log?: boolean;
  heartbeat?: boolean;
};

export function buildRuntimeStageJobUpdate(
  currentJob: JobRecord | null,
  event: RuntimeStageEvent,
  now: string,
  options: { keepJobStage?: boolean } = {}
) {
  const stage = event.status === "running" ? `runtime-${event.stage}` : `runtime-${event.stage}-${event.status}`;
  const level: JobRecord["logs"][number]["level"] = event.status === "failed" ? "warn" : "info";
  const previousStage = currentJob?.runtimeStages?.[event.stage];
  const previousRunningProgress = previousStage?.status === "running" ? previousStage.progress : 0;
  const eventProgress = getNormalizedRuntimeProgress(event.progress);
  const preservePreviousMessage =
    !event.error &&
    previousStage?.status === "running" &&
    previousStage?.message &&
    (event.heartbeat || (event.status === "running" && eventProgress !== null && eventProgress < previousRunningProgress));
  const message = event.error ? `${event.message}: ${event.error}` : preservePreviousMessage ? previousStage.message : event.message;
  const stageProgress = getRuntimeStageProgress(event, previousRunningProgress);
  const jobProgress = Math.max(currentJob?.progress ?? 0, getRuntimeJobProgress(event.stage, stageProgress));
  const runtimeStages = {
    ...(currentJob?.runtimeStages ?? {}),
    [event.stage]: {
      stage: event.stage,
      status: event.status,
      message,
      progress: stageProgress,
      error: event.error ?? null,
      startedAt: previousStage?.status === "running" ? previousStage.startedAt : now,
      updatedAt: now,
      completedAt: event.status === "running" ? null : now
    }
  } satisfies JobRecord["runtimeStages"];
  const logMessage = event.log === false || event.heartbeat ? undefined : `[runtime:${event.stage}:${event.status}] ${message}`;
  const nextJobStage = options.keepJobStage ? "local-model-runtime" : stage;
  return {
    patch: { stage: nextJobStage, progress: jobProgress, runtimeStages } satisfies Partial<JobRecord>,
    logMessage,
    level
  };
}

function getRuntimeStageProgress(event: { status: "running" | "succeeded" | "failed"; progress?: number }, previousProgress = 0) {
  if (event.status === "succeeded" || event.status === "failed") return 100;
  const progress = getNormalizedRuntimeProgress(event.progress);
  if (progress !== null) return Math.max(previousProgress, progress);
  return Math.max(0, Math.min(100, Math.round(previousProgress)));
}

function getNormalizedRuntimeProgress(value: unknown) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function getRuntimeJobProgress(stage: string, stageProgress: number) {
  const ranges: Record<string, [number, number]> = {
    audio: [40, 44],
    "audio-probe": [44, 46],
    visual: [44, 48],
    asr: [48, 52],
    diarization: [52, 54],
    ocr: [54, 58]
  };
  const [start, end] = ranges[stage] ?? [48, 52];
  const normalized = Math.max(0, Math.min(100, stageProgress)) / 100;
  return Math.round(start + (end - start) * normalized);
}
