# Arion

Arion is a local TwelveLabs-like service prototype for video ingest, index management, asynchronous jobs, timeline search, analysis, webhook delivery, and operational event logs.

## What It Implements

- Index creation with model and modality configuration
- Local video/audio upload
- Async indexing and reindexing jobs with progress states
- `ffprobe` metadata extraction
- Local S3/R2-style object storage under `.data/object-storage`
- Local queue runner for indexing and reindexing jobs
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
- Persistent vector storage in PostgreSQL + pgvector, with `.data/vector-store.json` fallback when `DATABASE_URL` is unset
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

```text
React Console
  -> Express API
  -> Index / Asset / Job Services
  -> Local Object Storage Adapter
  -> Local Queue Runner
  -> ffprobe Metadata
  -> Local ASR / OCR / Visual Runtime
  -> Local Timeline + Sentence-Transformers Embedding Index
  -> OpenCLIP Keyframe Visual Index
  -> Local Vector Store
  -> Search / Analyze APIs
  -> Webhook Dispatcher
  -> Local Billing Ledger
  -> Event Log
  -> Observability: OpenTelemetry Spans + JSON Logs + Latency Metrics
```

The indexing and analysis logic is intentionally adapter-friendly. The local deterministic implementation can later be replaced with production ASR, OCR, embedding models, vector databases, and queue infrastructure.

## Commands

```bash
npm install
npm run dev
npm run build
npm run db:check
npm run db:migrate
npm run db:seed
npm run db:reset
npm run embeddings:rebuild
npm run text:repair
npm run models:doctor
npm run models:doctor:ai
```

The web app runs on `http://localhost:5173`, and the API runs on `http://localhost:8787`.
Local environment values are loaded from `.env` automatically when present.

## API

- `GET /api/health`
- `GET /api/metrics`
- `GET /api/db/status`
- `GET /api/observability`
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
- Set `UPLOAD_MAX_BYTES=8589934592` or another byte value to adjust the local upload limit. The default is 8GB.
- Set `LOCAL_AI_PYTHON=/path/to/python` if Whisper/PaddleOCR are installed in a dedicated virtual environment.
- Set `WHISPER_MODEL=large-v3|large-v3-turbo|small|medium|...` to choose the local Whisper model.
- Set `WHISPER_BACKEND=whispercpp`, `WHISPER_CPP_BIN=/path/to/whisper-cli`, and `WHISPER_CPP_MODEL=/path/to/ggml-large-v3-turbo.bin` to use whisper.cpp for ASR.
- Set `WHISPER_LANGUAGE=auto` to let Whisper detect the spoken language, or set a specific language code.
- Set `WHISPERX_MODEL=large-v3` and `WHISPERX_HF_TOKEN=...` to enable optional WhisperX speaker diarization.
- Set `PADDLEOCR_LANG=auto` to run OCR language candidates based on asset metadata, or set `en|korean|ch|...` to force one language pack.
- Set `VISION_DETECTOR_BACKEND=auto|ultralytics|rfdetr` to choose the person/ball detector. YOLO uses `VISION_DETECTOR_MODEL`, RF-DETR uses `VISION_RFDETR_MODEL`, and missing detector backends are marked unavailable.
- Set `VISION_TRACKER=bytetrack.yaml` to run Ultralytics ByteTrack/BoT-SORT tracking when `ultralytics` is installed.
- Set `SOCCERNET_ACTION_SPOTTING_COMMAND=/path/to/spotter` or `SOCCERNET_ACTION_SPOTS_JSON=/path/to/predictions.json` to import SoccerNet-style action spotting results as trusted sports domain evidence.
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

## Local AI Setup

Python 3.10-3.12 is recommended for PaddleOCR/PaddlePaddle compatibility.

```bash
python3 -m venv .venv-ai
. .venv-ai/bin/activate
python -m pip install -r requirements.local-ai.txt
LOCAL_AI_PYTHON="$PWD/.venv-ai/bin/python" npm run dev
```

The runtime extracts 16 kHz mono WAV audio with FFmpeg, derives speech/music regions with FFmpeg VAD-style silence detection, then tries `faster-whisper` first and `openai-whisper` second. WhisperX diarization is optional because pyannote-backed diarization requires `WHISPERX_HF_TOKEN` or `HF_TOKEN`. PaddleOCR runs over frames extracted from the uploaded video with FFmpeg and can try multiple OCR language candidates when `PADDLEOCR_LANG=auto`.
The current local setup uses `.venv-ai` with Python 3.11, `faster-whisper`, `openai-whisper`, `whisperx`, `paddleocr`, `paddlepaddle`, `sentence-transformers`, and optional `ultralytics`/`rfdetr`/`SoccerNet` backends.

## Local Embeddings

The default semantic embedding model is `intfloat/multilingual-e5-base`, which produces normalized 768-dimensional vectors for transcript, OCR, visual labels, tags, and timeline text. Query text is embedded with the same model before vector search.
The default visual embedding model is OpenCLIP `ViT-L-14/datacomp_xl_s13b_b90k`, which produces normalized 768-dimensional vectors for generated keyframes and visual text queries. `ViT-B-32/laion2b_s34b_b79k` remains usable by setting the environment variables back to that model and `VISUAL_EMBEDDING_DIMENSIONS=512`.

```bash
npm run embeddings:rebuild
```

Use this command after changing `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `VISUAL_EMBEDDING_MODEL`, `VISUAL_EMBEDDING_PRETRAINED`, or `VISUAL_EMBEDDING_DIMENSIONS`. If the text model runtime is unavailable, the app falls back to deterministic keyword vectors so local indexing can continue. If the visual model runtime is unavailable, visual vectors are skipped while text search remains available.

## PostgreSQL + pgvector

Set `DATABASE_URL` to switch storage from `.data/db.json` and `.data/vector-store.json` to PostgreSQL.

```bash
brew install postgresql@17 pgvector
brew services start postgresql@17

/opt/homebrew/opt/postgresql@17/bin/psql -d postgres -c "CREATE ROLE video_intelligence LOGIN PASSWORD 'video_intelligence';"
/opt/homebrew/opt/postgresql@17/bin/createdb -O video_intelligence video_intelligence
/opt/homebrew/opt/postgresql@17/bin/psql -d video_intelligence -c "CREATE EXTENSION IF NOT EXISTS vector;"

cp .env.example .env
npm run db:check
npm run db:migrate
npm run db:seed
npm run dev
```

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

If the `vector` extension is available, `app_vectors.embedding` and `app_knowledge_vectors.embedding` are created as `vector(768)` columns and vector distance search uses pgvector. If the extension is unavailable, vectors are still stored in PostgreSQL as JSON and searched in the app process as a local fallback.
Visual vectors are stored in `app_visual_vectors.embedding vector(512)` when pgvector is available.
Segments with missing or incompatible embeddings keep their JSON vector payload but leave the pgvector column empty, so migrations can safely preserve older local data.
`npm run db:reset` truncates app tables and recreates the default local user/index. It does not delete object-storage files under `.data/object-storage`.

## Production Extension Points

- Replace local uploads with S3, R2, GCS, or Azure Blob Storage.
- Replace in-memory async jobs with Redis, SQS, Pub/Sub, Kafka, or RabbitMQ.
- Add multimodal image/keyframe embeddings, shot detection, and stronger ranking signals.
- Add tenant isolation, production metering, external OpenTelemetry exporters, and hosted log/metric backends.
