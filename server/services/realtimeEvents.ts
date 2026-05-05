import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Response } from "express";
import IORedis from "ioredis";
import { logJson } from "../observability";

export type RealtimeEventType =
  | "asset.updated"
  | "asset.deleted"
  | "index.deleted"
  | "job.updated"
  | "ask.operation.updated"
  | "event.recorded"
  | "outbox.updated";

export type RealtimeEvent = {
  id: string;
  type: RealtimeEventType;
  createdAt: string;
  payload: Record<string, unknown>;
  originId?: string;
};

type RealtimeSubscriber = {
  id: number;
  filter: RealtimeEventFilter;
  send: (event: RealtimeEvent) => void;
};

export type RealtimeEventFilter = {
  jobId?: string | null;
  assetId?: string | null;
  operationId?: string | null;
};

const subscribers = new Map<number, RealtimeSubscriber>();
let nextSubscriberId = 1;
let nextEventId = 1;
const realtimeOriginId = `${hostname()}-${process.pid}-${randomUUID()}`;
const realtimeChannel = process.env.REALTIME_REDIS_CHANNEL ?? "arion:realtime-events";
let redisPublisher: IORedis | null = null;
let redisSubscriber: IORedis | null = null;
let redisSubscribeTask: Promise<void> | null = null;
let redisWarningLogged = false;

export function publishRealtimeEvent(type: RealtimeEventType, payload: Record<string, unknown>) {
  const event = createRealtimeEvent(type, payload);
  emitRealtimeEvent(event);
  void publishRedisRealtimeEvent(event);
  return event;
}

export function registerRealtimeSubscriber(res: Response, filter: RealtimeEventFilter = {}) {
  ensureRedisRealtimeSubscription();
  const id = nextSubscriberId++;
  const subscriber: RealtimeSubscriber = {
    id,
    filter,
    send: (event) => writeSseEvent(res, event)
  };
  subscribers.set(id, subscriber);
  writeSseComment(res, "connected");
  return () => {
    subscribers.delete(id);
  };
}

export function writeSseHeaders(res: Response) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();
}

export function writeSseComment(res: Response, comment: string) {
  res.write(`: ${comment}\n\n`);
}

export function writeSseRealtimeEvent(res: Response, type: RealtimeEventType, payload: Record<string, unknown>) {
  writeSseEvent(res, createRealtimeEvent(type, payload));
}

export async function closeRealtimeEvents() {
  const publisher = redisPublisher;
  const subscriber = redisSubscriber;
  redisPublisher = null;
  redisSubscriber = null;
  redisSubscribeTask = null;
  await Promise.allSettled([publisher?.quit(), subscriber?.quit()]);
}

function createRealtimeEvent(type: RealtimeEventType, payload: Record<string, unknown>): RealtimeEvent {
  return {
    id: `${realtimeOriginId}:${nextEventId++}`,
    type,
    createdAt: new Date().toISOString(),
    payload,
    originId: realtimeOriginId
  };
}

function emitRealtimeEvent(event: RealtimeEvent) {
  for (const subscriber of subscribers.values()) {
    if (matchesFilter(event, subscriber.filter)) subscriber.send(event);
  }
}

async function publishRedisRealtimeEvent(event: RealtimeEvent) {
  const publisher = getRedisPublisher();
  if (!publisher) return;
  try {
    await ensureRedisReady(publisher);
    await publisher.publish(realtimeChannel, JSON.stringify(event));
  } catch (error) {
    logRedisWarning("realtime.redis.publish_failed", "Redis realtime publish failed", error);
  }
}

function ensureRedisRealtimeSubscription() {
  if (redisSubscribeTask || redisSubscriber || !getRedisUrl()) return;
  const subscriber = createRedisConnection("subscriber");
  if (!subscriber) return;
  redisSubscriber = subscriber;
  subscriber.on("message", (channel, message) => {
    if (channel !== realtimeChannel) return;
    const event = parseRedisRealtimeEvent(message);
    if (!event || event.originId === realtimeOriginId) return;
    emitRealtimeEvent(event);
  });
  redisSubscribeTask = ensureRedisReady(subscriber)
    .then(() => subscriber.subscribe(realtimeChannel))
    .then(() => undefined)
    .catch((error) => {
      logRedisWarning("realtime.redis.subscribe_failed", "Redis realtime subscription failed", error);
      redisSubscriber?.disconnect();
      redisSubscriber = null;
      redisSubscribeTask = null;
    });
}

function getRedisPublisher() {
  if (!getRedisUrl()) return null;
  redisPublisher ??= createRedisConnection("publisher");
  return redisPublisher;
}

function createRedisConnection(role: "publisher" | "subscriber") {
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;
  const connection = new IORedis(redisUrl, {
    connectTimeout: 3000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: role === "subscriber" ? null : 1
  });
  connection.on("error", (error) => {
    logRedisWarning("realtime.redis.error", "Redis realtime connection error", error);
  });
  return connection;
}

async function ensureRedisReady(connection: IORedis) {
  if (connection.status === "ready") return;
  if (connection.status === "wait") {
    await connection.connect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis realtime connection did not become ready from ${connection.status}`));
    }, 3000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      connection.off("ready", onReady);
      connection.off("error", onError);
    };
    connection.once("ready", onReady);
    connection.once("error", onError);
  });
}

function getRedisUrl() {
  if (process.env.REALTIME_REDIS_ENABLED === "false") return null;
  return process.env.REALTIME_REDIS_URL || process.env.REDIS_URL || null;
}

function parseRedisRealtimeEvent(message: string): RealtimeEvent | null {
  try {
    const parsed = JSON.parse(message) as RealtimeEvent;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.type !== "string" || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

function logRedisWarning(event: string, message: string, error: unknown) {
  if (redisWarningLogged) return;
  redisWarningLogged = true;
  logJson("warn", event, message, {
    channel: realtimeChannel,
    error: error instanceof Error ? error.message : "Unknown Redis realtime error"
  });
}

function writeSseEvent(res: Response, event: RealtimeEvent) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function matchesFilter(event: RealtimeEvent, filter: RealtimeEventFilter) {
  if (filter.jobId && event.payload.jobId !== filter.jobId) return false;
  if (filter.assetId && event.payload.assetId !== filter.assetId) return false;
  if (filter.operationId && event.payload.operationId !== filter.operationId) return false;
  return true;
}
