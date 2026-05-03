export type SoccerNetActionSpot = {
  label: string;
  eventType: string;
  position: number;
  half: number | null;
  confidence: number;
  evidence: string[];
};

export type SoccerNetActionSpottingResult = {
  available: boolean;
  provider: string;
  model: string;
  task: "action_spotting";
  spots: SoccerNetActionSpot[];
  error?: string | null;
};
