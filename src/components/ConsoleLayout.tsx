import {
  Activity,
  CheckCircle2,
  Clock3,
  CreditCard,
  Database,
  FileVideo,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import type {
  AssetRecord,
  AssetSummaryRecord,
  CapabilityPolicy,
  ClipDetailResult,
  DomainQueryPlan,
  EventRecord,
  IdentityReviewPatchRequest,
  IndexRecord,
  JobRecord,
  KnowledgeSourceId,
  KnowledgeVectorStoreStatus,
  MetricsSummary,
  SearchResult,
  KnowledgeSnapshot
} from "../../shared/types";
import { KNOWLEDGE_SOURCES } from "../../shared/knowledgeSources";
import type { DatabaseStatus, ModelCapabilitiesSnapshot, ObservabilitySnapshot } from "../api";
import type { ConsoleTab, DialogMode, SearchKnowledgeContext, SearchScopeMode } from "../consoleTypes";
import { formatDuration, mediaPath } from "../displayUtils";
import { type SearchTrustFilters } from "../searchTrust";
import {
  AssetDetailTabs,
  AssetCatalogMetadataSummary,
  AssetComplianceSummary,
  AssetFlow,
  AssetGroupForm,
  AssetGroupSummary,
  AssetGroupStatusMarker,
  AssetStatusIndicator,
  ClipDetailDrawer,
  EmptyState,
  getAssetProgressLine,
  KnowledgePanel,
  TabButton,
  Timeline,
  VideoStatusSummary,
  type AssetDetailTab
} from "./ConsoleComponents";
import {
  SearchConversation,
  SearchScopeSelector,
  SearchScopeSummary,
  type SearchConversationTurn
} from "./SearchPanels";

export type ConsoleLayoutProps = {
  activeTab: ConsoleTab;
  setActiveTab: (tab: ConsoleTab) => void;
  indexes: IndexRecord[];
  assets: AssetSummaryRecord[];
  visibleAssets: AssetSummaryRecord[];
  selectedIndex: IndexRecord | null;
  selectedAsset: AssetRecord | null;
  selectedAssetLoading: boolean;
  selectedAssetJob: JobRecord | null;
  selectedSegment: AssetRecord["timeline"][number] | null;
  runningJobCount: number;
  refresh: () => Promise<void>;
  metrics: MetricsSummary;
  knowledgeSnapshot: KnowledgeSnapshot | null;
  knowledgeVectorStore: KnowledgeVectorStoreStatus | null;
  searchResults: SearchResult[];
  setDialogMode: Dispatch<SetStateAction<DialogMode>>;
  selectIndex: (indexId: string) => void;
  selectAsset: (asset: AssetSummaryRecord) => void;
  deleteIndex: (indexId: string) => Promise<void>;
  deleteAsset: (assetId: string) => Promise<void>;
  busy: boolean;
  assetDetailTab: AssetDetailTab;
  setAssetDetailTab: (tab: AssetDetailTab) => void;
  selectedKnowledgeDomain: KnowledgeSourceId;
  setSelectedKnowledgeDomain: (domain: KnowledgeSourceId) => void;
  playerRef: RefObject<HTMLVideoElement | null>;
  retryAssetStage: (assetId: string, stage: string) => Promise<void>;
  reviewIdentityCandidate: (request: IdentityReviewPatchRequest) => Promise<void>;
  selectSegment: (assetId: string, segmentId: string, at: number) => void;
  deleteKnowledgePlayer: (id: string) => Promise<void>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  searching: boolean;
  runSearch: (event: FormEvent) => Promise<void>;
  clearSearchHistory: () => void;
  searchScopeMode: SearchScopeMode;
  setSearchScopeMode: (mode: SearchScopeMode) => void;
  searchIndexId: string;
  setSearchIndexId: (indexId: string) => void;
  searchAssetId: string;
  setSearchAssetId: (assetId: string) => void;
  searchScopeLabel: string;
  trustFilters: SearchTrustFilters;
  useKnowledgeLayer: boolean;
  searchKnowledgeContext: SearchKnowledgeContext;
  searchConversation: SearchConversationTurn[];
  buildAssetMomentUrl: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  filteredSearchResults: SearchResult[];
  queryPlan: DomainQueryPlan | null;
  jobs: JobRecord[];
  retryJob: (id: string) => Promise<void>;
  events: EventRecord[];
  dbStatus: DatabaseStatus | null;
  observability: ObservabilitySnapshot | null;
  modelCapabilities: ModelCapabilitiesSnapshot | null;
  clipDetail: ClipDetailResult | null;
  clipDetailLoading: boolean;
  setClipDetail: Dispatch<SetStateAction<ClipDetailResult | null>>;
  dialogMode: DialogMode;
  createIndex: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  updateIndex: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  uploadAsset: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  message: string;
};

type SearchVideoPreview = {
  asset: Pick<AssetRecord, "id" | "title" | "storedName">;
  segment: AssetRecord["timeline"][number];
  start?: number;
  end?: number;
  label?: string;
};

type ObservabilityMetric = ObservabilitySnapshot["latencyMetrics"][number];
type ObservabilityLog = ObservabilitySnapshot["recentLogs"][number];

type TechStackTagItem = {
  category: string;
  label: string;
  tooltip: string;
  kind?: "app" | "runtime" | "model" | "storage" | "policy";
  disabled?: boolean;
};

type TechStackTooltip = {
  text: string;
  left: number;
  top: number;
  maxWidth: number;
};

type AssetOverviewFact = {
  label: string;
  value: string;
};

type AssetOverviewSummary = {
  content: string[];
  evidence: string[];
  metadataTerms: string[];
};

type SystemValueProps = {
  children: ReactNode;
  numeric?: boolean;
};

const countFormatter = new Intl.NumberFormat("en-US");

function formatCount(value: number) {
  return countFormatter.format(value);
}

function formatUnitCount(value: number, unit: string) {
  return `${formatCount(value)} ${value === 1 ? unit : `${unit}s`}`;
}

function formatCountRatio(value: number, total: number) {
  return `${formatCount(value)}/${formatCount(total)}`;
}

function SystemValue({ children, numeric = false }: SystemValueProps) {
  return <strong className={numeric ? "system-numeric-value" : undefined}>{children}</strong>;
}

function SystemFact({ label, value, numeric = false }: { label: string; value: ReactNode; numeric?: boolean }) {
  return (
    <span>
      <b>{label}</b>
      <SystemValue numeric={numeric}>{value}</SystemValue>
    </span>
  );
}

function buildAssetOverviewFacts(asset: AssetRecord): AssetOverviewFact[] {
  return [
    { label: "Duration", value: formatDuration(asset.duration ?? 0) },
    {
      label: "Frame",
      value: [
        asset.width && asset.height ? `${asset.width}x${asset.height}` : "No dimensions",
        asset.technicalMetadata.frameRate ? `${Math.round(asset.technicalMetadata.frameRate)}fps` : ""
      ]
        .filter(Boolean)
        .join(" · ")
    },
    {
      label: "Codec",
      value: [
        asset.technicalMetadata.videoCodec ?? "No video codec",
        asset.technicalMetadata.audioCodec ? `audio ${asset.technicalMetadata.audioCodec}` : ""
      ]
        .filter(Boolean)
        .join(" · ")
    },
    { label: "Detail", value: `${asset.timeline.length} moments · ${asset.keyframes.length} keyframes` },
    { label: "ASR", value: `${Math.round(asset.intelligence.asr.confidence * 100)}%` },
    { label: "OCR", value: `${asset.intelligence.ocr.tokens.length} tokens` },
    { label: "Color", value: asset.intelligence.visual.dominantColor },
    { label: "Frame change", value: asset.intelligence.visual.motionScore.toString() }
  ];
}

export function buildAssetOverviewSummary(summary: string): AssetOverviewSummary {
  const fallback = "Indexing metadata is not ready yet.";
  const cleaned = summary.trim();
  if (!cleaned) return { content: [fallback], evidence: [], metadataTerms: [] };

  const sections = parseLabeledAssetSummary(cleaned);
  const content = splitSummaryContent(formatAssetSummaryIntro(sections.content || cleaned));

  return {
    content: content.length > 0 ? content : [fallback],
    evidence: splitSummaryList(sections.evidence),
    metadataTerms: splitSummaryList(sections.metadata)
  };
}

function parseLabeledAssetSummary(summary: string) {
  type SummarySectionKey = "content" | "evidence" | "metadata";
  const labels: Array<{ key: SummarySectionKey; label: string }> = [
    { key: "content", label: "Content summary:" },
    { key: "evidence", label: "Evidence coverage:" },
    { key: "evidence", label: "Evidence sources:" },
    { key: "metadata", label: "Metadata terms:" }
  ];
  const matches = labels
    .map((item) => ({ ...item, index: summary.indexOf(item.label) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (matches.length === 0) return { content: summary, evidence: "", metadata: "" };

  const sections: Record<SummarySectionKey, string> = { content: "", evidence: "", metadata: "" };
  if (matches[0].index > 0) {
    sections.content = summary.slice(0, matches[0].index).trim();
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const value = summary.slice(current.index + current.label.length, next?.index ?? summary.length).trim();
    sections[current.key] = [sections[current.key], value].filter(Boolean).join("; ");
  }
  return sections;
}

function formatAssetSummaryIntro(intro: string) {
  const cleaned = intro.replace(/^Content summary:\s*/i, "").replace(/\s*\.\s*$/, "").trim();
  const match = cleaned.match(/^This asset was indexed into (\d+) timeline segments using (.+)$/i);
  if (match) return `Indexed into ${match[1]} timeline segments with ${match[2]}.`;
  return cleaned;
}

function splitSummaryContent(text: string) {
  const normalized = text
    .replace(/([가-힣])\s+([A-Z])/g, "$1; $2")
    .replace(/([.!?])\s+(?=[A-Z0-9가-힣])/g, "$1; ")
    .trim();
  return normalized
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitSummaryList(text: string) {
  return text
    .replace(/\s*\.\s*$/, "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function TechStackTags({ items }: { items: readonly (string | TechStackTagItem)[] }) {
  const [tooltip, setTooltip] = useState<TechStackTooltip | null>(null);
  function showTooltip(element: HTMLElement, tag: TechStackTagItem) {
    const rect = element.getBoundingClientRect();
    const margin = 16;
    const maxWidth = Math.min(420, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, window.innerWidth - maxWidth - margin));
    setTooltip({
      text: `${tag.category}: ${tag.tooltip}`,
      left,
      top: rect.bottom + 8,
      maxWidth
    });
  }

  return (
    <h2 className="section-stack-title tech-stack-tags" aria-label={items.map((item) => (typeof item === "string" ? item : `${item.category} ${item.label}`)).join(", ")}>
      {items.map((item) => {
        const tag = typeof item === "string" ? legacyTechStackTag(item) : item;
        return (
          <span
            key={`${tag.category}:${tag.label}`}
            className="tech-stack-tag"
            data-kind={tag.kind ?? "app"}
            data-disabled={tag.disabled ? "true" : undefined}
            data-tooltip={`${tag.category}: ${tag.tooltip}`}
            tabIndex={0}
            aria-label={`${tag.category}: ${tag.label}. ${tag.tooltip}`}
            onPointerEnter={(event) => showTooltip(event.currentTarget, tag)}
            onPointerLeave={() => setTooltip(null)}
            onFocus={(event) => showTooltip(event.currentTarget, tag)}
            onBlur={() => setTooltip(null)}
          >
            <b>{tag.category}</b>
            <span>{tag.label}</span>
          </span>
        );
      })}
      {tooltip && (
        <span
          className="tech-stack-tooltip"
          style={{ left: tooltip.left, top: tooltip.top, maxWidth: tooltip.maxWidth }}
          aria-hidden="true"
        >
          {tooltip.text}
        </span>
      )}
    </h2>
  );
}

function legacyTechStackTag(label: string): TechStackTagItem {
  return {
    category: "Stack",
    label,
    tooltip: `${label} is used in this console area.`,
    kind: "app"
  };
}

function buildAssetTechStackTags(
  index: IndexRecord | null,
  capabilities: ModelCapabilitiesSnapshot | null,
  dbStatus: DatabaseStatus | null
): TechStackTagItem[] {
  const configured = capabilities?.configuredModels;
  const modelFlags = capabilities?.models ?? {};
  const tools = capabilities?.tools ?? {};
  const policy = index?.capabilityPolicy;
  const textEmbedding = configured?.textEmbedding;
  const visualEmbedding = configured?.visualEmbedding;
  const asr = configured?.asr;
  const diarization = configured?.diarization;
  const ocr = configured?.ocr;
  const detector = configured?.visionDetector;
  const tracker = configured?.visionTracker;
  const videoVlm = configured?.videoVlm;
  const textDimensions = textEmbedding?.dimensions ?? dbStatus?.expectedEmbeddingDimensions;
  const visualDimensions = visualEmbedding?.dimensions ?? dbStatus?.expectedVisualEmbeddingDimensions;
  const vlmConfigured = videoVlm?.enabled ?? capabilities?.runtimeTopology?.vlm?.enabled;
  return [
    {
      category: "API",
      label: "Express / Multer",
      tooltip: "Used here for asset group CRUD, media upload handling, asset summaries, and indexing job requests.",
      kind: "app"
    },
    {
      category: "Media IO",
      label: "FFmpeg / ffprobe",
      tooltip: `Used for media probing, audio extraction, and frame extraction. ffmpeg ${availabilityText(tools.ffmpeg)}, ffprobe ${availabilityText(tools.ffprobe)}.`,
      kind: "runtime",
      disabled: tools.ffmpeg === false || tools.ffprobe === false
    },
    {
      category: "ASR model",
      label: `Whisper ${asr?.model ?? "large-v3"}`,
      tooltip: `Speech transcription model. Backend ${asr?.backend ?? "auto"}, language ${asr?.language ?? "auto"}, runtime ${runtimeModeText(capabilities, "asr")}, availability ${availabilityText(modelFlags.whisper)}.`,
      kind: "model",
      disabled: modelFlags.whisper === false
    },
    {
      category: "Diarization",
      label: `WhisperX ${diarization?.model ?? asr?.model ?? "large-v3"}`,
      tooltip: `Optional speaker diarization. Policy ${capabilityModeText(policy, "whisperXDiarization")}, token ${diarization?.tokenConfigured ? "configured" : "not configured"}, availability ${availabilityText(modelFlags.whisperx)}.`,
      kind: "model",
      disabled: policy?.whisperXDiarization === "disabled" || modelFlags.whisperx === false
    },
    {
      category: "OCR model",
      label: `PaddleOCR ${ocr?.language ?? "auto"}`,
      tooltip: `Frame text extraction for subtitles, scoreboards, overlays, and screen text. Workers ${ocr?.workers ?? 2}, runtime ${runtimeModeText(capabilities, "ocr")}, availability ${availabilityText(modelFlags.paddleocr)}.`,
      kind: "model",
      disabled: modelFlags.paddleocr === false
    },
    {
      category: "Text vectors",
      label: textEmbedding?.model ?? index?.models.embedding ?? "intfloat/multilingual-e5-base",
      tooltip: `SentenceTransformers embeddings for transcript, OCR, tags, timeline text, knowledge, and text query search${textDimensions ? ` at ${textDimensions} dimensions` : ""}. Runtime ${runtimeModeText(capabilities, "embedding")}.`,
      kind: "model",
      disabled: modelFlags.sentenceTransformers === false
    },
    {
      category: "Visual vectors",
      label: visualEmbedding?.model ?? "ViT-L-14/datacomp_xl_s13b_b90k",
      tooltip: `OpenCLIP image/text embeddings for keyframes and visual search${visualDimensions ? ` at ${visualDimensions} dimensions` : ""}. Availability ${availabilityText(modelFlags.openClip)}.`,
      kind: "model",
      disabled: modelFlags.openClip === false
    },
    {
      category: "VLM model",
      label: videoVlm?.model ?? capabilities?.runtimeTopology?.vlm?.model ?? "qwen-vl-local-worker",
      tooltip: `Qwen VL worker for segment captions, structured visual-language analysis, query planning, and related knowledge refinement. Policy ${capabilityModeText(policy, "videoVlmAnalysis")}, service ${vlmConfigured ? "enabled" : "not configured"}, availability ${availabilityText(modelFlags.qwenVlm)}.`,
      kind: "model",
      disabled: policy?.videoVlmAnalysis === "disabled" || vlmConfigured === false
    },
    {
      category: "Detector",
      label: detector?.model ?? "yolo11n.pt",
      tooltip: `Person/ball detector for sports evidence. Backend ${detector?.backend ?? "auto"}, provider ${detector?.provider ?? "Ultralytics YOLO / RF-DETR"}, confidence ${detector?.confidence ?? "0.25"}, policy ${capabilityModeText(policy, "visionDetector")}.`,
      kind: "model",
      disabled: policy?.visionDetector === "disabled" || (modelFlags.ultralytics === false && modelFlags.rfdetr === false)
    },
    {
      category: "Tracker",
      label: tracker?.tracker ?? "bytetrack.yaml",
      tooltip: `Multi-object tracking for detected players/balls. Confidence ${tracker?.confidence ?? "0.2"}, vid stride ${tracker?.vidStride ?? "3"}, policy ${capabilityModeText(policy, "visionTracker")}.`,
      kind: "model",
      disabled: policy?.visionTracker === "disabled" || modelFlags.ultralytics === false
    },
    {
      category: "Index search",
      label: index?.models.search ?? "local-semantic-retrieval",
      tooltip: `Selected asset group retrieval mode. Analysis label ${index?.models.analysis ?? "local-pattern-analysis"}.`,
      kind: "policy"
    }
  ];
}

function buildSearchTechStackTags(capabilities: ModelCapabilitiesSnapshot | null, dbStatus: DatabaseStatus | null): TechStackTagItem[] {
  const configured = capabilities?.configuredModels;
  const modelFlags = capabilities?.models ?? {};
  const queryPlanner = configured?.queryPlanner;
  const textEmbedding = configured?.textEmbedding;
  const visualEmbedding = configured?.visualEmbedding;
  const textDimensions = textEmbedding?.dimensions ?? dbStatus?.expectedEmbeddingDimensions;
  const visualDimensions = visualEmbedding?.dimensions ?? dbStatus?.expectedVisualEmbeddingDimensions;
  return [
    {
      category: "Query planner",
      label: queryPlanner?.model ?? "gpt-5.4-mini",
      tooltip: `OpenAI planner for converting natural-language searches into retrieval filters and response modes. Planner ${queryPlanner?.enabled === false ? "disabled" : "enabled or available when configured"}.`,
      kind: "model",
      disabled: queryPlanner?.enabled === false
    },
    {
      category: "Text vectors",
      label: textEmbedding?.model ?? "intfloat/multilingual-e5-base",
      tooltip: `Embeds user text queries and indexed timeline evidence${textDimensions ? ` at ${textDimensions} dimensions` : ""}. Availability ${availabilityText(modelFlags.sentenceTransformers)}.`,
      kind: "model",
      disabled: modelFlags.sentenceTransformers === false
    },
    {
      category: "Visual vectors",
      label: visualEmbedding?.model ?? "ViT-L-14/datacomp_xl_s13b_b90k",
      tooltip: `OpenCLIP text/image vectors for visual search and keyframe matching${visualDimensions ? ` at ${visualDimensions} dimensions` : ""}. Availability ${availabilityText(modelFlags.openClip)}.`,
      kind: "model",
      disabled: modelFlags.openClip === false
    },
    {
      category: "Vector DB",
      label: "PostgreSQL / pgvector",
      tooltip: `Search reads timeline and visual vectors from pgvector. Text column ${dbStatus?.embeddingColumn ?? "app_vectors.embedding"}, visual column ${dbStatus?.visualEmbeddingColumn ?? "app_visual_vectors.embedding"}.`,
      kind: "storage",
      disabled: dbStatus?.ready === false
    },
    {
      category: "Ranking",
      label: "hybrid lexical ranking",
      tooltip: "Combines vector retrieval with lexical matching, trust filters, and evidence source constraints.",
      kind: "policy"
    },
    {
      category: "Ask queue",
      label: "Redis / BullMQ",
      tooltip: "Runs ask/search operations asynchronously and streams operation state back to the console.",
      kind: "runtime"
    }
  ];
}

function buildKnowledgeTechStackTags(
  capabilities: ModelCapabilitiesSnapshot | null,
  dbStatus: DatabaseStatus | null,
  vectorStore: KnowledgeVectorStoreStatus | null
): TechStackTagItem[] {
  const textEmbedding = capabilities?.configuredModels?.textEmbedding;
  const modelFlags = capabilities?.models ?? {};
  const textDimensions = textEmbedding?.dimensions ?? dbStatus?.expectedEmbeddingDimensions;
  return [
    {
      category: "Registry",
      label: "Sports knowledge",
      tooltip: "Selected sports registry data such as teams, players, match activities, facts, and plays.",
      kind: "app"
    },
    {
      category: "Adapters",
      label: "football-data / StatBunker / StatsBomb / nflverse",
      tooltip: "Knowledge import adapters used to build the local related-knowledge corpus.",
      kind: "app"
    },
    {
      category: "Knowledge vectors",
      label: textEmbedding?.model ?? "intfloat/multilingual-e5-base",
      tooltip: `Embeds related knowledge records for grounding and retrieval${textDimensions ? ` at ${textDimensions} dimensions` : ""}. Availability ${availabilityText(modelFlags.sentenceTransformers)}.`,
      kind: "model",
      disabled: modelFlags.sentenceTransformers === false
    },
    {
      category: "Vector store",
      label: vectorStore?.storage === "postgres" ? "PostgreSQL / pgvector" : "local vector store",
      tooltip: `Stores ${vectorStore?.vectors ?? 0} related-knowledge vectors across ${(vectorStore?.domains ?? []).join(", ") || "loaded domains"}.`,
      kind: "storage",
      disabled: dbStatus?.ready === false
    },
    {
      category: "Grounding",
      label: "evidence contracts",
      tooltip: "Keeps selected knowledge, video evidence, and generated answers tied to explicit source records.",
      kind: "policy"
    }
  ];
}

function buildSystemTechStackTags(capabilities: ModelCapabilitiesSnapshot | null, dbStatus: DatabaseStatus | null): TechStackTagItem[] {
  return [
    {
      category: "Frontend",
      label: "React / Vite",
      tooltip: "Console UI, tabs, panels, routing state, and local interaction state.",
      kind: "app"
    },
    {
      category: "Backend",
      label: "Node.js / Express",
      tooltip: "HTTP API, system routes, asset routes, job routes, search orchestration, and static media serving.",
      kind: "app"
    },
    {
      category: "Runtime check",
      label: capabilities ? (capabilities.available === false ? "not checked" : "checked") : "pending",
      tooltip: capabilities?.available === false
        ? `Model availability check failed: ${capabilities.error ?? "unknown error"}.`
        : `Model availability snapshot ${capabilities?.checkedAt ?? "has not loaded yet"}.`,
      kind: "runtime",
      disabled: capabilities?.available === false
    },
    {
      category: "Database",
      label: "PostgreSQL / pgvector",
      tooltip: `Application state and vectors use PostgreSQL/pgvector. Status ${dbStatus?.ready === false ? "not ready" : "ready or pending"}.`,
      kind: "storage",
      disabled: dbStatus?.ready === false
    },
    {
      category: "Queue",
      label: "Redis / BullMQ",
      tooltip: "Background indexing, asset refinement, ask/search jobs, and worker coordination.",
      kind: "runtime"
    },
    {
      category: "Observability",
      label: "OpenTelemetry / NDJSON logs",
      tooltip: "Trace spans, latency metrics, model runtime metrics, and structured application logs.",
      kind: "runtime"
    }
  ];
}

function runtimeModeText(capabilities: ModelCapabilitiesSnapshot | null, kind: string) {
  const category = capabilities?.runtimeTopology?.python?.categories?.find((item) => item.kind === kind);
  if (!category) return capabilities?.runtimeTopology?.python?.boundary ?? "not checked";
  return category.splitByCategory ? `${category.mode} (${category.serviceUrl ?? "category URL"})` : category.mode;
}

function capabilityModeText(policy: CapabilityPolicy | undefined, key: keyof CapabilityPolicy) {
  return policy?.[key] ?? "optional";
}

function availabilityText(value: boolean | undefined) {
  if (value === true) return "available";
  if (value === false) return "unavailable";
  return "not checked";
}

export function ConsoleLayout(props: ConsoleLayoutProps) {
  const {
    activeTab,
    setActiveTab,
    indexes,
    assets,
    visibleAssets,
    selectedIndex,
    selectedAsset,
    selectedAssetLoading,
    selectedAssetJob,
    selectedSegment,
    runningJobCount,
    refresh,
    metrics,
    knowledgeSnapshot,
    knowledgeVectorStore,
    searchResults,
    setDialogMode,
    selectIndex,
    selectAsset,
    deleteIndex,
    deleteAsset,
    busy,
    assetDetailTab,
    setAssetDetailTab,
    selectedKnowledgeDomain,
    setSelectedKnowledgeDomain,
    playerRef,
    retryAssetStage,
    reviewIdentityCandidate,
    selectSegment,
    deleteKnowledgePlayer,
    query,
    setQuery,
    searching,
    runSearch,
    clearSearchHistory,
    searchScopeMode,
    setSearchScopeMode,
    searchIndexId,
    setSearchIndexId,
    searchAssetId,
    setSearchAssetId,
    searchScopeLabel,
    trustFilters,
    useKnowledgeLayer,
    searchKnowledgeContext,
    searchConversation,
    buildAssetMomentUrl,
    jobs,
    retryJob,
    events,
    dbStatus,
    observability,
    modelCapabilities,
    clipDetail,
    clipDetailLoading,
    setClipDetail,
    dialogMode,
    createIndex,
    updateIndex,
    uploadAsset,
    message
  } = props;
  const [searchVideoPreview, setSearchVideoPreview] = useState<SearchVideoPreview | null>(null);
  const [searchTargetOpen, setSearchTargetOpen] = useState(false);
  const searchTargetPopoverRef = useRef<HTMLDivElement | null>(null);
  const knowledgeDomains = knowledgeSnapshot?.domains ?? defaultKnowledgeDomains();
  const effectiveKnowledgeDomain = knowledgeDomains.find((domain) => domain.id === selectedKnowledgeDomain)?.id ?? knowledgeDomains[0]?.id ?? KNOWLEDGE_SOURCES[0]?.id ?? "";
  const knowledgeRecordCount = sumKnowledgeDomainDocuments(knowledgeDomains);
  const observabilityView = observability ? buildObservabilityView(observability) : null;
  const failedJobCount = jobs.filter((job) => job.status === "failed").length;
  const succeededJobCount = jobs.filter((job) => job.status === "succeeded").length;
  const visibleEvents = events.slice(0, 8);
  const activeJobCount = Math.max(runningJobCount, metrics.runningJobs);
  const activeAssetIds = new Set(
    jobs.filter((job) => (job.status === "queued" || job.status === "running") && job.assetId).map((job) => job.assetId as string)
  );
  const selectedIndexDeleteDisabled = Boolean(
    selectedIndex &&
      jobs.some(
        (job) =>
          (job.status === "queued" || job.status === "running") &&
          (job.indexId === selectedIndex.id || (job.assetId && visibleAssets.some((asset) => asset.id === job.assetId)))
      )
  );
  const assetTechStacks = buildAssetTechStackTags(selectedIndex, modelCapabilities, dbStatus);
  const knowledgeTechStacks = buildKnowledgeTechStackTags(modelCapabilities, dbStatus, knowledgeVectorStore);
  const searchTechStacks = buildSearchTechStackTags(modelCapabilities, dbStatus);
  const systemTechStacks = buildSystemTechStackTags(modelCapabilities, dbStatus);

  useEffect(() => {
    if (searching) setSearchVideoPreview(null);
  }, [searching]);

  useEffect(() => {
    if (!searchTargetOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (searchTargetPopoverRef.current?.contains(target)) return;
      setSearchTargetOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSearchTargetOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [searchTargetOpen]);

  useEffect(() => {
    if (knowledgeDomains.some((domain) => domain.id === selectedKnowledgeDomain)) return;
    setSelectedKnowledgeDomain(knowledgeDomains[0]?.id ?? KNOWLEDGE_SOURCES[0]?.id ?? "");
  }, [knowledgeDomains, selectedKnowledgeDomain]);

  function openSearchVideo(
    asset: Pick<AssetRecord, "id" | "title" | "storedName">,
    segment: AssetRecord["timeline"][number],
    options: { start?: number; end?: number; label?: string } = {}
  ) {
    setSearchVideoPreview({ asset, segment, ...options });
  }

  function closeDialog() {
    setDialogMode(null);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <section className="context-bar" aria-label="Current context">
          <div className="context-combined">
            <span>Dataset</span>
            <strong>{formatCountRatio(metrics.indexedAssets, metrics.assets)} indexed · {formatUnitCount(indexes.length, "group")}</strong>
          </div>
          <div>
            <span>Queue</span>
            <strong>{activeJobCount > 0 ? `${formatCount(activeJobCount)} active` : "clear"}</strong>
          </div>
        </section>
        <button className="ghost-button icon-only" type="button" aria-label="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={16} />
        </button>
      </header>

      <nav className="view-tabs" aria-label="Console sections">
        <a className="brand-logo" href="/" aria-label="Arion.AI home">
          <span className="brand-mark" aria-hidden="true">
            <img src="/arion-logo.png?v=20260508" alt="" />
          </span>
          <span className="brand-copy">
            <strong>Arion.AI</strong>
            <em>Video Intelligence</em>
          </span>
        </a>
        <TabButton
          active={activeTab === "data"}
          icon={<FileVideo size={17} />}
          label="Assets"
          meta={`${formatUnitCount(indexes.length, "group")} · ${formatUnitCount(assets.length, "asset")}`}
          onClick={() => setActiveTab("data")}
        />
        {activeTab === "data" && (
          <section className="asset-nav" aria-label="Data navigation">
            <div className="asset-nav-header">
              <span>Asset Groups</span>
              <button type="button" className="nav-add-button" aria-label="Create asset group" onClick={() => setDialogMode("index")}>
                <Plus size={14} />
              </button>
            </div>
            <div className="asset-nav-list">
              {indexes.map((index) => {
                const indexAssets = assets.filter((asset) => asset.indexId === index.id);
                const indexedCount = indexAssets.filter((asset) => asset.status === "indexed").length;
                return (
                  <button key={index.id} type="button" className={`asset-nav-item ${selectedIndex?.id === index.id ? "active" : ""}`} onClick={() => selectIndex(index.id)}>
                    <span className="asset-nav-title-with-marker">
                      <AssetGroupStatusMarker index={index} assets={indexAssets} />
                      <span>{index.name}</span>
                    </span>
                    <strong>{formatCountRatio(indexedCount, indexAssets.length)}</strong>
                  </button>
                );
              })}
            </div>

            <div className="asset-nav-header nested">
              <span>Videos</span>
              <button type="button" className="nav-add-button" aria-label="Add video" onClick={() => setDialogMode("asset")}>
                <Plus size={14} />
              </button>
            </div>
            <div className="asset-nav-list video-list">
              {visibleAssets.length === 0 && <p>No videos</p>}
              {visibleAssets.map((asset) => (
                <button key={asset.id} type="button" className={`asset-nav-item video ${selectedAsset?.id === asset.id ? "active" : ""}`} onClick={() => selectAsset(asset)}>
                  <span className="asset-nav-title">{asset.title}</span>
                  <AssetStatusIndicator asset={asset} />
                </button>
              ))}
            </div>
          </section>
        )}
        <TabButton
          active={activeTab === "search"}
          icon={<Search size={17} />}
          label="Search"
          meta={formatUnitCount(searchResults.length, "result")}
          onClick={() => setActiveTab("search")}
        />
        <TabButton
          active={activeTab === "knowledge"}
          icon={<Layers3 size={17} />}
          label="Knowledge"
          meta={knowledgeSnapshot ? formatUnitCount(knowledgeRecordCount, "record") : "loading"}
          onClick={() => setActiveTab("knowledge")}
        />
        {activeTab === "knowledge" && (
          <section className="asset-nav knowledge-nav" aria-label="Related knowledge navigation">
            <div className="asset-nav-header">
              <span>Related Knowledge</span>
            </div>
            <div className="asset-nav-list">
              {knowledgeDomains.map((domain) => (
                <button
                  key={domain.id}
                  type="button"
                  className={`asset-nav-item ${effectiveKnowledgeDomain === domain.id ? "active" : ""}`}
                  onClick={() => setSelectedKnowledgeDomain(domain.id)}
                >
                  <span>{domain.label}</span>
                  <strong>{formatCountRatio(domain.players, domain.teams)}</strong>
                </button>
              ))}
            </div>
          </section>
        )}
        <TabButton
          active={activeTab === "system"}
          icon={<Activity size={17} />}
          label="System"
          meta={activeJobCount > 0 ? `${formatCount(activeJobCount)} active` : `${formatCountRatio(metrics.indexedAssets, metrics.assets)} indexed`}
          onClick={() => setActiveTab("system")}
        />
      </nav>

      {activeTab === "data" && (
      <section className="section-block workflow-section">
        <div className="section-heading">
          <div>
            <TechStackTags items={assetTechStacks} />
          </div>
        </div>
        <AssetGroupSummary
          index={selectedIndex}
          assets={visibleAssets}
          modelCapabilities={modelCapabilities}
          onEdit={() => setDialogMode("edit-index")}
          onDelete={() => selectedIndex && void deleteIndex(selectedIndex.id)}
          deleteDisabled={busy || selectedIndexDeleteDisabled}
          deleteTitle={selectedIndexDeleteDisabled ? "인덱싱 중인 영상이 있어 에셋그룹을 삭제할 수 없습니다." : "에셋그룹 삭제"}
        />
      <section className="asset-workbench asset-detail-workbench">
        <section className="panel detail-panel">
          {selectedAsset ? (
            <>
              <div className="detail-header">
                <div>
                  <h2>{selectedAsset.title}</h2>
                  <span className="video-progress-line">{getAssetProgressLine(selectedAsset, selectedAssetJob)}</span>
                </div>
                <div className="detail-actions">
                  <VideoStatusSummary asset={selectedAsset} />
                  <button
                    type="button"
                    className="small-button icon-only danger-button"
                    aria-label="영상 삭제"
                    title={activeAssetIds.has(selectedAsset.id) ? "인덱싱 중인 영상은 삭제할 수 없습니다." : "영상 삭제"}
                    disabled={busy || activeAssetIds.has(selectedAsset.id)}
                    onClick={() => void deleteAsset(selectedAsset.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <AssetDetailTabs active={assetDetailTab} onChange={setAssetDetailTab} />
              {assetDetailTab === "overview" && (
                <section className="asset-detail-view">
                  {(() => {
                    const overviewSummary = buildAssetOverviewSummary(selectedAsset.summary);
                    return (
                      <>
                  <div className="asset-overview-layout">
                    <div className="asset-player-column">
                      <video key={selectedAsset.id} ref={playerRef} className="player" src={`/media/${selectedAsset.storedName}`} controls preload="metadata" />
                    </div>
                    <aside className="asset-metadata-strip" aria-label="Video technical and model details">
                      {buildAssetOverviewFacts(selectedAsset).map((fact) => (
                        <span key={fact.label} className="asset-metadata-fact">
                          <em>{fact.label}</em>
                          <strong>{fact.value}</strong>
                        </span>
                      ))}
                    </aside>
                  </div>
                  <section className="asset-summary-card" aria-label="Asset index summary">
                    <div className="asset-summary-primary">
                      <span>Index summary</span>
                      <div className="asset-summary-copy">
                        {overviewSummary.content.map((item, index) => (
                          <p key={`${index}-${item}`}>{item}</p>
                        ))}
                      </div>
                    </div>
                    {(overviewSummary.evidence.length > 0 || overviewSummary.metadataTerms.length > 0) && (
                      <div className="asset-summary-grid">
                        {overviewSummary.evidence.length > 0 && (
                          <div>
                            <strong>Evidence</strong>
                            <span className="asset-summary-chips">
                              {overviewSummary.evidence.map((item) => (
                                <em key={item}>{item}</em>
                              ))}
                            </span>
                          </div>
                        )}
                        {overviewSummary.metadataTerms.length > 0 && (
                          <div>
                            <strong>Metadata terms</strong>
                            <span className="asset-summary-chips">
                              {overviewSummary.metadataTerms.map((item) => (
                                <em key={item}>{item}</em>
                              ))}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                  <AssetCatalogMetadataSummary asset={selectedAsset} />
                  <AssetComplianceSummary asset={selectedAsset} />
                  <div className="chips">
                    {selectedAsset.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                      </>
                    );
                  })()}
                </section>
              )}
              {assetDetailTab === "workflow" && (
                <AssetFlow
                  asset={selectedAsset}
                  index={selectedIndex}
                  job={selectedAssetJob}
                  onRetryStage={retryAssetStage}
                  onReviewIdentity={reviewIdentityCandidate}
                  onOpenMoment={(segment, options) => openSearchVideo(selectedAsset, segment, options)}
                />
              )}
              {assetDetailTab === "timeline" && (
                <section className="asset-detail-view">
                  {selectedSegment && (
                    <div className="segment-inspector">
                      <strong>{selectedSegment.label}</strong>
                      <span>
                        {formatDuration(selectedSegment.start)}-{formatDuration(selectedSegment.end)} · confidence{" "}
                        {Math.round(selectedSegment.confidence * 100)}% · shot {selectedSegment.scene?.shotIndex ?? "-"}
                      </span>
                      <span>{selectedSegment.sources.join(", ")}</span>
                    </div>
                  )}
                  <div className="timeline-header">
                    <div>
                      <p className="section-label">Timeline</p>
                      <h3>{formatUnitCount(selectedAsset.timeline.length, "indexed moment")}</h3>
                    </div>
                    {selectedSegment && <span>{formatDuration(selectedSegment.start)} selected</span>}
                  </div>
                  <Timeline
                    asset={selectedAsset}
                    selectedSegmentId={selectedSegment?.id ?? null}
                    onSelect={(segment) => {
                      selectSegment(selectedAsset.id, segment.id, segment.start);
                      openSearchVideo(selectedAsset, segment);
                    }}
                  />
                </section>
              )}
            </>
          ) : selectedAssetLoading ? (
            <>
              <div className="panel-title detail-title">
                <FileVideo size={18} />
                <h2>Node workflow</h2>
              </div>
              <EmptyState text="Asset detail is loading." />
            </>
          ) : (
            <>
              <div className="panel-title detail-title">
                <FileVideo size={18} />
                <h2>Node workflow</h2>
              </div>
              <EmptyState text="Select or upload an asset." />
            </>
          )}
        </section>
      </section>
      </section>
      )}

      {activeTab === "knowledge" && (
      <section className="section-block knowledge-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Knowledge</p>
            <TechStackTags items={knowledgeTechStacks} />
          </div>
        </div>
        <KnowledgePanel
          knowledgeSnapshot={knowledgeSnapshot}
          selectedDomain={effectiveKnowledgeDomain}
          knowledgeVectorStore={knowledgeVectorStore}
          onDelete={deleteKnowledgePlayer}
        />
      </section>
      )}

      {activeTab === "search" && (
      <section className="section-block discovery-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Search</p>
            <TechStackTags items={searchTechStacks} />
          </div>
        </div>
      <section className="tools">
        <section className="panel search-chat-panel">
          <div className="search-history-bar">
            <div>
              <span>Search history</span>
              <strong>{searchConversation.length} turns</strong>
            </div>
            <button type="button" className="small-button search-clear-button" disabled={searching || searchConversation.length === 0} onClick={clearSearchHistory}>
              <Trash2 size={14} />
              Clear
            </button>
          </div>
          <SearchConversation
            turns={searchConversation}
            trustFilters={trustFilters}
            getMomentHref={buildAssetMomentUrl}
            activeMoment={searchVideoPreview ? { assetId: searchVideoPreview.asset.id, segmentId: searchVideoPreview.segment.id } : null}
            onOpenMoment={(asset, segment, options) => openSearchVideo(asset, segment, options)}
          />
          {!searching && searchConversation.length === 0 && (
            <div className="assistant-empty-state">
              <Search size={24} />
              <strong>Ask Arion</strong>
            </div>
          )}
          <div className="search-composer-shell">
            <div className="search-target-popover-host" ref={searchTargetPopoverRef}>
              <SearchScopeSummary
                scopeLabel={searchScopeLabel}
                trustFilters={trustFilters}
                useKnowledgeLayer={useKnowledgeLayer}
                knowledgeContext={searchKnowledgeContext}
                onTargetClick={() => setSearchTargetOpen((current) => !current)}
                targetExpanded={searchTargetOpen}
                targetControlId="search-target-popover"
              />
              {searchTargetOpen && (
                <div id="search-target-popover" className="search-target-panel" role="dialog" aria-label="Search target options">
                  <SearchScopeSelector
                    mode={searchScopeMode}
                    onModeChange={setSearchScopeMode}
                    indexes={indexes}
                    assets={assets}
                    indexId={searchIndexId}
                    onIndexChange={setSearchIndexId}
                    assetId={searchAssetId}
                    onAssetChange={setSearchAssetId}
                    onRequestClose={() => setSearchTargetOpen(false)}
                  />
                </div>
              )}
            </div>
            <form onSubmit={runSearch} className="search-row search-form ask-form chat-composer">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask for stats, moments, clips, or patterns" />
              <button type="submit" disabled={searching} aria-label={searching ? "Searching" : "Ask"}>
                <Search size={16} />
                <span>{searching ? "Thinking" : "Ask"}</span>
              </button>
            </form>
          </div>
        </section>

      </section>
      </section>
      )}

      {activeTab === "system" && (
      <section className="section-block ops-section">
        <div className="section-heading">
          <div>
            <p className="section-label">System</p>
            <TechStackTags items={systemTechStacks} />
          </div>
        </div>
        <section className="system-console">
          <section className="system-kpi-grid" aria-label="Service snapshot">
            <article className="system-kpi">
              <CheckCircle2 size={18} />
              <span>Indexed Assets</span>
              <SystemValue numeric>{formatCountRatio(metrics.indexedAssets, metrics.assets)}</SystemValue>
              <em className="system-numeric-meta">{formatUnitCount(metrics.indexes, "index")}</em>
            </article>
            <article className="system-kpi">
              <Clock3 size={18} />
              <span>Jobs</span>
              <SystemValue numeric>{formatCount(metrics.runningJobs)}</SystemValue>
              <em className="system-numeric-meta">{formatCount(failedJobCount)} failed · {formatCount(succeededJobCount)} succeeded</em>
            </article>
            <article className="system-kpi">
              <Layers3 size={18} />
              <span>Timeline</span>
              <SystemValue numeric>{formatCount(metrics.segments)}</SystemValue>
              <em className="system-numeric-meta">{formatUnitCount(metrics.vectors, "vector")}</em>
            </article>
            <article className="system-kpi">
              <CreditCard size={18} />
              <span>Compute Units</span>
              <SystemValue numeric>{formatCount(metrics.billingUnits)}</SystemValue>
              <em>{dbStatus?.enabled ? "PostgreSQL" : dbStatus?.storage ?? "storage pending"}</em>
            </article>
          </section>

          <section className="system-status-strip" aria-label="Infrastructure and telemetry status">
            <article className="system-status-group">
              <div className="system-status-heading">
                <Database size={16} aria-hidden="true" />
                <span>Storage</span>
                <strong>Database</strong>
              </div>
              {dbStatus ? (
                <div className="system-status-facts">
                  <SystemFact label="Store" value={dbStatus.enabled ? "PostgreSQL" : dbStatus.storage ?? "File storage"} />
                  <SystemFact label="State" value={dbStatus.operationalState ?? (dbStatus.enabled ? "ready" : "local")} />
                  <SystemFact label="Vector" value={dbStatus.pgvector ? `${dbStatus.vectorSearchMode ?? "pgvector"} ${dbStatus.pgvector}` : dbStatus.vectorSearchMode ?? "off"} />
                  <SystemFact
                    label="Text"
                    value={dbStatus.embeddingColumn ?? `${formatCount(dbStatus.expectedEmbeddingDimensions ?? 0)} dimensions`}
                    numeric={!dbStatus.embeddingColumn}
                  />
                  <SystemFact
                    label="Visual"
                    value={dbStatus.visualEmbeddingColumn ?? `${formatCount(dbStatus.expectedVisualEmbeddingDimensions ?? 0)} dimensions`}
                    numeric={!dbStatus.visualEmbeddingColumn}
                  />
                </div>
              ) : (
                <span className="system-status-empty">Database status is loading.</span>
              )}
            </article>

            <article className="system-status-group">
              <div className="system-status-heading">
                <Activity size={16} aria-hidden="true" />
                <span>Telemetry</span>
                <strong>Observability</strong>
              </div>
              {observabilityView ? (
                <>
                  <p className="system-status-purpose">
                    Intent: expose request latency, worker pipeline health, trace correlation, and structured logs before indexing or search issues become silent failures.
                  </p>
                  <div className="system-observability-details">
                    <span>
                      <b>Trace</b>
                      <SystemValue numeric>{formatUnitCount(observabilityView.spanCount, "span")}</SystemValue>
                      <em>{observabilityView.traceStore} trace store keeps recent API and worker spans locally so trace IDs can connect jobs, logs, and request timing.</em>
                    </span>
                    <span>
                      <b>API p95</b>
                      <SystemValue numeric>{observabilityView.httpP95}</SystemValue>
                      <em>{observabilityView.httpSummary}. p95 highlights the slow edge of recent HTTP traffic, not the average case.</em>
                    </span>
                    <span>
                      <b>Pipeline</b>
                      <SystemValue numeric>{formatUnitCount(observabilityView.pipelineErrorCount, "error")}</SystemValue>
                      <em>{observabilityView.slowestLabel}. This catches slow or failing model/runtime stages while jobs are still moving.</em>
                    </span>
                    <span>
                      <b>Logs</b>
                      <strong>{observabilityView.logFormat}</strong>
                      <em>Structured log stream at {observabilityView.logPath}; use requestId and traceId to inspect exact runtime behavior.</em>
                    </span>
                  </div>
                  {observabilityView.pipelineMetrics.length > 0 && (
                    <div className="system-inline-metrics">
                      {observabilityView.pipelineMetrics.slice(0, 3).map((metric) => (
                        <span key={metric.key} className={metric.lastStatus === "error" ? "error" : ""}>
                          <b title={formatMetricName(metric.key)}>{formatCompactMetricName(metric.key)}</b>
                          <SystemValue numeric>p95 {formatLatency(metric.p95Ms)} · {formatUnitCount(metric.errorCount, "error")}</SystemValue>
                          <em>{metric.lastStatus === "error" && metric.lastError ? `Last error: ${metric.lastError}` : describeObservabilityMetricIntent(metric.key)}</em>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span className="system-status-empty">Observability data is loading.</span>
              )}
            </article>
          </section>

          <section className="system-workspace">
            <section className="panel system-panel system-jobs-panel">
              <div className="system-panel-header">
                <div>
                  <p className="section-label">Queue</p>
                  <h2>Jobs</h2>
                </div>
                <div className="system-panel-counts">
                  <span>{formatCount(jobs.length)} total</span>
                  <span>{formatCount(metrics.runningJobs)} running</span>
                </div>
              </div>

              <div className="system-job-list">
                {jobs.map((job) => (
                  <article key={job.id} className={`system-job-row ${job.status}`}>
                    <div className="system-job-main">
                      <span className={`system-status-pill ${job.status}`}>{formatJobStatus(job.status)}</span>
                      <strong>{formatJobTypeLabel(job.type)}</strong>
                      <span>{formatJobStageLabel(job)}</span>
                      <span>{formatJobProgressLabel(job)}</span>
                      <time>{formatRelativeTime(job.updatedAt)}</time>
                    </div>
                    {job.assetId && (
                      <button
                        type="button"
                        className="small-button icon-only retry-button"
                        onClick={() => void retryJob(job.id)}
                        aria-label={`Retry ${formatJobTypeLabel(job.type)}`}
                        title={`Retry ${formatJobTypeLabel(job.type)}`}
                      >
                        <RefreshCw size={14} aria-hidden="true" />
                      </button>
                    )}
                  </article>
                ))}
                {jobs.length === 0 && <EmptyState text="No jobs have been recorded." />}
              </div>
            </section>

            <aside className="system-side-column">
              <section className="panel system-panel system-events-panel">
                <div className="system-panel-header">
                  <div>
                    <p className="section-label">Event Feed</p>
                    <h2>Events</h2>
                  </div>
                  <span className="panel-count">{formatCount(events.length)}</span>
                </div>
                <div className="system-event-list">
                  {visibleEvents.map((event) => (
                    <article key={event.id} className="system-event-row">
                      <strong>{formatEventTypeLabel(event.type)}</strong>
                      <span>{event.message}</span>
                      <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                    </article>
                  ))}
                  {events.length === 0 && <EmptyState text="No operational events have been recorded." />}
                </div>
              </section>
            </aside>
          </section>
        </section>
      </section>
      )}

      {searchVideoPreview && (
        <SearchVideoPreviewPanel
          preview={searchVideoPreview}
          onClose={() => setSearchVideoPreview(null)}
          onOpenAsset={(assetId, segmentId, at) => selectSegment(assetId, segmentId, at)}
        />
      )}

      {(clipDetail || clipDetailLoading) && (
        <ClipDetailDrawer
          detail={clipDetail}
          loading={clipDetailLoading}
          onClose={() => setClipDetail(null)}
          onSeek={(assetId, segmentId, at) => {
            const asset = assets.find((item) => item.id === assetId);
            if (asset && clipDetail?.segment.id === segmentId) {
              openSearchVideo(asset, clipDetail.segment, { start: at, end: clipDetail.clip.end, label: clipDetail.clip.title });
            }
            selectSegment(assetId, segmentId, at);
          }}
        />
      )}

      {dialogMode && (
        <section className="modal-backdrop" role="presentation" onMouseDown={closeDialog}>
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="asset-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="section-label">{dialogMode === "asset" ? "Upload" : "Asset Group"}</p>
                <h2 id="asset-dialog-title">
                  {dialogMode === "index"
                    ? "에셋그룹 만들기"
                    : dialogMode === "edit-index"
                      ? "에셋그룹 수정"
                      : "영상 추가"}
                </h2>
              </div>
              <button type="button" className="small-button icon-only" aria-label="닫기" onClick={closeDialog}>
                <X size={16} />
              </button>
            </div>

            {dialogMode === "index" || dialogMode === "edit-index" ? (
              <AssetGroupForm
                index={dialogMode === "edit-index" ? selectedIndex : null}
                onSubmit={dialogMode === "edit-index" ? updateIndex : createIndex}
              />
            ) : (
              <form className="stack compact" onSubmit={uploadAsset}>
                <p className="modal-kicker">{selectedIndex?.name ?? "Default video intelligence index"} 에셋그룹에 영상을 추가합니다.</p>
                <input name="title" placeholder="영상 제목" autoFocus />
                <textarea name="description" placeholder="검색과 분석에 참고할 설명" />
                <input name="video" type="file" accept="video/*,audio/*" />
                <button type="submit" disabled={busy}>
                  <UploadCloud size={16} />
                  {busy ? "업로드 중" : "영상 추가 및 분석 시작"}
                </button>
              </form>
            )}
            {message && <p className="hint">{message}</p>}
          </div>
        </section>
      )}
    </main>
  );
}

function sumKnowledgeDomainDocuments(domains: NonNullable<KnowledgeSnapshot["domains"]>) {
  return domains.reduce(
    (total, domain) => total + domain.competitions.length + domain.teams + domain.players + domain.matchActivities + domain.facts + (domain.plays ?? 0),
    0
  );
}

function defaultKnowledgeDomains(): NonNullable<KnowledgeSnapshot["domains"]> {
  return [
    { id: "sports.football", label: "Football", sport: "football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0, plays: 0 },
    { id: "sports.american_football", label: "American football", sport: "american_football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0, plays: 0 }
  ];
}

function formatJobTypeLabel(type: JobRecord["type"]) {
  const labels: Record<JobRecord["type"], string> = {
    "asset.index": "Index asset",
    "asset.reindex": "Reindex asset",
    "asset.domain-vlm.refine": "Related knowledge VLM",
    "webhook.test": "Webhook test"
  };
  return labels[type] ?? type;
}

function formatJobStageLabel(job: JobRecord) {
  if (job.stage === "stale") return "Restart interrupted";
  return job.stage;
}

function formatJobProgressLabel(job: JobRecord) {
  if (job.stage === "stale") return getRecoveredJobDisposition(job);
  return `${formatCount(job.progress)}%`;
}

function formatJobStatus(status: JobRecord["status"]) {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function getRecoveredJobDisposition(job: JobRecord) {
  const message = `${job.error ?? ""} ${job.logs.at(-1)?.message ?? ""}`;
  if (/previous indexed data was preserved/i.test(message)) return "Previous index preserved";
  if (/retry is required/i.test(message)) return "Retry required";
  return "Needs review";
}

function formatRelativeTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatEventTypeLabel(type: EventRecord["type"]) {
  const parts = type.split(".");
  const usefulParts = parts[0] === "asset" ? parts.slice(1) : parts;
  return usefulParts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function buildObservabilityView(snapshot: ObservabilitySnapshot) {
  const pipelineMetricPool = [...snapshot.modelRuntimeMetrics, ...snapshot.stageMetrics];
  const pipelineMetrics = [...pipelineMetricPool].sort(compareObservabilityMetrics).slice(0, 6);
  const httpMetric = snapshot.requestMetrics.find((metric) => metric.key === "http.request") ?? snapshot.requestMetrics[0] ?? null;
  const slowestMetric = pipelineMetricPool.reduce<ObservabilityMetric | null>(
    (slowest, metric) => (!slowest || metric.p95Ms > slowest.p95Ms ? metric : slowest),
    null
  );

  return {
    traceStore: formatTraceStore(snapshot.traceExporter),
    spanCount: snapshot.recentSpans.length,
    httpP95: httpMetric ? formatLatency(httpMetric.p95Ms) : "No samples",
    httpSummary: httpMetric ? `${formatUnitCount(httpMetric.count, "request")} · ${formatUnitCount(httpMetric.errorCount, "error")}` : "No request metrics",
    pipelineErrorCount: pipelineMetricPool.reduce((sum, metric) => sum + metric.errorCount, 0),
    logFormat: formatLogFormat(snapshot.logFormat),
    logPath: compactLogPath(snapshot.logPath),
    slowestLabel: slowestMetric ? `Slowest p95 ${formatMetricName(slowestMetric.key)} ${formatLatency(slowestMetric.p95Ms)}` : "Waiting for pipeline samples",
    pipelineMetrics,
    signalLogs: snapshot.recentLogs.filter(isOperationalSignalLog).slice(0, 5)
  };
}

function describeObservabilityMetricIntent(key: string) {
  if (key === "model.doctor.service") return "Verifies the model runtime boundary responds before UI features depend on local AI services.";
  if (key.startsWith("python_runtime.service")) return "Measures Python runtime service calls used by ASR, OCR, vision, and embedding work.";
  if (key.startsWith("model.")) return "Tracks model availability or model execution health for local intelligence stages.";
  if (key.startsWith("stage.")) return "Measures indexing pipeline stages so slow evidence extraction and vector writes are visible.";
  if (key.startsWith("job.")) return "Tracks background job execution to detect stalled or failing worker paths.";
  if (key.startsWith("search.vector")) return "Measures vector retrieval latency used by search and grounded answer flows.";
  return "Operational latency metric used to identify slow, failing, or recently changed runtime paths.";
}

function compareObservabilityMetrics(a: ObservabilityMetric, b: ObservabilityMetric) {
  const statusDelta = Number(b.lastStatus === "error") - Number(a.lastStatus === "error");
  if (statusDelta !== 0) return statusDelta;
  if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
  return b.p95Ms - a.p95Ms;
}

function isOperationalSignalLog(log: ObservabilityLog) {
  return log.event !== "http.request";
}

function formatTraceStore(traceExporter: string) {
  if (traceExporter === "local-in-memory") return "Memory";
  return formatMetricName(traceExporter);
}

function formatLogFormat(logFormat: string) {
  if (logFormat === "json-ndjson") return "NDJSON";
  return logFormat.toUpperCase();
}

function compactLogPath(logPath: string) {
  const parts = logPath.split("/").filter(Boolean);
  const dataIndex = parts.lastIndexOf(".data");
  if (dataIndex >= 0) return parts.slice(dataIndex).join("/");
  return parts.slice(-3).join("/");
}

function formatLatency(value: number) {
  if (value < 10) return `${value.toFixed(2)}ms`;
  if (value < 100) return `${value.toFixed(1)}ms`;
  return `${formatCount(Math.round(value))}ms`;
}

function formatMetricName(key: string) {
  const acronyms = new Set(["api", "asr", "http", "ocr", "p95", "vad", "vlm"]);
  return key
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => (acronyms.has(part.toLowerCase()) ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

function formatCompactMetricName(key: string) {
  if (key === "model.doctor.service") return "Model doctor";
  if (key.startsWith("python_runtime.service")) return "Python runtime";
  if (key.startsWith("model.embedding.text")) return "Text embedding";
  if (key.startsWith("model.embedding.visual")) return "Visual embedding";
  if (key.startsWith("model.asr")) return "ASR";
  if (key.startsWith("model.ocr")) return "OCR";
  if (key.startsWith("model.vision")) return "Vision";
  if (key.startsWith("search.vector_text")) return "Text vector";
  if (key.startsWith("search.vector_visual")) return "Visual vector";
  if (key.startsWith("search.knowledge_vector")) return "Knowledge vector";
  const name = formatMetricName(key);
  return name.length > 14 ? name.split(/\s+/).slice(0, 2).join(" ") : name;
}

function SearchVideoPreviewPanel({
  preview,
  onClose,
  onOpenAsset
}: {
  preview: SearchVideoPreview;
  onClose: () => void;
  onOpenAsset: (assetId: string, segmentId: string, at: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const source = mediaPath(preview.asset.storedName);
  const start = Math.max(0, preview.start ?? preview.segment.start);
  const end = Math.max(start, preview.end ?? preview.segment.end);
  const label = preview.label ?? preview.segment.label;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const seekToMoment = () => {
      video.currentTime = start;
    };
    if (video.readyState >= 1) seekToMoment();
    video.addEventListener("loadedmetadata", seekToMoment, { once: true });
    void video.play().catch(() => undefined);
    return () => video.removeEventListener("loadedmetadata", seekToMoment);
  }, [preview.asset.id, preview.segment.id, start]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <section className="search-video-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="search-video-preview"
        role="dialog"
        aria-modal="true"
        aria-label="Search result video player"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-video-header">
          <div>
            <p className="section-label">Video Preview</p>
            <h3>{preview.asset.title}</h3>
            <span>
              {formatDuration(start)}-{formatDuration(end)} · {label}
            </span>
          </div>
          <button type="button" className="small-button icon-only" aria-label="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {source ? (
          <video ref={videoRef} className="search-video-player" src={`${source}#t=${start.toFixed(2)}`} controls playsInline preload="metadata" />
        ) : (
          <EmptyState text="Video media is not available for this result." />
        )}
        <div className="search-video-actions">
          <button
            type="button"
            className="small-button"
            onClick={() => {
              onOpenAsset(preview.asset.id, preview.segment.id, start);
              onClose();
            }}
          >
            데이터 화면에서 열기
          </button>
        </div>
      </div>
    </section>
  );
}
