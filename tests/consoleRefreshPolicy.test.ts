import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_CONSOLE_REFRESH_INTERVAL_MS,
  getConsoleRefreshIntervalMs,
  isRefreshableActiveJob
} from "../src/hooks/useConsoleRefreshPolicy";

test("console refresh polling is enabled only while job state is active", () => {
  assert.equal(isRefreshableActiveJob({ status: "running" }), true);
  assert.equal(isRefreshableActiveJob({ status: "queued" }), true);
  assert.equal(isRefreshableActiveJob({ status: "succeeded" }), false);
  assert.equal(isRefreshableActiveJob({ status: "failed" }), false);
});

test("console refresh policy reconciles stale active UI without polling completed jobs", () => {
  assert.equal(getConsoleRefreshIntervalMs([{ status: "running" }]), ACTIVE_CONSOLE_REFRESH_INTERVAL_MS);
  assert.equal(getConsoleRefreshIntervalMs([{ status: "queued" }]), ACTIVE_CONSOLE_REFRESH_INTERVAL_MS);
  assert.equal(getConsoleRefreshIntervalMs([{ status: "succeeded" }]), null);
  assert.equal(getConsoleRefreshIntervalMs([]), null);
});
