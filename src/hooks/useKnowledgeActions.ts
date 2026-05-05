import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { KnowledgeSnapshot } from "../../shared/types";
import { api } from "../api";

export function useKnowledgeActions({
  setKnowledgeSnapshot,
  setMessage
}: {
  setKnowledgeSnapshot: Dispatch<SetStateAction<KnowledgeSnapshot | null>>;
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
      ? await api.put<KnowledgeSnapshot>(`/api/knowledge/players/${id}`, payload)
      : await api.post<KnowledgeSnapshot>("/api/knowledge/players", payload);
    setKnowledgeSnapshot(snapshot);
    form.reset();
    setMessage(id ? "Knowledge player updated." : "Knowledge registry updated.");
  }

  async function deleteKnowledgePlayer(id: string) {
    const snapshot = await api.delete<KnowledgeSnapshot>(`/api/knowledge/players/${id}`);
    setKnowledgeSnapshot(snapshot);
    setMessage("Knowledge player deleted.");
  }

  return {
    registerKnowledgePlayer,
    deleteKnowledgePlayer
  };
}
