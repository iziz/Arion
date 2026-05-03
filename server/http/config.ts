import path from "node:path";

export const port = Number(process.env.PORT ?? 8787);
export const uploadDir = path.resolve(".data", "tmp-uploads");
export const legacyUploadDir = path.resolve("uploads");
export const rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600);
export const uploadMaxBytes = parsePositiveInteger(process.env.UPLOAD_MAX_BYTES, 8 * 1024 * 1024 * 1024);

export const rateLimitExemptGetPaths = new Set([
  "/api/health",
  "/api/indexes",
  "/api/assets",
  "/api/jobs",
  "/api/events",
  "/api/webhooks",
  "/api/metrics",
  "/api/db/status",
  "/api/observability"
]);

export function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${Number(value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1))}${units[unitIndex]}`;
}
