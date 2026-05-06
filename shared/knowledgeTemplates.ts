import type { KnowledgeSourceId } from "./types";

export type KnowledgeTemplateProviderContract = {
  name: string;
  role: string;
  contract: string;
};

export type KnowledgeTemplateEvidenceContract = {
  name: string;
  role: string;
  required: boolean;
  contract: string;
};

export type KnowledgeTemplateBenchmarkCoverage = {
  name: string;
  source: string;
  role: string;
  status: "active" | "partial" | "planned" | "external";
  coverage: string;
  metrics: string[];
  notes: string;
};

export type SportsBaseTemplateContract = {
  id: string;
  label: string;
  version: string;
  sharedRules: string[];
  evidenceContract: string[];
  outputContract: string[];
  skipPolicy: string[];
  evaluatorPolicy: string[];
};

export type KnowledgeTemplateStrategyContract = {
  baseTemplateId: string;
  strategyId: string;
  sharedRules: string[];
  specializationRules: string[];
};

export type KnowledgeTemplateDescriptor = {
  sourceId: KnowledgeSourceId;
  strategy: KnowledgeTemplateStrategyContract;
  manifest: {
    id: string;
    label: string;
    domain: string;
    version: string;
    summary: string;
    providerContracts: KnowledgeTemplateProviderContract[];
    requiredEvidence: KnowledgeTemplateEvidenceContract[];
    outputSchema: string[];
    runtimeGates: string[];
    skipConditions: string[];
    limitations: string[];
  };
  generator: {
    id: string;
    adapter: string;
    kind: "external-prediction-source" | "inline-template-generator";
    timing: string;
    outputVersion: string;
    consumes: string[];
    pipeline: string[];
    emits: string[];
    actionSpotting: {
      minCandidateConfidence: number;
      alignment: {
        minScore: number;
        minStrongScore: number;
        requireProviderContext: boolean;
        teamTermStrategy: string;
      };
    };
  };
  evaluator: {
    benchmarkCoverage: KnowledgeTemplateBenchmarkCoverage[];
    validationGates: string[];
    fixtures: string[];
    regressionChecks: string[];
  };
};

export const sportsBaseTemplateContract: SportsBaseTemplateContract = {
  id: "sports.base.manifest.v1",
  label: "Sports base template",
  version: "sports-base-template-v1",
  sharedRules: [
    "Resolve game or match context before assigning player identity.",
    "Represent edited videos as multiple context video ranges with independent clock mappings.",
    "Keep detector, OCR, ASR, VLM, tracking, and knowledge evidence as separate evidence sources.",
    "Treat trackId to playerId resolution as candidate evidence unless roster window, context, clock, and visual continuity agree.",
    "Expose skip reasons when required domain evidence is missing instead of fabricating context."
  ],
  evidenceContract: [
    "timeline segment start/end",
    "OCR/ASR/VLM text evidence",
    "domain event metadata",
    "team/player registry records",
    "MOT track ids",
    "domain-specific clock or play/match metadata"
  ],
  outputContract: [
    "matchContexts[].videoRanges[]",
    "matchContexts[].clockMappings[]",
    "activeRosterWindows[]",
    "playerIdentityCandidates[]",
    "trackIdentityAssignments[]",
    "searchText identity enrichment"
  ],
  skipPolicy: [
    "Skip when no registered sports strategy matches the asset group domain.",
    "Skip domain context when no domain knowledge candidate can be scored above threshold.",
    "Skip confirmed identity when track evidence or time-scoped participant evidence is absent."
  ],
  evaluatorPolicy: [
    "Validate schema stability independently from model quality.",
    "Measure benchmark coverage per domain strategy.",
    "Keep false context alignment prevention as a regression gate."
  ]
};

export const knowledgeTemplateDescriptors: Partial<Record<KnowledgeSourceId, KnowledgeTemplateDescriptor>> = {
  "sports.football": {
    sourceId: "sports.football",
    strategy: {
      baseTemplateId: sportsBaseTemplateContract.id,
      strategyId: "sports.football.identity.strategy.v1",
      sharedRules: sportsBaseTemplateContract.sharedRules,
      specializationRules: [
        "Use matchId, half/minute, lineup activity, and SoccerNet-style action spots as the football specialization.",
        "Limit player identity with starting lineup, substitution, and red-card roster windows.",
        "Use jersey OCR only as candidate evidence unless a track and roster window also support the same player."
      ]
    },
    manifest: {
      id: "sports.football.manifest.v1",
      label: "Football template",
      domain: "Association football",
      version: "football-template-v1",
      summary: "Maps sports registry records and SoccerNet-style timestamp predictions into football DomainEvent evidence.",
      providerContracts: [
        {
          name: "football-data / StatBunker / StatsBomb / FBref",
          role: "Registry and RAG source",
          contract: "competition, team, player, match activity, and fact documents"
        },
        {
          name: "SoccerNet action spotting",
          role: "Timestamp action source",
          contract: "label, eventType, position, half, confidence, evidence"
        },
        {
          name: "Vision detector + tracker",
          role: "Player/ball evidence",
          contract: "person/ball boxes, trackId, field zone, ball movement"
        }
      ],
      requiredEvidence: [
        { name: "SoccerNet JSON", role: "Primary timestamp action source", required: true, contract: "position, half, label, confidence" },
        { name: "ASR/OCR/VLM", role: "Grounding and search evidence", required: false, contract: "spoken text, visible text, captions, visible players/actions" },
        { name: "Vision detector", role: "Player and ball spatial evidence", required: false, contract: "person boxes, ball boxes, field zone estimates" },
        { name: "MOT tracks", role: "Identity continuity", required: false, contract: "trackId continuity and player/ball trajectories" },
        { name: "Sports registry", role: "Team/player/fact grounding", required: false, contract: "competition aliases, teams, players, match activities, facts" }
      ],
      outputSchema: [
        "label",
        "eventType",
        "position",
        "half",
        "confidence",
        "evidence",
        "football.phase",
        "football.fieldZone",
        "football.passType",
        "football.receivingPlayer.trackId",
        "football.passingPlayer.trackId"
      ],
      runtimeGates: [
        "SOCCERNET_ACTION_SPOTTING_COMMAND or SOCCERNET_ACTION_SPOTS_JSON must exist when action spotting is required.",
        "Vision detector/tracker capability gates control whether trackId evidence is available.",
        "RAG vector rebuild controls whether registry knowledge participates in query grounding."
      ],
      skipConditions: [
        "Action spotting is skipped when SoccerNet prediction source is missing and the capability is optional.",
        "Player identity fields stay empty when no registry, OCR/ASR/VLM, or track evidence can identify a player.",
        "Field calibration fields stay estimated when no homography/calibration layer is configured."
      ],
      limitations: [
        "SoccerNet action spots provide timestamp action evidence, not official match play identifiers.",
        "Player identity requires separate registry, OCR/ASR/VLM, or tracking evidence.",
        "Field calibration remains estimated unless a calibrated homography layer is configured."
      ]
    },
    generator: {
      id: "sports.football.generator.soccernet.v1",
      adapter: "sports.football.soccernet",
      kind: "external-prediction-source",
      timing: "Runs inside the knowledge-action stage after timeline, detector, and tracker evidence are available.",
      outputVersion: "soccernet-action-spotting-v1",
      consumes: ["SoccerNet JSON or command output", "indexed timeline segments", "vision detector output", "MOT tracks", "sports registry aliases"],
      pipeline: [
        "Import registry and match/fact knowledge into the sports store.",
        "Vectorize selected knowledge documents for RAG evidence grounding.",
        "Normalize SoccerNet-style prediction JSON or external command output.",
        "Attach action spots to timeline segments by timestamp tolerance.",
        "Emit football DomainEvent fields for phase, fieldZone, passType, players, ball, and field evidence."
      ],
      emits: ["timestamp action spots", "football DomainEvent fields", "searchable action labels", "evidence grounding references"],
      actionSpotting: {
        minCandidateConfidence: 0.5,
        alignment: {
          minScore: 0,
          minStrongScore: 0,
          requireProviderContext: false,
          teamTermStrategy: "competition/player/team registry aliases"
        }
      }
    },
    evaluator: {
      benchmarkCoverage: [
        {
          name: "SoccerNet action spotting",
          source: "SoccerNet",
          role: "Timestamp action benchmark",
          status: "external",
          coverage: "Adapter accepts SoccerNet-style predictions; benchmark execution remains external.",
          metrics: ["mAP", "timestamp tolerance recall", "label precision"],
          notes: "Arion validates schema normalization and timeline attachment, not full SoccerNet model quality."
        },
        {
          name: "Football registry grounding",
          source: "football-data / StatsBomb / StatBunker / FBref",
          role: "Knowledge retrieval coverage",
          status: "active",
          coverage: "Registry and vector coverage are shown in the Overview tab.",
          metrics: ["document coverage", "provider distribution", "grounded evidence count"],
          notes: "Coverage depends on imported providers and vector rebuild status."
        }
      ],
      validationGates: [
        "Prediction source must parse into the action spotting output schema.",
        "Timestamp attachment must preserve segment-local evidence and not fabricate player identity.",
        "Search ranking must keep direct video evidence separate from registry-only knowledge evidence."
      ],
      fixtures: ["SoccerNet-style JSON fixture", "football DomainEvent mapping fixture", "registry-grounded search fixture"],
      regressionChecks: [
        "Missing SoccerNet source reports an unavailable reason instead of creating empty verified events.",
        "Unstructured football text cannot create player identity without supporting evidence.",
        "Timeline moments are built from timestamp windows, not fixed scene count caps."
      ]
    }
  },
  "sports.american_football": {
    sourceId: "sports.american_football",
    strategy: {
      baseTemplateId: sportsBaseTemplateContract.id,
      strategyId: "sports.american_football.identity.strategy.v1",
      sharedRules: sportsBaseTemplateContract.sharedRules,
      specializationRules: [
        "Use gameId, playId, quarter, game clock, down, distance, and yardline as the American-football specialization.",
        "Prefer nflverse and action-spot play metadata over weak team-name-only alignment.",
        "Use helmet/contact/MOT evidence as track identity evidence when those detectors are available."
      ]
    },
    manifest: {
      id: "sports.american_football.manifest.v1",
      label: "American football template",
      domain: "American football",
      version: "american-football-template-v1",
      summary: "Uses nflverse play metadata, indexed video evidence, and MOT/contact hooks to produce timestamp action JSON with game/play context.",
      providerContracts: [
        {
          name: "nflverse",
          role: "Domain knowledge and play metadata",
          contract: "gameId, playId, season, week, down, distance, yardline, playType, players"
        },
        {
          name: "Big Data Bowl schema",
          role: "Tracking-style metadata contract",
          contract: "gameId, playId, nflId/playerId, frameId, trackId, x/y/s/a/o/dir"
        },
        {
          name: "Helmet/MOT/contact layer",
          role: "Identity and contact evidence",
          contract: "trackId, playerId, contactIds, frameIds, confidence"
        },
        {
          name: "OCR/ASR/VLM alignment",
          role: "Video-to-play matching evidence",
          contract: "team/player/down-distance/play text cues with timestamp evidence"
        }
      ],
      requiredEvidence: [
        { name: "Indexed video timeline", role: "Primary timestamp source", required: true, contract: "segment start/end, ASR text, OCR text, VLM captions, visual labels" },
        { name: "nflverse play-by-play", role: "Game/play metadata source", required: false, contract: "gameId, playId, down, distance, yardline, playType, player ids/names" },
        { name: "Vision detector", role: "Helmet/player/ball evidence", required: false, contract: "detected players, ball, event classification, field hints" },
        { name: "MOT tracks", role: "trackId continuity", required: false, contract: "playerTracks, ballTracks, nearestPlayerTrackId, ballTrackId" },
        { name: "Contact detector", role: "contact/impact evidence", required: false, contract: "contactIds, frameIds, player/contact confidence" }
      ],
      outputSchema: [
        "label",
        "eventType",
        "position",
        "period",
        "confidence",
        "evidence",
        "playMetadata.gameId",
        "playMetadata.playId",
        "playMetadata.down",
        "playMetadata.distance",
        "playMetadata.yardline",
        "participants.playerId",
        "participants.trackId",
        "tracking.frameIds",
        "tracking.contactIds"
      ],
      runtimeGates: [
        "The inline American-football template generator is configured by default when the related knowledge capability is enabled.",
        "Explicit AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND or AMERICAN_FOOTBALL_ACTION_SPOTS_JSON overrides the inline generator.",
        "nflverse play metadata must be imported before game/play alignment can be populated.",
        "Vision detector/tracker controls MOT track availability.",
        "Contact and helmet assignment fields remain empty until those detectors provide aligned outputs."
      ],
      skipConditions: [
        "Action labels are skipped when segment evidence does not meet the minimum candidate confidence.",
        "nflverse game/play alignment is skipped when NFL/provider context is missing.",
        "nflverse game/play alignment is skipped when strong player/team/down-distance evidence is below threshold.",
        "participant playerId is skipped when the aligned play has no matching passer/rusher/receiver metadata.",
        "trackId/contactId fields stay empty when MOT/contact layers do not produce aligned evidence."
      ],
      limitations: [
        "nflverse is NFL-scoped; college or non-NFL footage can still get action labels but must not get nflverse play alignment.",
        "Play alignment is evidence-gated and should stay empty when only generic football text is present.",
        "Route concepts and pressure attribution require a stronger football-specific model than generic VLM text."
      ]
    },
    generator: {
      id: "sports.american_football.generator.template.v1",
      adapter: "sports.american_football.action_spotting",
      kind: "inline-template-generator",
      timing: "Runs directly inside the knowledge-action stage after vision tracking and before domain enrichment.",
      outputVersion: "american-football-action-spotting-v1",
      consumes: [
        "current detected timeline",
        "asset title/description/originalName",
        "ASR/OCR/VLM evidence",
        "vision event classification",
        "MOT player/ball tracks",
        "nflverse play metadata"
      ],
      pipeline: [
        "Build nflverse lookup indexes from season, player terms, team terms, and play description terms.",
        "Read ASR/OCR/VLM/vision/MOT evidence from each indexed timeline segment.",
        "Generate action candidates from domain cue rules and classifier hints.",
        "Reject candidates below the configured minimum confidence.",
        "Attach nflverse game/play metadata only when provider context and strong evidence thresholds pass.",
        "Emit timestamp action JSON consumed immediately by Knowledge action spotting."
      ],
      emits: ["timestamp action JSON", "American-football DomainEvent records", "play metadata links", "participant evidence", "MOT tracking evidence"],
      actionSpotting: {
        minCandidateConfidence: 0.58,
        alignment: {
          minScore: 7,
          minStrongScore: 3.5,
          requireProviderContext: true,
          teamTermStrategy: "mascot-or-full-team"
        }
      }
    },
    evaluator: {
      benchmarkCoverage: [
        {
          name: "NFL Big Data Bowl / nflverse",
          source: "nflverse + Big Data Bowl schema",
          role: "Play metadata and tracking-style schema validation",
          status: "active",
          coverage: "Play metadata ingest is active; tracking schema fields are represented in the event output contract.",
          metrics: ["play metadata count", "aligned play count", "down-distance match rate", "schema field completeness"],
          notes: "Arion currently validates metadata normalization and alignment gates, not full player trajectory model quality."
        },
        {
          name: "NFL Player Contact / Impact Detection",
          source: "NFL contact benchmark",
          role: "Contact and impact evidence target",
          status: "planned",
          coverage: "Output contract includes contactIds; detector integration is not yet active.",
          metrics: ["contact precision", "contact recall", "frame-level F1"],
          notes: "Contact fields intentionally stay empty until an aligned detector is connected."
        },
        {
          name: "Helmet Assignment / MOT datasets",
          source: "Helmet assignment and MOT-style tracking",
          role: "Player identity and track continuity target",
          status: "partial",
          coverage: "MOT trackId hooks are active; helmet-to-player identity assignment is still detector-dependent.",
          metrics: ["track continuity", "ID switch count", "helmet assignment accuracy"],
          notes: "Current generator preserves trackIds from vision tracking and only adds playerId through nflverse alignment."
        },
        {
          name: "Custom event labels",
          source: "Arion regression fixtures",
          role: "Domain action cue validation",
          status: "active",
          coverage: "Rush, pass, pressure, scramble, throw-on-run, touchdown, field goal, punt, and kickoff cues are covered by generator logic.",
          metrics: ["candidate precision", "skip reason correctness", "false alignment prevention"],
          notes: "Regression tests include inline generation without JSON and non-NFL context alignment rejection."
        }
      ],
      validationGates: [
        "Inline generator must create action spots without pre-existing prediction JSON.",
        "NFL play alignment must require provider context and strong evidence.",
        "College or generic football footage must not inherit nflverse gameId/playId from weak team terms.",
        "Generated events must preserve timestamp evidence and expose missing tracking/contact fields as missing, not fabricated."
      ],
      fixtures: [
        "NFL Barkley/Eagles inline generation fixture",
        "College Arizona State no-alignment fixture",
        "nflverse play-by-play normalization fixture",
        "American-football DomainEvent mapping fixture"
      ],
      regressionChecks: [
        "Required capability is available through the built-in template generator.",
        "External prediction JSON is an explicit override, not the default runtime source.",
        "Action labels can be produced without play metadata when evidence is valid but alignment is not.",
        "playMetadata, participants, and tracking fields are added only from aligned evidence."
      ]
    }
  }
};
