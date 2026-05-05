import assert from "node:assert/strict";
import test from "node:test";
import { shouldReplaceExistingRedisJob } from "../server/services/redisJobQueue";

test("replaces terminal Redis jobs before requeueing persistent queued jobs", () => {
  assert.equal(shouldReplaceExistingRedisJob("completed"), true);
  assert.equal(shouldReplaceExistingRedisJob("failed"), true);
});

test("keeps non-terminal Redis jobs in place", () => {
  assert.equal(shouldReplaceExistingRedisJob("waiting"), false);
  assert.equal(shouldReplaceExistingRedisJob("active"), false);
  assert.equal(shouldReplaceExistingRedisJob("delayed"), false);
});
