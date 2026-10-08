> **已过期，见 HANDOFF-CODEX.md。**（本文停留在当时的世界与版本，结论不再适用。）

# Local Mayor Engine v0

> **STATUS: LEGACY / HISTORICAL V1 PLANNING REFERENCE (2026-09-12).** Retained for execution infrastructure, observation/native primitives, regression evidence, and failure analysis. It does not define the active V2 planning abstraction; see [V2_ARCHITECTURE_BASELINE.md](V2_ARCHITECTURE_BASELINE.md).

## Recovery candidate execution handoff live result (2026-09-11)

The first recovery-dispatch retry disproved the earlier registry-only blocker. The L4 residual candidate `R-345710-342149-3` reached the production `executeActions` port, so registry retention across an observational Snapshot and dispatch-pending Activity behavior are now covered statically. However, the zoning candidate did not produce a batch result from the adapter's pre-dispatch validation path; Activity left `building` and reported `observing/unavailable`, with no world mutation or fresh post-execution readback. The run stopped at the first blocker without retrying.

Evidence: `docs/ai-mayor/evidence/local-mayor-recovery-dispatch-live-2026-09-11/`. Exact classification: `recovery_candidate_payload_blocker` — L4 zoning payload/revalidation did not reach `cs2_mayor_execute_actions`.

## Growth opportunity recovery v1 live result (2026-09-11)

The read-only forensic audit found that the previous zero-candidate state was not an exhausted world: the loaded city had 9 owned tiles, approximately 3.50 km², 20 ingress connection candidates, 193 safe roadside cells and 8 canonical planning anchors. The ordinary path exposed no candidate because it stopped at its first bounded gateway search; broader deterministic source/heading/length checks found safe/native-previewable alternatives, while residual safe frontage also supported a bounded smaller zoning patch.

Recovery v1 is static-complete and records levels 1–4. The first authorized live retest reached level 4 and exposed real zoning candidates, but the production Local Mayor loop repeatedly projected `building` without returning an execution batch or fresh readback. The run was stopped at that first runtime blocker; no safety rule was relaxed and no retry was performed. Evidence: `docs/ai-mayor/evidence/local-mayor-growth-recovery-live-2026-09-11/`.

## Growth Pace v1 corridor live validation (2026-09-11)

The authorized real-CS2 corridor validation reached a valid loaded city and used the existing simulation path for the full six-game-hour actionability window. The precheck at `2026-01-07 04:30` had demand `R100/C0/I77`, typed reserve `R159/C643/I0/Office0`, 193 safe roadside cells and 8 frontier anchors, but zero validated zoning or road candidates. The planner therefore remained fail-closed; no Local Mayor build burst was started.

After six game-hours of bounded observation, the game reached `2026-01-07 10:31`. Demand was `R100/C0/I73`, typed reserve was `R159/C631/I0/Office0`, and actionable candidates were still zero. Roads stayed `374`, buildings changed `103 -> 104`, and population stayed `135`. Simulation advanced automatically through the existing runSimulation path, with no city construction initiated by this run. This is `CURRENT_STATE_UNSUITABLE_FOR_CORRIDOR_VALIDATION`, not a product failure and not a reason to relax planner safety.

Evidence: `docs/ai-mayor/evidence/local-mayor-growth-corridor-live-2026-09-11/`. Provider calls and cost were `0`; visible impact was `NONE` because no growth action was available.

## Typed growth goal arbitration (2026-09-11)

Typed reserve deficits are now domain-aware. A meaningful demand with an insufficient matching reserve creates `maintain_development_reserve` carrying `domain` (`residential`, `commercial`, `industrial` or `office`). Zero residential demand does not create `grow_residential`, so an industrial deficit cannot be displaced by a generic residential growth goal. The selected domain is propagated through bounded growth-opportunity generation, road candidate metadata, fresh post-road snapshots and domain-prioritized zoning; roads remain ordinary roads.

Construction remains bounded by the existing reserve, finance, utility, cooldown, native-preview and safety guards. When a construction chain ends in continuous Local mode, the existing `runSimulation` path is used for the next observation rather than leaving the city paused for manual recovery. Provider calls remain zero.

## Big Batch #6 stable idle/blocked semantics

The live blocker was traced to the Activity projection default: every episode started as `planning`, and a no-candidate `replan` did not override that default. The boundary is now explicit: `observing` represents a fresh snapshot or bounded re-observation without an actionable construction opportunity; `planning` is reserved for evaluating a real candidate or an active planner supply attempt; `building` is reserved for an execution lifecycle with a real candidate. A `no_material_change` or unavailable post-readback returns to `observing` and does not claim a successful build.

After `no_safe_actionability_after_refresh`, Runtime keeps a compact blocker containing the actionability key, snapshot revision when available, reason and a three-observation backoff. Ordinary snapshots do not clear it. The blocker can be interrupted by a demand-band crossing, material capacity change, spatial revision/world change, candidate supply or a bounded backoff expiry. Demand bands are coarse (25-point), so the live `58 -> 62 -> 58` jitter stays in one band and cannot by itself request repeated Spatial Planner refreshes. Backoff uses existing wait/simulation observation and remains finite.

The 50-episode idle synthetic run produced one Activity transition, 13 bounded planner refreshes, 50 blocked episodes, zero observing episodes, zero fake planning episodes, 34 waits, 16 simulations, zero replans, provider calls `0`, and a bounded retry after backoff. The high-growth synthetic run remains 10 refreshes, 3 zoning actions, 7 road actions and 912 meaningful capacity units. This preserves construction policy and safety boundaries while making idle behavior honest.

## Big Batch #5 live activity validation — blocked by idle activity flicker (2026-09-11)

The loaded `法兰克福广场` city passed preflight: Bridge, Snapshot, Spatial and the existing camera tool were reachable, the city was paused, utilities were available, and Local mode used a provider-free balance guard. Baseline was population `82`, treasury `2,017,359`, monthly balance `-12,273`, residential high `0`, commercial `0`, industrial `58`, and zero actionable zoning/road candidates.

The bounded refresh contract did run in real CS2. Refresh `1` observed `0 -> 0` candidates with the existing planner note `No non-overlapping zoning patch or validated road expansion candidate is currently available.` Refreshes `2` and `3` followed real industrial-demand changes `58 -> 62 -> 58`; they were not repeated refreshes for an unchanged demand/capacity key. No zoning or road candidate was produced, no execution occurred, and no focus target existed.

Activity correctly exposed `blocked / no_safe_actionability_after_refresh` for episodes 1–3, with no focus target. The first real UX blocker then appeared: episode 4 projected `planning / fresh_snapshot`, episode 5 `waiting_for_demand / bounded_reobserve`, and episode 6 returned to `planning / fresh_snapshot`, without a new candidate or meaningful world change. This violates the no-action observability requirement because a player can reasonably interpret the planning state as renewed work. The run stopped at that first blocker; no code retry was made.

Evidence: `docs/ai-mayor/evidence/local-mayor-activity-live-2026-09-11/activity-events.jsonl`. Cleanup through the existing pause-only path restored `game.paused=true` and saved successfully. The interrupted smoke process did not reach a natural `MayorRuntime.stop()` call, so this run does not replace the prior shutdown validation.

## Big Batch #4 actionability supply and activity feedback

The latest live run had meaningful industrial demand but zero actionable zoning/road candidates. Static audit shows this was not a Local Mayor bypass of Spatial Planner: the main adapter already rebuilt the bounded candidate registry on every fresh Snapshot and applied existing native road preflight. The missing contract was that an empty supply had no explicit refresh/reason projection, so the engine could only alternate between wait and replan. The live evidence is therefore best classified as a candidate-supply/safety outcome with insufficient actionability diagnostics, not proof of a throughput failure.

Local episodes now use a bounded `shouldRefreshLocalMayorSupply` policy. When demand is meaningful, pending capacity is insufficient, and the current registry is empty, Runtime calls the existing adapter refresh (`getSnapshot()`), which remains the sole Spatial Planner/registry/safety path. The refresh is keyed by bounded demand, capacity, utility and supply facts; unchanged empty worlds do not regenerate the catalog every episode. If refresh still returns no safe action, the state records `no_safe_actionability_after_refresh` and waits without a permanent replan ping-pong. Existing pending capacity produces `development_capacity_pending` and favors observation instead of expansion spam.

`LocalMayorActivity` is a compact Runtime/UI projection, not a second state machine or a dump of LocalMayorState. It reports status, primary goal, `planning`, `building`, `waiting_for_growth`, `waiting_for_demand`, `recovering`, `yielding` or `blocked`, a bounded reason/display key, one recent meaningful result and an optional candidate identity focus target. The overlay shows a compact Local Mayor activity card and a View action that uses the existing `cs2_set_camera` capability; no camera capability or target resolves to a safe no-op. No arbitrary coordinates or geometry enter the activity payload.

The offline 50-episode actionability run started with empty candidate supply under industrial demand and healthy capacity/finance conditions. It performed 10 bounded planner refreshes, generated 3 zoning and 7 road candidates, selected 3 zoning and 7 road actions, added 912 bounded capacity units, waited 40 episodes, replanned 0 times, and reported no actionability loop or finance suicide. Local mode remains provider-free.

## Live throughput validation after `ced9821`

The first authorized real-CS2 validation after the pacing change used the manually loaded `法兰克福广场` city and local-only Runtime. Stage 0 passed. Stage 1 ran 25 episodes in `319.7s` and stopped without entering Stage 2 because the current Snapshot had zero actionable zoning and road candidates throughout. It produced `0` candidate attempts, `0` execution successes/rejections, `0` impact classifications, `13` bounded simulation observations and `12` replans. Roads/buildings stayed `366/77`; population moved `84 -> 82` during simulation. This is `INCONCLUSIVE_LOW_ACTIONABILITY`, not evidence that the new action-impact model failed under demand.

The run did verify the negative controls: no provider decision call, zero API cost, no candidate spam, no repeated failure loop, wait/replan streaks both bounded at `1`, healthy electricity/water/sewage, and no Stage 2 continuation. Shutdown passed with a fresh final Snapshot reporting `game.paused=true`, controller `stopped`, one `confirmPaused()` call and existing save completion.

## Product goal and static pacing follow-up

Local Mayor is not only a loop-stability mechanism. Its product goal is bounded throughput that feels like a skilled player: under strong demand, healthy utilities, safe finances, useful candidates and insufficient development capacity, it should keep selecting meaningful safe growth actions; when capacity is available but not yet digested, it should observe; when frontage is exhausted, it should expand through existing validated road candidates.

The live endurance audit found 19 zoning and 5 road-expansion selections among 24 candidate decisions. The streak of 24 was a candidate-decision streak, not verified visible growth. Exact per-action roads/buildings/population deltas are unavailable because the live evidence captured native batch results but not a post-readback after every candidate. The compact Snapshot also does not expose occupied-zoning digestion, building spawn deltas or precise population yield. Those facts remain explicitly unavailable rather than reverse-engineered.

The engine now carries the existing bounded candidate facts `approximateCells`, `approximateNewFrontage`, `approximateLength` and `spatialRole`; computes bounded pending zoning/frontage capacity; and adds an action-impact term so a larger safe opportunity can beat a tiny low-impact opportunity under unmet demand. Wait utility is reduced when demand is high and actionable capacity is not merely being digested. This is event/state driven and contains no fixed build-every-N-seconds rule.

Successful candidate execution receives one bounded post-action Snapshot readback. The trace records `road_added`, `zoning_added`, `world_changed`, `no_material_change` or `unavailable`; native `ok:true` is not treated as strong impact by itself. Exact successful targets receive a short bounded cooldown to prevent immediate spam, while changed candidate IDs and fresh alternatives remain eligible. A recent `no_material_change` outcome adds a bounded penalty rather than creating an infinite retry or a permanent stop.

The offline high-growth replay ran 50 episodes: 168 meaningful capacity units, 7 zoning actions, 2 road expansions, 24 waits, 17 replans, max wait streak 1, final treasury 89,700, no finance suicide. This validates capacity digestion, frontage exhaustion and safe road expansion without provider calls or safety relaxation.

## Big Batch #3 live result (2026-09-11)

The real CS2 Local Mayor session completed 60 episodes in the same local-mode Runtime session. The loop observed fresh snapshots, chose existing zoning/road candidates, executed through the existing registry/revalidation/executor path, waited/replanned, and remained provider-free. Evidence is in `docs/ai-mayor/evidence/local-mayor-live-endurance-2026-09-11/`.

Live aggregate: 24 candidate decisions, 23 successful executions, 1 rejected road candidate (`E-73626-1-east-80-0`), 18 waits, 18 replans, zero stale events, zero yielding/blocked states, and zero provider/API requests or cost. The failed target was not retried on every episode and later recovered successfully. Wait episodes advanced game time through the existing simulation port; the harness labels those as `wait` with simulation telemetry.

The loop stayed stable and the final readback showed a loaded paused city with roads `366`, buildings `77`, population `84`, treasury `2,020,152`, monthly balance `-10,192`, and electricity/water/sewage available. However, the first post-`runtime.stop()` readback unexpectedly observed `paused:false`; the existing safety `pause-only` path then restored and saved the city, and a second readback confirmed `paused:true`, speed `0`. This is recorded as a runtime shutdown/pause anomaly, so Big Batch #3 is not a full pass until `MayorRuntime.stop()` pause stability is separately fixed and tested. No code was changed or retried in this live run.

## Purpose

Local Mayor v0 is a local, deterministic, utility-based decision core for routine mayor actions. It compiles bounded world facts, identifies a small set of goals, scores existing validated actions, and chooses one next step or wait. It does not call an API and is not connected to continuous runtime execution in Big Batch #1.

## Boundary

The engine may select an existing validated zoning or road-expansion candidate, wait, request a bounded observe/simulation step, or replan. It never creates geometry, coordinates, tool names, ECS mutations, registry entries, native previews, or safety exceptions. Existing planner, registry, preview, revalidation and execution ports remain authoritative.

## State and goals

`LocalMayorState` is versioned and compact. It contains bounded population/economy facts, demand, utility availability/headroom/risk, validated candidate references, snapshot revision/fingerprint, and at most eight recent actions and twelve cooldowns. Missing facts remain unavailable. Goals are bounded and typed: utility stabilization, finance protection, residential/commercial/industrial growth, frontier expansion, existing-frontage use, wait-for-growth, and recovery from failed expansion.

## Actions and scoring

Actions are `choose_candidate`, `wait`, `simulate`, and `replan`. Candidate actions carry only an existing candidate ID and class. Scoring exposes goal urgency, demand pressure, utility risk, treasury safety, expected cost, usefulness, bounded action impact, capacity, repetition/failure/cooldown penalties and wait value. Ties use stable action keys. Negative monthly balance is pressure, not an absolute stop; runway and treasury determine whether growth remains useful.

## Wait, recovery and cooldowns

Wait is a valid bounded observation action. Consecutive waits are capped; after the cap the engine selects replan rather than waiting forever. A failed or stale road candidate receives a bounded observation cooldown. Fresh alternatives remain eligible; when all bounded expansion choices fail, the engine falls back to wait/replan instead of retrying indefinitely.

## External changes and cooperative control

Before execution, callers compare the previous bounded world fingerprint/revision with a fresh state. A changed or unavailable world invalidates the pending episode and yields to a fresh snapshot. Observation-only state is unchanged. The engine does not claim to identify keyboard or mouse ownership and never blocks player input; this is an external-world-change boundary, not an OS input hook.

## Replay and future policy traces

Replay fixtures use compact reusable builders and cover 30+ city situations. `LocalMayorDecisionTrace` stores bounded state summary, goals, scored candidates, chosen action, rejected alternatives, margin and reason code. It is local-only, has no telemetry or training loop, and is reserved for future learned-policy evaluation.

## Deliberately not in v0

No utility/service-building system, tax or transport optimizer, garbage/deathcare scanner, issue-awareness layer, learned policy, DeepSeek call, UI, ECS reverse engineering, or geometry engine is included. Big Batch #1 did not integrate continuous Runtime; that integration is now covered by Big Batch #2 below.

## Big Batch #2 runtime integration

Local mode is now an explicit `MayorRuntime` decision source. The existing Runtime still owns the single tick/continuous loop, cancellation, pause/save finalization, balance guard, snapshot boundary, telemetry and single-flight ownership. A local tick performs:

`fresh snapshot → compile state → decide episode → execute/wait/replan → record feedback`.

`choose_candidate` is converted only to the existing candidate-ID plan action and sent through `ports.executeActions()`, so registry resolution, execution-time revalidation, native safety and conflict handling remain unchanged. `wait` and `simulate` reuse `runSimulation`; `replan` discards the current assumption and waits for the next fresh episode.

Execution results are classified as success, failure or stale and recorded in session-bounded history/cooldowns. Successful candidate actions also receive one post-action readback impact classification; `ok:true` with an unchanged bounded fingerprint is recorded as `no_material_change`. Failed road candidates therefore become recovery inputs rather than executor retry loops. Bridge/no-city conditions enter `blocked`; changed world fingerprints enter `yielding` and skip execution. A successful local action marks one expected mutation acknowledgement so the AI's own revision is not mistaken for permanent external intervention. Unchanged observation-only facts do not yield.

Local mode never calls `ports.decide`, creates no provider prompt, and reports zero API requests/cost in telemetry. Its trace is enriched with outcome, failure reason and bounded world fingerprints before/after. Recent memory is session-only; no database persistence or telemetry upload was added.

Big Batch #3 is reserved for real CS2 Local Mayor endurance validation. It is not started automatically.

## Early-city growth loop closure

Local Mayor must be able to create actionability, not only consume an existing candidate catalog. The runtime now projects bounded development capacity from spatial zoning/frontage facts and can raise `maintain_development_reserve` when concrete development capacity is below the local target. Demand controls land-use mix, urgency and pace; it is not an absolute permission gate for a small healthy city.

When ordinary candidates are empty and the reserve is deficient, the existing runtime adapter may call `ensureGrowthOpportunity`. This seam reuses the current SiteContext, canonical planning anchors, pinned road sources, `buildMayorCandidateSet`, registry ownership, native preview and the existing executor. It tries bounded frontier-aware road alternatives of 60/80/100m through the existing straight-road generator. A successful road is followed by a fresh snapshot before zoning is considered; no stale snapshot assumes new frontage.

Reserve growth is bounded by finance, utilities, capacity digestion, candidate conflict groups and existing cooldown/revalidation rules. Existing frontage is preferred before expansion; when no safe opportunity exists, the engine fails closed with bounded backoff and keeps the player-facing activity honest. No second planner, executor, coordinate system or provider path was added.

## Continuous runtime progress invariant

Local Mayor continuous mode must either make bounded progress or boundedly yield. A local iteration records execution, simulation, yielding, world/game-time observation, or no progress. When a paused or unavailable world returns without execution or simulation, the existing Runtime scheduler applies a bounded zero-progress yield even when `tickDelayMs` is zero. This prevents a snapshot/error/blocked return path from becoming a zero-delay busy-loop. Wait and simulate actions continue to use the existing `runSimulation` port; stop still owns cancellation, pause confirmation and save.

## Big Batch #6 live idle UX validation (2026-09-11)

The post-`51d16e7` local-only smoke used `法兰克福广场` with no provider configured. Baseline was population `81`, treasury `2,016,185`, monthly balance `-12,646`, industrial demand `55`, residential/commercial demand `0`, healthy utilities, and zero actionable zoning or road candidates.

The smoke ran 13 Local Mayor episodes for `312.1s` wall-clock. It produced one Activity transition: `blocked / no_safe_actionability_after_refresh`, with no focus target. Four bounded refreshes each observed `0 -> 0` candidates; actions were 10 waits and 3 simulation observations, with zero replans and zero fake planning episodes. The activity remained stable rather than flickering through planning.

The final fresh Snapshot was game time `2026-01-07 11:09`, population `80`, treasury `2,013,029`, monthly balance `-11,534`, industrial demand `62`, zero candidates, and available utilities. `MayorRuntime.stop()` completed normally: fresh readback reported `game.paused=true`, save completed, and both controller and Local Mayor loop stopped. Provider requests and API cost were zero. Evidence is in `docs/ai-mayor/evidence/local-mayor-idle-ux-live-2026-09-11/idle-ux-events.jsonl`.

The idle observability gate is `YES` for this tested state: the runtime exposes stable blocked activity and the overlay maps it to `No safe expansion action available`; there was no false planning promise or fake focus target. Real construction and camera focus were not exercised because the world produced no safe candidate.

## Simulation-control audit (2026-09-11)

The existing `runSimulation` contract is an active simulation command, not passive polling. The main adapter reads `cs2_game_state`, calls the existing `cs2_run_simulation({ hours, speed })` tool, then polls `cs2_game_state` until it observes frame/game progress and the tool's auto-pause. The existing Bridge tool explicitly unpauses for the bounded run and auto-pauses at its target. `pause()` reuses the same tool with `cancel=true` and confirms the paused state.

The previous failed 3-minute proof used a one-off live harness whose `legacyList()` exposed only `cs2_mayor_snapshot`; it omitted `cs2_game_state` and `cs2_run_simulation`. Runtime caught that missing-tool failure as a local simulation failure, then the bounded zero-progress scheduler yield correctly prevented a busy-loop. This made the run appear to lack paused-world control. The prior successful endurance evidence shows the adapter contract itself works: wait episodes took about 23.5 seconds and advanced the city by 30 game minutes at a time.

The authorized retry with the complete 48-tool list proved the distinction: a paused start at `2026-01-06 10:13` resumed at speed 4, reached `10:23`, and auto-paused. No product simulation-control rewrite was necessary and no provider call occurred. The retry harness was stopped because its live construction guard failed to translate `choose_candidate` into the batch result action type; evidence is in `local-mayor-simulation-control-live-2026-09-11/`.

## Final live proof harness accounting (2026-09-11)

The live harness now maps a Local Mayor `choose_candidate` through typed candidate metadata (`actionType: build_road | zone`) and records the authoritative batch result `type`/`ok` fields. Failed results and unknown candidate metadata remain explicit and do not increment road/zoning execution guards. The harness also rejects an incomplete Runtime tool set before starting.

The final live attempt passed the simulation heartbeat, but the current city already had sufficient pending capacity from the preceding authorized retry: `reserveStatus=digesting`, `reserveDeficit=false`, `existingZonedUnoccupiedCells=512`, and `availableDevelopmentCells=512`. It therefore stayed in `waiting_for_growth` and performed no new construction. This is a valid observation state, not evidence of a simulation or planner failure; a fresh reserve-deficit save is required to formally prove another growth action.

## Development digestion live proof (2026-09-11)

The loaded city began in the expected reserve state: `reserveDeficit=false`, `reserveStatus=digesting`, `availableDevelopmentCells=512`, and `existingZonedUnoccupiedCells=512`. Local Mayor ran twelve bounded simulation observations from `2026-01-06 17:25` to `23:21` without calling `ensureGrowthOpportunity`, adding roads, or adding zoning. Activity remained `waiting_for_growth` / observation-oriented, and the anti-runaway condition held.

Buildings remained `77` and roads `366`; population moved `80 -> 76`. Demand stayed low for development purposes (residential high `0`, commercial `0`, industrial about `49`) while utilities remained available. The evidence therefore classifies this run as `PASS — DEMAND_LIMITED_DIGESTION`: the 512 cells are authoritative existing unoccupied zoning capacity, but no consumption signal was observed to make buildings spawn. This is not evidence that the capacity projection is false; it is evidence that Local Mayor correctly did not expand while reserve remained sufficient and demand was limited.
# Typed development reserve audit (2026-09-11)

The development-digestion checkpoint reported `availableDevelopmentCells=512` and `existingZonedUnoccupiedCells=512`, but both were aggregate fields. The authoritative Spatial input did contain per-cell `zoneType`; the adapter discarded that dimension, and the saved evidence did not include the cell list. The current R/C/I/office distribution is therefore unavailable from the checkpoint and must not be inferred from `512`.

This is now corrected statically. Local Development Capacity retains per-category unoccupied zoned cells and a separate unknown bucket. Aggregate capacity remains the total anti-runaway ceiling; demand is compared only with its matching reserve. A meaningful industrial demand with insufficient industrial reserve is no longer classified as `digesting` solely because residential reserve is large. The policy still requires safe validated actionability and unchanged finance/utility/cooldown/total-cap guards.

## Authoritative zone semantics correction (2026-09-11)

The first typed-reserve live readback correctly failed closed: all 512 cells became `unknown` because Spatial's numeric `zoneType` is `Game.Zones.ZoneType.m_Index`, a runtime prefab-type key, not a residential/commercial/industrial enum. Current values `27`, `29`, and `31` happen to identify the loaded commercial-low, residential-low, and industrial-manufacturing prefabs, but those numeric associations are not a supported contract and are not hardcoded.

The authoritative classification now happens in the Bridge through the same prefab metadata already used by zoning execution discovery: `ZoneData.m_ZoneType.m_Index` joins each cell to its zone prefab; `ZoneData.m_AreaType` supplies Residential, Commercial, or Industrial, and `ZoneData.IsOffice()` separates office from industrial. Spatial detail emits the bounded semantic `zoneCategory`, and 5ire consumes only that field. Missing, future, or modded semantics remain `unknown`. Exact typed counts sum to exact `existingZonedUnoccupiedCells`; only `availableDevelopmentCells` retains the existing 512 anti-runaway cap. Local Mayor policy is unchanged.

The paused read-only live check on `法兰克福广场` resolved the current window as residential `88`, commercial `694`, industrial `0`, office `0`, unknown `0`, total `782`. The prior `512` was the anti-runaway projection cap, not the raw authoritative cell count. No Runtime tick, simulation, construction, or provider request occurred; the city remained paused at `2026-01-06 23:21`.

## Service recovery v0 audit (2026-09-11)

Local issue awareness has a bounded `LocalServiceRecoveryIntent` lifecycle. Electricity, water and sewage now use the same `executeSharedUtilityRecovery` implementation as Bootstrap: existing Spatial planning and safety facts, native facility/network preflight, authoritative placement receipt, exact-facility connector discovery, attachment verification and fresh capacity readback. Garbage, fire, healthcare and police remain observable-only. No issue is presented as resolved merely because execution returned success; unchanged capacity/issue state records `no_material_issue_improvement` and enters bounded cooldown.

The shared recovery state machine is `planning -> facility_ready -> facility_placed -> connector_discovered -> connector_connected -> verifying -> resolved/improving/blocked`. Every transition is revision-aware and abortable. Local retains the existing maximum of three attempts, cooldown and finance/runway guard; critical utility recovery outranks growth, while extreme runway can return structured `finance_guard`. External world mutation makes the expected revision stale and causes re-observation instead of competing with the player.
