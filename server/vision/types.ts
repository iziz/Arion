import type { VisionBoundingBox, VisionEvidence, VisionJerseyNumberCandidate, VisionTrackAppearance, VisionTrackTeamCluster } from "../../shared/types";

export type DetectorFrame = {
  segmentId: string;
  path: string;
  frameAt: number | null;
  width: number;
  height: number;
  provider: string;
  available: boolean;
  error: string | null;
  boxes: VisionBoundingBox[];
  proximity: NonNullable<VisionEvidence["proximity"]>;
};

export type DetectorResult = {
  available: boolean;
  provider: string;
  model: string;
  warning?: string;
  error?: string;
  frames: DetectorFrame[];
};

export type TrackSummary = {
  id: string;
  label: "person" | "sports_ball";
  frames: number;
  confidence: number;
  firstSeen: number | null;
  lastSeen: number | null;
  appearance?: VisionTrackAppearance;
  teamCluster?: VisionTrackTeamCluster;
  teamConfidence?: number;
  teamEvidence?: string[];
  jerseyNumberCandidates?: VisionJerseyNumberCandidate[];
};

export type TrackerSegment = {
  segmentId: string;
  frameCount: number;
  trackedFrameCount: number;
  trackCoverage: number;
  ballTrackId: string | null;
  nearestPlayerTrackId: string | null;
  ballMovement: NonNullable<VisionEvidence["tracking"]>["ballMovement"];
  proximity: NonNullable<VisionEvidence["proximity"]>;
  playerTracks: TrackSummary[];
  ballTracks: TrackSummary[];
  idSwitches: number;
  boxes: VisionBoundingBox[];
  provider: string;
  model: string;
  tracker: string;
};

export type TrackerResult = {
  available: boolean;
  provider: string;
  model: string;
  tracker: string;
  segments: TrackerSegment[];
  error?: string | null;
};

export type Point = { x: number; y: number };
export type TrackedPlayerBox = { id: string; box: VisionBoundingBox; center: Point; distance?: number };
