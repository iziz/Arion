import type { Express } from "express";
import { buildOrchestrationPlan } from "../orchestrator";
import { planDomainQueryWithOpenAi } from "../openaiQueryPlanner";
import { parseDomainFilters } from "../queryPlanner";
import { listAssets, listIndexes } from "../store";
import { scopeAssetsForQuery } from "../workflows/askWorkflow";

export function registerOrchestrationRoutes(app: Express) {
  app.get("/api/orchestrate/plan", async (req, res) => {
    const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
    const scopedAssets = scopeAssetsForQuery(assets, {
      query: String(req.query.q ?? ""),
      explicitFilters: parseDomainFilters(req.query),
      indexId: req.query.indexId ? String(req.query.indexId) : undefined,
      tag: req.query.tag ? String(req.query.tag) : undefined,
      modality: req.query.modality ? String(req.query.modality) : undefined
    });
    const queryPlan = await planDomainQueryWithOpenAi(String(req.query.q ?? ""), parseDomainFilters(req.query));
    res.json(buildOrchestrationPlan(queryPlan, scopedAssets, indexes));
  });
}
