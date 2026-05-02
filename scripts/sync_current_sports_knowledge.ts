import "../server/env";
import { importFootballDataKnowledge } from "../server/footballDataClient";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
);

const competitions = splitArg(args.get("competitions") ?? args.get("competition") ?? "PL");
const seasons = splitArg(args.get("seasons") ?? "2024,2025")
  .map((season) => Number(season))
  .filter((season) => Number.isInteger(season) && season >= 2000);
const includeMatches = args.get("includeMatches") === "true";
const matchLimit = args.get("matchLimit") ? Number(args.get("matchLimit")) : undefined;

const results = [];
for (const competitionCode of competitions) {
  for (const season of seasons) {
    const result = await importFootballDataKnowledge({
      competitionCode,
      season,
      includeMatches,
      matchLimit
    });
    results.push({
      competitionCode: result.competitionCode,
      season: result.season,
      teams: result.teams,
      players: result.players,
      matchActivities: result.matchActivities,
      warnings: result.warnings,
      storedPlayers: result.snapshot.players.length,
      storedMatchActivities: result.snapshot.matchActivities?.length ?? 0
    });
  }
}

console.log(JSON.stringify({ results }, null, 2));

function splitArg(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
