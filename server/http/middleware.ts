import type { NextFunction, Request, Response } from "express";
import { getUserByApiKey } from "../store";
import { formatBytes } from "./config";

export function createRateLimitMiddleware(rateLimitPerMinute: number, exemptGetPaths: Set<string>) {
  const requestBuckets = new Map<string, { count: number; resetAt: number }>();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    if (req.method === "GET" && exemptGetPaths.has(req.path)) {
      next();
      return;
    }
    const key = req.ip ?? "local";
    const now = Date.now();
    const current = requestBuckets.get(key);
    if (!current || current.resetAt < now) {
      requestBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    current.count += 1;
    if (current.count > rateLimitPerMinute) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    next();
  };
}

export function optionalApiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.API_KEYS?.split(",").map((key) => key.trim()).filter(Boolean) ?? [];
  if (configured.length === 0) {
    next();
    return;
  }
  const key = String(req.header("x-api-key") || "");
  void getUserByApiKey(key).then((user) => {
    if (!configured.includes(key) && !user) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    next();
  });
}

export function createErrorHandler(uploadMaxBytes: number) {
  return function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
    const fileSizeError = isMulterFileSizeError(error);
    const statusCode = fileSizeError
      ? 413
      : typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    res.status(statusCode).json({
      error: fileSizeError
        ? `Uploaded file exceeds the ${formatBytes(uploadMaxBytes)} limit. Set UPLOAD_MAX_BYTES to allow larger files.`
        : error instanceof Error ? error.message : "Unexpected server error"
    });
  };
}

export function isMulterFileSizeError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "LIMIT_FILE_SIZE";
}

export function sendNotFound(res: Response, message: string) {
  res.status(404).json({ error: message });
}
