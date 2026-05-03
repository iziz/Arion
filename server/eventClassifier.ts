import type { TimelineSegment, VisionEvidence } from "../shared/types";

type EventLabel = NonNullable<VisionEvidence["eventClassification"]>["label"];

const classifierRules: Array<{
  label: EventLabel;
  textTerms: string[];
  receiverTerms?: string[];
  eventCandidate?: string;
}> = [
  {
    label: "through_ball_receive",
    textTerms: ["through ball", "ball in behind", "pass in behind", "in behind", "스루패스", "스루 패스", "침투패스", "침투 패스", "über die spitze", "ueber die spitze", "in die tiefe"],
    receiverTerms: ["receive", "receives", "received", "receiver", "receiving", "받는", "받아", "받았다", "리시브", "control", "first touch"],
    eventCandidate: "pass_receive"
  },
  {
    label: "cross_receive",
    textTerms: ["cross", "crosses", "크로스", "flank", "flanke"],
    receiverTerms: ["receive", "header", "headed", "finish", "받는", "헤더", "마무리"],
    eventCandidate: "pass_receive"
  },
  {
    label: "cutback_receive",
    textTerms: ["cutback", "cut back", "컷백", "pull back"],
    receiverTerms: ["receive", "finish", "tap in", "받는", "마무리"],
    eventCandidate: "pass_receive"
  },
  {
    label: "shot",
    textTerms: ["shot", "shoot", "finish", "goal", "골", "슛", "슈팅", "마무리", "abschluss", "tor"],
    eventCandidate: "shot"
  },
  {
    label: "dribble",
    textTerms: ["dribble", "dribbles", "dribbling", "take on", "takes on", "carry", "carries", "드리블", "돌파", "운반"],
    eventCandidate: "carry"
  },
  {
    label: "progressive_pass",
    textTerms: ["progressive pass", "line breaking pass", "breaks the line", "전진 패스", "라인 브레이킹", "라인브레이킹"],
    eventCandidate: "pass_receive"
  },
  {
    label: "save",
    textTerms: ["save", "saves", "keeper save", "goalkeeper save", "선방", "세이브"],
    eventCandidate: "shot"
  },
  {
    label: "pressure",
    textTerms: ["pressure", "under pressure", "pressured", "압박", "pressure situation"],
    eventCandidate: "unknown"
  },
  {
    label: "scramble",
    textTerms: ["scramble", "scrambles", "scramble play", "스크램블"],
    eventCandidate: "carry"
  },
  {
    label: "pocket_escape",
    textTerms: ["pocket escape", "escapes the pocket", "out of the pocket", "포켓 탈출"],
    eventCandidate: "carry"
  },
  {
    label: "throw_on_run",
    textTerms: ["throw on the run", "throws on the run", "rolling right", "rolling left", "이동 중 패스"],
    eventCandidate: "pass_receive"
  }
];

export function applyEventClassification(timeline: TimelineSegment[]): TimelineSegment[] {
  return timeline.map((segment, index) => {
    const vision = segment.sceneData?.vision;
    if (!vision) return segment;
    const context = buildSequenceContext(timeline, index, vision);
    const classification = classifySegmentEvent(segment, vision, context);
    return {
      ...segment,
      sceneData: {
        ...segment.sceneData!,
        vision: {
          ...vision,
          eventClassification: classification,
          eventCandidates: mergeClassificationCandidate(vision.eventCandidates, classification)
        }
      }
    };
  });
}

type SequenceContext = {
  sameNearestPlayerWindow: boolean;
  directionMatchesAttack: boolean;
  trackingContinuity: number;
  trackingVersion: "tracking_v0" | "tracking_v2" | null;
  trackingCoverage: number | null;
  trackingReliable: boolean;
  ballSpeed: number | null;
  pressureCue: boolean;
  calibratedZone: boolean;
  sequenceRules: string[];
};

function classifySegmentEvent(segment: TimelineSegment, vision: VisionEvidence, context: SequenceContext): NonNullable<VisionEvidence["eventClassification"]> {
  const normalized = normalizeText(collectClassifierText(segment));
  const receiverCue = hasAny(normalized, ["receive", "receives", "received", "receiver", "receiving", "받는", "받아", "받았다", "리시브", "first touch"]);
  const playerNearBall = Boolean(vision.proximity?.ballNearPlayer);
  const ballTracked = Boolean(vision.tracking?.ballTrackId);
  const direction = vision.tracking?.ballMovement.direction ?? "unknown";
  const rules: string[] = [];
  let selected: { label: EventLabel; confidence: number } | null = null;

  for (const rule of classifierRules) {
    const textMatches = matchingTerms(normalized, rule.textTerms);
    const receiverMatches = matchingTerms(normalized, rule.receiverTerms ?? []);
    const candidateMatch = rule.eventCandidate ? vision.eventCandidates.some((candidate) => candidate.type === rule.eventCandidate && candidate.confidence >= 0.45) : false;
    if (textMatches.length === 0) continue;

    const requiresReceiver = rule.label.endsWith("_receive");
    const hasReceiver = receiverMatches.length > 0 || receiverCue || playerNearBall;
    if (requiresReceiver && !hasReceiver) continue;

    let confidence = 0.34;
    confidence += Math.min(0.28, textMatches.length * 0.14);
    confidence += receiverMatches.length > 0 || receiverCue ? 0.12 : 0;
    confidence += playerNearBall ? 0.12 : 0;
    confidence += ballTracked ? (context.trackingReliable ? 0.1 : 0.04) : 0;
    confidence += vision.fieldZone.zone === "final_third" || vision.fieldZone.zone === "penalty_area" ? 0.08 : 0;
    confidence += context.directionMatchesAttack ? 0.08 : 0;
    confidence += context.sameNearestPlayerWindow && rule.label.endsWith("_receive") ? 0.06 : 0;
    confidence += context.trackingContinuity >= 0.45 ? (context.trackingReliable ? 0.08 : 0.03) : 0;
    confidence += context.calibratedZone ? 0.06 : 0;
    confidence += direction !== "unknown" && direction !== "stationary" ? 0.04 : 0;
    if (candidateMatch) confidence += 0.08;
    confidence = roundConfidence(confidence);

    rules.push(`${rule.label}: ${[...textMatches, ...receiverMatches].join(", ") || "vision candidate"}`);
    if (!selected || confidence > selected.confidence) selected = { label: rule.label, confidence };
  }

  const trackingReceive = inferTrackingReceive(vision, context);
  if (trackingReceive && (!selected || trackingReceive.confidence > selected.confidence)) {
    selected = trackingReceive;
    rules.push(...context.sequenceRules, `tracking-event: ${trackingReceive.label}`);
  }

  const trackingCarry = inferTrackingCarry(vision, context);
  if (trackingCarry && (!selected || trackingCarry.confidence > selected.confidence)) {
    selected = trackingCarry;
    rules.push(...context.sequenceRules, `tracking-event: ${trackingCarry.label}`);
  }

  if (!selected && context.pressureCue) {
    selected = { label: "pressure", confidence: roundConfidence(0.4 + (vision.objects.players.confidence ?? 0) * 0.18) };
    rules.push("text/vision: pressure cue near player cluster");
  }

  if (!selected && ballTracked && playerNearBall) {
    selected = {
      label: vision.fieldZone.zone === "final_third" || vision.fieldZone.zone === "penalty_area" ? "pass_receive" : "carry",
      confidence: roundConfidence(0.44 + (vision.tracking?.continuity ?? 0) * 0.18 + (vision.proximity?.confidence ?? 0) * 0.12)
    };
    rules.push("tracking: ball near player with continuous ball track");
  }

  const label = selected?.label ?? "unknown";
  return {
    label,
    confidence: selected?.confidence ?? 0,
    rules,
    features: {
      textCue: rules.some((rule) => !rule.startsWith("tracking:")),
      receiverCue,
      ballTracked,
      playerNearBall,
      fieldZone: vision.fieldZone.zone,
      ballDirection: direction,
      trackingContinuity: context.trackingContinuity,
      trackingVersion: context.trackingVersion ?? undefined,
      trackingCoverage: context.trackingCoverage,
      trackingReliable: context.trackingReliable,
      ballSpeed: context.ballSpeed,
      directionMatchesAttack: context.directionMatchesAttack,
      sameNearestPlayerWindow: context.sameNearestPlayerWindow,
      pressureCue: context.pressureCue,
      calibratedZone: context.calibratedZone
    }
  };
}

function buildSequenceContext(timeline: TimelineSegment[], index: number, vision: VisionEvidence): SequenceContext {
  const previousVision = timeline[index - 1]?.sceneData?.vision ?? null;
  const nextVision = timeline[index + 1]?.sceneData?.vision ?? null;
  const nearest = vision.tracking?.nearestPlayerTrackId ?? null;
  const sameNearestPlayerWindow = Boolean(
    nearest && (previousVision?.tracking?.nearestPlayerTrackId === nearest || nextVision?.tracking?.nearestPlayerTrackId === nearest)
  );
  const ballSpeed = vision.tracking?.ballMovement.speedPerSecond ?? null;
  const trackingContinuity = vision.tracking?.continuity ?? 0;
  const trackingVersion = vision.tracking?.version ?? null;
  const trackingCoverage = vision.tracking?.trackCoverage ?? null;
  const trackingReliable = Boolean(trackingVersion === "tracking_v2" && (trackingCoverage ?? trackingContinuity) >= 0.12);
  const attackDirection = vision.fieldCalibration?.attackingDirection ?? "unknown";
  const ballDirection = vision.tracking?.ballMovement.direction ?? "unknown";
  const directionMatchesAttack =
    (attackDirection === "left_to_right" && ballDirection === "right") || (attackDirection === "right_to_left" && ballDirection === "left");
  const pressureCue = Boolean(vision.objects.players.countEstimate >= 8 && vision.proximity?.ballNearPlayer && (ballSpeed ?? 0) < 0.06);
  const calibratedZone = vision.fieldCalibration?.status === "calibrated";
  const sequenceRules = [
    trackingContinuity > 0 ? `sequence: tracking continuity ${trackingContinuity}` : "",
    trackingVersion ? `sequence: ${trackingVersion} coverage ${trackingCoverage ?? "unknown"}` : "",
    ballSpeed !== null ? `sequence: ball speed ${ballSpeed}` : "",
    sameNearestPlayerWindow ? `sequence: same nearest player ${nearest} in adjacent window` : "",
    directionMatchesAttack ? `sequence: ball direction matches attack direction ${attackDirection}` : "",
    vision.fieldCalibration ? `sequence: field ${vision.fieldCalibration.status}/${vision.fieldCalibration.method}` : ""
  ].filter(Boolean);
  return {
    sameNearestPlayerWindow,
    directionMatchesAttack,
    trackingContinuity,
    trackingVersion,
    trackingCoverage,
    trackingReliable,
    ballSpeed,
    pressureCue,
    calibratedZone,
    sequenceRules
  };
}

function inferTrackingReceive(vision: VisionEvidence, context: SequenceContext): { label: EventLabel; confidence: number } | null {
  const inAttackingZone = vision.fieldZone.zone === "final_third" || vision.fieldZone.zone === "penalty_area";
  const movingBall = (context.ballSpeed ?? 0) >= 0.025;
  const receiveSequence = Boolean(vision.tracking?.ballTrackId && vision.proximity?.ballNearPlayer && movingBall);
  if (!receiveSequence) return null;
  const throughLike = inAttackingZone && context.directionMatchesAttack;
  const confidence = roundConfidence(
    (context.trackingReliable ? 0.44 : 0.36) +
      (vision.proximity?.confidence ?? 0) * 0.18 +
      Math.min(0.14, (context.ballSpeed ?? 0) * 1.4) +
      (context.sameNearestPlayerWindow ? (context.trackingReliable ? 0.08 : 0.03) : 0) +
      (inAttackingZone ? 0.08 : 0) +
      (context.directionMatchesAttack ? (context.trackingReliable ? 0.08 : 0.04) : 0) +
      (context.calibratedZone ? 0.06 : 0)
  );
  return { label: throughLike ? "through_ball_receive" : "pass_receive", confidence };
}

function inferTrackingCarry(vision: VisionEvidence, context: SequenceContext): { label: EventLabel; confidence: number } | null {
  const samePlayer = context.sameNearestPlayerWindow;
  const nearBall = Boolean(vision.proximity?.ballNearPlayer);
  const lowOrMediumSpeed = (context.ballSpeed ?? 0) > 0 && (context.ballSpeed ?? 0) < 0.09;
  if (!samePlayer || !nearBall || !lowOrMediumSpeed || (!context.trackingReliable && context.trackingContinuity < 0.55)) return null;
  const confidence = roundConfidence(
    (context.trackingReliable ? 0.4 : 0.32) + (vision.proximity?.confidence ?? 0) * 0.14 + context.trackingContinuity * 0.14
  );
  return { label: "dribble", confidence };
}

function mergeClassificationCandidate(
  candidates: VisionEvidence["eventCandidates"],
  classification: NonNullable<VisionEvidence["eventClassification"]>
): VisionEvidence["eventCandidates"] {
  if (classification.label === "unknown" || classification.confidence <= 0) return candidates;
  const type = eventCandidateType(classification.label);
  const reason = `Event classifier v1: ${classification.label}`;
  const existing = candidates.find((candidate) => candidate.reason === reason);
  if (existing) return candidates;
  return [
    ...candidates,
    {
      type,
      confidence: classification.confidence,
      reason
    }
  ];
}

function eventCandidateType(label: EventLabel): VisionEvidence["eventCandidates"][number]["type"] {
  if (label === "shot" || label === "save") return "shot";
  if (label === "carry" || label === "dribble" || label === "scramble" || label === "pocket_escape") return "carry";
  if (label === "pressure") return "unknown";
  return "pass_receive";
}

function collectClassifierText(segment: TimelineSegment) {
  const text = segment.sceneData?.text;
  return [
    segment.label,
    segment.transcript,
    text?.speech,
    ...(text?.subtitles ?? []),
    ...(text?.screenText ?? []),
    ...(text?.overlays ?? [])
  ]
    .filter(Boolean)
    .join(" ");
}

function matchingTerms(value: string, terms: string[]) {
  return terms.filter((term) => value.includes(normalizeText(term)));
}

function hasAny(value: string, terms: string[]) {
  return matchingTerms(value, terms).length > 0;
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

function roundConfidence(value: number) {
  return Number(Math.max(0, Math.min(0.92, value)).toFixed(2));
}
