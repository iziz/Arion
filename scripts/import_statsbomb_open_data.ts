import "../server/env";
import { importStatsBombOpenDataKnowledge } from "../server/statsbombOpenDataImport";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
);

const competitions = (args.get("competitions") ?? args.get("competition") ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const seasons = (args.get("seasons") ?? args.get("season") ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const result = await importStatsBombOpenDataKnowledge({
  competitions: competitions.length > 0 ? competitions : undefined,
  seasons: seasons.length > 0 ? seasons : undefined,
  maxMatches: args.get("maxMatches") ? Number(args.get("maxMatches")) : undefined,
  maxEventMatches: args.get("maxEventMatches") ? Number(args.get("maxEventMatches")) : undefined,
  includeEvents: args.get("includeEvents") !== "false" && args.get("events") !== "false"
});

console.log(
  JSON.stringify(
    {
      source: result.source,
      competitions: result.competitions,
      competitionSeasons: result.competitionSeasons,
      matches: result.matches,
      eventMatches: result.eventMatches,
      teams: result.teams,
      players: result.players,
      matchActivities: result.matchActivities,
      facts: result.facts,
      warnings: result.warnings.slice(0, 10),
      storedPlayers: result.snapshot.players.length,
      storedMatchActivities: result.snapshot.matchActivities?.length ?? 0,
      storedFacts: result.snapshot.facts?.length ?? 0,
      football: result.snapshot.domains?.find((domain) => domain.id === "sports.football")
    },
    null,
    2
  )
);
