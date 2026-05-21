import "../server/env";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { publishQueueOutbox } from "../server/services/queueOutboxPublisher";
import {
  importRurugrabCatalog,
  parseRurugrabRootMapping,
  previewRurugrabCatalog,
  type RurugrabCatalogRootMapping
} from "../server/services/rurugrabCatalogImport";
import { createDefaultIndex, ensureStore, getIndex, listIndexes, newId, saveIndex } from "../server/store";
import type { ExternalMediaMetadata, IndexRecord } from "../shared/types";

type CliOptions = {
  preview: boolean;
  dbPath: string | null;
  catalogName: string | null;
  indexId: string | null;
  indexName: string | null;
  limit: number | undefined;
  rootMappings: RurugrabCatalogRootMapping[];
  onlyAccessible: boolean;
  queueJobs: boolean;
  dispatchQueue: boolean;
};

const defaultIndexName = "Rurugrab catalog";

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.preview) {
    const preview = await previewRurugrabCatalog({
      dbPath: options.dbPath ?? undefined,
      catalogName: options.catalogName ?? undefined,
      limit: options.limit ?? 50,
      rootMappings: options.rootMappings,
      onlyAccessible: options.onlyAccessible
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          scanned: preview.length,
          accessible: preview.filter((item) => item.accessible).length,
          inaccessible: preview.filter((item) => !item.accessible).length,
          items: preview.map((item) => ({
            catalogName: item.catalogName,
            path: item.path,
            originalPath: item.originalPath,
            originalName: item.originalName,
            size: item.size,
            accessible: item.accessible,
            candidates: item.candidates,
            metadata: summarizeMetadata(item.metadata)
          }))
        },
        null,
        2
      )
    );
  } else {
    await ensureStore();
    const index = await resolveTargetIndex(options);
    const result = await importRurugrabCatalog({
      dbPath: options.dbPath ?? undefined,
      catalogName: options.catalogName ?? undefined,
      limit: options.limit,
      rootMappings: options.rootMappings,
      indexId: index.id,
      queueJobs: options.queueJobs,
      onProgress: (event) => {
        const subject = event.path ? ` ${event.path}` : "";
        console.error(`[rurugrab-catalog:${event.phase}]${subject} ${event.message}`);
      }
    });
    const queueDispatch = options.dispatchQueue && result.jobs.length > 0 ? await publishQueueOutbox("asset-job", Math.max(10, result.jobs.length)) : null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          indexId: result.indexId,
          scanned: result.scanned,
          imported: result.imported,
          skipped: result.skipped,
          catalog: result.catalog,
          jobs: result.jobs.map((job) => ({ id: job.id, assetId: job.assetId, status: job.status })),
          queueDispatch,
          assets: result.assets.map((asset) => ({
            id: asset.id,
            title: asset.title,
            originalName: asset.originalName,
            status: asset.status,
            metadata: summarizeMetadata(asset.externalMetadata?.rurugrab ?? null)
          })),
          skippedFiles: result.skippedFiles
        },
        null,
        2
      )
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Rurugrab catalog import failed";
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
} finally {
  if (isPostgresEnabled()) await closePostgresStore();
}

async function resolveTargetIndex(options: CliOptions): Promise<IndexRecord> {
  if (options.indexId) {
    const index = await getIndex(options.indexId);
    if (!index) throw new Error(`Index not found: ${options.indexId}`);
    return index;
  }

  const indexes = await listIndexes();
  const name = options.indexName ?? defaultIndexName;
  const existing = indexes.find((index) => index.name === name);
  if (existing) return existing;

  const now = new Date().toISOString();
  const index: IndexRecord = {
    ...createDefaultIndex(now),
    id: newId(),
    name,
    description: "Local Rurugrab catalog import index for owned media assets.",
    createdAt: now,
    updatedAt: now
  };
  await saveIndex(index);
  return index;
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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    preview: false,
    dbPath: null,
    catalogName: null,
    indexId: null,
    indexName: null,
    limit: undefined,
    rootMappings: [],
    onlyAccessible: false,
    queueJobs: true,
    dispatchQueue: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preview") {
      options.preview = true;
      continue;
    }
    if (arg === "--only-accessible") {
      options.onlyAccessible = true;
      continue;
    }
    if (arg === "--no-queue" || arg === "--queue=false") {
      options.queueJobs = false;
      continue;
    }
    if (arg === "--no-dispatch" || arg === "--dispatch=false") {
      options.dispatchQueue = false;
      continue;
    }
    if (arg.startsWith("--dbPath=")) {
      options.dbPath = valueAfterEquals(arg);
      continue;
    }
    if (arg === "--dbPath") {
      options.dbPath = requiredNext(argv, i, "--dbPath");
      i += 1;
      continue;
    }
    if (arg.startsWith("--catalogName=")) {
      options.catalogName = valueAfterEquals(arg);
      continue;
    }
    if (arg === "--catalogName") {
      options.catalogName = requiredNext(argv, i, "--catalogName");
      i += 1;
      continue;
    }
    if (arg.startsWith("--indexId=")) {
      options.indexId = valueAfterEquals(arg);
      continue;
    }
    if (arg === "--indexId") {
      options.indexId = requiredNext(argv, i, "--indexId");
      i += 1;
      continue;
    }
    if (arg.startsWith("--indexName=")) {
      options.indexName = valueAfterEquals(arg);
      continue;
    }
    if (arg === "--indexName") {
      options.indexName = requiredNext(argv, i, "--indexName");
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = parseLimit(valueAfterEquals(arg));
      continue;
    }
    if (arg === "--limit") {
      options.limit = parseLimit(requiredNext(argv, i, "--limit"));
      i += 1;
      continue;
    }
    if (arg.startsWith("--map-root=")) {
      options.rootMappings.push(parseRurugrabRootMapping(valueAfterEquals(arg)));
      continue;
    }
    if (arg === "--map-root") {
      options.rootMappings.push(parseRurugrabRootMapping(requiredNext(argv, i, "--map-root")));
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}\n${usage()}`);
  }

  if (options.preview) {
    options.queueJobs = false;
    options.dispatchQueue = false;
  }
  return options;
}

function valueAfterEquals(arg: string) {
  const value = arg.slice(arg.indexOf("=") + 1).trim();
  if (!value) throw new Error(`Missing value for ${arg.slice(0, arg.indexOf("="))}`);
  return value;
}

function requiredNext(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

function parseLimit(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Invalid --limit value: ${value}`);
  return Math.floor(parsed);
}

function usage() {
  return [
    "Usage:",
    "  npm run rurugrab:catalog:preview -- --limit 25",
    "  npm run rurugrab:catalog:preview -- --catalogName \"AV8192-05.AV\" --map-root 'G:\\\\=/Volumes/AV/G'",
    "  npm run rurugrab:catalog:import -- --catalogName \"AV8192-05.AV\" --map-root 'G:\\\\=/Volumes/AV/G' --indexName \"Rurugrab catalog\"",
    "Options:",
    "  --preview                 Report catalog files and metadata matches without importing.",
    "  --dbPath <path>            Rurugrab localdb.sqlite3 path. Defaults to RURUGRAB_LOCAL_DB_PATH or ~/.rurugrab/localdb.sqlite3.",
    "  --catalogName <name>       Limit to one VVV catalog.",
    "  --map-root <FROM=TO>       Map an offline catalog root such as G:\\\\ to a mounted macOS path.",
    "  --only-accessible          In preview mode, show only files accessible after root mapping.",
    "  --indexId <id>             Import into an existing index.",
    "  --indexName <name>         Use or create an index by name.",
    "  --limit <n>                Limit scanned catalog rows.",
    "  --no-queue                Import assets without queueing indexing jobs.",
    "  --no-dispatch             Keep queued jobs in the outbox without publishing to Redis."
  ].join("\n");
}
