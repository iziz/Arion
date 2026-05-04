import type { RuntimeStageReporter } from "./stageReporter";

type PythonProgressEvent = {
  type?: string;
  stage?: string;
  message?: string;
  progress?: number;
};

const pythonProgressPrefix = "ARION_PROGRESS ";

export function createPythonProgressReporter(fallbackStage: string, reportStage?: RuntimeStageReporter) {
  let buffered = "";
  let pending = Promise.resolve();
  return {
    handleChunk(chunk: string) {
      if (!reportStage) return;
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const event = parsePythonProgressEvent(line);
        if (!event) continue;
        const stage = typeof event.stage === "string" && event.stage.trim() ? event.stage.trim() : fallbackStage;
        const message = typeof event.message === "string" && event.message.trim() ? event.message.trim() : `${stage} is running`;
        pending = pending
          .then(() =>
            reportStage({
              stage,
              status: "running",
              message,
              progress: normalizeStageProgress(event.progress),
              log: false
            })
          )
          .then(() => undefined, () => undefined);
      }
    },
    async flush() {
      await pending;
    }
  };
}

function parsePythonProgressEvent(line: string): PythonProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(pythonProgressPrefix)) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(pythonProgressPrefix.length)) as PythonProgressEvent;
    return parsed.type === "progress" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStageProgress(value: unknown) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress)));
}
