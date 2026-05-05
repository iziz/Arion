import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function inspectAudioPresence(filePath: string) {
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

export async function inspectVisualFrames(filePath: string) {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-vf", "fps=1,scale=24:16", "-frames:v", "3", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
      { encoding: "buffer", maxBuffer: 24 * 16 * 3 * 3 + 4096 }
    );
    return {
      available: true,
      ...summarizeVisualFrameBytes(Buffer.from(stdout), 24, 16),
      error: null
    };
  } catch (error) {
    return {
      available: false,
      dominantColor: "#000000",
      brightness: 0,
      motionScore: 0,
      labels: [],
      error: error instanceof Error ? error.message : "Visual frame sampling failed"
    };
  }
}

export function summarizeVisualFrameBytes(bytes: Buffer, width: number, height: number) {
  const frameSize = width * height * 3;
  const frames = Math.floor(bytes.length / frameSize);
  if (frames <= 0) throw new Error("No frame bytes");
  const usableLength = frames * frameSize;
  let red = 0;
  let green = 0;
  let blue = 0;
  let temporalDiff = 0;
  const pixelsPerFrame = width * height;
  const totalPixels = pixelsPerFrame * frames;
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * frameSize;
    for (let pixel = 0; pixel < pixelsPerFrame; pixel += 1) {
      const index = frameOffset + pixel * 3;
      red += bytes[index];
      green += bytes[index + 1];
      blue += bytes[index + 2];
      if (frame > 0) {
        const previousIndex = frameOffset - frameSize + pixel * 3;
        const luminance = (bytes[index] + bytes[index + 1] + bytes[index + 2]) / 3;
        const previousLuminance = (bytes[previousIndex] + bytes[previousIndex + 1] + bytes[previousIndex + 2]) / 3;
        temporalDiff += Math.abs(luminance - previousLuminance);
      }
    }
  }
  const avgRed = Math.round(red / totalPixels);
  const avgGreen = Math.round(green / totalPixels);
  const avgBlue = Math.round(blue / totalPixels);
  const brightness = Number(((avgRed + avgGreen + avgBlue) / 765).toFixed(3));
  const motionScore = frames > 1 ? Number(Math.min(1, temporalDiff / ((frames - 1) * pixelsPerFrame * 255)).toFixed(3)) : 0;
  return {
    dominantColor: rgbToHex(avgRed, avgGreen, avgBlue),
    brightness,
    motionScore,
    labels: labelsFor(brightness, motionScore, avgRed, avgGreen, avgBlue),
    sampledFrames: frames,
    sampledBytes: usableLength
  };
}

function labelsFor(brightness: number, frameChange: number, red: number, green: number, blue: number) {
  const labels = [brightness > 0.58 ? "bright-scene" : "dim-scene", frameChange > 0.12 ? "high-frame-change" : "low-frame-change"];
  if (red > green && red > blue) labels.push("warm-palette");
  if (blue > red && blue > green) labels.push("cool-palette");
  if (green > red && green > blue) labels.push("green-dominant");
  return labels;
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
