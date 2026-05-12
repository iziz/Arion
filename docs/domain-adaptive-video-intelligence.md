# Domain-Adaptive Video Intelligence Platform

Last checked against code: 2026-05-11.

## Context

The interview brief describes a platform layer above two foundation-model capabilities:

- **Retrieval model**: finds semantically relevant video moments.
- **Generation model**: summarizes or analyzes selected video moments.

The platform problem is that sports analyst queries require facts the base models do not reliably own: player identity, roster/team history, competition, season, sport-specific event semantics, and confidence-aware grounding.

Arion implements this as an application-layer orchestration system rather than as model retraining.

## Current Arion Mapping

| Brief concept | Arion implementation |
| --- | --- |
| Marengo-style retrieval | Text/visual embeddings plus PostgreSQL/pgvector stores in `server/postgres/*VectorRepository.ts`, reached through `server/localVectorStore.ts` and `server/localVisualVectorStore.ts` |
| Pegasus-style generation | Local grounded analysis generator in `server/analysisGenerator.ts` and pattern aggregation in `server/intelligence.ts` |
| Related knowledge layer | Generic knowledge facade in `server/knowledge/*` with the current sports adapter under `server/knowledge/adapters/sports/*` plus imported provider data |
| Query orchestrator | `/api/ask` operation pipeline in `server/workflows/ask/*`, model-backed planning in `server/llmQueryPlanner.ts`, and decision plans in `server/orchestrator.ts` |
| Domain event indexing | `server/domainIndex/*` football and American-football event builders, plus `server/domainIndex/matchIdentityResolver.ts` for sports context and identity resolution |
| Optional visual and planning model | VLM worker bridge in `server/vlmWorkerClient.ts` and `scripts/qwen_vlm_worker.py` for video/domain reasoning and `/plan/query` fallback |

## Design Changes Applied

### 1. First-Class Sports Domain Groups

Arion now models sports domains explicitly:

- `sports.football`
- `sports.american_football`

This prevents a Premier League asset group from being treated as sufficient coverage for NFL/Mahomes queries. The route decision now checks the requested domain before marking a query as ready.

### 2. Sports Base Template and Domain Strategies

Sports indexing now uses a shared base contract plus domain-specific strategies:

- `sports.base` defines common evidence rules, context output, clock mappings, identity candidates, skip policy, and evaluator expectations.
- `sports.football` specializes the contract with match activities, lineup windows, SoccerNet-style action spots, and football match clocks.
- `sports.american_football` specializes the contract with nflverse play metadata, `gameId`, `playId`, quarter clock, down-distance, yardline, participants, and MOT/helmet/contact evidence hooks.

This keeps common sports rules stable while preventing domain-specific semantics from leaking across sports.

### 3. American Football Structured Events

American football event output now has sport-specific fields:

- `quarterback`
- `pressure`
- `pocket`
- `decision`
- `playType`
- `playMetadata`
- `participants`
- `tracking`

This supports queries such as:

> Find Patrick Mahomes scramble plays under pressure, then generate a breakdown of his decision-making pattern.

The first version is still evidence-gated: it uses text, OCR, coarse vision cues, optional VLM output, nflverse play metadata, and MOT hooks. It exposes down-distance and play metadata when aligned evidence exists, but it does not fabricate route concepts, calibrated pressure attribution, contact detections, or stable helmet identity when those detectors are not connected.

### 4. Match/Game Context Identity Resolution

Sports identity resolution runs after domain event enrichment and before extractive summaries, embedding, and vector upsert.

It writes:

- `matchContexts[]`
- `matchContexts[].videoRanges[]`
- `matchContexts[].clockMappings[]`
- `activeRosterWindows[]`
- `playerIdentityCandidates[]`
- `trackIdentityAssignments[]`

This supports edited videos where one asset contains clips from multiple matches or games. Each segment can carry its own context ids and clock mappings.

### 5. Confidence-Aware Scope Handling

The retrieval filter now evaluates domain filters as `trusted`, `weak`, or `failed`. It no longer drops a candidate only because `competition` or `season` scope is missing when stronger player and event evidence exists. Instead:

- Trusted structured player/event/scope constraints satisfy the filter.
- Text-only event or weak scope context can keep the segment in the candidate set as weak evidence.
- Trusted structured event evidence that conflicts with the requested event or role fails the candidate before ranking.
- Missing competition/season remains visible as `unknown` verification.
- Analysis gates can exclude weak or failed evidence before generating pattern claims.

This is important for partially indexed historical footage where old clips often lack clean season metadata.

### 6. Season Window Interpretation

The planner now distinguishes:

- `last 3 seasons`
- `last 3 seasons and compare to this season`

The second form expands to current season plus the previous three seasons. For Premier League in May 2026, this resolves to:

- `2025-26`
- `2024-25`
- `2023-24`
- `2022-23`

### 7. Domain-Aware VLM Routing

The VLM worker accepts both supported sports domains. The TypeScript client sends the domain selected by the asset group or segment, and merges VLM output back into the correct event schema.

### 8. Knowledge-Seeded Stat Moment Retrieval

Ranking/stat questions that ask for matching video moments use an explicit hybrid route:

- `knowledge_seeded_asset_evidence + moment_retrieval + grounding`

The ask workflow first builds a temporary structured knowledge plan, resolves the ranked/stat subject from selected related knowledge, and only then builds the video retrieval plan with concrete player and event filters. If the subject cannot be resolved, Arion returns the knowledge limitation instead of silently broadening to generic moment retrieval.

## Query Workflows

### Haaland Through Ball Search

1. Parse query into `player=Erling Haaland`, `event=pass_receive`, `pass=through_ball`, `zone=final_third`.
2. Resolve Haaland through the selected related-knowledge adapter.
3. Retrieve vector/domain candidates from football-indexed assets.
4. Keep strong player/event candidates when competition or season scope is missing only as weak evidence; reject candidates whose trusted structured events conflict with the requested pass/role/event.
5. Return moments with verification checks for player, event, pass type, field zone, competition, and season.

### Leaderboard-to-Moment Retrieval

1. Parse the query into `metric=goals`, `statMode=leaderboard`, and a video-moment intent.
2. Route as `knowledge_seeded_asset_evidence`.
3. Resolve the leaderboard subject from imported related knowledge.
4. Build retrieval filters such as `player=<resolved leader>`, `event=shot`, and `role=shooter`.
5. Search indexed video evidence for that resolved subject and surface any missing or weak video evidence separately from the knowledge answer.

### Son Dribbling Pattern Analysis

1. Parse query into `player=Son Heung-min`, `event=dribble`, and a comparison season window.
2. Retrieve dribble candidates from indexed football assets.
3. Aggregate patterns by event type, field zone, ball direction, season, and role grounding.
4. Generate only over evidence that passes the analysis trust gate.
5. Surface missing season scope as a limitation rather than as a silent false negative.

### Mahomes Scramble Breakdown

1. Parse query into `domain=sports.american_football`, `player=Patrick Mahomes`, `event=scramble`.
2. Check for an American-football-indexed asset group.
3. If unavailable, return an orchestration fallback explaining that the domain is not indexed.
4. Once NFL footage is ingested under `sports.american_football`, index scramble/pressure/pocket/decision cues.
5. Generate decision-pattern analysis only from retrieved, verified scramble candidates.

## Remaining Gaps

- Stable player identity still needs stronger helmet assignment, ReID, and contact/track models. Current tracking can add heuristic kit-color clusters and crop-based jersey number candidates for visible player separation, but identity output remains candidate-first unless domain context, clock, participant/roster evidence, and track evidence agree.
- Field zone and pocket state remain heuristic until sport-specific calibration/tracking is added.
- Multi-camera game synchronization is not implemented.
- Large-scale ingestion already has Redis/BullMQ dispatch and persisted job/ask records, but multi-region scheduling, autoscaling, and cross-cluster queue ownership are not implemented.
- Provider knowledge should be versioned by weekly roster snapshots and transfer windows.

See [sports-domain-indexing.md](sports-domain-indexing.md) for the implementation and operation details.

## MVP Execution Order

1. Harden ingestion and domain metadata coverage for Premier League and NFL asset groups.
2. Build identity resolution against roster snapshots and visible OCR/title/ASR evidence.
3. Add domain-specific retrieval gates and verification summaries.
4. Add VLM refinement for ambiguous clips.
5. Add analyst-facing review tools for low-confidence identity, season, and event labels.
