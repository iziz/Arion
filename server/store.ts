import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { defaultCapabilityPolicy, normalizeCapabilityPolicy } from "./domainConfig";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";
import { getVectorCount } from "./localVectorStore";
import * as pgStore from "./postgresStore";
import type {
  AssetRecord,
  BillingRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  MetricsSummary,
  UserRecord,
  WebhookRecord
} from "../shared/types";

type Database = {
  indexes: IndexRecord[];
  assets: AssetRecord[];
  jobs: JobRecord[];
  webhooks: WebhookRecord[];
  events: EventRecord[];
  users: UserRecord[];
  billing: BillingRecord[];
};

type LegacyDatabase = Partial<Database> & {
  videos?: AssetRecord[];
};

const dataDir = path.resolve(".data");
const dbPath = path.join(dataDir, "db.json");
const eventsPath = path.join(dataDir, "events.ndjson");
const defaultIndexId = "default-index";

let database: Database = emptyDatabase();
let loaded = false;
let writeChain = Promise.resolve();

export async function ensureStore() {
  if (pgStore.isPostgresEnabled()) {
    await pgStore.ensurePostgresStore();
    loaded = true;
    return;
  }
  if (loaded) return;
  database = migrate(await readJsonFile<LegacyDatabase>(dbPath, () => ({}), "store.db"));
  ensureDefaultIndex();
  await persist();
  loaded = true;
}

export async function listIndexes() {
  if (pgStore.isPostgresEnabled()) return pgStore.listIndexes();
  await ensureStore();
  return [...database.indexes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getIndex(id: string) {
  if (pgStore.isPostgresEnabled()) return pgStore.getIndex(id);
  await ensureStore();
  return database.indexes.find((index) => index.id === id) ?? null;
}

export async function saveIndex(index: IndexRecord) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveIndex(index);
  await ensureStore();
  const existing = database.indexes.findIndex((item) => item.id === index.id);
  if (existing >= 0) {
    database.indexes[existing] = index;
  } else {
    database.indexes.push(index);
  }
  await persist();
  return index;
}

export async function listAssets(indexId?: string) {
  if (pgStore.isPostgresEnabled()) return pgStore.listAssets(indexId);
  await ensureStore();
  return database.assets
    .filter((asset) => !indexId || asset.indexId === indexId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAsset(id: string) {
  if (pgStore.isPostgresEnabled()) return pgStore.getAsset(id);
  await ensureStore();
  return database.assets.find((asset) => asset.id === id) ?? null;
}

export async function saveAsset(asset: AssetRecord) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveAsset(asset);
  await ensureStore();
  const existing = database.assets.findIndex((item) => item.id === asset.id);
  if (existing >= 0) {
    database.assets[existing] = asset;
  } else {
    database.assets.push(asset);
  }

  const index = database.indexes.find((item) => item.id === asset.indexId);
  if (index && !index.assetIds.includes(asset.id)) {
    index.assetIds.push(asset.id);
    index.status = "ready";
    index.updatedAt = new Date().toISOString();
  }
  await persist();
  return asset;
}

export async function listJobs() {
  if (pgStore.isPostgresEnabled()) return pgStore.listJobs();
  await ensureStore();
  return [...database.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getJob(id: string) {
  if (pgStore.isPostgresEnabled()) return pgStore.getJob(id);
  await ensureStore();
  return database.jobs.find((job) => job.id === id) ?? null;
}

export async function saveJob(job: JobRecord) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveJob(job);
  await ensureStore();
  const existing = database.jobs.findIndex((item) => item.id === job.id);
  if (existing >= 0) {
    database.jobs[existing] = job;
  } else {
    database.jobs.push(job);
  }
  await persist();
  return job;
}

export async function listWebhooks() {
  if (pgStore.isPostgresEnabled()) return pgStore.listWebhooks();
  await ensureStore();
  return [...database.webhooks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getWebhook(id: string) {
  if (pgStore.isPostgresEnabled()) return pgStore.getWebhook(id);
  await ensureStore();
  return database.webhooks.find((webhook) => webhook.id === id) ?? null;
}

export async function saveWebhook(webhook: WebhookRecord) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveWebhook(webhook);
  await ensureStore();
  const existing = database.webhooks.findIndex((item) => item.id === webhook.id);
  if (existing >= 0) {
    database.webhooks[existing] = webhook;
  } else {
    database.webhooks.push(webhook);
  }
  await persist();
  return webhook;
}

export async function listEvents(limit = 80) {
  if (pgStore.isPostgresEnabled()) return pgStore.listEvents(limit);
  await ensureStore();
  return [...database.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function saveEvent(event: EventRecord) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveEvent(event);
  await ensureStore();
  database.events.push(event);
  database.events = database.events.slice(-500);
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`);
  await persist();
  return event;
}

export async function listUsers() {
  if (pgStore.isPostgresEnabled()) return pgStore.listUsers();
  await ensureStore();
  return database.users;
}

export async function getUserByApiKey(apiKey: string) {
  if (pgStore.isPostgresEnabled()) return pgStore.getUserByApiKey(apiKey);
  await ensureStore();
  return database.users.find((user) => user.apiKey === apiKey) ?? null;
}

export async function listBilling() {
  if (pgStore.isPostgresEnabled()) return pgStore.listBilling();
  await ensureStore();
  return [...database.billing].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveBilling(record: BillingRecord) {
  if (pgStore.isPostgresEnabled()) return pgStore.saveBilling(record);
  await ensureStore();
  database.billing.push(record);
  database.billing = database.billing.slice(-1000);
  await persist();
  return record;
}

export async function getMetrics(): Promise<MetricsSummary> {
  if (pgStore.isPostgresEnabled()) return pgStore.getMetrics();
  await ensureStore();
  return {
    indexes: database.indexes.length,
    assets: database.assets.length,
    indexedAssets: database.assets.filter((asset) => asset.status === "indexed").length,
    runningJobs: database.jobs.filter((job) => ["queued", "running"].includes(job.status)).length,
    failedJobs: database.jobs.filter((job) => job.status === "failed").length,
    totalDuration: database.assets.reduce((sum, asset) => sum + (asset.duration ?? 0), 0),
    segments: database.assets.reduce((sum, asset) => sum + asset.timeline.length, 0),
    vectors: await getVectorCount(),
    webhooks: database.webhooks.filter((webhook) => webhook.active).length,
    billingUnits: database.billing.reduce((sum, record) => sum + record.units, 0)
  };
}

export async function listVideos() {
  return listAssets();
}

export async function getVideo(id: string) {
  return getAsset(id);
}

export async function saveVideo(asset: AssetRecord) {
  return saveAsset(asset);
}

export function createDefaultIndex(now = new Date().toISOString()): IndexRecord {
  return {
    id: defaultIndexId,
    name: "Default video intelligence index",
    description: "Local index for uploaded assets, timeline metadata, search, and analysis.",
    models: {
      search: "local-semantic-retrieval",
      analysis: "local-pattern-analysis",
      embedding: process.env.EMBEDDING_MODEL || "intfloat/multilingual-e5-small"
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

function emptyDatabase(): Database {
  return {
    indexes: [],
    assets: [],
    jobs: [],
    webhooks: [],
    events: [],
    users: [
      {
        id: "local-user",
        name: "Local Developer",
        apiKey: "local-dev-key",
        plan: "local-dev",
        createdAt: new Date().toISOString()
      }
    ],
    billing: []
  };
}

function migrate(raw: LegacyDatabase): Database {
  const migrated = emptyDatabase();
  migrated.indexes = (raw.indexes ?? []).map((index) => ({
    ...index,
    domainIndexing: index.domainIndexing ?? { enabled: false, groups: [], stages: [] },
    capabilityPolicy: normalizeCapabilityPolicy(index.capabilityPolicy, index.domainIndexing)
  }));
  migrated.assets = raw.assets ?? raw.videos ?? [];
  migrated.jobs = raw.jobs ?? [];
  migrated.webhooks = raw.webhooks ?? [];
  migrated.events = raw.events ?? [];
  migrated.users = raw.users ?? emptyDatabase().users;
  migrated.billing = raw.billing ?? [];

  migrated.assets = migrated.assets.map((asset) => ({
    ...asset,
    indexId: asset.indexId ?? defaultIndexId,
    status: normalizeStatus(asset.status),
    technicalMetadata: asset.technicalMetadata ?? {
      storageProvider: "local",
      bucket: "legacy-uploads",
      objectKey: asset.storedName,
      checksum: null,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    },
    intelligence: {
	      audio: {
	        extractedPath: asset.intelligence?.audio?.extractedPath ?? null,
	        vad: asset.intelligence?.audio?.vad ?? {
	          available: (asset.intelligence?.audio?.speechSegments?.length ?? 0) > 0,
	          provider: "legacy",
	          error: null
	        },
	        speechSegments: asset.intelligence?.audio?.speechSegments ?? [],
        musicSegments: asset.intelligence?.audio?.musicSegments ?? [],
        hasSpeech: asset.intelligence?.audio?.hasSpeech ?? false,
        hasMusic: asset.intelligence?.audio?.hasMusic ?? false
      },
      asr: {
        transcript: asset.intelligence?.asr?.transcript ?? "",
        language: asset.intelligence?.asr?.language ?? "unknown",
        confidence: asset.intelligence?.asr?.confidence ?? 0,
        segments: asset.intelligence?.asr?.segments ?? []
      },
      diarization: {
        provider: asset.intelligence?.diarization?.provider ?? "none",
        speakers: asset.intelligence?.diarization?.speakers ?? [],
        segments: asset.intelligence?.diarization?.segments ?? [],
        error: asset.intelligence?.diarization?.error ?? null
      },
      ocr: {
        tokens: asset.intelligence?.ocr?.tokens ?? [],
        confidence: asset.intelligence?.ocr?.confidence ?? 0,
        frames: asset.intelligence?.ocr?.frames ?? []
      },
      visual: {
        available:
          asset.intelligence?.visual?.available ??
          isStoredVisualAvailable(asset.intelligence?.visual),
        labels: asset.intelligence?.visual?.labels ?? [],
        dominantColor: asset.intelligence?.visual?.dominantColor ?? "#000000",
        brightness: asset.intelligence?.visual?.brightness ?? 0,
        motionScore: asset.intelligence?.visual?.motionScore ?? 0,
        error: asset.intelligence?.visual?.error ?? null
      },
      modelTrace: asset.intelligence?.modelTrace ?? []
    },
    keyframes: asset.keyframes ?? [],
    timeline: asset.timeline.map((segment) => ({
      ...segment,
      modalities: segment.modalities ?? ["metadata"],
      embedding: segment.embedding ?? [],
      thumbnailPath: segment.thumbnailPath ?? null,
      sources: segment.sources ?? ["metadata"]
    }))
  }));

  migrated.webhooks = migrated.webhooks.map((webhook) => ({
    ...webhook,
    deliveries: webhook.deliveries.map((delivery) => ({
      ...delivery,
      eventId: delivery.eventId ?? null,
      attempts: delivery.attempts ?? 1,
      nextRetryAt: delivery.nextRetryAt ?? null,
      updatedAt: delivery.updatedAt ?? delivery.createdAt
    }))
  }));

  return migrated;
}

function ensureDefaultIndex() {
  let index = database.indexes.find((item) => item.id === defaultIndexId);
  if (!index) {
    index = createDefaultIndex();
    database.indexes.unshift(index);
  }
  const defaultAssetIds = database.assets.filter((asset) => asset.indexId === defaultIndexId).map((asset) => asset.id);
  index.assetIds = Array.from(new Set([...index.assetIds, ...defaultAssetIds]));
  index.status = index.assetIds.length > 0 ? "ready" : "empty";
}

function normalizeStatus(status: string): AssetRecord["status"] {
  if (status === "processing") return "embedding";
  if (status === "queued" || status === "indexed" || status === "failed") return status;
  if (
    status === "probing" ||
    status === "transcribing" ||
    status === "scanning" ||
    status === "sampling" ||
    status === "embedding" ||
    status === "uploaded"
  )
    return status;
  return "uploaded";
}

function isStoredVisualAvailable(visual: AssetRecord["intelligence"]["visual"] | undefined) {
  if (!visual) return false;
  if (visual.labels.some((label) => label === "metadata-derived" || label === "visual-fallback")) return false;
  return visual.labels.length > 0 || visual.dominantColor !== "#000000" || visual.motionScore > 0 || visual.brightness > 0;
}

async function persist() {
  writeChain = writeChain.then(() => writeJsonFile(dbPath, database));
  await writeChain;
}

export function newId() {
  return randomUUID();
}
