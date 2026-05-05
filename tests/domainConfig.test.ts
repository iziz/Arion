import assert from "node:assert/strict";
import test from "node:test";
import { defaultCapabilityPolicy, normalizeCapabilityPolicy } from "../server/domainConfig";

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
      "disabled"
    );
  });
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
