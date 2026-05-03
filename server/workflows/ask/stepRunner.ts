import type { AskOperationStep } from "../../../shared/types";
import { updateAskOperation } from "./operationStore";
import type { AskOperationEntry } from "./types";

export async function runAskStep<T>(
  entry: AskOperationEntry,
  spec: Pick<AskOperationStep, "id" | "label" | "owner" | "input">,
  action: () => Promise<{ value: T; output: string; status?: AskOperationStep["status"] }>
) {
  const step = startAskStep(entry, spec);
  try {
    const result = await action();
    finishAskStep(entry, step.id, result.status ?? "succeeded", result.output, null);
    return result.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Step failed";
    finishAskStep(entry, step.id, "failed", "", message);
    throw error;
  }
}

export async function runOptionalAskStep<T>(
  entry: AskOperationEntry | undefined,
  spec: Pick<AskOperationStep, "id" | "label" | "owner" | "input">,
  action: () => Promise<{ value: T; output: string; status?: AskOperationStep["status"] }>
) {
  if (!entry) return (await action()).value;
  return runAskStep(entry, spec, action);
}

export function skipAskStep(
  entry: AskOperationEntry,
  spec: Pick<AskOperationStep, "id" | "label" | "owner" | "input" | "output">
) {
  const now = new Date().toISOString();
  entry.operation.steps = [
    ...entry.operation.steps.filter((item) => item.id !== spec.id),
    {
      ...spec,
      status: "skipped",
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      error: null
    }
  ];
  updateAskOperation(entry, {});
}

function startAskStep(entry: AskOperationEntry, spec: Pick<AskOperationStep, "id" | "label" | "owner" | "input">) {
  const now = new Date().toISOString();
  const step: AskOperationStep = {
    ...spec,
    output: "",
    status: "running",
    startedAt: now,
    completedAt: null,
    durationMs: null,
    error: null
  };
  entry.operation.steps = [...entry.operation.steps.filter((item) => item.id !== spec.id), step];
  updateAskOperation(entry, {});
  return step;
}

function finishAskStep(
  entry: AskOperationEntry,
  stepId: string,
  status: AskOperationStep["status"],
  output: string,
  error: string | null
) {
  const completedAt = new Date().toISOString();
  entry.operation.steps = entry.operation.steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          status,
          output,
          completedAt,
          durationMs: step.startedAt ? new Date(completedAt).getTime() - new Date(step.startedAt).getTime() : null,
          error
        }
      : step
  );
  updateAskOperation(entry, {});
}
