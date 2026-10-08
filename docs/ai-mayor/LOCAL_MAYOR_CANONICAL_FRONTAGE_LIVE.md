> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# Local Mayor canonical frontage live validation

> **STATUS: LEGACY / HISTORICAL V1 VALIDATION (2026-09-12).** Preserved as execution/observation evidence and regression reference. It does not define the active V2 planning direction; see [V2_ARCHITECTURE_BASELINE.md](V2_ARCHITECTURE_BASELINE.md).

Date: 2026-09-11  
Evidence: `docs/ai-mayor/evidence/local-mayor-canonical-frontage-live-2026-09-11/`

The explicit `mayor:live:local` entrypoint ran the production Local Mayor Runtime with the complete MCP tool set. The startup banner confirmed `decisionMode=local` and `providerAccess=disabled`; provider invocations were `0` and cost was `0`.

The loaded `法兰克福广场` session reached recovery level 4. It selected and executed two industrial zoning candidates (`I-345713-342116-2` and `I-345710-342149-3`). Both native zoning batches returned `ok=true`, `requested=1`, `executed=1`. Activity entered `building` only after dispatch, then moved to `waiting_for_demand`.

The post-build Local Mayor path advanced game time automatically from `2026-01-07 11:18` to `11:21`; shutdown completed with `pausedAfterStop=true`. The final readback reported `candidateZoningCells=5` and typed unoccupied reserve `residential=157`, `commercial=607`, `industrial=60`, `office=0`.

The current live harness summary does not persist each selected private registry payload, so the selected candidates' exact private `frontageRoad` and per-candidate exact patch sizes are not asserted in this artifact. No such values are inferred from IDs.
