import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExternalMediaMetadata } from "../../shared/types";
import {
  extractRurugrabMediaKeyCandidatesForAsset,
  lookupRurugrabMetadataForAsset
} from "../metadata/rurugrab";
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

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
