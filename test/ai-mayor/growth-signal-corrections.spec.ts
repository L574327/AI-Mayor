import { generateLocalMayorGoals } from "../../src/main/services/ai-mayor/local-mayor/decision";
import { compileLocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/state";

// Snapshot shaped like the live city of 2026-10-03, reduced to the facts these rules read.
const snapshot = (overrides: { electricity?: object; laborStarved?: string[] } = {}) => ({
  game: { status: "available", paused: true },
  population: { status: "available", current: 45 },
  economy: { status: "available", treasury: 577_000, monthlyBalance: 5_000 },
  demand: {
    status: "available",
    residential: { low: 0, medium: 100, high: 100 },
    commercial: 0, industrial: 51, office: 100,
    ...(overrides.laborStarved ? { laborStarved: overrides.laborStarved } : {}),
  },
  utilities: {
    electricity: { status: "available", production: 22873, consumption: 10520, fulfilledConsumption: 4102,
      ...overrides.electricity },
    water: { status: "available", capacity: 17864, consumption: 192 },
    sewage: { status: "available", capacity: 200000, consumption: 192 },
  },
  planningCatalog: { zoneTypes: [
    { name: "Industrial Manufacturing", areaType: "Industrial", office: false, spawnableBuildingCount: 474 },
    { name: "EU Residential Low", areaType: "Residential", office: false, spawnableBuildingCount: 127 },
    { name: "EU Commercial Low", areaType: "Commercial", office: false, spawnableBuildingCount: 143 },
    { name: "EU Residential Medium", areaType: "Residential", office: false, spawnableBuildingCount: 78 },
    { name: "Office Low", areaType: "Industrial", office: true, spawnableBuildingCount: 68 },
  ] },
});

describe("electricity delivery gap is not a supply shortage", () => {
  test("unserved load with supply to spare is recorded, not raised to critical", () => {
    const electricity = compileLocalMayorState(snapshot()).utilities.electricity;
    expect(electricity.risk).not.toBe("critical");
    expect(electricity.undeliveredLoad).toBe(10520 - 4102);
    const goals = generateLocalMayorGoals(compileLocalMayorState(snapshot()));
    expect(goals.some((goal) => goal.kind === "stabilize_utilities")).toBe(false);
  });

  test("unserved load with too little supply is still critical", () => {
    const short = compileLocalMayorState(snapshot({ electricity: { production: 9000, consumption: 10520, fulfilledConsumption: 9000 } }));
    expect(short.utilities.electricity.risk).toBe("critical");
    expect(generateLocalMayorGoals(short)[0]?.kind).toBe("stabilize_utilities");
  });
});

describe("jobs without workers yield to housing", () => {
  const growthOrder = (laborStarved?: string[]) => generateLocalMayorGoals(compileLocalMayorState(snapshot({ laborStarved })))
    .filter((goal) => goal.kind.startsWith("grow_")).map((goal) => goal.kind);

  test("labor-starved job domains rank below residential", () => {
    const order = growthOrder(["industrial", "office"]);
    expect(order[0]).toBe("grow_residential");
    for (const job of ["grow_office", "grow_industrial"]) {
      if (order.includes(job)) expect(order.indexOf("grow_residential")).toBeLessThan(order.indexOf(job));
    }
    // The rule is what moves the job domain: same city, with and without the workforce fact.
    const urgencyOf = (laborStarved?: string[]) => generateLocalMayorGoals(compileLocalMayorState(snapshot({ laborStarved })))
      .find((goal) => goal.kind === "grow_office")?.urgency;
    expect(urgencyOf()! - urgencyOf(["office"])!).toBe(24);
  });

  test("without the workforce fact nothing is reordered by it", () => {
    const state = compileLocalMayorState(snapshot());
    expect(state.laborStarvedDomains).toEqual([]);
  });
});
