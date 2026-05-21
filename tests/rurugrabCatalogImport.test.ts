import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRurugrabRootMapping,
  resolveRurugrabCatalogPath,
  rurugrabCatalogMetadataProbe,
  rurugrabCatalogRowToMediaFile,
  type RurugrabCatalogRow
} from "../server/services/rurugrabCatalogImport";
import { extractRurugrabMediaKeyCandidatesForAsset } from "../server/metadata/rurugrab";

test("Rurugrab catalog root mappings convert Windows catalog paths to mounted local paths", () => {
  const mapping = parseRurugrabRootMapping("G:\\=/Volumes/AV/G");
  assert.equal(
    resolveRurugrabCatalogPath("G:\\Studio\\ABCD-123.mp4", [mapping]),
    "/Volumes/AV/G/Studio/ABCD-123.mp4"
  );
});

test("Rurugrab catalog rows become local library media files", () => {
  const row: RurugrabCatalogRow = {
    catalog_name: "AV8192-05.AV",
    root_path: "G:\\",
    rel_path: "Studio\\ABCD-123.mp4",
    full_path: "G:\\Studio\\ABCD-123.mp4",
    file_name: "ABCD-123.mp4",
    extension: "mp4",
    size: 1234
  };
  const file = rurugrabCatalogRowToMediaFile(row, [parseRurugrabRootMapping("G:\\=/Volumes/AV/G")]);
  assert.equal(file.catalogName, "AV8192-05.AV");
  assert.equal(file.originalName, "ABCD-123.mp4");
  assert.equal(file.title, "ABCD-123");
  assert.equal(file.path, "/Volumes/AV/G/Studio/ABCD-123.mp4");
  assert.equal(file.originalPath, "G:\\Studio\\ABCD-123.mp4");
  assert.equal(file.size, 1234);
});

test("Rurugrab catalog metadata probes prefer file codes over catalog root names", () => {
  const file = rurugrabCatalogRowToMediaFile(
    {
      catalog_name: "AV4096-01.AV",
      root_path: "AV4096-01.AV",
      rel_path: "GS/GS-395.mp4",
      full_path: "AV4096-01.AV\\GS/GS-395.mp4",
      file_name: "GS-395.mp4",
      extension: "mp4",
      size: 1234
    },
    []
  );
  const candidates = extractRurugrabMediaKeyCandidatesForAsset(rurugrabCatalogMetadataProbe(file));
  assert.deepEqual(candidates.map((candidate) => candidate.mediaDisplayKey), ["GS-395"]);
});
