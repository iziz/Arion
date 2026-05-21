import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { checksumLocalFile, putLocalFileObject } from "../localObjectStorage";
import {
  extractRurugrabMediaKeyCandidatesForAsset,
  lookupRurugrabMetadataForAsset,
  mergeRurugrabMetadataIntoAsset
} from "../metadata/rurugrab";
import { getIndex, listAssets, saveVideo } from "../store";
import { createQueuedAssetJob } from "./jobState";
import { recordEvent } from "./events";
import type { AssetRecord, ExternalMediaMetadata, JobRecord, LocalIntelligence } from "../../shared/types";

export type LocalLibraryMediaFile = {
  path: string;
  originalName: string;
  title: string;
  size: number;
};

export type LocalLibraryPreviewItem = LocalLibraryMediaFile & {
  candidates: Array<{ mediaDisplayKey: string; confidence: number; evidence: string }>;
  metadata: ExternalMediaMetadata | null;
};

export type LocalLibraryImportOptions = {
  rootPath: string;
  indexId: string;
  limit?: number;
  queueJobs?: boolean;
  onProgress?: (event: LocalLibraryImportProgress) => void;
};

export type LocalLibraryImportFilesOptions = Omit<LocalLibraryImportOptions, "limit"> & {
  files: LocalLibraryMediaFile[];
};

export type LocalLibraryImportProgress = {
  phase: "scan" | "preview" | "import" | "skip" | "done";
  path?: string;
  message: string;
};

export type LocalLibraryImportResult = {
  rootPath: string;
  indexId: string;
  scanned: number;
  imported: number;
  skipped: number;
  jobs: JobRecord[];
  assets: AssetRecord[];
  skippedFiles: Array<{ path: string; reason: string }>;
};

const supportedMediaExtensions = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".wmv",
  ".flv",
  ".mpg",
  ".mpeg",
  ".m2ts",
  ".mts"
]);

export function isSupportedLocalLibraryMediaPath(filePath: string) {
  return supportedMediaExtensions.has(path.extname(filePath).toLowerCase());
}

export async function scanLocalLibrary(rootPath: string, limit = Number.POSITIVE_INFINITY) {
  const root = path.resolve(rootPath);
  const files: LocalLibraryMediaFile[] = [];
  const rootInfo = await stat(root);
  if (rootInfo.isFile()) {
    if (isSupportedLocalLibraryMediaPath(root)) {
      files.push({
        path: root,
        originalName: path.basename(root),
        title: path.basename(root).replace(/\.[^.]+$/, ""),
        size: rootInfo.size
      });
    }
    return files;
  }
  await walk(root, files, limit);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function previewLocalLibrary(rootPath: string, limit = 100): Promise<LocalLibraryPreviewItem[]> {
  const files = await scanLocalLibrary(rootPath, limit);
  const preview: LocalLibraryPreviewItem[] = [];
  for (const file of files) {
    const assetLike = assetMetadataProbe(file);
    const candidates = extractRurugrabMediaKeyCandidatesForAsset(assetLike).map((candidate) => ({
      mediaDisplayKey: candidate.mediaDisplayKey,
      confidence: candidate.confidence,
      evidence: candidate.evidence
    }));
    preview.push({
      ...file,
      candidates,
      metadata: await lookupRurugrabMetadataForAsset(assetLike)
    });
  }
  return preview;
}

export async function importLocalLibrary(options: LocalLibraryImportOptions): Promise<LocalLibraryImportResult> {
  const files = await scanLocalLibrary(options.rootPath, options.limit ?? Number.POSITIVE_INFINITY);
  options.onProgress?.({ phase: "scan", message: `Scanned ${files.length} media files.` });
  return importLocalMediaFiles({
    rootPath: options.rootPath,
    indexId: options.indexId,
    files,
    queueJobs: options.queueJobs,
    onProgress: options.onProgress
  });
}

export async function importLocalMediaFiles(options: LocalLibraryImportFilesOptions): Promise<LocalLibraryImportResult> {
  const index = await getIndex(options.indexId);
  if (!index) throw new Error(`Index not found: ${options.indexId}`);
  const queueJobs = options.queueJobs !== false;
  const files = options.files;
  const existingAssets = await listAssets(index.id);
  const existingSourcePaths = new Set(existingAssets.map((asset) => asset.importSource?.path).filter(Boolean) as string[]);
  const existingNameAndSize = new Set(existingAssets.map((asset) => `${asset.originalName}:${asset.size}`));
  const existingChecksums = new Set(existingAssets.map((asset) => asset.technicalMetadata.checksum).filter(Boolean) as string[]);
  const result: LocalLibraryImportResult = {
    rootPath: path.resolve(options.rootPath),
    indexId: index.id,
    scanned: files.length,
    imported: 0,
    skipped: 0,
    jobs: [],
    assets: [],
    skippedFiles: []
  };

  for (const file of files) {
    const duplicateReason = duplicateImportReason(file, existingSourcePaths, existingNameAndSize);
    if (duplicateReason) {
      result.skipped += 1;
      result.skippedFiles.push({ path: file.path, reason: duplicateReason });
      options.onProgress?.({ phase: "skip", path: file.path, message: duplicateReason });
      continue;
    }

    options.onProgress?.({ phase: "import", path: file.path, message: "Checking source checksum." });
    const checksum = await checksumLocalFile(file.path);
    if (existingChecksums.has(checksum)) {
      result.skipped += 1;
      result.skippedFiles.push({ path: file.path, reason: "matching checksum already imported" });
      options.onProgress?.({ phase: "skip", path: file.path, message: "matching checksum already imported" });
      continue;
    }

    options.onProgress?.({ phase: "import", path: file.path, message: "Copying media into local object storage." });
    const now = new Date().toISOString();
    const assetId = randomUUID();
    const stored = await putLocalFileObject(file.path, file.originalName, assetId, { checksum });
    const asset = await enrichImportedAsset({
      id: assetId,
      indexId: index.id,
      title: file.title,
      description: "",
      originalName: file.originalName,
      storedName: `${stored.provider}/${stored.bucket}/${stored.objectKey}`,
      mimeType: mimeTypeForPath(file.path),
      size: stored.size,
      duration: null,
      width: null,
      height: null,
      status: queueJobs ? "queued" : "uploaded",
      progress: queueJobs ? 5 : 0,
      tags: [],
      summary: "",
      timeline: [],
      keyframes: [],
      importSource: {
        type: "local-library",
        path: file.path,
        importedAt: now
      },
      technicalMetadata: {
        storageProvider: stored.provider,
        bucket: stored.bucket,
        objectKey: stored.objectKey,
        checksum: stored.checksum,
        frameRate: null,
        audioCodec: null,
        videoCodec: null
      },
      intelligence: emptyIntelligence(),
      error: null,
      createdAt: now,
      updatedAt: now
    });
    await saveVideo(asset);
    const job = queueJobs ? await createQueuedAssetJob("asset.index", index.id, asset.id) : null;
    await recordEvent("asset.uploaded", "Local library asset imported", {
      indexId: index.id,
      assetId: asset.id,
      jobId: job?.id ?? null,
      payload: { sourcePath: file.path }
    });
    result.imported += 1;
    result.assets.push(asset);
    if (job) result.jobs.push(job);
    existingSourcePaths.add(file.path);
    existingNameAndSize.add(`${asset.originalName}:${asset.size}`);
    existingChecksums.add(stored.checksum);
  }

  options.onProgress?.({ phase: "done", message: `Imported ${result.imported} files and skipped ${result.skipped}.` });
  return result;
}

async function enrichImportedAsset(asset: AssetRecord) {
  const metadata = await lookupRurugrabMetadataForAsset(asset, asset.createdAt);
  if (!metadata) return asset;
  return mergeRurugrabMetadataIntoAsset(asset, metadata, asset.createdAt);
}

function duplicateImportReason(file: LocalLibraryMediaFile, sourcePaths: Set<string>, nameAndSize: Set<string>) {
  if (sourcePaths.has(file.path)) return "source path already imported";
  if (nameAndSize.has(`${file.originalName}:${file.size}`)) return "matching filename and size already imported";
  return null;
}

function assetMetadataProbe(file: LocalLibraryMediaFile) {
  return {
    title: file.title,
    description: "",
    originalName: file.originalName,
    storedName: file.path,
    summary: "",
    tags: []
  };
}

async function walk(directory: string, files: LocalLibraryMediaFile[], limit: number) {
  if (files.length >= limit) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= limit) return;
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files, limit);
      continue;
    }
    if (!entry.isFile() || !isSupportedLocalLibraryMediaPath(fullPath)) continue;
    const info = await stat(fullPath);
    files.push({
      path: fullPath,
      originalName: entry.name,
      title: entry.name.replace(/\.[^.]+$/, ""),
      size: info.size
    });
  }
}

function mimeTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".avi") return "video/x-msvideo";
  return "video/mp4";
}

function emptyIntelligence(): LocalIntelligence {
  return {
    audio: { extractedPath: null, vad: { available: false, provider: "none", error: null }, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
    asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
    diarization: { provider: "none", speakers: [], segments: [], error: null },
    ocr: { tokens: [], confidence: 0, frames: [] },
    visual: { available: false, labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0, error: null },
    modelTrace: []
  };
}
