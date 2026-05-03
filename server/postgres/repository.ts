import type {
  AssetRecord,
  BillingRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  UserRecord,
  WebhookRecord
} from "../../shared/types";
import { getPool } from "./connection";
import { ensurePostgresStore } from "./schema";

export async function listIndexes() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_indexes order by created_at asc");
  return result.rows.map((row) => row.data as IndexRecord);
}

export async function getIndex(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_indexes where id = $1", [id]);
  return (result.rows[0]?.data as IndexRecord | undefined) ?? null;
}

export async function saveIndex(index: IndexRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_indexes(id, data, created_at, updated_at)
     values ($1, $2, $3, $4)
     on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at`,
    [index.id, index, index.createdAt, index.updatedAt]
  );
  return index;
}

export async function listAssets(indexId?: string) {
  await ensurePostgresStore();
  const result = indexId
    ? await getPool().query("select data from app_assets where index_id = $1 order by created_at desc", [indexId])
    : await getPool().query("select data from app_assets order by created_at desc");
  return result.rows.map((row) => row.data as AssetRecord);
}

export async function getAsset(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_assets where id = $1", [id]);
  return (result.rows[0]?.data as AssetRecord | undefined) ?? null;
}

export async function saveAsset(asset: AssetRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_assets(id, index_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set index_id = excluded.index_id, data = excluded.data, updated_at = excluded.updated_at`,
    [asset.id, asset.indexId, asset, asset.createdAt, asset.updatedAt]
  );
  const index = await getIndex(asset.indexId);
  if (index && !index.assetIds.includes(asset.id)) {
    index.assetIds.push(asset.id);
    index.status = "ready";
    index.updatedAt = new Date().toISOString();
    await saveIndex(index);
  }
  return asset;
}

export async function listJobs() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_jobs order by created_at desc");
  return result.rows.map((row) => row.data as JobRecord);
}

export async function getJob(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_jobs where id = $1", [id]);
  return (result.rows[0]?.data as JobRecord | undefined) ?? null;
}

export async function saveJob(job: JobRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_jobs(id, asset_id, index_id, status, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set asset_id = excluded.asset_id, index_id = excluded.index_id, status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
    [job.id, job.assetId, job.indexId, job.status, job, job.createdAt, job.updatedAt]
  );
  return job;
}

export async function listWebhooks() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_webhooks order by created_at desc");
  return result.rows.map((row) => row.data as WebhookRecord);
}

export async function getWebhook(id: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_webhooks where id = $1", [id]);
  return (result.rows[0]?.data as WebhookRecord | undefined) ?? null;
}

export async function saveWebhook(webhook: WebhookRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_webhooks(id, active, data, created_at, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set active = excluded.active, data = excluded.data, updated_at = excluded.updated_at`,
    [webhook.id, webhook.active, webhook, webhook.createdAt, webhook.updatedAt]
  );
  return webhook;
}

export async function listEvents(limit = 80) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_events order by created_at desc limit $1", [limit]);
  return result.rows.map((row) => row.data as EventRecord);
}

export async function saveEvent(event: EventRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_events(id, type, asset_id, index_id, job_id, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [event.id, event.type, event.assetId, event.indexId, event.jobId, event, event.createdAt]
  );
  return event;
}

export async function listUsers() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_users order by created_at asc");
  return result.rows.map((row) => row.data as UserRecord);
}

export async function getUserByApiKey(apiKey: string) {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_users where api_key = $1", [apiKey]);
  return (result.rows[0]?.data as UserRecord | undefined) ?? null;
}

export async function listBilling() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_billing order by created_at desc");
  return result.rows.map((row) => row.data as BillingRecord);
}

export async function saveBilling(record: BillingRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_billing(id, user_id, asset_id, job_id, units, data, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [record.id, record.userId, record.assetId, record.jobId, record.units, record, record.createdAt]
  );
  return record;
}

export async function getMetrics(): Promise<MetricsSummary> {
  await ensurePostgresStore();
  const result = await getPool().query(`
    select
      (select count(*)::int from app_indexes) as indexes,
      (select count(*)::int from app_assets) as assets,
      (select count(*)::int from app_assets where data->>'status' = 'indexed') as indexed_assets,
      (select count(*)::int from app_jobs where status in ('queued', 'running')) as running_jobs,
      (select count(*)::int from app_jobs where status = 'failed') as failed_jobs,
      coalesce((select sum((data->>'duration')::double precision) from app_assets where data->>'duration' is not null), 0) as total_duration,
      coalesce((select sum(jsonb_array_length(coalesce(data->'timeline', '[]'::jsonb))) from app_assets), 0)::int as segments,
      ((select count(*)::int from app_vectors) + (select count(*)::int from app_visual_vectors)) as vectors,
      (select count(*)::int from app_webhooks where active = true) as webhooks,
      coalesce((select sum(units) from app_billing), 0)::int as billing_units
  `);
  const row = result.rows[0];
  return {
    indexes: row.indexes,
    assets: row.assets,
    indexedAssets: row.indexed_assets,
    runningJobs: row.running_jobs,
    failedJobs: row.failed_jobs,
    totalDuration: Number(row.total_duration),
    segments: row.segments,
    vectors: row.vectors,
    webhooks: row.webhooks,
    billingUnits: row.billing_units
  };
}
