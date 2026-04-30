import {
  Activity,
  Bell,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  CreditCard,
  Database,
  FileVideo,
  Layers3,
  RefreshCw,
  Search,
  UploadCloud
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalysisResult,
  AssetRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  SearchResult,
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

type ConsoleTab = "overview" | "assets" | "discovery" | "operations";

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
  const [question, setQuestion] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeek] = useState<{ assetId: string; at: number } | null>(null);
  const [activeTab, setActiveTab] = useState<ConsoleTab>("assets");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const playerRef = useRef<HTMLVideoElement | null>(null);

  const selectedIndex = indexes.find((index) => index.id === selectedIndexId) ?? indexes[0] ?? null;
  const visibleAssets = assets.filter((asset) => !selectedIndex || asset.indexId === selectedIndex.id);
  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? visibleAssets[0] ?? null,
    [assets, selectedAssetId, visibleAssets]
  );
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const selectedSegment = selectedAsset?.timeline.find((segment) => segment.id === selectedSegmentId) ?? selectedAsset?.timeline[0] ?? null;
  const filterTags = useMemo(() => Array.from(new Set(visibleAssets.flatMap((asset) => asset.tags))).sort(), [visibleAssets]);
  const runningJobCount = jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const observabilityErrorCount = observability?.latencyMetrics.reduce((sum, metric) => sum + metric.errorCount, 0) ?? 0;

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
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(interval);
  }, []);

  async function createIndex(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const index = await api.post<IndexRecord>("/api/indexes", {
      name: data.get("name"),
      description: data.get("description"),
      modalities: ["visual", "audio", "transcription", "metadata"]
    });
    form.reset();
    setSelectedIndexId(index.id);
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
      form.reset();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams({ q: query, indexId: selectedIndex?.id ?? "default-index" });
    if (searchTag) params.set("tag", searchTag);
    if (searchModality) params.set("modality", searchModality);
    setSearchResults(await api.get<SearchResult[]>(`/api/search?${params.toString()}`));
  }

  function seekTo(assetId: string, at: number) {
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

  async function retryWebhook(id: string) {
    await api.post<WebhookRecord>(`/api/webhooks/${id}/retry`, {});
    await refresh();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Full local spec</p>
          <h1>Video Intelligence Console</h1>
        </div>
        <button className="ghost-button" type="button" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </header>

      <nav className="view-tabs" aria-label="Console sections">
        <TabButton
          active={activeTab === "overview"}
          icon={<Activity size={17} />}
          label="Overview"
          meta={`${metrics.indexedAssets}/${metrics.assets} indexed`}
          onClick={() => setActiveTab("overview")}
        />
        <TabButton
          active={activeTab === "assets"}
          icon={<FileVideo size={17} />}
          label="Assets"
          meta={selectedAsset?.status ?? `${visibleAssets.length} assets`}
          onClick={() => setActiveTab("assets")}
        />
        <TabButton
          active={activeTab === "discovery"}
          icon={<Search size={17} />}
          label="Discovery"
          meta={`${searchResults.length} results`}
          onClick={() => setActiveTab("discovery")}
        />
        <TabButton
          active={activeTab === "operations"}
          icon={<Database size={17} />}
          label="Operations"
          meta={runningJobCount > 0 ? `${runningJobCount} running` : `${observabilityErrorCount} errors`}
          onClick={() => setActiveTab("operations")}
        />
      </nav>

      <section className="context-bar" aria-label="Current context">
        <div>
          <span>Active asset</span>
          <strong>{selectedAsset?.title ?? "No asset selected"}</strong>
        </div>
        <div>
          <span>Index</span>
          <strong>{selectedIndex?.name ?? "No index"}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{selectedAsset ? selectedAsset.status : "idle"}</strong>
        </div>
        <div>
          <span>Queue</span>
          <strong>{runningJobCount > 0 ? `${runningJobCount} active` : "clear"}</strong>
        </div>
        <button type="button" className="small-button" onClick={() => setActiveTab("assets")}>
          <FileVideo size={14} />
          Open asset
        </button>
      </section>

      {activeTab === "overview" && (
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
          <Metric icon={<FileVideo size={18} />} label="Assets" value={metrics.assets.toString()} />
          <Metric icon={<CheckCircle2 size={18} />} label="Indexed" value={metrics.indexedAssets.toString()} />
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
        <div className="section-heading">
          <div>
            <p className="section-label">Asset workflow</p>
            <h2>Ingest, browse, inspect</h2>
          </div>
          <p>Create indexes, upload media, and review selected asset signals in one flow.</p>
        </div>
        <div className="workflow-steps" aria-label="Asset workflow steps">
          <span className={selectedIndex ? "complete" : ""}>
            <Layers3 size={16} />
            <strong>Index</strong>
            <em>{selectedIndex ? selectedIndex.name : "Not selected"}</em>
          </span>
          <span className={visibleAssets.length > 0 ? "complete" : ""}>
            <UploadCloud size={16} />
            <strong>Ingest</strong>
            <em>{visibleAssets.length} assets</em>
          </span>
          <span className={selectedAsset ? "complete" : ""}>
            <FileVideo size={16} />
            <strong>Review</strong>
            <em>{selectedAsset?.status ?? "No asset"}</em>
          </span>
          <span className={searchResults.length > 0 ? "complete" : ""}>
            <Search size={16} />
            <strong>Discover</strong>
            <em>{searchResults.length} results</em>
          </span>
        </div>
      <section className="full-grid asset-workbench">
        <aside className="panel control-panel">
          <div className="panel-title">
            <Layers3 size={18} />
            <h2>Index setup</h2>
          </div>
          <p className="panel-kicker">Choose the active collection for upload, search, and analysis.</p>
          <select value={selectedIndex?.id ?? ""} onChange={(event) => setSelectedIndexId(event.target.value)}>
            {indexes.map((index) => (
              <option key={index.id} value={index.id}>
                {index.name}
              </option>
            ))}
          </select>
          <form className="stack compact" onSubmit={createIndex}>
            <input name="name" placeholder="New index name" />
            <textarea name="description" placeholder="Index description" />
            <button type="submit">
              <Layers3 size={16} />
              Create index
            </button>
          </form>

          <div className="panel-title spacer">
            <UploadCloud size={18} />
            <h2>Ingest</h2>
          </div>
          <p className="panel-kicker">Upload video or audio into the selected index.</p>
          <form className="stack compact" onSubmit={uploadAsset}>
            <input name="title" placeholder="Asset title" />
            <textarea name="description" placeholder="Context for search and analysis" />
            <input name="video" type="file" accept="video/*,audio/*" />
            <button type="submit" disabled={busy}>
              <UploadCloud size={16} />
              {busy ? "Uploading" : "Upload and index"}
            </button>
          </form>
          {message && <p className="hint">{message}</p>}
        </aside>

        <section className="panel library-panel">
          <div className="panel-title">
            <FileVideo size={18} />
            <h2>Asset library</h2>
            <span className="panel-count">{visibleAssets.length}</span>
          </div>
          <p className="panel-kicker">Pick an asset to inspect metadata, model signals, and timeline segments.</p>
          <div className="asset-list">
            {visibleAssets.length === 0 && <EmptyState text="No assets in this index." />}
            {visibleAssets.map((asset) => (
              <button
                key={asset.id}
                className={`asset-row ${selectedAsset?.id === asset.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedAssetId(asset.id);
                  setSelectedSegmentId(asset.timeline[0]?.id ?? null);
                  setAnalysis(null);
                }}
              >
                <div>
                  <strong>{asset.title}</strong>
                  <span>{asset.originalName}</span>
                </div>
                <StatusBadge asset={asset} />
              </button>
            ))}
          </div>
        </section>

        <section className="panel detail-panel">
          {selectedAsset ? (
            <>
              <div className="panel-title detail-title">
                <FileVideo size={18} />
                <h2>Review workspace</h2>
              </div>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{selectedIndex?.name ?? "Index"}</p>
                  <h2>{selectedAsset.title}</h2>
                </div>
                <StatusBadge asset={selectedAsset} />
              </div>
              <video ref={playerRef} className="player" src={`/media/${selectedAsset.storedName}`} controls />
              <div className="metadata-grid">
                <InfoTile label="Duration" value={formatDuration(selectedAsset.duration ?? 0)} />
                <InfoTile
                  label="Frame"
                  value={selectedAsset.width && selectedAsset.height ? `${selectedAsset.width}x${selectedAsset.height}` : "No dimensions"}
                />
                <InfoTile label="Codec" value={selectedAsset.technicalMetadata.videoCodec ?? "No codec"} />
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
              <div className="chips">
                {selectedAsset.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
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
            </>
          ) : (
            <EmptyState text="Select or upload an asset." />
          )}
        </section>
      </section>
      </section>
      )}

      {activeTab === "discovery" && (
      <section className="section-block discovery-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Discovery</p>
            <h2>Search and analyze</h2>
          </div>
          <p>Find timeline moments first, then ask focused questions about the selected asset.</p>
        </div>
      <section className="tools">
        <section className="panel">
          <div className="panel-title">
            <Search size={18} />
            <h2>Search</h2>
          </div>
          <form onSubmit={runSearch} className="search-row">
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
            <button type="submit">
              <Search size={16} />
              Search
            </button>
          </form>
          <div className="result-list">
            {searchResults.map((result) => (
              <article key={result.asset.id} className="result-card">
                <div>
                  <strong>{result.asset.title}</strong>
                  <span>
                    Score {result.score} · semantic {result.ranking.semantic} · lexical {result.ranking.lexical} ·{" "}
                    visual {result.ranking.visual} ·{" "}
                    {result.index?.name ?? "Unknown index"}
                  </span>
                </div>
                {result.segments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    className="result-segment"
                    onClick={() => selectSegment(result.asset.id, segment.id, segment.start)}
                  >
                    {segment.thumbnailPath && <img src={`/media/${segment.thumbnailPath}`} alt="" />}
                    <p>
                      {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.label} · shot{" "}
                      {segment.scene?.shotIndex ?? "-"}
                    </p>
                  </button>
                ))}
                <div className="rank-grid">
                  <span>visual {result.ranking.visual}</span>
                  <span>source {result.ranking.source}</span>
                  <span>confidence {result.ranking.confidence}</span>
                </div>
              </article>
            ))}
            {query && searchResults.length === 0 && <EmptyState text="No indexed moment matched the query." />}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <BrainCircuit size={18} />
            <h2>Analyze</h2>
          </div>
          <form onSubmit={runAnalysis} className="search-row">
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

      {activeTab === "operations" && (
      <section className="section-block ops-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Operations</p>
            <h2>Jobs, delivery, storage, traces</h2>
          </div>
          <p>Watch background processing and local infrastructure from a single area.</p>
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

function StatusBadge({ asset }: { asset: AssetRecord }) {
  return (
    <span className={`badge ${asset.status}`}>
      {asset.status}
      {asset.status !== "indexed" && ` ${asset.progress}%`}
    </span>
  );
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
          {segment.thumbnailPath && <img src={`/media/${segment.thumbnailPath}`} alt="" />}
          <span>
            {formatDuration(segment.start)}-{formatDuration(segment.end)} · shot {segment.scene?.shotIndex ?? "-"} ·{" "}
            {segment.modalities.join(", ")} · {segment.sources.join(", ")}
          </span>
          <strong>{segment.label}</strong>
          <p>{segment.transcript}</p>
          <em>confidence {Math.round(segment.confidence * 100)}%</em>
        </article>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
