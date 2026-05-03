import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeUploadedText } from "../textEncoding";

export function createUploadMiddleware(uploadDir: string, uploadMaxBytes: number) {
  return multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, callback) => {
        const extension = path.extname(normalizeUploadedText(file.originalname));
        callback(null, `${randomUUID()}${extension}`);
      }
    }),
    limits: {
      fileSize: uploadMaxBytes
    }
  });
}
