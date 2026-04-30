import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnalysisResult, AssetRecord, IndexRecord, SearchResult, TimelineSegment } from "../shared/types";
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
    const ocrContext = nearbyOcrTokens(asset, item).join(" ");
    const transcript = basis?.text
      ? `${basis.text}${ocrContext ? ` OCR: ${ocrContext}.` : ""}`
      : `${asset.intelligence.asr.transcript} Detected ${primary}, ${secondary}, and ${tertiary} context from ${formatTime(start)} to ${formatTime(
          end
        )}.${ocrContext ? ` OCR: ${ocrContext}.` : ""}`;
    const sources: TimelineSegment["sources"] = [
      ...(hasWhisperSource ? (["whisper"] as const) : []),
      ...(ocrContext ? (["paddleocr"] as const) : []),
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

  return {
    tags: safeTags,
    timeline,
    summary: `This asset was indexed into ${timeline.length} timeline segments using ${index.models.embedding}. Local ASR, OCR, visual sampling, and vector indexing emphasize ${safeTags
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

function nearbyOcrTokens(asset: AssetRecord, index: number) {
  const frame = asset.intelligence.ocr.frames[index % Math.max(1, asset.intelligence.ocr.frames.length)];
  return unique([...(frame?.tokens ?? []), ...asset.intelligence.ocr.tokens]).slice(0, 8);
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
  } = {}
): SearchResult[] {
  const queryTerms = extractKeywords(query);
  if (queryTerms.length === 0) return [];
  const queryVector = options.queryVector ?? vectorize(queryTerms.join(" "));
  const limit = options.limit ?? 10;

  return assets
    .filter((asset) => asset.status === "indexed")
    .filter((asset) => !options.indexId || asset.indexId === options.indexId)
    .filter((asset) => !options.tag || asset.tags.includes(options.tag))
    .map((asset) => {
      const matchingSegments = asset.timeline
        .filter((segment) => !options.modality || segment.modalities.includes(options.modality as TimelineSegment["modalities"][number]))
        .map((segment) => {
          const lexicalScore = scoreText(`${segment.label} ${segment.transcript} ${segment.tags.join(" ")}`, queryTerms);
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
            score: lexicalScore * 3 + semanticScore * 8 + visualScore * 6 + sourceScore + confidenceScore * 1.5
          };
        })
        .filter((item) => item.lexicalScore > 0 || item.semanticScore > 0.58 || item.visualScore > 0.12)
        .sort((a, b) => b.score - a.score);

      const assetLexicalScore = scoreText(`${asset.title} ${asset.description} ${asset.tags.join(" ")} ${asset.summary}`, queryTerms);
      const lexical = assetLexicalScore * 2 + matchingSegments.reduce((sum, item) => sum + item.lexicalScore, 0) * 3;
      const semantic = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.semanticScore, 0) * 8;
      const visual = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.visualScore, 0) * 6;
      const source = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.sourceScore, 0);
      const confidence = matchingSegments.slice(0, 5).reduce((sum, item) => sum + item.confidenceScore, 0) * 1.5;
      const recency = recencyBoost(asset.createdAt);
      const totalScore = Number((lexical + semantic + visual + source + confidence + recency).toFixed(3));
      const index = indexes.find((item) => item.id === asset.indexId) ?? null;
      return {
        asset,
        index,
        segments: matchingSegments.slice(0, 5).map((item) => item.segment),
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
          `${Number(semantic.toFixed(3))} semantic rank score`,
          `${Number(visual.toFixed(3))} visual rank score`,
          `${Number(source.toFixed(3))} source quality boost`,
          `${Number(confidence.toFixed(3))} confidence boost`,
          `${matchingSegments.length} matching timeline segments`,
          index ? `index=${index.name}` : "index=unknown"
        ]
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function analyzeAsset(asset: AssetRecord, question = ""): AnalysisResult {
  const queryTerms = extractKeywords(question);
  const matchingChapters =
    queryTerms.length > 0
      ? asset.timeline.filter((segment) => scoreText(`${segment.transcript} ${segment.tags.join(" ")}`, queryTerms))
      : asset.timeline;
  const chapters = (matchingChapters.length > 0 ? matchingChapters : asset.timeline).slice(0, 6);
  const signals = unique([...asset.tags.slice(0, 6), ...chapters.flatMap((segment) => segment.tags)]).slice(0, 10);
  const answer =
    question.trim().length > 0
      ? `The strongest local signals for "${question}" are ${signals.slice(0, 5).join(", ")}. Review ${chapters
          .map((chapter) => `${formatTime(chapter.start)}-${formatTime(chapter.end)}`)
          .join(", ")}.`
      : `The asset is indexed with ${asset.timeline.length} segments and emphasizes ${signals.slice(0, 5).join(", ")}.`;

  return {
    assetId: asset.id,
    indexId: asset.indexId,
    summary: asset.summary,
    answer,
    chapters,
    signals,
    generatedAt: new Date().toISOString()
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
      .filter((term) => term.length > 2 && !stopWords.has(term))
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
