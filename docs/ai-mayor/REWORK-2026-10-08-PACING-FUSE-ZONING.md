# AI Mayor rework 2026-10-08 — paced template districts, building under the spending fuse, homes before empty offices

## What the live session showed (0.1.4, a new city taken over with 1,000,000)

Evidence: `%APPDATA%\AI Mayor\ai-mayor\` (decisions.jsonl, execution-telemetry.jsonl, spend-guard-refusals.log) and read-only Bridge reads (`/city/zoning`, `/city/buildings`, `/city/notifications`).

| Symptom the player saw | What it was |
|---|---|
| A blue road flashing again and again, never placed | From 02:17 the treasury stood under the spending fuse (floor 300,000 + 30,000 margin). Every cycle dry-ran a district's streets (the game draws the preview), then the build was refused by the fuse: 290+ refusals in 30 min. Plus one 280 m "through street" refused by the game 26 times and by the fuse 47 times — no breaker. |
| Money gone | 02:00–02:17: ten grid districts (up to 1,200 x 760 m), all Medium Road, ~40 km by the districts' sizes — snowball's "batch = what the cash pays for" sized against a 150,000 reserve while the fuse refuses at 330,000. |
| "Roads built but buildings grow slowly / a big middle area never grows" | Not jobs: unemployment 4–5 %, open jobs 4–5 %, the product itself read bottleneck HOUSING. Low-density homes were 97 % built (24,604 / 25,337 cells). The empty land was **Office Low 9,839 / 10,289 cells empty** and **Commercial Low 6,902 / 11,318 empty**, most of it in the middle district. The mix gave offices 15 % (with a 0.3 demand floor), new districts gave 85 % of their outer ring to shops/offices, and at 02:26 202 empty housing spots were repainted as offices while housing was the bottleneck. The stale-zoning pass dezoned 2 spots a cycle. |
| Cemetery never joined to a road | Placed (big-building path) on free land 1,139 m from the hearse icons at 02:28 with the treasury at the floor; its 3-piece access road was dry-run OK and refused by the fuse; the cemetery was then marked stranded, holding every cemetery for 7 game days; hearse icons grew to 18; the home-clearing experiment bulldozed homes 11 times for a cemetery that can never stand on a house lot. |
| "Ambulance icons everywhere" | The game reported Ambulance 0, Hearse 18 at the time of the reading: the vehicle icons were hearses (deathcare), not healthcare. |

## What changed

| Area | Change | File |
|---|---|---|
| Template district | The policy's own growth lays districts of at most 400 x 400 m (3 x 3 blocks of 120/160/120, a collector ring, local streets inside) — copies, laid one after another. A player's named request is not held to it. | `growth-policy.ts` (`TEMPLATE_DISTRICT_*`), `district-builder.ts` (`maximumSideMeters`) |
| Pace (snowball) | Batch = min(cash, pipeline). Pipeline = 2 template districts of empty homes of the density being laid (other uses: 1 template). A district follows as soon as the last ones fill. | `snowballPipelineCells`, `#planGrowth`, `#withBatch` |
| Rhythm | Paced waits (`PIPELINE_FULL`, `FUNDS_REFILLING`, `BATCH_BELOW_ONE_DISTRICT`) rest 5 s and never escalate the idle back-off (3→30 s is kept for dead ends). | `host/mayor-engine.ts` |
| Sized under the fuse | The engine publishes the fuse's floor+margin and hourly cap (`AI_MAYOR_SPEND_FLOOR`, `AI_MAYOR_SPEND_HOURLY_CAP`); the batch reserve = floor + operating band (max(50,000, 20 % of floor)); the batch never exceeds the hourly cap. The band is left for repairs (access roads, links, services). | `spend-guard.ts`, `growth-policy.ts` (`capitalReserve`, `operatingReserve`) |
| No preview for nothing | A write the fuse refuses (or a treasury under its floor at cycle start) marks the cycle: no further dry-run, placement check or write that costs money that cycle (districts, through streets, dead ends, access roads, links, services, utilities, land, signatures, train). A district refused by the fuse is not marked refused, not pruned, not retried by another way in. Money refusals never count as failed tries (no facility is taken down or given up for want of cash). | `district-builder.ts` (`#fundsRefused`, Proxy on `buildRoad`/`purchaseTile`/`utilities.place`/`utilities.connect`) |
| Breaker | A through street the game refused twice is left alone for 24 game hours. | `linkDistricts` |
| Local streets | Inside the ring: Small Road (two lanes: cheaper to build and keep, quieter); ring and way in stay Medium Road. | `DISTRICT_LOCAL_ROAD_PREFAB`, `districtCoursePrefab` |
| Land use (seams) | A free rectangle running alongside a street 40/80 m away is drawn back to 120 m, so the strip between is a full block zoned from both streets instead of one-cell lots. | `snapSeams` |
| Mix | Shops/offices/industry already ≥ 50 % empty (≥ 300 cells) get no new share; offices keep no demand floor and are zoned only while jobs are the bottleneck (V2 P4). Empty homes are never repainted as shops/offices while homes are wanted, and only into a use < 30 % empty. | `zoning-mix.ts`, `#zoningUses`, `#homesWanted` |
| Stale offices → homes | While homes are wanted (bottleneck HOUSING, or NONE with demand ≥ 50) and a density is open, empty stale shop/office zoning is repainted as homes: a spot every 40 m along every street, up to 60 brushes per half game hour, homes' distance from industry/rail/highway kept, every brush through the fresh-read admission. | `#repaintStaleAsHomes` |
| Big services | A building on free land waits for 40,000 above the fuse's floor (it needs its road after it). | `BIG_SERVICE_MINIMUM_HEADROOM` |
| Home clearing | Never for a service that cannot stand on a house lot (cemetery, crematorium, hospital, depot, landfill…), never for a held prefab, never without the money. | `BIG_SERVICE_PREFAB`, services loop |
| Subtitle | New lines for the paced waits, the stale-to-homes repaint and the funds wait; "opened a district of X ha" now says what was laid (it said the batch target). | `host/mayor-narrator.ts` |

Tests: `test/ai-mayor/pacing-and-fuse.spec.ts` (new), seam/template cases in `survey-gateway.spec.ts`, updated `fast-expansion-v2.spec.ts`, `district-services.spec.ts`, `mayor-narrator.spec.ts`. Full suite 201 suites / 2,727 tests green.

## The macro control and feedback layer: the growth governor (`v2/growth-governor.ts`)

The player's question after the live runs: "rules are added here and there; where is the macro control and feedback layer — what happens at the next dead loop?"
Every stall of the day had one shape: a rule acted on its own input (a labour reading, a planning margin, a land-use prior, the cash) and nothing checked the
outcome. The governor sits over every rule of the builder and reads only outcomes and the game's own demand:

1. **Open / closed per use** (low, medium, high homes; shops; industry; offices). Closed when the game has no building demand for it (community wiki, Zoning:
   zoned cells grow "as long as there is demand"; demand-panel factors explain why: EmptyBuildings, Unemployment, Uneducated/EducatedWorkforce, LocalDemand,
   Taxes), or when its own empty zoning has not filled for 6 game hours. A closed use gets no district, no frontage zoning, no density choice. The old special
   rules (offices only on a jobs bottleneck, the labour reading pausing homes) are now just inputs it can overrule.
2. **Progress invariant + stall watchdog.** Within 8 game hours population, built cells or the monthly balance must rise, or the problem icons fall. If not:
   - BUSY stall (the Mayor acted to no effect): the supply family it did most in the window is suspended, 6 h doubling to at most 48 h;
   - IDLE stall (it only waited): one template district is laid past the pipeline's wait, once per window.
   A stall is written to the decision log (`governor: … STALL …`) and said on the subtitle.
3. **Outcome scores (the recorder in the loop).** Every supply action (`LAY:<use>`, `ZONE:<use>`) is judged 6 game hours later: did the use's built cells grow
   by 5 % of what it added? Scores per family are kept in `%APPDATA%\AI Mayor\ai-mayor\governor.json` across sessions; a family under 25 % effective after
   3 judgements is suspended like a busy stall.

It cannot promise that no stall happens; it promises a stall is seen within a bounded game time, something different is done, and the report says what.
No API: the governor is code; the player's AI key stays for language only.

Live (run 5, 14,200 people): every use closed because the game's building demand is 0 for all of them (low: EmptyBuildings −80 — homes built faster than people
arrive; high density asked for but locked until milestone 8), population still rising → "progressing", no supply, care round only. The earlier runs of the
day laid district after district into exactly this state.

Not built yet: answers to the demand factors that are not supply (taxes, education for the workforce factors, transit for homelessness) — a stall with every use
closed is reported, not acted on.

### The objective and the repeat guard (the player's restatement, 2026-10-08)

"The feedback layer is for the most income and the most population growth; tend the icons (not necessarily all); schedule and optimise; as few repeated failed
construction actions as possible; never stuck again."

- The governor's line now carries the objective's rates: people per game hour and the change of the monthly balance per game hour, over the progress window.
- **Repeat guard** (one rule over every caller, in the builder's port): the same street — same road, same course to the metre — refused by the game twice is not
  put to the game again for 24 game hours, neither as a build nor as a dry run (the dry run is the preview the player sees). Money refusals do not count.

Live (run 7, 15,500 people): every use closed (the game's building demand is 0 everywhere; homes built faster than people arrive), people +82–95 per game hour,
the monthly balance +3,000–12,800 per game hour, treasury 466k → 559k in two minutes; nothing laid, nothing refused, nothing repeated.

## Pause and quit (the player's report)

- Pause now interrupts the district cycle at its next write (`MayorRuntime.interruptCycle`), instead of after the whole batch; what stands of a district is
  kept and zoned later. Measured: pause → PAUSED in 1.7 s (between cycles; the mid-cycle path is unit-tested only).
- Closing the console quits the product: the Mayor is stopped the way the console's stop does it (the write in hand finishes, the game is handed back running
  at normal speed), and the Mayor's button and subtitle windows are closed. Before, the console's close left the engine running in the tray with the button
  on screen and no way to close it from the game.

## Not verified live yet

All of the above is unit-tested only. To verify on a city: the blue preview no longer flashes under the floor; districts are 400 m and follow one another; the empty offices in the middle become homes and fill; the cemetery's road is laid once the cash is back; Small Road inside districts is accepted by the game's dry run (prefab name as used by the access-road repair).

## Known, not changed

- The small coal plant at (211,172) has no car access (its frontage roads are refused by the game for overlap) and reads No Fuel: a costly facility, left for the player by the existing rule. Its placement accepted a site whose car access the access dry-run did not prove.
- The fuse's floor stays 30 % of the takeover funds (the player's earlier rule). On a new 1,000,000 city that keeps 330,000 idle; lowering it is the player's call.
- High-voltage "Powerline Not Connected" on a cable end keeps failing `NEW_ROAD_PROPOSAL_EDGE_NOT_IDENTIFIED` (bounded at 4 tries per spot).
