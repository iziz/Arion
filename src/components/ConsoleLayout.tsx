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
  SlidersHorizontal,
  UploadCloud,
  X
} from "lucide-react";
import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import type {
  AskResponse,
  AssetRecord,
  ClipDetailResult,
  DomainQueryPlan,
  DomainSearchFilters,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  OrchestrationPlan,
  SearchResult,
  SportsKnowledgeAnswer,
  SportsKnowledgeSnapshot
} from "../../shared/types";
import type { DatabaseStatus, ObservabilitySnapshot } from "../api";
import type { ConsoleTab, DialogMode } from "../consoleTypes";
import { formatDuration } from "../displayUtils";
import { buildEvidenceLedger, type SearchTrustFilters } from "../searchTrust";
import {
  AssetDetailTabs,
  AssetFlow,
  AssetGroupForm,
  AssetGroupSummary,
  AssetStatusIndicator,
  ClipDetailDrawer,
  ClipStrip,
  EmptyState,
  getAssetProgressLine,
  InfoTile,
  KnowledgeEvidenceRow,
  Metric,
  SearchSceneEvidence,
  SignalEvidence,
  SportsKnowledgePanel,
  TabButton,
  Timeline,
  TrustBadge,
  VideoStatusSummary,
  type AssetDetailTab
} from "./ConsoleComponents";
import {
  AdvancedSearchFilters,
  AskOperationTrace,
  OrchestrationPlanCard,
  QueryPlanCard,
  ResultTrustSummary,
  SearchConversation,
  SearchPresetChips,
  SearchScopeSummary,
  SportsAnswerCard,
  type SearchConversationTurn
} from "./SearchPanels";

type SearchPreset = "haaland-through-ball" | "son-goals" | "strict-evidence" | "clear";

export type ConsoleLayoutProps = {
  activeTab: ConsoleTab;
  setActiveTab: Dispatch<SetStateAction<ConsoleTab>>;
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
  sportsKnowledge: SportsKnowledgeSnapshot | null;
  searchResults: SearchResult[];
  setDialogMode: Dispatch<SetStateAction<DialogMode>>;
  selectIndex: (indexId: string) => void;
  selectAsset: (asset: AssetRecord) => void;
  busy: boolean;
  refineAssetGroupVlm: (indexId: string) => Promise<void>;
  assetDetailTab: AssetDetailTab;
  setAssetDetailTab: Dispatch<SetStateAction<AssetDetailTab>>;
  playerRef: RefObject<HTMLVideoElement | null>;
  retryAssetStage: (assetId: string, stage: string) => Promise<void>;
  selectSegment: (assetId: string, segmentId: string, at: number) => void;
  registerKnowledgePlayer: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  deleteKnowledgePlayer: (id: string) => Promise<void>;
  importFootballData: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  importStatbunker: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  searching: boolean;
  runSearch: (event: FormEvent) => Promise<void>;
  applySearchPreset: (preset: SearchPreset) => void;
  filtersOpen: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  activeSearchFilterCount: number;
  searchTag: string;
  setSearchTag: Dispatch<SetStateAction<string>>;
  searchModality: string;
  setSearchModality: Dispatch<SetStateAction<string>>;
  domainFilters: DomainSearchFilters;
  setDomainFilters: Dispatch<SetStateAction<DomainSearchFilters>>;
  trustFilters: SearchTrustFilters;
  setTrustFilters: Dispatch<SetStateAction<SearchTrustFilters>>;
  searchConversation: SearchConversationTurn[];
  buildAssetMomentUrl: (assetId: string, segmentId?: string | null, at?: number | null) => string;
  askResponse: AskResponse | null;
  filterTags: string[];
  filteredSearchResults: SearchResult[];
  sportsAnswer: SportsKnowledgeAnswer | null;
  queryPlan: DomainQueryPlan | null;
  orchestrationPlan: OrchestrationPlan | null;
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
    sportsKnowledge,
    searchResults,
    setDialogMode,
    selectIndex,
    selectAsset,
    busy,
    refineAssetGroupVlm,
    assetDetailTab,
    setAssetDetailTab,
    playerRef,
    retryAssetStage,
    selectSegment,
    registerKnowledgePlayer,
    deleteKnowledgePlayer,
    importFootballData,
    importStatbunker,
    query,
    setQuery,
    searching,
    runSearch,
    applySearchPreset,
    filtersOpen,
    setFiltersOpen,
    activeSearchFilterCount,
    searchTag,
    setSearchTag,
    searchModality,
    setSearchModality,
    domainFilters,
    setDomainFilters,
    trustFilters,
    setTrustFilters,
    searchConversation,
    buildAssetMomentUrl,
    askResponse,
    filterTags,
    filteredSearchResults,
    sportsAnswer,
    queryPlan,
    orchestrationPlan,
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
          active={activeTab === "knowledge"}
          icon={<Layers3 size={17} />}
          label="지식"
          meta={`${sportsKnowledge?.players.length ?? 0} players`}
          onClick={() => setActiveTab("knowledge")}
        />
        <TabButton
          active={activeTab === "system"}
          icon={<Activity size={17} />}
          label="시스템"
          meta={runningJobCount > 0 ? `${runningJobCount} active` : `${metrics.indexedAssets}/${metrics.assets} indexed`}
          onClick={() => setActiveTab("system")}
        />
      </nav>

      {activeTab === "data" && (
      <section className="section-block workflow-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Data</p>
            <h2>에셋</h2>
          </div>
        </div>
        <AssetGroupSummary
          index={selectedIndex}
          assets={visibleAssets}
          busy={busy}
          onEdit={() => setDialogMode("edit-index")}
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

      {activeTab === "knowledge" && (
      <section className="section-block knowledge-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Knowledge</p>
            <h2>지식 베이스</h2>
          </div>
        </div>
        <SportsKnowledgePanel
          sportsKnowledge={sportsKnowledge}
          onSubmit={registerKnowledgePlayer}
          onDelete={deleteKnowledgePlayer}
          onImport={importFootballData}
          onStatbunkerImport={importStatbunker}
          importing={busy}
        />
      </section>
      )}

      {activeTab === "search" && (
      <section className="section-block discovery-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Search</p>
            <h2>검색</h2>
          </div>
        </div>
      <section className="tools">
        <section className="panel">
          <div className="panel-title">
            <Search size={18} />
            <h2>Ask</h2>
          </div>
          <form onSubmit={runSearch} className="search-row search-form ask-form">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask for stats, moments, clips, or patterns" />
            <button type="submit" disabled={searching}>
              <Search size={16} />
              {searching ? "Thinking..." : "Ask"}
            </button>
          </form>
          <div className="ask-toolbar">
            <SearchPresetChips onPreset={applySearchPreset} />
            <button type="button" className={`filter-toggle ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen((open) => !open)}>
              <SlidersHorizontal size={16} />
              Filters
              {activeSearchFilterCount > 0 && <span>{activeSearchFilterCount}</span>}
            </button>
          </div>
          <SearchScopeSummary
            index={selectedIndex}
            tag={searchTag}
            modality={searchModality}
            domainFilters={domainFilters}
            trustFilters={trustFilters}
          />
          <SearchConversation turns={searchConversation} getMomentHref={buildAssetMomentUrl} />
          {askResponse && <AskOperationTrace operation={askResponse.operation} />}
          <AdvancedSearchFilters
            open={filtersOpen}
            selectedIndex={selectedIndex}
            filterTags={filterTags}
            searchTag={searchTag}
            setSearchTag={setSearchTag}
            searchModality={searchModality}
            setSearchModality={setSearchModality}
            domainFilters={domainFilters}
            setDomainFilters={setDomainFilters}
            trustFilters={trustFilters}
            setTrustFilters={setTrustFilters}
            total={searchResults.length}
            visible={filteredSearchResults.length}
          />
          {sportsAnswer?.route !== "stat_qa" && (
            <ResultTrustSummary total={searchResults.length} visible={filteredSearchResults.length} trustFilters={trustFilters} />
          )}
          {sportsAnswer && <SportsAnswerCard answer={sportsAnswer} />}
          {(queryPlan || orchestrationPlan) && (
            <details className="search-diagnostics">
              <summary>검색 진단</summary>
              {queryPlan && <QueryPlanCard plan={queryPlan} />}
              {orchestrationPlan && <OrchestrationPlanCard plan={orchestrationPlan} />}
            </details>
          )}
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
            {filteredSearchResults.map((result) => (
              <article key={result.asset.id} className="result-card">
                <div className="result-card-header">
                  <div>
                    <strong>{result.asset.title}</strong>
                    <span>
                      Relevance {Math.round(result.score)} · {Math.min(result.segments.length, 3)} key moments ·{" "}
                      {result.index?.name ?? "Unknown index"}
                    </span>
                  </div>
                  <TrustBadge ledger={buildEvidenceLedger(result.verification, result.matchReasons, result.segments)} />
                </div>
                {result.explain.some((item) => item.includes("mentioned players:")) && (
                  <span className="result-summary-row">
                    {result.explain
                      .filter((item) => item.includes("mentioned players:"))
                      .map((item) => (
                        <em key={item}>{item}</em>
                      ))}
                  </span>
                )}
                {result.knowledgeEvidence.length > 0 && <KnowledgeEvidenceRow evidence={result.knowledgeEvidence} />}
                {result.segments.slice(0, 3).map((segment) => (
                  <a
                    key={segment.id}
                    className="result-segment"
                    href={buildAssetMomentUrl(result.asset.id, segment.id, segment.start)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <SearchSceneEvidence
                      segment={segment}
                      query={queryPlan?.semanticQuery ?? query}
                      reasons={result.matchReasons.filter((reason) => reason.segmentId === segment.id)}
                      verification={result.verification.filter((check) => check.segmentId === segment.id)}
                    />
                  </a>
                ))}
                {result.clips.length > 0 && <ClipStrip clips={result.clips} getHref={(clip) => buildAssetMomentUrl(clip.assetId, clip.segmentId, clip.start)} />}
              </article>
            ))}
            {!searching && !sportsAnswer && (query || Object.values(domainFilters).some(Boolean)) && searchResults.length === 0 && (
              <EmptyState text="No indexed moment matched the query." />
            )}
            {!searching && searchResults.length > 0 && filteredSearchResults.length === 0 && (
              <EmptyState text="No results match the trust filters. Lower the minimum score or include soft matches." />
            )}
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
            <h2>시스템</h2>
          </div>
        </div>
        <section className="metrics ops-metrics" aria-label="Service snapshot">
          <Metric icon={<Layers3 size={18} />} label="Indexes" value={metrics.indexes.toString()} />
          <Metric icon={<FileVideo size={18} />} label="Total Assets" value={metrics.assets.toString()} />
          <Metric icon={<CheckCircle2 size={18} />} label="Indexed Total" value={metrics.indexedAssets.toString()} />
          <Metric icon={<Clock3 size={18} />} label="Running Jobs" value={metrics.runningJobs.toString()} />
          <Metric icon={<Database size={18} />} label="Segments" value={metrics.segments.toString()} />
          <Metric icon={<Database size={18} />} label="Vectors" value={metrics.vectors.toString()} />
          <Metric icon={<CreditCard size={18} />} label="Billing Units" value={metrics.billingUnits.toString()} />
        </section>
      <section className="ops-grid">
        <section className="panel jobs-panel">
          <div className="panel-title">
            <Activity size={18} />
            <h2>Jobs</h2>
            <span className="panel-count">{jobs.length}</span>
          </div>
          <div className="table-list">
            {jobs.slice(0, 10).map((job) => (
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
            {jobs.length === 0 && <EmptyState text="No jobs have been recorded." />}
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

        <section className="panel events-panel">
          <div className="panel-title">
            <Activity size={18} />
            <h2>Events</h2>
            <span className="panel-count">{events.length}</span>
          </div>
          <div className="table-list">
            {events.map((event) => (
              <article key={event.id} className="ops-row">
                <strong>{event.type}</strong>
                <span>{event.message} · {new Date(event.createdAt).toLocaleTimeString()}</span>
              </article>
            ))}
            {events.length === 0 && <EmptyState text="No operational events have been recorded." />}
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

      {(clipDetail || clipDetailLoading) && (
        <ClipDetailDrawer
          detail={clipDetail}
          loading={clipDetailLoading}
          onClose={() => setClipDetail(null)}
          onSeek={(assetId, segmentId, at) => selectSegment(assetId, segmentId, at)}
        />
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
