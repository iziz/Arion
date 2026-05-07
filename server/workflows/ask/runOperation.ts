import { buildOrchestrationPlan } from "../../orchestrator";
import { planDomainQueryWithLlm } from "../../llmQueryPlanner";
import {
  answerStructuredKnowledgeQuestion,
  disabledStructuredKnowledgeAnswer,
  isDirectKnowledgeAnswerPlan
} from "../../knowledge/answer";
import { listAssets, listIndexes } from "../../store";
import { buildAskAnalysisAnswerContent, buildAskVideoAnswerContent, plainAskAnswerContent } from "./answerBuilder";
import { completeAskOperation, failAskOperation, updateAskOperation } from "./operationStore";
import { executeSearchPipeline, scopeAssetsForQuery } from "./searchPipeline";
import {
  applyScopeDomainDefaults,
  buildStatSeedKnowledgePlan,
  buildStatSeededMomentPlan,
  isKnowledgeSeededMomentPlan,
  shouldContinueWithMomentRetrieval
} from "./statMomentSeed";
import { runAskStep, skipAskStep } from "./stepRunner";
import type { DomainQueryPlan } from "../../../shared/types";
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
      const plan = await planDomainQueryWithLlm(request.query, planningFilters);
      return {
        value: plan,
        output: `${plan.route.replace(/_/g, " ")} · ${plan.responseMode.replace(/_/g, " ")} · ${plan.relatedKnowledgeMode.replace(/_/g, " ")} · ${Math.round(plan.confidence * 100)}%`
      };
    });

    const seedKnowledgePlan = isKnowledgeSeededMomentPlan(queryPlan) ? buildStatSeedKnowledgePlan(queryPlan) : queryPlan;
    const shouldRunKnowledgeAnswer = request.useKnowledgeLayer && (isDirectKnowledgeAnswerPlan(queryPlan) || isKnowledgeSeededMomentPlan(queryPlan));
    const knowledgeAnswer = shouldRunKnowledgeAnswer
      ? await runAskStep(entry, {
          id: "knowledge_answer",
          label: "Related knowledge answer",
          owner: "knowledge",
          input: seedKnowledgePlan.rewrittenQuery
        }, async () => {
          const answer = answerStructuredKnowledgeQuestion(seedKnowledgePlan);
          return {
            value: answer,
            output: answer.applicable ? `${answer.status} · ${answer.subject.metric ?? "no metric"} · ${Math.round(answer.confidence * 100)}%` : "not applicable",
            status: answer.applicable && answer.status !== "answered" ? "fallback" : "succeeded"
          };
        })
      : disabledStructuredKnowledgeAnswer(
          seedKnowledgePlan,
          request.useKnowledgeLayer
            ? "Related knowledge direct answer is skipped for this retrieval workflow."
            : "Related knowledge layer is disabled for this search.",
          request.useKnowledgeLayer
            ? "Related knowledge direct answer was skipped because the route is not a related-knowledge answer route."
            : "Related knowledge layer was disabled by the selected search scope."
        );
    if (!shouldRunKnowledgeAnswer && (isDirectKnowledgeAnswerPlan(queryPlan) || isKnowledgeSeededMomentPlan(queryPlan))) {
      skipAskStep(entry, {
        id: "knowledge_answer",
        label: "Related knowledge answer",
        owner: "knowledge",
        input: seedKnowledgePlan.rewrittenQuery,
        output: request.useKnowledgeLayer ? "Skipped because this route does not need a direct knowledge answer." : "Disabled by selected search scope."
      });
    }

    const statSeeded = shouldContinueWithMomentRetrieval(queryPlan, knowledgeAnswer);
    const continueWithRetrieval = statSeeded;
    if (statSeeded) {
      queryPlan = buildStatSeededMomentPlan(queryPlan, knowledgeAnswer);
    } else if (isKnowledgeSeededMomentPlan(queryPlan)) {
      skipAskStep(entry, {
        id: "retrieve",
        label: "Moment retrieval",
        owner: "retrieval",
        input: queryPlan.semanticQuery,
        output: "Skipped because related knowledge did not resolve a ranked subject for video retrieval."
      });
      const answerContent = plainAskAnswerContent(knowledgeAnswer.answer);
      const orchestrationPlan = buildOrchestrationPlan(queryPlan, scoped.scopedAssets, scoped.indexes);
      completeAskOperation(entry, {
        operation: entry.operation,
        route: "structured_answer",
        answerContent,
        queryPlan,
        orchestrationPlan,
        knowledgeAnswer: knowledgeAnswer.applicable ? knowledgeAnswer : null,
        results: [],
        warnings: [...queryPlan.warnings, ...knowledgeAnswer.warnings]
      });
      return;
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

    if (isDirectKnowledgeAnswerPlan(queryPlan) && knowledgeAnswer.applicable && knowledgeAnswer.route === "stat_qa" && !continueWithRetrieval) {
      skipAskStep(entry, {
        id: "retrieve",
        label: "Moment retrieval",
        owner: "retrieval",
        input: queryPlan.semanticQuery,
        output: "Skipped because this is a direct structured knowledge question."
      });
      const answerContent = plainAskAnswerContent(knowledgeAnswer.answer);
      completeAskOperation(entry, {
        operation: entry.operation,
        route: "structured_answer",
        answerContent,
        queryPlan,
        orchestrationPlan,
        knowledgeAnswer,
        results: [],
        warnings: [...queryPlan.warnings, ...knowledgeAnswer.warnings]
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
    const answerContent = orchestrationPlan.analysis.required
      ? await runAskStep(entry, {
          id: "analysis",
          label: "Grounded analysis",
          owner: "analysis",
          input: `${results.length} retrieved assets`
        }, async () => {
          const nextAnswer = buildAskAnalysisAnswerContent(results, queryPlan, orchestrationPlan);
          return {
            value: nextAnswer,
            output: results.length > 0 ? analysisOutputForMode(queryPlan.responseMode) : "Skipped because retrieval returned no moments.",
            status: results.length > 0 ? "succeeded" : "skipped"
          };
        })
      : buildAskVideoAnswerContent(results, queryPlan);
    const route = results.length > 0 ? "moment_retrieval" : "empty";
    completeAskOperation(entry, {
      operation: entry.operation,
      route,
      answerContent,
      queryPlan,
      orchestrationPlan,
      knowledgeAnswer: knowledgeAnswer.applicable ? knowledgeAnswer : null,
      results,
      warnings: [...queryPlan.warnings, ...(knowledgeAnswer.applicable ? knowledgeAnswer.warnings : [])]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ask operation failed";
    failAskOperation(entry, message);
  }
}

function analysisOutputForMode(responseMode: DomainQueryPlan["responseMode"]) {
  if (responseMode === "summary") return "Generated a local video summary from retrieved evidence.";
  if (responseMode === "analysis") return "Generated a local pattern analysis from retrieved moments.";
  return "Generated a local grounded answer from retrieved moments.";
}
