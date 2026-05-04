export type RuntimeStageReporter = (event: {
  stage: string;
  status: "running" | "succeeded" | "failed";
  message: string;
  error?: string;
  progress?: number;
  log?: boolean;
  heartbeat?: boolean;
}) => void | Promise<void>;

export async function runRuntimeStage<T>(
  reportStage: RuntimeStageReporter | undefined,
  stage: string,
  message: string,
  run: () => Promise<T>,
  getSoftError?: (result: T) => string | null
) {
  await reportStage?.({ stage, status: "running", message, progress: 0 });
  const heartbeat =
    reportStage &&
    setInterval(() => {
      void reportStage({ stage, status: "running", message: formatHeartbeatMessage(message), log: false, heartbeat: true });
    }, 60000);
  try {
    const result = await run();
    const softError = getSoftError?.(result) ?? null;
    if (softError) {
      await reportStage?.({ stage, status: "failed", message: `${message} failed`, error: softError, progress: 100 });
    } else {
      await reportStage?.({ stage, status: "succeeded", message: `${message} complete`, progress: 100 });
    }
    return result;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Runtime stage failed";
    await reportStage?.({ stage, status: "failed", message: `${message} failed`, error: messageText, progress: 100 });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function formatHeartbeatMessage(message: string) {
  const trimmed = message.trim();
  const activeObject = trimmed.match(/^running\s+(.+)$/i)?.[1];
  if (activeObject) return `${activeObject} is still running`;
  return `${trimmed} is still running`;
}
