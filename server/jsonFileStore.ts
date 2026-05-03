import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { logJson } from "./observability";

export async function readJsonFile<T>(filePath: string, fallback: () => T, context: string): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return fallback();

    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let backupError: string | null = null;
    try {
      await copyFile(filePath, backupPath);
    } catch (copyError) {
      backupError = copyError instanceof Error ? copyError.message : "Failed to copy corrupt JSON file";
    }

    logJson("error", "json_store.read_failed", "Local JSON store read failed; repair is required", {
      context,
      path: filePath,
      backupPath: backupError ? null : backupPath,
      backupError,
      error: error instanceof Error ? error.message : "Unknown JSON read failure"
    });
    throw new Error(`Local JSON store is corrupt and requires repair: ${filePath}`);
  }
}

export async function writeJsonFile(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}
