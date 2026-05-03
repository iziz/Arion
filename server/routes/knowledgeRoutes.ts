import type { Express } from "express";
import { importFootballDataKnowledge } from "../footballDataClient";
import { deleteSportsKnowledgePlayer, getSportsKnowledgeSnapshot, upsertSportsKnowledgePlayer } from "../sportsKnowledge";
import { importStatbunkerKnowledge } from "../statbunkerImport";

export function registerKnowledgeRoutes(app: Express) {
  app.get("/api/knowledge/sports", async (_req, res) => {
    res.json(getSportsKnowledgeSnapshot());
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
