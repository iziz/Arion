export type ProcessRole = "api" | "worker" | "script" | "unknown";

export function getProcessRole(): ProcessRole {
  const role = String(process.env.ARION_PROCESS_ROLE || "unknown").trim().toLowerCase();
  if (role === "api" || role === "worker" || role === "script") return role;
  return "unknown";
}

export function assertWorkerOrScriptBoundary(boundary: string) {
  const role = getProcessRole();
  if (role === "worker" || role === "script") return;
  if (process.env.ALLOW_API_MODEL_RUNTIME === "true") return;
  throw new Error(`${boundary} must run in the asset worker or a maintenance script. Current process role: ${role}.`);
}
