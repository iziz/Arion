import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { normalizeCapabilityPolicy, normalizeDomainIndexing } from "../domainConfig";
import { sendNotFound } from "../http/middleware";
import { getEmbeddingModelName } from "../localEmbeddingRuntime";
import { recordEvent } from "../services/events";
import { createDefaultIndex, getIndex, listIndexes, saveIndex } from "../store";
import type { IndexRecord } from "../../shared/types";

export function registerIndexRoutes(app: Express) {
  app.get("/api/indexes", async (_req, res) => {
    res.json(await listIndexes());
  });

  app.post("/api/indexes", async (req, res) => {
    const now = new Date().toISOString();
    const domainIndexing = normalizeDomainIndexing(req.body.domainIndexing);
    const index: IndexRecord = {
      ...createDefaultIndex(now),
      id: randomUUID(),
      name: String(req.body.name || "Untitled index"),
      description: String(req.body.description || ""),
      models: {
        search: String(req.body.models?.search || "local-semantic-retrieval"),
        analysis: String(req.body.models?.analysis || "local-pattern-analysis"),
        embedding: String(req.body.models?.embedding || getEmbeddingModelName())
      },
      modalities: Array.isArray(req.body.modalities) && req.body.modalities.length > 0 ? req.body.modalities : ["visual", "audio", "transcription", "metadata"],
      domainIndexing,
      capabilityPolicy: normalizeCapabilityPolicy(req.body.capabilityPolicy, domainIndexing),
      assetIds: [],
      status: "empty",
      createdAt: now,
      updatedAt: now
    };
    await saveIndex(index);
    await recordEvent("system.info", "Index created", { indexId: index.id, payload: { name: index.name } });
    res.status(201).json(index);
  });

  app.get("/api/indexes/:id", async (req, res) => {
    const index = await getIndex(String(req.params.id));
    if (!index) return sendNotFound(res, "Index not found");
    res.json(index);
  });

  app.patch("/api/indexes/:id", async (req, res) => {
    const index = await getIndex(String(req.params.id));
    if (!index) return sendNotFound(res, "Index not found");
    const now = new Date().toISOString();
    const domainIndexing = req.body.domainIndexing === undefined ? index.domainIndexing : normalizeDomainIndexing(req.body.domainIndexing);
    const next: IndexRecord = {
      ...index,
      name: typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : index.name,
      description: typeof req.body.description === "string" ? req.body.description : index.description,
      domainIndexing,
      capabilityPolicy: req.body.capabilityPolicy === undefined ? index.capabilityPolicy : normalizeCapabilityPolicy(req.body.capabilityPolicy, domainIndexing),
      updatedAt: now
    };
    await saveIndex(next);
    await recordEvent("system.info", "Index updated", { indexId: next.id, payload: { name: next.name } });
    res.json(next);
  });
}
