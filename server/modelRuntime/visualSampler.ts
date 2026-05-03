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
      available: true,
      dominantColor: rgbToHex(avgRed, avgGreen, avgBlue),
      brightness,
      motionScore,
      labels: labelsFor(brightness, motionScore, avgRed, avgGreen, avgBlue),
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

function labelsFor(brightness: number, motion: number, red: number, green: number, blue: number) {
  const labels = [brightness > 0.58 ? "bright-scene" : "dim-scene", motion > 0.12 ? "active-motion" : "stable-shot"];
  if (red > green && red > blue) labels.push("warm-palette");
  if (blue > red && blue > green) labels.push("cool-palette");
  if (green > red && green > blue) labels.push("green-dominant");
  return labels;
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
