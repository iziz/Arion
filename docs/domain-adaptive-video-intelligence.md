# Domain-Adaptive Video Intelligence Platform

## Context

The interview brief describes a platform layer above two foundation-model capabilities:

- **Retrieval model**: finds semantically relevant video moments.
- **Generation model**: summarizes or analyzes selected video moments.

The platform problem is that sports analyst queries require facts the base models do not reliably own: player identity, roster/team history, competition, season, sport-specific event semantics, and confidence-aware grounding.

Arion implements this as an application-layer orchestration system rather than as model retraining.

## Current Arion Mapping

| Brief concept | Arion implementation |
| --- | --- |
| Marengo-style retrieval | Local text/visual embeddings plus vector stores in `server/localVectorStore.ts` and `server/localVisualVectorStore.ts` |
| Pegasus-style generation | Local grounded analysis generator in `server/analysisGenerator.ts` and pattern aggregation in `server/intelligence.ts` |
| Domain knowledge layer | Sports knowledge store in `server/sportsKnowledge.ts` plus imported provider data |
| Query orchestrator | `/api/ask` pipeline in `server/index.ts` and decision plan in `server/orchestrator.ts` |
| Domain event indexing | `server/domainIndex.ts` football and American-football event structures |
| Optional visual grounding | VLM worker bridge in `server/vlmWorkerClient.ts` and `scripts/qwen_vlm_worker.py` |

## Design Changes Applied

### 1. First-Class Sports Domain Groups

Arion now models sports domains explicitly:

- `sports.football`
- `sports.american_football`

This prevents a Premier League asset group from being treated as sufficient coverage for NFL/Mahomes queries. The route decision now checks the requested domain before marking a query as ready.

### 2. American Football Structured Events

American football event output now has sport-specific fields:

- `quarterback`
- `pressure`
- `pocket`
- `decision`
- `playType`

This supports queries such as:

> Find Patrick Mahomes scramble plays under pressure, then generate a breakdown of his decision-making pattern.

The first version is intentionally heuristic: it uses text, OCR, coarse vision cues, and optional VLM output. It does not claim route concepts, down-distance, defensive pressure attribution, or stable player tracking.

### 3. Confidence-Aware Scope Handling

The retrieval filter no longer drops a candidate only because `competition` or `season` scope is missing when stronger player and event evidence exists. Instead:

- Player/event constraints can keep the segment in the candidate set.
- Missing competition/season remains visible as `unknown` verification.
- Analysis gates can exclude weak or failed evidence before generating pattern claims.

This is important for partially indexed historical footage where old clips often lack clean season metadata.

### 4. Season Window Interpretation

The planner now distinguishes:

- `last 3 seasons`
- `last 3 seasons and compare to this season`

The second form expands to current season plus the previous three seasons. For Premier League in May 2026, this resolves to:

- `2025-26`
- `2024-25`
- `2023-24`
- `2022-23`

### 5. Domain-Aware VLM Routing

The VLM worker accepts both supported sports domains. The TypeScript client sends the domain selected by the asset group or segment, and merges VLM output back into the correct event schema.

## Query Workflows

### Haaland Through Ball Search

1. Parse query into `player=Erling Haaland`, `event=pass_receive`, `pass=through_ball`, `zone=final_third`.
2. Resolve Haaland through sports knowledge.
3. Retrieve vector/domain candidates from football-indexed assets.
4. Keep strong player/event candidates even when competition or season scope is missing.
5. Return moments with verification checks for player, event, pass type, field zone, competition, and season.

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

- Stable player identity still needs jersey/roster tracking, not just text or VLM inference.
- Field zone and pocket state remain heuristic until sport-specific calibration/tracking is added.
- Multi-camera game synchronization is not implemented.
- Large-scale ingestion needs distributed job queues and durable task state beyond the local queue.
- Provider sports knowledge should be versioned by weekly roster snapshots and transfer windows.

## MVP Execution Order

1. Harden ingestion and domain metadata coverage for Premier League and NFL asset groups.
2. Build identity resolution against roster snapshots and visible OCR/title/ASR evidence.
3. Add domain-specific retrieval gates and verification summaries.
4. Add VLM refinement for ambiguous clips.
5. Add analyst-facing review tools for low-confidence identity, season, and event labels.
