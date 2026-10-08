import type { MayorBatchResult, MayorOperationalSignals } from "./types";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const demandValue = (
  snapshot: unknown,
  category: keyof MayorOperationalSignals["demandPersistenceTicks"],
): number | null => {
  const demand = record(record(snapshot).demand);
  if (category === "residential") {
    const residential = record(demand.residential);
    const values = [finite(residential.low), finite(residential.medium), finite(residential.high)].filter(
      (value): value is number => value !== null,
    );
    return values.length > 0 ? Math.max(...values) : null;
  }
  return finite(demand[category]);
};

export function emptyMayorOperationalSignals(): MayorOperationalSignals {
  return {
    demandPersistenceTicks: { residential: 0, commercial: 0, industrial: 0, office: 0 },
    consecutiveNoConstructionTicks: 0,
    populationStagnationTicks: 0,
    treasury: { sessionStart: null, current: null, change: null },
    previousNoOpStatus: null,
    note: "Persistence is observational context only; it never requires construction.",
  };
}

export function updateMayorOperationalSignals(input: {
  current: MayorOperationalSignals;
  snapshot: unknown;
  previousSnapshot: unknown | null;
  previousBatch: MayorBatchResult | null;
  previousStatus: string;
}): MayorOperationalSignals {
  const current = input.current;
  const economy = record(record(input.snapshot).economy);
  const population = finite(record(record(input.snapshot).population).current);
  const previousPopulation = finite(record(record(input.previousSnapshot).population).current);
  const treasury = finite(economy.treasury);
  const sessionStart = current.treasury.sessionStart ?? treasury;
  const demandPersistenceTicks = { ...current.demandPersistenceTicks };
  for (const category of Object.keys(demandPersistenceTicks) as Array<keyof typeof demandPersistenceTicks>) {
    const value = demandValue(input.snapshot, category);
    demandPersistenceTicks[category] = value !== null && value >= 75 ? demandPersistenceTicks[category] + 1 : 0;
  }

  const hadPreviousTick = input.previousBatch !== null;
  return {
    demandPersistenceTicks,
    consecutiveNoConstructionTicks:
      hadPreviousTick && input.previousBatch?.requested === 0 ? current.consecutiveNoConstructionTicks + 1 : 0,
    populationStagnationTicks:
      previousPopulation !== null && population !== null && previousPopulation === population
        ? current.populationStagnationTicks + 1
        : 0,
    treasury: {
      sessionStart,
      current: treasury,
      change: sessionStart !== null && treasury !== null ? treasury - sessionStart : null,
    },
    previousNoOpStatus: hadPreviousTick && input.previousBatch?.requested === 0 ? input.previousStatus : null,
    note: "Demand persistence means demand >=75 on the 0-255 scale for consecutive fresh snapshots. These counters inform strategy but never force an action.",
  };
}
