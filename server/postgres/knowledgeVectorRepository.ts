import type { SportsDomainGroup } from "../../shared/types";
import type { SportsKnowledgeVectorRecord } from "../sportsKnowledgeDocuments";
import { getPool, isVectorExtensionAvailable } from "./connection";
import { ensurePostgresStore } from "./schema";
import { cosineSimilarity, isPgVectorCompatible, vectorLiteral } from "./vectorUtils";

type KnowledgeVectorRow = {
  id: string;
  domain_group: SportsDomainGroup;
  provider: SportsKnowledgeVectorRecord["provider"];
  kind: SportsKnowledgeVectorRecord["kind"];
  entity_type: SportsKnowledgeVectorRecord["entityType"];
  entity_name: string;
  competition: string | null;
  season: string | null;
  team: string | null;
  match_time: string | null;
  text: string;
  source_text: string;
  embedding_json: number[];
  score?: number;
};

export async function rebuildKnowledgeVectorStore(records: SportsKnowledgeVectorRecord[]) {
  await ensurePostgresStore();
  const db = getPool();
  await db.query("truncate app_knowledge_vectors");
  for (const record of records) {
    const pgVector = isVectorExtensionAvailable() && isPgVectorCompatible(record.vector) ? vectorLiteral(record.vector) : null;
    if (pgVector) {
      await db.query(
        `insert into app_knowledge_vectors(
          id, domain_group, provider, kind, entity_type, entity_name, competition, season, team, match_time, text, source_text, embedding_json, embedding
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector)`,
        rowValues(record, pgVector)
      );
    } else {
      await db.query(
        `insert into app_knowledge_vectors(
          id, domain_group, provider, kind, entity_type, entity_name, competition, season, team, match_time, text, source_text, embedding_json
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        rowValues(record)
      );
    }
  }
}

export async function searchKnowledgeVectors(domainGroup: SportsDomainGroup | undefined, queryVector: number[], limit = 24) {
  await ensurePostgresStore();
  if (isVectorExtensionAvailable() && isPgVectorCompatible(queryVector)) {
    const result = await getPool().query(
      `select *, 1 - (embedding <=> $1::vector) as score
       from app_knowledge_vectors
       where embedding is not null
         and ($2::text is null or domain_group = $2)
       order by embedding <=> $1::vector
       limit $3`,
      [vectorLiteral(queryVector), domainGroup ?? null, limit]
    );
    return result.rows.map(rowToResult);
  }

  const result = await getPool().query(
    "select * from app_knowledge_vectors where ($1::text is null or domain_group = $1)",
    [domainGroup ?? null]
  );
  return result.rows
    .map((row) => ({ ...rowToResult(row), score: cosineSimilarity(queryVector, row.embedding_json ?? []) }))
    .filter((row) => row.score > 0.12)
    .sort((a, b) => b.score - a.score || a.entityName.localeCompare(b.entityName))
    .slice(0, limit);
}

export async function getKnowledgeVectorCount() {
  await ensurePostgresStore();
  const result = await getPool().query("select count(*)::int as count from app_knowledge_vectors");
  return result.rows[0].count as number;
}

function rowValues(record: SportsKnowledgeVectorRecord, pgVector?: string) {
  return [
    record.id,
    record.domainGroup,
    record.provider,
    record.kind,
    record.entityType,
    record.entityName,
    record.competition ?? null,
    record.season ?? null,
    record.team ?? null,
    record.matchTime ?? null,
    record.text,
    record.sourceText,
    JSON.stringify(record.vector),
    ...(pgVector ? [pgVector] : [])
  ];
}

function rowToResult(row: KnowledgeVectorRow) {
  return {
    id: row.id,
    domainGroup: row.domain_group,
    provider: row.provider,
    kind: row.kind,
    entityType: row.entity_type,
    entityName: row.entity_name,
    competition: row.competition ?? undefined,
    season: row.season ?? undefined,
    team: row.team ?? undefined,
    matchTime: row.match_time ?? undefined,
    text: row.text,
    sourceText: row.source_text,
    vector: row.embedding_json ?? [],
    score: Number(row.score ?? 0)
  };
}
