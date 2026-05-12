import assert from "node:assert/strict";
import test from "node:test";
import type { AssetRecord, IdentityReviewPatchRequest, PlayerIdentityCandidate, TimelineSegment } from "../shared/types";
import { applyIdentityReviewPatch, IdentityReviewError } from "../server/identityReview";

test("identity review confirmation persists candidate status across segment and asset identity", () => {
  const result = applyIdentityReviewPatch(assetFixture(), request("confirmed"), "2026-05-12T00:00:00.000Z");
  const segmentCandidate = result.asset.timeline[0].identity?.playerIdentityCandidates[0];
  const assetCandidate = result.asset.identity?.playerIdentityCandidates[0];

  assert.equal(segmentCandidate?.status, "confirmed");
  assert.equal(segmentCandidate?.confidence, 0.98);
  assert.equal(segmentCandidate?.evidence.some((item) => item.source === "metadata" && item.value.includes("Manual review confirmed")), true);
  assert.equal(assetCandidate?.status, "confirmed");
  assert.equal(result.asset.timeline[0].identity?.trackIdentityAssignments[0]?.status, "confirmed");
  assert.equal(result.asset.identity?.trackIdentityAssignments[0]?.status, "confirmed");
  assert.equal(result.asset.intelligence.modelTrace.includes("identity-review:seg-1:person-7:p7:confirmed"), true);
});

test("identity review rejection removes rejected candidates from track assignments", () => {
  const result = applyIdentityReviewPatch(assetFixture(), request("rejected"), "2026-05-12T00:00:00.000Z");
  const segmentIdentity = result.asset.timeline[0].identity;

  assert.equal(segmentIdentity?.playerIdentityCandidates[0]?.status, "rejected");
  assert.equal(segmentIdentity?.playerIdentityCandidates[0]?.confidence, 0);
  assert.equal(segmentIdentity?.trackIdentityAssignments.length, 0);
  assert.equal(result.asset.identity?.trackIdentityAssignments.length, 0);
});

test("identity review fails when the candidate target is missing", () => {
  assert.throws(
    () =>
      applyIdentityReviewPatch(
        assetFixture(),
        {
          ...request("confirmed"),
          candidate: { trackId: "person-404", playerId: "missing", canonicalName: "Missing Player", matchContextId: "matchctx-1", videoRange: { start: 0, end: 6 } }
        },
        "2026-05-12T00:00:00.000Z"
      ),
    (error) => error instanceof IdentityReviewError && error.statusCode === 404
  );
});

function request(status: IdentityReviewPatchRequest["status"]): IdentityReviewPatchRequest {
  return {
    segmentId: "seg-1",
    status,
    reviewer: "test",
    candidate: {
      trackId: "person-7",
      playerId: "p7",
      canonicalName: "Test Player",
      matchContextId: "matchctx-1",
      videoRange: { start: 0, end: 6 }
    }
  };
}

function assetFixture(): AssetRecord {
  const candidate: PlayerIdentityCandidate = {
    trackId: "person-7",
    playerId: "p7",
    canonicalName: "Test Player",
    team: "Test FC",
    shirtNumber: 7,
    matchContextId: "matchctx-1",
    videoRange: { start: 0, end: 6 },
    matchClock: null,
    confidence: 0.61,
    status: "candidate",
    evidence: [{ source: "jersey_ocr", value: "Jersey number 7", confidence: 0.64 }]
  };
  const segment: TimelineSegment = {
    id: "seg-1",
    start: 0,
    end: 6,
    label: "Segment 1",
    transcript: "Test Player on ball.",
    identity: {
      matchContextIds: ["matchctx-1"],
      clockMappings: [],
      activeRosterWindows: [],
      playerIdentityCandidates: [candidate],
      trackIdentityAssignments: [{ ...candidate, trackId: "person-7" }],
      teamClusterAssignments: []
    },
    tags: [],
    modalities: ["visual"],
    confidence: 0.8,
    embedding: [],
    thumbnailPath: null,
    sources: ["visual"]
  };
  return {
    id: "asset-1",
    indexId: "idx-1",
    title: "Identity review fixture",
    description: "",
    originalName: "fixture.mp4",
    storedName: "fixture.mp4",
    mimeType: "video/mp4",
    size: 1,
    duration: 6,
    width: 1920,
    height: 1080,
    status: "indexed",
    progress: 100,
    tags: [],
    summary: "",
    timeline: [segment],
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "test",
      objectKey: "fixture.mp4",
      checksum: null,
      frameRate: 25,
      audioCodec: "aac",
      videoCodec: "h264"
    },
    intelligence: {
      audio: { extractedPath: null, speechSegments: [], musicSegments: [], hasSpeech: true, hasMusic: false },
      asr: { transcript: "", language: "en", confidence: 0.8, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0.8, frames: [] },
      visual: { labels: [], dominantColor: "#000000", brightness: 0.5, motionScore: 0.1 },
      modelTrace: []
    },
    identity: {
      generatedBy: "test",
      status: "ready",
      matchContexts: [],
      activeRosterWindows: [],
      playerIdentityCandidates: [candidate],
      trackIdentityAssignments: [{ ...candidate, trackId: "person-7" }],
      teamClusterAssignments: [],
      limitations: [],
      updatedAt: "2026-05-11T00:00:00.000Z"
    },
    error: null,
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z"
  };
}
