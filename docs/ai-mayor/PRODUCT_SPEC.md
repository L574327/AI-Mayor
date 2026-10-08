> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# AI Mayor Core MVP Product Specification

## Purpose

AI Mayor turns a high-level city goal into a bounded sequence of autonomous Cities: Skylines II decisions. It is a runtime owned by 5ire, not a long-lived chat turn. The CS2 MCP remains responsible for game observation and deterministic execution.

## MVP user outcome

A user starts a Mayor session with a goal, a maximum session spend in CNY, and a minimum DeepSeek balance. The Mayor repeatedly observes the city, asks DeepSeek V4 Flash for one structured plan, executes one safe batch, advances simulation time, and observes again. It runs without repeated user messages and can be stopped safely.

## Tick contract

Each normal tick performs:

1. Refresh DeepSeek balance and enforce the cost guard before any model request.
2. Call `cs2_mayor_snapshot` once.
3. Build bounded context from the goal, compact memory, current snapshot, previous compact batch result, and one pending command.
4. Make one non-streaming DeepSeek JSON decision request. No MCP tools are exposed to the model.
5. Parse a strict `MayorPlan` and validate every exact prefab/zone/entity against the current Snapshot planning catalog.
6. Call `cs2_mayor_execute_actions` at most once for 1-20 actions.
7. Advance CS2 simulation for the requested duration and wait for auto-pause.
8. Replace current snapshot/result references and update bounded memory.

## MayorPlan

The stable plan shape is:

```json
{
  "status": "Residential demand is high; prepare a small eastward expansion.",
  "actions": [],
  "simulation": { "run": true, "hours": 4, "speed": 4 },
  "memoryUpdate": {
    "phase": "stable growth",
    "strategy": "Expand in small demand-led blocks.",
    "importantAreas": [],
    "recentMilestones": [],
    "unresolvedProblems": [],
    "nextGoal": "Recheck demand after development."
  },
  "stop": { "requested": false }
}
```

Actions are limited to `build_road`, `zone`, `place_building`, and `upgrade_road`. Demolition, loans, save deletion, arbitrary endpoints, arbitrary MCP tools, and shell access are excluded by schema and by the MCP batch executor.
`force=true` is also excluded from Mayor plans. CS2 remains the final authority for terrain, water and collision validity.

## Session state and events

State includes `sessionId`, `goal`, `status`, `startedAt`, `tickCount`, cost limits, current estimated spend/balance, `compactMayorMemory`, current snapshot, last compact batch result, consecutive failures, pending user command, bounded tick telemetry, and stop reason.

The preload API exposes `start`, `stop`, `singleTick`, `continuousRun`, `getState`, and `command`. Main-process events are reserved as `ai-mayor-status`, `ai-mayor-balance`, and `ai-mayor-tick`. Commands already support `source=text|voice|map` and an optional target coordinate; no companion UI is part of this MVP.

## Safety and stopping

- Balance unavailable/below minimum or session spend at maximum: stop before a new decision request.
- Snapshot/MCP transport failures: stop after 3 consecutive failures.
- DeepSeek request failures: stop after 3 consecutive failures.
- Invalid model plans: stop after 2 consecutive failures.
- Related batch failures: fail fast in the batch, re-snapshot next tick, stop after 3 consecutive failures.
- A plan may request a stop with a reason.
- Any stop attempts to pause simulation and create a timestamped save. Failures to pause/save are retained in status instead of retried forever.

## Non-goals

The MVP does not include a companion UI, vision, voice, cloud API, multi-user billing, map markers, advanced traffic endpoints, or a dashboard.

## Acceptance evidence

Unit and mock tests are under `test/ai-mayor`. Live evidence and exact telemetry are recorded in `IMPLEMENTATION_STATUS.md`; live game checks must progress from saved single tick to 3 ticks, then approximately 10 minutes before longer trials.
