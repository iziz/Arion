import type { AskAnswerContent, AskAnswerSection, DomainQueryPlan, OrchestrationPlan, SearchResult, TimelineSegment } from "../../../shared/types";
import { buildEmptySearchAnswer } from "../../../shared/searchAnswerCopy";
import { trustedDomainEvents } from "../../evidenceTrust";
import { getKnowledgePlayer, matchKnowledgePlayer } from "../../knowledge/registry";
import type { AskRequest } from "./types";

export function formatSearchScope({ indexId, assetId, domainGroup, tag, modality }: Pick<AskRequest, "indexId" | "assetId" | "domainGroup" | "tag" | "modality">) {
  return [
    assetId ? `asset=${assetId}` : "",
    indexId ? `index=${indexId}` : domainGroup ? `domain=${domainGroup}` : "all indexes",
    tag ? `tag=${tag}` : "",
    modality ? `modality=${modality}` : ""
  ].filter(Boolean).join(" · ");
}

export function buildAskVideoAnswerContent(results: SearchResult[], queryPlan: DomainQueryPlan): AskAnswerContent {
  const korean = isKoreanQuery(queryPlan.originalQuery);
  if (results.length === 0) {
    return plainAskAnswerContent(buildEmptySearchAnswer(queryPlan));
  }
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  if (isPlayerInventoryPlan(queryPlan)) {
    return plainAskAnswerContent(buildPlayerInventoryAnswer(results, segmentCount, korean));
  }
  const player = queryPlan.intent.player ? ` for ${queryPlan.intent.player}` : "";
  const event = queryPlan.intent.eventType ? ` matching ${queryPlan.intent.eventType.replace(/_/g, " ")}` : "";
  if (korean) {
    const focus = [
      queryPlan.intent.player ? `player=${queryPlan.intent.player}` : "",
      queryPlan.intent.eventType ? `event=${queryPlan.intent.eventType}` : ""
    ].filter(Boolean).join(" · ");
    return plainAskAnswerContent(`${results.length}개 asset에서 ${segmentCount}개의 indexed moment를 찾았습니다${focus ? ` (${focus})` : ""}.`);
  }
  return plainAskAnswerContent(`Found ${segmentCount} indexed moments across ${results.length} assets${player}${event}.`);
}

function buildPlayerInventoryAnswer(results: SearchResult[], segmentCount: number, korean: boolean) {
  const playerNames = collectInventoryPlayerNames(results);
  if (playerNames.length === 0) {
    return korean
      ? `${results.length}개 asset에서 ${segmentCount}개의 indexed moment를 찾았지만, 인덱싱된 player identity는 확인하지 못했습니다.`
      : `Found ${segmentCount} indexed moments across ${results.length} assets, but no indexed player identity was available.`;
  }
  if (korean) {
    return `보유 영상 기준으로 노출/언급된 선수 이름은 ${playerNames.join(", ")}입니다. 총 ${playerNames.length}명이며, ${results.length}개 asset/${segmentCount}개 indexed moment에서 확인했습니다.`;
  }
  return `Indexed video evidence exposes these player names: ${playerNames.join(", ")}. I found ${playerNames.length} players across ${results.length} assets and ${segmentCount} indexed moments.`;
}

export function buildAskAnalysisAnswerContent(results: SearchResult[], queryPlan: DomainQueryPlan, orchestrationPlan: OrchestrationPlan): AskAnswerContent {
  if (results.length === 0) return buildAskVideoAnswerContent(results, queryPlan);
  const korean = isKoreanQuery(queryPlan.originalQuery);
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  const top = results[0];
  const topMoments = top.segments.slice(0, 3).map((segment) => `${formatClock(segment.start)}-${formatClock(segment.end)}`).join(", ");
  const sourceProfile = summarizeResultSources(results);
  if (isGenericVideoSummaryRequest(queryPlan)) {
    return buildGenericVideoSummaryAnswer(results, queryPlan, topMoments, sourceProfile, korean);
  }
  if (queryPlan.relatedKnowledgeMode === "none" && queryPlan.responseMode !== "analysis") {
    return buildGenericGroundedAnswer(results, queryPlan, topMoments, sourceProfile, korean);
  }
  const features = collectMomentFeatures(results);
  const subject = resolveAnalysisSubject(queryPlan, features, korean);
  const headline = korean ? buildStyleHeadlineKo(features) : buildStyleHeadlineEn(features);
  const patternSentences = korean ? buildPatternSentencesKo(features) : buildPatternSentencesEn(features);
  const evidenceLine = korean
    ? `"${top.asset.title}"의 ${topMoments || "retrieved timeline"} 구간이 가장 강한 근거이며, 전체 분석은 ${segmentCount}개 moment/${results.length}개 asset에 한정됩니다.`
    : `The strongest source asset is "${top.asset.title}" with key moments around ${topMoments || "the retrieved timeline"}, and the analysis is limited to ${segmentCount} moments across ${results.length} assets.`;
  if (korean) {
    return sectionedAskAnswerContent([
      answerSection("summary", "요약", `${subject}의 플레이 스타일은 현재 검색된 영상 기준으로 "${headline}"으로 요약됩니다.`),
      answerSection("patterns", "패턴", patternSentences.join(" ")),
      answerSection("evidence", "근거", evidenceLine, "evidence"),
      sourceProfile ? answerSection("sources", "소스", `${sourceProfile}.`, "evidence") : null,
      orchestrationPlan.analysis.required
        ? answerSection("note", "주의", "이 결론은 최종 검색된 indexed moments만 분석한 결과이며, 영상 전체나 외부 통계로 일반화하지 않습니다.", "warning")
        : null
    ]);
  }
  const focus = [
    queryPlan.intent.player ? `player=${queryPlan.intent.player}` : "",
    queryPlan.intent.eventType ? `event=${queryPlan.intent.eventType}` : "",
    queryPlan.intent.fieldZone ? `zone=${queryPlan.intent.fieldZone}` : ""
  ].filter(Boolean).join(" · ");
  return sectionedAskAnswerContent([
    answerSection("summary", "Summary", `${subject}'s play style from the retrieved indexed video is best summarized as "${headline}".`),
    answerSection("patterns", "Patterns", patternSentences.join(" ")),
    answerSection("scope", "Scope", `I analyzed ${segmentCount} indexed moments across ${results.length} assets${focus ? ` (${focus})` : ""}.`),
    answerSection("evidence", "Evidence", evidenceLine, "evidence"),
    sourceProfile ? answerSection("sources", "Sources", `${sourceProfile}.`, "evidence") : null,
    orchestrationPlan.analysis.required
      ? answerSection("note", "Note", "This conclusion is grounded only in the retrieved indexed moments and should not be generalized to all games or external statistics.", "warning")
      : null
  ]);
}

function isGenericVideoSummaryRequest(queryPlan: DomainQueryPlan) {
  return queryPlan.responseMode === "summary";
}

function buildGenericGroundedAnswer(results: SearchResult[], queryPlan: DomainQueryPlan, topMoments: string, sourceProfile: string, korean: boolean): AskAnswerContent {
  const top = results[0];
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  const snippets = collectGroundedSnippets(results);
  const evidenceScope = korean
    ? `${segmentCount}개 moment/${results.length}개 asset`
    : `${segmentCount} moments across ${results.length} assets`;
  if (korean) {
    return sectionedAskAnswerContent([
      answerSection(
        "answer",
        "답변",
        snippets.length > 0
          ? `검색된 영상 근거 기준으로 ${joinSummarySnippetsKo(snippets.slice(0, 4))}로 확인됩니다.`
          : "검색된 구간에는 이 질문에 답할 충분한 ASR/OCR/visual evidence가 제한적입니다."
      ),
      answerSection("evidence", "근거", `"${top.asset.title}"의 ${topMoments || "retrieved timeline"} 구간이 가장 강한 근거입니다.`, "evidence"),
      sourceProfile ? answerSection("sources", "소스", `${sourceProfile}.`, "evidence") : null,
      answerSection("note", "주의", `이 답변은 최종 검색된 ${evidenceScope}에 한정됩니다.`, "warning")
    ]);
  }
  return sectionedAskAnswerContent([
    answerSection(
      "answer",
      "Answer",
      snippets.length > 0
        ? `From the retrieved video evidence, the answer is grounded in these observations: ${joinSummarySnippetsEn(snippets.slice(0, 4))}.`
        : "The retrieved moments do not contain enough ASR/OCR/visual evidence to answer this precisely."
    ),
    answerSection("evidence", "Evidence", `The strongest retrieved source is "${top.asset.title}" around ${topMoments || "the retrieved timeline"}.`, "evidence"),
    sourceProfile ? answerSection("sources", "Sources", `${sourceProfile}.`, "evidence") : null,
    answerSection("note", "Note", `This answer is limited to the retrieved ${evidenceScope}.`, "warning")
  ]);
}

function collectGroundedSnippets(results: SearchResult[]) {
  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const result of results) {
    for (const segment of result.segments) {
      const scene = segment.sceneData;
      const candidates = [
        scene?.vlm?.caption,
        scene?.vlm?.description,
        scene?.vlm?.evidence.join(", "),
        scene?.vlm?.objects.join(", "),
        scene?.vlm?.actions.join(", "),
        scene?.vlm?.labels.join(", "),
        segment.transcript,
        segment.label
      ];
      for (const candidate of candidates) {
        const text = cleanSummaryText(candidate ?? "");
        if (!text || seen.has(text)) continue;
        seen.add(text);
        snippets.push(truncateSentence(text, 140));
        if (snippets.length >= 6) return snippets;
      }
    }
  }
  return snippets;
}

function buildGenericVideoSummaryAnswer(results: SearchResult[], queryPlan: DomainQueryPlan, topMoments: string, sourceProfile: string, korean: boolean): AskAnswerContent {
  const top = results[0];
  const totalSegments = results.reduce((sum, result) => sum + result.segments.length, 0);
  const snippets = collectSummarySnippets(top);
  const evidenceScope = korean
    ? `${totalSegments}개 moment/${results.length}개 asset`
    : `${totalSegments} moments across ${results.length} assets`;
  if (korean) {
    return sectionedAskAnswerContent([
      answerSection("summary", "요약", `"${top.asset.title}"`),
      answerSection(
        "key-flow",
        "핵심 흐름",
        snippets.length > 0
          ? `검색된 indexed moments 기준 ${joinSummarySnippetsKo(snippets)}입니다.`
          : "현재 index에는 제목/metadata 중심의 근거만 있고, 요약에 쓸 충분한 ASR/OCR 문장이 제한적입니다."
      ),
      answerSection("evidence", "근거", `주요 구간은 ${topMoments || "retrieved timeline"}입니다.`, "evidence"),
      sourceProfile ? answerSection("sources", "소스", `${sourceProfile}.`, "evidence") : null,
      answerSection("note", "주의", `이 요약은 최종 검색된 ${evidenceScope}의 ASR/OCR/visual evidence에 한정됩니다.`, "warning")
    ]);
  }
  return sectionedAskAnswerContent([
    answerSection("summary", "Summary", `"${top.asset.title}".`),
    answerSection(
      "key-flow",
      "Key flow",
      snippets.length > 0
        ? `From the retrieved indexed moments, the main evidence says: ${joinSummarySnippetsEn(snippets)}.`
        : "The current index has title/metadata evidence, but limited ASR/OCR text for a fuller summary."
    ),
    answerSection("evidence", "Evidence", `The strongest retrieved moments are ${topMoments || "the retrieved timeline"}.`, "evidence"),
    sourceProfile ? answerSection("sources", "Sources", `${sourceProfile}.`, "evidence") : null,
    answerSection("note", "Note", `This summary is limited to the retrieved ${evidenceScope} and their ASR/OCR/visual evidence.`, "warning")
  ]);
}

function collectSummarySnippets(result: SearchResult) {
  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const segment of result.segments) {
    const text = cleanSummaryText(segment.sceneData?.text.speech || segment.transcript || segment.label);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    snippets.push(truncateSentence(text, 120));
    if (snippets.length >= 4) break;
  }
  return snippets;
}

function cleanSummaryText(value: string) {
  return value
    .replace(/\s*OCR:\s*.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSentence(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function joinSummarySnippetsKo(snippets: string[]) {
  if (snippets.length === 1) return `"${snippets[0]}"`;
  return snippets.map((snippet) => `"${snippet}"`).join(", ");
}

function joinSummarySnippetsEn(snippets: string[]) {
  if (snippets.length === 1) return `"${snippets[0]}"`;
  return snippets.map((snippet) => `"${snippet}"`).join("; ");
}

type MomentFeature = {
  player: string | null;
  eventType: string;
  passType: string;
  fieldZone: string;
  role: string;
  sourceText: string;
};

function collectMomentFeatures(results: SearchResult[]): MomentFeature[] {
  return results.flatMap((result) =>
    result.segments.map((segment) => {
      const event = trustedDomainEvents(segment)[0];
      const football = event?.football;
      const americanFootball = event?.americanFootball;
      const sourceText = [
        result.asset.title,
        segment.label,
        segment.transcript,
        segment.tags.join(" "),
        segment.domain?.captions.join(" "),
        segment.domain?.labels.join(" "),
        event?.caption,
        event?.labels.join(" ")
      ].filter(Boolean).join(" ");
      return {
        player:
          football?.receivingPlayer.identity?.name ??
          football?.passingPlayer.identity?.name ??
          americanFootball?.quarterback.identity?.name ??
          segment.domain?.scope?.players[0]?.value ??
          null,
        eventType: normalizeFeature(event?.eventType ?? segment.sceneData?.vision?.eventClassification?.label ?? inferEventFromText(sourceText)),
        passType: normalizeFeature(football?.passType ?? americanFootball?.playType ?? inferPassFromText(sourceText)),
        fieldZone: normalizeFeature(football?.fieldZone ?? inferZoneFromText(sourceText)),
        role: normalizeFeature(roleForSegment(segment, event?.eventType)),
        sourceText
      };
    })
  );
}

function resolveAnalysisSubject(queryPlan: DomainQueryPlan, features: MomentFeature[], korean: boolean) {
  const featureSubject = topGroup(features.map((feature) => feature.player).filter(Boolean) as string[])?.value ?? "";
  const plannedText = [
    queryPlan.intent.analysisSubject,
    queryPlan.intent.player,
    queryPlan.retrieval?.evidenceTerms.join(" "),
    queryPlan.semanticQuery,
    queryPlan.rewrittenQuery
  ].filter(Boolean).join(" ");
  const plannedMatch = matchKnowledgePlayer(plannedText)?.value;
  const canonical = queryPlan.intent.analysisSubject ?? queryPlan.intent.player ?? plannedMatch?.canonical ?? featureSubject;
  const matchedPlayer = plannedMatch ?? (canonical ? getKnowledgePlayer(canonical) ?? matchKnowledgePlayer(canonical)?.value : null);
  if (matchedPlayer && korean) {
    return matchedPlayer.aliases.find((alias) => /[가-힣]/.test(alias)) ?? canonical;
  }
  return canonical || (korean ? "요청한 대상" : "the requested subject");
}

function isPlayerInventoryPlan(queryPlan: DomainQueryPlan) {
  return queryPlan.route === "asset_catalog" || queryPlan.responseMode === "asset_lookup";
}

function roleForSegment(segment: TimelineSegment, eventType?: string) {
  const event = trustedDomainEvents(segment)[0];
  const football = event?.football;
  const americanFootball = event?.americanFootball;
  if (football?.receivingPlayer.present) return "receiver";
  if (football?.passingPlayer.present) return "passer";
  if (eventType === "shot") return "shooter";
  if (americanFootball?.quarterback.present) return "quarterback";
  return "unknown";
}

function buildStyleHeadlineKo(features: MomentFeature[]) {
  const event = topGroup(features.map((feature) => feature.eventType).filter(isKnownFeature))?.value;
  const pass = topGroup(features.map((feature) => feature.passType).filter(isKnownFeature))?.value;
  const role = topGroup(features.map((feature) => feature.role).filter(isKnownFeature))?.value;
  const text = features.map((feature) => feature.sourceText).join(" ").toLowerCase();
  if (event === "shot") return "득점 장면 중심의 마무리형 움직임";
  if (event === "dribble" || /dribble|carry|take on|드리블|돌파/.test(text)) return "공 운반과 돌파 중심의 전진 패턴";
  if (event === "pass_receive" && pass === "through_ball") return "침투 후 패스를 받는 receiver 패턴";
  if (event === "pass_receive" || role === "receiver") return "공간을 찾아 패스를 받는 오프볼 수신 패턴";
  if (event === "scramble" || event === "pocket_escape") return "압박 회피 후 의사결정 패턴";
  if (/goal|goals|scoring|득점|골/.test(text)) return "득점 영상 맥락의 공격 관여 패턴";
  return "검색된 장면에서 반복되는 이벤트 기반 패턴";
}

function buildStyleHeadlineEn(features: MomentFeature[]) {
  const event = topGroup(features.map((feature) => feature.eventType).filter(isKnownFeature))?.value;
  const pass = topGroup(features.map((feature) => feature.passType).filter(isKnownFeature))?.value;
  const role = topGroup(features.map((feature) => feature.role).filter(isKnownFeature))?.value;
  const text = features.map((feature) => feature.sourceText).join(" ").toLowerCase();
  if (event === "shot") return "finish-first attacking actions";
  if (event === "dribble" || /dribble|carry|take on/.test(text)) return "progressive carrying and take-on patterns";
  if (event === "pass_receive" && pass === "through_ball") return "receiver runs onto through balls";
  if (event === "pass_receive" || role === "receiver") return "off-ball receiving patterns";
  if (event === "scramble" || event === "pocket_escape") return "pressure escape and decision-making patterns";
  if (/goal|goals|scoring/.test(text)) return "attacking involvement in scoring-context footage";
  return "repeated event patterns in the retrieved clips";
}

function buildPatternSentencesKo(features: MomentFeature[]) {
  const total = features.length;
  const sentences = [
    groupSentenceKo("주요 event", features.map((feature) => feature.eventType), total),
    groupSentenceKo("역할", features.map((feature) => feature.role), total),
    groupSentenceKo("공간", features.map((feature) => feature.fieldZone), total),
    groupSentenceKo("패스 유형", features.map((feature) => feature.passType), total)
  ].filter(Boolean) as string[];
  const topEvent = topGroup(features.map((feature) => feature.eventType).filter(isKnownFeature))?.value;
  const sourceText = features.map((feature) => feature.sourceText).join(" ").toLowerCase();
  if (topEvent && topEvent !== "shot" && /goal|goals|scoring|득점|골/.test(sourceText)) {
    sentences.push("다만 scoring/goals 맥락은 주로 asset title/metadata에서 강하게 나타나며, 구조화 event 자체는 shot보다 수신/연계 장면으로 잡혀 있습니다.");
  }
  return sentences.length > 0 ? sentences : ["현재 index에서는 세부 event/role/zone 근거가 제한적이라, 장면 제목과 domain caption 중심으로만 분석됩니다."];
}

function buildPatternSentencesEn(features: MomentFeature[]) {
  const total = features.length;
  const sentences = [
    groupSentenceEn("Main event", features.map((feature) => feature.eventType), total),
    groupSentenceEn("Role", features.map((feature) => feature.role), total),
    groupSentenceEn("Space", features.map((feature) => feature.fieldZone), total),
    groupSentenceEn("Pass type", features.map((feature) => feature.passType), total)
  ].filter(Boolean) as string[];
  const topEvent = topGroup(features.map((feature) => feature.eventType).filter(isKnownFeature))?.value;
  const sourceText = features.map((feature) => feature.sourceText).join(" ").toLowerCase();
  if (topEvent && topEvent !== "shot" && /goal|goals|scoring/.test(sourceText)) {
    sentences.push("The scoring context is strongest in the asset title and metadata, while the structured events are grounded more as receiving/link-up moments than direct shots.");
  }
  return sentences.length > 0 ? sentences : ["The current index has limited event, role, and zone grounding, so the analysis relies mainly on scene labels and domain captions."];
}

function groupSentenceKo(label: string, values: string[], total: number) {
  const group = topGroup(values.filter(isKnownFeature));
  if (!group) return "";
  const particle = label.endsWith("event") ? "는" : "은";
  return `${label}${particle} ${labelValueKo(group.value)}가 가장 많이 반복됩니다(${group.count}/${total}).`;
}

function groupSentenceEn(label: string, values: string[], total: number) {
  const group = topGroup(values.filter(isKnownFeature));
  if (!group) return "";
  return `${label} is mostly ${group.value.replace(/_/g, " ")} (${group.count}/${total}).`;
}

function topGroup(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }))[0] ?? null;
}

function labelValueKo(value: string) {
  const labels: Record<string, string> = {
    shot: "shot/finish",
    dribble: "dribble/carry",
    pass_receive: "pass receive",
    through_ball: "through ball",
    short_pass: "short pass",
    long_ball: "long ball",
    cross: "cross",
    cutback: "cutback",
    final_third: "final third",
    penalty_area: "penalty area",
    middle_third: "middle third",
    defensive_third: "defensive third",
    receiver: "receiver",
    passer: "passer",
    shooter: "shooter",
    scramble: "scramble",
    pocket_escape: "pocket escape",
    throw_on_run: "throw on run",
    pressure: "pressure"
  };
  return labels[value] ?? value.replace(/_/g, " ");
}

function normalizeFeature(value: string | null | undefined) {
  const normalized = (value ?? "").trim();
  return normalized || "unknown";
}

function isKnownFeature(value: string) {
  return Boolean(value && value !== "unknown" && !value.startsWith("unknown_"));
}

function inferEventFromText(text: string) {
  const normalized = text.toLowerCase();
  if (/dribble|carry|take on|드리블|돌파/.test(normalized)) return "dribble";
  if (/through ball|receive|receiving|pass receive|스루패스|패스 받|받는/.test(normalized)) return "pass_receive";
  if (/goal|goals|scoring|shot|finish|득점|골|슈팅|슛/.test(normalized)) return "shot";
  if (/scramble|스크램블/.test(normalized)) return "scramble";
  if (/pocket escape|out of the pocket|포켓 탈출/.test(normalized)) return "pocket_escape";
  if (/pressure|압박/.test(normalized)) return "pressure";
  return "unknown";
}

function inferPassFromText(text: string) {
  const normalized = text.toLowerCase();
  if (/through ball|스루패스|침투패스/.test(normalized)) return "through_ball";
  if (/cutback|cut back|컷백/.test(normalized)) return "cutback";
  if (/cross|크로스/.test(normalized)) return "cross";
  return "unknown";
}

function inferZoneFromText(text: string) {
  const normalized = text.toLowerCase();
  if (/final third|attacking third|파이널 서드|공격 진영/.test(normalized)) return "final_third";
  if (/penalty area|box|페널티 박스|박스/.test(normalized)) return "penalty_area";
  if (/middle third/.test(normalized)) return "middle_third";
  if (/defensive third/.test(normalized)) return "defensive_third";
  return "unknown";
}

function collectInventoryPlayerNames(results: SearchResult[]) {
  const names = new Map<string, string>();
  const addName = (value: string | null | undefined) => {
    const cleaned = (value ?? "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/^mentioned players:\s*/i, "")
      .trim();
    if (!cleaned || cleaned.toLowerCase() === "unknown") return;
    const normalized = cleaned.toLowerCase();
    if (Array.from(names.values()).some((existing) => likelySamePlayerName(cleaned, existing))) return;
    if (!names.has(normalized)) names.set(normalized, cleaned);
  };
  for (const result of results) {
    for (const line of result.explain) {
      const match = line.match(/mentioned players:\s*(.+)$/i);
      if (match) {
        for (const name of match[1].split(",")) addName(name);
      }
    }
    for (const reason of result.matchReasons) {
      if (reason.label === "Player") addName(reason.value);
    }
    for (const segment of result.segments) {
      for (const player of segment.domain?.scope?.players ?? []) addName(player.value);
      for (const event of trustedDomainEvents(segment)) {
        addName(event.football?.receivingPlayer.identity?.name);
        addName(event.football?.passingPlayer.identity?.name);
        addName(event.americanFootball?.quarterback.identity?.name);
      }
    }
  }
  return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
}

function likelySamePlayerName(candidate: string, existing: string) {
  const candidateParts = candidate.toLowerCase().replace(/[^a-z가-힣.\s-]/g, " ").split(/\s+/).filter(Boolean);
  const existingParts = existing.toLowerCase().replace(/[^a-z가-힣.\s-]/g, " ").split(/\s+/).filter(Boolean);
  if (candidateParts.join(" ") === existingParts.join(" ")) return true;
  const candidateLast = candidateParts.at(-1)?.replace(/\./g, "");
  const existingLast = existingParts.at(-1)?.replace(/\./g, "");
  const candidateInitial = candidateParts[0]?.[0];
  const existingInitial = existingParts[0]?.[0];
  return Boolean(candidateLast && existingLast && candidateLast === existingLast && candidateInitial && existingInitial && candidateInitial === existingInitial);
}

function isKoreanQuery(query: string) {
  return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function summarizeResultSources(results: SearchResult[]) {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const segment of result.segments) {
      for (const source of segment.sources) counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}=${count}`)
    .join(", ");
}

export function plainAskAnswerContent(text: string): AskAnswerContent {
  const trimmed = text.trim();
  return {
    format: "plain",
    text: trimmed,
    sections: trimmed ? [answerSection("answer", null, trimmed)] : []
  };
}

function sectionedAskAnswerContent(items: Array<AskAnswerSection | null | undefined>): AskAnswerContent {
  const sections = items.filter((item): item is AskAnswerSection => Boolean(item && item.body.trim()));
  return {
    format: "sections",
    text: sections.map((section) => (section.label ? `${section.label}: ${section.body}` : section.body)).join("\n"),
    sections
  };
}

function answerSection(id: string, label: string | null, body: string, tone: AskAnswerSection["tone"] = "neutral"): AskAnswerSection {
  return {
    id,
    label,
    body: body.trim(),
    tone
  };
}
