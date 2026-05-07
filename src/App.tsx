import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetRecord,
  AssetSummaryRecord,
  ClipDetailResult,
  IndexRecord,
  JobRecord,
  KnowledgeSourceId,
} from "../shared/types";
import { KNOWLEDGE_SOURCES } from "../shared/knowledgeSources";
import { summarizeAssetRecord } from "../shared/assetSummary";
import {
  api,
  getFailureMessage,
  indexFormPayload,
  isAssetUploadPayload,
  readJson,
} from "./api";
import { getLatestAssetJob } from "./assetFlow";
import type { ConsoleTab, DialogMode } from "./consoleTypes";
import { ConsoleLayout } from "./components/ConsoleLayout";
import { useConsoleData } from "./hooks/useConsoleData";
import { useKnowledgeActions } from "./hooks/useKnowledgeActions";
import { useSearchController } from "./hooks/useSearchController";
import { type AssetDetailTab } from "./components/ConsoleComponents";
import { buildConsoleHref, consoleLocationKey, parseConsoleRoute, type ConsoleRouteState } from "./navigation";

export default function App() {
  const {
    indexes,
    assets,
    jobs,
    events,
    metrics,
    dbStatus,
    observability,
    modelCapabilities,
    knowledgeSnapshot,
    setIndexes,
    setAssets,
    setJobs,
    setKnowledgeSnapshot,
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
  const [selectedMomentTime, setSelectedMomentTime] = useState<number | null>(null);
  const [selectedAssetDetail, setSelectedAssetDetail] = useState<AssetRecord | null>(null);
  const [selectedAssetLoading, setSelectedAssetLoading] = useState(false);
  const [clipDetail, setClipDetail] = useState<ClipDetailResult | null>(null);
  const [clipDetailLoading, setClipDetailLoading] = useState(false);
  const [pendingSeek, setPendingSeek] = useState<{ assetId: string; at: number } | null>(null);
  const [activeTab, setActiveTab] = useState<ConsoleTab>("system");
  const [assetDetailTab, setAssetDetailTab] = useState<AssetDetailTab>("overview");
  const [selectedKnowledgeDomain, setSelectedKnowledgeDomain] = useState<KnowledgeSourceId>(KNOWLEDGE_SOURCES[0]?.id ?? "");
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [busy, setBusy] = useState(false);
  const [routeReady, setRouteReady] = useState(false);
  const routeReadyRef = useRef(false);
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
    searchKnowledgeContext,
    queryPlan,
    searchConversation,
    searchResults,
    filteredSearchResults,
    searching,
    runSearch,
    clearSearchHistory,
    buildAssetMomentUrl
  } = useSearchController({ indexes, assets, selectedIndexId, selectedAssetId, setMessage });
  const { deleteKnowledgePlayer } = useKnowledgeActions({
    setKnowledgeSnapshot,
    setMessage
  });
  const visibleAssets = assets.filter((asset) => !selectedIndex || asset.indexId === selectedIndex.id);
  const selectedAssetSummary = useMemo(
    () => visibleAssets.find((asset) => asset.id === selectedAssetId) ?? null,
    [selectedAssetId, visibleAssets]
  );
  const selectedAsset = selectedAssetDetail?.id === selectedAssetId ? selectedAssetDetail : null;
  const selectedAssetJob = selectedAsset ? getLatestAssetJob(jobs, selectedAsset.id) : null;
  const selectedSegment = selectedAsset?.timeline.find((segment) => segment.id === selectedSegmentId) ?? selectedAsset?.timeline[0] ?? null;

  function buildCurrentRoute(overrides: Partial<ConsoleRouteState> = {}): ConsoleRouteState {
    return {
      activeTab,
      selectedIndexId,
      selectedAssetId,
      selectedSegmentId,
      assetDetailTab,
      selectedKnowledgeDomain,
      seekAt: selectedMomentTime,
      ...overrides
    };
  }

  function writeConsoleRoute(overrides: Partial<ConsoleRouteState>, mode: "push" | "replace") {
    if (!routeReadyRef.current) return;
    const nextHref = buildConsoleHref(buildCurrentRoute(overrides));
    if (nextHref === consoleLocationKey(window.location.href)) return;
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", nextHref);
  }

  function navigateTab(tab: ConsoleTab) {
    setActiveTab(tab);
    writeConsoleRoute({ activeTab: tab }, "push");
  }

  function navigateAssetDetailTab(tab: AssetDetailTab) {
    setAssetDetailTab(tab);
    writeConsoleRoute({ activeTab: "data", assetDetailTab: tab }, "push");
  }

  useEffect(() => {
    function applyRouteFromLocation() {
      const route = parseConsoleRoute(new URL(window.location.href));
      setActiveTab(route.activeTab);
      setAssetDetailTab(route.assetDetailTab);
      if (route.selectedKnowledgeDomain) setSelectedKnowledgeDomain(route.selectedKnowledgeDomain);
      if (route.selectedIndexId) setSelectedIndexId(route.selectedIndexId);
      if (route.activeTab === "data") {
        setSelectedAssetId(route.selectedAssetId);
        setSelectedSegmentId(route.selectedSegmentId);
        setSelectedMomentTime(route.seekAt);
        setPendingSeek(route.selectedAssetId && route.seekAt !== null ? { assetId: route.selectedAssetId, at: route.seekAt } : null);
      }
    }

    applyRouteFromLocation();
    routeReadyRef.current = true;
    setRouteReady(true);
    window.addEventListener("popstate", applyRouteFromLocation);
    return () => window.removeEventListener("popstate", applyRouteFromLocation);
  }, [setSelectedAssetId, setSelectedIndexId]);

  useEffect(() => {
    if (!selectedAssetId) return;
    const asset = assets.find((item) => item.id === selectedAssetId);
    if (asset && asset.indexId !== selectedIndexId) setSelectedIndexId(asset.indexId);
  }, [assets, selectedAssetId, selectedIndexId]);

  useEffect(() => {
    if (!routeReady) return;
    writeConsoleRoute({}, "replace");
  }, [routeReady, activeTab, selectedIndexId, selectedAssetId, selectedSegmentId, selectedMomentTime, assetDetailTab, selectedKnowledgeDomain]);

  useEffect(() => {
    if (!pendingSeek || selectedAsset?.id !== pendingSeek.assetId || !playerRef.current) return;
    playerRef.current.currentTime = pendingSeek.at;
    playerRef.current.pause();
    setPendingSeek(null);
  }, [pendingSeek, selectedAsset]);

  useEffect(() => {
    if (!selectedAssetId) {
      setSelectedAssetDetail(null);
      setSelectedAssetLoading(false);
      return;
    }
    let cancelled = false;
    setSelectedAssetLoading(true);
    api.get<AssetRecord>(`/api/assets/${selectedAssetId}`)
      .then((asset) => {
        if (cancelled) return;
        setSelectedAssetDetail(asset);
      })
      .catch((error) => {
        if (cancelled) return;
        setSelectedAssetDetail(null);
        setMessage(`Asset detail load failed: ${getFailureMessage(error)}`);
      })
      .finally(() => {
        if (!cancelled) setSelectedAssetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAssetId, selectedAssetSummary?.updatedAt, setMessage]);

  function upsertUploadedAsset(asset: AssetRecord, job?: JobRecord) {
    const summary = summarizeAssetRecord(asset);
    setAssets((current) => {
      const existing = current.findIndex((item) => item.id === summary.id);
      if (existing >= 0) {
        const currentAsset = current[existing];
        if (isNewerAssetSummary(currentAsset, summary)) return current;
        return current.map((item) => (item.id === summary.id ? summary : item));
      }
      return [summary, ...current];
    });
    setSelectedAssetDetail(asset);
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
        index.id === summary.indexId
          ? {
              ...index,
              assetIds: index.assetIds.includes(summary.id) ? index.assetIds : [...index.assetIds, summary.id],
              status: "ready",
              updatedAt: summary.updatedAt
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
    if (!selectedIndex) {
      setMessage("Create an asset group before uploading media.");
      return;
    }
    data.set("indexId", selectedIndex.id);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/indexes/${selectedIndex.id}/assets`, {
        method: "POST",
        body: data
      });
      const payload = await readJson<unknown>(response);
      if (!isAssetUploadPayload(payload)) throw new Error("Upload returned an invalid asset payload");
      upsertUploadedAsset(payload.asset, payload.job);
      setSelectedIndexId(payload.asset.indexId);
      setSelectedAssetId(payload.asset.id);
      setSelectedSegmentId(null);
      setSelectedMomentTime(null);
      setActiveTab("data");
      setAssetDetailTab("overview");
      writeConsoleRoute(
        {
          activeTab: "data",
          selectedIndexId: payload.asset.indexId,
          selectedAssetId: payload.asset.id,
          selectedSegmentId: null,
          assetDetailTab: "overview",
          seekAt: null
        },
        "push"
      );
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

  async function deleteAsset(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) return;
    if (!window.confirm(`Delete "${asset.title}" and all related indexing data, vectors, jobs, and media artifacts?`)) return;
    setBusy(true);
    setMessage("");
    try {
      await api.delete<{ assetId: string; indexId: string }>(`/api/assets/${asset.id}`);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setIndexes((current) =>
        current.map((index) =>
          index.id === asset.indexId
            ? {
                ...index,
                assetIds: index.assetIds.filter((id) => id !== asset.id),
                status: index.assetIds.length > 1 ? index.status : "empty",
                updatedAt: new Date().toISOString()
              }
            : index
        )
      );
      if (selectedAssetId === asset.id) {
        setSelectedAssetId(null);
        setSelectedSegmentId(null);
        setSelectedMomentTime(null);
        writeConsoleRoute({ activeTab: "data", selectedIndexId: asset.indexId, selectedAssetId: null, selectedSegmentId: null, seekAt: null }, "replace");
      }
      setMessage("Asset deleted.");
      await refresh();
    } catch (error) {
      setMessage(`Delete failed: ${getFailureMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteIndex(indexId: string) {
    const index = indexes.find((item) => item.id === indexId);
    if (!index) return;
    const indexAssets = assets.filter((asset) => asset.indexId === index.id);
    const detail = indexAssets.length === 1 ? "1 asset" : `${indexAssets.length} assets`;
    if (!window.confirm(`Delete asset group "${index.name}" with ${detail}, including all indexing data, vectors, jobs, and media artifacts?`)) return;
    setBusy(true);
    setMessage("");
    try {
      await api.delete<{ indexId: string; assetIds: string[] }>(`/api/indexes/${index.id}`);
      setIndexes((current) => current.filter((item) => item.id !== index.id));
      setAssets((current) => current.filter((asset) => asset.indexId !== index.id));
      if (selectedIndexId === index.id) {
        setSelectedIndexId("");
        setSelectedAssetId(null);
        setSelectedSegmentId(null);
        setSelectedMomentTime(null);
        writeConsoleRoute({ activeTab: "data", selectedIndexId: null, selectedAssetId: null, selectedSegmentId: null, seekAt: null }, "replace");
      }
      setMessage("Asset group deleted.");
      await refresh();
    } catch (error) {
      setMessage(`Delete failed: ${getFailureMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function seekTo(assetId: string, at: number, segmentId: string | null = null) {
    setActiveTab("data");
    setAssetDetailTab("overview");
    setSelectedAssetId(assetId);
    setSelectedSegmentId(segmentId);
    setSelectedMomentTime(at);
    setPendingSeek({ assetId, at });
    writeConsoleRoute(
      {
        activeTab: "data",
        selectedAssetId: assetId,
        selectedSegmentId: segmentId,
        assetDetailTab: "overview",
        seekAt: at
      },
      "push"
    );
  }

  function selectSegment(assetId: string, segmentId: string, at: number) {
    seekTo(assetId, at, segmentId);
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

  function selectIndex(indexId: string) {
    setActiveTab("data");
    setSelectedIndexId(indexId);
    setSelectedAssetId(null);
    setSelectedSegmentId(null);
    setSelectedMomentTime(null);
    setAssetDetailTab("overview");
    writeConsoleRoute(
      {
        activeTab: "data",
        selectedIndexId: indexId,
        selectedAssetId: null,
        selectedSegmentId: null,
        assetDetailTab: "overview",
        seekAt: null
      },
      "push"
    );
  }

  function selectAsset(asset: AssetSummaryRecord) {
    playerRef.current?.pause();
    setActiveTab("data");
    setSelectedIndexId(asset.indexId);
    setSelectedAssetId(asset.id);
    setSelectedSegmentId(null);
    setSelectedMomentTime(null);
    setAssetDetailTab("overview");
    writeConsoleRoute(
      {
        activeTab: "data",
        selectedIndexId: asset.indexId,
        selectedAssetId: asset.id,
        selectedSegmentId: null,
        assetDetailTab: "overview",
        seekAt: null
      },
      "push"
    );
  }

  return (
    <ConsoleLayout
      activeTab={activeTab}
      setActiveTab={navigateTab}
      indexes={indexes}
      assets={assets}
      visibleAssets={visibleAssets}
      selectedIndex={selectedIndex}
      selectedAsset={selectedAsset}
      selectedAssetLoading={selectedAssetLoading}
      selectedAssetJob={selectedAssetJob}
      selectedSegment={selectedSegment}
      runningJobCount={runningJobCount}
      refresh={refresh}
      metrics={metrics}
      knowledgeSnapshot={knowledgeSnapshot}
      knowledgeVectorStore={knowledgeVectorStore}
      searchResults={searchResults}
      setDialogMode={setDialogMode}
      selectIndex={selectIndex}
      selectAsset={selectAsset}
      deleteIndex={deleteIndex}
      deleteAsset={deleteAsset}
      busy={busy}
      assetDetailTab={assetDetailTab}
      setAssetDetailTab={navigateAssetDetailTab}
      selectedKnowledgeDomain={selectedKnowledgeDomain}
      setSelectedKnowledgeDomain={setSelectedKnowledgeDomain}
      playerRef={playerRef}
      retryAssetStage={retryAssetStage}
      selectSegment={selectSegment}
      deleteKnowledgePlayer={deleteKnowledgePlayer}
      query={query}
      setQuery={setQuery}
      searching={searching}
      runSearch={runSearch}
      clearSearchHistory={clearSearchHistory}
      searchScopeMode={searchScopeMode}
      setSearchScopeMode={setSearchScopeMode}
      searchIndexId={searchIndexId}
      setSearchIndexId={setSearchIndexId}
      searchAssetId={searchAssetId}
      setSearchAssetId={setSearchAssetId}
      searchScopeLabel={searchScopeLabel}
      trustFilters={trustFilters}
      useKnowledgeLayer={useKnowledgeLayer}
      searchKnowledgeContext={searchKnowledgeContext}
      searchConversation={searchConversation}
      buildAssetMomentUrl={buildAssetMomentUrl}
      filteredSearchResults={filteredSearchResults}
      queryPlan={queryPlan}
      jobs={jobs}
      retryJob={retryJob}
      events={events}
      dbStatus={dbStatus}
      observability={observability}
      modelCapabilities={modelCapabilities}
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

function isNewerAssetSummary(current: AssetSummaryRecord, next: AssetSummaryRecord) {
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
