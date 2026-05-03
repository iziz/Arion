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
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import type {
  AskResponse,
  AssetRecord,
  ClipDetailResult,
  DomainQueryPlan,
  DomainSearchFilters,
  EventRecord,
  IndexRecord,
  JobRecord,
  KnowledgeVectorStoreStatus,
  MetricsSummary,
  OrchestrationPlan,
  SearchResult,
  SportsDomainGroup,
  SportsKnowledgeAnswer,
  SportsKnowledgeSnapshot
} from "../../shared/types";
import type { DatabaseStatus, ObservabilitySnapshot } from "../api";
import type { ConsoleTab, DialogMode } from "../consoleTypes";
import { formatDuration, mediaPath } from "../displayUtils";
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
  SearchSceneEvidence,
  SportsKnowledgePanel,
  TabButton,
  Timeline,
  TrustBadge,
  VideoStatusSummary,
  type AssetDetailTab
} from "./ConsoleComponents";
import {
  AdvancedSearchFilters,
  ResultTrustSummary,
  SearchConversation,
  SearchDomainSelector,
  SearchScopeSummary,
  SearchWorkflowTrace,
  SportsAnswerCard,
  type SearchConversationTurn
} from "./SearchPanels";

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
  knowledgeVectorStore: KnowledgeVectorStoreStatus | null;
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
  deleteKnowledgePlayer: (id: string) => Promise<void>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  searching: boolean;
  runSearch: (event: FormEvent) => Promise<void>;
  filtersOpen: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  activeSearchFilterCount: number;
  searchTag: string;
  setSearchTag: Dispatch<SetStateAction<string>>;
  searchDomainGroup: SportsDomainGroup | "";
  setSearchDomainGroup: (domainGroup: SportsDomainGroup | "") => void;
  domainFilters: DomainSearchFilters;
  setDomainFilters: Dispatch<SetStateAction<DomainSearchFilters>>;
  trustFilters: SearchTrustFilters;
  setTrustFilters: Dispatch<SetStateAction<SearchTrustFilters>>;
  useKnowledgeLayer: boolean;
  setUseKnowledgeLayer: Dispatch<SetStateAction<boolean>>;
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

type SearchVideoPreview = {
  asset: AssetRecord;
  segment: AssetRecord["timeline"][number];
  start?: number;
  end?: number;
  label?: string;
};

type ObservabilityMetric = ObservabilitySnapshot["latencyMetrics"][number];
type ObservabilityLog = ObservabilitySnapshot["recentLogs"][number];

const sectionTechStacks = {
  data: "React · Express · Multer · FFmpeg/ffprobe · Whisper · PaddleOCR · OpenCLIP · pgvector",
  search: "Query planner · multilingual-e5 · OpenCLIP visual vectors · pgvector HNSW · hybrid lexical ranking",
  knowledge: "Sports registry · Football-Data · StatBunker · StatsBomb · nflverse · knowledge vectors",
  system: "TypeScript · Vite · Node.js/Express · PostgreSQL · OpenTelemetry · local queue · NDJSON logs"
} as const;

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
    knowledgeVectorStore,
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
    deleteKnowledgePlayer,
    query,
    setQuery,
    searching,
    runSearch,
    filtersOpen,
    setFiltersOpen,
    activeSearchFilterCount,
    searchTag,
    setSearchTag,
    searchDomainGroup,
    setSearchDomainGroup,
    domainFilters,
    setDomainFilters,
    trustFilters,
    setTrustFilters,
    useKnowledgeLayer,
    setUseKnowledgeLayer,
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
  const [searchVideoPreview, setSearchVideoPreview] = useState<SearchVideoPreview | null>(null);
  const knowledgeDomains = sportsKnowledge?.domains ?? defaultKnowledgeDomains();
  const [selectedKnowledgeDomain, setSelectedKnowledgeDomain] = useState<SportsDomainGroup>("sports.football");
  const effectiveKnowledgeDomain = knowledgeDomains.find((domain) => domain.id === selectedKnowledgeDomain)?.id ?? knowledgeDomains[0]?.id ?? "sports.football";
  const observabilityView = observability ? buildObservabilityView(observability) : null;
  const failedJobCount = jobs.filter((job) => job.status === "failed").length;
  const succeededJobCount = jobs.filter((job) => job.status === "succeeded").length;
  const visibleJobs = jobs.slice(0, 12);
  const visibleEvents = events.slice(0, 8);

  useEffect(() => {
    if (searching) setSearchVideoPreview(null);
  }, [searching]);

  useEffect(() => {
    if (knowledgeDomains.some((domain) => domain.id === selectedKnowledgeDomain)) return;
    setSelectedKnowledgeDomain(knowledgeDomains[0]?.id ?? "sports.football");
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
        <div>
          <h1>Arion Console</h1>
        </div>
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
        {activeTab === "knowledge" && (
          <section className="asset-nav knowledge-nav" aria-label="Knowledge domain navigation">
            <div className="asset-nav-header">
              <span>도메인</span>
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
          meta={runningJobCount > 0 ? `${runningJobCount} active` : `${metrics.indexedAssets}/${metrics.assets} indexed`}
          onClick={() => setActiveTab("system")}
        />
      </nav>

      {activeTab === "data" && (
      <section className="section-block workflow-section">
        <div className="section-heading">
          <div>
            <p className="section-label">Data</p>
            <h2 className="section-stack-title">{sectionTechStacks.data}</h2>
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
                      <video key={selectedAsset.id} ref={playerRef} className="player" src={`/media/${selectedAsset.storedName}`} controls preload="metadata" />
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
        <SportsKnowledgePanel
          sportsKnowledge={sportsKnowledge}
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
          <div className="search-under-input">
            <SearchDomainSelector value={searchDomainGroup} onChange={setSearchDomainGroup} />
            <div className="search-option-actions">
              <label className={`knowledge-layer-toggle ${useKnowledgeLayer ? "active" : ""}`}>
                <input type="checkbox" checked={useKnowledgeLayer} onChange={(event) => setUseKnowledgeLayer(event.target.checked)} />
                <span>Knowledge layer</span>
              </label>
              <button type="button" className={`filter-toggle ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen((open) => !open)}>
                <SlidersHorizontal size={16} />
                Filters
                {activeSearchFilterCount > 0 && <span>{activeSearchFilterCount}</span>}
              </button>
            </div>
          </div>
          <AdvancedSearchFilters
            open={filtersOpen}
            searchDomainGroup={searchDomainGroup}
            filterTags={filterTags}
            searchTag={searchTag}
            setSearchTag={setSearchTag}
            domainFilters={domainFilters}
            setDomainFilters={setDomainFilters}
            trustFilters={trustFilters}
            setTrustFilters={setTrustFilters}
            total={searchResults.length}
            visible={filteredSearchResults.length}
          />
          <SearchScopeSummary
            domainGroup={searchDomainGroup}
            tag={searchTag}
            domainFilters={domainFilters}
            trustFilters={trustFilters}
            useKnowledgeLayer={useKnowledgeLayer}
          />
          <SearchConversation
            turns={searchConversation}
            getMomentHref={buildAssetMomentUrl}
            onOpenMoment={(asset, segment, options) => openSearchVideo(asset, segment, options)}
          />
          <SearchWorkflowTrace
            operation={askResponse?.operation ?? null}
            queryPlan={queryPlan}
            orchestrationPlan={orchestrationPlan}
            totalResults={searchResults.length}
            visibleResults={filteredSearchResults.length}
          />
          {sportsAnswer?.route !== "stat_qa" && (
            <ResultTrustSummary total={searchResults.length} visible={filteredSearchResults.length} trustFilters={trustFilters} />
          )}
          {sportsAnswer && <SportsAnswerCard answer={sportsAnswer} />}
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
                  <button
                    key={segment.id}
                    type="button"
                    className={`result-segment ${
                      searchVideoPreview?.asset.id === result.asset.id && searchVideoPreview.segment.id === segment.id ? "active" : ""
                    }`}
                    onClick={() => openSearchVideo(result.asset, segment)}
                  >
                    <SearchSceneEvidence
                      segment={segment}
                      query={queryPlan?.semanticQuery ?? query}
                      reasons={result.matchReasons.filter((reason) => reason.segmentId === segment.id)}
                      verification={result.verification.filter((check) => check.segmentId === segment.id)}
                    />
                  </button>
                ))}
                {result.clips.length > 0 && (
                  <ClipStrip
                    clips={result.clips}
                    onOpen={async (clip) => {
                      const segment = result.asset.timeline.find((item) => item.id === clip.segmentId) ?? result.segments.find((item) => item.id === clip.segmentId);
                      if (segment) openSearchVideo(result.asset, segment, { start: clip.start, end: clip.end, label: clip.title });
                    }}
                  />
                )}
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
                      <span><b>pgvector</b>{dbStatus.pgvector ?? "off"}</span>
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

function defaultKnowledgeDomains(): NonNullable<SportsKnowledgeSnapshot["domains"]> {
  return [
    { id: "sports.football", label: "Football", sport: "football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0 },
    { id: "sports.american_football", label: "American football", sport: "american_football", competitions: [], teams: 0, players: 0, matchActivities: 0, facts: 0 }
  ];
}

function formatJobTypeLabel(type: JobRecord["type"]) {
  const labels: Record<JobRecord["type"], string> = {
    "asset.index": "Index asset",
    "asset.reindex": "Reindex asset",
    "asset.domain-vlm.refine": "Domain VLM",
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
