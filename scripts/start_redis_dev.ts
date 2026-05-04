import IORedis from "ioredis";
import { mkdir } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

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

let child = tryStartRedisServer(port) ?? tryStartDockerRedis(port);
if (!child) {
  console.error("[dev:redis] Could not start Redis. Install redis-server or Docker, then rerun npm run dev:full.");
  process.exit(1);
}

const ready = await waitForRedis(redisUrl, child);
if (!ready) {
  child.kill("SIGTERM");
  process.exit(1);
}

console.log(`[dev:redis] Redis is ready at ${redisUrl}`);

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

child.on("exit", (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 0);
});

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

async function waitForRedis(url: string, processRef: ChildProcess) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (processRef.exitCode !== null) {
      console.error(`[dev:redis] Redis process exited before becoming ready with code ${processRef.exitCode}.`);
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

function shutdown() {
  child?.kill("SIGTERM");
}
