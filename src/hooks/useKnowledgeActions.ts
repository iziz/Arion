import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { SportsKnowledgeSnapshot } from "../../shared/types";
import {
  api,
  type FootballDataImportResult,
  type StatbunkerImportResult
} from "../api";

export function useKnowledgeActions({
  setSportsKnowledge,
  setMessage,
  setBusy
}: {
  setSportsKnowledge: Dispatch<SetStateAction<SportsKnowledgeSnapshot | null>>;
  setMessage: (message: string) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
}) {
  async function registerKnowledgePlayer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const id = String(data.get("id") ?? "").trim();
    const payload = {
      id,
      canonical: data.get("canonical"),
      aliases: data.get("aliases"),
      sport: data.get("sport"),
      league: data.get("league"),
      activeSeasons: data.get("activeSeasons"),
      team: data.get("team"),
      position: data.get("position"),
      shirtNumber: data.get("shirtNumber")
    };
    const snapshot = id
      ? await api.put<SportsKnowledgeSnapshot>(`/api/knowledge/sports/players/${id}`, payload)
      : await api.post<SportsKnowledgeSnapshot>("/api/knowledge/sports/players", payload);
    setSportsKnowledge(snapshot);
    form.reset();
    setMessage(id ? "Knowledge player updated." : "Knowledge registry updated.");
  }

  async function deleteKnowledgePlayer(id: string) {
    const snapshot = await api.delete<SportsKnowledgeSnapshot>(`/api/knowledge/sports/players/${id}`);
    setSportsKnowledge(snapshot);
    setMessage("Knowledge player deleted.");
  }

  async function importFootballData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage("");
    try {
      const result = await api.post<FootballDataImportResult>("/api/knowledge/sports/import/football-data", {
        competitionCode: data.get("competitionCode"),
        season: data.get("season"),
        includeMatches: data.get("includeMatches") === "on",
        matchLimit: data.get("matchLimit")
      });
      setSportsKnowledge(result.snapshot);
      setMessage(
        `Football-data import stored ${result.players} players, ${result.teams} teams, ${result.matchActivities} match activities.${
          result.warnings.length > 0 ? ` Warning: ${result.warnings[0]}` : ""
        }`
      );
    } finally {
      setBusy(false);
    }
  }

  async function importStatbunker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage("");
    try {
      const result = await api.post<StatbunkerImportResult>("/api/knowledge/sports/import/statbunker", {
        source: data.get("source"),
        dataset: data.get("dataset"),
        localPath: data.get("localPath"),
        competition: data.get("competition"),
        season: data.get("season"),
        download: data.get("download") === "on"
      });
      setSportsKnowledge(result.snapshot);
      setMessage(
        `${result.source} import parsed ${result.files} files, stored ${result.players} players and ${result.matchActivities} stat/activity records.${
          result.facts ? ` Facts: ${result.facts}.` : ""
        }${
          result.warnings.length > 0 ? ` Warning: ${result.warnings[0]}` : ""
        }`
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    registerKnowledgePlayer,
    deleteKnowledgePlayer,
    importFootballData,
    importStatbunker
  };
}
