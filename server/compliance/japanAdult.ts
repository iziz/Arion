import type { AssetComplianceCheck, AssetComplianceRecord, AssetRecord, IndexRecord } from "../../shared/types";

export const japanAdultKnowledgeSourceId = "adult.jp_legal" as const;

export const japanAdultRequiredTags = [
  "jp-adult:age-verified",
  "jp-adult:performer-id-verified",
  "jp-adult:consent-contract",
  "jp-adult:contract-explained",
  "jp-adult:cooling-period-1m",
  "jp-adult:publication-delay-4m",
  "jp-adult:performer-preview",
  "jp-adult:revocation-window-tracked",
  "jp-adult:takedown-ready",
  "jp-adult:mosaic-reviewed",
  "jp-adult:rights-documented"
] as const;

const explicitBlockTags = [
  "jp-adult:block:minor-risk",
  "jp-adult:block:age-unverified",
  "jp-adult:block:consent-withdrawn",
  "jp-adult:block:takedown-requested",
  "jp-adult:block:unmosaiced",
  "jp-adult:block:illegal-source"
] as const;

const reviewTerms = [
  "under 18",
  "underage",
  "minor",
  "child",
  "juvenile",
  "未成年",
  "児童",
  "18歳未満",
  "年齢未確認",
  "同意撤回",
  "削除請求",
  "配信停止",
  "モザイクなし",
  "無修正"
];

export function isJapanLegalAdultIndex(index: Pick<IndexRecord, "domainIndexing"> | null | undefined) {
  return Boolean(index?.domainIndexing?.enabled && index.domainIndexing.groups.includes(japanAdultKnowledgeSourceId));
}

export function evaluateJapanAdultCompliance(
  asset: Pick<AssetRecord, "title" | "description" | "originalName" | "tags" | "summary" | "timeline" | "intelligence">,
  index: Pick<IndexRecord, "domainIndexing"> | null | undefined,
  now = new Date().toISOString()
): AssetComplianceRecord {
  if (!isJapanLegalAdultIndex(index)) {
    return {
      jurisdiction: "JP",
      domainGroup: japanAdultKnowledgeSourceId,
      status: "not_applicable",
      summary: "Japan legal adult content compliance is not enabled for this asset group.",
      checkedAt: now,
      checks: [],
      blockers: [],
      requiredTags: [...japanAdultRequiredTags],
      references: complianceReferences()
    };
  }

  const tags = new Set(asset.tags.map((tag) => tag.trim().toLowerCase()));
  const explicitBlockers = explicitBlockTags.filter((tag) => tags.has(tag));
  const textEvidence = collectTextEvidence(asset);
  const reviewIndicators = reviewTerms.filter((term) => textEvidence.normalized.includes(term.toLowerCase()));
  const checks = buildChecks(tags, explicitBlockers, reviewIndicators);
  const criticalBlockers = checks.filter((check) => check.status === "blocked").map((check) => check.label);
  const missing = checks.filter((check) => check.status === "missing" || check.status === "review");
  const status = criticalBlockers.length > 0 ? "blocked" : missing.length > 0 ? "review_required" : "metadata_complete";

  return {
    jurisdiction: "JP",
    domainGroup: japanAdultKnowledgeSourceId,
    status,
    summary: complianceSummary(status, criticalBlockers.length, missing.length),
    checkedAt: now,
    checks,
    blockers: criticalBlockers,
    requiredTags: [...japanAdultRequiredTags],
    references: complianceReferences()
  };
}

export function japanAdultComplianceTrace(compliance: AssetComplianceRecord) {
  if (compliance.status === "not_applicable") return "";
  const missing = compliance.checks.filter((check) => check.status === "missing").length;
  const review = compliance.checks.filter((check) => check.status === "review").length;
  const blocked = compliance.checks.filter((check) => check.status === "blocked").length;
  return `compliance:adult.jp_legal:${compliance.status}:missing=${missing}:review=${review}:blocked=${blocked}`;
}

export function isAssetSearchableByCompliance(asset: Pick<AssetRecord, "compliance">) {
  const compliance = asset.compliance;
  return !compliance || compliance.status === "not_applicable" || compliance.status === "metadata_complete";
}

export function assetComplianceSearchBlockReason(asset: Pick<AssetRecord, "compliance">) {
  return isAssetSearchableByCompliance(asset) ? null : `compliance:${asset.compliance?.domainGroup}:${asset.compliance?.status}`;
}

function buildChecks(tags: Set<string>, explicitBlockers: readonly string[], reviewIndicators: string[]): AssetComplianceCheck[] {
  const checks: AssetComplianceCheck[] = [
    requiredTagCheck(tags, "performer-age", "Performer age verification", "Verified records show all performers are 18 or older.", "jp-adult:age-verified"),
    requiredTagCheck(tags, "performer-id", "Performer identity verification", "Performer identity records are present and linked to the release package.", "jp-adult:performer-id-verified"),
    requiredTagCheck(tags, "consent-contract", "Consent and performance agreement", "A signed performance agreement and consent record exist.", "jp-adult:consent-contract"),
    requiredTagCheck(tags, "contract-explanation", "Contract explanation record", "The performer received contract documents and an explanation record.", "jp-adult:contract-explained"),
    requiredTagCheck(tags, "one-month-shooting-wait", "One-month shooting wait", "Shooting did not occur within one month after contract/explanation document delivery.", "jp-adult:cooling-period-1m"),
    requiredTagCheck(tags, "four-month-publication-wait", "Four-month publication wait", "Publication did not occur within four months after all shooting ended.", "jp-adult:publication-delay-4m"),
    requiredTagCheck(tags, "pre-publication-preview", "Pre-publication performer preview", "The performer had an opportunity to preview recorded footage before publication.", "jp-adult:performer-preview"),
    requiredTagCheck(tags, "revocation-window", "Revocation window tracking", "The publication workflow tracks the statutory voluntary cancellation window.", "jp-adult:revocation-window-tracked"),
    requiredTagCheck(tags, "takedown-readiness", "Takedown and stop-distribution readiness", "The operator can stop sales/distribution when cancellation, rescission, or no-contract publication is asserted.", "jp-adult:takedown-ready"),
    requiredTagCheck(tags, "article-175-review", "Article 175 mosaic/obscenity review", "A Japan distribution review for Article 175 exposure has been completed.", "jp-adult:mosaic-reviewed"),
    requiredTagCheck(tags, "rights-documentation", "Studio and distribution rights", "Source, studio, distribution, and storage rights are documented.", "jp-adult:rights-documented")
  ];

  if (explicitBlockers.length > 0) {
    checks.push({
      id: "explicit-block-tags",
      label: "Explicit compliance block tag",
      status: "blocked",
      severity: "critical",
      requirement: "Assets with explicit block tags must not be searchable or distributed until reviewed and corrected.",
      evidence: explicitBlockers.map((tag) => `tag:${tag}`),
      source: "metadata"
    });
  }

  if (reviewIndicators.length > 0) {
    checks.push({
      id: "risk-terms",
      label: "Review terms detected",
      status: "review",
      severity: "warning",
      requirement: "Potential age, consent, takedown, or uncensored-distribution terms require human compliance review.",
      evidence: reviewIndicators.map((term) => `term:${term}`),
      source: "system"
    });
  }

  return checks;
}

function requiredTagCheck(tags: Set<string>, id: string, label: string, requirement: string, tag: typeof japanAdultRequiredTags[number]): AssetComplianceCheck {
  const passed = tags.has(tag);
  return {
    id,
    label,
    status: passed ? "passed" : "missing",
    severity: passed ? "info" : "critical",
    requirement,
    evidence: passed ? [`tag:${tag}`] : [],
    source: "metadata"
  };
}

function collectTextEvidence(asset: Pick<AssetRecord, "title" | "description" | "originalName" | "tags" | "summary" | "timeline" | "intelligence">) {
  const values = [
    asset.title,
    asset.description,
    asset.originalName,
    asset.summary,
    ...asset.tags,
    asset.intelligence.asr.transcript,
    ...asset.intelligence.ocr.tokens,
    ...asset.timeline.flatMap((segment) => [
      segment.label,
      segment.summary ?? "",
      segment.transcript,
      segment.sceneData?.text.speech ?? "",
      ...(segment.sceneData?.text.subtitles ?? []),
      ...(segment.sceneData?.text.screenText ?? []),
      ...(segment.sceneData?.text.overlays ?? [])
    ])
  ].filter(Boolean);
  return {
    raw: values,
    normalized: values.join(" ").toLowerCase()
  };
}

function complianceSummary(status: AssetComplianceRecord["status"], blockers: number, missing: number) {
  if (status === "metadata_complete") return "Required Japan adult content review metadata is present; this is not a legal clearance.";
  if (status === "blocked") return `${blockers} critical compliance blocker(s) require removal or legal review before use.`;
  return `${missing} metadata check(s) require review before this asset should be searchable.`;
}

function complianceReferences() {
  return [
    {
      label: "Cabinet Office AV performance harm prevention and relief law summary",
      url: "https://www.gender.go.jp/policy/no_violence/avjk/houritsu.html"
    },
    {
      label: "Japanese Penal Code Article 175",
      url: "https://www.japaneselawtranslation.go.jp/en/laws/view/3581/en"
    },
    {
      label: "Child prostitution and child pornography protection act",
      url: "https://www.japaneselawtranslation.go.jp/en/laws/view/100/en"
    }
  ];
}
