import type { AssetRecord, IndexRecord, JobRecord } from "../shared/types";
import { formatKnowledgeSourceLabel, sourceListSupportsKnowledgeActionSpotting } from "../shared/knowledgeSources";
import { formatDuration } from "./displayUtils";
import {
  getActiveWorkflowNodeIds,
  getImpactedWorkflowNodeIds,
  getWorkflowNodeDescription,
  getWorkflowRetryStage,
  getWorkflowWaitingDetailForJob
} from "../shared/workflowNodes";

export type FlowStepState = "done" | "active" | "waiting" | "skipped" | "error";

export type FlowStep = {
  id: string;
  label: string;
  detail: string;
  description: string;
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
  const failureMessage = asset.error || job?.error || "";

  const hasProbe = Boolean(asset.duration || asset.width || asset.height || asset.technicalMetadata.videoCodec || asset.technicalMetadata.audioCodec);
  const hasAsr = Boolean(asset.intelligence.asr.transcript || asset.intelligence.asr.segments.length > 0);
  const hasOcr = asset.intelligence.ocr.tokens.length > 0;
  const hasSceneData = asset.timeline.some((segment) => segment.scene || segment.sceneData);
  const hasKeyframes = asset.keyframes.some((keyframe) => Boolean(keyframe.path));
  const hasVisual = Boolean(hasKeyframes || asset.intelligence.visual.labels.length > 0 || asset.intelligence.visual.dominantColor !== "#000000");
  const hasAudio = Boolean(asset.intelligence.audio?.extractedPath);
  const hasVad = Boolean(asset.intelligence.audio?.vad?.available || asset.intelligence.audio?.speechSegments?.length || asset.intelligence.audio?.musicSegments?.length);
  const hasDiarization = Boolean(asset.intelligence.diarization?.segments?.length);
  const isIndexed = asset.status === "indexed";
  const hasTimeline = asset.timeline.length > 0;
  const hasDomainEvents = asset.timeline.some((segment) => (segment.domain?.events.length ?? 0) > 0);
  const domainEventCount = asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
  const videoVlmSummary = getVideoVlmSummary(asset);
  const videoVlmJobProgress = getVideoVlmJobProgress(job);
  const videoVlmJobFailed = Boolean(videoVlmJobProgress?.failed && videoVlmJobProgress.failed > 0 && videoVlmJobProgress.described === 0);
  const domainVlmSummary = getDomainVlmSummary(asset);
  const summaryTrace = findTrace(traces, "summary:extractive-v1");
  const summarizedSegmentCount = asset.timeline.filter((segment) => Boolean(segment.summary?.trim())).length;
  const hasExtractiveSummaries = Boolean(asset.summary.trim() && summarizedSegmentCount > 0);
  const domainIndexingEnabled = Boolean(index?.domainIndexing?.enabled && index.domainIndexing.groups.length > 0);
  const knowledgeActionSupported = sourceListSupportsKnowledgeActionSpotting(index?.domainIndexing?.groups);
  const isFailed = asset.status === "failed" || (asset.status !== "indexed" && job?.status === "failed");

  const textEmbeddingTrace = findTrace(traces, "embedding:");
  const visualEmbeddingTrace = findTrace(traces, "visual-embedding:");
  const visualEmbeddingUnavailableTrace = findTrace(traces, "visual-embedding-unavailable:");
  const visualUnavailableTrace = findTrace(traces, "visual-unavailable:");
  const videoVlmTrace = findTrace(traces, "video-vlm:");
  const videoVlmUnavailableTrace = findTrace(traces, "video-vlm-unavailable:");
  const detectorTrace = findTrace(traces, "vision-detector:");
  const detectorUnavailableTrace = findTrace(traces, "vision-detector-unavailable:");
  const trackerTrace = findTrace(traces, "vision-tracker:");
  const trackerUnavailableTrace = findTrace(traces, "vision-tracker-unavailable:");
  const knowledgeActionTrace = findTrace(traces, "knowledge-action:") ?? findTrace(traces, "soccernet-action:");
  const knowledgeActionUnavailableTrace = findTrace(traces, "knowledge-action-unavailable:") ?? findTrace(traces, "soccernet-action-unavailable:");
  const asrModel = findTraceValue(traces, "faster-whisper:");
  const hasTextEmbedding = Boolean(textEmbeddingTrace) || asset.timeline.some((segment) => segment.embedding.length > 0);

  const audioRuntimeStatus = getRuntimeStageStatus(job, "audio");
  const asrRuntimeStatus = getRuntimeStageStatus(job, "asr");
  const diarizationRuntimeStatus = getRuntimeStageStatus(job, "diarization");
  const ocrRuntimeStatus = getRuntimeStageStatus(job, "ocr");
  const visualRuntimeStatus = getRuntimeStageStatus(job, "visual");
  const hasRunningRuntimeStage = job?.status === "running" && Object.values(job.runtimeStages ?? {}).some((stage) => stage.status === "running");
  const localRuntimeInProgress = hasActiveJob && (activeJobStage === "local-model-runtime" || activeJobStage.startsWith("runtime-") || hasRunningRuntimeStage);
  const assetIndexingInProgress = hasActiveJob && (job?.type === "asset.index" || job?.type === "asset.reindex");
  const domainVlmRunning = hasActiveJob && job?.type === "asset.domain-vlm.refine";
  const audioRuntimeRunning = audioRuntimeStatus === "running";
  const asrRuntimeRunning = asrRuntimeStatus === "running";
  const diarizationRuntimeRunning = diarizationRuntimeStatus === "running";
  const ocrRuntimeRunning = ocrRuntimeStatus === "running";
  const visualRuntimeRunning = visualRuntimeStatus === "running";
  const audioRuntimeFailed = isCurrentRuntimeStageFailure(job, "audio", audioRuntimeStatus);
  const asrRuntimeFailed = isCurrentRuntimeStageFailure(job, "asr", asrRuntimeStatus);
  const diarizationRuntimeFailed = isCurrentRuntimeStageFailure(job, "diarization", diarizationRuntimeStatus);
  const ocrRuntimeFailed = isCurrentRuntimeStageFailure(job, "ocr", ocrRuntimeStatus);
  const visualRuntimeFailed = isCurrentRuntimeStageFailure(job, "visual", visualRuntimeStatus);

  const storedWhisperFailure = findTrace(traces, "whisper-unavailable:");
  const storedDiarizationError = findTrace(traces, "whisperx-unavailable:")?.replace(/^whisperx-unavailable:/, "");
  const storedOcrFailure = findTrace(traces, "paddleocr-unavailable:")?.replace(/^paddleocr-unavailable:/, "");
  const whisperFailure = !hasActiveJob || asrRuntimeStatus === "failed" ? storedWhisperFailure : undefined;
  const diarizationError = !hasActiveJob || diarizationRuntimeStatus === "failed" ? asset.intelligence.diarization?.error || storedDiarizationError : undefined;
  const ocrFailure = !hasActiveJob || ocrRuntimeStatus === "failed" ? storedOcrFailure : undefined;

  const audioDone = hasAudio;
  const vadDone = hasVad;
  const asrDone = hasAsr;
  const diarizationDone = hasDiarization;
  const ocrDone = hasOcr;
  const visualDone = hasVisual;
  const audioRuntimeWaitingForMerge = localRuntimeInProgress && !hasAudio && (audioRuntimeStatus === "succeeded" || audioRuntimeStatus === "failed");
  const vadRuntimeWaitingForMerge = localRuntimeInProgress && !hasVad && (audioRuntimeStatus === "succeeded" || audioRuntimeStatus === "failed");
  const asrRuntimeWaitingForMerge = localRuntimeInProgress && !hasAsr && (asrRuntimeStatus === "succeeded" || asrRuntimeStatus === "failed");
  const diarizationRuntimeWaitingForMerge = localRuntimeInProgress && !hasDiarization && (diarizationRuntimeStatus === "succeeded" || diarizationRuntimeStatus === "failed");
  const ocrRuntimeWaitingForMerge = localRuntimeInProgress && !hasOcr && (ocrRuntimeStatus === "succeeded" || ocrRuntimeStatus === "failed");
  const visualRuntimeWaitingForMerge = localRuntimeInProgress && !visualDone && (visualRuntimeStatus === "succeeded" || visualRuntimeStatus === "failed");
  const scenePassCompleted = assetIndexingInProgress && activeJobProgress >= 72;
  const timelinePassCompleted = assetIndexingInProgress && activeJobProgress >= 74;
  const keyframesPassCompleted = assetIndexingInProgress && activeJobProgress >= 76;
  const videoVlmPassCompleted = assetIndexingInProgress && activeJobProgress >= 78;
  const detectorPassCompleted = assetIndexingInProgress && activeJobProgress >= 80;
  const trackerPassCompleted = assetIndexingInProgress && activeJobProgress >= 81;
  const knowledgeActionPassCompleted = assetIndexingInProgress && activeJobProgress >= 82;
  const summaryPassCompleted = assetIndexingInProgress && activeJobProgress >= 84;
  const textEmbeddingPassCompleted = assetIndexingInProgress && activeJobProgress >= 88;
  const visualEmbeddingPassCompleted = assetIndexingInProgress && activeJobProgress >= 96;

  const detectorFailed = isFailed && /visionDetector|Detector/i.test(failureMessage);
  const videoVlmFailed = isFailed && /videoVlmAnalysis|Video VLM|video-vlm/i.test(failureMessage);
  const trackerFailed = isFailed && /visionTracker|Tracker/i.test(failureMessage);
  const knowledgeActionFailed = isFailed && /knowledgeActionSpotting|soccerNetActionSpotting|Knowledge action|SoccerNet/i.test(failureMessage);
  const domainVlmFailed = isFailed && /domainVlmRefinement|(?:Sports event|Related knowledge) VLM|domain-vlm/i.test(failureMessage);
  const stalePreservedIndexedJob = Boolean(job?.status === "failed" && job.stage === "stale" && /(?:previous|partial) indexed data was preserved/i.test(failureMessage));
  const jobLogText = (job?.logs ?? []).map((entry) => entry.message).join("\n");
  const videoVlmInterruptedBeforeSave = stalePreservedIndexedJob && /Video VLM analysis completed|\[video-vlm:/i.test(jobLogText);
  const detectorInterruptedBeforeSave = stalePreservedIndexedJob && /Detecting players and ball candidates|stage\.vision_detection|vision-detection/i.test(jobLogText);
  const trackerInterruptedBeforeSave = stalePreservedIndexedJob && /Tracking players and ball candidates|stage\.vision_tracking|vision-tracking/i.test(jobLogText);

  const videoVlmDisabled = index?.capabilityPolicy?.videoVlmAnalysis === "disabled";
  const detectorDisabled = index?.capabilityPolicy?.visionDetector === "disabled";
  const trackerDisabled = index?.capabilityPolicy?.visionTracker === "disabled";
  const knowledgeActionDisabled = index?.capabilityPolicy?.knowledgeActionSpotting === "disabled" || !knowledgeActionSupported;
  const domainVlmDisabled = index?.capabilityPolicy?.domainVlmRefinement === "disabled" || !domainIndexingEnabled;

  const domainFlow = getDomainFlowState({
    domainIndexingEnabled,
    hasDomainEvents,
    hasActiveJob,
    assetIndexingInProgress,
    isIndexed,
    job
  });

  const steps: Array<Omit<FlowStep, "description" | "progress" | "retryStage">> = [
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
          ? skipped("indexing finished without stored probe metadata")
          : "Waiting for ffprobe",
      state: flowState(asset, ["probing"], hasProbe, isFailed)
    },
    {
      id: "audio",
      label: "Extract audio",
      detail: audioDone
        ? "16kHz mono WAV ready"
        : audioRuntimeRunning
          ? "Extracting audio"
          : audioRuntimeFailed
            ? formatCurrentRuntimeFailure(job, "audio", "Audio extraction")
          : audioRuntimeWaitingForMerge
            ? audioRuntimeStatus === "failed"
              ? "Audio extraction failed; waiting for local runtime merge"
              : "Audio extraction finished; waiting for local runtime merge"
        : audioRuntimeStatus === "failed"
          ? "Audio extraction failed"
          : localRuntimeInProgress
            ? "Waiting for audio extraction"
            : isIndexed
              ? skipped("indexing finished without an extracted audio artifact")
              : "Waiting for ffmpeg audio extraction",
      state: audioRuntimeFailed
        ? currentRuntimeFailureState(job, "audio")
        : audioDone
          ? "done"
          : audioRuntimeRunning
            ? "active"
            : audioRuntimeWaitingForMerge || localRuntimeInProgress
              ? "waiting"
              : flowState(asset, ["sampling"], audioDone, isFailed)
    },
    {
      id: "vad",
      label: "VAD + music regions",
      detail: hasVad
        ? `${asset.intelligence.audio?.speechSegments.length ?? 0} speech · ${asset.intelligence.audio?.musicSegments.length ?? 0} music`
        : audioRuntimeRunning
          ? "Detecting speech/music regions"
          : audioRuntimeFailed
            ? formatCurrentRuntimeFailure(job, "audio", "Speech/music detection")
          : vadRuntimeWaitingForMerge
            ? audioRuntimeStatus === "failed"
              ? "Speech/music detection failed; waiting for local runtime merge"
              : "Speech/music detection finished; waiting for local runtime merge"
        : vadDone
          ? "Speech/music detection complete"
          : audioRuntimeStatus === "failed"
            ? "Speech/music detection failed"
            : localRuntimeInProgress
              ? "Waiting for speech/music detection"
              : isIndexed
                ? skipped("audio analysis found no speech or music regions to store")
                : "Waiting for speech/music detection",
      state: audioRuntimeFailed
        ? currentRuntimeFailureState(job, "audio")
        : vadDone
          ? "done"
          : audioRuntimeRunning
            ? "active"
            : vadRuntimeWaitingForMerge || localRuntimeInProgress
              ? "waiting"
              : flowState(asset, ["scanning"], vadDone, isFailed)
    },
    {
      id: "asr",
      label: asrModel ? `Faster-Whisper ${asrModel} ASR` : "Faster-Whisper ASR",
      detail: asrRuntimeRunning
        ? "Running transcription"
        : asrRuntimeFailed
          ? formatCurrentRuntimeFailure(job, "asr", "Whisper ASR")
        : hasAsr
          ? `${asset.intelligence.asr.segments.length} segments · ${Math.round(asset.intelligence.asr.confidence * 100)}% confidence`
          : asrRuntimeWaitingForMerge
            ? asrRuntimeStatus === "failed"
              ? "Whisper ASR failed; waiting for local runtime merge"
              : "Whisper ASR finished; waiting for local runtime merge"
        : asrRuntimeStatus === "succeeded"
          ? skipped("Whisper ASR completed but no transcript segments were stored")
          : asrRuntimeStatus === "failed"
            ? "Whisper ASR failed"
            : whisperFailure
              ? compactTraceFailure(whisperFailure)
              : localRuntimeInProgress
                ? "Waiting for transcription"
              : isIndexed
                ? skipped("ASR produced no transcript segments for this indexed asset")
                : "Waiting for transcription",
      state: asrRuntimeFailed
        ? currentRuntimeFailureState(job, "asr")
        : whisperFailure && !asrDone
          ? "error"
        : asrRuntimeRunning
            ? "active"
          : asrDone
            ? "done"
            : asrRuntimeWaitingForMerge || localRuntimeInProgress
              ? "waiting"
              : asrRuntimeStatus === "succeeded"
                ? "skipped"
                : flowState(asset, ["transcribing"], asrDone, isFailed),
      trace: compactModelTrace(asrModel ? `faster-whisper:${asrModel}` : undefined)
    },
    {
      id: "speakers",
      label: "WhisperX diarization",
      detail: (job?.status === "running" && job.stage === "diarization") || diarizationRuntimeRunning
        ? "Running speaker diarization"
        : diarizationRuntimeFailed
          ? formatCurrentRuntimeFailure(job, "diarization", "Speaker diarization")
        : hasDiarization
          ? `${asset.intelligence.diarization?.speakers.length ?? 0} speakers`
          : diarizationRuntimeWaitingForMerge
            ? diarizationRuntimeStatus === "failed"
              ? "Speaker diarization failed; waiting for local runtime merge"
              : "Speaker diarization finished; waiting for local runtime merge"
        : diarizationRuntimeStatus === "succeeded"
          ? skipped("speaker diarization completed but no speaker segments were stored")
          : diarizationError
            ? skipped(compactTraceFailure(diarizationError))
          : diarizationRuntimeStatus === "failed"
            ? "Speaker diarization failed"
            : localRuntimeInProgress
              ? "Waiting for speaker diarization"
              : !asrDone && hasActiveJob
                ? "Waiting for ASR segments"
                : isIndexed
                  ? skipped("optional WhisperX diarization produced no speaker segments")
                  : "Optional: configure WHISPERX_HF_TOKEN",
      state: diarizationRuntimeFailed
          ? currentRuntimeFailureState(job, "diarization")
          : (job?.status === "running" && job.stage === "diarization") || diarizationRuntimeRunning
            ? "active"
          : diarizationDone
            ? "done"
            : diarizationRuntimeWaitingForMerge || localRuntimeInProgress
              ? "waiting"
              : diarizationRuntimeStatus === "succeeded"
                ? "skipped"
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
      detail: ocrRuntimeRunning
        ? "Running PaddleOCR"
        : ocrRuntimeFailed
          ? formatCurrentRuntimeFailure(job, "ocr", "PaddleOCR")
        : hasOcr
          ? `${asset.intelligence.ocr.tokens.length} tokens · ${Math.round(asset.intelligence.ocr.confidence * 100)}% confidence`
          : ocrRuntimeWaitingForMerge
            ? ocrRuntimeStatus === "failed"
              ? "PaddleOCR failed; waiting for local runtime merge"
              : "PaddleOCR finished; waiting for local runtime merge"
        : ocrRuntimeStatus === "succeeded"
          ? skipped("PaddleOCR completed but no frame text tokens were stored")
          : ocrRuntimeStatus === "failed"
            ? "PaddleOCR failed"
            : ocrFailure
              ? compactTraceFailure(ocrFailure)
              : localRuntimeInProgress
                ? "Waiting for PaddleOCR"
              : isIndexed
                ? skipped("PaddleOCR found no frame text tokens to store")
                : "Waiting for frame text",
      state: ocrRuntimeFailed
        ? currentRuntimeFailureState(job, "ocr")
        : ocrFailure && !ocrDone
          ? "error"
        : ocrRuntimeRunning
            ? "active"
          : ocrDone
            ? "done"
            : ocrRuntimeWaitingForMerge || localRuntimeInProgress
              ? "waiting"
              : ocrRuntimeStatus === "succeeded"
                ? "skipped"
                : flowState(asset, ["scanning"], ocrDone, isFailed),
      helpText: ocrFailure ? `PaddleOCR did not complete: ${ocrFailure}` : undefined,
      trace: compactModelTrace(findTrace(traces, "paddleocr:") ?? findTrace(traces, "paddleocr-unavailable:"))
    },
    {
      id: "visual",
      label: "Coarse visual profile",
      detail: hasVisual
        ? `Coarse frame profile · ${asset.intelligence.visual.dominantColor}`
        : visualRuntimeRunning
          ? "Sampling visual frames"
          : visualRuntimeFailed
            ? formatCurrentRuntimeFailure(job, "visual", "Visual sampling")
          : visualRuntimeWaitingForMerge
            ? visualRuntimeStatus === "failed"
              ? "Visual sampler returned no usable frames; waiting for local runtime merge"
              : "Visual sampler finished; waiting for local runtime merge"
            : visualRuntimeStatus === "failed"
              ? "Visual sampling failed"
              : visualUnavailableTrace
                ? skipped(compactTraceFailure(visualUnavailableTrace))
                : visualRuntimeStatus === "succeeded"
                  ? skipped("visual sampler completed but no keyframes or visual samples were stored")
                  : localRuntimeInProgress
                    ? "Waiting for visual sampler"
                    : isIndexed
                      ? skipped("indexing finished without stored visual samples")
                      : "Waiting for visual profile sampling",
      state: visualRuntimeFailed
        ? currentRuntimeFailureState(job, "visual")
        : visualDone
          ? "done"
          : visualRuntimeRunning
            ? "active"
            : visualRuntimeWaitingForMerge || localRuntimeInProgress
              ? "waiting"
            : visualUnavailableTrace || visualRuntimeStatus === "succeeded" || isIndexed
              ? "skipped"
              : flowState(asset, ["sampling", "scanning"], visualDone, isFailed),
      helpText: !hasVisual && (visualUnavailableTrace || visualRuntimeStatus === "succeeded")
        ? "Visual sampling did not produce stored frames. Check ffmpeg visual sampler output and reindex this asset if visual search is required."
        : undefined,
      trace: compactModelTrace(findTrace(traces, "visual-source:") ?? visualUnavailableTrace ?? findTrace(traces, "ffmpeg-visual-sampler:"))
    },
    {
      id: "scene",
      label: "Scene boundaries",
      detail: hasSceneData
        ? `${asset.timeline.length} timeline windows with scene data`
        : activeJobStage === "scene-detection"
          ? "Detecting shot boundaries"
          : scenePassCompleted
            ? waitingForIndexedAssetSave("Scene boundary")
            : isIndexed
              ? skipped("indexing finished without stored scene boundary data")
              : "Waiting for scene detection",
      state: hasSceneData ? "done" : activeJobStage === "scene-detection" ? "active" : scenePassCompleted || hasActiveJob ? "waiting" : isIndexed ? "skipped" : flowState(asset, ["embedding"], false, isFailed)
    },
    {
      id: "timeline",
      label: "Build searchable timeline",
      detail: hasTimeline
        ? `${asset.timeline.length} indexed moments`
        : activeJobStage === "timeline"
          ? "Merging ASR, OCR, visual, and scene windows"
          : timelinePassCompleted
            ? waitingForIndexedAssetSave("Timeline build")
            : isIndexed
              ? skipped("indexing finished without searchable timeline moments")
              : "Waiting for timeline build",
      state: hasTimeline ? "done" : activeJobStage === "timeline" ? "active" : timelinePassCompleted || hasActiveJob ? "waiting" : isIndexed ? "skipped" : flowState(asset, ["embedding"], false, isFailed)
    },
    {
      id: "keyframes",
      label: "Keyframes",
      detail: hasKeyframes
        ? `${asset.keyframes.length} keyframes stored`
        : activeJobStage === "keyframes"
          ? "Generating segment thumbnails"
          : keyframesPassCompleted
            ? waitingForIndexedAssetSave("Keyframe generation")
            : isIndexed
              ? skipped("indexing finished without stored keyframe files")
              : "Waiting for keyframes",
      state: hasKeyframes ? "done" : activeJobStage === "keyframes" ? "active" : keyframesPassCompleted || hasActiveJob ? "waiting" : isIndexed ? "skipped" : flowState(asset, ["embedding"], false, isFailed),
      helpText: !hasKeyframes && isIndexed
        ? "No keyframe files are stored for this asset. Visual search, detector input, and timeline thumbnails are limited until keyframes are regenerated."
        : undefined
    },
    {
      id: "videoVlm",
      label: "Video VLM analysis",
      detail: videoVlmSummary
        ? videoVlmSummary
        : activeJobStage === "video-vlm"
          ? videoVlmJobProgress
            ? `Analyzing timeline keyframes ${videoVlmJobProgress.attempted}/${videoVlmJobProgress.total}`
            : "Analyzing timeline keyframes"
          : videoVlmTrace
            ? formatVideoVlmTrace(videoVlmTrace)
            : videoVlmUnavailableTrace
              ? skipped(compactTraceFailure(videoVlmUnavailableTrace))
              : videoVlmDisabled
                ? skipped(`video VLM analysis is ${index?.capabilityPolicy?.videoVlmAnalysis ?? "disabled"} in the asset group capability policy`)
                : videoVlmFailed
                  ? failureMessage
                    : videoVlmPassCompleted
                      ? videoVlmJobProgress
                        ? videoVlmJobProgress.failed
                          ? `Video VLM completed: ${videoVlmJobProgress.described ?? 0}/${videoVlmJobProgress.total} described, ${videoVlmJobProgress.failed} failed`
                          : `Video VLM pass finished (${videoVlmJobProgress.attempted}/${videoVlmJobProgress.total}); waiting for indexed asset record save`
                        : waitingForIndexedAssetSave("Video VLM analysis")
                    : videoVlmInterruptedBeforeSave
                      ? interruptedBeforeSave("Video VLM output")
                    : isIndexed
                      ? skipped("indexing finished without stored video VLM scene analysis")
                      : "Waiting for video VLM analysis",
      state: videoVlmSummary || videoVlmTrace
        ? "done"
        : videoVlmFailed || videoVlmJobFailed || videoVlmInterruptedBeforeSave
          ? "error"
          : videoVlmUnavailableTrace || videoVlmDisabled
            ? "skipped"
            : activeJobStage === "video-vlm"
              ? "active"
              : videoVlmPassCompleted || hasActiveJob
                ? "waiting"
                : isIndexed
                  ? "skipped"
                  : "waiting",
      trace: compactModelTrace(videoVlmTrace ?? videoVlmUnavailableTrace)
    },
    {
      id: "detector",
      label: "Vision detector",
      detail: detectorTrace
        ? formatDetectorTrace(detectorTrace)
        : detectorUnavailableTrace
          ? skipped(compactTraceFailure(detectorUnavailableTrace))
          : detectorDisabled
            ? skipped(`vision detector is ${index?.capabilityPolicy?.visionDetector ?? "disabled"} in the asset group capability policy`)
            : detectorFailed
              ? failureMessage
              : detectorInterruptedBeforeSave
                ? interruptedBeforeSave("detector output")
              : activeJobStage === "vision-detection"
                ? "Running configured object detector"
                : detectorPassCompleted
                  ? waitingForIndexedAssetSave("Detector")
                  : isIndexed
                    ? skipped("indexing finished without a detector trace or stored detection output")
                    : "Waiting for detector",
      state: detectorTrace
        ? "done"
        : detectorFailed || detectorInterruptedBeforeSave
          ? "error"
          : detectorUnavailableTrace || detectorDisabled
            ? "skipped"
            : activeJobStage === "vision-detection"
              ? "active"
              : detectorPassCompleted || hasActiveJob
                ? "waiting"
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
          ? skipped(compactTraceFailure(trackerUnavailableTrace))
          : trackerDisabled
            ? skipped(`vision tracker is ${index?.capabilityPolicy?.visionTracker ?? "disabled"} in the asset group capability policy`)
            : trackerFailed
              ? failureMessage
              : trackerInterruptedBeforeSave
                ? interruptedBeforeSave("tracker output")
              : activeJobStage === "vision-tracking"
                ? "Running configured tracker"
                : trackerPassCompleted
                  ? waitingForIndexedAssetSave("Tracker")
                  : isIndexed
                    ? skipped("indexing finished without a tracker trace or stored tracking output")
                    : "Waiting for tracker",
      state: trackerTrace
        ? "done"
        : trackerFailed || trackerInterruptedBeforeSave
          ? "error"
          : trackerUnavailableTrace || trackerDisabled
            ? "skipped"
            : activeJobStage === "vision-tracking"
              ? "active"
              : trackerPassCompleted || hasActiveJob
                ? "waiting"
                : isIndexed
                  ? "skipped"
                  : "waiting",
      trace: compactModelTrace(trackerTrace ?? trackerUnavailableTrace)
    },
    {
      id: "knowledgeAction",
      label: "Knowledge action spotting",
      detail: knowledgeActionTrace
        ? formatKnowledgeActionTrace(knowledgeActionTrace)
        : knowledgeActionUnavailableTrace
          ? skipped(compactTraceFailure(knowledgeActionUnavailableTrace))
          : knowledgeActionDisabled
            ? index?.capabilityPolicy?.knowledgeActionSpotting === "disabled"
              ? skipped(`knowledge action spotting is ${index.capabilityPolicy.knowledgeActionSpotting} in the asset group capability policy`)
              : skipped(`selected related knowledge source does not expose action spotting: ${formatDomainGroups(index)}`)
            : knowledgeActionFailed
              ? failureMessage
              : activeJobStage === "knowledge-action" || activeJobStage === "soccernet-action"
                ? "Running configured template/action generator"
                : knowledgeActionPassCompleted
                  ? waitingForIndexedAssetSave("Knowledge action spotting")
                : isIndexed
                  ? skipped("optional knowledge action spotting did not run for this indexed asset")
                  : "Waiting for knowledge action spotting",
      state: knowledgeActionTrace
        ? "done"
        : knowledgeActionFailed
          ? "error"
          : knowledgeActionUnavailableTrace || knowledgeActionDisabled || isIndexed
            ? "skipped"
            : activeJobStage === "knowledge-action" || activeJobStage === "soccernet-action"
              ? "active"
              : knowledgeActionPassCompleted || hasActiveJob
                ? "waiting"
                : "waiting",
      trace: compactModelTrace(knowledgeActionTrace ?? knowledgeActionUnavailableTrace)
    },
    {
      id: "domain",
      label: "Related knowledge events",
      detail: hasDomainEvents ? `${domainEventCount} event candidates${domainVlmSummary ? ` · ${domainVlmSummary}` : ""}` : domainFlow.detail,
      state: hasDomainEvents ? "done" : domainFlow.state
    },
    {
      id: "domainVlm",
      label: "Related knowledge VLM refinement",
      detail: domainVlmRunning
        ? `Related knowledge VLM refinement running · ${job?.progress ?? 0}%`
        : domainVlmSummary
          ? domainVlmSummary
          : domainVlmFailed
            ? failureMessage
            : domainVlmDisabled
              ? !domainIndexingEnabled
                ? skipped("related knowledge VLM refinement requires related knowledge indexing for this asset group")
                : skipped(`related knowledge VLM refinement is ${index?.capabilityPolicy?.domainVlmRefinement ?? "disabled"} in the asset group capability policy`)
              : isIndexed
                ? hasDomainEvents
                  ? skipped("indexing finished without any stored related knowledge VLM refinement result")
                  : skipped("no related knowledge events were available for VLM refinement")
                : "Waiting for related knowledge event layer",
      state: domainVlmRunning
        ? "active"
        : domainVlmFailed
          ? "error"
          : domainVlmSummary
            ? "done"
            : domainVlmDisabled || isIndexed
              ? "skipped"
              : "waiting",
      helpText: "Retry runs only the related knowledge VLM refinement pass and then rebuilds text vectors.",
      trace: compactModelTrace(findTrace(traces, "domain-vlm:") ?? findTrace(traces, "domain-vlm-refine:"))
    },
    {
      id: "summary",
      label: "Extractive summaries",
      detail: hasExtractiveSummaries
        ? `${summarizedSegmentCount}/${asset.timeline.length} moment summaries · asset summary ready`
        : activeJobStage === "summary"
          ? "Building deterministic asset and moment summaries"
          : summaryPassCompleted
            ? waitingForIndexedAssetSave("Extractive summaries")
            : isIndexed
              ? skipped("indexing finished without stored extractive summaries")
              : "Waiting for extractive summaries",
      state: hasExtractiveSummaries || summaryTrace
        ? "done"
        : activeJobStage === "summary"
          ? "active"
          : summaryPassCompleted || hasActiveJob
            ? "waiting"
            : isIndexed
              ? "skipped"
              : "waiting",
      trace: compactModelTrace(summaryTrace)
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
            : textEmbeddingPassCompleted
              ? waitingForIndexedAssetSave("Text embedding")
              : isIndexed
                ? skipped("indexing finished without a stored text embedding trace")
                : "Waiting for text embeddings",
      state: textEmbeddingTrace || hasTextEmbedding ? "done" : activeJobStage === "embed" ? "active" : textEmbeddingPassCompleted || hasActiveJob ? "waiting" : flowState(asset, ["embedding"], false, isFailed),
      trace: compactModelTrace(textEmbeddingTrace)
    },
    {
      id: "visualEmbedding",
      label: "Visual embedding",
      detail: visualEmbeddingTrace
        ? formatVisualEmbeddingTrace(visualEmbeddingTrace)
        : visualEmbeddingUnavailableTrace
          ? skipped(compactTraceFailure(visualEmbeddingUnavailableTrace))
          : activeJobStage === "visual-embedding" || activeJobStage === "visual-embedding-unavailable"
            ? "Computing visual keyframe embeddings"
            : visualEmbeddingPassCompleted
              ? waitingForIndexedAssetSave("Visual embedding")
              : isIndexed
                ? skipped("indexing finished without a stored visual embedding trace")
                : "Waiting for visual embeddings",
      state: visualEmbeddingTrace
        ? "done"
        : visualEmbeddingUnavailableTrace
          ? "skipped"
          : activeJobStage === "visual-embedding" || activeJobStage === "visual-embedding-unavailable"
            ? "active"
            : visualEmbeddingPassCompleted || hasActiveJob
              ? "waiting"
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

  const activeNodeIds = hasActiveJob ? getActiveWorkflowNodeIds(job) : new Set<string>();
  const impactedNodeIds = hasActiveJob ? getImpactedWorkflowNodeIds(job) : new Set<string>();

  return steps.map((step) => {
    const currentRunStep = applyCurrentWorkflowPresentation(step, job, activeNodeIds, impactedNodeIds);
    return {
      ...currentRunStep,
      description: getWorkflowNodeDescription(step.id),
      progress: getFlowStepProgress(currentRunStep, asset, job),
      retryStage: getWorkflowRetryStage(step.id),
      serverProgress: getFlowStepServerProgress(currentRunStep, job)
    };
  });
}

type FlowStepDraft = Omit<FlowStep, "description" | "progress" | "retryStage">;

function applyCurrentWorkflowPresentation(step: FlowStepDraft, job: JobRecord | null, activeNodeIds: Set<string>, impactedNodeIds: Set<string>): FlowStepDraft {
  if (!job || (job.status !== "queued" && job.status !== "running")) return step;
  if (activeNodeIds.has(step.id)) {
    return {
      ...step,
      detail: getCurrentWorkflowActiveDetail(step.id, job, step.detail),
      state: "active"
    };
  }

  if (impactedNodeIds.has(step.id) && (step.state === "done" || step.state === "active")) {
    return {
      ...step,
      detail: getWorkflowWaitingDetailForJob(job),
      state: "waiting"
    };
  }

  return step;
}

function getCurrentWorkflowActiveDetail(stepId: string, job: JobRecord, fallback: string) {
  if (stepId === "videoVlm") {
    const progress = getVideoVlmJobProgress(job);
    return progress ? `Analyzing timeline keyframes ${progress.attempted}/${progress.total}` : "Analyzing timeline keyframes";
  }
  const details: Record<string, string> = {
    probe: "Reading media metadata",
    scene: "Detecting shot boundaries",
    timeline: "Merging ASR, OCR, visual, and scene windows",
    keyframes: "Generating segment thumbnails",
    detector: "Running configured object detector",
    tracker: "Running configured tracker",
    knowledgeAction: "Running configured action spotter",
    domain: "Building related knowledge event layer",
    domainVlm: `Related knowledge VLM refinement running · ${job.progress}%`,
    summary: "Building deterministic asset and moment summaries",
    textEmbedding: "Computing semantic text embeddings",
    visualEmbedding: "Computing visual keyframe embeddings",
    vector: job.stage === "finalize" ? "Saving indexed asset record" : `Writing vectors (${job.stage})`,
    ready: "Saving indexed asset record"
  };
  return details[stepId] ?? fallback;
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

function getVideoVlmSummary(asset: AssetRecord) {
  const counts = asset.timeline.reduce(
    (sum, segment) => {
      const status = segment.sceneData?.vlm?.status;
      if (status) sum[status] += 1;
      return sum;
    },
    { described: 0, invalid: 0, failed: 0, skipped: 0 }
  );
  const attempted = counts.described + counts.invalid + counts.failed;
  if (attempted === 0) return "";
  return `VLM ${counts.described}/${attempted} described${counts.invalid ? `, ${counts.invalid} invalid` : ""}${counts.failed ? `, ${counts.failed} failed` : ""}`;
}

function getVideoVlmJobProgress(job: JobRecord | null) {
  if (!job) return null;
  for (let index = job.logs.length - 1; index >= 0; index -= 1) {
    const message = job.logs[index]?.message ?? "";
    const segmentMatch = message.match(/^\[video-vlm:([^\]]+)] Video VLM (?:analyzing|analyzed|returned invalid structure for|failed for) segment (\d+)\/(\d+)/i);
    if (segmentMatch) {
      const attempted = Number(segmentMatch[2]);
      const total = Number(segmentMatch[3]);
      if (Number.isFinite(attempted) && Number.isFinite(total) && total > 0) {
        return {
          status: segmentMatch[1],
          attempted,
          total,
          progress: Math.max(0, Math.min(100, Math.round((attempted / total) * 100)))
        };
      }
    }
    const completedMatch = message.match(/^Video VLM analysis completed for (\d+)\/(\d+) attempted segments \((\d+) invalid, (\d+) failed\)/i);
    if (completedMatch) {
      const attempted = Number(completedMatch[2]);
      const described = Number(completedMatch[1]);
      const invalid = Number(completedMatch[3]);
      const failed = Number(completedMatch[4]);
      if (Number.isFinite(attempted) && attempted > 0) {
        return {
          status: "complete",
          attempted,
          total: attempted,
          progress: 100,
          described,
          invalid: Number.isFinite(invalid) ? invalid : 0,
          failed: Number.isFinite(failed) ? failed : 0
        };
      }
    }
  }
  return null;
}

function getFlowStepServerProgress(step: Omit<FlowStep, "description" | "progress" | "retryStage">, job: JobRecord | null) {
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
  const canReportRunning = job.status === "running";
  const structuredStatus = job.runtimeStages?.[stage]?.status;
  if (structuredStatus && (structuredStatus !== "running" || canReportRunning)) return structuredStatus;
  for (let index = job.logs.length - 1; index >= 0; index -= 1) {
    const message = job.logs[index]?.message ?? "";
    if (message.startsWith(`[runtime:${stage}:running]`)) return canReportRunning ? "running" : null;
    if (message.startsWith(`[runtime:${stage}:succeeded]`)) return "succeeded";
    if (message.startsWith(`[runtime:${stage}:failed]`)) return "failed";
  }
  if (job.stage === `runtime-${stage}`) return canReportRunning ? "running" : null;
  if (job.stage === `runtime-${stage}-succeeded`) return "succeeded";
  if (job.stage === `runtime-${stage}-failed`) return "failed";
  return null;
}

function isCurrentRuntimeStageFailure(job: JobRecord | null, stage: string, status: ReturnType<typeof getRuntimeStageStatus>) {
  return Boolean((job?.status === "queued" || job?.status === "running") && status === "failed" && job.runtimeStages?.[stage]?.status === "failed");
}

function currentRuntimeFailureState(job: JobRecord | null, stage: string): FlowStepState {
  return isRecoverableRuntimeFailure(job, stage) ? "waiting" : "error";
}

function formatCurrentRuntimeFailure(job: JobRecord | null, stage: string, label: string) {
  return isRecoverableRuntimeFailure(job, stage) ? `${label} interrupted; waiting for retry` : `${label} failed`;
}

function isRecoverableRuntimeFailure(job: JobRecord | null, stage: string) {
  const message = job?.runtimeStages?.[stage]?.message ?? job?.runtimeStages?.[stage]?.error ?? "";
  return /will rerun from checkpoint|durable worker recovery/i.test(message);
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
  assetIndexingInProgress,
  isIndexed,
  job
}: {
  domainIndexingEnabled: boolean;
  hasDomainEvents: boolean;
  hasActiveJob: boolean;
  assetIndexingInProgress: boolean;
  isIndexed: boolean;
  job: JobRecord | null;
}): { detail: string; state: FlowStepState } {
  if (hasDomainEvents) return { detail: "Related knowledge events are ready", state: "done" };
  if (!domainIndexingEnabled) return { detail: skipped("related knowledge indexing is disabled; knowledge event metadata is not generated for this asset group"), state: "skipped" };

  const stage = job?.stage ?? "queued";
  const progress = job?.progress ?? 0;
  if (hasActiveJob) {
    if (stage === "domain-index") {
      return { detail: "Building related knowledge event layer", state: "active" };
    }
    if (assetIndexingInProgress && progress >= 82) {
      return { detail: waitingForIndexedAssetSave("Domain event"), state: "waiting" };
    }
    if (progress >= 78) {
      return { detail: `Preparing related knowledge events (${stage})`, state: "active" };
    }
    return { detail: `Waiting for detector, tracker, and text signals (${stage})`, state: "waiting" };
  }

  if (isIndexed) return { detail: skipped("no trusted related knowledge events were produced from the indexed timeline signals"), state: "skipped" };
  return { detail: "Waiting for related knowledge indexing", state: "waiting" };
}

function getFlowStepProgress(step: Omit<FlowStep, "description" | "progress" | "retryStage">, asset: AssetRecord, job: JobRecord | null) {
  if (step.state === "done") return 100;
  if (step.id === "videoVlm" && step.state === "active") {
    const videoVlmJobProgress = getVideoVlmJobProgress(job);
    if (videoVlmJobProgress) return videoVlmJobProgress.progress;
  }
  if (step.state === "waiting") return null;
  if (step.state === "skipped") return null;
  if (step.state === "error") return null;

  const runtimeProgress = getFlowStepRuntimeProgress(step.id, job);
  if (runtimeProgress !== null) return runtimeProgress;

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
    visual: [38, 60],
    scene: [68, 72],
    timeline: [68, 74],
    keyframes: [72, 76],
    videoVlm: [76, 78],
    detector: [78, 80],
    tracker: [80, 81],
    knowledgeAction: [80, 82],
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

function getFlowStepRuntimeProgress(stepId: string, job: JobRecord | null) {
  if (!job || (job.status !== "queued" && job.status !== "running")) return null;
  const runtimeStageIds: Record<string, string[]> = {
    audio: ["audio"],
    vad: ["audio"],
    asr: ["asr"],
    speakers: ["diarization"],
    ocr: ["ocr"],
    visual: ["visual"]
  };
  const stages = runtimeStageIds[stepId] ?? [];
  const progressValues = stages
    .map((stageId) => job.runtimeStages?.[stageId]?.progress)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (progressValues.length === 0) return null;
  return Math.max(5, Math.min(100, Math.round(Math.max(...progressValues))));
}

export function getLatestAssetJob(jobs: JobRecord[], assetId: string) {
  const assetJobs = jobs.filter((job) => job.assetId === assetId);
  return (
    assetJobs.find((job) => job.status === "running" || job.status === "queued") ??
    [...assetJobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ??
    null
  );
}

function skipped(reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) return "Skipped: no stored result is available for this step";
  return trimmed.toLowerCase().startsWith("skipped:") ? trimmed : `Skipped: ${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function waitingForIndexedAssetSave(label: string) {
  return `${label} pass finished; waiting for indexed asset record save`;
}

function interruptedBeforeSave(label: string) {
  return `Interrupted before ${label} was saved; previous indexed asset was preserved`;
}

function formatDomainGroups(index: IndexRecord | null) {
  const groups = index?.domainIndexing?.groups ?? [];
  return groups.length > 0 ? groups.map(formatKnowledgeSourceLabel).join(", ") : "no related knowledge source";
}

function compactTraceFailure(trace: string) {
  const detail = trace.replace(/^[^:]+:/, "").trim();
  if (!detail) return "Model execution failed";
  if (detail.includes("WHISPERX_HF_TOKEN")) return "WhisperX diarization requires WHISPERX_HF_TOKEN or HF_TOKEN";
  if (detail.includes("HF_TOKEN") || detail.includes("HF Hub")) return "Whisper failed while accessing Hugging Face model files";
  if (detail.includes("ModuleNotFoundError")) return detail.split("\n")[0];
  if (detail.includes("is not valid JSON")) return "Model runtime returned non-JSON output instead of the expected result payload";
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

function formatVideoVlmTrace(trace: string) {
  const [model, described] = trace.slice("video-vlm:".length).split(":");
  return [model, described ? `${described} described` : ""].filter(Boolean).join(" · ");
}

function formatKnowledgeActionTrace(trace: string) {
  if (trace.startsWith("knowledge-action:")) {
    const [sourceId, provider, model, spots] = trace.slice("knowledge-action:".length).split(":");
    return [formatKnowledgeSourceLabel(sourceId), provider, model, countLabel(spots, "spot")].filter(Boolean).join(" · ");
  }
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
