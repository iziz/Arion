import { buildOrchestrationPlan } from "../../orchestrator";
import { planDomainQueryWithOpenAi } from "../../openaiQueryPlanner";
import { answerSportsKnowledgeQuestion } from "../../sportsKnowledgeQa";
import { listAssets, listIndexes } from "../../store";
import { buildAskAnalysisAnswer, buildAskVideoAnswer } from "./answerBuilder";
import { completeAskOperation, failAskOperation, updateAskOperation } from "./operationStore";
import { executeSearchPipeline, scopeAssetsForQuery } from "./searchPipeline";
import {
  applyScopeDomainDefaults,
  buildStatSeededMomentPlan,
  shouldContinueWithMomentRetrieval
} from "./statMomentSeed";
import { runAskStep, skipAskStep } from "./stepRunner";
import type { AskOperationEntry, AskRequest } from "./types";

export async function runAskOperation(entry: AskOperationEntry, request: AskRequest) {
  try {
    updateAskOperation(entry, { status: "running", route: "pending", error: null });
    const scoped = await runAskStep(entry, {
      id: "scope",
      label: "Asset scope",
      owner: "platform",
      input: [
        request.assetId ? `asset=${request.assetId}` : "",
        request.indexId ? `index=${request.indexId}` : request.domainGroup ? `domain=${request.domainGroup}` : "all indexes",
        request.tag ? `tag=${request.tag}` : "",
        request.modality ? `modality=${request.modality}` : ""
      ].filter(Boolean).join(" · ")
    }, async () => {
      const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
      const scopedAssets = scopeAssetsForQuery(assets, request, indexes);
      return {
        value: { assets, indexes, scopedAssets },
        output: `${scopedAssets.length}/${assets.length} assets in scope`
      };
    });
    const planningFilters = applyScopeDomainDefaults(request.explicitFilters, { ...request, indexId: request.indexId ?? (request.assetId ? scoped.scopedAssets[0]?.indexId : undefined) }, scoped.indexes);

    let queryPlan = await runAskStep(entry, {
      id: "plan",
      label: "Query planning",
      owner: "router",
      input: request.query || "Filtered search"
    }, async () => {
      const plan = await planDomainQueryWithOpenAi(request.query, planningFilters);
      return {
        value: plan,
        output: `${plan.route.replace(/_/g, " ")} · ${plan.responseMode.replace(/_/g, " ")} · ${plan.knowledgeMode.replace(/_/g, " ")} · ${Math.round(plan.confidence * 100)}%`
      };
    });

    const shouldRunKnowledgeAnswer = request.useKnowledgeLayer && isDirectKnowledgeAnswerPlan(queryPlan);
    const sportsAnswer = shouldRunKnowledgeAnswer
      ? await runAskStep(entry, {
          id: "knowledge_answer",
          label: "Knowledge answer",
          owner: "knowledge",
          input: queryPlan.rewrittenQuery
        }, async () => {
          const answer = answerSportsKnowledgeQuestion(queryPlan);
          return {
            value: answer,
            output: answer.applicable ? `${answer.status} · ${answer.subject.metric ?? "no metric"} · ${Math.round(answer.confidence * 100)}%` : "not applicable",
            status: answer.applicable && answer.status !== "answered" ? "fallback" : "succeeded"
          };
        })
      : disabledSportsKnowledgeAnswer(
          queryPlan,
          request.useKnowledgeLayer
            ? "Knowledge direct answer is skipped for this retrieval workflow."
            : "Knowledge layer is disabled for this search.",
          request.useKnowledgeLayer
            ? "Knowledge direct answer was skipped because the route is not a knowledge-answer route."
            : "Knowledge layer was disabled by the selected search scope."
        );
    if (!shouldRunKnowledgeAnswer && isDirectKnowledgeAnswerPlan(queryPlan)) {
      skipAskStep(entry, {
        id: "knowledge_answer",
        label: "Knowledge answer",
        owner: "knowledge",
        input: queryPlan.rewrittenQuery,
        output: request.useKnowledgeLayer ? "Skipped because this route does not need a direct knowledge answer." : "Disabled by selected search scope."
      });
    }

    const statSeeded = shouldContinueWithMomentRetrieval(queryPlan, sportsAnswer);
    const continueWithRetrieval = statSeeded;
    if (statSeeded) {
      queryPlan = buildStatSeededMomentPlan(queryPlan, sportsAnswer);
    }

    const orchestrationPlan = await runAskStep(entry, {
      id: "orchestrate",
      label: "Query orchestration",
      owner: "router",
      input: queryPlan.rewrittenQuery
    }, async () => {
      const plan = buildOrchestrationPlan(queryPlan, scoped.scopedAssets, scoped.indexes);
      return {
        value: plan,
        output: `${plan.mode.replace(/_/g, " ")} · ${plan.retrieval.engine.replace(/_/g, " ")}`
      };
    });

    if (isDirectKnowledgeAnswerPlan(queryPlan) && sportsAnswer.applicable && sportsAnswer.route === "stat_qa" && !continueWithRetrieval) {
      skipAskStep(entry, {
        id: "retrieve",
        label: "Moment retrieval",
        owner: "retrieval",
        input: queryPlan.semanticQuery,
        output: "Skipped because this is a direct structured knowledge question."
      });
      completeAskOperation(entry, {
        operation: entry.operation,
        route: "structured_answer",
        answer: sportsAnswer.answer,
        queryPlan,
        orchestrationPlan,
        sportsAnswer,
        results: [],
        warnings: [...queryPlan.warnings, ...sportsAnswer.warnings]
      });
      return;
    }

    const results = await executeSearchPipeline({
      query: request.query,
      explicitFilters: planningFilters,
      queryPlan,
      assets: scoped.assets,
      indexes: scoped.indexes,
      indexId: request.indexId,
      assetId: request.assetId,
      domainGroup: request.domainGroup,
      tag: request.tag,
      modality: request.modality,
      limit: request.limit,
      useKnowledgeLayer: request.useKnowledgeLayer,
      askEntry: entry
    });
    const answer = orchestrationPlan.analysis.required
      ? await runAskStep(entry, {
          id: "analysis",
          label: "Grounded analysis",
          owner: "analysis",
          input: `${results.length} retrieved assets`
        }, async () => {
          const nextAnswer = buildAskAnalysisAnswer(results, queryPlan, orchestrationPlan);
          return {
            value: nextAnswer,
            output: results.length > 0 ? analysisOutputForMode(queryPlan.responseMode) : "Skipped because retrieval returned no moments.",
            status: results.length > 0 ? "succeeded" : "skipped"
          };
        })
      : buildAskVideoAnswer(results, queryPlan);
    const route = results.length > 0 ? "moment_retrieval" : "empty";
    completeAskOperation(entry, {
      operation: entry.operation,
      route,
      answer,
      queryPlan,
      orchestrationPlan,
      sportsAnswer: sportsAnswer.applicable ? sportsAnswer : null,
      results,
      warnings: [...queryPlan.warnings, ...(sportsAnswer.applicable ? sportsAnswer.warnings : [])]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ask operation failed";
    failAskOperation(entry, message);
  }
}

function analysisOutputForMode(responseMode: Parameters<typeof buildAskAnalysisAnswer>[1]["responseMode"]) {
  if (responseMode === "summary") return "Generated a local video summary from retrieved evidence.";
  if (responseMode === "analysis") return "Generated a local pattern analysis from retrieved moments.";
  return "Generated a local grounded answer from retrieved moments.";
}

function isDirectKnowledgeAnswerPlan(queryPlan: Parameters<typeof answerSportsKnowledgeQuestion>[0]) {
  return queryPlan.route === "knowledge_evidence" && queryPlan.responseMode === "structured_answer" && queryPlan.knowledgeMode === "direct_answer";
}

function disabledSportsKnowledgeAnswer(
  queryPlan: Parameters<typeof answerSportsKnowledgeQuestion>[0],
  answer: string,
  warning: string
): ReturnType<typeof answerSportsKnowledgeQuestion> {
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
