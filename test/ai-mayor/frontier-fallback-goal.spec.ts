import { rankedGrowthGoals } from "../../src/main/services/ai-mayor/v2/autonomous-brain";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

const state = () => compileLocalMayorState({
  game: { status: "available", paused: true },
  population: { status: "available", current: 123 },
  economy: { status: "available", treasury: 433_000, monthlyBalance: -60_000 },
  demand: { status: "available", residential: { low: 0, medium: 100, high: 100 }, commercial: 80, industrial: 0, office: 100 },
  utilities: {
    electricity: { status: "available", production: 22000, consumption: 13000, fulfilledConsumption: 13000 },
    water: { status: "available", capacity: 21000, consumption: 500 },
    sewage: { status: "available", capacity: 200000, consumption: 500 },
  },
  planningCatalog: { zoneTypes: [
    { name: "EU Residential Medium", areaType: "Residential", office: false },
    { name: "EU Commercial Low", areaType: "Commercial", office: false },
    { name: "Office Low", areaType: "Industrial", office: true },
  ] },
});
const allExpansionParked = new Set(["EXPAND_RESIDENTIAL:residential", "EXPAND_COMMERCIAL:commercial", "EXPAND_OFFICE:office",
  "EXPAND_INDUSTRIAL:industrial", "EXPAND_RESIDENTIAL", "EXPAND_COMMERCIAL", "EXPAND_OFFICE", "EXPAND_INDUSTRIAL"]);

describe("the frontier Goal is offered when every expansion domain refused the ground the roads can see", () => {
  test("off by default, so the caller's own park release runs first", () => {
    expect(rankedGrowthGoals(state(), undefined, null, allExpansionParked).map((goal) => goal.type)).not.toContain("ESTABLISH_ROAD_NETWORK");
  });

  test("on request, with every domain parked, it is the way out of idling", () => {
    const goals = rankedGrowthGoals(state(), undefined, null, allExpansionParked, { frontierFallback: true });
    expect(goals[0]?.type).toBe("ESTABLISH_ROAD_NETWORK");
  });

  test("not offered when domains are not parked, and not when the frontier Goal itself is suppressed", () => {
    expect(rankedGrowthGoals(state(), undefined, null, new Set(), { frontierFallback: true })[0]?.type).not.toBe("ESTABLISH_ROAD_NETWORK");
    const suppressed = new Set([...allExpansionParked, "ESTABLISH_ROAD_NETWORK"]);
    expect(rankedGrowthGoals(state(), undefined, null, suppressed, { frontierFallback: true }).map((goal) => goal.type))
      .not.toContain("ESTABLISH_ROAD_NETWORK");
  });
});
