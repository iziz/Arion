export type AssetStatus =
  | "uploaded"
  | "queued"
  | "probing"
  | "transcribing"
  | "scanning"
  | "sampling"
  | "embedding"
  | "indexed"
  | "failed";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type JobType = "asset.index" | "asset.reindex" | "webhook.test";

export type StorageProvider = "local" | "local-s3" | "local-r2";

export type WebhookEventType =
  | "asset.uploaded"
  | "asset.indexing.started"
  | "asset.indexing.progress"
  | "asset.indexing.succeeded"
  | "asset.indexing.failed"
  | "analysis.completed";

export type DomainEvent = {
  id: string;
  domain: string;
  ontologyVersion: string;
  caption: string;
  eventType: string;
  labels: string[];
  confidence: number;
  evidence: {
    asr: string[];
    ocr: string[];
    visual: string[];
    metadata: string[];
    heuristics: string[];
  };
  football?: {
    phase: "attack" | "transition" | "set_piece" | "unknown";
    fieldZone: "defensive_third" | "middle_third" | "final_third" | "penalty_area" | "unknown";
    passType: "through_ball" | "cross" | "cutback" | "short_pass" | "long_ball" | "unknown";
    receivingPlayer: {
      present: boolean;
      confidence: number;
      trackId: string | null;
      trackingStatus: "not_configured" | "estimated" | "detected" | "not_detected";
      identity?: PlayerIdentity | null;
    };
    passingPlayer: {
      present: boolean;
      confidence: number;
      trackId: string | null;
      trackingStatus: "not_configured" | "estimated" | "detected" | "not_detected";
      identity?: PlayerIdentity | null;
    };
    ball: {
      state: "in_play" | "pass_travel" | "shot" | "unknown";
      confidence: number;
      trackingStatus: "not_configured" | "estimated" | "detected" | "not_detected";
    };
    field: {
      calibrationStatus: "not_configured" | "estimated" | "calibrated";
      attackingDirection: "left_to_right" | "right_to_left" | "unknown";
      zoneConfidence: number;
    };
    limitations: string[];
  };
};

export type PlayerIdentity = {
  name: string;
  confidence: number;
  source: "query" | "title" | "asr" | "ocr" | "metadata" | "knowledge";
  evidence: string[];
};

export type DomainScopeValue = {
  value: string;
  confidence: number;
  source: "title" | "asr" | "ocr" | "metadata" | "knowledge";
  evidence: string[];
};

export type DomainScope = {
  competition: DomainScopeValue | null;
  season: DomainScopeValue | null;
  teams: DomainScopeValue[];
  players: DomainScopeValue[];
};

export type VisionEvidence = {
  generatedBy: string;
  frameAt: number | null;
  pitch: {
    present: boolean;
    greenDominance: number;
    confidence: number;
  };
  objects: {
    players: {
      countEstimate: number;
      confidence: number;
      status: "not_configured" | "estimated" | "detected" | "not_detected";
      boxes?: VisionBoundingBox[];
    };
    ball: {
      present: boolean;
      confidence: number;
      status: "not_configured" | "estimated" | "detected" | "not_detected";
      boxes?: VisionBoundingBox[];
    };
  };
  proximity?: {
    ballNearPlayer: boolean;
    confidence: number;
    normalizedDistance: number | null;
  };
  tracking?: {
    status: "not_configured" | "estimated" | "tracked";
    ballTrackId: string | null;
    nearestPlayerTrackId: string | null;
    continuity: number;
    ballMovement: {
      fromPrevious: number | null;
      speedPerSecond: number | null;
      direction: "left" | "right" | "vertical" | "stationary" | "unknown";
    };
  };
  eventClassification?: {
    label:
      | "through_ball_receive"
      | "pass_receive"
      | "shot"
      | "cross_receive"
      | "cutback_receive"
      | "carry"
      | "dribble"
      | "progressive_pass"
      | "save"
      | "pressure"
      | "scramble"
      | "pocket_escape"
      | "throw_on_run"
      | "unknown";
    confidence: number;
    rules: string[];
    features: {
      textCue: boolean;
      receiverCue: boolean;
      ballTracked: boolean;
      playerNearBall: boolean;
      fieldZone: VisionEvidence["fieldZone"]["zone"];
      ballDirection: "left" | "right" | "vertical" | "stationary" | "unknown";
    };
  };
  fieldZone: {
    zone: "defensive_third" | "middle_third" | "final_third" | "penalty_area" | "unknown";
    confidence: number;
    method: "color_motion_heuristic" | "detector" | "homography" | "none";
  };
  eventCandidates: Array<{
    type: "pass_receive" | "shot" | "carry" | "unknown";
    confidence: number;
    reason: string;
  }>;
  limitations: string[];
};

export type VisionBoundingBox = {
  label: "person" | "sports_ball" | "unknown";
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  source: string;
};

export type TimelineSegment = {
  id: string;
  start: number;
  end: number;
  label: string;
  transcript: string;
  sceneData?: {
    image: {
      thumbnailPath: string | null;
      framePath: string | null;
      labels: string[];
      dominantColor: string;
      brightness: number;
      motionScore: number;
      keyframeAt: number | null;
    };
    text: {
      speech: string;
      subtitles: string[];
      screenText: string[];
      overlays: string[];
      watermarks: string[];
      comparisons: Array<{
        kind: "subtitle" | "screen_text";
        asrText: string;
        ocrText: string;
        similarity: number;
        status: "match" | "review" | "mismatch";
        suggestedText: string;
      }>;
    };
    vision?: VisionEvidence;
  };
  domain?: {
    groups: string[];
    captions: string[];
    labels: string[];
    events: DomainEvent[];
    scope?: DomainScope;
    searchText: string;
    confidence: number;
    generatedBy: string;
  };
  tags: string[];
  modalities: Array<"visual" | "audio" | "transcription" | "metadata">;
  confidence: number;
  embedding: number[];
  thumbnailPath: string | null;
  sources: Array<"whisper" | "paddleocr" | "visual" | "metadata" | "shot" | "domain">;
  scene?: {
    shotIndex: number;
    boundaryScore: number | null;
  };
};

export type WhisperSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
};

export type OcrFrameResult = {
  framePath: string;
  at?: number | null;
  tokens: string[];
  boxes?: OcrBox[];
  confidence: number;
};

export type OcrBox = {
  text: string;
  confidence: number;
  bbox: Array<[number, number]>;
  region: "top" | "middle" | "bottom" | "left" | "right";
  role: "subtitle" | "overlay" | "watermark" | "screen_text";
};

export type KeyframeRecord = {
  id: string;
  segmentId: string | null;
  at: number;
  path: string;
  width: number | null;
  height: number | null;
};

export type LocalIntelligence = {
  audio: {
    extractedPath: string | null;
    speechSegments: Array<{
      start: number;
      end: number;
      confidence: number;
    }>;
    musicSegments: Array<{
      start: number;
      end: number;
      confidence: number;
    }>;
    hasSpeech: boolean;
    hasMusic: boolean;
  };
  asr: {
    transcript: string;
    language: string;
    confidence: number;
    segments: WhisperSegment[];
  };
  diarization: {
    provider: string;
    speakers: string[];
    segments: Array<{
      start: number;
      end: number;
      speaker: string;
      text: string;
    }>;
    error: string | null;
  };
  ocr: {
    tokens: string[];
    confidence: number;
    frames: OcrFrameResult[];
  };
  visual: {
    labels: string[];
    dominantColor: string;
    brightness: number;
    motionScore: number;
  };
  modelTrace: string[];
};

export type IndexRecord = {
  id: string;
  name: string;
  description: string;
  models: {
    search: string;
    analysis: string;
    embedding: string;
  };
  modalities: Array<"visual" | "audio" | "transcription" | "metadata">;
  domainIndexing?: {
    enabled: boolean;
    groups: Array<"sports.football">;
    stages: Array<"domain_caption" | "event_label" | "structured_event">;
  };
  assetIds: string[];
  status: "ready" | "empty";
  createdAt: string;
  updatedAt: string;
};

export type AssetRecord = {
  id: string;
  indexId: string;
  title: string;
  description: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  status: AssetStatus;
  progress: number;
  tags: string[];
  summary: string;
  timeline: TimelineSegment[];
  keyframes: KeyframeRecord[];
  technicalMetadata: {
    storageProvider: StorageProvider;
    bucket: string;
    objectKey: string;
    checksum: string | null;
    frameRate: number | null;
    audioCodec: string | null;
    videoCodec: string | null;
  };
  intelligence: LocalIntelligence;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchResult = {
  asset: AssetRecord;
  index: IndexRecord | null;
  segments: TimelineSegment[];
  clips: ClipResult[];
  score: number;
  ranking: {
    lexical: number;
    semantic: number;
    visual: number;
    source: number;
    confidence: number;
    recency: number;
    total: number;
  };
  explain: string[];
  queryPlan: DomainQueryPlan | null;
  matchReasons: SearchMatchReason[];
  verification: VerificationCheck[];
};

export type DomainSearchFilters = {
  competition?: string;
  season?: string;
  player?: string;
  eventType?: string;
  passType?: string;
  fieldZone?: string;
  role?: "receiver" | "passer" | "shooter" | "any";
};

export type DomainQueryPlan = {
  originalQuery: string;
  semanticQuery: string;
  rewrittenQuery: string;
  domainFilters: DomainSearchFilters;
  intent: {
    domain: string | null;
    eventType: string | null;
    passType: string | null;
    fieldZone: string | null;
    player: string | null;
    role: "receiver" | "passer" | "shooter" | "any" | null;
  };
  confidence: number;
  warnings: string[];
};

export type OrchestrationPlan = {
  query: string;
  mode: "search" | "analysis" | "search_and_analysis";
  confidence: number;
  decisions: Array<{
    id: string;
    label: string;
    value: string;
    confidence: number;
    status: "ready" | "needs_review" | "fallback";
    reason: string;
  }>;
  steps: Array<{
    id: string;
    label: string;
    owner: "router" | "knowledge" | "marengo" | "pegasus" | "platform";
    action: string;
    input: string;
    output: string;
    status: "ready" | "needs_review" | "fallback";
    trigger: string;
  }>;
  retrieval: {
    engine: "marengo_semantic" | "structured_domain" | "hybrid";
    filters: DomainSearchFilters;
    fallback: string[];
  };
  analysis: {
    required: boolean;
    model: "pegasus_generate" | "none";
    prompt: string;
    inputs: string[];
  };
  warnings: string[];
};

export type SearchMatchReason = {
  segmentId: string;
  kind: "query_plan" | "domain_filter" | "lexical" | "semantic" | "visual" | "evidence" | "limitation";
  label: string;
  value: string;
  confidence?: number;
};

export type VerificationCheck = {
  segmentId: string;
  constraint: "competition" | "season" | "player" | "eventType" | "passType" | "fieldZone" | "role";
  expected: string;
  observed: string;
  status: "pass" | "soft_pass" | "fail" | "unknown";
  confidence: number;
  evidence: string[];
};

export type ClipResult = {
  id: string;
  assetId: string;
  segmentId: string;
  title: string;
  start: number;
  end: number;
  thumbnailPath: string | null;
  event: string;
  player: string | null;
  confidence: number;
  verificationSummary: {
    pass: number;
    softPass: number;
    unknown: number;
    fail: number;
  };
  reasons: string[];
};

export type AnalysisResult = {
  assetId: string;
  indexId: string;
  summary: string;
  answer: string;
  chapters: TimelineSegment[];
  clips: ClipResult[];
  signals: string[];
  patterns: {
    totalMoments: number;
    verifiedConstraints: number;
    uncertainConstraints: number;
    failedConstraints: number;
    topGroups: Array<{
      key: string;
      label: string;
      count: number;
      share: number;
      confidence: number;
    }>;
    gaps: string[];
  };
  report: {
    title: string;
    confidence: number;
    sections: Array<{
      heading: string;
      body: string;
      bullets: string[];
    }>;
    limitations: string[];
  };
  generator: {
    provider: string;
    model: string;
    mode: "local" | "http" | "fallback";
  };
  generatedAt: string;
};

export type JobLog = {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type JobRecord = {
  id: string;
  type: JobType;
  status: JobStatus;
  stage: string;
  progress: number;
  indexId: string | null;
  assetId: string | null;
  logs: JobLog[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type WebhookRecord = {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  deliveries: Array<{
    id: string;
    eventId: string | null;
    event: WebhookEventType;
    status: "delivered" | "failed" | "skipped";
    statusCode: number | null;
    error: string | null;
    attempts: number;
    nextRetryAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type EventRecord = {
  id: string;
  type: WebhookEventType | "system.info";
  message: string;
  indexId: string | null;
  assetId: string | null;
  jobId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type MetricsSummary = {
  indexes: number;
  assets: number;
  indexedAssets: number;
  runningJobs: number;
  failedJobs: number;
  totalDuration: number;
  segments: number;
  vectors: number;
  webhooks: number;
  billingUnits: number;
};

export type BillingRecord = {
  id: string;
  userId: string;
  assetId: string | null;
  jobId: string | null;
  units: number;
  reason: string;
  createdAt: string;
};

export type UserRecord = {
  id: string;
  name: string;
  apiKey: string;
  plan: "local-dev" | "local-pro";
  createdAt: string;
};

export type VideoStatus = AssetStatus;
export type VideoRecord = AssetRecord;
