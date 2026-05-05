import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  KnowledgeVectorStoreStatus,
  MetricsSummary,
  SportsKnowledgeSnapshot
} from "../../shared/types";
import {
  api,
  emptyMetrics,
  getArrayResult,
  getGuardedResult,
  isDatabaseStatus,
  isKnowledgeVectorStoreStatus,
  isMetricsSummary,
  isObservabilitySnapshot,
  isSportsKnowledgeSnapshot,
  type DatabaseStatus,
  type ObservabilitySnapshot
} from "../api";
import { getConsoleRefreshIntervalMs } from "./useConsoleRefreshPolicy";

export function useConsoleData() {
  const [indexes, setIndexes] = useState<IndexRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsSummary>(emptyMetrics);
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(null);
  const [observability, setObservability] = useState<ObservabilitySnapshot | null>(null);
  const [sportsKnowledge, setSportsKnowledge] = useState<SportsKnowledgeSnapshot | null>(null);
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
        api.get<AssetRecord[]>("/api/assets"),
        api.get<JobRecord[]>("/api/jobs"),
        api.get<EventRecord[]>("/api/events?limit=20")
      ]);
      const nextIndexes = getArrayResult<IndexRecord>(indexesResult, "indexes", failures);
      const nextAssets = getArrayResult<AssetRecord>(assetsResult, "assets", failures);
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

      const [metricsResult, dbStatusResult, observabilityResult, sportsKnowledgeResult, knowledgeVectorStoreResult] = await Promise.allSettled([
        api.get<MetricsSummary>("/api/metrics"),
        api.get<DatabaseStatus>("/api/db/status"),
        api.get<ObservabilitySnapshot>("/api/observability"),
        api.get<SportsKnowledgeSnapshot>("/api/knowledge/sports"),
        api.get<KnowledgeVectorStoreStatus>("/api/knowledge/sports/vector-store")
      ]);
      const nextMetrics = getGuardedResult(metricsResult, "metrics", isMetricsSummary, failures);
      const nextDbStatus = getGuardedResult(dbStatusResult, "database status", isDatabaseStatus, failures);
      const nextObservability = getGuardedResult(observabilityResult, "observability", isObservabilitySnapshot, failures);
      const nextSportsKnowledge = getGuardedResult(sportsKnowledgeResult, "sports knowledge", isSportsKnowledgeSnapshot, failures);
      const nextKnowledgeVectorStore = getGuardedResult(knowledgeVectorStoreResult, "knowledge vector store", isKnowledgeVectorStoreStatus, failures);

      if (nextMetrics) setMetrics(nextMetrics);
      if (nextDbStatus) setDbStatus(nextDbStatus);
      if (nextObservability) setObservability(nextObservability);
      if (nextSportsKnowledge) setSportsKnowledge(nextSportsKnowledge);
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
    sportsKnowledge,
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
  };
}
