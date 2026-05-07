# Arion Code Architecture

## Scope

This document describes the current Arion architecture from the checked-in code. It is based on static code inspection of the frontend, backend, shared types, workflows, storage adapters, and runtime adapters. It is not a runtime benchmark or deployment verification report.

Primary code references:

- `package.json`
- `vite.config.ts`
- `src/main.tsx`
- `src/App.tsx`
- `src/hooks/useConsoleData.ts`
- `src/hooks/useConsoleRefreshPolicy.ts`
- `src/hooks/useSearchController.ts`
- `src/api.ts`
- `shared/assetSummary.ts`
- `server/index.ts`
- `server/routes/*Routes.ts`
- `server/workflows/*`
- `server/store.ts`
- `server/postgres/*`
- `server/local*Store.ts`
- `server/localModelRuntime.ts`
- `server/localEmbeddingRuntime.ts`
- `server/localVisualEmbeddingRuntime.ts`
- `server/llmQueryPlanner.ts`
- `server/queryRetrievalPlan.ts`
- `server/intelligenceCore/evidence.ts`
- `server/domainIndex/*`
- `server/sceneDetection.ts`
- `server/modelRuntime/pythonRuntimeService.ts`
- `server/knowledgeAdapters.ts`
- `server/knowledge/adapters/sports/*`
- `server/services/redisJobQueue.ts`
- `server/services/askJobQueue.ts`
- `server/services/queueOutboxStore.ts`
- `server/services/queueOutboxPublisher.ts`
- `server/services/jobStageCheckpoint.ts`
- `server/services/realtimeEvents.ts`
- `server/jobWorker.ts`
- `server/askWorker.ts`
- `server/services/assetJobRunner.ts`
- `server/services/mediaLifecycle.ts`
- `server/observability.ts`
- `server/vlmWorkerClient.ts`
- `server/knowledge/*`
- `shared/knowledgeSources.ts`
- `shared/knowledgeTemplates.ts`
- `scripts/arion_model_runtime_service.py`
- `scripts/import_nflverse.ts`
- `scripts/build_american_football_action_spots.ts`
- `scripts/qwen_vlm_worker.py`
- `shared/types.ts`

Sports-domain indexing details are documented in [sports-domain-indexing.md](sports-domain-indexing.md).

## Operational Runtime Topology

This is the intended production-style boundary model after the durable queue and media boundary changes. Standard local development uses Docker Compose for Redis and PostgreSQL/pgvector; Vite and local filesystem-backed object storage are implementation choices behind the same boundaries.

```mermaid
flowchart TB
  Client["Client runtime\nReact + TypeScript"] --> Api["Express API process\n/api route layer"]
  Client --> MediaDelivery["Media delivery boundary\nobject storage / CDN / reverse proxy"]

  Api --> Services["TypeScript application services\nroutes, workflows, search, knowledge"]
  Services --> AppState["Application persistence\nPostgreSQL app_* tables + pgvector"]
  Services --> QueueOutbox["Transactional queue outbox\napp_queue_outbox"]
  QueueOutbox --> AskQueue["Redis + BullMQ\nask operation queue"]
  QueueOutbox --> AssetQueue["Redis + BullMQ\nasset job queue"]

  AskQueue --> AskWorker["Ask operation worker process\nserver/askWorker.ts"]
  AssetQueue --> AssetWorker["Asset job worker process\nserver/jobWorker.ts"]

  AskWorker --> AppState
  AssetWorker --> AppState
  AskWorker --> QueueOutbox
  AssetWorker --> QueueOutbox

  Services --> MediaStore["Media object storage\nsource files + generated artifacts"]
  AssetWorker --> MediaStore
  MediaDelivery --> MediaStore

  AskWorker --> RuntimeBoundary["Runtime/service boundary"]
  AssetWorker --> RuntimeBoundary
  Services --> RuntimeBoundary

  RuntimeBoundary --> PythonServices["Python runtime services\nASR, OCR, Vision, Embedding"]
  RuntimeBoundary --> VlmService["VLM service\nQwen/LLaVA-style video reasoning"]
  RuntimeBoundary --> NodeIntegrations["Node runtime integrations\nFFmpeg, OpenAI HTTP client"]

  Services --> Realtime["SSE event stream\n/api/events/stream"]
  AskWorker --> Realtime
  AssetWorker --> Realtime
  Realtime --> Client

  Services --> Observability["Observability sink\nOpenTelemetry, spans, NDJSON logs"]
  AskWorker --> Observability
  AssetWorker --> Observability
```

Operational boundary rules:

- Media binaries are not application persistence. Source videos, keyframes, OCR frames, extracted audio, and generated thumbnails belong to the media object-storage boundary.
- Application state belongs to the persistence boundary: metadata, jobs, ask operations, events, tracking records, and vector indexes.
- Express can serve `/media` only in local-static mode. In operational deployment, set `MEDIA_SERVING_MODE=disabled` and serve media through object storage, CDN, or a reverse proxy boundary.
- Asset indexing and ask execution are both queue-backed. The API process persists operation records and queue outbox entries; worker/API publishers dispatch IDs from the outbox to Redis/BullMQ; worker processes execute the long-running work.
- Asset indexing stores stage checkpoints in `JobRecord.stageCheckpoints`. Worker recovery preserves checkpoint state and resumes from the failed or interrupted stage when persisted stage outputs are reusable.
- Frontend progress and ask updates use `/api/events/stream` Server-Sent Events. Initial reads still use normal REST endpoints. The console also keeps a bounded interval refresh only while queued/running jobs exist so stale active state can recover if an SSE event is missed.
- Python runtime categories can run as one combined service or be split by `ASR_RUNTIME_SERVICE_URL`, `OCR_RUNTIME_SERVICE_URL`, `VISION_RUNTIME_SERVICE_URL`, and `EMBEDDING_RUNTIME_SERVICE_URL`. The VLM worker remains a separate HTTP boundary through `VLM_WORKER_URL`.

## Detailed Local Development Runtime Topology

```mermaid
flowchart TB
  subgraph ClientDev["Client runtime"]
    Browser["Browser runtime"] --> React["React + TypeScript console\nsrc/main.tsx -> src/App.tsx"]
  end

  subgraph WebDev["Vite dev server\nlocalhost:5173"]
    ViteAssets["Frontend assets + HMR"]
    ViteProxy["Dev proxy\n/api, /media -> localhost:8787"]
  end
  Browser --> ViteAssets
  React -->|"same-origin /api/* and /media/*"| ViteProxy

  subgraph ApiProcess["Express API process\nserver/index.ts - localhost:8787"]
    ViteProxy --> ExpressEntry["Express app"]
    ExpressEntry --> CommonHttp["HTTP middleware\ncors, observability, rate limit"]
    CommonHttp -->|"/media/*"| MediaBoundary["Local media serving boundary\n/media -> .data/object-storage\nMEDIA_SERVING_MODE=local-static"]
    MediaBoundary -->|"static hit"| ObjectStorage
    MediaBoundary -.->|"disabled or static miss"| MediaError["media 404/error\nno API route match"]
    CommonHttp -->|"/api/*"| ApiMiddleware["API middleware\nexpress.json, optional API key"]
    ApiMiddleware --> Routes["Express route modules\nserver/routes/*Routes.ts"]
  end

  Routes --> Services["TypeScript application services\nworkflows, job state, search/vector,\nknowledge, events/webhooks, direct store calls"]
  Services -->|"asset job dispatch"| RedisAssetQueue["Redis + BullMQ asset queue\nJobRecord id"]
  Services -->|"ask operation dispatch"| RedisAskQueue["Redis + BullMQ ask queue\nAskOperation id"]
  Services -->|"query-time embeddings,\nVLM health, OpenAI/VLM planning"| RuntimeBoundary["Runtime and external service boundary"]

  subgraph WorkerProcess["Asset job worker process\nserver/jobWorker.ts"]
    RedisAssetQueue --> AssetWorker["BullMQ Worker\nclaim queued JobRecord"]
    AssetWorker --> Runner["TypeScript asset job runner\nassetJobRunner + workflows"]
  end

  subgraph AskWorkerProcess["Ask operation worker process\nserver/askWorker.ts"]
    RedisAskQueue --> AskWorker["BullMQ Worker\nclaim queued AskOperation"]
    AskWorker --> AskRunner["TypeScript ask operation runner\nrunAskOperation"]
  end

  Runner -->|"asset indexing runtime"| RuntimeBoundary
  AskRunner -->|"query-time runtime"| RuntimeBoundary
  Services --> Persistence
  Services --> Observability
  Runner --> Persistence
  Runner --> Observability
  AskRunner --> Persistence
  AskRunner --> Observability
  CommonHttp --> Observability

  subgraph RuntimeLayer["Model and integration runtimes"]
    direction LR
    RuntimeBoundary --> RuntimeClient["TypeScript runtime service client\nserver/modelRuntime/pythonRuntimeService.ts"]
    RuntimeClient --> RuntimeServices["Python runtime service(s)\nASR, OCR, Vision, Embedding\nPYTHON_RUNTIME_SERVICE_URL or category URLs"]
    RuntimeServices --> RuntimeScripts["Python runtime scripts\nscripts/arion_model_runtime_service.py -> scripts/* adapters"]
    RuntimeBoundary --> VlmService["VLM service\nscripts/qwen_vlm_worker.py\nVLM_WORKER_URL"]
    RuntimeBoundary --> RuntimeIntegrations["Node runtime integrations\nFFmpeg child_process,\nOpenAI HTTP client"]
  end

  subgraph StorageAndTelemetry["Application state and telemetry sinks"]
    direction LR
    Persistence["Application persistence adapters\nmetadata, ask operations,\ntracking, vector stores"] --> PostgresPersistence["Docker PostgreSQL persistence\napp_* tables + pgvector"]
    ObjectStorage["Object-storage media files\n.data/object-storage"]
    Persistence -.->|diagnostic logs only| Observability["Observability sink\nOpenTelemetry SDK, local spans,\nlatency buckets, NDJSON logs"]
    Observability --> LogFiles["Observability log files\n.data/logs/app.ndjson"]
  end

  Services --> ObjectStorage
  Runner --> ObjectStorage

  Contracts["TypeScript shared type contracts\nshared/types.ts"]
  React -.-> Contracts
  Routes -.-> Contracts
  Services -.-> Contracts
```

## Repository Shape

| Area | Path | Responsibility |
| --- | --- | --- |
| Frontend entry | `src/main.tsx` | Mounts React `App` under `React.StrictMode`. |
| Frontend orchestration | `src/App.tsx` | Owns selected tab, selected asset/index/segment, dialogs, upload, retries, URL state, and passes props to `ConsoleLayout`. |
| Frontend API client | `src/api.ts` | Thin `fetch` wrapper with JSON parsing, type guards, and form payload helpers. |
| Frontend data refresh | `src/hooks/useConsoleData.ts` | Performs initial REST hydration, then refreshes operational data from `/api/events/stream` SSE notifications. |
| Frontend search state | `src/hooks/useSearchController.ts` | Posts `/api/ask`, waits on operation-scoped SSE updates, tracks query plan, orchestration plan, optional structured knowledge answer, and result conversation. |
| Frontend routing | `src/navigation.ts` | Converts console state to path/query URLs and parses URLs back into console state. |
| API entry | `server/index.ts` | Creates Express app, applies middleware, registers routes, persists operation records/outbox entries, exposes SSE, and starts listener. |
| Asset job worker | `server/jobWorker.ts` | Runs BullMQ worker process, recovers interrupted jobs, claims queued `JobRecord`s, and executes long-running asset workflows. |
| Ask operation worker | `server/askWorker.ts` | Runs BullMQ worker process, recovers interrupted ask operations, claims queued `AskOperation`s, and executes query/search workflows outside the API process. |
| Shared contract | `shared/types.ts` | Defines assets, indexes, jobs, timeline segments, local intelligence, ask responses, knowledge, tracking, events, metrics, webhooks, and billing records. |
| Workflow layer | `server/workflows/*` | Coordinates ingestion/indexing, ask/search, analysis, domain VLM refinement, and diarization retry jobs. |
| Storage adapter | `server/store.ts` | Requires PostgreSQL, delegates to `server/postgresStore.ts`, and fails fast when `DATABASE_URL` is unset. |
| Postgres adapter | `server/postgres/*` | Creates schema, repositories, vector repositories, status, defaults, and reset logic. |
| Legacy migration | `scripts/migrate_legacy_to_docker.ts` | One-time migration from earlier local JSON stores into Docker PostgreSQL and the Docker app-data volume. Referenced media is copied; orphan source-media directories are left in place unless the deletion option is used. |
| Video data purge | `scripts/purge_video_data.ts` | Clears asset groups, assets, jobs, ask state, video vectors, tracking records, media files, and Redis queues while preserving knowledge vectors and users. |
| Local runtime adapters | `server/localModelRuntime.ts`, `server/modelRuntime/*` | Coordinates FFmpeg, ASR, OCR, diarization, audio probing, visual sampling, and Python runtime service calls. |
| Embedding adapters | `server/localEmbeddingRuntime.ts`, `server/localVisualEmbeddingRuntime.ts` | Calls text and visual embedding runtimes and validates dimensions. |
| Python runtime service | `scripts/arion_model_runtime_service.py` | FastAPI boundary that exposes ASR, OCR, vision, and embedding runtime endpoints. |
| Python runtimes | `scripts/*.py` | Local model execution for ASR, OCR, scene/object detection, tracking, VLM worker, embeddings, imports, and maintenance. |

## Development Runtime

`package.json` defines the local development topology. The canonical npm command reference is [npm-scripts.md](npm-scripts.md).

- `npm run dev` runs `dev:infra` first, then starts `dev:api`, `dev:worker:run`, `dev:ask-worker:run`, and `dev:web` concurrently.
- `npm run dev:full` also starts the Python runtime service through `models:runtime:ai` and the Python VLM worker through `models:vlm:ai`.
- `dev:infra` runs `scripts/docker_infra.ts up`; it starts `redis` and `postgres` through Docker Compose and waits for Redis and PostgreSQL readiness.
- `dev:api` runs `ARION_DOCKER_INFRA=true tsx watch server/index.ts`.
- `dev:worker` starts `dev:infra` plus `dev:worker:run`; `dev:worker:run` runs `ARION_DOCKER_INFRA=true tsx watch server/jobWorker.ts`.
- `dev:ask-worker` starts `dev:infra` plus `dev:ask-worker:run`; `dev:ask-worker:run` runs `ARION_DOCKER_INFRA=true tsx watch server/askWorker.ts`.
- `dev:web` waits for `/api/health`, then runs `vite --host 0.0.0.0` through `dev:web:run`.
- `worker` and `ask-worker` also start `dev:infra` before running their non-watch worker entrypoints.
- `infra:up`, `infra:check`, `infra:logs`, and `infra:down` manage the Docker Redis/PostgreSQL infrastructure.
- `docker:up` runs the containerized web/API/worker stack with Redis and PostgreSQL.
- `docker:full` runs `docker:up` plus the Python runtime and VLM services.
- The API default port is `8787`.
- The Vite default port is `5173`.
- The combined local Python runtime service default port is `8792`.
- Redis is required for asset job execution and ask operation execution. Docker Compose owns Redis in the standard runtime, and worker entrypoints wait for Redis readiness before creating BullMQ workers. `REDIS_URL` defaults to `redis://127.0.0.1:16379` for Docker-backed host development and `redis://redis:6379` inside Docker app services.
- PostgreSQL/pgvector is the standard application persistence backend in Docker development and operations. `ARION_DOCKER_INFRA=true` pins host development to the Docker PostgreSQL URL so an unrelated local Postgres cannot be used accidentally.

`vite.config.ts` proxies frontend development requests:

- `/api` -> `http://localhost:8787`
- `/media` -> `http://localhost:8787`

This means frontend code uses same-origin paths such as `/api/assets` and `/media/...`; the dev server forwards them to Express.
The detailed local topology shows this Vite proxy because it is part of the development runtime. In a production deployment, the static frontend host or reverse proxy can replace this node while Express owns only the `/api` route layer. Local `/media` serving should be disabled in that topology with `MEDIA_SERVING_MODE=disabled`.

## Docker Runtime

Docker Compose is the standard infrastructure and operational packaging boundary.

| Service | Image/build | Runtime responsibility |
| --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg17` | Durable application persistence and pgvector indexes. |
| `redis` | `redis:7.4-alpine` | BullMQ execution queues for asset jobs and ask operations. |
| `api` | `Dockerfile.node` | Express API process, route handling, queue outbox writes, SSE fanout, and optional local `/media` serving. |
| `asset-worker` | `Dockerfile.node` | BullMQ asset job worker and long-running indexing workflows. |
| `ask-worker` | `Dockerfile.node` | BullMQ ask operation worker and query/search workflows. |
| `web` | `Dockerfile.web` | Nginx-served React build with reverse proxying for `/api` and `/media`. |
| `model-runtime` | `Dockerfile.python` | FastAPI Python runtime service for ASR, OCR, vision, and embedding endpoints. |
| `vlm` | `Dockerfile.python` | FastAPI VLM service for Qwen/LLaVA-style video reasoning. |

Compose profiles:

- Default profile: infrastructure only, `redis` and `postgres`.
- `app`: web, API, asset worker, ask worker, Redis, and PostgreSQL.
- `ai`: Python runtime and VLM services. Use with `app` for a fully containerized AI runtime.

Shared Docker volumes:

- `postgres-data`: PostgreSQL cluster data.
- `redis-data`: Redis append-only data.
- `app-data`: application `.data` boundary, including local object storage, logs, and generated artifacts.
- `uploads`: upload temp files.

## Frontend Architecture

### Entry And Top-Level State

`src/main.tsx` mounts `App`. `src/App.tsx` is the top-level application coordinator. It does not render most page details directly; instead it gathers state and handlers and passes them into `ConsoleLayout`.

Top-level state includes:

- selected index, asset, segment, and job
- current console tab: `data`, `knowledge`, `search`, or `system`
- asset detail tab: `overview`, `workflow`, or `timeline`
- selected related-knowledge domain
- dialog state for asset group and upload forms
- busy/message state
- pending video seek state
- route synchronization state

### URL State

`src/navigation.ts` maps application state to readable URLs:

- `/system`
- `/search`
- `/knowledge`
- `/knowledge/:domainGroup`
- `/assets/:indexId`
- `/asset/:assetId`
- `/asset/:assetId/:assetDetailTab`

When a selected segment or seek time exists, it is encoded as query parameters:

- `segment`
- `t`
- `assetTab`

`App` listens to `popstate`, parses the URL, and updates selected tab/index/asset/segment/seek state.

### Data Refresh

`useConsoleData` is the main data hydration hook. It performs an initial REST read in two batches:

1. Core operational data:
   - `GET /api/indexes`
   - `GET /api/assets/summary`
   - `GET /api/jobs`
   - `GET /api/events?limit=20`
2. System and knowledge data:
   - `GET /api/metrics`
   - `GET /api/db/status`
   - `GET /api/observability`
   - `GET /api/knowledge/summary` with legacy `/api/knowledge/sports/summary` fallback
   - `GET /api/knowledge/vector-store` with legacy `/api/knowledge/sports/vector-store` fallback

After initial hydration, it opens `GET /api/events/stream`. The hook schedules a short debounced REST refresh when it receives `asset.updated`, `asset.deleted`, `index.deleted`, `job.updated`, `event.recorded`, `outbox.updated`, or `ask.operation.updated`. A second refresh guard uses `getConsoleRefreshIntervalMs(jobs)` and runs only while the job list contains active work.

The asset list is summary-only. `App` loads the selected asset's full `AssetRecord` lazily through `GET /api/assets/:id`, keyed by `selectedAssetId` and the selected summary's `updatedAt`.

The hook uses `Promise.allSettled` and per-payload type guards. Partial failures are surfaced as refresh warnings instead of discarding all successful data.

### Search Controller

`useSearchController` owns the interactive ask/search state:

- query text
- search scope mode: all, group, or asset
- selected search index and asset
- knowledge layer toggle
- current `AskResponse`
- query plan and orchestration plan
- optional `StructuredKnowledgeAnswer`
- raw and trust-filtered results
- local conversation history in `localStorage`

The main search flow is:

```mermaid
sequenceDiagram
  participant UI as Search UI
  participant Hook as useSearchController
  participant Client as src/api.ts fetch
  participant API as askRoutes
  participant Ask as Ask operation store
  participant Outbox as Queue outbox
  participant Queue as Redis/BullMQ ask queue
  participant SSE as /api/events/stream
  participant Worker as askWorker

  UI->>Hook: submit query
  Hook->>Client: api.post("/api/ask")
  Client->>API: POST /api/ask via same-origin path; Vite proxy in dev
  API->>Ask: ensure store, prune, create, persist queued operation
  API->>Outbox: persist ask-operation outbox entry
  Outbox->>Queue: publish AskOperation id
  API-->>Client: 202 AskResponse with operation id
  Client-->>Hook: started AskResponse
  Hook->>SSE: open operation-scoped EventSource
  Queue->>Worker: BullMQ worker receives AskOperation id
  Worker->>Ask: load persisted request and operation state
  Note over Worker,SSE: Worker updates operation steps, status, and final response; operationStore emits ask.operation.updated events.
  Ask-->>SSE: ask.operation.updated
  SSE-->>Hook: current AskResponse payload
  Hook->>Hook: update plan, orchestration, answer, results
```

The client performs one immediate `GET /api/ask/:id` read to cover races, then waits for operation-scoped SSE updates and times out after 48 seconds. The SSE route emits the current operation snapshot once on connect when `operationId` is provided. Heartbeats are SSE comments only and do not resend the full ask response.

### Upload And Reindex Controls

`App.uploadAsset` submits multipart form data to:

- `POST /api/indexes/:id/assets`

The response is validated with `isAssetUploadPayload`. The returned asset and job are inserted optimistically into frontend state, and a refresh follows.

Retry actions call:

- `POST /api/jobs/:id/retry`
- `POST /api/assets/:id/reindex`
- `POST /api/assets/:id/domain-vlm/refine`
- `POST /api/indexes/:id/domain-vlm/refine`

### UI Composition

`ConsoleLayout` receives all state and renders the four console sections:

- `system`: metrics, jobs, events, DB status, observability.
- `data`: asset groups, uploaded assets, asset details, video player, timeline, workflow.
- `search`: ask form, search scope, workflow trace, optional knowledge answer, results, clip detail.
- `knowledge`: related knowledge registry and vector store status.

Most specialized UI is split under:

- `src/components/assets/AssetComponents.tsx`
- `src/components/SearchPanels.tsx`
- `src/components/evidence/EvidenceComponents.tsx`
- `src/components/knowledge/KnowledgePanel.tsx`
- `src/components/common/ConsolePrimitives.tsx`

## Backend Boot Sequence

`server/index.ts` performs this sequence:

1. Loads `.env` through `server/env.ts`.
2. Creates the Express app.
3. Ensures `.data/tmp-uploads` exists.
4. Cleans stale files from `.data/tmp-uploads` using `UPLOAD_TEMP_MAX_AGE_MS`.
5. Creates the Multer upload middleware with the configured max upload size.
6. Creates the in-memory rate limiter.
7. Applies middleware in order:
   - `cors()`
   - `observabilityMiddleware`
   - rate limit middleware
   - local `/media` serving boundary from `.data/object-storage` when `MEDIA_SERVING_MODE=local-static`
   - `express.json({ limit: "2mb" })`
   - optional API key auth
8. Registers route groups:
   - system
   - index
   - asset
   - job
   - ask
   - knowledge
   - orchestration
   - vector
   - analysis
   - webhook
   - video compatibility aliases
9. Installs the error handler.
10. Starts listening on `PORT` or `8787`.

The API process does not execute long-running asset jobs. It persists `JobRecord`s with queue outbox entries and may attempt immediate outbox publication.
The API process also does not execute ask operations. It persists `AskOperation` records with queue outbox entries and may attempt immediate outbox publication.

## Worker Boot Sequence

`server/jobWorker.ts` performs this sequence:

1. Loads `.env` through `server/env.ts`.
2. Resolves `JOB_WORKER_ID` and `JOB_QUEUE_RECONCILE_MS`.
3. Waits for Redis readiness before creating any BullMQ worker connection.
4. Runs `recoverDurableWorkerJobs` before creating the BullMQ worker.
5. During recovery, cleans stale runtime processes for queued/running asset jobs.
6. Resets interrupted `running` jobs back to `queued` while preserving `stageCheckpoints` and setting `parameters.resumeFromStage`.
7. Publishes pending `asset-job` queue outbox entries.
8. Reconciles queued supported asset jobs into Redis through `enqueueQueuedAssetJobs` as a compatibility repair path.
9. Creates a Redis/BullMQ worker using `REDIS_URL`, `JOB_QUEUE_NAME`, and `JOB_WORKER_CONCURRENCY`.
10. Claims queued `JobRecord`s before execution.
11. Runs the matching workflow through `assetJobRunner`.
12. Periodically publishes queue outbox entries and reconciles queued jobs using `JOB_QUEUE_RECONCILE_MS`.

## Ask Worker Boot Sequence

`server/askWorker.ts` performs this sequence:

1. Loads `.env` through `server/env.ts`.
2. Resolves `ASK_WORKER_ID`, `ASK_QUEUE_NAME`, `ASK_WORKER_CONCURRENCY`, and `ASK_QUEUE_RECONCILE_MS`.
3. Waits for Redis readiness before creating any BullMQ worker connection.
4. Resets interrupted `running` ask operations back to `queued`.
5. Publishes pending `ask-operation` queue outbox entries.
6. Reconciles queued ask operations into Redis/BullMQ as a compatibility repair path.
7. Creates a Redis/BullMQ worker.
8. Claims queued `AskOperation` records by operation ID.
9. Runs `runAskOperation` from the persisted request stored with the operation.
10. Periodically publishes queue outbox entries and reconciles queued ask operations into Redis.

## HTTP Middleware

| Middleware | File | Behavior |
| --- | --- | --- |
| CORS | `server/index.ts` | Enables cross-origin requests for local API use. |
| Observability | `server/observability.ts` | Adds request ID, traceparent, local spans, request metrics, and JSON logs. It runs before both local media serving and API routes. |
| Rate limiting | `server/http/middleware.ts` | Per-IP in-memory count with configurable requests per minute. Health/status GET endpoints and the SSE stream are exempt. It runs before local media serving and API routes. |
| Static media | `server/http/mediaServing.ts` | Serves generated and stored media from `/media` only when `MEDIA_SERVING_MODE=local-static`. It is mounted only on the `/media` prefix, so `/api/*` requests skip it. A matching static file response does not enter the API route layer. Operational deployments can set `MEDIA_SERVING_MODE=disabled` and serve media outside the API process. |
| JSON body | `server/index.ts` | Limits JSON body payloads to `2mb`. |
| Optional API key | `server/http/middleware.ts` | If `API_KEYS` is unset, API is open. If set, request must match configured keys or local users by `x-api-key`. |
| Error handler | `server/http/middleware.ts` | Returns JSON errors. Multer file size errors become HTTP 413. |

## API Surface

| Group | Endpoints | File | Main collaborators |
| --- | --- | --- | --- |
| System | `GET /api/health`, `/api/metrics`, `/api/db/status`, `/api/storage/status`, `/api/observability`, `/api/model-capabilities`, `/api/users`, `/api/billing`, `/api/events`, `/api/events/stream` | `server/routes/systemRoutes.ts` | `store`, `postgresStore`, `localObjectStorage`, `observability`, `modelCapabilities`, `realtimeEvents` |
| Indexes | `GET /api/indexes`, `POST /api/indexes`, `GET /api/indexes/:id`, `DELETE /api/indexes/:id`, `PATCH /api/indexes/:id` | `server/routes/indexRoutes.ts` | `store`, `domainConfig`, `localEmbeddingRuntime`, `events`, `mediaLifecycle` |
| Assets | `GET /api/assets`, `GET /api/assets/summary`, `GET /api/assets/:id`, `DELETE /api/assets/:id`, `POST /api/assets`, `POST /api/indexes/:id/assets`, clip endpoints, tracking endpoints, `POST /api/indexes/:id/analyze`, reindex/domain refinement endpoints | `server/routes/assetRoutes.ts` | `indexingWorkflow`, `jobState`, `intelligence`, `trackingStore`, `events`, `mediaLifecycle` |
| Jobs | `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/retry` | `server/routes/jobRoutes.ts` | `store`, `jobState`, `redisJobQueue` |
| Ask/search | `POST /api/ask`, `GET /api/ask/:id`, `GET /api/search`, `GET /api/search/plan`, `GET /api/knowledge/answer`, `GET /api/models/vlm/health` | `server/routes/askRoutes.ts` | `askWorkflow`, `askJobQueue`, `llmQueryPlanner`, `statMomentSeed`, structured knowledge answer dispatcher, `vlmWorkerClient` |
| Knowledge | generic `/api/knowledge/*` plus legacy `/api/knowledge/sports/*` aliases for snapshot, summary, vector status/rebuild/search, provider imports, player CRUD | `server/routes/knowledgeRoutes.ts` | `knowledge/registry`, provider importers, `localKnowledgeVectorStore`, `localEmbeddingRuntime` |
| Vectors | `GET /api/vector-search`, `GET /api/visual-search`, `POST /api/vector-store/rebuild` | `server/routes/vectorRoutes.ts` | `localEmbeddingRuntime`, `localVisualEmbeddingRuntime`, vector stores, `vectorMaintenance` |
| Orchestration | `GET /api/orchestrate/plan` | `server/routes/orchestrationRoutes.ts` | `orchestrator`, query planning, asset scoping |
| Analysis | `POST /api/analyze`, `POST /api/assets/:id/analyze`, plus `POST /api/indexes/:id/analyze` in asset routes | `server/routes/analysisRoutes.ts`, `server/routes/assetRoutes.ts` | `analysisWorkflow`, `intelligence` |
| Webhooks | `GET /api/webhooks`, `POST /api/webhooks`, `POST /api/webhooks/:id/test`, `POST /api/webhooks/:id/retry` | `server/routes/webhookRoutes.ts` | `store`, `events` |
| Video aliases | `GET /api/videos`, `GET /api/videos/:id`, `POST /api/videos`, `POST /api/videos/:id/analyze` | `server/routes/videoRoutes.ts` | asset storage and analysis compatibility wrappers |

## Shared Domain Model

`shared/types.ts` is the contract between frontend and backend.

### IndexRecord

An index is the asset group. It contains:

- model names for search, analysis, and embedding
- enabled modalities
- optional domain indexing config
- optional capability policy
- associated asset IDs
- status and timestamps

### AssetRecord

An asset is an uploaded media item. It contains:

- media identity and storage metadata
- ingest/indexing status and progress
- duration, dimensions, codec metadata
- tags and summary
- timeline segments
- keyframes
- local intelligence output
- error and timestamps

`AssetSummaryRecord` is the bounded list-view DTO used by the frontend console and realtime asset updates. It omits `timeline`, `keyframes`, `technicalMetadata`, and `intelligence`, while keeping counts and status fields needed for lists and side navigation.

### TimelineSegment

A timeline segment is the primary retrieval unit. It contains:

- time range
- label and transcript
- scene data:
  - image summary
  - speech/subtitle/screen text evidence
  - optional VLM evidence
  - optional vision evidence
- optional domain evidence:
  - domain groups
  - captions and labels
  - structured events
  - scope values
  - search text
  - confidence and trust
- retrieval metadata:
  - tags
  - modalities
  - embedding vector
  - thumbnail path
  - evidence sources
  - scene boundary metadata

### LocalIntelligence

`LocalIntelligence` stores model/runtime outputs attached to an asset:

- audio extraction and VAD speech/music regions
- Whisper ASR transcript, language, confidence, segments
- WhisperX speaker diarization
- PaddleOCR tokens and frames
- visual sampler labels, color, brightness, and motion score
- model trace strings

### JobRecord

Jobs track async work:

- type: `asset.index`, `asset.reindex`, `asset.domain-vlm.refine`, or `webhook.test`
- status: queued, running, succeeded, failed
- stage and progress
- optional parameters for retry, resume, rebuild, and invalidation state
- optional asset/index IDs
- per-runtime stage records
- per-indexing-stage checkpoints
- logs, error, and timestamps

### AskOperation And AskResponse

Ask operations are server-side async operation records. They are kept in an in-memory map while the API process is running and persisted through the ask operation store. The response shape includes:

- operation status and step trace
- operation route: pending, structured answer, moment retrieval, empty, or error
- answer
- query plan, including domain-agnostic route, response mode, and knowledge mode
- orchestration plan
- optional structured knowledge answer payload, currently represented by `StructuredKnowledgeAnswer`
- search results
- warnings

### SearchResult

Search results bundle:

- asset summary, not the full asset record
- matching index
- selected timeline segments with embedding vectors stripped from the response payload
- generated clips
- ranking scores
- explanation strings
- query plan
- knowledge evidence
- match reasons
- verification checks

`searchAssets` still ranks against full in-memory `AssetRecord` objects on the server. Only the returned `SearchResult` is converted into a payload-safe DTO so ask/search responses and browser search history do not retain full timelines or vector arrays.

### Knowledge And Tracking

Related knowledge currently includes competitions, teams, players, match activities, and facts from the sports adapter. Tracking records are derived from timeline vision evidence and connect ball/player/link track IDs to segment ranges.

## Ingestion And Indexing

### Upload Flow

```mermaid
sequenceDiagram
  participant FE as React App
  participant HTTP as Same-origin HTTP path
  participant API as assetRoutes
  participant Upload as Multer
  participant Storage as localObjectStorage
  participant Jobs as jobState
  participant Events as events service
  participant Store as Store Adapter
  participant Outbox as Queue Outbox
  participant Queue as Redis/BullMQ Queue
  participant Worker as jobWorker
  participant Job as Indexing Workflow

  FE->>HTTP: fetch POST /api/indexes/:id/assets multipart
  HTTP->>API: route request; Vite proxy forwards in dev
  API->>Upload: upload.single("video") route middleware
  Upload-->>API: req.file and req.body
  API->>Storage: putUploadedObject(tempPath, originalName, generated asset id)
  API->>Store: saveVideo queued AssetRecord
  API->>Jobs: createQueuedAssetJob("asset.index")
  Jobs->>Store: save queued JobRecord
  Jobs->>Outbox: create asset-job outbox entry
  API->>Events: recordEvent("asset.uploaded")
  Events->>Store: saveEvent
  API->>Outbox: publish pending asset-job entries
  Outbox->>Queue: enqueue Redis asset job by JobRecord id
  API-->>HTTP: 202 { asset, job }
  HTTP-->>FE: 202 { asset, job }
  Queue->>Worker: BullMQ worker receives job id
  Worker->>Jobs: claim queued JobRecord
  Worker->>Job: runIndexingJob(jobId, assetId, storedPath)
```

`createAssetFromUpload` creates the asset with `status: "queued"` and `progress: 5`, stores the source media, creates an `asset.index` job with a queue outbox entry, and records an event. The route attempts immediate outbox publication, and `server/jobWorker.ts` continues outbox publishing and executes the indexing workflow.

### Redis Backed Asset Job Queue

Asset job durability is split between persisted job records and Redis execution dispatch:

- `JobRecord` is persisted through `store.ts` into PostgreSQL.
- `JobRecord.parameters` stores replay-critical parameters such as the normalized retry stage.
- `server/services/queueOutboxStore.ts` stores Redis dispatch requests before publication.
- `createQueuedAssetJob` writes the `JobRecord` and `app_queue_outbox` entry in one PostgreSQL transaction through `saveJobWithQueueOutbox`.
- `server/services/queueOutboxPublisher.ts` publishes pending outbox entries to Redis/BullMQ by `JobRecord.id`.
- `server/services/redisJobQueue.ts` remains the BullMQ adapter used by the outbox publisher and worker reconciliation.
- `server/jobWorker.ts` owns long-running job execution outside the Express API process.
- `server/services/assetJobRunner.ts` maps persisted asset job type and parameters back to executable workflow functions.
- On worker boot, `recoverDurableWorkerJobs` cleans stale runtime processes, preserves checkpoint state, marks interrupted running jobs queued, and records `parameters.resumeFromStage`.
- Worker startup and worker intervals publish pending queue outbox entries. Legacy queued-job reconciliation remains as a compatibility repair path.
- A recovered indexing job resumes from the failed or interrupted checkpoint when the stage output is already persisted and reusable.

### Indexing Pipeline

`runIndexingJob` is the core indexing workflow:

```mermaid
flowchart TD
  Start["runIndexingJob\nasset.index or asset.reindex"] --> Probe["Probe media\nffprobe"]
  Probe --> Runtime["Local model runtime\nFFmpeg audio/VAD\nASR service\nOCR service\nvisual sampler"]
  Runtime --> Scene["Scene detection\nFFmpeg default\nPySceneDetect opt-in"]
  Scene --> Timeline["Build local timeline\ntext, OCR, visual, scene data"]
  Timeline --> Keyframes["Generate keyframes\nFFmpeg"]
  Keyframes --> Snapshot["Persist timeline/keyframe snapshot"]
  Snapshot --> VideoVlm{"videoVlmAnalysis enabled?"}
  VideoVlm -->|no| VisionDetect
  VideoVlm -->|yes| VideoVlmWorker{"VLM_WORKER_URL configured?"}
  VideoVlmWorker -->|yes| VideoVlmRun["Analyze timeline keyframes\nVLM worker"]
  VideoVlmWorker -->|no and optional| VisionDetect
  VideoVlmWorker -->|no and required| Failure["Fail job\nRequiredCapabilityUnavailableError"]
  VideoVlmRun --> VisionDetect["Detect objects if visionDetector enabled\napply detections"]
  VisionDetect -.->|required unavailable| Failure
  VisionDetect --> VisionHeuristic["Apply local vision tracking heuristics"]
  VisionHeuristic --> VisionTracks["Detect tracks if visionTracker enabled\napply tracks"]
  VisionTracks -.->|required unavailable| Failure
  VisionTracks --> Classify["Apply event classification"]
  Classify --> KnowledgeAction{"knowledgeActionSpotting enabled\nand selected source supports it?"}
  KnowledgeAction -->|yes| KnowledgeActionRun["Domain template action source\nsports.football -> SoccerNet external source\nsports.american_football -> inline NFL generator or explicit override"]
  KnowledgeActionRun -.->|required unavailable| Failure
  KnowledgeAction -->|no| DomainIndex
  KnowledgeActionRun --> DomainIndex{"domainIndexing enabled?"}
  DomainIndex -->|yes| Domain["Domain timeline enrichment\nrelated knowledge events and scope"]
  DomainIndex -->|no| TextEmbed
  Domain --> DomainVlm{"domainVlmRefinement enabled?"}
  DomainVlm -->|no| SportsIdentity["Sports identity resolver\nmatch/game context, clock mappings,\nroster windows, trackId/playerId candidates"]
  DomainVlm -->|yes| DomainVlmWorker{"VLM_WORKER_URL configured?"}
  DomainVlmWorker -->|yes| DomainVlmRun["Refine related knowledge events\nVLM worker"]
  DomainVlmWorker -->|no and optional| SportsIdentity
  DomainVlmWorker -->|no and required| Failure
  DomainVlmRun --> SportsIdentity
  SportsIdentity --> TextEmbed["Text embeddings\nsentence-transformers script"]
  TextEmbed --> TextVector["Upsert text vectors"]
  TextVector --> VisualEmbed["Try visual embeddings\nOpenCLIP script"]
  VisualEmbed --> VisualVector["Upsert visual vectors\npossibly empty on unavailable visual embedding"]
  VisualVector --> Finalize["Save indexed asset\nupsert tracking\ncomplete job\nrecord billing"]
```

Stage details:

1. `probe`
   - Calls `probeVideo` from `server/intelligence.ts`.
   - Updates duration, width, height, frame rate, audio codec, and video codec.
2. `local-model-runtime`
   - `runLocalModelRuntime` coordinates:
     - audio extraction and VAD through FFmpeg
     - audio presence probing through ffprobe
     - visual frame sampling through FFmpeg raw frames
     - Whisper ASR through the ASR runtime service
     - optional WhisperX diarization through the ASR runtime service
     - PaddleOCR through generated OCR frames and the OCR runtime service
   - Cached runtime outputs are reused unless a retry stage forces a rerun.
   - Runtime stages report progress into `JobRecord.runtimeStages`.
3. `scene-detection`
   - Uses FFmpeg scene detection by default.
   - PySceneDetect remains opt-in through `SCENE_DETECTION_ENGINE=pyscenedetect` or `SCENE_DETECTION_ENGINE=py-scene-detect`.
   - When PySceneDetect is selected, an empty PySceneDetect result falls back to FFmpeg.
4. `timeline`
   - Calls `buildLocalIndex` to create searchable segments from local intelligence and scene windows.
5. `keyframes`
   - Generates one keyframe per segment under `.data/object-storage/generated/assets/:assetId/keyframes`.
   - After a successful indexing run, unreferenced generated media for the asset is pruned.
6. `video-vlm`
   - Optional, controlled by capability policy and `VLM_WORKER_URL`.
   - Uses `analyzeTimelineWithVlm`.
7. `vision-detection` and `vision-tracking`
   - Object detection uses the Vision runtime service.
   - Detector output is applied only when a configured detector backend such as Ultralytics or RF-DETR is available.
   - There is no OpenCV heuristic detector fallback. Detector unavailability remains unavailable evidence and is handled by capability policy.
   - Tracking uses the Vision runtime service.
   - The output is merged into timeline `sceneData.vision`.
8. Event classification
   - `applyEventClassification` derives event labels from text and vision features.
9. `knowledge-action`
   - A sub-stage inside the durable `domain-index` checkpoint, exposed to the UI as its own workflow node.
   - Runs only when `knowledgeActionSpotting` is enabled and the selected related-knowledge source supports a registered adapter.
   - The current implementation maps `sports.football` to the SoccerNet action spotting adapter.
   - The current implementation maps `sports.american_football` to the American-football action spotting adapter, which uses the inline template generator by default and switches to an explicit JSON/command/runtime source only when `AMERICAN_FOOTBALL_ACTION_*` or legacy `NFL_ACTION_*` variables are set.
   - The selected adapter receives the already-built timeline, detector output, tracker output, asset metadata, and related sports snapshot. It returns timestamp action JSON that is merged back into timeline domain events.
10. `domain-index`
   - Related-knowledge-enabled indexes enrich segments with domain captions, labels, events, scope, and search text.
   - For sports domains, after optional domain VLM refinement, the same checkpoint runs `resolveTimelineMatchIdentity` from `server/domainIndex/matchIdentityResolver.ts`.
   - `sports.football` resolves match context, match clock mappings, active roster windows, and track/player identity candidates from match activities, OCR/ASR/VLM text, domain events, and track evidence.
   - `sports.american_football` resolves game/play context, quarter clock mappings, down-distance/yardline, active participants, and track/player identity candidates from nflverse plays, action spots, OCR/ASR/VLM text, domain events, and MOT evidence.
   - `asset.identity` stores the asset-level identity index; each affected segment also receives `segment.identity` with context IDs, clock mappings, roster windows, identity candidates, and track assignments.
   - Identity assignment is candidate-first. It is not face-recognition-first, and stable `trackId -> playerId` assignment requires context, clock, participant/roster evidence, and track evidence to agree.
11. `domain-vlm`
   - Optional VLM refinement of related-knowledge event metadata.
   - A sub-stage inside the durable `domain-index` checkpoint when enabled.
   - For `sports.football`, the VLM output can populate structured `football.passingPlayer` and `football.receivingPlayer` roles. These roles describe event evidence, not the current query target.
   - Named passer/receiver identities require segment-local evidence. ASR/OCR/subtitle/VLM evidence can bind a role only when the player alias and action-direction cue are local to the segment. Asset titles, tags, broad metadata, and asset-level scope can identify catalog context or player mentions, but they do not prove that the named player is the passer or receiver.
   - Domain VLM merge preserves observed segment-local role evidence from the base domain index when the VLM response omits a role identity. It does not swap passer and receiver direction to satisfy a search term.
12. `embed`
   - `embedTimelineSegments` converts segment evidence into passage text and calls the Embedding runtime service.
   - Embedding dimension is validated against `EMBEDDING_DIMENSIONS` or the default `768`.
13. `vector-upsert-text`
   - Writes text timeline vectors to PostgreSQL/pgvector.
14. `visual-embedding`
   - `embedKeyframes` calls the Embedding runtime service in OpenCLIP image mode.
   - Visual embedding dimension is validated against `VISUAL_EMBEDDING_DIMENSIONS` or the default `768`.
   - The generated visual vector records are transient workflow output; a completed `visual-embedding` checkpoint is reusable only after `vector-upsert-visual` has also completed.
15. `vector-upsert-visual`
   - Writes visual vectors to PostgreSQL/pgvector.
16. `finalize`
   - Saves the asset as `indexed`.
   - Upserts tracking records.
   - Marks the job succeeded.
   - Emits `asset.indexing.succeeded`.
   - Records local billing units based on duration.

If an error escapes the workflow, the active checkpoint is marked failed, the asset is marked failed, the job is marked failed, an error log is written, and `asset.indexing.failed` is emitted.

### Stage Checkpoint And Resume

`server/services/jobStageCheckpoint.ts` stores indexing checkpoint state in `JobRecord.stageCheckpoints`.

Checkpointed stages are:

- `probe`
- `local-model-runtime`
- `timeline`
- `video-vlm`
- `vision-detection`
- `vision-tracking`
- `domain-index`
- `embed`
- `vector-upsert-text`
- `visual-embedding`
- `vector-upsert-visual`
- `finalize`

Each checkpoint stores status, message, progress, timestamps, errors, and attempt count. `runIndexingJob` wraps each durable stage with checkpoint start/complete/fail calls. The resume path only skips a completed checkpoint when the corresponding persisted output can be verified from `AssetRecord` or the completed checkpoint itself:

- `probe` requires persisted media metadata.
- `local-model-runtime` requires persisted intelligence or model trace output.
- `timeline` requires persisted timeline and keyframe snapshots.
- VLM and vision stages require matching model trace output.
- `embed` requires persisted segment embeddings.
- Vector upsert stages use checkpoint completion because vector writes are external to the asset JSON but are idempotent by asset/vector IDs.
- `visual-embedding` is coupled to `vector-upsert-visual`: because visual vector records are not stored in the checkpoint, resume reruns visual embedding if visual vector upsert has not completed yet.
- `finalize` requires the asset to be persisted as `indexed`.

Worker recovery now preserves checkpoint state. `recoverDurableWorkerJobs` sets `parameters.resumeFromStage` to the failed, running, or current checkpoint stage instead of resetting progress to the beginning. Manual retry stages still override the resume gate and rerun the requested stage plus downstream stages.

### Reindex And Specialized Retry Jobs

Asset reindexing is routed through `POST /api/assets/:id/reindex`.

Supported normalized retry stages include:

- `input`
- `probe`
- `audio`
- `vad`
- `asr`
- `speakers`
- `ocr`
- `visual`
- `timeline`
- `scene`
- `keyframes`
- `domain`
- `domainVlm`
- `knowledgeAction`
- `detector`
- `tracker`
- `vector`
- `textEmbedding`
- `visualEmbedding`
- `ready`
- `videoVlm`

Special retry paths:

- `speakers` runs `runSpeakerDiarizationJob`.
- `audio` and `vad` run `runAudioExtractionJob`.
- Other stages run the full indexing workflow with `retryStage`.
- Domain VLM refinement can run as a standalone `asset.domain-vlm.refine` job.
- The standalone domain VLM refinement path rebuilds the base domain layer before merging VLM output. This prevents stale `segment.domain` JSON from preserving old passer/receiver role binding after the role-evidence policy changes.

Duplicate active asset jobs are rejected by returning the active job with `x-existing-job: true`.

## Ask, Search, And Analysis

### Ask Operation Flow

`POST /api/ask` parses the request, ensures the persisted ask operation store is loaded, creates an operation record, persists the original request with that record, and writes an ask-operation queue outbox entry. The outbox publisher dispatches the operation ID to Redis/BullMQ. `server/askWorker.ts` executes `runAskOperation` outside the API process. If immediate Redis dispatch fails, the operation remains `queued`, the outbox entry remains pending/failed with retry metadata, and the ask worker publisher retries it later.

```mermaid
flowchart TD
  Request["POST /api/ask"] --> Ensure["Ensure ask operation store\nand prune old completed entries"]
  Ensure --> Operation["Create queued AskOperation\npersist request before 202 response"]
  Operation --> Outbox["Persist ask-operation outbox entry"]
  Outbox --> Dispatch{"Immediate outbox publish succeeded?"}
  Dispatch -->|yes| Queue["Enqueue AskOperation id\nRedis/BullMQ"]
  Dispatch -->|no| QueuedOnly["Keep operation queued\nkeep outbox retry pending"]
  Queue --> Response["Return 202 AskResponse\nwith operation id"]
  QueuedOnly --> Response
  Queue --> Worker["askWorker receives operation id"]
  Worker --> Run["Run persisted AskRequest"]
  Run --> Scope["Scope assets\nasset/index/domain/tag/modality"]
  Scope --> Plan["Query planning\nOpenAI first, VLM /plan/query fallback,\notherwise unavailable"]
  Plan --> KnowledgeSeeded{"knowledge_seeded_asset_evidence?"}
  KnowledgeSeeded -->|yes| SeedKnowledgePlan["Build structured knowledge seed plan\nknowledge_evidence + structured_answer + direct_answer"]
  SeedKnowledgePlan --> SeedKnowledge["Resolve ranked/stat subject\nfrom selected related knowledge"]
  SeedKnowledge --> SeedResolved{"Resolved answered subject?"}
  SeedResolved -->|yes| RewriteFromKnowledge["Build seeded retrieval plan\nsame route + player/event filters"]
  SeedResolved -->|no| CompleteStructured["Complete structured_answer response\nwith knowledge limitation"]
  KnowledgeSeeded -->|no| KnowledgeAnswer{"knowledge_evidence +\nstructured_answer + direct_answer?"}
  KnowledgeAnswer -->|yes| DirectKnowledge["Answer from selected related knowledge"]
  KnowledgeAnswer -->|no| SkipKnowledgeAnswer["Skip direct knowledge answer"]
  DirectKnowledge --> Orchestrate
  SkipKnowledgeAnswer --> Orchestrate["Build orchestration plan"]
  RewriteFromKnowledge --> Orchestrate
  Orchestrate --> DirectStructured{"Direct structured answer?"}
  DirectStructured -->|yes| CompleteStructured["Complete structured_answer response"]
  DirectStructured -->|no| Retrieval["Execute search pipeline"]
  Retrieval --> Analysis{"Analysis required?"}
  Analysis -->|yes| Generate["Build grounded local analysis answer"]
  Analysis -->|no| Answer["Build video search answer"]
  CompleteStructured --> Complete["Complete AskResponse"]
  Generate --> Complete
  Answer --> Complete
  Run -->|caught error| Failed["Persist failed AskResponse"]
```

Operation steps are appended with owner, input, output, status, timings, and errors. `operationStore` publishes `ask.operation.updated` realtime events whenever the operation changes. The frontend listens through `/api/events/stream?operationId=...` instead of polling `GET /api/ask/:id` in a loop.

### Query Planning

Query planning has two layers:

1. `server/queryPlanner.ts`
   - Legacy local parser used only by older direct callers and regression tests.
   - It is not the Ask/search planner fallback.
2. `server/llmQueryPlanner.ts`
   - Primary Ask/search planner boundary.
   - Requests a structured `DomainQueryPlan` from OpenAI first.
   - Falls back to the configured VLM worker `/plan/query` endpoint when OpenAI planning fails.
   - Returns an unavailable plan when neither model planner is configured or reachable.
   - Uses the OpenAI planner only when `OPENAI_API_KEY` is present and `OPENAI_QUERY_PLANNER` is not off; the VLM planner can still run when OpenAI is disabled or unavailable.
   - Merges model output into a neutral plan with allow-lists for routes, response modes, related-knowledge modes, metrics, stat modes, roles, event types, pass types, and field zones.
   - Does not fall back to the local rule parser when both model planners are unavailable.

The query plan contract deliberately separates source routing from answer shape and related-knowledge usage:

| Field | Values | Meaning |
| --- | --- | --- |
| `route` | `asset_evidence`, `knowledge_seeded_asset_evidence`, `knowledge_evidence`, `asset_catalog`, `unsupported` | Selects the evidence source and whether a related-knowledge seed is required before asset retrieval. It does not encode a domain name such as sports. |
| `responseMode` | `moment_retrieval`, `grounded_answer`, `summary`, `analysis`, `structured_answer`, `asset_lookup` | Selects the answer shape. This is what decides whether retrieval-only output or grounded generation is needed. |
| `relatedKnowledgeMode` | `none`, `grounding`, `direct_answer` | Selects whether selected related knowledge is ignored, used only to ground asset retrieval, or used as the primary answer source. It does not control structured asset/domain filters. |

Terminology used by the query and retrieval layers:

| Term | Meaning |
| --- | --- |
| Asset evidence | Evidence indexed from the asset itself, including ASR, OCR, VLM captions, visual embeddings, text embeddings, titles, descriptions, tags, and timeline metadata. |
| Structured asset evidence / domain evidence | Domain-shaped facts attached to indexed timeline segments, such as `eventType`, `passType`, `football.passingPlayer.identity`, `football.receivingPlayer.identity`, `fieldZone`, match context, and role labels. |
| Domain filters | Structured retrieval constraints in `domainFilters`. They are verified against structured asset/domain evidence and may remain active when `relatedKnowledgeMode=none`. |
| Participants | Query-time semantic action constraints. `action_source` means the named entity initiates the action, `action_target` means the named entity receives or is targeted by it, and `subject` means the named entity is only the topic. |
| Related knowledge | Selected asset-group knowledge outside the raw indexed video evidence, such as imported sports stats, rosters, provider rows, related documents, and knowledge vectors. |
| Domain lexicon / registry | Canonical name and alias normalization used by planners and indexers. Using a registry to normalize `Son` to `Son Heung-min` is not the same as using related knowledge as an answer or retrieval source. |
| Role-bound identity | A structured event identity attached to a participant role, such as `football.passingPlayer.identity`. It must come from segment-local role evidence and is compared through the canonical player registry before falling back to text normalization. |

Additional planner fields are part of the retrieval contract:

- `retrieval.textQuery`, `retrieval.visualQuery`, and `retrieval.evidenceTerms` define concrete search inputs.
- `retrieval.requiredEvidence` defines hard evidence-channel constraints such as `visible_text` or `spoken_text`.
- `filterEvidence` records the exact planner evidence for inferred structured filters. Inferred filters without evidence are discarded unless supplied explicitly by the caller.
- `intent.metric` and `intent.statMode` are explicit. Route alone never implies a statistics question.
- `intent.participants` preserves named-entity action direction. `relation=action_source` means the entity initiates the action, `relation=action_target` means the entity receives or is targeted by it, and `subject` means the entity is only the topic.
- Participant roles are inferred from structured semantic direction and event type, not from language-specific keyword overrides. For example, a pass action with `Son Heung-min` as `action_source` becomes `player=Son Heung-min`, `role=passer`, and `eventType=pass_receive`.
- Top-level planner `role` is treated as deprecated for participant binding. A role is promoted into `domainFilters` only when it is backed by evidence-bearing `participants` or by explicit caller filters.

Current examples from the code:

| User intent | Route plan |
| --- | --- |
| Find a visible object or moment in indexed video | `asset_evidence + moment_retrieval + none` |
| Ask what something in the video looks like | `asset_evidence + grounded_answer + none` |
| Summarize selected video evidence | `asset_evidence + summary + none` |
| Find a player/action moment from indexed video evidence | `asset_evidence + moment_retrieval + none` |
| Find a moment that needs selected related knowledge to expand or ground the query | `asset_evidence + moment_retrieval + grounding` |
| Find moments for the player who leads a selected related-knowledge leaderboard | `knowledge_seeded_asset_evidence + moment_retrieval + grounding` |
| Answer a structured fact from selected related knowledge | `knowledge_evidence + structured_answer + direct_answer` |
| List or inspect asset catalog metadata | `asset_catalog + asset_lookup + none` |

`knowledge_seeded_asset_evidence` is an explicit hybrid route. `runAskOperation` first builds a temporary structured knowledge seed plan, resolves the ranked/stat subject, and then constructs the retrieval plan with concrete player and event filters. If selected related knowledge cannot resolve an answered subject, retrieval is not silently downgraded to a broad asset search.

### Orchestration

`server/orchestrator.ts` converts the query plan and available scoped assets into an `OrchestrationPlan`.

It decides:

- mode: search, analysis, or structured answer
- identity readiness when related knowledge is active in the selected asset group
- scope readiness when related knowledge is active in the selected asset group
- retrieval engine:
  - `semantic_retrieval` for asset evidence without related knowledge
  - `structured_domain` for direct related-knowledge answers
  - `hybrid` for asset retrieval grounded by selected related knowledge
- whether analysis generation is required
- warnings and fallbacks

Analysis generation is required for `responseMode` values `grounded_answer`, `summary`, and `analysis`. It is skipped for retrieval-only `moment_retrieval`, `asset_lookup`, and direct `structured_answer` responses.

### Search Pipeline

`executeSearchPipeline` performs retrieval:

1. Scope assets by asset ID, index ID, domain group, tag, modality, and explicit asset references in the query.
2. Decide whether the selected asset group exposes related knowledge and whether `relatedKnowledgeMode` allows using it.
3. Ground the query with selected related knowledge when applicable.
4. Expand the query with domain aliases.
5. Embed the text query.
6. Attempt visual text embedding for visual vector search.
7. Search text vectors.
8. Search visual vectors when the visual query vector is available.
9. Search related knowledge vectors when the knowledge layer applies.
10. Merge grounding evidence and knowledge vector evidence.
11. Call `searchAssets` to rank and verify matching timeline segments.

Domain filter matching uses a production evaluation model:

- `trusted`: structured scope/player/event evidence satisfies the filter.
- `weak`: unstructured text or weak scope context satisfies the filter without trusted structured evidence.
- `failed`: trusted structured evidence conflicts with the requested event, role, pass type, field zone, player, competition, or season.

Weak event text can admit a candidate only when no trusted structured event is present. It is reported as `soft_pass` verification and receives lower ranking credit. If trusted structured event evidence exists and conflicts with the requested filter, the candidate is rejected before ranking.

Player-role binding is checked against structured domain events. A query such as `player=Son Heung-min + role=passer + eventType=pass_receive` must match `football.passingPlayer.identity`; a segment where Son appears only as `football.receivingPlayer.identity` is rejected. There is no text fallback for role-specific player binding.

Role-specific player checks compare player identities through the domain registry first. For example, `손흥민`, `Son`, `Sonny`, and `Son Heung-min` resolve to the same canonical player ID before the search verifier decides whether the structured role identity satisfies the query. Raw string matching is only a fallback for values that are not present in the registry.

Role-bound indexing is stricter than generic player mention indexing:

- Segment-local `손흥민의 패스`, `Son Heung-min cutback`, or `Son passes` can bind `football.passingPlayer.identity`.
- Segment-local `finds Son`, `to Son`, or `Son receives` can bind `football.receivingPlayer.identity`.
- Asset titles, tags, broad metadata, or a player appearing in scope can support catalog/search context but cannot bind a passer/receiver role by themselves.

Because domain events and vector text are materialized into `app_assets.data.timeline[].domain` and `app_vectors`, policy changes require re-materializing affected assets. Full media extraction is not required when ASR/OCR/VLM/vision evidence is unchanged; rerun the `domain-index` retry stage, standalone `asset.domain-vlm.refine`, or an affected-index rebuild so domain JSON, text vectors, and tracking records are regenerated from the current policy.

Text vector query flow:

- `embedQueryText`
- `searchVectors`

Visual query flow:

- `embedVisualQuery`
- `searchVisualVectors`

Knowledge vector flow:

- `searchKnowledgeVectors`
- `knowledgeVectorHitToEvidence`

### Synchronous Search Endpoints

`GET /api/search` exposes a synchronous search path using the same query planning and `executeSearchPipeline` machinery. For direct structured knowledge questions, it returns a `409` instructing clients to use the related knowledge answer endpoint. For `knowledge_seeded_asset_evidence`, it first resolves the seed subject through related knowledge; if that succeeds it runs seeded retrieval, otherwise it returns `409` with the knowledge-answer limitation.

### Analysis

Analysis is exposed through:

- `POST /api/analyze`
- `POST /api/assets/:id/analyze`
- `POST /api/indexes/:id/analyze`

Asset-level analysis uses `analyzeAndEmit`, which requires the asset to be indexed and then calls `analyzeAsset`. Asset-group analysis calls `analyzeAssetGroup`. Successful analysis records an `analysis.completed` event, delivers matching webhooks, and records billing.

## Related Knowledge And Domain Adapters

The ask/query architecture treats related knowledge as an asset-group capability, not as a top-level domain label. Query planning uses `relatedKnowledgeMode` and the selected asset group's `domainIndexing.groups` to decide whether this layer can ground retrieval or answer directly.

### Knowledge Registry

The generic knowledge facade names live in:

- `server/knowledge/registry.ts`
- `server/knowledge/documents.ts`
- `server/knowledge/answer.ts`

The current code still binds that facade directly to the sports adapter. `registry.ts` re-exports sports store functions, `answer.ts` calls `answerSportsKnowledgeQuestion`, and `documents.ts` builds documents from the same sports snapshot. This means the names are domain-generic, but adapter dispatch is not yet pluggable.

The concrete adapter implementation lives under `server/knowledge/adapters/sports/*` because the only configured domain groups today are football and American football. This adapter contains built-in competitions, teams, and players, and merges external knowledge from local persistent storage. It supports:

- competition matching
- player alias matching
- team matching
- season helpers
- player upsert/delete
- provider data merging

The knowledge snapshot includes:

- domains
- competitions
- teams
- players
- match activities
- facts
- American-football plays from nflverse

### Provider Imports

Knowledge import routes call provider-specific importers:

- Football-Data
- football-data.co.uk
- StatBunker or Kaggle source mode
- StatsBomb open data
- nflverse

The imported knowledge is merged into the current adapter store and exposed through the generic knowledge facade.

### Structured Knowledge QA

`server/knowledge/answer.ts` dispatches direct structured answers for `knowledge_evidence + structured_answer + direct_answer` plans. The current sports adapter answers supported aggregate stat questions directly from imported related knowledge. It does not treat video retrieval as the authoritative source for aggregate totals.

Supported metric families include football and American-football metrics:

- goals
- assists
- appearances
- minutes
- cards
- points
- touchdowns
- passing yards
- passing touchdowns
- rushing yards
- receiving yards
- sacks
- interceptions

### Knowledge Grounding

`server/knowledgeGrounding.ts` builds evidence for `asset_evidence` retrieval when `relatedKnowledgeMode` is `grounding`:

- competition scope
- player profiles
- rosters
- match activities
- facts
- video scope evidence already present in indexed segments

The result becomes both retrieval text and structured `KnowledgeEvidence`.

### Domain Indexing

Related-knowledge domain indexing is configured on `IndexRecord.domainIndexing`. The current configured source IDs are sports-specific:

- `sports.football`
- `sports.american_football`

When enabled, timeline segments can receive:

- domain group membership
- domain captions
- labels
- structured football or American-football events
- scope values for competition, season, teams, and players
- confidence and trust
- searchable domain text
- optional domain VLM quality metadata

Capability policies control whether VLM, detector, tracker, adapter action spotting, domain VLM, and diarization steps are disabled, optional, or required.

### Domain-Specific Sports Templates

Sports domain behavior is described in `shared/knowledgeTemplates.ts` as a fixed `manifest + generator + evaluator` contract.

`sports.base` is the shared contract. It defines:

- common evidence rules for ASR, OCR, VLM, detector, tracker, and registry evidence
- edited-video support through multiple `matchContexts[].videoRanges[]`
- clock mappings per match/game context
- candidate-first player identity rules
- skip policies for missing domain context, missing action sources, or missing identity evidence
- evaluator policies for schema stability, benchmark coverage, and false-alignment regression gates

`sports.football` specializes the base contract with football match activities, lineup windows, SoccerNet-style timestamp action spots, match clocks, field zones, pass/player/ball fields, and football registry grounding.

`sports.american_football` specializes the base contract with nflverse play metadata, `gameId`, `playId`, quarter clock, down-distance, yardline, participant fields, Big Data Bowl-style tracking schema hooks, MOT track IDs, and planned helmet/contact evidence.

The frontend exposes this contract in two places:

- `src/components/knowledge/KnowledgePanel.tsx` shows `Overview`, `Manifest`, `Generator`, and `Evaluator` tabs for the selected related knowledge.
- `src/components/assets/AssetComponents.tsx` shows the same template contract inside the asset workflow `knowledgeAction` node, including runtime gates, skip conditions, output schema count, benchmark coverage, and stored traces.

### Sports Identity Resolution

`server/domainIndex/matchIdentityResolver.ts` runs after domain event construction and optional domain VLM refinement, before text embeddings and vector upsert. It keeps generic video evidence separate from sports identity decisions.

The resolver supports multiple context ranges inside one edited asset:

- one video can contain multiple matches or games
- each context stores independent `videoRanges[]`
- each context stores independent `clockMappings[]`
- segment-level identity points back to one or more context IDs

For football, the resolver builds match candidates from imported match activities and roster windows. It restricts player identity candidates by match context, clock, lineup/substitution/red-card windows, text evidence, and track evidence.

For American football, the resolver builds game/play candidates from nflverse play metadata and action-spot play metadata. It uses `gameId`, `playId`, quarter, clock, down, distance, yardline, participant metadata, and MOT track evidence when available.

The resolver intentionally does not claim stable visual identity from generic face recognition. Face, jersey OCR, team-kit classification, helmet assignment, ReID, contact, and calibrated tracking can be added as evidence sources, but current stable identity remains evidence-gated and candidate-first unless the required evidence agrees.

## Storage Architecture

### Object Storage

`server/localObjectStorage.ts` stores uploaded media under:

- `.data/object-storage/:provider/:bucket/assets/:assetId/source.ext`

The default local provider is `local-s3`. `LOCAL_OBJECT_PROVIDER` can switch to `local-s3` or `local-r2`. Generated artifacts such as audio, OCR frames, and keyframes also live under the public media root.

Upload/media lifecycle:

- Multer writes incoming files to `.data/tmp-uploads`.
- `createAssetFromUpload` moves the temp file into object storage through `putUploadedObject`.
- Validation failures after Multer upload discard the temp file.
- API boot removes stale temp uploads older than `UPLOAD_TEMP_MAX_AGE_MS`.
- Source media is retained under `assets/:assetId/source.ext`.
- Generated media is written under `generated/assets/:assetId`.
- Successful indexing and audio retry prune generated files that are no longer referenced by the saved `AssetRecord`.
- Stored source checksum is a file SHA-256 digest.

`/media` serves:

- `.data/object-storage`

This path is exposed through `server/http/mediaServing.ts` only when `MEDIA_SERVING_MODE=local-static`.
`/api/*` requests do not pass through this middleware because the mounted `/media` prefix does not match.
Operational deployments should set `MEDIA_SERVING_MODE=disabled` and serve the object-storage media through a dedicated object storage, CDN, or reverse proxy boundary.

`GET /api/storage/status` reports the application persistence boundary and the media storage boundary separately. It intentionally does not describe object-storage media as database persistence.

### Metadata Store Adapter

`server/store.ts` is the main persistence boundary.

The runtime requires `DATABASE_URL` and delegates metadata, events, billing, users, jobs, ask operations, tracking records, queue outbox entries, and vector records to `server/postgresStore.ts` and `server/postgres/*` repositories.

Earlier local JSON stores are no longer a runtime fallback. They are only read by the explicit one-time migration script, `scripts/migrate_legacy_to_docker.ts`, when legacy development data needs to be imported into Docker PostgreSQL.

### Postgres Schema

`server/postgres/schema.ts` creates:

- `app_indexes`
- `app_assets`
- `app_jobs`
- `app_ask_operations`
- `app_webhooks`
- `app_events`
- `app_users`
- `app_billing`
- `app_vectors`
- `app_visual_vectors`
- `app_knowledge_vectors`
- `app_tracking_records`
- `app_schema_migrations`

`pgvector` is required:

- `app_vectors.embedding` is created as `vector(EMBEDDING_DIMENSIONS)`.
- `app_knowledge_vectors.embedding` is created as `vector(EMBEDDING_DIMENSIONS)`.
- `app_visual_vectors.embedding` is created as `vector(VISUAL_EMBEDDING_DIMENSIONS)`.
- HNSW cosine indexes are attempted for those vector columns.

If `pgvector` is unavailable, schema initialization fails. If vector dimensions change, incompatible embeddings fail insertion/search readiness and must be rebuilt with `npm run embeddings:rebuild` or `npm run indexes:rebuild`.

`GET /api/db/status` reports:

- Postgres readiness and degraded state.
- pgvector extension version or install error.
- active vector search mode: `pgvector`.
- vector column type, expected type, HNSW index presence, and row counts for each vector table.
- schema migration records and aggregate metrics.

### Vector Stores

Text vectors:

- Postgres table: `app_vectors`
- Built from timeline segment embedding text.

Visual vectors:

- Postgres table: `app_visual_vectors`
- Built from generated keyframes.

Knowledge vectors:

- Postgres table: `app_knowledge_vectors`
- Built from related knowledge documents.

Vector search uses cosine similarity through pgvector distance over compatible vector columns.

### Tracking Store

`server/trackingStore.ts` stores derived ball/player/link tracking records.

Tracking records are persisted in `app_tracking_records`.
Tracking records are rebuilt from asset timeline vision evidence and can be filtered by asset, segment, or track ID.
Postgres upserts and rebuilds are wrapped in transactions so a failed rebuild does not leave a partially replaced tracking set committed.

### Ask Operation Store

`server/workflows/ask/operationStore.ts` stores async ask operation state.

Ask operation entries are persisted in `app_ask_operations`.
The in-memory map remains a process-local cache over persisted operation state. Initial operation creation is persisted before the API returns `202`, later state writes are serialized, and persistence failures are recorded through observability logs. Persisted completed or failed operations can be read after an API restart. Interrupted running operations are reset to `queued` by the ask worker and rerun from the beginning.
The persisted entry includes the original `AskRequest`, so an ask worker can execute an operation from the durable operation ID without depending on API process memory.

### Events, Webhooks, And Billing

Events and billing go through the same store adapter as assets and jobs.

`server/services/events.ts` provides:

- `recordEvent`
- `deliverEvent`
- `deliverWebhook`
- `recordBilling`

Webhook behavior:

- Active webhooks receive events they subscribe to.
- `log://` URLs are marked delivered without a network request.
- HTTP webhooks are sent with a 2.5 second timeout.
- Failed deliveries get exponential retry timestamps up to 60 seconds.
- Delivery history is capped at 30 entries per webhook.

## Runtime Adapters

### Local Model Runtime

`server/localModelRuntime.ts` coordinates the local media intelligence pipeline.

Runtime stages:

- audio extraction and VAD
- visual sampling
- audio waveform presence check
- ASR
- diarization
- OCR

The runtime can reuse cached asset intelligence unless a retry explicitly forces the stage. It publishes partial intelligence during long indexing jobs so the frontend can show incremental progress.

### Python Runtime Service Boundary

Long-running model runtimes are called through a service boundary instead of being owned directly by the Express API process. The default local service is `scripts/arion_model_runtime_service.py`, a FastAPI process that wraps the existing Python runtime scripts.

The Node side is split by runtime category:

- ASR service: Whisper and WhisperX through `ASR_RUNTIME_SERVICE_URL` or `PYTHON_RUNTIME_SERVICE_URL`.
- OCR service: PaddleOCR through `OCR_RUNTIME_SERVICE_URL` or `PYTHON_RUNTIME_SERVICE_URL`.
- Vision service: object detection, tracking, adapter action spotting, and optional PySceneDetect through `VISION_RUNTIME_SERVICE_URL` or `PYTHON_RUNTIME_SERVICE_URL`.
- Embedding service: text and visual embeddings through `EMBEDDING_RUNTIME_SERVICE_URL` or `PYTHON_RUNTIME_SERVICE_URL`.
- VLM service: Qwen/LLaVA-style video and domain refinement through `VLM_WORKER_URL`.

The initial local deployment can run a single combined Python runtime service on port `8792`. Production or multi-host development can split ASR, OCR, Vision, and Embedding into separate services by setting the category-specific URLs; the Node worker code continues to call the same TypeScript runtime interface.

`server/processRole.ts` prevents asset model runtime execution from the API process. Asset indexing runtime is allowed from the BullMQ worker and maintenance scripts; API-side search embeddings can still call the Embedding runtime service because they are query-time service calls, not asset indexing workflows.

Important scripts include:

- `scripts/whisper_transcribe.py`
- `scripts/whisperx_diarize.py`
- `scripts/paddle_ocr_extract.py`
- `scripts/embed_text.py`
- `scripts/embed_visual.py`
- `scripts/detect_scenes.py`
- `scripts/detect_objects.py`
- `scripts/track_objects.py`
- `scripts/qwen_vlm_worker.py`
- `scripts/soccernet_action_spotting.py`
- `scripts/american_football_action_spotting.py`

`PYTHON_RUNTIME_MODE=service` routes model work through HTTP runtime services. `PYTHON_RUNTIME_MODE=direct` keeps local script execution available for development and migration checks. `PYTHON_RUNTIME_SERVICE_ATTEMPTS` controls transient HTTP call retries before the workflow records the runtime stage as failed.

Scene detection is the exception to the general "Python first" model-runtime pattern. `server/sceneDetection.ts` uses FFmpeg by default to avoid loading both PyAV and OpenCV FFmpeg dylibs in the common path. Set `SCENE_DETECTION_ENGINE=pyscenedetect` to opt into PySceneDetect; when that opt-in path returns no boundaries, FFmpeg remains the fallback.

### Capability Policy

Capability modes are:

- `disabled`
- `optional`
- `required`

Capabilities:

- `whisperXDiarization`
- `videoVlmAnalysis`
- `visionDetector`
- `visionTracker`
- `knowledgeActionSpotting`
- `domainVlmRefinement`

Optional unavailable capabilities are recorded in traces/logs where applicable. Required unavailable capabilities throw `RequiredCapabilityUnavailableError` and fail the job.

### VLM Worker

`server/vlmWorkerClient.ts` is the HTTP client for VLM operations:

- video segment description
- sports domain event refinement
- query planning fallback through `/plan/query`
- health check

It is enabled when `VLM_WORKER_URL` is configured. The local `dev:full` command starts `scripts/qwen_vlm_worker.py` through the `.venv-ai` Python path.

### LLM Query Planner

`server/llmQueryPlanner.ts` is the model-backed query planner boundary. It calls the OpenAI Responses API first, then the configured VLM worker `/plan/query` endpoint when OpenAI planning fails. The OpenAI implementation is guarded by:

- `OPENAI_API_KEY`
- `OPENAI_QUERY_PLANNER` not being `off` or `false`

It starts from a neutral unsupported plan and merges allow-listed model output into the structured plan contract. If neither model planner is available, it returns an unavailable planner result instead of using local query rules.

## Observability

`server/observability.ts` implements local observability:

- request ID generation or propagation from `x-request-id`
- W3C `traceparent` response header
- OpenTelemetry local in-memory span exporter
- recent spans buffer
- recent JSON log buffer
- latency buckets for requests, jobs, stages, model runtimes, embeddings, and search operations
- NDJSON log persistence at `.data/logs/app.ndjson`

`GET /api/observability` returns:

- trace exporter type
- log format and path
- recent logs
- recent spans
- all latency metrics
- model runtime metrics
- stage metrics
- request metrics

Noisy successful status GET requests and the SSE stream path are suppressed from console output unless `CONSOLE_LOG_LEVEL=all`, but logs are still managed through the internal logging path.

Python runtime service calls are logged with category-specific metric keys such as `model.asr.whisper.service`, `model.ocr.paddle.service`, `model.vision.detector.service`, and `model.embedding.text.query.service`. Each log records the selected runtime-service URL, duration, service-reported duration, job context, and asset context when available.

## Failure And Recovery Behavior

### HTTP Errors

The Express error handler returns JSON:

- upload size failures become `413`
- known errors with `statusCode` use that status
- all others become `500`

### Runtime Failures

`runRuntimeStage` reports stage start, success, failure, and heartbeat messages. Recoverable model runtime tasks can return unavailable fallback payloads instead of throwing. Whether this fails the job depends on the capability policy.

Runtime-service HTTP failures are retried according to `PYTHON_RUNTIME_SERVICE_ATTEMPTS`. If all attempts fail, the TypeScript workflow records the runtime stage as failed. Optional capabilities can continue with unavailable payloads; required capabilities fail the job through the existing capability policy path.

### Job Recovery

On worker startup, `recoverDurableWorkerJobs` scans queued or running jobs left from a previous worker process:

- Stale runtime processes are cleaned through `cleanupStaleRuntimeProcesses` before jobs are re-dispatched.
- Supported queued asset jobs are reconciled into Redis/BullMQ through `redisJobQueue`.
- Supported job types are `asset.index`, `asset.reindex`, and `asset.domain-vlm.refine`.
- Reindex retry stage is recovered from `JobRecord.parameters.retryStage`; older log-only records are still parsed as a compatibility fallback.
- Running jobs are reset to `queued`, `parameters.resumeFromStage` is set from the failed/running/current checkpoint, and `runIndexingJob` skips completed checkpoints only when persisted stage output is reusable.
- BullMQ jobs are keyed by `JobRecord.id`, so reconciliation is idempotent for already-enqueued jobs.

### Ask Operation Durability

Ask operations are cached in an in-memory `Map`, persisted in PostgreSQL by `server/workflows/ask/operationStore.ts`, and dispatched through the queue outbox before Redis/BullMQ publication.

Implications from the code:

- The persisted source of truth is `app_ask_operations`.
- The API process persists the original request and a queue outbox entry, then publishes only the `AskOperation.id`.
- `saveAskOperation(..., { queueDispatch: true })` writes `app_ask_operations` and `app_queue_outbox` in one PostgreSQL transaction.
- Redis dispatch failure does not mark a newly created ask operation as failed. The operation remains `queued`, and the outbox entry retains retry state.
- `server/askWorker.ts` loads the persisted request, runs `runAskOperation`, and persists step/status/result updates.
- Completed or failed operations can be retrieved after an API restart until they are pruned.
- Running operations are reset to `queued` by the ask worker on restart and rerun from the beginning.
- Completed or failed operations are pruned from both the cache and the persistent store when the operation set grows beyond the configured in-code threshold.
- Ask operation execution is durable at the operation-record level, not checkpoint-resume level.

### Realtime Event Push

`server/services/realtimeEvents.ts` implements the Server-Sent Events bus. `GET /api/events/stream` keeps a same-origin SSE connection open and emits typed events:

- `asset.updated`
- `asset.deleted`
- `index.deleted`
- `job.updated`
- `ask.operation.updated`
- `event.recorded`
- `outbox.updated`

Events are emitted to in-process subscribers immediately. When `REALTIME_REDIS_ENABLED` is not `false` and `REALTIME_REDIS_URL` or `REDIS_URL` is configured, the same events are also published to a Redis pub/sub channel so separate API/worker processes can fan out updates. Each event carries an origin ID so a process does not replay its own Redis echo.

The SSE route supports optional `jobId`, `assetId`, and `operationId` filters. When `operationId` is provided, the route writes the current ask operation snapshot once on connect. Later heartbeats are comments only, not repeated full ask responses.

The frontend still performs an initial REST read for full state hydration. Continuous console refresh is driven by SSE-triggered debounced refreshes in `src/hooks/useConsoleData.ts`, with an active-job interval refresh as a fallback. Ask completion waits on operation-scoped SSE events in `src/hooks/useSearchController.ts`.

## Concurrency And Durability Characteristics

| Concern | Current implementation |
| --- | --- |
| API process | Express process for HTTP, local media serving when enabled, route handling, queue outbox writes, immediate outbox publish attempts, and SSE fanout. |
| Asset jobs | Redis/BullMQ execution queue plus separate `server/jobWorker.ts` process. |
| Asset queue durability | `JobRecord` plus queue outbox are the source of truth. Redis/BullMQ is the execution queue. PostgreSQL writes the job and outbox in one transaction. Worker startup publishes pending outbox entries and reconciles queued records. |
| Asset checkpoint durability | `JobRecord.stageCheckpoints` records checkpoint status. Interrupted indexing jobs preserve checkpoints and resume from the failed or interrupted stage when outputs are reusable. |
| Ask operations | Queue outbox plus Redis/BullMQ execution queue and separate `server/askWorker.ts` process. Persisted `AskOperation` entries include the original request. Running execution restarts from the beginning after worker recovery. |
| Metadata durability | PostgreSQL in Docker development/operations. |
| Vector durability | PostgreSQL + pgvector in Docker development/operations. |
| Tracking durability | PostgreSQL in Docker development/operations. |
| Runtime parallelism | Asset job worker concurrency is controlled by `JOB_WORKER_CONCURRENCY`; some local model stages can also run concurrently based on `LOCAL_MODEL_HEAVY_CONCURRENCY`. |
| Frontend refresh | SSE event push through `/api/events/stream`; initial hydration remains REST; active jobs enable a bounded interval fallback. |

## Environment-Driven Behavior

Selected environment variables used by the implementation:

| Variable | Effect |
| --- | --- |
| `PORT` | API port, default `8787`. |
| `ARION_DOCKER_INFRA` | When true, host development uses Docker Redis and Docker PostgreSQL/pgvector URLs, overriding `.env` values to avoid accidental local-service connections. |
| `REDIS_URL` | Redis URL for BullMQ asset job and ask operation dispatch/execution, default `redis://127.0.0.1:16379` in Docker-backed host development. |
| `JOB_QUEUE_NAME` | BullMQ queue name, default `arion-asset-jobs`. BullMQ queue names cannot contain `:`, so configured values are normalized by replacing `:` with `-`. |
| `JOB_WORKER_CONCURRENCY` | Number of asset jobs a worker process can run concurrently, default `1`. |
| `JOB_QUEUE_RECONCILE_MS` | Worker interval for reconciling queued `JobRecord`s into Redis, default `15000`. |
| `ASK_QUEUE_NAME` | BullMQ queue name for ask operation execution, default `arion-ask-operations`. BullMQ queue names cannot contain `:`, so configured values are normalized by replacing `:` with `-`. |
| `ASK_WORKER_CONCURRENCY` | Number of ask operations an ask worker can run concurrently, default `2`. |
| `ASK_QUEUE_RECONCILE_MS` | Ask worker interval for reconciling queued `AskOperation`s into Redis, default `15000`. |
| `DATABASE_URL` | Required Postgres storage URL; Docker-backed host development defaults to `postgres://video_intelligence:video_intelligence@127.0.0.1:15432/video_intelligence`. |
| `POSTGRES_APPLICATION_NAME` | Sets the Postgres connection application name, default `arion`. |
| `POSTGRES_POOL_MAX` | Sets the Node `pg` pool max size, default `10`. |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | Sets Postgres connection timeout, default `5000`. |
| `POSTGRES_IDLE_TIMEOUT_MS` | Sets idle connection timeout, default `30000`. |
| `POSTGRES_REQUIRE_PGVECTOR` | Expected to be `true`; pgvector is required for runtime schema initialization and vector search. |
| `PGSSLMODE` / `POSTGRES_SSLMODE` | Enables Postgres TLS when set to `require`. |
| `API_KEYS` | Enables API-key auth when non-empty. |
| `RATE_LIMIT_PER_MINUTE` | Sets in-memory rate limit, default `600`. |
| `MEDIA_SERVING_MODE` | `local-static` serves `.data/object-storage` through Express `/media`; `disabled` removes local media serving for object storage/CDN deployments. |
| `MEDIA_STATIC_MAX_AGE` | Cache-control max age for local static media serving, default `1h`. |
| `UPLOAD_MAX_BYTES` | Upload limit, default 8GB. |
| `UPLOAD_TEMP_MAX_AGE_MS` | Max age for stale `.data/tmp-uploads` files cleaned on API boot, default `86400000`. |
| `LOCAL_OBJECT_PROVIDER` | `local-s3` or `local-r2`. |
| `LOCAL_OBJECT_BUCKET` | Object storage bucket name, default `video-assets`. |
| `LOCAL_AI_PYTHON` | Python executable for local AI scripts. |
| `ARION_PROCESS_ROLE` | Optional process role override: `api`, `worker`, or `script`; normally inferred from the entrypoint. |
| `ALLOW_API_MODEL_RUNTIME` | Emergency development override for running asset model runtime in the API process. Default is blocked. |
| `PYTHON_RUNTIME_MODE` | `service` routes model work through HTTP runtime services; `direct` runs scripts from Node for local development checks. |
| `PYTHON_RUNTIME_SERVICE_URL` | Default combined Python runtime service URL, default `http://127.0.0.1:8792`. |
| `PYTHON_RUNTIME_SERVICE_HOST` / `PYTHON_RUNTIME_SERVICE_PORT` | Host and port used by `scripts/arion_model_runtime_service.py`. |
| `PYTHON_RUNTIME_SERVICE_ATTEMPTS` | Number of transient runtime-service call attempts, default `1`. |
| `ASR_RUNTIME_SERVICE_URL` | Optional ASR service override for Whisper and WhisperX. |
| `OCR_RUNTIME_SERVICE_URL` | Optional OCR service override for PaddleOCR. |
| `VISION_RUNTIME_SERVICE_URL` | Optional vision service override for object detection, tracking, and adapter action spotting. PySceneDetect uses this service only when explicitly selected by `SCENE_DETECTION_ENGINE`. |
| `EMBEDDING_RUNTIME_SERVICE_URL` | Optional embedding service override for text and visual embeddings. |
| `WHISPER_MODEL` | Whisper model, default `large-v3`. |
| `WHISPER_BACKEND` | Whisper backend mode. |
| `WHISPER_LANGUAGE` | ASR language hint or auto mode. |
| `WHISPERX_MODEL` | WhisperX model. |
| `WHISPERX_HF_TOKEN` / `HF_TOKEN` | Enables pyannote-backed diarization where required. |
| `PADDLEOCR_LANG` | OCR language selection. |
| `EMBEDDING_MODEL` | Text embedding model, default `intfloat/multilingual-e5-base`. |
| `EMBEDDING_DIMENSIONS` | Text and knowledge vector dimensions, default `768`. |
| `VISUAL_EMBEDDING_MODEL` | Visual model name, default `ViT-L-14`. |
| `VISUAL_EMBEDDING_PRETRAINED` | Visual model pretrained weights, default `datacomp_xl_s13b_b90k`. |
| `VISUAL_EMBEDDING_DIMENSIONS` | Visual vector dimensions, default `768`. |
| `VLM_WORKER_URL` | Enables VLM worker calls. |
| `SCENE_DETECTION_ENGINE` | Scene detection engine. Defaults to `ffmpeg`; `pyscenedetect` or `py-scene-detect` opts into PySceneDetect with FFmpeg fallback. |
| `OPENAI_API_KEY` | Enables optional OpenAI query planner. |
| `OPENAI_QUERY_PLANNER` | Disables OpenAI planner when `off` or `false`. |
| `CAPABILITY_*` | Sets capability modes for runtime stages. |
| `VISION_DETECTOR_BACKEND` | Selects vision detector backend. |
| `VISION_TRACKER` | Selects Ultralytics tracker config. |
| `SOCCERNET_ACTION_SPOTTING_COMMAND` / `SOCCERNET_ACTION_SPOTS_JSON` | Enables SoccerNet-style action spotting. |
| `AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND` / `AMERICAN_FOOTBALL_ACTION_SPOTS_JSON` | Overrides the built-in American-football inline template generator with an explicit prediction source. Legacy `NFL_ACTION_*` names are also accepted. |

## Maintenance Scripts

The repo includes TypeScript and Python maintenance scripts. Use [npm-scripts.md](npm-scripts.md) for the command-level reference.

- Postgres:
  - `scripts/postgres_check.ts`
  - `scripts/migrate_legacy_to_docker.ts`
  - `scripts/postgres_seed.ts`
  - `scripts/postgres_reset.ts`
- Knowledge import:
  - `scripts/import_football_data.ts`
  - `scripts/import_football_data_uk.ts`
  - `scripts/import_nflverse.ts`
  - `scripts/import_statbunker.ts`
  - `scripts/import_statsbomb_open_data.ts`
  - `scripts/sync_current_sports_knowledge.ts`
- Rebuild:
  - `scripts/rebuild_embeddings.ts`
  - `scripts/rebuild_knowledge_vectors.ts`
  - `scripts/rebuild_all_indexes.ts`
  - `scripts/refine_vlm_domain.ts`
  - `scripts/build_american_football_action_spots.ts`
- Runtime diagnostics:
  - `scripts/model_doctor.py`
- Runtime workers and adapters:
  - `scripts/arion_model_runtime_service.py`
  - ASR, OCR, VLM, embedding, scene detection, object detection, tracking, SoccerNet, and American-football action spotting scripts.

## Extension Boundaries

The code is already organized around replaceable adapters:

- Object storage can be replaced behind `localObjectStorage`.
- Metadata storage can be replaced behind `store.ts`.
- Text, visual, and knowledge vector storage can be replaced behind vector store modules.
- Redis/BullMQ is isolated behind `redisJobQueue`, and workflow execution is isolated behind `assetJobRunner`.
- Ask operation execution is isolated behind `askJobQueue` and `askWorker`.
- Python runtime categories can be moved independently by configuring ASR, OCR, Vision, and Embedding service URLs.
- VLM worker is already a separate HTTP boundary and can serve both video/domain reasoning and query planning fallback.
- Query planning is isolated behind `llmQueryPlanner`; it uses OpenAI first, the VLM worker as model fallback, and an unavailable plan instead of local rule fallback when model planning cannot run.
- Webhook delivery is isolated in `server/services/events.ts`.
- The knowledge facade has generic names, but the current adapter dispatch is still wired directly to `server/knowledge/adapters/sports/*`.

## Current Implementation Constraints

These are direct consequences of the code shape:

- Asset job execution is separated from the API process, Redis-backed, and checkpointed at durable indexing stage boundaries.
- Redis is required for execution dispatch, while persisted operation records and queue outbox entries remain the source of truth for recovery and status.
- Ask operations are worker-backed and durable at the operation-record level, but ask execution is not checkpoint-resume based; interrupted running ask operations are reset to queued and rerun from the beginning.
- Local `/media` serving is explicit and configurable. Production-style deployments should set `MEDIA_SERVING_MODE=disabled` and serve media outside the API process.
- Frontend progress and ask updates are pushed through SSE. The bus is in-process plus optional Redis pub/sub; multi-instance deployments need Redis realtime enabled or sticky routing.
- PostgreSQL/pgvector is the required durable metadata/vector storage boundary.
- API key auth is optional and disabled when `API_KEYS` is unset.
- CORS is enabled globally.
- Several model/runtime stages are optional by default; unavailable optional capabilities are recorded, while required capabilities fail jobs.
- Visual embedding failures do not necessarily fail indexing; they are logged and traced as unavailable unless policy requires downstream capabilities elsewhere.
- OpenCV heuristic object detection is not a runtime fallback. Detector failures remain unavailable detector evidence, and capability policy decides whether indexing can continue.
- Direct structured answers come from the current sports related-knowledge adapter. It answers aggregate stat questions from imported related knowledge, not from video moment counts.
- Knowledge-seeded asset retrieval must resolve the ranked/stat subject from selected related knowledge before searching video evidence; unresolved seeds complete with a knowledge limitation instead of broad moment retrieval.
- Sports player identity is candidate-first. The current resolver can use match/game context, roster or lineup windows, nflverse play metadata, OCR/ASR/VLM text, jersey/helmet/ReID/contact evidence hooks, and MOT track IDs, but it does not implement face-first stable identity.
