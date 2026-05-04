import dotenv from "dotenv";
import IORedis from "ioredis";
import { spawn } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(".env"), quiet: true, override: false });

const mode = process.argv[2] ?? "up";
const redisPort = process.env.REDIS_PORT || "16379";
const postgresPort = process.env.POSTGRES_PORT || "15432";
const defaultRedisUrl = `redis://127.0.0.1:${redisPort}`;
const defaultDatabaseUrl = `postgres://video_intelligence:video_intelligence@127.0.0.1:${postgresPort}/video_intelligence`;
const redisUrl = process.env.DOCKER_REDIS_URL || defaultRedisUrl;
const databaseUrl = process.env.DOCKER_DATABASE_URL || defaultDatabaseUrl;

try {
  if (mode === "up") {
    await runDockerCompose(["up", "-d", "redis", "postgres"]);
    await waitForInfra();
  } else if (mode === "check") {
    await waitForInfra();
  } else if (mode === "down") {
    await runDockerCompose(["down"]);
  } else {
    throw new Error(`Unknown docker infra mode: ${mode}`);
  }
} catch (error) {
  console.error(`[docker:infra] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function waitForInfra() {
  await waitForRedis(redisUrl);
  await waitForPostgres(databaseUrl);
  console.log(`[docker:infra] Redis is ready at ${redactUrl(redisUrl)}`);
  console.log(`[docker:infra] PostgreSQL is ready at ${redactUrl(databaseUrl)}`);
}

async function runDockerCompose(args: string[]) {
  await run("docker", ["compose", ...args]);
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(new Error(`Failed to run ${command}. Docker Desktop and Docker Compose are required. ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function waitForRedis(url: string) {
  let lastError = "Redis is not reachable";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new IORedis(url, {
      connectTimeout: 1000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.ping();
      await client.quit();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Redis is not reachable";
      client.disconnect();
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for Docker Redis at ${redactUrl(url)}. Last error: ${lastError}`);
}

async function waitForPostgres(connectionString: string) {
  let lastError = "PostgreSQL is not reachable";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 1000,
      idleTimeoutMillis: 1000,
      max: 1,
      ssl: getPostgresSslConfig()
    });
    try {
      await pool.query("select 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "PostgreSQL is not reachable";
      await pool.end().catch(() => undefined);
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for Docker PostgreSQL at ${redactUrl(connectionString)}. Last error: ${lastError}`);
}

function getPostgresSslConfig() {
  const sslMode = process.env.PGSSLMODE ?? process.env.POSTGRES_SSLMODE;
  if (!sslMode || sslMode === "disable") return undefined;
  if (sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}

function redactUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return value;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
