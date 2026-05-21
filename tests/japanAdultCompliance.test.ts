import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJapanAdultCompliance, japanAdultRequiredTags } from "../server/compliance/japanAdult";
import type { AssetRecord, IndexRecord } from "../shared/types";

test("Japan adult compliance is not applied outside the adult.jp_legal source", () => {
  const result = evaluateJapanAdultCompliance(assetFixture(), indexFixture([]));

  assert.equal(result.status, "not_applicable");
  assert.equal(result.checks.length, 0);
});

test("Japan adult compliance clears only when all required metadata tags are present", () => {
  const result = evaluateJapanAdultCompliance(assetFixture({ tags: [...japanAdultRequiredTags] }), indexFixture(["adult.jp_legal"]));

  assert.equal(result.status, "cleared");
  assert.equal(result.checks.every((check) => check.status === "passed"), true);
});

test("Japan adult compliance requires review when mandatory metadata is missing", () => {
  const result = evaluateJapanAdultCompliance(assetFixture({ tags: ["jp-adult:age-verified"] }), indexFixture(["adult.jp_legal"]));

  assert.equal(result.status, "review_required");
  assert.ok(result.checks.some((check) => check.id === "consent-contract" && check.status === "missing"));
});

test("Japan adult compliance blocks explicit blocker tags even when required tags are present", () => {
  const result = evaluateJapanAdultCompliance(
    assetFixture({ tags: [...japanAdultRequiredTags, "jp-adult:block:takedown-requested"] }),
    indexFixture(["adult.jp_legal"])
  );

  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("Explicit compliance block tag"));
});

function indexFixture(groups: string[]): Pick<IndexRecord, "domainIndexing"> {
  return {
    domainIndexing: {
      enabled: groups.length > 0,
      groups,
      stages: ["domain_caption", "event_label", "structured_event"]
    }
  };
}

function assetFixture(overrides: Partial<Pick<AssetRecord, "title" | "description" | "originalName" | "tags" | "summary" | "timeline">> = {}) {
  return {
    title: "Compliance fixture",
    description: "",
    originalName: "fixture.mp4",
    tags: [],
    summary: "",
    timeline: [],
    intelligence: {
      audio: { extractedPath: null, vad: { available: false, provider: "none", error: null }, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
      asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0, frames: [] },
      visual: { available: false, labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0, error: null },
      modelTrace: []
    },
    ...overrides
  };
}
