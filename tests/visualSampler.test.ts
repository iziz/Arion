import assert from "node:assert/strict";
import test from "node:test";
import { summarizeVisualFrameBytes } from "../server/modelRuntime/visualSampler";

test("coarse visual profile frame-change score compares matching pixels across frames", () => {
  const firstFrame = Buffer.from([0, 0, 0, 255, 255, 255]);
  const secondFrame = Buffer.from([0, 0, 0, 255, 255, 255]);
  const summary = summarizeVisualFrameBytes(Buffer.concat([firstFrame, secondFrame]), 2, 1);

  assert.equal(summary.motionScore, 0);
  assert.deepEqual(summary.labels.filter((label) => label.includes("frame-change")), ["low-frame-change"]);
});

test("coarse visual profile frame-change score detects temporal changes", () => {
  const firstFrame = Buffer.from([0, 0, 0, 0, 0, 0]);
  const secondFrame = Buffer.from([255, 255, 255, 255, 255, 255]);
  const summary = summarizeVisualFrameBytes(Buffer.concat([firstFrame, secondFrame]), 2, 1);

  assert.equal(summary.motionScore, 1);
  assert.deepEqual(summary.labels.filter((label) => label.includes("frame-change")), ["high-frame-change"]);
});
