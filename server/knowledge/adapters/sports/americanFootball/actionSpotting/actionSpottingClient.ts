import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import type { TimelineSegment } from "../../../../../../shared/types";
import { getAsset } from "../../../../../store";
import { callPythonRuntimeService, isPythonRuntimeServiceMode } from "../../../../../modelRuntime/pythonRuntimeService";
import { getKnowledgeSnapshot } from "../../store";
import { buildAmericanFootballActionSpotPredictions } from "./generateActionSpots";
import {
  americanFootballActionModel,
  americanFootballActionPythonBin,
  americanFootballActionScript,
  americanFootballActionSpotsDir,
  hasExplicitAmericanFootballActionSpottingSource
} from "./runtimeConfig";
import type { AmericanFootballActionSpottingResult } from "./types";

export async function spotAmericanFootballActions(filePath: string, timeline: TimelineSegment[], duration: number | null): Promise<AmericanFootballActionSpottingResult> {
  if (!hasExplicitAmericanFootballActionSpottingSource()) {
    return generateInlineActionSpots(filePath, timeline);
  }
  const segments = timeline.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end
  }));
  try {
    if (isPythonRuntimeServiceMode("vision")) {
      return await callPythonRuntimeService<AmericanFootballActionSpottingResult>(
        "vision",
        "/v1/american-football-action-spotting",
        {
          mediaPath: filePath,
          model: americanFootballActionModel,
          spotsDir: americanFootballActionSpotsDir,
          duration,
          segments
        },
        {
          metricKey: "model.vision.american_football_action.service"
        }
      );
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(americanFootballActionPythonBin, [americanFootballActionScript, filePath, "--model", americanFootballActionModel, "--spots-dir", americanFootballActionSpotsDir], {
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
        else reject(new Error(Buffer.concat(stderrChunks).toString("utf8") || `American football action spotting exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify({ duration, segments }));
    });
    return JSON.parse(stdout) as AmericanFootballActionSpottingResult;
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "American football action spotting failed");
  }
}

async function generateInlineActionSpots(filePath: string, timeline: TimelineSegment[]): Promise<AmericanFootballActionSpottingResult> {
  const assetId = assetIdFromMediaPath(filePath);
  const storedAsset = assetId ? await getAsset(assetId) : null;
  const asset = {
    id: storedAsset?.id ?? assetId ?? basename(dirname(filePath)),
    title: storedAsset?.title ?? basename(filePath),
    description: storedAsset?.description ?? "",
    originalName: storedAsset?.originalName ?? basename(filePath),
    timeline
  };
  const snapshot = getKnowledgeSnapshot();
  const spots = buildAmericanFootballActionSpotPredictions(asset, snapshot.americanFootballPlays ?? []);
  return {
    available: true,
    provider: "american-football-template-generator",
    model: americanFootballActionModel,
    task: "action_spotting",
    spots,
    error: null
  };
}

function assetIdFromMediaPath(mediaPath: string) {
  const parts = mediaPath.split(/[\\/]+/);
  const assetsIndex = parts.lastIndexOf("assets");
  return assetsIndex >= 0 ? parts[assetsIndex + 1] ?? null : null;
}

function unavailable(error: string): AmericanFootballActionSpottingResult {
  return {
    available: false,
    provider: "american-football-action-spotting",
    model: americanFootballActionModel,
    task: "action_spotting",
    spots: [],
    error
  };
}
