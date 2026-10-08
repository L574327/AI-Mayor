import { readFileSync } from "node:fs";
import { assertExactlyOneRouteBAction, assertPreparedBoundary1Contract, runRouteBProofOnly, type RouteBProvenance } from "../../src/main/services/ai-mayor/v2/route-b-thin-harness";
import type { PreparedUtilityExecution, UtilityPreparationInput } from "../../src/main/services/ai-mayor/v2/utility-execution-planner";

const input = { kind: "electricity", intentId: "intent", projectId: "project", trancheId: "tranche", reservationRef: "reservation", worldId: "world", worldEpochId: "epoch", generation: "generation", topologyRevision: "topology", spatialEnvelope: { center: { x: 0, z: 0 }, radius: 128 }, maximumSpend: 1000, treasury: 1000, treasurySafetyReserve: 0, connectionOnly: true, selectedPrimitive: "direct-cable" } as UtilityPreparationInput;
const provenance: RouteBProvenance = { worldId: "world", worldEpochId: "epoch", generation: "generation", loaded: true, ready: true, clean: true, evidence: {} };

const prepared = (actions: unknown[] = [{ type: "build_road", prefab: "Low-voltage Ground Cable", x1: 0, z1: 0, x2: 10, z2: 0 }]): PreparedUtilityExecution => ({
  status: "READY", currentFacility: {} as never, currentConnector: {} as never, plan: {} as never, candidate: {} as never,
  targetServiceEntry: { road: { index: 1, version: 1 }, position: { x: 10, z: 0 } }, approvedContact: { x: 10, z: 0 },
  nativeActions: actions as PreparedUtilityExecution["nativeActions"], executionScope: {} as never,
  boundary1Contract: { prefab: "Low-voltage Ground Cable", creationFlags: 65536, original: null, start: { entity: null, flags: 51 }, end: { entity: null, flags: 51 } },
});

describe("thin Route B proof-only harness", () => {
  test("uses a structural exactly-one direct cable guard", () => {
    expect(assertExactlyOneRouteBAction([])).toMatchObject({ status: "BLOCKED", reason: "ROUTE_B_EXPECTED_ONE_MUTATION_MISSING" });
    expect(assertExactlyOneRouteBAction([prepared([]).nativeActions[0] as never, prepared([]).nativeActions[0] as never])).toMatchObject({ status: "BLOCKED", reason: "ROUTE_B_EXPECTED_ONE_MUTATION_VIOLATED" });
    expect(assertExactlyOneRouteBAction([{ type: "place_building", prefab: "WindTurbine01", x: 0, z: 0 }])).toMatchObject({ status: "BLOCKED", reason: "ROUTE_B_UNEXPECTED_ACTION_TYPE" });
    expect(assertExactlyOneRouteBAction([{ type: "build_road", prefab: "Small Road", x1: 0, z1: 0, x2: 1, z2: 1 }])).toMatchObject({ status: "BLOCKED", reason: "ROUTE_B_FORBIDDEN_SETUP_ACTION" });
    expect(assertExactlyOneRouteBAction(prepared().nativeActions)).toMatchObject({ status: "PASS" });
  });

  test("proof-only mode never invokes an execution callback and reports zero mutations", async () => {
    let prepareCalls = 0;
    const result = await runRouteBProofOnly(input, {
      provenance: async () => provenance,
      prepare: async () => { prepareCalls++; return prepared(); },
    });
    expect(prepareCalls).toBe(1);
    expect(result).toMatchObject({ status: "READY", mode: "PROOF_ONLY", nativeMutationCount: 0, preparedBoundary1NativeEquivalent: "YES" });
  });

  test("preparation failure is fail-closed with zero mutations", async () => {
    const result = await runRouteBProofOnly(input, {
      provenance: async () => provenance,
      prepare: async () => ({ status: "BLOCKED", reason: "UTILITY_PLAN_UNAVAILABLE", nativeActionsSubmitted: 0 }),
    });
    expect(result).toMatchObject({ status: "BLOCKED", nativeMutationCount: 0, reason: "UTILITY_PLAN_UNAVAILABLE" });
  });

  test("blocked preparation preserves completed binding and candidate stages", async () => {
    const result = await runRouteBProofOnly(input, {
      provenance: async () => provenance,
      prepare: async () => ({
        status: "BLOCKED" as const,
        reason: "DIRECT_CABLE_PREFLIGHT_REJECTED" as const,
        nativeActionsSubmitted: 0 as const,
        diagnostics: {
          currentBinding: { facility: { entity: { index: 1, version: 1 } }, connector: { node: { index: 2, version: 1 } } },
          currentBindingResolved: true,
          candidateBuilderCalled: true,
          candidateCount: 1,
          selectedCandidatePrimitive: "direct-cable",
          candidateActionCount: 1,
          preflightDiagnostics: [{ actionIndex: 0, valid: false, failedCondition: "fixture_condition", native: {
            nativeToolErrors: [{ errorType: "OverlapExisting" }, { errorType: "SteepSlope" }],
            code: "FIXTURE_CODE",
          } }],
        },
      }),
    });
    expect(result).toMatchObject({
      status: "BLOCKED", nativeMutationCount: 0,
      proofEvidence: {
        facilityBindingUnique: "YES", connectorBindingUnique: "YES",
        candidateSourceAuthoritative: "YES", candidateCount: 1, candidateActionCount: 1,
      },
    });
    expect(result.prepared.status === "BLOCKED" ? result.prepared.diagnostics?.preflightDiagnostics : undefined).toEqual([
      expect.objectContaining({ actionIndex: 0, failedCondition: "fixture_condition", native: expect.objectContaining({
        nativeToolErrors: [{ errorType: "OverlapExisting" }, { errorType: "SteepSlope" }],
      }) }),
    ]);
  });

  test("prepared Boundary 1 contract is checked without claiming live Raw Tap evidence", () => {
    expect(assertPreparedBoundary1Contract(prepared())).toBe("YES");
    expect(assertPreparedBoundary1Contract({ ...prepared(), boundary1Contract: { ...prepared().boundary1Contract!, start: { entity: null, flags: 49 } } })).toBe("NO");
  });

  test("dedicated entrypoint has no run8b authority or custom target matcher", () => {
    const source = readFileSync("scripts/local-v2-route-b-differential.ts", "utf8");
    expect(source).not.toMatch(/local-v2-gate1-battlefield|certifiedRoadRefs|candidateLedger|approvedContact|targetServiceEntry/);
    expect(source).toContain("greenfieldUtilityBootstrap.prepare");
    expect(source).toContain("runRouteBProofOnly");
  });
});
