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

export type JobType = "asset.index" | "asset.reindex" | "asset.domain-vlm.refine" | "webhook.test";

export type JobParameters = {
  retryStage?: string | null;
  resumeFromStage?: string | null;
  rebuildFromStage?: string | null;
  invalidatedRetryStage?: string | null;
};

export type StorageProvider = "local-s3" | "local-r2";

export type WebhookEventType =
  | "asset.uploaded"
  | "asset.indexing.started"
  | "asset.indexing.progress"
  | "asset.indexing.succeeded"
  | "asset.indexing.failed"
  | "analysis.completed";

export type KnowledgeSourceId = string;
export type SportsKnowledgeSourceId = "sports.football" | "sports.american_football";
export type SportsDomainGroup = SportsKnowledgeSourceId;

export type EvidenceTrustTier = "observed" | "detected" | "aligned" | "inferred" | "heuristic" | "unavailable";
export type CapabilityMode = "disabled" | "optional" | "required";

export type CapabilityPolicy = {
  whisperXDiarization: CapabilityMode;
  videoVlmAnalysis: CapabilityMode;
  visionDetector: CapabilityMode;
  visionTracker: CapabilityMode;
  knowledgeActionSpotting: CapabilityMode;
  domainVlmRefinement: CapabilityMode;
};

export type DomainEvent = {
  id: string;
  domain: string;
  ontologyVersion: string;
  caption: string;
  eventType: string;
  labels: string[];
  confidence: number;
  trust?: EvidenceTrustTier;
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
  americanFootball?: {
    phase: "dropback" | "designed_run" | "scramble" | "play_action" | "unknown";
    playType: "scramble" | "pocket_escape" | "throw_on_run" | "pressure" | "pass" | "rush" | "unknown";
    quarterback: {
      present: boolean;
      confidence: number;
      trackId: string | null;
      trackingStatus: "not_configured" | "estimated" | "detected" | "not_detected";
      identity?: PlayerIdentity | null;
    };
    pressure: {
      present: boolean;
      confidence: number;
      source: "text" | "vision" | "vlm" | "unknown";
    };
    pocket: {
      status: "intact" | "collapsing" | "escaped" | "unknown";
      confidence: number;
    };
    decision: {
      outcome: "run" | "throw" | "sack_avoidance" | "unknown";
      confidence: number;
    };
    limitations: string[];
  };
};

export type PlayerIdentity = {
  name: string;
  confidence: number;
  source: "query" | "title" | "asr" | "ocr" | "metadata" | "knowledge" | "vlm";
  evidence: string[];
};

export type DomainScopeValue = {
  value: string;
  confidence: number;
  source: "title" | "asr" | "ocr" | "metadata" | "knowledge" | "vlm";
  evidence: string[];
};

export type DomainScope = {
  competition: DomainScopeValue | null;
  season: DomainScopeValue | null;
  teams: DomainScopeValue[];
  players: DomainScopeValue[];
};

export type DomainVlmQuality = {
  provider: string;
  model: string;
  status: "refined" | "invalid" | "failed" | "skipped";
  attemptedAt: string;
  confidence: number;
  message: string;
  rawResponse: string | null;
  error: string | null;
};

export type VideoVlmEvidence = {
  provider: string;
  model: string;
  status: "described" | "invalid" | "failed" | "skipped";
  attemptedAt: string;
  confidence: number;
  caption: string;
  description: string;
  sceneType: string;
  labels: string[];
  objects: string[];
  actions: string[];
  visibleText: string[];
  evidence: string[];
  rawResponse: string | null;
  error: string | null;
};

export type VisionEvidence = {
  generatedBy: string;
  trust?: EvidenceTrustTier;
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
    version?: "tracking_v0" | "tracking_v2";
    provider?: string;
    model?: string;
    tracker?: string;
    frameCount?: number;
    trackedFrameCount?: number;
    trackCoverage?: number;
    idSwitches?: number;
    playerTracks?: Array<{
      id: string;
      label: "person" | "sports_ball";
      frames: number;
      confidence: number;
      firstSeen: number | null;
      lastSeen: number | null;
    }>;
    ballTracks?: Array<{
      id: string;
      label: "person" | "sports_ball";
      frames: number;
      confidence: number;
      firstSeen: number | null;
      lastSeen: number | null;
    }>;
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
      trackingContinuity?: number;
      trackingVersion?: "tracking_v0" | "tracking_v2";
      trackingCoverage?: number | null;
      trackingReliable?: boolean;
      ballSpeed?: number | null;
      directionMatchesAttack?: boolean;
      sameNearestPlayerWindow?: boolean;
      pressureCue?: boolean;
      calibratedZone?: boolean;
    };
  };
  fieldZone: {
    zone: "defensive_third" | "middle_third" | "final_third" | "penalty_area" | "unknown";
    confidence: number;
    method: "color_motion_heuristic" | "detector" | "detector_x_position" | "homography" | "text_context" | "none";
  };
  fieldCalibration?: {
    status: "not_configured" | "estimated" | "calibrated";
    method: "color_motion_heuristic" | "detector_x_position" | "homography" | "text_context" | "none";
    zone: VisionEvidence["fieldZone"]["zone"];
    zoneConfidence: number;
    attackingDirection: "left_to_right" | "right_to_left" | "unknown";
    attackingDirectionConfidence: number;
    evidence: string[];
    limitations: string[];
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
  trackId?: string | null;
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
    vlm?: VideoVlmEvidence;
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
    trust?: EvidenceTrustTier;
    vlm?: DomainVlmQuality;
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
    boundarySource?: "pyscenedetect" | "ffmpeg" | null;
    boundaryDetector?: string | null;
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
    vad?: {
      available: boolean;
      provider: string;
      error: string | null;
    };
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
    available?: boolean;
    labels: string[];
    dominantColor: string;
    brightness: number;
    motionScore: number;
    error?: string | null;
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
    groups: KnowledgeSourceId[];
    stages: Array<"domain_caption" | "event_label" | "structured_event">;
  };
  capabilityPolicy?: CapabilityPolicy;
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
  knowledgeEvidence: KnowledgeEvidence[];
  matchReasons: SearchMatchReason[];
  verification: VerificationCheck[];
};

export type KnowledgeEvidence = {
  id: string;
  kind: "roster" | "player_profile" | "match_activity" | "competition_scope" | "video_scope" | "team_stat" | "attendance";
  entityType: "player" | "team" | "competition" | "season" | "event";
  entityName: string;
  source: "sports_knowledge" | "football-data" | "football-data-uk" | "kaggle" | "statbunker" | "statsbomb" | "nflverse" | "fbref" | "video_index" | "query";
  confidence: number;
  evidenceText: string;
  competition?: string;
  season?: string;
  team?: string;
  matchTime?: string;
  assetId?: string;
  segmentId?: string;
};

export type KnowledgeVectorStoreStatus = {
  storage: "postgres" | "local";
  vectors: number;
  domains: Array<{
    domainGroup: KnowledgeSourceId;
    vectors: number;
    providers: Array<{ provider: KnowledgeEvidence["source"]; vectors: number }>;
    kinds: Array<{ kind: KnowledgeEvidence["kind"]; vectors: number }>;
  }>;
  providers: Array<{ provider: KnowledgeEvidence["source"]; vectors: number }>;
  kinds: Array<{ kind: KnowledgeEvidence["kind"]; vectors: number }>;
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

export type QueryRoute =
  | "asset_evidence"
  | "knowledge_evidence"
  | "asset_catalog"
  | "unsupported";

export type ResponseMode =
  | "moment_retrieval"
  | "grounded_answer"
  | "summary"
  | "analysis"
  | "structured_answer"
  | "asset_lookup";

export type KnowledgeMode = "none" | "grounding" | "direct_answer";

export type DomainQueryPlan = {
  originalQuery: string;
  semanticQuery: string;
  rewrittenQuery: string;
  retrieval?: {
    textQuery: string;
    visualQuery: string;
    evidenceTerms: string[];
  };
  domainFilters: DomainSearchFilters;
  route: QueryRoute;
  responseMode: ResponseMode;
  knowledgeMode: KnowledgeMode;
  intent: {
    domain: string | null;
    questionType?: "moment_retrieval" | "grounded_answer" | "summary" | "analysis" | "structured_answer" | "asset_lookup";
    metric?:
      | "goals"
      | "assists"
      | "appearances"
      | "minutes"
      | "cards"
      | "points"
      | "touchdowns"
      | "passing_yards"
      | "passing_touchdowns"
      | "rushing_yards"
      | "receiving_yards"
      | "sacks"
      | "interceptions"
      | null;
    eventType: string | null;
    passType: string | null;
    fieldZone: string | null;
    player: string | null;
    role: "receiver" | "passer" | "shooter" | "any" | null;
  };
  confidence: number;
  warnings: string[];
  planner?: {
    source: "rules" | "openai";
    model: string | null;
    fallbackReason?: string;
  };
};

export type SportsKnowledgeAnswer = {
  applicable: boolean;
  route: "stat_qa" | "unsupported";
  answer: string;
  confidence: number;
  subject: {
    player: string | null;
    competition: string | null;
    season: string | null;
    metric:
      | "goals"
      | "assists"
      | "appearances"
      | "minutes"
      | "cards"
      | "points"
      | "touchdowns"
      | "passing_yards"
      | "passing_touchdowns"
      | "rushing_yards"
      | "receiving_yards"
      | "sacks"
      | "interceptions"
      | null;
  };
  value: number | null;
  status: "answered" | "missing_stat" | "unsupported" | "needs_clarification";
  evidence: Array<{
    provider: string;
    season: string;
    competition: string;
    team: string;
    sourceText: string;
  }>;
  fallback: string | null;
  warnings: string[];
};

export type AskRoute = "pending" | "structured_answer" | "moment_retrieval" | "empty" | "error";

export type AskOperationStep = {
  id: string;
  label: string;
  owner: "router" | "knowledge" | "retrieval" | "analysis" | "platform";
  input: string;
  output: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "fallback";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
};

export type AskOperation = {
  id: string;
  query: string;
  indexId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  route: AskRoute;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  steps: AskOperationStep[];
};

export type AskResponse = {
  operation: AskOperation;
  route: AskRoute;
  answer: string | null;
  queryPlan: DomainQueryPlan | null;
  orchestrationPlan: OrchestrationPlan | null;
  sportsAnswer: SportsKnowledgeAnswer | null;
  results: SearchResult[];
  warnings: string[];
};

export type OrchestrationPlan = {
  query: string;
  mode: "search" | "analysis" | "search_and_analysis" | "structured_answer";
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
    owner: "router" | "knowledge" | "retrieval" | "analysis" | "platform";
    action: string;
    input: string;
    output: string;
    status: "ready" | "needs_review" | "fallback";
    trigger: string;
  }>;
  retrieval: {
    engine: "semantic_retrieval" | "structured_domain" | "hybrid";
    filters: DomainSearchFilters;
    fallback: string[];
  };
  analysis: {
    required: boolean;
    model: "pattern_analysis_generate" | "none";
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

export type TrackingRecord = {
  id: string;
  indexId: string;
  assetId: string;
  segmentId: string;
  trackType: "player" | "ball" | "link";
  trackId: string;
  linkedTrackId: string | null;
  start: number;
  end: number;
  frameAt: number | null;
  status: "not_configured" | "estimated" | "tracked";
  confidence: number;
  fieldZone: VisionEvidence["fieldZone"]["zone"];
  direction: NonNullable<NonNullable<VisionEvidence["tracking"]>["ballMovement"]>["direction"];
  speedPerSecond: number | null;
  normalizedDistance: number | null;
  player: string | null;
  event: string | null;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
};

export type TrackingSummary = {
  assetId?: string;
  records: number;
  players: number;
  balls: number;
  links: number;
  trackedSegments: number;
  updatedAt: string | null;
};

export type ClipDetailResult = {
  clip: ClipResult;
  asset: Pick<AssetRecord, "id" | "indexId" | "title" | "duration">;
  segment: TimelineSegment;
  verification: VerificationCheck[];
  reasons: SearchMatchReason[];
  tracking: TrackingRecord[];
  domainEvents: DomainEvent[];
};

export type SportsKnowledgeSnapshot = {
  domains?: Array<{
    id: KnowledgeSourceId;
    label: string;
    sport: "football" | "american_football";
    competitions: string[];
    teams: number;
    players: number;
    matchActivities: number;
    facts: number;
  }>;
  competitions: Array<{ value: string; aliases: string[]; domainGroup?: KnowledgeSourceId; sport?: "football" | "american_football" }>;
  teams: Array<{ value: string; aliases: string[]; domainGroup?: KnowledgeSourceId; league?: string }>;
  players: Array<{
    id: string;
    canonical: string;
    aliases: string[];
    sport: "football" | "american_football";
    league: string;
    activeSeasons: string[];
    teamsBySeason: Record<string, string>;
    provider?: "local" | "football-data" | "football-data-uk" | "kaggle" | "statbunker" | "statsbomb" | "nflverse" | "fbref";
    externalIds?: Record<string, string | number>;
    position?: string | null;
    shirtNumber?: number | null;
  }>;
  matchActivities?: Array<{
    id: string;
    provider: "football-data" | "football-data-uk" | "kaggle" | "statbunker" | "statsbomb" | "nflverse" | "fbref";
    competition: string;
    season: string;
    matchId: number;
    utcDate: string | null;
    matchday: number | null;
    homeTeam: string;
    awayTeam: string;
    team: string;
    player: string;
    playerId: number | null;
    role: "STARTING" | "BENCH" | "GOAL" | "ASSIST" | "SUB_IN" | "SUB_OUT" | "CARD" | "STAT";
    minute: number | null;
    event: string;
    sourceText: string;
  }>;
  facts?: Array<{
    id: string;
    provider: "football-data" | "football-data-uk" | "kaggle" | "statbunker" | "statsbomb" | "nflverse" | "fbref";
    kind: "league_table" | "team_offense" | "team_defense" | "attendance" | "nationality_distribution" | "team_stat";
    competition: string;
    season: string;
    entityType: "team" | "competition" | "country";
    entityName: string;
    team?: string;
    metric: string;
    value: string | number;
    rank?: number | null;
    sourceText: string;
  }>;
};

export type AnalysisResult = {
  assetId: string;
  indexId: string;
  scope: {
    type: "asset" | "asset_group";
    label: string;
    assetCount: number;
  };
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
      tier?: "confirmed" | "likely" | "review";
    }>;
    gaps: string[];
  };
  evidence: {
    trustScore: number;
    tier: "verified" | "review" | "weak";
    hardChecks: number;
    softChecks: number;
    missingChecks: number;
    failedChecks: number;
    includedMoments: number;
    excludedMoments: number;
    confirmedPatterns: string[];
    likelyPatterns: string[];
    needsReview: string[];
    missingEvidence: string[];
    limitations: string[];
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

export type RuntimeStageRecord = {
  stage: string;
  status: "running" | "succeeded" | "failed";
  message: string;
  progress: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type JobStageCheckpoint = {
  stage: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  message: string;
  progress: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  attempts: number;
};

export type JobRecord = {
  id: string;
  type: JobType;
  status: JobStatus;
  stage: string;
  progress: number;
  indexId: string | null;
  assetId: string | null;
  parameters?: JobParameters;
  runtimeStages?: Record<string, RuntimeStageRecord>;
  stageCheckpoints?: Record<string, JobStageCheckpoint>;
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
