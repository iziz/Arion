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
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import type {
  AssetRecord,
  ClipDetailResult,
  DomainQueryPlan,
  EventRecord,
  IndexRecord,
  JobRecord,
  KnowledgeSourceId,
  KnowledgeVectorStoreStatus,
  MetricsSummary,
  SearchResult,
  KnowledgeSnapshot
} from "../../shared/types";
import { KNOWLEDGE_SOURCES } from "../../shared/knowledgeSources";
import type { DatabaseStatus, ObservabilitySnapshot } from "../api";
import type { ConsoleTab, DialogMode, SearchKnowledgeContext, SearchScopeMode } from "../consoleTypes";
import { formatDuration, mediaPath } from "../displayUtils";
import { type SearchTrustFilters } from "../searchTrust";
import {
  AssetDetailTabs,
  AssetFlow,
  AssetGroupForm,
  AssetGroupSummary,
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
  assets: AssetRecord[];
  visibleAssets: AssetRecord[];
  visibleIndexedAssets: number;
  selectedIndex: IndexRecord | null;
  selectedAsset: AssetRecord | null;
  selectedAssetJob: JobRecord | null;
  selectedSegment: AssetRecord["timeline"][number] | null;
  selectedJob: JobRecord | null;
  runningJobCount: number;
  refresh: () => Promise<void>;
  metrics: MetricsSummary;
  knowledgeSnapshot: KnowledgeSnapshot | null;
  knowledgeVectorStore: KnowledgeVectorStoreStatus | null;
  searchResults: SearchResult[];
  setDialogMode: Dispatch<SetStateAction<DialogMode>>;
  selectIndex: (indexId: string) => void;
  selectAsset: (asset: AssetRecord) => void;
  deleteIndex: (indexId: string) => Promise<void>;
  deleteAsset: (assetId: string) => Promise<void>;
  busy: boolean;
  refineAssetGroupVlm: (indexId: string) => Promise<void>;
  assetDetailTab: AssetDetailTab;
  setAssetDetailTab: (tab: AssetDetailTab) => void;
  selectedKnowledgeDomain: KnowledgeSourceId;
  setSelectedKnowledgeDomain: (domain: KnowledgeSourceId) => void;
  playerRef: RefObject<HTMLVideoElement | null>;
  retryAssetStage: (assetId: string, stage: string) => Promise<void>;
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
  setSelectedJobId: Dispatch<SetStateAction<string | null>>;
  retryJob: (id: string) => Promise<void>;
  events: EventRecord[];
  dbStatus: DatabaseStatus | null;
  observability: ObservabilitySnapshot | null;
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
  asset: AssetRecord;
  segment: AssetRecord["timeline"][number];
  start?: number;
  end?: number;
  label?: string;
};

type ObservabilityMetric = ObservabilitySnapshot["latencyMetrics"][number];
type ObservabilityLog = ObservabilitySnapshot["recentLogs"][number];

const dataTechStack = ["React", "Express", "Multer", "FFmpeg/ffprobe", "Whisper", "PaddleOCR", "OpenCLIP", "pgvector"] as const;

const sectionTechStacks = {
  search: "Query planner · multilingual-e5 · OpenCLIP visual vectors · pgvector HNSW · hybrid lexical ranking",
  knowledge: "Related knowledge · registry sources · semantic vectors · evidence grounding",
  system: "TypeScript · Vite · Node.js/Express · PostgreSQL · OpenTelemetry · local queue · NDJSON logs"
} as const;

type AssetOverviewFact = {
  label: string;
  value: string;
};

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

export function ConsoleLayout(props: ConsoleLayoutProps) {
  const {
    activeTab,
    setActiveTab,
    indexes,
    assets,
    visibleAssets,
    visibleIndexedAssets,
    selectedIndex,
    selectedAsset,
    selectedAssetJob,
    selectedSegment,
    selectedJob,
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
    refineAssetGroupVlm,
    assetDetailTab,
    setAssetDetailTab,
    selectedKnowledgeDomain,
    setSelectedKnowledgeDomain,
    playerRef,
    retryAssetStage,
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
    setSelectedJobId,
    retryJob,
    events,
    dbStatus,
    observability,
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
  const knowledgeDomains = knowledgeSnapshot?.domains ?? defaultKnowledgeDomains();
  const effectiveKnowledgeDomain = knowledgeDomains.find((domain) => domain.id === selectedKnowledgeDomain)?.id ?? knowledgeDomains[0]?.id ?? KNOWLEDGE_SOURCES[0]?.id ?? "";
  const observabilityView = observability ? buildObservabilityView(observability) : null;
  const failedJobCount = jobs.filter((job) => job.status === "failed").length;
  const succeededJobCount = jobs.filter((job) => job.status === "succeeded").length;
  const visibleJobs = jobs.slice(0, 12);
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

  useEffect(() => {
    if (searching) setSearchVideoPreview(null);
  }, [searching]);

  useEffect(() => {
    if (knowledgeDomains.some((domain) => domain.id === selectedKnowledgeDomain)) return;
    setSelectedKnowledgeDomain(knowledgeDomains[0]?.id ?? KNOWLEDGE_SOURCES[0]?.id ?? "");
  }, [knowledgeDomains, selectedKnowledgeDomain]);

  function openSearchVideo(
    asset: AssetRecord,
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
            <strong>{metrics.indexedAssets}/{metrics.assets} indexed · {indexes.length} groups</strong>
          </div>
          <div>
            <span>Data group</span>
            <strong>{selectedIndex?.name ?? "No group"}</strong>
          </div>
          <div>
            <span>Queue</span>
            <strong>{activeJobCount > 0 ? `${activeJobCount} active` : "clear"}</strong>
          </div>
        </section>
        <button className="ghost-button icon-only" type="button" aria-label="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={16} />
        </button>
      </header>

      <nav className="view-tabs" aria-label="Console sections">
        <a className="brand-logo" href="/" aria-label="Arion.AI home">
          <span className="brand-mark" aria-hidden="true">
            <img src="/arion-mark.svg" alt="" />
          </span>
          <span className="brand-copy">
            <strong>Arion.AI</strong>
            <em>Video Intelligence</em>
          </span>
        </a>
        <TabButton
          active={activeTab === "data"}
          icon={<FileVideo size={17} />}
          label="에셋"
          meta={`${visibleIndexedAssets}/${visibleAssets.length} indexed`}
          onClick={() => setActiveTab("data")}
        />
        {activeTab === "data" && (
          <section className="asset-nav" aria-label="Data navigation">
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
                  <button key={index.id} type="button" className={`asset-nav-item ${selectedIndex?.id === index.id ? "active" : ""}`} onClick={() => selectIndex(index.id)}>
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
              {visibleAssets.map((asset) => {
                const deleteDisabled = busy || activeAssetIds.has(asset.id);
                return (
                  <div key={asset.id} className={`asset-nav-row ${selectedAsset?.id === asset.id ? "active" : ""}`}>
                    <button type="button" className={`asset-nav-item video ${selectedAsset?.id === asset.id ? "active" : ""}`} onClick={() => selectAsset(asset)}>
                      <span className="asset-nav-title">{asset.title}</span>
                      <AssetStatusIndicator asset={asset} />
                    </button>
                    <button
                      type="button"
                      className="nav-delete-button"
                      aria-label={`${asset.title} 삭제`}
                      title={deleteDisabled ? "인덱싱 중인 영상은 삭제할 수 없습니다." : "영상 삭제"}
                      disabled={deleteDisabled}
                      onClick={() => void deleteAsset(asset.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
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
          active={activeTab === "knowledge"}
          icon={<Layers3 size={17} />}
          label="지식"
          meta={`${knowledgeSnapshot?.players.length ?? 0} records`}
          onClick={() => setActiveTab("knowledge")}
        />
        {activeTab === "knowledge" && (
          <section className="asset-nav knowledge-nav" aria-label="Related knowledge navigation">
            <div className="asset-nav-header">
              <span>관련 지식</span>
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
                  <strong>{domain.players}/{domain.teams}</strong>
                </button>
              ))}
            </div>
          </section>
        )}
        <TabButton
          active={activeTab === "system"}
          icon={<Activity size={17} />}
          label="시스템"
          meta={activeJobCount > 0 ? `${activeJobCount} active` : `${metrics.indexedAssets}/${metrics.assets} indexed`}
          onClick={() => setActiveTab("system")}
        />
      </nav>

      {activeTab === "data" && (
      <section className="section-block workflow-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Data</p>
            <h2 className="section-stack-title tech-stack-tags" aria-label={dataTechStack.join(", ")}>
              {dataTechStack.map((item) => (
                <span key={item} className="tech-stack-tag">
                  {item}
                </span>
              ))}
            </h2>
          </div>
        </div>
        <AssetGroupSummary
          index={selectedIndex}
          assets={visibleAssets}
          busy={busy}
          onEdit={() => setDialogMode("edit-index")}
          onDelete={() => selectedIndex && void deleteIndex(selectedIndex.id)}
          deleteDisabled={busy || selectedIndexDeleteDisabled}
          deleteTitle={selectedIndexDeleteDisabled ? "인덱싱 중인 영상이 있어 에셋그룹을 삭제할 수 없습니다." : "에셋그룹 삭제"}
          onRefineVlm={(indexId) => void refineAssetGroupVlm(indexId)}
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
                  <p className="summary">{selectedAsset.summary || "Indexing metadata is not ready yet."}</p>
                  <div className="chips">
                    {selectedAsset.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </section>
              )}
              {assetDetailTab === "workflow" && (
                <AssetFlow
                  asset={selectedAsset}
                  index={selectedIndex}
                  job={selectedAssetJob}
                  onRetryStage={retryAssetStage}
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
                      <h3>{selectedAsset.timeline.length} indexed moments</h3>
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
            <h2 className="section-stack-title">{sectionTechStacks.knowledge}</h2>
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
            <h2 className="section-stack-title">{sectionTechStacks.search}</h2>
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
            <SearchScopeSummary
              scopeLabel={searchScopeLabel}
              trustFilters={trustFilters}
              useKnowledgeLayer={useKnowledgeLayer}
              knowledgeContext={searchKnowledgeContext}
              onTargetClick={() => setSearchTargetOpen((current) => !current)}
              targetExpanded={searchTargetOpen}
            />
            {searchTargetOpen && (
              <div className="search-target-panel">
                <SearchScopeSelector
                  mode={searchScopeMode}
                  onModeChange={setSearchScopeMode}
                  indexes={indexes}
                  assets={assets}
                  indexId={searchIndexId}
                  onIndexChange={setSearchIndexId}
                  assetId={searchAssetId}
                  onAssetChange={setSearchAssetId}
                />
              </div>
            )}
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
            <h2 className="section-stack-title">{sectionTechStacks.system}</h2>
          </div>
        </div>
        <section className="system-console">
          <section className="system-kpi-grid" aria-label="Service snapshot">
            <article className="system-kpi">
              <CheckCircle2 size={18} />
              <span>Indexed Assets</span>
              <strong>{metrics.indexedAssets}/{metrics.assets}</strong>
              <em>{metrics.indexes} indexes</em>
            </article>
            <article className="system-kpi">
              <Clock3 size={18} />
              <span>Jobs</span>
              <strong>{metrics.runningJobs}</strong>
              <em>{failedJobCount} failed · {succeededJobCount} succeeded</em>
            </article>
            <article className="system-kpi">
              <Layers3 size={18} />
              <span>Timeline</span>
              <strong>{metrics.segments}</strong>
              <em>{metrics.vectors} vectors</em>
            </article>
            <article className="system-kpi">
              <CreditCard size={18} />
              <span>Billing Units</span>
              <strong>{metrics.billingUnits}</strong>
              <em>{dbStatus?.enabled ? "PostgreSQL" : dbStatus?.storage ?? "storage pending"}</em>
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
                  <span>{jobs.length} total</span>
                  <span>{metrics.runningJobs} running</span>
                </div>
              </div>

              <div className="system-job-list">
                {visibleJobs.map((job) => (
                  <article key={job.id} className={`system-job-row ${job.status} ${selectedJob?.id === job.id ? "active" : ""}`}>
                    <button type="button" className="system-job-main" onClick={() => setSelectedJobId(job.id)}>
                      <span className={`system-status-pill ${job.status}`}>{formatJobStatus(job.status)}</span>
                      <strong>{formatJobTypeLabel(job.type)}</strong>
                      <span>{formatJobStageLabel(job)}</span>
                      <span>{formatJobProgressLabel(job)}</span>
                      <time>{formatRelativeTime(job.updatedAt)}</time>
                    </button>
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

              {selectedJob && (
                <article className="system-job-detail">
                  <div className="system-detail-title">
                    <div>
                      <p className="section-label">Selected Job</p>
                      <h3>{formatJobDetailTitle(selectedJob)}</h3>
                    </div>
                    <span className={`system-status-pill ${selectedJob.status}`}>{formatJobStatus(selectedJob.status)}</span>
                  </div>
                  <div className="system-detail-grid">
                    <span><b>Type</b>{formatJobTypeLabel(selectedJob.type)}</span>
                    <span><b>Stage</b>{formatJobStageLabel(selectedJob)}</span>
                    <span><b>Progress</b>{formatJobProgressLabel(selectedJob)}</span>
                    <span><b>Updated</b>{formatRelativeTime(selectedJob.updatedAt)}</span>
                  </div>
                  <span className="job-id">Job ID {selectedJob.id}</span>
                  {selectedJob.error && <p className="system-job-error">{selectedJob.error}</p>}
                  <div className="system-log-list">
                    <strong>Job Logs</strong>
                    {selectedJob.logs.slice(-6).map((log) => (
                      <p key={`${log.at}-${log.message}`}>
                        <time>{new Date(log.at).toLocaleTimeString()}</time>
                        <span>{log.level}</span>
                        {log.message}
                      </p>
                    ))}
                  </div>
                </article>
              )}
            </section>

            <aside className="system-side-column">
              <section className="panel system-panel system-events-panel">
                <div className="system-panel-header">
                  <div>
                    <p className="section-label">Event Feed</p>
                    <h2>Events</h2>
                  </div>
                  <span className="panel-count">{events.length}</span>
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

              <section className="system-info-grid">
                <section className="panel system-panel system-database-panel">
                  <div className="system-panel-header compact">
                    <div>
                      <p className="section-label">Storage</p>
                      <h2>Database</h2>
                    </div>
                    <Database size={18} />
                  </div>
                  {dbStatus ? (
                    <div className="system-fact-grid">
                      <span><b>Store</b>{dbStatus.enabled ? "PostgreSQL" : dbStatus.storage ?? "File storage"}</span>
                      <span><b>State</b>{dbStatus.operationalState ?? (dbStatus.enabled ? "ready" : "local")}</span>
                      <span><b>Vector</b>{dbStatus.pgvector ? `${dbStatus.vectorSearchMode ?? "pgvector"} ${dbStatus.pgvector}` : dbStatus.vectorSearchMode ?? "off"}</span>
                      <span><b>Text</b>{dbStatus.embeddingColumn ?? `${dbStatus.expectedEmbeddingDimensions ?? 0} dimensions`}</span>
                      <span><b>Visual</b>{dbStatus.visualEmbeddingColumn ?? `${dbStatus.expectedVisualEmbeddingDimensions ?? 0} dimensions`}</span>
                    </div>
                  ) : (
                    <EmptyState text="Database status is loading." />
                  )}
                </section>

                <section className="panel system-panel system-observability-panel">
                  <div className="system-panel-header compact">
                    <div>
                      <p className="section-label">Telemetry</p>
                      <h2>Observability</h2>
                    </div>
                    <Activity size={18} />
                  </div>
                  {observabilityView ? (
                    <>
                      <div className="system-fact-grid">
                        <span><b>Trace</b>{observabilityView.traceStore} · {observabilityView.spanCount} spans</span>
                        <span><b>API p95</b>{observabilityView.httpP95}</span>
                        <span><b>Pipeline</b>{observabilityView.pipelineErrorCount} errors</span>
                        <span><b>Logs</b>{observabilityView.logFormat}</span>
                      </div>
                      {observabilityView.pipelineMetrics.length > 0 && (
                        <div className="system-mini-metrics">
                          {observabilityView.pipelineMetrics.slice(0, 3).map((metric) => (
                            <span key={metric.key}>
                              <b>{formatMetricName(metric.key)}</b>
                              p95 {formatLatency(metric.p95Ms)} · {metric.errorCount} errors
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <EmptyState text="Observability data is loading." />
                  )}
                </section>
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

function defaultKnowledgeDomains(): NonNullable<KnowledgeSnapshot["domains"]> {
  return [
    { id: "sports.football", label: "Football", sport: "football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0 },
    { id: "sports.american_football", label: "American football", sport: "american_football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0 }
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

function formatJobDetailTitle(job: JobRecord) {
  if (job.stage === "stale") return "Interrupted by server restart";
  return formatJobStageLabel(job);
}

function formatJobProgressLabel(job: JobRecord) {
  if (job.stage === "stale") return getRecoveredJobDisposition(job);
  return `${job.progress}%`;
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
    httpSummary: httpMetric ? `${httpMetric.count} requests · ${httpMetric.errorCount} errors` : "No request metrics",
    pipelineErrorCount: pipelineMetricPool.reduce((sum, metric) => sum + metric.errorCount, 0),
    logFormat: formatLogFormat(snapshot.logFormat),
    logPath: compactLogPath(snapshot.logPath),
    slowestLabel: slowestMetric ? `Slowest p95 ${formatMetricName(slowestMetric.key)} ${formatLatency(slowestMetric.p95Ms)}` : "Waiting for pipeline samples",
    pipelineMetrics,
    signalLogs: snapshot.recentLogs.filter(isOperationalSignalLog).slice(0, 5)
  };
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
  return `${Math.round(value)}ms`;
}

function formatMetricName(key: string) {
  const acronyms = new Set(["api", "asr", "http", "ocr", "p95", "vad", "vlm"]);
  return key
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => (acronyms.has(part.toLowerCase()) ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(" ");
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
