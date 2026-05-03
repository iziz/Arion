import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  SportsKnowledgeSnapshot
} from "../../shared/types";
import {
  api,
  emptyMetrics,
  getArrayResult,
  getGuardedResult,
  isDatabaseStatus,
  isMetricsSummary,
  isObservabilitySnapshot,
  isSportsKnowledgeSnapshot,
  type DatabaseStatus,
  type ObservabilitySnapshot
} from "../api";

export function useConsoleData() {
  const [indexes, setIndexes] = useState<IndexRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsSummary>(emptyMetrics);
  const [dbStatus, setDbStatus] = useState<DatabaseStatus | null>(null);
  const [observability, setObservability] = useState<ObservabilitySnapshot | null>(null);
  const [sportsKnowledge, setSportsKnowledge] = useState<SportsKnowledgeSnapshot | null>(null);
  const [selectedIndexId, setSelectedIndexId] = useState("default-index");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const refreshPromise = useRef<Promise<void> | null>(null);
  const initialSelectionHydrated = useRef(false);

  const runningJobCount = useMemo(
    () => jobs.filter((job) => job.status === "running" || job.status === "queued").length,
    [jobs]
  );

  const refresh = useCallback(async () => {
    if (refreshPromise.current) return refreshPromise.current;
    const promise = (async () => {
      const health = await api.get<{ status: string }>("/api/health").catch(() => null);
      if (!health) {
        setMessage("Refresh warning: API server is restarting or unavailable.");
        return;
      }
      const [indexesResult, assetsResult, jobsResult, eventsResult, metricsResult, dbStatusResult, observabilityResult, sportsKnowledgeResult] =
        await Promise.allSettled([
          api.get<IndexRecord[]>("/api/indexes"),
          api.get<AssetRecord[]>("/api/assets"),
          api.get<JobRecord[]>("/api/jobs"),
          api.get<EventRecord[]>("/api/events?limit=20"),
          api.get<MetricsSummary>("/api/metrics"),
          api.get<DatabaseStatus>("/api/db/status"),
          api.get<ObservabilitySnapshot>("/api/observability"),
          api.get<SportsKnowledgeSnapshot>("/api/knowledge/sports")
        ]);
      const failures: string[] = [];
      const nextIndexes = getArrayResult<IndexRecord>(indexesResult, "indexes", failures);
      const nextAssets = getArrayResult<AssetRecord>(assetsResult, "assets", failures);
      const nextJobs = getArrayResult<JobRecord>(jobsResult, "jobs", failures);
      const nextEvents = getArrayResult<EventRecord>(eventsResult, "events", failures);
      const nextMetrics = getGuardedResult(metricsResult, "metrics", isMetricsSummary, failures);
      const nextDbStatus = getGuardedResult(dbStatusResult, "database status", isDatabaseStatus, failures);
      const nextObservability = getGuardedResult(observabilityResult, "observability", isObservabilitySnapshot, failures);
      const nextSportsKnowledge = getGuardedResult(sportsKnowledgeResult, "sports knowledge", isSportsKnowledgeSnapshot, failures);

      if (nextIndexes) {
        setIndexes(nextIndexes);
        setSelectedIndexId((current) => (current && nextIndexes.some((index) => index.id === current) ? current : nextIndexes[0]?.id ?? current));
      }
      if (nextAssets) {
        setAssets(nextAssets);
        setSelectedAssetId((current) => {
          if (current) return nextAssets.some((asset) => asset.id === current) ? current : null;
          if (initialSelectionHydrated.current) return current;
          initialSelectionHydrated.current = true;
          return nextAssets.find((asset) => asset.indexId === selectedIndexId)?.id ?? null;
        });
      }
      if (nextJobs) setJobs(nextJobs);
      if (nextEvents) setEvents(nextEvents);
      if (nextMetrics) setMetrics(nextMetrics);
      if (nextDbStatus) setDbStatus(nextDbStatus);
      if (nextObservability) setObservability(nextObservability);
      if (nextSportsKnowledge) setSportsKnowledge(nextSportsKnowledge);

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
  }, [selectedIndexId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), runningJobCount > 0 ? 1500 : 4000);
    return () => window.clearInterval(interval);
  }, [refresh, runningJobCount]);

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
