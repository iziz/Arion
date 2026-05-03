import type { AssetRecord, IndexRecord, JobRecord } from "../shared/types";
import { formatDuration } from "./displayUtils";

export type FlowStepState = "done" | "active" | "waiting" | "skipped" | "error";

export type FlowStep = {
  id: string;
  label: string;
  detail: string;
  state: FlowStepState;
  progress: number | null;
  retryStage: string;
  serverProgress?: {
    status: JobRecord["status"];
    stage: string;
    progress: number;
  };
  helpText?: string;
};

export function getAssetFlow(asset: AssetRecord, index: IndexRecord | null, job: JobRecord | null): FlowStep[] {
  const hasProbe = Boolean(asset.duration || asset.width || asset.height || asset.technicalMetadata.videoCodec || asset.technicalMetadata.audioCodec);
  const hasAsr = Boolean(asset.intelligence.asr.transcript || asset.intelligence.asr.segments.length > 0);
  const hasOcr = asset.intelligence.ocr.tokens.length > 0;
  const hasVisual = Boolean(asset.keyframes.length > 0 || asset.intelligence.visual.labels.length > 0 || asset.intelligence.visual.dominantColor !== "#000000");
  const hasAudio = Boolean(asset.intelligence.audio?.extractedPath);
  const hasVad = Boolean(asset.intelligence.audio?.speechSegments?.length || asset.intelligence.audio?.musicSegments?.length);
  const hasDiarization = Boolean(asset.intelligence.diarization?.segments?.length);
  const isIndexed = asset.status === "indexed";
  const hasTimeline = asset.timeline.length > 0;
  const hasDomainEvents = asset.timeline.some((segment) => (segment.domain?.events.length ?? 0) > 0);
  const domainEventCount = asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
  const domainVlmSummary = getDomainVlmSummary(asset);
  const domainIndexingEnabled = Boolean(index?.domainIndexing?.enabled && index.domainIndexing.groups.length > 0);
  const hasEmbedding = isIndexed || asset.intelligence.modelTrace.some((trace) => trace.startsWith("embedding:"));
  const isFailed = asset.status === "failed" || (asset.status !== "indexed" && job?.status === "failed");
  const activeRuntimeStage = job?.status === "running" ? job.stage : "";
  const audioRuntimeStatus = getRuntimeStageStatus(job, "audio");
  const asrRuntimeStatus = getRuntimeStageStatus(job, "asr");
  const diarizationRuntimeStatus = getRuntimeStageStatus(job, "diarization");
  const ocrRuntimeStatus = getRuntimeStageStatus(job, "ocr");
  const visualRuntimeStatus = getRuntimeStageStatus(job, "visual");
  const hasActiveJob = job?.status === "queued" || job?.status === "running";
  const domainVlmRunning = hasActiveJob && job?.type === "asset.domain-vlm.refine";
  const storedWhisperFailure = asset.intelligence.modelTrace.find((trace) => trace.startsWith("whisper-unavailable:"));
  const storedDiarizationError = asset.intelligence.modelTrace.find((trace) => trace.startsWith("whisperx-unavailable:"))?.replace(/^whisperx-unavailable:/, "");
  const storedOcrFailure = asset.intelligence.modelTrace.find((trace) => trace.startsWith("paddleocr-unavailable:"))?.replace(/^paddleocr-unavailable:/, "");
  const whisperFailure = !hasActiveJob || asrRuntimeStatus === "failed" ? storedWhisperFailure : undefined;
  const diarizationError = !hasActiveJob || diarizationRuntimeStatus === "failed" ? asset.intelligence.diarization?.error || storedDiarizationError : undefined;
  const ocrFailure = !hasActiveJob || ocrRuntimeStatus === "failed" ? storedOcrFailure : undefined;
  const audioDone = hasAudio || audioRuntimeStatus === "succeeded";
  const vadDone = hasVad || audioRuntimeStatus === "succeeded";
  const asrDone = hasAsr || asrRuntimeStatus === "succeeded";
  const diarizationDone = hasDiarization || diarizationRuntimeStatus === "succeeded";
  const ocrDone = hasOcr || ocrRuntimeStatus === "succeeded";
  const visualDone = hasVisual || visualRuntimeStatus === "succeeded";
  const domainFlow = getDomainFlowState({
    domainIndexingEnabled,
    hasDomainEvents,
    hasActiveJob,
    isIndexed,
    job
  });

  const steps: Array<Omit<FlowStep, "progress" | "retryStage">> = [
    {
      id: "input",
      label: "Input video",
      detail: asset.originalName,
      state: isFailed ? "done" : "done"
    },
    {
      id: "probe",
      label: "Probe metadata",
      detail: hasProbe
        ? `${formatDuration(asset.duration ?? 0)} · ${asset.width && asset.height ? `${asset.width}x${asset.height}` : "media metadata"}`
        : isIndexed
          ? "No probe metadata was stored"
          : "Waiting for ffprobe",
      state: flowState(asset, ["probing"], hasProbe, isFailed)
    },
    {
      id: "audio",
      label: "Extract audio",
      detail: audioDone
        ? "16kHz mono WAV ready"
        : audioRuntimeStatus === "failed"
          ? "Audio extraction failed"
          : activeRuntimeStage === "runtime-audio"
            ? "Extracting audio"
            : isIndexed
              ? "No extracted audio artifact"
              : "Waiting for ffmpeg audio extraction",
      state: audioRuntimeStatus === "failed" && !audioDone ? "error" : audioDone ? "done" : activeRuntimeStage === "runtime-audio" ? "active" : flowState(asset, ["sampling"], audioDone, isFailed)
    },
    {
      id: "vad",
      label: "VAD + music regions",
      detail: hasVad
        ? `${asset.intelligence.audio?.speechSegments.length ?? 0} speech · ${asset.intelligence.audio?.musicSegments.length ?? 0} music`
        : vadDone
          ? "Speech/music detection complete"
        : audioRuntimeStatus === "failed"
          ? "Speech/music detection failed"
        : activeRuntimeStage === "runtime-audio"
          ? "Detecting speech/music regions"
        : isIndexed
          ? "No speech or music regions were detected"
          : "Waiting for speech/music detection",
      state: audioRuntimeStatus === "failed" && !vadDone ? "error" : vadDone ? "done" : activeRuntimeStage === "runtime-audio" ? "active" : flowState(asset, ["scanning"], vadDone, isFailed)
    },
    {
      id: "asr",
      label: "Whisper large-v3 ASR",
      detail: hasAsr
        ? `${asset.intelligence.asr.segments.length} segments · ${Math.round(asset.intelligence.asr.confidence * 100)}% confidence`
        : asrRuntimeStatus === "succeeded"
          ? "Whisper ASR complete"
        : asrRuntimeStatus === "failed"
          ? "Whisper ASR failed"
        : whisperFailure
          ? compactTraceFailure(whisperFailure)
        : isIndexed
          ? "No speech transcript was extracted"
          : activeRuntimeStage === "runtime-asr"
            ? "Running large-v3 transcription"
            : "Waiting for transcription",
      state: (asrRuntimeStatus === "failed" || whisperFailure) && !asrDone ? "error" : asrDone ? "done" : activeRuntimeStage === "runtime-asr" ? "active" : flowState(asset, ["transcribing"], asrDone, isFailed)
    },
    {
      id: "speakers",
      label: "WhisperX diarization",
      detail: hasDiarization
        ? `${asset.intelligence.diarization?.speakers.length ?? 0} speakers`
        : diarizationRuntimeStatus === "succeeded"
          ? "Speaker diarization complete"
        : diarizationRuntimeStatus === "failed"
          ? "Speaker diarization failed"
        : job?.stage === "diarization" || activeRuntimeStage === "runtime-diarization"
          ? "Running speaker diarization"
        : !asrDone && (job?.status === "queued" || job?.status === "running")
          ? "Waiting for ASR segments"
        : diarizationError
          ? compactTraceFailure(diarizationError)
          : "Optional: configure WHISPERX_HF_TOKEN",
      state: diarizationDone
        ? "done"
        : diarizationRuntimeStatus === "failed" && !diarizationError
          ? "error"
          : job?.stage === "diarization" || activeRuntimeStage === "runtime-diarization"
            ? "active"
            : !asrDone && (job?.status === "queued" || job?.status === "running")
              ? "waiting"
              : diarizationError || isIndexed
                ? "skipped"
                : flowState(asset, ["transcribing"], false, isFailed),
      helpText: hasDiarization
        ? undefined
        : diarizationError
          ? `WhisperX diarization was skipped because the local runtime returned: ${diarizationError}`
          : diarizationRuntimeStatus === "failed"
            ? "WhisperX diarization failed in the local runtime. Check the job logs for the exact stage error."
          : "Speaker diarization is optional. Configure WhisperX and WHISPERX_HF_TOKEN to enable it."
    },
    {
      id: "ocr",
      label: "PaddleOCR",
      detail: hasOcr
        ? `${asset.intelligence.ocr.tokens.length} tokens · ${Math.round(asset.intelligence.ocr.confidence * 100)}% confidence`
        : ocrRuntimeStatus === "succeeded"
          ? "PaddleOCR complete"
        : ocrRuntimeStatus === "failed"
          ? "PaddleOCR failed"
        : ocrFailure
          ? compactTraceFailure(ocrFailure)
        : activeRuntimeStage === "runtime-ocr"
          ? "Running PaddleOCR"
        : isIndexed
          ? "No frame text was detected"
          : "Waiting for frame text",
      state: (ocrRuntimeStatus === "failed" || ocrFailure) && !ocrDone ? "error" : ocrDone ? "done" : activeRuntimeStage === "runtime-ocr" ? "active" : flowState(asset, ["scanning"], ocrDone, isFailed),
      helpText: ocrFailure ? `PaddleOCR did not complete: ${ocrFailure}` : undefined
    },
    {
      id: "visual",
      label: "Visual sampling",
      detail: hasVisual
        ? `${asset.keyframes.length} keyframes · ${asset.intelligence.visual.dominantColor}`
        : visualRuntimeStatus === "succeeded"
          ? "Visual sampling complete"
          : visualRuntimeStatus === "failed"
            ? "Visual sampling failed"
            : activeRuntimeStage === "runtime-visual"
              ? "Sampling visual frames"
              : isIndexed
                ? "No visual samples were stored"
                : "Waiting for keyframes",
      state: visualRuntimeStatus === "failed" && !visualDone ? "error" : visualDone ? "done" : activeRuntimeStage === "runtime-visual" ? "active" : flowState(asset, ["sampling", "scanning"], visualDone, isFailed)
    },
    {
      id: "timeline",
      label: "Build searchable timeline",
      detail: hasTimeline ? `${asset.timeline.length} indexed moments` : isIndexed ? "No timeline moments were created" : "Waiting for timeline and embeddings",
      state: flowState(asset, ["embedding"], hasTimeline, isFailed)
    },
    {
      id: "domain",
      label: "Sports domain events + VLM",
      detail: domainVlmRunning
        ? `Qwen VLM refinement running · ${job?.progress ?? 0}%`
        : hasDomainEvents
          ? `${domainEventCount} event candidates${domainVlmSummary ? ` · ${domainVlmSummary}` : ""}`
          : domainFlow.detail,
      state: domainVlmRunning ? "active" : hasDomainEvents ? "done" : domainFlow.state,
      helpText: "Retry runs only the sports-domain VLM refinement pass and then rebuilds text vectors."
    },
    {
      id: "vector",
      label: "Embedding + vector index",
      detail: hasEmbedding ? "Text and visual vectors are ready" : job?.stage === "embed" ? "Writing vectors" : "Waiting for embeddings",
      state: flowState(asset, ["embedding"], hasEmbedding, isFailed)
    },
    {
      id: "ready",
      label: "Ready to ask or search",
      detail: isIndexed ? "Search and analysis are available" : job?.stage ?? "Finishing index",
      state: isFailed ? "error" : isIndexed ? "done" : asset.status === "embedding" ? "active" : "waiting"
    }
  ];

  return steps.map((step) => ({
    ...step,
    progress: getFlowStepProgress(step, asset, job),
    retryStage: step.id,
    serverProgress: getFlowStepServerProgress(step, job)
  }));
}

function getDomainVlmSummary(asset: AssetRecord) {
  const counts = asset.timeline.reduce(
    (sum, segment) => {
      const status = segment.domain?.vlm?.status;
      if (status) sum[status] += 1;
      return sum;
    },
    { refined: 0, invalid: 0, failed: 0, skipped: 0 }
  );
  const attempted = counts.refined + counts.invalid + counts.failed;
  if (attempted === 0) return "";
  return `VLM ${counts.refined}/${attempted} refined${counts.invalid ? `, ${counts.invalid} invalid` : ""}${counts.failed ? `, ${counts.failed} failed` : ""}`;
}

function getFlowStepServerProgress(step: Omit<FlowStep, "progress" | "retryStage">, job: JobRecord | null) {
  if (step.state !== "active") return undefined;
  if (job?.status !== "queued" && job?.status !== "running") return undefined;
  return {
    status: job.status,
    stage: job.stage,
    progress: job.progress
  };
}

function getRuntimeStageStatus(job: JobRecord | null, stage: string): "running" | "succeeded" | "failed" | null {
  if (!job) return null;
  for (let index = job.logs.length - 1; index >= 0; index -= 1) {
    const message = job.logs[index]?.message ?? "";
    if (message.startsWith(`[runtime:${stage}:running]`)) return "running";
    if (message.startsWith(`[runtime:${stage}:succeeded]`)) return "succeeded";
    if (message.startsWith(`[runtime:${stage}:failed]`)) return "failed";
  }
  if (job.stage === `runtime-${stage}`) return "running";
  if (job.stage === `runtime-${stage}-succeeded`) return "succeeded";
  if (job.stage === `runtime-${stage}-failed`) return "failed";
  return null;
}

function flowState(asset: AssetRecord, activeStatuses: AssetRecord["status"][], complete: boolean, isFailed: boolean): FlowStepState {
  if (isFailed && activeStatuses.includes(asset.status)) return "error";
  if (complete) return "done";
  if (activeStatuses.includes(asset.status)) return "active";
  if (asset.status === "indexed") return "skipped";
  return "waiting";
}

function getDomainFlowState({
  domainIndexingEnabled,
  hasDomainEvents,
  hasActiveJob,
  isIndexed,
  job
}: {
  domainIndexingEnabled: boolean;
  hasDomainEvents: boolean;
  hasActiveJob: boolean;
  isIndexed: boolean;
  job: JobRecord | null;
}): { detail: string; state: FlowStepState } {
  if (hasDomainEvents) return { detail: "Sports domain events are ready", state: "done" };

  const stage = job?.stage ?? "queued";
  const progress = job?.progress ?? 0;
  if (hasActiveJob) {
    if (!domainIndexingEnabled) {
      return {
        detail: `Indexing job running (${stage}); domain indexing is disabled for this asset group`,
        state: "active"
      };
    }
    if (stage === "domain-index") {
      return { detail: "Building sports domain event layer", state: "active" };
    }
    if (progress < 60) {
      return { detail: `Waiting for ASR/OCR/visual signals before domain events (${stage})`, state: "active" };
    }
    if (progress < 78) {
      return { detail: `Preparing sports domain events from timeline signals (${stage})`, state: "active" };
    }
    return { detail: `Finalizing vectors after domain event pass (${stage})`, state: "active" };
  }

  if (!domainIndexingEnabled) return { detail: "Disabled for this asset group", state: "skipped" };
  if (isIndexed) return { detail: "Skipped because no sports cues matched", state: "skipped" };
  return { detail: "Waiting for sports domain indexing", state: "waiting" };
}

function getFlowStepProgress(step: Omit<FlowStep, "progress" | "retryStage">, asset: AssetRecord, job: JobRecord | null) {
  if (step.state === "done") return 100;
  if (step.state === "waiting") return 0;
  if (step.state === "skipped") return null;
  if (step.state === "error") return null;

  const progress = job?.progress ?? asset.progress;
  const stage = job?.stage ?? asset.status;
  if (step.id === "speakers" && stage === "diarization") {
    if (progress >= 45) {
      return Math.max(5, Math.min(95, Math.round(((progress - 45) / 50) * 90) + 5));
    }
    return Math.max(5, Math.min(95, progress));
  }
  const ranges: Record<string, [number, number]> = {
    input: [0, 5],
    probe: [12, 38],
    audio: [38, 60],
    vad: [50, 60],
    asr: [50, 60],
    speakers: [45, 95],
    ocr: [50, 60],
    visual: [38, 72],
    timeline: [60, 78],
    domain: [50, 78],
    vector: [68, 100],
    ready: [78, 100]
  };
  const [start, end] = ranges[step.id] ?? [0, 100];
  const normalized = Math.round(((progress - start) / Math.max(1, end - start)) * 100);
  if (stage === "queued") return 0;
  return Math.max(5, Math.min(95, normalized));
}

export function getLatestAssetJob(jobs: JobRecord[], assetId: string) {
  const assetJobs = jobs.filter((job) => job.assetId === assetId);
  return (
    assetJobs.find((job) => job.status === "running" || job.status === "queued") ??
    [...assetJobs].filter((job) => job.status === "succeeded").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ??
    [...assetJobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ??
    null
  );
}

function compactTraceFailure(trace: string) {
  const detail = trace.replace(/^[^:]+:/, "").trim();
  if (!detail) return "Model execution failed";
  if (detail.includes("Python script timed out")) return "Model runtime exceeded the previous safety timeout";
  if (detail.includes("HF_TOKEN") || detail.includes("HF Hub")) return "Whisper failed while accessing Hugging Face model files";
  if (detail.includes("ModuleNotFoundError")) return detail.split("\n")[0];
  if (detail.includes("paddle_ocr_extract.py")) return "PaddleOCR command failed";
  if (detail.includes("whisperx_diarize.py")) return "WhisperX command failed";
  if (detail.includes("whisper_transcribe.py")) return "Whisper command failed";
  if (detail.includes("Command failed")) return "Whisper command failed";
  return detail.split("\n")[0].slice(0, 120);
}
