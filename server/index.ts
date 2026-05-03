import "./env";
import cors from "cors";
import express from "express";
import { mkdir } from "node:fs/promises";
import { getPublicMediaRoot } from "./localObjectStorage";
import { observabilityMiddleware } from "./observability";
import { legacyUploadDir, port, rateLimitExemptGetPaths, rateLimitPerMinute, uploadDir, uploadMaxBytes } from "./http/config";
import { createErrorHandler, createRateLimitMiddleware, optionalApiKeyAuth } from "./http/middleware";
import { createUploadMiddleware } from "./http/upload";
import { registerAnalysisRoutes } from "./routes/analysisRoutes";
import { registerAskRoutes } from "./routes/askRoutes";
import { registerAssetRoutes } from "./routes/assetRoutes";
import { registerIndexRoutes } from "./routes/indexRoutes";
import { registerJobRoutes } from "./routes/jobRoutes";
import { registerKnowledgeRoutes } from "./routes/knowledgeRoutes";
import { registerOrchestrationRoutes } from "./routes/orchestrationRoutes";
import { registerSystemRoutes } from "./routes/systemRoutes";
import { registerVectorRoutes } from "./routes/vectorRoutes";
import { registerVideoRoutes } from "./routes/videoRoutes";
import { registerWebhookRoutes } from "./routes/webhookRoutes";
import { recoverDetachedLocalJobs } from "./services/jobState";

const app = express();

await mkdir(uploadDir, { recursive: true });

const upload = createUploadMiddleware(uploadDir, uploadMaxBytes);
const rateLimit = createRateLimitMiddleware(rateLimitPerMinute, rateLimitExemptGetPaths);

app.use(cors());
app.use("/media", express.static(getPublicMediaRoot(), { maxAge: "1h" }));
app.use("/media", express.static(legacyUploadDir, { maxAge: "1h" }));
app.use(express.json({ limit: "2mb" }));
app.use(observabilityMiddleware);
app.use(rateLimit);
app.use(optionalApiKeyAuth);

registerSystemRoutes(app);
registerIndexRoutes(app);
registerAssetRoutes(app, upload);
registerJobRoutes(app);
registerAskRoutes(app);
registerKnowledgeRoutes(app);
registerOrchestrationRoutes(app);
registerVectorRoutes(app);
registerAnalysisRoutes(app);
registerWebhookRoutes(app);
registerVideoRoutes(app, upload);

app.use(createErrorHandler(uploadMaxBytes));

await recoverDetachedLocalJobs();

app.listen(port, () => {
  console.log(`Video intelligence API listening on http://localhost:${port}`);
});
