import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetSummaryRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  KnowledgeVectorStoreStatus,
  MetricsSummary,
  KnowledgeSnapshot
} from "../../shared/types";
import {
  api,
  emptyMetrics,
  getArrayResult,
  getGuardedResult,
  isDatabaseStatus,
  isKnowledgeVectorStoreStatus,
  isModelCapabilitiesSnapshot,
  isMetricsSummary,
  isObservabilitySnapshot,
  isKnowledgeSnapshot,
  type DatabaseStatus,
  type ModelCapabilitiesSnapshot,
  type ObservabilitySnapshot
} from "../api";
import { getConsoleRefreshIntervalMs } from "./useConsoleRefreshPolicy";

export function useConsoleData() {
  const [indexes, setIndexes] = useState<IndexRecord[]>([]);
  const [assets, setAssets] = useState<AssetSummaryRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsSummary>(emptyMetrics);
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(null);
  const [observability, setObservability] = useState<ObservabilitySnapshot | null>(null);
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilitiesSnapshot | null>(null);
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [knowledgeVectorStore, setKnowledgeVectorStore] = useState<KnowledgeVectorStoreStatus | null>(null);
  const [selectedIndexId, setSelectedIndexId] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const refreshPromise = useRef<Promise<void> | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const runningJobCount = useMemo(
    () => jobs.filter((job) => job.status === "running" || job.status === "queued").length,
    [jobs]
  );

  const refresh = useCallback(async () => {
    if (refreshPromise.current) return refreshPromise.current;
    const promise = (async () => {
      const failures: string[] = [];
      const [indexesResult, assetsResult, jobsResult, eventsResult] = await Promise.allSettled([
        api.get<IndexRecord[]>("/api/indexes"),
        api.get<AssetSummaryRecord[]>("/api/assets/summary"),
        api.get<JobRecord[]>("/api/jobs"),
        api.get<EventRecord[]>("/api/events?limit=20")
      ]);
      const nextIndexes = getArrayResult<IndexRecord>(indexesResult, "indexes", failures);
      const nextAssets = getArrayResult<AssetSummaryRecord>(assetsResult, "assets", failures);
      const nextJobs = getArrayResult<JobRecord>(jobsResult, "jobs", failures);
      const nextEvents = getArrayResult<EventRecord>(eventsResult, "events", failures);

      if (nextIndexes) {
        setIndexes(nextIndexes);
        setSelectedIndexId((current) => (current && nextIndexes.some((index) => index.id === current) ? current : nextIndexes[0]?.id ?? ""));
      }
      if (nextAssets) {
        setAssets(nextAssets);
        setSelectedAssetId((current) => {
          if (current) return nextAssets.some((asset) => asset.id === current) ? current : null;
          return null;
        });
      }
      if (nextJobs) setJobs(nextJobs);
      if (nextEvents) setEvents(nextEvents);

      const [metricsResult, dbStatusResult, observabilityResult, modelCapabilitiesResult, knowledgeSnapshotResult, knowledgeVectorStoreResult] = await Promise.allSettled([
        api.get<MetricsSummary>("/api/metrics"),
        api.get<DatabaseStatus>("/api/db/status"),
        api.get<ObservabilitySnapshot>("/api/observability"),
        api.get<ModelCapabilitiesSnapshot>("/api/model-capabilities"),
        getWithFallback<KnowledgeSnapshot>([
          "/api/knowledge/summary",
          "/api/knowledge?summary=true",
          "/api/knowledge/sports/summary",
          "/api/knowledge/sports?summary=true"
        ]),
        getWithFallback<KnowledgeVectorStoreStatus>(["/api/knowledge/vector-store", "/api/knowledge/sports/vector-store"])
      ]);
      const nextMetrics = getGuardedResult(metricsResult, "metrics", isMetricsSummary, failures);
      const nextDbStatus = getGuardedResult(dbStatusResult, "database status", isDatabaseStatus, failures);
      const nextObservability = getGuardedResult(observabilityResult, "observability", isObservabilitySnapshot, failures);
      const nextModelCapabilities = getGuardedResult(modelCapabilitiesResult, "model capabilities", isModelCapabilitiesSnapshot, failures);
      const nextKnowledgeSnapshot = getGuardedResult(knowledgeSnapshotResult, "related knowledge", isKnowledgeSnapshot, failures);
      const nextKnowledgeVectorStore = getGuardedResult(knowledgeVectorStoreResult, "knowledge vector store", isKnowledgeVectorStoreStatus, failures);

      if (nextMetrics) setMetrics(nextMetrics);
      if (nextDbStatus) setDbStatus(nextDbStatus);
      if (nextObservability) setObservability(nextObservability);
      if (nextModelCapabilities) setModelCapabilities(nextModelCapabilities);
      if (nextKnowledgeSnapshot) setKnowledgeSnapshot(nextKnowledgeSnapshot);
      if (nextKnowledgeVectorStore) setKnowledgeVectorStore(nextKnowledgeVectorStore);

      if (failures.length > 0) {
        const criticalFailures = [indexesResult, assetsResult, jobsResult, eventsResult].filter((result) => result.status === "rejected").length;
        setMessage(
          criticalFailures === 4
            ? "Refresh warning: API server is restarting or unavailable."
            : `Refresh warning: ${failures.slice(0, 2).join("; ")}`
        );
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
  }, []);

  useEffect(() => {
    void refresh();
    const source = new EventSource("/api/events/stream");
    const scheduleRefresh = () => {
      if (refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 150);
    };
    const eventTypes = ["asset.updated", "asset.deleted", "index.deleted", "job.updated", "event.recorded", "outbox.updated", "ask.operation.updated"];
    for (const eventType of eventTypes) source.addEventListener(eventType, scheduleRefresh);
    source.onerror = () => {
      setMessage((current) => current || "Realtime updates disconnected; refresh will resume when the server reconnects.");
    };
    source.onopen = () => {
      setMessage((current) => (current.startsWith("Realtime updates disconnected") ? "" : current));
    };
    return () => {
      for (const eventType of eventTypes) source.removeEventListener(eventType, scheduleRefresh);
      source.close();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refresh]);

  useEffect(() => {
    const intervalMs = getConsoleRefreshIntervalMs(jobs);
    if (intervalMs === null) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  return {
    indexes,
    setIndexes,
    assets,
    setAssets,
    jobs,
    setJobs,
    events,
    metrics,
    dbStatus,
    observability,
    modelCapabilities,
    knowledgeSnapshot,
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
  };
}

async function getWithFallback<T>(urls: string[]): Promise<T> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      return await api.get<T>(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All API fallbacks failed: ${urls.join(", ")}`);
}
