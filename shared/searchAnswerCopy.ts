import type { DomainQueryPlan } from "./types";

export function buildEmptySearchAnswer(queryPlan: Pick<DomainQueryPlan, "originalQuery" | "route"> & Partial<Pick<DomainQueryPlan, "responseMode" | "knowledgeMode">>) {
  const korean = isKoreanQuery(queryPlan.originalQuery);
  if (queryPlan.route === "unsupported") {
    return korean
      ? "이 질문은 현재 video search route로 처리하지 않았습니다. 검색 가능한 영상 장면, 요약, 또는 지원되는 sports 질문으로 다시 입력해 주세요."
      : "This question was not routed to video search. Ask for a searchable video moment, summary, or supported sports question.";
  }
  if ("knowledgeMode" in queryPlan && queryPlan.knowledgeMode !== "none") {
    return korean
      ? "이 질문과 일치하는 indexed video moment를 찾지 못했습니다. 이벤트, 선수, 시즌을 더 구체화하거나 evidence filter를 낮춰보세요."
      : "No indexed video moment matched this query. Try adding an event, player, season, or lowering the trust filters.";
  }
  if ("responseMode" in queryPlan && queryPlan.responseMode === "summary") {
    return korean
      ? "현재 선택한 검색 범위에서 요약할 indexed video moment를 찾지 못했습니다. 영상 인덱싱 상태를 확인하거나 검색 범위를 넓혀보세요."
      : "No indexed video moment was available to summarize in the selected scope. Check indexing status or broaden the search scope.";
  }
  return korean
    ? "현재 선택한 검색 범위에서 이 질문과 일치하는 indexed video moment를 찾지 못했습니다. 영상 인덱싱 상태, 검색 범위, 질문 표현을 확인해보세요."
    : "No indexed video moment matched this query in the selected scope. Check indexing status, search scope, or the query wording.";
}

function isKoreanQuery(query: string) {
  return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(query);
}
