import * as financeRuntime from "../../src/main/services/ai-mayor/v2/finance";
import { applyFinanceReceipt, authorizeSpend, quoteNativeTempCost, quoteState, stableRoadInput, type FinanceObservation, type NativeTempEntity, type ProposalIdentity, type ProposalQuote } from "../../src/main/services/ai-mayor/v2/finance";
import { createPumpSegment2JunctionContract } from "../../src/main/services/ai-mayor/v2/bounded-network-junction";

const identity = (overrides: Partial<ProposalIdentity> = {}): ProposalIdentity => ({ proposalId: "proposal-road-1", actionFamily: "ROAD", exactInput: stableRoadInput({ prefab: "Small Road", x1: 0, z1: 0, x2: 100, z2: 0 }), runtimeEpoch: "runtime-1", frame: 10, validationState: "VALID", ...overrides });
const observation = (overrides: Partial<FinanceObservation> = {}): FinanceObservation => ({ schemaVersion: "ai-mayor-v2-finance/1", treasuryAmount: 1000, unlimitedMoney: false, runtimeEpoch: "runtime-1", frame: 10, observedAt: "2026-09-13T00:00:00.000Z", freshness: "FRESH", provenance: "OBSERVED_NATIVE", ...overrides });
const temps = [
  { tempId: "t1", ownerProposalId: "proposal-road-1", signedCost: 25, cancelled: false },
  { tempId: "t2", ownerProposalId: "proposal-road-1", signedCost: -5, cancelled: false },
  { tempId: "cancelled", ownerProposalId: "proposal-road-1", signedCost: 99, cancelled: true },
];

type NativeCapturePhase = "BEFORE_DEFINITION_PLAYBACK" | "AFTER_NATIVE_COST" | "AFTER_CLEANUP";

function captureBridgeTempQuote(input: {
  phase: NativeCapturePhase;
  beforeTempIds: string[];
  currentTemps: Array<Omit<NativeTempEntity, "ownerProposalId">>;
  exclusiveToolOwnership: boolean;
  nativeCostReady?: boolean;
  applySetEquivalent?: boolean;
}): { state: "READY"; quote: ProposalQuote } | { state: "UNAVAILABLE"; reason: string } {
  if (input.phase !== "AFTER_NATIVE_COST") {
    return { state: "UNAVAILABLE", reason: input.phase === "BEFORE_DEFINITION_PLAYBACK" ? "TIMING_TOO_EARLY" : "AFTER_CLEANUP" };
  }
  const before = new Set(input.beforeTempIds);
  const created = input.currentTemps.filter((temp) => !before.has(temp.tempId));
  if (!input.exclusiveToolOwnership) return { state: "UNAVAILABLE", reason: "OWNERSHIP_AMBIGUOUS" };
  if (input.applySetEquivalent === false) return { state: "UNAVAILABLE", reason: "APPLY_SET_AMBIGUOUS" };
  if (input.nativeCostReady === false) return { state: "UNAVAILABLE", reason: "COST_NOT_READY" };
  const quote = quoteNativeTempCost(
    identity(),
    "quote-captured",
    created.map((temp) => ({ ...temp, ownerProposalId: identity().proposalId })),
    new Date("2026-09-13T00:00:00Z"),
  );
  return quote.state === "VALID" ? { state: "READY", quote } : { state: "UNAVAILABLE", reason: "TEMP_CAPTURE_INCOMPLETE" };
}

describe("V2 Batch 4 finance contract", () => {
  test("runtime finance module exports stableRoadInput as a callable function", () => {
    expect(typeof financeRuntime.stableRoadInput).toBe("function");
    expect(financeRuntime.stableRoadInput({ prefab: "Medium Road", x1: 0, z1: 0, x2: 10, z2: 0 })).toContain('"actionFamily":"ROAD"');
  });

  test("planning fingerprint extends the exact road identity with materially relevant context", () => {
    const road = { prefab: "Small Road", x1: 0, z1: 0, x2: 100, z2: 0 };
    const base = { objectiveId: "objective-1", worldEpochId: "world-1", topologyRevision: "topology-1",
      facility: { prefab: "WindTurbine03", position: { x: 20, z: 0 }, entity: { index: 7, version: 3 } },
      sourceEndpoint: { entity: { index: 9, version: 1 }, position: { x: 0, z: 0 } },
      targetContact: { road: { index: 22, version: 4 }, position: { x: 100, z: 0 } } };
    expect(stableRoadInput(road, base)).not.toBe(stableRoadInput(road, { ...base, targetContact: { ...base.targetContact, road: { index: 23, version: 4 } } }));
    expect(stableRoadInput(road)).toBe(stableRoadInput(road, undefined));
  });
  test("sums only owned eligible native Temp.m_Cost and preserves signed values", () => {
    const quote = quoteNativeTempCost(identity(), "quote-1", temps, new Date("2026-09-13T00:00:00Z"));
    expect(quote).toMatchObject({ signedAmount: 20, eligibleTempEntityCount: 2, provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST" });
  });
  test.each([0, 25, -25])( "preserves signed quote %s", (amount) => expect(quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: amount, cancelled: false }], new Date()).signedAmount).toBe(amount));
  test("binds quote to exact proposal and rejects unrelated or duplicate ownership", () => {
    const bad = quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "other", signedCost: 1, cancelled: false }], new Date());
    expect(bad.state).toBe("REJECTED");
    expect(quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 1, cancelled: false }, { tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 1, cancelled: false }], new Date()).state).toBe("REJECTED");
  });
  test("stale epoch/frame and expiry reject a quote", () => {
    const quote = quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 0, cancelled: false }], new Date("2026-09-13T00:00:00Z"), 10);
    expect(quoteState(quote, { runtimeEpoch: "runtime-2", frame: 10, now: new Date("2026-09-13T00:00:00Z") })).toBe("STALE");
    expect(quoteState(quote, { runtimeEpoch: "runtime-1", frame: 11, now: new Date("2026-09-13T00:00:00Z") })).toBe("STALE");
    expect(quoteState(quote, { runtimeEpoch: "runtime-1", frame: 10, now: new Date("2026-09-13T00:00:00.011Z") })).toBe("EXPIRED");
  });
  test("empty or component-missing owned Temp fails closed instead of becoming zero", () => {
    expect(quoteNativeTempCost(identity(), "q", [], new Date()).state).toBe("REJECTED");
    expect(quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 1, cancelled: false, hasTempComponent: false }], new Date()).state).toBe("REJECTED");
  });
  test("Admission fails closed for unknown/stale, max bound, reserve, and stale treasury", () => {
    const quote = quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 100, cancelled: false }], new Date("2026-09-13T00:00:00Z"));
    expect(authorizeSpend({ observation: observation({ freshness: "STALE" }), quote, requiredGrossSpend: 1, authorizedMaxSpend: 100, treasurySafetyReserve: 50, now: new Date() }).decision).toBe("REJECTED");
    expect(authorizeSpend({ observation: observation(), quote: undefined, requiredGrossSpend: 1, authorizedMaxSpend: 100, treasurySafetyReserve: 50, now: new Date() }).decision).toBe("REJECTED");
    expect(authorizeSpend({ observation: observation(), quote, requiredGrossSpend: 101, authorizedMaxSpend: 100, treasurySafetyReserve: 50, now: new Date("2026-09-13T00:00:00Z") }).decision).toBe("REJECTED");
    expect(authorizeSpend({ observation: observation({ treasuryAmount: 120 }), quote, requiredGrossSpend: 100, authorizedMaxSpend: 100, treasurySafetyReserve: 50, now: new Date("2026-09-13T00:00:00Z") }).decision).toBe("REJECTED");
  });
  test("explicit zero AUTHORIZED_MAX_SPEND reaches Admission and denies even a native-ready zero quote", () => {
    const quote = quoteNativeTempCost(identity(), "q-zero", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 0, cancelled: false }], new Date("2026-09-13T00:00:00Z"));
    expect(authorizeSpend({ observation: observation(), quote, requiredGrossSpend: 0, authorizedMaxSpend: 0, treasurySafetyReserve: 0, now: new Date("2026-09-13T00:00:00Z") })).toMatchObject({ decision: "REJECTED", authorizedMaxSpend: 0, reason: "zero_quote_not_authorized_for_operation" });
    expect(authorizeSpend({ observation: observation(), quote, requiredGrossSpend: 0, authorizedMaxSpend: 1, treasurySafetyReserve: 0, now: new Date("2026-09-13T00:00:00Z") })).toMatchObject({ decision: "REJECTED", reason: "zero_quote_not_authorized_for_operation" });
  });
  test("only the exact typed junction can reserve a native Temp-set zero quote with a zero cap", () => {
    const contract = createPumpSegment2JunctionContract();
    const input = { prefab: "Medium Road", ...contract.road.course, networkJunctionInsert: contract };
    const exact = stableRoadInput(input);
    const proposal = identity({ proposalId: "junction-test", exactInput: exact });
    const quote = quoteNativeTempCost(proposal, "junction-zero", [{ tempId: "junction-temp", ownerProposalId: proposal.proposalId, signedCost: 0, cancelled: false }], new Date("2026-09-13T00:00:00Z"));
    expect(authorizeSpend({ observation: observation(), quote, requiredGrossSpend: 0, authorizedMaxSpend: 0, treasurySafetyReserve: 50_000, operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT", now: new Date("2026-09-13T00:00:00Z") })).toMatchObject({ decision: "AUTHORIZED", authorizedMaxSpend: 0 });
    expect(authorizeSpend({ observation: observation(), quote, requiredGrossSpend: 0, authorizedMaxSpend: 1, treasurySafetyReserve: 0, operationKind: "BOUNDED_NETWORK_JUNCTION_INSERT", now: new Date("2026-09-13T00:00:00Z") })).toMatchObject({ decision: "REJECTED", reason: "typed_zero_quote_requires_zero_spend_cap" });
  });
  test("unlimited money is explicit and permits reservation without treasury deduction", () => {
    const quote = quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 100, cancelled: false }], new Date("2026-09-13T00:00:00Z"));
    const result = authorizeSpend({ observation: observation({ unlimitedMoney: true, treasuryAmount: 0 }), quote, requiredGrossSpend: 100, authorizedMaxSpend: 100, treasurySafetyReserve: 1000, now: new Date("2026-09-13T00:00:00Z") });
    expect(result.decision).toBe("AUTHORIZED");
  });
  test("receipt keeps same identity, excludes unrelated entity, and fails ambiguous ownership closed", () => {
    const quote = quoteNativeTempCost(identity(), "q", temps, new Date("2026-09-13T00:00:00Z"));
    const receipt = applyFinanceReceipt({ commandId: "cmd-1", identity: identity(), quote, applyFrame: 10, temps: temps.slice(0, 2), unlimitedMoney: false, completionState: "COMPLETED", applySetIdentity: "apply-1", ownershipUnique: true });
    expect(receipt).toMatchObject({ proposalId: "proposal-road-1", quoteId: "q", signedAppliedAmount: 20, attribution: "BOUNDED_ATTRIBUTION" });
    expect(applyFinanceReceipt({ commandId: "cmd-2", identity: identity(), quote, applyFrame: 10, temps: [...temps.slice(0, 2), { tempId: "foreign", ownerProposalId: "other", signedCost: 500, cancelled: false }], unlimitedMoney: false, completionState: "COMPLETED", applySetIdentity: "apply-2", ownershipUnique: true }).attribution).toBe("INCONCLUSIVE");
    expect(applyFinanceReceipt({ commandId: "cmd-3", identity: identity(), quote, applyFrame: 10, temps: temps.slice(0, 2), unlimitedMoney: false, completionState: "COMMIT_ACK" as never, applySetIdentity: "apply-3", ownershipUnique: false }).attribution).toBe("INCONCLUSIVE");
  });
  test("command identity remains stable across receipt correlation and preserves signed native amount", () => {
    const proposal = identity();
    const quote = quoteNativeTempCost(proposal, "quote-160", [{ tempId: "t", ownerProposalId: proposal.proposalId, signedCost: 160, cancelled: false }], new Date("2026-09-13T00:00:00Z"));
    const receipt = applyFinanceReceipt({ commandId: "bridge-command-1", identity: proposal, quote, applyFrame: 11, temps: [{ tempId: "t", ownerProposalId: proposal.proposalId, signedCost: 160, cancelled: false }], unlimitedMoney: false, completionState: "COMPLETED", applySetIdentity: "apply-1", ownershipUnique: true });
    expect(receipt).toMatchObject({ commandId: "bridge-command-1", proposalId: proposal.proposalId, quoteId: "quote-160", signedAppliedAmount: 160, attribution: "BOUNDED_ATTRIBUTION" });
  });
  test("missing command identity fails closed", () => {
    const proposal = identity();
    const quote = quoteNativeTempCost(proposal, "quote", [{ tempId: "t", ownerProposalId: proposal.proposalId, signedCost: 160, cancelled: false }], new Date());
    expect(applyFinanceReceipt({ commandId: "", identity: proposal, quote, applyFrame: 10, temps: [{ tempId: "t", ownerProposalId: proposal.proposalId, signedCost: 160, cancelled: false }], unlimitedMoney: false, completionState: "COMPLETED", applySetIdentity: "apply", ownershipUnique: true }).attribution).toBe("INCONCLUSIVE");
  });
  test("acknowledgement or treasury delta alone cannot create a receipt", () => {
    expect(applyFinanceReceipt({ commandId: "cmd", identity: identity(), quote: quoteNativeTempCost(identity(), "q", [{ tempId: "t", ownerProposalId: "proposal-road-1", signedCost: 0, cancelled: false }], new Date()), applyFrame: 10, temps: [], unlimitedMoney: false, completionState: "UNKNOWN", applySetIdentity: "none", ownershipUnique: false }).attribution).toBe("INCONCLUSIVE");
  });
  test("legacy isolation: contract has no legacy candidate dependency", () => {
    expect(stableRoadInput({ prefab: "Small Road", x1: 0, z1: 0, x2: 10, z2: 0 })).not.toMatch(/candidate|growthOpportunity|roadExpansion/i);
  });

  test("captures a valid ROAD quote only after native Temp generation and cost calculation", () => {
    const result = captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: ["old"], currentTemps: [{ tempId: "old", signedCost: 999, cancelled: false }, { tempId: "road", signedCost: 64, cancelled: false }], exclusiveToolOwnership: true });
    expect(result).toMatchObject({ state: "READY", quote: { signedAmount: 64, eligibleTempEntityCount: 1, provenance: "OBSERVED_NATIVE", sourceKind: "NATIVE_TOOL_TEMP_COST" } });
  });

  test("generated Temp with initial zero cost is unavailable until native cost readiness", () => {
    expect(captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: [], currentTemps: [{ tempId: "road", signedCost: 0, cancelled: false }], exclusiveToolOwnership: true, nativeCostReady: false })).toEqual({ state: "UNAVAILABLE", reason: "COST_NOT_READY" });
    expect(captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: [], currentTemps: [{ tempId: "road", signedCost: 80, cancelled: false }], exclusiveToolOwnership: true, nativeCostReady: true })).toMatchObject({ state: "READY", quote: { signedAmount: 80 } });
  });

  test("a genuine native-ready zero remains legal", () => {
    expect(captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: [], currentTemps: [{ tempId: "road", signedCost: 0, cancelled: false }], exclusiveToolOwnership: true, nativeCostReady: true })).toMatchObject({ state: "READY", quote: { signedAmount: 0 } });
  });

  test("quote set must be semantically equivalent to the native apply Temp set", () => {
    expect(captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: ["foreign"], currentTemps: [{ tempId: "foreign", signedCost: 500, cancelled: false }, { tempId: "road", signedCost: 80, cancelled: false }], exclusiveToolOwnership: true, nativeCostReady: true, applySetEquivalent: false })).toEqual({ state: "UNAVAILABLE", reason: "APPLY_SET_AMBIGUOUS" });
  });

  test("capture before definition playback cannot manufacture a zero quote", () => {
    expect(captureBridgeTempQuote({ phase: "BEFORE_DEFINITION_PLAYBACK", beforeTempIds: [], currentTemps: [], exclusiveToolOwnership: true })).toEqual({ state: "UNAVAILABLE", reason: "TIMING_TOO_EARLY" });
  });

  test("capture after cleanup remains explicit unavailable and does not dereference destroyed Temp", () => {
    expect(captureBridgeTempQuote({ phase: "AFTER_CLEANUP", beforeTempIds: [], currentTemps: [], exclusiveToolOwnership: true })).toEqual({ state: "UNAVAILABLE", reason: "AFTER_CLEANUP" });
  });

  test("before/after relation excludes one or multiple pre-existing unrelated Temp entities", () => {
    for (const beforeTempIds of [["foreign-1"], ["foreign-1", "foreign-2"]]) {
      const result = captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds, currentTemps: [...beforeTempIds.map((tempId) => ({ tempId, signedCost: 500, cancelled: false })), { tempId: "road", signedCost: 32, cancelled: false }], exclusiveToolOwnership: true });
      expect(result).toMatchObject({ state: "READY", quote: { signedAmount: 32, eligibleTempEntityCount: 1 } });
    }
  });

  test("new Temp ownership ambiguity fails closed instead of contaminating the quote", () => {
    expect(captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: [], currentTemps: [{ tempId: "road", signedCost: 32, cancelled: false }, { tempId: "foreign", signedCost: 500, cancelled: false }], exclusiveToolOwnership: false })).toEqual({ state: "UNAVAILABLE", reason: "OWNERSHIP_AMBIGUOUS" });
  });

  test("cancelled Temp is excluded and positive, zero, and negative costs stay signed after capture", () => {
    for (const signedCost of [25, 0, -25]) {
      const result = captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: [], currentTemps: [{ tempId: "road", signedCost, cancelled: false }, { tempId: "cancelled", signedCost: 999, cancelled: true }], exclusiveToolOwnership: true });
      expect(result).toMatchObject({ state: "READY", quote: { signedAmount: signedCost, eligibleTempEntityCount: 1 } });
    }
  });

  test("cleanup after quote capture cannot invalidate the returned value", () => {
    const currentTemps = [{ tempId: "road", signedCost: 48, cancelled: false }];
    const result = captureBridgeTempQuote({ phase: "AFTER_NATIVE_COST", beforeTempIds: [], currentTemps, exclusiveToolOwnership: true });
    currentTemps.splice(0);
    expect(result).toMatchObject({ state: "READY", quote: { signedAmount: 48, eligibleTempEntityCount: 1, state: "VALID" } });
  });
});
