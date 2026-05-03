import type { AssetRecord, DomainQueryPlan, SearchResult, VerificationCheck } from "../shared/types";

export type EvidenceLedgerItem = {
  id: string;
  label: string;
  value: string;
  detail: string;
  confidence: number | null;
  status: "hard" | "soft" | "missing" | "failed" | "limitation";
};

export type EvidenceLedger = {
  score: number;
  label: "Verified" | "Review" | "Weak";
  tone: "verified" | "review" | "weak";
  summary: string;
  hard: EvidenceLedgerItem[];
  soft: EvidenceLedgerItem[];
  missing: EvidenceLedgerItem[];
  failed: EvidenceLedgerItem[];
  limitations: EvidenceLedgerItem[];
};

export type SearchTrustFilters = {
  verifiedOnly: boolean;
  includeSoft: boolean;
  hideFailed: boolean;
  minScore: number;
  requireHardPlayer: boolean;
  requireHardFieldZone: boolean;
};

export type TrustPreset = "broad" | "balanced" | "strict";

export const TRUST_PRESETS: Record<TrustPreset, SearchTrustFilters> = {
  broad: {
    verifiedOnly: false,
    includeSoft: true,
    hideFailed: false,
    minScore: 0,
    requireHardPlayer: false,
    requireHardFieldZone: false
  },
  balanced: {
    verifiedOnly: false,
    includeSoft: true,
    hideFailed: true,
    minScore: 0,
    requireHardPlayer: false,
    requireHardFieldZone: false
  },
  strict: {
    verifiedOnly: true,
    includeSoft: false,
    hideFailed: true,
    minScore: 70,
    requireHardPlayer: true,
    requireHardFieldZone: false
  }
};

export function trustPresetFor(filters: SearchTrustFilters): TrustPreset {
  if (filters.verifiedOnly && filters.minScore >= 70 && filters.requireHardPlayer) return "strict";
  if (!filters.hideFailed || filters.minScore === 0 && filters.includeSoft && !filters.verifiedOnly) return filters.hideFailed ? "balanced" : "broad";
  return "balanced";
}

export function labelForTrustPreset(preset: TrustPreset) {
  if (preset === "strict") return "Strict";
  if (preset === "broad") return "Broad";
  return "Balanced";
}

export function buildEvidenceLedger(
  verification: VerificationCheck[],
  reasons: SearchResult["matchReasons"],
  segments: Array<AssetRecord["timeline"][number]>
): EvidenceLedger {
  const hard: EvidenceLedgerItem[] = [];
  const soft: EvidenceLedgerItem[] = [];
  const missing: EvidenceLedgerItem[] = [];
  const failed: EvidenceLedgerItem[] = [];
  const limitations: EvidenceLedgerItem[] = [];

  for (const check of verification) {
    const item: EvidenceLedgerItem = {
      id: `check-${check.segmentId}-${check.constraint}-${check.expected}-${check.observed}`,
      label: readableConstraint(check.constraint),
      value: `${check.expected} -> ${check.observed}`,
      detail: check.evidence.filter(Boolean).slice(0, 2).join(" · ") || "No direct evidence text stored.",
      confidence: check.confidence,
      status: check.status === "pass" ? "hard" : check.status === "soft_pass" ? "soft" : check.status === "unknown" ? "missing" : "failed"
    };
    if (item.status === "hard") hard.push(item);
    if (item.status === "soft") soft.push(item);
    if (item.status === "missing") missing.push(item);
    if (item.status === "failed") failed.push(item);
  }

  for (const reason of reasons) {
    if (reason.kind === "limitation") {
      limitations.push({
        id: `reason-limit-${reason.segmentId}-${reason.label}-${reason.value}`,
        label: reason.label,
        value: reason.value,
        detail: "Model or pipeline limitation.",
        confidence: reason.confidence ?? null,
        status: "limitation"
      });
      continue;
    }
    if (!reason.confidence || reason.confidence < 0.7) continue;
    const item: EvidenceLedgerItem = {
      id: `reason-${reason.segmentId}-${reason.kind}-${reason.label}-${reason.value}`,
      label: reason.label,
      value: reason.value,
      detail: reason.kind.replace(/_/g, " "),
      confidence: reason.confidence,
      status: reason.kind === "visual" && reason.value.includes("estimated") ? "soft" : "hard"
    };
    if (item.status === "hard") hard.push(item);
    else soft.push(item);
  }

  for (const segment of segments) {
    const vision = segment.sceneData?.vision;
    const field = vision?.fieldCalibration;
    if (field && field.status !== "calibrated" && field.zone !== "unknown") {
      soft.push({
        id: `field-${segment.id}`,
        label: "Field calibration",
        value: `${field.zone} · ${field.status}/${field.method}`,
        detail: field.evidence.slice(0, 2).join(" · ") || "Estimated field zone.",
        confidence: field.zoneConfidence,
        status: "soft"
      });
      for (const limitation of field.limitations.slice(0, 2)) {
        limitations.push({
          id: `field-limit-${segment.id}-${limitation}`,
          label: "Field",
          value: limitation,
          detail: "Zone verification remains soft until calibrated.",
          confidence: null,
          status: "limitation"
        });
      }
    }

    const vlm = segment.domain?.vlm;
    if (vlm?.status === "refined") {
      soft.push({
        id: `vlm-${segment.id}`,
        label: "VLM",
        value: `${vlm.model} refined`,
        detail: vlm.message,
        confidence: vlm.confidence,
        status: "soft"
      });
    } else if (vlm?.status === "invalid" || vlm?.status === "failed") {
      failed.push({
        id: `vlm-${segment.id}`,
        label: "VLM",
        value: vlm.status,
        detail: vlm.error ?? vlm.message,
        confidence: vlm.confidence,
        status: "failed"
      });
    }

    for (const event of segment.domain?.events ?? []) {
      for (const limitation of event.football?.limitations.slice(0, 2) ?? []) {
        limitations.push({
          id: `domain-limit-${event.id}-${limitation}`,
          label: "Domain",
          value: limitation,
          detail: event.caption,
          confidence: event.confidence,
          status: "limitation"
        });
      }
    }
  }

  const deduped = {
    hard: dedupeLedgerItems(hard).slice(0, 12),
    soft: dedupeLedgerItems(soft).slice(0, 12),
    missing: dedupeLedgerItems(missing).slice(0, 12),
    failed: dedupeLedgerItems(failed).slice(0, 12),
    limitations: dedupeLedgerItems(limitations).slice(0, 12)
  };
  const score = calculateTrustScore(deduped);
  const label: EvidenceLedger["label"] = score >= 75 && deduped.failed.length === 0 ? "Verified" : score >= 45 ? "Review" : "Weak";
  const tone: EvidenceLedger["tone"] = label === "Verified" ? "verified" : label === "Review" ? "review" : "weak";
  return {
    ...deduped,
    score,
    label,
    tone,
    summary: `${deduped.hard.length} hard, ${deduped.soft.length} soft, ${deduped.missing.length} missing, ${deduped.failed.length} failed checks.`
  };
}

export function filterSearchResultsByTrust(results: SearchResult[], filters: SearchTrustFilters) {
  return results.filter((result) => {
    const ledger = buildEvidenceLedger(result.verification, result.matchReasons, result.segments);
    if (filters.verifiedOnly && ledger.tone !== "verified") return false;
    if (!filters.includeSoft && ledger.soft.length > 0) return false;
    if (filters.hideFailed && ledger.failed.length > 0) return false;
    if (ledger.score < filters.minScore) return false;
    if (filters.requireHardPlayer && !hasHardConstraint(ledger, "Player")) return false;
    if (filters.requireHardFieldZone && !hasHardConstraint(ledger, "Field zone")) return false;
    return true;
  });
}

function hasHardConstraint(ledger: EvidenceLedger, label: string) {
  const normalized = label.toLowerCase();
  return ledger.hard.some((item) => item.label.toLowerCase() === normalized);
}

export function buildSearchAssistantAnswer(results: SearchResult[], plan: DomainQueryPlan) {
  if (results.length === 0) {
    return "No indexed video moment matched this query. Try adding an event, player, season, or lowering the trust filters.";
  }
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  const top = results[0];
  const topLedger = buildEvidenceLedger(top.verification, top.matchReasons, top.segments);
  const player = plan.intent.player ? ` involving ${plan.intent.player}` : "";
  const event = plan.intent.eventType ? ` for ${plan.intent.eventType.replace(/_/g, " ")}` : "";
  return `I found ${segmentCount} indexed moments across ${results.length} assets${player}${event}. The top match is "${top.asset.title}" with ${topLedger.label.toLowerCase()} evidence (${topLedger.score}% trust).`;
}

function calculateTrustScore(ledger: Pick<EvidenceLedger, "hard" | "soft" | "missing" | "failed" | "limitations">) {
  const hard = ledger.hard.reduce((sum, item) => sum + (item.confidence ?? 0.75), 0);
  const soft = ledger.soft.reduce((sum, item) => sum + (item.confidence ?? 0.45) * 0.55, 0);
  const denominator = Math.max(1, ledger.hard.length + ledger.soft.length + ledger.missing.length + ledger.failed.length);
  const penalty = ledger.failed.length * 0.45 + ledger.missing.length * 0.16 + Math.min(0.18, ledger.limitations.length * 0.025);
  return Math.round(Math.max(0, Math.min(1, (hard + soft) / denominator - penalty)) * 100);
}

function dedupeLedgerItems(items: EvidenceLedgerItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.status}:${item.label}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readableConstraint(value: VerificationCheck["constraint"]) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}
