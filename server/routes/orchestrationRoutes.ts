import type { Express } from "express";
import { buildOrchestrationPlan } from "../orchestrator";
import { planDomainQueryWithLlm } from "../llmQueryPlanner";
import { parseDomainFilters } from "../queryPlanner";
import { listAssets, listIndexes } from "../store";
import { scopeAssetsForQuery } from "../workflows/askWorkflow";
import { applyScopeDomainDefaults } from "../workflows/ask/statMomentSeed";

export function registerOrchestrationRoutes(app: Express) {
  app.get("/api/orchestrate/plan", async (req, res) => {
    const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
    const indexId = req.query.indexId ? String(req.query.indexId) : undefined;
    const assetId = req.query.assetId ? String(req.query.assetId) : undefined;
    const assetScopeIndexId = assetId ? assets.find((asset) => asset.id === assetId)?.indexId : undefined;
    const explicitFilters = applyScopeDomainDefaults(parseDomainFilters(req.query), { indexId: indexId ?? assetScopeIndexId }, indexes);
    const scopedAssets = scopeAssetsForQuery(assets, {
      query: String(req.query.q ?? ""),
      explicitFilters,
      indexId,
      assetId,
      tag: req.query.tag ? String(req.query.tag) : undefined,
      modality: req.query.modality ? String(req.query.modality) : undefined,
      useKnowledgeLayer: req.query.useKnowledgeLayer !== "false"
    }, indexes);
    const queryPlan = await planDomainQueryWithLlm(String(req.query.q ?? ""), explicitFilters);
    res.json(buildOrchestrationPlan(queryPlan, scopedAssets, indexes));
  });
}
