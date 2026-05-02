import type { AssetRecord, DomainEvent, DomainScope, DomainScopeValue, IndexRecord, PlayerIdentity, TimelineSegment } from "../shared/types";
import { matchCompetition, matchKnowledgePlayers, matchTeams } from "./sportsKnowledge";

const ONTOLOGY_VERSION = "sports-domain-v1";

type DomainQueryProfile = {
  expandedText: string;
  domains: string[];
  labels: string[];
  football: {
    fieldZones: NonNullable<DomainEvent["football"]>["fieldZone"][];
    passTypes: NonNullable<DomainEvent["football"]>["passType"][];
    eventTypes: string[];
    receiverRequired: boolean;
    playerRequired: boolean;
  };
};

type OntologyRule = {
  label: string;
  terms: string[];
  aliases: string[];
};

const footballRules = {
  domain: {
    label: "sports.football",
    terms: [
      "football",
      "soccer",
      "축구",
      "fifa",
      "uefa",
      "premier league",
      "bundesliga",
      "champions league",
      "haaland",
      "striker",
      "keeper",
      "goalkeeper",
      "goal",
      "shot",
      "pass",
      "cross",
      "offside",
      "spielzug",
      "tor",
      "stürmer",
      "stuermer"
    ],
    aliases: ["football", "soccer", "축구"]
  },
  passTypes: [
    {
      label: "pass.through_ball",
      terms: [
        "through ball",
        "through-ball",
        "스루패스",
        "스루 패스",
        "침투패스",
        "침투 패스",
        "killer pass",
        "ball in behind",
        "pass in behind",
        "in die tiefe",
        "über die spitze",
        "ueber die spitze",
        "over the top"
      ],
      aliases: ["through ball", "스루패스", "침투패스"]
    },
    {
      label: "pass.cross",
      terms: ["cross", "크로스", "flanke", "wide delivery"],
      aliases: ["cross", "크로스"]
    },
    {
      label: "pass.cutback",
      terms: ["cutback", "cut back", "컷백", "pull back"],
      aliases: ["cutback", "컷백"]
    },
    {
      label: "pass.long_ball",
      terms: ["long ball", "롱볼", "long pass", "diagonal ball"],
      aliases: ["long ball", "롱볼"]
    },
    {
      label: "pass.short_pass",
      terms: ["short pass", "패스", "pass", "passes", "passing", "ball"],
      aliases: ["pass", "패스"]
    }
  ] satisfies OntologyRule[],
  eventTypes: [
    {
      label: "event.pass_receive",
      terms: [
        "receive",
        "receives",
        "received",
        "receiver",
        "receiving",
        "first touch",
        "controls",
        "takes",
        "latch onto",
        "gets on the end",
        "받는",
        "받아",
        "받았다",
        "리시브",
        "연결",
        "annahme",
        "annimmt",
        "bekommt"
      ],
      aliases: ["receive", "receiver", "받는 선수"]
    },
    {
      label: "event.shot",
      terms: ["shot", "shoots", "finish", "finishes", "슈팅", "슛", "마무리", "abschluss"],
      aliases: ["shot", "슛"]
    },
    {
      label: "event.dribble",
      terms: ["dribble", "dribbles", "dribbling", "take on", "takes on", "carry", "carries", "드리블", "돌파", "운반"],
      aliases: ["dribble", "드리블"]
    },
    {
      label: "event.progressive_pass",
      terms: ["progressive pass", "line breaking pass", "breaks the line", "전진 패스", "라인 브레이킹", "라인브레이킹"],
      aliases: ["progressive pass", "전진 패스"]
    },
    {
      label: "event.save",
      terms: ["save", "saves", "keeper save", "goalkeeper save", "선방", "세이브"],
      aliases: ["save", "선방"]
    },
    {
      label: "event.pressure",
      terms: ["pressure", "under pressure", "pressured", "압박", "pressure situation"],
      aliases: ["pressure", "압박"]
    },
    {
      label: "event.scramble",
      terms: ["scramble", "scrambles", "scramble play", "스크램블"],
      aliases: ["scramble", "스크램블"]
    },
    {
      label: "event.pocket_escape",
      terms: ["pocket escape", "escapes the pocket", "out of the pocket", "포켓 탈출"],
      aliases: ["pocket escape", "포켓 탈출"]
    },
    {
      label: "event.throw_on_run",
      terms: ["throw on the run", "throws on the run", "rolling right", "rolling left", "이동 중 패스"],
      aliases: ["throw on the run"]
    }
  ] satisfies OntologyRule[],
  fieldZones: [
    {
      label: "zone.final_third",
      terms: ["final third", "attacking third", "파이널 서드", "공격 진영", "공격 지역", "last third", "letzte drittel"],
      aliases: ["final third", "attacking third", "파이널 서드"]
    },
    {
      label: "zone.penalty_area",
      terms: ["penalty area", "box", "six yard", "박스", "페널티 박스", "goal area", "strafraum"],
      aliases: ["penalty area", "box", "박스"]
    },
    {
      label: "zone.middle_third",
      terms: ["middle third", "midfield", "미드필드", "중원", "mittelfeld"],
      aliases: ["middle third", "midfield", "중원"]
    },
    {
      label: "zone.defensive_third",
      terms: ["defensive third", "own third", "수비 진영", "수비 지역"],
      aliases: ["defensive third", "수비 진영"]
    }
  ] satisfies OntologyRule[],
  phase: {
    attack: ["attack", "attacking", "counter", "counterattack", "break", "chance", "찬스", "역습", "공격", "spielzug"],
    setPiece: ["corner", "free kick", "set piece", "코너킥", "프리킥"]
  }
};

export function buildDomainSegmentIndex(asset: AssetRecord, index: IndexRecord, segment: TimelineSegment): TimelineSegment["domain"] | undefined {
  if (!isSportsDomainIndexingEnabled(index)) return undefined;
  const text = collectSegmentText(asset, index, segment);
  const normalized = normalizeText(text);
  const domainMatches = matchingTerms(normalized, footballRules.domain.terms);
  const passMatches = footballRules.passTypes.flatMap((rule) => matchingTerms(normalized, rule.terms));
  const eventMatches = footballRules.eventTypes.flatMap((rule) => matchingTerms(normalized, rule.terms));
  const footballCueCount = domainMatches.length + passMatches.length + eventMatches.length;
  const hasSpecificFootballCue = passMatches.some((term) => term !== "ball" && term !== "pass") || domainMatches.some((term) => term !== "shot" && term !== "pass");
  const isFootball = index.domainIndexing?.groups.includes("sports.football") && (footballCueCount >= 2 || hasSpecificFootballCue);
  if (!isFootball) return undefined;

  const event = buildFootballEvent(asset, segment, normalized, domainMatches);
  const scope = inferFootballScope(asset, segment);
  const stageLabels = stageLabelsForIndex(index);
  const labels = unique([footballRules.domain.label, ...event.labels, ...scopeLabels(scope), ...stageLabels]);
  const captions = [event.caption];
  const searchText = [
    "Domain: sports football soccer 축구.",
    scope.competition ? `Competition: ${scope.competition.value}.` : "",
    scope.season ? `Season: ${scope.season.value}.` : "",
    scope.teams.length > 0 ? `Teams: ${scope.teams.map((item) => item.value).join(", ")}.` : "",
    scope.players.length > 0 ? `Players: ${scope.players.map((item) => item.value).join(", ")}.` : "",
    `Caption: ${event.caption}`,
    `Labels: ${labels.join(" ")}`,
    event.football
      ? [
          `Event: ${readableLabel(event.eventType)}.`,
          `Pass type: ${readableLabel(event.football.passType)}.`,
          `Field zone: ${readableLabel(event.football.fieldZone)}.`,
          event.football.receivingPlayer.present ? "Receiver: receiving player receiver present 받는 선수." : "Receiver: unknown.",
          event.football.receivingPlayer.identity ? `Receiver identity: ${event.football.receivingPlayer.identity.name}.` : "",
          event.football.passingPlayer.identity ? `Passing player identity: ${event.football.passingPlayer.identity.name}.` : "",
          event.football.ball.state !== "unknown" ? `Ball state: ${readableLabel(event.football.ball.state)}.` : ""
        ].join(" ")
      : ""
  ]
    .filter(Boolean)
    .join(" ");

  return {
    groups: ["sports.football"],
    captions,
    labels,
    events: [event],
    scope,
    searchText,
    confidence: event.confidence,
    generatedBy: "domain-ontology-heuristic-v1"
  };
}

export function isSportsDomainIndexingEnabled(index: IndexRecord) {
  return Boolean(index.domainIndexing?.enabled && index.domainIndexing.groups.includes("sports.football"));
}

export function enrichTimelineWithDomain(asset: AssetRecord, index: IndexRecord): TimelineSegment[] {
  return asset.timeline.map((segment) => withDomainSegment(asset, index, segment));
}

export function withDomainSegment(asset: AssetRecord, index: IndexRecord, segment: TimelineSegment): TimelineSegment {
  const domain = segment.domain ?? buildDomainSegmentIndex(asset, index, segment);
  if (!domain) return segment;
  const domainTagText = domain.labels.flatMap((label) => [label, readableLabel(label)]).join(" ");
  return {
    ...segment,
    domain,
    tags: unique([...segment.tags, ...domain.labels, ...extractLightKeywords(domainTagText)]).slice(0, 32),
    sources: unique([...segment.sources, "domain" as const])
  };
}

export function expandDomainQuery(query: string): DomainQueryProfile {
  const normalized = normalizeText(query);
  const labels: string[] = [];
  const domains: string[] = [];
  const fieldZones: DomainQueryProfile["football"]["fieldZones"] = [];
  const passTypes: DomainQueryProfile["football"]["passTypes"] = [];
  const eventTypes: string[] = [];

  if (matchingTerms(normalized, [...footballRules.domain.terms, "final third", "through ball", "스루패스", "받는 선수"]).length > 0) {
    domains.push("sports.football");
    labels.push("sports.football");
  }

  for (const rule of footballRules.passTypes) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    passTypes.push(passTypeFromLabel(rule.label));
  }
  for (const rule of footballRules.fieldZones) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    fieldZones.push(fieldZoneFromLabel(rule.label));
  }
  for (const rule of footballRules.eventTypes) {
    if (matchingTerms(normalized, [...rule.terms, ...rule.aliases]).length === 0) continue;
    labels.push(rule.label, ...rule.aliases);
    eventTypes.push(eventTypeFromLabel(rule.label));
  }

  const receiverRequired = matchingTerms(normalized, footballRules.eventTypes[0].terms).length > 0 || /받는\s*선수|receiver|receiving player/.test(normalized);
  const playerRequired = receiverRequired || /선수|player/.test(normalized);
  const expandedText = unique([
    query,
    ...labels,
    ...labels.map(readableLabel),
    receiverRequired ? "receive receiver receiving player 받는 선수" : "",
    passTypes.includes("through_ball") ? "through ball 스루패스 침투패스 ball in behind in die tiefe ueber die spitze" : "",
    fieldZones.includes("final_third") ? "final third attacking third 파이널 서드 공격 진영" : "",
    domains.includes("sports.football") ? "football soccer 축구" : ""
  ])
    .filter(Boolean)
    .join(" ");

  return {
    expandedText,
    domains: unique(domains),
    labels: unique(labels),
    football: {
      fieldZones: unique(fieldZones).filter((zone) => zone !== "unknown"),
      passTypes: unique(passTypes).filter((passType) => passType !== "unknown"),
      eventTypes: unique(eventTypes),
      receiverRequired,
      playerRequired
    }
  };
}

export function domainSearchText(segment: TimelineSegment) {
  if (!segment.domain) return "";
  return [segment.domain.searchText, ...segment.domain.captions, ...segment.domain.labels].filter(Boolean).join(" ");
}

export function scoreDomainMatch(segment: TimelineSegment, profile: DomainQueryProfile) {
  if (!segment.domain || profile.labels.length === 0) return 0;
  let score = 0;
  const labels = new Set(segment.domain.labels);
  for (const domain of profile.domains) {
    if (segment.domain.groups.includes(domain) || labels.has(domain)) score += 1.25;
  }
  for (const label of profile.labels) {
    if (labels.has(label)) score += 1;
  }
  for (const event of segment.domain.events) {
    const football = event.football;
    if (!football) continue;
    if (profile.football.eventTypes.includes(event.eventType)) score += 1.4;
    if (profile.football.passTypes.includes(football.passType)) score += 1.6;
    if (profile.football.fieldZones.includes(football.fieldZone)) score += 1.2;
    if (profile.football.fieldZones.includes("final_third") && football.fieldZone === "penalty_area") score += 0.8;
    if (profile.football.receiverRequired && football.receivingPlayer.present) score += 1.2;
    score += Math.min(1.2, event.confidence);
  }
  return Number(score.toFixed(3));
}

function buildFootballEvent(asset: AssetRecord, segment: TimelineSegment, normalized: string, domainMatches: string[]): DomainEvent {
  const passRule = bestRule(footballRules.passTypes, normalized);
  const eventRule = bestRule(footballRules.eventTypes, normalized);
  const explicitZoneRule = bestRule(footballRules.fieldZones, normalized);
  const visual = segment.sceneData?.vision;
  const classifier = visual?.eventClassification;
  let passType = passRule ? passTypeFromLabel(passRule.rule.label) : passTypeFromClassifier(classifier?.label);
  let eventType = eventRule ? eventTypeFromLabel(eventRule.rule.label) : eventTypeFromClassifier(classifier?.label, passType);
  if (classifier?.label === "shot") {
    eventType = "shot";
    passType = passType === "unknown" ? "unknown" : passType;
  }
  if (passType !== "unknown" && eventType === "shot") {
    eventType = "pass_receive";
  }
  const textFieldZone = inferFieldZone(normalized, explicitZoneRule?.rule.label, passType);
  const fieldZone = textFieldZone === "unknown" && visual?.fieldZone.zone ? visual.fieldZone.zone : textFieldZone;
  const phase = inferPhase(normalized);
  const receiverPresent = eventType === "pass_receive" || passType === "through_ball" || Boolean(classifier?.label.endsWith("_receive")) || Boolean(visual?.proximity?.ballNearPlayer);
  const passerPresent = passType !== "unknown";
  const ballState = eventRule?.rule.label.endsWith("shot") || classifier?.label === "shot" ? "shot" : passType !== "unknown" ? "pass_travel" : "unknown";
  const playerIdentity = inferPlayerIdentity(asset, segment);
  const evidenceAsr = snippets(segment.sceneData?.text.speech || segment.transcript);
  const evidenceOcr = [
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? [])
  ].slice(0, 4);
  const evidenceVisual = [
    ...(segment.sceneData?.image.labels ?? asset.intelligence.visual.labels),
    visual?.pitch.present ? `pitch estimated ${Math.round(visual.pitch.confidence * 100)}%` : "",
    visual && isObjectEvidenceReady(visual.objects.players.status) ? `players ${visual.objects.players.status} ${visual.objects.players.countEstimate}` : "",
    visual && isObjectEvidenceReady(visual.objects.ball.status) ? `ball ${visual.objects.ball.status} ${Math.round(visual.objects.ball.confidence * 100)}%` : "",
    visual && visual.fieldZone.zone !== "unknown" ? `visual zone ${visual.fieldZone.zone}` : "",
    visual?.tracking?.ballTrackId ? `ball track ${visual.tracking.ballTrackId}` : "",
    visual?.tracking?.nearestPlayerTrackId ? `nearest player track ${visual.tracking.nearestPlayerTrackId}` : "",
    classifier && classifier.label !== "unknown" ? `event classifier ${classifier.label} ${Math.round(classifier.confidence * 100)}%` : ""
  ].filter(Boolean);
  const heuristics = [
    passRule ? `Matched pass ontology: ${passRule.matches.join(", ")}` : "",
    eventRule ? `Matched event ontology: ${eventRule.matches.join(", ")}` : "",
    explicitZoneRule ? `Matched field zone ontology: ${explicitZoneRule.matches.join(", ")}` : "",
    classifier && classifier.label !== "unknown" ? `Event classifier v1 selected ${classifier.label} with rules: ${classifier.rules.join("; ")}` : "",
    playerIdentity ? `Player identity v0 inferred ${playerIdentity.name} from ${playerIdentity.source}` : "",
    !explicitZoneRule && textFieldZone !== "unknown" ? `Inferred field zone from attacking/pass context: ${fieldZone}` : "",
    textFieldZone === "unknown" && visual?.fieldZone.zone !== "unknown" ? `Estimated field zone from vision evidence v0: ${visual?.fieldZone.zone}` : "",
    visual?.pitch.present ? `Vision evidence v0 estimated pitch presence: ${Math.round(visual.pitch.confidence * 100)}%` : "",
    visual?.eventCandidates[0]?.reason ?? "",
    visual?.tracking?.status === "tracked" ? `Tracking v0 linked ${visual.tracking.ballTrackId ?? "ball"} to ${visual.tracking.nearestPlayerTrackId ?? "no player"} with continuity ${visual.tracking.continuity}` : "",
    "Player, ball, and field geometry are estimated until detector/tracker stages are configured."
  ].filter(Boolean);
  const labels = unique([
    eventType !== "scene" ? `event.${eventType}` : "",
    passType !== "unknown" ? `pass.${passType}` : "",
    fieldZone !== "unknown" ? `zone.${fieldZone}` : "",
    receiverPresent ? "role.receiver" : "",
    playerIdentity ? `player.${normalizeLabel(playerIdentity.name)}` : "",
    classifier && classifier.label !== "unknown" ? `classifier.${classifier.label}` : "",
    ballState !== "unknown" ? `ball.${ballState}` : "",
    phase !== "unknown" ? `phase.${phase}` : ""
  ].filter(Boolean));
  const confidence = calculateFootballConfidence({
    passRuleMatches: passRule?.matches.length ?? 0,
    eventRuleMatches: eventRule?.matches.length ?? 0,
    fieldZone,
    explicitZone: Boolean(explicitZoneRule),
    receiverPresent,
    asrConfidence: asset.intelligence.asr.confidence,
    visualLabelCount: evidenceVisual.length,
    motionScore: asset.intelligence.visual.motionScore,
    visionConfidence: visual ? Math.max(visual.pitch.confidence, visual.fieldZone.confidence, visual.objects.players.confidence, visual.objects.ball.confidence, visual.tracking?.continuity ?? 0, classifier?.confidence ?? 0) : 0
  });
  const caption = buildFootballCaption(eventType, passType, fieldZone, receiverPresent, confidence);

  return {
    id: `${segment.id}-domain-football-1`,
    domain: "sports.football",
    ontologyVersion: ONTOLOGY_VERSION,
    caption,
    eventType,
    labels,
    confidence,
    evidence: {
      asr: evidenceAsr,
      ocr: evidenceOcr,
      visual: evidenceVisual.slice(0, 6),
      metadata: domainMatches.slice(0, 6),
      heuristics
    },
    football: {
      phase,
      fieldZone,
      passType,
      receivingPlayer: {
        present: receiverPresent,
        confidence: receiverPresent ? confidenceFromSignals(confidence, eventRule ? 0.15 : -0.1) : 0,
        trackId: visual?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: receiverPresent && visual?.objects.players.status === "detected" ? "detected" : receiverPresent && visual?.objects.players.status === "estimated" ? "estimated" : "not_configured",
        identity: receiverPresent ? playerIdentity : null
      },
      passingPlayer: {
        present: passerPresent,
        confidence: passerPresent ? confidenceFromSignals(confidence, 0) : 0,
        trackId: visual?.tracking?.nearestPlayerTrackId ?? null,
        trackingStatus: passerPresent && visual?.objects.players.status === "detected" ? "detected" : passerPresent && visual?.objects.players.status === "estimated" ? "estimated" : "not_configured",
        identity: passerPresent && !receiverPresent ? playerIdentity : null
      },
      ball: {
        state: ballState,
        confidence: ballState !== "unknown" ? confidenceFromSignals(confidence, isObjectEvidenceReady(visual?.objects.ball.status) ? 0.04 : -0.08) : 0,
        trackingStatus: ballState !== "unknown" && visual?.tracking?.ballTrackId ? "detected" : ballState !== "unknown" && visual?.objects.ball.status === "detected" ? "detected" : ballState !== "unknown" && visual?.objects.ball.status === "estimated" ? "estimated" : "not_configured"
      },
      field: {
        calibrationStatus: visual?.fieldZone.method === "detector" ? "estimated" : visual?.fieldZone.method === "color_motion_heuristic" ? "estimated" : "not_configured",
        attackingDirection: "unknown",
        zoneConfidence: fieldZone === "unknown" ? 0 : confidenceFromSignals(confidence, explicitZoneRule ? 0.05 : visual?.fieldZone.confidence ? -0.02 : -0.18)
      },
      limitations: [
        "Vision evidence v0 estimates pitch/player/ball cues from detector boxes and fallback heuristics.",
        "Tracking v0 links boxes by nearest centers; it is not stable player identity re-id.",
        "Player identity v0 is text-derived from title/ASR/OCR/metadata, not visual face or jersey recognition.",
        "Field zone is ontology/ASR/vision-heuristic derived unless a future calibration stage writes homography."
      ]
    }
  };
}

function stageLabelsForIndex(index: IndexRecord) {
  return (index.domainIndexing?.stages ?? []).map((stage) => `stage.${stage}`);
}

function collectSegmentText(asset: AssetRecord, index: IndexRecord, segment: TimelineSegment) {
  const sceneText = segment.sceneData?.text;
  return [
    asset.title,
    asset.description,
    asset.originalName,
    asset.tags.join(" "),
    segment.label,
    segment.transcript,
    sceneText?.speech,
    ...(sceneText?.subtitles ?? []),
    ...(sceneText?.screenText ?? []),
    ...(sceneText?.overlays ?? []),
    ...(segment.sceneData?.image.labels ?? asset.intelligence.visual.labels),
    segment.sceneData?.vision?.pitch.present ? "football pitch green field" : "",
    isObjectEvidenceReady(segment.sceneData?.vision?.objects.players.status) ? `players ${segment.sceneData?.vision?.objects.players.status}` : "",
    isObjectEvidenceReady(segment.sceneData?.vision?.objects.ball.status) ? `ball ${segment.sceneData?.vision?.objects.ball.status}` : "",
    segment.sceneData?.vision?.fieldZone.zone !== "unknown" ? segment.sceneData?.vision?.fieldZone.zone : "",
    segment.sceneData?.vision?.eventClassification && segment.sceneData.vision.eventClassification.label !== "unknown" ? segment.sceneData.vision.eventClassification.label : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function inferFootballScope(asset: AssetRecord, segment: TimelineSegment): DomainScope {
  const sources = scopeSources(asset, segment);
  const competition = inferCompetitionScopeValue(sources);
  const season = inferSeasonScopeValue(sources);
  const teams = inferTeamScopeValues(sources).slice(0, 4);
  const knownPlayers = inferPlayerScopeValues(sources).slice(0, 5);
  const identity = inferPlayerIdentity(asset, segment);
  const players = mergeScopeValues(
    knownPlayers,
    identity
      ? [
          {
            value: identity.name,
            confidence: Math.max(0.42, identity.confidence),
            source: identity.source === "query" ? "metadata" : identity.source,
            evidence: identity.evidence
          } satisfies DomainScopeValue
        ]
      : []
  ).slice(0, 6);

  return {
    competition,
    season,
    teams,
    players
  };
}

function scopeSources(asset: AssetRecord, segment: TimelineSegment): Array<{ source: DomainScopeValue["source"]; text: string; confidence: number }> {
  const sceneText = segment.sceneData?.text;
  return [
    { source: "title", text: [asset.title, asset.originalName].filter(Boolean).join(" "), confidence: 0.78 },
    { source: "metadata", text: [asset.description, asset.tags.join(" "), asset.summary].filter(Boolean).join(" "), confidence: 0.66 },
    { source: "asr", text: [segment.transcript, sceneText?.speech].filter(Boolean).join(" "), confidence: 0.62 },
    { source: "ocr", text: [...(sceneText?.subtitles ?? []), ...(sceneText?.screenText ?? []), ...(sceneText?.overlays ?? [])].join(" "), confidence: 0.56 }
  ];
}

function inferCompetitionScopeValue(sources: Array<{ source: DomainScopeValue["source"]; text: string; confidence: number }>): DomainScopeValue | null {
  for (const source of sources) {
    const match = matchCompetition(source.text);
    if (!match) continue;
    return {
      value: match.value,
      confidence: Math.max(source.confidence, match.confidence),
      source: "knowledge",
      evidence: match.evidence
    };
  }
  return null;
}

function inferTeamScopeValues(sources: Array<{ source: DomainScopeValue["source"]; text: string; confidence: number }>): DomainScopeValue[] {
  return mergeScopeValues(
    ...sources.map((source) =>
      matchTeams(source.text).map((match) => ({
        value: match.value,
        confidence: Math.max(source.confidence, match.confidence),
        source: "knowledge" as const,
        evidence: match.evidence
      }))
    )
  ).sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}

function inferPlayerScopeValues(sources: Array<{ source: DomainScopeValue["source"]; text: string; confidence: number }>): DomainScopeValue[] {
  return mergeScopeValues(
    ...sources.map((source) =>
      matchKnowledgePlayers(source.text).map((match) => ({
        value: match.value.canonical,
        confidence: Math.max(source.confidence, match.confidence),
        source: "knowledge" as const,
        evidence: match.evidence
      }))
    )
  ).sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}

function inferSeasonScopeValue(sources: Array<{ source: DomainScopeValue["source"]; text: string; confidence: number }>): DomainScopeValue | null {
  for (const source of sources) {
    const range = source.text.match(/\b(20\d{2})\s*[-/]\s*(\d{2}|20\d{2})\b/);
    const year = source.text.match(/\b(20\d{2})\b/);
    const value = range ? `${range[1]}-${range[2]}` : year?.[1];
    if (!value) continue;
    return {
      value,
      confidence: range ? source.confidence : Number(Math.max(0.35, source.confidence - 0.16).toFixed(2)),
      source: source.source,
      evidence: snippets(source.text).slice(0, 2)
    };
  }
  return null;
}

function mergeScopeValues(...groups: DomainScopeValue[][]) {
  const byValue = new Map<string, DomainScopeValue>();
  for (const value of groups.flat()) {
    const key = normalizeText(value.value);
    const existing = byValue.get(key);
    if (!existing || value.confidence > existing.confidence) {
      byValue.set(key, value);
    }
  }
  return Array.from(byValue.values());
}

function scopeLabels(scope: DomainScope) {
  return [
    scope.competition ? `competition.${normalizeLabel(scope.competition.value)}` : "",
    scope.season ? `season.${normalizeLabel(scope.season.value)}` : "",
    ...scope.teams.map((team) => `team.${normalizeLabel(team.value)}`),
    ...scope.players.map((player) => `player.${normalizeLabel(player.value)}`)
  ].filter(Boolean);
}

function bestRule(rules: OntologyRule[], normalized: string) {
  const matches = rules
    .map((rule) => ({ rule, matches: matchingTerms(normalized, rule.terms) }))
    .filter((item) => item.matches.length > 0)
    .sort((a, b) => b.matches.length - a.matches.length || b.rule.terms[0].length - a.rule.terms[0].length);
  return matches[0] ?? null;
}

function matchingTerms(normalized: string, terms: string[]) {
  return unique(terms.filter((term) => normalized.includes(normalizeText(term))));
}

function inferFieldZone(normalized: string, explicitLabel: string | undefined, passType: NonNullable<DomainEvent["football"]>["passType"]) {
  if (explicitLabel) return fieldZoneFromLabel(explicitLabel);
  if (matchingTerms(normalized, footballRules.fieldZones[1].terms).length > 0) return "penalty_area";
  const attackingCues = ["goal", "keeper", "goalkeeper", "shot", "finish", "chance", "assist", "box", "tor", "abschluss", "찬스", "슈팅", "골"];
  if (passType === "through_ball" && matchingTerms(normalized, attackingCues).length > 0) return "final_third";
  if (passType === "through_ball") return "final_third";
  if (matchingTerms(normalized, footballRules.fieldZones[2].terms).length > 0) return "middle_third";
  if (matchingTerms(normalized, footballRules.fieldZones[3].terms).length > 0) return "defensive_third";
  return "unknown";
}

function inferPhase(normalized: string): NonNullable<DomainEvent["football"]>["phase"] {
  if (matchingTerms(normalized, footballRules.phase.setPiece).length > 0) return "set_piece";
  if (matchingTerms(normalized, footballRules.phase.attack).length > 0) return "attack";
  if (matchingTerms(normalized, ["transition", "turnover", "역습", "counter"]).length > 0) return "transition";
  return "unknown";
}

function isObjectEvidenceReady(status?: "not_configured" | "estimated" | "detected" | "not_detected") {
  return status === "estimated" || status === "detected";
}

function calculateFootballConfidence(options: {
  passRuleMatches: number;
  eventRuleMatches: number;
  fieldZone: NonNullable<DomainEvent["football"]>["fieldZone"];
  explicitZone: boolean;
  receiverPresent: boolean;
  asrConfidence: number;
  visualLabelCount: number;
  motionScore: number;
  visionConfidence: number;
}) {
  let confidence = 0.28;
  confidence += Math.min(0.24, options.passRuleMatches * 0.12);
  confidence += Math.min(0.16, options.eventRuleMatches * 0.08);
  confidence += options.fieldZone === "unknown" ? 0 : options.explicitZone ? 0.16 : 0.08;
  confidence += options.receiverPresent ? 0.08 : 0;
  confidence += Math.min(0.12, Math.max(0, options.asrConfidence) * 0.12);
  confidence += Math.min(0.04, options.visualLabelCount * 0.01);
  confidence += Math.min(0.04, Math.max(0, options.motionScore) * 0.04);
  confidence += Math.min(0.08, Math.max(0, options.visionConfidence) * 0.1);
  return Number(Math.min(0.86, confidence).toFixed(2));
}

function buildFootballCaption(
  eventType: string,
  passType: NonNullable<DomainEvent["football"]>["passType"],
  fieldZone: NonNullable<DomainEvent["football"]>["fieldZone"],
  receiverPresent: boolean,
  confidence: number
) {
  const parts = ["Football"];
  if (eventType !== "scene") parts.push(readableLabel(eventType));
  if (passType !== "unknown") parts.push(`via ${readableLabel(passType)}`);
  if (fieldZone !== "unknown") parts.push(`in ${readableLabel(fieldZone)}`);
  if (receiverPresent) parts.push("with an inferred receiving player");
  parts.push(`candidate (${Math.round(confidence * 100)}% confidence)`);
  return parts.join(" ");
}

function confidenceFromSignals(base: number, delta: number) {
  return Number(Math.max(0, Math.min(0.95, base + delta)).toFixed(2));
}

function passTypeFromClassifier(label?: string): NonNullable<DomainEvent["football"]>["passType"] {
  if (label === "through_ball_receive") return "through_ball";
  if (label === "cross_receive") return "cross";
  if (label === "cutback_receive") return "cutback";
  return "unknown";
}

function eventTypeFromClassifier(label: string | undefined, passType: NonNullable<DomainEvent["football"]>["passType"]) {
  if (label === "shot") return "shot";
  if (label === "carry" || label === "dribble" || label === "progressive_pass" || label === "save" || label === "pressure" || label === "scramble" || label === "pocket_escape" || label === "throw_on_run") return label;
  if (label?.endsWith("_receive") || passType !== "unknown") return "pass_receive";
  return "scene";
}

function passTypeFromLabel(label: string): NonNullable<DomainEvent["football"]>["passType"] {
  if (label.endsWith("through_ball")) return "through_ball";
  if (label.endsWith("cross")) return "cross";
  if (label.endsWith("cutback")) return "cutback";
  if (label.endsWith("long_ball")) return "long_ball";
  if (label.endsWith("short_pass")) return "short_pass";
  return "unknown";
}

function fieldZoneFromLabel(label: string): NonNullable<DomainEvent["football"]>["fieldZone"] {
  if (label.endsWith("final_third")) return "final_third";
  if (label.endsWith("penalty_area")) return "penalty_area";
  if (label.endsWith("middle_third")) return "middle_third";
  if (label.endsWith("defensive_third")) return "defensive_third";
  return "unknown";
}

function eventTypeFromLabel(label: string) {
  if (label.endsWith("pass_receive")) return "pass_receive";
  if (label.endsWith("shot")) return "shot";
  if (label.endsWith("dribble")) return "dribble";
  if (label.endsWith("progressive_pass")) return "progressive_pass";
  if (label.endsWith("save")) return "save";
  if (label.endsWith("pressure")) return "pressure";
  if (label.endsWith("scramble")) return "scramble";
  if (label.endsWith("pocket_escape")) return "pocket_escape";
  if (label.endsWith("throw_on_run")) return "throw_on_run";
  return "scene";
}

function readableLabel(value: string) {
  return value.replace(/^[^.]+\./, "").replace(/_/g, " ");
}

function normalizeLabel(value: string) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippets(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = cleaned.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  return (sentences.length ? sentences : [cleaned]).slice(0, 3).map((item) => item.slice(0, 220));
}

function inferPlayerIdentity(asset: AssetRecord, segment: TimelineSegment): PlayerIdentity | null {
  const sceneText = segment.sceneData?.text;
  const sources: Array<{ source: PlayerIdentity["source"]; text: string; confidence: number }> = [
    { source: "asr", text: [segment.transcript, sceneText?.speech].filter(Boolean).join(" "), confidence: 0.74 },
    { source: "ocr", text: [...(sceneText?.subtitles ?? []), ...(sceneText?.screenText ?? []), ...(sceneText?.overlays ?? [])].join(" "), confidence: 0.62 },
    { source: "title", text: [asset.title, asset.originalName].filter(Boolean).join(" "), confidence: 0.58 },
    { source: "metadata", text: [asset.description, asset.tags.join(" ")].filter(Boolean).join(" "), confidence: 0.5 }
  ];

  for (const source of sources) {
    if (!source.text.trim()) continue;
    const player = matchKnowledgePlayers(source.text)[0];
    if (!player) continue;
    return {
      name: player.value.canonical,
      confidence: Math.max(source.confidence, player.confidence),
      source: "knowledge",
      evidence: player.evidence
    };
  }

  return null;
}

function extractLightKeywords(value: string) {
  return unique(
    value
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .map((term) => term.trim().replace(/^-+|-+$/g, ""))
      .filter((term) => term.length > 2)
  );
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}
