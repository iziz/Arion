import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const pythonBin = process.env.LOCAL_AI_PYTHON || "python3";
const execFileAsync = promisify(execFile);
const activePythonPids = new Set<number>();
let shutdownHandlersInstalled = false;

export type PythonScriptResult = {
  stdout: string;
  stderr: string;
};

export type ProcessTableEntry = {
  pid: number;
  ppid: number;
  command: string;
};

export function runPythonScriptOnExit(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }
): Promise<PythonScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (child.pid) activePythonPids.add(child.pid);
    installShutdownHandlers();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 4;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (child.pid) activePythonPids.delete(child.pid);
      fn();
    };

    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      if (kind === "stdout") {
        stdout += text;
        options.onStdout?.(text);
      } else {
        stderr += text;
        options.onStderr?.(text);
      }
      if (stdout.length + stderr.length > maxBuffer) {
        if (child.pid) void terminateProcessTree(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
        finish(() => reject(new Error(`Python script output exceeded ${maxBuffer} bytes: ${pythonBin} ${args.join(" ")}`)));
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`Command failed: ${pythonBin} ${args.join(" ")}${signal ? ` (${signal})` : ""}\n${stderr}`));
      });
    });
  });
}

export async function terminateActivePythonChildren(signal: NodeJS.Signals = "SIGTERM") {
  const pids = Array.from(activePythonPids);
  await Promise.allSettled(pids.map((pid) => terminateProcessTree(pid, signal)));
}

export async function terminateProcessTree(rootPid: number, signal: NodeJS.Signals = "SIGTERM") {
  const table = await listProcessTable().catch(() => []);
  const descendants = collectDescendantPids(table, rootPid);
  const targets = [...descendants.reverse(), rootPid];
  for (const pid of targets) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
  return targets;
}

export async function listProcessTable(): Promise<ProcessTableEntry[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 1024 * 1024 * 2
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimStart().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid) && entry.command.length > 0);
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parsePythonJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of [...lines].reverse()) {
      if (!line.startsWith("{") || !line.endsWith("}")) continue;
      try {
        return JSON.parse(line) as T;
      } catch {
        continue;
      }
    }
    throw new Error(`Python script did not return parseable JSON. Last output: ${lines.at(-1)?.slice(0, 240) ?? "empty"}`);
  }
}

function collectDescendantPids(table: ProcessTableEntry[], rootPid: number) {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }
  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || descendants.includes(pid)) continue;
    descendants.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function installShutdownHandlers() {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void terminateActivePythonChildren("SIGTERM").finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }
}
