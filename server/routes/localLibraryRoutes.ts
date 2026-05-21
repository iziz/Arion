import type { Express } from "express";
import { summarizeAssetRecord } from "../../shared/assetSummary";
import type { ExternalMediaMetadata } from "../../shared/types";
import { sendNotFound } from "../http/middleware";
import { importLocalLibrary, previewLocalLibrary } from "../services/localLibraryImport";
import { publishQueueOutbox } from "../services/queueOutboxPublisher";
import { getIndex } from "../store";

export function registerLocalLibraryRoutes(app: Express) {
  app.post("/api/local-library/preview", async (req, res) => {
    const rootPath = parseRootPath(req.body);
    if (!rootPath) {
      res.status(400).json({ error: "Local library path is required." });
      return;
    }
    const limit = parseLimit(req.body?.limit, 100);
    const preview = await previewLocalLibrary(rootPath, limit);
    res.json({
      rootPath,
      scanned: preview.length,
      files: preview.map((item) => ({
        path: item.path,
        originalName: item.originalName,
        title: item.title,
        size: item.size,
        candidates: item.candidates,
        metadata: summarizeMetadata(item.metadata)
      }))
    });
  });

  app.post("/api/local-library/import", async (req, res) => {
    const rootPath = parseRootPath(req.body);
    if (!rootPath) {
      res.status(400).json({ error: "Local library path is required." });
      return;
    }
    const indexId = String(req.body?.indexId || "").trim();
    if (!indexId) {
      res.status(400).json({ error: "Target asset group is required." });
      return;
    }
    const index = await getIndex(indexId);
    if (!index) return sendNotFound(res, "Index not found");

    const result = await importLocalLibrary({
      rootPath,
      indexId,
      limit: parseLimit(req.body?.limit, 500),
      queueJobs: req.body?.queueJobs !== false
    });
    const dispatchQueue = req.body?.dispatchQueue !== false;
    const queueDispatch = dispatchQueue && result.jobs.length > 0 ? await publishQueueOutbox("asset-job", Math.max(10, result.jobs.length)) : null;

    res.status(202).json({
      rootPath: result.rootPath,
      indexId: result.indexId,
      scanned: result.scanned,
      imported: result.imported,
      skipped: result.skipped,
      queueDispatch,
      jobs: result.jobs.map((job) => ({
        id: job.id,
        assetId: job.assetId,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        updatedAt: job.updatedAt
      })),
      assets: result.assets.map(summarizeAssetRecord),
      skippedFiles: result.skippedFiles
    });
  });
}

function parseRootPath(body: unknown) {
  if (!body || typeof body !== "object" || !("rootPath" in body)) return "";
  return String(body.rootPath || "").trim();
}

function parseLimit(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), 5000);
}

function summarizeMetadata(metadata: ExternalMediaMetadata | null) {
  if (!metadata) return null;
  return {
    status: metadata.status,
    mediaDisplayKey: metadata.mediaDisplayKey,
    matchConfidence: metadata.matchConfidence,
    matchReason: metadata.matchReason,
    providerCount: metadata.providerCount,
    primaryProvider: metadata.primaryProvider,
    hasTitle: Boolean(metadata.title),
    releaseDate: metadata.releaseDate,
    runtimeMinutes: metadata.runtimeMinutes,
    studio: metadata.studio,
    label: metadata.label,
    series: metadata.series,
    performers: metadata.performers.slice(0, 10),
    genres: metadata.genres.slice(0, 12),
    hasCoverImage: Boolean(metadata.coverImageUrl),
    hasPreviewVideo: Boolean(metadata.previewVideoUrl)
  };
}
