import { CheckCircle2, CircleHelp, Edit3, FileVideo, Layers3, RefreshCw, Search, Trash2, XCircle } from "lucide-react";
import { Fragment, type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import type { AssetRecord, AssetSummaryRecord, IdentityReviewPatchRequest, IndexRecord, JobRecord } from "../../../shared/types";
import { KNOWLEDGE_SOURCES, formatKnowledgeSourceLabel } from "../../../shared/knowledgeSources";
import { knowledgeTemplateDescriptors, sportsBaseTemplateContract, type KnowledgeTemplateDescriptor } from "../../../shared/knowledgeTemplates";
import { getAssetFlow, type FlowStep } from "../../assetFlow";
import type { ModelCapabilitiesSnapshot } from "../../api";
import { formatDuration, mediaPath, truncateText } from "../../displayUtils";
import { EmptyState } from "../common/ConsolePrimitives";
import { OcrRoleSummary } from "../evidence/EvidenceComponents";
import { getDomainSummary, getSearchSceneData } from "../evidence/sceneEvidence";
import { getWorkflowLogTokens, getWorkflowRuntimeStageIds, getWorkflowSearchImpact, getWorkflowStageAliases } from "../../../shared/workflowNodes";

export type AssetDetailTab = "overview" | "workflow" | "timeline";
export type AssetGroupMarkerSize = "small" | "large";

type MomentOpenOptions = {
  start?: number;
  end?: number;
  label?: string;
};

type OpenMomentHandler = (segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;
export type IdentityReviewHandler = (request: IdentityReviewPatchRequest) => Promise<void>;

const SEGMENT_PREVIEW_LIMIT = 120;
const OCR_TOKEN_PREVIEW_LIMIT = 160;
const OCR_FRAME_PREVIEW_LIMIT = 40;

export function AssetGroupForm({ index, onSubmit }: { index: IndexRecord | null; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  const domain = index?.domainIndexing;
  const domainEnabled = Boolean(domain?.enabled);
  const stages = new Set(domain?.stages ?? ["domain_caption", "event_label", "structured_event"]);
  const policy = index?.capabilityPolicy;
  return (
    <form className="stack compact" onSubmit={(event) => void onSubmit(event)}>
      <input name="name" placeholder="새 에셋그룹 이름" defaultValue={index?.name ?? ""} autoFocus />
      <textarea name="description" placeholder="에셋그룹 설명" defaultValue={index?.description ?? ""} />
      <div className="index-options">
        <label className="toggle-row">
          <input name="domainIndexingEnabled" type="checkbox" defaultChecked={domainEnabled} />
          <span>
            <strong>Related knowledge indexing</strong>
            <em>Enable when this asset group should use a selected knowledge source.</em>
          </span>
        </label>
        <label className="field-label">
          <span>Knowledge source</span>
          <select name="domainGroup" defaultValue={domain?.groups[0] ?? KNOWLEDGE_SOURCES[0]?.id ?? ""}>
            {KNOWLEDGE_SOURCES.map((source) => (
              <option key={source.id} value={source.id}>{source.label}</option>
            ))}
          </select>
        </label>
        <div className="stage-options" aria-label="Domain indexing stages">
          <label>
            <input name="domainStage" type="checkbox" value="domain_caption" defaultChecked={stages.has("domain_caption")} />
            <span>Knowledge captions</span>
          </label>
          <label>
            <input name="domainStage" type="checkbox" value="event_label" defaultChecked={stages.has("event_label")} />
            <span>Event labels</span>
          </label>
          <label>
            <input name="domainStage" type="checkbox" value="structured_event" defaultChecked={stages.has("structured_event")} />
            <span>Structured event schema</span>
          </label>
        </div>
        <div className="stage-options" aria-label="Model capability policy">
          <CapabilitySelect name="capabilityWhisperX" label="WhisperX diarization" value={policy?.whisperXDiarization ?? "optional"} />
          <CapabilitySelect name="capabilityVideoVlm" label="Video VLM analysis" value={policy?.videoVlmAnalysis ?? "optional"} />
          <CapabilitySelect name="capabilityVisionDetector" label="Vision detector" value={policy?.visionDetector ?? "optional"} />
          <CapabilitySelect name="capabilityVisionTracker" label="Vision tracker" value={policy?.visionTracker ?? "optional"} />
          <CapabilitySelect name="capabilityKnowledgeAction" label="Knowledge action spotting" value={policy?.knowledgeActionSpotting ?? "optional"} />
          <CapabilitySelect name="capabilityDomainVlm" label="Related knowledge VLM refinement" value={policy?.domainVlmRefinement ?? "optional"} />
        </div>
      </div>
      <button type="submit">
        <Layers3 size={16} />
        {index ? "에셋그룹 저장" : "에셋그룹 만들기"}
      </button>
    </form>
  );
}

function CapabilitySelect({ name, label, value }: { name: string; label: string; value: "disabled" | "optional" | "required" }) {
  return (
    <label>
      <span>{label}</span>
      <select name={name} defaultValue={value}>
        <option value="optional">optional</option>
        <option value="required">required</option>
        <option value="disabled">disabled</option>
      </select>
    </label>
  );
}

export function AssetGroupSummary({
  index,
  assets,
  onEdit,
  onDelete,
  deleteDisabled,
  deleteTitle,
  modelCapabilities
}: {
  index: IndexRecord | null;
  assets: AssetSummaryRecord[];
  modelCapabilities: ModelCapabilitiesSnapshot | null;
  onEdit: () => void;
  onDelete: () => void;
  deleteDisabled: boolean;
  deleteTitle: string;
}) {
  const indexedCount = assets.filter((asset) => asset.status === "indexed").length;
  const domain = index?.domainIndexing;
  const vlmSummary = summarizeAssetGroupVlm(assets);
  const domainText =
    domain?.enabled && domain.groups.length > 0
      ? `${domain.groups.map(formatKnowledgeSourceLabel).join(", ")} · ${domain.stages.map((stage) => stage.replace(/_/g, " ")).join(", ")}`
      : "Off";
  const capabilityText = index?.capabilityPolicy ? summarizeCapabilityPolicy(index.capabilityPolicy) : "capabilities optional";
  const metaChips = buildAssetGroupMetaChips(index, assets, modelCapabilities, domainText, capabilityText, vlmSummary);
  return (
    <section className="asset-group-summary" aria-label="Selected asset group summary">
      <div>
        <p className="section-label">Asset Group</p>
        <span className="asset-group-title-row">
          <span className="asset-group-title-main">
            <h2 className="asset-group-title">
              <AssetGroupStatusMarker index={index} assets={assets} size="large" />
              <span>{index?.name ?? "No asset group selected"}</span>
            </h2>
            <em className="asset-group-indexed-count">{indexedCount}/{assets.length} indexed</em>
          </span>
          <span className="asset-group-title-actions">
            <button type="button" className="asset-group-edit" onClick={onEdit} disabled={!index} aria-label="에셋그룹 수정" title="에셋그룹 수정">
              <Edit3 size={17} />
            </button>
            <button
              type="button"
              className="asset-group-edit asset-group-delete"
              onClick={onDelete}
              disabled={!index || deleteDisabled}
              aria-label="에셋그룹 삭제"
              title={deleteTitle}
            >
              <Trash2 size={17} />
            </button>
          </span>
        </span>
        {index?.description && <p>{index.description}</p>}
        <div className="asset-group-meta">
          {metaChips.map((chip) => (
            <span
              key={chip.label}
              className="asset-group-meta-chip"
              data-kind={chip.kind}
              data-disabled={chip.disabled ? "true" : undefined}
              data-tooltip={`${chip.label}: ${chip.tooltip}`}
              tabIndex={0}
              aria-label={`${chip.label}: ${chip.value}. ${chip.tooltip}`}
            >
              <b>{chip.label}</b>
              {chip.value}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function AssetGroupStatusMarker({ index, assets = [], size = "small" }: { index: IndexRecord | null; assets?: AssetSummaryRecord[]; size?: AssetGroupMarkerSize }) {
  const marker = assetGroupStatusMarker(index, assets);
  return (
    <span
      className={`asset-group-status-marker ${size}`}
      style={{ color: marker.color }}
      aria-label={marker.label}
      title={marker.label}
    >
      ●
    </span>
  );
}

const ACTIVE_ASSET_STATUSES = new Set<AssetSummaryRecord["status"]>(["queued", "probing", "transcribing", "scanning", "sampling", "embedding"]);

function assetGroupStatusMarker(index: IndexRecord | null, assets: AssetSummaryRecord[]) {
  if (!index) return { color: "#a2b1aa", label: "No asset group selected" };
  if (assets.some((asset) => asset.status === "failed")) return { color: "#c8574a", label: "Asset group has failed videos" };
  if (assets.some((asset) => ACTIVE_ASSET_STATUSES.has(asset.status))) return { color: "#2a7c94", label: "Asset group is indexing" };
  if (assets.length === 0 || index.status === "empty") return { color: "#a2b1aa", label: "Asset group is empty" };
  if (assets.every((asset) => asset.status === "indexed")) return { color: "#2b8b70", label: "Asset group ready" };
  return { color: "#b7792f", label: "Asset group partially indexed" };
}

function summarizeCapabilityPolicy(policy: NonNullable<IndexRecord["capabilityPolicy"]>) {
  const required = Object.entries(policy)
    .filter(([, mode]) => mode === "required")
    .map(([name]) => name.replace(/([A-Z])/g, " $1").toLowerCase());
  const disabled = Object.entries(policy)
    .filter(([, mode]) => mode === "disabled")
    .map(([name]) => name.replace(/([A-Z])/g, " $1").toLowerCase());
  if (required.length > 0) return `required: ${required.join(", ")}`;
  if (disabled.length > 0) return `disabled: ${disabled.join(", ")}`;
  return "capabilities optional";
}

function summarizeAssetGroupVlm(assets: AssetSummaryRecord[]) {
  const counts = assets.reduce(
    (sum, asset) => ({
      refined: sum.refined + asset.domainVlm.refined,
      invalid: sum.invalid + asset.domainVlm.invalid,
      failed: sum.failed + asset.domainVlm.failed,
      skipped: sum.skipped + asset.domainVlm.skipped,
      attempted: sum.attempted + asset.domainVlm.attempted
    }),
    { refined: 0, invalid: 0, failed: 0, skipped: 0, attempted: 0 }
  );
  const attempted = counts.attempted;
  if (attempted === 0) return "not run";
  return `${counts.refined}/${attempted} refined${counts.invalid ? ` · ${counts.invalid} invalid` : ""}${counts.failed ? ` · ${counts.failed} failed` : ""}`;
}

type AssetGroupMetaChip = {
  label: string;
  value: string;
  tooltip: string;
  kind: "knowledge" | "policy" | "model" | "storage";
  disabled?: boolean;
};

function buildAssetGroupMetaChips(
  index: IndexRecord | null,
  assets: AssetSummaryRecord[],
  modelCapabilities: ModelCapabilitiesSnapshot | null,
  domainText: string,
  capabilityText: string,
  vlmSummary: string
): AssetGroupMetaChip[] {
  const domain = index?.domainIndexing;
  const policy = index?.capabilityPolicy;
  const configured = modelCapabilities?.configuredModels;
  const domainEnabled = Boolean(domain?.enabled && domain.groups.length > 0);
  const domainStages = domain?.stages.map((stage) => stage.replace(/_/g, " ")).join(", ") || "none";
  const indexedCount = assets.filter((asset) => asset.status === "indexed").length;
  const vlm = configured?.videoVlm;
  const vlmConfigured = vlm?.enabled ?? modelCapabilities?.runtimeTopology?.vlm?.enabled;
  return [
    {
      label: "Knowledge",
      value: domainText,
      tooltip: domainEnabled
        ? `Selected related knowledge sources and indexing stages. Stages: ${domainStages}.`
        : "Related knowledge indexing is disabled for this asset group.",
      kind: "knowledge",
      disabled: !domainEnabled
    },
    {
      label: "Capability policy",
      value: capabilityText,
      tooltip: policy ? formatCapabilityPolicyTooltip(policy) : "No explicit policy was stored, so optional capability defaults apply.",
      kind: "policy"
    },
    {
      label: "VLM refinement",
      value: vlmSummary,
      tooltip: `Related knowledge VLM refinement uses ${vlm?.model ?? modelCapabilities?.runtimeTopology?.vlm?.model ?? "qwen2.5-vl-local-worker"} when enabled. Policy ${policy?.domainVlmRefinement ?? "optional"}, service ${vlmConfigured ? "enabled" : "not configured"}, indexed assets ${indexedCount}/${assets.length}.`,
      kind: "model",
      disabled: policy?.domainVlmRefinement === "disabled" || vlmConfigured === false
    }
  ];
}

function formatCapabilityPolicyTooltip(policy: NonNullable<IndexRecord["capabilityPolicy"]>) {
  return Object.entries(policy)
    .map(([name, mode]) => `${name.replace(/([A-Z])/g, " $1").toLowerCase()}: ${mode}`)
    .join(", ");
}

export function VideoStatusSummary({ asset }: { asset: AssetRecord }) {
  return (
    <div className="video-status-summary" aria-label="Selected video status">
      <span className={asset.status ? "complete" : ""}>
        <FileVideo size={15} />
        <strong>영상 확인</strong>
        <em>{asset.status}</em>
      </span>
      <span className={asset.status === "indexed" ? "complete" : ""}>
        <Search size={15} />
        <strong>검색 준비</strong>
        <em>{asset.status === "indexed" ? "사용 가능" : asset.status}</em>
      </span>
    </div>
  );
}

export function AssetFlow({
  asset,
  index,
  job,
  onRetryStage,
  onOpenMoment,
  onReviewIdentity
}: {
  asset: AssetRecord;
  index: IndexRecord | null;
  job: JobRecord | null;
  onRetryStage: (assetId: string, stage: string) => Promise<void>;
  onOpenMoment?: OpenMomentHandler;
  onReviewIdentity?: IdentityReviewHandler;
}) {
  const flow = getAssetFlow(asset, index, job);
  const activeStep = flow.find((step) => step.state === "active") ?? flow.find((step) => step.state === "error") ?? flow.at(-1);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(activeStep?.id ?? flow[0]?.id ?? "input");
  const overallProgress = getServerBackedProgress(asset, job);
  const overallStage = getServerBackedStage(asset, job);
  const stageGroups = [
    {
      label: "1. Source preparation",
      detail: "Validate the media file, probe metadata, then sample coarse audio and visual signals.",
      steps: flow.filter((step) => step.id === "input" || step.id === "probe" || step.id === "audio" || step.id === "vad" || step.id === "visual")
    },
    {
      label: "2. Speech and text extraction",
      detail: "Run ASR, optional speaker alignment, and OCR before timeline assembly.",
      steps: flow.filter((step) => step.id === "asr" || step.id === "speakers" || step.id === "ocr")
    },
    {
      label: "3. Scene and vision evidence",
      detail: "Build scene windows, keyframes, and VLM scene evidence before domain grounding.",
      steps: flow.filter((step) => step.id === "scene" || step.id === "timeline" || step.id === "keyframes" || step.id === "videoVlm")
    },
    {
      label: "4. Domain evidence",
      detail: "Apply detector, tracker, raw match profiling, template action generation, related knowledge event construction, and optional event-level VLM refinement.",
      steps: flow.filter((step) => step.id === "detector" || step.id === "tracker" || step.id === "matchProfile" || step.id === "knowledgeAction" || step.id === "domain" || step.id === "domainVlm")
    },
    {
      label: "5. Vector index",
      detail: "Build search summaries, text embeddings, visual embeddings, and vector records.",
      steps: flow.filter((step) => step.id === "summary" || step.id === "textEmbedding" || step.id === "visualEmbedding" || step.id === "vector")
    },
    {
      label: "6. Serve",
      detail: "Expose the indexed asset for search and focused analysis.",
      steps: flow.filter((step) => step.id === "ready")
    }
  ].filter((group) => group.steps.length > 0);
  const retryDisabled = job?.status === "queued" || job?.status === "running";
  const retryNode = (step: FlowStep) => void onRetryStage(asset.id, step.retryStage);
  return (
    <section className="asset-flow" aria-label="Selected video processing flow">
      <div className="flow-summary">
        <div>
          <p className="section-label">Node workflow</p>
          <h3>{activeStep?.label ?? "Ready"}</h3>
        </div>
        <span>{overallStage} · {overallProgress}%</span>
      </div>
      <div className="progress-track" aria-label={`${overallProgress}% complete`}>
        <span style={{ width: `${overallProgress}%` }} />
      </div>
      <div className="node-canvas">
        {stageGroups.map((group, stageIndex) => (
          <Fragment key={group.label}>
            <section className="workflow-stage">
              <div className="workflow-stage-header">
                <span>{group.label}</span>
                <p>{group.detail}</p>
              </div>
              <div className="node-column">
                {group.steps.map((step) => (
                  <FlowNode
                    key={step.id}
                    step={step}
                    expanded={expandedStepId === step.id}
                    retryDisabled={retryDisabled}
                    onToggle={(nextStep) => setExpandedStepId((current) => (current === nextStep.id ? null : nextStep.id))}
                    onRetry={retryNode}
                  >
                    <WorkflowRunDetails job={job} step={step} />
                    <WorkflowResultContent asset={asset} index={index} step={step} onOpenMoment={onOpenMoment} onReviewIdentity={onReviewIdentity} />
                  </FlowNode>
                ))}
              </div>
            </section>
            {stageIndex < stageGroups.length - 1 && <FlowConnector />}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

function getServerBackedProgress(asset: AssetRecord, job: JobRecord | null) {
  if (job?.status === "queued" || job?.status === "running") return job.progress;
  return asset.progress;
}

function getServerBackedStage(asset: AssetRecord, job: JobRecord | null) {
  if (job?.status === "queued" || job?.status === "running") return job.stage;
  return asset.status;
}

export function getAssetProgressLine(asset: AssetRecord, job: JobRecord | null) {
  if (job?.status === "queued" || job?.status === "running") {
    return `${job.status} · ${job.stage} · ${job.progress}%`;
  }
  return `${asset.status} ${asset.progress}%`;
}

export function FlowNode({
  step,
  expanded,
  retryDisabled,
  onToggle,
  onRetry,
  children
}: {
  step: FlowStep;
  expanded: boolean;
  retryDisabled: boolean;
  onToggle: (step: FlowStep) => void;
  onRetry: (step: FlowStep) => void;
  children?: ReactNode;
}) {
  const progressLabel = typeof step.progress === "number" ? `${step.progress}%` : null;
  const progressAriaLabel = progressLabel ? `${step.label} ${progressLabel}` : `${step.label} ${step.state}`;
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle(step);
  }
  return (
    <article className={`flow-node ${step.state} ${expanded ? "expanded" : ""}`} title={step.helpText}>
      <div className="node-click-target" role="button" tabIndex={0} aria-expanded={expanded} onClick={() => onToggle(step)} onKeyDown={handleKeyDown}>
        <div className="node-title">
          <span className="node-kind">{step.id}</span>
          {step.helpText && (
            <span className="node-help" aria-label={step.helpText} title={step.helpText} tabIndex={0}>
              <CircleHelp size={14} />
            </span>
          )}
          <strong>{step.label}</strong>
        </div>
        <p>{step.detail}</p>
        <p className="node-description">{step.description}</p>
        {step.serverProgress && !expanded && (
          <span className="node-server-progress">
            Overall job · {step.serverProgress.status} · {step.serverProgress.stage} · {step.serverProgress.progress}%
          </span>
        )}
        <div className="node-badge-row" aria-label={`${step.label} quality and search impact`}>
          <span className={`node-quality ${qualityToneForStep(step)}`}>Quality: {qualityLabelForStep(step)}</span>
          <span>{searchImpactForStep(step)}</span>
        </div>
        <div className="node-progress" aria-label={progressAriaLabel}>
          <span style={{ width: `${step.progress ?? 0}%` }} />
        </div>
        <div className="node-actions">
          <span className="node-state">{step.state}</span>
          {progressLabel && <span className="node-percent">Node {progressLabel}</span>}
          <span className="node-open">{expanded ? "Hide" : "View"}</span>
          <button
            type="button"
            className="node-retry"
            onClick={(event) => {
              event.stopPropagation();
              onRetry(step);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={retryDisabled}
            aria-label={`Retry ${step.label}`}
            title={`Retry ${step.label}`}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
      {expanded && children && <div className="node-result">{children}</div>}
    </article>
  );
}

type NodeMetricTone = "good" | "warning" | "bad" | "neutral";

type NodeMetric = {
  label: string;
  value: string;
  tone?: NodeMetricTone;
};

function WorkflowNodeDetails({
  produced,
  usedBy,
  quality,
  inspect,
  rawDetails
}: {
  produced: NodeMetric[];
  usedBy: string[];
  quality: NodeMetric[];
  inspect?: ReactNode;
  rawDetails?: string[];
}) {
  const normalizedRaw = (rawDetails ?? []).filter(Boolean);
  return (
    <div className="workflow-node-details">
      <WorkflowMetricSection title="Produced" metrics={produced} />
      <WorkflowUsageSection items={usedBy} />
      <WorkflowMetricSection title="Quality" metrics={quality} />
      {inspect && (
        <section className="workflow-node-section inspect">
          <h4>Inspect</h4>
          {inspect}
        </section>
      )}
      {normalizedRaw.length > 0 && (
        <details className="workflow-raw-details">
          <summary>Raw details</summary>
          <div>
            {normalizedRaw.map((detail) => (
              <code key={detail}>{detail}</code>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function WorkflowMetricSection({ title, metrics }: { title: string; metrics: NodeMetric[] }) {
  if (metrics.length === 0) return null;
  return (
    <section className="workflow-node-section">
      <h4>{title}</h4>
      <div className="workflow-result-grid compact">
        {metrics.map((metric) => (
          <ResultMetric key={`${title}-${metric.label}-${metric.value}`} label={metric.label} value={metric.value} tone={metric.tone} />
        ))}
      </div>
    </section>
  );
}

function WorkflowUsageSection({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="workflow-node-section">
      <h4>Used by</h4>
      <div className="workflow-used-by">
        {items.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </section>
  );
}

function PreviewLimitNotice({ total, visible, label }: { total: number; visible: number; label: string }) {
  const hidden = Math.max(0, total - visible);
  if (hidden === 0) return null;
  return <span className="preview-limit-note">Showing {visible} of {total} {label}; use search or timeline filters for the rest.</span>;
}

function WorkflowRunDetails({ job, step }: { job: JobRecord | null; step: FlowStep }) {
  if (!job) return null;
  const currentStage = isWorkflowStageMatch(step, job.stage);
  const runtimeStages = getWorkflowRuntimeStages(job, step);
  const matchedLogs = getWorkflowStepLogs(job, step);
  const candidateLogs = matchedLogs.length > 0 ? matchedLogs : currentStage ? job.logs : [];
  const logs = collapseConsecutiveWorkflowLogs(candidateLogs).slice(-6);
  const logTitle = matchedLogs.length > 0 || !currentStage ? "Related logs" : "Recent job logs";
  return (
    <section className={`workflow-node-run-details ${currentStage ? "current" : ""}`} aria-label={`${step.label} run details`}>
      <div className="workflow-run-header">
        <div>
          <h4>Run details</h4>
          <span>Overall job · {job.type} · {job.status} · {job.stage}</span>
        </div>
        <strong>Overall {job.progress}%</strong>
      </div>
      <div className="workflow-run-progress" aria-label={`${job.progress}% job progress`}>
        <span style={{ width: `${job.progress}%` }} />
      </div>
      <div className="workflow-run-facts">
        <span>
          <b>Node</b>
          {step.state}
        </span>
        <span>
          <b>Node progress</b>
          {step.progress === null ? step.state : `${step.progress}%`}
        </span>
        <span>
          <b>Updated</b>
          {formatWorkflowTime(job.updatedAt)}
        </span>
      </div>
      {job.error && <p className="workflow-run-error">{job.error}</p>}
      {runtimeStages.length > 0 && (
        <div className="workflow-runtime-stage-list" aria-label={`${step.label} runtime stages`}>
          {runtimeStages.map((stage) => {
            const progress = normalizeWorkflowPercent(stage.progress);
            const elapsed = formatWorkflowElapsed(stage.startedAt, stage.completedAt);
            return (
              <article key={stage.stage} className={`workflow-runtime-stage ${stage.status}`}>
                <div className="workflow-runtime-stage-heading">
                  <strong>{stage.stage}</strong>
                  <span>{stage.status} · {progress}%</span>
                </div>
                <p>{stage.message}</p>
                <div className="workflow-runtime-stage-progress" aria-label={`${stage.stage} ${progress}% complete`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="workflow-runtime-stage-meta">
                  <span>Elapsed {elapsed}</span>
                  <span>Updated {formatWorkflowTime(stage.updatedAt)}</span>
                </div>
                {stage.error && <em>{stage.error}</em>}
              </article>
            );
          })}
        </div>
      )}
      <div className="workflow-log-list" aria-label={`${step.label} job logs`}>
        <strong>{logTitle}</strong>
        {logs.length > 0 ? (
          logs.map((log) => (
            <p key={`${log.at}-${log.message}`} className={log.level}>
              <time>{formatWorkflowTime(log.at)}</time>
              <span>{log.level}</span>
              {log.message}
            </p>
          ))
        ) : (
          <em>No job log lines matched this node.</em>
        )}
      </div>
    </section>
  );
}

function collapseConsecutiveWorkflowLogs(logs: JobRecord["logs"]) {
  return logs.reduce<JobRecord["logs"]>((collapsed, log) => {
    const previous = collapsed.at(-1);
    if (previous?.level === log.level && previous.message === log.message) {
      collapsed[collapsed.length - 1] = log;
      return collapsed;
    }
    collapsed.push(log);
    return collapsed;
  }, []);
}

function getWorkflowRuntimeStages(job: JobRecord, step: FlowStep) {
  const runtimeStageIds = getWorkflowRuntimeStageIds(step.id);
  return runtimeStageIds
    .map((stageId) => job.runtimeStages?.[stageId])
    .filter((stage): stage is NonNullable<JobRecord["runtimeStages"]>[string] => Boolean(stage));
}

function getWorkflowStepLogs(job: JobRecord, step: FlowStep) {
  const tokens = getWorkflowLogTokens(step.id);
  return job.logs.filter((log) => {
    const message = log.message.toLowerCase();
    return tokens.some((token) => message.includes(token));
  });
}

function isWorkflowStageMatch(step: FlowStep, stage: string) {
  const normalizedStage = stage.toLowerCase();
  return getWorkflowStageAliases(step.id).some((alias) => normalizedStage === alias || normalizedStage.startsWith(`${alias}-`));
}

function formatWorkflowTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatWorkflowElapsed(startedAt: string, completedAt: string | null) {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "0:00";
  return formatDuration((end - start) / 1000);
}

function normalizeWorkflowPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function qualityToneForStep(step: FlowStep) {
  if (step.state === "done") return "good";
  if (step.state === "error") return "bad";
  if (step.state === "skipped") return "warning";
  return "neutral";
}

function qualityLabelForStep(step: FlowStep) {
  if (step.state === "done") return "ready";
  if (step.state === "error") return "failed";
  if (step.state === "skipped") return "skipped";
  if (step.state === "active") return "running";
  return "pending";
}

function searchImpactForStep(step: FlowStep) {
  return getWorkflowSearchImpact(step.id, step.state);
}

function WorkflowResultContent({
  asset,
  index,
  step,
  onOpenMoment,
  onReviewIdentity
}: {
  asset: AssetRecord;
  index: IndexRecord | null;
  step: FlowStep;
  onOpenMoment?: OpenMomentHandler;
  onReviewIdentity?: IdentityReviewHandler;
}) {
  const stepId = step.id;
  if (stepId === "input") return <InputSourceResult asset={asset} step={step} />;
  if (stepId === "probe") return <ProbeMetadataResult asset={asset} step={step} />;
  if (stepId === "audio" || stepId === "vad") return <AudioResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "asr") return <AsrResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "speakers") return <SpeakerResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "ocr") return <OcrResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "visual" || stepId === "keyframes") return <VisualResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "videoVlm") return <VideoVlmResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "scene" || stepId === "timeline") return <TimelineResult asset={asset} step={step} onOpenMoment={onOpenMoment} />;
  if (stepId === "detector" || stepId === "tracker" || stepId === "knowledgeAction") return <ModelTraceResult asset={asset} index={index} step={step} />;
  if (stepId === "matchProfile") return <RawMatchProfileResult asset={asset} step={step} />;
  if (stepId === "domain" || stepId === "domainVlm") return <DomainResult asset={asset} step={step} onOpenMoment={onOpenMoment} onReviewIdentity={onReviewIdentity} />;
  if (stepId === "summary" || stepId === "textEmbedding" || stepId === "visualEmbedding" || stepId === "vector" || stepId === "ready") return <VectorResult asset={asset} step={step} />;
  return <EmptyState text="No stored result details are available for this workflow step." />;
}

function findMomentSegment(asset: AssetRecord, at: number, segmentId?: string | null) {
  const directSegment = segmentId ? asset.timeline.find((segment) => segment.id === segmentId) : null;
  if (directSegment) return directSegment;
  const containingSegment = asset.timeline.find((segment) => at >= segment.start && at <= segment.end);
  if (containingSegment) return containingSegment;
  return asset.timeline.reduce<AssetRecord["timeline"][number] | null>((closest, segment) => {
    if (!closest) return segment;
    return Math.abs(segment.start - at) < Math.abs(closest.start - at) ? segment : closest;
  }, null);
}

function openAssetMoment(
  asset: AssetRecord,
  onOpenMoment: OpenMomentHandler | undefined,
  {
    at,
    end,
    label,
    segmentId
  }: {
    at: number;
    end?: number;
    label?: string;
    segmentId?: string | null;
  }
) {
  const segment = findMomentSegment(asset, at, segmentId);
  if (!segment) return;
  const start = Math.max(0, at);
  onOpenMoment?.(segment, {
    start,
    end: typeof end === "number" ? Math.max(start, end) : undefined,
    label
  });
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function sumWindowDuration(windows: Array<{ start: number; end: number }>) {
  return windows.reduce((sum, window) => sum + Math.max(0, window.end - window.start), 0);
}

function formatCoverage(numerator: number, denominator: number | null | undefined) {
  if (!denominator || denominator <= 0) return "Unknown";
  return `${Math.round(Math.max(0, Math.min(1, numerator / denominator)) * 100)}%`;
}

function metricTone(ok: boolean, warning = false): NodeMetricTone {
  if (ok) return "good";
  return warning ? "warning" : "bad";
}

function rawStepDetails(step: FlowStep, extra: string[] = []) {
  return [step.trace, ...extra].filter(Boolean) as string[];
}

function InputSourceResult({ asset, step }: { asset: AssetRecord; step: FlowStep }) {
  const hasObjectKey = Boolean(asset.technicalMetadata.objectKey);
  const hasChecksum = Boolean(asset.technicalMetadata.checksum);
  const hasStoredName = Boolean(asset.storedName);
  const hasPayload = asset.size > 0;
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Source file", value: hasStoredName ? "Stored" : "Missing", tone: metricTone(hasStoredName) },
        { label: "File size", value: formatBytes(asset.size), tone: metricTone(hasPayload) },
        { label: "MIME type", value: asset.mimeType || "Unknown", tone: metricTone(Boolean(asset.mimeType), true) },
        { label: "Checksum", value: hasChecksum ? "Stored" : "Missing", tone: metricTone(hasChecksum, true) },
        { label: "Storage", value: `${asset.technicalMetadata.storageProvider} · ${asset.technicalMetadata.bucket}`, tone: metricTone(Boolean(asset.technicalMetadata.bucket)) },
        { label: "Object key", value: hasObjectKey ? "Stored" : "Missing", tone: metricTone(hasObjectKey) }
      ]}
      usedBy={["probe metadata", "audio extraction", "visual sampling", "result source anchoring"]}
      quality={[
        { label: "Source anchor", value: hasObjectKey ? "object key ready" : "object key missing", tone: metricTone(hasObjectKey) },
        { label: "Payload", value: hasPayload ? "non-empty file" : "empty or unknown size", tone: metricTone(hasPayload) },
        { label: "Checksum", value: hasChecksum ? "integrity fingerprint stored" : "integrity fingerprint missing", tone: metricTone(hasChecksum, true) },
        { label: "Storage", value: asset.technicalMetadata.bucket ? "bucket assigned" : "bucket missing", tone: metricTone(Boolean(asset.technicalMetadata.bucket)) }
      ]}
      inspect={
        <div className="workflow-result-grid">
          <ResultMetric label="Original" value={asset.originalName} />
          <ResultMetric label="Stored" value={asset.storedName} />
          <ResultMetric label="MIME" value={asset.mimeType || "Unknown"} />
          <ResultMetric label="Provider" value={asset.technicalMetadata.storageProvider} />
          <ResultMetric label="Bucket" value={asset.technicalMetadata.bucket} />
          <ResultMetric label="Object key" value={asset.technicalMetadata.objectKey} />
        </div>
      }
      rawDetails={rawStepDetails(step, [asset.technicalMetadata.checksum ? `checksum:${asset.technicalMetadata.checksum}` : ""])}
    />
  );
}

function ProbeMetadataResult({ asset, step }: { asset: AssetRecord; step: FlowStep }) {
  const hasDuration = Boolean(asset.duration && asset.duration > 0);
  const hasFrame = Boolean(asset.width && asset.height);
  const hasVideoCodec = Boolean(asset.technicalMetadata.videoCodec);
  const hasAudioCodec = Boolean(asset.technicalMetadata.audioCodec);
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Duration", value: hasDuration ? formatDuration(asset.duration ?? 0) : "Missing", tone: metricTone(hasDuration) },
        { label: "Resolution", value: hasFrame ? `${asset.width}x${asset.height}` : "Missing", tone: metricTone(hasFrame) },
        { label: "FPS", value: asset.technicalMetadata.frameRate ? `${Math.round(asset.technicalMetadata.frameRate)}fps` : "Unknown", tone: metricTone(Boolean(asset.technicalMetadata.frameRate), true) },
        { label: "Video codec", value: asset.technicalMetadata.videoCodec ?? "Unknown", tone: metricTone(hasVideoCodec, true) },
        { label: "Audio codec", value: asset.technicalMetadata.audioCodec ?? "Unavailable", tone: metricTone(hasAudioCodec, true) },
        { label: "Container", value: asset.mimeType || "Unknown", tone: metricTone(Boolean(asset.mimeType), true) }
      ]}
      usedBy={["audio extraction timing", "visual sampling cadence", "scene windows", "metadata filters"]}
      quality={[
        { label: "Video", value: hasVideoCodec ? "codec known" : "codec unknown", tone: metricTone(hasVideoCodec, true) },
        { label: "Audio", value: hasAudioCodec ? "codec known" : "audio unavailable", tone: metricTone(hasAudioCodec, true) },
        { label: "Duration", value: hasDuration ? "usable" : "duration 0 or missing", tone: metricTone(hasDuration) },
        { label: "Frame", value: hasFrame ? "dimensions stored" : "dimensions missing", tone: metricTone(hasFrame, true) }
      ]}
      inspect={
        <div className="workflow-result-grid">
          <ResultMetric label="Duration seconds" value={asset.duration ? asset.duration.toFixed(3) : "Unknown"} />
          <ResultMetric label="Width" value={asset.width ? String(asset.width) : "Unknown"} />
          <ResultMetric label="Height" value={asset.height ? String(asset.height) : "Unknown"} />
          <ResultMetric label="Frame rate" value={asset.technicalMetadata.frameRate ? `${asset.technicalMetadata.frameRate.toFixed(3)}fps` : "Unknown"} />
          <ResultMetric label="Video codec" value={asset.technicalMetadata.videoCodec ?? "Unknown"} />
          <ResultMetric label="Audio codec" value={asset.technicalMetadata.audioCodec ?? "Unavailable"} />
        </div>
      }
      rawDetails={rawStepDetails(step, [
        asset.duration ? `ffprobe:duration:${asset.duration}` : "",
        hasFrame ? `ffprobe:resolution:${asset.width}x${asset.height}` : "",
        asset.technicalMetadata.frameRate ? `ffprobe:frameRate:${asset.technicalMetadata.frameRate}` : "",
        asset.technicalMetadata.videoCodec ? `ffprobe:videoCodec:${asset.technicalMetadata.videoCodec}` : "",
        asset.technicalMetadata.audioCodec ? `ffprobe:audioCodec:${asset.technicalMetadata.audioCodec}` : ""
      ])}
    />
  );
}

function AudioResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  const speechSegments = asset.intelligence.audio?.speechSegments ?? [];
  const musicSegments = asset.intelligence.audio?.musicSegments ?? [];
  const speechDuration = sumWindowDuration(speechSegments);
  const musicDuration = sumWindowDuration(musicSegments);
  const mediaDuration = asset.duration ?? 0;
  const noSpeechDuration = Math.max(0, mediaDuration - speechDuration);
  const hasAudioArtifact = Boolean(asset.intelligence.audio?.extractedPath);
  const speechCoverage = formatCoverage(speechDuration, asset.duration);
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Audio artifact", value: hasAudioArtifact ? "16kHz mono WAV" : "Missing", tone: metricTone(hasAudioArtifact, true) },
        { label: "Speech coverage", value: speechCoverage, tone: metricTone(speechSegments.length > 0, true) },
        { label: "Speech duration", value: formatDuration(speechDuration), tone: speechSegments.length > 0 ? "good" : "warning" },
        { label: "Music/noise duration", value: formatDuration(musicDuration), tone: "neutral" },
        { label: "No-speech gap", value: mediaDuration > 0 ? formatDuration(noSpeechDuration) : "Unknown", tone: "neutral" },
        { label: "Regions", value: `${speechSegments.length} speech · ${musicSegments.length} music/noise`, tone: "neutral" }
      ]}
      usedBy={["ASR", "speaker diarization", "speech-aware timeline", "text search coverage"]}
      quality={[
        { label: "Artifact", value: hasAudioArtifact ? "ready" : "no extracted audio", tone: metricTone(hasAudioArtifact, true) },
        { label: "VAD", value: asset.intelligence.audio?.vad?.available === false ? "unavailable" : "available", tone: asset.intelligence.audio?.vad?.available === false ? "warning" : "good" },
        { label: "Provider", value: asset.intelligence.audio?.vad?.provider ?? "local", tone: "neutral" },
        { label: "Coverage", value: speechCoverage, tone: speechSegments.length > 0 ? "good" : "warning" }
      ]}
      inspect={
        <div className="segment-list compact-list">
          {[...speechSegments.map((segment) => ({ ...segment, kind: "speech" })), ...musicSegments.map((segment) => ({ ...segment, kind: "music/noise" }))].map((segment) => (
            <button
              key={`${segment.kind}-${segment.start}-${segment.end}`}
              type="button"
              className="time-chip"
              aria-label={`Play ${segment.kind} from ${formatDuration(segment.start)}`}
              onClick={() => openAssetMoment(asset, onOpenMoment, { at: segment.start, end: segment.end, label: `${segment.kind} region` })}
            >
              {segment.kind} · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {Math.round(segment.confidence * 100)}%
            </button>
          ))}
          {speechSegments.length + musicSegments.length === 0 && <span>No speech or music regions are stored.</span>}
        </div>
      }
      rawDetails={rawStepDetails(step, [asset.intelligence.audio?.vad?.error ? `vad-error:${asset.intelligence.audio.vad.error}` : ""])}
    />
  );
}

function AsrResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  const segments = asset.intelligence.asr.segments;
  const visibleSegments = segments.slice(0, SEGMENT_PREVIEW_LIMIT);
  const transcript = asset.intelligence.asr.transcript.trim();
  const coverage = formatCoverage(sumWindowDuration(segments), asset.duration);
  const confidence = asset.intelligence.asr.confidence;
  const sample = segments.find((segment) => segment.text.trim().length > 0)?.text.trim() || transcript || "No speech text was extracted.";
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Transcript", value: transcript ? `${transcript.length} chars` : "Empty", tone: metricTone(Boolean(transcript), true) },
        { label: "Segments", value: segments.length.toString(), tone: metricTone(segments.length > 0, true) },
        { label: "Coverage", value: coverage, tone: metricTone(segments.length > 0, true) },
        { label: "Language", value: asset.intelligence.asr.language || "Unknown", tone: asset.intelligence.asr.language ? "good" : "warning" },
        { label: "Confidence", value: `${Math.round(confidence * 100)}%`, tone: confidence >= 0.65 ? "good" : confidence > 0 ? "warning" : "bad" }
      ]}
      usedBy={["text search", "player/event inference", "domain planning", "play-style analysis grounding"]}
      quality={[
        { label: "Searchable text", value: transcript ? "available" : "missing", tone: metricTone(Boolean(transcript), true) },
        { label: "Low confidence", value: confidence > 0 && confidence < 0.55 ? "review" : "not flagged", tone: confidence > 0 && confidence < 0.55 ? "warning" : "good" },
        { label: "Empty windows", value: segments.length === 0 ? "all empty" : "timestamped samples available", tone: segments.length === 0 ? "warning" : "good" }
      ]}
      inspect={
        <div className="workflow-result-stack">
          <p className="transcript-box">{truncateText(sample, 520)}</p>
          <div className="segment-list compact-list">
            {visibleSegments.map((segment) => (
              <button
                key={`${segment.start}-${segment.end}-${segment.text}`}
                type="button"
                className="time-chip"
                aria-label={`Play ASR segment from ${formatDuration(segment.start)}`}
                onClick={() => openAssetMoment(asset, onOpenMoment, { at: segment.start, end: segment.end, label: "ASR segment" })}
              >
                {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.text}
              </button>
            ))}
            <PreviewLimitNotice total={segments.length} visible={visibleSegments.length} label="ASR segments" />
            {segments.length === 0 && <span>No timestamped ASR segments are stored.</span>}
          </div>
        </div>
      }
      rawDetails={rawStepDetails(step)}
    />
  );
}

function SpeakerResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  const diarization = asset.intelligence.diarization;
  const visibleSegments = (diarization?.segments ?? []).slice(0, SEGMENT_PREVIEW_LIMIT);
  const currentRunActive = step.state === "active";
  const speakerCount = currentRunActive ? null : (diarization?.speakers.length ?? 0);
  const segmentCount = currentRunActive ? null : (diarization?.segments.length ?? 0);
  const currentRunError = currentRunActive ? null : diarization?.error;
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Provider", value: currentRunActive ? "current run pending" : (diarization?.provider ?? "none"), tone: currentRunActive ? "neutral" : diarization?.provider ? "good" : "warning" },
        { label: "Speakers", value: speakerCount === null ? "pending" : speakerCount.toString(), tone: speakerCount === null ? "neutral" : speakerCount > 0 ? "good" : "warning" },
        { label: "Segments", value: segmentCount === null ? "pending" : segmentCount.toString(), tone: segmentCount === null ? "neutral" : segmentCount > 0 ? "good" : "warning" }
      ]}
      usedBy={["speaker-aware review", "quote attribution", "analysis context"]}
      quality={[
        { label: "Optional stage", value: "not required for base search", tone: "neutral" },
        {
          label: "Status",
          value: currentRunActive ? "running" : currentRunError ? "skipped or failed" : (diarization?.segments.length ?? 0) > 0 ? "ready" : "no segments",
          tone: currentRunActive ? "neutral" : currentRunError ? "warning" : (diarization?.segments.length ?? 0) > 0 ? "good" : "neutral"
        }
      ]}
      inspect={
        <div className="segment-list compact-list">
          {currentRunActive ? (
            <span>Current speaker diarization run is still in progress.</span>
          ) : (
            <>
              {visibleSegments.map((segment) => (
                <button
                  key={`${segment.speaker}-${segment.start}-${segment.end}-${segment.text}`}
                  type="button"
                  className="time-chip"
                  aria-label={`Play ${segment.speaker} from ${formatDuration(segment.start)}`}
                  onClick={() => openAssetMoment(asset, onOpenMoment, { at: segment.start, end: segment.end, label: `${segment.speaker} segment` })}
                >
                  {segment.speaker} · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.text}
                </button>
              ))}
              <PreviewLimitNotice total={diarization?.segments.length ?? 0} visible={visibleSegments.length} label="speaker segments" />
              {(diarization?.segments.length ?? 0) === 0 && <span>No speaker diarization segments are stored.</span>}
            </>
          )}
        </div>
      }
      rawDetails={rawStepDetails(step, [currentRunError ? `diarization-error:${currentRunError}` : ""])}
    />
  );
}

function OcrResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  const frames = asset.intelligence.ocr.frames;
  const visibleTokens = asset.intelligence.ocr.tokens.slice(0, OCR_TOKEN_PREVIEW_LIMIT);
  const visibleFrames = frames.slice(0, OCR_FRAME_PREVIEW_LIMIT);
  const boxes = frames.flatMap((frame) => frame.boxes ?? []);
  const roleCounts = boxes.reduce<Record<string, number>>((counts, box) => {
    counts[box.role] = (counts[box.role] ?? 0) + 1;
    return counts;
  }, {});
  const scoreboardTokens = asset.intelligence.ocr.tokens.filter(isScoreboardLikeToken);
  const hasClock = asset.intelligence.ocr.tokens.some((token) => /\b\d{1,2}:\d{2}\b/.test(token));
  const hasScore = asset.intelligence.ocr.tokens.some((token) => /\b\d{1,3}\s*[-:]\s*\d{1,3}\b/.test(token));
  const hasTeamText = asset.intelligence.ocr.tokens.some((token) => /[A-Z]{2,4}/.test(token) && token.length <= 8);
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Tokens", value: asset.intelligence.ocr.tokens.length.toString(), tone: metricTone(asset.intelligence.ocr.tokens.length > 0, true) },
        { label: "Frames", value: frames.length.toString(), tone: metricTone(frames.length > 0, true) },
        { label: "Subtitles", value: String(roleCounts.subtitle ?? 0), tone: "neutral" },
        { label: "Overlays", value: String(roleCounts.overlay ?? 0), tone: "neutral" },
        { label: "Watermarks", value: String(roleCounts.watermark ?? 0), tone: "neutral" },
        { label: "Scoreboard-like", value: scoreboardTokens.length.toString(), tone: scoreboardTokens.length > 0 ? "good" : "neutral" }
      ]}
      usedBy={["screen-text search", "scoreboard/team inference", "ASR/OCR consistency", "domain planning"]}
      quality={[
        { label: "Confidence", value: `${Math.round(asset.intelligence.ocr.confidence * 100)}%`, tone: asset.intelligence.ocr.confidence >= 0.65 ? "good" : asset.intelligence.ocr.confidence > 0 ? "warning" : "bad" },
        { label: "Clock text", value: hasClock ? "detected" : "not found", tone: hasClock ? "good" : "neutral" },
        { label: "Score text", value: hasScore ? "detected" : "not found", tone: hasScore ? "good" : "neutral" },
        { label: "Team text", value: hasTeamText ? "candidate" : "not found", tone: hasTeamText ? "good" : "neutral" }
      ]}
      inspect={
        <div className="workflow-result-stack">
          <div className="ocr-token-list">
            {visibleTokens.map((token) => <span key={token}>{token}</span>)}
            <PreviewLimitNotice total={asset.intelligence.ocr.tokens.length} visible={visibleTokens.length} label="OCR tokens" />
            {asset.intelligence.ocr.tokens.length === 0 && <span>No OCR text was extracted.</span>}
          </div>
          <div className="ocr-frame-list">
            {visibleFrames.map((frame) => {
              const src = mediaPath(frame.framePath);
              const content = (
                <>
                  {src && <img src={src} alt="" loading="lazy" decoding="async" />}
                  <div>
                    <strong>{Math.round(frame.confidence * 100)}%{typeof frame.at === "number" ? ` · ${formatDuration(frame.at)}` : ""}</strong>
                    <OcrRoleSummary boxes={frame.boxes ?? []} fallback={frame.tokens} />
                  </div>
                </>
              );
              return typeof frame.at === "number" ? (
                <button
                  key={frame.framePath || frame.tokens.join("-")}
                  type="button"
                  className="ocr-frame-card"
                  aria-label={`Play OCR frame at ${formatDuration(frame.at)}`}
                  onClick={() => openAssetMoment(asset, onOpenMoment, { at: frame.at ?? 0, end: (frame.at ?? 0) + 2, label: "OCR frame" })}
                >
                  {content}
                </button>
              ) : (
                <article key={frame.framePath || frame.tokens.join("-")} className="ocr-frame-card">
                  {content}
                </article>
              );
            })}
            <PreviewLimitNotice total={frames.length} visible={visibleFrames.length} label="OCR frames" />
            {frames.length === 0 && <span>No OCR frames are stored.</span>}
          </div>
        </div>
      }
      rawDetails={rawStepDetails(step)}
    />
  );
}

function isScoreboardLikeToken(token: string) {
  const normalized = token.trim();
  if (!normalized) return false;
  return /\b\d{1,2}:\d{2}\b/.test(normalized) || /\b\d{1,3}\s*[-:]\s*\d{1,3}\b/.test(normalized) || /\b(Q[1-4]|1ST|2ND|3RD|4TH|OT|HT|FT)\b/i.test(normalized);
}

function VisualResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  if (step.id === "visual") return <VisualProfileResult asset={asset} step={step} />;
  const usableKeyframes = asset.keyframes.filter((keyframe) => keyframe.path && keyframe.segmentId).length;
  const visualTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("visual-embedding:") || trace.startsWith("visual-embedding-unavailable:"));
  const visualVectorState = visualTrace?.startsWith("visual-embedding:") ? `${usableKeyframes} ready` : visualTrace ? "unavailable" : usableKeyframes === 0 ? "no keyframes" : "pending";
  const detectorTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("vision-detector:") || trace.startsWith("vision-detector-unavailable:"));
  const trackerTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("vision-tracker:") || trace.startsWith("vision-tracker-unavailable:"));
  const visionSegments = asset.timeline.filter((segment) => segment.sceneData?.vision).length;
  const domainEvents = asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
  const visualAssessable = asset.intelligence.visual.available !== false && (usableKeyframes > 0 || asset.intelligence.visual.labels.length > 0 || asset.intelligence.visual.dominantColor !== "#000000");
  const blankCandidate = visualAssessable && asset.intelligence.visual.brightness < 0.04;
  const lowFrameChangeCandidate = visualAssessable && asset.intelligence.visual.motionScore < 0.01;
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Keyframes", value: asset.keyframes.length.toString(), tone: metricTone(asset.keyframes.length > 0, true) },
        { label: "Usable keyframes", value: `${usableKeyframes}/${asset.keyframes.length}`, tone: metricTone(usableKeyframes > 0, true) },
        { label: "Visual vectors", value: visualVectorState, tone: visualTrace?.startsWith("visual-embedding:") ? "good" : visualTrace || usableKeyframes === 0 ? "warning" : "neutral" },
        { label: "Detector input", value: `${usableKeyframes} frames`, tone: usableKeyframes > 0 ? "good" : "warning" },
        { label: "Vision segments", value: visionSegments.toString(), tone: visionSegments > 0 ? "good" : "neutral" },
        { label: "Domain support", value: `${domainEvents} events`, tone: domainEvents > 0 ? "good" : "neutral" }
      ]}
      usedBy={["timeline thumbnails", "visual vector search", "detector/tracker input", "domain event confidence"]}
      quality={[
        { label: "Sampler", value: asset.intelligence.visual.available === false ? "unavailable" : "available", tone: asset.intelligence.visual.available === false ? "warning" : "good" },
        { label: "Blank candidates", value: !visualAssessable ? "not assessed" : blankCandidate ? "possible" : "not flagged", tone: !visualAssessable ? "neutral" : blankCandidate ? "warning" : "good" },
        { label: "Low frame-change candidates", value: !visualAssessable ? "not assessed" : lowFrameChangeCandidate ? "possible" : "not flagged", tone: !visualAssessable ? "neutral" : lowFrameChangeCandidate ? "warning" : "good" },
        { label: "Detector readiness", value: detectorTrace?.startsWith("vision-detector:") ? "done" : "pending/optional", tone: detectorTrace?.startsWith("vision-detector:") ? "good" : "neutral" }
      ]}
      inspect={
        <div className="workflow-result-stack">
          <div className="workflow-usage-grid">
            <VisualUsageCard
              title="Timeline preview"
              value={`${asset.keyframes.length} keyframes`}
              detail="Used as thumbnails in timeline, search results, and workflow review."
            />
            <VisualUsageCard
              title="Visual vector search"
              value={visualVectorState}
              detail={visualTrace ?? "Keyframes become image embeddings when the visual embedding stage runs."}
            />
            <VisualUsageCard
              title="Detector and tracker input"
              value={`${usableKeyframes} frames`}
              detail={[detectorTrace ?? "detector pending", trackerTrace ?? "tracker pending"].join(" · ")}
            />
            <VisualUsageCard
              title="Domain confidence support"
              value={`${visionSegments} vision segments · ${domainEvents} events`}
              detail="Detector, tracker, VLM, and low-weight coarse profile cues support related knowledge event confidence."
            />
          </div>
          <details className="workflow-raw-details">
            <summary>Technical details</summary>
            <div className="workflow-technical-strip" aria-label="Raw visual sampler summary">
              <span><b>Sampler</b>{asset.intelligence.visual.available === false ? "unavailable" : "available"}</span>
              <span><b>Dominant color</b>{asset.intelligence.visual.dominantColor}</span>
              <span><b>Brightness</b>{asset.intelligence.visual.brightness.toFixed(2)}</span>
              <span><b>Frame change</b>{asset.intelligence.visual.motionScore.toFixed(2)}</span>
            </div>
          </details>
          <div className="workflow-keyframe-grid">
            {asset.keyframes.slice(0, 12).map((keyframe) => {
              const src = mediaPath(keyframe.path);
              return (
                <button
                  key={keyframe.id}
                  type="button"
                  aria-label={`Play keyframe at ${formatDuration(keyframe.at)}`}
                  onClick={() => openAssetMoment(asset, onOpenMoment, { at: keyframe.at, end: keyframe.at + 2, label: "Keyframe", segmentId: keyframe.segmentId })}
                >
                  {src ? <img src={src} alt="" /> : <i>No image</i>}
                  <b>{formatDuration(keyframe.at)}</b>
                </button>
              );
            })}
            {asset.keyframes.length === 0 && <span>No keyframes are stored.</span>}
          </div>
        </div>
      }
      rawDetails={rawStepDetails(step, [asset.intelligence.visual.error ? `visual-error:${asset.intelligence.visual.error}` : ""])}
    />
  );
}

function VisualProfileResult({ asset, step }: { asset: AssetRecord; step: FlowStep }) {
  const visual = asset.intelligence.visual;
  const visualAssessable = visual.available !== false && (visual.labels.length > 0 || visual.dominantColor !== "#000000");
  const blankCandidate = visualAssessable && visual.brightness < 0.04;
  const lowFrameChangeCandidate = visualAssessable && visual.motionScore < 0.01;
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Profile", value: visual.available === false ? "unavailable" : visualAssessable ? "stored" : "pending", tone: visual.available === false ? "warning" : visualAssessable ? "good" : "neutral" },
        { label: "Labels", value: visual.labels.length.toString(), tone: visual.labels.length > 0 ? "good" : "neutral" },
        { label: "Average color", value: visual.dominantColor, tone: visual.dominantColor !== "#000000" ? "good" : "neutral" },
        { label: "Frame change", value: visual.motionScore.toFixed(2), tone: visualAssessable ? "neutral" : "warning" }
      ]}
      usedBy={["media sanity checks", "coarse timeline tags", "low-confidence visual hints"]}
      quality={[
        { label: "Sampler", value: visual.available === false ? "unavailable" : "available", tone: visual.available === false ? "warning" : "good" },
        { label: "Blank candidates", value: !visualAssessable ? "not assessed" : blankCandidate ? "possible" : "not flagged", tone: !visualAssessable ? "neutral" : blankCandidate ? "warning" : "good" },
        { label: "Low frame-change candidates", value: !visualAssessable ? "not assessed" : lowFrameChangeCandidate ? "possible" : "not flagged", tone: !visualAssessable ? "neutral" : lowFrameChangeCandidate ? "warning" : "good" },
        { label: "Evidence tier", value: "heuristic", tone: "neutral" }
      ]}
      inspect={
        <div className="workflow-result-stack">
          <div className="workflow-technical-strip" aria-label="Raw coarse visual profile summary">
            <span><b>Sampler</b>{visual.available === false ? "unavailable" : "available"}</span>
            <span><b>Average color</b>{visual.dominantColor}</span>
            <span><b>Brightness</b>{visual.brightness.toFixed(2)}</span>
            <span><b>Frame change</b>{visual.motionScore.toFixed(2)}</span>
          </div>
          <p className="workflow-muted-note">
            Coarse visual profile is not detector, tracker, VLM, or calibrated field evidence.
          </p>
        </div>
      }
      rawDetails={rawStepDetails(step, [visual.error ? `visual-error:${visual.error}` : ""])}
    />
  );
}

function VisualUsageCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <article className="workflow-usage-card">
      <b>{title}</b>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function VideoVlmResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  const vlmSegments = asset.timeline.filter((segment) => segment.sceneData?.vlm);
  const describedCount = vlmSegments.filter((segment) => segment.sceneData?.vlm?.status === "described").length;
  const invalidCount = vlmSegments.filter((segment) => segment.sceneData?.vlm?.status === "invalid").length;
  const failedCount = vlmSegments.filter((segment) => segment.sceneData?.vlm?.status === "failed").length;
  const skippedCount = vlmSegments.filter((segment) => segment.sceneData?.vlm?.status === "skipped").length;
  const averageConfidence = averageNumber(vlmSegments.map((segment) => segment.sceneData?.vlm?.confidence ?? 0).filter((value) => value > 0));
  const topLabels = topCounts(vlmSegments.flatMap((segment) => segment.sceneData?.vlm?.labels ?? [])).slice(0, 4);
  const topObjects = topCounts(vlmSegments.flatMap((segment) => segment.sceneData?.vlm?.objects ?? [])).slice(0, 4);
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Described", value: describedCount.toString(), tone: describedCount > 0 ? "good" : "neutral" },
        { label: "Invalid", value: invalidCount.toString(), tone: invalidCount > 0 ? "warning" : "neutral" },
        { label: "Failed", value: failedCount.toString(), tone: failedCount > 0 ? "bad" : "neutral" },
        { label: "Skipped", value: skippedCount.toString(), tone: skippedCount > 0 ? "warning" : "neutral" },
        { label: "Attempted", value: vlmSegments.length.toString(), tone: "neutral" }
      ]}
      usedBy={["scene caption search", "semantic timeline evidence", "analysis grounding", "domain-independent video understanding"]}
      quality={[
        { label: "Confidence", value: averageConfidence === null ? "unknown" : `${Math.round(averageConfidence * 100)}% avg`, tone: averageConfidence !== null && averageConfidence >= 0.55 ? "good" : "warning" },
        { label: "Top labels", value: topLabels.length ? topLabels.map(([label, count]) => `${label} ${count}`).join(" · ") : "none", tone: topLabels.length ? "good" : "neutral" },
        { label: "Top objects", value: topObjects.length ? topObjects.map(([label, count]) => `${label} ${count}`).join(" · ") : "none", tone: topObjects.length ? "good" : "neutral" }
      ]}
      inspect={
        <div className="workflow-result-list">
          {vlmSegments.slice(0, 12).map((segment) => {
            const vlm = segment.sceneData?.vlm;
            const imagePath = segment.thumbnailPath ?? segment.sceneData?.image.thumbnailPath ?? segment.sceneData?.image.framePath ?? null;
            const src = imagePath ? mediaPath(imagePath) : null;
            const detail = [
              vlm?.status,
              vlm?.model,
              vlm ? `${Math.round(vlm.confidence * 100)}%` : "",
              vlm?.sceneType ? `scene: ${vlm.sceneType}` : "",
              vlm?.actions.length ? `actions: ${vlm.actions.slice(0, 3).join(", ")}` : "",
              vlm?.objects.length ? `objects: ${vlm.objects.slice(0, 3).join(", ")}` : ""
            ].filter(Boolean).join(" · ");
            return (
              <button
                key={`${segment.id}-video-vlm`}
                type="button"
                aria-label={`Play VLM segment at ${formatDuration(segment.start)}`}
                onClick={() => openAssetMoment(asset, onOpenMoment, { at: segment.start, end: segment.end, label: vlm?.caption || "Video VLM segment", segmentId: segment.id })}
              >
                {src ? <img src={src} alt="" /> : <i className="timeline-thumbnail-placeholder">No image</i>}
                <div>
                  <strong>{vlm?.caption || vlm?.error || "No VLM caption stored"}</strong>
                  <span>{formatDuration(segment.start)}-{formatDuration(segment.end)} · {detail}</span>
                  {vlm?.visibleText.length ? <span>Visible text: {vlm.visibleText.slice(0, 3).join(" · ")}</span> : null}
                </div>
              </button>
            );
          })}
          {vlmSegments.length === 0 && <EmptyState text="No video VLM scene analysis is stored." />}
        </div>
      }
      rawDetails={rawStepDetails(step, vlmSegments.flatMap((segment) => segment.sceneData?.vlm?.rawResponse ? [`video-vlm:${truncateText(segment.sceneData.vlm.rawResponse, 360)}`] : []))}
    />
  );
}

function TimelineResult({ asset, step, onOpenMoment }: { asset: AssetRecord; step: FlowStep; onOpenMoment?: OpenMomentHandler }) {
  const sceneDataCount = asset.timeline.filter((segment) => segment.sceneData).length;
  const thumbnailCount = asset.timeline.filter((segment) => segment.thumbnailPath).length;
  const averageDuration = asset.timeline.length > 0 ? asset.timeline.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0) / asset.timeline.length : 0;
  const allComparisons = asset.timeline.flatMap((segment) => getSearchSceneData(segment, "").text.comparisons ?? []);
  const duplicateComparisonCount = Math.max(0, allComparisons.length - dedupeTextComparisons(allComparisons).length);
  const shortSegments = asset.timeline.filter((segment) => segment.end - segment.start < 0.5).length;
  const longSegments = asset.timeline.filter((segment) => segment.end - segment.start > 45).length;
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Moments", value: asset.timeline.length.toString(), tone: metricTone(asset.timeline.length > 0, true) },
        { label: "Avg duration", value: averageDuration > 0 ? formatDuration(averageDuration) : "Unknown", tone: averageDuration >= 0.5 && averageDuration <= 45 ? "good" : averageDuration > 0 ? "warning" : "neutral" },
        { label: "Scene data", value: `${sceneDataCount}/${asset.timeline.length}`, tone: sceneDataCount > 0 ? "good" : "warning" },
        { label: "Thumbnails", value: `${thumbnailCount}/${asset.timeline.length}`, tone: thumbnailCount > 0 ? "good" : "warning" }
      ]}
      usedBy={["moment retrieval", "search result clips", "video player seek points", "domain event windows"]}
      quality={[
        { label: "Short segments", value: shortSegments.toString(), tone: shortSegments > 0 ? "warning" : "good" },
        { label: "Long segments", value: longSegments.toString(), tone: longSegments > 0 ? "warning" : "good" },
        { label: "Thumbnail coverage", value: formatCoverage(thumbnailCount, asset.timeline.length), tone: thumbnailCount === asset.timeline.length && asset.timeline.length > 0 ? "good" : "warning" },
        { label: "Duplicate ASR/OCR", value: duplicateComparisonCount.toString(), tone: duplicateComparisonCount > 0 ? "warning" : "good" }
      ]}
      inspect={
        <div className="workflow-result-list">
          {asset.timeline.slice(0, 10).map((segment) => (
            <button
              key={segment.id}
              type="button"
              aria-label={`Play timeline moment at ${formatDuration(segment.start)} for ${segment.label}`}
              onClick={() => onOpenMoment?.(segment)}
            >
              <TimelineThumbnail path={segment.thumbnailPath} />
              <div>
                <strong>{segment.label}</strong>
                <span>{formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.sources.join(", ")}</span>
                <SceneDataSummary segment={segment} />
              </div>
            </button>
          ))}
          {asset.timeline.length === 0 && <EmptyState text="No timeline moments are stored." />}
        </div>
      }
      rawDetails={rawStepDetails(step)}
    />
  );
}

function ModelTraceResult({ asset, index, step }: { asset: AssetRecord; index: IndexRecord | null; step: FlowStep }) {
  const stepId = step.id;
  const prefixes =
    stepId === "detector"
      ? ["vision-detector:"]
      : stepId === "tracker"
        ? ["vision-tracker:"]
        : ["knowledge-action:", "soccernet-action:"];
  const unavailablePrefixes = prefixes.map((prefix) => prefix.replace(":", "-unavailable:"));
  const traces = asset.intelligence.modelTrace.filter((trace) => [...prefixes, ...unavailablePrefixes].some((prefix) => trace.startsWith(prefix)));
  const visionSegments = asset.timeline.filter((segment) => segment.sceneData?.vision);
  const playerDetected = visionSegments.filter((segment) => {
    const status = segment.sceneData?.vision?.objects.players.status;
    return status === "detected" || status === "estimated";
  }).length;
  const ballDetected = visionSegments.filter((segment) => {
    const status = segment.sceneData?.vision?.objects.ball.status;
    return status === "detected" || status === "estimated";
  }).length;
  const trackingSegments = visionSegments.filter((segment) => {
    const status = segment.sceneData?.vision?.tracking?.status;
    return status === "tracked" || status === "estimated";
  }).length;
  const averageTrackCoverage = averageNumber(visionSegments.map((segment) => segment.sceneData?.vision?.tracking?.trackCoverage ?? null).filter((value): value is number => typeof value === "number"));
  const calibratedFields = visionSegments.filter((segment) => segment.sceneData?.vision?.fieldCalibration?.status === "calibrated").length;
  const template = stepId === "knowledgeAction" ? knowledgeTemplateForIndex(index) : null;
  const templateProduced: NodeMetric[] = template
    ? [
        { label: "Base", value: sportsBaseTemplateContract.version, tone: "neutral" },
        { label: "Template", value: template.manifest.version, tone: "good" },
        { label: "Generator", value: template.generator.kind, tone: "good" },
        { label: "Schema fields", value: template.manifest.outputSchema.length.toString(), tone: "neutral" },
        { label: "Benchmarks", value: template.evaluator.benchmarkCoverage.length.toString(), tone: "neutral" }
      ]
    : [];
  const templateQuality: NodeMetric[] = template
    ? [
        { label: "Runtime gates", value: template.manifest.runtimeGates.length.toString(), tone: "neutral" },
        { label: "Skip conditions", value: template.manifest.skipConditions.length.toString(), tone: "neutral" },
        { label: "Validation gates", value: template.evaluator.validationGates.length.toString(), tone: "neutral" }
      ]
    : [];
  return (
    <WorkflowNodeDetails
      produced={[
        ...templateProduced,
        { label: "Stored traces", value: traces.length.toString(), tone: traces.length > 0 ? "good" : "warning" },
        { label: "Vision segments", value: visionSegments.length.toString(), tone: visionSegments.length > 0 ? "good" : "warning" },
        { label: "Players", value: formatCoverage(playerDetected, visionSegments.length), tone: playerDetected > 0 ? "good" : "warning" },
        { label: "Ball", value: formatCoverage(ballDetected, visionSegments.length), tone: ballDetected > 0 ? "good" : "warning" },
        { label: "Tracking", value: averageTrackCoverage === null ? formatCoverage(trackingSegments, visionSegments.length) : `${Math.round(averageTrackCoverage * 100)}% avg`, tone: trackingSegments > 0 ? "good" : "warning" },
        { label: "Field calibration", value: calibratedFields > 0 ? `${calibratedFields} calibrated` : "estimated/not configured", tone: calibratedFields > 0 ? "good" : "neutral" }
      ]}
      usedBy={stepId === "knowledgeAction" ? ["adapter action labels", "domain events", "search filters"] : ["domain events", "receiver/passer inference", "pressure/pocket judgment", "visual verification"]}
      quality={[
        { label: "Trace", value: traces.length > 0 ? "stored" : "missing", tone: traces.length > 0 ? "good" : "warning" },
        ...templateQuality,
        { label: "Player evidence", value: playerDetected > 0 ? "available" : "not detected", tone: playerDetected > 0 ? "good" : "warning" },
        { label: "Ball evidence", value: ballDetected > 0 ? "available" : "not detected", tone: ballDetected > 0 ? "good" : "warning" },
        { label: "Search impact", value: stepId === "tracker" ? "motion/domain evidence" : stepId === "detector" ? "object/domain evidence" : "action spotting", tone: "neutral" }
      ]}
      inspect={
        template ? (
          <KnowledgeActionWorkflowInspect template={template} traces={traces} visionSegments={visionSegments} />
        ) : (
          <VisionWorkflowInspect stepId={stepId} visionSegments={visionSegments} />
        )
      }
      rawDetails={rawStepDetails(step, traces)}
    />
  );
}

function knowledgeTemplateForIndex(index: IndexRecord | null) {
  const sourceId = index?.domainIndexing?.groups.find((group) => knowledgeTemplateDescriptors[group]);
  return sourceId ? knowledgeTemplateDescriptors[sourceId] ?? null : null;
}

function KnowledgeActionWorkflowInspect({
  template,
  traces,
  visionSegments
}: {
  template: KnowledgeTemplateDescriptor;
  traces: string[];
  visionSegments: AssetRecord["timeline"];
}) {
  const action = template.generator.actionSpotting;
  return (
    <div className="workflow-result-stack">
      <div className="workflow-usage-grid">
        <VisualUsageCard
          title="Sports base"
          value={template.strategy.baseTemplateId}
          detail={`${template.strategy.sharedRules.length} shared rules · ${template.strategy.strategyId}`}
        />
        <VisualUsageCard
          title="Manifest"
          value={template.manifest.version}
          detail={`${template.manifest.providerContracts.length} providers · ${template.manifest.requiredEvidence.length} evidence contracts · ${template.manifest.outputSchema.length} output fields`}
        />
        <VisualUsageCard
          title="Generator"
          value={template.generator.kind}
          detail={`${template.generator.adapter} · ${template.generator.outputVersion}`}
        />
        <VisualUsageCard
          title="Evaluator"
          value={`${template.evaluator.benchmarkCoverage.length} coverage items`}
          detail={template.evaluator.benchmarkCoverage.map((coverage) => `${coverage.name}: ${coverage.status}`).join(" · ")}
        />
        <VisualUsageCard
          title="Runtime source"
          value={traces.length > 0 ? "trace stored" : "trace missing"}
          detail={traces[0] ?? template.generator.timing}
        />
      </div>
      <div className="workflow-technical-strip" aria-label="Knowledge action template rules">
        <span><b>Min confidence</b>{action.minCandidateConfidence}</span>
        <span><b>Alignment score</b>{action.alignment.minScore}</span>
        <span><b>Strong score</b>{action.alignment.minStrongScore}</span>
        <span><b>Provider context</b>{action.alignment.requireProviderContext ? "required" : "not required"}</span>
      </div>
      <details className="workflow-raw-details">
        <summary>Template manifest and evaluator contract</summary>
        <div>
          <code>Manifest: {template.manifest.summary}</code>
          <code>Base rules: {template.strategy.sharedRules.join(" · ")}</code>
          <code>Specialization: {template.strategy.specializationRules.join(" · ")}</code>
          <code>Consumes: {template.generator.consumes.join(" · ")}</code>
          <code>Skip conditions: {template.manifest.skipConditions.join(" · ")}</code>
          <code>Validation gates: {template.evaluator.validationGates.join(" · ")}</code>
        </div>
      </details>
      <VisionWorkflowInspect stepId="knowledgeAction" visionSegments={visionSegments} />
    </div>
  );
}

function VisionWorkflowInspect({ stepId, visionSegments }: { stepId: string; visionSegments: AssetRecord["timeline"] }) {
  return (
    <div className="workflow-result-list">
      {visionSegments.slice(0, 8).map((segment) => (
        <article key={`${stepId}-${segment.id}`}>
          <TimelineThumbnail path={segment.thumbnailPath} />
          <div>
            <strong>{segment.label}</strong>
            <span>{formatDuration(segment.start)}-{formatDuration(segment.end)}</span>
            <SceneDataSummary segment={segment} />
          </div>
        </article>
      ))}
      {visionSegments.length === 0 && <EmptyState text="No vision-backed timeline segments are stored." />}
    </div>
  );
}

function averageNumber(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function RawMatchProfileResult({ asset, step }: { asset: AssetRecord; step: FlowStep }) {
  const profile = asset.rawMatchProfile;
  if (!profile) {
    return (
      <WorkflowNodeDetails
        produced={[
          { label: "Profile", value: qualityLabelForStep(step), tone: step.state === "error" ? "bad" : step.state === "skipped" ? "warning" : "neutral" },
          { label: "Source context", value: "unknown", tone: "neutral" },
          { label: "Tracking readiness", value: "pending", tone: "neutral" }
        ]}
        usedBy={["workflow review", "identity review", "event confidence calibration", "raw recording QA"]}
        quality={[
          { label: "Metadata", value: "not stored", tone: step.state === "skipped" ? "warning" : "neutral" },
          { label: "Search impact", value: "profile unavailable", tone: "neutral" }
        ]}
        inspect={<EmptyState text="No raw match profile metadata is stored for this asset." />}
        rawDetails={rawStepDetails(step)}
      />
    );
  }

  const trustItems = Object.entries(profile.trustSummary)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const teamClusters = profile.observed.teamKitClusters.slice(0, 6);
  const eventTypes = profile.eventReadiness.eventTypes.slice(0, 8);
  const limitations = profile.limitations.slice(0, 8);

  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Profile", value: profile.status, tone: profile.status === "ready" ? "good" : profile.status === "partial" ? "warning" : "neutral" },
        { label: "Source context", value: profile.sourceContext.status, tone: profile.sourceContext.status === "confirmed" ? "good" : profile.sourceContext.status === "partial" ? "warning" : "neutral" },
        { label: "Pitch", value: profile.observed.pitchVisible ? `${formatPercent(profile.observed.pitchConfidence)} visible` : "not confirmed", tone: profile.observed.pitchVisible ? "good" : "warning" },
        { label: "Team clusters", value: profile.observed.teamKitClusters.length.toString(), tone: profile.observed.teamKitClusters.length > 0 ? "good" : "neutral" },
        { label: "Clock candidates", value: profile.observed.clockCandidates.length.toString(), tone: profile.observed.clockCandidates.length > 0 ? "good" : "neutral" },
        { label: "Event types", value: profile.eventReadiness.eventTypes.length.toString(), tone: profile.eventReadiness.eventTypes.length > 0 ? "good" : "neutral" }
      ]}
      usedBy={["workflow review", "identity review", "event confidence calibration", "raw recording QA"]}
      quality={[
        { label: "Player coverage", value: formatPercent(profile.trackingReadiness.playerCoverage), tone: readinessTone(profile.trackingReadiness.playerCoverage, 0.18) },
        { label: "Ball coverage", value: formatPercent(profile.trackingReadiness.ballCoverage), tone: readinessTone(profile.trackingReadiness.ballCoverage, 0.12) },
        { label: "Track coverage", value: formatPercent(profile.trackingReadiness.averageTrackCoverage), tone: readinessTone(profile.trackingReadiness.averageTrackCoverage, 0.12) },
        { label: "Event readiness", value: profile.trackingReadiness.usableForEvents ? "usable" : "limited", tone: profile.trackingReadiness.usableForEvents ? "good" : "warning" },
        { label: "Identity readiness", value: profile.trackingReadiness.usableForIdentity ? "usable" : "candidate-only", tone: profile.trackingReadiness.usableForIdentity ? "good" : "warning" },
        { label: "Roster required", value: profile.identityReadiness.rosterRequired ? "yes" : "no", tone: profile.identityReadiness.rosterRequired ? "warning" : "good" }
      ]}
      inspect={
        <div className="workflow-result-stack">
          <div className="workflow-usage-grid">
            <VisualUsageCard
              title="Technical"
              value={profile.technical.resolution ?? "Unknown"}
              detail={`${profile.technical.fps ? `${Math.round(profile.technical.fps)}fps` : "fps unknown"} · ${profile.technical.videoCodec ?? "video codec unknown"}`}
            />
            <VisualUsageCard
              title="Source"
              value={summarizeSourceContext(profile)}
              detail={profile.sourceContext.evidence.slice(0, 3).join(" · ") || "No confirmed external context evidence"}
            />
            <VisualUsageCard
              title="Identity"
              value={`${profile.identityReadiness.candidateCount} candidates`}
              detail={[
                profile.identityReadiness.jerseyOcrUsable ? "jersey OCR usable" : "no jersey OCR",
                profile.identityReadiness.faceUsable ? "face candidates usable" : "no face candidates",
                `${profile.identityReadiness.confirmedAssignmentCount} confirmed`
              ].join(" · ")}
            />
            <VisualUsageCard
              title="Events"
              value={`${profile.eventReadiness.candidateCount} candidates`}
              detail={`${profile.eventReadiness.domainEventCount} domain events · ${profile.eventReadiness.eventTypes.length} event types`}
            />
          </div>
          <div className="workflow-technical-strip" aria-label="Raw match profile readiness">
            <span><b>Players</b>{formatPercent(profile.trackingReadiness.playerCoverage)}</span>
            <span><b>Ball</b>{formatPercent(profile.trackingReadiness.ballCoverage)}</span>
            <span><b>Track avg</b>{formatPercent(profile.trackingReadiness.averageTrackCoverage)}</span>
            <span><b>ID switches</b>{profile.trackingReadiness.idSwitches}</span>
            <span><b>Trust</b>{trustItems.map(([tier, count]) => `${tier} ${count}`).join(" · ") || "none"}</span>
          </div>
          <div className="domain-event-list">
            {teamClusters.map((cluster) => (
              <article key={cluster.cluster} className="domain-event-row">
                <div>
                  <strong>{cluster.cluster}</strong>
                  <span>{cluster.trackCount} tracks · {cluster.segmentCount} segments · {formatPercent(cluster.confidence)}</span>
                </div>
                <span>{cluster.colors.join(" · ") || "No kit color samples"}{cluster.evidence.length ? ` · ${cluster.evidence.slice(0, 3).join(" · ")}` : ""}</span>
              </article>
            ))}
            {eventTypes.map((event) => (
              <article key={event.type} className="domain-event-row">
                <div>
                  <strong>{event.type}</strong>
                  <span>{event.count} candidates · {formatPercent(event.confidence)} · {event.trust}</span>
                </div>
              </article>
            ))}
            {limitations.map((limitation) => (
              <article key={limitation} className="domain-event-row">
                <div>
                  <strong>Limitation</strong>
                  <span>{limitation}</span>
                </div>
              </article>
            ))}
            {teamClusters.length + eventTypes.length + limitations.length === 0 && <span className="empty-inline">No raw match profile details are stored.</span>}
          </div>
        </div>
      }
      rawDetails={rawStepDetails(step, [
        `raw-match-profile:${profile.generatedBy}:${profile.status}`,
        `source-context:${profile.sourceContext.status}`,
        profile.technical.qualityFlags.length ? `quality-flags:${profile.technical.qualityFlags.join(",")}` : "",
        `updated:${profile.updatedAt}`
      ])}
    />
  );
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function readinessTone(value: number, threshold: number): NodeMetricTone {
  if (value >= threshold) return "good";
  if (value > 0) return "warning";
  return "neutral";
}

function summarizeSourceContext(profile: NonNullable<AssetRecord["rawMatchProfile"]>) {
  if (profile.sourceContext.teams.length > 0) return profile.sourceContext.teams.slice(0, 2).join(" vs ");
  if (profile.sourceContext.competitions.length > 0) return profile.sourceContext.competitions[0] ?? "competition candidate";
  if (profile.sourceContext.matchContextIds.length > 0) return `${profile.sourceContext.matchContextIds.length} context candidates`;
  return profile.sourceContext.status;
}

function DomainResult({
  asset,
  step,
  onOpenMoment,
  onReviewIdentity
}: {
  asset: AssetRecord;
  step: FlowStep;
  onOpenMoment?: OpenMomentHandler;
  onReviewIdentity?: IdentityReviewHandler;
}) {
  const domainEvents = asset.timeline.flatMap((segment) =>
    (segment.domain?.events ?? []).map((event) => ({
      segment,
      event
    }))
  );
  const vlmSegments = asset.timeline.filter((segment) => segment.domain?.vlm);
  const refinedCount = vlmSegments.filter((segment) => segment.domain?.vlm?.status === "refined").length;
  const invalidCount = vlmSegments.filter((segment) => segment.domain?.vlm?.status === "invalid").length;
  const failedCount = vlmSegments.filter((segment) => segment.domain?.vlm?.status === "failed").length;
  const skippedCount = vlmSegments.filter((segment) => segment.domain?.vlm?.status === "skipped").length;
  const topTypes = topCounts(domainEvents.map(({ event }) => event.eventType)).slice(0, 3);
  const identityCount = domainEvents.filter(({ event }) =>
    Boolean(event.football?.receivingPlayer.identity || event.football?.passingPlayer.identity || event.americanFootball?.quarterback.identity)
  ).length;
  const matchContextCount = asset.identity?.matchContexts.length ?? asset.timeline.filter((segment) => (segment.identity?.matchContextIds.length ?? 0) > 0).length;
  const trackAssignmentCount = asset.identity?.trackIdentityAssignments.length ?? asset.timeline.reduce((sum, segment) => sum + (segment.identity?.trackIdentityAssignments.length ?? 0), 0);
  const teamClusterAssignmentCount = asset.identity?.teamClusterAssignments?.length ?? asset.timeline.reduce((sum, segment) => sum + (segment.identity?.teamClusterAssignments?.length ?? 0), 0);
  const clockMappingCount = asset.identity?.matchContexts.reduce((sum, context) => sum + context.clockMappings.length, 0) ?? asset.timeline.reduce((sum, segment) => sum + (segment.identity?.clockMappings.length ?? 0), 0);
  const averageConfidence = averageNumber(domainEvents.map(({ event }) => event.confidence));
  const identityReviewItems = asset.timeline
    .flatMap((segment) =>
      (segment.identity?.playerIdentityCandidates ?? []).map((candidate) => ({
        segment,
        candidate,
        teamCluster: (segment.identity?.teamClusterAssignments ?? []).find(
          (assignment) => assignment.matchContextId === candidate.matchContextId && assignment.team === candidate.team && assignment.videoRange.start === candidate.videoRange.start
        )
      }))
    )
    .filter(({ candidate }) => candidate.status !== "confirmed" || candidate.confidence < 0.82)
    .sort((a, b) => a.candidate.confidence - b.candidate.confidence)
    .slice(0, 10);
  const isVlmNode = step.id === "domainVlm";
  return (
    <WorkflowNodeDetails
      produced={isVlmNode
        ? [
            { label: "Refined", value: refinedCount.toString(), tone: refinedCount > 0 ? "good" : "neutral" },
            { label: "Skipped", value: skippedCount.toString(), tone: skippedCount > 0 ? "warning" : "neutral" },
            { label: "Failed", value: failedCount.toString(), tone: failedCount > 0 ? "bad" : "neutral" },
            { label: "Invalid", value: invalidCount.toString(), tone: invalidCount > 0 ? "warning" : "neutral" },
            { label: "Attempted", value: vlmSegments.length.toString(), tone: "neutral" }
          ]
        : [
            { label: "Events", value: domainEvents.length.toString(), tone: domainEvents.length > 0 ? "good" : "warning" },
            { label: "Top event types", value: topTypes.length ? topTypes.map(([type, count]) => `${type} ${count}`).join(" · ") : "None", tone: topTypes.length ? "good" : "warning" },
            { label: "Identity resolved", value: `${identityCount}/${domainEvents.length}`, tone: identityCount > 0 ? "good" : "neutral" },
            { label: "Match contexts", value: matchContextCount.toString(), tone: matchContextCount > 0 ? "good" : "neutral" },
            { label: "Track identities", value: trackAssignmentCount.toString(), tone: trackAssignmentCount > 0 ? "good" : "neutral" },
            { label: "Team clusters", value: teamClusterAssignmentCount.toString(), tone: teamClusterAssignmentCount > 0 ? "good" : "neutral" },
            { label: "Avg confidence", value: averageConfidence === null ? "Unknown" : `${Math.round(averageConfidence * 100)}%`, tone: averageConfidence !== null && averageConfidence >= 0.55 ? "good" : "warning" },
            { label: "Knowledge VLM checks", value: vlmSegments.length.toString(), tone: vlmSegments.length > 0 ? "good" : "neutral" }
          ]}
      usedBy={isVlmNode ? ["knowledge event refinement", "evidence review", "confidence calibration"] : ["knowledge-aware search", "stat-seeded retrieval", "play-style analysis", "structured filters"]}
      quality={isVlmNode
        ? [
            { label: "Optional stage", value: "not required for base search", tone: "neutral" },
            { label: "Refinement", value: refinedCount > 0 ? "available" : "not applied", tone: refinedCount > 0 ? "good" : "neutral" },
            { label: "Failures", value: failedCount > 0 ? `${failedCount} failed` : "none stored", tone: failedCount > 0 ? "bad" : "good" }
          ]
        : [
            { label: "Knowledge structure", value: domainEvents.length > 0 ? "searchable" : "missing", tone: domainEvents.length > 0 ? "good" : "warning" },
            { label: "Player identity", value: identityCount > 0 ? "resolved candidates" : "not resolved", tone: identityCount > 0 ? "good" : "neutral" },
            { label: "Match clock mappings", value: clockMappingCount > 0 ? `${clockMappingCount} mapped` : "not mapped", tone: clockMappingCount > 0 ? "good" : "neutral" },
            { label: "Confidence", value: averageConfidence === null ? "unknown" : `${Math.round(averageConfidence * 100)}% avg`, tone: averageConfidence !== null && averageConfidence >= 0.55 ? "good" : "warning" }
          ]}
      inspect={
        isVlmNode ? (
          <div className="domain-event-list">
            {vlmSegments.slice(0, 12).map((segment) => {
              const vlm = segment.domain?.vlm;
              return (
                <article key={`${segment.id}-domain-vlm`} className="domain-event-row">
                  <div>
                    <strong>{vlm?.message || vlm?.error || "Related knowledge VLM check"}</strong>
                    <button
                      type="button"
                      className="time-link"
                      aria-label={`Play related knowledge VLM check at ${formatDuration(segment.start)}`}
                      onClick={() => onOpenMoment?.(segment, { start: segment.start, end: segment.end, label: "Related knowledge VLM check" })}
                    >
                      {formatDuration(segment.start)}-{formatDuration(segment.end)} · {vlm?.status} · {vlm?.model} · {Math.round((vlm?.confidence ?? 0) * 100)}%
                    </button>
                  </div>
                  {vlm?.rawResponse && <span>Raw: {truncateText(vlm.rawResponse, 360)}</span>}
                </article>
              );
            })}
            {vlmSegments.length === 0 && <span className="empty-inline">No related knowledge VLM checks are stored.</span>}
          </div>
        ) : (
          <>
            <IdentityReviewQueue items={identityReviewItems} onOpenMoment={onOpenMoment} onReviewIdentity={onReviewIdentity} />
            <div className="domain-event-list">
              {domainEvents.slice(0, 12).map(({ segment, event }) => (
                <DomainEventRow key={event.id} segment={segment} event={event} onOpenMoment={onOpenMoment} />
              ))}
              {domainEvents.length === 0 && <span className="empty-inline">No domain event metadata was generated for this asset.</span>}
            </div>
          </>
        )
      }
      rawDetails={rawStepDetails(step, vlmSegments.flatMap((segment) => segment.domain?.vlm?.rawResponse ? [`vlm:${truncateText(segment.domain.vlm.rawResponse, 360)}`] : []))}
    />
  );
}

function IdentityReviewQueue({
  items,
  onOpenMoment,
  onReviewIdentity
}: {
  items: Array<{
    segment: AssetRecord["timeline"][number];
    candidate: NonNullable<AssetRecord["timeline"][number]["identity"]>["playerIdentityCandidates"][number];
    teamCluster?: NonNullable<NonNullable<AssetRecord["timeline"][number]["identity"]>["teamClusterAssignments"]>[number];
  }>;
  onOpenMoment?: OpenMomentHandler;
  onReviewIdentity?: IdentityReviewHandler;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  async function reviewCandidate(segment: AssetRecord["timeline"][number], candidate: NonNullable<AssetRecord["timeline"][number]["identity"]>["playerIdentityCandidates"][number], status: IdentityReviewPatchRequest["status"]) {
    if (!onReviewIdentity) return;
    const key = identityReviewKey(segment, candidate, status);
    setPendingKey(key);
    try {
      await onReviewIdentity({
        segmentId: segment.id,
        status,
        candidate: {
          trackId: candidate.trackId,
          playerId: candidate.playerId,
          canonicalName: candidate.canonicalName,
          matchContextId: candidate.matchContextId,
          videoRange: candidate.videoRange
        }
      });
    } finally {
      setPendingKey(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="domain-event-list">
        <article className="domain-event-row">
          <div>
            <strong>Identity review queue</strong>
            <span>No low-confidence identity candidates are stored for review.</span>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="domain-event-list">
      <article className="domain-event-row">
        <div>
          <strong>Identity review queue</strong>
          <span>{items.length} candidate{items.length === 1 ? "" : "s"} need evidence review before confirmation.</span>
        </div>
      </article>
      {items.map(({ segment, candidate, teamCluster }) => (
        <article key={identityReviewKey(segment, candidate)} className="domain-event-row">
          <div>
            <strong>{candidate.canonicalName ?? "Unknown player"}{candidate.team ? ` · ${candidate.team}` : ""}</strong>
            <button
              type="button"
              className="time-link"
              aria-label={`Play identity review candidate at ${formatDuration(segment.start)}`}
              onClick={() => onOpenMoment?.(segment, { start: segment.start, end: segment.end, label: candidate.canonicalName ?? "Identity review candidate" })}
            >
              {formatDuration(segment.start)}-{formatDuration(segment.end)} · {candidate.status} · {Math.round(candidate.confidence * 100)}%
            </button>
          </div>
          <div className="domain-structured-grid">
            <span><b>Track</b>{candidate.trackId ?? "no track"}</span>
            <span><b>Shirt</b>{candidate.shirtNumber ?? "unknown"}</span>
            <span><b>Kit cluster</b>{teamCluster ? `${teamCluster.cluster} -> ${teamCluster.team ?? "unknown"} · ${Math.round(teamCluster.confidence * 100)}%` : "not mapped"}</span>
          </div>
          {onReviewIdentity && (
            <div className="identity-review-actions">
              <button
                type="button"
                className="identity-review-confirm"
                disabled={candidate.status === "confirmed" || pendingKey !== null}
                onClick={() => void reviewCandidate(segment, candidate, "confirmed")}
              >
                <CheckCircle2 size={14} />
                Confirm
              </button>
              <button
                type="button"
                className="identity-review-reject"
                disabled={candidate.status === "rejected" || pendingKey !== null}
                onClick={() => void reviewCandidate(segment, candidate, "rejected")}
              >
                <XCircle size={14} />
                Reject
              </button>
            </div>
          )}
          <span>{candidate.evidence.slice(0, 4).map((item) => `${item.source}: ${item.value} (${Math.round(item.confidence * 100)}%)`).join(" · ") || "No candidate evidence stored."}</span>
        </article>
      ))}
    </div>
  );
}

function identityReviewKey(
  segment: AssetRecord["timeline"][number],
  candidate: NonNullable<AssetRecord["timeline"][number]["identity"]>["playerIdentityCandidates"][number],
  action = "view"
) {
  return [
    segment.id,
    candidate.trackId ?? "no-track",
    candidate.playerId ?? candidate.canonicalName ?? "unknown",
    candidate.matchContextId ?? "no-context",
    candidate.videoRange.start,
    candidate.videoRange.end,
    action
  ].join(":");
}

function DomainEventRow({
  segment,
  event,
  onOpenMoment
}: {
  segment: AssetRecord["timeline"][number];
  event: NonNullable<AssetRecord["timeline"][number]["domain"]>["events"][number];
  onOpenMoment?: OpenMomentHandler;
}) {
  return (
    <article className="domain-event-row">
      <div>
        <strong>{event.caption}</strong>
        <button
          type="button"
          className="time-link"
          aria-label={`Play domain event at ${formatDuration(segment.start)} for ${event.caption}`}
          onClick={() => onOpenMoment?.(segment, { start: segment.start, end: segment.end, label: event.caption })}
        >
          {formatDuration(segment.start)}-{formatDuration(segment.end)} · {event.domain} · {Math.round(event.confidence * 100)}%
        </button>
      </div>
      <div className="domain-chip-row">
        {event.labels.slice(0, 8).map((label) => (
          <em key={`${event.id}-${label}`}>{label}</em>
        ))}
      </div>
      {event.football && (
        <div className="domain-structured-grid">
          {segment.domain?.scope?.competition && <span><b>Competition</b>{segment.domain.scope.competition.value} · {segment.domain.scope.competition.source}</span>}
          {segment.domain?.scope?.season && <span><b>Season</b>{segment.domain.scope.season.value} · {segment.domain.scope.season.source}</span>}
          {segment.identity?.matchContextIds[0] && <span><b>Match context</b>{segment.identity.matchContextIds[0]}</span>}
          {segment.identity?.clockMappings[0] && <span><b>Match clock</b>{segment.identity.clockMappings[0].period} · {segment.identity.clockMappings[0].clockText ?? `${segment.identity.clockMappings[0].matchMinuteStart}'`}</span>}
          <span><b>Event</b>{event.eventType}</span>
          <span><b>Pass</b>{event.football.passType}</span>
          <span><b>Zone</b>{event.football.fieldZone}</span>
          <span><b>Receiver</b>{event.football.receivingPlayer.identity ? `${event.football.receivingPlayer.identity.name} · ${event.football.receivingPlayer.identity.source}` : event.football.receivingPlayer.trackingStatus}</span>
          {event.football.passingPlayer.identity && <span><b>Passer</b>{event.football.passingPlayer.identity.name} · {event.football.passingPlayer.identity.source}</span>}
          <span><b>Ball</b>{event.football.ball.state} · {event.football.ball.trackingStatus}</span>
          <span><b>Field</b>{event.football.field.calibrationStatus} · {Math.round(event.football.field.zoneConfidence * 100)}% · {event.football.field.attackingDirection}</span>
        </div>
      )}
      {event.americanFootball && (
        <div className="domain-structured-grid">
          {segment.domain?.scope?.competition && <span><b>Competition</b>{segment.domain.scope.competition.value} · {segment.domain.scope.competition.source}</span>}
          {segment.domain?.scope?.season && <span><b>Season</b>{segment.domain.scope.season.value} · {segment.domain.scope.season.source}</span>}
          {segment.identity?.matchContextIds[0] && <span><b>Match context</b>{segment.identity.matchContextIds[0]}</span>}
          {segment.identity?.clockMappings[0] && <span><b>Match clock</b>{segment.identity.clockMappings[0].period} · {segment.identity.clockMappings[0].clockText ?? `${segment.identity.clockMappings[0].matchMinuteStart}'`}</span>}
          <span><b>Event</b>{event.eventType}</span>
          <span><b>Play type</b>{event.americanFootball.playType}</span>
          <span><b>Phase</b>{event.americanFootball.phase}</span>
          <span><b>QB</b>{event.americanFootball.quarterback.identity ? `${event.americanFootball.quarterback.identity.name} · ${event.americanFootball.quarterback.identity.source}` : event.americanFootball.quarterback.trackingStatus}</span>
          <span><b>Pressure</b>{event.americanFootball.pressure.present ? `${Math.round(event.americanFootball.pressure.confidence * 100)}% · ${event.americanFootball.pressure.source}` : "not detected"}</span>
          <span><b>Pocket</b>{event.americanFootball.pocket.status} · {Math.round(event.americanFootball.pocket.confidence * 100)}%</span>
          <span><b>Decision</b>{event.americanFootball.decision.outcome} · {Math.round(event.americanFootball.decision.confidence * 100)}%</span>
        </div>
      )}
      <details className="domain-event-details">
        <summary>Evidence and limitations</summary>
        {segment.domain?.vlm && (
          <p>
            Related knowledge VLM {segment.domain.vlm.status} · {segment.domain.vlm.model} · {Math.round(segment.domain.vlm.confidence * 100)}% · {segment.domain.vlm.message}
            {segment.domain.vlm.error ? ` · ${segment.domain.vlm.error}` : ""}
          </p>
        )}
        {segment.identity?.trackIdentityAssignments.length ? (
          <p>
            Track identity:{" "}
            {segment.identity.trackIdentityAssignments
              .slice(0, 3)
              .map((assignment) => `${assignment.trackId} -> ${assignment.canonicalName ?? "unknown"} (${assignment.status}, ${Math.round(assignment.confidence * 100)}%)`)
              .join(" · ")}
          </p>
        ) : null}
        {segment.identity?.teamClusterAssignments?.length ? (
          <p>
            Team clusters:{" "}
            {segment.identity.teamClusterAssignments
              .slice(0, 3)
              .map((assignment) => `${assignment.cluster} -> ${assignment.team ?? "unknown"} (${assignment.status}, ${Math.round(assignment.confidence * 100)}%)`)
              .join(" · ")}
          </p>
        ) : null}
        <p>{[...event.evidence.asr, ...event.evidence.ocr, ...event.evidence.visual].filter(Boolean).slice(0, 4).join(" · ") || "No direct evidence text stored."}</p>
        <p>{[...event.evidence.heuristics, ...(event.football?.limitations ?? []), ...(event.americanFootball?.limitations ?? [])].filter(Boolean).slice(0, 5).join(" · ")}</p>
      </details>
    </article>
  );
}

function topCounts(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function VectorResult({ asset, step }: { asset: AssetRecord; step: FlowStep }) {
  const textEmbeddingCount = asset.timeline.filter((segment) => segment.embedding.length > 0).length;
  const visualTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("visual-embedding:") || trace.startsWith("visual-embedding-unavailable:"));
  const textTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("embedding:"));
  const textDimensions = asset.timeline.find((segment) => segment.embedding.length > 0)?.embedding.length ?? 0;
  const domainEvents = asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
  const domainLinks = asset.timeline.filter((segment) => Boolean(segment.domain?.scope?.competition || segment.domain?.scope?.season || (segment.domain?.scope?.players.length ?? 0) > 0)).length;
  const visualVectorsReady = Boolean(visualTrace?.startsWith("visual-embedding:"));
  return (
    <WorkflowNodeDetails
      produced={[
        { label: "Text vectors", value: `${textEmbeddingCount}/${asset.timeline.length}`, tone: textEmbeddingCount > 0 ? "good" : "warning" },
        { label: "Text dimension", value: textDimensions > 0 ? `${textDimensions} dims` : "Unknown", tone: textDimensions > 0 ? "good" : "warning" },
        { label: "Visual vectors", value: visualVectorsReady ? "stored" : visualTrace ? "unavailable" : "pending", tone: visualVectorsReady ? "good" : visualTrace ? "warning" : "neutral" },
        { label: "Keyframes", value: asset.keyframes.length.toString(), tone: asset.keyframes.length > 0 ? "good" : "neutral" },
        { label: "Domain events", value: domainEvents.toString(), tone: domainEvents > 0 ? "good" : "neutral" },
        { label: "Knowledge links", value: domainLinks.toString(), tone: domainLinks > 0 ? "good" : "neutral" }
      ]}
      usedBy={["semantic retrieval", "visual retrieval", "hybrid ranking", "analysis grounding"]}
      quality={[
        { label: "Vector DB", value: asset.status === "indexed" ? "committed" : "not complete", tone: asset.status === "indexed" ? "good" : "warning" },
        { label: "Text coverage", value: formatCoverage(textEmbeddingCount, asset.timeline.length), tone: textEmbeddingCount === asset.timeline.length && asset.timeline.length > 0 ? "good" : "warning" },
        { label: "Visual coverage", value: visualVectorsReady ? "available" : "not used in ranking", tone: visualVectorsReady ? "good" : "neutral" },
        { label: "Searchable moments", value: asset.status === "indexed" ? asset.timeline.length.toString() : "not ready", tone: asset.status === "indexed" ? "good" : "warning" }
      ]}
      inspect={
        <div className="segment-list compact-list">
          <span>{textTrace ?? "No text embedding trace is stored."}</span>
          <span>{visualTrace ?? "No visual embedding trace is stored."}</span>
          <span>{asset.status === "indexed" ? "Asset vectors are committed and searchable." : "Vector commit is not complete yet."}</span>
        </div>
      }
      rawDetails={rawStepDetails(step, [textTrace ?? "", visualTrace ?? ""])}
    />
  );
}

function ResultMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: NodeMetricTone }) {
  return (
    <span className={`workflow-result-metric ${tone}`}>
      <b>{label}</b>
      {value}
    </span>
  );
}

export function FlowConnector({ label }: { label?: string }) {
  return (
    <div className="flow-connector" aria-hidden="true">
      <span />
      {label && <em>{label}</em>}
    </div>
  );
}
export function AssetDetailTabs({ active, onChange }: { active: AssetDetailTab; onChange: (tab: AssetDetailTab) => void }) {
  const tabs: Array<{ id: AssetDetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "workflow", label: "Workflow" },
    { id: "timeline", label: "Timeline" }
  ];
  return (
    <div className="asset-detail-tabs" aria-label="Asset detail sections">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`asset-detail-tab ${active === tab.id ? "active" : ""}`}
          aria-pressed={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
export function AssetStatusIndicator({ asset }: { asset: Pick<AssetRecord, "status"> }) {
  if (asset.status === "indexed") {
    return (
      <span className="asset-status-icon" aria-label="Indexed" title="Indexed">
        <IndexStatusIcon />
      </span>
    );
  }
  if (asset.status === "failed") {
    return (
      <span className="asset-status-icon failed" aria-label="Failed" title="Failed">
        <FailStatusIcon />
      </span>
    );
  }

  return <strong>{asset.status}</strong>;
}

export function StatusBadge({ asset }: { asset: AssetRecord }) {
  if (asset.status === "indexed") {
    return (
      <span className="badge indexed icon-badge" aria-label="Indexed" title="Indexed">
        <IndexStatusIcon />
      </span>
    );
  }
  if (asset.status === "failed") {
    return (
      <span className="badge failed icon-badge" aria-label="Failed" title="Failed">
        <FailStatusIcon />
      </span>
    );
  }

  return (
    <span className={`badge ${asset.status}`}>
      {asset.status}
      {` ${asset.progress}%`}
    </span>
  );
}

export function IndexStatusIcon() {
  return <span className="index-status-icon" aria-hidden="true" />;
}

export function FailStatusIcon() {
  return <span className="fail-status-icon" aria-hidden="true" />;
}

export function Timeline({
  asset,
  selectedSegmentId,
  onSelect
}: {
  asset: AssetRecord;
  selectedSegmentId: string | null;
  onSelect: (segment: AssetRecord["timeline"][number]) => void;
}) {
  if (asset.timeline.length === 0) return <EmptyState text="Timeline segments will appear after indexing." />;
  const openSegment = (segment: AssetRecord["timeline"][number]) => onSelect(segment);
  const openSegmentFromKeyboard = (event: KeyboardEvent<HTMLElement>, segment: AssetRecord["timeline"][number]) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSegment(segment);
  };
  return (
    <div className="timeline">
      {asset.timeline.map((segment) => (
        <article
          key={segment.id}
          className={selectedSegmentId === segment.id ? "active" : ""}
          role="button"
          tabIndex={0}
          aria-label={`Open video at ${formatDuration(segment.start)} for ${segment.label}`}
          onClick={() => openSegment(segment)}
          onKeyDown={(event) => openSegmentFromKeyboard(event, segment)}
        >
          <TimelineThumbnail path={segment.thumbnailPath} />
          <span>
            {formatDuration(segment.start)}-{formatDuration(segment.end)} · shot {segment.scene?.shotIndex ?? "-"} ·{" "}
            {segment.modalities.join(", ")} · {segment.sources.join(", ")}
          </span>
          <strong>{segment.label}</strong>
          <SceneDataSummary segment={segment} />
          <em>confidence {Math.round(segment.confidence * 100)}%</em>
        </article>
      ))}
    </div>
  );
}

export function TimelineThumbnail({ path }: { path: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = path && !failed ? mediaPath(path) : null;
  if (!src) return <span className="timeline-thumbnail-placeholder">No image</span>;
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

export function SceneDataSummary({ segment }: { segment: AssetRecord["timeline"][number] }) {
  const scene = getSearchSceneData(segment, "");
  const domainSummary = getDomainSummary(segment);
  const imageText = [scene.image.labels.slice(0, 3).join(" · "), scene.image.dominantColor].filter(Boolean).join(" · ") || "keyframe";
  const vision = scene.vision;
  const textRows = [
    { label: "Speech", value: scene.text.speech },
    { label: "Subtitle", value: scene.text.subtitles.join(" ") },
    { label: "Screen", value: scene.text.screenText.join(" ") },
    { label: "Overlay", value: scene.text.overlays.join(" ") }
  ].filter((row) => row.value.trim().length > 0);
  const comparisonRows = dedupeTextComparisons(scene.text.comparisons ?? []);
  return (
    <span className="timeline-scene-data">
      <span>
        <b>Image</b>
        {imageText}
      </span>
      {vision && (
        <span>
          <b>Vision</b>
          pitch {Math.round(vision.pitch.confidence * 100)}% · players {vision.objects.players.status}
          {vision.objects.ball.status === "estimated" || vision.objects.ball.status === "detected" ? ` · ball ${vision.objects.ball.status}` : ""}
          {vision.fieldZone.zone !== "unknown" ? ` · ${vision.fieldZone.zone}` : ""}
          {vision.fieldCalibration ? ` · field ${vision.fieldCalibration.status}/${vision.fieldCalibration.method}` : ""}
          {vision.tracking?.ballTrackId ? ` · ${vision.tracking.ballTrackId}` : ""}
          {formatTrackKitClusters(vision.tracking?.playerTracks) ? ` · ${formatTrackKitClusters(vision.tracking?.playerTracks)}` : ""}
          {vision.eventClassification && vision.eventClassification.label !== "unknown" ? ` · ${vision.eventClassification.label} ${Math.round(vision.eventClassification.confidence * 100)}%` : ""}
        </span>
      )}
      {textRows.slice(0, 3).map((row) => (
        <span key={row.label}>
          <b>{row.label}</b>
          {truncateText(row.value, 150)}
        </span>
      ))}
      {domainSummary && (
        <span>
          <b>Related knowledge</b>
          {truncateText(domainSummary, 150)}
        </span>
      )}
      {comparisonRows.slice(0, 2).map((row, index) => (
        <span key={`${row.kind}-${index}`} className={`timeline-comparison ${row.status}`}>
          <b>ASR/OCR consistency</b>
          {Math.round(row.similarity * 100)}% · {row.status} · {truncateText(row.suggestedText, 150)}
        </span>
      ))}
    </span>
  );
}

function formatTrackKitClusters(
  tracks: NonNullable<NonNullable<NonNullable<AssetRecord["timeline"][number]["sceneData"]>["vision"]>["tracking"]>["playerTracks"] | undefined
) {
  const clusters = (tracks ?? [])
    .filter((track) => track.teamCluster && track.teamCluster !== "unknown")
    .slice(0, 4)
    .map((track) => `${track.id}:${track.teamCluster}${track.appearance?.dominantHex ? ` ${track.appearance.dominantHex}` : ""}`);
  const jerseys = (tracks ?? [])
    .flatMap((track) => (track.jerseyNumberCandidates ?? []).slice(0, 1).map((candidate) => `${track.id}:#${candidate.number}`))
    .slice(0, 4);
  return [
    clusters.length > 0 ? `kits ${clusters.join(", ")}` : "",
    jerseys.length > 0 ? `jerseys ${jerseys.join(", ")}` : ""
  ].filter(Boolean).join("; ");
}

function dedupeTextComparisons(comparisons: NonNullable<ReturnType<typeof getSearchSceneData>["text"]["comparisons"]>) {
  const seen = new Set<string>();
  return comparisons.filter((row) => {
    const key = [
      row.status,
      Math.round(row.similarity * 100),
      normalizeCompareText(row.suggestedText || row.asrText || row.ocrText)
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeCompareText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
