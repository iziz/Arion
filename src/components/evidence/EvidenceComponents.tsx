import { AlertTriangle, CircleHelp, ShieldCheck, X } from "lucide-react";
import type { AssetRecord, ClipDetailResult, OcrBox, SearchResult, VerificationCheck } from "../../../shared/types";
import { formatDuration, mediaPath, truncateText } from "../../displayUtils";
import { buildEvidenceLedger, type EvidenceLedger } from "../../searchTrust";
import { EmptyState } from "../common/ConsolePrimitives";
import { getDomainSummary, getSearchSceneData } from "./sceneEvidence";

export function KnowledgeEvidenceRow({ evidence }: { evidence: SearchResult["knowledgeEvidence"] }) {
  return (
    <span className="knowledge-evidence-row">
      {evidence.slice(0, 6).map((item) => (
        <em key={item.id} className={item.source}>
          <b>{item.kind.replace(/_/g, " ")}</b>
          {item.entityName}
          {item.season ? ` · ${item.season}` : ""}
          {item.team ? ` · ${item.team}` : ""}
          {item.matchTime ? ` · ${item.matchTime}` : ""}
          {` · ${Math.round(item.confidence * 100)}%`}
        </em>
      ))}
    </span>
  );
}

export function TrustBadge({ ledger, compact = false }: { ledger: EvidenceLedger; compact?: boolean }) {
  const Icon = ledger.tone === "verified" ? ShieldCheck : ledger.tone === "review" ? CircleHelp : AlertTriangle;
  return (
    <span className={`trust-badge ${ledger.tone} ${compact ? "compact" : ""}`} title={ledger.summary}>
      <Icon size={compact ? 13 : 15} />
      <b>{ledger.label}</b>
      <em>{ledger.score}%</em>
    </span>
  );
}

export function EvidenceColumn({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section>
      <b>{title}</b>
      <ul>
        {(items.length > 0 ? items.slice(0, 4) : [empty]).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function EvidenceLedgerCompact({ ledger }: { ledger: EvidenceLedger }) {
  const groups = [
    { key: "hard", label: "Hard", items: ledger.hard },
    { key: "soft", label: "Soft", items: ledger.soft },
    { key: "missing", label: "Missing", items: ledger.missing },
    { key: "failed", label: "Failed", items: ledger.failed }
  ];
  return (
    <span className="evidence-ledger-compact">
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <em key={group.key} className={group.key}>
            <b>{group.label}</b>
            {group.items.length}
          </em>
        ))}
      {ledger.limitations.length > 0 && (
        <em className="limitation">
          <b>Limits</b>
          {ledger.limitations.length}
        </em>
      )}
    </span>
  );
}

export function EvidenceLedgerPanel({ ledger }: { ledger: EvidenceLedger }) {
  const sections = [
    { key: "hard", title: "Hard Evidence", empty: "No hard evidence.", items: ledger.hard },
    { key: "soft", title: "Soft Evidence", empty: "No soft evidence.", items: ledger.soft },
    { key: "missing", title: "Missing Evidence", empty: "No missing evidence.", items: ledger.missing },
    { key: "failed", title: "Failed Checks", empty: "No failed checks.", items: ledger.failed },
    { key: "limitation", title: "Limitations", empty: "No stored limitations.", items: ledger.limitations }
  ];
  return (
    <div className="evidence-ledger-panel">
      <p>{ledger.summary}</p>
      {sections.map((section) => (
        <article key={section.key} className={section.key}>
          <strong>{section.title}</strong>
          {section.items.length > 0 ? (
            section.items.slice(0, 8).map((item) => (
              <span key={item.id}>
                <b>{item.label}</b>
                {item.value}
                {item.confidence !== null ? <em>{Math.round(item.confidence * 100)}%</em> : null}
                <small>{item.detail}</small>
              </span>
            ))
          ) : (
            <small>{section.empty}</small>
          )}
        </article>
      ))}
    </div>
  );
}

export function ClipUseSummary({ ledger, detail }: { ledger: EvidenceLedger; detail: ClipDetailResult }) {
  const primaryCautions = buildClipCautions(ledger, detail);
  const canUse = ledger.tone === "verified" && ledger.failed.length === 0;
  const title = canUse ? "Ready for use" : ledger.tone === "review" ? "Use with caution" : "Needs verification";
  const copy = canUse
    ? "Structured checks are mostly backed by hard evidence."
    : primaryCautions[0] ?? "Important evidence is missing or failed for this clip.";
  return (
    <section className={`clip-use-summary ${ledger.tone}`}>
      <div>
        <span className="clip-use-icon">{ledger.tone === "verified" ? <ShieldCheck size={18} /> : ledger.tone === "review" ? <CircleHelp size={18} /> : <AlertTriangle size={18} />}</span>
        <div>
          <strong>{title}</strong>
          <p>{copy}</p>
        </div>
      </div>
      <div className="clip-use-stats">
        <span><b>Hard</b>{ledger.hard.length}</span>
        <span><b>Soft</b>{ledger.soft.length}</span>
        <span><b>Missing</b>{ledger.missing.length}</span>
        <span><b>Failed</b>{ledger.failed.length}</span>
      </div>
      {primaryCautions.length > 0 && (
        <ul>
          {primaryCautions.slice(0, 4).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function buildClipCautions(ledger: EvidenceLedger, detail: ClipDetailResult) {
  const cautions = [
    ...ledger.failed.map((item) => `${item.label}: ${item.value}`),
    ...ledger.missing.map((item) => `${item.label}: missing ${item.value}`),
    ...ledger.soft
      .filter((item) => /field|player|vlm/i.test(`${item.label} ${item.value} ${item.detail}`))
      .map((item) => `${item.label}: ${item.value}`),
    ...ledger.limitations.map((item) => item.value),
    detail.tracking.length === 0 ? "No persisted tracking record for this segment." : "",
    detail.clip.verificationSummary.softPass > 0 ? `${detail.clip.verificationSummary.softPass} verification checks are soft matches.` : ""
  ].filter(Boolean);
  return Array.from(new Set(cautions)).slice(0, 6);
}

export function SearchSceneEvidence({
  segment,
  query,
  reasons,
  verification
}: {
  segment: AssetRecord["timeline"][number];
  query: string;
  reasons: SearchResult["matchReasons"];
  verification: VerificationCheck[];
}) {
  const scene = getSearchSceneData(segment, query);
  const imagePath = scene.image.thumbnailPath ?? segment.thumbnailPath ?? scene.image.framePath;
  const domainSummary = getDomainSummary(segment);
  const textRows = [
    { label: "Speech", value: scene.text.speech },
    { label: "Subtitle", value: scene.text.subtitles.join(" ") },
    { label: "Screen", value: scene.text.screenText.join(" ") },
    { label: "Overlay", value: scene.text.overlays.join(" ") }
  ].filter((row) => row.value.trim().length > 0);
  const review = scene.text.comparisons?.find((item) => item.status !== "match");
  const ledger = buildEvidenceLedger(verification, reasons, [segment]);
  return (
    <>
      {imagePath ? <img src={mediaPath(imagePath) ?? ""} alt="" /> : <span className="result-image-placeholder">No image</span>}
      <span className="result-segment-copy">
        <strong>
          {formatDuration(segment.start)}-{formatDuration(segment.end)} · shot {segment.scene?.shotIndex ?? "-"}
        </strong>
        <TrustBadge ledger={ledger} compact />
        <span className="scene-evidence-grid">
          <span className="scene-evidence-block">
            <em>Image</em>
            <span>
              {scene.image.labels.length > 0 ? scene.image.labels.slice(0, 3).join(" · ") : "keyframe"}
              {scene.image.dominantColor ? ` · ${scene.image.dominantColor}` : ""}
            </span>
          </span>
          <span className="scene-evidence-block text">
            <em>Text</em>
            {textRows.length > 0 ? (
              textRows.slice(0, 2).map((row) => (
                <span key={row.label}>
                  <b>{row.label}</b> · {truncateText(row.value, 130)}
                </span>
              ))
            ) : (
              <span>No scene text extracted</span>
            )}
          </span>
          {domainSummary && (
            <span className="scene-evidence-block domain">
              <em>Domain</em>
              <span>{domainSummary}</span>
            </span>
          )}
          {scene.vision && (
            <span className="scene-evidence-block vision">
              <em>Vision</em>
              <span>
                pitch {Math.round(scene.vision.pitch.confidence * 100)}% · players {scene.vision.objects.players.status}
                {scene.vision.objects.ball.status === "estimated" || scene.vision.objects.ball.status === "detected" ? ` · ball ${scene.vision.objects.ball.status}` : ""}
                {scene.vision.fieldZone.zone !== "unknown" ? ` · ${scene.vision.fieldZone.zone}` : ""}
                {scene.vision.fieldCalibration ? ` · field ${scene.vision.fieldCalibration.status}/${scene.vision.fieldCalibration.method}` : ""}
                {scene.vision.tracking?.ballTrackId ? ` · ${scene.vision.tracking.ballTrackId}` : ""}
                {scene.vision.eventClassification && scene.vision.eventClassification.label !== "unknown" ? ` · ${scene.vision.eventClassification.label} ${Math.round(scene.vision.eventClassification.confidence * 100)}%` : ""}
              </span>
            </span>
          )}
          {review && (
            <span className={`scene-evidence-block compare ${review.status}`}>
              <em>Compare</em>
              <span>
                <b>{Math.round(review.similarity * 100)}%</b> · {review.status} · {truncateText(review.suggestedText, 90)}
              </span>
            </span>
          )}
          {reasons.length > 0 && (
            <span className="scene-evidence-reasons">
              {reasons.slice(0, 5).map((reason, index) => (
                <em key={`${reason.kind}-${reason.label}-${index}`} className={reason.kind}>
                  <b>{reason.label}</b>
                  {reason.value}
                  {typeof reason.confidence === "number" ? ` · ${Math.round(reason.confidence * 100)}%` : ""}
                </em>
              ))}
            </span>
          )}
          {verification.length > 0 && (
            <EvidenceLedgerCompact ledger={ledger} />
          )}
        </span>
      </span>
    </>
  );
}

export function ClipStrip({
  clips,
  onOpen,
  getHref
}: {
  clips: SearchResult["clips"];
  onOpen?: (clip: SearchResult["clips"][number]) => Promise<void>;
  getHref?: (clip: SearchResult["clips"][number]) => string;
}) {
  return (
    <div className="clip-strip">
      {clips.slice(0, 5).map((clip) => {
        const imagePath = clip.thumbnailPath ? mediaPath(clip.thumbnailPath) : null;
        const content = (
          <>
            {imagePath ? <img src={imagePath} alt="" /> : <span>No image</span>}
            <b>{clip.title}</b>
            <em>
              {clip.event}
              {clip.player ? ` · ${clip.player}` : ""} · {Math.round(clip.confidence * 100)}%
            </em>
            <small>
              pass {clip.verificationSummary.pass} · soft {clip.verificationSummary.softPass} · unknown {clip.verificationSummary.unknown} · fail {clip.verificationSummary.fail}
            </small>
          </>
        );
        const href = getHref?.(clip);
        return href ? (
          <a key={clip.id} href={href} target="_blank" rel="noreferrer">
            {content}
          </a>
        ) : (
          <button key={clip.id} type="button" onClick={() => void onOpen?.(clip)}>
            {content}
          </button>
        );
      })}
    </div>
  );
}

export function ClipDetailDrawer({
  detail,
  loading,
  onClose,
  onSeek
}: {
  detail: ClipDetailResult | null;
  loading: boolean;
  onClose: () => void;
  onSeek: (assetId: string, segmentId: string, at: number) => void;
}) {
  const imagePath = detail?.clip.thumbnailPath ? mediaPath(detail.clip.thumbnailPath) : null;
  const scene = detail ? getSearchSceneData(detail.segment, "") : null;
  const ledger = detail ? buildEvidenceLedger(detail.verification, detail.reasons, [detail.segment]) : null;
  return (
    <aside className="clip-detail-drawer" aria-label="Clip detail">
      <div className="clip-detail-header">
        <div>
          <p className="section-label">Clip Detail</p>
          <h2>{detail?.clip.title ?? "Loading clip"}</h2>
          {detail && <span>{detail.asset.title}</span>}
        </div>
        <button type="button" className="small-button icon-only" aria-label="닫기" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {loading && !detail ? (
        <div className="clip-detail-loading">
          <span className="search-loading-bar" />
          <p>Loading clip evidence.</p>
        </div>
      ) : detail ? (
        <>
          <button type="button" className="clip-detail-hero" onClick={() => onSeek(detail.clip.assetId, detail.clip.segmentId, detail.clip.start)}>
            {imagePath ? <img src={imagePath} alt="" /> : <span>No image</span>}
            <span>
              <b>{formatDuration(detail.clip.start)}-{formatDuration(detail.clip.end)}</b>
              <em>{detail.clip.event}{detail.clip.player ? ` · ${detail.clip.player}` : ""} · {Math.round(detail.clip.confidence * 100)}%</em>
            </span>
          </button>

          {ledger && <ClipUseSummary ledger={ledger} detail={detail} />}

          <section className="clip-detail-section">
            <div className="clip-section-title-row">
              <h3>Verification</h3>
              {ledger && <TrustBadge ledger={ledger} />}
            </div>
            {ledger ? <EvidenceLedgerPanel ledger={ledger} /> : <p>No structured verification checks for this clip.</p>}
          </section>

          <section className="clip-detail-section">
            <h3>Tracking</h3>
            <div className="clip-track-list">
              {detail.tracking.length > 0 ? detail.tracking.map((track) => (
                <article key={track.id}>
                  <strong>{track.trackType} · {track.trackId}</strong>
                  <span>{track.status} · {track.fieldZone} · {track.direction} · {Math.round(track.confidence * 100)}%</span>
                  <span>{track.player ?? "unresolved player"}{track.linkedTrackId ? ` · linked ${track.linkedTrackId}` : ""}</span>
                  {track.evidence.length > 0 && <em>{track.evidence.slice(0, 2).join(" · ")}</em>}
                </article>
              )) : <p>No tracking records persisted for this segment.</p>}
            </div>
          </section>

          <section className="clip-detail-section">
            <h3>Domain Events</h3>
            <div className="clip-event-list">
              {detail.domainEvents.length > 0 ? detail.domainEvents.map((event) => (
                <article key={event.id}>
                  <strong>{event.eventType}</strong>
                  <span>{event.caption}</span>
                  {event.football && <em>{event.football.fieldZone} · {event.football.passType} · {event.football.ball.state}</em>}
                </article>
              )) : <p>No domain event attached to this segment.</p>}
            </div>
          </section>

          <section className="clip-detail-section">
            <h3>Evidence</h3>
            <div className="clip-evidence-list">
              {detail.reasons.slice(0, 8).map((reason, index) => (
                <span key={`${reason.kind}-${reason.label}-${index}`}>
                  <b>{reason.label}</b>
                  {reason.value}
                  {typeof reason.confidence === "number" ? ` · ${Math.round(reason.confidence * 100)}%` : ""}
                </span>
              ))}
              {scene && (
                <>
                  {scene.text.speech && <span><b>Speech</b>{truncateText(scene.text.speech, 140)}</span>}
                  {scene.text.subtitles.length > 0 && <span><b>Subtitle</b>{truncateText(scene.text.subtitles.join(" "), 140)}</span>}
                  {scene.vision?.tracking?.ballTrackId && <span><b>Vision</b>{scene.vision.tracking.ballTrackId} · {scene.vision.tracking.nearestPlayerTrackId ?? "no player track"}</span>}
                </>
              )}
            </div>
          </section>
        </>
      ) : null}
    </aside>
  );
}
export function SignalEvidence({ asset }: { asset: AssetRecord }) {
  const asrSegments = asset.intelligence.asr.segments;
  const ocrFrames = asset.intelligence.ocr.frames;
  const speechSegments = asset.intelligence.audio?.speechSegments ?? [];
  const musicSegments = asset.intelligence.audio?.musicSegments ?? [];
  const speakerSegments = asset.intelligence.diarization?.segments ?? [];
  const domainEvents = asset.timeline.flatMap((segment) =>
    (segment.domain?.events ?? []).map((event) => ({
      segment,
      event
    }))
  );
  const vlmSegments = asset.timeline.filter((segment) => segment.domain?.vlm);
  const visionSegments = asset.timeline.filter((segment) => segment.sceneData?.vision);
  return (
    <section className="evidence-panel" aria-label="Extracted text evidence">
      <div className="subsection-heading">
        <p className="section-label">Evidence</p>
        <h3>Extracted signals and domain events</h3>
      </div>
      <div className="evidence-grid">
        <article className="evidence-card domain-evidence-card">
          <div className="evidence-title">
            <strong>Domain events</strong>
            <span>{domainEvents.length} candidates · {vlmSegments.length} VLM checks</span>
          </div>
          <div className="domain-event-list">
            {domainEvents.length === 0 && <span className="empty-inline">No domain event metadata was generated for this asset.</span>}
            {domainEvents.slice(0, 12).map(({ segment, event }) => (
              <article key={event.id} className="domain-event-row">
                <div>
                  <strong>{event.caption}</strong>
                  <span>
                    {formatDuration(segment.start)}-{formatDuration(segment.end)} · {event.domain} · {Math.round(event.confidence * 100)}%
                  </span>
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
            {vlmSegments
              .filter((segment) => segment.domain?.vlm?.status !== "refined" || (segment.domain?.events.length ?? 0) === 0)
              .slice(0, 8)
              .map((segment) => (
                <article key={`${segment.id}-vlm-quality`} className="domain-event-row">
                  <div>
                    <strong>VLM quality check</strong>
                    <span>
                      {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.domain?.vlm?.status} · {Math.round((segment.domain?.vlm?.confidence ?? 0) * 100)}%
                    </span>
                  </div>
                  <details className="domain-event-details" open>
                    <summary>Raw result</summary>
                    <p>{segment.domain?.vlm?.message}{segment.domain?.vlm?.error ? ` · ${segment.domain.vlm.error}` : ""}</p>
                    {segment.domain?.vlm?.rawResponse && <p>Raw VLM: {truncateText(segment.domain.vlm.rawResponse, 360)}</p>}
                  </details>
                </article>
              ))}
          </div>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>Vision evidence + field calibration</strong>
            <span>{visionSegments.length} segments</span>
          </div>
          <div className="segment-list compact-list">
            {visionSegments.length === 0 && <span>No vision evidence has been written for this asset.</span>}
            {visionSegments.slice(0, 12).map((segment) => {
              const vision = segment.sceneData?.vision;
              if (!vision) return null;
              return (
                <span key={`vision-${segment.id}`}>
                  {formatDuration(segment.start)}-{formatDuration(segment.end)} · pitch {Math.round(vision.pitch.confidence * 100)}% · players{" "}
                  {vision.objects.players.status}
                  {vision.objects.ball.status === "estimated" || vision.objects.ball.status === "detected" ? ` · ball ${vision.objects.ball.status}` : ""}
                  {vision.fieldZone.zone !== "unknown" ? ` · ${vision.fieldZone.zone}` : ""}
                  {vision.fieldCalibration ? ` · field ${vision.fieldCalibration.status}/${vision.fieldCalibration.method} ${Math.round(vision.fieldCalibration.zoneConfidence * 100)}%` : ""}
                  {vision.tracking?.ballTrackId ? ` · ${vision.tracking.ballTrackId}` : ""}
                  {vision.eventClassification && vision.eventClassification.label !== "unknown" ? ` · ${vision.eventClassification.label} ${Math.round(vision.eventClassification.confidence * 100)}%` : ""}
                </span>
              );
            })}
          </div>
        </article>

        <article className="evidence-card transcript-card">
          <div className="evidence-title">
            <strong>Audio extract + VAD</strong>
            <span>{speechSegments.length} speech · {musicSegments.length} music</span>
          </div>
          <div className="segment-list compact-list">
            {speechSegments.length === 0 && <span>No speech regions were detected.</span>}
            {speechSegments.map((segment) => (
              <span key={`speech-${segment.start}-${segment.end}`}>
                speech · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {Math.round(segment.confidence * 100)}%
              </span>
            ))}
            {musicSegments.map((segment) => (
              <span key={`music-${segment.start}-${segment.end}`}>
                music/noise bed · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {Math.round(segment.confidence * 100)}%
              </span>
            ))}
          </div>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>Whisper transcript</strong>
            <span>{asset.intelligence.asr.language} · {Math.round(asset.intelligence.asr.confidence * 100)}%</span>
          </div>
          <details className="evidence-disclosure">
            <summary>Show transcript</summary>
            <p className="transcript-box">{asset.intelligence.asr.transcript || "No speech text was extracted."}</p>
            <div className="segment-list compact-list">
              {asrSegments.length === 0 && <span>No timestamped ASR segments.</span>}
              {asrSegments.map((segment) => (
                <span key={`${segment.start}-${segment.end}-${segment.text}`}>
                  {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.text}
                </span>
              ))}
            </div>
          </details>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>WhisperX speakers</strong>
            <span>{asset.intelligence.diarization?.provider ?? "none"}</span>
          </div>
          <div className="segment-list compact-list">
            {speakerSegments.length === 0 && (
              <span>{asset.intelligence.diarization?.error ?? "No speaker diarization segments are available."}</span>
            )}
            {speakerSegments.map((segment) => (
              <span key={`${segment.speaker}-${segment.start}-${segment.end}-${segment.text}`}>
                {segment.speaker} · {formatDuration(segment.start)}-{formatDuration(segment.end)} · {segment.text}
              </span>
            ))}
          </div>
        </article>

        <article className="evidence-card">
          <div className="evidence-title">
            <strong>PaddleOCR tokens</strong>
            <span>{asset.intelligence.ocr.tokens.length} tokens · {Math.round(asset.intelligence.ocr.confidence * 100)}%</span>
          </div>
          <div className="ocr-token-list">
            {asset.intelligence.ocr.tokens.length === 0 && <span>No OCR text was extracted.</span>}
            {asset.intelligence.ocr.tokens.map((token) => (
              <span key={token}>{token}</span>
            ))}
          </div>
          <div className="ocr-frame-list">
            {ocrFrames.length === 0 && <span>No OCR frames are available.</span>}
            {ocrFrames.map((frame) => {
              const src = mediaPath(frame.framePath);
              return (
                <article key={frame.framePath || frame.tokens.join("-")} className="ocr-frame-card">
                  {src && <img src={src} alt="" />}
                  <div>
                    <strong>{Math.round(frame.confidence * 100)}%</strong>
                    <OcrRoleSummary boxes={frame.boxes ?? []} fallback={frame.tokens} />
                  </div>
                </article>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}

export function OcrRoleSummary({ boxes, fallback }: { boxes: OcrBox[]; fallback: string[] }) {
  if (boxes.length === 0) return <span>{fallback.length > 0 ? fallback.join(" · ") : "No text"}</span>;
  const groups = [
    ["subtitle", "Subtitle"],
    ["screen_text", "Screen"],
    ["overlay", "Overlay"],
    ["watermark", "Watermark"]
  ] as const;
  return (
    <span className="ocr-role-summary">
      {groups.map(([role, label]) => {
        const text = boxes
          .filter((box) => box.role === role)
          .map((box) => box.text)
          .join(" · ");
        return text ? (
          <em key={role}>
            {label} · {text}
          </em>
        ) : null;
      })}
    </span>
  );
}
