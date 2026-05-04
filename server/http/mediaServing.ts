import express, { type Express } from "express";
import { getPublicMediaRoot } from "../localObjectStorage";
import { mediaServingMode, mediaStaticMaxAge } from "./config";

export function registerMediaServing(app: Express) {
  if (mediaServingMode === "disabled") {
    app.use("/media", (_req, res) => {
      res.status(404).json({
        error: "Local media serving is disabled. Serve media from the configured object storage or CDN boundary."
      });
    });
    return;
  }

  app.use(
    "/media",
    express.static(getPublicMediaRoot(), {
      fallthrough: false,
      maxAge: mediaStaticMaxAge
    })
  );
}
