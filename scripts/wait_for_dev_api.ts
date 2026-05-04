import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(".env"), quiet: true, override: false });

const apiUrl = process.env.DEV_API_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || "8787"}/api/health`;
const timeoutMs = positiveInteger(process.env.DEV_API_WAIT_TIMEOUT_MS, 60_000);
const intervalMs = positiveInteger(process.env.DEV_API_WAIT_INTERVAL_MS, 500);
const startedAt = Date.now();

try {
  await waitForApi();
  console.log(`[dev:web] API is ready at ${apiUrl}`);
} catch (error) {
  console.error(`[dev:web] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function waitForApi() {
  let lastError = "API is not reachable";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(apiUrl, { signal: AbortSignal.timeout(Math.min(intervalMs, 1000)) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "API is not reachable";
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for API readiness at ${apiUrl}. Last error: ${lastError}`);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
