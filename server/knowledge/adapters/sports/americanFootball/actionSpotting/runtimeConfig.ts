import path from "node:path";

export const americanFootballActionPythonBin = process.env.LOCAL_AI_PYTHON || process.env.PYTHON_BIN || path.resolve(".venv-ai", "bin", "python");
export const americanFootballActionScript = path.resolve("scripts", "american_football_action_spotting.py");
export const americanFootballActionModel = process.env.AMERICAN_FOOTBALL_ACTION_SPOTTING_MODEL || process.env.NFL_ACTION_SPOTTING_MODEL || "external";
export const americanFootballActionSpotsDir =
  process.env.AMERICAN_FOOTBALL_ACTION_SPOTS_DIR || process.env.NFL_ACTION_SPOTS_DIR || path.resolve(".data", "american-football-action-spots");

export function isAmericanFootballActionSpottingConfigured() {
  return true;
}

export function hasExplicitAmericanFootballActionSpottingSource() {
  return (
    Boolean(process.env.AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND) ||
    Boolean(process.env.AMERICAN_FOOTBALL_ACTION_SPOTS_JSON) ||
    Boolean(process.env.NFL_ACTION_SPOTTING_COMMAND) ||
    Boolean(process.env.NFL_ACTION_SPOTS_JSON)
  );
}
