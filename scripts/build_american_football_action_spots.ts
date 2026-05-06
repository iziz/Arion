import "../server/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getKnowledgeSnapshot } from "../server/knowledge/registry";
import { closePostgresStore } from "../server/postgresStore";
import { listAssets, listIndexes } from "../server/store";
import { buildAmericanFootballActionSpotPredictions } from "../server/knowledge/adapters/sports/americanFootball/actionSpotting/generateActionSpots";
import { americanFootballKnowledgeTemplate } from "../server/knowledge/adapters/sports/americanFootball/knowledgeTemplate";

type BuildOptions = {
  outDir: string;
  assetIds: Set<string>;
  indexId: string | null;
  minConfidence: number;
  maxPerAsset: number | null;
  dryRun: boolean;
};

const args = parseArgs(process.argv.slice(2));
const options: BuildOptions = {
  outDir: resolve(process.cwd(), args.get("outDir") ?? ".data/american-football-action-spots"),
  assetIds: new Set((args.get("assetId") ?? args.get("assetIds") ?? "").split(",").map((item) => item.trim()).filter(Boolean)),
  indexId: args.get("indexId") ?? null,
  minConfidence: numberArg(args.get("minConfidence"), americanFootballKnowledgeTemplate.generator.actionSpotting.minCandidateConfidence),
  maxPerAsset: nullableNumberArg(args.get("maxPerAsset")),
  dryRun: args.get("dryRun") === "true"
};

try {
  const snapshot = getKnowledgeSnapshot();
  const plays = snapshot.americanFootballPlays ?? [];
  const indexes = await listIndexes();
  const americanFootballIndexIds = new Set(
    indexes
      .filter((index) => index.domainIndexing?.enabled && index.domainIndexing.groups.includes("sports.american_football"))
      .map((index) => index.id)
  );
  const assets = (await listAssets(options.indexId ?? undefined)).filter((asset) => {
    if (options.assetIds.size > 0 && !options.assetIds.has(asset.id)) return false;
    if (options.indexId) return true;
    return americanFootballIndexIds.has(asset.indexId);
  });

  if (!options.dryRun) mkdirSync(options.outDir, { recursive: true });

  const results = [];
  for (const asset of assets) {
    const predictions = buildAmericanFootballActionSpotPredictions(asset, plays, {
      minConfidence: options.minConfidence,
      maxPerAsset: options.maxPerAsset
    });
    const payload = {
      source: "arion-indexed-evidence",
      version: americanFootballKnowledgeTemplate.generator.outputVersion,
      assetId: asset.id,
      title: asset.title,
      generatedAt: new Date().toISOString(),
      predictions
    };
    if (!options.dryRun) {
      writeFileSync(resolve(options.outDir, `${asset.id}.json`), JSON.stringify(payload, null, 2));
    }
    results.push({
      assetId: asset.id,
      title: asset.title,
      predictions: predictions.length,
      alignedPlays: predictions.filter((prediction) => prediction.playMetadata).length
    });
  }

  console.log(JSON.stringify({ outDir: options.outDir, dryRun: options.dryRun, plays: plays.length, assets: results }, null, 2));
} finally {
  await closePostgresStore();
}

function parseArgs(values: string[]) {
  return new Map(
    values.map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"] as const;
    })
  );
}

function numberArg(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumberArg(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}
