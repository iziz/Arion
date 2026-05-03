import { spawn } from "node:child_process";

const pythonBin = process.env.LOCAL_AI_PYTHON || "python3";

export type PythonScriptResult = {
  stdout: string;
  stderr: string;
};

export function runPythonScriptOnExit(
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number }
): Promise<PythonScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 4;
    let timer: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
      if (kind === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`Python script output exceeded ${maxBuffer} bytes: ${pythonBin} ${args.join(" ")}`)));
      }
    };

    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`Python script exceeded safety limit after ${options.timeout}ms: ${pythonBin} ${args.join(" ")}`)));
      }, options.timeout);
    }

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
