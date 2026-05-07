import assert from "node:assert/strict";
import test from "node:test";
import { buildAssetOverviewSummary } from "../src/components/ConsoleLayout";

test("asset overview parses extractive summary sections for readable display", () => {
  const summary =
    "Content summary: 내 아내는 잠을 잘 못 자니 A person wearing a patterned shirt is seen indoors. The individual appears to be in a traditional setting. Evidence coverage: 40 timeline segments; 40 moment summaries; sources metadata=40, shot=40, visual=40, whisper=35, paddleocr=1; VLM descriptions 40. Metadata terms: 21세기, 대군부인, 자가.";

  const parsed = buildAssetOverviewSummary(summary);

  assert.deepEqual(parsed.content.slice(0, 3), [
    "내 아내는 잠을 잘 못 자니",
    "A person wearing a patterned shirt is seen indoors.",
    "The individual appears to be in a traditional setting"
  ]);
  assert.deepEqual(parsed.evidence, [
    "40 timeline segments",
    "40 moment summaries",
    "sources metadata=40",
    "shot=40",
    "visual=40",
    "whisper=35",
    "paddleocr=1",
    "VLM descriptions 40"
  ]);
  assert.deepEqual(parsed.metadataTerms, ["21세기", "대군부인", "자가"]);
});

test("asset overview keeps legacy evidence source summaries readable", () => {
  const parsed = buildAssetOverviewSummary("This asset was indexed into 2 timeline segments using text-embedding-3-small Evidence sources: whisper=2, visual=2. Metadata terms: goal, replay.");

  assert.deepEqual(parsed.content, ["Indexed into 2 timeline segments with text-embedding-3-small."]);
  assert.deepEqual(parsed.evidence, ["whisper=2", "visual=2"]);
  assert.deepEqual(parsed.metadataTerms, ["goal", "replay"]);
});
