import type { SportsDomainGroup } from "../../shared/types";
import type { SportsKnowledgeVectorRecord } from "../sportsKnowledgeDocuments";
import { extractKeywords } from "../intelligenceCore/textUtils";
import { scoreKnowledgeVectorRecord } from "../knowledgeVectorScoring";
import { buildKnowledgeVectorStatus, type KnowledgeVectorStatusRecord } from "../knowledgeVectorStatus";
import { getPool, isVectorExtensionAvailable } from "./connection";
import { ensurePostgresStore } from "./schema";
import { isPgVectorCompatible, vectorLiteral } from "./vectorUtils";

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

export async function searchKnowledgeVectors(domainGroup: SportsDomainGroup | undefined, queryVector: number[], limit = 24, queryText = "") {
  await ensurePostgresStore();
  const terms = extractKeywords(queryText).slice(0, 8);
  const candidateLimit = Math.max(limit * 24, 200);
  const candidates = new Map<string, ReturnType<typeof rowToResult>>();
  if (isVectorExtensionAvailable() && isPgVectorCompatible(queryVector)) {
    const pgvectorRows = await getPool().query(
      `select *, 1 - (embedding <=> $1::vector) as score
       from app_knowledge_vectors
       where embedding is not null
         and ($2::text is null or domain_group = $2)
       order by embedding <=> $1::vector
       limit $3`,
      [vectorLiteral(queryVector), domainGroup ?? null, candidateLimit]
    );
    for (const row of pgvectorRows.rows.map(rowToResult)) candidates.set(row.id, row);
    const jsonFallbackRows = await getPool().query(
      `select *
       from app_knowledge_vectors
       where embedding is null
         and ($1::text is null or domain_group = $1)
       limit $2`,
      [domainGroup ?? null, candidateLimit]
    );
    for (const row of jsonFallbackRows.rows.map(rowToResult)) candidates.set(row.id, row);
  } else {
    const result = await getPool().query(
      "select * from app_knowledge_vectors where ($1::text is null or domain_group = $1)",
      [domainGroup ?? null]
    );
    for (const row of result.rows.map(rowToResult)) candidates.set(row.id, row);
  }

  if (terms.length > 0) {
    const { where, values } = lexicalWhereClause(terms, domainGroup);
    const result = await getPool().query(`select * from app_knowledge_vectors where ${where} limit ${candidateLimit}`, values);
    for (const row of result.rows.map(rowToResult)) candidates.set(row.id, row);
  }

  return Array.from(candidates.values())
    .map((row) => ({ ...row, score: scoreKnowledgeVectorRecord(row, queryVector, terms, queryText) }))
    .filter((row) => row.score > 0.12)
    .sort((a, b) => b.score - a.score || a.entityName.localeCompare(b.entityName))
    .slice(0, limit);
}

export async function getKnowledgeVectorCount() {
  await ensurePostgresStore();
  const result = await getPool().query("select count(*)::int as count from app_knowledge_vectors");
  return result.rows[0].count as number;
}

export async function getKnowledgeVectorStatus() {
  await ensurePostgresStore();
  const result = await getPool().query(
    `select domain_group as "domainGroup", provider, kind, count(*)::int as vectors
     from app_knowledge_vectors
     group by domain_group, provider, kind`
  );
  return buildKnowledgeVectorStatus(result.rows as KnowledgeVectorStatusRecord[], "postgres");
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

function lexicalWhereClause(terms: string[], domainGroup: SportsDomainGroup | undefined) {
  const values: string[] = [];
  const clauses: string[] = [];
  if (domainGroup) {
    values.push(domainGroup);
    clauses.push(`domain_group = $${values.length}`);
  }
  const termClauses = terms.map((term) => {
    values.push(`%${term.toLowerCase()}%`);
    const index = values.length;
    return `(lower(text) like $${index} or lower(entity_name) like $${index} or lower(coalesce(competition, '')) like $${index} or lower(coalesce(team, '')) like $${index})`;
  });
  clauses.push(`(${termClauses.join(" or ")})`);
  return { where: clauses.join(" and "), values };
}
