/**
 * FINANCIAL_RECOVERY — the Mayor taking over a city that is losing money, and bringing it back to a sustainable balance.
 *
 * It is a loop over the same primitives every profile uses, not a controller of its own:
 *
 *   read the world and the books → rank the real causes of the deficit → list the actions that could address them →
 *   score each by expected monthly gain over its risk, reversible first → do ONE → let the city run → read again →
 *   keep what measurably helped, undo what did not or what hurt, and stop when the city no longer needs cutting.
 *
 * Nothing here knows a city, a percentage or a building. Step sizes and thresholds are the profile's own parameters;
 * every quantity that matters (what a budget change really saves, what a tax step really costs in demand) is measured
 * from the world after the action, which is why one action is taken per cycle. Knowledge it relies on is the Bible's
 * skill S06 (POL-FINANCE, K29–K34): judge by runway, count full marginal cost, change taxes and budgets in small
 * purposeful steps with an observation window, never borrow to carry a structural deficit, and fix a failed service
 * before cutting around it (K32, K35/K36).
 */
export type TaxArea = "Residential" | "Commercial" | "Industrial" | "Office";

export interface ServiceLine { name: string; budgetPercent: number; efficiencyPercent: number; estimatedUpkeep: number }

/** A facility the world shows as not connected to the network it was built to feed. */
export interface UnattachedFacility {
  entity: { index: number; version: number };
  prefab: string;
  /** The utility its connector carries, as the bridge names it (`electricity`, `water`, `sewage`). */
  utility: string;
  position: { x: number; z: number };
}

export interface FacilityInLine { entity: { index: number; version: number }; prefab: string }

export interface FinanceFacts {
  treasury: number;
  monthlyIncome: number;
  /** Positive: what the city spends in a month. */
  monthlyExpenses: number;
  monthlyBalance: number;
  incomeByTaxArea: Partial<Record<TaxArea, number>>;
  serviceLines: ServiceLine[];
  taxRates: Partial<Record<TaxArea, number>>;
  /** The demand "Taxes" factor per land use, as the game reports it: negative means the tax is suppressing demand. */
  taxDemandPenalty: Partial<Record<TaxArea, number>>;
  loanPrincipal: number;
  population: number;
  happiness: number;
  /** Buildings the world proves are not served (a building's own consumerService, not an icon count), per utility. */
  unserved: { electricity: number; water: number; sewage: number };
  /** Whether those counts were confirmed against each building's own service state; false means "unknown", never "none". */
  unservedConfirmed: boolean;
  unattachedFacilities: UnattachedFacility[];
  /** Buildings the city has, so an unserved count can be read as a share: a growing city has more unserved buildings and is not worse off. */
  buildingCount: number;
  /** Icons that mean a building or its people are being lost (condemned, abandoned, collapsed, on fire). */
  assetLossIcons: number;
  facilitiesByServiceLine: Record<string, FacilityInLine[]>;
  /** Electricity production over consumption as the world reads it now (null: unread). A surplus is spending that buys nothing. */
  electricityHeadroom?: number | null;
  /** Problem icons of the services a budget cut would starve (garbage piling up, the sick, the dead): a line with them is not cut. */
  serviceIcons?: { garbage: number; health: number; deathcare: number };
}

export type RecoveryActionKind = "CONNECT_FACILITY" | "PROVISION_UTILITY" | "TRIM_SERVICE_BUDGET" | "RAISE_TAX" | "DEMOLISH_FACILITY";

export interface RecoveryCandidate {
  id: string;
  kind: RecoveryActionKind;
  reversible: boolean;
  /** What the action is to do, in the terms of the execution port. */
  params: Record<string, unknown>;
  /** Estimated monthly effect on the balance; refined by measurement after the action. */
  expectedMonthlyGain: number;
  /** How much damage to the city this could do if the estimate is wrong; 1 is mild. */
  riskWeight: number;
  rationale: string;
}

/** Parameters of the profile. These are the profile's, not a city's. */
export const RECOVERY_PARAMETERS = {
  /** One budget step, in percentage points. The game allows 50–150. */
  budgetStepPoints: 10,
  minimumBudgetPercent: 50,
  /** A service whose capacity stands at least this many times above its load may be cut down to the point where this much headroom is left (live 2026-10-07: electricity at 2.4x the load, 520k a month). */
  surplusHeadroomToCut: 2.0,
  keptHeadroom: 1.6,
  /** Live 2026-10-07: power cut to 55% at 1.3x left 67 buildings dark a few game hours later (wind output swings). Below this headroom with buildings dark, the
   * budget goes back up first. */
  restoreBelowHeadroom: 1.3,
  restoreStepPoints: 15,
  /** A service line with at least this many of its own icons is not cut. */
  iconsThatHoldALine: 5,
  taxStepPoints: 1,
  maximumTaxPercent: 20,
  /** A tax is raised only where the game reports no demand penalty from the current rate. */
  /** Population drop between reads that counts as harm. */
  harmfulPopulationDrop: 0.05,
  harmfulHappinessDrop: 3,
  /** Asset-loss icons: harm when they rise by at least this many. */
  harmfulAssetLossIncrease: 3,
  /** Share of buildings left unserved may rise by this much before it counts as harm. */
  harmfulUnservedShareIncrease: 0.05,
  /** A measured improvement smaller than this share of the deficit is "no measurable effect". */
  measurableShareOfDeficit: 0.01,
  /** Consecutive non-negative reads before Recovery calls itself done. */
  exitReads: 2,
  /** Also done when the books are not yet positive but the runway is this long and nothing worth doing remains. */
  safeRunwayMonths: 36,
  /** A deficit up to this share of monthly income, with a safe runway, counts as sustainable. */
  tolerableShortfallShare: 0.05,
  /**
   * New capacity (a water tower, a generator) is bought only with this many months of runway left: it is spending, its gain is the small share of the tax base it
   * restores, and a deficit city that spends its last cash on it is worse off (live 2026-10-07: 4 of 493 buildings without water, a tower of ~150k bought with
   * 435k left and -150k a month; the cheap repairs and the cuts come first).
   */
  minimumRunwayMonthsToProvision: 12,
  /** A facility is tried this many times before the loop stops proposing it. */
  maximumAttemptsPerTarget: 2,
} as const;

/** Risk of cutting a service line, from the Bible: roads and power carry everything else (K49, K36); emergency services are slow to notice (K46). */
export function lineRiskWeight(name: string): number {
  if (/road|electric/i.test(name)) return 3;
  if (/fire|police|health|water|sewage/i.test(name)) return 2;
  return 1;
}

/** The service line a prefab's upkeep is booked to, by its name. Null when it is not a service building. */
export function serviceLineOfPrefab(prefab: string): string | null {
  if (/Medical|Hospital|Clinic|Cemetery|Crematorium|Deathcare/i.test(prefab)) return "Health & Deathcare";
  if (/Pumping|SewageOutlet|WaterTower|Wastewater|Sewage|WaterTreatment/i.test(prefab)) return "Water & Sewage";
  if (/Fire(House|Station)/i.test(prefab)) return "Fire & Rescue";
  if (/Police|Prison/i.test(prefab)) return "Police & Administration";
  if (/School|University|College|Library|Research/i.test(prefab)) return "Education & Research";
  if (/Landfill|Recycl|Incinerat|GarbageTransfer/i.test(prefab)) return "Garbage Management";
  if (/WindTurbine|Solar|PowerPlant|Transformer|Substation|Battery|Geothermal/i.test(prefab)) return "Electricity";
  if (/Park|Plaza|Playground/i.test(prefab)) return "Parks & Recreation";
  if (/BusDepot|BusStop|TrainStation|Metro|Tram|TaxiDepot/i.test(prefab)) return "Transportation";
  return null;
}

/** Whether a service line is currently failing to deliver, so cutting its budget would hide a fault rather than save money. */
function lineHasDeliveryFault(facts: FinanceFacts, line: ServiceLine): boolean {
  if (!facts.unservedConfirmed) return false;
  if (/electric/i.test(line.name)) return facts.unserved.electricity > 0;
  if (/water|sewage/i.test(line.name)) return facts.unserved.water > 0 || facts.unserved.sewage > 0;
  return false;
}

export interface RecoveryMemory {
  /** Candidates tried and judged, by id: "KEPT", "UNDONE", "FAILED". A judged candidate is not proposed again unless the world changed. */
  judged: Map<string, "KEPT" | "UNDONE" | "FAILED">;
  attempts: Map<string, number>;
  /** Balance reads while the loop has run, newest last. */
  balanceReads: number[];
}

export const newRecoveryMemory = (): RecoveryMemory => ({ judged: new Map(), attempts: new Map(), balanceReads: [] });

/** The facts' own account of why the city is losing money, biggest first. For the report and for the ranking below. */
export function diagnoseDeficit(facts: FinanceFacts): Array<{ cause: string; monthly: number; evidence: string }> {
  const causes: Array<{ cause: string; monthly: number; evidence: string }> = [];
  for (const line of facts.serviceLines.filter((candidate) => candidate.estimatedUpkeep > 0)) {
    causes.push({ cause: `FIXED_COST:${line.name}`, monthly: line.estimatedUpkeep,
      evidence: `${line.name} costs ${line.estimatedUpkeep}/month at ${line.budgetPercent}% budget (${((line.estimatedUpkeep / Math.max(1, facts.monthlyExpenses)) * 100).toFixed(0)}% of spending)` });
  }
  const unservedTotal = facts.unserved.electricity + facts.unserved.water + facts.unserved.sewage;
  if (facts.unservedConfirmed && unservedTotal > 0) {
    causes.push({ cause: "TAX_BASE_UNSERVED", monthly: facts.monthlyIncome,
      evidence: `${facts.unserved.electricity} buildings without power, ${facts.unserved.water} without water, ${facts.unserved.sewage} without sewage (confirmed on each building); income is only ${facts.monthlyIncome}/month` });
  }
  if (facts.unattachedFacilities.length > 0) {
    causes.push({ cause: "FACILITY_NOT_CONNECTED", monthly: facts.monthlyIncome,
      evidence: `${facts.unattachedFacilities.map((facility) => `${facility.prefab}(${facility.utility})`).join(", ")} not connected to the network` });
  }
  return causes.sort((left, right) => right.monthly - left.monthly);
}

/** The actions that could address the deficit now, each with its estimated monthly gain and its risk. */
export function recoveryCandidates(facts: FinanceFacts, memory: RecoveryMemory): RecoveryCandidate[] {
  const candidates: RecoveryCandidate[] = [];
  const open = (id: string) => (memory.attempts.get(id) ?? 0) < RECOVERY_PARAMETERS.maximumAttemptsPerTarget && !memory.judged.has(id);
  // 1. A facility the world shows disconnected: the cheapest way to restore what the city already paid for.
  for (const facility of facts.unattachedFacilities) {
    const id = `connect:${facility.entity.index}`;
    // A producer or pump that is not attached is a fault whether or not anyone has moved in yet: the repair costs a cable.
    if (!open(id)) continue;
    candidates.push({ id, kind: "CONNECT_FACILITY", reversible: false, params: { facility },
      expectedMonthlyGain: Math.max(1, facts.monthlyIncome * 0.5), riskWeight: 0.5,
      rationale: `${facility.prefab} carries ${facility.utility} but its connector is not attached; buildings that need it are unserved` });
  }
  // 1b. A utility the world proves is short, with every facility already connected: more capacity, chosen by the port from what
  // the world offers. The gain is the share of the tax base it would restore.
  for (const utility of ["electricity", "water", "sewage"] as const) {
    const count = facts.unserved[utility];
    const id = `provision:${utility}`;
    if (!facts.unservedConfirmed || count <= 0 || facts.unattachedFacilities.some((facility) => facility.utility.includes(utility.slice(0, 4))) || !open(id)) continue;
    const share = count / Math.max(1, facts.buildingCount);
    const runway = facts.monthlyBalance >= 0 ? Number.POSITIVE_INFINITY : facts.treasury / -facts.monthlyBalance;
    if (runway < RECOVERY_PARAMETERS.minimumRunwayMonthsToProvision) continue;
    candidates.push({ id, kind: "PROVISION_UTILITY", reversible: false, params: { utility, unserved: count },
      expectedMonthlyGain: Math.max(1, facts.monthlyIncome * share * 0.25), riskWeight: 0.7,
      rationale: `${count} of ${facts.buildingCount} buildings are confirmed without ${utility} although the facilities are connected: the city lacks capacity` });
  }
  // The player's takeover permissions (`host/protocol.ts`): budgets and taxes only when economic adjustments are allowed; no building is taken down
  // while the player's assets are preserved (the recovery cannot tell a building the player placed from one the Mayor placed).
  const economyAllowed = process.env.AI_MAYOR_ALLOW_ECONOMY !== "0";
  const demolitionAllowed = process.env.AI_MAYOR_PRESERVE_PLAYER_ASSETS !== "1";
  // 2. Service budgets: a step down on the lines that cost most, except where the service is failing (cutting hides the fault).
  for (const line of economyAllowed ? facts.serviceLines : []) {
    const icons = facts.serviceIcons;
    if (icons && /garbage/i.test(line.name) && icons.garbage >= RECOVERY_PARAMETERS.iconsThatHoldALine) continue;
    if (icons && /health|deathcare/i.test(line.name) && icons.health + icons.deathcare >= RECOVERY_PARAMETERS.iconsThatHoldALine) continue;
    let next = Math.max(RECOVERY_PARAMETERS.minimumBudgetPercent, line.budgetPercent - RECOVERY_PARAMETERS.budgetStepPoints);
    // Electricity made 2.4x the city's need: the budget comes down in one step to where 1.3x is still left. Output follows the budget, so what is cut was surplus;
    // the world's re-read of the line and of the unserved share judges it, and it is undone if anything went dark.
    const headroom = facts.electricityHeadroom ?? null;
    const surplus = /electric/i.test(line.name) && headroom !== null && headroom >= RECOVERY_PARAMETERS.surplusHeadroomToCut;
    if (surplus) next = Math.max(RECOVERY_PARAMETERS.minimumBudgetPercent, Math.min(next, Math.ceil((100 * RECOVERY_PARAMETERS.keptHeadroom) / headroom! / 5) * 5));
    const id = `budget:${line.name}:${next}`;
    // Unserved buildings beside a generation surplus are unconnected, not under-supplied: cutting the surplus does not touch them.
    if (line.estimatedUpkeep <= 0 || next >= line.budgetPercent || !open(id) || (!surplus && lineHasDeliveryFault(facts, line))) continue;
    // A linear lower bound on the saving; the world's own re-read after the step is what is believed.
    const gain = line.estimatedUpkeep * ((line.budgetPercent - next) / line.budgetPercent) * 0.5;
    candidates.push({ id, kind: "TRIM_SERVICE_BUDGET", reversible: true, params: { service: line.name, from: line.budgetPercent, to: next },
      expectedMonthlyGain: gain, riskWeight: surplus ? 0.5 : lineRiskWeight(line.name),
      rationale: `${line.name} costs ${line.estimatedUpkeep}/month at ${line.budgetPercent}%; a step to ${next}% saves at least ~${Math.round(gain)}` });
  }
  // 2b. Power cut too far: buildings dark while the production barely covers the load. The budget goes back up a step (a repair, never undone).
  const power = facts.serviceLines.find((line) => /electric/i.test(line.name));
  const powerHeadroom = facts.electricityHeadroom ?? null;
  if (power && power.budgetPercent < 100 && facts.unservedConfirmed && facts.unserved.electricity > 0 && (powerHeadroom === null || powerHeadroom < RECOVERY_PARAMETERS.restoreBelowHeadroom)) {
    const to = Math.min(100, power.budgetPercent + RECOVERY_PARAMETERS.restoreStepPoints);
    const id = `restore:${power.name}:${to}`;
    if (open(id)) candidates.push({ id, kind: "TRIM_SERVICE_BUDGET", reversible: true, params: { service: power.name, from: power.budgetPercent, to },
      expectedMonthlyGain: 1, riskWeight: 0.5,
      rationale: `${power.name} at ${power.budgetPercent}% leaves ${facts.unserved.electricity} building(s) dark with production at ${powerHeadroom?.toFixed(2) ?? "?"}x the load: back up to ${to}%` });
  }
  // 3. Tax: a small step where the game says the current rate is not suppressing that land use's demand.
  for (const area of economyAllowed ? (["Residential", "Commercial", "Industrial", "Office"] as const) : []) {
    const rate = facts.taxRates[area];
    const income = facts.incomeByTaxArea[area] ?? 0;
    const penalty = facts.taxDemandPenalty[area] ?? 0;
    const next = rate === undefined ? null : rate + RECOVERY_PARAMETERS.taxStepPoints;
    const id = `tax:${area}:${next}`;
    if (next === null || next > RECOVERY_PARAMETERS.maximumTaxPercent || income <= 0 || penalty < 0 || !open(id)) continue;
    candidates.push({ id, kind: "RAISE_TAX", reversible: true, params: { area, from: rate, to: next },
      expectedMonthlyGain: (income / Math.max(1, rate!)) * RECOVERY_PARAMETERS.taxStepPoints, riskWeight: 2,
      rationale: `${area} tax ${rate}% yields ${income}/month and the game reports no demand penalty from it` });
  }
  // 4. Demolition: the line's own cost is the saving, and it cannot be undone. Only offered once the reversible lever
  // on that line (its budget) has been pulled as far as it goes: the same saving is taken the reversible way first.
  for (const line of demolitionAllowed ? facts.serviceLines : []) {
    const buildings = facts.facilitiesByServiceLine[line.name] ?? [];
    if (line.estimatedUpkeep <= 0 || buildings.length === 0 || line.budgetPercent > RECOVERY_PARAMETERS.minimumBudgetPercent) continue;
    const perBuilding = line.estimatedUpkeep / buildings.length;
    for (const building of buildings) {
      const id = `demolish:${building.entity.index}`;
      if (!open(id) || lineHasDeliveryFault(facts, line)) continue;
      candidates.push({ id, kind: "DEMOLISH_FACILITY", reversible: false, params: { entity: building.entity, prefab: building.prefab, line: line.name },
        expectedMonthlyGain: perBuilding, riskWeight: lineRiskWeight(line.name) * 2,
        rationale: `${building.prefab} is one of ${buildings.length} building(s) behind ${line.name}'s ${line.estimatedUpkeep}/month; removing it saves about ${Math.round(perBuilding)} and cannot be undone` });
    }
  }
  return candidates;
}

/**
 * The next action: repairs first (a failed service is fixed, not cut around), then the best reversible action by gain
 * over risk, and an irreversible one only when no reversible action is left or its gain clearly dominates.
 */
export function chooseRecoveryAction(facts: FinanceFacts, candidates: readonly RecoveryCandidate[]): RecoveryCandidate | null {
  const score = (candidate: RecoveryCandidate) => candidate.expectedMonthlyGain / candidate.riskWeight;
  const restores = candidates.filter((candidate) => candidate.id.startsWith("restore:"));
  if (restores.length > 0) return restores[0]!;
  const repairs = candidates.filter((candidate) => candidate.kind === "CONNECT_FACILITY" || candidate.kind === "PROVISION_UTILITY").sort((l, r) => score(r) - score(l));
  if (repairs.length > 0) return repairs[0]!;
  const reversible = candidates.filter((candidate) => candidate.reversible && candidate.expectedMonthlyGain > 0).sort((l, r) => score(r) - score(l));
  const irreversible = candidates.filter((candidate) => !candidate.reversible && candidate.kind === "DEMOLISH_FACILITY").sort((l, r) => score(r) - score(l));
  const deficit = Math.max(0, -facts.monthlyBalance);
  const bestReversible = reversible[0];
  const bestIrreversible = irreversible[0];
  if (bestIrreversible && deficit > 0 && (!bestReversible ||
    (bestIrreversible.expectedMonthlyGain >= 0.25 * deficit && bestIrreversible.expectedMonthlyGain >= 3 * bestReversible.expectedMonthlyGain))) {
    return bestIrreversible;
  }
  return bestReversible ?? null;
}

export interface RecoveryReading {
  /** Each service line's monthly upkeep, so an action is judged by the line it touched, not by a city-wide number that other things move. */
  lineUpkeep: Record<string, number>;
  /** Tax income per land use and the population, so a tax step is judged per head. */
  incomeByTaxArea: Partial<Record<TaxArea, number>>;
  monthlyBalance: number;
  population: number;
  happiness: number;
  assetLossIcons: number;
  unservedTotal: number;
  buildingCount: number;
}

export const readingOf = (facts: FinanceFacts): RecoveryReading => ({
  lineUpkeep: Object.fromEntries(facts.serviceLines.map((line) => [line.name, line.estimatedUpkeep])), incomeByTaxArea: { ...facts.incomeByTaxArea },
  monthlyBalance: facts.monthlyBalance, population: facts.population, happiness: facts.happiness, assetLossIcons: facts.assetLossIcons,
  unservedTotal: facts.unserved.electricity + facts.unserved.water + facts.unserved.sewage,
  buildingCount: facts.buildingCount,
});
const unservedShare = (reading: RecoveryReading) => reading.unservedTotal / Math.max(1, reading.buildingCount);

export type RecoveryVerdict = { verdict: "KEEP" | "UNDO" | "NEUTRAL" | "HARM"; reason: string };

/**
 * What the world says an action did. HARM is the loss of people, happiness or buildings (or a service that stopped being
 * delivered); the action is undone if it can be. An action with no measurable effect is undone too: it saved nothing the
 * books can show, and a service cut that saves nothing is a pure loss.
 */
export function judgeAction(candidate: RecoveryCandidate, before: RecoveryReading, after: RecoveryReading): RecoveryVerdict {
  // Putting a starved service back is a repair: it is never taken back (that would cut it again).
  if (candidate.id.startsWith("restore:")) return { verdict: "KEEP", reason: `restored; unserved share ${(unservedShare(before) * 100).toFixed(0)}%→${(unservedShare(after) * 100).toFixed(0)}%` };
  const harm: string[] = [];
  if (before.population > 0 && (before.population - after.population) / before.population > RECOVERY_PARAMETERS.harmfulPopulationDrop) harm.push(`population ${before.population}→${after.population}`);
  if (before.happiness - after.happiness >= RECOVERY_PARAMETERS.harmfulHappinessDrop) harm.push(`happiness ${before.happiness}→${after.happiness}`);
  if (after.assetLossIcons - before.assetLossIcons >= RECOVERY_PARAMETERS.harmfulAssetLossIncrease) harm.push(`asset-loss icons ${before.assetLossIcons}→${after.assetLossIcons}`);
  // A city that grew has more unserved buildings; only a rise in the SHARE of buildings left unserved is harm.
  if (unservedShare(after) - unservedShare(before) > RECOVERY_PARAMETERS.harmfulUnservedShareIncrease) harm.push(`unserved share ${(unservedShare(before) * 100).toFixed(0)}%→${(unservedShare(after) * 100).toFixed(0)}%`);
  if (harm.length > 0) return { verdict: candidate.reversible ? "UNDO" : "HARM", reason: harm.join("; ") };
  const gain = after.monthlyBalance - before.monthlyBalance;
  const measurable = Math.max(1, Math.abs(Math.min(before.monthlyBalance, 0)) * RECOVERY_PARAMETERS.measurableShareOfDeficit);
  if (candidate.kind === "CONNECT_FACILITY") {
    // A repair is judged by what it served, not by one balance read: the tax base returns slowly.
    return unservedShare(after) < unservedShare(before) || gain >= measurable
      ? { verdict: "KEEP", reason: `unserved share ${(unservedShare(before) * 100).toFixed(0)}%→${(unservedShare(after) * 100).toFixed(0)}%, balance ${gain >= 0 ? "+" : ""}${Math.round(gain)}` }
      : { verdict: "NEUTRAL", reason: "no change yet in what is served or in the balance" };
  }
  // A budget step is judged by the line it touched: while a repair or growth moves the city-wide balance by tens of
  // thousands, a 10-point trim must not be credited with it. A tax step is judged by tax income per head.
  if (candidate.kind === "TRIM_SERVICE_BUDGET") {
    const line = String((candidate.params as { service?: string }).service ?? "");
    const saved = (before.lineUpkeep[line] ?? 0) - (after.lineUpkeep[line] ?? 0);
    // Measurable against the line itself: a step that moves its own line by 1% or more has done what it was for.
    return saved >= Math.max(1, (before.lineUpkeep[line] ?? 0) * RECOVERY_PARAMETERS.measurableShareOfDeficit)
      ? { verdict: "KEEP", reason: `${line} upkeep -${Math.round(saved)}/month` }
      : { verdict: "UNDO", reason: `${line} upkeep did not fall (${Math.round(saved)}/month)` };
  }
  if (candidate.kind === "RAISE_TAX") {
    const area = (candidate.params as { area?: TaxArea }).area as TaxArea;
    const perHead = (reading: RecoveryReading) => (reading.incomeByTaxArea[area] ?? 0) / Math.max(1, reading.population);
    const gainPerHead = perHead(after) - perHead(before);
    return gainPerHead > 0
      ? { verdict: "KEEP", reason: `${area} tax per head +${gainPerHead.toFixed(1)}` }
      : { verdict: "UNDO", reason: `${area} tax per head did not rise (${gainPerHead.toFixed(1)})` };
  }
  if (gain >= measurable) return { verdict: "KEEP", reason: `balance +${Math.round(gain)}/month` };
  return { verdict: candidate.reversible ? "UNDO" : "NEUTRAL", reason: `no measurable gain (${Math.round(gain)}/month)` };
}

export type RecoveryStatus = "RECOVERED" | "RECOVERING" | "EXHAUSTED";

/**
 * Whether Recovery is done. Done when the books have been non-negative on enough consecutive reads, or when the runway
 * is long and nothing worth doing remains. EXHAUSTED when still negative and no action is left: it says so rather than
 * cutting further.
 */
export function recoveryStatus(facts: FinanceFacts, memory: RecoveryMemory, candidates: readonly RecoveryCandidate[]): RecoveryStatus {
  const reads = memory.balanceReads;
  const recent = reads.slice(-RECOVERY_PARAMETERS.exitReads);
  if (recent.length >= RECOVERY_PARAMETERS.exitReads && recent.every((balance) => balance >= 0)) return "RECOVERED";
  const runway = facts.monthlyBalance >= 0 ? Number.POSITIVE_INFINITY : facts.treasury / -facts.monthlyBalance;
  // Sustainable is not "never below zero in one read": a deficit that is a small share of income, against a runway of years
  // and a tax base that is growing, is not a reason to keep cutting (Bible: judge by runway, not by one monthly figure).
  const shortfallShare = facts.monthlyBalance >= 0 ? 0 : -facts.monthlyBalance / Math.max(1, facts.monthlyIncome);
  if (runway >= RECOVERY_PARAMETERS.safeRunwayMonths && shortfallShare <= RECOVERY_PARAMETERS.tolerableShortfallShare && reads.length >= RECOVERY_PARAMETERS.exitReads) {
    const trend = reads.slice(-RECOVERY_PARAMETERS.exitReads);
    if (trend.every((balance) => balance / Math.max(1, facts.monthlyIncome) >= -RECOVERY_PARAMETERS.tolerableShortfallShare)) return "RECOVERED";
  }
  const actionable = chooseRecoveryAction(facts, candidates);
  if (!actionable) return runway >= RECOVERY_PARAMETERS.safeRunwayMonths ? "RECOVERED" : "EXHAUSTED";
  return "RECOVERING";
}

// --------------------------------------------------------------------------------------------------------------------
// The step: one cycle of the loop, over a port. Holds only what the loop itself needs between cycles.

export interface FinanceRecoveryPort {
  readFacts(signal?: AbortSignal): Promise<FinanceFacts>;
  setServiceBudget(service: string, percent: number, signal?: AbortSignal): Promise<boolean>;
  setTax(area: TaxArea, rate: number, signal?: AbortSignal): Promise<boolean>;
  connectFacility(facility: UnattachedFacility, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  /** Place and connect one facility that adds capacity for a utility, chosen from what the world offers. */
  provisionUtility(utility: "electricity" | "water" | "sewage", signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
  demolish(entity: { index: number; version: number }, signal?: AbortSignal): Promise<boolean>;
}

export interface RecoveryStepResult {
  status: RecoveryStatus;
  /** True when the world was changed this cycle and the city should now run before the next read. */
  acted: boolean;
  notes: string[];
}

interface PendingAction { candidate: RecoveryCandidate; before: RecoveryReading; undo: (() => Promise<boolean>) | null }

export class FinanceRecoveryLoop {
  readonly memory: RecoveryMemory = newRecoveryMemory();
  #pending: PendingAction | null = null;

  constructor(private readonly port: FinanceRecoveryPort) {}

  async step(signal?: AbortSignal): Promise<RecoveryStepResult> {
    const notes: string[] = [];
    const facts = await this.port.readFacts(signal);
    this.memory.balanceReads.push(facts.monthlyBalance);
    // 1. Judge what the last cycle did, from the world as it is now.
    if (this.#pending) {
      const { candidate, before, undo } = this.#pending;
      this.#pending = null;
      const verdict = judgeAction(candidate, before, readingOf(facts));
      notes.push(`${candidate.kind} ${candidate.id}: ${verdict.verdict} (${verdict.reason})`);
      if (verdict.verdict === "KEEP") this.memory.judged.set(candidate.id, "KEPT");
      else if (verdict.verdict === "UNDO" && undo) {
        const undone = await undo();
        this.memory.judged.set(candidate.id, undone ? "UNDONE" : "FAILED");
        notes.push(undone ? "undone" : "could not be undone");
        // The world changed back; the next cycle reads it again before anything else.
        return { status: "RECOVERING", acted: true, notes };
      } else if (verdict.verdict === "HARM") this.memory.judged.set(candidate.id, "FAILED");
      else if (verdict.verdict === "NEUTRAL") this.memory.attempts.set(candidate.id, (this.memory.attempts.get(candidate.id) ?? 0) + 1);
    }
    const candidates = recoveryCandidates(facts, this.memory);
    const status = recoveryStatus(facts, this.memory, candidates);
    const causes = diagnoseDeficit(facts).slice(0, 3).map((cause) => cause.evidence);
    notes.push(`balance ${Math.round(facts.monthlyBalance)}/month, treasury ${Math.round(facts.treasury)}; causes: ${causes.join(" | ") || "none found"}`);
    if (status !== "RECOVERING") return { status, acted: false, notes: [...notes, `recovery ${status}`] };
    const choice = chooseRecoveryAction(facts, candidates);
    if (!choice) return { status: "EXHAUSTED", acted: false, notes };
    const before = readingOf(facts);
    this.memory.attempts.set(choice.id, (this.memory.attempts.get(choice.id) ?? 0) + 1);
    notes.push(`chose ${choice.kind} ${choice.id}: ${choice.rationale}`);
    let undo: (() => Promise<boolean>) | null = null;
    let done = false;
    if (choice.kind === "TRIM_SERVICE_BUDGET") {
      const { service, from, to } = choice.params as { service: string; from: number; to: number };
      done = await this.port.setServiceBudget(service, to, signal);
      undo = () => this.port.setServiceBudget(service, from, signal);
    } else if (choice.kind === "RAISE_TAX") {
      const { area, from, to } = choice.params as { area: TaxArea; from: number; to: number };
      done = await this.port.setTax(area, to, signal);
      undo = () => this.port.setTax(area, from, signal);
    } else if (choice.kind === "CONNECT_FACILITY") {
      const outcome = await this.port.connectFacility((choice.params as { facility: UnattachedFacility }).facility, signal);
      done = outcome.ok;
      notes.push(outcome.detail);
    } else if (choice.kind === "PROVISION_UTILITY") {
      const outcome = await this.port.provisionUtility((choice.params as { utility: "electricity" | "water" | "sewage" }).utility, signal);
      done = outcome.ok;
      notes.push(outcome.detail);
    } else if (choice.kind === "DEMOLISH_FACILITY") {
      // Irreversible: the reason it is worth it is part of the record.
      notes.push(`irreversible: ${choice.rationale}`);
      done = await this.port.demolish((choice.params as { entity: { index: number; version: number } }).entity, signal);
    }
    if (!done) {
      this.memory.attempts.set(choice.id, RECOVERY_PARAMETERS.maximumAttemptsPerTarget);
      notes.push("the world did not accept the action");
      return { status: "RECOVERING", acted: false, notes };
    }
    this.#pending = { candidate: choice, before, undo };
    return { status: "RECOVERING", acted: true, notes };
  }
}
