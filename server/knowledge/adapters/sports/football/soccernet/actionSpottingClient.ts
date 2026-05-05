import { spawn } from "node:child_process";
import type { TimelineSegment } from "../../../../../../shared/types";
import { callPythonRuntimeService, isPythonRuntimeServiceMode } from "../../../../../modelRuntime/pythonRuntimeService";
import { isSoccerNetActionSpottingConfigured, soccerNetActionModel, soccerNetActionScript, soccerNetPythonBin } from "./runtimeConfig";
import type { SoccerNetActionSpottingResult } from "./types";

export async function spotSoccerNetActions(filePath: string, timeline: TimelineSegment[], duration: number | null): Promise<SoccerNetActionSpottingResult> {
  if (!isSoccerNetActionSpottingConfigured()) {
    return unavailable("SoccerNet action spotting is not configured.");
  }
  const segments = timeline.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end
  }));
  try {
    if (isPythonRuntimeServiceMode("vision")) {
      return await callPythonRuntimeService<SoccerNetActionSpottingResult>(
        "vision",
        "/v1/soccernet-action-spotting",
        {
          mediaPath: filePath,
          model: soccerNetActionModel,
          duration,
          segments
        },
        {
          metricKey: "model.vision.soccernet_action.service"
        }
      );
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(soccerNetPythonBin, [soccerNetActionScript, filePath, "--model", soccerNetActionModel], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (code) => {
        const output = Buffer.concat(stdoutChunks).toString("utf8");
        if (code === 0) resolve(output);
        else reject(new Error(Buffer.concat(stderrChunks).toString("utf8") || `SoccerNet action spotting exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify({ duration, segments }));
    });
    return JSON.parse(stdout) as SoccerNetActionSpottingResult;
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "SoccerNet action spotting failed");
  }
}

function unavailable(error: string): SoccerNetActionSpottingResult {
  return {
    available: false,
    provider: "soccernet-action-spotting",
    model: soccerNetActionModel,
    task: "action_spotting",
    spots: [],
    error
  };
}
