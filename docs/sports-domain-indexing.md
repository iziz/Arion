# Sports Domain Indexing

Last checked against code: 2026-05-11.

This document summarizes the current sports-domain indexing work: American-football knowledge ingestion, template-driven action spotting, sports identity resolution, UI exposure, and operational commands.

## Goals

The sports layer is designed to keep generic video retrieval separate from related knowledge while still allowing selected related knowledge to ground search, identity, and analysis.

The current implementation supports two configured sports domains:

- `sports.football`: association football / soccer
- `sports.american_football`: American football / NFL-oriented knowledge

## Architecture Summary

```text
Asset group domain configuration
  -> knowledge-action stage
     -> domain-specific generator or external prediction adapter
     -> timestamp action JSON
  -> domain-index stage
     -> domain event enrichment
     -> optional domain VLM refinement
     -> sports identity resolver
        -> sports.base contract
        -> sports.football strategy
        -> sports.american_football strategy
  -> extractive-summary stage
  -> embedding/vector upsert
     -> domain and identity-enriched search text
Ask/search query planning
  -> model planner contract
     -> participants[] semantic direction
        -> action_source/action_target/subject
     -> evidence-gated player + role + event filters
  -> domain filter verification
     -> structured event role identity binding
```

## Sports Base Template

`sports.base` is a shared contract, not an event classifier. It defines the common rules every sports strategy must follow:

- Resolve game or match context before assigning player identity.
- Represent edited videos as multiple context video ranges with independent clock mappings.
- Keep OCR, ASR, VLM, tracking, detector, and knowledge evidence as separate evidence sources.
- Treat `trackId -> playerId` as candidate evidence unless context, clock, participant/roster evidence, and visual continuity agree.
- Emit skip reasons when required evidence is missing instead of fabricating domain context.

The base output contract is shared:

- `matchContexts[].videoRanges[]`
- `matchContexts[].clockMappings[]`
- `activeRosterWindows[]`
- `playerIdentityCandidates[]`
- `trackIdentityAssignments[]`
- domain `searchText` enrichment for downstream embeddings

## Football Strategy

The football strategy is registered as `sports.football.identity.strategy.v1`.

It specializes the base contract with:

- football registry match activities
- `matchId`
- home/away team evidence
- player mentions
- lineup activity
- substitution and red-card roster windows
- match minute parsing from OCR/ASR/VLM
- SoccerNet-style action spotting evidence when available

Football domain events can carry explicit pass participant roles:

- `football.passingPlayer`: the player who releases or initiates the pass
- `football.receivingPlayer`: the player who receives, controls, or is clearly targeted by the pass

These roles are evidence fields on the indexed event. They are not query-time labels and must not be swapped to satisfy a user search. Named roles require segment-local ASR/OCR/subtitle/VLM evidence that binds the player alias to the action direction. Asset titles, tags, broad metadata, and asset-level scope can support player mention or catalog context, but they do not bind `passingPlayer` or `receivingPlayer` by themselves.

Identity status remains conservative:

- `confirmed` requires confirmed match context, strong ASR/OCR/VLM text evidence, active roster window, track evidence, and clock evidence.
- Jersey OCR is candidate evidence unless roster and track evidence also support the same player. The tracker can now emit crop-based jersey number candidates on player tracks, but the identity resolver still requires match context and active-roster agreement before creating player candidates from those numbers.
- Tracking can now attach heuristic upper-body kit-color clusters (`team-1`, `team-2`, or `unknown`) to player tracks. These clusters separate visible players inside a match screen but are not mapped to home/away teams without additional scoreboard, roster, or manual evidence.

## Participant-Aware Query Planning

The Ask/search planner now represents named entities in actions through `participants[]`:

- `relation=action_source`: the entity initiates the action
- `relation=action_target`: the entity receives or is targeted by the action
- `relation=subject`: the entity is only the topic
- `relation=unknown`: direction is unclear

For football passes, `action_source` maps to `role=passer` and `eventType=pass_receive`; `action_target` maps to `role=receiver` and `eventType=pass_receive`.

Planner roles are not inferred through language-specific keyword overrides. Evidence-bearing participant constraints are required before inferred roles are promoted into search filters. A query such as `손흥민이 다른 선수한테 패스하는 장면 찾아줘` should plan as a named `action_source`, so retrieval verifies `Son Heung-min` against `football.passingPlayer.identity`.

Top-level planner `role` is deprecated for participant binding. It is ignored unless the role is backed by `participants[]` or supplied as an explicit caller filter.

## American Football Strategy

The American-football strategy is registered as `sports.american_football.identity.strategy.v1`.

It specializes the base contract with:

- nflverse play-by-play metadata
- `gameId`
- `playId`
- quarter and game clock
- down and distance
- yardline / `yardline100`
- passer/rusher/receiver participants
- MOT `trackId` evidence
- helmet/contact detector hooks in the output contract

American-football context can be resolved from either:

- domain events already carrying aligned `playMetadata`
- indexed video text evidence matching NFL teams, players, down-distance, quarter, and play description terms

The strategy deliberately avoids weak alignment from generic football text. nflverse play alignment is skipped when provider context or strong player/team/down-distance evidence is missing.

## Knowledge Action Spotting

Knowledge action spotting is now domain-specific:

| Domain | Adapter | Runtime source |
| --- | --- | --- |
| `sports.football` | `sports.football.soccernet` | SoccerNet-style external prediction JSON or command output |
| `sports.american_football` | `sports.american_football.action_spotting` | Inline template generator by default, with optional external JSON/command override |

For American football, the inline generator can produce timestamp action JSON from indexed video evidence without a pre-existing prediction file. It can attach nflverse `playMetadata` only when strong alignment gates pass.

## nflverse Knowledge Ingestion

`knowledge:nflverse` imports:

- NFL players
- season roster rows
- play-by-play rows
- roster facts
- play metadata records

The knowledge snapshot exposes `americanFootballPlays[]`, which is consumed by:

- the American-football action spot generator
- the sports identity resolver
- related-knowledge grounding and vector documents

## Asset Workflow Exposure

The asset workflow now exposes domain behavior in two places:

- Knowledge action node:
  - base template
  - domain strategy
  - generator kind
  - output schema count
  - runtime gates
  - skip conditions
  - benchmark coverage
- Domain result / timeline details:
  - match context count
  - track identity assignment count
  - match clock mapping count
  - per-segment context and clock evidence
  - per-segment track identity candidates
  - crop-based jersey number OCR candidates when the tracker sees isolated shirt numbers

## Knowledge UI Exposure

The Knowledge panel includes `Manifest`, `Generator`, and `Evaluator` tabs for each domain-specific template.

The manifest tab now also shows:

- sports base rules
- strategy specialization rules
- provider contracts
- evidence requirements
- output schema
- runtime gates
- skip conditions
- limitations

## Operational Commands

See [npm-scripts.md](npm-scripts.md) for the full command reference.

Common sports-domain commands:

```bash
npm run knowledge:nflverse
npm run knowledge:american-football-action-spots
npm run knowledge:sync-current
npm run knowledge:vectors:rebuild
npm run indexes:rebuild -- --all
```

Verification commands used for this change set:

```bash
npm test -- tests/matchIdentityResolver.test.ts tests/domainConfig.test.ts
npm run build
```

The package-level `test` script currently runs the full test suite because `tests/**/*.test.ts` is included before forwarded arguments.

## Reindexing Guidance

Existing uploaded videos do not need to be uploaded again.

To populate the new sports identity output or participant role event fields for existing football or American-football assets, re-run indexing from `domain-index`, run domain VLM refinement, or rebuild the affected indexes. The domain VLM refinement path rebuilds the base domain layer before merging VLM output, then rebuilds summaries and text vectors, so it can refresh stale stored role evidence without re-uploading media. Full video extraction is only required when upstream evidence changes, such as adding a new OCR, VLM, detector, ReID, helmet assignment, or contact model.

## Current Limitations

- Football player identity is still evidence-gated and candidate-first unless match context, clock, roster window, and track evidence agree.
- Kit-color clustering helps separate tracked players by visible uniform appearance, but it is heuristic and does not by itself prove player identity or team identity.
- Football passer/receiver identity depends on structured domain event evidence from action spots, VLM refinement, and segment-local OCR/ASR/subtitle text. Generic text, asset metadata, title aliases, or asset-level scope alone do not prove that a named player is the passer.
- American-football helmet assignment and contact detection are represented in the schema, but external detector integration is still model-dependent.
- nflverse is NFL-scoped; college or generic American-football footage can receive action labels but must not receive nflverse game/play alignment from weak evidence.
- Multi-camera synchronization and official broadcast timecode feeds are not implemented.

## Google Slides Update Checklist

Any project presentation should be updated to reflect these architecture changes:

- Replace a single "football" domain diagram with `sports.base -> sports.football / sports.american_football`.
- Add the `manifest + generator + evaluator` template contract.
- Show Knowledge action spotting as a domain-specific stage, not one SoccerNet-only path.
- Add the sports identity resolver after domain event enrichment and before extractive summaries plus embedding/vector upsert.
- Add participant-aware query planning with `participants[]`, including `action_source`/`action_target` direction and structured passer/receiver verification.
- Show edited videos as multiple match/game contexts with `videoRanges[]` and `clockMappings[]`.
- Add American-football data flow: nflverse play metadata, Big Data Bowl-style schema, helmet/contact/MOT hooks, and timestamp action JSON.
- Clarify that `trackId -> playerId` is evidence-gated and candidate-first.
- Add the operational command flow for knowledge refresh and index rebuild.
