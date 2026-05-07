import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { searchAssets } from "../server/intelligenceCore/search";
import { buildSearchMatchReasons, buildVerificationChecks, evaluateSegmentDomainFilters, scoreText } from "../server/intelligenceCore/evidence";
import { segmentSearchText } from "../server/intelligenceCore/sceneTimeline";
import { vectorRecordText } from "../server/postgres/vectorUtils";
import { planDomainQuery } from "../server/queryPlanner";
import { planDomainQueryWithLlm } from "../server/llmQueryPlanner";
import { buildOrchestrationPlan } from "../server/orchestrator";
import { answerSportsKnowledgeQuestion } from "../server/knowledge/adapters/sports/answer";
import { buildStatSeedKnowledgePlan, buildStatSeededMomentPlan, shouldContinueWithMomentRetrieval } from "../server/workflows/ask/statMomentSeed";
import { buildAskAnalysisAnswerContent, buildAskVideoAnswerContent } from "../server/workflows/ask/answerBuilder";
import { buildSearchAssistantAnswer } from "../src/searchTrust";
import { applyExtractiveVideoSummaries } from "../server/intelligenceCore/extractiveSummary";
import { segmentToEmbeddingText } from "../server/localEmbeddingRuntime";
import { mergeVlmResponse } from "../server/vlm/domainMapper";
import { buildDomainSegmentIndex } from "../server/domainIndex/domainTimeline";
import type { AssetRecord, DomainEvent, DomainQueryPlan, IndexRecord, StructuredKnowledgeAnswer, TimelineSegment } from "../shared/types";

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

test("visible text search requires the literal text inside OCR/subtitle/logo evidence", () => {
  const queryPlan = queryPlanForKoreanVisibleText();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "generic-ocr",
          transcript: "A subtitle appears on screen.",
          subtitles: ["다른 자막"],
          embedding: [1, 0]
        }),
        segment({
          id: "literal-ocr",
          transcript: "The requested text is visible.",
          subtitles: ["미소"],
          embedding: [0, 1]
        }),
        segment({
          id: "literal-logo",
          transcript: "A logo is visible on screen.",
          vlm: {
            ...birthdayVlmEvidence(),
            caption: "A logo appears on screen.",
            description: "The visible logo text reads 미소.",
            visibleText: ["logo: 미소"],
            evidence: ["logo text reads 미소"]
          },
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "미소라는 한글이 노출된 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.segments.map((segment) => segment.id).sort(), ["literal-logo", "literal-ocr"]);
});

test("spoken phrase search requires the phrase inside speech evidence", () => {
  const queryPlan = queryPlanForSpokenThanks();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "generic-speaking",
          transcript: "A person is speaking during the interview.",
          embedding: [1, 0]
        }),
        segment({
          id: "visible-only-thanks",
          transcript: "No dialogue here.",
          screenText: ["thank you"],
          embedding: [1, 0]
        }),
        segment({
          id: "vlm-caption-thanks",
          transcript: "People laugh while the caption is shown.",
          vlm: {
            ...birthdayVlmEvidence(),
            visibleText: ["고마워~"],
            caption: "People are smiling during a behind-the-scenes moment."
          },
          embedding: [0, 1]
        }),
        segment({
          id: "spoken-korean-thanks",
          transcript: "정말 고마워. 덕분에 살았어.",
          embedding: [0, 1]
        }),
        segment({
          id: "spoken-english-thanks",
          transcript: "Thank you for coming today.",
          embedding: [0, 1]
        })
      ])
    ],
    [indexRecord()],
    "고마워 라고 말하는 장면 찾아줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );

  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.segments.map((segment) => segment.id).sort(), ["spoken-english-thanks", "spoken-korean-thanks", "vlm-caption-thanks"]);
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

test("generic business goal language is not forced into a related-knowledge route by rules", () => {
  const plan = planDomainQuery("business goal video");

  assert.equal(plan.route, "asset_evidence");
  assert.equal(plan.responseMode, "moment_retrieval");
  assert.equal(plan.relatedKnowledgeMode, "none");
  assert.deepEqual(plan.domainFilters, {});
});

test("generic clothing question is planned as a grounded video answer", () => {
  const plan = planDomainQuery("이 영상에 나오는 남자의 옷 스타일이 뭐야?");
  const orchestration = buildOrchestrationPlan(plan, [assetWithSegments([])], [indexRecord()]);

  assert.equal(plan.route, "asset_evidence");
  assert.equal(plan.responseMode, "grounded_answer");
  assert.equal(plan.relatedKnowledgeMode, "none");
  assert.equal(orchestration.mode, "analysis");
  assert.equal(orchestration.analysis.required, true);
});

test("local query planner does not infer participant roles from language-specific event terms", () => {
  const passPlan = planDomainQuery("손흥민이 패스하는 장면 찾아줘");
  const shotPlan = planDomainQuery("손흥민 골 장면 찾아줘");

  assert.equal(passPlan.domainFilters.role, undefined);
  assert.equal(passPlan.intent.role, null);
  assert.equal(shotPlan.domainFilters.eventType, "shot");
  assert.equal(shotPlan.domainFilters.role, undefined);
  assert.equal(shotPlan.intent.role, null);
});

test("OpenAI generic route can override related-knowledge false positives", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      semanticQuery: "business objective video",
      retrieval: {
        textQuery: "business objective discussion",
        visualQuery: "business objective meeting",
        evidenceTerms: ["business objective"]
      },
      confidence: 0.83,
      warnings: []
    },
    () => planDomainQueryWithLlm("business goal video")
  );

  assert.equal(plan.route, "asset_evidence");
  assert.equal(plan.responseMode, "moment_retrieval");
  assert.equal(plan.relatedKnowledgeMode, "none");
  assert.deepEqual(plan.domainFilters, {});
  assert.equal(plan.semanticQuery, "business objective video");
  assert.deepEqual(plan.retrieval?.evidenceTerms, ["business objective"]);
});

test("OpenAI visible text plans carry literal OCR constraints separately from source labels", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      semanticQuery: "Find a scene where the Korean text '미소' appears on screen.",
      retrieval: {
        textQuery: "미소 Korean text on screen OCR subtitle sign logo",
        visualQuery: "screen with Korean text '미소' visible",
        evidenceTerms: ["미소", "korean text", "ocr", "subtitle", "logo"],
        requiredEvidence: [{ kind: "visible_text", terms: ["미소"], match: "all" }]
      },
      confidence: 0.92,
      warnings: []
    },
    () => planDomainQueryWithLlm("미소라는 한글이 노출된 장면 찾아줘")
  );

  assert.deepEqual(plan.retrieval?.requiredEvidence, [{ kind: "visible_text", terms: ["미소"], match: "all" }]);
});

test("OpenAI spoken phrase plans carry literal speech constraints separately from action labels", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      semanticQuery: "scene where someone says thank you",
      retrieval: {
        textQuery: "고마워 thank you spoken dialogue",
        visualQuery: "person speaking",
        evidenceTerms: ["고마워", "thank you", "saying thank you", "speaking"],
        requiredEvidence: [{ kind: "spoken_text", terms: ["고마워", "thank you"], match: "any" }]
      },
      confidence: 0.86,
      warnings: []
    },
    () => planDomainQueryWithLlm("고마워 라고 말하는 장면 찾아줘")
  );

  assert.deepEqual(plan.retrieval?.requiredEvidence, [{ kind: "spoken_text", terms: ["고마워", "thank you"], match: "any" }]);
});

test("VLM planner is used when OpenAI planning fails", async () => {
  const plan = await withMockedOpenAiFailureAndVlmPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      semanticQuery: "Find a scene where the Korean text '테스트미소' appears on screen.",
      retrieval: {
        textQuery: "테스트미소 Korean text on screen OCR subtitle logo",
        visualQuery: "screen with Korean text '테스트미소' visible",
        evidenceTerms: ["테스트미소", "korean text", "ocr", "subtitle", "logo"],
        requiredEvidence: [{ kind: "visible_text", terms: ["테스트미소"], match: "all" }]
      },
      confidence: 0.91,
      warnings: []
    },
    () => planDomainQueryWithLlm("테스트미소라는 한글이 노출된 장면 찾아줘")
  );

  assert.equal(plan.planner?.source, "vlm");
  assert.match(plan.planner?.fallbackReason ?? "", /OpenAI planner fallback/);
  assert.deepEqual(plan.retrieval?.requiredEvidence, [{ kind: "visible_text", terms: ["테스트미소"], match: "all" }]);
});

test("VLM fallback planner preserves structured participant direction", async () => {
  const plan = await withMockedOpenAiFailureAndVlmPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: null,
      participants: [
        {
          entity: "Son Heung-min",
          relation: "action_source",
          role: "passer",
          eventType: "pass_receive",
          evidence: ["The named entity initiates the pass action."]
        }
      ],
      semanticQuery: "Son Heung-min passing the ball to another player",
      retrieval: {
        textQuery: "Son Heung-min pass to another player football",
        visualQuery: "football player passing the ball to a teammate",
        evidenceTerms: ["son heung-min", "pass", "teammate"]
      },
      filterEvidence: {
        player: ["Son Heung-min"],
        eventType: ["pass action"]
      },
      confidence: 0.89,
      warnings: []
    },
    () => planDomainQueryWithLlm("손흥민이 다른 선수한테 패스하는 장면 찾아줘")
  );

  assert.equal(plan.planner?.source, "vlm");
  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.eventType, "pass_receive");
  assert.equal(plan.domainFilters.role, "passer");
  assert.deepEqual(plan.intent.participants?.map((participant) => [participant.entity, participant.relation, participant.role]), [["Son Heung-min", "action_source", "passer"]]);
});

test("planner unavailability does not fall back to local query rules", async () => {
  const plan = await withoutConfiguredModelPlanners(() => planDomainQueryWithLlm("로컬규칙반지 나오는 장면 찾아줘"));

  assert.equal(plan.planner?.source, "unavailable");
  assert.equal(plan.route, "unsupported");
  assert.deepEqual(plan.retrieval?.evidenceTerms, []);
  assert.deepEqual(plan.retrieval?.requiredEvidence, []);
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
    () => planDomainQueryWithLlm("unsupported non-video request")
  );

  assert.equal(plan.route, "unsupported");
  assert.equal(plan.semanticQuery, "unsupported request");
});

test("OpenAI unsupported grounded video answer is normalized to asset evidence", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "unsupported",
      responseMode: "grounded_answer",
      relatedKnowledgeMode: "none",
      semanticQuery: "man's clothing style",
      retrieval: {
        textQuery: "man's clothing outfit style",
        visualQuery: "man clothing outfit style",
        evidenceTerms: ["남자", "옷", "스타일", "man", "clothing", "outfit"]
      },
      confidence: 0.18,
      warnings: ["visual evidence may be limited"]
    },
    () => planDomainQueryWithLlm("이 남자의 옷스타일은 뭐야?")
  );

  assert.equal(plan.route, "asset_evidence");
  assert.equal(plan.responseMode, "grounded_answer");
  assert.equal(plan.relatedKnowledgeMode, "none");
  assert.deepEqual(plan.retrieval?.evidenceTerms, ["남자", "옷", "스타일", "man", "clothing", "outfit"]);
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
    () => planDomainQueryWithLlm("반지 나오는 장면 찾아줘")
  );

  assert.equal(plan.route, "asset_evidence");
  assert.equal(plan.responseMode, "moment_retrieval");
  assert.deepEqual(plan.retrieval?.evidenceTerms, ["반지", "ring"]);
});

test("non-structured knowledge evidence plans are normalized to asset retrieval", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "knowledge_evidence",
      responseMode: "analysis",
      relatedKnowledgeMode: "grounding",
      analysisSubject: "Son Heung-min",
      semanticQuery: "Analyze Son Heung-min playing style from indexed video evidence.",
      retrieval: {
        textQuery: "Son Heung-min playing style dribbling shooting runs positioning",
        visualQuery: "Son Heung-min match footage dribbling shooting runs positioning",
        evidenceTerms: ["손흥민", "son heung-min", "dribbling", "shooting", "runs", "positioning"]
      },
      confidence: 0.8,
      warnings: []
    },
    () => planDomainQueryWithLlm("손흥민의 플레이 스타일을 분석해줘")
  );

  assert.equal(plan.route, "asset_evidence");
  assert.equal(plan.responseMode, "analysis");
  assert.equal(plan.relatedKnowledgeMode, "grounding");
  assert.match(plan.warnings.join(" "), /Normalized non-structured knowledge route/);
});

test("OpenAI stat plans use statMode and filterEvidence instead of query leaderboard rules", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "grounding",
      metric: "goals",
      statMode: "leaderboard",
      competition: "Premier League",
      season: "2025-26",
      semanticQuery: "Premier League goals leader 2025-26",
      filterEvidence: {
        competition: ["Premier League"],
        season: ["2025-26"],
        statMode: ["goals leader"]
      },
      confidence: 0.88,
      warnings: []
    },
    () => planDomainQueryWithLlm("득점 현황 알려줘")
  );

  assert.equal(plan.route, "knowledge_evidence");
  assert.equal(plan.responseMode, "structured_answer");
  assert.equal(plan.relatedKnowledgeMode, "direct_answer");
  assert.equal(plan.intent.metric, "goals");
  assert.equal(plan.intent.statMode, "leaderboard");
  assert.deepEqual(plan.domainFilters, { competition: "Premier League", season: "2025-26" });
});

test("OpenAI stat moment plans become explicit knowledge-seeded retrieval routes", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "grounding",
      metric: "goals",
      statMode: "leaderboard",
      competition: "Premier League",
      season: "2025-26",
      semanticQuery: "Premier League goals leader goal moments 2025-26",
      retrieval: {
        textQuery: "Premier League goals leader goal scenes",
        visualQuery: "football goal scoring scenes",
        evidenceTerms: ["goal", "scoring", "shot"]
      },
      filterEvidence: {
        competition: ["Premier League"],
        season: ["2025-26"],
        statMode: ["goals leader"]
      },
      confidence: 0.88,
      warnings: []
    },
    () => planDomainQueryWithLlm("득점 1위 골 장면 찾아줘")
  );

  assert.equal(plan.route, "knowledge_seeded_asset_evidence");
  assert.equal(plan.responseMode, "moment_retrieval");
  assert.equal(plan.relatedKnowledgeMode, "grounding");
  assert.equal(plan.intent.metric, "goals");
  assert.equal(plan.intent.statMode, "leaderboard");
});

test("planner-provided pass participant roles are preserved as structured filters", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: null,
      participants: [
        {
          entity: "Son Heung-min",
          relation: "action_source",
          role: "passer",
          eventType: "pass_receive",
          evidence: ["The named player is the source of the pass action."]
        }
      ],
      semanticQuery: "Son Heung-min passing the ball to another player",
      retrieval: {
        textQuery: "Son Heung-min pass to another player football",
        visualQuery: "football player passing the ball to teammate",
        evidenceTerms: ["손흥민", "son heung-min", "pass", "패스"]
      },
      filterEvidence: {
        player: ["손흥민"],
        eventType: ["model inferred pass event"]
      },
      confidence: 0.82,
      warnings: []
    },
    () => planDomainQueryWithLlm("손흥민이 다른선수한테 공을 패스해주는 영상 찾아줘")
  );

  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.eventType, "pass_receive");
  assert.equal(plan.domainFilters.role, "passer");
  assert.equal(plan.intent.role, "passer");
  assert.deepEqual(plan.intent.participants?.map((participant) => [participant.entity, participant.relation, participant.role]), [["Son Heung-min", "action_source", "passer"]]);
  assert.doesNotMatch(plan.warnings.join(" "), /Normalized directional pass role/);
});

test("participant filters remain active for indexed asset evidence without knowledge grounding", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      player: "Son Heung-min",
      participants: [
        {
          entity: "Son Heung-min",
          relation: "action_source",
          role: "passer",
          eventType: "pass_receive",
          evidence: ["The named player initiates the pass action."]
        }
      ],
      semanticQuery: "Son Heung-min passing the ball to another player",
      retrieval: {
        textQuery: "Son Heung-min pass to another player football",
        visualQuery: "football player passing the ball to teammate",
        evidenceTerms: ["손흥민", "son heung-min", "pass", "패스"]
      },
      filterEvidence: {
        player: ["손흥민"],
        eventType: ["model inferred pass event"]
      },
      confidence: 0.82,
      warnings: []
    },
    () => planDomainQueryWithLlm("손흥민이 다른 선수에게 공을 패스하는 장면")
  );

  assert.equal(plan.relatedKnowledgeMode, "none");
  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.eventType, "pass_receive");
  assert.equal(plan.domainFilters.role, "passer");
  assert.equal(plan.intent.role, "passer");
});

test("asset moment retrieval drops registry-inferred competition and season scope filters", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      competition: "Premier League",
      season: "2025-26",
      player: "Son Heung-min",
      eventType: "pass_receive",
      participants: [
        {
          entity: "Son Heung-min",
          relation: "action_source",
          role: "passer",
          eventType: "pass_receive",
          evidence: ["The named player initiates the pass action."]
        },
        {
          entity: "Scott Player",
          relation: "action_target",
          role: "receiver",
          eventType: "pass_receive",
          evidence: ["The pass is directed to another player."]
        }
      ],
      semanticQuery: "Find moments where Son Heung-min passes to another player.",
      retrieval: {
        textQuery: "Son Heung-min pass to teammate assist pass",
        visualQuery: "football player passing the ball to teammate",
        evidenceTerms: ["손흥민", "son heung-min", "pass", "패스"]
      },
      filterEvidence: {
        competition: ["Son Heung-min is a Premier League player"],
        season: ["current Premier League season in May 2026 is 2025-26"],
        player: ["named player Son Heung-min"],
        eventType: ["asking for a pass action"]
      },
      confidence: 0.94,
      warnings: []
    },
    () => planDomainQueryWithLlm("손흥민이 다른 선수한테 패스하는 영상 찾아줘")
  );

  assert.equal(plan.domainFilters.competition, undefined);
  assert.equal(plan.domainFilters.season, undefined);
  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.eventType, "pass_receive");
  assert.equal(plan.domainFilters.role, "passer");
  assert.deepEqual(plan.intent.participants?.map((participant) => participant.entity), ["Son Heung-min"]);
  assert.match(plan.warnings.join(" "), /Dropped inferred scope filters/);
});

test("asset moment retrieval keeps explicitly requested competition and season scope filters", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      competition: "Premier League",
      season: "2025-26",
      player: "Son Heung-min",
      eventType: "pass_receive",
      participants: [
        {
          entity: "Son Heung-min",
          relation: "action_source",
          role: "passer",
          eventType: "pass_receive",
          evidence: ["The named player initiates the pass action."]
        }
      ],
      semanticQuery: "Find Premier League 2025-26 moments where Son Heung-min passes to another player.",
      retrieval: {
        textQuery: "Premier League 2025-26 Son Heung-min pass to teammate",
        visualQuery: "Premier League football player passing the ball to teammate",
        evidenceTerms: ["프리미어리그", "2025-26", "손흥민", "pass"]
      },
      filterEvidence: {
        competition: ["The user explicitly says 프리미어리그."],
        season: ["The user explicitly says 2025-26."],
        player: ["named player Son Heung-min"],
        eventType: ["asking for a pass action"]
      },
      confidence: 0.94,
      warnings: []
    },
    () => planDomainQueryWithLlm("프리미어리그 2025-26에서 손흥민이 다른 선수한테 패스하는 영상 찾아줘")
  );

  assert.equal(plan.domainFilters.competition, "Premier League");
  assert.equal(plan.domainFilters.season, "2025-26");
  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.eventType, "pass_receive");
  assert.equal(plan.domainFilters.role, "passer");
  assert.doesNotMatch(plan.warnings.join(" "), /Dropped inferred scope filters/);
});

test("top-level planner roles are ignored unless backed by structured participants", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: "passer",
      semanticQuery: "Son Heung-min pass moment",
      retrieval: {
        textQuery: "Son Heung-min pass moment",
        visualQuery: "football pass moment",
        evidenceTerms: ["son heung-min", "pass"]
      },
      filterEvidence: {
        player: ["Son Heung-min"],
        eventType: ["pass event"],
        role: ["legacy top-level role without participant contract"]
      },
      confidence: 0.82,
      warnings: []
    },
    () => planDomainQueryWithLlm("Son Heung-min pass participant without evidence clip")
  );

  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.eventType, "pass_receive");
  assert.equal(plan.domainFilters.role, undefined);
  assert.equal(plan.intent.role, null);
  assert.deepEqual(plan.intent.participants, []);
});

test("participant constraints without evidence are not promoted into filters", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      player: "Son Heung-min",
      participants: [
        {
          entity: "Son Heung-min",
          relation: "action_source",
          role: "passer",
          eventType: "pass_receive",
          evidence: []
        }
      ],
      semanticQuery: "Son Heung-min pass moment",
      retrieval: {
        textQuery: "Son Heung-min pass moment",
        visualQuery: "football pass moment",
        evidenceTerms: ["son heung-min", "pass"]
      },
      filterEvidence: {
        player: ["Son Heung-min"]
      },
      confidence: 0.82,
      warnings: []
    },
    () => planDomainQueryWithLlm("Son Heung-min passing clip")
  );

  assert.equal(plan.domainFilters.player, "Son Heung-min");
  assert.equal(plan.domainFilters.role, undefined);
  assert.equal(plan.domainFilters.eventType, undefined);
  assert.deepEqual(plan.intent.participants, []);
});

test("knowledge-seeded retrieval resolves the stat subject before building moment filters", () => {
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "knowledge_seeded_asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "grounding",
    domainFilters: {
      competition: "Premier League",
      season: "2025-26"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      metric: "goals",
      statMode: "leaderboard"
    }
  };
  const knowledgePlan = buildStatSeedKnowledgePlan(queryPlan);
  const answer: StructuredKnowledgeAnswer = {
    applicable: true,
    route: "stat_qa",
    answer: "Son Heung-min leads Premier League 2025-26 with 12 goals.",
    confidence: 0.86,
    subject: {
      player: "Son Heung-min",
      competition: "Premier League",
      season: "2025-26",
      metric: "goals"
    },
    value: 12,
    status: "answered",
    evidence: [
      {
        provider: "test",
        season: "2025-26",
        competition: "Premier League",
        team: "Tottenham Hotspur",
        sourceText: "Son Heung-min 12 goals"
      }
    ],
    fallback: null,
    warnings: []
  };
  const retrievalPlan = buildStatSeededMomentPlan(queryPlan, answer);

  assert.equal(knowledgePlan.route, "knowledge_evidence");
  assert.equal(knowledgePlan.responseMode, "structured_answer");
  assert.equal(knowledgePlan.domainFilters.player, undefined);
  assert.equal(shouldContinueWithMomentRetrieval(queryPlan, answer), true);
  assert.equal(retrievalPlan.route, "knowledge_seeded_asset_evidence");
  assert.equal(retrievalPlan.domainFilters.player, "Son Heung-min");
  assert.equal(retrievalPlan.domainFilters.eventType, "shot");
  assert.equal(retrievalPlan.domainFilters.role, "shooter");
  assert.ok(retrievalPlan.retrieval?.evidenceTerms.includes("goal"));
});

test("planner-inferred filters without filterEvidence are rejected", async () => {
  const plan = await withMockedOpenAiPlanner(
    {
      route: "asset_evidence",
      responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
      competition: "Premier League",
      player: "Son Heung-min",
      semanticQuery: "sports video moment",
      retrieval: {
        textQuery: "sports video moment",
        visualQuery: "soccer match footage",
        evidenceTerms: ["soccer"]
      },
      confidence: 0.77,
      warnings: []
    },
    () => planDomainQueryWithLlm("스포츠 장면 찾아줘")
  );

  assert.deepEqual(plan.domainFilters, {});
  assert.equal(plan.intent.player, null);
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

test("unstructured event text is weak event evidence only when structured event evidence is absent", () => {
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "none",
    domainFilters: {
      eventType: "shot"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      eventType: "shot",
      role: null
    }
  };
  const textOnlyGoal = segment({
    id: "text-only-goal",
    transcript: "Son scores a goal from close range after a quick move.",
    embedding: [0, 1]
  });
  const structuredConflict = withDomainEvents(
    segment({
      id: "structured-pass",
      transcript: "The commentary mentions a goal, but the indexed event is a pass receive.",
      embedding: [0, 1]
    }),
    [domainEvent("pass_receive")]
  );
  const asset = assetWithSegments([textOnlyGoal, structuredConflict]);
  const results = searchAssets([asset], [indexRecord()], "goal shot", {
    queryPlan,
    domainFilters: queryPlan.domainFilters,
    queryVector: [1, 0]
  });
  const weakChecks = results[0]?.verification ?? [];
  const conflictChecks = buildVerificationChecks(asset, structuredConflict, queryPlan.domainFilters);

  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.segments.map((item) => item.id), ["text-only-goal"]);
  assert.equal(evaluateSegmentDomainFilters(asset, textOnlyGoal, queryPlan.domainFilters).trust, "weak");
  assert.equal(evaluateSegmentDomainFilters(asset, structuredConflict, queryPlan.domainFilters).accepted, false);
  assert.deepEqual(weakChecks.map((check) => check.status), ["soft_pass"]);
  assert.deepEqual(conflictChecks.map((check) => check.status), ["fail"]);
});

test("passer role searches reject moments where the named player is not the structured passer", () => {
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "asset_evidence",
    responseMode: "moment_retrieval",
      relatedKnowledgeMode: "none",
    rewrittenQuery: "player=Son Heung-min · role=passer · event=pass_receive",
    domainFilters: {
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: "passer"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: "passer"
    }
  };
  const sonReceiver = withDomainEvents(
    segment({
      id: "son-receiver",
      transcript: "Harry Kane passes into Son Heung-min.",
      embedding: [0, 1]
    }),
    [footballPassEvent({ passingPlayer: "Harry Kane", receivingPlayer: "Son Heung-min" })]
  );
  const sonPasser = withDomainEvents(
    segment({
      id: "son-passer",
      transcript: "Son Heung-min passes the ball to another player.",
      embedding: [0, 1]
    }),
    [footballPassEvent({ passingPlayer: "Son Heung-min", receivingPlayer: "Dejan Kulusevski" })]
  );
  const sonAliasPasser = withDomainEvents(
    segment({
      id: "son-alias-passer",
      transcript: "손흥민의 굉장한 패스가 이어지고요.",
      embedding: [0, 1]
    }),
    [footballPassEvent({ passingPlayer: "손흥민", receivingPlayer: "Unknown Receiver" })]
  );
  const unnamedPassEvent = footballPassEvent({ passingPlayer: "Unknown Player", receivingPlayer: "Unknown Receiver" });
  const unnamedPasser = withDomainEvents(
    segment({
      id: "unnamed-passer",
      transcript: "Son Heung-min is mentioned by commentary as an unnamed player passes to a teammate.",
      embedding: [0, 1]
    }),
    [
      {
        ...unnamedPassEvent,
        caption: "An unnamed player passes to a teammate.",
        football: {
          ...unnamedPassEvent.football!,
          passingPlayer: {
            ...unnamedPassEvent.football!.passingPlayer,
            identity: null
          },
          receivingPlayer: {
            ...unnamedPassEvent.football!.receivingPlayer,
            identity: null
          }
        }
      }
    ]
  );
  const asset = assetWithSegments([sonReceiver, unnamedPasser, sonPasser]);
  const results = searchAssets([asset], [indexRecord()], "손흥민이 다른선수한테 공을 패스해주는 영상 찾아줘", {
    queryPlan,
    domainFilters: queryPlan.domainFilters,
    queryVector: [1, 0]
  });
  const rejectedChecks = buildVerificationChecks(asset, sonReceiver, queryPlan.domainFilters);
  const unboundChecks = buildVerificationChecks(asset, unnamedPasser, queryPlan.domainFilters);
  const aliasChecks = buildVerificationChecks(asset, sonAliasPasser, queryPlan.domainFilters);

  assert.equal(evaluateSegmentDomainFilters(asset, sonReceiver, queryPlan.domainFilters).accepted, false);
  assert.equal(evaluateSegmentDomainFilters(asset, unnamedPasser, queryPlan.domainFilters).accepted, false);
  assert.equal(evaluateSegmentDomainFilters(asset, sonAliasPasser, queryPlan.domainFilters).accepted, true);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.segments.map((item) => item.id), ["son-passer"]);
  assert.equal(results[0]?.clips[0]?.player, "Son Heung-min");
  assert.equal(rejectedChecks.find((check) => check.constraint === "player")?.status, "fail");
  assert.equal(unboundChecks.find((check) => check.constraint === "player")?.status, "fail");
  assert.equal(aliasChecks.find((check) => check.constraint === "player")?.status, "pass");
});

test("heuristic football indexing binds segment-local pass source text to passer identity", () => {
  const source = segment({
    id: "son-cutback-source",
    transcript: "Son Heung-min cutback into the box.",
    embedding: [0, 1]
  });
  const domain = buildDomainSegmentIndex(assetWithSegments([source]), knowledgeIndexRecord(), source);
  const event = domain?.events[0];

  assert.equal(event?.eventType, "pass_receive");
  assert.equal(event?.football?.passType, "cutback");
  assert.equal(event?.football?.passingPlayer.identity?.name, "Son Heung-min");
  assert.equal(event?.football?.receivingPlayer.identity, null);
});

test("heuristic football indexing treats Korean local pass ownership as observed passer evidence", () => {
  const source = segment({
    id: "son-korean-pass-source",
    transcript: "손흥민의 굉장한 패스가 이어지고요.",
    embedding: [0, 1]
  });
  const domain = buildDomainSegmentIndex(assetWithSegments([source]), knowledgeIndexRecord(), source);
  const event = domain?.events[0];

  assert.equal(domain?.trust, "observed");
  assert.equal(event?.trust, "observed");
  assert.equal(event?.eventType, "pass_receive");
  assert.equal(event?.football?.passingPlayer.present, true);
  assert.equal(event?.football?.passingPlayer.identity?.name, "Son Heung-min");
  assert.equal(event?.football?.passingPlayer.identity?.source, "asr");
  assert.equal(event?.football?.receivingPlayer.identity, null);
});

test("heuristic football indexing does not bind asset-level pass text to a local player mention", () => {
  const source = segment({
    id: "son-mention-only",
    transcript: "Son!",
    embedding: [0, 1]
  });
  const asset = {
    ...assetWithSegments([source]),
    title: "Son Heung-Min Scoring STREAK Continues! 9 GOALS in 9 GAMES!",
    tags: ["soccer", "goal", "pass"]
  };
  const domain = buildDomainSegmentIndex(asset, knowledgeIndexRecord(), source);
  const event = domain?.events[0];

  assert.equal(event?.football?.passingPlayer.identity, null);
  assert.notEqual(event?.trust, "observed");
});

test("heuristic football indexing keeps local target wording out of passer identity", () => {
  const source = segment({
    id: "son-target-source",
    transcript: "Transition finds Son.",
    embedding: [0, 1]
  });
  const asset = {
    ...assetWithSegments([source]),
    tags: ["soccer", "pass"]
  };
  const domain = buildDomainSegmentIndex(asset, knowledgeIndexRecord(), source);
  const event = domain?.events[0];

  assert.equal(event?.football?.passingPlayer.identity, null);
  assert.equal(event?.football?.receivingPlayer.identity?.name, "Son Heung-min");
});

test("heuristic football indexing keeps receive text bound to receiver identity", () => {
  const source = segment({
    id: "son-receive-source",
    transcript: "Football moment: Son Heung-min receives in the box.",
    embedding: [0, 1]
  });
  const domain = buildDomainSegmentIndex(assetWithSegments([source]), knowledgeIndexRecord(), source);
  const event = domain?.events[0];

  assert.equal(event?.eventType, "pass_receive");
  assert.equal(event?.football?.receivingPlayer.identity?.name, "Son Heung-min");
  assert.equal(event?.football?.passingPlayer.identity, null);
});

test("VLM football refinement records named passers as action-source role evidence", () => {
  const source = segment({
    id: "vlm-son-passer",
    transcript: "Son Heung-min plays a pass to a teammate.",
    embedding: [0, 1]
  });
  const refined = mergeVlmResponse(
    assetWithSegments([source]),
    source,
    {
      domain: "sports.football",
      provider: "test-vlm",
      model: "test-model",
      caption: "Son Heung-min passes the ball to a teammate.",
      eventType: "scene",
      confidence: 0.92,
      labels: ["sports.football"],
      evidence: ["The frame and indexed text describe Son Heung-min making a pass."],
      football: {
        phase: "attack",
        fieldZone: "middle_third",
        passType: "short_pass",
        passingPlayer: {
          present: true,
          name: "Son Heung-min",
          confidence: 0.91,
          evidence: ["Indexed segment text names Son Heung-min as the passer."]
        },
        receivingPlayer: {
          present: true,
          name: null,
          confidence: 0.7,
          evidence: ["A teammate is the pass target."]
        },
        ballState: "pass_travel",
        attackingDirection: "unknown"
      }
    },
    "sports.football",
    "test-model"
  );
  const event = refined.domain?.events[0];

  assert.equal(event?.eventType, "pass_receive");
  assert.equal(event?.football?.passingPlayer.present, true);
  assert.equal(event?.football?.passingPlayer.identity?.name, "Son Heung-min");
  assert.equal(event?.football?.receivingPlayer.present, true);
  assert.equal(event?.football?.ball.state, "pass_travel");
  assert.match(refined.domain?.searchText ?? "", /passer=Son Heung-min/);
});

test("VLM football refinement preserves observed passer evidence when the VLM omits the role identity", () => {
  const source = segment({
    id: "vlm-son-korean-passer",
    transcript: "손흥민의 굉장한 패스가 이어지고요.",
    embedding: [0, 1]
  });
  const asset = assetWithSegments([source]);
  const domain = buildDomainSegmentIndex(asset, knowledgeIndexRecord(), source);
  const refined = mergeVlmResponse(
    asset,
    { ...source, domain },
    {
      domain: "sports.football",
      provider: "test-vlm",
      model: "test-model",
      caption: "손흥민의 굉장한 패스가 이어지고요",
      eventType: "pass_receive",
      confidence: 0.62,
      labels: ["sports.football"],
      evidence: ["손흥민의 굉장한 패스가 이어지고요"],
      football: {
        phase: "unknown",
        fieldZone: "middle_third",
        passType: "short_pass",
        passingPlayer: {
          present: false,
          name: null,
          confidence: 0.62,
          evidence: ["손흥민의 굉장한 패스가 이어지고요"]
        },
        receivingPlayer: {
          present: false,
          name: null,
          confidence: 0.62,
          evidence: ["손흥민의 굉장한 패스가 이어지고요"]
        },
        ballState: "pass_travel",
        attackingDirection: "unknown"
      }
    },
    "sports.football",
    "test-model"
  );
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "none",
    rewrittenQuery: "player=Son Heung-min · role=passer · event=pass_receive",
    domainFilters: {
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: "passer"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      player: "Son Heung-min",
      eventType: "pass_receive",
      role: "passer"
    }
  };
  const results = searchAssets([{ ...asset, timeline: [refined] }], [knowledgeIndexRecord()], "손흥민이 다른 선수한테 패스하는 영상 찾아줘", {
    queryPlan,
    domainFilters: queryPlan.domainFilters,
    queryVector: [1, 0]
  });
  const event = refined.domain?.events.find((item) => item.id.endsWith("-domain-vlm-1"));

  assert.equal(event?.football?.passingPlayer.present, true);
  assert.equal(event?.football?.passingPlayer.identity?.name, "Son Heung-min");
  assert.match(refined.domain?.searchText ?? "", /passer=Son Heung-min/);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.segments[0]?.id, "vlm-son-korean-passer");
  assert.equal(results[0]?.clips[0]?.player, "Son Heung-min");
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

test("search results expose summarized assets and stripped segment embeddings", () => {
  const queryPlan = queryPlanForBirthday();
  const sourceSegment = segment({
    id: "birthday",
    transcript: "Everyone sings happy birthday and celebrates together.",
    embedding: [1, 0]
  });
  const results = searchAssets([assetWithSegments([sourceSegment])], [indexRecord()], "생일 축하 장면 찾아줘", {
    queryPlan,
    queryVector: [1, 0]
  });
  const result = results[0];
  const assetPayload = result?.asset as Record<string, unknown> | undefined;

  assert.equal(results.length, 1);
  assert.equal(result?.asset.timelineCount, 1);
  assert.equal(assetPayload ? "timeline" in assetPayload : true, false);
  assert.equal(assetPayload ? "keyframes" in assetPayload : true, false);
  assert.deepEqual(result?.segments[0]?.embedding, []);
  assert.deepEqual(sourceSegment.embedding, [1, 0]);
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

test("extractive summaries are indexed as searchable moment text", () => {
  const queryPlan = queryPlanForBirthday();
  const summarizedSegment = segment({
    id: "summary-birthday",
    transcript: "People gather in a room.",
    summary: "A birthday celebration with a cake and candles.",
    embedding: [0, 1]
  });
  const results = searchAssets([assetWithSegments([summarizedSegment])], [indexRecord()], "생일 축하 장면 찾아줘", {
    queryPlan,
    queryVector: [1, 0]
  });

  assert.match(segmentSearchText(summarizedSegment), /birthday celebration/);
  assert.match(vectorRecordText(summarizedSegment), /cake and candles/);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.segments[0]?.id, "summary-birthday");
});

test("deterministic summaries are built from existing evidence before embedding", () => {
  const source = assetWithSegments([
    segment({
      id: "vlm-birthday",
      transcript: "The group reacts to the song.",
      vlm: birthdayVlmEvidence(),
      embedding: []
    }),
    withDomainEvents(
      segment({
        id: "structured-shot",
        transcript: "The crowd gets louder.",
        vision: sportsVisionEvidence(),
        embedding: []
      }),
      [domainEvent("shot")]
    )
  ]);
  const summarized = applyExtractiveVideoSummaries(source, knowledgeIndexRecord(), source.timeline);
  const birthday = summarized.timeline[0];
  const shot = summarized.timeline[1];

  assert.match(birthday?.summary ?? "", /birthday celebration|생일 서프라이즈/);
  assert.match(shot?.summary ?? "", /Structured shot event/);
  assert.match(summarized.summary, /Content summary:/);
  assert.match(summarized.summary, /Evidence coverage: 2 timeline segments/);
  assert.match(segmentToEmbeddingText(birthday!), /Summary: .*birthday/);
  assert.match(vectorRecordText(birthday!), /birthday/);
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

test("empty generic Korean answer does not expose domain-specific guidance", () => {
  const queryPlan = queryPlanForBirthday();
  const serverAnswer = buildAskVideoAnswerContent([], queryPlan).text;
  const clientFallback = buildSearchAssistantAnswer([], queryPlan);

  assert.match(serverAnswer, /검색 범위/);
  assert.doesNotMatch(serverAnswer, /선수|시즌|이벤트|evidence filter/);
  assert.equal(clientFallback, serverAnswer);
});

test("unsupported Korean answer does not expose domain-specific copy", () => {
  const serverAnswer = buildAskVideoAnswerContent([], {
    ...queryPlanForBirthday(),
    route: "unsupported"
  }).text;

  assert.match(serverAnswer, /asset evidence|related knowledge/);
  assert.doesNotMatch(serverAnswer, /sports|스포츠/);
});

test("empty related-knowledge Korean answer keeps constraint guidance", () => {
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "asset_evidence",
    responseMode: "moment_retrieval",
      relatedKnowledgeMode: "grounding",
    domainFilters: {
      player: "Son Heung-min"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      player: "Son Heung-min"
    }
  };

  assert.match(buildAskVideoAnswerContent([], queryPlan).text, /이벤트, 선수, 시즌/);
});

test("analysis answer follows planner mode instead of local style-word heuristics", () => {
  const queryPlan = queryPlanForPlayStyleAnalysis();
  const results = searchAssets(
    [
      assetWithSegments([
        segment({
          id: "son-finish",
          transcript: "Son gets in behind 1v1 and finishes into the far corner.",
          vlm: {
            ...birthdayVlmEvidence(),
            caption: "A soccer player in white dribbles the ball on a green field.",
            description: "The player is in motion and controls the ball before a finish.",
            labels: ["soccer", "attack"],
            actions: ["dribbling", "shooting"],
            objects: ["soccer ball", "green field"]
          },
          embedding: [1, 0]
        })
      ])
    ],
    [indexRecord()],
    "영상 기준 손흥민의 플레이 스타일을 분석해줘",
    {
      queryPlan,
      queryVector: [1, 0]
    }
  );
  const answerContent = buildAskAnalysisAnswerContent(results, queryPlan, buildOrchestrationPlan(queryPlan, [assetWithSegments([])], [indexRecord()]));

  assert.doesNotMatch(answerContent.text, /옷 스타일|clothing style|포멀|캐주얼/);
  assert.match(answerContent.text, /플레이 스타일|검색된 영상 기준/);
  assert.match(answerContent.text, /^요약:/);
  assert.match(answerContent.text, /\n패턴:/);
  assert.match(answerContent.text, /\n근거:/);
  assert.equal(answerContent.format, "sections");
  assert.deepEqual(answerContent.sections.slice(0, 3).map((section) => section.label), ["요약", "패턴", "근거"]);
});

test("sports direct answers use planner player and statMode instead of original query matching", () => {
  const queryPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    originalQuery: "이 기록 알려줘",
    route: "knowledge_evidence",
    responseMode: "structured_answer",
    relatedKnowledgeMode: "direct_answer",
    domainFilters: {
      competition: "Premier League",
      player: "Son Heung-min"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      questionType: "structured_answer",
      metric: "goals",
      statMode: "player_total",
      player: "Son Heung-min"
    }
  };
  const answer = answerSportsKnowledgeQuestion(queryPlan);

  assert.equal(answer.subject.player, "Son Heung-min");
  assert.notEqual(answer.status, "needs_clarification");
  assert.doesNotMatch(answer.answer, /identify the player/i);
});

test("sports leaderboard answers require planner statMode", () => {
  const withoutStatMode: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    originalQuery: "득점 1위 알려줘",
    route: "knowledge_evidence",
    responseMode: "structured_answer",
    relatedKnowledgeMode: "direct_answer",
    domainFilters: {
      competition: "Premier League"
    },
    intent: {
      ...queryPlanForBirthday().intent,
      domain: "sports.football",
      questionType: "structured_answer",
      metric: "goals"
    }
  };
  const withStatMode: DomainQueryPlan = {
    ...withoutStatMode,
    intent: {
      ...withoutStatMode.intent,
      statMode: "leaderboard"
    }
  };

  assert.equal(answerSportsKnowledgeQuestion(withoutStatMode).status, "needs_clarification");
  assert.notEqual(answerSportsKnowledgeQuestion(withStatMode).status, "needs_clarification");
});

test("generic orchestration does not expose related-knowledge identity or scope decisions", () => {
  const plan = buildOrchestrationPlan(queryPlanForBirthday(), [assetWithSegments([])], [indexRecord()]);

  assert.deepEqual(plan.decisions.map((decision) => decision.id), ["route"]);
  assert.doesNotMatch(JSON.stringify(plan), /No player requested|No competition\/season requested|sports knowledge/i);
});

test("orchestration uses identity and scope only when related knowledge is active in scope", () => {
  const sportsPlan: DomainQueryPlan = {
    ...queryPlanForBirthday(),
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "grounding",
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
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "none",
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
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "none",
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

function queryPlanForKoreanVisibleText(): DomainQueryPlan {
  return {
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "none",
    originalQuery: "미소라는 한글이 노출된 장면 찾아줘",
    rewrittenQuery: "Find a scene where the Korean text '미소' appears on screen.",
    semanticQuery: "Find a scene where the Korean text '미소' appears on screen.",
    retrieval: {
      textQuery: "미소 Korean text on screen OCR subtitle sign logo",
      visualQuery: "screen with Korean text '미소' visible",
      evidenceTerms: ["미소", "korean text", "on screen", "ocr", "subtitle", "sign", "logo", "miso"],
      requiredEvidence: [{ kind: "visible_text", terms: ["미소"], match: "all" }]
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

function queryPlanForSpokenThanks(): DomainQueryPlan {
  return {
    route: "asset_evidence",
    responseMode: "moment_retrieval",
    relatedKnowledgeMode: "none",
    originalQuery: "고마워 라고 말하는 장면 찾아줘",
    rewrittenQuery: "Find a scene where someone says thank you.",
    semanticQuery: "scene where someone says thank you",
    retrieval: {
      textQuery: "고마워 thank you spoken dialogue",
      visualQuery: "person speaking",
      evidenceTerms: ["고마워", "thank you", "saying thank you", "speaking"],
      requiredEvidence: [{ kind: "spoken_text", terms: ["고마워", "thank you"], match: "any" }]
    },
    confidence: 0.86,
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

function queryPlanForPlayStyleAnalysis(): DomainQueryPlan {
  return {
    route: "asset_evidence",
    responseMode: "analysis",
    relatedKnowledgeMode: "none",
    originalQuery: "영상 기준 손흥민의 플레이 스타일을 분석해줘",
    rewrittenQuery: "Analyze Son Heung-min's playing style from the selected video evidence.",
    semanticQuery: "Analyze Son Heung-min's playing style from the selected video evidence.",
    retrieval: {
      textQuery: "Son Heung-min playing style dribbling shooting runs positioning",
      visualQuery: "Son Heung-min in match footage dribbling shooting runs positioning",
      evidenceTerms: ["손흥민", "son heung-min", "son", "dribbling", "shooting", "runs", "positioning"]
    },
    confidence: 0.86,
    domainFilters: {},
    warnings: [],
    intent: {
      domain: null,
      questionType: "analysis",
      analysisSubject: "Son Heung-min",
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
  summary,
  embedding = [0, 1],
  vision,
  vlm,
  subtitles = [],
  screenText = [],
  overlays = []
}: {
  id: string;
  transcript: string;
  summary?: string;
  embedding?: number[];
  vision?: NonNullable<TimelineSegment["sceneData"]>["vision"];
  vlm?: NonNullable<TimelineSegment["sceneData"]>["vlm"];
  subtitles?: string[];
  screenText?: string[];
  overlays?: string[];
}): TimelineSegment {
  return {
    id,
    start: 0,
    end: 5,
    label: "Scene",
    transcript,
    summary,
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
        subtitles,
        screenText,
        overlays,
        watermarks: [],
        comparisons: []
      },
      ...(vision ? { vision } : {}),
      ...(vlm ? { vlm } : {})
    }
  };
}

function withDomainEvents(source: TimelineSegment, events: DomainEvent[]): TimelineSegment {
  return {
    ...source,
    sources: [...source.sources, "domain"],
    domain: {
      groups: ["sports.football"],
      captions: events.map((event) => event.caption),
      labels: events.flatMap((event) => event.labels),
      events,
      scope: {
        competition: null,
        season: null,
        teams: [],
        players: []
      },
      searchText: events.map((event) => [event.caption, ...event.labels].join(" ")).join(" "),
      confidence: 0.84,
      generatedBy: "test-domain-events",
      trust: "detected"
    }
  };
}

function domainEvent(eventType: string): DomainEvent {
  return {
    id: `event-${eventType}`,
    domain: "sports.football",
    ontologyVersion: "test",
    caption: `Structured ${eventType} event`,
    eventType,
    labels: [eventType],
    confidence: 0.84,
    trust: "detected",
    evidence: {
      asr: [],
      ocr: [],
      visual: [],
      metadata: [],
      heuristics: []
    }
  };
}

function footballPassEvent({ passingPlayer, receivingPlayer }: { passingPlayer: string; receivingPlayer: string }): DomainEvent {
  return {
    ...domainEvent("pass_receive"),
    caption: `${passingPlayer} passes to ${receivingPlayer}.`,
    labels: ["event.pass_receive", "pass.short_pass", "role.passer", "role.receiver"],
    football: {
      phase: "attack",
      fieldZone: "middle_third",
      passType: "short_pass",
      receivingPlayer: {
        present: true,
        confidence: 0.86,
        trackId: null,
        trackingStatus: "estimated",
        identity: {
          name: receivingPlayer,
          confidence: 0.9,
          source: "vlm",
          evidence: [`VLM identified receiver as ${receivingPlayer}.`]
        }
      },
      passingPlayer: {
        present: true,
        confidence: 0.88,
        trackId: null,
        trackingStatus: "estimated",
        identity: {
          name: passingPlayer,
          confidence: 0.91,
          source: "vlm",
          evidence: [`VLM identified passer as ${passingPlayer}.`]
        }
      },
      ball: {
        state: "pass_travel",
        confidence: 0.84,
        trackingStatus: "estimated"
      },
      field: {
        calibrationStatus: "estimated",
        attackingDirection: "unknown",
        zoneConfidence: 0.62
      },
      limitations: []
    }
  };
}

function birthdayVlmEvidence(): NonNullable<NonNullable<TimelineSegment["sceneData"]>["vlm"]> {
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
  const originalVlmWorkerUrl = process.env.VLM_WORKER_URL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.VLM_WORKER_URL;
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
    if (originalVlmWorkerUrl === undefined) delete process.env.VLM_WORKER_URL;
    else process.env.VLM_WORKER_URL = originalVlmWorkerUrl;
    globalThis.fetch = originalFetch;
  }
}

async function withMockedOpenAiFailureAndVlmPlanner<T>(plannerResponse: Record<string, unknown>, action: () => Promise<T>) {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalVlmWorkerUrl = process.env.VLM_WORKER_URL;
  const originalFetch = globalThis.fetch;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/plan/query") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ provider: "test-vlm", model: "test-vlm-model", ...plannerResponse }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test VLM server did not expose a TCP address.");
  process.env.OPENAI_API_KEY = "test-key";
  process.env.VLM_WORKER_URL = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "forced OpenAI planner failure" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
  try {
    return await action();
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalVlmWorkerUrl === undefined) delete process.env.VLM_WORKER_URL;
    else process.env.VLM_WORKER_URL = originalVlmWorkerUrl;
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function withoutConfiguredModelPlanners<T>(action: () => Promise<T>) {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalVlmWorkerUrl = process.env.VLM_WORKER_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VLM_WORKER_URL;
  try {
    return await action();
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalVlmWorkerUrl === undefined) delete process.env.VLM_WORKER_URL;
    else process.env.VLM_WORKER_URL = originalVlmWorkerUrl;
  }
}
