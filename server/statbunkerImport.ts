import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SportsKnowledgeSnapshot } from "../shared/types";
import { mergeSportsKnowledge, type SportsKnowledgeFact, type SportsKnowledgeMatchActivity, type SportsKnowledgePlayer, type SportsLeague } from "./sportsKnowledge";

const execFileAsync = promisify(execFile);
const defaultKaggleDataset = "cclayford/statbunker-football-stats";

type ImportOptions = {
  source?: "kaggle" | "statbunker";
  dataset?: string;
  localPath?: string;
  competition?: string;
  season?: string;
  download?: boolean;
};

export async function importStatbunkerKnowledge(options: ImportOptions = {}): Promise<{
  source: "kaggle" | "statbunker";
  path: string;
  files: number;
  players: number;
  matchActivities: number;
  facts: number;
  warnings: string[];
  snapshot: SportsKnowledgeSnapshot;
}> {
  const source = options.source ?? "kaggle";
  const warnings: string[] = [];
  const importPath = options.localPath?.trim() || path.resolve(".data", source, slug(options.dataset ?? defaultKaggleDataset));
  if (options.download && source === "kaggle") {
    try {
      await downloadKaggleDataset(options.dataset ?? defaultKaggleDataset, importPath);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Kaggle dataset download failed");
    }
  }
  if (!existsSync(importPath)) {
    warnings.push(`Import path does not exist: ${importPath}`);
    return {
      source,
      path: importPath,
      files: 0,
      players: 0,
      matchActivities: 0,
      facts: 0,
      warnings,
      snapshot: mergeSportsKnowledge({})
    };
  }

  const files = await listDataFiles(importPath);
  const parsed = await Promise.all(files.map((file) => parseStatFile(file, source, options)));
  const players = parsed.flatMap((item) => item.players);
  const matchActivities = parsed.flatMap((item) => item.matchActivities);
  const facts = parsed.flatMap((item) => item.facts);
  const snapshot = mergeSportsKnowledge({ players, matchActivities, facts });
  return {
    source,
    path: importPath,
    files: files.length,
    players: players.length,
    matchActivities: matchActivities.length,
    facts: facts.length,
    warnings,
    snapshot
  };
}

async function downloadKaggleDataset(dataset: string, targetPath: string) {
  await mkdir(targetPath, { recursive: true });
  const credentials = getKaggleCredentials();
  let directDownloadError = "";
  if (credentials) {
    try {
      await downloadKaggleDatasetDirect(dataset, targetPath, credentials);
      return;
    } catch (error) {
      // Fall back to the official CLI path below when direct download is blocked.
      directDownloadError = error instanceof Error ? error.message : "Kaggle direct download failed";
    }
  }
  const kaggleArgs = ["datasets", "download", "-d", dataset, "--unzip", "-p", targetPath];
  try {
    await execFileAsync("kaggle", kaggleArgs, { timeout: 120_000, env: kaggleCliEnv() });
  } catch (error) {
    const credentialHint = credentials
      ? ""
      : " Set KAGGLE_API_TOKEN, or configure legacy KAGGLE_USERNAME and KAGGLE_KEY.";
    throw new Error(
      `Kaggle download failed.${credentialHint}${directDownloadError ? ` Direct: ${directDownloadError}.` : ""} CLI: ${
        error instanceof Error ? error.message : "failed"
      }`.trim()
    );
  }
}

async function downloadKaggleDatasetDirect(dataset: string, targetPath: string, credentials: KaggleCredentials) {
  const [owner, slugName] = dataset.split("/");
  if (!owner || !slugName) throw new Error(`Invalid Kaggle dataset ref: ${dataset}`);
  const response = await fetch(`https://www.kaggle.com/api/v1/datasets/download/${owner}/${slugName}`, {
    headers: kaggleAuthHeaders(credentials)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kaggle direct download failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 120)}` : ""}`);
  }
  const zipPath = path.join(targetPath, "dataset.zip");
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  await execFileAsync("unzip", ["-o", zipPath, "-d", targetPath], { timeout: 120_000 });
}

type KaggleCredentials = { accessToken: string } | { username: string; key: string };

function getKaggleCredentials() {
  const accessToken = process.env.KAGGLE_API_TOKEN?.trim();
  if (accessToken) {
    try {
      const parsed = JSON.parse(accessToken) as { username?: string; key?: string };
      if (parsed.username && parsed.key) return { username: parsed.username, key: parsed.key };
    } catch {
      // New Kaggle API tokens are opaque single values.
    }
    if (accessToken.includes(":") || accessToken.includes(",")) {
      const [tokenUser, tokenKey] = accessToken.includes(":") ? accessToken.split(":", 2) : accessToken.split(",", 2);
      if (tokenUser && tokenKey) return { username: tokenUser.trim(), key: tokenKey.trim() };
    }
    return { accessToken };
  }
  const username = process.env.KAGGLE_USERNAME?.trim();
  const key = process.env.KAGGLE_KEY?.trim();
  if (username && key) return { username, key };
  return null;
}

function kaggleCliEnv() {
  const credentials = getKaggleCredentials();
  if (!credentials) return process.env;
  if ("accessToken" in credentials) return { ...process.env, KAGGLE_API_TOKEN: credentials.accessToken };
  return { ...process.env, KAGGLE_USERNAME: credentials.username, KAGGLE_KEY: credentials.key };
}

function kaggleAuthHeaders(credentials: KaggleCredentials) {
  if ("accessToken" in credentials) return { Authorization: `Bearer ${credentials.accessToken}` };
  return { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.key}`).toString("base64")}` };
}

async function listDataFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) return listDataFiles(fullPath);
      return /\.(csv|json)$/i.test(entry.name) ? [fullPath] : [];
    })
  );
  return nested.flat();
}

async function parseStatFile(filePath: string, source: "kaggle" | "statbunker", options: ImportOptions) {
  const raw = await readFile(filePath, "utf8");
  const rows = filePath.toLowerCase().endsWith(".json") ? rowsFromJson(raw) : rowsFromCsv(raw);
  const league = leagueFromText([options.competition, filePath, raw.slice(0, 500)].filter(Boolean).join(" "));
  const season = options.season || seasonFromText(filePath) || seasonFromText(raw.slice(0, 500)) || "unknown";
  const players = new Map<string, SportsKnowledgePlayer>();
  const matchActivities: SportsKnowledgeMatchActivity[] = [];
  const facts = rows.flatMap((row) => factsFromRow(row, source, league, season, filePath));

  for (const row of rows) {
    const playerName = pick(row, ["player", "player name", "name", "footballer"]);
    if (!playerName || looksLikeTeamRow(playerName)) continue;
    const team = pick(row, ["team", "club", "squad", "club name"]) || "Unknown team";
    const position = pick(row, ["position", "pos"]);
    const shirtNumber = numberValue(pick(row, ["shirt number", "shirt", "number", "no"]));
    const id = `${source}-${slug(playerName)}-${slug(team)}-${slug(season)}`;
    players.set(id, {
      id,
      canonical: playerName,
      aliases: [playerName],
      sport: "football",
      league,
      activeSeasons: season === "unknown" ? [] : [season],
      teamsBySeason: season === "unknown" ? {} : { [season]: team },
      provider: source,
      position: position || null,
      shirtNumber
    });

    const activity = activityFromRow(row, source, league, season, team, playerName);
    if (activity) matchActivities.push(activity);
  }

  return { players: Array.from(players.values()), matchActivities, facts };
}

function factsFromRow(row: Record<string, string>, source: "kaggle" | "statbunker", competition: SportsLeague, season: string, filePath: string): SportsKnowledgeFact[] {
  const fileName = path.basename(filePath).toLowerCase();
  const team = pick(row, ["team", "club", "squad", "club name"]);
  const country = pick(row, ["country", "nationality"]);
  const base = {
    provider: source,
    competition,
    season
  };
  if (fileName.includes("tables") && team) {
    return factMetrics(row, base, "league_table", "team", team, team, [
      ["pos", "position"],
      ["p", "played"],
      ["w", "wins"],
      ["d", "draws"],
      ["l", "losses"],
      ["f", "goals for"],
      ["a", "goals against"],
      ["gd", "goal difference"],
      ["pts", "points"],
      ["table type", "table type"]
    ]);
  }
  if (fileName.includes("team offense") && team) {
    return factMetrics(row, base, "team_offense", "team", team, team, [
      ["goals for", "goals for"],
      ["gf home", "home goals for"],
      ["gf away", "away goals for"],
      ["gf first half", "first-half goals for"],
      ["gf second half", "second-half goals for"],
      ["gf first 15 mins", "first-15-min goals for"],
      ["gf last 10 mins", "last-10-min goals for"],
      ["gf per match", "goals for per match"]
    ]);
  }
  if (fileName.includes("team defense") && team) {
    return factMetrics(row, base, "team_defense", "team", team, team, [
      ["goals against", "goals against"],
      ["ga home", "home goals against"],
      ["ga away", "away goals against"],
      ["ga first half", "first-half goals against"],
      ["ga second half", "second-half goals against"],
      ["ga first 15 mins", "first-15-min goals against"],
      ["ga last 10 mins", "last-10-min goals against"],
      ["ga per match", "goals against per match"]
    ]);
  }
  if (fileName.includes("attendance") && team) {
    const homeAway = fileName.includes("home") ? "home" : "away";
    return factMetrics(row, base, "attendance", "team", team, team, [
      [`avg ${homeAway} attendance`, `avg ${homeAway} attendance`],
      [`total ${homeAway} attendance`, `total ${homeAway} attendance`],
      [`highest ${homeAway} attendance`, `highest ${homeAway} attendance`],
      [`lowest ${homeAway} attendance`, `lowest ${homeAway} attendance`]
    ]);
  }
  if (fileName.includes("nationalities") && country) {
    const players = pick(row, ["players"]);
    if (!players) return [];
    return [
      {
        id: `${source}:fact:nationality:${slug(competition)}:${slug(season)}:${slug(country)}:${slug(team || "league")}`,
        ...base,
        kind: "nationality_distribution",
        entityType: "country",
        entityName: country,
        team: team || undefined,
        metric: "players",
        value: numberValue(players) ?? players,
        rank: null,
        sourceText: `${country} players${team ? ` for ${team}` : ""} in ${competition} ${season}: ${players}.`
      }
    ];
  }
  return [];
}

function factMetrics(
  row: Record<string, string>,
  base: { provider: "kaggle" | "statbunker"; competition: SportsLeague; season: string },
  kind: SportsKnowledgeFact["kind"],
  entityType: SportsKnowledgeFact["entityType"],
  entityName: string,
  team: string | undefined,
  metrics: Array<[string, string]>
): SportsKnowledgeFact[] {
  return metrics.flatMap(([column, metric]) => {
    const raw = pick(row, [column]);
    if (!raw) return [];
    const value = numberValue(raw) ?? raw;
    return [
      {
        id: `${base.provider}:fact:${kind}:${slug(base.competition)}:${slug(base.season)}:${slug(entityName)}:${slug(metric)}`,
        ...base,
        kind,
        entityType,
        entityName,
        team,
        metric,
        value,
        rank: metric === "position" ? numberValue(raw) : null,
        sourceText: `${entityName} ${metric} in ${base.competition} ${base.season}: ${raw}.`
      }
    ];
  });
}

function activityFromRow(row: Record<string, string>, source: "kaggle" | "statbunker", competition: SportsLeague, season: string, team: string, player: string): SportsKnowledgeMatchActivity | null {
  const minutes = numberValue(pick(row, ["minutes", "mins", "min"]));
  const appearances = numberValue(pick(row, ["appearances", "apps", "app"]));
  const goals = numberValue(pick(row, ["goals", "goal"]));
  const assists = numberValue(pick(row, ["assists", "assist"]));
  const cards = numberValue(pick(row, ["yellow cards", "red cards", "cards"]));
  const stats = [
    minutes !== null ? `${minutes} minutes` : "",
    appearances !== null ? `${appearances} appearances` : "",
    goals !== null ? `${goals} goals` : "",
    assists !== null ? `${assists} assists` : "",
    cards !== null ? `${cards} cards` : ""
  ].filter(Boolean);
  if (stats.length === 0) return null;
  return {
    id: `${source}:stat:${slug(competition)}:${slug(season)}:${slug(team)}:${slug(player)}`,
    provider: source,
    competition,
    season,
    matchId: 0,
    utcDate: null,
    matchday: null,
    homeTeam: team,
    awayTeam: "Season aggregate",
    team,
    player,
    playerId: null,
    role: "STAT",
    minute: minutes,
    event: "season aggregate",
    sourceText: `${player} season aggregate for ${team}: ${stats.join(", ")}.`
  };
}

function rowsFromJson(raw: string) {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed.filter(isRecord).map(stringRecord);
  if (isRecord(parsed)) {
    const values = Object.values(parsed).find((value) => Array.isArray(value));
    if (Array.isArray(values)) return values.filter(isRecord).map(stringRecord);
  }
  return [];
}

function rowsFromCsv(raw: string) {
  const records = parseCsv(raw);
  const [headers, ...rows] = records;
  if (!headers || rows.length === 0) return [];
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  return rows.map((row) =>
    Object.fromEntries(normalizedHeaders.map((header, index) => [header, row[index]?.trim() ?? ""]))
  );
}

function parseCsv(raw: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function pick(row: Record<string, string>, names: string[]) {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function leagueFromText(text: string): SportsLeague {
  const normalized = text.toLowerCase();
  if (normalized.includes("bundesliga")) return "Bundesliga";
  if (normalized.includes("champions")) return "Champions League";
  return "Premier League";
}

function seasonFromText(text: string) {
  const range = text.match(/\b(20\d{2})[-_/ ]?(\d{2})\b/);
  if (range) return `${range[1]}-${range[2]}`;
  const year = text.match(/\b(20\d{2})\b/);
  return year?.[1] ?? null;
}

function numberValue(value: string) {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeTeamRow(value: string) {
  return ["total", "team", "player"].includes(value.toLowerCase().trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizeHeader(key), String(item ?? "")]));
}

function slug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
