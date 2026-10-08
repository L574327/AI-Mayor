# Direct growable building placement — capability verdict

**Verdict: `NOT_SUPPORTED` as a production fast lane.** The Mayor keeps zoning as
its only way to produce growable RCI development.

This was measured, not assumed. The product question was whether
`road/frontage ready → zoning + direct building placement in parallel` is
available, and the answer is no — with a specific mechanical reason, recorded
here so nobody spends another round re-discovering it.

## What was tested

Two live probes against the running Bridge (`127.0.0.1:8642`, `gameMode=Game`,
`isLoading=false`, MCP server `cs2-mcp 0.8.0`):

- `scripts/tmp-growable-direct-placement-preflight.ts` — zero-mutation. Asks the
  game's own placement validator, through the same `cs2_spatial`
  `mode:preflight, kind:object` path production already uses for facility
  placement, whether a growable zone prefab may be committed at a given cell.
- `scripts/tmp-growable-direct-placement-commit.ts` — places exactly one
  growable, reads it back, runs the simulation, and reports.

## What was found

### 1. The prefab catalogue exposes growables, and native validation accepts them

`cs2_find_prefabs?category=building` returns the zone-spawn prefabs by name —
`NA_ResidentialLow01_L1_3x2`, `NA_CommercialLow01_L1_3x2`, `IndustrialOreHub01_L1`,
`OfficeLow01_L1_3x4`, and hundreds more per land use. All four land uses.

At points where a control placeable (`WindTurbine03`) was also accepted, the
preflight returned `valid: true, toolAllowApply: true` for **11 of 12** probed
growable placements (the twelfth was a site-specific refusal, the same kind any
placement gets). So the tool will commit one.

### 2. The committed building is condemned, unattached, and does not survive

Committed `NA_ResidentialLow01_L1_3x2` at `-690.78, 180.82` on unzoned ground:

```
placement : { placed: true, entity: { index: 345566, version: 87 } }
inspect   : { flags: ["building", "condemned"], renterCount: 0, renters: [] }
access    : roadAttachment: { roadEdge: null, roadExists: false,
                              reciprocalConnectedBuilding: false }
            nativeRoadFrontage.lotSizeX/Y = 3/2, all 8 entrances
            connectedLane1/2 = null on every ParkingLane
simulation: 2 game hours at speed 4
after     : population 84 -> 84, jobs unchanged
listing   : cs2_list_buildings?query=ResidentialLow01_L1_3x2 -> totalMatches: 0
demolish  : "entity 345566:87 does not exist (stale id?)"
```

The building is placed, immediately marked `condemned`, has no road attachment,
gains no renters, and is **removed by the game's own cleanup within two game
hours**. There is no occupancy and no job to read, and no entity left to
demolish.

## Why — the mechanic

`cs2_place_building` runs CS2's **object placement tool**
(`BridgeToolSystem` → `CreateDefinitions` with `m_ObjectPrefab` →
`GetAllowApply()`), the same pipeline that places service buildings and props.
That tool validates geometry: overlap, water, slope, protected entities.

It has no concept of a **zone lot**. A growable in CS2 is not a placeable object:

- it is spawned onto a `VacantLot` owned by a zone block, by the zone spawn
  systems, and
- it requires a native road connection, resolved by
  `Game.Buildings.RoadConnectionSystem` from the lot's frontage.

Placing the prefab directly produces neither. The result is a `Building` entity
with `condemned` set, no `roadEdge`, and no lot — which the simulation then
cleans up. This is exactly why `cs2_zone_area`'s own contract says "Buildings
grow on zoned cells while the simulation runs".

Bypassing zoning is not a shortcut here; zoning *is* the mechanism that creates
the lot the building needs.

## Consequence for the product

The fast lane is not implemented, and the throughput it was meant to buy is
taken from the two levers that are real:

1. **Maximum-throughput zoning**, and
2. **Road and frontage built ahead of the current district**, so the next
   package's land is already zoned and growing while the current one fills in.

Those are `FULL_SPEED_EXPANSION`'s actual shape: the package chain
(`GrowthPace.maximumPackageItems`), the bounded census ring
(`selectGrowableSearchAnchors`), the cross-domain fallback, and a growth Goal
that completes when its land is delivered and observed rather than when its
residents arrive.

## Reproducing

```powershell
npx tsx scripts/tmp-growable-direct-placement-preflight.ts   # read-only
npx tsx scripts/tmp-growable-direct-placement-commit.ts      # places + reads back
```

Both need the Bridge up (`http://127.0.0.1:8642/ping`) and the world loaded.
The commit probe mutates the live city by exactly one building, which the game
removes on its own.
