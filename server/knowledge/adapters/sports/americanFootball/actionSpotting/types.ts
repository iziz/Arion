export type AmericanFootballActionSpot = {
  label: string;
  eventType: string;
  position: number;
  period: number | null;
  confidence: number;
  evidence: string[];
  playMetadata?: {
    provider: "nflverse" | "big-data-bowl" | "manual" | "unknown";
    gameId: string | null;
    playId: string | null;
    season: string | null;
    week: number | null;
    possessionTeam: string | null;
    defensiveTeam: string | null;
    down: number | null;
    distance: number | null;
    yardline: string | null;
    yardline100: number | null;
    quarter: number | null;
    clock: string | null;
    description: string | null;
    sourceText: string[];
  };
  participants?: Array<{
    role: "quarterback" | "rusher" | "receiver" | "passer" | "tackler" | "contact" | "unknown";
    playerId: string | null;
    name: string | null;
    team: string | null;
    trackId: string | null;
    confidence: number;
    source: "nflverse" | "helmet_assignment" | "tracking" | "asr" | "ocr" | "vlm" | "unknown";
  }>;
  tracking?: {
    schema: "big-data-bowl" | "mot" | "unavailable";
    playId: string | null;
    frameIds: string[];
    trackIds: string[];
    contactIds: string[];
    confidence: number;
  };
};

export type AmericanFootballActionSpottingResult = {
  available: boolean;
  provider: string;
  model: string;
  task: "action_spotting";
  spots: AmericanFootballActionSpot[];
  error?: string | null;
};
