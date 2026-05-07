import type { AssetRecord, DomainScope, DomainScopeValue, PlayerIdentity, TimelineSegment } from "../../shared/types";
import { matchKnowledgeCompetition, matchKnowledgePlayers, matchKnowledgeTeams } from "../knowledge/registry";
import { normalizeLabel, normalizeText, snippets } from "./utils";

export function inferFootballScope(asset: AssetRecord, segment: TimelineSegment): DomainScope {
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

export function scopeLabels(scope: DomainScope) {
  return [
    scope.competition ? `competition.${normalizeLabel(scope.competition.value)}` : "",
    scope.season ? `season.${normalizeLabel(scope.season.value)}` : "",
    ...scope.teams.map((team) => `team.${normalizeLabel(team.value)}`),
    ...scope.players.map((player) => `player.${normalizeLabel(player.value)}`)
  ].filter(Boolean);
}

export function inferPlayerIdentity(asset: AssetRecord, segment: TimelineSegment): PlayerIdentity | null {
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
      source: source.source,
      evidence: [`${source.source} matched player alias.`, ...player.evidence]
    };
  }

  return null;
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
    const match = matchKnowledgeCompetition(source.text);
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
      matchKnowledgeTeams(source.text).map((match) => ({
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
