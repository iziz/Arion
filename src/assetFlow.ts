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
  trace?: string;
  serverProgress?: {
    status: JobRecord["status"];
    stage: string;
    progress: number;
  };
  helpText?: string;
};

export function getAssetFlow(asset: AssetRecord, index: IndexRecord | null, job: JobRecord | null): FlowStep[] {
  const traces = asset.intelligence.modelTrace ?? [];
  const hasActiveJob = job?.status === "queued" || job?.status === "running";
  const activeJobStage = hasActiveJob ? job.stage : "";
  const activeJobProgress = hasActiveJob ? job.progress : 0;
  const activeRuntimeStage = job?.status === "running" ? job.stage : "";
  const failureMessage = asset.error || job?.error || "";

  const hasProbe = Boolean(asset.duration || asset.width || asset.height || asset.technicalMetadata.videoCodec || asset.technicalMetadata.audioCodec);
  const hasAsr = Boolean(asset.intelligence.asr.transcript || asset.intelligence.asr.segments.length > 0);
  const hasOcr = asset.intelligence.ocr.tokens.length > 0;
  const hasVisual = Boolean(asset.keyframes.length > 0 || asset.intelligence.visual.labels.length > 0 || asset.intelligence.visual.dominantColor !== "#000000");
  const hasSceneData = asset.timeline.some((segment) => segment.scene || segment.sceneData);
  const hasKeyframes = asset.keyframes.some((keyframe) => Boolean(keyframe.path));
  const hasAudio = Boolean(asset.intelligence.audio?.extractedPath);
  const hasVad = Boolean(asset.intelligence.audio?.speechSegments?.length || asset.intelligence.audio?.musicSegments?.length);
  const hasDiarization = Boolean(asset.intelligence.diarization?.segments?.length);
  const isIndexed = asset.status === "indexed";
  const hasTimeline = asset.timeline.length > 0;
  const hasDomainEvents = asset.timeline.some((segment) => (segment.domain?.events.length ?? 0) > 0);
  const domainEventCount = asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
  const domainVlmSummary = getDomainVlmSummary(asset);
  const domainIndexingEnabled = Boolean(index?.domainIndexing?.enabled && index.domainIndexing.groups.length > 0);
  const isFootballDomain = Boolean(index?.domainIndexing?.groups.includes("sports.football"));
  const isFailed = asset.status === "failed" || (asset.status !== "indexed" && job?.status === "failed");

  const textEmbeddingTrace = findTrace(traces, "embedding:");
  const visualEmbeddingTrace = findTrace(traces, "visual-embedding:");
  const visualEmbeddingUnavailableTrace = findTrace(traces, "visual-embedding-unavailable:");
  const detectorTrace = findTrace(traces, "vision-detector:");
  const detectorUnavailableTrace = findTrace(traces, "vision-detector-unavailable:");
  const trackerTrace = findTrace(traces, "vision-tracker:");
  const trackerUnavailableTrace = findTrace(traces, "vision-tracker-unavailable:");
  const soccerNetTrace = findTrace(traces, "soccernet-action:");
  const soccerNetUnavailableTrace = findTrace(traces, "soccernet-action-unavailable:");
  const asrModel = findTraceValue(traces, "faster-whisper:");
  const hasTextEmbedding = Boolean(textEmbeddingTrace) || asset.timeline.some((segment) => segment.embedding.length > 0);

  const audioRuntimeStatus = getRuntimeStageStatus(job, "audio");
  const asrRuntimeStatus = getRuntimeStageStatus(job, "asr");
  const diarizationRuntimeStatus = getRuntimeStageStatus(job, "diarization");
  const ocrRuntimeStatus = getRuntimeStageStatus(job, "ocr");
  const visualRuntimeStatus = getRuntimeStageStatus(job, "visual");
  const domainVlmRunning = hasActiveJob && job?.type === "asset.domain-vlm.refine";

  const storedWhisperFailure = findTrace(traces, "whisper-unavailable:");
  const storedDiarizationError = findTrace(traces, "whisperx-unavailable:")?.replace(/^whisperx-unavailable:/, "");
  const storedOcrFailure = findTrace(traces, "paddleocr-unavailable:")?.replace(/^paddleocr-unavailable:/, "");
  const whisperFailure = !hasActiveJob || asrRuntimeStatus === "failed" ? storedWhisperFailure : undefined;
  const diarizationError = !hasActiveJob || diarizationRuntimeStatus === "failed" ? asset.intelligence.diarization?.error || storedDiarizationError : undefined;
  const ocrFailure = !hasActiveJob || ocrRuntimeStatus === "failed" ? storedOcrFailure : undefined;

  const audioDone = hasAudio || audioRuntimeStatus === "succeeded";
  const vadDone = hasVad || audioRuntimeStatus === "succeeded";
  const asrDone = hasAsr || asrRuntimeStatus === "succeeded";
  const diarizationDone = hasDiarization || diarizationRuntimeStatus === "succeeded";
  const ocrDone = hasOcr || ocrRuntimeStatus === "succeeded";
  const visualDone = hasVisual || visualRuntimeStatus === "succeeded";
  const sceneDone = hasSceneData || activeJobProgress >= 72;
  const timelineDone = hasTimeline || activeJobProgress >= 74;
  const keyframesDone = hasKeyframes || activeJobProgress >= 78;
  const textEmbeddingDone = hasTextEmbedding || activeJobProgress >= 88;
  const visualEmbeddingPassDone = Boolean(visualEmbeddingTrace || visualEmbeddingUnavailableTrace) || activeJobProgress >= 96;

  const detectorFailed = isFailed && /visionDetector|Detector/i.test(failureMessage);
  const trackerFailed = isFailed && /visionTracker|Tracker/i.test(failureMessage);
  const soccerNetFailed = isFailed && /soccerNetActionSpotting|SoccerNet/i.test(failureMessage);
  const domainVlmFailed = isFailed && /domainVlmRefinement|VLM_WORKER_URL|VLM/i.test(failureMessage);

  const detectorDisabled = index?.capabilityPolicy?.visionDetector === "disabled";
  const trackerDisabled = index?.capabilityPolicy?.visionTracker === "disabled";
  const soccerNetDisabled = index?.capabilityPolicy?.soccerNetActionSpotting === "disabled" || !isFootballDomain;
  const domainVlmDisabled = index?.capabilityPolicy?.domainVlmRefinement === "disabled" || !domainIndexingEnabled;

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
      state: "done"
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
      label: asrModel ? `Faster-Whisper ${asrModel} ASR` : "Faster-Whisper ASR",
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
                  ? "Running transcription"
                  : "Waiting for transcription",
      state: (asrRuntimeStatus === "failed" || whisperFailure) && !asrDone ? "error" : asrDone ? "done" : activeRuntimeStage === "runtime-asr" ? "active" : flowState(asset, ["transcribing"], asrDone, isFailed),
      trace: compactModelTrace(asrModel ? `faster-whisper:${asrModel}` : undefined)
    },
    {
      id: "speakers",
      label: "WhisperX diarization",
      detail: hasDiarization
        ? `${asset.intelligence.diarization?.speakers.length ?? 0} speakers`
        : diarizationRuntimeStatus === "succeeded"
          ? "Speaker diarization complete"
          : diarizationError
            ? compactTraceFailure(diarizationError)
          : diarizationRuntimeStatus === "failed"
            ? "Speaker diarization failed"
            : job?.stage === "diarization" || activeRuntimeStage === "runtime-diarization"
              ? "Running speaker diarization"
              : !asrDone && hasActiveJob
                ? "Waiting for ASR segments"
                : "Optional: configure WHISPERX_HF_TOKEN",
      state: diarizationDone
        ? "done"
        : diarizationRuntimeStatus === "failed" && !diarizationError
          ? "error"
          : job?.stage === "diarization" || activeRuntimeStage === "runtime-diarization"
            ? "active"
            : !asrDone && hasActiveJob
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
            : "Speaker diarization is optional. Configure WhisperX and WHISPERX_HF_TOKEN to enable it.",
      trace: compactModelTrace(findTrace(traces, "whisperx:") ?? findTrace(traces, "whisperx-unavailable:"))
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
      helpText: ocrFailure ? `PaddleOCR did not complete: ${ocrFailure}` : undefined,
      trace: compactModelTrace(findTrace(traces, "paddleocr:") ?? findTrace(traces, "paddleocr-unavailable:"))
    },
    {
      id: "visual",
      label: "Visual sampler",
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
      state: visualRuntimeStatus === "failed" && !visualDone ? "error" : visualDone ? "done" : activeRuntimeStage === "runtime-visual" ? "active" : flowState(asset, ["sampling", "scanning"], visualDone, isFailed),
      trace: compactModelTrace(findTrace(traces, "visual-source:") ?? findTrace(traces, "ffmpeg-visual-sampler:"))
    },
    {
      id: "scene",
      label: "Scene boundaries",
      detail: hasSceneData
        ? `${asset.timeline.length} timeline windows with scene data`
        : activeJobStage === "scene-detection"
          ? "Detecting shot boundaries"
          : sceneDone
            ? "Scene boundary pass completed"
            : isIndexed
              ? "No scene boundary data was stored"
              : "Waiting for scene detection",
      state: hasSceneData ? "done" : activeJobStage === "scene-detection" ? "active" : sceneDone ? "done" : isIndexed ? "skipped" : hasActiveJob ? "waiting" : flowState(asset, ["embedding"], false, isFailed)
    },
    {
      id: "timeline",
      label: "Build searchable timeline",
      detail: hasTimeline
        ? `${asset.timeline.length} indexed moments`
        : activeJobStage === "timeline"
          ? "Merging ASR, OCR, visual, and scene windows"
          : timelineDone
            ? "Timeline build completed"
            : isIndexed
              ? "No timeline moments were created"
              : "Waiting for timeline build",
      state: hasTimeline ? "done" : activeJobStage === "timeline" ? "active" : timelineDone ? "done" : isIndexed ? "skipped" : hasActiveJob ? "waiting" : flowState(asset, ["embedding"], false, isFailed)
    },
    {
      id: "keyframes",
      label: "Keyframes",
      detail: hasKeyframes
        ? `${asset.keyframes.length} keyframes stored`
        : activeJobStage === "keyframes"
          ? "Generating segment thumbnails"
          : keyframesDone
            ? "Keyframe generation completed"
            : isIndexed
              ? "No keyframes were stored"
              : "Waiting for keyframes",
      state: hasKeyframes ? "done" : activeJobStage === "keyframes" ? "active" : keyframesDone ? "done" : isIndexed ? "skipped" : hasActiveJob ? "waiting" : flowState(asset, ["embedding"], false, isFailed)
    },
    {
      id: "detector",
      label: "Vision detector",
      detail: detectorTrace
        ? formatDetectorTrace(detectorTrace)
        : detectorUnavailableTrace
          ? compactTraceFailure(detectorUnavailableTrace)
          : detectorDisabled
            ? "Disabled by capability policy"
            : detectorFailed
              ? failureMessage
              : activeJobStage === "vision-detection"
                ? "Running configured object detector"
                : activeJobProgress >= 80
                  ? "Detector pass completed"
                  : "Waiting for detector",
      state: detectorTrace
        ? "done"
        : detectorFailed
          ? "error"
          : detectorUnavailableTrace || detectorDisabled
            ? "skipped"
            : activeJobStage === "vision-detection"
              ? "active"
              : activeJobProgress >= 80
                ? "done"
                : isIndexed
                  ? "skipped"
                  : "waiting",
      trace: compactModelTrace(detectorTrace ?? detectorUnavailableTrace)
    },
    {
      id: "tracker",
      label: "Vision tracker",
      detail: trackerTrace
        ? formatTrackerTrace(trackerTrace)
        : trackerUnavailableTrace
          ? compactTraceFailure(trackerUnavailableTrace)
          : trackerDisabled
            ? "Disabled by capability policy"
            : trackerFailed
              ? failureMessage
              : activeJobStage === "vision-tracking"
                ? "Running configured tracker"
                : activeJobProgress >= 81
                  ? "Tracker pass completed"
                  : "Waiting for tracker",
      state: trackerTrace
        ? "done"
        : trackerFailed
          ? "error"
          : trackerUnavailableTrace || trackerDisabled
            ? "skipped"
            : activeJobStage === "vision-tracking"
              ? "active"
              : activeJobProgress >= 81
                ? "done"
                : isIndexed
                  ? "skipped"
                  : "waiting",
      trace: compactModelTrace(trackerTrace ?? trackerUnavailableTrace)
    },
    {
      id: "soccernet",
      label: "SoccerNet action spotting",
      detail: soccerNetTrace
        ? formatSoccerNetTrace(soccerNetTrace)
        : soccerNetUnavailableTrace
          ? compactTraceFailure(soccerNetUnavailableTrace)
          : soccerNetDisabled
            ? isFootballDomain
              ? "Disabled by capability policy"
              : "Not applicable to this domain group"
            : soccerNetFailed
              ? failureMessage
              : activeJobStage === "soccernet-action"
                ? "Running configured action spotter"
                : isIndexed
                  ? "Not configured or no action spots returned"
                  : "Waiting for football action spotting",
      state: soccerNetTrace
        ? "done"
        : soccerNetFailed
          ? "error"
          : soccerNetUnavailableTrace || soccerNetDisabled || isIndexed
            ? "skipped"
            : activeJobStage === "soccernet-action"
              ? "active"
              : activeJobProgress >= 82
                ? "done"
                : "waiting",
      trace: compactModelTrace(soccerNetTrace ?? soccerNetUnavailableTrace)
    },
    {
      id: "domain",
      label: "Sports domain events",
      detail: hasDomainEvents ? `${domainEventCount} event candidates${domainVlmSummary ? ` · ${domainVlmSummary}` : ""}` : domainFlow.detail,
      state: hasDomainEvents ? "done" : domainFlow.state
    },
    {
      id: "domainVlm",
      label: "Domain VLM refinement",
      detail: domainVlmRunning
        ? `VLM refinement running · ${job?.progress ?? 0}%`
        : domainVlmSummary
          ? domainVlmSummary
          : domainVlmFailed
            ? failureMessage
            : domainVlmDisabled
              ? "Disabled or not applicable"
              : isIndexed
                ? "Not configured or not requested"
                : "Waiting for domain event layer",
      state: domainVlmRunning
        ? "active"
        : domainVlmFailed
          ? "error"
          : domainVlmSummary
            ? "done"
            : domainVlmDisabled || isIndexed
              ? "skipped"
              : "waiting",
      helpText: "Retry runs only the sports-domain VLM refinement pass and then rebuilds text vectors.",
      trace: compactModelTrace(findTrace(traces, "domain-vlm:") ?? findTrace(traces, "domain-vlm-refine:"))
    },
    {
      id: "textEmbedding",
      label: "Text embedding",
      detail: textEmbeddingTrace
        ? formatEmbeddingTrace(textEmbeddingTrace)
        : hasTextEmbedding
          ? "Timeline embeddings stored"
          : activeJobStage === "embed"
            ? "Computing semantic text embeddings"
            : textEmbeddingDone
              ? "Semantic text embedding completed"
              : "Waiting for text embeddings",
      state: textEmbeddingTrace || hasTextEmbedding ? "done" : activeJobStage === "embed" ? "active" : textEmbeddingDone ? "done" : hasActiveJob ? "waiting" : flowState(asset, ["embedding"], false, isFailed),
      trace: compactModelTrace(textEmbeddingTrace)
    },
    {
      id: "visualEmbedding",
      label: "Visual embedding",
      detail: visualEmbeddingTrace
        ? formatVisualEmbeddingTrace(visualEmbeddingTrace)
        : visualEmbeddingUnavailableTrace
          ? compactTraceFailure(visualEmbeddingUnavailableTrace)
          : activeJobStage === "visual-embedding" || activeJobStage === "visual-embedding-unavailable"
            ? "Computing visual keyframe embeddings"
            : visualEmbeddingPassDone
              ? "Visual embedding pass completed"
              : isIndexed
                ? "No visual embedding trace was stored"
                : "Waiting for visual embeddings",
      state: visualEmbeddingTrace
        ? "done"
        : visualEmbeddingUnavailableTrace
          ? "skipped"
          : activeJobStage === "visual-embedding" || activeJobStage === "visual-embedding-unavailable"
            ? "active"
            : visualEmbeddingPassDone
              ? "done"
              : isIndexed
                ? "skipped"
                : hasActiveJob
                  ? "waiting"
                  : flowState(asset, ["embedding"], false, isFailed),
      trace: compactModelTrace(visualEmbeddingTrace ?? visualEmbeddingUnavailableTrace)
    },
    {
      id: "vector",
      label: "Vector upsert",
      detail: isIndexed
        ? "Asset vectors committed"
        : activeJobStage === "vector-upsert-text" || activeJobStage === "vector-upsert-visual"
          ? `Writing vectors (${activeJobStage})`
          : activeJobStage === "finalize"
            ? "Saving indexed asset record"
            : "Waiting for vector writes",
      state: isFailed
        ? "error"
        : isIndexed
          ? "done"
          : activeJobStage === "vector-upsert-text" || activeJobStage === "vector-upsert-visual" || activeJobStage === "finalize"
            ? "active"
            : hasActiveJob
              ? "waiting"
              : flowState(asset, ["embedding"], false, isFailed)
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
    retryStage: getRetryStage(step.id),
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
  if (!domainIndexingEnabled) return { detail: "Disabled for this asset group", state: "skipped" };

  const stage = job?.stage ?? "queued";
  const progress = job?.progress ?? 0;
  if (hasActiveJob) {
    if (stage === "domain-index") {
      return { detail: "Building sports domain event layer", state: "active" };
    }
    if (progress >= 82) {
      return { detail: "Domain event pass completed", state: "done" };
    }
    if (progress >= 78) {
      return { detail: `Preparing sports domain events (${stage})`, state: "active" };
    }
    return { detail: `Waiting for detector, tracker, and text signals (${stage})`, state: "waiting" };
  }

  if (isIndexed) return { detail: "Skipped because no trusted sports events were produced", state: "skipped" };
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
    scene: [68, 72],
    timeline: [68, 74],
    keyframes: [72, 78],
    detector: [78, 80],
    tracker: [80, 81],
    soccernet: [80, 82],
    domain: [81, 84],
    domainVlm: [82, 84],
    textEmbedding: [84, 88],
    visualEmbedding: [92, 96],
    vector: [88, 100],
    ready: [96, 100]
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
  if (detail.includes("WHISPERX_HF_TOKEN")) return "WhisperX diarization requires WHISPERX_HF_TOKEN or HF_TOKEN";
  if (detail.includes("HF_TOKEN") || detail.includes("HF Hub")) return "Whisper failed while accessing Hugging Face model files";
  if (detail.includes("ModuleNotFoundError")) return detail.split("\n")[0];
  if (detail.includes("paddle_ocr_extract.py")) return "PaddleOCR command failed";
  if (detail.includes("whisperx_diarize.py")) return "WhisperX command failed";
  if (detail.includes("whisper_transcribe.py")) return "Whisper command failed";
  if (detail.includes("Command failed")) return "Whisper command failed";
  return detail.split("\n")[0].slice(0, 120);
}

function findTrace(traces: string[], prefix: string) {
  return traces.find((trace) => trace.startsWith(prefix));
}

function findTraceValue(traces: string[], prefix: string) {
  return findTrace(traces, prefix)?.slice(prefix.length);
}

function compactModelTrace(trace: string | undefined) {
  if (!trace) return undefined;
  return trace.length > 96 ? `${trace.slice(0, 93)}...` : trace;
}

function formatDetectorTrace(trace: string) {
  const [provider, model, frames] = trace.slice("vision-detector:".length).split(":");
  return [provider, model, countLabel(frames, "frame")].filter(Boolean).join(" · ");
}

function formatTrackerTrace(trace: string) {
  const [provider, tracker, segments] = trace.slice("vision-tracker:".length).split(":");
  return [provider, tracker, countLabel(segments, "tracked segment")].filter(Boolean).join(" · ");
}

function formatSoccerNetTrace(trace: string) {
  const [model, spots] = trace.slice("soccernet-action:".length).split(":");
  return [model, countLabel(spots, "spot")].filter(Boolean).join(" · ");
}

function formatEmbeddingTrace(trace: string) {
  return trace.slice("embedding:".length) || "Text embedding completed";
}

function formatVisualEmbeddingTrace(trace: string) {
  return trace.slice("visual-embedding:".length) || "Visual embedding completed";
}

function countLabel(value: string | undefined, noun: string) {
  if (!value) return "";
  const count = Number(value);
  if (!Number.isFinite(count)) return value;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function getRetryStage(stepId: string) {
  const retryStages: Record<string, string> = {
    input: "input",
    probe: "probe",
    audio: "audio",
    vad: "vad",
    asr: "asr",
    speakers: "speakers",
    ocr: "ocr",
    visual: "visual",
    scene: "timeline",
    timeline: "timeline",
    keyframes: "timeline",
    detector: "visual",
    tracker: "visual",
    soccernet: "domain",
    domain: "domain",
    domainVlm: "domain",
    textEmbedding: "vector",
    visualEmbedding: "vector",
    vector: "vector",
    ready: "ready"
  };
  return retryStages[stepId] ?? stepId;
}
