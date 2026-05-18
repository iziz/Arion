# npm Scripts

Last checked against `package.json`: 2026-05-11.

This document is the canonical reference for `package.json` scripts. Keep it in sync when scripts are added, renamed, or removed.

## Common Workflows

| Goal | Command | Notes |
| --- | --- | --- |
| Install dependencies | `npm install` | Required before any local script. |
| Start standard local development | `npm run dev` | Starts Docker Redis/PostgreSQL, API, asset worker, ask worker, and Vite. |
| Start full local AI development | `npm run dev:full` | Starts everything in `dev`, plus the Python model runtime service and VLM worker from `.venv-ai`. |
| Check infra and database state | `npm run infra:check && npm run db:check` | Verifies Docker Redis/PostgreSQL and pgvector-backed app tables. |
| Run tests | `npm test` / `npm run test` | Runs Node's test runner against `tests/**/*.test.ts`. |
| Type-check and build frontend | `npm run build` | Runs `tsc --noEmit` and `vite build`. |
| Rebuild all indexed assets and knowledge vectors | `npm run indexes:rebuild -- --all` | Reindexes source assets and rebuilds related knowledge vectors. |
| Run model dependency diagnostics | `npm run models:doctor:ai` | Uses `.venv-ai/bin/python`; use `models:doctor` for the system Python. |

## Development Runtime

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run dev` | `dev:cleanup`, `dev:infra`, then `dev:api`, `dev:worker:run`, `dev:ask-worker:run`, `dev:web` concurrently | Standard local development topology. |
| `npm run dev:full` | `dev:cleanup`, `dev:infra`, then `models:runtime:ai`, `models:vlm:ai`, `dev:api`, `dev:worker:run`, `dev:ask-worker:run`, `dev:web` concurrently | Full local AI topology. |
| `npm run dev:cleanup` | `tsx scripts/dev_process_guard.ts` | Clears stale local development processes before starting a new stack. |
| `npm run dev:infra` | `tsx scripts/docker_infra.ts up` | Starts Docker Redis/PostgreSQL and waits for readiness. |
| `npm run dev:api` | `ARION_DOCKER_INFRA=true tsx watch server/index.ts` | Watches the Express API process. |
| `npm run dev:worker` | `dev:infra`, then `dev:worker:run` | Starts only the asset worker in watch mode with Docker infra. |
| `npm run dev:worker:run` | `ARION_DOCKER_INFRA=true tsx watch server/jobWorker.ts` | Watches the BullMQ asset indexing worker. |
| `npm run dev:ask-worker` | `dev:infra`, then `dev:ask-worker:run` | Starts only the ask worker in watch mode with Docker infra. |
| `npm run dev:ask-worker:run` | `ARION_DOCKER_INFRA=true tsx watch server/askWorker.ts` | Watches the BullMQ ask operation worker. |
| `npm run dev:web` | `tsx scripts/wait_for_dev_api.ts`, then `dev:web:run` | Waits for API health before starting Vite. |
| `npm run dev:web:run` | `vite --host 0.0.0.0` | Starts the Vite dev server. |

Standard host development uses `ARION_DOCKER_INFRA=true` so Redis and PostgreSQL URLs point at the Docker-managed ports instead of unrelated local services.

## Infrastructure

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run infra:up` | `tsx scripts/docker_infra.ts up` | Starts Docker Redis and PostgreSQL. |
| `npm run infra:check` | `tsx scripts/docker_infra.ts check` | Checks Docker Redis/PostgreSQL readiness. |
| `npm run infra:down` | `tsx scripts/docker_infra.ts down` | Stops Docker Redis/PostgreSQL. |
| `npm run infra:logs` | `docker compose logs -f redis postgres` | Tails Redis/PostgreSQL logs. |

## Process Entrypoints

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run api` | `tsx server/index.ts` | Runs the API process without watch mode. |
| `npm run worker` | `dev:infra`, then `ARION_DOCKER_INFRA=true npm run worker:run` | Runs the asset worker without watch mode. |
| `npm run worker:run` | `tsx server/jobWorker.ts` | Asset worker entrypoint. |
| `npm run ask-worker` | `dev:infra`, then `ARION_DOCKER_INFRA=true npm run ask-worker:run` | Runs the ask worker without watch mode. |
| `npm run ask-worker:run` | `tsx server/askWorker.ts` | Ask worker entrypoint. |
| `npm run preview` | `vite preview --host 0.0.0.0` | Previews the built frontend. |
| `npm start` | `node dist-server/index.js` | Packaged server entrypoint when a `dist-server` build artifact exists. |

## Verification

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run build` | `tsc --noEmit && vite build` | Type-checks TypeScript and builds the Vite client. |
| `npm test` / `npm run test` | `node --import tsx --test tests/**/*.test.ts` | Runs the full TypeScript test suite. |

Useful targeted test pattern:

```bash
npm test -- tests/matchIdentityResolver.test.ts tests/domainConfig.test.ts
```

The current package script includes `tests/**/*.test.ts` before forwarded arguments, so the full test suite still runs. Use this command as a visible intent marker, not as a strict test filter.

## Database and Data Maintenance

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run db:check` | `ARION_DOCKER_INFRA=true tsx scripts/postgres_check.ts` | Checks PostgreSQL, pgvector, vector columns, HNSW indexes, row counts, and metrics. |
| `npm run legacy:migrate` | `dev:infra`, then `tsx scripts/migrate_legacy_to_docker.ts --copy-app-data --archive-legacy-stores` | One-way migration from legacy local JSON stores into Docker PostgreSQL/object storage. |
| `npm run docker:migrate:legacy` | `npm run legacy:migrate` | Alias for legacy migration. |
| `npm run video:purge` | `dev:infra`, then `tsx scripts/purge_video_data.ts` | Purges video assets, jobs, queues, vectors, tracking records, and media while preserving knowledge/users. |
| `npm run db:seed` | `ARION_DOCKER_INFRA=true tsx scripts/postgres_seed.ts` | Seeds default local database records. |
| `npm run db:reset` | `ARION_DOCKER_INFRA=true tsx scripts/postgres_reset.ts` | Resets app tables and default records without deleting object-storage files. |

Use `db:reset` only when local data loss is intended. Use `video:purge` when knowledge vectors and user records should remain intact.

## Docker Application Runtime

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run docker:build` | `docker compose --profile app build` | Builds containerized app services. |
| `npm run docker:up` | `docker compose --profile app up --build` | Runs web, API, workers, Redis, and PostgreSQL. |
| `npm run docker:full` | `docker compose --profile app --profile ai up --build` | Runs app services plus Python model runtime and VLM services. |
| `npm run docker:down` | `docker compose --profile app --profile ai down` | Stops app and AI profile services. |
| `npm run docker:logs` | `docker compose --profile app --profile ai logs -f` | Tails logs for app and AI services. |

## Knowledge Imports and Sports Templates

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run knowledge:football-data` | `tsx scripts/import_football_data.ts` | Imports football-data provider knowledge. |
| `npm run knowledge:football-data-uk` | `tsx scripts/import_football_data_uk.ts` | Imports UK football-data provider knowledge. |
| `npm run knowledge:statsbomb` | `tsx scripts/import_statsbomb_open_data.ts` | Imports StatsBomb open-data knowledge. |
| `npm run knowledge:statbunker` | `tsx scripts/import_statbunker.ts` | Imports StatBunker knowledge. |
| `npm run knowledge:nflverse` | `tsx scripts/import_nflverse.ts` | Imports nflverse American-football play metadata. |
| `npm run knowledge:american-football-action-spots` | `tsx scripts/build_american_football_action_spots.ts` | Builds American-football timestamp action spot prediction JSON from the template generator. |
| `npm run knowledge:sync-current` | `tsx scripts/sync_current_sports_knowledge.ts` | Syncs current sports knowledge into the local store. |
| `npm run knowledge:vectors:rebuild` | `tsx scripts/rebuild_knowledge_vectors.ts` | Rebuilds related knowledge vector rows. |

Typical sports knowledge refresh:

```bash
npm run knowledge:nflverse
npm run knowledge:sync-current
npm run knowledge:vectors:rebuild
```

## Rebuild and Repair

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run embeddings:rebuild` | `tsx scripts/rebuild_embeddings.ts` | Rebuilds text and visual embeddings for existing indexed assets. |
| `npm run indexes:rebuild` | `tsx scripts/rebuild_all_indexes.ts` | Rebuilds asset indexes and/or knowledge vectors. |
| `npm run domain:vlm:refine` | `tsx scripts/refine_vlm_domain.ts` | Re-runs domain-specific VLM refinement for eligible assets. |
| `npm run text:repair` | `tsx scripts/repair_text_encoding.ts` | Repairs older mojibake/CJK text records. |

Common `indexes:rebuild` options:

```bash
npm run indexes:rebuild -- --all
npm run indexes:rebuild -- --skipKnowledge
npm run indexes:rebuild -- --skipAssets
npm run indexes:rebuild -- --batchSize=128
```

Without `--all`, `indexes:rebuild` reindexes only assets that are already indexed.

## Model Runtime Services

| Script | Runs | Purpose |
| --- | --- | --- |
| `npm run models:doctor` | `python3 scripts/model_doctor.py` | Checks model/runtime dependencies with the system Python. |
| `npm run models:doctor:ai` | `./.venv-ai/bin/python scripts/model_doctor.py` | Checks model/runtime dependencies with `.venv-ai`. |
| `npm run models:runtime` | `python3 scripts/arion_model_runtime_service.py` | Starts the FastAPI model runtime service with the system Python. |
| `npm run models:runtime:ai` | `./.venv-ai/bin/python scripts/arion_model_runtime_service.py` | Starts the FastAPI model runtime service with `.venv-ai`. |
| `npm run models:vlm` | `python3 scripts/qwen_vlm_worker.py` | Starts the VLM worker with the system Python. |
| `npm run models:vlm:ai` | `./.venv-ai/bin/python scripts/qwen_vlm_worker.py` | Starts the VLM worker with `.venv-ai`. |
| `npm run eval:vlm -- --fixture path/to/vlm-fixture.json` | `python3 scripts/eval_vlm_worker.py` | Runs VLM worker fixture checks against `VLM_WORKER_URL`. |
| `npm run benchmark:detectors -- --manifest path/to/detector-manifest.json` | `python3 scripts/benchmark_detectors.py` | Benchmarks Ultralytics and RF-DETR detector backends on sampled frames. |

Use the `:ai` variants when local AI dependencies were installed into `.venv-ai`, which is the recommended local setup.
