import type { AssetRecord, TimelineSegment, TrackingRecord, TrackingSummary } from "../shared/types";
import { trustedDomainEvents } from "./evidenceTrust";
import * as pgStore from "./postgresStore";

export async function ensureTrackingStore() {
  assertPostgresRuntime();
  await pgStore.ensurePostgresStore();
}

export async function upsertAssetTracking(asset: AssetRecord) {
  assertPostgresRuntime();
  return pgStore.upsertTrackingRecords(asset.id, buildTrackingRecords(asset));
}

export async function rebuildTrackingStore(assets: AssetRecord[]) {
  assertPostgresRuntime();
  return pgStore.rebuildTrackingRecords(assets.flatMap((asset) => buildTrackingRecords(asset)));
}

export async function listTrackingRecords(filters: { assetId?: string; segmentId?: string; trackId?: string } = {}) {
  assertPostgresRuntime();
  return pgStore.listTrackingRecords(filters);
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
  const nearestPlayerTrack = tracking.nearestPlayerTrackId ? tracking.playerTracks?.find((track) => track.id === tracking.nearestPlayerTrackId) ?? null : null;
  const event = trustedDomainEvents(segment)[0] ?? null;
  const football = event?.football;
  const americanFootball = event?.americanFootball;
  const confirmedTrackIdentity = segment.identity?.trackIdentityAssignments.find(
    (candidate) => candidate.status === "confirmed" && candidate.trackId === tracking.nearestPlayerTrackId
  );
  const player =
    confirmedTrackIdentity?.canonicalName ??
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
    teamCluster: nearestPlayerTrack?.teamCluster,
    teamConfidence: nearestPlayerTrack?.teamConfidence,
    appearance: nearestPlayerTrack?.appearance,
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
        ...(nearestPlayerTrack?.teamEvidence ?? []),
        ...(nearestPlayerTrack?.jerseyNumberCandidates?.slice(0, 2).map((candidate) => `Jersey crop OCR #${candidate.number} (${Math.round(candidate.confidence * 100)}%)`) ?? []),
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
        ...(nearestPlayerTrack?.teamEvidence ?? []),
        event?.caption ?? ""
      ].filter(Boolean)
    });
  }
  return records;
}

function assertPostgresRuntime() {
  if (!pgStore.isPostgresEnabled()) {
    throw new Error("PostgreSQL tracking persistence is required. Set DATABASE_URL or run through Docker infra.");
  }
}
