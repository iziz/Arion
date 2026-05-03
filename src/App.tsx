import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetRecord,
  ClipDetailResult,
  IndexRecord,
  JobRecord,
} from "../shared/types";
import {
  api,
  getFailureMessage,
  indexFormPayload,
  isAssetUploadPayload,
  readJson,
  type DomainVlmBulkRefineResult,
} from "./api";
import { getLatestAssetJob } from "./assetFlow";
import type { ConsoleTab, DialogMode } from "./consoleTypes";
import { ConsoleLayout } from "./components/ConsoleLayout";
import { useConsoleData } from "./hooks/useConsoleData";
import { useKnowledgeActions } from "./hooks/useKnowledgeActions";
import { useSearchController } from "./hooks/useSearchController";
import { type AssetDetailTab } from "./components/ConsoleComponents";

function isConsoleTab(value: string | null): value is ConsoleTab {
  return value === "data" || value === "knowledge" || value === "search" || value === "system";
}

function isAssetDetailTab(value: string | null): value is AssetDetailTab {
  return value === "overview" || value === "workflow" || value === "evidence" || value === "timeline";
}

export default function App() {
  const {
    indexes,
    assets,
    jobs,
    events,
    metrics,
    dbStatus,
    observability,
    sportsKnowledge,
    setSportsKnowledge,
    selectedIndexId,
    setSelectedIndexId,
    selectedAssetId,
    setSelectedAssetId,
    runningJobCount,
    refresh,
    message,
    setMessage
  } = useConsoleData();
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [clipDetail, setClipDetail] = useState<ClipDetailResult | null>(null);
  const [clipDetailLoading, setClipDetailLoading] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [pendingSeek, setPendingSeek] = useState<{ assetId: string; at: number } | null>(null);
  const [activeTab, setActiveTab] = useState<ConsoleTab>("system");
  const [assetDetailTab, setAssetDetailTab] = useState<AssetDetailTab>("overview");
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [busy, setBusy] = useState(false);
  const playerRef = useRef<HTMLVideoElement | null>(null);

  const selectedIndex = indexes.find((index) => index.id === selectedIndexId) ?? indexes[0] ?? null;
  const {
    query,
    setQuery,
    searchTag,
    setSearchTag,
    searchModality,
    setSearchModality,
    filtersOpen,
    setFiltersOpen,
    domainFilters,
    setDomainFilters,
    trustFilters,
    setTrustFilters,
    queryPlan,
    orchestrationPlan,
    sportsAnswer,
    askResponse,
    searchConversation,
    searchResults,
    filteredSearchResults,
    searching,
    activeSearchFilterCount,
    runSearch,
    applySearchPreset,
    buildAssetMomentUrl
  } = useSearchController({ selectedIndex, setMessage });
  const { registerKnowledgePlayer, deleteKnowledgePlayer, importFootballData, importStatbunker } = useKnowledgeActions({
    setSportsKnowledge,
    setMessage,
    setBusy
  });
  const visibleAssets = assets.filter((asset) => !selectedIndex || asset.indexId === selectedIndex.id);
  const visibleIndexedAssets = visibleAssets.filter((asset) => asset.status === "indexed").length;
  const selectedAsset = useMemo(
    () => visibleAssets.find((asset) => asset.id === selectedAssetId) ?? null,
    [selectedAssetId, visibleAssets]
  );
  const selectedAssetJob = selectedAsset ? getLatestAssetJob(jobs, selectedAsset.id) : null;
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const selectedSegment = selectedAsset?.timeline.find((segment) => segment.id === selectedSegmentId) ?? selectedAsset?.timeline[0] ?? null;
  const filterTags = useMemo(() => Array.from(new Set(visibleAssets.flatMap((asset) => asset.tags))).sort(), [visibleAssets]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get("asset");
    const segmentId = params.get("segment");
    const at = Number(params.get("t"));
    const tab = params.get("tab");
    const detailTab = params.get("assetTab");
    if (tab === "dashboard") setActiveTab("system");
    if (isConsoleTab(tab)) setActiveTab(tab);
    if (isAssetDetailTab(detailTab)) setAssetDetailTab(detailTab);
    if (assetId) setSelectedAssetId(assetId);
    if (segmentId) setSelectedSegmentId(segmentId);
    if (assetId && Number.isFinite(at)) setPendingSeek({ assetId, at });
  }, []);

  useEffect(() => {
    if (!selectedAssetId) return;
    const asset = assets.find((item) => item.id === selectedAssetId);
    if (asset && asset.indexId !== selectedIndexId) setSelectedIndexId(asset.indexId);
  }, [assets, selectedAssetId, selectedIndexId]);

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
      setActiveTab("data");
      setAssetDetailTab("overview");
      form.reset();
      setDialogMode(null);
      await refresh();
    } catch (error) {
      setMessage(`Upload failed: ${getFailureMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function seekTo(assetId: string, at: number) {
    setActiveTab("data");
    setAssetDetailTab("overview");
    setSelectedAssetId(assetId);
    setPendingSeek({ assetId, at });
  }

  function selectSegment(assetId: string, segmentId: string, at: number) {
    setSelectedSegmentId(segmentId);
    seekTo(assetId, at);
  }

  async function retryJob(id: string) {
    await api.post<JobRecord>(`/api/jobs/${id}/retry`, {});
    await refresh();
  }

  async function retryAssetStage(assetId: string, stage: string) {
    if (stage === "domain") {
      await api.post<JobRecord>(`/api/assets/${assetId}/domain-vlm/refine`, {});
    } else {
      await api.post<JobRecord>(`/api/assets/${assetId}/reindex`, { stage });
    }
    await refresh();
  }

  async function refineAssetGroupVlm(indexId: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await api.post<DomainVlmBulkRefineResult>(`/api/indexes/${indexId}/domain-vlm/refine`, {});
      setMessage(`Queued ${result.queued} VLM refinement jobs${result.skipped ? `, skipped ${result.skipped} active assets` : ""}.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function selectIndex(indexId: string) {
    setSelectedIndexId(indexId);
    const firstAsset = assets.find((asset) => asset.indexId === indexId) ?? null;
    setSelectedAssetId(firstAsset?.id ?? null);
    setSelectedSegmentId(firstAsset?.timeline[0]?.id ?? null);
    setAssetDetailTab("overview");
  }

  function selectAsset(asset: AssetRecord) {
    setSelectedAssetId(asset.id);
    setSelectedSegmentId(asset.timeline[0]?.id ?? null);
    setAssetDetailTab("overview");
  }

  return (
    <ConsoleLayout
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      indexes={indexes}
      assets={assets}
      visibleAssets={visibleAssets}
      visibleIndexedAssets={visibleIndexedAssets}
      selectedIndex={selectedIndex}
      selectedAsset={selectedAsset}
      selectedAssetJob={selectedAssetJob}
      selectedSegment={selectedSegment}
      selectedJob={selectedJob}
      runningJobCount={runningJobCount}
      refresh={refresh}
      metrics={metrics}
      sportsKnowledge={sportsKnowledge}
      searchResults={searchResults}
      setDialogMode={setDialogMode}
      selectIndex={selectIndex}
      selectAsset={selectAsset}
      busy={busy}
      refineAssetGroupVlm={refineAssetGroupVlm}
      assetDetailTab={assetDetailTab}
      setAssetDetailTab={setAssetDetailTab}
      playerRef={playerRef}
      retryAssetStage={retryAssetStage}
      selectSegment={selectSegment}
      registerKnowledgePlayer={registerKnowledgePlayer}
      deleteKnowledgePlayer={deleteKnowledgePlayer}
      importFootballData={importFootballData}
      importStatbunker={importStatbunker}
      query={query}
      setQuery={setQuery}
      searching={searching}
      runSearch={runSearch}
      applySearchPreset={applySearchPreset}
      filtersOpen={filtersOpen}
      setFiltersOpen={setFiltersOpen}
      activeSearchFilterCount={activeSearchFilterCount}
      searchTag={searchTag}
      setSearchTag={setSearchTag}
      searchModality={searchModality}
      setSearchModality={setSearchModality}
      domainFilters={domainFilters}
      setDomainFilters={setDomainFilters}
      trustFilters={trustFilters}
      setTrustFilters={setTrustFilters}
      searchConversation={searchConversation}
      buildAssetMomentUrl={buildAssetMomentUrl}
      askResponse={askResponse}
      filterTags={filterTags}
      filteredSearchResults={filteredSearchResults}
      sportsAnswer={sportsAnswer}
      queryPlan={queryPlan}
      orchestrationPlan={orchestrationPlan}
      jobs={jobs}
      setSelectedJobId={setSelectedJobId}
      retryJob={retryJob}
      events={events}
      dbStatus={dbStatus}
      observability={observability}
      clipDetail={clipDetail}
      clipDetailLoading={clipDetailLoading}
      setClipDetail={setClipDetail}
      dialogMode={dialogMode}
      createIndex={createIndex}
      updateIndex={updateIndex}
      uploadAsset={uploadAsset}
      message={message}
    />
  );
}
