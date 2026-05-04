import type { PoolClient } from "pg";
import type { JobRecord } from "../../shared/types";
import type { AskOperationEntry } from "../workflows/ask/types";
import type { QueueOutboxEntry, QueueOutboxKind } from "../services/queueOutboxStore";
import { getPool } from "./connection";
import { ensurePostgresStore } from "./schema";

export async function saveQueueOutboxEntry(entry: QueueOutboxEntry) {
  await ensurePostgresStore();
  await upsertQueueOutboxEntry(getPool(), entry);
  return entry;
}

export async function saveJobWithQueueOutbox(job: JobRecord, entry: QueueOutboxEntry) {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into app_jobs(id, asset_id, index_id, status, data, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set asset_id = excluded.asset_id, index_id = excluded.index_id, status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
      [job.id, job.assetId, job.indexId, job.status, job, job.createdAt, job.updatedAt]
    );
    await upsertQueueOutboxEntry(client, entry);
    await client.query("commit");
    return job;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertAskOperationEntryWithQueueOutbox(entry: AskOperationEntry, outbox: QueueOutboxEntry) {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into app_ask_operations(id, index_id, status, route, data, created_at, updated_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set
         index_id = excluded.index_id,
         status = excluded.status,
         route = excluded.route,
         data = excluded.data,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at`,
      [
        entry.operation.id,
        entry.operation.indexId,
        entry.operation.status,
        entry.operation.route,
        entry,
        entry.operation.createdAt,
        entry.operation.updatedAt,
        entry.operation.completedAt
      ]
    );
    await upsertQueueOutboxEntry(client, outbox);
    await client.query("commit");
    return entry;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPendingQueueOutboxEntries(kind?: QueueOutboxKind, limit = 100) {
  await ensurePostgresStore();
  const params: unknown[] = [limit];
  const kindClause = kind ? "and kind = $2" : "";
  if (kind) params.push(kind);
  const result = await getPool().query(
    `select data
     from app_queue_outbox
     where status <> 'published'
       and (next_attempt_at is null or next_attempt_at <= now())
       ${kindClause}
     order by created_at asc
     limit $1`,
    params
  );
  return result.rows.map((row) => row.data as QueueOutboxEntry);
}

export async function updateQueueOutboxEntry(id: string, patch: Partial<Pick<QueueOutboxEntry, "status" | "lastError" | "nextAttemptAt" | "publishedAt">>) {
  await ensurePostgresStore();
  const current = await getQueueOutboxEntry(id);
  if (!current) return null;
  const next: QueueOutboxEntry = {
    ...current,
    ...patch,
    attempts: patch.status === "failed" ? current.attempts + 1 : current.attempts,
    updatedAt: new Date().toISOString()
  };
  await upsertQueueOutboxEntry(getPool(), next);
  return next;
}

async function getQueueOutboxEntry(id: string) {
  const result = await getPool().query("select data from app_queue_outbox where id = $1", [id]);
  return (result.rows[0]?.data as QueueOutboxEntry | undefined) ?? null;
}

async function upsertQueueOutboxEntry(client: Pick<PoolClient, "query">, entry: QueueOutboxEntry) {
  await client.query(
    `insert into app_queue_outbox(id, kind, aggregate_id, status, attempts, data, created_at, updated_at, next_attempt_at, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (id) do update set
       kind = excluded.kind,
       aggregate_id = excluded.aggregate_id,
       status = excluded.status,
       attempts = excluded.attempts,
       data = excluded.data,
       updated_at = excluded.updated_at,
       next_attempt_at = excluded.next_attempt_at,
       published_at = excluded.published_at`,
    [
      entry.id,
      entry.kind,
      entry.aggregateId,
      entry.status,
      entry.attempts,
      entry,
      entry.createdAt,
      entry.updatedAt,
      entry.nextAttemptAt,
      entry.publishedAt
    ]
  );
}
