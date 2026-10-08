> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# AI Mayor Core MVP Architecture

> **STATUS: LEGACY / HISTORICAL CORE-MVP IMPLEMENTATION REFERENCE (2026-09-12).** This document describes the v1/Core MVP runtime and reusable execution substrate. It does not define the active V2 planning architecture; see [V2_ARCHITECTURE_BASELINE.md](V2_ARCHITECTURE_BASELINE.md) for current authority boundaries and gates.

## Ownership

The Mayor runtime lives in `src/main/services/ai-mayor` because DeepSeek credentials, telemetry, balance, cost guard, Electron lifecycle, and MCP connections are owned by 5ire. The CS2 MCP contains no model calls. It exposes compact observation and deterministic safe execution.

```text
Renderer / future companion
        | IPC: start, stop, tick, command, state
        v
5ire main process MayorRuntime
        |-- DeepSeek balance + CNY Cost Guard
        |-- bounded prompt + one DeepSeek JSON request
        |-- strict local MayorPlan validation
        |-- bounded memory and telemetry
        v
MCPToolsManager
        |-- cs2_mayor_snapshot
        |-- cs2_mayor_execute_actions
        |-- cs2_run_simulation / cs2_game_state
        `-- cs2_save_game
        v
CS2 MCP -> Bridge :8642 -> game
```

## Files

- `types.ts`: stable session, command, plan, action, result, telemetry, and port contracts.
- `schema.ts`: strict Zod plan/action schemas, live planning-catalog enforcement, and memory/snapshot/result limits.
- `skill.ts`: short stable decision policy used as the cache-friendly system prompt.
- `prompt.ts`: dynamic bounded context only; it never includes prior reasoning or chat history.
- `runtime.ts`: serialized tick loop, lifecycle, cost/failure policy, memory and telemetry.
- `main-adapters.ts`: direct DeepSeek JSON request and named MCP tool adapters.
- `src/main/main.ts`: singleton runtime wiring and IPC handlers.
- `src/main/preload.ts`: future UI-facing API and event channel types.

## Context bounds

Only one copy of each current value enters a decision prompt: goal, compact memory, current snapshot, previous compact batch result, and pending command. Full reasoning, earlier snapshots, earlier results, and chat messages are never appended.

Hard boundaries are 48,000 bytes for a snapshot, 8,000 bytes for a batch result, 4,096 bytes for memory, 1,000 characters for the goal, and 500 characters for a command. Memory lists are capped and replaced rather than appended by the runtime. Tick telemetry retains only the latest 20 records while cumulative numeric totals remain constant-size.

## DeepSeek request

The runtime defaults to API model alias `deepseek-chat`, mapped by existing telemetry to V4 Flash pricing. A caller may select another model. The adapter requests `response_format=json_object`, temperature `0.2`, and at most 1,800 output tokens. It does not expose tools, so a normal tick has exactly one model request and no tool-call continuation. Provider-returned usage supplies prompt/cache/output/reasoning token counts, and pricing is calculated in CNY.

## Concurrency and lifecycle

`singleTick` is serialized: concurrent callers share the active tick promise. `continuousRun` owns one loop and waits for the current simulation to auto-pause before starting the next tick. `stop` aborts simulation polling and finalizes once. Application shutdown also stops an active Mayor session.

## MCP adapter behavior

The adapter discovers exact named tools among active `MCPToolsManager` collections and never allows the plan to choose a tool name. Simulation uses `cs2_run_simulation`, polls `cs2_game_state`, and cancels/pauses on timeout. Stop uses `cancel=true` and `cs2_save_game`.

Snapshot schema 1.1 adds only bounded planning data: exact unlocked names, the latest eight road anchors, and a camera pivot. The runtime cross-checks every road, zone, building, and upgrade target against that current catalog before Batch execution. The MCP executor remains sequential and fail-fast; a fixed 120 ms settle permits the in-game tool pipeline to return to idle between successful actions without retrying failures. Simulation polling accepts both the older flat state fields and Bridge 0.8.2's nested `simulation` object.

## Extension seams

`MayorCommand` already includes optional coordinates and text/voice/map source. Runtime events carry status, balance, and tick state. These seams permit a future companion UI without moving model or MCP authority to the renderer.
