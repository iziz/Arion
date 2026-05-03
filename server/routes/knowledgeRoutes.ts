import type { Express } from "express";
import { importFootballDataKnowledge } from "../footballDataClient";
import { importFootballDataUkKnowledge } from "../footballDataUkImport";
import { embedQueryText } from "../localEmbeddingRuntime";
import { getKnowledgeVectorStatus, rebuildKnowledgeVectorStore, searchKnowledgeVectors } from "../localKnowledgeVectorStore";
import { importNflverseKnowledge } from "../nflverseImport";
import { deleteSportsKnowledgePlayer, getSportsKnowledgeSnapshot, upsertSportsKnowledgePlayer } from "../sportsKnowledge";
import { buildSportsKnowledgeDocuments, knowledgeVectorHitToEvidence } from "../sportsKnowledgeDocuments";
import { importStatbunkerKnowledge } from "../statbunkerImport";
import { importStatsBombOpenDataKnowledge } from "../statsbombOpenDataImport";

export function registerKnowledgeRoutes(app: Express) {
  app.get("/api/knowledge/sports", async (_req, res) => {
    res.json(getSportsKnowledgeSnapshot());
  });

  app.get("/api/knowledge/sports/vector-store", async (_req, res) => {
    res.json(await getKnowledgeVectorStatus());
  });

  app.post("/api/knowledge/sports/vector-store/rebuild", async (req, res) => {
    const documents = buildSportsKnowledgeDocuments(undefined, {
      maxPlayers: req.body.all ? undefined : optionalNumber(req.body.maxPlayers, 5000),
      maxFacts: req.body.all ? undefined : optionalNumber(req.body.maxFacts, 5000),
      maxActivities: req.body.all ? undefined : optionalNumber(req.body.maxActivities, 5000)
    });
    const result = await rebuildKnowledgeVectorStore(documents, {
      batchSize: optionalNumber(req.body.batchSize, 128)
    });
    res.json({ ...result, documents: documents.length });
  });

  app.get("/api/knowledge/sports/vector-search", async (req, res) => {
    const query = String(req.query.q ?? req.query.query ?? "").trim();
    if (!query) {
      res.status(400).json({ error: "Query is required" });
      return;
    }
    const domainGroup = domainGroupValue(req.query.domainGroup);
    const queryVector = await embedQueryText(query);
    const hits = await searchKnowledgeVectors(domainGroup, queryVector, optionalNumber(req.query.limit, 12), query);
    res.json({
      hits,
      evidence: hits.map(knowledgeVectorHitToEvidence)
    });
  });

  app.post("/api/knowledge/sports/import/football-data", async (req, res) => {
    const competitionCode = String(req.body.competitionCode ?? "PL");
    const season = req.body.season ? Number(req.body.season) : undefined;
    const includeMatches = Boolean(req.body.includeMatches);
    const matchLimit = req.body.matchLimit ? Number(req.body.matchLimit) : undefined;
    const result = await importFootballDataKnowledge({ competitionCode, season, includeMatches, matchLimit });
    res.json(result);
  });

  app.post("/api/knowledge/sports/import/statbunker", async (req, res) => {
    const result = await importStatbunkerKnowledge({
      source: req.body.source === "statbunker" ? "statbunker" : "kaggle",
      dataset: String(req.body.dataset ?? ""),
      localPath: String(req.body.localPath ?? ""),
      competition: String(req.body.competition ?? ""),
      season: String(req.body.season ?? ""),
      download: Boolean(req.body.download)
    });
    res.json(result);
  });

  app.post("/api/knowledge/sports/import/football-data-uk", async (req, res) => {
    const seasons = String(req.body.seasons ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const divisions = String(req.body.divisions ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const result = await importFootballDataUkKnowledge({
      seasons: seasons.length > 0 ? seasons : undefined,
      divisions: divisions.length > 0 ? divisions : undefined
    });
    res.json(result);
  });

  app.post("/api/knowledge/sports/import/statsbomb", async (req, res) => {
    const competitions = String(req.body.competitions ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const seasons = String(req.body.seasons ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const result = await importStatsBombOpenDataKnowledge({
      competitions: competitions.length > 0 ? competitions : undefined,
      seasons: seasons.length > 0 ? seasons : undefined,
      maxMatches: req.body.maxMatches ? Number(req.body.maxMatches) : undefined,
      maxEventMatches: req.body.maxEventMatches ? Number(req.body.maxEventMatches) : undefined,
      includeEvents: req.body.includeEvents !== false
    });
    res.json(result);
  });

  app.post("/api/knowledge/sports/import/nflverse", async (req, res) => {
    const seasons = String(req.body.seasons ?? "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item));
    const result = await importNflverseKnowledge({
      seasons: seasons.length > 0 ? seasons : undefined,
      includePlayers: req.body.includePlayers !== false
    });
    res.json(result);
  });

  app.post("/api/knowledge/sports/players", async (req, res) => {
    const canonical = String(req.body.canonical ?? "").trim();
    if (!canonical) {
      res.status(400).json({ error: "Player canonical name is required" });
      return;
    }
    const aliases = String(req.body.aliases ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const activeSeasons = String(req.body.activeSeasons ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const team = String(req.body.team ?? "").trim();
    const league = String(req.body.league ?? "");
    const teamsBySeason = Object.fromEntries(activeSeasons.map((season) => [season, team]));
    res.status(201).json(
      upsertSportsKnowledgePlayer({
        id: String(req.body.id ?? "").trim() || undefined,
        canonical,
        aliases,
        activeSeasons,
        teamsBySeason,
        sport: req.body.sport === "american_football" ? "american_football" : "football",
        league: league === "NFL" || league === "Champions League" || league === "Bundesliga" || league === "Premier League" ? league : undefined,
        position: String(req.body.position ?? "").trim() || null,
        shirtNumber: req.body.shirtNumber ? Number(req.body.shirtNumber) : null,
        provider: "local"
      })
    );
  });

  app.put("/api/knowledge/sports/players/:id", async (req, res) => {
    const id = String(req.params.id).trim();
    const canonical = String(req.body.canonical ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "Player id is required" });
      return;
    }
    if (!canonical) {
      res.status(400).json({ error: "Player canonical name is required" });
      return;
    }
    const aliases = String(req.body.aliases ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const activeSeasons = String(req.body.activeSeasons ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const team = String(req.body.team ?? "").trim();
    const league = String(req.body.league ?? "");
    const teamsBySeason = Object.fromEntries(activeSeasons.map((season) => [season, team]));
    res.json(
      upsertSportsKnowledgePlayer({
        id,
        canonical,
        aliases,
        activeSeasons,
        teamsBySeason,
        sport: req.body.sport === "american_football" ? "american_football" : "football",
        league: league === "NFL" || league === "Champions League" || league === "Bundesliga" || league === "Premier League" ? league : undefined,
        position: String(req.body.position ?? "").trim() || null,
        shirtNumber: req.body.shirtNumber ? Number(req.body.shirtNumber) : null,
        provider: "local"
      })
    );
  });

  app.delete("/api/knowledge/sports/players/:id", async (req, res) => {
    const id = String(req.params.id).trim();
    if (!id) {
      res.status(400).json({ error: "Player id is required" });
      return;
    }
    res.json(deleteSportsKnowledgePlayer(id));
  });
}

function domainGroupValue(value: unknown) {
  return value === "sports.football" || value === "sports.american_football" ? value : undefined;
}

function optionalNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}
