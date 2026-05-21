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

export type DeleteCascadeSummary = {
  indexId: string | null;
  assetIds: string[];
  jobIds: string[];
  askOperationIds: string[];
  deleted: {
    indexes: number;
    assets: number;
    jobs: number;
    queueOutbox: number;
    askOperations: number;
    events: number;
    billing: number;
    textVectors: number;
    visualVectors: number;
    appearanceVectors: number;
    trackingRecords: number;
  };
};

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

export async function deleteAssetCascade(assetId: string): Promise<DeleteCascadeSummary | null> {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const assetResult = await client.query("select data, index_id from app_assets where id = $1 for update", [assetId]);
    const asset = assetResult.rows[0]?.data as AssetRecord | undefined;
    if (!asset) {
      await client.query("rollback");
      return null;
    }

    const indexId = String(assetResult.rows[0].index_id);
    const jobIds = await selectTextColumn(client, "select id from app_jobs where asset_id = $1", [assetId]);
    const askOperationIds = await selectTextColumn(client, "select id from app_ask_operations where data #>> '{request,assetId}' = $1", [assetId]);
    const deleted = {
      textVectors: rowCount(await client.query("delete from app_vectors where asset_id = $1", [assetId])),
      visualVectors: rowCount(await client.query("delete from app_visual_vectors where asset_id = $1", [assetId])),
      appearanceVectors: rowCount(await client.query("delete from app_appearance_vectors where asset_id = $1", [assetId])),
      trackingRecords: rowCount(await client.query("delete from app_tracking_records where asset_id = $1", [assetId])),
      queueOutbox: rowCount(
        await client.query(
          `delete from app_queue_outbox
           where (kind = 'asset-job' and aggregate_id = any($1::text[]))
              or (kind = 'ask-operation' and aggregate_id = any($2::text[]))`,
          [jobIds, askOperationIds]
        )
      ),
      askOperations: rowCount(await client.query("delete from app_ask_operations where id = any($1::text[])", [askOperationIds])),
      billing: rowCount(
        await client.query("delete from app_billing where asset_id = $1 or job_id = any($2::text[])", [assetId, jobIds])
      ),
      events: rowCount(await client.query("delete from app_events where asset_id = $1 or job_id = any($2::text[])", [assetId, jobIds])),
      jobs: rowCount(await client.query("delete from app_jobs where asset_id = $1", [assetId])),
      assets: rowCount(await client.query("delete from app_assets where id = $1", [assetId])),
      indexes: 0
    };
    await removeAssetsFromIndex(client, indexId, [assetId]);
    await client.query("commit");
    return {
      indexId,
      assetIds: [assetId],
      jobIds,
      askOperationIds,
      deleted
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteIndexCascade(indexId: string): Promise<DeleteCascadeSummary | null> {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const indexResult = await client.query("select data from app_indexes where id = $1 for update", [indexId]);
    if (!indexResult.rows[0]) {
      await client.query("rollback");
      return null;
    }

    const assetIds = await selectTextColumn(client, "select id from app_assets where index_id = $1", [indexId]);
    const jobIds = await selectTextColumn(
      client,
      "select id from app_jobs where index_id = $1 or asset_id = any($2::text[])",
      [indexId, assetIds]
    );
    const askOperationIds = await selectTextColumn(
      client,
      `select id from app_ask_operations
       where index_id = $1
          or data #>> '{request,indexId}' = $1
          or data #>> '{request,assetId}' = any($2::text[])`,
      [indexId, assetIds]
    );

    const deleted = {
      textVectors: rowCount(
        await client.query("delete from app_vectors where index_id = $1 or asset_id = any($2::text[])", [indexId, assetIds])
      ),
      visualVectors: rowCount(
        await client.query("delete from app_visual_vectors where index_id = $1 or asset_id = any($2::text[])", [indexId, assetIds])
      ),
      appearanceVectors: rowCount(
        await client.query("delete from app_appearance_vectors where index_id = $1 or asset_id = any($2::text[])", [indexId, assetIds])
      ),
      trackingRecords: rowCount(
        await client.query("delete from app_tracking_records where index_id = $1 or asset_id = any($2::text[])", [indexId, assetIds])
      ),
      queueOutbox: rowCount(
        await client.query(
          `delete from app_queue_outbox
           where (kind = 'asset-job' and aggregate_id = any($1::text[]))
              or (kind = 'ask-operation' and aggregate_id = any($2::text[]))`,
          [jobIds, askOperationIds]
        )
      ),
      askOperations: rowCount(await client.query("delete from app_ask_operations where id = any($1::text[])", [askOperationIds])),
      billing: rowCount(
        await client.query("delete from app_billing where asset_id = any($1::text[]) or job_id = any($2::text[])", [assetIds, jobIds])
      ),
      events: rowCount(
        await client.query("delete from app_events where index_id = $1 or asset_id = any($2::text[]) or job_id = any($3::text[])", [
          indexId,
          assetIds,
          jobIds
        ])
      ),
      jobs: rowCount(await client.query("delete from app_jobs where index_id = $1 or asset_id = any($2::text[])", [indexId, assetIds])),
      assets: rowCount(await client.query("delete from app_assets where index_id = $1", [indexId])),
      indexes: rowCount(await client.query("delete from app_indexes where id = $1", [indexId]))
    };
    await client.query("commit");
    return {
      indexId,
      assetIds,
      jobIds,
      askOperationIds,
      deleted
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

export async function saveUser(user: UserRecord) {
  await ensurePostgresStore();
  await getPool().query(
    `insert into app_users(id, api_key, data, created_at)
     values ($1, $2, $3, $4)
     on conflict (id) do update set api_key = excluded.api_key, data = excluded.data`,
    [user.id, user.apiKey, user, user.createdAt]
  );
  return user;
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
      ((select count(*)::int from app_vectors) + (select count(*)::int from app_visual_vectors) + (select count(*)::int from app_appearance_vectors)) as vectors,
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

async function selectTextColumn(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, sql: string, values: unknown[]) {
  const result = await client.query(sql, values);
  return result.rows.map((row) => String(row.id));
}

async function removeAssetsFromIndex(client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }, indexId: string, assetIds: string[]) {
  const now = new Date().toISOString();
  await client.query(
    `update app_indexes
     set data = jsonb_set(
       jsonb_set(
         jsonb_set(
           data,
           '{assetIds}',
           coalesce(
             (
               select jsonb_agg(asset_id.value)
               from jsonb_array_elements_text(coalesce(data->'assetIds', '[]'::jsonb)) as asset_id(value)
               where asset_id.value <> all($2::text[])
             ),
             '[]'::jsonb
           ),
           true
         ),
         '{status}',
         to_jsonb(case when exists(select 1 from app_assets where index_id = $1) then 'ready'::text else 'empty'::text end),
         true
       ),
       '{updatedAt}',
       to_jsonb($3::text),
       true
     ),
     updated_at = $3::timestamptz
     where id = $1`,
    [indexId, assetIds, now]
  );
}

function rowCount(result: { rowCount: number | null }) {
  return result.rowCount ?? 0;
}
