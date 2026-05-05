import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const terminationGraceMs = 1500;

type ProcessInfo = {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
};

type ManagedMatch = {
  process: ProcessInfo;
  label: string;
};

const managedPatterns = [
  { label: "model runtime service", needles: ["scripts/arion_model_runtime_service.py", "npm run models:runtime", "npm run models:runtime:ai"] },
  { label: "VLM worker", needles: ["scripts/qwen_vlm_worker.py", "npm run models:vlm", "npm run models:vlm:ai"] },
  { label: "API watcher", needles: ["tsx watch server/index.ts", " server/index.ts", "npm run dev:api"] },
  { label: "asset worker watcher", needles: ["tsx watch server/jobWorker.ts", " server/jobWorker.ts", "npm run dev:worker:run"] },
  { label: "ask worker watcher", needles: ["tsx watch server/askWorker.ts", " server/askWorker.ts", "npm run dev:ask-worker:run"] },
  { label: "Vite dev server", needles: ["node_modules/.bin/vite --host 0.0.0.0", " vite --host 0.0.0.0", "npm run dev:web:run"] },
  { label: "dev web wrapper", needles: ["scripts/wait_for_dev_api.ts", "npm run dev:web"] }
];

const portChecks = [
  { label: "API", port: positiveInteger(process.env.PORT, 8787) },
  { label: "VLM worker", port: positiveInteger(process.env.QWEN_VLM_PORT, 8791) },
  { label: "model runtime service", port: positiveInteger(process.env.PYTHON_RUNTIME_SERVICE_PORT, 8792) }
];

async function main() {
  const processes = await listProcesses();
  const currentTree = currentProcessTree(processes);
  const matches = await managedProcesses(processes, currentTree);
  const targets = includeDescendants(matches, processes);

  if (targets.length > 0) {
    console.log(`[dev:cleanup] stopping ${targets.length} stale Arion dev process${targets.length === 1 ? "" : "es"}...`);
    for (const target of targets) {
      console.log(`[dev:cleanup] ${target.process.pid} ${target.label}: ${target.process.command}`);
    }
    await terminateProcesses(targets.map((target) => target.process), processes);
  } else {
    console.log("[dev:cleanup] no stale Arion dev processes found.");
  }

  const blockers = await portBlockers();
  if (blockers.length > 0) {
    const details = blockers
      .map((blocker) => `${blocker.label} port ${blocker.port}: PID ${blocker.process.pid} ${blocker.managed ? "managed process did not exit" : "unmanaged process"}: ${blocker.process.command}`)
      .join("\n");
    throw new Error(`Required development ports are still occupied:\n${details}`);
  }
}

async function listProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,stat=,command="], { maxBuffer: 2 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line): ProcessInfo | null => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        stat: match[3],
        command: match[4]
      };
    })
    .filter((processInfo): processInfo is ProcessInfo => Boolean(processInfo));
}

async function managedProcesses(processes: ProcessInfo[], currentTree: Set<number>): Promise<ManagedMatch[]> {
  const matches: ManagedMatch[] = [];
  for (const processInfo of processes) {
    if (currentTree.has(processInfo.pid)) continue;
    const pattern = managedPatterns.find((candidate) => candidate.needles.some((needle) => processInfo.command.includes(needle)));
    if (!pattern) continue;
    if (!(await belongsToRepo(processInfo))) continue;
    matches.push({ process: processInfo, label: pattern.label });
  }
  return matches;
}

function includeDescendants(matches: ManagedMatch[], processes: ProcessInfo[]): ManagedMatch[] {
  const childrenByParent = new Map<number, ProcessInfo[]>();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.ppid, children);
  }

  const targets = new Map<number, ManagedMatch>();
  const queue = [...matches];
  while (queue.length > 0) {
    const match = queue.shift()!;
    if (targets.has(match.process.pid)) continue;
    targets.set(match.process.pid, match);
    for (const child of childrenByParent.get(match.process.pid) ?? []) {
      queue.push({ process: child, label: `${match.label} child` });
    }
  }
  return Array.from(targets.values()).sort((a, b) => processDepth(b.process, processes) - processDepth(a.process, processes));
}

async function belongsToRepo(processInfo: ProcessInfo) {
  if (processInfo.command.includes(repoRoot)) return true;
  const cwd = await processCwd(processInfo.pid);
  return cwd ? isSameOrChildPath(cwd, repoRoot) : false;
}

async function processCwd(pid: number) {
  if (process.platform !== "win32") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      // macOS does not expose /proc; fall back to lsof below.
    }
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { maxBuffer: 64 * 1024 });
    const line = stdout
      .split("\n")
      .find((item) => item.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function currentProcessTree(processes: ProcessInfo[]) {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const tree = new Set<number>();
  let cursor = process.pid;
  while (cursor > 0 && !tree.has(cursor)) {
    tree.add(cursor);
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }
  return tree;
}

async function terminateProcesses(processes: ProcessInfo[], allProcesses: ProcessInfo[]) {
  const sorted = [...processes].sort((a, b) => processDepth(b, allProcesses) - processDepth(a, allProcesses));
  for (const processInfo of sorted) {
    signalProcess(processInfo.pid, "SIGTERM");
  }
  await sleep(terminationGraceMs);
  for (const processInfo of sorted) {
    if (isRunning(processInfo.pid)) signalProcess(processInfo.pid, "SIGKILL");
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : null;
    if (code !== "ESRCH") throw error;
  }
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processDepth(processInfo: ProcessInfo, processes: ProcessInfo[]) {
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  let depth = 0;
  let cursor = processInfo.ppid;
  const visited = new Set<number>();
  while (cursor > 0 && !visited.has(cursor)) {
    visited.add(cursor);
    const parent = byPid.get(cursor);
    if (!parent) break;
    depth += 1;
    cursor = parent.ppid;
  }
  return depth;
}

async function portBlockers() {
  const blockers: Array<{ label: string; port: number; process: ProcessInfo; managed: boolean }> = [];
  for (const check of portChecks) {
    const listeners = await listenersOnPort(check.port);
    for (const listener of listeners) {
      blockers.push({ label: check.label, port: check.port, process: listener, managed: await isManagedListener(listener) });
    }
  }
  return blockers;
}

async function listenersOnPort(port: number) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { maxBuffer: 256 * 1024 });
    const pids = stdout
      .split("\n")
      .filter((line) => line.startsWith("p"))
      .map((line) => Number(line.slice(1)))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    const processes = await listProcesses();
    const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
    return pids.flatMap((pid) => {
      const processInfo = byPid.get(pid);
      return processInfo ? [processInfo] : [];
    });
  } catch {
    return [];
  }
}

async function isManagedListener(processInfo: ProcessInfo) {
  const pattern = managedPatterns.find((candidate) => candidate.needles.some((needle) => processInfo.command.includes(needle)));
  return Boolean(pattern) && (await belongsToRepo(processInfo));
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isSameOrChildPath(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`[dev:cleanup] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
