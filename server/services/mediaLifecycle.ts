import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetRecord } from "../../shared/types";
import { getObjectPath, getPublicMediaRoot } from "../localObjectStorage";
import { logJson } from "../observability";

type UploadFileRef = {
  path?: string;
};

export async function cleanupTempUploads(uploadDir: string, maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs;
  const entries = await readdir(uploadDir, { withFileTypes: true }).catch(() => []);
  let scanned = 0;
  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    scanned += 1;
    const filePath = path.join(uploadDir, entry.name);
    try {
      const info = await stat(filePath);
      if (info.mtimeMs > cutoff) continue;
      await rm(filePath, { force: true });
      removed += 1;
    } catch (error) {
      failed += 1;
      logJson("warn", "media.tmp.cleanup_failed", error instanceof Error ? error.message : "Failed to remove temp upload", { filePath });
    }
  }
  if (removed > 0 || failed > 0) {
    logJson("info", "media.tmp.cleaned", "Cleaned stale upload temp files", { uploadDir, scanned, removed, failed, maxAgeMs });
  }
  return { scanned, removed, failed };
}

export async function discardUploadTempFile(file: UploadFileRef | null | undefined) {
  if (!file?.path) return false;
  try {
    await rm(file.path, { force: true });
    return true;
  } catch (error) {
    logJson("warn", "media.tmp.discard_failed", error instanceof Error ? error.message : "Failed to discard upload temp file", { filePath: file.path });
    return false;
  }
}

export async function pruneGeneratedAssetMedia(asset: AssetRecord) {
  const mediaRoot = getPublicMediaRoot();
  const generatedRoot = path.join(mediaRoot, "generated", "assets", asset.id);
  const files = await listFiles(generatedRoot);
  if (files.length === 0) return { scanned: 0, removed: 0, kept: 0 };

  const references = getReferencedGeneratedFiles(asset, mediaRoot, generatedRoot);
  let removed = 0;
  for (const filePath of files) {
    if (references.has(filePath)) continue;
    await rm(filePath, { force: true });
    removed += 1;
  }
  await pruneEmptyDirectories(generatedRoot);
  if (removed > 0) {
    logJson("info", "media.generated.pruned", "Pruned unreferenced generated asset media", {
      assetId: asset.id,
      scanned: files.length,
      removed,
      kept: files.length - removed
    });
  }
  return { scanned: files.length, removed, kept: files.length - removed };
}

export async function deleteAssetMedia(asset: AssetRecord) {
  const mediaRoot = getPublicMediaRoot();
  const sourceDir = path.dirname(getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey));
  const generatedRoot = path.join(mediaRoot, "generated", "assets", asset.id);
  const sourceFiles = await listFiles(sourceDir);
  const generatedFiles = await listFiles(generatedRoot);
  await rm(sourceDir, { recursive: true, force: true });
  await rm(generatedRoot, { recursive: true, force: true });
  return {
    sourceFiles: sourceFiles.length,
    generatedFiles: generatedFiles.length,
    removedFiles: sourceFiles.length + generatedFiles.length
  };
}

function getReferencedGeneratedFiles(asset: AssetRecord, mediaRoot: string, generatedRoot: string) {
  const values = [
    asset.intelligence.audio.extractedPath,
    ...asset.intelligence.ocr.frames.map((frame) => frame.framePath),
    ...asset.keyframes.map((keyframe) => keyframe.path),
    ...asset.timeline.flatMap((segment) => [
      segment.thumbnailPath,
      segment.sceneData?.image.thumbnailPath,
      segment.sceneData?.image.framePath
    ])
  ];
  const references = new Set<string>();
  for (const value of values) {
    const absolute = resolvePublicMediaPath(value, mediaRoot);
    if (!absolute) continue;
    if (absolute === generatedRoot || absolute.startsWith(`${generatedRoot}${path.sep}`)) {
      references.add(absolute);
    }
  }
  return references;
}

function resolvePublicMediaPath(value: string | null | undefined, mediaRoot: string) {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return null;
  return path.resolve(mediaRoot, value);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function pruneEmptyDirectories(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirectories(path.join(dir, entry.name));
  }
  const remaining = await readdir(dir).catch(() => []);
  if (remaining.length === 0) await rm(dir, { recursive: true, force: true });
}
