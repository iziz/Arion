import { randomUUID } from "node:crypto";
import { normalizeCapabilityPolicy, normalizeDomainIndexing } from "./domainConfig";
import { createDefaultIndex as createPostgresDefaultIndex } from "./postgres/defaults";
import * as pgStore from "./postgresStore";
import { publishRealtimeEvent } from "./services/realtimeEvents";
import { summarizeAssetRecord } from "../shared/assetSummary";
import type { AssetRecord, EventRecord, IndexRecord, JobRecord } from "../shared/types";

export async function ensureStore() {
  assertPostgresRuntime();
  await pgStore.ensurePostgresStore();
}

export async function listIndexes() {
  return (await pgStore.listIndexes()).map(normalizeIndexRecord);
}

export async function getIndex(id: string) {
  const index = await pgStore.getIndex(id);
  return index ? normalizeIndexRecord(index) : null;
}

export async function saveIndex(index: Parameters<typeof pgStore.saveIndex>[0]) {
  return pgStore.saveIndex(normalizeIndexRecord(index));
}

export async function listAssets(indexId?: string) {
  return pgStore.listAssets(indexId);
}

export async function getAsset(id: string) {
  return pgStore.getAsset(id);
}

export async function saveAsset(asset: AssetRecord) {
  const saved = await pgStore.saveAsset(asset);
  publishRealtimeEvent("asset.updated", { assetId: saved.id, indexId: saved.indexId, asset: summarizeAssetRecord(saved) });
  return saved;
}

export async function deleteAssetCascade(assetId: string) {
  const result = await pgStore.deleteAssetCascade(assetId);
  if (result) publishRealtimeEvent("asset.deleted", { assetId, indexId: result.indexId, deleted: result.deleted });
  return result;
}

export async function deleteIndexCascade(indexId: string) {
  const result = await pgStore.deleteIndexCascade(indexId);
  if (result) publishRealtimeEvent("index.deleted", { indexId, assetIds: result.assetIds, deleted: result.deleted });
  return result;
}

export async function listJobs() {
  return pgStore.listJobs();
}

export async function getJob(id: string) {
  return pgStore.getJob(id);
}

export async function saveJob(job: JobRecord) {
  const saved = await pgStore.saveJob(job);
  publishRealtimeEvent("job.updated", { jobId: saved.id, assetId: saved.assetId, job: saved });
  return saved;
}

export async function listWebhooks() {
  return pgStore.listWebhooks();
}

export async function getWebhook(id: string) {
  return pgStore.getWebhook(id);
}

export async function saveWebhook(webhook: Parameters<typeof pgStore.saveWebhook>[0]) {
  return pgStore.saveWebhook(webhook);
}

export async function listEvents(limit = 80) {
  return pgStore.listEvents(limit);
}

export async function saveEvent(event: EventRecord) {
  const saved = await pgStore.saveEvent(event);
  publishRealtimeEvent("event.recorded", { eventId: saved.id, assetId: saved.assetId, jobId: saved.jobId, event: saved });
  return saved;
}

export async function listUsers() {
  return pgStore.listUsers();
}

export async function getUserByApiKey(apiKey: string) {
  return pgStore.getUserByApiKey(apiKey);
}

export async function listBilling() {
  return pgStore.listBilling();
}

export async function saveBilling(record: Parameters<typeof pgStore.saveBilling>[0]) {
  return pgStore.saveBilling(record);
}

export async function getMetrics() {
  return pgStore.getMetrics();
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

export function createDefaultIndex(now = new Date().toISOString()) {
  return normalizeIndexRecord(createPostgresDefaultIndex(now));
}

export function newId() {
  return randomUUID();
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL is required. Set DATABASE_URL or run through Docker infra.");
  }
}

function normalizeIndexRecord(index: IndexRecord): IndexRecord {
  const domainIndexing = normalizeDomainIndexing(index.domainIndexing);
  return {
    ...index,
    domainIndexing,
    capabilityPolicy: normalizeCapabilityPolicy(index.capabilityPolicy, domainIndexing)
  };
}
