import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("coarse visual profile is presented as source preparation, not scene evidence", async () => {
  const component = await readFile(path.resolve("src", "components", "assets", "AssetComponents.tsx"), "utf8");
  const sourceGroup = groupBlock(component, "1. Source preparation");
  const sceneGroup = groupBlock(component, "3. Scene and vision evidence");

  assert.match(sourceGroup, /step\.id === "visual"/);
  assert.doesNotMatch(sceneGroup, /step\.id === "visual"/);
});

test("input source and probe metadata render distinct result panels", async () => {
  const component = await readFile(path.resolve("src", "components", "assets", "AssetComponents.tsx"), "utf8");
  const resultRouting = functionBlock(component, "function WorkflowResultContent");
  const inputResult = functionBlock(component, "function InputSourceResult");
  const probeResult = functionBlock(component, "function ProbeMetadataResult");

  assert.match(resultRouting, /stepId === "input"\) return <InputSourceResult/);
  assert.match(resultRouting, /stepId === "probe"\) return <ProbeMetadataResult/);
  assert.doesNotMatch(resultRouting, /stepId === "input" \|\| stepId === "probe"/);
  assert.match(inputResult, /Object key/);
  assert.match(inputResult, /Checksum/);
  assert.doesNotMatch(inputResult, /Frame rate/);
  assert.match(probeResult, /Frame rate/);
  assert.match(probeResult, /Video codec/);
  assert.doesNotMatch(probeResult, /Object key/);
});

test("detector and tracker are presented as domain evidence", async () => {
  const component = await readFile(path.resolve("src", "components", "assets", "AssetComponents.tsx"), "utf8");
  const sceneGroup = groupBlock(component, "3. Scene and vision evidence");
  const domainGroup = groupBlock(component, "4. Domain evidence");

  assert.doesNotMatch(sceneGroup, /step\.id === "detector"/);
  assert.doesNotMatch(sceneGroup, /step\.id === "tracker"/);
  assert.match(domainGroup, /step\.id === "detector"/);
  assert.match(domainGroup, /step\.id === "tracker"/);
});

function groupBlock(source: string, label: string) {
  const start = source.indexOf(`label: "${label}"`);
  assert.notEqual(start, -1, `Missing workflow group: ${label}`);
  const next = source.indexOf("},", source.indexOf("steps:", start));
  assert.notEqual(next, -1, `Missing workflow group end: ${label}`);
  return source.slice(start, next);
}

function functionBlock(source: string, signature: string) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Missing function: ${signature}`);
  const next = source.indexOf("\nfunction ", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}
