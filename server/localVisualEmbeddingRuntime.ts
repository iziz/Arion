import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { KeyframeRecord, TimelineSegment } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";

const pythonBin = process.env.LOCAL_AI_PYTHON || "python3";
const visualScript = path.resolve("scripts", "embed_visual.py");
const visualModel = process.env.VISUAL_EMBEDDING_MODEL || "ViT-B-32";
const visualPretrained = process.env.VISUAL_EMBEDDING_PRETRAINED || "laion2b_s34b_b79k";
const cache = new Map<string, number[]>();

export type VisualVectorRecord = {
  id: string;
  indexId: string;
  assetId: string;
  segmentId: string;
  keyframeId: string;
  keyframePath: string;
  start: number;
  end: number;
  vector: number[];
  model: string;
};

type VisualMode = "image" | "text";

type VisualResult = {
  available: boolean;
  provider: string;
  model: string;
  pretrained: string;
  mode: VisualMode;
  dimension: number;
  embeddings: number[][];
  error?: string;
};

export function getVisualEmbeddingModelName() {
  return `${visualModel}/${visualPretrained}`;
}

export function getExpectedVisualEmbeddingDimensions() {
  return Number(process.env.VISUAL_EMBEDDING_DIMENSIONS || 512);
}

export async function embedVisualQuery(text: string) {
  const [vector] = await embedTexts([text]);
  return vector ?? [];
}

export async function embedKeyframes(indexId: string, assetId: string, timeline: TimelineSegment[], keyframes: KeyframeRecord[]) {
  const usable = keyframes.filter((keyframe) => keyframe.path && keyframe.segmentId);
  const absolutePaths = usable.map((keyframe) => path.join(getPublicMediaRoot(), keyframe.path));
  const vectors = await embedImages(absolutePaths);
  return usable
    .map((keyframe, index): VisualVectorRecord | null => {
      const vector = vectors[index];
      if (!vector?.length || !keyframe.segmentId) return null;
      const segment = timeline.find((item) => item.id === keyframe.segmentId);
      return {
        id: `${assetId}:${keyframe.id}`,
        indexId,
        assetId,
        segmentId: keyframe.segmentId,
        keyframeId: keyframe.id,
        keyframePath: keyframe.path,
        start: segment?.start ?? keyframe.at,
        end: segment?.end ?? keyframe.at,
        vector,
        model: getVisualEmbeddingModelName()
      };
    })
    .filter((record): record is VisualVectorRecord => Boolean(record));
}

async function embedImages(paths: string[]) {
  return embedPayload(paths, "image");
}

async function embedTexts(texts: string[]) {
  return embedPayload(texts, "text");
}

async function embedPayload(items: string[], mode: VisualMode) {
  const cached = items.map((item) => cache.get(cacheKey(item, mode)) ?? null);
  const missing = items.map((item, index) => ({ item, index })).filter((entry) => !cached[entry.index]);
  if (missing.length === 0) return cached.map((vector) => vector ?? []);

  const result = await runVisualProcess(missing.map((entry) => entry.item), mode);
  if (result.available && result.embeddings.length === missing.length) {
    for (let index = 0; index < missing.length; index += 1) {
      const vector = normalizeVector(result.embeddings[index]);
      cache.set(cacheKey(missing[index].item, mode), vector);
      cached[missing[index].index] = vector;
    }
  } else {
    for (const entry of missing) {
      cache.set(cacheKey(entry.item, mode), []);
      cached[entry.index] = [];
    }
  }

  return cached.map((vector) => vector ?? []);
}

async function runVisualProcess(items: string[], mode: VisualMode): Promise<VisualResult> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(pythonBin, [visualScript, "--model", visualModel, "--pretrained", visualPretrained, "--mode", mode], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      const timeoutMs = Number(process.env.VISUAL_EMBEDDING_TIMEOUT_MS || 0);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              child.kill("SIGTERM");
              reject(new Error(`Visual embedding process exceeded safety limit after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const output = Buffer.concat(stdoutChunks).toString("utf8");
        if (code === 0) resolve(output);
        else reject(new Error(Buffer.concat(stderrChunks).toString("utf8") || `Visual embedding exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify(mode === "image" ? { images: items } : { texts: items }));
    });
    return JSON.parse(stdout) as VisualResult;
  } catch (error) {
    return {
      available: false,
      provider: "open_clip",
      model: visualModel,
      pretrained: visualPretrained,
      mode,
      dimension: 0,
      embeddings: [],
      error: error instanceof Error ? error.message : "Visual embedding execution failed"
    };
  }
}

function normalizeVector(vector: number[]) {
  const expected = getExpectedVisualEmbeddingDimensions();
  return vector.length === expected ? vector : vector.slice(0, expected);
}

function cacheKey(item: string, mode: VisualMode) {
  return createHash("sha256").update(`${visualModel}:${visualPretrained}:${mode}:${item}`).digest("hex");
}
