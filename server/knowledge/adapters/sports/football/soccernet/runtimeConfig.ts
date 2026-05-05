import path from "node:path";

export const soccerNetPythonBin = process.env.LOCAL_AI_PYTHON || process.env.PYTHON_BIN || path.resolve(".venv-ai", "bin", "python");
export const soccerNetActionScript = path.resolve("scripts", "soccernet_action_spotting.py");
export const soccerNetActionModel = process.env.SOCCERNET_ACTION_SPOTTING_MODEL || "external";

export function isSoccerNetActionSpottingConfigured() {
  return (
    process.env.SOCCERNET_ACTION_SPOTTING_ENABLED === "true" ||
    Boolean(process.env.SOCCERNET_ACTION_SPOTTING_COMMAND) ||
    Boolean(process.env.SOCCERNET_ACTION_SPOTS_JSON)
  );
}
