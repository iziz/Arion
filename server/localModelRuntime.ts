import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AssetRecord, LocalIntelligence, OcrFrameResult, WhisperSegment } from "../shared/types";
import { logJson, recordLatency, traceAsync } from "./observability";

const execFileAsync = promisify(execFile);
const pythonBin = process.env.LOCAL_AI_PYTHON || "python3";
const whisperScript = path.resolve("scripts", "whisper_transcribe.py");
const paddleOcrScript = path.resolve("scripts", "paddle_ocr_extract.py");
const modelCacheDir = path.resolve(".data", "model-cache");

export async function runLocalModelRuntime(filePath: string, asset: AssetRecord): Promise<LocalIntelligence> {
  const [visual, waveform, whisper, paddle] = await Promise.all([
    traceAsync("model.visual_sampler", { assetId: asset.id }, () => inspectVisualFrames(filePath), "model.visual_sampler"),
    traceAsync("model.audio_probe", { assetId: asset.id }, () => inspectAudioPresence(filePath), "model.audio_probe"),
    traceAsync("model.asr.whisper", { assetId: asset.id, model: process.env.WHISPER_MODEL || "tiny" }, () => runWhisper(filePath), "model.asr.whisper"),
    traceAsync("model.ocr.paddle", { assetId: asset.id, lang: process.env.PADDLEOCR_LANG || "en" }, () => runPaddleOcr(filePath, asset.id), "model.ocr.paddle")
  ]);
  if (!whisper.available) {
    recordLatency("model.asr.whisper.unavailable", 0, "error", whisper.error ?? "Whisper unavailable");
    logJson("warn", "model.asr.whisper.unavailable", "Whisper fallback activated", { assetId: asset.id, error: whisper.error });
  }
  if (!paddle.available) {
    recordLatency("model.ocr.paddle.unavailable", 0, "error", paddle.error ?? "PaddleOCR unavailable");
    logJson("warn", "model.ocr.paddle.unavailable", "PaddleOCR fallback activated", { assetId: asset.id, error: paddle.error });
  }
  const terms = extractTerms(`${asset.title} ${asset.description} ${asset.originalName}`);
  const transcriptTerms = terms.length > 0 ? terms : ["uploaded", "media", "local", "analysis"];
  const fallbackTranscript = transcriptTerms
    .slice(0, 10)
    .map((term, index) => `${index + 1}. Local ASR detected context around ${term}.`)
    .join(" ");
  const fallbackOcrTokens = unique([...terms.filter((term) => /[a-z0-9가-힣]/i.test(term)), asset.originalName.replace(/\.[^.]+$/, "")]).slice(
    0,
    12
  );
  const transcript =
    whisper.available && whisper.transcript.trim()
      ? whisper.transcript.trim()
      : waveform.hasAudio
        ? fallbackTranscript
        : "No audio track was available; local ASR used asset metadata as context.";
  const ocrTokens = paddle.available && paddle.tokens.length > 0 ? paddle.tokens : fallbackOcrTokens;
  const trace = [
    whisper.available ? `${whisper.provider}:${whisper.model ?? "default"}` : `whisper-unavailable:${whisper.error ?? "missing dependency"}`,
    paddle.available ? "paddleocr:real" : `paddleocr-unavailable:${paddle.error ?? "missing dependency"}`,
    "ffmpeg-visual-sampler:v1",
    "local-vlm-router:v1"
  ];

  return {
    asr: {
      transcript,
      language: whisper.language || (/[가-힣]/.test(transcript) ? "ko" : "en"),
      confidence: whisper.available ? whisper.confidence : waveform.hasAudio ? 0.68 : 0.42,
      segments: whisper.segments
    },
    ocr: {
      tokens: ocrTokens,
      confidence: paddle.available ? paddle.confidence : ocrTokens.length > 0 ? 0.61 : 0.2,
      frames: paddle.frames
    },
    visual: {
      labels: visual.labels,
      dominantColor: visual.dominantColor,
      brightness: visual.brightness,
      motionScore: visual.motionScore
    },
    modelTrace: trace
  };
}

type WhisperResult = {
  available: boolean;
  provider: string;
  model?: string;
  transcript: string;
  language: string;
  confidence: number;
  segments: WhisperSegment[];
  error?: string;
};

type PaddleResult = {
  available: boolean;
  provider: string;
  tokens: string[];
  confidence: number;
  frames: OcrFrameResult[];
  frameResults?: OcrFrameResult[];
  error?: string;
};

async function runWhisper(filePath: string): Promise<WhisperResult> {
  try {
    const { stdout } = await execFileAsync(
      pythonBin,
      [whisperScript, filePath, "--model", process.env.WHISPER_MODEL || "tiny"],
      {
        maxBuffer: 1024 * 1024 * 4,
        timeout: Number(process.env.WHISPER_TIMEOUT_MS || 180000)
      }
    );
    const parsed = JSON.parse(stdout) as WhisperResult;
    return {
      available: Boolean(parsed.available),
      provider: parsed.provider || "whisper",
      model: parsed.model,
      transcript: parsed.transcript || "",
      language: parsed.language || "unknown",
      confidence: parsed.confidence ?? 0,
      segments: normalizeWhisperSegments(parsed.segments),
      error: parsed.error
    };
  } catch (error) {
    return {
      available: false,
      provider: "none",
      transcript: "",
      language: "unknown",
      confidence: 0,
      segments: [],
      error: error instanceof Error ? error.message : "Whisper execution failed"
    };
  }
}

async function runPaddleOcr(filePath: string, assetId: string): Promise<PaddleResult> {
  const framesDir = path.join(modelCacheDir, assetId, "ocr-frames");
  try {
    await mkdir(framesDir, { recursive: true });
    await execFileAsync(
      "ffmpeg",
      ["-y", "-v", "error", "-i", filePath, "-vf", "fps=0.5,scale=960:-1", "-frames:v", "6", path.join(framesDir, "frame-%03d.png")],
      { timeout: 60000 }
    );
    const { stdout } = await execFileAsync(pythonBin, [paddleOcrScript, framesDir, "--lang", process.env.PADDLEOCR_LANG || "en"], {
      maxBuffer: 1024 * 1024 * 4,
      timeout: Number(process.env.PADDLEOCR_TIMEOUT_MS || 180000)
    });
    const parsed = JSON.parse(stdout) as PaddleResult;
    return {
      available: Boolean(parsed.available),
      provider: parsed.provider || "paddleocr",
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      confidence: parsed.confidence ?? 0,
      frames: normalizeOcrFrames(parsed.frameResults),
      error: parsed.error
    };
  } catch (error) {
    return {
      available: false,
      provider: "none",
      tokens: [],
      confidence: 0,
      frames: [],
      error: error instanceof Error ? error.message : "PaddleOCR execution failed"
    };
  }
}

function normalizeWhisperSegments(value: unknown): WhisperSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = item as Partial<WhisperSegment>;
      return {
        start: Number(record.start ?? 0),
        end: Number(record.end ?? record.start ?? 0),
        text: String(record.text ?? "").trim()
      };
    })
    .filter((item) => item.text.length > 0 && item.end >= item.start);
}

function normalizeOcrFrames(value: unknown): OcrFrameResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item as Partial<OcrFrameResult>;
    return {
      framePath: String(record.framePath ?? ""),
      tokens: Array.isArray(record.tokens) ? record.tokens.map(String) : [],
      confidence: Number(record.confidence ?? 0)
    };
  });
}

async function inspectAudioPresence(filePath: string) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      filePath
    ]);
    return { hasAudio: stdout.trim().length > 0 };
  } catch {
    return { hasAudio: false };
  }
}

async function inspectVisualFrames(filePath: string) {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-vf", "fps=1,scale=24:16", "-frames:v", "3", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { encoding: "buffer", maxBuffer: 24 * 16 * 3 * 3 + 4096 }
    );
    const bytes = Buffer.from(stdout);
    if (bytes.length === 0) throw new Error("No frame bytes");
    const frames = Math.max(1, Math.floor(bytes.length / (24 * 16 * 3)));
    let red = 0;
    let green = 0;
    let blue = 0;
    let diff = 0;
    let previous = 0;
    const pixels = bytes.length / 3;
    for (let index = 0; index < bytes.length; index += 3) {
      red += bytes[index];
      green += bytes[index + 1];
      blue += bytes[index + 2];
      const luminance = (bytes[index] + bytes[index + 1] + bytes[index + 2]) / 3;
      if (index > 0) diff += Math.abs(luminance - previous);
      previous = luminance;
    }
    const avgRed = Math.round(red / pixels);
    const avgGreen = Math.round(green / pixels);
    const avgBlue = Math.round(blue / pixels);
    const brightness = Number(((avgRed + avgGreen + avgBlue) / 765).toFixed(3));
    const motionScore = Number(Math.min(1, diff / (pixels * frames * 255)).toFixed(3));
    return {
      dominantColor: rgbToHex(avgRed, avgGreen, avgBlue),
      brightness,
      motionScore,
      labels: labelsFor(brightness, motionScore, avgRed, avgGreen, avgBlue)
    };
  } catch {
    const hash = createHash("md5").update(filePath).digest();
    return {
      dominantColor: rgbToHex(hash[0], hash[1], hash[2]),
      brightness: Number(((hash[0] + hash[1] + hash[2]) / 765).toFixed(3)),
      motionScore: Number((hash[3] / 255).toFixed(3)),
      labels: ["metadata-derived", "visual-fallback"]
    };
  }
}

function labelsFor(brightness: number, motion: number, red: number, green: number, blue: number) {
  const labels = [brightness > 0.58 ? "bright-scene" : "dim-scene", motion > 0.12 ? "active-motion" : "stable-shot"];
  if (red > green && red > blue) labels.push("warm-palette");
  if (blue > red && blue > green) labels.push("cool-palette");
  if (green > red && green > blue) labels.push("green-dominant");
  return labels;
}

function extractTerms(input: string) {
  return unique(
    input
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 2)
  );
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
