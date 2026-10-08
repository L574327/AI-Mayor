import type { LocalMayorHistory } from "./types";

export type LocalMayorFixtureSnapshot = Record<string, any>;

export function buildLocalMayorSnapshotFixture(overrides: Record<string, any> = {}): LocalMayorFixtureSnapshot {
  const base = {
    game: { status: "available", cityName: "replay-city", paused: true, gameDateTime: "2026-09-11T00:00:00Z" },
    population: { current: 1000 },
    economy: { treasury: 10000, monthlyBalance: 100 },
    demand: { residential: { low: 20, medium: 20, high: 20 }, commercial: 20, industrial: 20, office: 0 },
    utilities: {
      electricity: { status: "available", production: 100, consumption: 50, fulfilledConsumption: 50 },
      water: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
      sewage: { status: "available", capacity: 100, consumption: 50, fulfilledConsumption: 50 },
    },
    actionablePlanning: { status: "available", candidates: [] },
    urbanDesign: { siteContext: { snapshotRevision: "replay-1" } },
  };
  return {
    ...base,
    ...overrides,
    game: { ...base.game, ...(overrides.game ?? {}) },
    population: { ...base.population, ...(overrides.population ?? {}) },
    economy: { ...base.economy, ...(overrides.economy ?? {}) },
    demand: { ...base.demand, ...(overrides.demand ?? {}) },
    utilities: { ...base.utilities, ...(overrides.utilities ?? {}) },
    actionablePlanning: { ...base.actionablePlanning, ...(overrides.actionablePlanning ?? {}) },
    urbanDesign: { ...base.urbanDesign, ...(overrides.urbanDesign ?? {}) },
  };
}

export function zoningCandidate(
  id: string,
  areaType: "Residential" | "Commercial" | "Industrial" | "Office" = "Residential",
  estimatedCost = 500,
): Record<string, any> {
  return { id, actionType: "zone", areaType, estimatedCost, validationStatus: "validated" };
}

export function roadCandidate(id: string, index = 10, estimatedCost = 2000): Record<string, any> {
  return {
    id,
    actionType: "build_road",
    estimatedCost,
    approximateLength: 80,
    sourceRoad: { index, version: 1 },
    validationStatus: "validated",
  };
}

export function history(overrides: Partial<LocalMayorHistory> = {}): LocalMayorHistory {
  return { recentActions: [], cooldowns: [], consecutiveWaits: 0, ...overrides };
}

const scenario = (name: string, overrides: Record<string, any>, expected?: string) => ({
  name,
  snapshot: buildLocalMayorSnapshotFixture(overrides),
  expected,
});
const withCandidates = (candidates: Record<string, any>[]) => ({ actionablePlanning: { candidates } });

export const LOCAL_MAYOR_REPLAY_SCENARIOS = [
  scenario("balanced city waits", {}, "wait"),
  scenario("low demand waits", { demand: { residential: { high: 5 }, commercial: 5, industrial: 5 } }, "wait"),
  scenario("healthy utilities wait", { demand: { residential: { high: 30 }, commercial: 20, industrial: 20 } }, "wait"),
  scenario(
    "residential frontage",
    { demand: { residential: { high: 95 } }, ...withCandidates([zoningCandidate("zone-r1")]) },
    "zone-r1",
  ),
  scenario(
    "residential frontage two",
    { demand: { residential: { high: 80 } }, ...withCandidates([zoningCandidate("zone-r2")]) },
    "zone-r2",
  ),
  scenario(
    "residential expansion",
    { demand: { residential: { high: 90 } }, ...withCandidates([roadCandidate("road-r1")]) },
    "road-r1",
  ),
  scenario(
    "commercial demand",
    { demand: { commercial: 95 }, ...withCandidates([zoningCandidate("zone-c1", "Commercial")]) },
    "zone-c1",
  ),
  scenario(
    "industrial demand",
    { demand: { industrial: 95 }, ...withCandidates([zoningCandidate("zone-i1", "Industrial")]) },
    "zone-i1",
  ),
  scenario("mixed demand", {
    demand: { residential: { high: 80 }, commercial: 80, industrial: 80 },
    ...withCandidates([zoningCandidate("zone-m1"), roadCandidate("road-m1")]),
  }),
  scenario("existing capacity", {
    demand: { residential: { high: 40 } },
    ...withCandidates([zoningCandidate("zone-cap")]),
  }),
  scenario(
    "electricity critical",
    {
      utilities: { electricity: { status: "available", production: 50, consumption: 50, fulfilledConsumption: 40 } },
      demand: { residential: { high: 90 } },
      ...withCandidates([roadCandidate("road-u1")]),
    },
    "wait",
  ),
  scenario(
    "water critical",
    {
      utilities: { water: { status: "available", capacity: 50, consumption: 50, fulfilledConsumption: 40 } },
      demand: { commercial: 90 },
      ...withCandidates([zoningCandidate("zone-u2", "Commercial")]),
    },
    "wait",
  ),
  scenario(
    "sewage critical",
    {
      utilities: { sewage: { status: "available", capacity: 50, consumption: 50, fulfilledConsumption: 40 } },
      demand: { industrial: 90 },
      ...withCandidates([zoningCandidate("zone-u3", "Industrial")]),
    },
    "wait",
  ),
  scenario("deficit with large treasury", {
    economy: { treasury: 100000, monthlyBalance: -1000 },
    demand: { residential: { high: 90 } },
    ...withCandidates([zoningCandidate("zone-f1")]),
  }),
  scenario("moderate deficit", {
    economy: { treasury: 10000, monthlyBalance: -1000 },
    demand: { residential: { high: 70 } },
    ...withCandidates([zoningCandidate("zone-f2")]),
  }),
  scenario(
    "severe deficit",
    {
      economy: { treasury: 1000, monthlyBalance: -1000 },
      demand: { residential: { high: 90 } },
      ...withCandidates([zoningCandidate("zone-f3")]),
    },
    "wait",
  ),
  scenario("positive balance growth", {
    economy: { treasury: 5000, monthlyBalance: 500 },
    demand: { commercial: 90 },
    ...withCandidates([zoningCandidate("zone-f4", "Commercial")]),
  }),
  scenario("frontier failure then alternative", {
    demand: { residential: { high: 90 } },
    ...withCandidates([roadCandidate("road-a"), roadCandidate("road-b", 11)]),
  }),
  scenario("failed frontier cooldown", {
    demand: { residential: { high: 90 } },
    ...withCandidates([roadCandidate("road-a"), roadCandidate("road-b", 11)]),
  }),
  scenario(
    "all frontier failed",
    {
      demand: { residential: { high: 90 } },
      ...withCandidates([roadCandidate("road-a"), roadCandidate("road-b"), roadCandidate("road-c")]),
    },
    "wait",
  ),
  scenario("recent road success", {
    demand: { residential: { high: 80 } },
    ...withCandidates([roadCandidate("road-s")]),
  }),
  scenario("recent residential success", {
    demand: { residential: { high: 80 } },
    ...withCandidates([zoningCandidate("zone-s")]),
  }),
  scenario("repeated road action", {
    demand: { residential: { high: 80 } },
    ...withCandidates([roadCandidate("road-repeat")]),
  }),
  scenario("paused observation", { game: { paused: true }, demand: { residential: { high: 15 } } }, "wait"),
  scenario("unavailable world", { game: { status: "unavailable", cityName: null } }, "wait"),
  scenario("stale planning revision", {
    snapshotRevision: "stale-revision",
    ...withCandidates([roadCandidate("road-stale")]),
  }),
  scenario(
    "no useful action",
    {
      actionablePlanning: { status: "available", candidates: [] },
      demand: { residential: { high: 10 }, commercial: 10, industrial: 10 },
    },
    "wait",
  ),
  scenario("bounded candidate set", {
    demand: { residential: { high: 80 } },
    ...withCandidates(Array.from({ length: 20 }, (_, index) => zoningCandidate(`zone-${index}`))),
  }),
  scenario("office demand is observed", { demand: { office: 95 } }, "wait"),
  scenario(
    "utility unknown",
    {
      utilities: { electricity: { status: "unknown" } },
      demand: { residential: { high: 90 } },
      ...withCandidates([zoningCandidate("zone-unknown")]),
    },
    "wait",
  ),
  scenario("deterministic tie", {
    demand: { residential: { high: 60 }, commercial: 60 },
    ...withCandidates([zoningCandidate("zone-tie-r"), zoningCandidate("zone-tie-c", "Commercial")]),
  }),
  scenario("fresh expansion opportunity", {
    demand: { residential: { high: 85 } },
    ...withCandidates([roadCandidate("road-fresh")]),
  }),
  scenario(
    "healthy commercial wait",
    { demand: { commercial: 35 }, ...withCandidates([zoningCandidate("zone-wait-c", "Commercial")]) },
    "wait",
  ),
  scenario(
    "healthy industrial wait",
    { demand: { industrial: 35 }, ...withCandidates([zoningCandidate("zone-wait-i", "Industrial")]) },
    "wait",
  ),
  scenario("recoverable zoning", {
    demand: { residential: { high: 75 } },
    ...withCandidates([zoningCandidate("zone-recover")]),
  }),
  scenario("recoverable road", {
    demand: { residential: { high: 75 } },
    ...withCandidates([roadCandidate("road-recover")]),
  }),
] as const;
