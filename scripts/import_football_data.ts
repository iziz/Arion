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

const competitionCode = args.get("competition") ?? args.get("competitionCode") ?? "PL";
const season = args.get("season") ? Number(args.get("season")) : undefined;
const includeMatches = args.get("includeMatches") === "true" || args.get("matches") === "true";
const matchLimit = args.get("matchLimit") ? Number(args.get("matchLimit")) : undefined;

const result = await importFootballDataKnowledge({ competitionCode, season, includeMatches, matchLimit });

console.log(
  JSON.stringify(
    {
      competitionCode: result.competitionCode,
      season: result.season,
      teams: result.teams,
      players: result.players,
      matchActivities: result.matchActivities,
      warnings: result.warnings,
      storedPlayers: result.snapshot.players.length,
      storedMatchActivities: result.snapshot.matchActivities?.length ?? 0
    },
    null,
    2
  )
);
