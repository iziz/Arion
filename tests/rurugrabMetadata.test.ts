import assert from "node:assert/strict";
import test from "node:test";
import { externalMetadataToSearchText } from "../shared/externalMetadata";
import type { AssetRecord, ExternalMediaMetadata, IndexRecord, TimelineSegment } from "../shared/types";
import { searchAssets } from "../server/intelligence";
import { extractRurugrabMediaKeyCandidates, mergeRurugrabMetadataIntoAsset } from "../server/metadata/rurugrab";

test("Rurugrab product-code extraction handles display and provider filename variants", () => {
  const candidates = extractRurugrabMediaKeyCandidates("library/KNMB-085 h_491knmb00085.mp4");
  const keys = candidates.map((candidate) => candidate.mediaKeyNorm);

  assert.ok(keys.includes("KNMB085"));
  assert.equal(candidates.find((candidate) => candidate.mediaKeyNorm === "KNMB085")?.mediaDisplayKey, "KNMB-085");
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

function assetFixture(): AssetRecord {
  return {
    id: "asset-1",
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
