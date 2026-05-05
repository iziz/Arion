import type { Express } from "express";
import { isKnownKnowledgeSourceId } from "../../shared/knowledgeSources";
import { sendNotFound } from "../http/middleware";
import { answerStructuredKnowledgeQuestion } from "../knowledge/answer";
import { planDomainQueryWithOpenAi } from "../openaiQueryPlanner";
import { parseDomainFilters } from "../queryPlanner";
import { checkVlmWorkerHealth } from "../vlmWorkerClient";
import { executeSearchPipeline, getAskOperationResponse, parseAskRequest, scopeAssetsForQuery, startAskOperation } from "../workflows/askWorkflow";
import {
  applyScopeDomainDefaults,
  buildStatSeededMomentPlan,
  shouldContinueWithMomentRetrieval
} from "../workflows/ask/statMomentSeed";
import { listAssets, listIndexes } from "../store";

export function registerAskRoutes(app: Express) {
  app.post("/api/ask", async (req, res) => {
    const request = parseAskRequest(req.body);
    res.status(202).json(await startAskOperation(request));
  });

  app.get("/api/ask/:id", async (req, res) => {
    const response = await getAskOperationResponse(String(req.params.id));
    if (!response) return sendNotFound(res, "Ask operation not found");
    res.json(response);
  });

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.q ?? "");
    const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
    const domainGroup = domainGroupValue(req.query.domainGroup);
    const indexId = req.query.indexId ? String(req.query.indexId) : undefined;
    const assetId = req.query.assetId ? String(req.query.assetId) : undefined;
    const assetScopeIndexId = assetId ? assets.find((asset) => asset.id === assetId)?.indexId : undefined;
    const useKnowledgeLayer = req.query.useKnowledgeLayer !== "false";
    const explicitFilters = applyScopeDomainDefaults(parseDomainFilters(req.query), { indexId: indexId ?? assetScopeIndexId, domainGroup }, indexes);
    const queryPlan = await planDomainQueryWithOpenAi(query, explicitFilters);
    if (useKnowledgeLayer && queryPlan.route === "knowledge_evidence" && queryPlan.responseMode === "structured_answer" && queryPlan.knowledgeMode === "direct_answer") {
      const knowledgeAnswer = answerStructuredKnowledgeQuestion(queryPlan);
      const scopedAssets = scopeAssetsForQuery(assets, {
        query,
        explicitFilters,
        indexId,
        assetId,
        domainGroup,
        tag: req.query.tag ? String(req.query.tag) : undefined,
        modality: req.query.modality ? String(req.query.modality) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        useKnowledgeLayer
      }, indexes);
      const retrievalPlan = shouldContinueWithMomentRetrieval(queryPlan, knowledgeAnswer)
        ? buildStatSeededMomentPlan(queryPlan, knowledgeAnswer)
        : null;
      if (retrievalPlan) {
        res.json(
          await executeSearchPipeline({
            query,
            explicitFilters,
            queryPlan: retrievalPlan,
            assets,
            indexes,
            indexId,
            assetId,
            domainGroup,
            tag: req.query.tag ? String(req.query.tag) : undefined,
            modality: req.query.modality ? String(req.query.modality) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            useKnowledgeLayer
          })
        );
        return;
      }
      res.status(409).json({
        error: "This query asks for a direct structured knowledge answer. Use the related knowledge answer endpoint instead of /api/search.",
        route: "structured_answer",
        answer: knowledgeAnswer
      });
      return;
    }
    res.json(
      await executeSearchPipeline({
        query,
        explicitFilters,
        queryPlan,
        assets,
        indexes,
        indexId,
        assetId,
        domainGroup,
        tag: req.query.tag ? String(req.query.tag) : undefined,
        modality: req.query.modality ? String(req.query.modality) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        useKnowledgeLayer
      })
    );
  });


  app.get("/api/models/vlm/health", async (_req, res) => {
    res.json(await checkVlmWorkerHealth());
  });

  app.get("/api/search/plan", async (req, res) => {
    const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
    const domainGroup = domainGroupValue(req.query.domainGroup);
    const indexId = req.query.indexId ? String(req.query.indexId) : undefined;
    const assetId = req.query.assetId ? String(req.query.assetId) : undefined;
    const assetScopeIndexId = assetId ? assets.find((asset) => asset.id === assetId)?.indexId : undefined;
    const explicitFilters = applyScopeDomainDefaults(parseDomainFilters(req.query), { indexId: indexId ?? assetScopeIndexId, domainGroup }, indexes);
    res.json(await planDomainQueryWithOpenAi(String(req.query.q ?? ""), explicitFilters));
  });

  app.get(["/api/knowledge/answer", "/api/knowledge/sports/answer"], async (req, res) => {
    const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
    const domainGroup = domainGroupValue(req.query.domainGroup);
    const indexId = req.query.indexId ? String(req.query.indexId) : undefined;
    const assetId = req.query.assetId ? String(req.query.assetId) : undefined;
    const assetScopeIndexId = assetId ? assets.find((asset) => asset.id === assetId)?.indexId : undefined;
    const explicitFilters = applyScopeDomainDefaults(parseDomainFilters(req.query), { indexId: indexId ?? assetScopeIndexId, domainGroup }, indexes);
    const queryPlan = await planDomainQueryWithOpenAi(String(req.query.q ?? ""), explicitFilters);
    res.json(answerStructuredKnowledgeQuestion(queryPlan));
  });
}

function domainGroupValue(value: unknown) {
  return isKnownKnowledgeSourceId(value) ? value : undefined;
}
