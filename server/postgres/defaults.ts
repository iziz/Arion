import type { IndexRecord, UserRecord } from "../../shared/types";
import { defaultCapabilityPolicy } from "../domainConfig";
import { getPool } from "./connection";

export async function seedDefaults() {
  const now = new Date().toISOString();
  const user: UserRecord = {
    id: "local-user",
    name: "Local Developer",
    apiKey: "local-dev-key",
    plan: "local-dev",
    createdAt: now
  };
  await getPool().query(
    `insert into app_users(id, api_key, data, created_at)
     values ($1, $2, $3, $4)
     on conflict (id) do nothing`,
    [user.id, user.apiKey, user, user.createdAt]
  );
}

export function createDefaultIndex(now = new Date().toISOString()): IndexRecord {
  return {
    id: "default-index",
    name: "Default video intelligence index",
    description: "Local index for uploaded assets, timeline metadata, search, and analysis.",
    models: {
      search: "local-semantic-retrieval",
      analysis: "local-pattern-analysis",
      embedding: process.env.EMBEDDING_MODEL || "intfloat/multilingual-e5-base"
    },
    modalities: ["visual", "audio", "transcription", "metadata"],
    domainIndexing: {
      enabled: false,
      groups: [],
      stages: []
    },
    capabilityPolicy: defaultCapabilityPolicy({ enabled: false, groups: [], stages: [] }),
    assetIds: [],
    status: "empty",
    createdAt: now,
    updatedAt: now
  };
}
