import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnalysisResult, AssetRecord, DomainQueryPlan, DomainSearchFilters, IndexRecord, SearchMatchReason, SearchResult, TimelineSegment, VerificationCheck, VisionEvidence } from "../shared/types";
import { domainSearchText, expandDomainQuery, scoreDomainMatch, withDomainSegment } from "./domainIndex";
import { planDomainQuery } from "./queryPlanner";
import { createShotWindows, type SceneBoundary } from "./sceneDetection";

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
      confidence: zone === "unknown" ? 0 : Number(Math.min(0.54, confidenceBase - 0.05).toFixed(2)),
      method: zone === "unknown" ? "none" : "color_motion_heuristic"
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
  } = {}
): SearchResult[] {
  const domainProfile = expandDomainQuery(options.queryPlan?.semanticQuery ?? query);
  const queryTerms = extractKeywords(domainProfile.expandedText);
  const hasVectorHits = (options.vectorHitsBySegment?.size ?? 0) > 0 || (options.visualHitsBySegment?.size ?? 0) > 0;
  const hasDomainFilters = hasActiveDomainFilters(options.domainFilters);
  if (query.trim().length === 0 && queryTerms.length === 0 && !hasVectorHits && !hasDomainFilters) return [];
  const queryVector = options.queryVector ?? vectorize(domainProfile.expandedText);
  const limit = options.limit ?? 10;

  return assets
    .filter((asset) => asset.status === "indexed" || asset.timeline.length > 0)
    .filter((asset) => !options.indexId || asset.indexId === options.indexId)
    .filter((asset) => !options.tag || asset.tags.includes(options.tag))
    .filter((asset) => matchesAssetDomainText(asset, options.domainFilters))
    .map((asset) => {
      const assetLexicalScore = scoreText(`${asset.title} ${asset.description} ${asset.tags.join(" ")} ${asset.summary}`, queryTerms);
      const segmentCandidates = asset.timeline
        .filter((segment) => !options.modality || segment.modalities.includes(options.modality as TimelineSegment["modalities"][number]))
        .filter((segment) => matchesSegmentDomainFilters(asset, segment, options.domainFilters))
        .map((segment) => {
          const lexicalScore = scoreText(segmentSearchText(segment), queryTerms);
          const domainScore = scoreDomainMatch(segment, domainProfile);
          const filterScore = scoreDomainFilterMatch(asset, segment, options.domainFilters);
          const semanticScore = Math.max(
            queryVector.length === segment.embedding.length ? cosineSimilarity(queryVector, segment.embedding) : 0,
            options.vectorHitsBySegment?.get(segment.id) ?? 0
          );
          const visualScore = options.visualHitsBySegment?.get(segment.id) ?? 0;
          const sourceScore = scoreSources(segment.sources);
          const confidenceScore = segment.confidence;
          return {
            segment,
            lexicalScore,
            semanticScore,
            visualScore,
            sourceScore,
            confidenceScore,
            domainScore,
            filterScore,
            score: lexicalScore * 3 + domainScore * 5 + filterScore * 6 + semanticScore * 8 + visualScore * 6 + sourceScore + confidenceScore * 1.5
          };
        })
        .filter((item) => (hasDomainFilters ? item.filterScore > 0 : item.lexicalScore > 0 || item.domainScore > 0 || item.semanticScore > 0.72 || item.visualScore > 0.25));
      const lexicalSegmentMatches = segmentCandidates.filter((item) => item.lexicalScore > 0);
      const domainSegmentMatches = segmentCandidates.filter((item) => item.domainScore > 0);
      const semanticSegmentMatches = segmentCandidates.filter((item) => item.semanticScore > 0.72 || item.visualScore > 0.25);
      const matchingSegments = (hasDomainFilters
        ? segmentCandidates
        : lexicalSegmentMatches.length > 0 || domainSegmentMatches.length > 0
          ? [...lexicalSegmentMatches, ...domainSegmentMatches]
          : semanticSegmentMatches)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.segment.id === item.segment.id) === index)
        .sort((a, b) => b.score - a.score);

      const lexical = assetLexicalScore * 0.5 + matchingSegments.reduce((sum, item) => sum + item.lexicalScore, 0) * 3;
      const domain = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.domainScore, 0) * 5;
      const filters = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.filterScore, 0) * 6;
      const semantic = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.semanticScore, 0) * 8;
      const visual = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.visualScore, 0) * 6;
      const source = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.sourceScore, 0);
      const confidence = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.confidenceScore, 0) * 1.5;
      const recency = recencyBoost(asset.createdAt);
      const totalScore = Number((lexical + domain + filters + semantic + visual + source + confidence + recency).toFixed(3));
      const index = indexes.find((item) => item.id === asset.indexId) ?? null;
      const selectedSegments = matchingSegments.slice(0, 5);
      return {
        asset,
        index,
        segments: selectedSegments.map((item) => withSceneData(asset, item.segment)),
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
          `${Number(semantic.toFixed(3))} semantic rank score`,
          `${Number(visual.toFixed(3))} visual rank score`,
          `${Number(source.toFixed(3))} source quality boost`,
          `${Number(confidence.toFixed(3))} confidence boost`,
          `${matchingSegments.length} matching timeline segments`,
          hasDomainFilters ? `domain filters=${formatDomainFilters(options.domainFilters)}` : "",
          options.queryPlan ? `query plan=${options.queryPlan.rewrittenQuery}` : "",
          index ? `index=${index.name}` : "index=unknown"
        ].filter(Boolean),
        queryPlan: options.queryPlan ?? null,
        matchReasons: selectedSegments.flatMap((item) =>
          buildSearchMatchReasons(asset, item.segment, item, options.domainFilters, options.queryPlan)
        ),
        verification: selectedSegments.flatMap((item) => buildVerificationChecks(asset, item.segment, options.domainFilters))
      };
    })
    .filter((result) => result.score > 0 && result.segments.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function analyzeAsset(asset: AssetRecord, question = ""): AnalysisResult {
  const queryPlan = planDomainQuery(question);
  const domainProfile = expandDomainQuery(queryPlan.semanticQuery || question);
  const queryTerms = extractKeywords(domainProfile.expandedText);
  const candidateChapters = asset.timeline
    .filter((segment) => matchesSegmentDomainFilters(asset, segment, queryPlan.domainFilters))
    .map((segment) => {
      const lexicalScore = scoreText(`${segment.transcript} ${segment.tags.join(" ")} ${segmentSearchText(segment)}`, queryTerms);
      const domainScore = scoreDomainMatch(segment, domainProfile);
      const filterScore = scoreDomainFilterMatch(asset, segment, queryPlan.domainFilters);
      return {
        segment,
        score: lexicalScore * 2 + domainScore * 5 + filterScore * 6 + segment.confidence
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const chapters = (candidateChapters.length > 0 ? candidateChapters.map((item) => item.segment) : question.trim() ? [] : asset.timeline).slice(0, 6);
  const verification = chapters.flatMap((segment) => buildVerificationChecks(asset, segment, queryPlan.domainFilters));
  const verified = verification.filter((check) => check.status === "pass").length;
  const uncertain = verification.filter((check) => check.status === "soft_pass" || check.status === "unknown").length;
  const failed = verification.filter((check) => check.status === "fail").length;
  const features = chapters.map((segment) => featureFromSegment(segment, buildVerificationChecks(asset, segment, queryPlan.domainFilters)));
  const patterns = aggregatePatterns(features);
  const domainSignals = chapters.flatMap((segment) => [
    ...(segment.domain?.labels ?? []),
    ...(segment.domain?.scope?.players.map((player) => player.value) ?? []),
    segment.domain?.scope?.competition?.value ?? "",
    segment.domain?.scope?.season?.value ?? ""
  ]);
  const signals = unique([...(chapters.length > 0 ? asset.tags.slice(0, 6) : []), ...chapters.flatMap((segment) => segment.tags), ...domainSignals].filter(Boolean)).slice(0, 12);
  const answer =
    question.trim().length > 0
      ? `Grounded analysis for "${question}" used ${chapters.length} retrieved moments with ${verified} verified constraints, ${uncertain} soft or missing constraints, and ${failed} failed constraints. ${
          signals.length > 0 ? `Strongest signals are ${signals.slice(0, 6).join(", ")}.` : "No grounded signals were available."
        } Review ${chapters
          .map((chapter) => `${formatTime(chapter.start)}-${formatTime(chapter.end)}`)
          .join(", ") || "no grounded moments"}.`
      : `The asset is indexed with ${asset.timeline.length} segments and emphasizes ${signals.slice(0, 5).join(", ")}.`;

  return {
    assetId: asset.id,
    indexId: asset.indexId,
    summary: asset.summary,
    answer,
    chapters,
    signals,
    patterns,
    generatedAt: new Date().toISOString()
  };
}

function featureFromSegment(segment: TimelineSegment, verification: VerificationCheck[]) {
  const event = segment.domain?.events[0];
  const football = event?.football;
  return {
    segmentId: segment.id,
    player: football?.receivingPlayer.identity?.name ?? football?.passingPlayer.identity?.name ?? segment.domain?.scope?.players[0]?.value ?? "unknown_player",
    competition: segment.domain?.scope?.competition?.value ?? "unknown_competition",
    season: segment.domain?.scope?.season?.value ?? "unknown_season",
    eventType: event?.eventType ?? "unknown_event",
    passType: football?.passType ?? "unknown_pass",
    fieldZone: football?.fieldZone ?? "unknown_zone",
    role: football?.receivingPlayer.present ? "receiver" : football?.passingPlayer.present ? "passer" : event?.eventType === "shot" ? "shooter" : "unknown_role",
    ballState: football?.ball.state ?? "unknown_ball",
    confidence: event?.confidence ?? segment.confidence,
    verification
  };
}

function aggregatePatterns(features: ReturnType<typeof featureFromSegment>[]): AnalysisResult["patterns"] {
  const verification = features.flatMap((feature) => feature.verification);
  const topGroups = [
    ...topFeatureGroups(features, "fieldZone", "Zone"),
    ...topFeatureGroups(features, "passType", "Pass"),
    ...topFeatureGroups(features, "eventType", "Event"),
    ...topFeatureGroups(features, "player", "Player"),
    ...topFeatureGroups(features, "season", "Season")
  ]
    .filter((group) => !group.key.startsWith("unknown_"))
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, 8);
  const gaps = [
    features.some((feature) => feature.player === "unknown_player") ? "Some moments have no resolved player identity." : "",
    features.some((feature) => feature.season === "unknown_season") ? "Some moments have no season scope." : "",
    features.some((feature) => feature.competition === "unknown_competition") ? "Some moments have no competition scope." : "",
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

function topFeatureGroups(features: ReturnType<typeof featureFromSegment>[], key: "player" | "competition" | "season" | "eventType" | "passType" | "fieldZone" | "role", label: string) {
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
    confidence: Number((group.confidence / Math.max(1, group.count)).toFixed(2))
  }));
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
  if (!scopeFilterAllows(segment, "competition", filters.competition)) return false;
  if (!scopeFilterAllows(segment, "season", filters.season)) return false;
  const textTerms = [filters.player].map((value) => value?.trim()).filter(Boolean) as string[];
  if (textTerms.length > 0) {
    const segmentText = normalizeSearchValue(
      [
        asset.title,
        asset.description,
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
    if (!textTerms.every((term) => segmentText.includes(normalizeSearchValue(term)))) return false;
  }

  const eventFilters = {
    eventType: filters.eventType?.trim(),
    passType: filters.passType?.trim(),
    fieldZone: filters.fieldZone?.trim(),
    role: filters.role?.trim()
  };
  const needsEventMatch = Object.values(eventFilters).some(Boolean);
  if (!needsEventMatch) return true;
  return (segment.domain?.events ?? []).some((event) => {
    if (eventFilters.eventType && event.eventType !== eventFilters.eventType) return false;
    if (eventFilters.passType && event.football?.passType !== eventFilters.passType) return false;
    if (eventFilters.fieldZone && event.football?.fieldZone !== eventFilters.fieldZone) return false;
    if (filters.role === "receiver" && !event.football?.receivingPlayer.present) return false;
    if (filters.role === "passer" && !event.football?.passingPlayer.present) return false;
    if (filters.role === "shooter" && event.eventType !== "shot") return false;
    return true;
  });
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
  if (!scopeValue) return true;
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
  }

  const firstMatchingEvent = events[0];
  if (filters.eventType) {
    const match = events.find((event) => event.eventType === filters.eventType);
    checks.push({
      segmentId: segment.id,
      constraint: "eventType",
      expected: filters.eventType,
      observed: match?.eventType ?? firstMatchingEvent?.eventType ?? "missing",
      status: match ? "pass" : "fail",
      confidence: match?.confidence ?? 0,
      evidence: match ? [match.caption] : ["No matching structured event type."]
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
    checks.push({
      segmentId: segment.id,
      constraint: "fieldZone",
      expected: filters.fieldZone,
      observed: match?.football?.fieldZone ?? firstMatchingEvent?.football?.fieldZone ?? "missing",
      status: match ? "pass" : "fail",
      confidence: match?.football?.field.zoneConfidence ?? 0,
      evidence: match ? [match.caption] : ["No matching structured field zone."]
    });
  }
  if (filters.role && filters.role !== "any") {
    const match = events.find((event) => {
      if (filters.role === "receiver") return event.football?.receivingPlayer.present;
      if (filters.role === "passer") return event.football?.passingPlayer.present;
      if (filters.role === "shooter") return event.eventType === "shot";
      return false;
    });
    checks.push({
      segmentId: segment.id,
      constraint: "role",
      expected: filters.role,
      observed: match ? filters.role : "missing",
      status: match ? "pass" : "fail",
      confidence: match?.confidence ?? 0,
      evidence: match ? [match.caption] : ["No matching structured player role."]
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
      value: vision.fieldZone.zone,
      confidence: vision.fieldZone.confidence
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
