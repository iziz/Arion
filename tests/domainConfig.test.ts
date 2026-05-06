import assert from "node:assert/strict";
import test from "node:test";
import { defaultCapabilityPolicy, normalizeCapabilityPolicy } from "../server/domainConfig";
import { knowledgeTemplateDescriptors } from "../shared/knowledgeTemplates";

test("non-knowledge asset groups disable domain-specific capabilities", () => {
  const policy = normalizeCapabilityPolicy(
    {
      whisperXDiarization: "required",
      videoVlmAnalysis: "required",
      visionDetector: "required",
      visionTracker: "required",
      soccerNetActionSpotting: "required",
      knowledgeActionSpotting: "required",
      domainVlmRefinement: "required"
    },
    { enabled: false, groups: [], stages: [] }
  );

  assert.equal(policy.whisperXDiarization, "required");
  assert.equal(policy.videoVlmAnalysis, "required");
  assert.equal(policy.visionDetector, "disabled");
  assert.equal(policy.visionTracker, "disabled");
  assert.equal(policy.knowledgeActionSpotting, "disabled");
  assert.equal(policy.domainVlmRefinement, "disabled");
});

test("related knowledge defaults keep generic analysis optional and adapter action spotting scoped", () => {
  withDefaultCapabilityEnv(() => {
    assert.deepEqual(defaultCapabilityPolicy({ enabled: false, groups: [], stages: [] }), {
      whisperXDiarization: "optional",
      videoVlmAnalysis: "optional",
      visionDetector: "disabled",
      visionTracker: "disabled",
      knowledgeActionSpotting: "disabled",
      domainVlmRefinement: "disabled"
    });

    assert.equal(
      defaultCapabilityPolicy({
        enabled: true,
        groups: ["sports.american_football"],
        stages: ["domain_caption", "event_label", "structured_event"]
      }).knowledgeActionSpotting,
      "optional"
    );
  });
});

test("american football action spotting can be required when its adapter is selected", () => {
  const policy = normalizeCapabilityPolicy(
    {
      knowledgeActionSpotting: "required"
    },
    {
      enabled: true,
      groups: ["sports.american_football"],
      stages: ["domain_caption", "event_label", "structured_event"]
    }
  );

  assert.equal(policy.knowledgeActionSpotting, "required");
});

test("domain-specific knowledge templates expose manifest generator and evaluator contracts", () => {
  const template = knowledgeTemplateDescriptors["sports.american_football"];

  assert.ok(template);
  assert.equal(template.sourceId, "sports.american_football");
  assert.equal(template.manifest.id, "sports.american_football.manifest.v1");
  assert.equal(template.generator.kind, "inline-template-generator");
  assert.equal(template.generator.actionSpotting.alignment.requireProviderContext, true);
  assert.ok(template.manifest.skipConditions.some((condition) => condition.includes("nflverse game/play alignment is skipped")));
  assert.ok(template.evaluator.benchmarkCoverage.some((coverage) => coverage.name.includes("NFL Big Data Bowl")));
});

function withDefaultCapabilityEnv(run: () => void) {
  const keys = [
    "CAPABILITY_WHISPERX_DIARIZATION",
    "CAPABILITY_VIDEO_VLM_ANALYSIS",
    "CAPABILITY_VISION_DETECTOR",
    "CAPABILITY_VISION_TRACKER",
    "CAPABILITY_KNOWLEDGE_ACTION_SPOTTING",
    "CAPABILITY_SOCCERNET_ACTION_SPOTTING",
    "CAPABILITY_DOMAIN_VLM_REFINEMENT"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
