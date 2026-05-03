import { BrainCircuit, CircleHelp, Edit3, FileVideo, Layers3, RefreshCw, Search } from "lucide-react";
import { Fragment, type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import type { AssetRecord, IndexRecord, JobRecord } from "../../../shared/types";
import { getAssetFlow, type FlowStep } from "../../assetFlow";
import { formatDuration, mediaPath, truncateText } from "../../displayUtils";
import { EmptyState } from "../common/ConsolePrimitives";
import { OcrRoleSummary } from "../evidence/EvidenceComponents";
import { getDomainSummary, getSearchSceneData } from "../evidence/sceneEvidence";

export type AssetDetailTab = "overview" | "workflow" | "timeline";

type MomentOpenOptions = {
  start?: number;
  end?: number;
  label?: string;
};

type OpenMomentHandler = (segment: AssetRecord["timeline"][number], options?: MomentOpenOptions) => void;

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
            <strong>Sports domain indexing</strong>
            <em>Enable only for sports asset groups that need domain events.</em>
          </span>
        </label>
        <label className="field-label">
          <span>Domain group</span>
          <select name="domainGroup" defaultValue={domain?.groups[0] ?? "sports.football"}>
            <option value="sports.football">sports.football</option>
            <option value="sports.american_football">sports.american_football</option>
          </select>
        </label>
        <div className="stage-options" aria-label="Domain indexing stages">
          <label>
            <input name="domainStage" type="checkbox" value="domain_caption" defaultChecked={stages.has("domain_caption")} />
            <span>Domain captions</span>
          </label>
          <label>
            <input name="domainStage" type="checkbox" value="event_label" defaultChecked={stages.has("event_label")} />
            <span>Event labels</span>
          </label>
          <label>
            <input name="domainStage" type="checkbox" value="structured_event" defaultChecked={stages.has("structured_event")} />
            <span>Field/player/ball event schema</span>
          </label>
        </div>
        <div className="stage-options" aria-label="Model capability policy">
          <CapabilitySelect name="capabilityWhisperX" label="WhisperX diarization" value={policy?.whisperXDiarization ?? "optional"} />
          <CapabilitySelect name="capabilityVisionDetector" label="Vision detector" value={policy?.visionDetector ?? "optional"} />
          <CapabilitySelect name="capabilityVisionTracker" label="Vision tracker" value={policy?.visionTracker ?? "optional"} />
          <CapabilitySelect name="capabilitySoccerNetAction" label="SoccerNet action spotting" value={policy?.soccerNetActionSpotting ?? "optional"} />
          <CapabilitySelect name="capabilityDomainVlm" label="Domain VLM refinement" value={policy?.domainVlmRefinement ?? "optional"} />
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
  busy,
  onEdit,
  onRefineVlm
}: {
  index: IndexRecord | null;
  assets: AssetRecord[];
  busy: boolean;
  onEdit: () => void;
  onRefineVlm: (indexId: string) => void;
}) {
  const indexedCount = assets.filter((asset) => asset.status === "indexed").length;
  const domain = index?.domainIndexing;
  const canRefineVlm = Boolean(index && domain?.enabled && domain.groups.length > 0 && indexedCount > 0);
  const vlmSummary = summarizeAssetGroupVlm(assets);
  const domainText =
    domain?.enabled && domain.groups.length > 0
      ? `${domain.groups.join(", ")} · ${domain.stages.map((stage) => stage.replace(/_/g, " ")).join(", ")}`
      : "Off";
  const capabilityText = index?.capabilityPolicy ? summarizeCapabilityPolicy(index.capabilityPolicy) : "capabilities optional";
  return (
    <section className="asset-group-summary" aria-label="Selected asset group summary">
      <div>
        <p className="section-label">Asset Group</p>
        <span className="asset-group-title-row">
          <h2>{index?.name ?? "No asset group selected"}</h2>
          <em className="asset-group-indexed-count">{indexedCount}/{assets.length} indexed</em>
          <button type="button" className="asset-group-edit" onClick={onEdit} disabled={!index} aria-label="에셋그룹 수정" title="에셋그룹 수정">
            <Edit3 size={17} />
          </button>
        </span>
        {index?.description && <p>{index.description}</p>}
        <div className="asset-group-meta">
          <span>
            <b>Domain</b>
            {domainText}
          </span>
          <span>
            <b>Policy</b>
            {capabilityText}
          </span>
          <span>
            <b>VLM</b>
            {vlmSummary}
          </span>
        </div>
      </div>
      <div className="asset-group-actions">
        <button
          type="button"
          className="asset-group-refine"
          disabled={!canRefineVlm || busy}
          onClick={() => index && onRefineVlm(index.id)}
          title="Run Qwen VLM domain refinement for indexed assets in this asset group"
        >
          <BrainCircuit size={17} />
          <span>VLM refine</span>
        </button>
        <span className="asset-group-status-pill">{index?.status ?? "empty"}</span>
      </div>
    </section>
  );
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

function summarizeAssetGroupVlm(assets: AssetRecord[]) {
  const counts = assets.reduce(
    (sum, asset) => {
      for (const segment of asset.timeline) {
        const status = segment.domain?.vlm?.status;
        if (status) sum[status] += 1;
      }
      return sum;
    },
    { refined: 0, invalid: 0, failed: 0, skipped: 0 }
  );
  const attempted = counts.refined + counts.invalid + counts.failed;
  if (attempted === 0) return "not run";
  return `${counts.refined}/${attempted} refined${counts.invalid ? ` · ${counts.invalid} invalid` : ""}${counts.failed ? ` · ${counts.failed} failed` : ""}`;
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
  onOpenMoment
}: {
  asset: AssetRecord;
  index: IndexRecord | null;
  job: JobRecord | null;
  onRetryStage: (assetId: string, stage: string) => Promise<void>;
  onOpenMoment?: OpenMomentHandler;
}) {
  const flow = getAssetFlow(asset, index, job);
  const activeStep = flow.find((step) => step.state === "active") ?? flow.find((step) => step.state === "error") ?? flow.at(-1);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(activeStep?.id ?? flow[0]?.id ?? "input");
  const overallProgress = getServerBackedProgress(asset, job);
  const overallStage = getServerBackedStage(asset, job);
  const stageGroups = [
    {
      label: "1. Source preparation",
      detail: "Validate the media file, probe metadata, then extract speech/music regions.",
      steps: flow.filter((step) => step.id === "input" || step.id === "probe" || step.id === "audio" || step.id === "vad")
    },
    {
      label: "2. Speech and text extraction",
      detail: "Run ASR, optional speaker alignment, and OCR before timeline assembly.",
      steps: flow.filter((step) => step.id === "asr" || step.id === "speakers" || step.id === "ocr")
    },
    {
      label: "3. Scene and vision evidence",
      detail: "Build scene windows, keyframes, detector evidence, and tracker evidence.",
      steps: flow.filter((step) => step.id === "visual" || step.id === "scene" || step.id === "timeline" || step.id === "keyframes" || step.id === "detector" || step.id === "tracker")
    },
    {
      label: "4. Domain evidence",
      detail: "Apply trusted sports action spotting, domain event construction, and optional VLM refinement.",
      steps: flow.filter((step) => step.id === "soccernet" || step.id === "domain" || step.id === "domainVlm")
    },
    {
      label: "5. Vector index",
      detail: "Write text embeddings, visual embeddings, and vector records.",
      steps: flow.filter((step) => step.id === "textEmbedding" || step.id === "visualEmbedding" || step.id === "vector")
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
        {stageGroups.map((group, index) => (
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
                    <WorkflowResultContent asset={asset} stepId={step.id} onOpenMoment={onOpenMoment} />
                  </FlowNode>
                ))}
              </div>
            </section>
            {index < stageGroups.length - 1 && <FlowConnector />}
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
  const progressLabel = step.progress === null ? step.state : `${step.progress}%`;
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
        {step.serverProgress && (
          <span className="node-server-progress">
            server {step.serverProgress.status} · {step.serverProgress.stage} · {step.serverProgress.progress}%
          </span>
        )}
        {step.trace && <em>{step.trace}</em>}
        <div className="node-progress" aria-label={`${step.label} ${progressLabel}`}>
          <span style={{ width: `${step.progress ?? 0}%` }} />
        </div>
        <div className="node-actions">
          <span className="node-state">{step.state}</span>
          <span className="node-percent">{progressLabel}</span>
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

function WorkflowResultContent({ asset, stepId, onOpenMoment }: { asset: AssetRecord; stepId: string; onOpenMoment?: OpenMomentHandler }) {
  if (stepId === "input" || stepId === "probe") return <TechnicalResult asset={asset} />;
  if (stepId === "audio" || stepId === "vad") return <AudioResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "asr") return <AsrResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "speakers") return <SpeakerResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "ocr") return <OcrResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "visual" || stepId === "keyframes") return <VisualResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "scene" || stepId === "timeline") return <TimelineResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "detector" || stepId === "tracker" || stepId === "soccernet") return <ModelTraceResult asset={asset} stepId={stepId} />;
  if (stepId === "domain" || stepId === "domainVlm") return <DomainResult asset={asset} onOpenMoment={onOpenMoment} />;
  if (stepId === "textEmbedding" || stepId === "visualEmbedding" || stepId === "vector" || stepId === "ready") return <VectorResult asset={asset} />;
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

function TechnicalResult({ asset }: { asset: AssetRecord }) {
  return (
    <div className="workflow-result-grid">
      <ResultMetric label="Original" value={asset.originalName} />
      <ResultMetric label="Stored" value={asset.storedName} />
      <ResultMetric label="Duration" value={formatDuration(asset.duration ?? 0)} />
      <ResultMetric label="Frame" value={asset.width && asset.height ? `${asset.width}x${asset.height}` : "No dimensions"} />
      <ResultMetric label="Video codec" value={asset.technicalMetadata.videoCodec ?? "No video codec"} />
      <ResultMetric label="Audio codec" value={asset.technicalMetadata.audioCodec ?? "No audio codec"} />
      <ResultMetric label="Frame rate" value={asset.technicalMetadata.frameRate ? `${Math.round(asset.technicalMetadata.frameRate)}fps` : "Unknown"} />
      <ResultMetric label="Checksum" value={asset.technicalMetadata.checksum ?? "Not stored"} />
    </div>
  );
}

function AudioResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  const speechSegments = asset.intelligence.audio?.speechSegments ?? [];
  const musicSegments = asset.intelligence.audio?.musicSegments ?? [];
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Extracted audio" value={asset.intelligence.audio?.extractedPath ?? "No audio artifact"} />
        <ResultMetric label="Speech regions" value={speechSegments.length.toString()} />
        <ResultMetric label="Music regions" value={musicSegments.length.toString()} />
        <ResultMetric label="Provider" value={asset.intelligence.audio?.vad?.provider ?? "local"} />
      </div>
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
    </div>
  );
}

function AsrResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Language" value={asset.intelligence.asr.language || "Unknown"} />
        <ResultMetric label="Confidence" value={`${Math.round(asset.intelligence.asr.confidence * 100)}%`} />
        <ResultMetric label="Segments" value={asset.intelligence.asr.segments.length.toString()} />
      </div>
      <p className="transcript-box">{asset.intelligence.asr.transcript || "No speech text was extracted."}</p>
      <div className="segment-list compact-list">
        {asset.intelligence.asr.segments.map((segment) => (
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
        {asset.intelligence.asr.segments.length === 0 && <span>No timestamped ASR segments are stored.</span>}
      </div>
    </div>
  );
}

function SpeakerResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  const diarization = asset.intelligence.diarization;
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Provider" value={diarization?.provider ?? "none"} />
        <ResultMetric label="Speakers" value={(diarization?.speakers.length ?? 0).toString()} />
        <ResultMetric label="Segments" value={(diarization?.segments.length ?? 0).toString()} />
        <ResultMetric label="Error" value={diarization?.error ?? "None"} />
      </div>
      <div className="segment-list compact-list">
        {(diarization?.segments ?? []).map((segment) => (
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
        {(diarization?.segments.length ?? 0) === 0 && <span>No speaker diarization segments are stored.</span>}
      </div>
    </div>
  );
}

function OcrResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Tokens" value={asset.intelligence.ocr.tokens.length.toString()} />
        <ResultMetric label="Confidence" value={`${Math.round(asset.intelligence.ocr.confidence * 100)}%`} />
        <ResultMetric label="Frames" value={asset.intelligence.ocr.frames.length.toString()} />
      </div>
      <div className="ocr-token-list">
        {asset.intelligence.ocr.tokens.map((token) => <span key={token}>{token}</span>)}
        {asset.intelligence.ocr.tokens.length === 0 && <span>No OCR text was extracted.</span>}
      </div>
      <div className="ocr-frame-list">
        {asset.intelligence.ocr.frames.map((frame) => {
          const src = mediaPath(frame.framePath);
          const content = (
            <>
              {src && <img src={src} alt="" />}
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
        {asset.intelligence.ocr.frames.length === 0 && <span>No OCR frames are stored.</span>}
      </div>
    </div>
  );
}

function VisualResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  const usableKeyframes = asset.keyframes.filter((keyframe) => keyframe.path && keyframe.segmentId).length;
  const visualTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("visual-embedding:") || trace.startsWith("visual-embedding-unavailable:"));
  const visualVectorState = visualTrace?.startsWith("visual-embedding:") ? `${usableKeyframes} ready` : visualTrace ? "unavailable" : "pending";
  const detectorTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("vision-detector:") || trace.startsWith("vision-detector-unavailable:"));
  const trackerTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("vision-tracker:") || trace.startsWith("vision-tracker-unavailable:"));
  const visionSegments = asset.timeline.filter((segment) => segment.sceneData?.vision).length;
  const domainEvents = asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0);
  return (
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
          detail="Motion, visual labels, player/ball evidence, and field cues support sports event confidence."
        />
      </div>
      <div className="workflow-technical-strip" aria-label="Raw visual sampler summary">
        <span><b>Sampler</b>{asset.intelligence.visual.available === false ? "unavailable" : "available"}</span>
        <span><b>Dominant color</b>{asset.intelligence.visual.dominantColor}</span>
        <span><b>Brightness</b>{asset.intelligence.visual.brightness.toFixed(2)}</span>
        <span><b>Motion</b>{asset.intelligence.visual.motionScore.toFixed(2)}</span>
      </div>
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

function TimelineResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Moments" value={asset.timeline.length.toString()} />
        <ResultMetric label="Scene data" value={asset.timeline.filter((segment) => segment.sceneData).length.toString()} />
        <ResultMetric label="Thumbnails" value={asset.timeline.filter((segment) => segment.thumbnailPath).length.toString()} />
      </div>
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
    </div>
  );
}

function ModelTraceResult({ asset, stepId }: { asset: AssetRecord; stepId: string }) {
  const prefixes =
    stepId === "detector"
      ? ["vision-detector:"]
      : stepId === "tracker"
        ? ["vision-tracker:"]
        : ["soccernet-action:"];
  const unavailablePrefixes = prefixes.map((prefix) => prefix.replace(":", "-unavailable:"));
  const traces = asset.intelligence.modelTrace.filter((trace) => [...prefixes, ...unavailablePrefixes].some((prefix) => trace.startsWith(prefix)));
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Stored traces" value={traces.length.toString()} />
        <ResultMetric label="Vision segments" value={asset.timeline.filter((segment) => segment.sceneData?.vision).length.toString()} />
        <ResultMetric label="Domain events" value={asset.timeline.reduce((sum, segment) => sum + (segment.domain?.events.length ?? 0), 0).toString()} />
      </div>
      <div className="segment-list compact-list">
        {traces.map((trace) => <span key={trace}>{trace}</span>)}
        {traces.length === 0 && <span>No model trace is stored for this stage.</span>}
      </div>
    </div>
  );
}

function DomainResult({ asset, onOpenMoment }: { asset: AssetRecord; onOpenMoment?: OpenMomentHandler }) {
  const domainEvents = asset.timeline.flatMap((segment) =>
    (segment.domain?.events ?? []).map((event) => ({
      segment,
      event
    }))
  );
  const vlmSegments = asset.timeline.filter((segment) => segment.domain?.vlm);
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Events" value={domainEvents.length.toString()} />
        <ResultMetric label="VLM checks" value={vlmSegments.length.toString()} />
        <ResultMetric label="Refined" value={vlmSegments.filter((segment) => segment.domain?.vlm?.status === "refined").length.toString()} />
      </div>
      <div className="domain-event-list">
        {domainEvents.slice(0, 12).map(({ segment, event }) => (
          <article key={event.id} className="domain-event-row">
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
                <span><b>Event</b>{event.eventType}</span>
                <span><b>Pass</b>{event.football.passType}</span>
                <span><b>Zone</b>{event.football.fieldZone}</span>
                <span><b>Receiver</b>{event.football.receivingPlayer.identity ? `${event.football.receivingPlayer.identity.name} · ${event.football.receivingPlayer.identity.source}` : event.football.receivingPlayer.trackingStatus}</span>
                {event.football.passingPlayer.identity && <span><b>Passer</b>{event.football.passingPlayer.identity.name} · {event.football.passingPlayer.identity.source}</span>}
                <span><b>Ball</b>{event.football.ball.state} · {event.football.ball.trackingStatus}</span>
                <span><b>Field</b>{event.football.field.calibrationStatus} · {Math.round(event.football.field.zoneConfidence * 100)}% · {event.football.field.attackingDirection}</span>
              </div>
            )}
            <details className="domain-event-details">
              <summary>Evidence and limitations</summary>
              {segment.domain?.vlm && (
                <p>
                  VLM {segment.domain.vlm.status} · {segment.domain.vlm.model} · {Math.round(segment.domain.vlm.confidence * 100)}% · {segment.domain.vlm.message}
                  {segment.domain.vlm.error ? ` · ${segment.domain.vlm.error}` : ""}
                </p>
              )}
              <p>{[...event.evidence.asr, ...event.evidence.ocr, ...event.evidence.visual].filter(Boolean).slice(0, 4).join(" · ") || "No direct evidence text stored."}</p>
              {segment.domain?.vlm?.rawResponse && <p>Raw VLM: {truncateText(segment.domain.vlm.rawResponse, 360)}</p>}
              <p>{[...event.evidence.heuristics, ...(event.football?.limitations ?? [])].filter(Boolean).slice(0, 5).join(" · ")}</p>
            </details>
          </article>
        ))}
        {domainEvents.length === 0 && <span className="empty-inline">No domain event metadata was generated for this asset.</span>}
      </div>
    </div>
  );
}

function VectorResult({ asset }: { asset: AssetRecord }) {
  const textEmbeddingCount = asset.timeline.filter((segment) => segment.embedding.length > 0).length;
  const visualTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("visual-embedding:") || trace.startsWith("visual-embedding-unavailable:"));
  const textTrace = asset.intelligence.modelTrace.find((trace) => trace.startsWith("embedding:"));
  return (
    <div className="workflow-result-stack">
      <div className="workflow-result-grid compact">
        <ResultMetric label="Timeline embeddings" value={`${textEmbeddingCount}/${asset.timeline.length}`} />
        <ResultMetric label="Keyframes" value={asset.keyframes.length.toString()} />
        <ResultMetric label="Asset status" value={`${asset.status} · ${asset.progress}%`} />
      </div>
      <div className="segment-list compact-list">
        <span>{textTrace ?? "No text embedding trace is stored."}</span>
        <span>{visualTrace ?? "No visual embedding trace is stored."}</span>
        <span>{asset.status === "indexed" ? "Asset vectors are committed and searchable." : "Vector commit is not complete yet."}</span>
      </div>
    </div>
  );
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="workflow-result-metric">
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
export function AssetStatusIndicator({ asset }: { asset: AssetRecord }) {
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
          <b>Domain</b>
          {truncateText(domainSummary, 150)}
        </span>
      )}
      {comparisonRows.slice(0, 2).map((row, index) => (
        <span key={`${row.kind}-${index}`} className={`timeline-comparison ${row.status}`}>
          <b>Compare</b>
          {Math.round(row.similarity * 100)}% · {row.status} · {truncateText(row.suggestedText, 150)}
        </span>
      ))}
    </span>
  );
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
