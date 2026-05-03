import type { ShotWindow } from "../../sceneDetection";

export type TimelineBasis = {
  start: number;
  end: number;
  text: string;
  shotIndex: number;
  boundaryScore: number | null;
  boundarySource: ShotWindow["boundarySource"];
  boundaryDetector: string | null;
};
