import "../server/env";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ensurePostgresStore,
  saveAsset,
  saveBilling,
  closePostgresStore,
  saveEvent,
  saveIndex,
  saveJob,
  saveWebhook,
  upsertAssetVectors
} from "../server/postgresStore";
import type { AssetRecord, BillingRecord, EventRecord, IndexRecord, JobRecord, UserRecord, WebhookRecord } from "../shared/types";

type FileDatabase = {
  indexes?: IndexRecord[];
  assets?: AssetRecord[];
  videos?: AssetRecord[];
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
const raw = JSON.parse(await readFile(dbPath, "utf8")) as FileDatabase;
await ensurePostgresStore();

for (const index of raw.indexes ?? []) await saveIndex(index);
for (const asset of raw.assets ?? raw.videos ?? []) {
  await saveAsset(asset);
  if (asset.timeline?.length) await upsertAssetVectors(asset.indexId, asset.id, asset.timeline);
}
for (const job of raw.jobs ?? []) await saveJob(job);
for (const webhook of raw.webhooks ?? []) await saveWebhook(webhook);
for (const event of raw.events ?? []) await saveEvent(event);
for (const record of raw.billing ?? []) await saveBilling(record);

console.log(
  JSON.stringify(
    {
      ok: true,
      indexes: raw.indexes?.length ?? 0,
      assets: (raw.assets ?? raw.videos ?? []).length,
      jobs: raw.jobs?.length ?? 0,
      webhooks: raw.webhooks?.length ?? 0,
      events: raw.events?.length ?? 0,
      billing: raw.billing?.length ?? 0
    },
    null,
    2
  )
);
await closePostgresStore();
