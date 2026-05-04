import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(".env"), quiet: true, override: true });

if (!process.env.ARION_PROCESS_ROLE) {
  process.env.ARION_PROCESS_ROLE = inferProcessRole(process.argv[1] ?? "");
}

function inferProcessRole(entry: string) {
  const normalized = entry.split(path.sep).join("/");
  if (normalized.endsWith("/server/jobWorker.ts") || normalized.endsWith("/server/jobWorker.js")) return "worker";
  if (normalized.endsWith("/server/index.ts") || normalized.endsWith("/server/index.js")) return "api";
  if (normalized.includes("/scripts/") || normalized.startsWith("scripts/")) return "script";
  return "unknown";
}
