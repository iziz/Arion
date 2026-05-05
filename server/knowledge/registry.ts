export {
  deleteSportsKnowledgePlayer as deleteKnowledgePlayer,
  getKnowledgePlayer,
  getKnowledgeSnapshot,
  matchCompetition as matchKnowledgeCompetition,
  matchKnowledgePlayer,
  matchKnowledgePlayers,
  matchTeams as matchKnowledgeTeams,
  playerTeamForSeason,
  resolveRecentSeasons,
  upsertSportsKnowledgePlayer as upsertKnowledgePlayer
} from "./adapters/sports/store";
