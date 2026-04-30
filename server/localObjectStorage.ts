import { createHash } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
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
    checksum: createHash("sha256").update(`${provider}:${bucket}:${objectKey}:${info.size}`).digest("hex"),
    size: info.size
  };
}

export function getObjectPath(provider: StorageProvider, bucket: string, objectKey: string) {
  if (provider === "local") return path.resolve("uploads", objectKey);
  return path.join(rootDir, provider, bucket, objectKey);
}

export function getPublicMediaRoot() {
  return rootDir;
}

function normalizeProvider(value?: string): StorageProvider {
  if (value === "local-s3" || value === "local-r2") return value;
  return "local-s3";
}
