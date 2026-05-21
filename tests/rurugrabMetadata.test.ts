import assert from "node:assert/strict";
import test from "node:test";
import { externalMetadataToSearchText } from "../shared/externalMetadata";
import type { AssetRecord, ExternalMediaMetadata, IndexRecord, TimelineSegment } from "../shared/types";
import { searchAssets } from "../server/intelligence";
import { deriveAppearanceVectors } from "../server/appearanceSimilarity";
import { extractRurugrabMediaKeyCandidates, mergeRurugrabMetadataIntoAsset } from "../server/metadata/rurugrab";

test("Rurugrab product-code extraction handles display and provider filename variants", () => {
  const candidates = extractRurugrabMediaKeyCandidates("library/KNMB-085 h_491knmb00085.mp4");
  const keys = candidates.map((candidate) => candidate.mediaKeyNorm);

  assert.ok(keys.includes("KNMB085"));
  assert.equal(candidates.find((candidate) => candidate.mediaKeyNorm === "KNMB085")?.mediaDisplayKey, "KNMB-085");
});

test("Rurugrab product-code extraction handles numeric-prefix and dated catalog variants", () => {
  const candidates = extractRurugrabMediaKeyCandidates("1pondo-012345_001 carib-071214-001 FC2-PPV-1234567");
  const displays = candidates.map((candidate) => candidate.mediaDisplayKey);

  assert.ok(displays.includes("1PONDO-012345"));
  assert.ok(displays.includes("CARIB-071214-001"));
  assert.ok(displays.includes("FC2-PPV-1234567"));
});

test("Rurugrab metadata merge adds searchable catalog tags and trace", () => {
  const asset = assetFixture();
  const metadata = metadataFixture();
  const merged = mergeRurugrabMetadataIntoAsset(asset, metadata, "2026-05-21T00:00:00.000Z");

  assert.equal(merged.externalMetadata?.rurugrab?.status, "matched");
  assert.ok(merged.tags.includes("ABCD-123"));
  assert.ok(merged.tags.includes("Example Performer"));
  assert.ok(merged.intelligence.modelTrace.includes("metadata:rurugrab:matched:ABCD-123:providers=4"));
});

test("Indexed catalog metadata tags can retrieve a matching work even when moment text is generic", () => {
  const asset = {
    ...assetFixture(),
    status: "indexed" as const,
    externalMetadata: { rurugrab: metadataFixture() },
    timeline: [segmentFixture({ id: "generic-moment", transcript: "quiet indoor close-up", tags: ["metadata", "Example Performer"] })]
  };

  const results = searchAssets([asset], [indexFixture()], "Example Performer 출연 작품 찾아줘", {
    queryVector: [0, 1]
  });

  assert.deepEqual(results.map((result) => result.asset.id), ["asset-1"]);
  assert.deepEqual(results[0]?.segments.map((segment) => segment.id), ["generic-moment"]);
});

test("Catalog scene tags rank the specific work over a generic metadata-only asset", () => {
  const matching = {
    ...assetFixture("asset-matching"),
    status: "indexed" as const,
    externalMetadata: { rurugrab: metadataFixture() },
    timeline: [segmentFixture({ id: "scene-tagged", transcript: "quiet indoor moment", tags: ["metadata", "close-up", "Example Performer"] })]
  };
  const generic = {
    ...assetFixture("asset-generic"),
    status: "indexed" as const,
    title: "Generic title",
    originalName: "generic.mp4",
    timeline: [segmentFixture({ id: "generic", transcript: "quiet indoor moment", tags: ["metadata"] })]
  };

  const results = searchAssets([generic, matching], [indexFixture()], "Example Performer close-up 장면 찾아줘", {
    queryVector: [0, 1]
  });

  assert.deepEqual(results.map((result) => result.asset.id), ["asset-matching"]);
});

test("Appearance vectors are derived as candidate-only keyframe contexts from catalog metadata", () => {
  const asset = {
    ...assetFixture(),
    status: "indexed" as const,
    externalMetadata: { rurugrab: metadataFixture() },
    tags: ["ABCD-123", "Example Performer"],
    timeline: [segmentFixture({ id: "appearance-segment", tags: ["metadata:rurugrab", "Example Performer"] })]
  };

  const records = deriveAppearanceVectors(asset, [
    {
      id: "asset-1:keyframe-1",
      indexId: "index-1",
      assetId: "asset-1",
      segmentId: "appearance-segment",
      keyframeId: "keyframe-1",
      keyframePath: "generated/keyframe.jpg",
      start: 0,
      end: 30,
      vector: [0, 1],
      model: "fixture"
    }
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0]?.subjectLabel, "Example Performer");
  assert.equal(records[0]?.clusterSize, 1);
  assert.equal(records[0]?.clusterRank, 1);
  assert.ok(records[0]?.metadataTags.includes("Example Performer"));
});

test("Appearance vectors assign deterministic clusters for visually similar candidates", () => {
  const asset = {
    ...assetFixture(),
    status: "indexed" as const,
    externalMetadata: { rurugrab: metadataFixture() },
    tags: ["ABCD-123", "Example Performer"],
    timeline: [
      segmentFixture({ id: "appearance-a", tags: ["metadata:rurugrab", "Example Performer"] }),
      segmentFixture({ id: "appearance-b", start: 30, end: 60, tags: ["metadata:rurugrab", "Example Performer"] }),
      segmentFixture({ id: "appearance-c", start: 60, end: 90, tags: ["metadata:rurugrab", "Example Performer"] })
    ]
  };

  const records = deriveAppearanceVectors(asset, [
    visualRecordFixture({ id: "asset-1:keyframe-1", segmentId: "appearance-a", keyframeId: "keyframe-1", start: 0, end: 30, vector: [1, 0] }),
    visualRecordFixture({ id: "asset-1:keyframe-2", segmentId: "appearance-b", keyframeId: "keyframe-2", start: 30, end: 60, vector: [0.99, 0.01] }),
    visualRecordFixture({ id: "asset-1:keyframe-3", segmentId: "appearance-c", keyframeId: "keyframe-3", start: 60, end: 90, vector: [0, 1] })
  ]);

  const firstCluster = records.filter((record) => record.clusterId === "asset-1:appearance-cluster-001");
  const secondCluster = records.filter((record) => record.clusterId === "asset-1:appearance-cluster-002");
  assert.equal(firstCluster.length, 2);
  assert.equal(secondCluster.length, 1);
  assert.deepEqual(firstCluster.map((record) => record.clusterSize), [2, 2]);
  assert.deepEqual(firstCluster.map((record) => record.clusterRank).sort(), [1, 2]);
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
    localizedTitles: [],
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
    storedName: "local-s3/videos/asset-1/source.mp4",
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
      objectKey: "asset-1/source.mp4",
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

function visualRecordFixture(overrides: {
  id: string;
  segmentId: string;
  keyframeId: string;
  start: number;
  end: number;
  vector: number[];
}) {
  return {
    indexId: "index-1",
    assetId: "asset-1",
    keyframePath: `generated/${overrides.keyframeId}.jpg`,
    model: "fixture",
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
    assetIds: ["asset-1"],
    status: "ready",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z"
  };
}
