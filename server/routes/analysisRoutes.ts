import type { Express } from "express";
import { sendNotFound } from "../http/middleware";
import { getAsset } from "../store";
import { analyzeAndEmit } from "../workflows/indexingWorkflow";

export function registerAnalysisRoutes(app: Express) {
  app.post("/api/analyze", async (req, res) => {
    const asset = await getAsset(String(req.body.assetId || ""));
    if (!asset) return sendNotFound(res, "Asset not found");
    const result = await analyzeAndEmit(asset, String(req.body.question ?? ""));
    res.json(result);
  });

  app.post("/api/assets/:id/analyze", async (req, res) => {
    const asset = await getAsset(String(req.params.id));
    if (!asset) return sendNotFound(res, "Asset not found");
    const result = await analyzeAndEmit(asset, String(req.body.question ?? ""));
    res.json(result);
  });
}
