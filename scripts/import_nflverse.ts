import "../server/env";
import { importNflverseKnowledge } from "../server/nflverseImport";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
);

const seasons = (args.get("seasons") ?? args.get("season") ?? "")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isInteger(item));
const maxPlaysPerSeason = numberArg(args.get("maxPlaysPerSeason") ?? args.get("playLimit") ?? args.get("playsLimit"));

const result = await importNflverseKnowledge({
  seasons: seasons.length > 0 ? seasons : undefined,
  includePlayers: args.get("includePlayers") !== "false" && args.get("players") !== "false",
  includePlays: args.get("includePlays") !== "false" && args.get("plays") !== "false",
  maxPlaysPerSeason
});

console.log(
  JSON.stringify(
    {
      source: result.source,
      seasons: result.seasons,
      players: result.players,
      teams: result.teams,
      matchActivities: result.matchActivities,
      facts: result.facts,
      plays: result.plays,
      warnings: result.warnings,
      storedPlayers: result.snapshot.players.length,
      storedAmericanFootballPlays: result.snapshot.americanFootballPlays?.length ?? 0,
      americanFootball: result.snapshot.domains?.find((domain) => domain.id === "sports.american_football")
    },
    null,
    2
  )
);

function numberArg(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}
