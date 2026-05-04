import "../server/env";
import { stat } from "node:fs/promises";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { getObjectPath } from "../server/localObjectStorage";
import { rebuildKnowledgeVectorStore } from "../server/localKnowledgeVectorStore";
import { buildSportsKnowledgeDocuments } from "../server/sportsKnowledgeDocuments";
import { getAsset, getJob, listAssets, listJobs } from "../server/store";
import { createJob, updateAsset } from "../server/services/jobState";
import { runIndexingJob } from "../server/workflows/indexingWorkflow";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
);

const rebuildAllAssets = args.get("all") === "true";
const skipAssets = args.get("skipAssets") === "true";
const skipKnowledge = args.get("skipKnowledge") === "true";
const batchSize = numberArg("batchSize", 128);
const startedAt = Date.now();

const summary = {
  assets: {
    selected: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0
  },
  knowledge: {
    skipped: skipKnowledge,
    documents: 0,
    vectors: 0,
    storage: "none" as "none" | "local" | "postgres"
  }
};

if (!skipAssets) {
  const allAssets = await listAssets();
  const activeJobs = (await listJobs()).filter((job) => job.assetId && (job.status === "queued" || job.status === "running"));
  const activeAssetIds = new Set(activeJobs.map((job) => job.assetId));
  const assets = allAssets.filter((asset) => rebuildAllAssets || asset.status === "indexed");
  summary.assets.selected = assets.length;
  console.error(`[indexes-rebuild] asset reindex selected ${assets.length}/${allAssets.length} assets${rebuildAllAssets ? " (all)" : " (indexed only)"}`);

  for (const [index, asset] of assets.entries()) {
    const prefix = `[indexes-rebuild] asset ${index + 1}/${assets.length} ${asset.id}`;
    if (activeAssetIds.has(asset.id)) {
      summary.assets.skipped += 1;
      console.error(`${prefix} skipped: active job already exists`);
      continue;
    }

    const sourcePath = getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey);
    try {
      await stat(sourcePath);
    } catch {
      summary.assets.skipped += 1;
      console.error(`${prefix} skipped: source file not found at ${sourcePath}`);
      continue;
    }

    const job = await createJob("asset.reindex", asset.indexId, asset.id);
    await updateAsset(asset.id, { status: "queued", progress: 3, error: null });
    console.error(`${prefix} reindex started job=${job.id}`);
    await runIndexingJob(job.id, asset.id, sourcePath);
    const completedJob = await getJob(job.id);
    const refreshed = await getAsset(asset.id);
    if (completedJob?.status === "succeeded" && refreshed?.status === "indexed") {
      summary.assets.succeeded += 1;
      console.error(`${prefix} reindex succeeded`);
    } else {
      summary.assets.failed += 1;
      console.error(`${prefix} reindex failed: ${completedJob?.error ?? refreshed?.error ?? "unknown error"}`);
    }
  }
} else {
  summary.assets.skipped = (await listAssets()).length;
  console.error("[indexes-rebuild] asset reindex skipped");
}

if (!skipKnowledge) {
  const documents = buildSportsKnowledgeDocuments(undefined);
  summary.knowledge.documents = documents.length;
  console.error(`[indexes-rebuild] knowledge vector rebuild started (${documents.length} documents)`);
  let lastLogged = 0;
  const result = await rebuildKnowledgeVectorStore(documents, {
    batchSize,
    onProgress: ({ embedded, total }) => {
      if (embedded - lastLogged >= batchSize * 5 || embedded === total) {
        lastLogged = embedded;
        console.error(`[indexes-rebuild] knowledge ${embedded}/${total}`);
      }
    }
  });
  summary.knowledge.vectors = result.count;
  summary.knowledge.storage = result.storage;
  console.error(`[indexes-rebuild] knowledge vector rebuild complete (${result.count} vectors, ${result.storage})`);
}

console.log(
  JSON.stringify(
    {
      ok: summary.assets.failed === 0,
      ...summary,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000)
    },
    null,
    2
  )
);

if (isPostgresEnabled()) await closePostgresStore();

if (summary.assets.failed > 0) process.exitCode = 1;

function numberArg(name: string, fallback: number) {
  const value = args.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}
