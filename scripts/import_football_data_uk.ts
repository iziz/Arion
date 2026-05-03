import "../server/env";
import { importFootballDataUkKnowledge } from "../server/footballDataUkImport";

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
  .map((item) => item.trim())
  .filter(Boolean);
const divisions = (args.get("divisions") ?? args.get("division") ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const result = await importFootballDataUkKnowledge({
  seasons: seasons.length > 0 ? seasons : undefined,
  divisions: divisions.length > 0 ? divisions : undefined
});

console.log(
  JSON.stringify(
    {
      source: result.source,
      seasons: result.seasons,
      divisions: result.divisions,
      teams: result.teams,
      facts: result.facts,
      warnings: result.warnings,
      storedPlayers: result.snapshot.players.length,
      storedFacts: result.snapshot.facts?.length ?? 0,
      football: result.snapshot.domains?.find((domain) => domain.id === "sports.football")
    },
    null,
    2
  )
);
