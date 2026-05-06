# Arion

Arion is a local TwelveLabs-like service prototype for video ingest, index management, asynchronous jobs, timeline search, analysis, webhook delivery, and operational event logs.

## What It Implements

- Index creation with model and modality configuration
- Local video/audio upload
- Async indexing and reindexing jobs with progress states
- `ffprobe` metadata extraction
- Local S3/R2-style object storage under `.data/object-storage`
- Configurable local `/media` serving boundary for development, with production mode that disables API-process media serving
- Redis/BullMQ worker process for indexing and reindexing jobs
- Redis/BullMQ ask operation queue with a separate TypeScript ask worker process
- Queue outbox dispatch for asset jobs and ask operations
- Indexing stage checkpoints with checkpoint-aware worker recovery
- Server-Sent Events progress updates through `/api/events/stream`
- Python model runtime service boundary for ASR, OCR, vision, and embedding runtimes
- Whisper `large-v3` adapter for real local ASR, without metadata-as-transcript fallback
- FFmpeg audio extraction and local VAD/music-region detection
- Optional WhisperX speaker diarization when `whisperx` and a Hugging Face token are configured
- PaddleOCR adapter for real frame OCR, with metadata fallback when dependencies are unavailable
- Local visual-understanding sampler
- Segment-level Whisper timestamp mapping
- Generated keyframes for timeline/search thumbnails
- FFmpeg scene/shot boundary detection for scene-aware timeline segments
- Timeline segment generation with modality labels and local semantic text embeddings
- OpenCLIP keyframe image embeddings for visual search over generated thumbnails
- Optional sports-only domain indexing for football asset groups, with ontology captions, event labels, and structured field/player/ball event placeholders
- Persistent application and vector storage in Docker-managed PostgreSQL + pgvector
- Hybrid search ranking over lexical matches, text semantic vectors, visual vectors, source quality, confidence, and recency
- Analysis endpoint for selected indexed assets
- Webhook registration and delivery logs
- Event log persisted to `.data/events.ndjson`
- OpenTelemetry tracing with local in-memory span export
- Structured JSON logs persisted to `.data/logs/app.ndjson`
- Request id correlation through `x-request-id` and `traceparent` response headers
- Per-stage latency metrics for indexing, search, vector upserts, and model runtimes
- Model runtime latency/error dashboard in the React console
- Local user/API-key registry and billing ledger
- React dashboard for indexes, ingest, asset status, search, analysis, jobs, webhooks, events, database status, and observability

## Architecture

Sports-domain indexing details live in [docs/sports-domain-indexing.md](docs/sports-domain-indexing.md).

```text
React Console
  -> Express API Process
     -> TypeScript Application Services
        -> Queue Outbox -> Redis/BullMQ Ask Queue -> Ask Worker Process
        -> Queue Outbox -> Redis/BullMQ Asset Queue -> Asset Job Worker Process
        -> SSE Event Stream: /api/events/stream
        -> Runtime Service Boundary
           -> Python Runtime Services: ASR / OCR / Vision / Embedding
           -> VLM Worker Service
           -> Node Runtime Integrations: FFmpeg / OpenAI HTTP
        -> Application Persistence: PostgreSQL app_* tables
        -> Media Object Storage: source media and generated artifacts
        -> Observability Sink: OpenTelemetry spans, NDJSON logs, latency metrics
  -> Media Delivery Boundary
     -> Object storage / CDN / reverse proxy in production
     -> Express /media static serving only in local-static development mode
```

The indexing, search, and analysis logic is adapter-friendly. Production-oriented boundaries are explicit: application state is separate from binary media storage, long-running work runs in worker processes, and model runtimes are reached through service boundaries.

## Commands

The full npm script reference lives in [docs/npm-scripts.md](docs/npm-scripts.md).

```bash
npm install
npm run dev
npm run dev:full
npm test
npm run build
npm run models:doctor:ai
npm run models:runtime:ai
npm run infra:check
npm run db:check
npm run indexes:rebuild -- --all
npm run docker:up
npm run docker:full
```

Use `npm run dev` for the standard local stack and `npm run dev:full` when local AI runtime services should be started with the app.
The web app runs on `http://localhost:5173`, the API runs on `http://localhost:8787`, and the local Python runtime service defaults to `http://127.0.0.1:8792`.
Asset job execution, ask operation execution, and application persistence require Docker-managed Redis and PostgreSQL in the standard development path. `npm run dev`, `npm run dev:full`, `npm run dev:worker`, `npm run dev:ask-worker`, `npm run worker`, and `npm run ask-worker` run `dev:infra` first, which starts `redis` and `postgres` through Docker Compose and waits for readiness.
`REDIS_URL` defaults to `redis://127.0.0.1:16379` for Docker-backed host development, and Docker app services use `redis://redis:6379`.
The Vite dev server allows `.ngrok-free.dev` hosts by default for HTTPS tunnel testing. Set `VITE_DEV_ALLOWED_HOSTS` to a comma-separated list when additional tunnel or LAN hostnames need access.
Local environment values are loaded from `.env` automatically when present.

## API

- `GET /api/health`
- `GET /api/metrics`
- `GET /api/db/status`
- `GET /api/storage/status`
- `GET /api/observability`
- `GET /api/model-capabilities`
- `GET /api/users`
- `GET /api/billing`
- `GET /api/events`
- `GET /api/indexes`
- `POST /api/indexes`
- `GET /api/assets`
- `POST /api/assets`
- `POST /api/indexes/:id/assets`
- `POST /api/assets/:id/reindex`
- `GET /api/jobs`
- `POST /api/jobs/:id/retry`
- `POST /api/ask`
- `GET /api/ask/:id`
- `GET /api/search?q=...`
- `GET /api/vector-search?q=...`
- `GET /api/visual-search?q=...`
- `POST /api/vector-store/rebuild`
- `POST /api/analyze`
- `POST /api/assets/:id/analyze`
- `GET /api/webhooks`
- `POST /api/webhooks`
- `POST /api/webhooks/:id/test`
- `POST /api/webhooks/:id/retry`
- Compatibility aliases: `GET /api/videos`, `POST /api/videos`, `POST /api/videos/:id/analyze`

## Local Runtime Behavior

- If `API_KEYS` is unset, the API is open for local development.
- If `API_KEYS` is set to a comma-separated list, requests must include `x-api-key`.
- A default local user exists with API key `local-dev-key`.
- A lightweight in-memory rate limiter protects the local API. Set `RATE_LIMIT_PER_MINUTE` to override the default local limit of `600`.
- Webhook URLs beginning with `log://` are marked delivered without a network call.
- Set `LOCAL_OBJECT_PROVIDER=local-s3` or `LOCAL_OBJECT_PROVIDER=local-r2` to switch the local object-storage namespace.
- Set `MEDIA_SERVING_MODE=local-static` to serve `.data/object-storage` through Express `/media` during local development.
- Set `MEDIA_SERVING_MODE=disabled` for production-style deployments where media is served by object storage, CDN, or a reverse proxy boundary instead of the API process.
- Set `MEDIA_STATIC_MAX_AGE=1h` or another cache-control max age for local static media responses.
- Set `UPLOAD_MAX_BYTES=8589934592` or another byte value to adjust the local upload limit. The default is 8GB.
- Set `UPLOAD_TEMP_MAX_AGE_MS=86400000` to control stale temp upload cleanup on API boot.
- Set `ASK_QUEUE_NAME`, `ASK_WORKER_CONCURRENCY`, and `ASK_QUEUE_RECONCILE_MS` to tune the durable ask operation queue and worker reconciliation behavior.
- Set `PYTHON_RUNTIME_MODE=service` to route Python model work through HTTP runtime services. Set `PYTHON_RUNTIME_MODE=direct` for local script execution during development.
- Set `PYTHON_RUNTIME_SERVICE_URL=http://127.0.0.1:8792` for the default combined local runtime service.
- Set `ASR_RUNTIME_SERVICE_URL`, `OCR_RUNTIME_SERVICE_URL`, `VISION_RUNTIME_SERVICE_URL`, or `EMBEDDING_RUNTIME_SERVICE_URL` to move those runtimes to separate hosts without changing the Node worker code.
- Set `PYTHON_RUNTIME_SERVICE_ATTEMPTS=2` or higher to retry transient runtime-service call failures before the workflow records the stage as failed.
- Set `LOCAL_AI_PYTHON=/path/to/python` if Whisper/PaddleOCR are installed in a dedicated virtual environment.
- Set `WHISPER_MODEL=large-v3|large-v3-turbo|small|medium|...` to choose the local Whisper model.
- Set `WHISPER_BACKEND=whispercpp`, `WHISPER_CPP_BIN=/path/to/whisper-cli`, and `WHISPER_CPP_MODEL=/path/to/ggml-large-v3-turbo.bin` to use whisper.cpp for ASR.
- Set `WHISPER_LANGUAGE=auto` to let Whisper detect the spoken language, or set a specific language code.
- Set `WHISPERX_MODEL=large-v3` and `WHISPERX_HF_TOKEN=...` to enable optional WhisperX speaker diarization.
- Set `PADDLEOCR_LANG=auto` to run OCR language candidates based on asset metadata, or set `en|korean|ch|...` to force one language pack.
- Set `VISION_DETECTOR_BACKEND=auto|ultralytics|rfdetr` to choose the person/ball detector. YOLO uses `VISION_DETECTOR_MODEL`, RF-DETR uses `VISION_RFDETR_MODEL`, and missing detector backends are marked unavailable.
- Set `VISION_TRACKER=bytetrack.yaml` to run Ultralytics ByteTrack/BoT-SORT tracking when `ultralytics` is installed.
- Set `SOCCERNET_ACTION_SPOTTING_COMMAND=/path/to/spotter` or `SOCCERNET_ACTION_SPOTS_JSON=/path/to/predictions.json` to import SoccerNet-style action spotting results as trusted sports domain evidence.
- Set `AMERICAN_FOOTBALL_ACTION_SPOTTING_COMMAND=/path/to/spotter` or `AMERICAN_FOOTBALL_ACTION_SPOTS_JSON=/path/to/predictions.json` to import American-football action spotting results as trusted sports domain evidence. Legacy `NFL_ACTION_*` names are also accepted.
- Set `CAPABILITY_*` values or the asset-group capability policy to `disabled|optional|required`. Required capabilities fail the indexing job when unavailable; optional capabilities only record unavailable traces.
- Set `EMBEDDING_MODEL=intfloat/multilingual-e5-base` and `EMBEDDING_DIMENSIONS=768` to choose the local semantic embedding model.
- Set `VISUAL_EMBEDDING_MODEL=ViT-L-14`, `VISUAL_EMBEDDING_PRETRAINED=datacomp_xl_s13b_b90k`, and `VISUAL_EMBEDDING_DIMENSIONS=768` to choose the local visual embedding model.
- Set `SCENE_THRESHOLD=0.3` to tune FFmpeg scene-boundary detection sensitivity.
- Enable `Sports domain indexing` when creating an asset group to add football ontology captions, event labels, and structured event metadata. This layer is asset-group scoped and is skipped for non-sports asset groups.
- Uploaded filenames and multipart text fields are normalized to UTF-8 NFC. Run `npm run text:repair` if older local records contain mojibake from Korean or CJK filenames.
- Every API response includes `x-request-id` and W3C `traceparent` headers for request correlation.
- Structured JSON logs are written to stdout and `.data/logs/app.ndjson`.
- `GET /api/observability` returns recent spans, recent logs, request latency, stage latency, and model runtime latency/error metrics.
- `GET /api/model-capabilities` returns the current local runtime dependency/capability check.

## Docker Runtime

Docker is the required infrastructure boundary for the standard runtime.

```bash
npm run infra:up
npm run infra:check
npm run infra:logs
npm run infra:down
```

Containerized application runtime:

```bash
npm run docker:up
npm run docker:full
npm run docker:down
```

The Compose stack defines these service boundaries:

- `postgres`: `pgvector/pgvector:pg17`
- `redis`: `redis:7.4-alpine`
- `api`: Express API process
- `asset-worker`: BullMQ asset job worker
- `ask-worker`: BullMQ ask operation worker
- `web`: Nginx static frontend with `/api` and `/media` reverse proxying
- `model-runtime`: FastAPI Python runtime service for ASR/OCR/vision/embedding
- `vlm`: FastAPI VLM service

The Docker application services use `.env.docker`; host development uses `.env` plus `ARION_DOCKER_INFRA=true` from npm scripts. That flag pins Redis/PostgreSQL URLs to Docker infra ports so unrelated local services are not used accidentally.

## Local AI Setup

Python 3.10-3.12 is recommended for PaddleOCR/PaddlePaddle compatibility.

```bash
python3 -m venv .venv-ai
. .venv-ai/bin/activate
python -m pip install -r requirements.local-ai.txt
LOCAL_AI_PYTHON="$PWD/.venv-ai/bin/python" npm run dev
```

Run the model runtime service with the same Python environment used for local AI dependencies:

```bash
npm run models:runtime:ai
```

`npm run dev:full` starts the Python runtime service, the optional VLM worker, the Express API, the Redis-backed asset worker, the Redis-backed ask worker, and the Vite frontend together.

The runtime extracts 16 kHz mono WAV audio with FFmpeg, derives speech/music regions with FFmpeg VAD-style silence detection, then tries `faster-whisper` first and `openai-whisper` second. WhisperX diarization is optional because pyannote-backed diarization requires `WHISPERX_HF_TOKEN` or `HF_TOKEN`. PaddleOCR runs over frames extracted from the uploaded video with FFmpeg and can try multiple OCR language candidates when `PADDLEOCR_LANG=auto`.
The current local setup uses `.venv-ai` with Python 3.11, `faster-whisper`, `openai-whisper`, `whisperx`, `paddleocr`, `paddlepaddle`, `sentence-transformers`, and optional `ultralytics`/`rfdetr`/`SoccerNet` backends.

`TIMELINE_MAX_SEGMENTS` controls the maximum generated timeline windows and keyframes per asset; the default is `120`. When raw scene windows exceed that limit, adjacent windows are merged across the full duration instead of truncating the tail of the video. Domain-neutral Video VLM analysis and domain-specific VLM refinement follow their eligible timeline/keyframe counts.

## Local Embeddings

The default semantic embedding model is `intfloat/multilingual-e5-base`, which produces normalized 768-dimensional vectors for transcript, OCR, visual labels, tags, and timeline text. Query text is embedded with the same model before vector search.
The default visual embedding model is OpenCLIP `ViT-L-14/datacomp_xl_s13b_b90k`, which produces normalized 768-dimensional vectors for generated keyframes and visual text queries. `ViT-B-32/laion2b_s34b_b79k` remains usable by setting the environment variables back to that model and `VISUAL_EMBEDDING_DIMENSIONS=512`.

```bash
npm run embeddings:rebuild
```

Use this command after changing `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `VISUAL_EMBEDDING_MODEL`, `VISUAL_EMBEDDING_PRETRAINED`, or `VISUAL_EMBEDDING_DIMENSIONS`. If the text model runtime is unavailable, the app falls back to deterministic keyword vectors so local indexing can continue. If the visual model runtime is unavailable, visual vectors are skipped while text search remains available.

To rebuild every local index from source videos, including full asset reindexing, Video VLM analysis when configured, text/visual vectors, and sports knowledge vectors:

```bash
npm run indexes:rebuild -- --all
```

Use `--skipKnowledge` to rebuild only asset indexes, `--skipAssets` to rebuild only knowledge vectors, and `--batchSize=128` to tune knowledge vector embedding batches. Without `--all`, the command reindexes only assets that are already indexed.

## PostgreSQL + pgvector

The standard development and operational topology uses Docker-managed PostgreSQL with pgvector and Docker-managed Redis.

```bash
cp .env.example .env
npm run infra:up
npm run db:check
npm run legacy:migrate
npm run db:seed
npm run dev
```

`npm run infra:up` runs `docker compose up -d redis postgres` and waits for Redis and PostgreSQL readiness. Host development uses project-scoped ports `16379` for Redis and `15432` for PostgreSQL by default to avoid accidentally connecting to unrelated local services. `npm run infra:down` stops the Compose stack.
`docker-compose.yml` uses `pgvector/pgvector:pg17`, so `POSTGRES_REQUIRE_PGVECTOR=true` is the expected Docker path. The runtime requires `DATABASE_URL`; local JSON files are only accepted as input to the explicit legacy migration command.

Operational settings:

- `POSTGRES_POOL_MAX` controls the Node `pg` pool size.
- `POSTGRES_CONNECTION_TIMEOUT_MS` and `POSTGRES_IDLE_TIMEOUT_MS` control pool behavior.
- `POSTGRES_REQUIRE_PGVECTOR=true` fails startup when the `vector` extension is unavailable.
- `PGSSLMODE=require` enables TLS for hosted Postgres connections.

The app creates these tables automatically:

- `app_indexes`
- `app_assets`
- `app_jobs`
- `app_webhooks`
- `app_events`
- `app_users`
- `app_billing`
- `app_vectors`
- `app_visual_vectors`
- `app_knowledge_vectors`
- `app_tracking_records`
- `app_ask_operations`
- `app_queue_outbox`
- `app_schema_migrations`

`app_vectors.embedding` and `app_knowledge_vectors.embedding` are created as `vector(EMBEDDING_DIMENSIONS)` columns and vector distance search uses pgvector. `app_visual_vectors.embedding` is created as `vector(VISUAL_EMBEDDING_DIMENSIONS)`.
Rows with incompatible embedding dimensions fail insertion and must be rebuilt with `npm run embeddings:rebuild` or `npm run indexes:rebuild`. Search only uses compatible pgvector rows.
`npm run db:check` reports Postgres readiness, pgvector mode, vector columns, HNSW indexes, vector row counts, migrations, and metrics.
`npm run db:reset` truncates app tables and recreates the default local user/index. It does not delete object-storage files under `.data/object-storage`.

Legacy migration from earlier local JSON development data is explicit and one-way:

```bash
npm run legacy:migrate
```

The migration imports legacy metadata/vector/tracking JSON files into Docker PostgreSQL, copies referenced media into the Docker app-data volume, and archives the old JSON stores. Orphan source-media directories are not synthesized into new assets; they are left in place unless the migration is run with its orphan-media deletion option.

## Production Extension Points

- Replace local uploads with S3, R2, GCS, or Azure Blob Storage.
- Serve media through object storage, CDN, or a reverse proxy with `MEDIA_SERVING_MODE=disabled` in the API process.
- Replace the Docker Redis instance with managed Redis, SQS, Pub/Sub, Kafka, or RabbitMQ if the deployment needs managed queue infrastructure.
- Add multimodal image/keyframe embeddings, shot detection, and stronger ranking signals.
- Add tenant isolation, production metering, external OpenTelemetry exporters, and hosted log/metric backends.
