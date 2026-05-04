import "../server/env";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ensurePostgresStore,
  saveAsset,
  saveBilling,
  closePostgresStore,
  rebuildKnowledgeVectorStore,
  rebuildVisualVectorStore,
  saveEvent,
  saveIndex,
  saveJob,
  saveWebhook,
  upsertAssetVectors
} from "../server/postgresStore";
import { rebuildTrackingStore } from "../server/trackingStore";
import type { VisualVectorRecord } from "../server/localVisualEmbeddingRuntime";
import type { SportsKnowledgeVectorRecord } from "../server/sportsKnowledgeDocuments";
import type { AssetRecord, BillingRecord, EventRecord, IndexRecord, JobRecord, UserRecord, WebhookRecord } from "../shared/types";

type FileDatabase = {
  indexes?: IndexRecord[];
  assets?: AssetRecord[];
  jobs?: JobRecord[];
  webhooks?: WebhookRecord[];
  events?: EventRecord[];
  users?: UserRecord[];
  billing?: BillingRecord[];
};

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Postgres migration.");
}

const dbPath = path.resolve(".data", "db.json");
const visualVectorPath = path.resolve(".data", "visual-vector-store.json");
const knowledgeVectorPath = path.resolve(".data", "knowledge-vector-store.json");
const raw = JSON.parse(await readFile(dbPath, "utf8")) as FileDatabase;
await ensurePostgresStore();

for (const index of raw.indexes ?? []) await saveIndex(index);
for (const asset of raw.assets ?? []) {
  await saveAsset(asset);
  if (asset.timeline?.length) await upsertAssetVectors(asset.indexId, asset.id, asset.timeline);
}
for (const job of raw.jobs ?? []) await saveJob(job);
for (const webhook of raw.webhooks ?? []) await saveWebhook(webhook);
for (const event of raw.events ?? []) await saveEvent(event);
for (const record of raw.billing ?? []) await saveBilling(record);
const visualVectors = await readOptionalJson<VisualVectorRecord[]>(visualVectorPath, []);
if (visualVectors.length > 0) await rebuildVisualVectorStore(visualVectors);
const knowledgeVectors = await readOptionalJson<SportsKnowledgeVectorRecord[]>(knowledgeVectorPath, []);
if (knowledgeVectors.length > 0) await rebuildKnowledgeVectorStore(knowledgeVectors);
const trackingRecords = await rebuildTrackingStore(raw.assets ?? []);

console.log(
  JSON.stringify(
    {
      ok: true,
      indexes: raw.indexes?.length ?? 0,
      assets: raw.assets?.length ?? 0,
      jobs: raw.jobs?.length ?? 0,
      webhooks: raw.webhooks?.length ?? 0,
      events: raw.events?.length ?? 0,
      billing: raw.billing?.length ?? 0,
      visualVectors: visualVectors.length,
      knowledgeVectors: knowledgeVectors.length,
      trackingRecords: trackingRecords.length
    },
    null,
    2
  )
);
await closePostgresStore();

async function readOptionalJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}
