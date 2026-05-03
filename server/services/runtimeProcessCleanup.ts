import type { JobRecord } from "../../shared/types";
import { isProcessAlive, listProcessTable, terminateProcessTree } from "../modelRuntime/pythonProcess";
import { logJson } from "../observability";

const runtimeScripts = ["whisper_transcribe.py", "whisperx_diarize.py", "paddle_ocr_extract.py"] as const;

export async function cleanupStaleRuntimeProcesses(jobs: JobRecord[]) {
  const activeAssetIds = new Set(
    jobs
      .filter((job) => job.assetId && (job.status === "queued" || job.status === "running"))
      .map((job) => job.assetId as string)
  );
  const staleAssetIds = new Set(
    jobs
      .filter((job) => job.assetId && !activeAssetIds.has(job.assetId))
      .map((job) => job.assetId as string)
  );
  if (staleAssetIds.size === 0) return { roots: 0, terminated: 0, pids: [] as number[] };

  const table = await listProcessTable();
  const rootProcesses = table.filter((entry) => isWorkspaceRuntimeRoot(entry.command) && Array.from(staleAssetIds).some((assetId) => entry.command.includes(assetId)));
  if (rootProcesses.length === 0) return { roots: 0, terminated: 0, pids: [] as number[] };

  const terminated = new Set<number>();
  for (const entry of rootProcesses) {
    const pids = await terminateProcessTree(entry.pid, "SIGTERM");
    pids.forEach((pid) => terminated.add(pid));
  }
  await sleep(900);
  for (const pid of Array.from(terminated)) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited after SIGTERM.
    }
  }

  const pids = Array.from(terminated).sort((a, b) => a - b);
  logJson("warn", "runtime.processes.cleaned", "Terminated stale local model runtime processes", {
    roots: rootProcesses.length,
    pids
  });
  return { roots: rootProcesses.length, terminated: pids.length, pids };
}

function isWorkspaceRuntimeRoot(command: string) {
  return runtimeScripts.some((script) => command.includes(`/scripts/${script}`) || command.includes(`scripts/${script}`));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
