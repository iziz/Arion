import "../server/env";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { publishQueueOutbox } from "../server/services/queueOutboxPublisher";
import { closeRealtimeEvents } from "../server/services/realtimeEvents";
import { importLocalLibrary, previewLocalLibrary } from "../server/services/localLibraryImport";
import { createDefaultIndex, ensureStore, getIndex, listIndexes, newId, saveIndex } from "../server/store";
import type { ExternalMediaMetadata, IndexRecord } from "../shared/types";

type CliOptions = {
  rootPath: string | null;
  preview: boolean;
  indexId: string | null;
  indexName: string | null;
  limit: number | undefined;
  queueJobs: boolean;
  dispatchQueue: boolean;
};

const defaultIndexName = "Local video library";

try {
  const options = parseArgs(process.argv.slice(2));
  if (!options.rootPath) throw new Error(`Local library path is required.\n${usage()}`);

  if (options.preview) {
    const preview = await previewLocalLibrary(options.rootPath, options.limit ?? 100);
    console.log(
      JSON.stringify(
        {
          ok: true,
          rootPath: options.rootPath,
          files: preview.map((item) => ({
            path: item.path,
            originalName: item.originalName,
            size: item.size,
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
    const result = await importLocalLibrary({
      rootPath: options.rootPath,
      indexId: index.id,
      limit: options.limit,
      queueJobs: options.queueJobs,
      onProgress: (event) => {
        const subject = event.path ? ` ${event.path}` : "";
        console.error(`[library-import:${event.phase}]${subject} ${event.message}`);
      }
    });
    const queueDispatch = options.dispatchQueue && result.jobs.length > 0 ? await publishQueueOutbox("asset-job", Math.max(10, result.jobs.length)) : null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          rootPath: result.rootPath,
          indexId: result.indexId,
          scanned: result.scanned,
          imported: result.imported,
          skipped: result.skipped,
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
  const message = error instanceof Error ? error.message : "Local library import failed";
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exitCode = 1;
} finally {
  await closeRealtimeEvents();
  if (isPostgresEnabled()) await closePostgresStore();
}

async function resolveTargetIndex(options: CliOptions): Promise<IndexRecord> {
  if (options.indexId) {
    const index = await getIndex(options.indexId);
    if (!index) throw new Error(`Index not found: ${options.indexId}`);
    return index;
  }

  const indexes = await listIndexes();
  if (options.indexName) {
    const existing = indexes.find((index) => index.name === options.indexName);
    if (existing) return existing;
    const now = new Date().toISOString();
    const index: IndexRecord = {
      ...createDefaultIndex(now),
      id: newId(),
      name: options.indexName,
      description: "Local library index for imported video assets.",
      createdAt: now,
      updatedAt: now
    };
    await saveIndex(index);
    return index;
  }

  const existingDefault = indexes.find((index) => index.id === "default-index") ?? indexes.find((index) => index.name === defaultIndexName);
  if (existingDefault) return existingDefault;

  const now = new Date().toISOString();
  const index: IndexRecord = {
    ...createDefaultIndex(now),
    name: defaultIndexName,
    description: "Local library index for imported video assets.",
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
    rootPath: null,
    preview: false,
    indexId: null,
    indexName: null,
    limit: undefined,
    queueJobs: true,
    dispatchQueue: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preview") {
      options.preview = true;
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
    if (arg.startsWith("--path=")) {
      options.rootPath = valueAfterEquals(arg);
      continue;
    }
    if (arg === "--path") {
      options.rootPath = requiredNext(argv, i, "--path");
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
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    if (!options.rootPath) {
      options.rootPath = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
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
    "  npm run library:preview -- --path /path/to/videos --limit 25",
    "  npm run library:import -- --path /path/to/videos --indexName \"Local video library\"",
    "Options:",
    "  --preview            Scan and report candidate metadata without importing.",
    "  --path <path>         Directory or single media file to scan.",
    "  --indexId <id>       Import into an existing index.",
    "  --indexName <name>   Use or create an index by name.",
    "  --limit <n>          Limit scanned media files.",
    "  --no-queue           Import assets without queueing indexing jobs.",
    "  --no-dispatch        Keep queued jobs in the outbox without publishing to Redis."
  ].join("\n");
}
