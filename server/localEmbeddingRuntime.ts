import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { TimelineSegment } from "../shared/types";
import { isTrustedDomainSegment, isTrustedVisionEvidence, isTrustedVisionFieldZone, trustedDomainEvents } from "./evidenceTrust";

const pythonBin = process.env.LOCAL_AI_PYTHON || "python3";
const embedScript = path.resolve("scripts", "embed_text.py");
const embeddingModel = process.env.EMBEDDING_MODEL || "intfloat/multilingual-e5-base";
const embeddingCache = new Map<string, number[]>();

type EmbeddingKind = "query" | "passage";

type EmbedTextResult = {
  available: boolean;
  provider: string;
  model: string;
  kind: EmbeddingKind;
  dimension: number;
  embeddings: number[][];
  error?: string;
};

export function getEmbeddingModelName() {
  return embeddingModel;
}

export function getExpectedEmbeddingDimensions() {
  return Number(process.env.EMBEDDING_DIMENSIONS || 768);
}

export async function embedQueryText(text: string) {
  const [embedding] = await embedTexts([text], "query");
  if (!embedding) throw new Error("Embedding runtime returned no query vector");
  return embedding;
}

export async function embedPassageTexts(texts: string[]) {
  return embedTexts(texts, "passage");
}

export async function embedTimelineSegments(segments: TimelineSegment[]) {
  const texts = segments.map(segmentToEmbeddingText);
  const embeddings = await embedTexts(texts, "passage");
  return segments.map((segment, index) => ({
    ...segment,
    embedding: embeddings[index] ?? failMissingEmbedding(segment.id)
  }));
}

export function segmentToEmbeddingText(segment: TimelineSegment) {
  const sceneText = segment.sceneData?.text;
  const textEvidence = sceneText
    ? [sceneText.speech, ...sceneText.subtitles, ...sceneText.screenText, ...sceneText.overlays].filter(Boolean).join(" ")
    : segment.transcript;
  const trustedVision = isTrustedVisionEvidence(segment.sceneData?.vision);
  const imageEvidence = trustedVision ? (segment.sceneData?.image.labels.join(", ") ?? "") : "";
  const visionEvidence = segment.sceneData?.vision && trustedVision
    ? [
        segment.sceneData.vision.pitch.present ? `pitch ${Math.round(segment.sceneData.vision.pitch.confidence * 100)}%` : "",
        segment.sceneData.vision.objects.players.status === "detected"
          ? `players ${segment.sceneData.vision.objects.players.status} ${segment.sceneData.vision.objects.players.countEstimate}`
          : "",
        segment.sceneData.vision.objects.ball.status === "detected" ? `ball ${segment.sceneData.vision.objects.ball.status}` : "",
        isTrustedVisionFieldZone(segment.sceneData.vision) ? `zone ${segment.sceneData.vision.fieldZone.zone}` : "",
        isTrustedVisionFieldZone(segment.sceneData.vision) && segment.sceneData.vision.fieldCalibration ? `field calibration ${segment.sceneData.vision.fieldCalibration.status} ${segment.sceneData.vision.fieldCalibration.method}` : "",
        segment.sceneData.vision.fieldCalibration?.attackingDirection !== "unknown" ? `attacking direction ${segment.sceneData.vision.fieldCalibration?.attackingDirection}` : "",
        segment.sceneData.vision.tracking?.ballTrackId ? `ball track ${segment.sceneData.vision.tracking.ballTrackId}` : "",
        segment.sceneData.vision.tracking?.nearestPlayerTrackId ? `nearest player ${segment.sceneData.vision.tracking.nearestPlayerTrackId}` : "",
        segment.sceneData.vision.eventClassification && segment.sceneData.vision.eventClassification.label !== "unknown" ? `event classifier ${segment.sceneData.vision.eventClassification.label}` : ""
      ]
      .filter(Boolean)
      .join(" ")
    : "";
  const domainEvidence = segment.domain && isTrustedDomainSegment(segment.domain) ? `${segment.domain.searchText}. Events: ${trustedDomainEvents(segment).map((event) => event.caption).join(" ")}` : "";
  return `${segment.label}. Text: ${textEvidence}. Domain: ${domainEvidence}. Image: ${imageEvidence}. Vision: ${visionEvidence}. Tags: ${segment.tags.join(", ")} Sources: ${segment.sources.join(", ")}`;
}

async function embedTexts(texts: string[], kind: EmbeddingKind) {
  const cached: Array<number[] | null> = texts.map((text) => embeddingCache.get(cacheKey(text, kind)) ?? null);
  const missing = texts
    .map((text, index) => ({ text, index }))
    .filter((item) => !cached[item.index]);

  if (missing.length > 0) {
    const result = await runSentenceTransformers(missing.map((item) => item.text), kind);
    if (!result.available) {
      throw new Error(`Embedding runtime unavailable for ${kind}: ${result.error ?? "unknown error"}`);
    }
    if (result.embeddings.length !== missing.length) {
      throw new Error(`Embedding runtime returned ${result.embeddings.length} vectors for ${missing.length} ${kind} inputs`);
    }
    for (let index = 0; index < missing.length; index += 1) {
      const vector = normalizeEmbedding(result.embeddings[index], kind);
      embeddingCache.set(cacheKey(missing[index].text, kind), vector);
      cached[missing[index].index] = vector;
    }
  }

  return cached.map((vector, index) => vector ?? failMissingEmbedding(`${kind}:${index}`));
}

async function runSentenceTransformers(texts: string[], kind: EmbeddingKind): Promise<EmbedTextResult> {
  try {
    const stdout = await runPythonEmbeddingProcess(texts, kind);
    return JSON.parse(stdout) as EmbedTextResult;
  } catch (error) {
    return {
      available: false,
      provider: "sentence-transformers",
      model: embeddingModel,
      kind,
      dimension: 0,
      embeddings: [],
      error: error instanceof Error ? error.message : "Embedding execution failed"
    };
  }
}

async function runPythonEmbeddingProcess(texts: string[], kind: EmbeddingKind) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin, [embedScript, "--model", embeddingModel, "--kind", kind], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timeoutMs = Number(process.env.EMBEDDING_TIMEOUT_MS || 0);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`Embedding process exceeded safety limit after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `Embedding process exited with code ${code}`));
      }
    });
    child.stdin.end(JSON.stringify({ texts }));
  });
}

function normalizeEmbedding(vector: number[], kind: EmbeddingKind) {
  const expected = getExpectedEmbeddingDimensions();
  if (vector.length !== expected) {
    throw new Error(`Embedding runtime returned ${vector.length} dimensions for ${kind}; expected ${expected}`);
  }
  if (!vector.some((value) => Number.isFinite(value) && value !== 0)) {
    throw new Error(`Embedding runtime returned an empty ${kind} vector`);
  }
  return vector;
}

function cacheKey(text: string, kind: EmbeddingKind) {
  return createHash("sha256").update(`${embeddingModel}:${kind}:${text}`).digest("hex");
}

function failMissingEmbedding(context: string): never {
  throw new Error(`Missing embedding vector for ${context}`);
}
