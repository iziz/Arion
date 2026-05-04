import type { Response } from "express";

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

export function publishRealtimeEvent(type: RealtimeEventType, payload: Record<string, unknown>) {
  const event: RealtimeEvent = {
    id: String(nextEventId++),
    type,
    createdAt: new Date().toISOString(),
    payload
  };
  for (const subscriber of subscribers.values()) {
    if (matchesFilter(event, subscriber.filter)) subscriber.send(event);
  }
  return event;
}

export function registerRealtimeSubscriber(res: Response, filter: RealtimeEventFilter = {}) {
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
  writeSseEvent(res, {
    id: String(nextEventId++),
    type,
    createdAt: new Date().toISOString(),
    payload
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
