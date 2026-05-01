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
  }
];

export function applyEventClassification(timeline: TimelineSegment[]): TimelineSegment[] {
  return timeline.map((segment) => {
    const vision = segment.sceneData?.vision;
    if (!vision) return segment;
    const classification = classifySegmentEvent(segment, vision);
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

function classifySegmentEvent(segment: TimelineSegment, vision: VisionEvidence): NonNullable<VisionEvidence["eventClassification"]> {
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
    confidence += ballTracked ? 0.08 : 0;
    confidence += vision.fieldZone.zone === "final_third" || vision.fieldZone.zone === "penalty_area" ? 0.08 : 0;
    confidence += direction !== "unknown" && direction !== "stationary" ? 0.04 : 0;
    if (candidateMatch) confidence += 0.08;
    confidence = roundConfidence(confidence);

    rules.push(`${rule.label}: ${[...textMatches, ...receiverMatches].join(", ") || "vision candidate"}`);
    if (!selected || confidence > selected.confidence) selected = { label: rule.label, confidence };
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
      ballDirection: direction
    }
  };
}

function mergeClassificationCandidate(
  candidates: VisionEvidence["eventCandidates"],
  classification: NonNullable<VisionEvidence["eventClassification"]>
): VisionEvidence["eventCandidates"] {
  if (classification.label === "unknown" || classification.confidence <= 0) return candidates;
  const type = classification.label === "shot" ? "shot" : classification.label === "carry" ? "carry" : "pass_receive";
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
