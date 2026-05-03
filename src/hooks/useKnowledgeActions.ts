import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { SportsKnowledgeSnapshot } from "../../shared/types";
import { api } from "../api";

export function useKnowledgeActions({
  setSportsKnowledge,
  setMessage
}: {
  setSportsKnowledge: Dispatch<SetStateAction<SportsKnowledgeSnapshot | null>>;
  setMessage: (message: string) => void;
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

  return {
    registerKnowledgePlayer,
    deleteKnowledgePlayer
  };
}
