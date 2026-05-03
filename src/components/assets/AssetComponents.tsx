import { BrainCircuit, CircleHelp, Edit3, FileVideo, Layers3, RefreshCw, Search } from "lucide-react";
import { Fragment, type FormEvent, useState } from "react";
import type { AssetRecord, IndexRecord, JobRecord } from "../../../shared/types";
import { getAssetFlow, type FlowStep } from "../../assetFlow";
import { formatDuration, mediaPath, truncateText } from "../../displayUtils";
import { EmptyState } from "../common/ConsolePrimitives";
import { getDomainSummary, getSearchSceneData } from "../evidence/sceneEvidence";

export type AssetDetailTab = "overview" | "workflow" | "evidence" | "timeline";
export function AssetGroupForm({ index, onSubmit }: { index: IndexRecord | null; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  const domain = index?.domainIndexing;
  const domainEnabled = Boolean(domain?.enabled);
  const stages = new Set(domain?.stages ?? ["domain_caption", "event_label", "structured_event"]);
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
      </div>
      <button type="submit">
        <Layers3 size={16} />
        {index ? "에셋그룹 저장" : "에셋그룹 만들기"}
      </button>
    </form>
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
  onRetryStage
}: {
  asset: AssetRecord;
  index: IndexRecord | null;
  job: JobRecord | null;
  onRetryStage: (assetId: string, stage: string) => Promise<void>;
}) {
  const flow = getAssetFlow(asset, index, job);
  const activeStep = flow.find((step) => step.state === "active") ?? flow.find((step) => step.state === "error") ?? flow.at(-1);
  const overallProgress = getServerBackedProgress(asset, job);
  const overallStage = getServerBackedStage(asset, job);
  const stageGroups = [
    {
      label: "1. Source preparation",
      detail: "Validate the media file, probe metadata, then extract speech/music regions.",
      steps: flow.filter((step) => step.id === "input" || step.id === "probe" || step.id === "audio" || step.id === "vad")
    },
    {
      label: "2. Speech intelligence",
      detail: "Run ASR from VAD-focused audio, then align speaker labels from ASR segments.",
      steps: flow.filter((step) => step.id === "asr" || step.id === "speakers")
    },
    {
      label: "3. Visual and text extraction",
      detail: "Sample visual frames and extract on-screen text from subtitle and full-frame lanes.",
      steps: flow.filter((step) => step.id === "ocr" || step.id === "visual")
    },
    {
      label: "4. Search index",
      detail: "Merge ASR, OCR, scene data, domain events, and visual signals into searchable timeline vectors.",
      steps: flow.filter((step) => step.id === "timeline" || step.id === "domain" || step.id === "vector")
    },
    {
      label: "5. Serve",
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
                  <FlowNode key={step.id} step={step} retryDisabled={retryDisabled} onRetry={retryNode} />
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
  retryDisabled,
  onRetry
}: {
  step: FlowStep;
  retryDisabled: boolean;
  onRetry: (step: FlowStep) => void;
}) {
  const progressLabel = step.progress === null ? step.state : `${step.progress}%`;
  return (
    <article className={`flow-node ${step.state}`} title={step.helpText}>
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
      <div className="node-progress" aria-label={`${step.label} ${progressLabel}`}>
        <span style={{ width: `${step.progress ?? 0}%` }} />
      </div>
      <div className="node-actions">
        <span className="node-state">{step.state}</span>
        <span className="node-percent">{progressLabel}</span>
        <button
          type="button"
          className="node-retry"
          onClick={() => onRetry(step)}
          disabled={retryDisabled}
          aria-label={`Retry ${step.label}`}
          title={`Retry ${step.label}`}
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </article>
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
    { id: "evidence", label: "Evidence" },
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
  return (
    <div className="timeline">
      {asset.timeline.map((segment) => (
        <article key={segment.id} className={selectedSegmentId === segment.id ? "active" : ""} onClick={() => onSelect(segment)}>
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
  const comparisonRows = scene.text.comparisons ?? [];
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
