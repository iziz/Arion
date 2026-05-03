import { buildOrchestrationPlan } from "../../orchestrator";
import { planDomainQueryWithOpenAi } from "../../openaiQueryPlanner";
import { answerSportsKnowledgeQuestion } from "../../sportsKnowledgeQa";
import { listAssets, listIndexes } from "../../store";
import { buildAskAnalysisAnswer, buildAskVideoAnswer } from "./answerBuilder";
import { completeAskOperation, failAskOperation, updateAskOperation } from "./operationStore";
import { executeSearchPipeline, scopeAssetsForQuery } from "./searchPipeline";
import { runAskStep, skipAskStep } from "./stepRunner";
import type { AskOperationEntry, AskRequest } from "./types";

export async function runAskOperation(entry: AskOperationEntry, request: AskRequest) {
  try {
    updateAskOperation(entry, { status: "running", route: "pending", error: null });
    const queryPlan = await runAskStep(entry, {
      id: "plan",
      label: "Query planning",
      owner: "router",
      input: request.query || "Filtered search"
    }, async () => {
      const plan = await planDomainQueryWithOpenAi(request.query, request.explicitFilters);
      return {
        value: plan,
        output: `${plan.intent.questionType ?? "moment_retrieval"} · ${plan.rewrittenQuery} · ${Math.round(plan.confidence * 100)}%`
      };
    });

    const scoped = await runAskStep(entry, {
      id: "scope",
      label: "Asset scope",
      owner: "platform",
      input: [request.indexId ? `index=${request.indexId}` : "all indexes", request.tag ? `tag=${request.tag}` : "", request.modality ? `modality=${request.modality}` : ""].filter(Boolean).join(" · ")
    }, async () => {
      const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
      const scopedAssets = scopeAssetsForQuery(assets, request);
      return {
        value: { assets, indexes, scopedAssets },
        output: `${scopedAssets.length}/${assets.length} assets in scope`
      };
    });

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

    const sportsAnswer = await runAskStep(entry, {
      id: "knowledge_answer",
      label: "Sports knowledge answer",
      owner: "knowledge",
      input: queryPlan.rewrittenQuery
    }, async () => {
      const answer = answerSportsKnowledgeQuestion(queryPlan);
      return {
        value: answer,
        output: answer.applicable ? `${answer.status} · ${answer.subject.metric ?? "no metric"} · ${Math.round(answer.confidence * 100)}%` : "not applicable",
        status: answer.applicable && answer.status !== "answered" ? "fallback" : "succeeded"
      };
    });

    if (sportsAnswer.applicable && sportsAnswer.route === "stat_qa") {
      skipAskStep(entry, {
        id: "retrieve",
        label: "Moment retrieval",
        owner: "retrieval",
        input: queryPlan.semanticQuery,
        output: "Skipped because this is a structured sports statistics question."
      });
      completeAskOperation(entry, {
        operation: entry.operation,
        route: "stat_qa",
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
      explicitFilters: request.explicitFilters,
      queryPlan,
      assets: scoped.assets,
      indexes: scoped.indexes,
      indexId: request.indexId,
      tag: request.tag,
      modality: request.modality,
      limit: request.limit,
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
            output: results.length > 0 ? "Generated a local pattern summary from retrieved moments." : "Skipped because retrieval returned no moments.",
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
      sportsAnswer: null,
      results,
      warnings: queryPlan.warnings
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ask operation failed";
    failAskOperation(entry, message);
  }
}
