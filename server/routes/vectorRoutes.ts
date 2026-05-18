import type { Express } from "express";
import { expandDomainQuery } from "../domainIndex";
import { embedQueryText } from "../localEmbeddingRuntime";
import { embedVisualQuery } from "../localVisualEmbeddingRuntime";
import { searchVectors } from "../localVectorStore";
import { searchVisualVectors } from "../localVisualVectorStore";
import { traceAsync } from "../observability";
import { rebuildVectorStores } from "../services/vectorMaintenance";

export function registerVectorRoutes(app: Express) {
  app.get("/api/vector-search", async (req, res) => {
    const query = String(req.query.q ?? "");
    const expandedQuery = expandDomainQuery(query).expandedText;
    const queryVector = await traceAsync("search.embed_text_query", {}, () => embedQueryText(expandedQuery), "search.embed_text_query");
    res.json(await searchVectors(req.query.indexId ? String(req.query.indexId) : undefined, queryVector, Number(req.query.limit ?? 25), expandedQuery));
  });

  app.get("/api/visual-search", async (req, res) => {
    const query = String(req.query.q ?? "");
    const expandedQuery = expandDomainQuery(query).expandedText;
    try {
      const queryVector = await traceAsync("search.embed_visual_query", {}, () => embedVisualQuery(expandedQuery), "search.embed_visual_query");
      res.json(await searchVisualVectors(req.query.indexId ? String(req.query.indexId) : undefined, queryVector, Number(req.query.limit ?? 25)));
    } catch (error) {
      res.status(503).json({ available: false, error: error instanceof Error ? error.message : "Visual embedding unavailable" });
    }
  });

  app.post("/api/vector-store/rebuild", async (_req, res) => {
    res.json(await rebuildVectorStores());
  });
}
