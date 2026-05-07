import assert from "node:assert/strict";
import test from "node:test";
import type { SearchResult } from "../shared/types";
import { filterSearchResultsByTrust, TRUST_PRESETS } from "../src/searchTrust";

test("balanced trust filtering keeps asset results when at least one segment passes", () => {
  const results = filterSearchResultsByTrust([fixtureSearchResult()], TRUST_PRESETS.balanced);

  assert.equal(results.length, 1);
  assert.deepEqual(results[0].segments.map((segment) => segment.id), ["segment-pass"]);
  assert.deepEqual(results[0].clips.map((clip) => clip.segmentId), ["segment-pass"]);
  assert.deepEqual(results[0].matchReasons.map((reason) => reason.segmentId), ["segment-pass"]);
  assert.match(results[0].explain.at(-1) ?? "", /1\/2 moments passed current evidence threshold/);
});

test("balanced trust filtering hides asset results when every segment fails", () => {
  const source = fixtureSearchResult();
  const failedOnly = {
    ...source,
    segments: source.segments.filter((segment) => segment.id === "segment-fail"),
    clips: source.clips.filter((clip) => clip.segmentId === "segment-fail"),
    matchReasons: source.matchReasons.filter((reason) => reason.segmentId === "segment-fail")
  };

  const results = filterSearchResultsByTrust([failedOnly], TRUST_PRESETS.balanced);

  assert.equal(results.length, 0);
});

function fixtureSearchResult(): SearchResult {
  return {
    asset: { id: "asset-1", title: "Fixture asset" },
    index: null,
    segments: [
      { id: "segment-pass", embedding: [] },
      {
        id: "segment-fail",
        embedding: [],
        sceneData: {
          vlm: {
            status: "invalid",
            caption: "",
            error: "Invalid VLM output",
            confidence: 0
          }
        }
      }
    ],
    clips: [
      { id: "clip-pass", assetId: "asset-1", segmentId: "segment-pass", title: "Pass", start: 0, end: 1, thumbnailPath: null, event: "pass_receive", player: "Son Heung-min", confidence: 0.8, verificationSummary: { pass: 1, softPass: 0, unknown: 0, fail: 0 }, reasons: [] },
      { id: "clip-fail", assetId: "asset-1", segmentId: "segment-fail", title: "Fail", start: 1, end: 2, thumbnailPath: null, event: "pass_receive", player: "Son Heung-min", confidence: 0.8, verificationSummary: { pass: 1, softPass: 0, unknown: 0, fail: 0 }, reasons: [] }
    ],
    score: 1,
    ranking: { lexical: 0, semantic: 0, visual: 0, source: 0, confidence: 0, recency: 0, total: 1 },
    explain: ["fixture"],
    queryPlan: null,
    knowledgeEvidence: [],
    matchReasons: [
      { segmentId: "segment-pass", kind: "lexical", label: "Text", value: "pass", confidence: 0.8 },
      { segmentId: "segment-fail", kind: "lexical", label: "Text", value: "pass", confidence: 0.8 }
    ],
    verification: []
  } as unknown as SearchResult;
}
