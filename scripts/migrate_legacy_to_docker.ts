import "../server/env";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  closePostgresStore,
  ensurePostgresStore,
  getMetrics,
  rebuildKnowledgeVectorStore,
  rebuildVisualVectorStore,
  rebuildTrackingRecords,
  saveAsset,
  saveBilling,
  saveEvent,
  saveIndex,
  saveJob,
  saveUser,
  saveWebhook,
  upsertAssetVectors
} from "../server/postgresStore";
import type { VisualVectorRecord } from "../server/localVisualEmbeddingRuntime";
import type { SportsKnowledgeVectorRecord } from "../server/sportsKnowledgeDocuments";
import type {
  AssetRecord,
  BillingRecord,
  EventRecord,
  IndexRecord,
  JobRecord,
  TrackingRecord,
  UserRecord,
  WebhookRecord
} from "../shared/types";

type FileDatabase = {
  indexes?: IndexRecord[];
  assets?: AssetRecord[];
  jobs?: JobRecord[];
  webhooks?: WebhookRecord[];
  events?: EventRecord[];
  users?: UserRecord[];
  billing?: BillingRecord[];
};

type TrackingDatabase = {
  records?: TrackingRecord[];
};

const args = new Set(process.argv.slice(2));
const dataDir = path.resolve(".data");
const objectStorageDir = path.join(dataDir, "object-storage");
const backupRoot = path.resolve(".legacy-backups");
const deleteOrphanMedia = args.has("--delete-orphan-media");
const copyAppData = args.has("--copy-app-data");
const archiveLegacyStores = args.has("--archive-legacy-stores");
const dockerAppDataVolume = process.env.DOCKER_APP_DATA_VOLUME || "arion_app-data";
const dockerCopyImage = process.env.DOCKER_COPY_IMAGE || "redis:7.4-alpine";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Run with ARION_DOCKER_INFRA=true or set DATABASE_URL explicitly.");
}

await ensurePostgresStore();

const dbPath = path.join(dataDir, "db.json");
const raw = await readOptionalJson<FileDatabase>(dbPath, {});
const migrationStats = {
  indexes: 0,
  assets: 0,
  deletedOrphanMediaObjects: 0,
  jobs: 0,
  webhooks: 0,
  events: 0,
  users: 0,
  billing: 0,
  vectors: 0,
  visualVectors: 0,
  knowledgeVectors: 0,
  trackingRecords: 0,
  copiedAppDataVolume: false,
  archivedLegacyStoreFiles: [] as string[]
};

for (const index of raw.indexes ?? []) {
  await saveIndex(index);
  migrationStats.indexes += 1;
}
for (const user of raw.users ?? []) {
  await saveUser(user);
  migrationStats.users += 1;
}
for (const asset of raw.assets ?? []) {
  await saveAsset(asset);
  if (asset.timeline?.length) await upsertAssetVectors(asset.indexId, asset.id, asset.timeline);
  migrationStats.assets += 1;
}
for (const job of raw.jobs ?? []) {
  await saveJob(job);
  migrationStats.jobs += 1;
}
for (const webhook of raw.webhooks ?? []) {
  await saveWebhook(webhook);
  migrationStats.webhooks += 1;
}
for (const event of raw.events ?? []) {
  await saveEvent(event);
  migrationStats.events += 1;
}
for (const record of raw.billing ?? []) {
  await saveBilling(record);
  migrationStats.billing += 1;
}

const visualVectors = await readOptionalJson<VisualVectorRecord[]>(path.join(dataDir, "visual-vector-store.json"), []);
if (visualVectors.length > 0) {
  await rebuildVisualVectorStore(visualVectors);
  migrationStats.visualVectors = visualVectors.length;
}

const knowledgeVectors = await readOptionalJson<SportsKnowledgeVectorRecord[]>(
  path.join(dataDir, "knowledge-vector-store.json"),
  []
);
if (knowledgeVectors.length > 0) {
  await rebuildKnowledgeVectorStore(knowledgeVectors);
  migrationStats.knowledgeVectors = knowledgeVectors.length;
}

const trackingDatabase = await readOptionalJson<TrackingDatabase>(path.join(dataDir, "tracking-db.json"), { records: [] });
const trackingRecords = Array.isArray(trackingDatabase.records) ? trackingDatabase.records : [];
if (trackingRecords.length > 0) {
  await rebuildTrackingRecords(trackingRecords);
  migrationStats.trackingRecords = trackingRecords.length;
}

if (deleteOrphanMedia) {
  migrationStats.deletedOrphanMediaObjects = await deleteOrphanMediaObjects(raw.assets ?? []);
}

if (copyAppData) {
  await copyDataDirToDockerVolume();
  migrationStats.copiedAppDataVolume = true;
}

if (archiveLegacyStores) {
  migrationStats.archivedLegacyStoreFiles = await archiveMigratedLegacyStoreFiles();
}

const metrics = await getMetrics();
console.log(JSON.stringify({ ok: true, migration: migrationStats, postgresMetrics: metrics }, null, 2));
await closePostgresStore();

async function deleteOrphanMediaObjects(knownAssets: AssetRecord[]) {
  const knownAssetIds = new Set(knownAssets.map((asset) => asset.id));
  const sourceObjects = await listLegacySourceObjects();
  const orphanObjects = sourceObjects.filter((source) => !knownAssetIds.has(source.assetId));
  if (orphanObjects.length === 0) return 0;

  let deleted = 0;
  for (const source of orphanObjects) {
    await rm(path.dirname(source.absolutePath), { recursive: true, force: true });
    deleted += 1;
  }
  return deleted;
}

async function listLegacySourceObjects() {
  const objects: Array<{
    assetId: string;
    provider: "local-s3" | "local-r2";
    bucket: string;
    objectKey: string;
    absolutePath: string;
  }> = [];
  for (const provider of ["local-s3", "local-r2"] as const) {
    const providerDir = path.join(objectStorageDir, provider);
    for (const bucketEntry of await readDirSafe(providerDir)) {
      if (!bucketEntry.isDirectory()) continue;
      const bucket = bucketEntry.name;
      const assetsDir = path.join(providerDir, bucket, "assets");
      for (const assetEntry of await readDirSafe(assetsDir)) {
        if (!assetEntry.isDirectory()) continue;
        const assetId = assetEntry.name;
        const assetDir = path.join(assetsDir, assetId);
        for (const sourceEntry of await readDirSafe(assetDir)) {
          if (!sourceEntry.isFile() || !sourceEntry.name.startsWith("source.")) continue;
          objects.push({
            assetId,
            provider,
            bucket,
            objectKey: `assets/${assetId}/${sourceEntry.name}`,
            absolutePath: path.join(assetDir, sourceEntry.name)
          });
        }
      }
    }
  }
  return objects;
}

async function copyDataDirToDockerVolume() {
  await run("docker", ["volume", "create", dockerAppDataVolume]);
  await run("docker", [
    "run",
    "--rm",
    "-v",
    `${dockerAppDataVolume}:/target`,
    "-v",
    `${dataDir}:/source:ro`,
    dockerCopyImage,
    "sh",
    "-c",
    "mkdir -p /target && cp -a /source/. /target/"
  ]);
}

async function archiveMigratedLegacyStoreFiles() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join(backupRoot, `legacy-stores-${timestamp}`);
  const files = [
    "db.json",
    "events.ndjson",
    "vector-store.json",
    "visual-vector-store.json",
    "knowledge-vector-store.json",
    "tracking-db.json"
  ];
  const archived: string[] = [];
  await mkdir(archiveDir, { recursive: true });
  for (const relativePath of files) {
    const source = path.join(dataDir, relativePath);
    if (!(await exists(source))) continue;
    const destination = path.join(archiveDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: false });
    await rename(source, `${source}.migrated`);
    archived.push(relativePath);
  }
  await writeFile(
    path.join(archiveDir, "README.md"),
    [
      "# Legacy Store Archive",
      "",
      "These files were migrated into Docker PostgreSQL and moved out of the live `.data` store path.",
      "Source media under `.data/object-storage` is intentionally not deleted because local dev processes still use it as the media root.",
      ""
    ].join("\n"),
    "utf8"
  );
  return archived;
}

async function readOptionalJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readDirSafe(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}
