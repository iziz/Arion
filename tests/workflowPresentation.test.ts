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
