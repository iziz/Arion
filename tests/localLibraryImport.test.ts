import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isSupportedLocalLibraryMediaPath, previewLocalLibrary, scanLocalLibrary } from "../server/services/localLibraryImport";

test("local library scan recursively finds supported video files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arion-library-"));
  try {
    await mkdir(path.join(root, "nested"), { recursive: true });
    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await writeFile(path.join(root, "ABCD-123.mp4"), "video-one");
    await writeFile(path.join(root, "nested", "clip.MKV"), "video-two");
    await writeFile(path.join(root, "notes.txt"), "not-video");
    await writeFile(path.join(root, ".hidden", "hidden.mp4"), "hidden-video");

    const files = await scanLocalLibrary(root);

    assert.deepEqual(
      files.map((file) => path.relative(root, file.path)),
      ["ABCD-123.mp4", "nested/clip.MKV"]
    );
    assert.deepEqual(
      files.map((file) => file.title),
      ["ABCD-123", "clip"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local library scan supports a single media file path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arion-library-"));
  try {
    const filePath = path.join(root, "single.webm");
    await writeFile(filePath, "video");

    const files = await scanLocalLibrary(filePath);

    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, filePath);
    assert.equal(files[0]?.originalName, "single.webm");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local library scan honors the file limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arion-library-"));
  try {
    await writeFile(path.join(root, "one.mp4"), "one");
    await writeFile(path.join(root, "two.mp4"), "two");
    await writeFile(path.join(root, "three.mp4"), "three");

    const files = await scanLocalLibrary(root, 2);

    assert.equal(files.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local library preview exposes Rurugrab key candidates without requiring a metadata DB", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arion-library-"));
  const originalDbPath = process.env.RURUGRAB_METADATA_DB_PATH;
  try {
    process.env.RURUGRAB_METADATA_DB_PATH = path.join(root, "missing.sqlite3");
    await writeFile(path.join(root, "ABCD-123.mp4"), "video");

    const preview = await previewLocalLibrary(root, 1);

    assert.equal(preview.length, 1);
    assert.equal(preview[0]?.candidates[0]?.mediaDisplayKey, "ABCD-123");
    assert.equal(preview[0]?.metadata?.status, "unavailable");
  } finally {
    if (originalDbPath === undefined) {
      delete process.env.RURUGRAB_METADATA_DB_PATH;
    } else {
      process.env.RURUGRAB_METADATA_DB_PATH = originalDbPath;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("local library media path detection is extension based", () => {
  assert.equal(isSupportedLocalLibraryMediaPath("sample.MP4"), true);
  assert.equal(isSupportedLocalLibraryMediaPath("sample.mkv"), true);
  assert.equal(isSupportedLocalLibraryMediaPath("sample.ts"), false);
  assert.equal(isSupportedLocalLibraryMediaPath("sample.txt"), false);
});
