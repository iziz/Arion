import type { AskOperationEntry } from "../workflows/ask/types";
import { getPool } from "./connection";
import { ensurePostgresStore } from "./schema";

export async function listAskOperationEntries() {
  await ensurePostgresStore();
  const result = await getPool().query("select data from app_ask_operations order by updated_at desc limit 120");
  return result.rows.map((row) => row.data as AskOperationEntry);
}

export async function upsertAskOperationEntry(entry: AskOperationEntry) {
  await ensurePostgresStore();
  await getPool().query(
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
  return entry;
}

export async function deleteAskOperationEntries(ids: string[]) {
  if (ids.length === 0) return;
  await ensurePostgresStore();
  await getPool().query("delete from app_ask_operations where id = any($1::text[])", [ids]);
}
