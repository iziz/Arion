import type { DomainQueryPlan, StructuredKnowledgeAnswer } from "../../shared/types";
import { answerSportsKnowledgeQuestion } from "./adapters/sports/answer";

export function answerStructuredKnowledgeQuestion(queryPlan: DomainQueryPlan): StructuredKnowledgeAnswer {
  return answerSportsKnowledgeQuestion(queryPlan);
}

export function isDirectKnowledgeAnswerPlan(queryPlan: DomainQueryPlan) {
  return queryPlan.route === "knowledge_evidence" && queryPlan.responseMode === "structured_answer" && queryPlan.knowledgeMode === "direct_answer";
}

export function disabledStructuredKnowledgeAnswer(queryPlan: DomainQueryPlan, answer: string, warning: string): StructuredKnowledgeAnswer {
  return {
    applicable: false,
    route: "unsupported",
    answer,
    confidence: 0,
    subject: {
      player: queryPlan.intent.player,
      competition: queryPlan.domainFilters.competition ?? null,
      season: queryPlan.domainFilters.season ?? null,
      metric: queryPlan.intent.metric ?? null
    },
    value: null,
    status: "unsupported",
    evidence: [],
    fallback: null,
    warnings: [warning]
  };
}
