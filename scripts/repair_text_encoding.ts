import "../server/env";
import { closePostgresStore, isPostgresEnabled } from "../server/postgresStore";
import { listAssets, saveAsset } from "../server/store";
import { normalizePossiblyMojibake } from "../server/textEncoding";
import type { AssetRecord, KeyframeRecord, LocalIntelligence, TimelineSegment } from "../shared/types";

let repairedAssets = 0;
let repairedFields = 0;

for (const asset of await listAssets()) {
  const repaired = repairAsset(asset);
  if (JSON.stringify(repaired) !== JSON.stringify(asset)) {
    repairedAssets += 1;
    await saveAsset({
      ...repaired,
      updatedAt: new Date().toISOString()
    });
  }
}

console.log(JSON.stringify({ ok: true, repairedAssets, repairedFields }, null, 2));

if (isPostgresEnabled()) await closePostgresStore();

function repairAsset(asset: AssetRecord): AssetRecord {
  return {
    ...asset,
    title: repairText(asset.title),
    description: repairText(asset.description),
    originalName: repairText(asset.originalName),
    tags: asset.tags.map(repairText),
    summary: repairText(asset.summary),
    timeline: asset.timeline.map(repairTimelineSegment),
    keyframes: asset.keyframes.map(repairKeyframe),
    intelligence: repairIntelligence(asset.intelligence)
  };
}

function repairTimelineSegment(segment: TimelineSegment): TimelineSegment {
  return {
    ...segment,
    label: repairText(segment.label),
    transcript: repairText(segment.transcript),
    tags: segment.tags.map(repairText)
  };
}

function repairKeyframe(keyframe: KeyframeRecord): KeyframeRecord {
  return {
    ...keyframe,
    path: repairText(keyframe.path)
  };
}

function repairIntelligence(intelligence: LocalIntelligence): LocalIntelligence {
  return {
    ...intelligence,
    asr: {
      ...intelligence.asr,
      transcript: repairText(intelligence.asr.transcript),
      language: repairText(intelligence.asr.language),
      segments: intelligence.asr.segments.map((segment) => ({
        ...segment,
        text: repairText(segment.text)
      }))
    },
    ocr: {
      ...intelligence.ocr,
      tokens: intelligence.ocr.tokens.map(repairText),
      frames: intelligence.ocr.frames.map((frame) => ({
        ...frame,
        framePath: repairText(frame.framePath),
        tokens: frame.tokens.map(repairText),
        boxes: frame.boxes?.map((box) => ({
          ...box,
          text: repairText(box.text)
        }))
      }))
    },
    visual: {
      ...intelligence.visual,
      labels: intelligence.visual.labels.map(repairText),
      dominantColor: repairText(intelligence.visual.dominantColor)
    },
    modelTrace: intelligence.modelTrace.map(repairText)
  };
}

function repairText(value: string) {
  const repaired = normalizePossiblyMojibake(value);
  if (repaired !== value) repairedFields += 1;
  return repaired;
}
