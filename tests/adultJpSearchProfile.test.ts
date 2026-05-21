import assert from "node:assert/strict";
import test from "node:test";
import { externalMetadataToSearchText } from "../shared/externalMetadata";
import type { AssetRecord, ExternalMediaMetadata, IndexRecord, TimelineSegment } from "../shared/types";
import { searchAssets } from "../server/intelligence";
import { planDomainQuery } from "../server/queryPlanner";
import { evaluateSearchQuality } from "../server/searchEvaluation";

test("adult.jp_search profile extracts catalog and scene metadata constraints", () => {
  const catalogPlan = planDomainQuery("ABCD-123 작품 찾아줘");
  assert.equal(catalogPlan.intent.domain, "adult.jp_search");
  assert.equal(catalogPlan.domainFilters.catalogKey, "ABCD-123");
  assert.ok(catalogPlan.retrieval?.evidenceTerms.includes("abcd-123"));

  const performerPlan = planDomainQuery("Example Performer 출연 인터뷰 장면 찾아줘");
  assert.equal(performerPlan.intent.domain, "adult.jp_search");
  assert.equal(performerPlan.domainFilters.performer, "Example Performer");
  assert.equal(performerPlan.domainFilters.scene, "interview");
  assert.match(performerPlan.rewrittenQuery, /performer=Example Performer/);
});

test("adult.jp_search metadata filters retrieve catalog works without relying on sports filters", () => {
  const matching = {
    ...assetFixture("asset-matching"),
    status: "indexed" as const,
    externalMetadata: { rurugrab: metadataFixture() },
    tags: ["ABCD-123", "Example Performer"],
    timeline: [segmentFixture({ id: "generic-catalog", transcript: "quiet indoor moment", tags: ["metadata"] })]
  };
  const decoy = {
    ...assetFixture("asset-decoy"),
    title: "WXYZ-999",
    originalName: "WXYZ-999.mp4",
    status: "indexed" as const,
    timeline: [segmentFixture({ id: "decoy", transcript: "quiet indoor moment", tags: ["metadata"] })]
  };
  const plan = planDomainQuery("ABCD-123 작품 찾아줘");

  const results = searchAssets([decoy, matching], [indexFixture()], plan.originalQuery, {
    queryPlan: plan,
    domainFilters: plan.domainFilters
  });

  assert.deepEqual(results.map((result) => result.asset.id), ["asset-matching"]);
  assert.deepEqual(results[0]?.segments.map((segment) => segment.id), ["generic-catalog"]);
  assert.ok(results[0]?.verification.some((check) => check.constraint === "catalogKey" && check.status === "pass"));
});

test("adult.jp_search scene and performer constraints rank matching moments", () => {
  const matching = {
    ...assetFixture("asset-matching"),
    status: "indexed" as const,
    externalMetadata: { rurugrab: metadataFixture() },
    tags: ["ABCD-123", "Example Performer"],
    timeline: [
      segmentFixture({ id: "interview-moment", transcript: "short interview conversation", tags: ["interview", "metadata:rurugrab"] }),
      segmentFixture({ id: "other-moment", transcript: "quiet indoor moment", tags: ["metadata:rurugrab"] })
    ]
  };
  const decoy = {
    ...assetFixture("asset-decoy"),
    status: "indexed" as const,
    timeline: [segmentFixture({ id: "decoy-interview", transcript: "short interview conversation", tags: ["interview"] })]
  };
  const plan = planDomainQuery("Example Performer 출연 인터뷰 장면 찾아줘");

  const results = searchAssets([decoy, matching], [indexFixture()], plan.originalQuery, {
    queryPlan: plan,
    domainFilters: plan.domainFilters
  });

  assert.deepEqual(results.map((result) => result.asset.id), ["asset-matching"]);
  assert.deepEqual(results[0]?.segments.map((segment) => segment.id), ["interview-moment"]);
  assert.ok(results[0]?.matchReasons.some((reason) => reason.label === "Performer"));
  assert.ok(results[0]?.matchReasons.some((reason) => reason.label === "Scene"));
});

test("search evaluation harness reports top-k hit quality for adult catalog queries", () => {
  const assets = [
    {
      ...assetFixture("asset-matching"),
      status: "indexed" as const,
      externalMetadata: { rurugrab: metadataFixture() },
      tags: ["ABCD-123", "Example Performer"],
      timeline: [segmentFixture({ id: "interview-moment", transcript: "short interview conversation", tags: ["interview", "metadata:rurugrab"] })]
    },
    {
      ...assetFixture("asset-decoy"),
      status: "indexed" as const,
      timeline: [segmentFixture({ id: "decoy", transcript: "short interview conversation", tags: ["interview"] })]
    }
  ];

  const report = evaluateSearchQuality(
    [
      { id: "catalog-code", query: "ABCD-123 작품 찾아줘", expected: { assetIds: ["asset-matching"], segmentIds: ["interview-moment"] }, topK: 3 },
      { id: "performer-scene", query: "Example Performer 출연 인터뷰 장면 찾아줘", expected: { assetIds: ["asset-matching"], segmentIds: ["interview-moment"] }, topK: 3 }
    ],
    assets,
    [indexFixture()]
  );

  assert.equal(report.summary.cases, 2);
  assert.equal(report.summary.topKHitRate, 1);
  assert.equal(report.summary.meanReciprocalRank, 1);
  assert.equal(report.summary.meanNdcg, 1);
});

function metadataFixture(): ExternalMediaMetadata {
  const metadata: ExternalMediaMetadata = {
    source: "rurugrab",
    status: "matched",
    matchedAt: "2026-05-21T00:00:00.000Z",
    matchConfidence: 0.94,
    matchReason: "product-code:ABCD-123",
    mediaKeyNorm: "ABCD123",
    mediaDisplayKey: "ABCD-123",
    providerCount: 4,
    primaryProvider: "rurugrab-fixture",
    title: "Fixture title",
    localizedTitles: ["フィクスチャ作品"],
    titleVariants: [],
    releaseDate: "2025-01-01",
    runtimeMinutes: 120,
    studio: "Example Studio",
    label: "Example Label",
    series: "Example Series",
    director: "Example Director",
    genres: ["interview", "close-up"],
    performers: ["Example Performer"],
    coverImageUrl: null,
    previewVideoUrl: null,
    sourceUrls: [],
    externalIds: {},
    searchText: ""
  };
  metadata.searchText = externalMetadataToSearchText(metadata);
  return metadata;
}

function assetFixture(id = "asset-1"): AssetRecord {
  return {
    id,
    indexId: "index-1",
    title: "ABCD-123",
    description: "",
    originalName: "ABCD-123.mp4",
    storedName: `local-s3/videos/${id}/source.mp4`,
    mimeType: "video/mp4",
    size: 1,
    duration: 120,
    width: 1920,
    height: 1080,
    status: "queued",
    progress: 0,
    tags: [],
    summary: "",
    timeline: [],
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "videos",
      objectKey: `${id}/source.mp4`,
      checksum: null,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    },
    intelligence: {
      audio: { extractedPath: null, vad: { available: false, provider: "none", error: null }, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
      asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0, frames: [] },
      visual: { available: false, labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0, error: null },
      modelTrace: []
    },
    error: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z"
  };
}

function segmentFixture(overrides: Partial<TimelineSegment> = {}): TimelineSegment {
  return {
    id: "segment-1",
    start: 0,
    end: 30,
    label: "Moment 1",
    transcript: "",
    tags: [],
    modalities: ["metadata"],
    confidence: 0.4,
    embedding: [1, 0],
    thumbnailPath: null,
    sources: ["metadata"],
    ...overrides
  };
}

function indexFixture(): IndexRecord {
  return {
    id: "index-1",
    name: "Fixture index",
    description: "",
    models: { search: "fixture", analysis: "fixture", embedding: "fixture" },
    modalities: ["metadata"],
    assetIds: ["asset-matching", "asset-decoy"],
    status: "ready",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z"
  };
}
