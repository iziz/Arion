import type { AssetRecord, DomainQueryPlan, DomainScopeValue, DomainSearchFilters, IndexRecord, KnowledgeEvidence, PlayerIdentity, SearchMatchReason, SearchResult, TimelineSegment } from "../../shared/types";
import { expandDomainQuery, scoreDomainMatch } from "../domainIndex";
import { isTrustedDomainSegment, trustedDomainEvents } from "../evidenceTrust";
import { knowledgeEvidenceForNames } from "../knowledgeGrounding";
import { resolveQueryRetrievalPlan } from "../queryRetrievalPlan";
import { isPlayerInventoryQuery } from "../queryPlanner";
import { matchKnowledgePlayer, matchKnowledgePlayers } from "../knowledge/registry";
import { segmentSearchText, withSceneData } from "./sceneTimeline";
import { SEMANTIC_ONLY_THRESHOLD, VISUAL_ONLY_THRESHOLD } from "./searchThresholds";
import { cosineSimilarity, extractKeywords, normalizeSearchValue, unique, vectorize } from "./textUtils";
import { buildSearchMatchReasons, buildVerificationChecks, clipFromSegment, formatDomainFilters, hasActiveDomainFilters, matchesAssetDomainText, matchesSegmentDomainFilters, recencyBoost, scoreDomainFilterMatch, scoreSources, scoreText, scoreVlmQuality } from "./evidence";

const ASSET_LEXICAL_WEIGHT = 24;
const ASSET_KNOWLEDGE_WEIGHT = 8;
const SEGMENT_LEXICAL_WEIGHT = 3;

export function searchAssets(
  assets: AssetRecord[],
  indexes: IndexRecord[],
  query: string,
  options: {
    indexId?: string;
    tag?: string;
    modality?: string;
    limit?: number;
    queryVector?: number[];
    vectorHitsBySegment?: Map<string, number>;
    visualHitsBySegment?: Map<string, number>;
    domainFilters?: DomainSearchFilters;
    queryPlan?: DomainQueryPlan;
    knowledgeEvidence?: KnowledgeEvidence[];
    useKnowledgeLayer?: boolean;
  } = {}
): SearchResult[] {
  if (options.queryPlan?.route === "unsupported") return [];

  if (isPlayerInventoryQuery(query)) {
    return searchPlayerInventoryResults(assets, indexes, options);
  }

  const retrievalPlan = resolveQueryRetrievalPlan(options.queryPlan, query);
  const domainProfile = expandDomainQuery(retrievalPlan.textQuery);
  const queryTerms = retrievalPlan.evidenceTerms;
  const lexicalMatchThreshold = options.queryPlan?.retrieval?.evidenceTerms.length ? 1 : queryTerms.length >= 3 ? 2 : 1;
  const knowledgeProfile = buildKnowledgeSearchProfile(options.knowledgeEvidence ?? []);
  const knowledgeTerms = extractKeywords(knowledgeProfile.searchText);
  const hasVectorHits = (options.vectorHitsBySegment?.size ?? 0) > 0 || (options.visualHitsBySegment?.size ?? 0) > 0;
  const hasDomainFilters = hasActiveDomainFilters(options.domainFilters);
  const hasKnowledgeEvidence = knowledgeTerms.length > 0;
  const suppressBroadMatches = Boolean(options.queryPlan?.warnings.some((warning) => /nonsensical|no actionable|no recognizable/i.test(warning)));
  const allowSemanticOnlyMatches = !suppressBroadMatches;
  if (query.trim().length === 0 && queryTerms.length === 0 && !hasVectorHits && !hasDomainFilters && !hasKnowledgeEvidence) return [];
  const queryVector = options.queryVector ?? vectorize(domainProfile.expandedText);
  const limit = options.limit ?? 10;

  return assets
    .filter((asset) => asset.status === "indexed" || asset.timeline.length > 0)
    .filter((asset) => !options.indexId || asset.indexId === options.indexId)
    .filter((asset) => !options.tag || asset.tags.includes(options.tag))
    .filter((asset) => matchesAssetDomainText(asset, options.domainFilters))
    .map((asset) => {
      const assetText = `${asset.title} ${asset.description} ${asset.tags.join(" ")} ${asset.summary}`;
      const assetLexicalScore = scoreText(assetText, queryTerms);
      const assetKnowledgeScore = scoreText(assetText, knowledgeTerms);
      const assetMetadataScore = Math.max(assetLexicalScore, assetKnowledgeScore);
      const segmentCandidates = asset.timeline
        .filter((segment) => !options.modality || segment.modalities.includes(options.modality as TimelineSegment["modalities"][number]))
        .filter((segment) => matchesSegmentDomainFilters(asset, segment, options.domainFilters))
        .map((segment) => {
          const segmentText = segmentSearchText(segment);
          const lexicalScore = scoreText(segmentText, queryTerms);
          const knowledgeScore = scoreText([assetText, segmentText, isTrustedDomainSegment(segment.domain) ? segment.domain?.searchText : ""].filter(Boolean).join(" "), knowledgeTerms);
          const domainScore = scoreDomainMatch(segment, domainProfile);
          const filterScore = scoreDomainFilterMatch(asset, segment, options.domainFilters);
          const storedSemanticScore = queryVector.length === segment.embedding.length ? cosineSimilarity(queryVector, segment.embedding) : 0;
          const vectorSemanticScore = options.vectorHitsBySegment?.get(segment.id) ?? 0;
          const semanticScore = Math.max(storedSemanticScore, vectorSemanticScore);
          const visualScore = options.visualHitsBySegment?.get(segment.id) ?? 0;
          const sourceScore = scoreSources(segment.sources);
          const confidenceScore = segment.confidence;
          const vlmQualityScore = scoreVlmQuality(segment);
          return {
            segment,
            lexicalScore,
            semanticScore,
            visualScore,
            sourceScore,
            confidenceScore,
            vlmQualityScore,
            domainScore,
            filterScore,
            knowledgeScore,
            score:
              lexicalScore * 3 +
              assetMetadataScore * 1.2 +
              domainScore * 5 +
              filterScore * 6 +
              knowledgeScore * 4.5 +
              semanticScore * 8 +
              visualScore * 6 +
              sourceScore +
              confidenceScore * 1.5 +
              vlmQualityScore
          };
        })
        .filter((item) =>
          hasDomainFilters
            ? item.filterScore > 0
            : suppressBroadMatches
              ? false
              : item.lexicalScore >= lexicalMatchThreshold ||
                item.domainScore > 0 ||
                item.knowledgeScore > 0 ||
                (allowSemanticOnlyMatches && (item.semanticScore >= SEMANTIC_ONLY_THRESHOLD || item.visualScore >= VISUAL_ONLY_THRESHOLD))
        );
      const lexicalSegmentMatches = segmentCandidates.filter((item) => item.lexicalScore >= lexicalMatchThreshold);
      const domainSegmentMatches = segmentCandidates.filter((item) => item.domainScore > 0);
      const knowledgeSegmentMatches = segmentCandidates.filter((item) => item.knowledgeScore > 0);
      const semanticSegmentMatches = segmentCandidates.filter((item) => item.semanticScore >= SEMANTIC_ONLY_THRESHOLD || item.visualScore >= VISUAL_ONLY_THRESHOLD);
      const matchingSegments = (hasDomainFilters
        ? segmentCandidates
        : lexicalSegmentMatches.length > 0 || domainSegmentMatches.length > 0 || knowledgeSegmentMatches.length > 0
          ? [...lexicalSegmentMatches, ...domainSegmentMatches, ...knowledgeSegmentMatches]
          : semanticSegmentMatches)
        .filter((item, index, items) => items.findIndex((candidate) => candidate.segment.id === item.segment.id) === index)
        .sort((a, b) => b.score - a.score);

      const selectedSegments = matchingSegments.slice(0, 5);
      const lexical = assetLexicalScore * ASSET_LEXICAL_WEIGHT + selectedSegments.reduce((sum, item) => sum + item.lexicalScore, 0) * SEGMENT_LEXICAL_WEIGHT;
      const domain = selectedSegments.reduce((sum, item) => sum + item.domainScore, 0) * 5;
      const filters = selectedSegments.reduce((sum, item) => sum + item.filterScore, 0) * 6;
      const knowledge = assetKnowledgeScore * ASSET_KNOWLEDGE_WEIGHT + selectedSegments.reduce((sum, item) => sum + item.knowledgeScore, 0) * 4.5;
      const semantic = selectedSegments.reduce((sum, item) => sum + item.semanticScore, 0) * 8;
      const visual = selectedSegments.reduce((sum, item) => sum + item.visualScore, 0) * 6;
      const source = selectedSegments.reduce((sum, item) => sum + item.sourceScore, 0);
      const confidence = selectedSegments.reduce((sum, item) => sum + item.confidenceScore, 0) * 1.5;
      const vlmQuality = selectedSegments.reduce((sum, item) => sum + item.vlmQualityScore, 0);
      const recency = recencyBoost(asset.createdAt);
      const totalScore = Number((lexical + domain + filters + knowledge + semantic + visual + source + confidence + vlmQuality + recency).toFixed(3));
      const index = indexes.find((item) => item.id === asset.indexId) ?? null;
      const selectedSegmentIds = selectedSegments.map((item) => item.segment.id);
      const selectedPlayerNames = unique(
        selectedSegments.flatMap((item) => [
          ...(item.segment.domain?.scope?.players.map((player) => player.value) ?? []),
            trustedDomainEvents(item.segment)[0]?.football?.receivingPlayer.identity?.name ?? "",
            trustedDomainEvents(item.segment)[0]?.football?.passingPlayer.identity?.name ?? "",
            trustedDomainEvents(item.segment)[0]?.americanFootball?.quarterback.identity?.name ?? ""
        ].filter(Boolean))
      );
      const selectedDetails = selectedSegments.map((item) => {
        const segment = withSceneData(asset, item.segment);
        const matchReasons = buildSearchMatchReasons(asset, item.segment, item, options.domainFilters, options.queryPlan, queryTerms);
        const verification = buildVerificationChecks(asset, item.segment, options.domainFilters);
        return {
          segment,
          matchReasons,
          verification,
          clip: clipFromSegment(asset, segment, verification, matchReasons)
        };
      });
      return {
        asset,
        index,
        segments: selectedDetails.map((item) => item.segment),
        clips: selectedDetails.map((item) => item.clip),
        score: totalScore,
        ranking: {
          lexical: Number(lexical.toFixed(3)),
          semantic: Number(semantic.toFixed(3)),
          visual: Number(visual.toFixed(3)),
          source: Number(source.toFixed(3)),
          confidence: Number(confidence.toFixed(3)),
          recency: Number(recency.toFixed(3)),
          total: totalScore
        },
        explain: [
          `${assetLexicalScore} lexical asset matches`,
          `${Number(domain.toFixed(3))} related knowledge rank score`,
          `${Number(filters.toFixed(3))} structured filter score`,
          `${Number(knowledge.toFixed(3))} knowledge grounding score`,
          `${Number(semantic.toFixed(3))} semantic rank score`,
          `${Number(visual.toFixed(3))} visual rank score`,
          `${Number(source.toFixed(3))} source quality boost`,
          `${Number(confidence.toFixed(3))} confidence boost`,
          `${Number(vlmQuality.toFixed(3))} VLM quality adjustment`,
          `${matchingSegments.length} matching timeline segments`,
          hasDomainFilters ? `domain filters=${formatDomainFilters(options.domainFilters)}` : "",
          options.queryPlan ? `query plan=${options.queryPlan.rewrittenQuery}` : "",
          index ? `index=${index.name}` : "index=unknown"
        ].filter(Boolean),
        queryPlan: options.queryPlan ?? null,
        knowledgeEvidence: selectKnowledgeEvidence(options.knowledgeEvidence ?? [], asset.id, selectedSegmentIds, selectedPlayerNames),
        matchReasons: selectedDetails.flatMap((item) => item.matchReasons),
        verification: selectedDetails.flatMap((item) => item.verification)
      };
    })
    .filter((result) => result.score > 0 && result.segments.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchPlayerInventoryResults(
  assets: AssetRecord[],
  indexes: IndexRecord[],
  options: Parameters<typeof searchAssets>[3]
): SearchResult[] {
  const searchOptions = options ?? {};
  const limit = searchOptions.limit ?? 10;
  const useKnowledgeLayer = searchOptions.useKnowledgeLayer !== false;
  const inventoryFilters = inventoryDomainFilters(searchOptions.domainFilters);
  return assets
    .filter((asset) => asset.status === "indexed" || asset.timeline.length > 0)
    .filter((asset) => !searchOptions.indexId || asset.indexId === searchOptions.indexId)
    .filter((asset) => !searchOptions.tag || asset.tags.includes(searchOptions.tag))
    .filter((asset) => matchesAssetDomainText(asset, inventoryFilters))
    .map((asset) => {
      const assetPlayers = collectAssetPlayerMentions(asset, useKnowledgeLayer);
      const segmentCandidates = asset.timeline
        .filter((segment) => !searchOptions.modality || segment.modalities.includes(searchOptions.modality as TimelineSegment["modalities"][number]))
        .filter((segment) => matchesSegmentDomainFilters(asset, segment, inventoryFilters))
        .map((segment) => ({ segment, players: collectPlayerMentions(asset, segment, useKnowledgeLayer) }))
        .filter((item) => item.players.length > 0)
        .sort((a, b) => averageConfidence(b.players) - averageConfidence(a.players) || b.players.length - a.players.length);
      const segmentPlayerNames = new Set(segmentCandidates.flatMap((item) => item.players.map((player) => player.value)));
      const assetOnlyPlayers = assetPlayers.filter((player) => !segmentPlayerNames.has(player.value));
      const firstSegment = asset.timeline.find(
        (segment) =>
          (!searchOptions.modality || segment.modalities.includes(searchOptions.modality as TimelineSegment["modalities"][number])) &&
          matchesSegmentDomainFilters(asset, segment, inventoryFilters)
      );
      if (firstSegment && assetOnlyPlayers.length > 0) {
        segmentCandidates.push({ segment: firstSegment, players: assetOnlyPlayers });
      }
      const playerNames = unique(segmentCandidates.flatMap((item) => item.players.map((player) => player.value))).sort((a, b) => a.localeCompare(b));
      const selectedSegments = selectPlayerInventorySegments(segmentCandidates, playerNames).slice(0, 5);
      const selectedSegmentIds = selectedSegments.map((item) => item.segment.id);
      const selectedDetails = selectedSegments.map((item) => {
        const segment = withSceneData(asset, item.segment);
        const matchReasons = buildPlayerInventoryReasons(segment.id, item.players);
        const verification = buildVerificationChecks(asset, item.segment, inventoryFilters);
        return {
          segment,
          matchReasons,
          verification,
          clip: clipFromSegment(asset, segment, verification, matchReasons)
        };
      });
      const index = indexes.find((item) => item.id === asset.indexId) ?? null;
      const source = selectedSegments.reduce((sum, item) => sum + scoreSources(item.segment.sources), 0);
      const confidence = selectedSegments.reduce((sum, item) => sum + averageConfidence(item.players), 0);
      const recency = recencyBoost(asset.createdAt);
      const totalScore = Number((playerNames.length * 20 + segmentCandidates.length * 0.5 + source + confidence + recency).toFixed(3));
      return {
        asset,
        index,
        segments: selectedDetails.map((item) => item.segment),
        clips: selectedDetails.map((item) => item.clip),
        score: totalScore,
        ranking: {
          lexical: 0,
          semantic: 0,
          visual: 0,
          source: Number(source.toFixed(3)),
          confidence: Number(confidence.toFixed(3)),
          recency: Number(recency.toFixed(3)),
          total: totalScore
        },
        explain: [
          `${playerNames.length} mentioned players: ${playerNames.join(", ")}`,
          `${segmentCandidates.length} timeline segments with player evidence`,
          searchOptions.queryPlan ? `query plan=${searchOptions.queryPlan.rewrittenQuery}` : "",
          index ? `index=${index.name}` : "index=unknown"
        ].filter(Boolean),
        queryPlan: searchOptions.queryPlan ?? null,
        knowledgeEvidence: selectKnowledgeEvidence(
          knowledgeEvidenceForNames(searchOptions.knowledgeEvidence ?? [], playerNames),
          asset.id,
          selectedSegmentIds,
          playerNames
        ),
        matchReasons: selectedDetails.flatMap((item) => item.matchReasons),
        verification: selectedDetails.flatMap((item) => item.verification)
      };
    })
    .filter((result) => result.score > 0 && result.segments.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function inventoryDomainFilters(filters?: DomainSearchFilters): DomainSearchFilters | undefined {
  if (!filters) return filters;
  const base = filters.role === "any" ? { ...filters, role: undefined } : filters;
  const hasSpecificRole = Boolean(base.role);
  if (base.player || base.eventType || base.passType || base.fieldZone || hasSpecificRole) return base;
  const next = { ...base };
  delete next.competition;
  delete next.season;
  return next;
}

function collectPlayerMentions(_asset: AssetRecord, segment: TimelineSegment, useKnowledgeLayer: boolean): DomainScopeValue[] {
  const mentions = new Map<string, DomainScopeValue>();
  const addMention = (value: DomainScopeValue | null | undefined) => {
    if (!value?.value) return;
    const mention = useKnowledgeLayer ? canonicalizeScopeValue(value) : value;
    const existing = mentions.get(mention.value);
    if (!existing || mention.confidence > existing.confidence) mentions.set(mention.value, mention);
  };
  for (const player of segment.domain?.scope?.players ?? []) {
    addMention(player);
  }
  for (const event of trustedDomainEvents(segment)) {
    addMention(identityToScopeValue(event.football?.receivingPlayer.identity));
    addMention(identityToScopeValue(event.football?.passingPlayer.identity));
    addMention(identityToScopeValue(event.americanFootball?.quarterback.identity));
  }
  const text = [
    segment.transcript,
    segment.sceneData?.text.speech,
    ...(segment.sceneData?.text.subtitles ?? []),
    ...(segment.sceneData?.text.screenText ?? []),
    ...(segment.sceneData?.text.overlays ?? [])
  ]
    .filter(Boolean)
    .join(" ");
  if (useKnowledgeLayer) {
    for (const match of matchKnowledgePlayers(text)) {
      addMention({
        value: match.value.canonical,
        confidence: match.confidence,
        source: match.source,
        evidence: match.evidence
      });
    }
  }

  return Array.from(mentions.values()).sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}

function identityToScopeValue(identity: PlayerIdentity | null | undefined): DomainScopeValue | null {
  if (!identity?.name) return null;
  return {
    value: identity.name,
    confidence: identity.confidence,
    source: identity.source === "query" ? "metadata" : identity.source,
    evidence: identity.evidence
  };
}

function canonicalizeScopeValue(value: DomainScopeValue): DomainScopeValue {
  const match = matchKnowledgePlayer(value.value);
  if (!match || match.value.canonical === value.value) return value;
  return {
    ...value,
    value: match.value.canonical,
    confidence: Math.max(value.confidence, match.confidence),
    evidence: [...value.evidence, ...match.evidence]
  };
}

function collectAssetPlayerMentions(asset: AssetRecord, useKnowledgeLayer: boolean): DomainScopeValue[] {
  if (!useKnowledgeLayer) return [];
  const text = [asset.title, asset.originalName, asset.description, asset.tags.join(" ")].filter(Boolean).join(" ");
  return matchKnowledgePlayers(text)
    .map((match) => ({
      value: match.value.canonical,
      confidence: match.confidence,
      source: match.source,
      evidence: match.evidence
    }))
    .sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
}

function selectPlayerInventorySegments(
  candidates: Array<{ segment: TimelineSegment; players: DomainScopeValue[] }>,
  playerNames: string[]
) {
  const selected: Array<{ segment: TimelineSegment; players: DomainScopeValue[] }> = [];
  const selectedIds = new Set<string>();
  for (const playerName of playerNames) {
    const match = candidates.find((item) => item.players.some((player) => player.value === playerName));
    if (match && !selectedIds.has(match.segment.id)) {
      selected.push(match);
      selectedIds.add(match.segment.id);
    }
  }
  for (const candidate of candidates) {
    if (selectedIds.has(candidate.segment.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.segment.id);
  }
  return selected;
}

function buildPlayerInventoryReasons(segmentId: string, players: DomainScopeValue[]): SearchMatchReason[] {
  return players.map((player) => ({
    segmentId,
    kind: "evidence",
    label: "Player",
    value: `${player.value} (${player.source})`,
    confidence: player.confidence
  }));
}

function averageConfidence(players: DomainScopeValue[]) {
  if (players.length === 0) return 0;
  return players.reduce((sum, player) => sum + player.confidence, 0) / players.length;
}

export function selectKnowledgeEvidence(evidence: KnowledgeEvidence[], assetId: string, segmentIds: string[], playerNames: string[]) {
  const segmentIdSet = new Set(segmentIds);
  const playerNameSet = new Set(playerNames.map(normalizeSearchValue));
  return evidence
    .filter((item) => {
      if (item.assetId && item.assetId !== assetId) return false;
      if (item.segmentId && !segmentIdSet.has(item.segmentId)) return false;
      if (item.entityType === "player" && playerNameSet.size > 0) return playerNameSet.has(normalizeSearchValue(item.entityName));
      return item.source !== "video_index" || item.assetId === assetId;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
}

function buildKnowledgeSearchProfile(evidence: KnowledgeEvidence[]) {
  const selected = evidence.slice(0, 40);
  return {
    searchText: selected
      .flatMap((item) => [item.entityName, item.team, item.competition, item.season, item.matchTime, item.evidenceText])
      .filter(Boolean)
      .join(" "),
    sourceCount: selected.length
  };
}
