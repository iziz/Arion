import type { Express, RequestHandler } from "express";
import { sendNotFound } from "../http/middleware";
import { getVideo, listVideos } from "../store";
import { analyzeAndEmit, createAssetFromUpload } from "../workflows/indexingWorkflow";

type UploadMiddleware = { single(fieldName: string): RequestHandler };

export function registerVideoRoutes(app: Express, upload: UploadMiddleware) {
  app.get("/api/videos", async (_req, res) => {
    res.json(await listVideos());
  });

  app.get("/api/videos/:id", async (req, res) => {
    const video = await getVideo(String(req.params.id));
    if (!video) return sendNotFound(res, "Video not found");
    res.json(video);
  });

  app.post("/api/videos", upload.single("video"), async (req, res) => {
    const result = await createAssetFromUpload(req, res, String(req.body.indexId || "default-index"));
    if (result) res.status(202).json(result);
  });

  app.post("/api/videos/:id/analyze", async (req, res) => {
    const video = await getVideo(String(req.params.id));
    if (!video) return sendNotFound(res, "Video not found");
    const result = await analyzeAndEmit(video, String(req.body.question ?? ""));
    res.json(result);
  });
}
