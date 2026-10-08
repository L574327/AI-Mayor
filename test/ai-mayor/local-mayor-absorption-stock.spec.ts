import { isAbsorbing, unabsorbedReserve } from "../../src/main/services/ai-mayor/local-mayor/decision";
import type { LocalMayorState } from "../../src/main/services/ai-mayor/local-mayor/types";
import { builtButVacantFromGoalOrders } from "../../src/main/services/ai-mayor/runtime";

const state = (capacity: Record<string, unknown>): LocalMayorState =>
  ({
    demands: { residential: 80, commercial: 0, industrial: 0, office: 0 },
    developmentCapacity: {
      targetZoningCells: 16,
      typedReserveDeficit: { residential: false, commercial: false, industrial: false, office: false },
      ...capacity,
    },
  }) as unknown as LocalMayorState;

const goalOrder = (goalId: string, built: number, occupied: number) =>
  ({
    goalId,
    state: {
      tranche: {
        effect_progress: {
          attributedResidentialBuildings: Array.from({ length: built }, (_, index) => ({ index, version: 1 })),
          occupiedResidentialBuildings: Array.from({ length: occupied }, (_, index) => ({ index, version: 1 })),
        },
      },
    },
  }) as never;

describe("built-but-vacant stock", () => {
  it("reads the gap between the buildings a tranche built and the ones that have residents", () => {
    expect(builtButVacantFromGoalOrders([goalOrder("EXPAND_RESIDENTIAL:residential:facts:abc", 6, 2)]))
      .toMatchObject({ residential: 4, commercial: 0, unknown: 0 });
  });

  it("reports no vacancy for a tranche whose buildings are all occupied", () => {
    expect(builtButVacantFromGoalOrders([goalOrder("EXPAND_COMMERCIAL:commercial:facts:abc", 3, 3)]))
      .toMatchObject({ residential: 0, commercial: 0, unknown: 0 });
  });

  it("stays unobserved rather than zero when no tranche has observed occupancy", () => {
    expect(builtButVacantFromGoalOrders([])).toBeNull();
    expect(builtButVacantFromGoalOrders([{ goalId: "EXPAND_RESIDENTIAL:residential:facts:abc" } as never])).toBeNull();
  });

  it("keeps a gap whose Goal names no land use out of every domain", () => {
    expect(builtButVacantFromGoalOrders([goalOrder("ESTABLISH_ROAD_NETWORK:facts:abc", 2, 0)]))
      .toMatchObject({ residential: 0, commercial: 0, unknown: 2 });
  });

  it("counts an empty building as unabsorbed supply the reserve alone misses", () => {
    const withVacancy = state({ zonedUnoccupiedByType: { residential: 0 }, builtButVacantByType: { residential: 6 } });
    expect(unabsorbedReserve(withVacancy, "residential")).toBe(6);
    expect(isAbsorbing(withVacancy, "residential")).toBe(false);
  });

  it("stops calling a domain absorbed once its land is built on but empty", () => {
    // The conflation this exists for: six cells that were zoned and unbuilt
    // become six built-but-vacant buildings. Inventory alone reads the domain as
    // absorbed and growth resumes; the third stock reads it as still absorbing.
    const before = state({ zonedUnoccupiedByType: { residential: 16 }, builtButVacantByType: { residential: 0 } });
    const after = state({ zonedUnoccupiedByType: { residential: 0 }, builtButVacantByType: { residential: 16 } });
    expect(isAbsorbing(before, "residential")).toBe(true);
    expect(isAbsorbing(after, "residential")).toBe(true);
  });

  it("does not let one unabsorbed batch freeze the city forever", () => {
    // Vacancy beyond a full tranche is a structural failure for diagnosis, not a
    // reason for the growth policy to stop answering.
    const stuck = state({ zonedUnoccupiedByType: { residential: 0 }, builtButVacantByType: { residential: 200 } });
    expect(unabsorbedReserve(stuck, "residential")).toBe(16);
  });

  it("behaves exactly as before when no tranche has observed occupancy", () => {
    const noEvidence = state({ zonedUnoccupiedByType: { residential: 4 } });
    expect(unabsorbedReserve(noEvidence, "residential")).toBe(4);
    expect(isAbsorbing(noEvidence, "residential")).toBe(false);
  });

  it("still yields to a declared reserve deficit", () => {
    const deficit = state({
      zonedUnoccupiedByType: { residential: 0 },
      builtButVacantByType: { residential: 16 },
      typedReserveDeficit: { residential: true, commercial: false, industrial: false, office: false },
    });
    expect(isAbsorbing(deficit, "residential")).toBe(false);
  });
});
