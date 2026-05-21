import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider } from "../shared/types";

const rootDir = path.resolve(".data", "object-storage");

export type StoredObject = {
  provider: StorageProvider;
  bucket: string;
  objectKey: string;
  absolutePath: string;
  checksum: string;
  size: number;
};

export async function putUploadedObject(tempPath: string, originalName: string, assetId: string): Promise<StoredObject> {
  const provider = normalizeProvider(process.env.LOCAL_OBJECT_PROVIDER);
  const bucket = process.env.LOCAL_OBJECT_BUCKET || "video-assets";
  const extension = path.extname(originalName);
  const objectKey = `assets/${assetId}/source${extension}`;
  const absolutePath = path.join(rootDir, provider, bucket, objectKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await rename(tempPath, absolutePath);
  const info = await stat(absolutePath);
  return {
    provider,
    bucket,
    objectKey,
    absolutePath,
    checksum: await sha256File(absolutePath),
    size: info.size
  };
}

export async function putLocalFileObject(
  sourcePath: string,
  originalName: string,
  assetId: string,
  options: { checksum?: string } = {}
): Promise<StoredObject> {
  const provider = normalizeProvider(process.env.LOCAL_OBJECT_PROVIDER);
  const bucket = process.env.LOCAL_OBJECT_BUCKET || "video-assets";
  const extension = path.extname(originalName);
  const objectKey = `assets/${assetId}/source${extension}`;
  const absolutePath = path.join(rootDir, provider, bucket, objectKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await copyFile(sourcePath, absolutePath);
  const info = await stat(absolutePath);
  return {
    provider,
    bucket,
    objectKey,
    absolutePath,
    checksum: options.checksum ?? (await sha256File(absolutePath)),
    size: info.size
  };
}

export function checksumLocalFile(filePath: string) {
  return sha256File(filePath);
}

export function getObjectPath(provider: StorageProvider, bucket: string, objectKey: string) {
  return path.join(rootDir, provider, bucket, objectKey);
}

export function getPublicMediaRoot() {
  return rootDir;
}

export function getObjectStorageStatus() {
  return {
    storage: "local-object-storage",
    provider: normalizeProvider(process.env.LOCAL_OBJECT_PROVIDER),
    bucket: process.env.LOCAL_OBJECT_BUCKET || "video-assets",
    rootDir
  };
}

function normalizeProvider(value?: string): StorageProvider {
  if (value === "local-s3" || value === "local-r2") return value;
  return "local-s3";
}

function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
