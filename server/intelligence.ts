import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnalysisResult, AssetRecord, ClipDetailResult, ClipResult, DomainQueryPlan, DomainScopeValue, DomainSearchFilters, IndexRecord, KnowledgeEvidence, SearchMatchReason, SearchResult, TimelineSegment, VerificationCheck, VisionEvidence } from "../shared/types";
import { createAnalysisGenerator } from "./analysisGenerator";
import { domainSearchText, expandDomainQuery, scoreDomainMatch, withDomainSegment } from "./domainIndex";
import { knowledgeEvidenceForNames } from "./knowledgeGrounding";
import { isPlayerInventoryQuery, planDomainQuery } from "./queryPlanner";
import { createShotWindows, type SceneBoundary } from "./sceneDetection";
import { matchKnowledgePlayers, playerTeamForSeason } from "./sportsKnowledge";
import { listTrackingRecords } from "./trackingStore";

const execFileAsync = promisify(execFile);

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "video",
  "movie",
  "clip",
  "sample",
  "about",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "have",
  "has",
  "where",
  "when",
  "what",
  "how"
]);

export async function probeVideo(filePath: string) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath
    ]);
    const data = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }>;
    };
    const videoStream = data.streams?.find((stream) => stream.codec_type === "video");
    const audioStream = data.streams?.find((stream) => stream.codec_type === "audio");
    return {
      duration: data.format?.duration ? Number(data.format.duration) : null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      frameRate: parseFrameRate(videoStream?.r_frame_rate),
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null
    };
  } catch {
    return {
      duration: null,
      width: null,
      height: null,
      frameRate: null,
      videoCodec: null,
      audioCodec: null
    };
  }
}

export function buildLocalIndex(asset: AssetRecord, index: IndexRecord, sceneBoundaries: SceneBoundary[] = []) {
  const keywords = extractKeywords(
    `${asset.title} ${asset.description} ${asset.originalName.replace(/\.[^.]+$/, "")} ${index.name} ${
      asset.intelligence.asr.transcript
    } ${asset.intelligence.ocr.tokens.join(" ")} ${asset.intelligence.visual.labels.join(" ")}`
  );
  const tags = unique([...keywords, ...asset.intelligence.visual.labels, ...asset.intelligence.ocr.tokens]).slice(0, 24);
  const safeTags = tags.length > 0 ? tags : ["general", "uploaded", "media"];
  const duration = Math.max(asset.duration ?? 180, 1);
  const whisperSegments = normalizeWhisperTimeline(asset);
  const shotWindows = createShotWindows(sceneBoundaries, asset.duration);
  const timelineBasis =
    shotWindows.length > Math.max(1, whisperSegments.length)
      ? shotWindows.map((shot, index) => ({
          ...shot,
          text: overlappingWhisperText(asset, shot.start, shot.end) || asset.intelligence.asr.transcript,
          shotIndex: index + 1
        }))
      : whisperSegments.length > 0
        ? whisperSegments.map((segment, index) => ({ ...segment, shotIndex: index + 1, boundaryScore: null }))
        : [];
  const segmentCount = timelineBasis.length > 0 ? timelineBasis.length : Math.min(12, Math.max(3, Math.ceil(duration / 35)));
  const segmentLength = duration / segmentCount;

  const timeline: TimelineSegment[] = Array.from({ length: segmentCount }, (_, item) => {
    const basis = timelineBasis[item];
    const hasWhisperSource = Boolean(whisperSegments[item] || overlappingWhisperText(asset, basis?.start ?? 0, basis?.end ?? 0));
    const hasShotSource = shotWindows.length > Math.max(1, whisperSegments.length);
    const start = basis ? basis.start : Math.round(item * segmentLength);
    const end = basis ? basis.end : Math.round(item === segmentCount - 1 ? duration : (item + 1) * segmentLength);
    const primary = safeTags[item % safeTags.length];
    const secondary = safeTags[(item + 1) % safeTags.length] ?? primary;
    const tertiary = safeTags[(item + 2) % safeTags.length] ?? "context";
    const sceneData = buildSceneData(asset, item, start, end);
    const ocrContext = {
      subtitle: sceneData.text.subtitles,
      screenText: sceneData.text.screenText,
      overlay: [...sceneData.text.overlays, ...sceneData.text.watermarks]
    };
    const ocrText = formatOcrEvidence(ocrContext);
    const speechText = sceneData.text.speech || basis?.text || "";
    const transcript = speechText
      ? `${speechText}${ocrText ? ` ${ocrText}` : ""}`
      : `${asset.intelligence.asr.transcript} Detected ${primary}, ${secondary}, and ${tertiary} context from ${formatTime(start)} to ${formatTime(
          end
        )}.${ocrText ? ` ${ocrText}` : ""}`;
    const sources: TimelineSegment["sources"] = [
      ...(hasWhisperSource ? (["whisper"] as const) : []),
      ...(ocrText ? (["paddleocr"] as const) : []),
      ...(hasShotSource ? (["shot"] as const) : []),
      "visual",
      "metadata"
    ];
    return {
      id: `${asset.id}-segment-${item + 1}`,
      start,
      end,
      label: toTitleCase(`${primary} scene`),
      transcript,
      sceneData,
      tags: unique([primary, secondary, tertiary, ...asset.intelligence.visual.labels.slice(0, 2)]),
      modalities: chooseModalities(index.modalities, item),
      confidence: Number((0.73 + (item % 5) * 0.04).toFixed(2)),
      embedding: vectorize(`${primary} ${secondary} ${tertiary} ${transcript}`),
      thumbnailPath: null,
      sources: unique(sources),
      scene: {
        shotIndex: basis?.shotIndex ?? item + 1,
        boundaryScore: basis?.boundaryScore ?? null
      }
    };
  });

  const domainTimeline = timeline.map((segment) => withDomainSegment(asset, index, segment));

  return {
    tags: safeTags,
    timeline: domainTimeline,
    summary: `This asset was indexed into ${domainTimeline.length} timeline segments using ${index.models.embedding}. Local ASR, OCR, visual sampling, vector indexing${
      index.domainIndexing?.enabled ? ", and sports domain event indexing" : ""
    } emphasize ${safeTags
      .slice(0, 5)
      .join(", ")}. Dominant visual color is ${asset.intelligence.visual.dominantColor}.`
  };
}

function normalizeWhisperTimeline(asset: AssetRecord) {
  const duration = asset.duration ?? Number.POSITIVE_INFINITY;
  return asset.intelligence.asr.segments
    .map((segment) => ({
      start: Math.max(0, Number(segment.start || 0)),
      end: Math.min(duration, Math.max(Number(segment.end || 0), Number(segment.start || 0) + 1)),
      text: segment.text.trim()
    }))
    .filter((segment) => segment.text.length > 0)
    .slice(0, 80);
}

function overlappingWhisperText(asset: AssetRecord, start: number, end: number) {
  return asset.intelligence.asr.segments
    .filter((segment) => segment.end > start && segment.start < end)
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildSceneData(asset: AssetRecord, index: number, start: number, end: number): NonNullable<TimelineSegment["sceneData"]> {
  const ocrFrame = nearbyOcrFrame(asset, index, start, end);
  const ocrEvidence = ocrFrame ? ocrEvidenceFromFrame(ocrFrame) : { subtitle: [], screenText: [], overlay: [] };
  const speech = overlappingWhisperText(asset, start, end);
  const subtitles = ocrEvidence.subtitle;
  const screenText = ocrEvidence.screenText;
  const overlays = ocrEvidence.overlay.filter((value) => !isLikelyWatermark(value));
  const watermarks = ocrEvidence.overlay.filter(isLikelyWatermark);
  return {
    image: {
      thumbnailPath: null,
      framePath: ocrFrame?.framePath || null,
      labels: asset.intelligence.visual.labels.slice(0, 6),
      dominantColor: asset.intelligence.visual.dominantColor,
      brightness: asset.intelligence.visual.brightness,
      motionScore: asset.intelligence.visual.motionScore,
      keyframeAt: Number(((start + end) / 2).toFixed(2))
    },
    text: {
      speech,
      subtitles,
      screenText,
      overlays,
      watermarks,
      comparisons: buildTextComparisons(speech, subtitles, screenText)
    },
    vision: buildVisionEvidence(asset, start, end)
  };
}

export function withSceneData(asset: AssetRecord, segment: TimelineSegment): TimelineSegment {
  const sceneData = segment.sceneData ?? buildSceneData(asset, Math.max(0, (segment.scene?.shotIndex ?? 1) - 1), segment.start, segment.end);
  return {
    ...segment,
    sceneData: {
      ...sceneData,
      image: {
        ...sceneData.image,
        thumbnailPath: segment.thumbnailPath ?? sceneData.image.thumbnailPath
      },
      vision: sceneData.vision ?? buildVisionEvidence(asset, segment.start, segment.end)
    }
  };
}

function buildVisionEvidence(asset: AssetRecord, start: number, end: number): VisionEvidence {
  const labels = asset.intelligence.visual.labels;
  const { red, green, blue } = hexToRgb(asset.intelligence.visual.dominantColor);
  const greenDominance = green + red + blue > 0 ? Number((green / Math.max(1, red + green + blue)).toFixed(3)) : 0;
  const pitchPresent = labels.includes("green-dominant") || greenDominance >= 0.36;
  const motion = asset.intelligence.visual.motionScore;
  const confidenceBase = Math.min(0.82, 0.28 + (pitchPresent ? 0.24 : 0) + Math.min(0.22, motion * 0.8));
  const frameAt = Number(((start + end) / 2).toFixed(2));
  const playersLikely = pitchPresent && (labels.includes("active-motion") || labels.includes("stable-shot"));
  const ballLikely = pitchPresent && motion >= 0.08;
  const zone = estimateVisualFieldZone(asset, pitchPresent, motion);
  const zoneConfidence = zone === "unknown" ? 0 : Number(Math.min(0.54, confidenceBase - 0.05).toFixed(2));
  const candidates: VisionEvidence["eventCandidates"] = [];
  if (pitchPresent && motion >= 0.1) {
    candidates.push({
      type: "pass_receive",
      confidence: Number(Math.min(0.62, confidenceBase + 0.08).toFixed(2)),
      reason: "Green pitch and motion cues suggest an in-play football action candidate."
    });
  }
  if (pitchPresent && hasShotCue(asset)) {
    candidates.push({
      type: "shot",
      confidence: Number(Math.min(0.6, confidenceBase + 0.04).toFixed(2)),
      reason: "Pitch cue appears with shot/goal language in nearby ASR/OCR context."
    });
  }

  return {
    generatedBy: "vision-evidence-v0-color-motion",
    frameAt,
    pitch: {
      present: pitchPresent,
      greenDominance,
      confidence: Number((pitchPresent ? confidenceBase : Math.max(0.08, greenDominance)).toFixed(2))
    },
    objects: {
      players: {
        countEstimate: playersLikely ? Math.max(2, Math.round(6 + motion * 10)) : 0,
        confidence: playersLikely ? Number(Math.min(0.58, confidenceBase).toFixed(2)) : 0,
        status: playersLikely ? "estimated" : "not_detected"
      },
      ball: {
        present: ballLikely,
        confidence: ballLikely ? Number(Math.min(0.42, 0.18 + motion * 0.9).toFixed(2)) : 0,
        status: ballLikely ? "estimated" : "not_detected"
      }
    },
    fieldZone: {
      zone,
      confidence: zoneConfidence,
      method: zone === "unknown" ? "none" : "color_motion_heuristic"
    },
    fieldCalibration: {
      status: zone === "unknown" ? "not_configured" : "estimated",
      method: zone === "unknown" ? "none" : "text_context",
      zone,
      zoneConfidence,
      attackingDirection: "unknown",
      attackingDirectionConfidence: 0,
      evidence: zone === "unknown" ? ["No pitch-zone cue was available."] : ["Zone estimated from text, color, and motion context."],
      limitations: [
        "No pitch homography is configured.",
        "Zone is not derived from calibrated field coordinates."
      ]
    },
    eventCandidates: candidates,
    limitations: [
      "Vision evidence v0 uses color and motion heuristics, not object bounding boxes.",
      "Player identity, ball trajectory, and calibrated pitch coordinates require detector/tracker stages."
    ]
  };
}

function estimateVisualFieldZone(asset: AssetRecord, pitchPresent: boolean, motion: number): VisionEvidence["fieldZone"]["zone"] {
  if (!pitchPresent) return "unknown";
  const text = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.intelligence.asr.transcript,
      asset.intelligence.ocr.tokens.join(" ")
    ].join(" ")
  );
  if (/(penalty|box|박스|페널티|goal|keeper|골|슈팅|shot|finish)/i.test(text)) return "penalty_area";
  if (/(through ball|스루|침투|attack|attacking|chance|찬스)/i.test(text)) return "final_third";
  if (motion >= 0.14) return "middle_third";
  return "unknown";
}

function hasShotCue(asset: AssetRecord) {
  return /(shot|shoot|finish|goal|슈팅|슛|골|마무리)/i.test(
    [asset.title, asset.description, asset.intelligence.asr.transcript, asset.intelligence.ocr.tokens.join(" ")].join(" ")
  );
}

function hexToRgb(value: string) {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { red: 0, green: 0, blue: 0 };
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function isObjectEvidenceReady(status?: "not_configured" | "estimated" | "detected" | "not_detected") {
  return status === "estimated" || status === "detected";
}

function segmentSearchText(segment: TimelineSegment) {
  const text = segment.sceneData?.text;
  const domainText = domainSearchText(segment);
  const vision = segment.sceneData?.vision;
  const visionText = vision
    ? [
        vision.pitch.present ? "football pitch field" : "",
        isObjectEvidenceReady(vision.objects.players.status) ? `players ${vision.objects.players.status}` : "",
        isObjectEvidenceReady(vision.objects.ball.status) ? `ball ${vision.objects.ball.status}` : "",
        vision.fieldZone.zone !== "unknown" ? vision.fieldZone.zone : "",
        vision.tracking?.ballTrackId ? `ball track ${vision.tracking.ballTrackId}` : "",
        vision.tracking?.nearestPlayerTrackId ? `nearest player ${vision.tracking.nearestPlayerTrackId}` : "",
        vision.eventClassification && vision.eventClassification.label !== "unknown" ? `event classifier ${vision.eventClassification.label}` : ""
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  if (!text) return [segment.transcript, domainText, visionText].filter(Boolean).join(" ");
  return [text.speech, ...text.subtitles, ...text.screenText, ...text.overlays, domainText, visionText].filter(Boolean).join(" ");
}

function nearbyOcrFrame(asset: AssetRecord, index: number, start: number, end: number) {
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

function ocrEvidenceFromFrame(frame: NonNullable<AssetRecord["intelligence"]["ocr"]["frames"][number]>) {
  const boxes = frame.boxes ?? [];
  if (boxes.length === 0) return { subtitle: [], screenText: cleanOcrValues(unique(frame.tokens)).slice(0, 8), overlay: [] };
  return {
    subtitle: cleanOcrValues(unique(boxes.filter((box) => box.role === "subtitle").map((box) => box.text))).slice(0, 4),
    screenText: cleanOcrValues(unique(boxes.filter((box) => box.role === "screen_text").map((box) => box.text))).slice(0, 5),
    overlay: unique(boxes.filter((box) => box.role === "overlay" || box.role === "watermark").map((box) => box.text)).slice(0, 4)
  };
}

function nearbyOcrEvidence(asset: AssetRecord, index: number) {
  const frame = asset.intelligence.ocr.frames[index % Math.max(1, asset.intelligence.ocr.frames.length)];
  const boxes = frame?.boxes ?? [];
  if (boxes.length === 0) {
    return { subtitle: [], screenText: unique([...(frame?.tokens ?? []), ...asset.intelligence.ocr.tokens]).slice(0, 8), overlay: [] };
  }
  return {
    subtitle: unique(boxes.filter((box) => box.role === "subtitle").map((box) => box.text)).slice(0, 4),
    screenText: unique(boxes.filter((box) => box.role === "screen_text").map((box) => box.text)).slice(0, 5),
    overlay: unique(boxes.filter((box) => box.role === "overlay" || box.role === "watermark").map((box) => box.text)).slice(0, 4)
  };
}

function formatOcrEvidence(evidence: { subtitle: string[]; screenText: string[]; overlay: string[] }) {
  const parts = [
    evidence.subtitle.length ? `OCR subtitle: ${evidence.subtitle.join(" ")}` : "",
    evidence.screenText.length ? `OCR screen: ${evidence.screenText.join(" ")}` : "",
    evidence.overlay.length ? `OCR overlay: ${evidence.overlay.join(" ")}` : ""
  ].filter(Boolean);
  return parts.length ? `${parts.join(". ")}.` : "";
}

function isLikelyWatermark(value: string) {
  return /생성형\s*(a|ai)|이\s*영상(?:엔|에는)?\s*생성형|watermark/i.test(value);
}

function cleanOcrValues(values: string[]) {
  return values.map((value) => value.trim()).filter((value) => value.length > 0 && !isLikelyWatermark(value));
}

function buildTextComparisons(speech: string, subtitles: string[], screenText: string[]) {
  if (!speech.trim()) return [];
  const sources = [
    ...subtitles.map((text) => ({ kind: "subtitle" as const, text })),
    ...screenText.map((text) => ({ kind: "screen_text" as const, text }))
  ].filter((item) => item.text.trim().length > 0);
  return sources
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
    .sort((a, b) => a.similarity - b.similarity)
    .slice(0, 3);
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

export function searchAssets(
  assets: AssetRecord[],
  indexes: IndexRecord[],
  query: string,
  options: {
    indexId?: string;
    tag?: string;
    modality?: string;
    limit?: number;
    queryVector?: number[];
    vectorHitsBySegment?: Map<string, number>;
    visualHitsBySegment?: Map<string, number>;
    domainFilters?: DomainSearchFilters;
    queryPlan?: DomainQueryPlan;
    knowledgeEvidence?: KnowledgeEvidence[];
  } = {}
): SearchResult[] {
  if (isPlayerInventoryQuery(query)) {
    return searchPlayerInventoryResults(assets, indexes, options);
  }

  const domainProfile = expandDomainQuery(options.queryPlan?.semanticQuery ?? query);
  const queryTerms = extractKeywords(domainProfile.expandedText);
  const knowledgeProfile = buildKnowledgeSearchProfile(options.knowledgeEvidence ?? []);
  const knowledgeTerms = extractKeywords(knowledgeProfile.searchText);
  const hasVectorHits = (options.vectorHitsBySegment?.size ?? 0) > 0 || (options.visualHitsBySegment?.size ?? 0) > 0;
  const hasDomainFilters = hasActiveDomainFilters(options.domainFilters);
  const hasKnowledgeEvidence = knowledgeTerms.length > 0;
  if (query.trim().length === 0 && queryTerms.length === 0 && !hasVectorHits && !hasDomainFilters && !hasKnowledgeEvidence) return [];
  const queryVector = options.queryVector ?? vectorize(domainProfile.expandedText);
  const limit = options.limit ?? 10;

  return assets
    .filter((asset) => asset.status === "indexed" || asset.timeline.length > 0)
    .filter((asset) => !options.indexId || asset.indexId === options.indexId)
    .filter((asset) => !options.tag || asset.tags.includes(options.tag))
    .filter((asset) => matchesAssetDomainText(asset, options.domainFilters))
    .map((asset) => {
      const assetText = `${asset.title} ${asset.description} ${asset.tags.join(" ")} ${asset.summary}`;
      const assetLexicalScore = scoreText(assetText, queryTerms);
      const assetKnowledgeScore = scoreText(assetText, knowledgeTerms);
      const segmentCandidates = asset.timeline
        .filter((segment) => !options.modality || segment.modalities.includes(options.modality as TimelineSegment["modalities"][number]))
        .filter((segment) => matchesSegmentDomainFilters(asset, segment, options.domainFilters))
        .map((segment) => {
          const segmentText = segmentSearchText(segment);
          const lexicalScore = scoreText(segmentText, queryTerms);
          const knowledgeScore = scoreText([assetText, segmentText, segment.domain?.searchText].filter(Boolean).join(" "), knowledgeTerms);
          const domainScore = scoreDomainMatch(segment, domainProfile);
          const filterScore = scoreDomainFilterMatch(asset, segment, options.domainFilters);
          const semanticScore = Math.max(
            queryVector.length === segment.embedding.length ? cosineSimilarity(queryVector, segment.embedding) : 0,
            options.vectorHitsBySegment?.get(segment.id) ?? 0
          );
          const visualScore = options.visualHitsBySegment?.get(segment.id) ?? 0;
          const sourceScore = scoreSources(segment.sources);
          const confidenceScore = segment.confidence;
          const vlmQualityScore = scoreVlmQuality(segment);
          return {
            segment,
            lexicalScore,
            semanticScore,
            visualScore,
            sourceScore,
            confidenceScore,
            vlmQualityScore,
            domainScore,
            filterScore,
            knowledgeScore,
            score:
              lexicalScore * 3 +
              domainScore * 5 +
              filterScore * 6 +
              knowledgeScore * 4.5 +
              semanticScore * 8 +
              visualScore * 6 +
              sourceScore +
              confidenceScore * 1.5 +
              vlmQualityScore
          };
        })
        .filter((item) => (hasDomainFilters ? item.filterScore > 0 : item.lexicalScore > 0 || item.domainScore > 0 || item.knowledgeScore > 0 || item.semanticScore > 0.72 || item.visualScore > 0.25));
      const lexicalSegmentMatches = segmentCandidates.filter((item) => item.lexicalScore > 0);
      const domainSegmentMatches = segmentCandidates.filter((item) => item.domainScore > 0);
      const knowledgeSegmentMatches = segmentCandidates.filter((item) => item.knowledgeScore > 0);
      const semanticSegmentMatches = segmentCandidates.filter((item) => item.semanticScore > 0.72 || item.visualScore > 0.25);
      const matchingSegments = (hasDomainFilters
        ? segmentCandidates
        : lexicalSegmentMatches.length > 0 || domainSegmentMatches.length > 0 || knowledgeSegmentMatches.length > 0
          ? [...lexicalSegmentMatches, ...domainSegmentMatches, ...knowledgeSegmentMatches]
          : semanticSegmentMatches)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.segment.id === item.segment.id) === index)
        .sort((a, b) => b.score - a.score);

      const lexical = assetLexicalScore * 0.5 + matchingSegments.reduce((sum, item) => sum + item.lexicalScore, 0) * 3;
      const domain = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.domainScore, 0) * 5;
      const filters = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.filterScore, 0) * 6;
      const knowledge = assetKnowledgeScore * 0.5 + matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.knowledgeScore, 0) * 4.5;
      const semantic = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.semanticScore, 0) * 8;
      const visual = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.visualScore, 0) * 6;
      const source = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.sourceScore, 0);
      const confidence = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.confidenceScore, 0) * 1.5;
      const vlmQuality = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.vlmQualityScore, 0);
      const recency = recencyBoost(asset.createdAt);
      const totalScore = Number((lexical + domain + filters + knowledge + semantic + visual + source + confidence + vlmQuality + recency).toFixed(3));
      const index = indexes.find((item) => item.id === asset.indexId) ?? null;
      const selectedSegments = matchingSegments.slice(0, 5);
      const selectedSegmentIds = selectedSegments.map((item) => item.segment.id);
      const selectedPlayerNames = unique(
        selectedSegments.flatMap((item) => [
          ...(item.segment.domain?.scope?.players.map((player) => player.value) ?? []),
          item.segment.domain?.events[0]?.football?.receivingPlayer.identity?.name ?? "",
          item.segment.domain?.events[0]?.football?.passingPlayer.identity?.name ?? ""
        ].filter(Boolean))
      );
      const selectedDetails = selectedSegments.map((item) => {
        const segment = withSceneData(asset, item.segment);
        const matchReasons = buildSearchMatchReasons(asset, item.segment, item, options.domainFilters, options.queryPlan);
        const verification = buildVerificationChecks(asset, item.segment, options.domainFilters);
        return {
          segment,
          matchReasons,
          verification,
          clip: clipFromSegment(asset, segment, verification, matchReasons)
        };
      });
      return {
        asset,
        index,
        segments: selectedDetails.map((item) => item.segment),
        clips: selectedDetails.map((item) => item.clip),
        score: totalScore,
        ranking: {
          lexical: Number(lexical.toFixed(3)),
          semantic: Number(semantic.toFixed(3)),
          visual: Number(visual.toFixed(3)),
          source: Number(source.toFixed(3)),
          confidence: Number(confidence.toFixed(3)),
          recency: Number(recency.toFixed(3)),
          total: totalScore
        },
        explain: [
          `${assetLexicalScore} lexical asset matches`,
          `${Number(domain.toFixed(3))} sports domain rank score`,
          `${Number(filters.toFixed(3))} structured filter score`,
          `${Number(knowledge.toFixed(3))} knowledge grounding score`,
          `${Number(semantic.toFixed(3))} semantic rank score`,
          `${Number(visual.toFixed(3))} visual rank score`,
          `${Number(source.toFixed(3))} source quality boost`,
          `${Number(confidence.toFixed(3))} confidence boost`,
          `${Number(vlmQuality.toFixed(3))} VLM quality adjustment`,
          `${matchingSegments.length} matching timeline segments`,
          hasDomainFilters ? `domain filters=${formatDomainFilters(options.domainFilters)}` : "",
          options.queryPlan ? `query plan=${options.queryPlan.rewrittenQuery}` : "",
          index ? `index=${index.name}` : "index=unknown"
        ].filter(Boolean),
        queryPlan: options.queryPlan ?? null,
        knowledgeEvidence: selectKnowledgeEvidence(options.knowledgeEvidence ?? [], asset.id, selectedSegmentIds, selectedPlayerNames),
        matchReasons: selectedDetails.flatMap((item) => item.matchReasons),
        verification: selectedDetails.flatMap((item) => item.verification)
      };
    })
    .filter((result) => result.score > 0 && result.segments.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchPlayerInventoryResults(
  assets: AssetRecord[],
  indexes: IndexRecord[],
  options: Parameters<typeof searchAssets>[3]
): SearchResult[] {
  const searchOptions = options ?? {};
  const limit = searchOptions.limit ?? 10;
  return assets
    .filter((asset) => asset.status === "indexed" || asset.timeline.length > 0)
    .filter((asset) => !searchOptions.indexId || asset.indexId === searchOptions.indexId)
    .filter((asset) => !searchOptions.tag || asset.tags.includes(searchOptions.tag))
    .filter((asset) => matchesAssetDomainText(asset, searchOptions.domainFilters))
    .map((asset) => {
      const assetPlayers = collectAssetPlayerMentions(asset);
      const segmentCandidates = asset.timeline
        .filter((segment) => !searchOptions.modality || segment.modalities.includes(searchOptions.modality as TimelineSegment["modalities"][number]))
        .filter((segment) => matchesSegmentDomainFilters(asset, segment, searchOptions.domainFilters))
        .map((segment) => ({ segment, players: collectPlayerMentions(asset, segment) }))
        .filter((item) => item.players.length > 0)
        .sort((a, b) => averageConfidence(b.players) - averageConfidence(a.players) || b.players.length - a.players.length);
      const segmentPlayerNames = new Set(segmentCandidates.flatMap((item) => item.players.map((player) => player.value)));
      const assetOnlyPlayers = assetPlayers.filter((player) => !segmentPlayerNames.has(player.value));
      const firstSegment = asset.timeline.find(
        (segment) =>
          (!searchOptions.modality || segment.modalities.includes(searchOptions.modality as TimelineSegment["modalities"][number])) &&
          matchesSegmentDomainFilters(asset, segment, searchOptions.domainFilters)
      );
      if (firstSegment && assetOnlyPlayers.length > 0) {
        segmentCandidates.push({ segment: firstSegment, players: assetOnlyPlayers });
      }
      const playerNames = unique(segmentCandidates.flatMap((item) => item.players.map((player) => player.value))).sort((a, b) => a.localeCompare(b));
      const selectedSegments = selectPlayerInventorySegments(segmentCandidates, playerNames).slice(0, 5);
      const selectedSegmentIds = selectedSegments.map((item) => item.segment.id);
      const selectedDetails = selectedSegments.map((item) => {
        const segment = withSceneData(asset, item.segment);
        const matchReasons = buildPlayerInventoryReasons(segment.id, item.players);
        const verification = buildVerificationChecks(asset, item.segment, searchOptions.domainFilters);
        return {
          segment,
          matchReasons,
          verification,
          clip: clipFromSegment(asset, segment, verification, matchReasons)
        };
      });
      const index = indexes.find((item) => item.id === asset.indexId) ?? null;
      const source = selectedSegments.reduce((sum, item) => sum + scoreSources(item.segment.sources), 0);
      const confidence = selectedSegments.reduce((sum, item) => sum + averageConfidence(item.players), 0);
      const recency = recencyBoost(asset.createdAt);
      const totalScore = Number((playerNames.length * 20 + segmentCandidates.length * 0.5 + source + confidence + recency).toFixed(3));
      return {
        asset,
        index,
        segments: selectedDetails.map((item) => item.segment),
        clips: selectedDetails.map((item) => item.clip),
        score: totalScore,
        ranking: {
          lexical: 0,
          semantic: 0,
          visual: 0,
          source: Number(source.toFixed(3)),
          confidence: Number(confidence.toFixed(3)),
          recency: Number(recency.toFixed(3)),
          total: totalScore
        },
        explain: [
          `${playerNames.length} mentioned players: ${playerNames.join(", ")}`,
          `${segmentCandidates.length} timeline segments with player evidence`,
          searchOptions.queryPlan ? `query plan=${searchOptions.queryPlan.rewrittenQuery}` : "",
          index ? `index=${index.name}` : "index=unknown"
        ].filter(Boolean),
        queryPlan: searchOptions.queryPlan ?? null,
        knowledgeEvidence: selectKnowledgeEvidence(
          knowledgeEvidenceForNames(searchOptions.knowledgeEvidence ?? [], playerNames),
          asset.id,
          selectedSegmentIds,
          playerNames
        ),
        matchReasons: selectedDetails.flatMap((item) => item.matchReasons),
        verification: selectedDetails.flatMap((item) => item.verification)
      };
    })
    .filter((result) => result.score > 0 && result.segments.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function collectPlayerMentions(_asset: AssetRecord, segment: TimelineSegment): DomainScopeValue[] {
  const mentions = new Map<string, DomainScopeValue>();
  const text = [
    segment.transcript,
    segment.sceneData?.text.speech,
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? [])
  ]
    .filter(Boolean)
    .join(" ");
  for (const match of matchKnowledgePlayers(text)) {
    const value: DomainScopeValue = {
      value: match.value.canonical,
      confidence: match.confidence,
      source: match.source,
      evidence: match.evidence
    };
    const existing = mentions.get(value.value);
    if (!existing || value.confidence > existing.confidence) mentions.set(value.value, value);
  }

  return Array.from(mentions.values()).sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}

function collectAssetPlayerMentions(asset: AssetRecord): DomainScopeValue[] {
  const text = [asset.title, asset.originalName, asset.description, asset.tags.join(" ")].filter(Boolean).join(" ");
  return matchKnowledgePlayers(text)
    .map((match) => ({
      value: match.value.canonical,
      confidence: match.confidence,
      source: match.source,
      evidence: match.evidence
    }))
    .sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}

function selectPlayerInventorySegments(
  candidates: Array<{ segment: TimelineSegment; players: DomainScopeValue[] }>,
  playerNames: string[]
) {
  const selected: Array<{ segment: TimelineSegment; players: DomainScopeValue[] }> = [];
  const selectedIds = new Set<string>();
  for (const playerName of playerNames) {
    const match = candidates.find((item) => item.players.some((player) => player.value === playerName));
    if (match && !selectedIds.has(match.segment.id)) {
      selected.push(match);
      selectedIds.add(match.segment.id);
    }
  }
  for (const candidate of candidates) {
    if (selectedIds.has(candidate.segment.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.segment.id);
  }
  return selected;
}

function buildPlayerInventoryReasons(segmentId: string, players: DomainScopeValue[]): SearchMatchReason[] {
  return players.map((player) => ({
    segmentId,
    kind: "evidence",
    label: "Player",
    value: `${player.value} (${player.source})`,
    confidence: player.confidence
  }));
}

function averageConfidence(players: DomainScopeValue[]) {
  if (players.length === 0) return 0;
  return players.reduce((sum, player) => sum + player.confidence, 0) / players.length;
}

function selectKnowledgeEvidence(evidence: KnowledgeEvidence[], assetId: string, segmentIds: string[], playerNames: string[]) {
  const segmentIdSet = new Set(segmentIds);
  const playerNameSet = new Set(playerNames.map(normalizeSearchValue));
  return evidence
    .filter((item) => {
      if (item.assetId && item.assetId !== assetId) return false;
      if (item.segmentId && !segmentIdSet.has(item.segmentId)) return false;
      if (item.entityType === "player" && playerNameSet.size > 0) return playerNameSet.has(normalizeSearchValue(item.entityName));
      return item.source !== "video_index" || item.assetId === assetId;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
}

function buildKnowledgeSearchProfile(evidence: KnowledgeEvidence[]) {
  const selected = evidence.slice(0, 40);
  return {
    searchText: selected
      .flatMap((item) => [item.entityName, item.team, item.competition, item.season, item.matchTime, item.evidenceText])
      .filter(Boolean)
      .join(" "),
    sourceCount: selected.length
  };
}

type AnalysisMoment = {
  asset: AssetRecord;
  segment: TimelineSegment;
  reasons: SearchMatchReason[];
  verification: VerificationCheck[];
};

type ScoredAnalysisMoment = AnalysisMoment & {
  evidenceScore: number;
  evidenceTier: AnalysisResult["evidence"]["tier"];
  hardChecks: number;
  softChecks: number;
  missingChecks: number;
  failedChecks: number;
};

export async function analyzeAsset(asset: AssetRecord, question = ""): Promise<AnalysisResult> {
  const queryPlan = planDomainQuery(question);
  const domainProfile = expandDomainQuery(queryPlan.semanticQuery || question);
  const queryTerms = extractKeywords(domainProfile.expandedText);
  const candidateMoments = asset.timeline
    .filter((segment) => matchesSegmentDomainFilters(asset, segment, queryPlan.domainFilters))
    .map((segment) => {
      const lexicalScore = scoreText(`${segment.transcript} ${segment.tags.join(" ")} ${segmentSearchText(segment)}`, queryTerms);
      const domainScore = scoreDomainMatch(segment, domainProfile);
      const filterScore = scoreDomainFilterMatch(asset, segment, queryPlan.domainFilters);
      const verification = buildVerificationChecks(asset, segment, queryPlan.domainFilters);
      const reasons = buildSearchMatchReasons(
        asset,
        segment,
        {
          lexicalScore,
          semanticScore: 0,
          visualScore: 0,
          domainScore
        },
        queryPlan.domainFilters,
        queryPlan
      );
      return {
        asset,
        segment,
        reasons,
        verification,
        score: lexicalScore * 2 + domainScore * 5 + filterScore * 6 + segment.confidence
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const fallbackMoments = question.trim()
    ? []
    : asset.timeline.slice(0, 12).map((segment) => ({
        asset,
        segment,
        reasons: [],
        verification: buildVerificationChecks(asset, segment, queryPlan.domainFilters)
      }));
  const evidencePlan = buildAnalysisEvidencePlan((candidateMoments.length > 0 ? candidateMoments : fallbackMoments).slice(0, 18));
  const analysisMoments = evidencePlan.included.slice(0, 6);
  const chapters = analysisMoments.map((moment) => moment.segment);
  const verification = analysisMoments.flatMap((moment) => moment.verification);
  const features = analysisMoments.map((moment) => featureFromSegment(moment.segment, moment.verification));
  const patterns = aggregatePatterns(features);
  const domainSignals = chapters.flatMap((segment) => [
    ...(segment.domain?.labels ?? []),
    ...(segment.domain?.scope?.players.map((player) => player.value) ?? []),
    segment.domain?.scope?.competition?.value ?? "",
    segment.domain?.scope?.season?.value ?? ""
  ]);
  const signals = unique([...(chapters.length > 0 ? asset.tags.slice(0, 6) : []), ...chapters.flatMap((segment) => segment.tags), ...domainSignals].filter(Boolean)).slice(0, 12);
  const clips = analysisMoments.map((moment) => clipFromSegment(moment.asset, withSceneData(moment.asset, moment.segment), moment.verification, moment.reasons));
  const generated = await createAnalysisGenerator().generate({
    question,
    asset,
    chapters,
    clips,
    signals,
    patterns,
    verification
  });
  const evidence = summarizeAnalysisEvidence(evidencePlan.scored, analysisMoments);

  return {
    assetId: asset.id,
    indexId: asset.indexId,
    scope: {
      type: "asset",
      label: asset.title,
      assetCount: 1
    },
    summary: buildEvidenceAwareSummary(generated.summary ?? asset.summary, evidence),
    answer: generated.answer,
    chapters,
    clips,
    signals,
    patterns,
    evidence,
    report: buildEvidenceAwareReport(generated.report, evidence),
    generator: generated.generator,
    generatedAt: new Date().toISOString()
  };
}

export async function analyzeAssetGroup(assets: AssetRecord[], indexes: IndexRecord[], index: IndexRecord, question = ""): Promise<AnalysisResult> {
  const scopedAssets = assets.filter((asset) => asset.indexId === index.id && (asset.status === "indexed" || asset.timeline.length > 0));
  const queryPlan = planDomainQuery(question);
  const searchResults = searchAssets(scopedAssets, indexes, question, {
    indexId: index.id,
    domainFilters: queryPlan.domainFilters,
    queryPlan,
    limit: 12
  });
  const moments: AnalysisMoment[] = searchResults
    .flatMap((result) =>
      result.segments.map((segment) => ({
        asset: result.asset,
        segment,
        reasons: result.matchReasons.filter((reason) => reason.segmentId === segment.id),
        verification: result.verification.filter((check) => check.segmentId === segment.id)
      }))
    )
    .slice(0, 18);
  const evidencePlan = buildAnalysisEvidencePlan(
    moments.map((moment) => ({
      ...moment,
      verification: moment.verification.length > 0 ? moment.verification : buildVerificationChecks(moment.asset, moment.segment, queryPlan.domainFilters)
    }))
  );
  const analysisMoments = evidencePlan.included.slice(0, 18);
  const chapters = analysisMoments.map((moment) => moment.segment);
  const verification = analysisMoments.flatMap((moment) => moment.verification);
  const features = analysisMoments.map((moment) => featureFromSegment(moment.segment, moment.verification));
  const patterns = aggregatePatterns(features);
  const signals = unique(
    [
      index.name,
      ...scopedAssets.flatMap((asset) => asset.tags),
      ...chapters.flatMap((segment) => segment.tags),
      ...chapters.flatMap((segment) => segment.domain?.labels ?? []),
      ...chapters.flatMap((segment) => segment.domain?.scope?.players.map((player) => player.value) ?? []),
      ...chapters.map((segment) => segment.domain?.scope?.competition?.value ?? ""),
      ...chapters.map((segment) => segment.domain?.scope?.season?.value ?? "")
    ].filter(Boolean)
  ).slice(0, 16);
  const clips = analysisMoments.map((moment) =>
    clipFromSegment(
      moment.asset,
      withSceneData(moment.asset, moment.segment),
      moment.verification,
      moment.reasons
    )
  );
  const subject = buildGroupAnalysisSubject(index, scopedAssets, chapters);
  const generated = await createAnalysisGenerator().generate({
    question,
    asset: subject,
    chapters,
    clips,
    signals,
    patterns,
    verification
  });
  const evidence = summarizeAnalysisEvidence(evidencePlan.scored, analysisMoments);
  return {
    assetId: `asset-group:${index.id}`,
    indexId: index.id,
    scope: {
      type: "asset_group",
      label: index.name,
      assetCount: scopedAssets.length
    },
    summary: buildEvidenceAwareSummary(generated.summary ?? subject.summary, evidence),
    answer: generated.answer,
    chapters,
    clips,
    signals,
    patterns,
    evidence,
    report: buildEvidenceAwareReport(generated.report, evidence),
    generator: generated.generator,
    generatedAt: new Date().toISOString()
  };
}

export function listAssetClips(asset: AssetRecord, filters?: DomainSearchFilters, queryPlan?: DomainQueryPlan): ClipResult[] {
  return asset.timeline.map((segment) => {
    const sceneSegment = withSceneData(asset, segment);
    const verification = buildVerificationChecks(asset, segment, filters);
    const reasons = buildSearchMatchReasons(
      asset,
      segment,
      {
        lexicalScore: 0,
        semanticScore: 0,
        visualScore: 0,
        domainScore: 0
      },
      filters,
      queryPlan
    );
    return clipFromSegment(asset, sceneSegment, verification, reasons);
  });
}

export async function buildClipDetail(asset: AssetRecord, segmentId: string, filters?: DomainSearchFilters, queryPlan?: DomainQueryPlan): Promise<ClipDetailResult | null> {
  const segment = asset.timeline.find((item) => item.id === segmentId);
  if (!segment) return null;
  const sceneSegment = withSceneData(asset, segment);
  const verification = buildVerificationChecks(asset, segment, filters);
  const reasons = buildSearchMatchReasons(
    asset,
    segment,
    {
      lexicalScore: 0,
      semanticScore: 0,
      visualScore: 0,
      domainScore: scoreDomainMatch(segment, expandDomainQuery(queryPlan?.semanticQuery ?? ""))
    },
    filters,
    queryPlan
  );
  return {
    clip: clipFromSegment(asset, sceneSegment, verification, reasons),
    asset: {
      id: asset.id,
      indexId: asset.indexId,
      title: asset.title,
      duration: asset.duration
    },
    segment: sceneSegment,
    verification,
    reasons,
    tracking: await listTrackingRecords({ assetId: asset.id, segmentId }),
    domainEvents: segment.domain?.events ?? []
  };
}

function featureFromSegment(segment: TimelineSegment, verification: VerificationCheck[]) {
  const event = segment.domain?.events[0];
  const football = event?.football;
  const vision = segment.sceneData?.vision;
  const receiverTrackId = football?.receivingPlayer.trackId ?? null;
  const passerTrackId = football?.passingPlayer.trackId ?? null;
  const nearestPlayerTrackId = vision?.tracking?.nearestPlayerTrackId ?? null;
  const ballTrackId = vision?.tracking?.ballTrackId ?? null;
  const roleGrounding =
    receiverTrackId || passerTrackId ? "structured_event" : nearestPlayerTrackId && ballTrackId ? "tracking_v0" : "unknown_grounding";
  return {
    segmentId: segment.id,
    player: football?.receivingPlayer.identity?.name ?? football?.passingPlayer.identity?.name ?? segment.domain?.scope?.players[0]?.value ?? "unknown_player",
    competition: segment.domain?.scope?.competition?.value ?? "unknown_competition",
    season: segment.domain?.scope?.season?.value ?? "unknown_season",
    eventType: event?.eventType ?? "unknown_event",
    passType: football?.passType ?? "unknown_pass",
    fieldZone: football?.fieldZone ?? "unknown_zone",
    role: football?.receivingPlayer.present ? "receiver" : football?.passingPlayer.present ? "passer" : event?.eventType === "shot" ? "shooter" : "unknown_role",
    roleGrounding,
    playerTrackId: receiverTrackId ?? passerTrackId ?? nearestPlayerTrackId ?? "unknown_player_track",
    ballTrackId: ballTrackId ?? "unknown_ball_track",
    ballDirection: vision?.tracking?.ballMovement.direction ?? "unknown_direction",
    ballState: football?.ball.state ?? "unknown_ball",
    confidence: event?.confidence ?? segment.confidence,
    verification
  };
}

function buildGroupAnalysisSubject(index: IndexRecord, assets: AssetRecord[], chapters: TimelineSegment[]): AssetRecord {
  const base = assets[0];
  const now = new Date().toISOString();
  if (base) {
    return {
      ...base,
      id: `asset-group:${index.id}`,
      indexId: index.id,
      title: index.name,
      description: index.description,
      summary: `Asset group analysis across ${assets.length} indexed assets and ${chapters.length} retrieved moments.`,
      timeline: chapters,
      keyframes: base.keyframes.filter((keyframe) => chapters.some((segment) => segment.id === keyframe.segmentId)),
      updatedAt: now
    };
  }
  return {
    id: `asset-group:${index.id}`,
    indexId: index.id,
    title: index.name,
    description: index.description,
    originalName: index.name,
    storedName: "",
    mimeType: "application/octet-stream",
    size: 0,
    duration: null,
    width: null,
    height: null,
    status: "indexed",
    progress: 100,
    tags: [],
    summary: "Asset group analysis has no indexed assets available.",
    timeline: chapters,
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local",
      bucket: "analysis",
      objectKey: index.id,
      checksum: null,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    },
    intelligence: {
      audio: { extractedPath: null, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
      asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0, frames: [] },
      visual: { labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0 },
      modelTrace: []
    },
    error: null,
    createdAt: now,
    updatedAt: now
  };
}

function aggregatePatterns(features: ReturnType<typeof featureFromSegment>[]): AnalysisResult["patterns"] {
  const verification = features.flatMap((feature) => feature.verification);
  const topGroups = [
    ...topFeatureGroups(features, "fieldZone", "Zone"),
    ...topFeatureGroups(features, "passType", "Pass"),
    ...topFeatureGroups(features, "eventType", "Event"),
    ...topFeatureGroups(features, "player", "Player"),
    ...topFeatureGroups(features, "season", "Season"),
    ...topFeatureGroups(features, "roleGrounding", "Role grounding"),
    ...topFeatureGroups(features, "ballDirection", "Ball direction")
  ]
    .filter((group) => !group.key.startsWith("unknown_"))
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, 8);
  const gaps = [
    features.some((feature) => feature.player === "unknown_player") ? "Some moments have no resolved player identity." : "",
    features.some((feature) => feature.season === "unknown_season") ? "Some moments have no season scope." : "",
    features.some((feature) => feature.competition === "unknown_competition") ? "Some moments have no competition scope." : "",
    features.some((feature) => feature.playerTrackId === "unknown_player_track") ? "Some moments have no player track grounding." : "",
    features.some((feature) => feature.ballTrackId === "unknown_ball_track") ? "Some moments have no ball track grounding." : "",
    verification.some((check) => check.status === "fail") ? "Some retrieved moments failed structured verification." : "",
    verification.some((check) => check.status === "unknown") ? "Some constraints are missing indexed evidence." : ""
  ].filter(Boolean);
  return {
    totalMoments: features.length,
    verifiedConstraints: verification.filter((check) => check.status === "pass").length,
    uncertainConstraints: verification.filter((check) => check.status === "soft_pass" || check.status === "unknown").length,
    failedConstraints: verification.filter((check) => check.status === "fail").length,
    topGroups,
    gaps
  };
}

function buildAnalysisEvidencePlan(moments: AnalysisMoment[]) {
  const scored = moments.map(scoreAnalysisMoment).sort((a, b) => b.evidenceScore - a.evidenceScore);
  const included = scored.filter((moment) => moment.evidenceTier !== "weak" && moment.failedChecks === 0);
  return {
    scored,
    included
  };
}

function scoreAnalysisMoment(moment: AnalysisMoment): ScoredAnalysisMoment {
  const hardChecks = moment.verification.filter((check) => check.status === "pass").length;
  const softChecks = moment.verification.filter((check) => check.status === "soft_pass").length;
  const missingChecks = moment.verification.filter((check) => check.status === "unknown").length;
  const failedChecks = moment.verification.filter((check) => check.status === "fail").length;
  const hardConfidence = moment.verification
    .filter((check) => check.status === "pass")
    .reduce((sum, check) => sum + check.confidence, 0);
  const softConfidence = moment.verification
    .filter((check) => check.status === "soft_pass")
    .reduce((sum, check) => sum + check.confidence, 0);
  const structuredEventBoost = moment.segment.domain?.events?.length ? 12 : 0;
  const trackingBoost = moment.segment.sceneData?.vision?.tracking ? 8 : 0;
  const sourceBoost = Math.min(10, Math.round(scoreSources(moment.segment.sources) * 3));
  const base = moment.verification.length > 0 ? 35 : Math.round(moment.segment.confidence * 70);
  const rawEvidenceScore = clampScore(
    base +
      hardChecks * 14 +
      softChecks * 7 +
      Math.round(hardConfidence * 18) +
      Math.round(softConfidence * 8) +
      structuredEventBoost +
      trackingBoost +
      sourceBoost -
      missingChecks * 11 -
      failedChecks * 28
  );
  const evidenceScore = clampScore(Math.min(rawEvidenceScore, failedChecks > 0 ? 44 : missingChecks > 0 ? 60 : softChecks > 0 ? 74 : 100));
  const evidenceTier: AnalysisResult["evidence"]["tier"] =
    evidenceScore >= 75 && hardChecks > 0 && softChecks === 0 && missingChecks === 0 && failedChecks === 0 ? "verified" : evidenceScore >= 45 && failedChecks === 0 ? "review" : "weak";
  return {
    ...moment,
    evidenceScore,
    evidenceTier,
    hardChecks,
    softChecks,
    missingChecks,
    failedChecks
  };
}

function summarizeAnalysisEvidence(scored: ScoredAnalysisMoment[], included: AnalysisMoment[]): AnalysisResult["evidence"] {
  const includedIds = new Set(included.map((moment) => `${moment.asset.id}:${moment.segment.id}`));
  const includedScored = scored.filter((moment) => includedIds.has(`${moment.asset.id}:${moment.segment.id}`));
  const hardChecks = includedScored.reduce((sum, moment) => sum + moment.hardChecks, 0);
  const softChecks = includedScored.reduce((sum, moment) => sum + moment.softChecks, 0);
  const missingChecks = includedScored.reduce((sum, moment) => sum + moment.missingChecks, 0);
  const failedChecks = includedScored.reduce((sum, moment) => sum + moment.failedChecks, 0);
  const trustScore = includedScored.length > 0 ? Math.round(includedScored.reduce((sum, moment) => sum + moment.evidenceScore, 0) / includedScored.length) : 0;
  const tier: AnalysisResult["evidence"]["tier"] =
    trustScore >= 75 && hardChecks > 0 && softChecks === 0 && missingChecks === 0 && failedChecks === 0 ? "verified" : trustScore >= 45 && failedChecks === 0 ? "review" : "weak";
  const confirmedPatterns = buildEvidencePatternBullets(includedScored.filter((moment) => moment.evidenceTier === "verified")).slice(0, 5);
  const likelyPatterns = buildEvidencePatternBullets(includedScored.filter((moment) => moment.evidenceTier === "review")).slice(0, 5);
  const weakMoments = scored.filter((moment) => !includedIds.has(`${moment.asset.id}:${moment.segment.id}`));
  const needsReview = unique([
    ...includedScored
      .filter((moment) => moment.softChecks > 0)
      .flatMap((moment) => moment.verification.filter((check) => check.status === "soft_pass").map((check) => `${check.constraint} uses soft evidence for ${moment.segment.label}.`)),
    ...weakMoments
      .slice(0, 5)
      .map((moment) => `${moment.segment.label} was excluded from analysis because trust score was ${moment.evidenceScore}%.`)
  ]).slice(0, 6);
  const missingEvidence = unique(
    scored.flatMap((moment) =>
      moment.verification
        .filter((check) => check.status === "unknown" || check.status === "fail")
        .map((check) => `${check.constraint}: expected ${check.expected}, observed ${check.observed}.`)
    )
  ).slice(0, 6);
  const limitations = unique([
    includedScored.some((moment) => moment.segment.sceneData?.vision?.fieldCalibration?.status !== "calibrated") ? "Field zone findings may rely on estimated calibration, not pitch homography." : "",
    includedScored.some((moment) => moment.segment.sceneData?.vision?.tracking?.status !== "tracked") ? "Player and ball grounding may use estimated tracking rather than verified track identity." : "",
    includedScored.some((moment) => moment.segment.domain?.vlm?.status !== "refined") ? "Some scene descriptions still use local heuristics instead of refined VLM evidence." : "",
    missingEvidence.length > 0 ? "Missing or failed checks are excluded from confirmed claims." : "",
    includedScored.length === 0 && scored.length > 0 ? "No retrieved moments met the minimum evidence threshold for analysis." : ""
  ].filter(Boolean)).slice(0, 6);
  return {
    trustScore,
    tier,
    hardChecks,
    softChecks,
    missingChecks,
    failedChecks,
    includedMoments: includedScored.length,
    excludedMoments: Math.max(0, scored.length - includedScored.length),
    confirmedPatterns,
    likelyPatterns,
    needsReview,
    missingEvidence,
    limitations
  };
}

function buildEvidencePatternBullets(moments: ScoredAnalysisMoment[]) {
  return unique(
    moments.map((moment) => {
      const feature = featureFromSegment(moment.segment, moment.verification);
      const playerCheck = moment.verification.find((check) => check.constraint === "player");
      const fieldZoneCheck = moment.verification.find((check) => check.constraint === "fieldZone");
      const player =
        playerCheck?.status === "pass"
          ? playerCheck.observed
          : playerCheck
            ? "player identity review"
            : feature.player !== "unknown_player"
              ? feature.player
              : "";
      const fieldZone =
        fieldZoneCheck?.status === "pass"
          ? fieldZoneCheck.observed
          : fieldZoneCheck?.status === "soft_pass"
            ? `${fieldZoneCheck.expected.replace(/_/g, " ")} (estimated)`
            : fieldZoneCheck
              ? "field zone review"
              : feature.fieldZone !== "unknown_zone"
                ? feature.fieldZone.replace(/_/g, " ")
                : "";
      const parts = [
        player,
        feature.role !== "unknown_role" ? feature.role : "",
        feature.passType !== "unknown_pass" ? feature.passType.replace(/_/g, " ") : "",
        feature.eventType !== "unknown_event" ? feature.eventType.replace(/_/g, " ") : "",
        fieldZone,
        feature.season !== "unknown_season" ? feature.season : ""
      ].filter(Boolean);
      return parts.length > 0 ? `${parts.join(" · ")} (${formatTime(moment.segment.start)}-${formatTime(moment.segment.end)})` : `${moment.segment.label} (${formatTime(moment.segment.start)}-${formatTime(moment.segment.end)})`;
    })
  );
}

function buildEvidenceAwareSummary(summary: string, evidence: AnalysisResult["evidence"]) {
  const prefix = `Evidence ${evidence.tier} (${evidence.trustScore}%) from ${evidence.includedMoments} included moments`;
  const excluded = evidence.excludedMoments > 0 ? `; ${evidence.excludedMoments} low-trust moments excluded` : "";
  return `${prefix}${excluded}. ${summary}`;
}

function buildEvidenceAwareReport(report: AnalysisResult["report"], evidence: AnalysisResult["evidence"]): AnalysisResult["report"] {
  const evidenceSections: AnalysisResult["report"]["sections"] = [
    {
      heading: "Confirmed Patterns",
      body: evidence.confirmedPatterns.length > 0 ? "These claims are backed by hard verification checks." : "No pattern currently has enough hard evidence to be treated as confirmed.",
      bullets: evidence.confirmedPatterns.length > 0 ? evidence.confirmedPatterns : ["No confirmed pattern available."]
    },
    {
      heading: "Likely Patterns",
      body: evidence.likelyPatterns.length > 0 ? "These claims are useful but rely on soft or partial evidence." : "No likely pattern was separated from the retrieved moments.",
      bullets: evidence.likelyPatterns.length > 0 ? evidence.likelyPatterns : ["No likely pattern available."]
    },
    {
      heading: "Needs Review",
      body: evidence.needsReview.length > 0 ? "These moments or constraints should be checked before editorial use." : "No review-only warnings were produced.",
      bullets: evidence.needsReview.length > 0 ? evidence.needsReview : ["No review-only warning available."]
    },
    {
      heading: "Missing Evidence",
      body: evidence.missingEvidence.length > 0 ? "The index could not ground these constraints with current data." : "No missing or failed constraint evidence was found in included moments.",
      bullets: evidence.missingEvidence.length > 0 ? evidence.missingEvidence : ["No missing evidence item available."]
    },
    {
      heading: "Data Limitations",
      body: "Analysis is bounded by the indexed evidence and current sports-domain extraction quality.",
      bullets: evidence.limitations.length > 0 ? evidence.limitations : ["No major indexed limitation was detected."]
    }
  ];
  const generatorSections = report.sections.filter((section) => !evidenceSections.some((item) => item.heading === section.heading));
  return {
    ...report,
    confidence: Number(Math.min(report.confidence, evidence.trustScore > 0 ? evidence.trustScore / 100 : 0).toFixed(2)),
    sections: [...evidenceSections, ...generatorSections],
    limitations: unique([...evidence.limitations, ...report.limitations])
  };
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function topFeatureGroups(
  features: ReturnType<typeof featureFromSegment>[],
  key: "player" | "competition" | "season" | "eventType" | "passType" | "fieldZone" | "role" | "roleGrounding" | "ballDirection",
  label: string
) {
  const groups = new Map<string, { count: number; confidence: number }>();
  for (const feature of features) {
    const value = feature[key];
    const current = groups.get(value) ?? { count: 0, confidence: 0 };
    groups.set(value, {
      count: current.count + 1,
      confidence: current.confidence + feature.confidence
    });
  }
  return Array.from(groups.entries()).map(([value, group]) => ({
    key: value,
    label: `${label}: ${value.replace(/_/g, " ")}`,
    count: group.count,
    share: features.length > 0 ? Number((group.count / features.length).toFixed(2)) : 0,
    confidence: Number((group.confidence / Math.max(1, group.count)).toFixed(2)),
    tier: group.confidence / Math.max(1, group.count) >= 0.75 ? "confirmed" : group.confidence / Math.max(1, group.count) >= 0.45 ? "likely" : "review"
  })) satisfies AnalysisResult["patterns"]["topGroups"];
}

function clipFromSegment(asset: AssetRecord, segment: TimelineSegment, verification: VerificationCheck[], reasons: SearchMatchReason[]): ClipResult {
  const event = segment.domain?.events[0];
  const football = event?.football;
  const player = football?.receivingPlayer.identity?.name ?? football?.passingPlayer.identity?.name ?? segment.domain?.scope?.players[0]?.value ?? null;
  const start = Math.max(0, Number((segment.start - 2).toFixed(2)));
  const end = Number((segment.end + 2).toFixed(2));
  return {
    id: `${asset.id}:${segment.id}:clip`,
    assetId: asset.id,
    segmentId: segment.id,
    title: `${formatTime(segment.start)}-${formatTime(segment.end)} · ${segment.label}`,
    start,
    end,
    thumbnailPath: segment.sceneData?.image.thumbnailPath ?? segment.thumbnailPath,
    event: event?.eventType ?? segment.sceneData?.vision?.eventClassification?.label ?? "moment",
    player,
    confidence: Number(Math.max(event?.confidence ?? 0, segment.confidence).toFixed(2)),
    verificationSummary: summarizeVerification(verification),
    reasons: unique([
      event?.caption ?? "",
      ...reasons.map((reason) => `${reason.label}: ${reason.value}`),
      ...(event?.evidence.heuristics ?? [])
    ].filter(Boolean)).slice(0, 6)
  };
}

function summarizeVerification(verification: VerificationCheck[]): ClipResult["verificationSummary"] {
  return {
    pass: verification.filter((check) => check.status === "pass").length,
    softPass: verification.filter((check) => check.status === "soft_pass").length,
    unknown: verification.filter((check) => check.status === "unknown").length,
    fail: verification.filter((check) => check.status === "fail").length
  };
}

export function checksum(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function extractKeywords(input: string) {
  return unique(
    input
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .map((term) => term.trim().replace(/^-+|-+$/g, ""))
      .filter((term) => !stopWords.has(term) && (/[가-힣]/.test(term) ? term.length >= 2 : term.length > 2))
  ).slice(0, 24);
}

function scoreText(input: string, queryTerms: string[]) {
  const haystack = input.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function scoreSources(sources: TimelineSegment["sources"]) {
  let score = 0;
  if (sources.includes("whisper")) score += 0.75;
  if (sources.includes("paddleocr")) score += 0.65;
  if (sources.includes("shot")) score += 0.45;
  if (sources.includes("visual")) score += 0.25;
  if (sources.includes("metadata")) score += 0.1;
  return score;
}

function scoreVlmQuality(segment: TimelineSegment) {
  const quality = segment.domain?.vlm;
  if (!quality) return 0;
  if (quality.status === "refined") return 0.8 + quality.confidence;
  if (quality.status === "invalid") return -0.8;
  if (quality.status === "failed") return -1.2;
  return 0;
}

function hasActiveDomainFilters(filters?: DomainSearchFilters) {
  return Boolean(filters && Object.values(filters).some((value) => typeof value === "string" && value.trim().length > 0));
}

function matchesAssetDomainText(asset: AssetRecord, filters?: DomainSearchFilters) {
  if (!filters) return true;
  const terms = [filters.player].map((value) => value?.trim()).filter(Boolean) as string[];
  if (terms.length === 0) return true;
  const haystack = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.originalName,
      asset.tags.join(" "),
      asset.summary,
      asset.intelligence.asr.transcript,
      asset.intelligence.ocr.tokens.join(" "),
      asset.timeline.map((segment) => segmentSearchText(segment)).join(" ")
    ].join(" ")
  );
  return terms.every((term) => haystack.includes(normalizeSearchValue(term)));
}

function matchesSegmentDomainFilters(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters) {
  if (!filters || !hasActiveDomainFilters(filters)) return true;
  const fullSegmentText = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.originalName,
      asset.tags.join(" "),
      segment.label,
      segment.transcript,
      segment.tags.join(" "),
      segmentSearchText(segment),
      segment.domain?.searchText,
      ...(segment.domain?.events.flatMap((event) => [
        event.caption,
        ...event.labels,
        ...event.evidence.asr,
        ...event.evidence.ocr,
        ...event.evidence.metadata,
        ...event.evidence.heuristics
      ]) ?? [])
    ].join(" ")
  );
  if (!scopeFilterAllows(segment, "competition", filters.competition) && !textAllowsFilter(fullSegmentText, filters.competition)) return false;
  if (!scopeFilterAllows(segment, "season", filters.season) && !textAllowsFilter(fullSegmentText, filters.season)) return false;
  const textTerms = [filters.player].map((value) => value?.trim()).filter(Boolean) as string[];
  if (textTerms.length > 0) {
    if (!textTerms.every((term) => fullSegmentText.includes(normalizeSearchValue(term)))) return false;
  }

  const eventFilters = {
    eventType: filters.eventType?.trim(),
    passType: filters.passType?.trim(),
    fieldZone: filters.fieldZone?.trim(),
    role: filters.role?.trim()
  };
  const needsEventMatch = Object.values(eventFilters).some(Boolean);
  if (!needsEventMatch) return true;
  const structuredMatch = (segment.domain?.events ?? []).some((event) => {
    if (eventFilters.eventType && event.eventType !== eventFilters.eventType) return false;
    if (eventFilters.passType && event.football?.passType !== eventFilters.passType) return false;
    if (eventFilters.fieldZone && event.football?.fieldZone !== eventFilters.fieldZone) return false;
    if (filters.role === "receiver" && !event.football?.receivingPlayer.present) return false;
    if (filters.role === "passer" && !event.football?.passingPlayer.present) return false;
    if (filters.role === "shooter" && event.eventType !== "shot") return false;
    return true;
  });
  if (structuredMatch) return true;
  if (eventFilters.passType || eventFilters.fieldZone) return false;
  if (eventFilters.eventType && textAllowsEventFilter(fullSegmentText, eventFilters.eventType)) return true;
  return false;
}

function textAllowsFilter(haystack: string, value?: string) {
  const normalized = normalizeSearchValue(value ?? "");
  return Boolean(normalized && haystack.includes(normalized));
}

function textAllowsEventFilter(haystack: string, eventType: string) {
  const aliases: Record<string, string[]> = {
    shot: ["shot", "shoot", "scoring", "scored", "score", "goal", "goals", "finish", "득점", "골", "슈팅", "슛"],
    dribble: ["dribble", "dribbling", "carry", "take on", "드리블", "돌파"],
    pass_receive: ["receive", "receiving", "through ball", "pass", "받는", "스루패스", "패스"],
    pressure: ["pressure", "pressured", "under pressure", "압박"],
    scramble: ["scramble", "스크램블"],
    pocket_escape: ["pocket escape", "out of the pocket", "포켓 탈출"],
    throw_on_run: ["throw on the run", "rolling", "이동 중 패스"]
  };
  return (aliases[eventType] ?? [eventType]).some((alias) => textAllowsFilter(haystack, alias));
}

function scoreDomainFilterMatch(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters) {
  if (!filters || !hasActiveDomainFilters(filters)) return 0;
  const checks = buildVerificationChecks(asset, segment, filters);
  return Number(
    checks
      .reduce((score, check) => {
        if (check.status === "pass") return score + 1;
        if (check.status === "soft_pass") return score + 0.45;
        return score;
      }, 0)
      .toFixed(3)
  );
}

function scopeFilterAllows(segment: TimelineSegment, field: "competition" | "season", filterValue?: string) {
  const normalizedFilter = normalizeSearchValue(filterValue ?? "");
  if (!normalizedFilter) return true;
  const scopeValue = field === "competition" ? segment.domain?.scope?.competition : segment.domain?.scope?.season;
  if (!scopeValue) return false;
  return normalizeSearchValue(scopeValue.value).includes(normalizedFilter) || normalizedFilter.includes(normalizeSearchValue(scopeValue.value));
}

function buildVerificationChecks(asset: AssetRecord, segment: TimelineSegment, filters?: DomainSearchFilters): VerificationCheck[] {
  if (!filters || !hasActiveDomainFilters(filters)) return [];
  const checks: VerificationCheck[] = [];
  const events = segment.domain?.events ?? [];
  const segmentText = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      asset.originalName,
      asset.tags.join(" "),
      segment.label,
      segment.transcript,
      segmentSearchText(segment),
      segment.domain?.searchText
    ].join(" ")
  );
  const pushTextBackedCheck = (constraint: VerificationCheck["constraint"], expected: string | undefined, observed: string | null, confidence: number, evidence: string[]) => {
    if (!expected) return;
    const normalizedExpected = normalizeSearchValue(expected);
    const normalizedObserved = normalizeSearchValue(observed ?? "");
    if (normalizedObserved && (normalizedObserved.includes(normalizedExpected) || normalizedExpected.includes(normalizedObserved))) {
      checks.push({ segmentId: segment.id, constraint, expected, observed: observed ?? "", status: "pass", confidence, evidence });
    } else if (segmentText.includes(normalizedExpected)) {
      checks.push({ segmentId: segment.id, constraint, expected, observed: "text fallback", status: "soft_pass", confidence: 0.45, evidence: ["Matched unstructured text fallback."] });
    } else {
      checks.push({ segmentId: segment.id, constraint, expected, observed: observed ?? "missing", status: "unknown", confidence: 0, evidence: ["No indexed evidence for this constraint."] });
    }
  };

  pushTextBackedCheck(
    "competition",
    filters.competition,
    segment.domain?.scope?.competition?.value ?? null,
    segment.domain?.scope?.competition?.confidence ?? 0,
    segment.domain?.scope?.competition?.evidence ?? []
  );
  pushTextBackedCheck("season", filters.season, segment.domain?.scope?.season?.value ?? null, segment.domain?.scope?.season?.confidence ?? 0, segment.domain?.scope?.season?.evidence ?? []);

  if (filters.player) {
    const identities = events
      .flatMap((event) => [event.football?.receivingPlayer.identity, event.football?.passingPlayer.identity])
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
    const scopedPlayers = segment.domain?.scope?.players ?? [];
    const player = [...identities, ...scopedPlayers].find((candidate) => {
      const value = "name" in candidate ? candidate.name : candidate.value;
      const normalized = normalizeSearchValue(value);
      const expected = normalizeSearchValue(filters.player ?? "");
      return normalized.includes(expected) || expected.includes(normalized);
    });
    const observed = player ? ("name" in player ? player.name : player.value) : null;
    const confidence = player?.confidence ?? 0;
    const evidence = player?.evidence ?? [];
    pushTextBackedCheck("player", filters.player, observed, confidence, evidence);
    const team = playerTeamForSeason(filters.player, filters.season);
    if (team) {
      const observedTeams = segment.domain?.scope?.teams.map((item) => item.value) ?? [];
      const normalizedTeam = normalizeSearchValue(team);
      const teamMatch = observedTeams.find((item) => normalizeSearchValue(item).includes(normalizedTeam) || normalizedTeam.includes(normalizeSearchValue(item)));
      checks.push({
        segmentId: segment.id,
        constraint: "player",
        expected: `${filters.player} roster team ${team}`,
        observed: teamMatch ?? (observedTeams.join(", ") || "missing"),
        status: teamMatch ? "pass" : observedTeams.length === 0 ? "unknown" : "fail",
        confidence: teamMatch ? 0.82 : 0,
        evidence: teamMatch ? [`Knowledge roster team for ${filters.player}: ${team}`] : ["No matching team scope for roster verification."]
      });
    }
  }

  const firstMatchingEvent = events[0];
  if (filters.eventType) {
    const match = events.find((event) => event.eventType === filters.eventType);
    const textMatch = !match && textAllowsEventFilter(segmentText, filters.eventType);
    checks.push({
      segmentId: segment.id,
      constraint: "eventType",
      expected: filters.eventType,
      observed: match?.eventType ?? (textMatch ? "text fallback" : firstMatchingEvent?.eventType ?? "missing"),
      status: match ? "pass" : textMatch ? "soft_pass" : "fail",
      confidence: match?.confidence ?? (textMatch ? 0.45 : 0),
      evidence: match ? [match.caption] : textMatch ? ["Matched unstructured event text fallback."] : ["No matching structured event type."]
    });
  }
  if (filters.passType) {
    const match = events.find((event) => event.football?.passType === filters.passType);
    checks.push({
      segmentId: segment.id,
      constraint: "passType",
      expected: filters.passType,
      observed: match?.football?.passType ?? firstMatchingEvent?.football?.passType ?? "missing",
      status: match ? "pass" : "fail",
      confidence: match?.football?.ball.confidence ?? 0,
      evidence: match ? [match.caption] : ["No matching structured pass type."]
    });
  }
  if (filters.fieldZone) {
    const match = events.find((event) => event.football?.fieldZone === filters.fieldZone);
    const calibration = match?.football?.field;
    const status = match
      ? calibration?.calibrationStatus === "calibrated"
        ? "pass"
        : calibration?.calibrationStatus === "estimated"
          ? "soft_pass"
          : "unknown"
      : "fail";
    checks.push({
      segmentId: segment.id,
      constraint: "fieldZone",
      expected: filters.fieldZone,
      observed: match?.football?.fieldZone ?? firstMatchingEvent?.football?.fieldZone ?? "missing",
      status,
      confidence: match?.football?.field.zoneConfidence ?? 0,
      evidence: match
        ? [
            match.caption,
            `Field calibration: ${calibration?.calibrationStatus ?? "not_configured"}`,
            ...(segment.sceneData?.vision?.fieldCalibration?.evidence ?? [])
          ].filter(Boolean)
        : ["No matching structured field zone."]
    });
  }
  if (filters.role && filters.role !== "any") {
    const match = events.find((event) => {
      if (filters.role === "receiver") return event.football?.receivingPlayer.present;
      if (filters.role === "passer") return event.football?.passingPlayer.present;
      if (filters.role === "shooter") return event.eventType === "shot";
      return false;
    });
    const textMatch = !match && filters.role === "shooter" && textAllowsEventFilter(segmentText, "shot");
    checks.push({
      segmentId: segment.id,
      constraint: "role",
      expected: filters.role,
      observed: match ? filters.role : textMatch ? "text fallback" : "missing",
      status: match ? "pass" : textMatch ? "soft_pass" : "fail",
      confidence: match?.confidence ?? (textMatch ? 0.4 : 0),
      evidence: match ? [match.caption] : textMatch ? ["Matched unstructured goal/shot text fallback."] : ["No matching structured player role."]
    });
  }
  return checks;
}

function buildSearchMatchReasons(
  asset: AssetRecord,
  segment: TimelineSegment,
  scores: {
    lexicalScore: number;
    semanticScore: number;
    visualScore: number;
    domainScore: number;
    knowledgeScore?: number;
  },
  filters?: DomainSearchFilters,
  queryPlan?: DomainQueryPlan
): SearchMatchReason[] {
  const reasons: SearchMatchReason[] = [];
  const events = segment.domain?.events ?? [];
  const firstEvent = events[0];
  const segmentText = normalizeSearchValue(
    [
      asset.title,
      asset.description,
      segment.label,
      segment.transcript,
      segment.tags.join(" "),
      segmentSearchText(segment),
      segment.domain?.searchText
    ].join(" ")
  );

  if (queryPlan && Object.keys(queryPlan.domainFilters).length > 0) {
    reasons.push({
      segmentId: segment.id,
      kind: "query_plan",
      label: "Query plan",
      value: queryPlan.rewrittenQuery,
      confidence: queryPlan.confidence
    });
  }

  if (filters?.competition && segmentText.includes(normalizeSearchValue(filters.competition))) {
    reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Competition", value: filters.competition });
  }
  if (filters?.season && segmentText.includes(normalizeSearchValue(filters.season))) {
    reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Season", value: filters.season });
  }
  if (firstEvent && segment.domain?.scope?.competition) {
    const competition = segment.domain.scope.competition;
    reasons.push({
      segmentId: segment.id,
      kind: "domain_filter",
      label: "Scope competition",
      value: `${competition.value} (${competition.source})`,
      confidence: competition.confidence
    });
  }
  if (firstEvent && segment.domain?.scope?.season) {
    const season = segment.domain.scope.season;
    reasons.push({
      segmentId: segment.id,
      kind: "domain_filter",
      label: "Scope season",
      value: `${season.value} (${season.source})`,
      confidence: season.confidence
    });
  }
  if (filters?.player && segmentText.includes(normalizeSearchValue(filters.player))) {
    reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Player", value: filters.player });
  }

  for (const event of events) {
    if (filters?.eventType && event.eventType === filters.eventType) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Event", value: filters.eventType, confidence: event.confidence });
    }
    if (filters?.passType && event.football?.passType === filters.passType) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Pass", value: filters.passType, confidence: event.football.ball.confidence });
    }
    if (filters?.fieldZone && event.football?.fieldZone === filters.fieldZone) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Zone", value: filters.fieldZone, confidence: event.football.field.zoneConfidence });
    }
    if (filters?.role === "receiver" && event.football?.receivingPlayer.present) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Role", value: "receiver", confidence: event.football.receivingPlayer.confidence });
    }
  }

  if (scores.lexicalScore > 0) {
    reasons.push({ segmentId: segment.id, kind: "lexical", label: "Text", value: `${scores.lexicalScore} query terms matched` });
  }
  if (scores.domainScore > 0) {
    reasons.push({ segmentId: segment.id, kind: "semantic", label: "Domain rank", value: `${scores.domainScore} sports score` });
  }
  if ((scores.knowledgeScore ?? 0) > 0) {
    reasons.push({ segmentId: segment.id, kind: "evidence", label: "Knowledge", value: `${scores.knowledgeScore} grounded terms matched` });
  }
  if (scores.semanticScore > 0.72) {
    reasons.push({ segmentId: segment.id, kind: "semantic", label: "Vector", value: `${Math.round(scores.semanticScore * 100)}% text similarity` });
  }
  if (scores.visualScore > 0.25) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Visual", value: `${Math.round(scores.visualScore * 100)}% visual similarity` });
  }
  const vision = segment.sceneData?.vision;
  if (vision?.pitch.present) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Pitch", value: `estimated ${Math.round(vision.pitch.confidence * 100)}%`, confidence: vision.pitch.confidence });
  }
  if (vision && isObjectEvidenceReady(vision.objects.players.status)) {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Players",
      value: `${vision.objects.players.status} ${vision.objects.players.countEstimate}`,
      confidence: vision.objects.players.confidence
    });
  }
  if (vision && isObjectEvidenceReady(vision.objects.ball.status)) {
    reasons.push({ segmentId: segment.id, kind: "visual", label: "Ball", value: vision.objects.ball.status, confidence: vision.objects.ball.confidence });
  }
  if (vision && vision.fieldZone.zone !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Visual zone",
      value: vision.fieldCalibration
        ? `${vision.fieldZone.zone} · ${vision.fieldCalibration.status}/${vision.fieldCalibration.method}`
        : vision.fieldZone.zone,
      confidence: vision.fieldZone.confidence
    });
  }
  if (vision?.fieldCalibration && vision.fieldCalibration.attackingDirection !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Direction",
      value: vision.fieldCalibration.attackingDirection,
      confidence: vision.fieldCalibration.attackingDirectionConfidence
    });
  }
  if (vision?.tracking?.status === "tracked") {
    reasons.push({
      segmentId: segment.id,
      kind: "visual",
      label: "Track",
      value: [
        vision.tracking.ballTrackId ?? "ball untracked",
        vision.tracking.nearestPlayerTrackId ? `near ${vision.tracking.nearestPlayerTrackId}` : "",
        vision.tracking.ballMovement.direction !== "unknown" ? vision.tracking.ballMovement.direction : ""
      ]
        .filter(Boolean)
        .join(" · "),
      confidence: vision.tracking.continuity
    });
  }
  if (vision?.eventClassification && vision.eventClassification.label !== "unknown") {
    reasons.push({
      segmentId: segment.id,
      kind: "evidence",
      label: "Classifier",
      value: vision.eventClassification.label,
      confidence: vision.eventClassification.confidence
    });
  }

  if (firstEvent) {
    const receiverIdentity = firstEvent.football?.receivingPlayer.identity;
    const passerIdentity = firstEvent.football?.passingPlayer.identity;
    if (receiverIdentity) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Receiver ID", value: `${receiverIdentity.name} (${receiverIdentity.source})`, confidence: receiverIdentity.confidence });
    } else if (passerIdentity) {
      reasons.push({ segmentId: segment.id, kind: "domain_filter", label: "Player ID", value: `${passerIdentity.name} (${passerIdentity.source})`, confidence: passerIdentity.confidence });
    }
    for (const heuristic of firstEvent.evidence.heuristics.slice(0, 2)) {
      reasons.push({ segmentId: segment.id, kind: "evidence", label: "Evidence", value: heuristic, confidence: firstEvent.confidence });
    }
    for (const limitation of firstEvent.football?.limitations.slice(0, 1) ?? []) {
      reasons.push({ segmentId: segment.id, kind: "limitation", label: "Limitation", value: limitation });
    }
  }

  return reasons.slice(0, 10);
}

function formatDomainFilters(filters?: DomainSearchFilters) {
  if (!filters) return "none";
  return Object.entries(filters)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key}:${value}`)
    .join(",");
}

function normalizeSearchValue(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function recencyBoost(createdAt: string) {
  const ageDays = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  return Math.max(0, 0.6 - ageDays * 0.03);
}

export function vectorize(input: string) {
  const vector = new Array(16).fill(0);
  for (const term of extractKeywords(input)) {
    const hash = createHash("sha1").update(term).digest();
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] += (hash[index] - 128) / 128;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(4)));
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
  }
  return Math.max(0, Number(dot.toFixed(3)));
}

function chooseModalities(modalities: IndexRecord["modalities"], index: number) {
  const fallback: IndexRecord["modalities"] = ["metadata"];
  const source = modalities.length > 0 ? modalities : fallback;
  return unique([source[index % source.length], source[(index + 1) % source.length] ?? "metadata"]);
}

function parseFrameRate(value?: string) {
  if (!value || !value.includes("/")) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || !denominator) return null;
  return Number((numerator / denominator).toFixed(3));
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function toTitleCase(input: string) {
  return input.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
