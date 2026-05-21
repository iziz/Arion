import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { externalMetadataSearchText, externalMetadataTags } from "../../shared/externalMetadata";
import type { AssetRecord, ExternalMediaMetadata, JobRecord, LocalIntelligence, TimelineSegment } from "../../shared/types";
import {
  extractRurugrabMediaKeyCandidatesForAsset,
  lookupRurugrabMetadataForAsset
} from "../metadata/rurugrab";
import { listAssets, saveAsset } from "../store";
import { importLocalMediaFiles, type LocalLibraryImportProgress, type LocalLibraryMediaFile } from "./localLibraryImport";

const execFileAsync = promisify(execFile);

export const defaultRurugrabLocalDbPath = "/Users/ishtar/.rurugrab/localdb.sqlite3";

export type RurugrabCatalogRootMapping = {
  from: string;
  to: string;
};

export type RurugrabCatalogLoadOptions = {
  dbPath?: string;
  catalogName?: string;
  limit?: number;
  rootMappings?: RurugrabCatalogRootMapping[];
  onlyAccessible?: boolean;
};

export type RurugrabCatalogImportOptions = RurugrabCatalogLoadOptions & {
  indexId: string;
  metadataOnly?: boolean;
  queueJobs?: boolean;
  onProgress?: (event: LocalLibraryImportProgress) => void;
};

export type RurugrabCatalogFile = LocalLibraryMediaFile & {
  catalogName: string;
  originalPath: string;
  rootPath: string;
  relPath: string;
  extension: string;
  accessible: boolean;
};

export type RurugrabCatalogPreviewItem = RurugrabCatalogFile & {
  candidates: Array<{ mediaDisplayKey: string; confidence: number; evidence: string }>;
  metadata: ExternalMediaMetadata | null;
};

export type RurugrabCatalogRow = {
  catalog_name: string;
  root_path: string;
  rel_path: string;
  full_path: string;
  file_name: string;
  extension: string;
  size: number;
};

const videoExtensions = [
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
  "m2ts",
  "mts"
];

export async function loadRurugrabCatalogFiles(options: RurugrabCatalogLoadOptions = {}) {
  const rows = await queryRurugrabCatalogRows(options);
  const files = rows.map((row) => rurugrabCatalogRowToMediaFile(row, options.rootMappings ?? []));
  return options.onlyAccessible ? files.filter((file) => file.accessible) : files;
}

export async function previewRurugrabCatalog(options: RurugrabCatalogLoadOptions = {}): Promise<RurugrabCatalogPreviewItem[]> {
  const files = await loadRurugrabCatalogFiles(options);
  const preview: RurugrabCatalogPreviewItem[] = [];
  for (const file of files) {
    const probe = assetMetadataProbe(file);
    preview.push({
      ...file,
      candidates: extractRurugrabMediaKeyCandidatesForAsset(probe).map((candidate) => ({
        mediaDisplayKey: candidate.mediaDisplayKey,
        confidence: candidate.confidence,
        evidence: candidate.evidence
      })),
      metadata: await lookupRurugrabMetadataForAsset(probe)
    });
  }
  return preview;
}

export async function importRurugrabCatalog(options: RurugrabCatalogImportOptions) {
  const files = await loadRurugrabCatalogFiles({ ...options, onlyAccessible: false });
  if (options.metadataOnly) {
    return importRurugrabCatalogMetadataOnly(options, files);
  }
  const inaccessible = files.filter((file) => !file.accessible);
  const accessible = files.filter((file) => file.accessible);
  const result = await importLocalMediaFiles({
    rootPath: catalogRootLabel(options),
    indexId: options.indexId,
    files: accessible,
    queueJobs: options.queueJobs,
    onProgress: options.onProgress
  });
  return {
    ...result,
    scanned: files.length,
    skipped: result.skipped + inaccessible.length,
    skippedFiles: [
      ...inaccessible.map((file) => ({
        path: file.originalPath,
        reason: "catalog path is not accessible; provide --map-root for the mounted volume"
      })),
      ...result.skippedFiles
    ],
    catalog: {
      dbPath: resolveRurugrabLocalDbPath(options.dbPath),
      catalogName: options.catalogName ?? null,
      accessible: accessible.length,
      inaccessible: inaccessible.length
    }
  };
}

export async function importRurugrabCatalogMetadataOnly(options: RurugrabCatalogImportOptions, files?: RurugrabCatalogFile[]) {
  const catalogFiles = files ?? (await loadRurugrabCatalogFiles({ ...options, onlyAccessible: false }));
  const existingAssets = await listAssets(options.indexId);
  const existingSourcePaths = new Set(existingAssets.map((asset) => asset.importSource?.path).filter(Boolean) as string[]);
  const existingMediaKeys = new Set(
    existingAssets
      .flatMap((asset) => [asset.externalMetadata?.rurugrab?.mediaKeyNorm, asset.externalMetadata?.rurugrab?.mediaDisplayKey])
      .filter(Boolean)
      .map((value) => String(value).toLowerCase())
  );
  const result = {
    rootPath: catalogRootLabel(options),
    indexId: options.indexId,
    scanned: catalogFiles.length,
    imported: 0,
    skipped: 0,
    jobs: [] as JobRecord[],
    assets: [] as AssetRecord[],
    skippedFiles: [] as Array<{ path: string; reason: string }>,
    catalog: {
      dbPath: resolveRurugrabLocalDbPath(options.dbPath),
      catalogName: options.catalogName ?? null,
      accessible: catalogFiles.filter((file) => file.accessible).length,
      inaccessible: catalogFiles.filter((file) => !file.accessible).length,
      metadataOnly: true
    }
  };

  for (const file of catalogFiles) {
    if (existingSourcePaths.has(file.originalPath)) {
      result.skipped += 1;
      result.skippedFiles.push({ path: file.originalPath, reason: "catalog path already imported" });
      options.onProgress?.({ phase: "skip", path: file.originalPath, message: "catalog path already imported" });
      continue;
    }
    options.onProgress?.({ phase: "import", path: file.originalPath, message: "Resolving Rurugrab metadata." });
    const now = new Date().toISOString();
    const metadata = await lookupRurugrabMetadataForAsset(assetMetadataProbe(file), now);
    const mediaKey = metadata?.mediaKeyNorm ?? metadata?.mediaDisplayKey ?? null;
    if (mediaKey && existingMediaKeys.has(mediaKey.toLowerCase())) {
      result.skipped += 1;
      result.skippedFiles.push({ path: file.originalPath, reason: `catalog metadata already imported: ${mediaKey}` });
      options.onProgress?.({ phase: "skip", path: file.originalPath, message: `catalog metadata already imported: ${mediaKey}` });
      continue;
    }
    const asset = buildMetadataOnlyAsset(file, options.indexId, metadata, now);
    await saveAsset(asset);
    result.imported += 1;
    result.assets.push(asset);
    existingSourcePaths.add(file.originalPath);
    if (mediaKey) existingMediaKeys.add(mediaKey.toLowerCase());
  }

  options.onProgress?.({ phase: "done", message: `Imported ${result.imported} metadata-only catalog records and skipped ${result.skipped}.` });
  return result;
}

export function parseRurugrabRootMapping(value: string): RurugrabCatalogRootMapping {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`Invalid --map-root value: ${value}. Expected FROM=TO.`);
  }
  return {
    from: value.slice(0, separatorIndex),
    to: value.slice(separatorIndex + 1)
  };
}

export function resolveRurugrabCatalogPath(originalPath: string, mappings: RurugrabCatalogRootMapping[]) {
  for (const mapping of mappings) {
    if (!pathStartsWithCatalogRoot(originalPath, mapping.from)) continue;
    const rest = originalPath.slice(mapping.from.length).replace(/^[\\/]+/, "");
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    return path.resolve(mapping.to, ...parts);
  }
  return originalPath;
}

export function rurugrabCatalogRowToMediaFile(row: RurugrabCatalogRow, mappings: RurugrabCatalogRootMapping[]): RurugrabCatalogFile {
  const mappedPath = resolveRurugrabCatalogPath(row.full_path, mappings);
  return {
    path: mappedPath,
    originalName: row.file_name,
    title: row.file_name.replace(/\.[^.]+$/, ""),
    size: Number(row.size ?? 0),
    catalogName: row.catalog_name,
    originalPath: row.full_path,
    rootPath: row.root_path,
    relPath: row.rel_path,
    extension: row.extension,
    accessible: existsSync(mappedPath)
  };
}

async function queryRurugrabCatalogRows(options: RurugrabCatalogLoadOptions) {
  const dbPath = resolveRurugrabLocalDbPath(options.dbPath);
  const sql = `
    select
      c.name as catalog_name,
      f.root_path,
      f.rel_path,
      f.full_path,
      f.file_name,
      f.extension,
      f.size
    from vvv_catalog_files f
    join vvv_catalogs c on c.id = f.catalog_id
    where lower(f.extension) in (${videoExtensions.map(sqlString).join(",")})
      ${options.catalogName ? `and c.name = ${sqlString(options.catalogName)}` : ""}
    order by c.name asc, f.full_path asc
    ${options.limit && Number.isFinite(options.limit) && options.limit > 0 ? `limit ${Math.floor(options.limit)}` : ""};
  `;
  const { stdout } = await execFileAsync("sqlite3", ["-json", sqliteUri(dbPath), sql], { maxBuffer: 32 * 1024 * 1024 });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout) as RurugrabCatalogRow[];
}

function resolveRurugrabLocalDbPath(dbPath: string | undefined) {
  return dbPath?.trim() || process.env.RURUGRAB_LOCAL_DB_PATH?.trim() || defaultRurugrabLocalDbPath;
}

function sqliteUri(dbPath: string) {
  if (dbPath.startsWith("file:")) return dbPath;
  return `file:${dbPath}?mode=ro&immutable=1`;
}

function pathStartsWithCatalogRoot(value: string, root: string) {
  const normalizedValue = value.replace(/\//g, "\\").toLowerCase();
  const normalizedRoot = root.replace(/\//g, "\\").toLowerCase();
  return normalizedValue === normalizedRoot || normalizedValue.startsWith(normalizedRoot.endsWith("\\") ? normalizedRoot : `${normalizedRoot}\\`);
}

function catalogRootLabel(options: RurugrabCatalogLoadOptions) {
  const catalog = options.catalogName ? `:${options.catalogName}` : "";
  return `rurugrab-catalog${catalog}`;
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

function buildMetadataOnlyAsset(file: RurugrabCatalogFile, indexId: string, metadata: ExternalMediaMetadata | null, now: string): AssetRecord {
  const assetId = randomUUID();
  const metadataText = metadata ? externalMetadataSearchText({ externalMetadata: { rurugrab: metadata } }) : "";
  const title = metadata?.title || metadata?.mediaDisplayKey || file.title;
  const summary = [
    "Metadata-only Rurugrab catalog record.",
    metadata?.mediaDisplayKey ? `Catalog key: ${metadata.mediaDisplayKey}.` : "",
    metadata?.studio ? `Studio: ${metadata.studio}.` : "",
    metadata?.series ? `Series: ${metadata.series}.` : "",
    metadata?.performers.length ? `Performers: ${metadata.performers.slice(0, 8).join(", ")}.` : "",
    metadata?.genres.length ? `Genres: ${metadata.genres.slice(0, 12).join(", ")}.` : "",
    "Source video is not imported yet; mount the catalog path and reimport or reindex for scene and appearance search."
  ].filter(Boolean).join(" ");
  const tags = metadata ? externalMetadataTags(metadata) : extractRurugrabMediaKeyCandidatesForAsset(assetMetadataProbe(file)).map((candidate) => candidate.mediaDisplayKey);
  const segment = metadataOnlySegment(assetId, title, summary, metadataText, tags);
  return {
    id: assetId,
    indexId,
    title,
    description: "Metadata-only Rurugrab catalog entry. No local video object has been imported for this asset.",
    originalName: file.originalName,
    storedName: `rurugrab-catalog/${file.catalogName}/${file.relPath}`,
    mimeType: "application/x-rurugrab-catalog",
    size: file.size,
    duration: metadata?.runtimeMinutes ? metadata.runtimeMinutes * 60 : null,
    width: null,
    height: null,
    status: "indexed",
    progress: 100,
    tags: uniqueClean(["metadata:rurugrab:catalog-only", ...tags]).slice(0, 48),
    summary,
    timeline: [segment],
    keyframes: [],
    externalMetadata: metadata ? { rurugrab: metadata } : undefined,
    importSource: {
      type: "rurugrab-catalog",
      path: file.originalPath,
      originalPath: file.originalPath,
      mappedPath: file.accessible ? file.path : null,
      catalogName: file.catalogName,
      metadataOnly: true,
      importedAt: now
    },
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "rurugrab-catalog",
      objectKey: file.originalPath,
      checksum: null,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    },
    intelligence: {
      ...emptyIntelligence(),
      modelTrace: [
        "metadata:rurugrab:catalog-only",
        metadata?.status === "matched"
          ? `metadata:rurugrab:matched:${metadata.mediaDisplayKey ?? metadata.mediaKeyNorm ?? "unknown"}:providers=${metadata.providerCount}`
          : metadata
            ? `metadata:rurugrab:${metadata.status}:${metadata.matchReason}`
            : "metadata:rurugrab:not_found:no product-code metadata"
      ]
    },
    error: null,
    createdAt: now,
    updatedAt: now
  };
}

function metadataOnlySegment(assetId: string, title: string, summary: string, metadataText: string, tags: string[]): TimelineSegment {
  return {
    id: `${assetId}-catalog-metadata`,
    start: 0,
    end: 0,
    label: title,
    transcript: metadataText,
    summary,
    tags: uniqueClean(["metadata:rurugrab", "metadata:catalog-only", ...tags]).slice(0, 48),
    modalities: ["metadata"],
    confidence: metadataText ? 0.86 : 0.52,
    embedding: [],
    thumbnailPath: null,
    sources: ["metadata"]
  };
}

function emptyIntelligence(): LocalIntelligence {
  return {
    audio: { extractedPath: null, vad: { available: false, provider: "none", error: null }, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
    asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
    diarization: { provider: "none", speakers: [], segments: [], error: null },
    ocr: { tokens: [], confidence: 0, frames: [] },
    visual: { available: false, labels: ["metadata-only"], dominantColor: "#000000", brightness: 0, motionScore: 0, error: null },
    modelTrace: []
  };
}

function uniqueClean(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value?.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
