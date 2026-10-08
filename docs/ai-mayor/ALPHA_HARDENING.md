> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# Local Mayor Alpha Hardening

This document records validation only. Alpha Core behavior is frozen; no growth, utility, zoning, or policy feature is added by hardening runs.

## Runtime stall hardening (2026-09-11)

Static root cause: the Local observation path and MCP adapter had unbounded external awaits. The preserved long-run artifact cannot identify whether the old stall was `cs2_mayor_snapshot`, `cs2_spatial`, or a `cs2_game_state` poll because it contains no stage/request timeline. This is classified as a product reliability gap, not a proven harness false positive.

The fix adds opt-in bounded stage trace, 90s observation/simulation boundaries, signal propagation into MCP legacy calls, structured timeout/abort completion, blocked Activity recovery, and bounded stop waiting. Deterministic hang fixtures pass. Phase A short soak passed 15 minutes / 38 ticks; Phase B long soak passed 50 minutes / 119 ticks, crossed the original failure window, and stopped/saved normally. Evidence: `docs/ai-mayor/evidence/alpha-hardening-runtime-stall-2026-09-11/`.

## Runtime freshness

The previous stale Cities2 process was exited and restarted. The new process loaded Bridge 0.8.3 after the deployed DLL timestamp. MCP stdio exposed 48 tools, the Local harness printed `decisionMode=local` and `providerAccess=disabled`, and read-only connector sanity returned an authoritative existing `waterPipe` connector using `entity.index + entity.version`. No place-building mutation was used for sanity.

## Run matrix

| Map | Duration | Game-time progress | Growth/actions | Utility event | Provider | Runtime health | Shutdown | Result |
| --- | ---: | --- | --- | --- | ---: | --- | --- | --- |
| 法兰克福广场 / short soak | ~15 min | `2026-01-07 01:07 -> 19:14` | road 2, zoning 1; 40 Local ticks | none | 0 | watchdog 0; no stale/repeated/runaway event | paused=true; save via runtime | PASS |
| 法兰克福广场 / long soak | ~42 min before safe stop | `2026-01-07 19:14 -> 2026-01-09 16:23` | first road action succeeded; last observed tick 91 | `NO_NATURAL_UTILITY_RECOVERY_EVENT` | 0 | singleTick remained in-flight after Bridge was paused; no completion output | Bridge paused confirmed; save invoked; harness required emergency interruption | FAIL: `runtime_exception` |
| 法兰克福广场 / runtime stall Phase A | 15 min | `2026-01-09 16:45 -> 2026-01-10 10:56` | 1 zoning; 38 ticks | none | 0 | no stage timeout; no watchdog blocker | paused=true; normal runtime stop/save | PASS |
| 法兰克福广场 / runtime stall Phase B | 50 min | `2026-01-10 10:56 -> 2026-01-12 21:34` | 119 ticks; no actionability available | none | 0 | crossed old ~42 min window; no unresolved in-flight | paused=true; normal runtime stop/save | PASS |
| official map 2 | not run | — | — | — | — | manual map load required | — | pending |
| official map 3 | not run | — | — | — | — | manual map load required | — | pending |

The long-run evidence is in `docs/ai-mayor/evidence/alpha-hardening-2026-09-11/long-run-frankfurt/`. The exact blocker is recorded in `blocker.json`. No retry or product change was made after the first blocker.

## Scope result

Freshness and contract sanity passed. The runtime stall hardening passed deterministic tests, a 15-minute short soak, and a 50-minute long soak that crossed the original failure window with provider calls 0, no watchdog/stage timeout, and clean pause/save shutdown. Multi-map validation remains pending manual loading of two additional official maps.
