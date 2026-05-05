import assert from "node:assert/strict";
import test from "node:test";
import { searchAssets } from "../server/intelligenceCore/search";
import { buildSearchMatchReasons, scoreText } from "../server/intelligenceCore/evidence";
import { segmentSearchText } from "../server/intelligenceCore/sceneTimeline";
import { vectorRecordText } from "../server/postgres/vectorUtils";
import { planDomainQuery } from "../server/queryPlanner";
import { planDomainQueryWithOpenAi } from "../server/openaiQueryPlanner";
import { buildOrchestrationPlan } from "../server/orchestrator";
import { buildAskVideoAnswer } from "../server/workflows/ask/answerBuilder";
import { buildSearchAssistantAnswer } from "../src/searchTrust";
import type { AssetRecord, DomainQueryPlan, IndexRecord, TimelineSegment } from "../shared/types";

test("planned semantic query is used as the lexical retrieval anchor", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "command-only",
          transcript: "장면 찾아줘",
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 0);
});

test("generic Korean object search uses planned evidence terms instead of utility keyword extraction", () => {
  assert.deepEqual(queryPlanForRing().retrieval?.evidenceTerms, ["반지", "ring", "wedding ring", "jewelry"]);
  assert.equal(scoreText("손에 반지가 보입니다.", ["반지"]), 1);
});

test("generic Korean object search does not rank scenes from request words", () => {
  const queryPlan = queryPlanForRing();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "generic-appearance",
          transcript: "A person appears and is shown sitting at a table.",
          embedding: [0, 1]
        }),
        segment({
          id: "ring-evidence",
          transcript: "손에 반지가 보입니다.",
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "반지 나오는 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.segments.map((segment) => segment.id), ["ring-evidence"]);
});

test("text match reasons include matched term and evidence source", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "birthday-vlm",
          transcript: "No speech.",
          embedding: [0, 1],
          vlm: birthdayVlmEvidence()
        })
      ])
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );
  const textReason = results[0]?.matchReasons.find((reason) => reason.kind === "lexical");

  assert.match(textReason?.value ?? "", /matched:/);
  assert.match(textReason?.value ?? "", /birthday|cake|생일/);
  assert.match(textReason?.value ?? "", /VLM caption|visible text|VLM evidence|VLM visual|VLM description/);
});

test("generic object search rejects weak visual-only matches without direct evidence", () => {
  const queryPlan = queryPlanForRing();
  const visualHitsBySegment = new Map([["weak-visual", 0.36]]);
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "weak-visual",
          transcript: "A person is sitting at a table.",
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "반지 나오는 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0],
      visualHitsBySegment
    }
  );

  assert.equal(results.length, 0);
});

test("generic object search can use strong visual-only evidence", () => {
  const queryPlan = queryPlanForRing();
  const visualHitsBySegment = new Map([["strong-visual", 0.52]]);
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "strong-visual",
          transcript: "No speech in this shot.",
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "반지 나오는 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0],
      visualHitsBySegment
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.segments[0]?.id, "strong-visual");
});

test("asset metadata alone does not make an unrelated segment a moment match", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      {
        ...assetWithSegments([
          segment({
            id: "desk",
            transcript: "A person is sitting at a desk with a laptop.",
            embedding: [0, 1]
          })
        ]),
        title: "Birthday episode"
      }
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 0);
});

test("English lexical scoring uses terms instead of substring matches", () => {
  assert.equal(scoreText("A person is sitting at a desk.", ["son"]), 0);
  assert.equal(scoreText("The goalkeeper makes a save.", ["goal"]), 0);
  assert.equal(scoreText("The goal is scored.", ["goal"]), 1);
});

test("generic business goal language is not forced into a sports route by rules", () => {
  const plan = planDomainQuery("business goal video");

  assert.equal(plan.route, "generic_video_qa");
  assert.deepEqual(plan.domainFilters, {});
});

test("OpenAI generic route can override rules sports false positives", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "generic_video_qa",
      questionType: "moment_retrieval",
      semanticQuery: "business objective video",
      retrieval: {
        textQuery: "business objective discussion",
        visualQuery: "business objective meeting",
        evidenceTerms: ["business objective"]
      },
      confidence: 0.83,
      warnings: []
    },
    () => planDomainQueryWithOpenAi("business goal video")
  );

  assert.equal(plan.route, "generic_video_qa");
  assert.deepEqual(plan.domainFilters, {});
  assert.equal(plan.semanticQuery, "business objective video");
  assert.deepEqual(plan.retrieval?.evidenceTerms, ["business objective"]);
});

test("OpenAI unsupported route is preserved instead of forced into search", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "unsupported",
      questionType: "moment_retrieval",
      semanticQuery: "unsupported request",
      confidence: 0.81,
      warnings: ["unsupported"]
    },
    () => planDomainQueryWithOpenAi("unsupported non-video request")
  );

  assert.equal(plan.route, "unsupported");
  assert.equal(plan.semanticQuery, "unsupported request");
});

test("OpenAI object moment retrieval is not treated as unsupported when retrieval terms exist", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "unsupported",
      questionType: "moment_retrieval",
      semanticQuery: "ring appears",
      retrieval: {
        textQuery: "ring appears",
        visualQuery: "ring visible on person",
        evidenceTerms: ["반지", "ring"]
      },
      confidence: 0.24,
      warnings: ["broad visual query"]
    },
    () => planDomainQueryWithOpenAi("반지 나오는 장면 찾아줘")
  );

  assert.equal(plan.route, "generic_video_qa");
  assert.deepEqual(plan.retrieval?.evidenceTerms, ["반지", "ring"]);
});

test("unsupported query plans do not return search results", () => {
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "birthday",
          transcript: "Everyone sings happy birthday.",
          embedding: [1, 0]
        })
      ])
    ],
    [indexRecord()],
    "unsupported request",
    {
      queryPlan: {
        ...queryPlanForBirthday(),
        route: "unsupported",
        semanticQuery: "unsupported request",
        rewrittenQuery: "unsupported request"
      },
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 0);
});

test("moment search does not return weak semantic-only scenes without direct evidence", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "desk",
          transcript: "A person is sitting at a desk with a laptop.",
          embedding: [0.87, 0.49]
        })
      ])
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 0);
});

test("moment search can return strong semantic evidence without literal query text", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "cake-candles",
          transcript: "A group gathers around a cake with candles while singing.",
          embedding: [1, 0]
        })
      ])
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.segments[0]?.id, "cake-candles");
});

test("birthday moment search keeps scenes with direct birthday evidence", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "birthday",
          transcript: "Everyone sings happy birthday and celebrates together.",
          embedding: [1, 0]
        })
      ])
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.segments[0]?.id, "birthday");
});

test("birthday moment search keeps scenes with VLM-only birthday evidence", () => {
  const queryPlan = queryPlanForBirthday();
  const birthdaySegment = segment({
    id: "vlm-birthday",
    transcript: "The group reacts to the song.",
    vlm: birthdayVlmEvidence(),
    embedding: [1, 0]
  });
  const results = searchAssets(
    [assetWithSegments([birthdaySegment])],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.match(segmentSearchText(birthdaySegment), /생일 서프라이즈/);
  assert.match(vectorRecordText(birthdaySegment), /birthday/);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.segments[0]?.id, "vlm-birthday");
});

test("multi-term moment search does not pass generic single-term lexical matches", () => {
  const queryPlan = queryPlanForBirthday();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "generic-celebration",
          transcript: "People smile during a celebration.",
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "생일 축하 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 0);
});

test("generic video search does not expose sports vision metadata as match reasons", () => {
  const reasons = buildSearchMatchReasons(
    assetWithSegments([]),
    segment({
      id: "tracked",
      transcript: "A person is sitting at a desk.",
      vision: sportsVisionEvidence()
    }),
    {
      lexicalScore: 0,
      semanticScore: 0.9,
      visualScore: 0,
      domainScore: 0
    },
    undefined,
    queryPlanForBirthday()
  );

  assert.deepEqual(reasons.map((reason) => reason.label), ["Vector"]);
});

test("match reasons use the same vector thresholds as search inclusion", () => {
  const reasons = buildSearchMatchReasons(
    assetWithSegments([]),
    segment({
      id: "weak-vector",
      transcript: "A person is sitting at a desk."
    }),
    {
      lexicalScore: 0,
      semanticScore: 0.81,
      visualScore: 0.31,
      domainScore: 0
    },
    undefined,
    queryPlanForBirthday()
  );

  assert.deepEqual(reasons, []);
});

test("empty generic Korean answer does not expose sports-specific guidance", () => {
  const queryPlan = queryPlanForBirthday();
  const serverAnswer = buildAskVideoAnswer([], queryPlan);
  const clientFallback = buildSearchAssistantAnswer([], queryPlan);

  assert.match(serverAnswer, /검색 범위/);
  assert.doesNotMatch(serverAnswer, /선수|시즌|이벤트|evidence filter/);
  assert.equal(clientFallback, serverAnswer);
});

test("empty sports Korean answer keeps sports-specific guidance", () => {
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "sports_moment_retrieval",
    domainFilters: {
      player: "Son Heung-min"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      player: "Son Heung-min"
    }
  };

  assert.match(buildAskVideoAnswer([], queryPlan), /이벤트, 선수, 시즌/);
});

test("generic orchestration does not expose related-knowledge identity or scope decisions", () => {
  const plan = buildOrchestrationPlan(queryPlanForBirthday(), [assetWithSegments([])], [indexRecord()]);

  assert.deepEqual(plan.decisions.map((decision) => decision.id), ["route"]);
  assert.doesNotMatch(JSON.stringify(plan), /No player requested|No competition\/season requested|sports knowledge/i);
});

test("sports orchestration uses identity and scope only when related knowledge is active in scope", () => {
  const sportsPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "sports_moment_retrieval",
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      player: "Son Heung-min"
    },
    domainFilters: {
      player: "Son Heung-min"
    }
  };
  const withoutKnowledge = buildOrchestrationPlan(sportsPlan, [assetWithSegments([])], [indexRecord()]);
  const withKnowledge = buildOrchestrationPlan(sportsPlan, [assetWithSegments([])], [knowledgeIndexRecord()]);

  assert.deepEqual(withoutKnowledge.decisions.map((decision) => decision.id), ["route"]);
  assert.deepEqual(withKnowledge.decisions.map((decision) => decision.id), ["identity", "scope", "route"]);
});

function queryPlanForBirthday(): DomainQueryPlan {
  return {
    route: "generic_video_qa",
    originalQuery: "생일 축하 장면 찾아줘",
    rewrittenQuery: "Find the birthday celebration scene or birthday wish moment in the video.",
    semanticQuery: "Find the birthday celebration scene or birthday wish moment in the video.",
    retrieval: {
      textQuery: "birthday celebration, birthday wish, happy birthday song, cake, candles",
      visualQuery: "birthday celebration with cake candles or people singing happy birthday",
      evidenceTerms: ["생일", "생일 축하", "birthday", "happy birthday", "cake", "candles"]
    },
    confidence: 0.92,
    domainFilters: {},
    warnings: [],
    intent: {
      domain: null,
      questionType: "moment_retrieval",
      player: null,
      metric: null,
      eventType: null,
      passType: null,
      fieldZone: null,
      role: null
    },
    planner: {
      source: "openai",
      model: "test"
    }
  };
}

function queryPlanForRing(): DomainQueryPlan {
  return {
    route: "generic_video_qa",
    originalQuery: "반지 나오는 장면 찾아줘",
    rewrittenQuery: "Find the scene where a ring appears or is shown.",
    semanticQuery: "Find the scene where a ring appears or is shown.",
    retrieval: {
      textQuery: "ring, wedding ring, jewelry, close-up of a hand wearing a ring",
      visualQuery: "a ring or wedding ring visible on a hand",
      evidenceTerms: ["반지", "ring", "wedding ring", "jewelry"]
    },
    confidence: 0.74,
    domainFilters: {},
    warnings: [],
    intent: {
      domain: null,
      questionType: "moment_retrieval",
      player: null,
      metric: null,
      eventType: null,
      passType: null,
      fieldZone: null,
      role: null
    },
    planner: {
      source: "openai",
      model: "test"
    }
  };
}

function assetWithSegments(timeline: TimelineSegment[]): AssetRecord {
  return {
    id: "asset-1",
    indexId: "index-1",
    title: "Sample video",
    description: "",
    originalName: "sample.mp4",
    storedName: "sample.mp4",
    mimeType: "video/mp4",
    size: 1024,
    duration: 20,
    width: 1920,
    height: 1080,
    status: "indexed",
    progress: 100,
    tags: [],
    summary: "",
    timeline,
    keyframes: [],
    technicalMetadata: {
      storageProvider: "local-s3",
      bucket: "bucket",
      objectKey: "sample.mp4",
      checksum: null,
      frameRate: 30,
      audioCodec: "aac",
      videoCodec: "h264"
    },
    intelligence: {
      audio: { extractedPath: null, speechSegments: [], musicSegments: [], hasSpeech: false, hasMusic: false },
      asr: { transcript: "", language: "unknown", confidence: 0, segments: [] },
      diarization: { provider: "none", speakers: [], segments: [], error: null },
      ocr: { tokens: [], confidence: 0, frames: [] },
      visual: { labels: [], dominantColor: "#000000", brightness: 0, motionScore: 0 },
      modelTrace: []
    },
    error: null,
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z"
  } as AssetRecord;
}

function segment({
  id,
  transcript,
  embedding = [0, 1],
  vision,
  vlm
}: {
  id: string;
  transcript: string;
  embedding?: number[];
  vision?: NonNullable<TimelineSegment["sceneData"]>["vision"];
  vlm?: NonNullable<TimelineSegment["sceneData"]>["vlm"];
}): TimelineSegment {
  return {
    id,
    start: 0,
    end: 5,
    label: "Scene",
    transcript,
    tags: [],
    modalities: ["transcription"],
    confidence: 0.8,
    embedding,
    thumbnailPath: null,
    sources: ["whisper"],
    sceneData: {
      image: {
        thumbnailPath: null,
        framePath: null,
        labels: [],
        dominantColor: "#000000",
        brightness: 0,
        motionScore: 0,
        keyframeAt: 2.5
      },
      text: {
        speech: transcript,
        subtitles: [],
        screenText: [],
        overlays: [],
        watermarks: [],
        comparisons: []
      },
      ...(vision ? { vision } : {}),
      ...(vlm ? { vlm } : {})
    }
  };
}

function birthdayVlmEvidence(): NonNullable<TimelineSegment["sceneData"]>["vlm"] {
  return {
    provider: "qwen2.5-vl:mlx",
    model: "test-vlm",
    status: "described",
    attemptedAt: "2026-05-05T00:00:00.000Z",
    confidence: 0.8,
    caption: "A man stands beside a large cake during a birthday celebration.",
    description: "The scene appears to be a birthday surprise with a cake and candles.",
    sceneType: "Celebratory",
    labels: ["celebration", "birthday"],
    objects: ["large cake", "candles"],
    actions: ["smiling", "standing"],
    visibleText: ["이안대군 생일 서프라이즈 대성공"],
    evidence: ["large cake with lit candles", "birthday surprise text"],
    rawResponse: null,
    error: null
  };
}

function sportsVisionEvidence(): NonNullable<TimelineSegment["sceneData"]>["vision"] {
  return {
    generatedBy: "ultralytics-track",
    trust: "detected",
    frameAt: 2.5,
    pitch: {
      present: true,
      greenDominance: 0.5,
      confidence: 0.7
    },
    objects: {
      players: {
        countEstimate: 8,
        confidence: 0.9,
        status: "detected"
      },
      ball: {
        present: false,
        confidence: 0,
        status: "not_detected"
      }
    },
    fieldZone: {
      zone: "final_third",
      confidence: 0.68,
      method: "detector_x_position"
    },
    fieldCalibration: {
      status: "estimated",
      method: "detector_x_position",
      zone: "final_third",
      zoneConfidence: 0.68,
      attackingDirection: "unknown",
      attackingDirectionConfidence: 0,
      evidence: [],
      limitations: []
    },
    tracking: {
      status: "tracked",
      version: "tracking_v2",
      tracker: "bytetrack.yaml",
      model: "yolo11n.pt",
      continuity: 1,
      frameCount: 10,
      trackedFrameCount: 10,
      trackCoverage: 1,
      idSwitches: 0,
      playerTracks: [],
      ballTracks: [],
      ballTrackId: null,
      nearestPlayerTrackId: "person-1",
      ballMovement: {
        direction: "unknown",
        speedPerSecond: null,
        fromPrevious: null
      }
    },
    eventCandidates: [],
    limitations: []
  };
}

function indexRecord(): IndexRecord {
  return {
    id: "index-1",
    name: "Default",
    description: "",
    models: {
      search: "test",
      analysis: "test",
      embedding: "test"
    },
    modalities: ["visual", "audio", "transcription", "metadata"],
    assetIds: ["asset-1"],
    status: "ready",
    createdAt: "2026-05-05T00:00:00.000Z",
    updatedAt: "2026-05-05T00:00:00.000Z"
  };
}

function knowledgeIndexRecord(): IndexRecord {
  return {
    ...indexRecord(),
    domainIndexing: {
      enabled: true,
      groups: ["sports.football"],
      stages: ["domain_caption", "event_label", "structured_event"]
    }
  };
}

async function withMockedOpenAiPlanner<T>(plannerResponse: Record<string, unknown>, action: () => Promise<T>) {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ output_text: JSON.stringify(plannerResponse) }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
  try {
    return await action();
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
  }
}
