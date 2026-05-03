import type { DomainQueryPlan, OrchestrationPlan, SearchResult, TimelineSegment } from "../../../shared/types";
import { trustedDomainEvents } from "../../evidenceTrust";
import { isPlayerInventoryQuery } from "../../queryPlanner";
import type { AskRequest } from "./types";

export function formatSearchScope({ indexId, domainGroup, tag, modality }: Pick<AskRequest, "indexId" | "domainGroup" | "tag" | "modality">) {
  return [
    indexId ? `index=${indexId}` : domainGroup ? `domain=${domainGroup}` : "all indexes",
    tag ? `tag=${tag}` : "",
    modality ? `modality=${modality}` : ""
  ].filter(Boolean).join(" · ");
}

export function buildAskVideoAnswer(results: SearchResult[], queryPlan: DomainQueryPlan) {
  const korean = isKoreanQuery(queryPlan.originalQuery);
  if (results.length === 0) {
    return korean
      ? "이 질문과 일치하는 indexed video moment를 찾지 못했습니다. 이벤트, 선수, 시즌을 더 구체화하거나 evidence filter를 낮춰보세요."
      : "No indexed video moment matched this query. Try adding an event, player, season, or lowering the trust filters.";
  }
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  if (isPlayerInventoryQuery(queryPlan.originalQuery)) {
    return buildPlayerInventoryAnswer(results, segmentCount, korean);
  }
  const player = queryPlan.intent.player ? ` for ${queryPlan.intent.player}` : "";
  const event = queryPlan.intent.eventType ? ` matching ${queryPlan.intent.eventType.replace(/_/g, " ")}` : "";
  if (korean) {
    const focus = [
      queryPlan.intent.player ? `player=${queryPlan.intent.player}` : "",
      queryPlan.intent.eventType ? `event=${queryPlan.intent.eventType}` : ""
    ].filter(Boolean).join(" · ");
    return `${results.length}개 asset에서 ${segmentCount}개의 indexed moment를 찾았습니다${focus ? ` (${focus})` : ""}.`;
  }
  return `Found ${segmentCount} indexed moments across ${results.length} assets${player}${event}.`;
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

export function buildAskAnalysisAnswer(results: SearchResult[], queryPlan: DomainQueryPlan, orchestrationPlan: OrchestrationPlan) {
  if (results.length === 0) return buildAskVideoAnswer(results, queryPlan);
  const korean = isKoreanQuery(queryPlan.originalQuery);
  const segmentCount = results.reduce((sum, result) => sum + result.segments.length, 0);
  const top = results[0];
  const topMoments = top.segments.slice(0, 3).map((segment) => `${formatClock(segment.start)}-${formatClock(segment.end)}`).join(", ");
  const sourceProfile = summarizeResultSources(results);
  const features = collectMomentFeatures(results);
  const subject = queryPlan.intent.player ?? topGroup(features.map((feature) => feature.player).filter(Boolean) as string[])?.value ?? "the requested player";
  const headline = korean ? buildStyleHeadlineKo(features) : buildStyleHeadlineEn(features);
  const patternSentences = korean ? buildPatternSentencesKo(features) : buildPatternSentencesEn(features);
  const evidenceLine = korean
    ? `"${top.asset.title}"의 ${topMoments || "retrieved timeline"} 구간이 가장 강한 근거이며, 전체 분석은 ${segmentCount}개 moment/${results.length}개 asset에 한정됩니다.`
    : `The strongest source asset is "${top.asset.title}" with key moments around ${topMoments || "the retrieved timeline"}, and the analysis is limited to ${segmentCount} moments across ${results.length} assets.`;
  if (korean) {
    return [
      `${subject}의 플레이 스타일은 현재 검색된 영상 기준으로 "${headline}"으로 요약됩니다.`,
      patternSentences.join(" "),
      evidenceLine,
      sourceProfile ? `근거 소스: ${sourceProfile}.` : "",
      orchestrationPlan.analysis.required ? "주의: 이 결론은 최종 검색된 indexed moments만 분석한 결과이며, 영상 전체나 외부 통계로 일반화하지 않습니다." : ""
    ].filter(Boolean).join(" ");
  }
  const focus = [
    queryPlan.intent.player ? `player=${queryPlan.intent.player}` : "",
    queryPlan.intent.eventType ? `event=${queryPlan.intent.eventType}` : "",
    queryPlan.intent.fieldZone ? `zone=${queryPlan.intent.fieldZone}` : ""
  ].filter(Boolean).join(" · ");
  return [
    `${subject}'s play style from the retrieved indexed video is best summarized as "${headline}".`,
    patternSentences.join(" "),
    `I analyzed ${segmentCount} indexed moments across ${results.length} assets${focus ? ` (${focus})` : ""}.`,
    evidenceLine,
    sourceProfile ? `Sources: ${sourceProfile}.` : "",
    orchestrationPlan.analysis.required ? "This conclusion is grounded only in the retrieved indexed moments and should not be generalized to all games or external statistics." : ""
  ].filter(Boolean).join(" ");
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
