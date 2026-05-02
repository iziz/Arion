import "../server/env";
import { importStatbunkerKnowledge } from "../server/statbunkerImport";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
);

const result = await importStatbunkerKnowledge({
  source: args.get("source") === "statbunker" ? "statbunker" : "kaggle",
  dataset: args.get("dataset") || undefined,
  localPath: args.get("path") || args.get("localPath") || undefined,
  competition: args.get("competition") || undefined,
  season: args.get("season") || undefined,
  download: args.get("download") === "true"
});

console.log(
  JSON.stringify(
    {
      source: result.source,
      path: result.path,
      files: result.files,
      players: result.players,
      matchActivities: result.matchActivities,
      facts: result.facts,
      warnings: result.warnings,
      storedPlayers: result.snapshot.players.length,
      storedMatchActivities: result.snapshot.matchActivities?.length ?? 0,
      storedFacts: result.snapshot.facts?.length ?? 0
    },
    null,
    2
  )
);
