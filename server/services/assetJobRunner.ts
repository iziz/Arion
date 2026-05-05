import { getObjectPath } from "../localObjectStorage";
import { traceJobAsync } from "../observability";
import { assertWorkerOrScriptBoundary } from "../processRole";
import { getAsset } from "../store";
import { runDomainVlmRefineJob } from "../workflows/domainVlmWorkflow";
import {
  normalizeWorkflowStage,
  runIndexingJob
} from "../workflows/indexingWorkflow";
import type { AssetRecord, JobRecord } from "../../shared/types";
import { updateAsset } from "./jobState";

type RunAssetJobResult =
  | { ran: true; job: JobRecord }
  | { ran: false; job: JobRecord; reason: string };

export async function runAssetJob(job: JobRecord): Promise<RunAssetJobResult> {
  assertWorkerOrScriptBoundary("Asset job execution");
  if (!isSupportedAssetJob(job)) {
    return { ran: false, job, reason: `Unsupported worker job type: ${job.type}` };
  }
  if (!job.assetId) {
    return { ran: false, job, reason: "Asset job is missing assetId." };
  }

  const asset = await getAsset(job.assetId);
  if (!asset) {
    return { ran: false, job, reason: `Asset not found for job ${job.id}.` };
  }

  const retryStage = getRetryStage(job);
  if (job.type === "asset.domain-vlm.refine") {
    await traceJobAsync("job.domain_vlm.refine", { jobId: job.id, assetId: asset.id }, { type: job.type }, () => runDomainVlmRefineJob(job.id, asset.id));
    return { ran: true, job };
  }

  const sourcePath = getAssetSourcePath(asset);
  await updateAsset(asset.id, { status: "queued", progress: 3, error: null });
  await traceJobAsync("job.indexing", { jobId: job.id, assetId: asset.id }, { type: job.type, retryStage }, () =>
    runIndexingJob(job.id, asset.id, sourcePath, { retryStage })
  );
  return { ran: true, job };
}

export function isSupportedAssetJob(job: JobRecord) {
  return job.type === "asset.index" || job.type === "asset.reindex" || job.type === "asset.domain-vlm.refine";
}

export function getRetryStage(job: JobRecord) {
  const parameterStage = normalizeWorkflowStage(job.parameters?.retryStage);
  if (Object.prototype.hasOwnProperty.call(job.parameters ?? {}, "retryStage")) return parameterStage;
  if (parameterStage) return parameterStage;

  const logPrefix = "Retry requested from workflow card:";
  const retryLog = [...job.logs].reverse().find((entry) => entry.message.startsWith(logPrefix));
  if (!retryLog) return null;
  return normalizeWorkflowStage(retryLog.message.slice(logPrefix.length).trim());
}

function getAssetSourcePath(asset: AssetRecord) {
  return getObjectPath(asset.technicalMetadata.storageProvider, asset.technicalMetadata.bucket, asset.technicalMetadata.objectKey);
}
