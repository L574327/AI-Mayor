# AI Mayor 0.1.4 — what changed, the player's rulings, and the known gaps (2026-10-08)

## The player's rulings behind this release

- **Full expansion is the default** (snowball mode); "steady" (grow while the treasury keeps growing) is the choice. The Mayor deals with the problem icons by itself either way.
- **The player's word wins** (说一就是一): a sentence about growth is read as growth, never as care of the city or traffic. The player can always halt the Mayor by voice ("市长停一下", "先停下", "别动了"; "继续" resumes).
- **Problem icons outrank the houses in the way**: a service building with no lot may clear homes (low and medium density; never towers, services, signature or map buildings, never a protected district, never while "keep my buildings" is on). Noise on homes that trees do not answer: the nearest industry goes and its lot is dezoned.
- **Industry keeps to itself** (its own road, its own grid; at most one step closer to homes, 400 → 320 m; past that, land is bought). **Homes and shops fill the land** (homes keep 320 → 240 → 160 m from polluters when no site is found; snowball re-sweeps the whole city's street frontage every 2 game hours).
- **The subtitle says little**: first person, plain statements with figures, no map coordinates, no internal building names, one line a minute at most, one line of a kind per 8 minutes, the same sentence never within 45 minutes. The runtime's old event templates are no longer said.
- **The console**: one start button; an unmistakable live state; the city's figures; growth mode, target population, "no expansion", "keep my buildings"; one input line. Settings: the AI key (with the statement that the product cannot yet build complex intentions) and the interface (subtitle, language, theme). About: GitHub first, the author's site second (both need a stable network; the site has no stable domain in mainland China yet).
- **In the game**: a small round button (the product icon by default; the picture is changed in the console) that opens a white input strip with a pause button.

## What changed (0.1.2 → 0.1.4)

| Area | Change | Why (measured) |
|---|---|---|
| Density | Low density is built over the 25 % quota when the game asks for it (bar ≥ 50; snowball: > 0) and nothing denser is open | 2026-10-07: 286 of 338 cycles `HOUSING_HELD` beside a full low-density bar, 1 % unemployment, 250 open jobs |
| Stock holds | The use the city lacks is never held by its own empty zoning; the hold needs 70 % empty (and, with no named gap, 1,500 cells) | every freshly laid district is 100 % empty, so the next one waited for buildings to grow |
| Snowball | batch = what the cash pays for; no absorption/seed cap; land bought whenever the reserve stands — and, ahead of need, only while districts are being laid | the player's mode |
| Unreachable land | 8 refused ways in on one tile → the tile is set aside for 6 game hours (no sites, not counted as land in hand) | 2026-10-08: ~1,000 candidate sites on land across an obstacle, 7 refused per 5 s cycle, land bought ahead on the strength of them |
| Idle cycles | cycles that build nothing in a row slow down 3 → 6 → 12 → 30 s; a built cycle or a player instruction resets it | the same spin |
| Tile price | the price the game quoted for a refused purchase is kept; not asked again until the cash covers it | the same refusal every minute |
| Language | capability index (`host/capability-index.ts`) with example sentences, each tested against the local reader; `style` (SNOWBALL/STEADY) in the AI filter; an AI's catch-all care goal never stands in for "expand" | "直接扩展" came back as traffic care |
| Update check | Electron `net.fetch` (follows the system proxy) | Node's fetch went to a polluted direct address behind the player's local proxy |
| Decisions | every cycle, waits included, in `%APPDATA%\AI Mayor\ai-mayor\decisions.jsonl` | the reason a city stood still could not be read before |
| Legal copy | exact 5ire statement (zh + the required English sentence); non-affiliation with Paradox / Colossal Order; "as is" disclaimer; the AI provider privacy notice; no named third-party product disparaged | review of 2026-10-08 |

## Known gaps (recorded, not being optimised now — the player's decision)

1. **Old areas' gaps are not filled.** The survey uses the whole owned land, but only two kinds of ground: a free rectangle big enough for a whole district (about 57,600 m² at least, 12 m clear of buildings, with a way in), and unzoned cells beside existing streets. Small gaps between old buildings with no street to them are neither, so they are never used. The frontage re-sweep (snowball, every 2 game hours) only zones roadside cells; it does not lay a short street into an enclosed gap. A fix would need an "infill" planner: small rectangles inside the built area, a stub street from the nearest street, zoning only.
2. The frontage re-sweep runs on game time; on a slow game clock it may not have run during a short session.
3. Not verified live in this release: the unreachable-tile set-aside, the idle back-off, the remembered tile price, noise → industry demolition, clearing homes for a service, the residential distance ladder, the in-game button's picture change.
4. The capability statement stands: complex intentions, grand plans and complex transport works (interchanges, metro, named landmarks, exact taxes) are not possible yet; they are listed in `NOT_YET` and said back to the player.
