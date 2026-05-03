import path from "node:path";

export function toPublicMediaPath(framePath: string, mediaRoot: string) {
  if (!framePath) return "";
  const relative = path.relative(mediaRoot, framePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return framePath;
}
