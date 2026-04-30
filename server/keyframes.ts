import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { KeyframeRecord, TimelineSegment } from "../shared/types";
import { getPublicMediaRoot } from "./localObjectStorage";

const execFileAsync = promisify(execFile);

export async function generateKeyframes(
  filePath: string,
  assetId: string,
  segments: TimelineSegment[],
  duration: number | null = null
): Promise<KeyframeRecord[]> {
  const mediaRoot = getPublicMediaRoot();
  const relativeDir = path.join("generated", "assets", assetId, "keyframes");
  const absoluteDir = path.join(mediaRoot, relativeDir);
  await mkdir(absoluteDir, { recursive: true });

  const keyframes: KeyframeRecord[] = [];
  for (const [index, segment] of segments.entries()) {
    const safeEnd = duration ? Math.max(0.05, duration - 0.05) : segment.end;
    const midpoint = segment.start + Math.max(0.25, (segment.end - segment.start) / 2);
    const at = Math.max(0, Math.min(midpoint, segment.end, safeEnd));
    const filename = `segment-${String(index + 1).padStart(3, "0")}.jpg`;
    const absolutePath = path.join(absoluteDir, filename);
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        String(at),
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-1",
        "-q:v",
        "3",
        absolutePath
      ]);
      await stat(absolutePath);
      keyframes.push({
        id: `${assetId}-keyframe-${index + 1}`,
        segmentId: segment.id,
        at,
        path: path.posix.join(relativeDir.split(path.sep).join("/"), filename),
        width: 480,
        height: null
      });
    } catch {
      keyframes.push({
        id: `${assetId}-keyframe-${index + 1}`,
        segmentId: segment.id,
        at,
        path: "",
        width: null,
        height: null
      });
    }
  }

  return keyframes;
}
