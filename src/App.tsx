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
  return value === "overview" || value === "workflow" || value === "timeline";
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
    setIndexes,
    setAssets,
    setJobs,
    setSportsKnowledge,
    knowledgeVectorStore,
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
    searchScopeMode,
    setSearchScopeMode,
    searchIndexId,
    setSearchIndexId,
    searchAssetId,
    setSearchAssetId,
    searchScopeLabel,
    trustFilters,
    useKnowledgeLayer,
    setUseKnowledgeLayer,
    queryPlan,
    orchestrationPlan,
    sportsAnswer,
    askResponse,
    searchConversation,
    searchResults,
    filteredSearchResults,
    searching,
    runSearch,
    buildAssetMomentUrl
  } = useSearchController({ indexes, assets, selectedIndexId, selectedAssetId, setMessage });
  const { deleteKnowledgePlayer } = useKnowledgeActions({
    setSportsKnowledge,
    setMessage
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
    const url = new URL(window.location.href);
    if (selectedAssetId) {
      url.searchParams.set("asset", selectedAssetId);
    } else {
      url.searchParams.delete("asset");
      url.searchParams.delete("segment");
      url.searchParams.delete("t");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedAssetId]);

  useEffect(() => {
    if (!pendingSeek || selectedAsset?.id !== pendingSeek.assetId || !playerRef.current) return;
    playerRef.current.currentTime = pendingSeek.at;
    playerRef.current.pause();
    setPendingSeek(null);
  }, [pendingSeek, selectedAsset]);

  function upsertUploadedAsset(asset: AssetRecord, job?: JobRecord) {
    setAssets((current) => {
      const existing = current.findIndex((item) => item.id === asset.id);
      if (existing >= 0) {
        const currentAsset = current[existing];
        if (isNewerAssetRecord(currentAsset, asset)) return current;
        return current.map((item) => (item.id === asset.id ? asset : item));
      }
      return [asset, ...current];
    });
    if (job) {
      setJobs((current) => {
        const existing = current.findIndex((item) => item.id === job.id);
        if (existing >= 0) {
          const currentJob = current[existing];
          if (isNewerJobRecord(currentJob, job)) return current;
          return current.map((item) => (item.id === job.id ? job : item));
        }
        return [job, ...current];
      });
    }
    setIndexes((current) =>
      current.map((index) =>
        index.id === asset.indexId
          ? {
              ...index,
              assetIds: index.assetIds.includes(asset.id) ? index.assetIds : [...index.assetIds, asset.id],
              status: "ready",
              updatedAt: asset.updatedAt
            }
          : index
      )
    );
  }

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
      upsertUploadedAsset(payload.asset, payload.job);
      setSelectedIndexId(payload.asset.indexId);
      setSelectedAssetId(payload.asset.id);
      setSelectedSegmentId(null);
      setActiveTab("data");
      setAssetDetailTab("overview");
      form.reset();
      setDialogMode(null);
      void refresh()
        .catch((error) => setMessage(`Refresh warning: ${getFailureMessage(error)}`))
        .finally(() => setSelectedAssetId(payload.asset.id));
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
      setMessage(`Queued ${result.queued} sports event VLM refinement jobs${result.skipped ? `, skipped ${result.skipped} active assets` : ""}.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function selectIndex(indexId: string) {
    setSelectedIndexId(indexId);
    setSelectedAssetId(null);
    setSelectedSegmentId(null);
    setAssetDetailTab("overview");
  }

  function selectAsset(asset: AssetRecord) {
    playerRef.current?.pause();
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
      knowledgeVectorStore={knowledgeVectorStore}
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
      deleteKnowledgePlayer={deleteKnowledgePlayer}
      query={query}
      setQuery={setQuery}
      searching={searching}
      runSearch={runSearch}
      searchScopeMode={searchScopeMode}
      setSearchScopeMode={setSearchScopeMode}
      searchIndexId={searchIndexId}
      setSearchIndexId={setSearchIndexId}
      searchAssetId={searchAssetId}
      setSearchAssetId={setSearchAssetId}
      searchScopeLabel={searchScopeLabel}
      trustFilters={trustFilters}
      useKnowledgeLayer={useKnowledgeLayer}
      setUseKnowledgeLayer={setUseKnowledgeLayer}
      searchConversation={searchConversation}
      buildAssetMomentUrl={buildAssetMomentUrl}
      askResponse={askResponse}
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

function isNewerAssetRecord(current: AssetRecord, next: AssetRecord) {
  const currentTime = Date.parse(current.updatedAt) || 0;
  const nextTime = Date.parse(next.updatedAt) || 0;
  if (currentTime !== nextTime) return currentTime > nextTime;
  return current.progress > next.progress;
}

function isNewerJobRecord(current: JobRecord, next: JobRecord) {
  const currentTime = Date.parse(current.updatedAt) || 0;
  const nextTime = Date.parse(next.updatedAt) || 0;
  if (currentTime !== nextTime) return currentTime > nextTime;
  return current.progress > next.progress;
}
