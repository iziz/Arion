import type {
  AssetRecord,
  IdentityEvidenceItem,
  IdentityReviewPatchRequest,
  IdentityReviewPatchResult,
  PlayerIdentityCandidate,
  SegmentIdentityContext,
  TimelineSegment,
  TrackIdentityAssignment
} from "../shared/types";

export class IdentityReviewError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "IdentityReviewError";
  }
}

export function applyIdentityReviewPatch(
  asset: AssetRecord,
  request: IdentityReviewPatchRequest,
  reviewedAt = new Date().toISOString()
): IdentityReviewPatchResult {
  const status = normalizeReviewStatus(request.status);
  const segmentIndex = asset.timeline.findIndex((segment) => segment.id === request.segmentId);
  if (segmentIndex < 0) throw new IdentityReviewError("Segment not found for identity review.", 404);

  const segment = asset.timeline[segmentIndex];
  if (!segment.identity) throw new IdentityReviewError("Segment has no identity candidates to review.", 409);

  const target = normalizeCandidateTarget(request);
  const reviewedSegment = reviewSegmentIdentity(segment, target, status, request.reviewer, reviewedAt);
  const reviewedCandidate = reviewedSegment.reviewedCandidate;
  const nextTimeline = asset.timeline.map((item, index) => (index === segmentIndex ? reviewedSegment.segment : item));
  const nextAssetIdentity = asset.identity ? reviewAssetIdentity(asset.identity, target, reviewedCandidate, reviewedAt) : undefined;
  const trace = `identity-review:${request.segmentId}:${reviewedCandidate.trackId ?? "no-track"}:${reviewedCandidate.playerId ?? reviewedCandidate.canonicalName ?? "unknown"}:${status}`;

  const nextAsset: AssetRecord = {
    ...asset,
    timeline: nextTimeline,
    identity: nextAssetIdentity,
    intelligence: {
      ...asset.intelligence,
      modelTrace: uniqueStrings([...asset.intelligence.modelTrace, trace])
    },
    updatedAt: reviewedAt
  };

  return {
    asset: nextAsset,
    segmentId: request.segmentId,
    candidate: reviewedCandidate,
    updatedAt: reviewedAt
  };
}

function reviewSegmentIdentity(
  segment: TimelineSegment,
  target: CandidateTarget,
  status: IdentityReviewPatchRequest["status"],
  reviewer: string | null | undefined,
  reviewedAt: string
): { segment: TimelineSegment; reviewedCandidate: PlayerIdentityCandidate } {
  const identity = segment.identity;
  if (!identity) throw new IdentityReviewError("Segment has no identity candidates to review.", 409);
  const update = reviewCandidates(identity.playerIdentityCandidates, target, status, reviewer, reviewedAt);
  if (!update.reviewedCandidate) throw new IdentityReviewError("Identity candidate not found for review.", 404);
  const nextIdentity: SegmentIdentityContext = {
    ...identity,
    playerIdentityCandidates: update.candidates,
    trackIdentityAssignments: rebuildTrackAssignments(update.candidates)
  };
  return {
    segment: {
      ...segment,
      identity: nextIdentity
    },
    reviewedCandidate: update.reviewedCandidate
  };
}

function reviewAssetIdentity(
  identity: NonNullable<AssetRecord["identity"]>,
  target: CandidateTarget,
  reviewedCandidate: PlayerIdentityCandidate,
  reviewedAt: string
): NonNullable<AssetRecord["identity"]> {
  const status = reviewedCandidate.status === "confirmed" || reviewedCandidate.status === "rejected" ? reviewedCandidate.status : "confirmed";
  const update = reviewCandidates(identity.playerIdentityCandidates, target, status, null, null, reviewedCandidate);
  const candidates = update.updatedCount > 0 ? update.candidates : dedupeCandidates([...identity.playerIdentityCandidates, reviewedCandidate]);
  return {
    ...identity,
    playerIdentityCandidates: candidates,
    trackIdentityAssignments: rebuildTrackAssignments(candidates),
    updatedAt: reviewedAt
  };
}

function reviewCandidates(
  candidates: PlayerIdentityCandidate[],
  target: CandidateTarget,
  status: IdentityReviewPatchRequest["status"],
  reviewer: string | null | undefined,
  reviewedAt: string | null,
  replacement?: PlayerIdentityCandidate
) {
  let reviewedCandidate: PlayerIdentityCandidate | null = null;
  let updatedCount = 0;
  const nextCandidates = candidates.map((candidate) => {
    if (!candidateMatches(candidate, target)) return candidate;
    updatedCount += 1;
    const next = replacement ?? reviewCandidate(candidate, status, reviewer, reviewedAt ?? new Date().toISOString());
    reviewedCandidate = next;
    return next;
  });
  return {
    candidates: dedupeCandidates(nextCandidates),
    reviewedCandidate,
    updatedCount
  };
}

function reviewCandidate(
  candidate: PlayerIdentityCandidate,
  status: IdentityReviewPatchRequest["status"],
  reviewer: string | null | undefined,
  reviewedAt: string
): PlayerIdentityCandidate {
  const reviewerText = reviewer?.trim() || "operator";
  const evidence: IdentityEvidenceItem = {
    source: "metadata",
    value: `Manual review ${status} by ${reviewerText} at ${reviewedAt}`,
    confidence: 1
  };
  return {
    ...candidate,
    status,
    confidence: status === "confirmed" ? Number(Math.max(candidate.confidence, 0.98).toFixed(2)) : 0,
    evidence: dedupeEvidenceItems([...candidate.evidence, evidence])
  };
}

function rebuildTrackAssignments(candidates: PlayerIdentityCandidate[]): TrackIdentityAssignment[] {
  return dedupeCandidates(candidates)
    .filter((candidate): candidate is TrackIdentityAssignment => Boolean(candidate.trackId) && candidate.status !== "rejected")
    .sort((left, right) => right.confidence - left.confidence);
}

function normalizeReviewStatus(status: unknown): IdentityReviewPatchRequest["status"] {
  if (status === "confirmed" || status === "rejected") return status;
  throw new IdentityReviewError("Identity review status must be confirmed or rejected.");
}

type CandidateTarget = Required<IdentityReviewPatchRequest["candidate"]>;

function normalizeCandidateTarget(request: IdentityReviewPatchRequest): CandidateTarget {
  if (!request.candidate || typeof request.candidate !== "object") {
    throw new IdentityReviewError("Identity review candidate target is required.");
  }
  const target = {
    trackId: request.candidate.trackId ?? null,
    playerId: request.candidate.playerId ?? null,
    canonicalName: request.candidate.canonicalName ?? null,
    matchContextId: request.candidate.matchContextId ?? null,
    videoRange: request.candidate.videoRange ?? null
  };
  if (!target.trackId && !target.playerId && !target.canonicalName) {
    throw new IdentityReviewError("Identity review candidate target must include trackId, playerId, or canonicalName.");
  }
  return target;
}

function candidateMatches(candidate: PlayerIdentityCandidate, target: CandidateTarget) {
  if ((candidate.trackId ?? null) !== target.trackId) return false;
  if ((candidate.playerId ?? null) !== target.playerId) return false;
  if ((candidate.canonicalName ?? null) !== target.canonicalName) return false;
  if ((candidate.matchContextId ?? null) !== target.matchContextId) return false;
  if (target.videoRange) {
    return candidate.videoRange.start === target.videoRange.start && candidate.videoRange.end === target.videoRange.end;
  }
  return true;
}

function dedupeCandidates(candidates: PlayerIdentityCandidate[]) {
  const byKey = new Map<string, PlayerIdentityCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.matchContextId ?? "unknown"}:${candidate.trackId ?? "no-track"}:${candidate.playerId ?? candidate.canonicalName ?? "unknown"}:${candidate.videoRange.start}:${candidate.videoRange.end}`;
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence || candidate.status === "confirmed") byKey.set(key, candidate);
  }
  return Array.from(byKey.values()).sort((left, right) => right.confidence - left.confidence);
}

function dedupeEvidenceItems(items: IdentityEvidenceItem[]) {
  const byKey = new Map<string, IdentityEvidenceItem>();
  for (const item of items) {
    const key = `${item.source}:${item.value}`;
    const existing = byKey.get(key);
    if (!existing || item.confidence > existing.confidence) byKey.set(key, item);
  }
  return Array.from(byKey.values()).sort((left, right) => right.confidence - left.confidence || left.source.localeCompare(right.source));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
