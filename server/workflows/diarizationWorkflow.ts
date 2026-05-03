import { applyDiarizationToAsrSegments, runWhisperXDiarizationForAsset } from "../localModelRuntime";
import { logJson, traceAsync } from "../observability";
import { updateJob } from "../services/jobState";
import { getAsset, saveAsset } from "../store";

export async function runSpeakerDiarizationJob(jobId: string, assetId: string) {
  let stopProgress = () => {};
  try {
    await updateJob(jobId, { status: "running", stage: "diarization", progress: 5 }, "Running WhisperX speaker diarization only");
    const asset = await getAsset(assetId);
    if (!asset) throw new Error("Asset not found");
    stopProgress = startDiarizationProgress(jobId);
    const diarization = await traceAsync(
      "model.diarization.whisperx.retry",
      { jobId, assetId },
      () => runWhisperXDiarizationForAsset(asset),
      "model.diarization.whisperx.retry"
    );
    stopProgress();
    const modelTrace = [
      ...asset.intelligence.modelTrace.filter((trace) => !trace.startsWith("whisperx-unavailable:") && !trace.startsWith("whisperx:speakers:")),
      diarization.segments.length > 0 ? `whisperx:speakers:${diarization.speakers.length}` : `whisperx-unavailable:${diarization.error ?? "no speaker segments"}`
    ];
    await saveAsset({
      ...asset,
      intelligence: {
        ...asset.intelligence,
        asr: {
          ...asset.intelligence.asr,
          segments: applyDiarizationToAsrSegments(asset.intelligence.asr.segments, diarization.segments)
        },
        diarization,
        modelTrace
      },
      status: asset.timeline.length > 0 ? "indexed" : asset.status,
      progress: asset.timeline.length > 0 ? 100 : asset.progress,
      error: null,
      updatedAt: new Date().toISOString()
    });
    if (diarization.segments.length === 0) {
      throw new Error(diarization.error ?? "WhisperX did not return speaker segments");
    }
    await updateJob(
      jobId,
      { status: "succeeded", stage: "complete", progress: 100, completedAt: new Date().toISOString() },
      `WhisperX diarization completed with ${diarization.speakers.length} speakers`
    );
  } catch (error) {
    stopProgress();
    const message = error instanceof Error ? error.message : "WhisperX diarization failed";
    logJson("error", "job.diarization.failed", message, { jobId, assetId });
    await updateJob(
      jobId,
      { status: "failed", stage: "failed", progress: 100, error: message, completedAt: new Date().toISOString() },
      message,
      "error"
    );
  }
}

function startDiarizationProgress(jobId: string) {
  let progress = 5;
  const timer = setInterval(() => {
    progress = Math.min(95, progress + 1);
    void updateJob(jobId, { progress }, "WhisperX diarization is still running");
  }, 60000);
  return () => clearInterval(timer);
}
