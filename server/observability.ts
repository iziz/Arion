import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import { SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ExportResult } from "@opentelemetry/core";
import express from "express";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

type RequestContext = {
  requestId: string;
  traceId: string;
  spanId: string;
  jobId?: string;
  assetId?: string;
};

type JsonLogLevel = "debug" | "info" | "warn" | "error";

type JsonLogEntry = {
  timestamp: string;
  level: JsonLogLevel;
  event: string;
  message: string;
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  jobId?: string;
  assetId?: string;
  fields?: Record<string, unknown>;
};

type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  durationMs: number;
  status: string;
  attributes: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
};

type LatencyMetric = {
  key: string;
  count: number;
  errorCount: number;
  totalMs: number;
  avgMs: number;
  p95Ms: number;
  lastMs: number;
  lastStatus: "ok" | "error";
  lastError: string | null;
  updatedAt: string;
};

type LatencySample = {
  durationMs: number;
  status: "ok" | "error";
  error: string | null;
};

type LatencyBucket = {
  samples: LatencySample[];
  updatedAt: string;
};

const logPath = path.resolve(".data", "logs", "app.ndjson");
const requestContext = new AsyncLocalStorage<RequestContext>();
const recentLogs: JsonLogEntry[] = [];
const recentSpans: SpanRecord[] = [];
const latencyBuckets = new Map<string, LatencyBucket>();
let writeChain = Promise.resolve();

const noisyPollingPaths = new Set([
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

export function observabilityMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const requestId = String(req.headers["x-request-id"] || randomUUID());
  const startedAt = performance.now();
  const span = tracer.startSpan(`HTTP ${req.method} ${req.path}`, {
    attributes: {
      "http.request.method": req.method,
      "url.path": req.path,
      "url.query": req.url.includes("?") ? req.url.split("?").slice(1).join("?") : "",
      "client.address": req.ip ?? "unknown",
      "request.id": requestId
    }
  });
  const spanContext = span.spanContext();
  const store: RequestContext = {
    requestId,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId
  };
  res.setHeader("x-request-id", requestId);
  res.setHeader("traceparent", `00-${spanContext.traceId}-${spanContext.spanId}-01`);

  requestContext.run(store, () => {
    context.with(trace.setSpan(context.active(), span), () => {
      res.on("finish", () => {
        const durationMs = performance.now() - startedAt;
        span.setAttribute("http.response.status_code", res.statusCode);
        span.setAttribute("http.server.duration_ms", Number(durationMs.toFixed(2)));
        if (res.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
        recordLatency("http.request", durationMs, res.statusCode >= 500 ? "error" : "ok");
        logJson(res.statusCode >= 500 ? "error" : "info", "http.request", `${req.method} ${req.path}`, {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Number(durationMs.toFixed(2))
        });
      });
      next();
    });
  });
}

export function bindJobContext<T>(contextValues: { jobId?: string; assetId?: string }, fn: () => T) {
  const current = getContext();
  return requestContext.run(
    {
      requestId: current.requestId ?? randomUUID(),
      traceId: current.traceId ?? randomTraceId(),
      spanId: current.spanId ?? randomSpanId(),
      jobId: contextValues.jobId,
      assetId: contextValues.assetId
    },
    fn
  );
}

export async function traceJobAsync<T>(
  name: string,
  contextValues: { jobId?: string; assetId?: string },
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
  metricKey = name
): Promise<T> {
  const current = getContext();
  const span = tracer.startSpan(name, { attributes: sanitizeAttributes({ ...fields, ...contextValues }) });
  const startedAt = performance.now();
  const spanContext = span.spanContext();
  return requestContext.run(
    {
      requestId: current.requestId ?? randomUUID(),
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      jobId: contextValues.jobId,
      assetId: contextValues.assetId
    },
    async () => {
      try {
        const result = await context.with(trace.setSpan(context.active(), span), fn);
        const durationMs = performance.now() - startedAt;
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("duration.ms", Number(durationMs.toFixed(2)));
        recordLatency(metricKey, durationMs, "ok");
        logJson("info", metricKey, `${name} completed`, { ...fields, durationMs: Number(durationMs.toFixed(2)) });
        return result;
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const message = error instanceof Error ? error.message : "Unknown error";
        span.recordException(error instanceof Error ? error : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.setAttribute("duration.ms", Number(durationMs.toFixed(2)));
        recordLatency(metricKey, durationMs, "error", message);
        logJson("error", metricKey, `${name} failed`, { ...fields, durationMs: Number(durationMs.toFixed(2)), error: message });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

export async function traceAsync<T>(name: string, fields: Record<string, unknown>, fn: () => Promise<T>, metricKey = name): Promise<T> {
  const parent = context.active();
  const span = tracer.startSpan(name, { attributes: sanitizeAttributes(fields) }, parent);
  const startedAt = performance.now();
  const spanContext = span.spanContext();
  const current = getContext();
  return requestContext.run(
    {
      requestId: current.requestId ?? randomUUID(),
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      jobId: current.jobId,
      assetId: current.assetId
    },
    async () => {
      try {
        const result = await context.with(trace.setSpan(parent, span), fn);
        const durationMs = performance.now() - startedAt;
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("duration.ms", Number(durationMs.toFixed(2)));
        recordLatency(metricKey, durationMs, "ok");
        logJson("info", metricKey, `${name} completed`, { ...fields, durationMs: Number(durationMs.toFixed(2)) });
        return result;
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const message = error instanceof Error ? error.message : "Unknown error";
        span.recordException(error instanceof Error ? error : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.setAttribute("duration.ms", Number(durationMs.toFixed(2)));
        recordLatency(metricKey, durationMs, "error", message);
        logJson("error", metricKey, `${name} failed`, { ...fields, durationMs: Number(durationMs.toFixed(2)), error: message });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

export function logJson(level: JsonLogLevel, event: string, message: string, fields: Record<string, unknown> = {}) {
  const current = getContext();
  const entry: JsonLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    requestId: current.requestId ?? null,
    traceId: current.traceId ?? null,
    spanId: current.spanId ?? null,
    jobId: current.jobId,
    assetId: current.assetId,
    fields
  };
  pushBounded(recentLogs, entry, 300);
  if (shouldPrintToConsole(entry)) {
    console.log(JSON.stringify(entry));
  }
  void ensureLogDir().then(() => {
    writeChain = writeChain.then(() => appendFile(logPath, `${JSON.stringify(entry)}\n`)).catch(() => undefined);
  });
}

function shouldPrintToConsole(entry: JsonLogEntry) {
  const consoleLogLevel = process.env.CONSOLE_LOG_LEVEL ?? "important";
  if (consoleLogLevel === "all") {
    return true;
  }
  if (entry.level === "warn" || entry.level === "error") {
    return true;
  }
  if (entry.event !== "http.request") {
    return true;
  }

  const method = String(entry.fields?.method ?? "");
  const path = String(entry.fields?.path ?? "");
  const statusCode = Number(entry.fields?.statusCode ?? 0);
  if (method === "GET" && statusCode < 400 && noisyPollingPaths.has(path)) {
    return false;
  }
  if (method === "GET" && statusCode === 304) {
    return false;
  }
  return true;
}

export function recordLatency(key: string, durationMs: number, status: "ok" | "error", error: string | null = null) {
  const current = latencyBuckets.get(key) ?? { samples: [], updatedAt: new Date().toISOString() };
  current.samples.push({
    durationMs: Number(durationMs.toFixed(2)),
    status,
    error
  });
  current.samples = current.samples.slice(-250);
  current.updatedAt = new Date().toISOString();
  latencyBuckets.set(key, current);
}

export function getObservabilitySnapshot() {
  const metrics = [...latencyBuckets.entries()].map(([key, bucket]): LatencyMetric => {
    const values = bucket.samples.map((sample) => sample.durationMs);
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const last = bucket.samples[bucket.samples.length - 1];
    return {
      key,
      count: bucket.samples.length,
      errorCount: bucket.samples.filter((sample) => sample.status === "error").length,
      totalMs: Number(total.toFixed(2)),
      avgMs: Number((total / Math.max(1, values.length)).toFixed(2)),
      p95Ms: Number((sorted[p95Index] ?? 0).toFixed(2)),
      lastMs: last?.durationMs ?? 0,
      lastStatus: last?.status ?? "ok",
      lastError: last?.error ?? null,
      updatedAt: bucket.updatedAt
    };
  });
  return {
    service: "arion-local",
    traceExporter: "local-in-memory",
    logFormat: "json-ndjson",
    logPath,
    recentLogs: recentLogs.slice().reverse().slice(0, 80),
    recentSpans: recentSpans.slice().reverse().slice(0, 80),
    latencyMetrics: metrics.sort((a, b) => a.key.localeCompare(b.key)),
    modelRuntimeMetrics: metrics.filter(isModelRuntimeMetric),
    stageMetrics: metrics.filter((metric) => metric.key.startsWith("job.") || metric.key.startsWith("stage.") || metric.key.startsWith("search.vector")),
    requestMetrics: metrics.filter((metric) => metric.key.startsWith("http."))
  };
}

export function getContext(): Partial<RequestContext> {
  return requestContext.getStore() ?? {};
}

class LocalSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      const spanContext = span.spanContext();
      pushBounded(
        recentSpans,
        {
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          parentSpanId: span.parentSpanContext?.spanId ?? null,
          name: span.name,
          durationMs: Number(hrTimeToMilliseconds(span.duration).toFixed(2)),
          status: SpanStatusCode[span.status.code] ?? "UNSET",
          attributes: { ...span.attributes },
          startedAt: hrTimeToIso(span.startTime),
          endedAt: hrTimeToIso(span.endTime)
        },
        300
      );
    }
    resultCallback({ code: 0 });
  }

  async shutdown() {
    return undefined;
  }
}

const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new LocalSpanExporter())]
});
tracerProvider.register();

const tracer = trace.getTracer("arion-local");

function sanitizeAttributes(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, value as string | number | boolean])
  );
}

function pushBounded<T>(items: T[], item: T, limit: number) {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

async function ensureLogDir() {
  await mkdir(path.dirname(logPath), { recursive: true });
}

function hrTimeToIso(time: [number, number]) {
  return new Date(time[0] * 1000 + Math.round(time[1] / 1_000_000)).toISOString();
}

function randomTraceId() {
  return randomUUID().replace(/-/g, "");
}

function randomSpanId() {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function isModelRuntimeMetric(metric: LatencyMetric) {
  return (
    metric.key.startsWith("model.") ||
    metric.key.startsWith("search.embed") ||
    metric.key.includes("embedding")
  );
}
