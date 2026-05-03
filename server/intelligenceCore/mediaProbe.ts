import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function parseFrameRate(value?: string) {
  if (!value || !value.includes("/")) return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || !denominator) return null;
  return Number((numerator / denominator).toFixed(3));
}
