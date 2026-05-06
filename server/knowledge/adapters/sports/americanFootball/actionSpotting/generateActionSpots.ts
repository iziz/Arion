import type { AssetRecord, KnowledgeSnapshot, TimelineSegment } from "../../../../../../shared/types";
import {
  americanFootballKnowledgeTemplate,
  hasNflverseAlignmentContext,
  nflverseAlignmentTermsForTeam,
  normalizeKnowledgeTemplateTerm,
  significantTemplateTerms
} from "../knowledgeTemplate";
import type { AmericanFootballActionSpot } from "./types";

type AmericanFootballPlay = NonNullable<KnowledgeSnapshot["americanFootballPlays"]>[number];

type ActionCandidate = {
  eventType: string;
  label: string;
  confidence: number;
  evidence: string[];
};

type Alignment = {
  play: AmericanFootballPlay;
  confidence: number;
  evidence: string[];
};

type PlayLookup = {
  bySeason: Map<string, AmericanFootballPlay[]>;
  byPlayerTerm: Map<string, Map<string, AmericanFootballPlay[]>>;
  byTeamTerm: Map<string, Map<string, AmericanFootballPlay[]>>;
  byDescriptionTerm: Map<string, Map<string, AmericanFootballPlay[]>>;
  teamTerms: Set<string>;
};

export type AmericanFootballActionSpotGenerationAsset = Pick<AssetRecord, "id" | "title" | "description" | "originalName" | "timeline">;

export function buildAmericanFootballActionSpotPredictions(
  asset: AmericanFootballActionSpotGenerationAsset,
  plays: AmericanFootballPlay[],
  options: { minConfidence?: number; maxPerAsset?: number | null } = {}
): AmericanFootballActionSpot[] {
  const lookup = buildPlayLookup(plays);
  const season = seasonFromAsset(asset);
  const predictions: AmericanFootballActionSpot[] = [];
  const minConfidence = options.minConfidence ?? americanFootballKnowledgeTemplate.generator.actionSpotting.minCandidateConfidence;
  for (const segment of asset.timeline) {
    const candidate = actionCandidateForSegment(segment);
    if (!candidate || candidate.confidence < minConfidence) continue;
    const alignment = alignPlay(asset, segment, candidate.eventType, lookup, season);
    const confidence = alignment ? Math.min(0.96, Number((candidate.confidence + alignment.confidence * 0.12).toFixed(3))) : candidate.confidence;
    predictions.push({
      label: candidate.label,
      eventType: candidate.eventType,
      position: Number(((segment.start + segment.end) / 2).toFixed(3)),
      period: alignment?.play.quarter ?? periodFromSegment(segment),
      confidence,
      evidence: [...candidate.evidence, ...(alignment?.evidence ?? [])].slice(0, 12),
      playMetadata: alignment ? playMetadata(alignment.play) : undefined,
      participants: alignment ? participantsForPlay(alignment.play, alignment.confidence) : undefined,
      tracking: trackingForSegment(segment, alignment?.play)
    });
  }
  return predictions
    .sort((a, b) => a.position - b.position || b.confidence - a.confidence)
    .slice(0, options.maxPerAsset ?? predictions.length);
}

function actionCandidateForSegment(segment: TimelineSegment): ActionCandidate | null {
  const text = segmentText(segment);
  const normalized = normalize(text);
  const classifier = segment.sceneData?.vision?.eventClassification;
  const classifierType = classifier?.label && classifier.label !== "unknown" ? normalizeEventType(classifier.label) : null;
  const cue = eventCue(normalized, classifierType);
  if (!cue) return null;
  const evidence = [
    segment.transcript ? `ASR ${timeRange(segment)}: ${compact(segment.transcript, 180)}` : "",
    segment.sceneData?.vlm?.caption ? `VLM ${timeRange(segment)}: ${compact(segment.sceneData.vlm.caption, 180)}` : "",
    ...ocrEvidence(segment).slice(0, 3),
    classifierType ? `Vision classifier: ${classifierType} ${Math.round((classifier?.confidence ?? 0) * 100)}%.` : "",
    segment.sceneData?.vision?.tracking?.nearestPlayerTrackId ? `MOT nearestPlayerTrackId=${segment.sceneData.vision.tracking.nearestPlayerTrackId}.` : ""
  ].filter(Boolean);
  const confidence = clamp(
    cue.baseConfidence +
      (segment.transcript ? 0.04 : 0) +
      (segment.sceneData?.vlm?.caption || segment.sceneData?.vlm?.description ? 0.06 : 0) +
      (ocrEvidence(segment).length > 0 ? 0.03 : 0) +
      (classifierType === cue.eventType ? Math.min(0.08, (classifier?.confidence ?? 0) * 0.1) : 0) +
      (segment.sceneData?.vision?.tracking?.nearestPlayerTrackId ? 0.03 : 0),
    0,
    0.9
  );
  return {
    eventType: cue.eventType,
    label: cue.label,
    confidence: Number(confidence.toFixed(3)),
    evidence
  };
}

function eventCue(normalized: string, classifierType: string | null) {
  if (/touchdown|for_the_score|\btd\b|pick_six/.test(normalized)) return { eventType: "touchdown", label: "Touchdown", baseConfidence: 0.72 };
  if (/field_goal|\bfg\b/.test(normalized)) return { eventType: "field_goal", label: "Field goal", baseConfidence: 0.68 };
  if (/kickoff|kick_off/.test(normalized)) return { eventType: "kickoff", label: "Kickoff", baseConfidence: 0.64 };
  if (/punt|punter/.test(normalized)) return { eventType: "punt", label: "Punt", baseConfidence: 0.64 };
  if (/pressure|pass_rush|blitz|sack|hit_again|under_duress/.test(normalized) || classifierType === "pressure") {
    return { eventType: "pressure", label: "Quarterback pressure", baseConfidence: 0.67 };
  }
  if (/scramble|qb_run|quarterback_run/.test(normalized) || classifierType === "scramble") return { eventType: "scramble", label: "QB scramble", baseConfidence: 0.68 };
  if (/throw_on_the_run|rolling_right|rolling_left|off_platform|out_of_the_pocket/.test(normalized) || classifierType === "throw_on_run") {
    return { eventType: "throw_on_run", label: "Throw on the run", baseConfidence: 0.66 };
  }
  if (/interception|incomplete|completion|complete|caught|catch|reception|pass|throw|throws|passing/.test(normalized)) {
    return { eventType: "pass", label: "Pass play", baseConfidence: 0.64 };
  }
  if (/rush|rushing|carry|carries|handoff|run_with|running_with_the_ball|runs_for|tackle|tackles/.test(normalized)) {
    return { eventType: "rush", label: "Rush play", baseConfidence: 0.61 };
  }
  return null;
}

function alignPlay(asset: AmericanFootballActionSpotGenerationAsset, segment: TimelineSegment, eventType: string, lookup: PlayLookup, season: string | null): Alignment | null {
  const text = normalize([asset.title, asset.description, segmentText(segment)].join(" "));
  if (americanFootballKnowledgeTemplate.generator.actionSpotting.alignment.requireProviderContext) {
    const assetText = [asset.title, asset.description, asset.originalName].join(" ");
    if (!hasNflverseAlignmentContext(assetText, text, lookup.teamTerms)) return null;
  }
  const terms = significantTerms(text);
  const downDistance = parseDownDistance(text);
  const plays = candidatePlays(lookup, season, terms);
  if (plays.length === 0) return null;
  let best: { play: AmericanFootballPlay; score: number; strongScore: number; evidence: string[] } | null = null;
  for (const play of plays) {
    const evidence: string[] = [];
    let score = 0;
    let strongScore = 0;
    if (playTypeMatches(eventType, play)) {
      score += 2.5;
      evidence.push(`nflverse playType/touchdown matched ${eventType}.`);
    }
    for (const name of [play.passerPlayerName, play.rusherPlayerName, play.receiverPlayerName]) {
      const nameScore = playerNameScore(text, name);
      if (nameScore > 0) {
        score += nameScore;
        strongScore += nameScore;
        evidence.push(`Player mention matched ${name}.`);
      }
    }
    for (const team of [play.possessionTeam, play.defensiveTeam, play.homeTeam, play.awayTeam]) {
      const teamScore = teamMentionScore(text, team);
      if (teamScore > 0) {
        score += teamScore;
        strongScore += teamScore;
      }
    }
    if (downDistance && play.down === downDistance.down && play.distance === downDistance.distance) {
      score += 3;
      strongScore += 3;
      evidence.push(`Down-distance matched ${downDistance.down} and ${downDistance.distance}.`);
    }
    const overlap = termOverlap(terms, significantTerms(normalize(play.description)));
    if (overlap > 0) score += Math.min(3, overlap * 0.25);
    if (!best || score > best.score) best = { play, score, strongScore, evidence };
  }
  if (
    !best ||
    best.score < americanFootballKnowledgeTemplate.generator.actionSpotting.alignment.minScore ||
    best.strongScore < americanFootballKnowledgeTemplate.generator.actionSpotting.alignment.minStrongScore
  ) return null;
  return {
    play: best.play,
    confidence: Number(Math.min(0.96, 0.52 + best.score / 20).toFixed(3)),
    evidence: [`Aligned with nflverse gameId=${best.play.gameId} playId=${best.play.playId}.`, ...best.evidence].slice(0, 6)
  };
}

function buildPlayLookup(plays: AmericanFootballPlay[]): PlayLookup {
  const lookup: PlayLookup = {
    bySeason: new Map(),
    byPlayerTerm: new Map(),
    byTeamTerm: new Map(),
    byDescriptionTerm: new Map(),
    teamTerms: new Set()
  };
  for (const play of plays) {
    addToMap(lookup.bySeason, play.season, play);
    for (const map of [lookup.byPlayerTerm, lookup.byTeamTerm, lookup.byDescriptionTerm]) {
      if (!map.has(play.season)) map.set(play.season, new Map());
    }
    const playerMap = lookup.byPlayerTerm.get(play.season);
    const teamMap = lookup.byTeamTerm.get(play.season);
    const descriptionMap = lookup.byDescriptionTerm.get(play.season);
    if (!playerMap || !teamMap || !descriptionMap) continue;
    for (const name of [play.passerPlayerName, play.rusherPlayerName, play.receiverPlayerName]) {
      for (const term of playerTerms(name)) addToMap(playerMap, term, play);
    }
    for (const team of [play.possessionTeam, play.defensiveTeam, play.homeTeam, play.awayTeam]) {
      for (const term of teamTerms(team)) {
        lookup.teamTerms.add(term);
        addToMap(teamMap, term, play);
      }
    }
    for (const term of significantTerms(normalize(play.description)).filter((item) => item.length >= 5).slice(0, 18)) {
      addToMap(descriptionMap, term, play);
    }
  }
  return lookup;
}

function candidatePlays(lookup: PlayLookup, season: string | null, terms: string[]) {
  const seasons = season && lookup.bySeason.has(season) ? [season] : Array.from(lookup.bySeason.keys());
  const candidates = new Map<string, AmericanFootballPlay>();
  const add = (items: AmericanFootballPlay[] | undefined, limit: number) => {
    if (!items) return;
    for (const play of items.slice(0, limit)) candidates.set(`${play.gameId}:${play.playId}`, play);
  };
  for (const seasonKey of seasons) {
    const playerMap = lookup.byPlayerTerm.get(seasonKey);
    const teamMap = lookup.byTeamTerm.get(seasonKey);
    const descriptionMap = lookup.byDescriptionTerm.get(seasonKey);
    for (const term of terms) {
      add(playerMap?.get(term), 600);
      if (term.length >= 5) add(descriptionMap?.get(term), 250);
    }
    if (candidates.size < 1200) {
      for (const term of terms) add(teamMap?.get(term), 500);
    }
  }
  return Array.from(candidates.values()).slice(0, 6000);
}

function playMetadata(play: AmericanFootballPlay): NonNullable<AmericanFootballActionSpot["playMetadata"]> {
  return {
    provider: "nflverse",
    gameId: play.gameId,
    playId: play.playId,
    season: play.season,
    week: play.week,
    possessionTeam: play.possessionTeam,
    defensiveTeam: play.defensiveTeam,
    down: play.down,
    distance: play.distance,
    yardline: play.yardline,
    yardline100: play.yardline100,
    quarter: play.quarter,
    clock: play.clock,
    description: play.description,
    sourceText: [play.sourceText]
  };
}

function participantsForPlay(play: AmericanFootballPlay, confidence: number): NonNullable<AmericanFootballActionSpot["participants"]> {
  return [
    participant("passer", play.passerPlayerId, play.passerPlayerName, play.possessionTeam, confidence),
    participant("rusher", play.rusherPlayerId, play.rusherPlayerName, play.possessionTeam, confidence),
    participant("receiver", play.receiverPlayerId, play.receiverPlayerName, play.possessionTeam, confidence)
  ].filter((item): item is NonNullable<AmericanFootballActionSpot["participants"]>[number] => Boolean(item));
}

function participant(
  role: "passer" | "rusher" | "receiver",
  playerId: string | null,
  name: string | null,
  team: string | null,
  confidence: number
): NonNullable<AmericanFootballActionSpot["participants"]>[number] | null {
  if (!playerId && !name) return null;
  return {
    role,
    playerId,
    name,
    team,
    trackId: null,
    confidence,
    source: "nflverse"
  };
}

function trackingForSegment(segment: TimelineSegment, play: AmericanFootballPlay | undefined): AmericanFootballActionSpot["tracking"] | undefined {
  const tracking = segment.sceneData?.vision?.tracking;
  if (!tracking) return undefined;
  const trackIds = unique([
    ...(tracking.playerTracks?.map((track) => track.id) ?? []),
    ...(tracking.ballTracks?.map((track) => track.id) ?? []),
    tracking.nearestPlayerTrackId ?? "",
    tracking.ballTrackId ?? ""
  ]);
  if (trackIds.length === 0) return undefined;
  return {
    schema: "mot",
    playId: play?.playId ?? null,
    frameIds: tracking.trackedFrameCount ? [`trackedFrames:${tracking.trackedFrameCount}`] : [],
    trackIds,
    contactIds: [],
    confidence: Number(clamp(tracking.trackCoverage ?? tracking.continuity ?? 0.45, 0, 1).toFixed(3))
  };
}

function segmentText(segment: TimelineSegment) {
  return [
    segment.transcript,
    segment.sceneData?.text.speech,
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? []),
    ...(segment.sceneData?.image.labels ?? []),
    segment.sceneData?.vlm?.caption,
    segment.sceneData?.vlm?.description,
    ...(segment.sceneData?.vlm?.labels ?? []),
    ...(segment.sceneData?.vlm?.objects ?? []),
    ...(segment.sceneData?.vlm?.actions ?? []),
    ...(segment.sceneData?.vlm?.visibleText ?? []),
    ...(segment.domain?.captions ?? []),
    segment.domain?.searchText
  ].filter(Boolean).join(" ");
}

function ocrEvidence(segment: TimelineSegment) {
  return [
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? [])
  ].filter(Boolean).map((value) => `OCR: ${compact(value, 120)}`);
}

function normalizeEventType(value: string) {
  const normalized = normalize(value);
  if (/scramble/.test(normalized)) return "scramble";
  if (/throw_on_run|rolling|off_platform/.test(normalized)) return "throw_on_run";
  if (/pocket_escape|out_of_pocket/.test(normalized)) return "pocket_escape";
  if (/pressure|pass_rush|blitz|sack/.test(normalized)) return "pressure";
  if (/touchdown|\btd\b/.test(normalized)) return "touchdown";
  if (/pass|completion|interception/.test(normalized)) return "pass";
  if (/rush|run|carry/.test(normalized)) return "rush";
  if (/field_goal/.test(normalized)) return "field_goal";
  if (/punt/.test(normalized)) return "punt";
  if (/kickoff|kick_off/.test(normalized)) return "kickoff";
  return normalized;
}

function playTypeMatches(eventType: string, play: AmericanFootballPlay) {
  const playType = normalize(play.playType);
  if (eventType === "touchdown") return play.touchdown;
  if (eventType === "pass" || eventType === "pressure" || eventType === "throw_on_run") return playType.includes("pass");
  if (eventType === "rush" || eventType === "scramble") return playType.includes("run") || playType.includes("rush");
  if (eventType === "field_goal") return playType.includes("field_goal");
  if (eventType === "punt") return playType.includes("punt");
  if (eventType === "kickoff") return playType.includes("kickoff");
  return false;
}

function playerNameScore(text: string, name: string | null) {
  if (!name) return 0;
  const normalized = normalize(name);
  if (text.includes(normalized)) return 6;
  const parts = normalized.split("_").filter((part) => part.length > 2);
  const last = parts.at(-1);
  if (last && text.includes(last)) return 3.5;
  return 0;
}

function teamMentionScore(text: string, team: string | null) {
  if (!team) return 0;
  const normalized = normalize(team);
  if (text.includes(normalized)) return 1.5;
  const mascot = normalized.split("_").at(-1);
  return mascot && mascot.length > 2 && text.includes(mascot) ? 0.75 : 0;
}

function playerTerms(name: string | null) {
  if (!name) return [];
  const terms = significantTerms(normalize(name));
  const last = terms.at(-1);
  return unique([...terms, terms.join("_"), last ?? ""]).filter((term) => term.length >= 3);
}

function teamTerms(team: string | null) {
  return nflverseAlignmentTermsForTeam(team);
}

function parseDownDistance(text: string) {
  const match = text.match(/\b([1-4])(?:st|nd|rd|th)?_(?:and|&)_(\d{1,2})\b/);
  if (!match) return null;
  return { down: Number(match[1]), distance: Number(match[2]) };
}

function seasonFromAsset(asset: Pick<AssetRecord, "title" | "description">) {
  const match = [asset.title, asset.description].join(" ").match(/\b(20\d{2})\b/);
  return match?.[1] ?? null;
}

function periodFromSegment(segment: TimelineSegment) {
  const text = normalize(segmentText(segment));
  const match = text.match(/\bq([1-4])\b|quarter_([1-4])\b/);
  return match ? Number(match[1] ?? match[2]) : null;
}

function significantTerms(text: string) {
  return significantTemplateTerms(text);
}

function termOverlap(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.reduce((sum, term) => sum + (rightSet.has(term) ? 1 : 0), 0);
}

function normalize(value: string) {
  return normalizeKnowledgeTemplateTerm(value);
}

function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function timeRange(segment: TimelineSegment) {
  return `${segment.start.toFixed(2)}-${segment.end.toFixed(2)}`;
}

function addToMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items.filter(Boolean)));
}
