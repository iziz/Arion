import path from "node:path";
import type { AssetRecord, TimelineSegment, TrackingRecord, TrackingSummary } from "../shared/types";
import { trustedDomainEvents } from "./evidenceTrust";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";

type TrackingDatabase = {
  records: TrackingRecord[];
};

const dataDir = path.resolve(".data");
const trackingPath = path.join(dataDir, "tracking-db.json");

let trackingDatabase: TrackingDatabase = { records: [] };
let loaded = false;
let writeChain = Promise.resolve();

export async function ensureTrackingStore() {
  if (loaded) return;
  trackingDatabase = normalizeTrackingDatabase(await readJsonFile<Partial<TrackingDatabase>>(trackingPath, () => ({ records: [] }), "tracking-store"));
  loaded = true;
}

export async function upsertAssetTracking(asset: AssetRecord) {
  await ensureTrackingStore();
  const records = buildTrackingRecords(asset);
  trackingDatabase.records = [...trackingDatabase.records.filter((record) => record.assetId !== asset.id), ...records];
  await persistTrackingStore();
  return records;
}

export async function rebuildTrackingStore(assets: AssetRecord[]) {
  await ensureTrackingStore();
  trackingDatabase.records = assets.flatMap((asset) => buildTrackingRecords(asset));
  await persistTrackingStore();
  return trackingDatabase.records;
}

export async function listTrackingRecords(filters: { assetId?: string; segmentId?: string; trackId?: string } = {}) {
  await ensureTrackingStore();
  return trackingDatabase.records
    .filter((record) => !filters.assetId || record.assetId === filters.assetId)
    .filter((record) => !filters.segmentId || record.segmentId === filters.segmentId)
    .filter((record) => !filters.trackId || record.trackId === filters.trackId || record.linkedTrackId === filters.trackId)
    .sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
}

export async function getTrackingSummary(assetId?: string): Promise<TrackingSummary> {
  const records = await listTrackingRecords({ assetId });
  const trackedSegments = new Set(records.map((record) => record.segmentId)).size;
  const updatedAt = records.map((record) => record.updatedAt).sort().at(-1) ?? null;
  return {
    assetId,
    records: records.length,
    players: records.filter((record) => record.trackType === "player").length,
    balls: records.filter((record) => record.trackType === "ball").length,
    links: records.filter((record) => record.trackType === "link").length,
    trackedSegments,
    updatedAt
  };
}

function buildTrackingRecords(asset: AssetRecord) {
  const now = new Date().toISOString();
  return asset.timeline.flatMap((segment) => trackingRecordsForSegment(asset, segment, now));
}

function trackingRecordsForSegment(asset: AssetRecord, segment: TimelineSegment, now: string): TrackingRecord[] {
  const vision = segment.sceneData?.vision;
  const tracking = vision?.tracking;
  if (!vision || !tracking) return [];
  const event = trustedDomainEvents(segment)[0] ?? null;
  const football = event?.football;
  const americanFootball = event?.americanFootball;
  const player =
    football?.receivingPlayer.identity?.name ??
    football?.passingPlayer.identity?.name ??
    americanFootball?.quarterback.identity?.name ??
    segment.domain?.scope?.players[0]?.value ??
    null;
  const base = {
    indexId: asset.indexId,
    assetId: asset.id,
    segmentId: segment.id,
    start: segment.start,
    end: segment.end,
    frameAt: vision.frameAt,
    status: tracking.status,
    confidence: tracking.continuity,
    fieldZone: vision.fieldZone.zone,
    direction: tracking.ballMovement.direction,
    speedPerSecond: tracking.ballMovement.speedPerSecond,
    normalizedDistance: vision.proximity?.normalizedDistance ?? null,
    player,
    event: event?.eventType ?? vision.eventClassification?.label ?? null,
    createdAt: now,
    updatedAt: now
  } satisfies Omit<TrackingRecord, "id" | "trackType" | "trackId" | "linkedTrackId" | "evidence">;
  const records: TrackingRecord[] = [];
  if (tracking.ballTrackId) {
    records.push({
      ...base,
      id: `${asset.id}:${segment.id}:ball:${tracking.ballTrackId}`,
      trackType: "ball",
      trackId: tracking.ballTrackId,
      linkedTrackId: tracking.nearestPlayerTrackId,
      evidence: [
        `Ball track ${tracking.ballTrackId}`,
        `Direction ${tracking.ballMovement.direction}`,
        tracking.ballMovement.speedPerSecond !== null ? `Speed ${tracking.ballMovement.speedPerSecond}` : ""
      ].filter(Boolean)
    });
  }
  if (tracking.nearestPlayerTrackId) {
    records.push({
      ...base,
      id: `${asset.id}:${segment.id}:player:${tracking.nearestPlayerTrackId}`,
      trackType: "player",
      trackId: tracking.nearestPlayerTrackId,
      linkedTrackId: tracking.ballTrackId,
      evidence: [
        `Nearest player track ${tracking.nearestPlayerTrackId}`,
        vision.proximity?.ballNearPlayer ? "Ball near player" : "Nearest player linked by center distance",
        player ? `Resolved player ${player}` : ""
      ].filter(Boolean)
    });
  }
  if (tracking.ballTrackId && tracking.nearestPlayerTrackId) {
    records.push({
      ...base,
      id: `${asset.id}:${segment.id}:link:${tracking.ballTrackId}:${tracking.nearestPlayerTrackId}`,
      trackType: "link",
      trackId: tracking.ballTrackId,
      linkedTrackId: tracking.nearestPlayerTrackId,
      confidence: Math.max(tracking.continuity, vision.proximity?.confidence ?? 0),
      evidence: [
        `Linked ${tracking.ballTrackId} to ${tracking.nearestPlayerTrackId}`,
        vision.proximity?.normalizedDistance !== null && vision.proximity?.normalizedDistance !== undefined ? `Distance ${vision.proximity.normalizedDistance}` : "",
        event?.caption ?? ""
      ].filter(Boolean)
    });
  }
  return records;
}

function normalizeTrackingDatabase(value: Partial<TrackingDatabase>): TrackingDatabase {
  return {
    records: Array.isArray(value.records) ? value.records : []
  };
}

async function persistTrackingStore() {
  writeChain = writeChain.then(() => writeJsonFile(trackingPath, trackingDatabase));
  await writeChain;
}
