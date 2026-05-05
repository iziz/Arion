import type { JobRecord } from "./types";

export type WorkflowStepState = "done" | "active" | "waiting" | "skipped" | "error";

type WorkflowEvidence =
  | "source"
  | "probe"
  | "audio"
  | "vad"
  | "asr"
  | "diarization"
  | "ocr"
  | "visual-profile"
  | "timeline"
  | "keyframes"
  | "video-vlm"
  | "vision-detector"
  | "vision-tracker"
  | "knowledge-action"
  | "domain"
  | "domain-vlm"
  | "text-embedding"
  | "visual-embedding"
  | "vector"
  | "ready";

type WorkflowNodeDefinition = {
  id: string;
  description: string;
  retryStage: string;
  produces: WorkflowEvidence[];
  dependsOn: WorkflowEvidence[];
  stageAliases: string[];
  runtimeStages: string[];
  logTokens: string[];
  searchImpact: string;
  skippedSearchImpact?: string;
};

type WorkflowStageDefinition = {
  stage: string;
  activeNodeIds: string[];
  produces: WorkflowEvidence[];
  waitingLabel: string;
};

const workflowNodeDefinitions: Record<string, WorkflowNodeDefinition> = {
  input: {
    id: "input",
    description: "Stores the source file and anchors every search result to the original asset.",
    retryStage: "input",
    produces: ["source"],
    dependsOn: [],
    stageAliases: ["queued"],
    runtimeStages: [],
    logTokens: ["upload", "queued", "indexing started"],
    searchImpact: "Search impact: eligibility"
  },
  probe: {
    id: "probe",
    description: "Reads duration, resolution, codecs, and frame rate so later nodes can sample and time the video correctly.",
    retryStage: "probe",
    produces: ["probe"],
    dependsOn: ["source"],
    stageAliases: ["probe"],
    runtimeStages: [],
    logTokens: ["probe", "probing", "media"],
    searchImpact: "Search impact: eligibility"
  },
  audio: {
    id: "audio",
    description: "Creates a normalized WAV track used by transcription, speech regions, and speaker analysis.",
    retryStage: "audio",
    produces: ["audio"],
    dependsOn: ["source", "probe"],
    stageAliases: ["sample", "local-model-runtime", "runtime-audio"],
    runtimeStages: ["audio", "audio-probe"],
    logTokens: ["runtime:audio", "audio", "sampling"],
    searchImpact: "Search impact: ASR input"
  },
  vad: {
    id: "vad",
    description: "Finds speech and music ranges so search can separate spoken content from background audio.",
    retryStage: "vad",
    produces: ["vad"],
    dependsOn: ["audio"],
    stageAliases: ["local-model-runtime", "runtime-audio"],
    runtimeStages: ["audio"],
    logTokens: ["vad", "speech", "music"],
    searchImpact: "Search impact: ASR coverage"
  },
  asr: {
    id: "asr",
    description: "Transcribes spoken words into timed text segments for keyword and semantic search.",
    retryStage: "asr",
    produces: ["asr"],
    dependsOn: ["audio"],
    stageAliases: ["local-model-runtime", "runtime-asr"],
    runtimeStages: ["asr"],
    logTokens: ["runtime:asr", "asr", "transcription", "whisper"],
    searchImpact: "Search impact: text searchable"
  },
  speakers: {
    id: "speakers",
    description: "Assigns transcript ranges to speakers so answers can use speaker context and quote attribution.",
    retryStage: "speakers",
    produces: ["diarization"],
    dependsOn: ["audio", "asr"],
    stageAliases: ["diarization", "local-model-runtime", "runtime-diarization"],
    runtimeStages: ["diarization"],
    logTokens: ["runtime:diarization", "diarization", "speaker", "whisperx"],
    searchImpact: "Search impact: speaker context"
  },
  ocr: {
    id: "ocr",
    description: "Reads visible frame text so captions, slides, signs, and UI text become searchable.",
    retryStage: "ocr",
    produces: ["ocr"],
    dependsOn: ["source", "probe"],
    stageAliases: ["local-model-runtime", "runtime-ocr"],
    runtimeStages: ["ocr"],
    logTokens: ["runtime:ocr", "ocr"],
    searchImpact: "Search impact: screen text searchable"
  },
  visual: {
    id: "visual",
    description: "Samples coarse frame color and motion signals to show whether visual evidence is usable.",
    retryStage: "visual",
    produces: ["visual-profile"],
    dependsOn: ["source", "probe"],
    stageAliases: ["sample", "local-model-runtime", "runtime-visual"],
    runtimeStages: ["visual"],
    logTokens: ["runtime:visual", "visual", "frame", "sampling"],
    searchImpact: "Search impact: visual profile",
    skippedSearchImpact: "Search impact: visual unavailable"
  },
  scene: {
    id: "scene",
    description: "Splits the video into visual moments so evidence can attach to stable time windows.",
    retryStage: "timeline",
    produces: ["timeline"],
    dependsOn: ["source", "probe"],
    stageAliases: ["timeline", "scene-detection"],
    runtimeStages: [],
    logTokens: ["scene"],
    searchImpact: "Search impact: moment boundaries"
  },
  timeline: {
    id: "timeline",
    description: "Merges transcript, OCR, scene, and visual cues into indexed moments for retrieval.",
    retryStage: "timeline",
    produces: ["timeline"],
    dependsOn: ["probe", "asr", "ocr", "visual-profile"],
    stageAliases: ["timeline"],
    runtimeStages: [],
    logTokens: ["timeline"],
    searchImpact: "Search impact: moment retrieval"
  },
  keyframes: {
    id: "keyframes",
    description: "Stores representative thumbnails for each moment for review, visual models, and result previews.",
    retryStage: "timeline",
    produces: ["keyframes"],
    dependsOn: ["source", "timeline"],
    stageAliases: ["keyframes"],
    runtimeStages: [],
    logTokens: ["keyframe"],
    searchImpact: "Search impact: thumbnails",
    skippedSearchImpact: "Search impact: thumbnails unavailable"
  },
  videoVlm: {
    id: "videoVlm",
    description: "Captions keyframes with a VLM to add semantic scene descriptions beyond raw text.",
    retryStage: "videoVlm",
    produces: ["video-vlm"],
    dependsOn: ["keyframes"],
    stageAliases: ["video-vlm"],
    runtimeStages: [],
    logTokens: ["video-vlm", "vlm scene"],
    searchImpact: "Search impact: VLM scene captions",
    skippedSearchImpact: "Search impact: VLM scene captions not used"
  },
  detector: {
    id: "detector",
    description: "Detects configured objects or actors in keyframes to add object-level evidence.",
    retryStage: "visual",
    produces: ["vision-detector"],
    dependsOn: ["keyframes"],
    stageAliases: ["vision-detection"],
    runtimeStages: [],
    logTokens: ["vision-detection", "detecting configured domain object candidates", "detector"],
    searchImpact: "Search impact: object evidence",
    skippedSearchImpact: "Search impact: detector not used"
  },
  tracker: {
    id: "tracker",
    description: "Links detections over time to add movement and continuity evidence.",
    retryStage: "visual",
    produces: ["vision-tracker"],
    dependsOn: ["source", "timeline", "vision-detector"],
    stageAliases: ["vision-tracking"],
    runtimeStages: [],
    logTokens: ["vision-tracking", "tracking configured domain object candidates", "tracker"],
    searchImpact: "Search impact: motion evidence",
    skippedSearchImpact: "Search impact: tracker not used"
  },
  knowledgeAction: {
    id: "knowledgeAction",
    description: "Runs action spotting for the selected related knowledge source when that adapter supports it.",
    retryStage: "domain",
    produces: ["knowledge-action"],
    dependsOn: ["source", "timeline", "vision-tracker"],
    stageAliases: ["knowledge-action", "soccernet-action"],
    runtimeStages: [],
    logTokens: ["knowledge action", "action spotting", "soccernet"],
    searchImpact: "Search impact: adapter action evidence",
    skippedSearchImpact: "Search impact: action spotting not used"
  },
  domain: {
    id: "domain",
    description: "Combines text, vision, and action signals into trusted domain event candidates.",
    retryStage: "domain",
    produces: ["domain"],
    dependsOn: ["timeline", "vision-detector", "vision-tracker", "knowledge-action"],
    stageAliases: ["domain-index"],
    runtimeStages: [],
    logTokens: ["domain-index", "related knowledge", "event layer"],
    searchImpact: "Search impact: knowledge-aware",
    skippedSearchImpact: "Search impact: related knowledge layer unavailable"
  },
  domainVlm: {
    id: "domainVlm",
    description: "Refines related knowledge event candidates with VLM checks before they affect search context.",
    retryStage: "domain",
    produces: ["domain-vlm"],
    dependsOn: ["domain"],
    stageAliases: ["domain-vlm"],
    runtimeStages: [],
    logTokens: ["domain-vlm", "vlm"],
    searchImpact: "Search impact: knowledge-event refinement",
    skippedSearchImpact: "Search impact: knowledge-event refinement not applied"
  },
  textEmbedding: {
    id: "textEmbedding",
    description: "Turns timeline text into vectors for semantic moment ranking.",
    retryStage: "vector",
    produces: ["text-embedding"],
    dependsOn: ["timeline", "video-vlm", "vision-detector", "vision-tracker", "domain", "domain-vlm"],
    stageAliases: ["embed"],
    runtimeStages: [],
    logTokens: ["semantic text", "embedding started", "embedding complete", "embed"],
    searchImpact: "Search impact: semantic ranking",
    skippedSearchImpact: "Search impact: semantic ranking not used"
  },
  visualEmbedding: {
    id: "visualEmbedding",
    description: "Turns keyframes into image vectors for visual similarity ranking.",
    retryStage: "vector",
    produces: ["visual-embedding"],
    dependsOn: ["keyframes"],
    stageAliases: ["visual-embedding", "visual-embedding-unavailable"],
    runtimeStages: [],
    logTokens: ["visual-embedding", "visual embedding", "visual embeddings"],
    searchImpact: "Search impact: visual ranking",
    skippedSearchImpact: "Search impact: visual ranking not used"
  },
  vector: {
    id: "vector",
    description: "Writes searchable text, visual, and metadata vectors to the vector store.",
    retryStage: "vector",
    produces: ["vector"],
    dependsOn: ["text-embedding", "visual-embedding"],
    stageAliases: ["vector-upsert-text", "vector-upsert-visual", "finalize"],
    runtimeStages: [],
    logTokens: ["vector", "upsert", "writing"],
    searchImpact: "Search impact: vector DB",
    skippedSearchImpact: "Search impact: vector write unavailable"
  },
  ready: {
    id: "ready",
    description: "Marks the asset available for retrieval, asking, and focused analysis.",
    retryStage: "ready",
    produces: ["ready"],
    dependsOn: ["vector"],
    stageAliases: ["complete", "finalize"],
    runtimeStages: [],
    logTokens: ["complete", "finalize", "saving"],
    searchImpact: "Search impact: searchable"
  }
};

const workflowStageDefinitions: Record<string, WorkflowStageDefinition> = {
  queued: {
    stage: "queued",
    activeNodeIds: ["input"],
    produces: [],
    waitingLabel: "the indexing job to start"
  },
  probe: {
    stage: "probe",
    activeNodeIds: ["probe"],
    produces: ["probe"],
    waitingLabel: "media probing to finish"
  },
  sample: {
    stage: "sample",
    activeNodeIds: ["audio", "visual"],
    produces: ["audio", "vad", "visual-profile"],
    waitingLabel: "media sampling to finish"
  },
  "local-model-runtime": {
    stage: "local-model-runtime",
    activeNodeIds: [],
    produces: ["audio", "vad", "asr", "diarization", "ocr", "visual-profile"],
    waitingLabel: "speech, OCR, and visual extraction to finish"
  },
  "runtime-audio": {
    stage: "runtime-audio",
    activeNodeIds: ["audio", "vad"],
    produces: ["audio", "vad"],
    waitingLabel: "audio extraction to finish"
  },
  "runtime-asr": {
    stage: "runtime-asr",
    activeNodeIds: ["asr"],
    produces: ["asr"],
    waitingLabel: "transcription to finish"
  },
  "runtime-diarization": {
    stage: "runtime-diarization",
    activeNodeIds: ["speakers"],
    produces: ["diarization"],
    waitingLabel: "speaker diarization to finish"
  },
  "runtime-ocr": {
    stage: "runtime-ocr",
    activeNodeIds: ["ocr"],
    produces: ["ocr"],
    waitingLabel: "OCR to finish"
  },
  "runtime-visual": {
    stage: "runtime-visual",
    activeNodeIds: ["visual"],
    produces: ["visual-profile"],
    waitingLabel: "visual sampling to finish"
  },
  "scene-detection": {
    stage: "scene-detection",
    activeNodeIds: ["scene"],
    produces: ["timeline"],
    waitingLabel: "scene boundary detection to finish"
  },
  timeline: {
    stage: "timeline",
    activeNodeIds: ["timeline"],
    produces: ["timeline"],
    waitingLabel: "timeline assembly to finish"
  },
  keyframes: {
    stage: "keyframes",
    activeNodeIds: ["keyframes"],
    produces: ["keyframes"],
    waitingLabel: "keyframe generation to finish"
  },
  "video-vlm": {
    stage: "video-vlm",
    activeNodeIds: ["videoVlm"],
    produces: ["video-vlm"],
    waitingLabel: "Video VLM analysis to finish"
  },
  "vision-detection": {
    stage: "vision-detection",
    activeNodeIds: ["detector"],
    produces: ["vision-detector"],
    waitingLabel: "vision detection to finish"
  },
  "vision-tracking": {
    stage: "vision-tracking",
    activeNodeIds: ["tracker"],
    produces: ["vision-tracker"],
    waitingLabel: "vision tracking to finish"
  },
  "knowledge-action": {
    stage: "knowledge-action",
    activeNodeIds: ["knowledgeAction"],
    produces: ["knowledge-action"],
    waitingLabel: "knowledge action spotting to finish"
  },
  "soccernet-action": {
    stage: "soccernet-action",
    activeNodeIds: ["knowledgeAction"],
    produces: ["knowledge-action"],
    waitingLabel: "knowledge action spotting to finish"
  },
  "domain-index": {
    stage: "domain-index",
    activeNodeIds: ["domain"],
    produces: ["domain"],
    waitingLabel: "domain event indexing to finish"
  },
  "domain-vlm": {
    stage: "domain-vlm",
    activeNodeIds: ["domainVlm"],
    produces: ["domain-vlm"],
    waitingLabel: "related knowledge VLM refinement to finish"
  },
  embed: {
    stage: "embed",
    activeNodeIds: ["textEmbedding"],
    produces: ["text-embedding"],
    waitingLabel: "text embedding to finish"
  },
  "vector-upsert-text": {
    stage: "vector-upsert-text",
    activeNodeIds: ["vector"],
    produces: ["vector"],
    waitingLabel: "text vector writes to finish"
  },
  "visual-embedding": {
    stage: "visual-embedding",
    activeNodeIds: ["visualEmbedding"],
    produces: ["visual-embedding"],
    waitingLabel: "visual embedding to finish"
  },
  "visual-embedding-unavailable": {
    stage: "visual-embedding-unavailable",
    activeNodeIds: ["visualEmbedding"],
    produces: ["visual-embedding"],
    waitingLabel: "visual embedding handling to finish"
  },
  "vector-upsert-visual": {
    stage: "vector-upsert-visual",
    activeNodeIds: ["vector"],
    produces: ["vector"],
    waitingLabel: "visual vector writes to finish"
  },
  finalize: {
    stage: "finalize",
    activeNodeIds: ["vector", "ready"],
    produces: ["ready"],
    waitingLabel: "indexed asset save to finish"
  },
  complete: {
    stage: "complete",
    activeNodeIds: [],
    produces: [],
    waitingLabel: "job completion"
  }
};

export function getWorkflowNodeDescription(stepId: string) {
  return workflowNodeDefinitions[stepId]?.description ?? "Extracts workflow evidence that improves retrieval and review.";
}

export function getWorkflowRetryStage(stepId: string) {
  return workflowNodeDefinitions[stepId]?.retryStage ?? stepId;
}

export function getWorkflowRuntimeStageIds(stepId: string) {
  return workflowNodeDefinitions[stepId]?.runtimeStages ?? [];
}

export function getWorkflowStageAliases(stepId: string) {
  return workflowNodeDefinitions[stepId]?.stageAliases ?? [stepId.toLowerCase()];
}

export function getWorkflowLogTokens(stepId: string) {
  return workflowNodeDefinitions[stepId]?.logTokens ?? [stepId.toLowerCase()];
}

export function getWorkflowSearchImpact(stepId: string, state: WorkflowStepState) {
  if (state === "error") return "Search impact: failed";
  const definition = workflowNodeDefinitions[stepId];
  if (!definition) return "Search impact: diagnostic";
  if (state === "skipped") return definition.skippedSearchImpact ?? "Search impact: not used";
  return definition.searchImpact;
}

export function getActiveWorkflowNodeIds(job: JobRecord | null) {
  const stageDefinition = getWorkflowStageDefinition(job?.stage);
  const active = new Set(stageDefinition?.activeNodeIds ?? []);
  if (job?.status !== "running") return active;
  for (const stage of Object.values(job?.runtimeStages ?? {})) {
    if (stage.status === "running") {
      for (const nodeId of workflowStageDefinitions[`runtime-${stage.stage}`]?.activeNodeIds ?? []) {
        active.add(nodeId);
      }
    }
  }
  return active;
}

export function getImpactedWorkflowNodeIds(job: JobRecord | null) {
  const activeEvidence = getActiveWorkflowEvidence(job);
  if (activeEvidence.size === 0) return new Set<string>();

  const impactedEvidence = new Set(activeEvidence);
  const impactedNodeIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of Object.values(workflowNodeDefinitions)) {
      if (definition.dependsOn.some((evidence) => impactedEvidence.has(evidence))) {
        impactedNodeIds.add(definition.id);
        for (const output of definition.produces) {
          if (!impactedEvidence.has(output)) {
            impactedEvidence.add(output);
            changed = true;
          }
        }
      }
    }
  }
  return impactedNodeIds;
}

export function getWorkflowWaitingDetailForJob(job: JobRecord | null) {
  const label = getWorkflowStageDefinition(job?.stage)?.waitingLabel ?? "the current workflow stage to finish";
  return `Waiting for ${label}`;
}

function getActiveWorkflowEvidence(job: JobRecord | null) {
  const evidence = new Set<WorkflowEvidence>();
  const runtimeStages = Object.values(job?.runtimeStages ?? {});
  const runningRuntimeStages = job?.status === "running" ? runtimeStages.filter((stage) => stage.status === "running") : [];
  if (runningRuntimeStages.length > 0) {
    for (const stage of runningRuntimeStages) {
      for (const output of workflowStageDefinitions[`runtime-${stage.stage}`]?.produces ?? []) {
        evidence.add(output);
      }
    }
    return evidence;
  }
  if (runtimeStages.length > 0 && job?.stage === "local-model-runtime") {
    return evidence;
  }
  for (const output of getWorkflowStageDefinition(job?.stage)?.produces ?? []) {
    evidence.add(output);
  }
  return evidence;
}

function getWorkflowStageDefinition(stage: string | null | undefined) {
  return stage ? workflowStageDefinitions[stage] : undefined;
}
