import type { AssetRecord } from "../../../shared/types";
import { unique } from "../textUtils";

export function nearbyOcrFrame(asset: AssetRecord, index: number, start: number, end: number) {
  const frames = asset.intelligence.ocr.frames;
  if (frames.length === 0) return null;
  if (!asset.duration || asset.duration <= 0) return frames.find((frame) => typeof frame.at === "number") ?? null;
  const timestampedFrames = frames.filter((frame) => typeof frame.at === "number");
  if (timestampedFrames.length === 0) return null;
  const midpoint = (start + end) / 2;
  const nearest = timestampedFrames
    .map((frame) => ({ frame, distance: Math.abs((frame.at ?? 0) - midpoint) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const allowedDistance = Math.max(3, Math.min(8, (end - start) / 2 + 2));
  return nearest && nearest.distance <= allowedDistance ? nearest.frame : null;
}

export function ocrEvidenceFromFrame(frame: NonNullable<AssetRecord["intelligence"]["ocr"]["frames"][number]>) {
  const boxes = frame.boxes ?? [];
  if (boxes.length === 0) return { subtitle: [], screenText: cleanOcrValues(unique(frame.tokens)).slice(0, 8), overlay: [] };
  return {
    subtitle: cleanOcrValues(unique(boxes.filter((box) => box.role === "subtitle").map((box) => box.text))).slice(0, 4),
    screenText: cleanOcrValues(unique(boxes.filter((box) => box.role === "screen_text").map((box) => box.text))).slice(0, 5),
    overlay: unique(boxes.filter((box) => box.role === "overlay" || box.role === "watermark").map((box) => box.text)).slice(0, 4)
  };
}

export function formatOcrEvidence(evidence: { subtitle: string[]; screenText: string[]; overlay: string[] }) {
  const parts = [
    evidence.subtitle.length ? `OCR subtitle: ${evidence.subtitle.join(" ")}` : "",
    evidence.screenText.length ? `OCR screen: ${evidence.screenText.join(" ")}` : "",
    evidence.overlay.length ? `OCR overlay: ${evidence.overlay.join(" ")}` : ""
  ].filter(Boolean);
  return parts.length ? `${parts.join(". ")}.` : "";
}

export function isLikelyWatermark(value: string) {
  return /생성형\s*(a|ai)|이\s*영상(?:엔|에는)?\s*생성형|watermark/i.test(value);
}

export function buildTextComparisons(speech: string, subtitles: string[], screenText: string[]) {
  if (!speech.trim()) return [];
  const sources = [
    ...subtitles.map((text) => ({ kind: "subtitle" as const, text })),
    ...screenText.map((text) => ({ kind: "screen_text" as const, text }))
  ].filter((item) => item.text.trim().length > 0);
  const comparisons = sources
    .map((source) => {
      const similarity = textSimilarity(speech, source.text);
      return {
        kind: source.kind,
        asrText: speech,
        ocrText: source.text,
        similarity,
        status: similarity >= 0.82 ? ("match" as const) : similarity >= 0.58 ? ("review" as const) : ("mismatch" as const),
        suggestedText: chooseSuggestedCorrection(speech, source.text, similarity)
      };
    })
    .sort((a, b) => a.similarity - b.similarity);

  const seen = new Set<string>();
  return comparisons
    .filter((item) => {
      const key = [item.status, Math.round(item.similarity * 100), normalizeForComparison(item.suggestedText || item.asrText || item.ocrText)].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function cleanOcrValues(values: string[]) {
  return values.map((value) => value.trim()).filter((value) => value.length > 0 && !isLikelyWatermark(value));
}

function chooseSuggestedCorrection(asrText: string, ocrText: string, similarity: number) {
  if (similarity >= 0.82) return asrText.length >= ocrText.length ? asrText : ocrText;
  const normalizedAsr = normalizeForComparison(asrText);
  const normalizedOcr = normalizeForComparison(ocrText);
  if (normalizedAsr.length >= normalizedOcr.length * 0.7 && normalizedAsr.length <= normalizedOcr.length * 1.4) return asrText;
  return asrText.length >= ocrText.length ? asrText : ocrText;
}

function textSimilarity(left: string, right: string) {
  const a = comparisonBigrams(normalizeForComparison(left));
  const b = comparisonBigrams(normalizeForComparison(right));
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let overlap = 0;
  for (const item of b) {
    const count = counts.get(item) ?? 0;
    if (count <= 0) continue;
    overlap += 1;
    counts.set(item, count - 1);
  }
  return Number(((2 * overlap) / (a.length + b.length)).toFixed(3));
}

function comparisonBigrams(value: string) {
  if (value.length <= 1) return value ? [value] : [];
  return Array.from({ length: value.length - 1 }, (_item, index) => value.slice(index, index + 2));
}

function normalizeForComparison(value: string) {
  return value
    .toLowerCase()
    .replace(/ocr\s*(subtitle|screen|overlay)?:/gi, " ")
    .replace(/[^a-z0-9가-힣]/g, "")
    .trim();
}
