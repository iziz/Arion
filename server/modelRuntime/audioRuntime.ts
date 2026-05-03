import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getPublicMediaRoot } from "../localObjectStorage";
import { logJson } from "../observability";

const execFileAsync = promisify(execFile);

export type AudioRuntimeResult = {
  extractedPath: string;
  speechFocusedPath: string;
  vad: {
    available: boolean;
    provider: string;
    error: string | null;
  };
  speechSegments: Array<{ start: number; end: number; confidence: number }>;
  musicSegments: Array<{ start: number; end: number; confidence: number }>;
};

export async function extractAudioAndVad(filePath: string, assetId: string, duration: number | null): Promise<AudioRuntimeResult> {
  const mediaRoot = getPublicMediaRoot();
  const relativeDir = path.join("generated", "assets", assetId, "audio");
  const audioDir = path.join(mediaRoot, relativeDir);
  const audioPath = path.join(audioDir, "speech.wav");
  await mkdir(audioDir, { recursive: true });
  try {
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath]);
    await stat(audioPath);
  } catch (error) {
    logJson("warn", "model.audio_extract.unavailable", "Audio extraction returned no usable audio", {
      assetId,
      error: error instanceof Error ? error.message : "Audio extraction failed"
    });
      return {
        extractedPath: "",
        speechFocusedPath: "",
        vad: { available: false, provider: "ffmpeg-silencedetect", error: error instanceof Error ? error.message : "Audio extraction failed" },
        speechSegments: [],
        musicSegments: []
      };
    }
    const vad = await detectSpeechSegments(audioPath, duration);
    const speechSegments = vad.speechSegments;
    const musicSegments = inferMusicSegments(duration, speechSegments, vad.available);
    const speechFocusedPath = await createSpeechFocusedAudio(audioPath, path.join(audioDir, "speech-focused.wav"), speechSegments, duration, assetId);
    return {
      extractedPath: audioPath,
      speechFocusedPath,
      vad: {
        available: vad.available,
        provider: vad.provider,
        error: vad.error
      },
      speechSegments,
      musicSegments
    };
}

async function createSpeechFocusedAudio(
  audioPath: string,
  outputPath: string,
  speechSegments: Array<{ start: number; end: number; confidence: number }>,
  duration: number | null,
  assetId: string
) {
  if (speechSegments.length === 0) return "";
  const merged = mergeSpeechSegments(speechSegments, duration, 0.15);
  if (merged.length === 0) return "";
  const speechExpression = merged.map((segment) => `between(t\\,${segment.start}\\,${segment.end})`).join("+");
  const filter = `volume=enable='not(${speechExpression})':volume=0`;
  try {
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", audioPath, "-af", filter, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath]);
    await stat(outputPath);
    return outputPath;
  } catch (error) {
    logJson("warn", "model.audio_focus.unavailable", "Speech-focused audio generation failed; falling back to extracted audio", {
      assetId,
      error: error instanceof Error ? error.message : "Speech-focused audio generation failed"
    });
    return "";
  }
}

function mergeSpeechSegments(segments: Array<{ start: number; end: number }>, duration: number | null, padding: number) {
  const normalized = segments
    .map((segment) => ({
      start: Math.max(0, segment.start - padding),
      end: duration && duration > 0 ? Math.min(duration, segment.end + padding) : segment.end + padding
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const segment of normalized) {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 0.05) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push({ ...segment });
  }
  return merged.map((segment) => ({ start: roundTime(segment.start), end: roundTime(segment.end) }));
}

async function detectSpeechSegments(audioPath: string, duration: number | null) {
  const provider = "ffmpeg-silencedetect";
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", audioPath, "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"],
      {}
    );
      return { available: true, provider, error: null, speechSegments: speechFromSilenceLog(stderr, duration) };
    } catch (error) {
      const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      const parsed = speechFromSilenceLog(stderr, duration);
      if (parsed.length > 0) return { available: true, provider, error: null, speechSegments: parsed };
      return {
        available: false,
        provider,
        error: error instanceof Error ? error.message : "VAD execution failed",
        speechSegments: []
      };
    }
}

function speechFromSilenceLog(log: string, duration: number | null) {
  const events = [...log.matchAll(/silence_(start|end):\s*([0-9.]+)/g)].map((match) => ({
    type: match[1],
    at: Number(match[2])
  }));
  if (!duration || duration <= 0) {
    const last = events.at(-1)?.at ?? 0;
    duration = Math.max(last, 0);
  }
  if (duration <= 0) return [];
  const speech: Array<{ start: number; end: number; confidence: number }> = [];
  let cursor = 0;
  for (const event of events) {
    if (event.type === "start") {
      if (event.at > cursor) speech.push({ start: roundTime(cursor), end: roundTime(event.at), confidence: 0.72 });
    } else {
      cursor = Math.max(cursor, event.at);
    }
  }
  if (cursor < duration) speech.push({ start: roundTime(cursor), end: roundTime(duration), confidence: 0.72 });
  return speech.filter((segment) => segment.end - segment.start >= 0.25);
}

function inferMusicSegments(duration: number | null, speechSegments: Array<{ start: number; end: number }>, vadAvailable: boolean) {
  if (!duration || duration <= 0) return [];
  if (!vadAvailable) return [];
  if (speechSegments.length === 0) return [{ start: 0, end: roundTime(duration), confidence: 0.6 }];
  const speechDuration = speechSegments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
  const musicConfidence = Math.max(0, Math.min(1, 1 - speechDuration / duration));
  return musicConfidence > 0.2 ? [{ start: 0, end: roundTime(duration), confidence: Number(musicConfidence.toFixed(3)) }] : [];
}
function roundTime(value: number) {
  return Number(value.toFixed(3));
}
