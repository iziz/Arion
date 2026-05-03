import type { Express } from "express";
import { sendNotFound } from "../http/middleware";
import { planDomainQueryWithOpenAi } from "../openaiQueryPlanner";
import { parseDomainFilters } from "../queryPlanner";
import { answerSportsKnowledgeQuestion } from "../sportsKnowledgeQa";
import { checkVlmWorkerHealth } from "../vlmWorkerClient";
import { executeSearchPipeline, getAskOperationResponse, parseAskRequest, startAskOperation } from "../workflows/askWorkflow";
import { listAssets, listIndexes } from "../store";

export function registerAskRoutes(app: Express) {
  app.post("/api/ask", async (req, res) => {
    const request = parseAskRequest(req.body);
    res.status(202).json(startAskOperation(request));
  });

  app.get("/api/ask/:id", async (req, res) => {
    const response = getAskOperationResponse(String(req.params.id));
    if (!response) return sendNotFound(res, "Ask operation not found");
    res.json(response);
  });

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.q ?? "");
    const explicitFilters = parseDomainFilters(req.query);
    const queryPlan = await planDomainQueryWithOpenAi(query, explicitFilters);
    const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
    if (queryPlan.intent.questionType === "stat_qa") {
      res.status(409).json({
        error: "This query asks for aggregate sports statistics. Use /api/knowledge/sports/answer instead of /api/search.",
        route: "stat_qa",
        answer: answerSportsKnowledgeQuestion(queryPlan)
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
        indexId: req.query.indexId ? String(req.query.indexId) : undefined,
        tag: req.query.tag ? String(req.query.tag) : undefined,
        modality: req.query.modality ? String(req.query.modality) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined
      })
    );
  });


  app.get("/api/models/vlm/health", async (_req, res) => {
    res.json(await checkVlmWorkerHealth());
  });

  app.get("/api/search/plan", async (req, res) => {
    res.json(await planDomainQueryWithOpenAi(String(req.query.q ?? ""), parseDomainFilters(req.query)));
  });

  app.get("/api/knowledge/sports/answer", async (req, res) => {
    const queryPlan = await planDomainQueryWithOpenAi(String(req.query.q ?? ""), parseDomainFilters(req.query));
    res.json(answerSportsKnowledgeQuestion(queryPlan));
  });
}
