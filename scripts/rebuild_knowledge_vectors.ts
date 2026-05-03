import "../server/env";
import { rebuildKnowledgeVectorStore } from "../server/localKnowledgeVectorStore";
import { buildSportsKnowledgeDocuments } from "../server/sportsKnowledgeDocuments";

const args = new Map(
  process.argv
    .slice(2)
    .map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
);

const all = args.get("all") === "true";
const maxPlayers = all ? undefined : numberArg("maxPlayers", 5000);
const maxFacts = all ? undefined : numberArg("maxFacts", 5000);
const maxActivities = all ? undefined : numberArg("maxActivities", 5000);
const batchSize = numberArg("batchSize", 128);

const documents = buildSportsKnowledgeDocuments(undefined, {
  maxPlayers,
  maxFacts,
  maxActivities
});

console.error(
  `[knowledge-vectors] embedding ${documents.length} documents` +
    `${all ? " (all)" : ` (players=${maxPlayers}, facts=${maxFacts}, activities=${maxActivities})`}`
);

let lastLogged = 0;
const result = await rebuildKnowledgeVectorStore(documents, {
  batchSize,
  onProgress: ({ embedded, total }) => {
    if (embedded - lastLogged >= batchSize * 5 || embedded === total) {
      lastLogged = embedded;
      console.error(`[knowledge-vectors] ${embedded}/${total}`);
    }
  }
});

console.log(
  JSON.stringify(
    {
      storage: result.storage,
      vectors: result.count,
      documents: documents.length,
      limits: {
        all,
        maxPlayers,
        maxFacts,
        maxActivities,
        batchSize
      }
    },
    null,
    2
  )
);

function numberArg(name: string, fallback: number) {
  const value = args.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
