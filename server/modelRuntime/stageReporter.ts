export type RuntimeStageReporter = (event: {
  stage: string;
  status: "running" | "succeeded" | "failed";
  message: string;
  error?: string;
}) => void | Promise<void>;

export async function runRuntimeStage<T>(
  reportStage: RuntimeStageReporter | undefined,
  stage: string,
  message: string,
  run: () => Promise<T>,
  getSoftError?: (result: T) => string | null
) {
  await reportStage?.({ stage, status: "running", message });
  const heartbeat =
    reportStage &&
    setInterval(() => {
      void reportStage({ stage, status: "running", message: `${message} is still running` });
    }, 60000);
  try {
    const result = await run();
    const softError = getSoftError?.(result) ?? null;
    if (softError) {
      await reportStage?.({ stage, status: "failed", message: `${message} failed`, error: softError });
    } else {
      await reportStage?.({ stage, status: "succeeded", message: `${message} complete` });
    }
    return result;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Runtime stage failed";
    await reportStage?.({ stage, status: "failed", message: `${message} failed`, error: messageText });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}
