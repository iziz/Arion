import IORedis from "ioredis";
import { logJson } from "../observability";

type RedisReadyOptions = {
  component: string;
  event: string;
  redisUrl: string;
  workerId?: string;
  intervalMs?: number;
};

export async function waitForRedisReady(options: RedisReadyOptions) {
  const intervalMs = options.intervalMs ?? 2000;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const redis = new IORedis(options.redisUrl, {
      connectTimeout: 1000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      await redis.ping();
      await redis.quit();
      if (attempts > 1) {
        logJson("info", `${options.event}.ready`, "Redis is ready; starting worker process.", {
          component: options.component,
          redisUrl: options.redisUrl,
          workerId: options.workerId,
          attempts
        });
      }
      return;
    } catch (error) {
      redis.disconnect();
      if (attempts === 1 || attempts % 5 === 0) {
        logJson("warn", options.event, "Redis is not ready; worker startup is waiting before creating BullMQ workers.", {
          component: options.component,
          redisUrl: options.redisUrl,
          workerId: options.workerId,
          attempts,
          retryInMs: intervalMs,
          error: error instanceof Error ? error.message : "Redis connection failed"
        });
      }
      await sleep(intervalMs);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
