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

export type TimelineSegment = {
  id: string;
  start: number;
  end: number;
  label: string;
  transcript: string;
  tags: string[];
  modalities: Array<"visual" | "audio" | "transcription" | "metadata">;
  confidence: number;
  embedding: number[];
  thumbnailPath: string | null;
  sources: Array<"whisper" | "paddleocr" | "visual" | "metadata" | "shot">;
  scene?: {
    shotIndex: number;
    boundaryScore: number | null;
  };
};

export type WhisperSegment = {
  start: number;
  end: number;
  text: string;
};

export type OcrFrameResult = {
  framePath: string;
  tokens: string[];
  confidence: number;
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
  asr: {
    transcript: string;
    language: string;
    confidence: number;
    segments: WhisperSegment[];
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
};

export type AnalysisResult = {
  assetId: string;
  indexId: string;
  summary: string;
  answer: string;
  chapters: TimelineSegment[];
  signals: string[];
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
