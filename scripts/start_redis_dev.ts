import IORedis from "ioredis";
import { mkdir } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { RedisMemoryServer as RedisMemoryServerClass } from "redis-memory-server";

type RedisMemoryServerInstance = InstanceType<typeof RedisMemoryServerClass>;

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const parsed = new URL(redisUrl);
const host = parsed.hostname;
const port = Number(parsed.port || 6379);

if (await isRedisReachable(redisUrl)) {
  console.log(`[dev:redis] Redis is already reachable at ${redisUrl}`);
  process.exit(0);
}

if (!isLocalRedisHost(host)) {
  console.error(`[dev:redis] REDIS_URL points to non-local host ${host}; start Redis there or update REDIS_URL.`);
  process.exit(1);
}

await mkdir(path.resolve(".data", "redis"), { recursive: true });

let child: ChildProcess | null = tryStartRedisServer(port) ?? tryStartDockerRedis(port);
let memoryServer: RedisMemoryServerInstance | null = null;

if (!child) {
  memoryServer = await tryStartRedisMemoryServer(port);
}

if (!child && !memoryServer) {
  console.error("[dev:redis] Could not start Redis with redis-server, Docker, or redis-memory-server.");
  process.exit(1);
}

const ready = await waitForRedis(redisUrl, () => child !== null && (child.exitCode !== null || child.signalCode !== null));
if (!ready) {
  await shutdown(1);
  process.exit(1);
}

console.log(`[dev:redis] Redis is ready at ${redisUrl}`);

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

if (child) {
  child.on("exit", (code, signal) => {
    if (signal) process.exit(0);
    process.exit(code ?? 0);
  });
} else {
  process.stdin.resume();
}

function tryStartRedisServer(redisPort: number) {
  if (!commandExists("redis-server", ["--version"])) return null;
  console.log(`[dev:redis] Starting redis-server on port ${redisPort}`);
  return spawn(
    "redis-server",
    [
      "--port",
      String(redisPort),
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      path.resolve(".data", "redis"),
      "--loglevel",
      "warning"
    ],
    { stdio: "inherit" }
  );
}

function tryStartDockerRedis(redisPort: number) {
  if (!commandExists("docker", ["--version"])) return null;
  console.log(`[dev:redis] Starting redis:7 with Docker on port ${redisPort}`);
  return spawn("docker", ["run", "--rm", "-p", `${redisPort}:6379`, "redis:7"], { stdio: "inherit" });
}

async function tryStartRedisMemoryServer(redisPort: number) {
  try {
    const { RedisMemoryServer } = await import("redis-memory-server");
    console.log(`[dev:redis] Starting redis-memory-server on port ${redisPort}`);
    const server = await RedisMemoryServer.create({
      binary: {
        version: process.env.REDISMS_VERSION ?? "7.2.4"
      },
      instance: {
        args: ["--dir", path.resolve(".data", "redis")],
        ip: "127.0.0.1",
        port: redisPort
      }
    });
    const actualPort = await server.getPort();
    if (actualPort !== redisPort) {
      await server.stop();
      console.error(`[dev:redis] redis-memory-server started on ${actualPort}, expected ${redisPort}.`);
      return null;
    }
    return server;
  } catch (error) {
    console.error(`[dev:redis] redis-memory-server failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function waitForRedis(url: string, hasProcessExited: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (hasProcessExited()) {
      console.error("[dev:redis] Redis process exited before becoming ready.");
      return false;
    }
    if (await isRedisReachable(url)) return true;
    await sleep(250);
  }
  console.error(`[dev:redis] Timed out waiting for Redis at ${url}.`);
  return false;
}

async function isRedisReachable(url: string) {
  const client = new IORedis(url, {
    connectTimeout: 500,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    await client.quit();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}

function isLocalRedisHost(value: string) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "";
}

function commandExists(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shuttingDown = false;

async function shutdown(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  child?.kill("SIGTERM");
  if (memoryServer) {
    await memoryServer.stop();
  }
  process.exit(exitCode);
}
