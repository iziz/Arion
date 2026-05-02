import {
  Activity,
  Bell,
  BrainCircuit,
  CheckCircle2,
  CircleHelp,
  Clock3,
  CreditCard,
  Database,
  Edit3,
  FileVideo,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  UploadCloud,
  X
} from "lucide-react";
import { Fragment, type Dispatch, FormEvent, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalysisResult,
  AssetRecord,
  DomainQueryPlan,
  DomainSearchFilters,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  OcrBox,
  OrchestrationPlan,
  SearchResult,
  VerificationCheck,
  WebhookRecord
} from "../shared/types";

type DatabaseStatus = {
  enabled: boolean;
  storage?: string;
  postgres?: string;
  pgvector?: string | null;
  embeddingColumn?: string | null;
  expectedEmbeddingDimensions?: number;
  visualEmbeddingColumn?: string | null;
  expectedVisualEmbeddingDimensions?: number;
  migrations?: Array<{ version: string; description: string; applied_at: string }>;
  metrics: MetricsSummary;
};

type ObservabilitySnapshot = {
  traceExporter: string;
  logFormat: string;
  logPath: string;
  latencyMetrics: Array<{
    key: string;
    count: number;
    errorCount: number;
    avgMs: number;
    p95Ms: number;
    lastMs: number;
    lastStatus: "ok" | "error";
    lastError: string | null;
  }>;
  modelRuntimeMetrics: ObservabilitySnapshot["latencyMetrics"];
  stageMetrics: ObservabilitySnapshot["latencyMetrics"];
  requestMetrics: ObservabilitySnapshot["latencyMetrics"];
  recentSpans: Array<{ traceId: string; spanId: string; name: string; durationMs: number; status: string }>;
  recentLogs: Array<{ timestamp: string; level: string; event: string; message: string; requestId: string | null; traceId: string | null }>;
};

type ConsoleTab = "dashboard" | "assets" | "search" | "system";
type AssetDetailTab = "overview" | "workflow" | "evidence" | "timeline";
type DialogMode = "index" | "edit-index" | "asset" | null;
type FlowStepState = "done" | "active" | "waiting" | "skipped" | "error";

type FlowStep = {
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

const emptyMetrics: MetricsSummary = {
  indexes: 0,
  assets: 0,
  indexedAssets: 0,
  runningJobs: 0,
  failedJobs: 0,
  totalDuration: 0,
  segments: 0,
  vectors: 0,
  webhooks: 0,
  billingUnits: 0
};

const api = {
  async get<T>(url: string) {
    return readJson<T>(await fetch(url));
  },
  async post<T>(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson<T>(response);
  },
  async patch<T>(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson<T>(response);
  }
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  const payload = body ? parseJson(body) : null;
  if (!response.ok) {
    throw new Error(getErrorMessage(payload) ?? `Request failed with ${response.status}`);
  }
  if (payload === null) {
    throw new Error("Request returned an empty response");
  }
  return payload as T;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Request returned invalid JSON");
  }
}

function getErrorMessage(payload: unknown) {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
}

function getArrayResult<T>(result: PromiseSettledResult<T[]>, label: string, failures: string[]) {
  if (result.status === "rejected") {
    failures.push(`${label}: ${getFailureMessage(result.reason)}`);
    return null;
  }
  if (!Array.isArray(result.value)) {
    failures.push(`${label}: invalid payload`);
    return null;
  }
  return result.value;
}

function getGuardedResult<T>(result: PromiseSettledResult<T>, label: string, guard: (value: unknown) => value is T, failures: string[]) {
  if (result.status === "rejected") {
    failures.push(`${label}: ${getFailureMessage(result.reason)}`);
    return null;
  }
  if (!guard(result.value)) {
    failures.push(`${label}: invalid payload`);
    return null;
  }
  return result.value;
}

function getFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMetricsSummary(value: unknown): value is MetricsSummary {
  return (
    isRecord(value) &&
    ["indexes", "assets", "indexedAssets", "runningJobs", "failedJobs", "totalDuration", "segments", "vectors", "webhooks", "billingUnits"].every(
      (key) => typeof value[key] === "number"
    )
  );
}

function isDatabaseStatus(value: unknown): value is DatabaseStatus {
  return isRecord(value) && typeof value.enabled === "boolean" && isMetricsSummary(value.metrics);
}

function isObservabilitySnapshot(value: unknown): value is ObservabilitySnapshot {
  return (
    isRecord(value) &&
    typeof value.traceExporter === "string" &&
    typeof value.logFormat === "string" &&
    typeof value.logPath === "string" &&
    Array.isArray(value.latencyMetrics) &&
    Array.isArray(value.modelRuntimeMetrics) &&
    Array.isArray(value.stageMetrics) &&
    Array.isArray(value.requestMetrics) &&
    Array.isArray(value.recentSpans) &&
    Array.isArray(value.recentLogs)
  );
}

function isAssetUploadPayload(value: unknown): value is { asset: AssetRecord } {
  return isRecord(value) && isRecord(value.asset) && typeof value.asset.id === "string";
}

function indexFormPayload(form: HTMLFormElement) {
  const data = new FormData(form);
  const domainEnabled = data.get("domainIndexingEnabled") === "on";
  const domainGroup = String(data.get("domainGroup") || "");
  const domainStages = data.getAll("domainStage").map(String);
  return {
    name: data.get("name"),
    description: data.get("description"),
    domainIndexing: {
      enabled: domainEnabled,
      groups: domainEnabled && domainGroup === "sports.football" ? ["sports.football"] : [],
      stages: domainEnabled ? domainStages : []
    }
  };
}

export default function App() {
  const [indexes, setIndexes] = useState<IndexRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsSummary>(emptyMetrics);
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(null);
  const [observability, setObservability] = useState<ObservabilitySnapshot | null>(null);
  const [selectedIndexId, setSelectedIndexId] = useState("default-index");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchTag, setSearchTag] = useState("");
  const [searchModality, setSearchModality] = useState("");
  const [domainFilters, setDomainFilters] = useState<DomainSearchFilters>({});
  const [queryPlan, setQueryPlan] = useState<DomainQueryPlan | null>(null);
  const [orchestrationPlan, setOrchestrationPlan] = useState<OrchestrationPlan | null>(null);
  const [question, setQuestion] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeek] = useState<{ assetId: string; at: number } | null>(null);
  const [activeTab, setActiveTab] = useState<ConsoleTab>("dashboard");
  const [assetDetailTab, setAssetDetailTab] = useState<AssetDetailTab>("overview");
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const refreshPromise = useRef<Promise<void> | null>(null);

  const selectedIndex = indexes.find((index) => index.id === selectedIndexId) ?? indexes[0] ?? null;
  const visibleAssets = assets.filter((asset) => !selectedIndex || asset.indexId === selectedIndex.id);
  const visibleIndexedAssets = visibleAssets.filter((asset) => asset.status === "indexed").length;
  const selectedAsset = useMemo(
    () => visibleAssets.find((asset) => asset.id === selectedAssetId) ?? visibleAssets[0] ?? null,
    [selectedAssetId, visibleAssets]
  );
  const selectedAssetJob = selectedAsset ? getLatestAssetJob(jobs, selectedAsset.id) : null;
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const selectedSegment = selectedAsset?.timeline.find((segment) => segment.id === selectedSegmentId) ?? selectedAsset?.timeline[0] ?? null;
  const filterTags = useMemo(() => Array.from(new Set(visibleAssets.flatMap((asset) => asset.tags))).sort(), [visibleAssets]);
  const runningJobCount = jobs.filter((job) => job.status === "running" || job.status === "queued").length;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get("asset");
    if (assetId) setSelectedAssetId(assetId);
  }, []);

  useEffect(() => {
    if (!selectedAssetId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("asset", selectedAssetId);
    window.history.replaceState(null, "", url.toString());
  }, [selectedAssetId]);

  useEffect(() => {
    if (!pendingSeek || selectedAsset?.id !== pendingSeek.assetId || !playerRef.current) return;
    playerRef.current.currentTime = pendingSeek.at;
    void playerRef.current.play().catch(() => undefined);
    setPendingSeek(null);
  }, [pendingSeek, selectedAsset]);

  async function refresh() {
    if (refreshPromise.current) return refreshPromise.current;
    const promise = (async () => {
      const health = await api.get<{ status: string }>("/api/health").catch(() => null);
      if (!health) {
        setMessage("Refresh warning: API server is restarting or unavailable.");
        return;
      }
      const [indexesResult, assetsResult, jobsResult, eventsResult, webhooksResult, metricsResult, dbStatusResult, observabilityResult] = await Promise.allSettled([
        api.get<IndexRecord[]>("/api/indexes"),
        api.get<AssetRecord[]>("/api/assets"),
        api.get<JobRecord[]>("/api/jobs"),
        api.get<EventRecord[]>("/api/events?limit=20"),
        api.get<WebhookRecord[]>("/api/webhooks"),
        api.get<MetricsSummary>("/api/metrics"),
        api.get<DatabaseStatus>("/api/db/status"),
        api.get<ObservabilitySnapshot>("/api/observability")
      ]);
      const failures: string[] = [];
      const nextIndexes = getArrayResult<IndexRecord>(indexesResult, "indexes", failures);
      const nextAssets = getArrayResult<AssetRecord>(assetsResult, "assets", failures);
      const nextJobs = getArrayResult<JobRecord>(jobsResult, "jobs", failures);
      const nextEvents = getArrayResult<EventRecord>(eventsResult, "events", failures);
      const nextWebhooks = getArrayResult<WebhookRecord>(webhooksResult, "webhooks", failures);
      const nextMetrics = getGuardedResult(metricsResult, "metrics", isMetricsSummary, failures);
      const nextDbStatus = getGuardedResult(dbStatusResult, "database status", isDatabaseStatus, failures);
      const nextObservability = getGuardedResult(observabilityResult, "observability", isObservabilitySnapshot, failures);

      if (nextIndexes) {
        setIndexes(nextIndexes);
        setSelectedIndexId((current) => current || nextIndexes[0]?.id || current);
      }
      if (nextAssets) {
        setAssets(nextAssets);
        setSelectedAssetId((current) => current || nextAssets[0]?.id || current);
      }
      if (nextJobs) setJobs(nextJobs);
      if (nextEvents) setEvents(nextEvents);
      if (nextWebhooks) setWebhooks(nextWebhooks);
      if (nextMetrics) setMetrics(nextMetrics);
      if (nextDbStatus) setDbStatus(nextDbStatus);
      if (nextObservability) setObservability(nextObservability);

      if (failures.length > 0) {
        setMessage(`Refresh warning: ${failures.slice(0, 2).join("; ")}`);
      } else {
        setMessage((current) => (current.startsWith("Refresh warning:") ? "" : current));
      }
    })();
    refreshPromise.current = promise;
    try {
      await promise;
    } finally {
      refreshPromise.current = null;
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), runningJobCount > 0 ? 1500 : 4000);
    return () => window.clearInterval(interval);
  }, [runningJobCount]);

  async function createIndex(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = indexFormPayload(form);
    const index = await api.post<IndexRecord>("/api/indexes", {
      ...payload,
      modalities: ["visual", "audio", "transcription", "metadata"],
    });
    form.reset();
    setSelectedIndexId(index.id);
    setDialogMode(null);
    await refresh();
  }

  async function updateIndex(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedIndex) return;
    const form = event.currentTarget;
    const index = await api.patch<IndexRecord>(`/api/indexes/${selectedIndex.id}`, indexFormPayload(form));
    setSelectedIndexId(index.id);
    setDialogMode(null);
    await refresh();
  }

  async function uploadAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("video");
    if (!(file instanceof File) || file.size === 0) {
      setMessage("Choose a video or audio file first.");
      return;
    }
    data.set("indexId", selectedIndex?.id ?? "default-index");
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/indexes/${selectedIndex?.id ?? "default-index"}/assets`, {
        method: "POST",
        body: data
      });
      const payload = await readJson<unknown>(response);
      if (!isAssetUploadPayload(payload)) throw new Error("Upload returned an invalid asset payload");
      setSelectedAssetId(payload.asset.id);
      setActiveTab("assets");
      setAssetDetailTab("overview");
      form.reset();
      setDialogMode(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    setSearching(true);
    const params = new URLSearchParams({ q: query, indexId: selectedIndex?.id ?? "default-index" });
    if (searchTag) params.set("tag", searchTag);
    if (searchModality) params.set("modality", searchModality);
    for (const [key, value] of Object.entries(domainFilters)) {
      if (value) params.set(key, value);
    }
    try {
      const [plan, orchestration, results] = await Promise.all([
        api.get<DomainQueryPlan>(`/api/search/plan?${params.toString()}`),
        api.get<OrchestrationPlan>(`/api/orchestrate/plan?${params.toString()}`),
        api.get<SearchResult[]>(`/api/search?${params.toString()}`)
      ]);
      setQueryPlan(plan);
      setOrchestrationPlan(orchestration);
      setSearchResults(results);
    } finally {
      setSearching(false);
    }
  }

  function seekTo(assetId: string, at: number) {
    setActiveTab("assets");
    setAssetDetailTab("overview");
    setSelectedAssetId(assetId);
    setPendingSeek({ assetId, at });
  }

  function selectSegment(assetId: string, segmentId: string, at: number) {
    setSelectedSegmentId(segmentId);
    seekTo(assetId, at);
  }

  async function runAnalysis(event: FormEvent) {
    event.preventDefault();
    if (!selectedAsset) return;
    setAnalysis(await api.post<AnalysisResult>(`/api/assets/${selectedAsset.id}/analyze`, { question }));
    await refresh();
  }

  async function registerWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await api.post<WebhookRecord>("/api/webhooks", {
      name: data.get("name"),
      url: data.get("url"),
      events: ["asset.indexing.succeeded", "asset.indexing.failed", "analysis.completed"]
    });
    form.reset();
    await refresh();
  }

  async function retryJob(id: string) {
    await api.post<JobRecord>(`/api/jobs/${id}/retry`, {});
    await refresh();
  }

  async function retryAssetStage(assetId: string, stage: string) {
    await api.post<JobRecord>(`/api/assets/${assetId}/reindex`, { stage });
    await refresh();
  }

  async function retryWebhook(id: string) {
    await api.post<WebhookRecord>(`/api/webhooks/${id}/retry`, {});
    await refresh();
  }

  function selectIndex(indexId: string) {
    setSelectedIndexId(indexId);
    const firstAsset = assets.find((asset) => asset.indexId === indexId) ?? null;
    setSelectedAssetId(firstAsset?.id ?? null);
    setSelectedSegmentId(firstAsset?.timeline[0]?.id ?? null);
    setAssetDetailTab("overview");
    setAnalysis(null);
  }

  function selectAsset(asset: AssetRecord) {
    setSelectedAssetId(asset.id);
    setSelectedSegmentId(asset.timeline[0]?.id ?? null);
    setAnalysis(null);
    setAssetDetailTab("overview");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Arion Console</h1>
        </div>
        <section className="context-bar" aria-label="Current context">
          <div className="context-combined">
            <span>Asset · Index</span>
            <strong>
              {[selectedAsset?.title ?? "No asset selected", selectedIndex?.name ?? "No index"].join(" · ")}
            </strong>
          </div>
          <div>
            <span>Status</span>
            <strong>{selectedAsset ? selectedAsset.status : "idle"}</strong>
          </div>
          <div>
            <span>Queue</span>
            <strong>{runningJobCount > 0 ? `${runningJobCount} active` : "clear"}</strong>
          </div>
        </section>
        <button className="ghost-button icon-only" type="button" aria-label="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={16} />
        </button>
      </header>

      <nav className="view-tabs" aria-label="Console sections">
        <a className="brand-logo" href="/" aria-label="Arion home">
          <span className="brand-mark">
            <img src="/arion-mark.svg" alt="" />
          </span>
          <span className="brand-copy">
            <strong>Arion</strong>
            <em>Video Intelligence</em>
          </span>
        </a>
        <TabButton
          active={activeTab === "dashboard"}
          icon={<Activity size={17} />}
          label="대시보드"
          meta={`${metrics.indexedAssets}/${metrics.assets} indexed`}
          onClick={() => setActiveTab("dashboard")}
        />
        <TabButton
          active={activeTab === "assets"}
          icon={<FileVideo size={17} />}
          label="에셋"
          meta={`${visibleIndexedAssets}/${visibleAssets.length} indexed`}
          onClick={() => setActiveTab("assets")}
        />
        {activeTab === "assets" && (
          <section className="asset-nav" aria-label="Asset navigation">
            <div className="asset-nav-header">
              <span>에셋그룹</span>
              <button type="button" className="nav-add-button" aria-label="에셋그룹 만들기" onClick={() => setDialogMode("index")}>
                <Plus size={14} />
              </button>
            </div>
            <div className="asset-nav-list">
              {indexes.map((index) => {
                const indexAssets = assets.filter((asset) => asset.indexId === index.id);
                const indexedCount = indexAssets.filter((asset) => asset.status === "indexed").length;
                return (
                  <button
                    key={index.id}
                    type="button"
                    className={`asset-nav-item ${selectedIndex?.id === index.id ? "active" : ""}`}
                    onClick={() => selectIndex(index.id)}
                  >
                    <span>{index.name}</span>
                    <strong>{indexedCount}/{indexAssets.length}</strong>
                  </button>
                );
              })}
            </div>

            <div className="asset-nav-header nested">
              <span>영상</span>
              <button type="button" className="nav-add-button" aria-label="영상 추가" onClick={() => setDialogMode("asset")}>
                <Plus size={14} />
              </button>
            </div>
            <div className="asset-nav-list video-list">
              {visibleAssets.length === 0 && <p>영상 없음</p>}
              {visibleAssets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  className={`asset-nav-item video ${selectedAsset?.id === asset.id ? "active" : ""}`}
                  onClick={() => selectAsset(asset)}
                >
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
          label="검색"
          meta={`${searchResults.length} results`}
          onClick={() => setActiveTab("search")}
        />
        <TabButton
          active={activeTab === "system"}
          icon={<Database size={17} />}
          label="시스템"
          meta={runningJobCount > 0 ? `${runningJobCount} active` : "ready"}
          onClick={() => setActiveTab("system")}
        />
      </nav>

      {activeTab === "dashboard" && (
      <section className="section-block overview-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Overview</p>
            <h2>Service snapshot</h2>
          </div>
          <p>Current indexing, storage, and delivery health at a glance.</p>
        </div>
        <section className="metrics">
          <Metric icon={<Layers3 size={18} />} label="Indexes" value={metrics.indexes.toString()} />
          <Metric icon={<FileVideo size={18} />} label="Total Assets" value={metrics.assets.toString()} />
          <Metric icon={<CheckCircle2 size={18} />} label="Indexed Total" value={metrics.indexedAssets.toString()} />
          <Metric icon={<Clock3 size={18} />} label="Running Jobs" value={metrics.runningJobs.toString()} />
          <Metric icon={<Database size={18} />} label="Segments" value={metrics.segments.toString()} />
          <Metric icon={<Database size={18} />} label="Vectors" value={metrics.vectors.toString()} />
          <Metric icon={<Bell size={18} />} label="Webhooks" value={metrics.webhooks.toString()} />
          <Metric icon={<CreditCard size={18} />} label="Billing Units" value={metrics.billingUnits.toString()} />
        </section>
      </section>
      )}

      {activeTab === "assets" && (
      <section className="section-block workflow-section">
        <AssetGroupSummary index={selectedIndex} assets={visibleAssets} onEdit={() => setDialogMode("edit-index")} />
      <section className="asset-workbench asset-detail-workbench">
        <section className="panel detail-panel">
          {selectedAsset ? (
            <>
              <div className="detail-header">
                <div>
                  <h2>{selectedAsset.title}</h2>
                  <span className="video-progress-line">{getAssetProgressLine(selectedAsset, selectedAssetJob)}</span>
                </div>
                <VideoStatusSummary asset={selectedAsset} />
              </div>
              <AssetDetailTabs active={assetDetailTab} onChange={setAssetDetailTab} />
              {assetDetailTab === "overview" && (
                <section className="asset-detail-view">
                  <div className="asset-overview-layout">
                    <div className="asset-player-column">
                      <video ref={playerRef} className="player" src={`/media/${selectedAsset.storedName}`} controls />
                    </div>
                    <aside className="asset-metadata-panel" aria-label="Video technical details">
                      <InfoTile label="Duration" value={formatDuration(selectedAsset.duration ?? 0)} />
                      <InfoTile
                        label="Frame"
                        value={[
                          selectedAsset.width && selectedAsset.height ? `${selectedAsset.width}x${selectedAsset.height}` : "No dimensions",
                          selectedAsset.technicalMetadata.frameRate ? `${Math.round(selectedAsset.technicalMetadata.frameRate)}fps` : ""
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                      <InfoTile
                        label="Codec"
                        value={[
                          selectedAsset.technicalMetadata.videoCodec ?? "No video codec",
                          selectedAsset.technicalMetadata.audioCodec ? `audio ${selectedAsset.technicalMetadata.audioCodec}` : ""
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                      <InfoTile
                        label="Detail"
                        value={`${selectedAsset.timeline.length} moments · ${selectedAsset.keyframes.length} keyframes`}
                      />
                    </aside>
                  </div>
                  <p className="summary">{selectedAsset.summary || "Indexing metadata is not ready yet."}</p>
                  <div className="signal-group">
                    <div className="subsection-heading">
                      <p className="section-label">Signals</p>
                      <h3>Model outputs</h3>
                    </div>
                    <div className="intelligence-grid">
                      <InfoTile label="ASR" value={`${Math.round(selectedAsset.intelligence.asr.confidence * 100)}%`} />
                      <InfoTile label="OCR" value={`${selectedAsset.intelligence.ocr.tokens.length} tokens`} />
                      <InfoTile label="Color" value={selectedAsset.intelligence.visual.dominantColor} />
                      <InfoTile label="Motion" value={selectedAsset.intelligence.visual.motionScore.toString()} />
                    </div>
                  </div>
                  <div className="chips">
                    {selectedAsset.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </section>
              )}
              {assetDetailTab === "workflow" && <AssetFlow asset={selectedAsset} index={selectedIndex} job={selectedAssetJob} onRetryStage={retryAssetStage} />}
              {assetDetailTab === "evidence" && <SignalEvidence asset={selectedAsset} />}
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
                      <h3>{selectedAsset.timeline.length} indexed moments</h3>
                    </div>
                    {selectedSegment && <span>{formatDuration(selectedSegment.start)} selected</span>}
                  </div>
                  <Timeline
                    asset={selectedAsset}
                    selectedSegmentId={selectedSegment?.id ?? null}
                    onSelect={(segment) => selectSegment(selectedAsset.id, segment.id, segment.start)}
                  />
                </section>
              )}
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

      {activeTab === "search" && (
      <section className="section-block discovery-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Discover</p>
            <h2>Search and analyze</h2>
          </div>
          <p>Search indexed moments and ask focused questions without leaving the asset workspace.</p>
        </div>
      <section className="tools">
        <section className="panel">
          <div className="panel-title">
            <Search size={18} />
            <h2>Search</h2>
          </div>
          <form onSubmit={runSearch} className="search-row search-form">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search indexed timeline moments" />
            <select value={searchTag} onChange={(event) => setSearchTag(event.target.value)}>
              <option value="">Any tag</option>
              {filterTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <select value={searchModality} onChange={(event) => setSearchModality(event.target.value)}>
              <option value="">Any modality</option>
              <option value="visual">Visual</option>
              <option value="audio">Audio</option>
              <option value="transcription">Transcription</option>
              <option value="metadata">Metadata</option>
            </select>
            <button type="submit" disabled={searching}>
              <Search size={16} />
              {searching ? "Searching..." : "Search"}
            </button>
          </form>
          <DomainSearchControls filters={domainFilters} onChange={setDomainFilters} />
          {queryPlan && <QueryPlanCard plan={queryPlan} />}
          {orchestrationPlan && <OrchestrationPlanCard plan={orchestrationPlan} />}
          <div className="result-list">
            {searching && (
              <article className="result-card search-loading-card" aria-live="polite">
                <div>
                  <strong>Searching indexed moments</strong>
                  <span>Embedding query, matching vectors, and applying domain filters.</span>
                </div>
                <span className="search-loading-bar" />
              </article>
            )}
            {searchResults.map((result) => (
              <article key={result.asset.id} className="result-card">
                <div>
                  <strong>{result.asset.title}</strong>
                  <span>
                    Relevance {Math.round(result.score)} · {Math.min(result.segments.length, 3)} key moments ·{" "}
                    {result.index?.name ?? "Unknown index"}
                  </span>
                </div>
                {result.segments.slice(0, 3).map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    className="result-segment"
                    onClick={() => selectSegment(result.asset.id, segment.id, segment.start)}
                  >
                    <SearchSceneEvidence
                      segment={segment}
                      query={queryPlan?.semanticQuery ?? query}
                      reasons={result.matchReasons.filter((reason) => reason.segmentId === segment.id)}
                      verification={result.verification.filter((check) => check.segmentId === segment.id)}
                    />
                  </button>
                ))}
              </article>
            ))}
            {!searching && (query || Object.values(domainFilters).some(Boolean)) && searchResults.length === 0 && (
              <EmptyState text="No indexed moment matched the query." />
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <BrainCircuit size={18} />
            <h2>Analyze</h2>
          </div>
          <form onSubmit={runAnalysis} className="search-row analysis-form">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask about the selected asset"
              disabled={!selectedAsset || selectedAsset.status !== "indexed"}
            />
            <button type="submit" disabled={!selectedAsset || selectedAsset.status !== "indexed"}>
              <BrainCircuit size={16} />
              Analyze
            </button>
          </form>
          {analysis ? (
            <article className="analysis-card">
              <strong>{analysis.answer}</strong>
              <p>{analysis.summary}</p>
              <div className="chips">
                {analysis.signals.map((signal) => (
                  <span key={signal}>{signal}</span>
                ))}
              </div>
            </article>
          ) : (
            <EmptyState text="Select an indexed asset and ask a question." />
          )}
        </section>
      </section>
      </section>
      )}

      {activeTab === "system" && (
      <section className="section-block ops-section">
        <div className="section-heading">
          <div>
            <p className="section-label">System</p>
            <h2>Jobs, delivery, storage, traces</h2>
          </div>
          <p>Operational details are grouped here so the main workflow stays focused.</p>
        </div>
      <section className="ops-grid">
        <section className="panel jobs-panel">
          <div className="panel-title">
            <Activity size={18} />
            <h2>Jobs</h2>
          </div>
          <div className="table-list">
            {jobs.slice(0, 8).map((job) => (
              <article key={job.id} className={`ops-row ${selectedJob?.id === job.id ? "active" : ""}`}>
                <button type="button" className="row-button" onClick={() => setSelectedJobId(job.id)}>
                  <strong>{job.type}</strong>
                  <span>{job.status} · {job.stage} · {job.progress}%</span>
                </button>
                {job.assetId && (
                  <button type="button" className="small-button" onClick={() => void retryJob(job.id)}>
                    <RefreshCw size={14} />
                    Retry
                  </button>
                )}
              </article>
            ))}
          </div>
          {selectedJob && (
            <article className="job-detail">
              <strong>{selectedJob.stage}</strong>
              <span>{selectedJob.id}</span>
              <div className="job-log">
                {selectedJob.logs.slice(-6).map((log) => (
                  <p key={`${log.at}-${log.message}`}>
                    {new Date(log.at).toLocaleTimeString()} · {log.level} · {log.message}
                  </p>
                ))}
              </div>
            </article>
          )}
        </section>

        <section className="panel webhooks-panel">
          <div className="panel-title">
            <Bell size={18} />
            <h2>Webhooks</h2>
          </div>
          <form className="webhook-row" onSubmit={registerWebhook}>
            <input name="name" placeholder="Webhook name" />
            <input name="url" placeholder="log://local or https://example.com/hook" />
            <button type="submit">
              <Bell size={16} />
              Add
            </button>
          </form>
          <div className="table-list">
            {webhooks.map((webhook) => (
              <article key={webhook.id} className="ops-row">
                <strong>{webhook.name}</strong>
                <span>
                  {webhook.url} · {webhook.deliveries.length} deliveries
                  {webhook.deliveries[0] ? ` · last ${webhook.deliveries[0].status}` : ""}
                </span>
                {webhook.deliveries.some((delivery) => delivery.status === "failed") && (
                  <button type="button" className="small-button" onClick={() => void retryWebhook(webhook.id)}>
                    <RefreshCw size={14} />
                    Retry failed
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="panel events-panel">
          <div className="panel-title">
            <Activity size={18} />
            <h2>Events</h2>
          </div>
          <div className="table-list">
            {events.map((event) => (
              <article key={event.id} className="ops-row">
                <strong>{event.type}</strong>
                <span>{event.message} · {new Date(event.createdAt).toLocaleTimeString()}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="panel database-panel">
          <div className="panel-title">
            <Database size={18} />
            <h2>Database</h2>
          </div>
          {dbStatus ? (
            <article className="db-card">
              <strong>{dbStatus.enabled ? "PostgreSQL" : dbStatus.storage ?? "File storage"}</strong>
              <span>{dbStatus.embeddingColumn ?? `${dbStatus.expectedEmbeddingDimensions ?? 0} dimensions`}</span>
              <span>{dbStatus.visualEmbeddingColumn ?? `${dbStatus.expectedVisualEmbeddingDimensions ?? 0} visual dimensions`}</span>
              <span>pgvector {dbStatus.pgvector ?? "off"}</span>
              <div className="job-log">
                {(dbStatus.migrations ?? []).slice(-3).map((migration) => (
                  <p key={migration.version}>
                    {migration.version} · {migration.description}
                  </p>
                ))}
              </div>
            </article>
          ) : (
            <EmptyState text="Database status is loading." />
          )}
        </section>

        <section className="panel observability-panel">
          <div className="panel-title">
            <Activity size={18} />
            <h2>Observability</h2>
          </div>
          {observability ? (
            <>
              <div className="obs-summary">
                <span>{observability.traceExporter}</span>
                <span>{observability.logFormat}</span>
                <span>{observability.recentSpans.length} spans</span>
              </div>
              <div className="table-list">
                {[...observability.modelRuntimeMetrics, ...observability.stageMetrics].slice(0, 8).map((metric) => (
                  <article key={metric.key} className={`ops-row ${metric.lastStatus === "error" ? "error-row" : ""}`}>
                    <strong>{metric.key}</strong>
                    <span>
                      avg {metric.avgMs}ms · p95 {metric.p95Ms}ms · errors {metric.errorCount}
                    </span>
                    {metric.lastError && <span>{metric.lastError}</span>}
                  </article>
                ))}
              </div>
              <div className="job-log obs-log">
                {observability.recentLogs.slice(0, 5).map((log) => (
                  <p key={`${log.timestamp}-${log.event}-${log.requestId}`}>
                    {new Date(log.timestamp).toLocaleTimeString()} · {log.level} · {log.event} · {log.requestId ?? "no-request"}
                  </p>
                ))}
              </div>
            </>
          ) : (
            <EmptyState text="Observability data is loading." />
          )}
        </section>
      </section>
      </section>
      )}

      {dialogMode && (
        <section className="modal-backdrop" role="presentation" onMouseDown={() => setDialogMode(null)}>
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="asset-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="section-label">{dialogMode === "asset" ? "Upload" : "Asset Group"}</p>
                <h2 id="asset-dialog-title">
                  {dialogMode === "index" ? "에셋그룹 만들기" : dialogMode === "edit-index" ? "에셋그룹 수정" : "영상 추가"}
                </h2>
              </div>
              <button type="button" className="small-button icon-only" aria-label="닫기" onClick={() => setDialogMode(null)}>
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

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <article className="metric">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <span className="info-tile">
      <em>{label}</em>
      <strong>{value}</strong>
    </span>
  );
}

function AssetGroupForm({ index, onSubmit }: { index: IndexRecord | null; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  const domain = index?.domainIndexing;
  const domainEnabled = Boolean(domain?.enabled);
  const stages = new Set(domain?.stages ?? ["domain_caption", "event_label", "structured_event"]);
  return (
    <form className="stack compact" onSubmit={(event) => void onSubmit(event)}>
      <input name="name" placeholder="새 에셋그룹 이름" defaultValue={index?.name ?? ""} autoFocus />
      <textarea name="description" placeholder="에셋그룹 설명" defaultValue={index?.description ?? ""} />
      <div className="index-options">
        <label className="toggle-row">
          <input name="domainIndexingEnabled" type="checkbox" defaultChecked={domainEnabled} />
          <span>
            <strong>Sports domain indexing</strong>
            <em>Enable only for sports asset groups that need domain events.</em>
          </span>
        </label>
        <label className="field-label">
          <span>Domain group</span>
          <select name="domainGroup" defaultValue={domain?.groups[0] ?? "sports.football"}>
            <option value="sports.football">sports.football</option>
          </select>
        </label>
        <div className="stage-options" aria-label="Domain indexing stages">
          <label>
            <input name="domainStage" type="checkbox" value="domain_caption" defaultChecked={stages.has("domain_caption")} />
            <span>Domain captions</span>
          </label>
          <label>
            <input name="domainStage" type="checkbox" value="event_label" defaultChecked={stages.has("event_label")} />
            <span>Event labels</span>
          </label>
          <label>
            <input name="domainStage" type="checkbox" value="structured_event" defaultChecked={stages.has("structured_event")} />
            <span>Field/player/ball event schema</span>
          </label>
        </div>
      </div>
      <button type="submit">
        <Layers3 size={16} />
        {index ? "에셋그룹 저장" : "에셋그룹 만들기"}
      </button>
    </form>
  );
}

function AssetGroupSummary({ index, assets, onEdit }: { index: IndexRecord | null; assets: AssetRecord[]; onEdit: () => void }) {
  const indexedCount = assets.filter((asset) => asset.status === "indexed").length;
  const domain = index?.domainIndexing;
  const domainText =
    domain?.enabled && domain.groups.length > 0
      ? `${domain.groups.join(", ")} · ${domain.stages.map((stage) => stage.replace(/_/g, " ")).join(", ")}`
      : "Off";
  return (
    <section className="asset-group-summary" aria-label="Selected asset group summary">
      <div>
        <p className="section-label">Asset Group</p>
        <span className="asset-group-title-row">
          <h2>{index?.name ?? "No asset group selected"}</h2>
          <em className="asset-group-indexed-count">{indexedCount}/{assets.length} indexed</em>
          <button type="button" className="asset-group-edit" onClick={onEdit} disabled={!index} aria-label="에셋그룹 수정" title="에셋그룹 수정">
            <Edit3 size={17} />
          </button>
        </span>
        {index?.description && <p>{index.description}</p>}
        <div className="asset-group-meta">
          <span>
            <b>Domain</b>
            {domainText}
          </span>
        </div>
      </div>
      <span className="asset-group-status-pill">{index?.status ?? "empty"}</span>
    </section>
  );
}

function DomainSearchControls({
  filters,
  onChange
}: {
  filters: DomainSearchFilters;
  onChange: Dispatch<SetStateAction<DomainSearchFilters>>;
}) {
  const updateFilter = (key: keyof DomainSearchFilters, value: string) => {
    onChange((current) => ({ ...current, [key]: value || undefined }));
  };
  const presetHaaland = () => {
    onChange({
      competition: "Premier League",
      player: "Erling Haaland",
      eventType: "pass_receive",
      passType: "through_ball",
      fieldZone: "final_third"
    });
  };
  const clearFilters = () => onChange({});
  return (
    <section className="domain-search-controls" aria-label="Domain event search filters">
      <div className="domain-search-header">
        <strong>Domain Event Search</strong>
        <span>Filters match structured domain events when available, with text fallback for competition, season, and player.</span>
      </div>
      <div className="domain-filter-grid">
        <input value={filters.competition ?? ""} onChange={(event) => updateFilter("competition", event.target.value)} placeholder="Competition e.g. Premier League" />
        <input value={filters.season ?? ""} onChange={(event) => updateFilter("season", event.target.value)} placeholder="Season e.g. 2023-24" />
        <input value={filters.player ?? ""} onChange={(event) => updateFilter("player", event.target.value)} placeholder="Player e.g. Erling Haaland" />
        <select value={filters.eventType ?? ""} onChange={(event) => updateFilter("eventType", event.target.value)}>
          <option value="">Any event</option>
          <option value="pass_receive">Receive</option>
          <option value="shot">Shot</option>
        </select>
        <select value={filters.passType ?? ""} onChange={(event) => updateFilter("passType", event.target.value)}>
          <option value="">Any pass</option>
          <option value="through_ball">Through ball</option>
          <option value="cross">Cross</option>
          <option value="cutback">Cutback</option>
          <option value="long_ball">Long ball</option>
          <option value="short_pass">Short pass</option>
        </select>
        <select value={filters.fieldZone ?? ""} onChange={(event) => updateFilter("fieldZone", event.target.value)}>
          <option value="">Any zone</option>
          <option value="final_third">Final third</option>
          <option value="penalty_area">Penalty area</option>
          <option value="middle_third">Middle third</option>
          <option value="defensive_third">Defensive third</option>
        </select>
        <select value={filters.role ?? ""} onChange={(event) => updateFilter("role", event.target.value)}>
          <option value="">Any role</option>
          <option value="receiver">Receiver</option>
          <option value="passer">Passer</option>
          <option value="shooter">Shooter</option>
        </select>
      </div>
      <div className="domain-filter-actions">
        <button type="button" className="small-button" onClick={presetHaaland}>Haaland through ball preset</button>
        <button type="button" className="small-button" onClick={clearFilters}>Clear filters</button>
      </div>
    </section>
  );
}

function QueryPlanCard({ plan }: { plan: DomainQueryPlan }) {
  const filterEntries = Object.entries(plan.domainFilters).filter(([, value]) => Boolean(value));
  return (
    <section className="query-plan-card" aria-label="Structured query plan">
      <div>
        <strong>Query Plan</strong>
        <span>{plan.rewrittenQuery}</span>
      </div>
      <div className="query-plan-grid">
        {filterEntries.length > 0 ? (
          filterEntries.map(([key, value]) => (
            <span key={key}>
              <b>{key}</b>
              {String(value)}
            </span>
          ))
        ) : (
          <span>
            <b>mode</b>
            semantic only
          </span>
        )}
        <span>
          <b>confidence</b>
          {Math.round(plan.confidence * 100)}%
        </span>
      </div>
      {plan.warnings.length > 0 && (
        <p>{plan.warnings.slice(0, 2).join(" ")}</p>
      )}
    </section>
  );
}

function OrchestrationPlanCard({ plan }: { plan: OrchestrationPlan }) {
  const ownerLabel: Record<OrchestrationPlan["steps"][number]["owner"], string> = {
    router: "Router",
    knowledge: "Knowledge",
    marengo: "Marengo",
    pegasus: "Pegasus",
    platform: "Platform"
  };
  return (
    <section className="orchestration-card" aria-label="Model orchestration plan">
      <div className="orchestration-heading">
        <div>
          <strong>Orchestration</strong>
          <span>{plan.mode.replace(/_/g, " ")} · confidence {Math.round(plan.confidence * 100)}%</span>
        </div>
        <em>{plan.retrieval.engine.replace(/_/g, " ")}</em>
      </div>
      <div className="decision-row">
        {plan.decisions.map((decision) => (
          <span key={decision.id} className={decision.status}>
            <b>{decision.label}</b>
            {decision.value}
            <em>{Math.round(decision.confidence * 100)}%</em>
          </span>
        ))}
      </div>
      <div className="orchestration-steps">
        {plan.steps.map((step) => (
          <article key={step.id} className={step.status}>
            <span>{ownerLabel[step.owner]}</span>
            <strong>{step.label}</strong>
            <p>{step.action}</p>
            <em>{step.output}</em>
          </article>
        ))}
      </div>
      {(plan.retrieval.fallback.length > 0 || plan.warnings.length > 0) && (
        <p className="orchestration-warning">{[...plan.retrieval.fallback, ...plan.warnings].slice(0, 3).join(" ")}</p>
      )}
      {plan.analysis.required && (
        <p className="orchestration-analysis">Pegasus prompt: {truncateText(plan.analysis.prompt, 180)}</p>
      )}
    </section>
  );
}

function VideoStatusSummary({ asset }: { asset: AssetRecord }) {
  return (
    <div className="video-status-summary" aria-label="Selected video status">
      <span className={asset.status ? "complete" : ""}>
        <FileVideo size={15} />
        <strong>영상 확인</strong>
        <em>{asset.status}</em>
      </span>
      <span className={asset.status === "indexed" ? "complete" : ""}>
        <Search size={15} />
        <strong>검색 준비</strong>
        <em>{asset.status === "indexed" ? "사용 가능" : asset.status}</em>
      </span>
    </div>
  );
}

function AssetFlow({
  asset,
  index,
  job,
  onRetryStage
}: {
  asset: AssetRecord;
  index: IndexRecord | null;
  job: JobRecord | null;
  onRetryStage: (assetId: string, stage: string) => Promise<void>;
}) {
  const flow = getAssetFlow(asset, index, job);
  const activeStep = flow.find((step) => step.state === "active") ?? flow.find((step) => step.state === "error") ?? flow.at(-1);
  const overallProgress = getServerBackedProgress(asset, job);
  const overallStage = getServerBackedStage(asset, job);
  const stageGroups = [
    {
      label: "1. Source preparation",
      detail: "Validate the media file, probe metadata, then extract speech/music regions.",
      steps: flow.filter((step) => step.id === "input" || step.id === "probe" || step.id === "audio" || step.id === "vad")
    },
    {
      label: "2. Speech intelligence",
      detail: "Run ASR from VAD-focused audio, then align speaker labels from ASR segments.",
      steps: flow.filter((step) => step.id === "asr" || step.id === "speakers")
    },
    {
      label: "3. Visual and text extraction",
      detail: "Sample visual frames and extract on-screen text from subtitle and full-frame lanes.",
      steps: flow.filter((step) => step.id === "ocr" || step.id === "visual")
    },
    {
      label: "4. Search index",
      detail: "Merge ASR, OCR, scene data, domain events, and visual signals into searchable timeline vectors.",
      steps: flow.filter((step) => step.id === "timeline" || step.id === "domain" || step.id === "vector")
    },
    {
      label: "5. Serve",
      detail: "Expose the indexed asset for search and focused analysis.",
      steps: flow.filter((step) => step.id === "ready")
    }
  ].filter((group) => group.steps.length > 0);
  const retryDisabled = job?.status === "queued" || job?.status === "running";
  const retryNode = (step: FlowStep) => void onRetryStage(asset.id, step.retryStage);
  return (
    <section className="asset-flow" aria-label="Selected video processing flow">
      <div className="flow-summary">
        <div>
          <p className="section-label">Node workflow</p>
          <h3>{activeStep?.label ?? "Ready"}</h3>
        </div>
        <span>{overallStage} · {overallProgress}%</span>
      </div>
      <div className="progress-track" aria-label={`${overallProgress}% complete`}>
        <span style={{ width: `${overallProgress}%` }} />
      </div>
      <div className="node-canvas">
        {stageGroups.map((group, index) => (
          <Fragment key={group.label}>
            <section className="workflow-stage">
              <div className="workflow-stage-header">
                <span>{group.label}</span>
                <p>{group.detail}</p>
              </div>
              <div className="node-column">
                {group.steps.map((step) => (
                  <FlowNode key={step.id} step={step} retryDisabled={retryDisabled} onRetry={retryNode} />
                ))}
              </div>
            </section>
            {index < stageGroups.length - 1 && <FlowConnector />}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function getServerBackedProgress(asset: AssetRecord, job: JobRecord | null) {
  if (job?.status === "queued" || job?.status === "running") return job.progress;
  return asset.progress;
}

function getServerBackedStage(asset: AssetRecord, job: JobRecord | null) {
  if (job?.status === "queued" || job?.status === "running") return job.stage;
  return asset.status;
}

function getAssetProgressLine(asset: AssetRecord, job: JobRecord | null) {
  if (job?.status === "queued" || job?.status === "running") {
    return `${job.status} · ${job.stage} · ${job.progress}%`;
  }
  return `${asset.status} ${asset.progress}%`;
}

function FlowNode({
  step,
  retryDisabled,
  onRetry
}: {
  step: FlowStep;
  retryDisabled: boolean;
  onRetry: (step: FlowStep) => void;
}) {
  const progressLabel = step.progress === null ? step.state : `${step.progress}%`;
  return (
    <article className={`flow-node ${step.state}`} title={step.helpText}>
      <div className="node-title">
        <span className="node-kind">{step.id}</span>
        {step.helpText && (
          <span className="node-help" aria-label={step.helpText} title={step.helpText} tabIndex={0}>
            <CircleHelp size={14} />
          </span>
        )}
        <strong>{step.label}</strong>
      </div>
      <p>{step.detail}</p>
      {step.serverProgress && (
        <span className="node-server-progress">
          server {step.serverProgress.status} · {step.serverProgress.stage} · {step.serverProgress.progress}%
        </span>
      )}
      <div className="node-progress" aria-label={`${step.label} ${progressLabel}`}>
        <span style={{ width: `${step.progress ?? 0}%` }} />
      </div>
      <div className="node-actions">
        <span className="node-state">{step.state}</span>
        <span className="node-percent">{progressLabel}</span>
        <button
          type="button"
          className="node-retry"
          onClick={() => onRetry(step)}
          disabled={retryDisabled}
          aria-label={`Retry ${step.label}`}
          title={`Retry ${step.label}`}
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </article>
  );
}

function FlowConnector({ label }: { label?: string }) {
  return (
    <div className="flow-connector" aria-hidden="true">
      <span />
      {label && <em>{label}</em>}
    </div>
  );
}

function SearchSceneEvidence({
  segment,
  query,
  reasons,
  verification
}: {
  segment: AssetRecord["timeline"][number];
  query: string;
  reasons: SearchResult["matchReasons"];
  verification: VerificationCheck[];
}) {
  const scene = getSearchSceneData(segment, query);
  const imagePath = scene.image.thumbnailPath ?? segment.thumbnailPath ?? scene.image.framePath;
  const domainSummary = getDomainSummary(segment);
  const textRows = [
    { label: "Speech", value: scene.text.speech },
    { label: "Subtitle", value: scene.text.subtitles.join(" ") },
    { label: "Screen", value: scene.text.screenText.join(" ") },
    { label: "Overlay", value: scene.text.overlays.join(" ") }
  ].filter((row) => row.value.trim().length > 0);
  const review = scene.text.comparisons?.find((item) => item.status !== "match");
  return (
    <>
      {imagePath ? <img src={mediaPath(imagePath) ?? ""} alt="" /> : <span className="result-image-placeholder">No image</span>}
      <span className="result-segment-copy">
        <strong>
          {formatDuration(segment.start)}-{formatDuration(segment.end)} · shot {segment.scene?.shotIndex ?? "-"}
        </strong>
        <span className="scene-evidence-grid">
          <span className="scene-evidence-block">
            <em>Image</em>
            <span>
              {scene.image.labels.length > 0 ? scene.image.labels.slice(0, 3).join(" · ") : "keyframe"}
              {scene.image.dominantColor ? ` · ${scene.image.dominantColor}` : ""}
            </span>
          </span>
          <span className="scene-evidence-block text">
            <em>Text</em>
            {textRows.length > 0 ? (
              textRows.slice(0, 2).map((row) => (
                <span key={row.label}>
                  <b>{row.label}</b> · {truncateText(row.value, 130)}
                </span>
              ))
            ) : (
              <span>No scene text extracted</span>
            )}
          </span>
          {domainSummary && (
            <span className="scene-evidence-block domain">
              <em>Domain</em>
              <span>{domainSummary}</span>
            </span>
          )}
          {scene.vision && (
            <span className="scene-evidence-block vision">
              <em>Vision</em>
              <span>
                pitch {Math.round(scene.vision.pitch.confidence * 100)}% · players {scene.vision.objects.players.status}
                {scene.vision.objects.ball.status === "estimated" || scene.vision.objects.ball.status === "detected" ? ` · ball ${scene.vision.objects.ball.status}` : ""}
                {scene.vision.fieldZone.zone !== "unknown" ? ` · ${scene.vision.fieldZone.zone}` : ""}
                {scene.vision.tracking?.ballTrackId ? ` · ${scene.vision.tracking.ballTrackId}` : ""}
                {scene.vision.eventClassification && scene.vision.eventClassification.label !== "unknown" ? ` · ${scene.vision.eventClassification.label} ${Math.round(scene.vision.eventClassification.confidence * 100)}%` : ""}
              </span>
            </span>
          )}
          {review && (
            <span className={`scene-evidence-block compare ${review.status}`}>
              <em>Compare</em>
              <span>
                <b>{Math.round(review.similarity * 100)}%</b> · {review.status} · {truncateText(review.suggestedText, 90)}
              </span>
            </span>
          )}
          {reasons.length > 0 && (
            <span className="scene-evidence-reasons">
              {reasons.slice(0, 5).map((reason, index) => (
                <em key={`${reason.kind}-${reason.label}-${index}`} className={reason.kind}>
                  <b>{reason.label}</b>
                  {reason.value}
                  {typeof reason.confidence === "number" ? ` · ${Math.round(reason.confidence * 100)}%` : ""}
                </em>
              ))}
            </span>
          )}
          {verification.length > 0 && (
            <span className="scene-verification-row">
              {verification.slice(0, 7).map((check) => (
                <em key={`${check.constraint}-${check.expected}`} className={check.status}>
                  <b>{check.constraint}</b>
                  {check.status} · {check.observed}
                </em>
              ))}
            </span>
          )}
        </span>
      </span>
    </>
  );
}

function getSearchSceneData(segment: AssetRecord["timeline"][number], query: string) {
  if (segment.sceneData) {
    return {
      ...segment.sceneData,
      text: {
        ...segment.sceneData.text,
        comparisons: segment.sceneData.text.comparisons ?? []
      }
    };
  }
  const evidence = splitSearchEvidence(segment.transcript, segment.label, query);
  return {
    image: {
      thumbnailPath: segment.thumbnailPath,
      framePath: null,
      labels: segment.tags.slice(0, 4),
      dominantColor: "",
      brightness: 0,
      motionScore: 0,
      keyframeAt: (segment.start + segment.end) / 2
    },
    text: {
      speech: evidence.asr,
      subtitles: [],
      screenText: evidence.ocr ? [evidence.ocr] : [],
      overlays: [],
      watermarks: [],
      comparisons: []
    },
    vision: undefined
  };
}

function SignalEvidence({ asset }: { asset: AssetRecord }) {
  const asrSegments = asset.intelligence.asr.segments;
  const ocrFrames = asset.intelligence.ocr.frames;
  const speechSegments = asset.intelligence.audio?.speechSegments ?? [];
  const musicSegments = asset.intelligence.audio?.musicSegments ?? [];
  const speakerSegments = asset.intelligence.diarization?.segments ?? [];
  const domainEvents = asset.timeline.flatMap((segment) =>
    (segment.domain?.events ?? []).map((event) => ({
      segment,
      event
    }))
  );
  const visionSegments = asset.timeline.filter((segment) => segment.sceneData?.vision);
  return (
    <section className="evidence-panel" aria-label="Extracted text evidence">
      <div className="subsection-heading">
        <p className="section-label">Evidence</p>
        <h3>Extracted signals and domain events</h3>
      </div>
      <div className="evidence-grid">
        <article className="evidence-card domain-evidence-card">
          <div className="evidence-title">
            <strong>Domain events</strong>
            <span>{domainEvents.length} candidates</span>
          </div>
          <div className="domain-event-list">
            {domainEvents.length === 0 && <span className="empty-inline">No domain event metadata was generated for this asset.</span>}
            {domainEvents.slice(0, 12).map(({ segment, event }) => (
              <article key={event.id} className="domain-event-row">
                <div>
                  <strong>{event.caption}</strong>
                  <span>
                    {formatDuration(segment.start)}-{formatDuration(segment.end)} · {event.domain} · {Math.round(event.confidence * 100)}%
                  </span>
                </div>
                <div className="domain-chip-row">
                  {event.labels.slice(0, 8).map((label) => (
                    <em key={`${event.id}-${label}`}>{label}</em>
                  ))}
                </div>
                {event.football && (
                  <div className="domain-structured-grid">
                    {segment.domain?.scope?.competition && <span><b>Competition</b>{segment.domain.scope.competition.value} · {segment.domain.scope.competition.source}</span>}
                    {segment.domain?.scope?.season && <span><b>Season</b>{segment.domain.scope.season.value} · {segment.domain.scope.season.source}</span>}
                    <span><b>Event</b>{event.eventType}</span>
                    <span><b>Pass</b>{event.football.passType}</span>
                    <span><b>Zone</b>{event.football.fieldZone}</span>
                    <span><b>Receiver</b>{event.football.receivingPlayer.identity ? `${event.football.receivingPlayer.identity.name} · ${event.football.receivingPlayer.identity.source}` : event.football.receivingPlayer.trackingStatus}</span>
                    {event.football.passingPlayer.identity && <span><b>Passer</b>{event.football.passingPlayer.identity.name} · {event.football.passingPlayer.identity.source}</span>}
                    <span><b>Ball</b>{event.football.ball.state} · {event.football.ball.trackingStatus}</span>
                    <span><b>Field</b>{event.football.field.calibrationStatus} · {Math.round(event.football.field.zoneConfidence * 100)}%</span>
                  </div>
                )}
                <details className="domain-event-details">
                  <summary>Evidence and limitations</summary>
                  <p>{[...event.evidence.asr, ...event.evidence.ocr, ...event.evidence.visual].filter(Boolean).slice(0, 4).join(" · ") || "No direct evidence text stored."}</p>
                  <p>{[...event.evidence.heuristics, ...(event.football?.limitations ?? [])].filter(Boolean).slice(0, 5).join(" · ")}</p>
                </details>
              </article>
            ))}
          </div>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>Vision evidence v0</strong>
            <span>{visionSegments.length} segments</span>
          </div>
          <div className="segment-list compact-list">
            {visionSegments.length === 0 && <span>No vision evidence has been written for this asset.</span>}
            {visionSegments.slice(0, 12).map((segment) => {
              const vision = segment.sceneData?.vision;
              if (!vision) return null;
              return (
                <span key={`vision-${segment.id}`}>
                  {formatDuration(segment.start)}-{formatDuration(segment.end)} · pitch {Math.round(vision.pitch.confidence * 100)}% · players{" "}
                  {vision.objects.players.status}
                  {vision.objects.ball.status === "estimated" || vision.objects.ball.status === "detected" ? ` · ball ${vision.objects.ball.status}` : ""}
                  {vision.fieldZone.zone !== "unknown" ? ` · ${vision.fieldZone.zone}` : ""}
                  {vision.tracking?.ballTrackId ? ` · ${vision.tracking.ballTrackId}` : ""}
                  {vision.eventClassification && vision.eventClassification.label !== "unknown" ? ` · ${vision.eventClassification.label} ${Math.round(vision.eventClassification.confidence * 100)}%` : ""}
                </span>
              );
            })}
          </div>
        </article>

        <article className="evidence-card transcript-card">
          <div className="evidence-title">
            <strong>Audio extract + VAD</strong>
            <span>{speechSegments.length} speech · {musicSegments.length} music</span>
          </div>
          <div className="segment-list compact-list">
            {speechSegments.length === 0 && <span>No speech regions were detected.</span>}
            {speechSegments.map((segment) => (
              <span key={`speech-${segment.start}-${segment.end}`}>
                speech · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {Math.round(segment.confidence * 100)}%
              </span>
            ))}
            {musicSegments.map((segment) => (
              <span key={`music-${segment.start}-${segment.end}`}>
                music/noise bed · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {Math.round(segment.confidence * 100)}%
              </span>
            ))}
          </div>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>Whisper transcript</strong>
            <span>{asset.intelligence.asr.language} · {Math.round(asset.intelligence.asr.confidence * 100)}%</span>
          </div>
          <details className="evidence-disclosure">
            <summary>Show transcript</summary>
            <p className="transcript-box">{asset.intelligence.asr.transcript || "No speech text was extracted."}</p>
            <div className="segment-list compact-list">
              {asrSegments.length === 0 && <span>No timestamped ASR segments.</span>}
              {asrSegments.map((segment) => (
                <span key={`${segment.start}-${segment.end}-${segment.text}`}>
                  {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.text}
                </span>
              ))}
            </div>
          </details>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>WhisperX speakers</strong>
            <span>{asset.intelligence.diarization?.provider ?? "none"}</span>
          </div>
          <div className="segment-list compact-list">
            {speakerSegments.length === 0 && (
              <span>{asset.intelligence.diarization?.error ?? "No speaker diarization segments are available."}</span>
            )}
            {speakerSegments.map((segment) => (
              <span key={`${segment.speaker}-${segment.start}-${segment.end}-${segment.text}`}>
                {segment.speaker} · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.text}
              </span>
            ))}
          </div>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>PaddleOCR tokens</strong>
            <span>{asset.intelligence.ocr.tokens.length} tokens · {Math.round(asset.intelligence.ocr.confidence * 100)}%</span>
          </div>
          <div className="ocr-token-list">
            {asset.intelligence.ocr.tokens.length === 0 && <span>No OCR text was extracted.</span>}
            {asset.intelligence.ocr.tokens.map((token) => (
              <span key={token}>{token}</span>
            ))}
          </div>
          <div className="ocr-frame-list">
            {ocrFrames.length === 0 && <span>No OCR frames are available.</span>}
            {ocrFrames.map((frame) => {
              const src = mediaPath(frame.framePath);
              return (
                <article key={frame.framePath || frame.tokens.join("-")} className="ocr-frame-card">
                  {src && <img src={src} alt="" />}
                  <div>
                    <strong>{Math.round(frame.confidence * 100)}%</strong>
                    <OcrRoleSummary boxes={frame.boxes ?? []} fallback={frame.tokens} />
                  </div>
                </article>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}

function OcrRoleSummary({ boxes, fallback }: { boxes: OcrBox[]; fallback: string[] }) {
  if (boxes.length === 0) return <span>{fallback.length > 0 ? fallback.join(" · ") : "No text"}</span>;
  const groups = [
    ["subtitle", "Subtitle"],
    ["screen_text", "Screen"],
    ["overlay", "Overlay"],
    ["watermark", "Watermark"]
  ] as const;
  return (
    <span className="ocr-role-summary">
      {groups.map(([role, label]) => {
        const text = boxes
          .filter((box) => box.role === role)
          .map((box) => box.text)
          .join(" · ");
        return text ? (
          <em key={role}>
            {label} · {text}
          </em>
        ) : null;
      })}
    </span>
  );
}

function AssetDetailTabs({ active, onChange }: { active: AssetDetailTab; onChange: (tab: AssetDetailTab) => void }) {
  const tabs: Array<{ id: AssetDetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "workflow", label: "Workflow" },
    { id: "evidence", label: "Evidence" },
    { id: "timeline", label: "Timeline" }
  ];
  return (
    <div className="asset-detail-tabs" aria-label="Asset detail sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`asset-detail-tab ${active === tab.id ? "active" : ""}`}
          aria-pressed={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  meta,
  onClick
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`tab-button ${active ? "active" : ""}`} aria-pressed={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
      <strong>{meta}</strong>
    </button>
  );
}

function AssetStatusIndicator({ asset }: { asset: AssetRecord }) {
  if (asset.status === "indexed") {
    return (
      <span className="asset-status-icon" aria-label="Indexed" title="Indexed">
        <IndexStatusIcon />
      </span>
    );
  }
  if (asset.status === "failed") {
    return (
      <span className="asset-status-icon failed" aria-label="Failed" title="Failed">
        <FailStatusIcon />
      </span>
    );
  }

  return <strong>{asset.status}</strong>;
}

function StatusBadge({ asset }: { asset: AssetRecord }) {
  if (asset.status === "indexed") {
    return (
      <span className="badge indexed icon-badge" aria-label="Indexed" title="Indexed">
        <IndexStatusIcon />
      </span>
    );
  }
  if (asset.status === "failed") {
    return (
      <span className="badge failed icon-badge" aria-label="Failed" title="Failed">
        <FailStatusIcon />
      </span>
    );
  }

  return (
    <span className={`badge ${asset.status}`}>
      {asset.status}
      {` ${asset.progress}%`}
    </span>
  );
}

function IndexStatusIcon() {
  return <span className="index-status-icon" aria-hidden="true" />;
}

function FailStatusIcon() {
  return <span className="fail-status-icon" aria-hidden="true" />;
}

function Timeline({
  asset,
  selectedSegmentId,
  onSelect
}: {
  asset: AssetRecord;
  selectedSegmentId: string | null;
  onSelect: (segment: AssetRecord["timeline"][number]) => void;
}) {
  if (asset.timeline.length === 0) return <EmptyState text="Timeline segments will appear after indexing." />;
  return (
    <div className="timeline">
      {asset.timeline.map((segment) => (
        <article key={segment.id} className={selectedSegmentId === segment.id ? "active" : ""} onClick={() => onSelect(segment)}>
          <TimelineThumbnail path={segment.thumbnailPath} />
          <span>
            {formatDuration(segment.start)}-{formatDuration(segment.end)} · shot {segment.scene?.shotIndex ?? "-"} ·{" "}
            {segment.modalities.join(", ")} · {segment.sources.join(", ")}
          </span>
          <strong>{segment.label}</strong>
          <SceneDataSummary segment={segment} />
          <em>confidence {Math.round(segment.confidence * 100)}%</em>
        </article>
      ))}
    </div>
  );
}

function TimelineThumbnail({ path }: { path: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = path && !failed ? mediaPath(path) : null;
  if (!src) return <span className="timeline-thumbnail-placeholder">No image</span>;
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function SceneDataSummary({ segment }: { segment: AssetRecord["timeline"][number] }) {
  const scene = getSearchSceneData(segment, "");
  const domainSummary = getDomainSummary(segment);
  const imageText = [scene.image.labels.slice(0, 3).join(" · "), scene.image.dominantColor].filter(Boolean).join(" · ") || "keyframe";
  const vision = scene.vision;
  const textRows = [
    { label: "Speech", value: scene.text.speech },
    { label: "Subtitle", value: scene.text.subtitles.join(" ") },
    { label: "Screen", value: scene.text.screenText.join(" ") },
    { label: "Overlay", value: scene.text.overlays.join(" ") }
  ].filter((row) => row.value.trim().length > 0);
  const comparisonRows = scene.text.comparisons ?? [];
  return (
    <span className="timeline-scene-data">
      <span>
        <b>Image</b>
        {imageText}
      </span>
      {vision && (
        <span>
          <b>Vision</b>
          pitch {Math.round(vision.pitch.confidence * 100)}% · players {vision.objects.players.status}
          {vision.objects.ball.status === "estimated" || vision.objects.ball.status === "detected" ? ` · ball ${vision.objects.ball.status}` : ""}
          {vision.fieldZone.zone !== "unknown" ? ` · ${vision.fieldZone.zone}` : ""}
          {vision.tracking?.ballTrackId ? ` · ${vision.tracking.ballTrackId}` : ""}
          {vision.eventClassification && vision.eventClassification.label !== "unknown" ? ` · ${vision.eventClassification.label} ${Math.round(vision.eventClassification.confidence * 100)}%` : ""}
        </span>
      )}
      {textRows.slice(0, 3).map((row) => (
        <span key={row.label}>
          <b>{row.label}</b>
          {truncateText(row.value, 150)}
        </span>
      ))}
      {domainSummary && (
        <span>
          <b>Domain</b>
          {truncateText(domainSummary, 150)}
        </span>
      )}
      {comparisonRows.slice(0, 2).map((row, index) => (
        <span key={`${row.kind}-${index}`} className={`timeline-comparison ${row.status}`}>
          <b>Compare</b>
          {Math.round(row.similarity * 100)}% · {row.status} · {truncateText(row.suggestedText, 150)}
        </span>
      ))}
    </span>
  );
}

function getDomainSummary(segment: AssetRecord["timeline"][number]) {
  const event = segment.domain?.events[0];
  if (!event) return "";
  const football = event.football;
  const scope = segment.domain?.scope;
  const parts = [
    scope?.competition ? `competition ${scope.competition.value}` : "",
    scope?.season ? `season ${scope.season.value}` : "",
    event.caption,
    football?.fieldZone && football.fieldZone !== "unknown" ? `zone ${football.fieldZone.replace(/_/g, " ")}` : "",
    football?.passType && football.passType !== "unknown" ? `pass ${football.passType.replace(/_/g, " ")}` : "",
    football?.receivingPlayer.identity ? `receiver ${football.receivingPlayer.identity.name}` : "",
    football?.receivingPlayer.present ? "receiver inferred" : "",
    football?.ball.trackingStatus === "not_configured" ? "tracking pending" : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function getAssetFlow(asset: AssetRecord, index: IndexRecord | null, job: JobRecord | null): FlowStep[] {
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
      label: "Sports domain events",
      detail: hasDomainEvents ? `${asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0)} event candidates` : domainFlow.detail,
      state: hasDomainEvents ? "done" : domainFlow.state
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

function getLatestAssetJob(jobs: JobRecord[], assetId: string) {
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

function mediaPath(value: string) {
  if (!value || value.startsWith("/")) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `/media/${value.split("/").map(encodeURIComponent).join("/")}`;
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function splitSearchEvidence(transcript: string, fallback: string, query: string) {
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  if (!cleaned) return { asr: fallback, ocr: "" };
  const ocrMatch = cleaned.match(/\s+OCR(?:\s+(?:subtitle|screen|overlay))?:\s+/);
  if (!ocrMatch || ocrMatch.index === undefined) return { asr: truncateText(cleaned, 150), ocr: "" };
  const asrPart = cleaned.slice(0, ocrMatch.index);
  const ocrPart = cleaned
    .slice(ocrMatch.index)
      .replace(/\s*OCR(?:\s+(subtitle|screen|overlay))?:\s*/g, (_match, role) => (role ? ` | ${role}: ` : " | "))
      .replace(/^\s*\|\s*/, "")
      .trim();
  const asr = truncateText(asrPart.trim() || fallback, 150);
  const ocr = shouldShowOcrEvidence(ocrPart, asrPart, query) ? truncateText(ocrPart.replace(/\.$/, ""), 120) : "";
  return { asr, ocr };
}

function shouldShowOcrEvidence(ocr: string, asr: string, query: string) {
  const cleaned = ocr.replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  const normalized = cleaned.toLowerCase();
  const boilerplatePatterns = [/이\s*영상(?:엔|에는)?\s*생성형/i, /생성형\s*(?:a|ai)\s*기술/i, /기술이\s*사용\s*되었/i];
  if (boilerplatePatterns.some((pattern) => pattern.test(normalized))) return false;
  const terms = queryTermsForDisplay(query);
  if (terms.length === 0) return !asr.trim();
  const hasQueryHit = terms.some((term) => normalized.includes(term.toLowerCase()));
  return hasQueryHit || !asr.trim();
}

function queryTermsForDisplay(query: string) {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, " ")
        .split(/\s+/)
        .map((term) => term.trim().replace(/^-+|-+$/g, ""))
        .filter((term) => (/[가-힣]/.test(term) ? term.length >= 2 : term.length > 2))
    )
  );
}

function truncateText(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
