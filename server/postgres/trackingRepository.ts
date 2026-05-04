import type { TrackingRecord } from "../../shared/types";
import type { PoolClient } from "pg";
import { getPool } from "./connection";
import { ensurePostgresStore } from "./schema";

export async function upsertTrackingRecords(assetId: string, records: TrackingRecord[]) {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("delete from app_tracking_records where asset_id = $1", [assetId]);
    for (const record of records) {
      await insertTrackingRecord(client, record);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return records;
}

export async function rebuildTrackingRecords(records: TrackingRecord[]) {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("truncate app_tracking_records");
    for (const record of records) {
      await insertTrackingRecord(client, record);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return records;
}

export async function listTrackingRecords(filters: { assetId?: string; segmentId?: string; trackId?: string } = {}) {
  await ensurePostgresStore();
  const values: string[] = [];
  const clauses: string[] = [];
  if (filters.assetId) {
    values.push(filters.assetId);
    clauses.push(`asset_id = $${values.length}`);
  }
  if (filters.segmentId) {
    values.push(filters.segmentId);
    clauses.push(`segment_id = $${values.length}`);
  }
  if (filters.trackId) {
    values.push(filters.trackId);
    clauses.push(`(track_id = $${values.length} or linked_track_id = $${values.length})`);
  }
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const result = await getPool().query(
    `select data from app_tracking_records ${where} order by start_seconds asc, track_id asc`,
    values
  );
  return result.rows.map((row) => row.data as TrackingRecord);
}

async function insertTrackingRecord(client: PoolClient, record: TrackingRecord) {
  await client.query(
    `insert into app_tracking_records(
      id, index_id, asset_id, segment_id, track_type, track_id, linked_track_id,
      start_seconds, end_seconds, data, created_at, updated_at
    )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (id) do update set
       index_id = excluded.index_id,
       asset_id = excluded.asset_id,
       segment_id = excluded.segment_id,
       track_type = excluded.track_type,
       track_id = excluded.track_id,
       linked_track_id = excluded.linked_track_id,
       start_seconds = excluded.start_seconds,
       end_seconds = excluded.end_seconds,
       data = excluded.data,
       updated_at = excluded.updated_at`,
    [
      record.id,
      record.indexId,
      record.assetId,
      record.segmentId,
      record.trackType,
      record.trackId,
      record.linkedTrackId,
      record.start,
      record.end,
      record,
      record.createdAt,
      record.updatedAt
    ]
  );
}
