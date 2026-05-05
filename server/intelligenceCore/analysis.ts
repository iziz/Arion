import type { AnalysisResult, AssetRecord, ClipDetailResult, ClipResult, DomainQueryPlan, DomainSearchFilters, IndexRecord, SearchMatchReason, TimelineSegment, VerificationCheck } from "../../shared/types";
import { createAnalysisGenerator } from "../analysisGenerator";
import { expandDomainQuery, scoreDomainMatch } from "../domainIndex";
import { trustedDomainEvents } from "../evidenceTrust";
import { planDomainQueryWithLlm } from "../llmQueryPlanner";
import { resolveQueryRetrievalPlan } from "../queryRetrievalPlan";
import { listTrackingRecords } from "../trackingStore";
import { segmentSearchText, withSceneData } from "./sceneTimeline";
import { formatTime, unique } from "./textUtils";
import { buildSearchMatchReasons, buildVerificationChecks, clipFromSegment, matchesSegmentDomainFilters, scoreDomainFilterMatch, scoreSources, scoreText } from "./evidence";
import { searchAssets, selectKnowledgeEvidence } from "./search";

type AnalysisMoment = {
  asset: AssetRecord;
  segment: TimelineSegment;
  reasons: SearchMatchReason[];
  verification: VerificationCheck[];
};

type ScoredAnalysisMoment = AnalysisMoment & {
  evidenceScore: number;
  evidenceTier: AnalysisResult["evidence"]["tier"];
  hardChecks: number;
  softChecks: number;
  missingChecks: number;
  failedChecks: number;
};

export async function analyzeAsset(asset: AssetRecord, question = ""): Promise<AnalysisResult> {
  const queryPlan = await planDomainQueryWithLlm(question);
  const retrievalPlan = resolveQueryRetrievalPlan(queryPlan, question);
  const domainProfile = expandDomainQuery(retrievalPlan.textQuery);
  const queryTerms = retrievalPlan.evidenceTerms;
  const candidateMoments = asset.timeline
    .filter((segment) => matchesSegmentDomainFilters(asset, segment, queryPlan.domainFilters))
    .map((segment) => {
      const lexicalScore = scoreText(`${segment.transcript} ${segment.tags.join(" ")} ${segmentSearchText(segment)}`, queryTerms);
      const domainScore = scoreDomainMatch(segment, domainProfile);
      const filterScore = scoreDomainFilterMatch(asset, segment, queryPlan.domainFilters);
      const verification = buildVerificationChecks(asset, segment, queryPlan.domainFilters);
      const reasons = buildSearchMatchReasons(
        asset,
        segment,
        {
          lexicalScore,
          semanticScore: 0,
          visualScore: 0,
          domainScore
        },
        queryPlan.domainFilters,
        queryPlan,
        queryTerms
      );
      return {
        asset,
        segment,
        reasons,
        verification,
        score: lexicalScore * 2 + domainScore * 5 + filterScore * 6 + segment.confidence
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const fallbackMoments = question.trim()
    ? []
    : asset.timeline.slice(0, 12).map((segment) => ({
        asset,
        segment,
        reasons: [],
        verification: buildVerificationChecks(asset, segment, queryPlan.domainFilters)
      }));
  const evidencePlan = buildAnalysisEvidencePlan((candidateMoments.length > 0 ? candidateMoments : fallbackMoments).slice(0, 18));
  const analysisMoments = evidencePlan.included.slice(0, 6);
  const chapters = analysisMoments.map((moment) => moment.segment);
  const verification = analysisMoments.flatMap((moment) => moment.verification);
  const features = analysisMoments.map((moment) => featureFromSegment(moment.segment, moment.verification));
  const patterns = aggregatePatterns(features);
  const domainSignals = chapters.flatMap((segment) => [
    ...(segment.domain?.labels ?? []),
    ...(segment.domain?.scope?.players.map((player) => player.value) ?? []),
    segment.domain?.scope?.competition?.value ?? "",
    segment.domain?.scope?.season?.value ?? ""
  ]);
  const signals = unique([...(chapters.length > 0 ? asset.tags.slice(0, 6) : []), ...chapters.flatMap((segment) => segment.tags), ...domainSignals].filter(Boolean)).slice(0, 12);
  const clips = analysisMoments.map((moment) => clipFromSegment(moment.asset, withSceneData(moment.asset, moment.segment), moment.verification, moment.reasons));
  const generated = await createAnalysisGenerator().generate({
    question,
    asset,
    chapters,
    clips,
    signals,
    patterns,
    verification
  });
  const evidence = summarizeAnalysisEvidence(evidencePlan.scored, analysisMoments);

  return {
    assetId: asset.id,
    indexId: asset.indexId,
    scope: {
      type: "asset",
      label: asset.title,
      assetCount: 1
    },
    summary: buildEvidenceAwareSummary(generated.summary ?? asset.summary, evidence),
    answer: generated.answer,
    chapters,
    clips,
    signals,
    patterns,
    evidence,
    report: buildEvidenceAwareReport(generated.report, evidence),
    generator: generated.generator,
    generatedAt: new Date().toISOString()
  };
}

export async function analyzeAssetGroup(assets: AssetRecord[], indexes: IndexRecord[], index: IndexRecord, question = ""): Promise<AnalysisResult> {
  const scopedAssets = assets.filter((asset) => asset.indexId === index.id && (asset.status === "indexed" || asset.timeline.length > 0));
  const queryPlan = await planDomainQueryWithLlm(question);
  const searchResults = searchAssets(scopedAssets, indexes, question, {
    indexId: index.id,
    domainFilters: queryPlan.domainFilters,
    queryPlan,
    limit: 12
  });
  const scopedAssetById = new Map(scopedAssets.map((asset) => [asset.id, asset]));
  const moments: AnalysisMoment[] = searchResults
    .flatMap((result) => {
      const asset = scopedAssetById.get(result.asset.id);
      if (!asset) return [];
      return result.segments.map((segment) => ({
        asset,
        segment,
        reasons: result.matchReasons.filter((reason) => reason.segmentId === segment.id),
        verification: result.verification.filter((check) => check.segmentId === segment.id)
      }));
    })
    .slice(0, 18);
  const evidencePlan = buildAnalysisEvidencePlan(
    moments.map((moment) => ({
      ...moment,
      verification: moment.verification.length > 0 ? moment.verification : buildVerificationChecks(moment.asset, moment.segment, queryPlan.domainFilters)
    }))
  );
  const analysisMoments = evidencePlan.included.slice(0, 18);
  const chapters = analysisMoments.map((moment) => moment.segment);
  const verification = analysisMoments.flatMap((moment) => moment.verification);
  const features = analysisMoments.map((moment) => featureFromSegment(moment.segment, moment.verification));
  const patterns = aggregatePatterns(features);
  const signals = unique(
    [
      index.name,
      ...scopedAssets.flatMap((asset) => asset.tags),
      ...chapters.flatMap((segment) => segment.tags),
      ...chapters.flatMap((segment) => segment.domain?.labels ?? []),
      ...chapters.flatMap((segment) => segment.domain?.scope?.players.map((player) => player.value) ?? []),
      ...chapters.map((segment) => segment.domain?.scope?.competition?.value ?? ""),
      ...chapters.map((segment) => segment.domain?.scope?.season?.value ?? "")
    ].filter(Boolean)
  ).slice(0, 16);
  const clips = analysisMoments.map((moment) =>
    clipFromSegment(
      moment.asset,
      withSceneData(moment.asset, moment.segment),
      moment.verification,
      moment.reasons
    )
  );
  const subject = buildGroupAnalysisSubject(index, scopedAssets, chapters);
  const generated = await createAnalysisGenerator().generate({
    question,
    asset: subject,
    chapters,
    clips,
    signals,
    patterns,
    verification
  });
  const evidence = summarizeAnalysisEvidence(evidencePlan.scored, analysisMoments);
  return {
    assetId: `asset-group:${index.id}`,
    indexId: index.id,
    scope: {
      type: "asset_group",
      label: index.name,
      assetCount: scopedAssets.length
    },
    summary: buildEvidenceAwareSummary(generated.summary ?? subject.summary, evidence),
    answer: generated.answer,
    chapters,
    clips,
    signals,
    patterns,
    evidence,
    report: buildEvidenceAwareReport(generated.report, evidence),
    generator: generated.generator,
    generatedAt: new Date().toISOString()
  };
}

export function listAssetClips(asset: AssetRecord, filters?: DomainSearchFilters, queryPlan?: DomainQueryPlan): ClipResult[] {
  return asset.timeline.map((segment) => {
    const sceneSegment = withSceneData(asset, segment);
    const verification = buildVerificationChecks(asset, segment, filters);
    const reasons = buildSearchMatchReasons(
      asset,
      segment,
      {
        lexicalScore: 0,
        semanticScore: 0,
        visualScore: 0,
        domainScore: 0
      },
      filters,
      queryPlan
    );
    return clipFromSegment(asset, sceneSegment, verification, reasons);
  });
}

export async function buildClipDetail(asset: AssetRecord, segmentId: string, filters?: DomainSearchFilters, queryPlan?: DomainQueryPlan): Promise<ClipDetailResult | null> {
  const segment = asset.timeline.find((item) => item.id === segmentId);
  if (!segment) return null;
  const sceneSegment = withSceneData(asset, segment);
  const verification = buildVerificationChecks(asset, segment, filters);
  const reasons = buildSearchMatchReasons(
    asset,
    segment,
    {
      lexicalScore: 0,
      semanticScore: 0,
      visualScore: 0,
      domainScore: scoreDomainMatch(segment, expandDomainQuery(queryPlan?.semanticQuery ?? ""))
    },
    filters,
    queryPlan
  );
  return {
    clip: clipFromSegment(asset, sceneSegment, verification, reasons),
    asset: {
      id: asset.id,
      indexId: asset.indexId,
      title: asset.title,
      duration: asset.duration
    },
    segment: sceneSegment,
    verification,
    reasons,
    tracking: await listTrackingRecords({ assetId: asset.id, segmentId }),
    domainEvents: trustedDomainEvents(segment)
  };
}

function featureFromSegment(segment: TimelineSegment, verification: VerificationCheck[]) {
  const event = trustedDomainEvents(segment)[0];
  const football = event?.football;
  const americanFootball = event?.americanFootball;
  const vision = segment.sceneData?.vision;
  const receiverTrackId = football?.receivingPlayer.trackId ?? null;
  const passerTrackId = football?.passingPlayer.trackId ?? null;
  const quarterbackTrackId = americanFootball?.quarterback.trackId ?? null;
  const nearestPlayerTrackId = vision?.tracking?.nearestPlayerTrackId ?? null;
  const ballTrackId = vision?.tracking?.ballTrackId ?? null;
  const roleGrounding =
    receiverTrackId || passerTrackId || quarterbackTrackId
      ? "structured_event"
      : nearestPlayerTrackId && ballTrackId
        ? vision?.tracking?.version ?? "tracking_v0"
        : "unknown_grounding";
  return {
    segmentId: segment.id,
    player:
      football?.receivingPlayer.identity?.name ??
      football?.passingPlayer.identity?.name ??
      americanFootball?.quarterback.identity?.name ??
      segment.domain?.scope?.players[0]?.value ??
      "unknown_player",
    competition: segment.domain?.scope?.competition?.value ?? "unknown_competition",
    season: segment.domain?.scope?.season?.value ?? "unknown_season",
    eventType: event?.eventType ?? "unknown_event",
    passType: football?.passType ?? americanFootball?.playType ?? "unknown_pass",
    fieldZone: football?.fieldZone ?? americanFootball?.pocket.status ?? "unknown_zone",
    role: football?.receivingPlayer.present
      ? "receiver"
      : football?.passingPlayer.present
        ? "passer"
        : event?.eventType === "shot"
          ? "shooter"
          : americanFootball?.quarterback.present
            ? "quarterback"
            : "unknown_role",
    roleGrounding,
    playerTrackId: receiverTrackId ?? passerTrackId ?? quarterbackTrackId ?? nearestPlayerTrackId ?? "unknown_player_track",
    ballTrackId: ballTrackId ?? "unknown_ball_track",
    ballDirection: vision?.tracking?.ballMovement.direction ?? "unknown_direction",
    ballState: football?.ball.state ?? americanFootball?.decision.outcome ?? "unknown_ball",
    confidence: event?.confidence ?? segment.confidence,
    verification
  };
}

function buildGroupAnalysisSubject(index: IndexRecord, assets: AssetRecord[], chapters: TimelineSegment[]): AssetRecord {
  const base = assets[0];
  const now = new Date().toISOString();
  if (base) {
    return {
      ...base,
      id: `asset-group:${index.id}`,
      indexId: index.id,
      title: index.name,
      description: index.description,
      summary: `Asset group analysis across ${assets.length} indexed assets and ${chapters.length} retrieved moments.`,
      timeline: chapters,
      keyframes: base.keyframes.filter((keyframe) => chapters.some((segment) => segment.id === keyframe.segmentId)),
      updatedAt: now
    };
  }
  return {
    id: `asset-group:${index.id}`,
    indexId: index.id,
    title: index.name,
    description: index.description,
    originalName: index.name,
    storedName: "",
    mimeType: "application/octet-stream",
    size: 0,
    duration: null,
    width: null,
    height: null,
    status: "indexed",
    progress: 100,
    tags: [],
    summary: "Asset group analysis has no indexed assets available.",
    timeline: chapters,
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "analysis",
      objectKey: index.id,
      checksum: null,
      frameRate: null,
      audioCodec: null,
      videoCodec: null
    },
    intelligence: {
      audio: { extractedPath: null, vad: { available: false, provider: "none", error: null }, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
      asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0, frames: [] },
      visual: { available: false, labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0, error: null },
      modelTrace: []
    },
    error: null,
    createdAt: now,
    updatedAt: now
  };
}

function aggregatePatterns(features: ReturnType<typeof featureFromSegment>[]): AnalysisResult["patterns"] {
  const verification = features.flatMap((feature) => feature.verification);
  const topGroups = [
    ...topFeatureGroups(features, "fieldZone", "Zone"),
    ...topFeatureGroups(features, "passType", "Pass"),
    ...topFeatureGroups(features, "eventType", "Event"),
    ...topFeatureGroups(features, "player", "Player"),
    ...topFeatureGroups(features, "season", "Season"),
    ...topFeatureGroups(features, "roleGrounding", "Role grounding"),
    ...topFeatureGroups(features, "ballDirection", "Ball direction")
  ]
    .filter((group) => !group.key.startsWith("unknown_"))
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, 8);
  const gaps = [
    features.some((feature) => feature.player === "unknown_player") ? "Some moments have no resolved player identity." : "",
    features.some((feature) => feature.season === "unknown_season") ? "Some moments have no season scope." : "",
    features.some((feature) => feature.competition === "unknown_competition") ? "Some moments have no competition scope." : "",
    features.some((feature) => feature.playerTrackId === "unknown_player_track") ? "Some moments have no player track grounding." : "",
    features.some((feature) => feature.ballTrackId === "unknown_ball_track") ? "Some moments have no ball track grounding." : "",
    verification.some((check) => check.status === "fail") ? "Some retrieved moments failed structured verification." : "",
    verification.some((check) => check.status === "unknown") ? "Some constraints are missing indexed evidence." : ""
  ].filter(Boolean);
  return {
    totalMoments: features.length,
    verifiedConstraints: verification.filter((check) => check.status === "pass").length,
    uncertainConstraints: verification.filter((check) => check.status === "soft_pass" || check.status === "unknown").length,
    failedConstraints: verification.filter((check) => check.status === "fail").length,
    topGroups,
    gaps
  };
}

function buildAnalysisEvidencePlan(moments: AnalysisMoment[]) {
  const scored = moments.map(scoreAnalysisMoment).sort((a, b) => b.evidenceScore - a.evidenceScore);
  const included = scored.filter((moment) => moment.evidenceTier !== "weak" && moment.failedChecks === 0);
  return {
    scored,
    included
  };
}

function scoreAnalysisMoment(moment: AnalysisMoment): ScoredAnalysisMoment {
  const hardChecks = moment.verification.filter((check) => check.status === "pass").length;
  const softChecks = moment.verification.filter((check) => check.status === "soft_pass").length;
  const missingChecks = moment.verification.filter((check) => check.status === "unknown").length;
  const failedChecks = moment.verification.filter((check) => check.status === "fail").length;
  const hardConfidence = moment.verification
    .filter((check) => check.status === "pass")
    .reduce((sum, check) => sum + check.confidence, 0);
  const structuredEventBoost = trustedDomainEvents(moment.segment).length ? 12 : 0;
  const trackingBoost = moment.segment.sceneData?.vision?.tracking ? 8 : 0;
  const sourceBoost = Math.min(10, Math.round(scoreSources(moment.segment.sources) * 3));
  const base = moment.verification.length > 0 ? 35 : Math.round(moment.segment.confidence * 70);
  const rawEvidenceScore = clampScore(
    base +
      hardChecks * 14 +
      Math.round(hardConfidence * 18) +
      structuredEventBoost +
      trackingBoost +
      sourceBoost -
      missingChecks * 11 -
      failedChecks * 28
  );
  const evidenceScore = clampScore(Math.min(rawEvidenceScore, failedChecks > 0 ? 44 : missingChecks > 0 ? 60 : softChecks > 0 ? 74 : 100));
  const evidenceTier: AnalysisResult["evidence"]["tier"] =
    evidenceScore >= 75 && hardChecks > 0 && softChecks === 0 && missingChecks === 0 && failedChecks === 0 ? "verified" : evidenceScore >= 45 && failedChecks === 0 ? "review" : "weak";
  return {
    ...moment,
    evidenceScore,
    evidenceTier,
    hardChecks,
    softChecks,
    missingChecks,
    failedChecks
  };
}

function summarizeAnalysisEvidence(scored: ScoredAnalysisMoment[], included: AnalysisMoment[]): AnalysisResult["evidence"] {
  const includedIds = new Set(included.map((moment) => `${moment.asset.id}:${moment.segment.id}`));
  const includedScored = scored.filter((moment) => includedIds.has(`${moment.asset.id}:${moment.segment.id}`));
  const hardChecks = includedScored.reduce((sum, moment) => sum + moment.hardChecks, 0);
  const softChecks = includedScored.reduce((sum, moment) => sum + moment.softChecks, 0);
  const missingChecks = includedScored.reduce((sum, moment) => sum + moment.missingChecks, 0);
  const failedChecks = includedScored.reduce((sum, moment) => sum + moment.failedChecks, 0);
  const trustScore = includedScored.length > 0 ? Math.round(includedScored.reduce((sum, moment) => sum + moment.evidenceScore, 0) / includedScored.length) : 0;
  const tier: AnalysisResult["evidence"]["tier"] =
    trustScore >= 75 && hardChecks > 0 && softChecks === 0 && missingChecks === 0 && failedChecks === 0 ? "verified" : trustScore >= 45 && failedChecks === 0 ? "review" : "weak";
  const confirmedPatterns = buildEvidencePatternBullets(includedScored.filter((moment) => moment.evidenceTier === "verified")).slice(0, 5);
  const likelyPatterns = buildEvidencePatternBullets(includedScored.filter((moment) => moment.evidenceTier === "review")).slice(0, 5);
  const weakMoments = scored.filter((moment) => !includedIds.has(`${moment.asset.id}:${moment.segment.id}`));
  const needsReview = unique([
    ...includedScored
      .filter((moment) => moment.softChecks > 0)
      .flatMap((moment) => moment.verification.filter((check) => check.status === "soft_pass").map((check) => `${check.constraint} uses soft evidence for ${moment.segment.label}.`)),
    ...weakMoments
      .slice(0, 5)
      .map((moment) => `${moment.segment.label} was excluded from analysis because trust score was ${moment.evidenceScore}%.`)
  ]).slice(0, 6);
  const missingEvidence = unique(
    scored.flatMap((moment) =>
      moment.verification
        .filter((check) => check.status === "unknown" || check.status === "fail")
        .map((check) => `${check.constraint}: expected ${check.expected}, observed ${check.observed}.`)
    )
  ).slice(0, 6);
  const limitations = unique([
    includedScored.some((moment) => moment.segment.sceneData?.vision?.fieldCalibration?.status !== "calibrated") ? "Field zone findings may rely on estimated calibration, not pitch homography." : "",
    includedScored.some((moment) => moment.segment.sceneData?.vision?.tracking?.status !== "tracked") ? "Player and ball grounding may use estimated tracking rather than verified track identity." : "",
    includedScored.some((moment) => moment.segment.domain?.vlm?.status !== "refined") ? "Some scene descriptions still use local heuristics instead of refined VLM evidence." : "",
    missingEvidence.length > 0 ? "Missing or failed checks are excluded from confirmed claims." : "",
    includedScored.length === 0 && scored.length > 0 ? "No retrieved moments met the minimum evidence threshold for analysis." : ""
  ].filter(Boolean)).slice(0, 6);
  return {
    trustScore,
    tier,
    hardChecks,
    softChecks,
    missingChecks,
    failedChecks,
    includedMoments: includedScored.length,
    excludedMoments: Math.max(0, scored.length - includedScored.length),
    confirmedPatterns,
    likelyPatterns,
    needsReview,
    missingEvidence,
    limitations
  };
}

function buildEvidencePatternBullets(moments: ScoredAnalysisMoment[]) {
  return unique(
    moments.map((moment) => {
      const feature = featureFromSegment(moment.segment, moment.verification);
      const playerCheck = moment.verification.find((check) => check.constraint === "player");
      const fieldZoneCheck = moment.verification.find((check) => check.constraint === "fieldZone");
      const player =
        playerCheck?.status === "pass"
          ? playerCheck.observed
          : playerCheck
            ? "player identity review"
            : feature.player !== "unknown_player"
              ? feature.player
              : "";
      const fieldZone =
        fieldZoneCheck?.status === "pass"
          ? fieldZoneCheck.observed
          : fieldZoneCheck?.status === "soft_pass"
            ? `${fieldZoneCheck.expected.replace(/_/g, " ")} (estimated)`
            : fieldZoneCheck
              ? "field zone review"
              : feature.fieldZone !== "unknown_zone"
                ? feature.fieldZone.replace(/_/g, " ")
                : "";
      const parts = [
        player,
        feature.role !== "unknown_role" ? feature.role : "",
        feature.passType !== "unknown_pass" ? feature.passType.replace(/_/g, " ") : "",
        feature.eventType !== "unknown_event" ? feature.eventType.replace(/_/g, " ") : "",
        fieldZone,
        feature.season !== "unknown_season" ? feature.season : ""
      ].filter(Boolean);
      return parts.length > 0 ? `${parts.join(" · ")} (${formatTime(moment.segment.start)}-${formatTime(moment.segment.end)})` : `${moment.segment.label} (${formatTime(moment.segment.start)}-${formatTime(moment.segment.end)})`;
    })
  );
}

function buildEvidenceAwareSummary(summary: string, evidence: AnalysisResult["evidence"]) {
  const prefix = `Evidence ${evidence.tier} (${evidence.trustScore}%) from ${evidence.includedMoments} included moments`;
  const excluded = evidence.excludedMoments > 0 ? `; ${evidence.excludedMoments} low-trust moments excluded` : "";
  return `${prefix}${excluded}. ${summary}`;
}

function buildEvidenceAwareReport(report: AnalysisResult["report"], evidence: AnalysisResult["evidence"]): AnalysisResult["report"] {
  const evidenceSections: AnalysisResult["report"]["sections"] = [
    {
      heading: "Confirmed Patterns",
      body: evidence.confirmedPatterns.length > 0 ? "These claims are backed by hard verification checks." : "No pattern currently has enough hard evidence to be treated as confirmed.",
      bullets: evidence.confirmedPatterns.length > 0 ? evidence.confirmedPatterns : ["No confirmed pattern available."]
    },
    {
      heading: "Likely Patterns",
      body: evidence.likelyPatterns.length > 0 ? "These claims are useful but rely on soft or partial evidence." : "No likely pattern was separated from the retrieved moments.",
      bullets: evidence.likelyPatterns.length > 0 ? evidence.likelyPatterns : ["No likely pattern available."]
    },
    {
      heading: "Needs Review",
      body: evidence.needsReview.length > 0 ? "These moments or constraints should be checked before editorial use." : "No review-only warnings were produced.",
      bullets: evidence.needsReview.length > 0 ? evidence.needsReview : ["No review-only warning available."]
    },
    {
      heading: "Missing Evidence",
      body: evidence.missingEvidence.length > 0 ? "The index could not ground these constraints with current data." : "No missing or failed constraint evidence was found in included moments.",
      bullets: evidence.missingEvidence.length > 0 ? evidence.missingEvidence : ["No missing evidence item available."]
    },
    {
      heading: "Data Limitations",
      body: "Analysis is bounded by the indexed evidence and current sports-domain extraction quality.",
      bullets: evidence.limitations.length > 0 ? evidence.limitations : ["No major indexed limitation was detected."]
    }
  ];
  const generatorSections = report.sections.filter((section) => !evidenceSections.some((item) => item.heading === section.heading));
  return {
    ...report,
    confidence: Number(Math.min(report.confidence, evidence.trustScore > 0 ? evidence.trustScore / 100 : 0).toFixed(2)),
    sections: [...evidenceSections, ...generatorSections],
    limitations: unique([...evidence.limitations, ...report.limitations])
  };
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function topFeatureGroups(
  features: ReturnType<typeof featureFromSegment>[],
  key: "player" | "competition" | "season" | "eventType" | "passType" | "fieldZone" | "role" | "roleGrounding" | "ballDirection",
  label: string
) {
  const groups = new Map<string, { count: number; confidence: number }>();
  for (const feature of features) {
    const value = feature[key];
    const current = groups.get(value) ?? { count: 0, confidence: 0 };
    groups.set(value, {
      count: current.count + 1,
      confidence: current.confidence + feature.confidence
    });
  }
  return Array.from(groups.entries()).map(([value, group]) => ({
    key: value,
    label: `${label}: ${value.replace(/_/g, " ")}`,
    count: group.count,
    share: features.length > 0 ? Number((group.count / features.length).toFixed(2)) : 0,
    confidence: Number((group.confidence / Math.max(1, group.count)).toFixed(2)),
    tier: group.confidence / Math.max(1, group.count) >= 0.75 ? "confirmed" : group.confidence / Math.max(1, group.count) >= 0.45 ? "likely" : "review"
  })) satisfies AnalysisResult["patterns"]["topGroups"];
}
