import type { Express, RequestHandler } from "express";
import { expandDomainQuery } from "../domainIndex";
import { searchAssets } from "../intelligence";
import { embedQueryText } from "../localEmbeddingRuntime";
import { embedVisualImage, embedVisualQuery } from "../localVisualEmbeddingRuntime";
import { searchVectors } from "../localVectorStore";
import { searchVisualVectors } from "../localVisualVectorStore";
import { traceAsync } from "../observability";
import { discardUploadTempFile } from "../services/mediaLifecycle";
import { rebuildVectorStores } from "../services/vectorMaintenance";
import { listAssets, listIndexes } from "../store";

type UploadMiddleware = { single(fieldName: string): RequestHandler };

export function registerVectorRoutes(app: Express, upload: UploadMiddleware) {
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

  app.post("/api/visual-search/image", upload.single("image"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Image file is required" });
      return;
    }
    try {
      const indexId = req.query.indexId ? String(req.query.indexId) : undefined;
      const limit = Number(req.query.limit ?? 25);
      const queryText = String(req.body?.q ?? req.query.q ?? "visual image similarity");
      const queryVector = await traceAsync("search.embed_visual_image_query", {}, () => embedVisualImage(req.file!.path), "search.embed_visual_image_query");
      const hits = await searchVisualVectors(indexId, queryVector, limit);
      if (req.query.raw === "true") {
        res.json(hits);
        return;
      }
      const [assets, indexes] = await Promise.all([listAssets(), listIndexes()]);
      const visualHitsBySegment = new Map<string, number>();
      for (const hit of hits) {
        visualHitsBySegment.set(hit.segmentId, Math.max(visualHitsBySegment.get(hit.segmentId) ?? 0, hit.score));
      }
      res.json(
        searchAssets(assets, indexes, queryText, {
          indexId,
          limit,
          visualHitsBySegment
        })
      );
    } catch (error) {
      res.status(503).json({ available: false, error: error instanceof Error ? error.message : "Visual image search unavailable" });
    } finally {
      await discardUploadTempFile(req.file);
    }
  });

  app.post("/api/vector-store/rebuild", async (_req, res) => {
    res.json(await rebuildVectorStores());
  });
}
