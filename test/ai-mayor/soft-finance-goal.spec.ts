import { rankedGrowthGoals } from "../../src/main/services/ai-mayor/v2/autonomous-brain";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

const snapshot = (monthlyBalance: number, treasury: number) => ({
  game: { status: "available", paused: true },
  population: { status: "available", current: 95 },
  economy: { status: "available", treasury, monthlyBalance },
  demand: { status: "available", residential: { low: 0, medium: 0, high: 0 }, commercial: 0, industrial: 0, office: 0 },
  utilities: {
    electricity: { status: "available", production: 22000, consumption: 13000, fulfilledConsumption: 13000 },
    water: { status: "available", capacity: 21000, consumption: 500 },
    sewage: { status: "available", capacity: 200000, consumption: 500 },
  },
  planningCatalog: { zoneTypes: [] },
});

describe("a deficit with runway left does not freeze the Brain", () => {
  test("negative balance, 7.5 months of runway: the idle answer is to let the city run, not to pause for an issue", () => {
    const goals = rankedGrowthGoals(compileLocalMayorState(snapshot(-61_175, 461_056)));
    expect(goals.map((goal) => goal.type)).not.toContain("PAUSE_FOR_ISSUE");
  });

  test("a real runway shortfall still pauses", () => {
    const goals = rankedGrowthGoals(compileLocalMayorState(snapshot(-61_175, 90_000)));
    expect(goals[0]?.type).toBe("PAUSE_FOR_ISSUE");
  });
});
